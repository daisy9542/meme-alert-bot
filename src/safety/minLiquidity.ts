import axios from "axios";
import { PublicClient, getContract } from "viem";
import { ABI } from "../chains/abis.js";
import { getBaseTokenUsd, isBaseToken } from "../price/baseQuotes.js";
import { STRATEGY } from "../config.js";

/**
 * 计算当前池子的“可见美元流动性”并与阈值比较
 * - 优先：若一侧是基准币，读取 reserves 并按基准币 USD 折算
 * - 否则：使用 DexScreener 的 liquidity.usd 作为兜底
 */

export async function hasMinLiquidityV2(params: {
  chain: "BSC" | "ETH";
  client: PublicClient;
  pair: `0x${string}`;
  token0: `0x${string}`;
  token1: `0x${string}`;
  minUsd?: number;
}): Promise<{ ok: boolean; usd?: number; note?: string }> {
  const { chain, client, pair, token0, token1 } = params;
  const min = params.minUsd ?? STRATEGY.MIN_LIQ_USD;

  try {
    const c = getContract({ address: pair, abi: ABI.v2Pair, client });
    const [r0, r1] = (await c.read.getReserves()) as unknown as [
      bigint,
      bigint,
      number
    ];

    // 若 token1 是基准币：直接用 reserve1 × priceUsd
    if (isBaseToken(chain, token1)) {
      const d1 = Number(
        await getContract({
          address: token1,
          abi: ABI.erc20,
          client,
        }).read.decimals()
      );
      const usd1 = await getBaseTokenUsd(chain, token1);
      if (usd1 !== undefined) {
        const liq = (Number(r1) / 10 ** d1) * usd1 * 2; // 双边估算
        return { ok: liq >= min, usd: liq, note: "v2 reserve base=token1" };
      }
    }
    if (isBaseToken(chain, token0)) {
      const d0 = Number(
        await getContract({
          address: token0,
          abi: ABI.erc20,
          client,
        }).read.decimals()
      );
      const usd0 = await getBaseTokenUsd(chain, token0);
      if (usd0 !== undefined) {
        const liq = (Number(r0) / 10 ** d0) * usd0 * 2;
        return { ok: liq >= min, usd: liq, note: "v2 reserve base=token0" };
      }
    }
  } catch {}

  // 兜底：DexScreener
  try {
    const url = `https://api.dexscreener.com/latest/dex/pairs/${
      chain === "BSC" ? "bsc" : "ethereum"
    }/${pair}`;
    const { data } = await axios.get(url, { timeout: 6000 });
    const liq = Number(data?.pair?.liquidity?.usd ?? 0);
    if (Number.isFinite(liq) && liq > 0) {
      return { ok: liq >= min, usd: liq, note: "dexscreener liquidity" };
    }
  } catch {}

  return { ok: false, note: "unable to determine liquidity" };
}

/** V3 直接走 DexScreener 兜底（MVP 简化） */
export async function hasMinLiquidityV3(params: {
  chain: "BSC" | "ETH";
  pool: `0x${string}`;
  minUsd?: number;
}): Promise<{ ok: boolean; usd?: number; note?: string }> {
  const { chain, pool } = params;
  const min = params.minUsd ?? STRATEGY.MIN_LIQ_USD;
  try {
    const url = `https://api.dexscreener.com/latest/dex/pairs/${
      chain === "BSC" ? "bsc" : "ethereum"
    }/${pool}`;
    const { data } = await axios.get(url, { timeout: 6000 });
    const liq = Number(data?.pair?.liquidity?.usd ?? 0);
    if (Number.isFinite(liq) && liq > 0) {
      return { ok: liq >= min, usd: liq, note: "dexscreener liquidity (v3)" };
    }
  } catch {}
  return { ok: false, note: "unable to determine liquidity (v3)" };
}
