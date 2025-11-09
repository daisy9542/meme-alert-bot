import { createEvmClients, type EvmClients } from "./chains/evmClient.js";
import {
  watchFactories,
  watchV2Pair,
  watchV3Pool,
} from "./chains/subscriptions.js";
import { logger } from "./logger.js";
import { watchlist, marketKey } from "./state/watchlist.js";
import { prefetchBaseQuotes, isBaseToken } from "./price/baseQuotes.js";
import { hasMinLiquidityV2, hasMinLiquidityV3 } from "./safety/minLiquidity.js";
import { checkSellabilityV2 } from "./safety/sellability.js";
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

type ChainLabel = "BSC" | "ETH";

async function main() {
  const clients = createEvmClients();

  // 预取基准币报价（减少冷启动误差）
  prefetchBaseQuotes("BSC").catch(() => {});
  prefetchBaseQuotes("ETH").catch(() => {});

  // 已订阅的市场，避免重复
  const subscribed = new Set<string>();

  // —— 工厂事件：新建 Pair/Pool —— //
  watchFactories(clients, {
    onNewV2Pair: async ({ chain, pair, token0, token1 }) => {
      const key = marketKey(chain as ChainLabel, "v2", pair);
      if (!watchlist.has(key)) {
        watchlist.enqueueNew({
          chain: chain as ChainLabel,
          type: "v2",
          address: pair,
          token0,
          token1,
        });
        logger.info(
          { chain, pair, token0, token1 },
          "🆕 New V2 Pair (pending gates)"
        );
        // 安全闸门（异步跑，不阻塞订阅）
        runGates(clients, chain as ChainLabel, "v2", pair, token0, token1).catch(
          () => {}
        );
      }

      // 订阅交易事件（只做一次；是否入窗由 active 决定）
      const subKey = `${chain}:v2:${pair.toLowerCase()}`;
      if (!subscribed.has(subKey)) {
        subscribed.add(subKey);
        const client = chain === "BSC" ? clients.bsc : clients.ethereum;

        watchV2Pair(client, chain as ChainLabel, pair, {
          onV2Mint: async ({ args: { amount0, amount1 } }) => {
            // 记录“刚大额加池”信息（用于后续告警加分）
            const usd = await estimateMintUsdV2({
              chain: chain as ChainLabel,
              client,
              pair,
              token0,
              token1,
              amount0,
              amount1,
            });
            await onV2MintRecord(key, usd);
          },

          onV2Swap: async ({ args, chain }) => {
            const entry = watchlist.get(key);
            if (!entry || entry.status !== "active") return;

            // 目标侧：非基准币的一侧（若两侧都非基准币，默认 token0）
            const target = isBaseToken(chain as ChainLabel, token1)
              ? "token0"
              : isBaseToken(chain as ChainLabel, token0)
              ? "token1"
              : "token0";

            // —— 写入滑窗（折 USD）——
            await onV2SwapToWindows({
              chain: chain as ChainLabel,
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

            // —— 税率近似样本（仅当“对侧为基准币”时记录）——
            const otherIsBase =
              target === "token0"
                ? isBaseToken(chain as ChainLabel, token1)
                : isBaseToken(chain as ChainLabel, token0);

            if (otherIsBase) {
              // V2 约定：买入 token0 则 amount0Out>0；卖出 token0 则 amount0In>0（token1 同理）
              if (target === "token0") {
                const tokenIn = Number(args.amount0In); // 卖 token0
                const baseOut = Number(args.amount1Out); // 得到基准币
                if (tokenIn > 0 && baseOut > 0) {
                  await recordTaxApprox({
                    chain: chain as ChainLabel,
                    type: "v2",
                    addr: pair,
                    client,
                    token0,
                    token1,
                    direction: "sellToken0",
                    tokenIn: tokenIn,
                    baseOut: baseOut,
                  });
                }
                const baseIn = Number(args.amount1In); // 用基准币买 token0
                const tokenOut = Number(args.amount0Out);
                if (baseIn > 0 && tokenOut > 0) {
                  await recordTaxApprox({
                    chain: chain as ChainLabel,
                    type: "v2",
                    addr: pair,
                    client,
                    token0,
                    token1,
                    direction: "buyToken0",
                    baseIn: baseIn,
                    tokenIn: tokenOut,
                  });
                }
              } else {
                const tokenIn = Number(args.amount1In);
                const baseOut = Number(args.amount0Out);
                if (tokenIn > 0 && baseOut > 0) {
                  await recordTaxApprox({
                    chain: chain as ChainLabel,
                    type: "v2",
                    addr: pair,
                    client,
                    token0,
                    token1,
                    direction: "sellToken1",
                    tokenIn: tokenIn,
                    baseOut: baseOut,
                  });
                }
                const baseIn = Number(args.amount0In);
                const tokenOut = Number(args.amount1Out);
                if (baseIn > 0 && tokenOut > 0) {
                  await recordTaxApprox({
                    chain: chain as ChainLabel,
                    type: "v2",
                    addr: pair,
                    client,
                    token0,
                    token1,
                    direction: "buyToken1",
                    baseIn: baseIn,
                    tokenIn: tokenOut,
                  });
                }
              }
            }

            // —— 告警评估 ——（简单以本笔买入金额判断鲸鱼：>阈值）
            const lastTradeBuyerUsd =
              Number(args.amount0Out) > 0 &&
              isBaseToken(chain as ChainLabel, token1)
                ? undefined // 若对侧为基准，前面折USD时已计入窗口；此处只需是否达阈值
                : undefined; // MVP：这里不重复折USD，按窗口+阈值触发

            const res = await evaluateAlerts({
              chain: chain as ChainLabel,
              type: "v2",
              addr: pair,
              client,
              token0,
              token1,
              target,
              lastTradeIsBuy:
                target === "token0"
                  ? Number(args.amount0Out) > 0
                  : Number(args.amount1Out) > 0,
              lastTradeBuyerUsd,
              lastMintUsd: entry.meta.lastMintUsd,
            });

            if (res.level !== "none") {
              const msg = buildAlertMessage({
                level: res.level,
                chain: chain as ChainLabel,
                type: "v2",
                addr: pair,
                token0,
                token1,
                target,
                headline: `V2 ${chain} ${res.level.toUpperCase()} — ${pair}`,
                body: res.message,
              });
              await tgSend(msg);
              logger.info({ key, res }, "Alert sent");
            }
          },
        });
      }
    },

    onNewV3Pool: async ({ chain, pool, token0, token1 }) => {
      const key = marketKey(chain as ChainLabel, "v3", pool);
      if (!watchlist.has(key)) {
        watchlist.enqueueNew({
          chain: chain as ChainLabel,
          type: "v3",
          address: pool,
          token0,
          token1,
        });
        logger.info(
          { chain, pool, token0, token1 },
          "🆕 New V3 Pool (pending gates)"
        );
        runGates(clients, chain as ChainLabel, "v3", pool, token0, token1).catch(
          () => {}
        );
      }

      const subKey = `${chain}:v3:${pool.toLowerCase()}`;
      if (!subscribed.has(subKey)) {
        subscribed.add(subKey);
        const client = chain === "BSC" ? clients.bsc : clients.ethereum;

        watchV3Pool(client, chain as ChainLabel, pool, {
          onV3Swap: async ({ args, chain }) => {
            const entry = watchlist.get(key);
            if (!entry || entry.status !== "active") return;

            const target = isBaseToken(chain as ChainLabel, token1)
              ? "token0"
              : isBaseToken(chain as ChainLabel, token0)
              ? "token1"
              : "token0";

            await onV3SwapToWindows({
              chain: chain as ChainLabel,
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

            // V3 税率样本：略（MVP 简化）

            const res = await evaluateAlerts({
              chain: chain as ChainLabel,
              type: "v3",
              addr: pool,
              client,
              token0,
              token1,
              target,
              lastTradeIsBuy:
                target === "token0"
                  ? Number(args.amount0) < 0
                  : Number(args.amount1) < 0, // V3出池为买入
              lastMintUsd: entry.meta.lastMintUsd,
            });
            if (res.level !== "none") {
              const msg = buildAlertMessage({
                level: res.level,
                chain: chain as ChainLabel,
                type: "v3",
                addr: pool,
                token0,
                token1,
                target,
                headline: `V3 ${chain} ${res.level.toUpperCase()} — ${pool}`,
                body: res.message,
              });
              await tgSend(msg);
              logger.info({ key, res }, "Alert sent");
            }
          },
        });
      }
    },
  });

  logger.info("👀 Subscriptions ready — factories on BSC & ETH");
}

/** 跑安全闸门，通过后激活 watchlist 条目 */
async function runGates(
  clients: EvmClients,
  chain: ChainLabel,
  type: "v2" | "v3",
  addr: `0x${string}`,
  token0: `0x${string}`,
  token1: `0x${string}`
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

    // 可卖性（仅 V2 做静态校验）
    if (type === "v2") {
      const sell = await checkSellabilityV2(chain, client, token0);
      if (!sell.ok) {
        watchlist.reject(key, `sellability fail: ${sell.note}`);
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
    watchlist.activate(key);
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
