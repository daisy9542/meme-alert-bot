import { STRATEGY } from "../config.js";
import { logger } from "../logger.js";
import { DedupSet } from "../state/stores.js";
import { isBaseToken } from "../price/baseQuotes.js";
import {
  fetchPairData,
  fetchTrendingPairs,
} from "../datasources/dexScreener.js";

type ChainLabel = "BSC" | "ETH";

export type TrendingHandlers = {
  onV2Candidate: (ctx: {
    chain: ChainLabel;
    pair: `0x${string}`;
    token0: `0x${string}`;
    token1: `0x${string}`;
  }) => void;
  onV3Candidate: (ctx: {
    chain: ChainLabel;
    pool: `0x${string}`;
    token0: `0x${string}`;
    token1: `0x${string}`;
    fee?: number;
  }) => void;
};

const SOURCE_TTL = 5 * 60_000; // 5 分钟去重
const ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;
const SUPPORTED_DEX_IDS: Record<ChainLabel, string[]> = {
  BSC: ["pancakeswap", "pcs"],
  ETH: ["uniswap"],
};

function inferType(dexId: string | undefined) {
  if (!dexId) return "v2";
  const id = dexId.toLowerCase();
  return id.includes("v3") ? "v3" : "v2";
}

function looksLikeAddress(
  value: string | undefined
): value is `0x${string}` {
  return !!value && ADDRESS_REGEX.test(value);
}

function dexSupported(chain: ChainLabel, dexId: string | undefined) {
  if (!dexId) return false;
  const needles = SUPPORTED_DEX_IDS[chain];
  const id = dexId.toLowerCase();
  return needles.some((needle) => id.includes(needle));
}

export function startTrendingWatcher(handlers: TrendingHandlers) {
  const dedup = new DedupSet(SOURCE_TTL);

  async function pollChain(chain: ChainLabel) {
    try {
      const res = await fetchTrendingPairs(chain, STRATEGY.TRENDING_TOP_K);
      const pairs: any[] = Array.isArray(res?.pairs) ? res.pairs : [];
      for (const item of pairs) {
        const pairAddress = item?.pairAddress ?? item?.pair ?? "";
        const token0 = item?.baseToken?.address as string | undefined;
        const token1 = item?.quoteToken?.address as string | undefined;
        if (!dexSupported(chain, item?.dexId)) continue;
        if (
          !looksLikeAddress(pairAddress) ||
          !looksLikeAddress(token0) ||
          !looksLikeAddress(token1)
        ) {
          continue;
        }
        const normalizedPair = pairAddress.toLowerCase() as `0x${string}`;
        const normalizedToken0 = token0.toLowerCase() as `0x${string}`;
        const normalizedToken1 = token1.toLowerCase() as `0x${string}`;
        const key = `${chain}:${normalizedPair}`;
        if (dedup.has(key)) continue;
        const liquidityUsd = Number(item?.liquidity?.usd ?? 0);
        if (!Number.isFinite(liquidityUsd)) continue;
        if (liquidityUsd < STRATEGY.TRENDING_MIN_LIQ_USD) continue;
        const basePaired =
          isBaseToken(chain, token0 as `0x${string}`) ||
          isBaseToken(chain, token1 as `0x${string}`);
        if (!basePaired) continue;
        dedup.add(key);
        const type = inferType(item?.dexId);
        if (type === "v3") {
          let fee = Number(item?.feeTier ?? item?.fee ?? NaN);
          if (!Number.isFinite(fee)) {
            try {
              const detail = await fetchPairData(chain, normalizedPair);
              fee = Number(detail?.pair?.feeTier ?? detail?.pair?.fee ?? NaN);
            } catch (err) {
              logger.debug({ err }, "fetchPairData failed for trending pool");
            }
          }
          handlers.onV3Candidate({
            chain,
            pool: normalizedPair,
            token0: normalizedToken0,
            token1: normalizedToken1,
            fee: Number.isFinite(fee) ? fee : undefined,
          });
        } else {
          handlers.onV2Candidate({
            chain,
            pair: normalizedPair,
            token0: normalizedToken0,
            token1: normalizedToken1,
          });
        }
      }
    } catch (e: any) {
      logger.warn({ chain, err: String(e?.message ?? e) }, "Trending poll failed");
    }
  }

  const tick = async () => {
    await Promise.all([pollChain("BSC"), pollChain("ETH")]);
  };

  tick().catch((e) => logger.warn({ err: e }, "Trending poll init failed"));
  const timer = setInterval(() => {
    tick().catch((e) => logger.warn({ err: e }, "Trending poll loop failed"));
  }, STRATEGY.TRENDING_POLL_INTERVAL_MS);

  return () => clearInterval(timer);
}
