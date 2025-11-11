import { createEvmClients, type EvmClients } from "./chains/evmClient.js";
import {
  watchFactories,
  watchV2Pair,
  watchV3Pool,
} from "./chains/subscriptions.js";
import { logger } from "./logger.js";
import { watchlist, marketKey } from "./state/watchlist.js";
import { prefetchBaseQuotes, isBaseToken } from "./price/baseQuotes.js";
import { getTokenDecimals } from "./price/reservesPrice.js";
import { hasMinLiquidityV2, hasMinLiquidityV3 } from "./safety/minLiquidity.js";
import { checkSellabilityV2, checkSellabilityV3 } from "./safety/sellability.js";
import {
  lpRiskScore,
  estimateMintUsdV2,
  onV2MintRecord,
} from "./safety/lpRisk.js";
import { recordTaxApprox } from "./safety/taxEstimator.js";
import { onV2SwapToWindows, onV3SwapToWindows } from "./metrics/volume.js";
import { passSafetyGates } from "./rules/gates.js";
import { evaluateAlerts } from "./rules/alerts.js";
import { tgSend, buildAlertMessage } from "./notifiers/console.js";
import { STRATEGY } from "./config.js";
import { startTrendingWatcher } from "./pipeline/trending.js";

type ChainLabel = "BSC" | "ETH";

async function main() {
  const clients = createEvmClients();

  // 预取基准币报价（减少冷启动误差）
  prefetchBaseQuotes("BSC").catch(() => {});
  prefetchBaseQuotes("ETH").catch(() => {});

  // 已订阅的市场，避免重复
  const subscriptions = new Map<string, () => void>();

  const normalize = (addr: `0x${string}`): `0x${string}` =>
    addr.toLowerCase() as `0x${string}`;

  const hasCapacity = () => {
    if (subscriptions.size < STRATEGY.MAX_ACTIVE_MARKETS) return true;
    return false;
  };

  const ensureV2Market = (
    chain: ChainLabel,
    pairAddr: `0x${string}`,
    token0Addr: `0x${string}`,
    token1Addr: `0x${string}`,
    meta?: { source?: string }
  ) => {
    const pair = normalize(pairAddr);
    const token0 = normalize(token0Addr);
    const token1 = normalize(token1Addr);
    const key = marketKey(chain, "v2", pair);

    if (!watchlist.has(key)) {
      watchlist.enqueueNew({
        chain,
        type: "v2",
        address: pair,
        token0,
        token1,
      });
      logger.info(
        { chain, pair, token0, token1, source: meta?.source ?? "factory" },
        "Tracking V2 market (pending gates)"
      );
      runGates(clients, chain, "v2", pair, token0, token1).catch(() => {});
    }

    const subKey = `${chain}:v2:${pair}`;
    if (subscriptions.has(subKey)) return;
    if (!hasCapacity()) {
      logger.warn({ chain, pair }, "Active market limit reached, skip V2 subscribe");
      return;
    }

    const client = chain === "BSC" ? clients.bsc : clients.ethereum;
    const stop = watchV2Pair(client, chain, pair, {
      onV2Mint: async ({ args: { amount0, amount1 } }) => {
        const usd = await estimateMintUsdV2({
          chain,
          client,
          pair,
          token0,
          token1,
          amount0,
          amount1,
        });
        await onV2MintRecord(key, usd);
      },
      onV2Swap: async ({ args, chain: eventChain }) => {
        const entry = watchlist.get(key);
        if (!entry || entry.status !== "active") return;

        const target = isBaseToken(eventChain as ChainLabel, token1)
          ? "token0"
          : isBaseToken(eventChain as ChainLabel, token0)
          ? "token1"
          : "token0";

        const swapResult = await onV2SwapToWindows({
          chain: eventChain as ChainLabel,
          client,
          addr: pair,
          token0,
          token1,
          target,
          sender: args.sender,
          to: args.to,
          amount0In: args.amount0In,
          amount1In: args.amount1In,
          amount0Out: args.amount0Out,
          amount1Out: args.amount1Out,
        });

        const otherIsBase =
          target === "token0"
            ? isBaseToken(eventChain as ChainLabel, token1)
            : isBaseToken(eventChain as ChainLabel, token0);

        if (otherIsBase) {
          let cachedDecimals: [number, number] | null = null;
          const ensureDecimals = async () => {
            if (cachedDecimals) return cachedDecimals;
            cachedDecimals = await Promise.all([
              getTokenDecimals(client, token0),
              getTokenDecimals(client, token1),
            ]);
            return cachedDecimals;
          };
          const [dec0, dec1] = await ensureDecimals();
          const decimals = { token0: dec0, token1: dec1 };

          if (target === "token0") {
            if (args.amount0In > 0n && args.amount1Out > 0n) {
              await recordTaxApprox({
                chain: eventChain as ChainLabel,
                type: "v2",
                addr: pair,
                client,
                token0,
                token1,
                direction: "sellToken0",
                tokenIn: args.amount0In,
                baseOut: args.amount1Out,
                decimals,
              });
            }
            if (args.amount1In > 0n && args.amount0Out > 0n) {
              await recordTaxApprox({
                chain: eventChain as ChainLabel,
                type: "v2",
                addr: pair,
                client,
                token0,
                token1,
                direction: "buyToken0",
                baseIn: args.amount1In,
                tokenIn: args.amount0Out,
                decimals,
              });
            }
          } else {
            if (args.amount1In > 0n && args.amount0Out > 0n) {
              await recordTaxApprox({
                chain: eventChain as ChainLabel,
                type: "v2",
                addr: pair,
                client,
                token0,
                token1,
                direction: "sellToken1",
                tokenIn: args.amount1In,
                baseOut: args.amount0Out,
                decimals,
              });
            }
            if (args.amount0In > 0n && args.amount1Out > 0n) {
              await recordTaxApprox({
                chain: eventChain as ChainLabel,
                type: "v2",
                addr: pair,
                client,
                token0,
                token1,
                direction: "buyToken1",
                baseIn: args.amount0In,
                tokenIn: args.amount1Out,
                decimals,
              });
            }
          }
        }

        const res = await evaluateAlerts({
          chain: eventChain as ChainLabel,
          type: "v2",
          addr: pair,
          client,
          token0,
          token1,
          target,
          lastTradeUsd: swapResult?.usd,
          lastTradeIsBuy: swapResult?.isBuy ?? false,
          lastTradeBuyerUsd:
            swapResult && swapResult.isBuy ? swapResult.usd : undefined,
          liquidityUsd: entry.meta.liquidityUsd,
          lastMintUsd: entry.meta.lastMintUsd,
        });

        if (res.level !== "none") {
          const msg = buildAlertMessage({
            level: res.level,
            chain: eventChain as ChainLabel,
            type: "v2",
            addr: pair,
            token0,
            token1,
            target,
            headline: `V2 ${eventChain} ${res.level.toUpperCase()} — ${pair}`,
            body: res.message,
          });
          await tgSend(msg);
          logger.info({ key, res }, "Alert sent");
        }
      },
    });

    subscriptions.set(subKey, stop);
  };

  const ensureV3Market = (
    chain: ChainLabel,
    poolAddr: `0x${string}`,
    token0Addr: `0x${string}`,
    token1Addr: `0x${string}`,
    fee?: number,
    meta?: { source?: string }
  ) => {
    const pool = normalize(poolAddr);
    const token0 = normalize(token0Addr);
    const token1 = normalize(token1Addr);
    const key = marketKey(chain, "v3", pool);

    if (!watchlist.has(key)) {
      watchlist.enqueueNew({
        chain,
        type: "v3",
        address: pool,
        token0,
        token1,
        fee,
      });
      logger.info(
        { chain, pool, token0, token1, source: meta?.source ?? "factory" },
        "Tracking V3 market (pending gates)"
      );
      runGates(clients, chain, "v3", pool, token0, token1, fee).catch(() => {});
    }

    const subKey = `${chain}:v3:${pool}`;
    if (subscriptions.has(subKey)) return;
    if (!hasCapacity()) {
      logger.warn({ chain, pool }, "Active market limit reached, skip V3 subscribe");
      return;
    }

    const client = chain === "BSC" ? clients.bsc : clients.ethereum;
    const stop = watchV3Pool(client, chain, pool, {
      onV3Swap: async ({ args, chain: eventChain }) => {
        const entry = watchlist.get(key);
        if (!entry || entry.status !== "active") return;

        const target = isBaseToken(eventChain as ChainLabel, token1)
          ? "token0"
          : isBaseToken(eventChain as ChainLabel, token0)
          ? "token1"
          : "token0";

        const swapResult = await onV3SwapToWindows({
          chain: eventChain as ChainLabel,
          client,
          addr: pool,
          token0,
          token1,
          target,
          sender: args.sender,
          recipient: args.recipient,
          amount0: args.amount0,
          amount1: args.amount1,
        });

        const res = await evaluateAlerts({
          chain: eventChain as ChainLabel,
          type: "v3",
          addr: pool,
          client,
          token0,
          token1,
          target,
          lastTradeUsd: swapResult?.usd,
          lastTradeIsBuy: swapResult?.isBuy ?? false,
          lastTradeBuyerUsd:
            swapResult && swapResult.isBuy ? swapResult.usd : undefined,
          liquidityUsd: entry.meta.liquidityUsd,
          lastMintUsd: entry.meta.lastMintUsd,
        });
        if (res.level !== "none") {
          const msg = buildAlertMessage({
            level: res.level,
            chain: eventChain as ChainLabel,
            type: "v3",
            addr: pool,
            token0,
            token1,
            target,
            headline: `V3 ${eventChain} ${res.level.toUpperCase()} — ${pool}`,
            body: res.message,
          });
          await tgSend(msg);
          logger.info({ key, res }, "Alert sent");
        }
      },
    });

    subscriptions.set(subKey, stop);
  };

  // —— 工厂事件：新建 Pair/Pool —— //
  watchFactories(clients, {
    onNewV2Pair: ({ chain, pair, token0, token1 }) =>
      ensureV2Market(chain as ChainLabel, pair, token0, token1, {
        source: "factory",
      }),
    onNewV3Pool: ({ chain, pool, token0, token1, fee }) =>
      ensureV3Market(chain as ChainLabel, pool, token0, token1, fee, {
        source: "factory",
      }),
  });

  startTrendingWatcher({
    onV2Candidate: ({ chain, pair, token0, token1 }) =>
      ensureV2Market(chain, pair, token0, token1, { source: "trending" }),
    onV3Candidate: ({ chain, pool, token0, token1, fee }) =>
      ensureV3Market(chain, pool, token0, token1, fee, { source: "trending" }),
  });

  logger.info("👀 Subscriptions ready — factories & trending feeds online");
}

/** 跑安全闸门，通过后激活 watchlist 条目 */
async function runGates(
  clients: EvmClients,
  chain: ChainLabel,
  type: "v2" | "v3",
  addr: `0x${string}`,
  token0: `0x${string}`,
  token1: `0x${string}`,
  fee?: number
) {
  const client = chain === "BSC" ? clients.bsc : clients.ethereum;
  const key = marketKey(chain, type, addr);

  try {
    // 最小流动性早筛（快速失败）
    const liq =
      type === "v2"
        ? await hasMinLiquidityV2({
            chain,
            client,
            pair: addr as any,
            token0,
            token1,
            minUsd: STRATEGY.MIN_LIQ_USD,
          })
        : await hasMinLiquidityV3({
            chain,
            pool: addr as any,
            minUsd: STRATEGY.MIN_LIQ_USD,
          });
    if (!liq.ok) {
      watchlist.reject(key, `minLiquidity fail: ${liq.note ?? ""}`);
      return;
    }

    // 可卖性（V2 / V3）
    if (type === "v2") {
      const sell = await checkSellabilityV2(chain, client, token0);
      if (!sell.ok) {
        watchlist.reject(key, `sellability fail: ${sell.note}`);
        return;
      }
    } else {
      const sell = await checkSellabilityV3({
        chain,
        client,
        token0,
        token1,
        pool: addr,
        fee,
      });
      if (!sell.ok) {
        watchlist.reject(
          key,
          `sellability v3 fail: ${sell.note ?? "no quote"}`
        );
        return;
      }
    }

    // LP 风险评分
    const { score, notes } = await lpRiskScore({
      chain,
      type,
      addr,
      token0,
      token1,
    });
    if (score >= 2) {
      watchlist.reject(key, `lpRisk high: ${notes.join(",")}`);
      return;
    }

    // 全部通过 → 激活
    watchlist.activate(key, { liquidityUsd: liq.usd });
    logger.info({ key, addr }, "✅ Safety gates passed — activated");
    await tgSend(
      `✅ *Activated* ${chain} ${type.toUpperCase()} \`${addr}\`\n${notes.join(
        " | "
      )}`
    );
  } catch (e: any) {
    logger.error({ key, e }, "runGates error");
    watchlist.reject(key, "gates error");
  }
}

main().catch((e) => {
  logger.error(e, "Fatal error in main()");
  process.exit(1);
});
