import { getContract, PublicClient } from "viem";
import { ABI } from "../chains/abis.js";
import {
  getV2RelativePrice,
  getV3RelativePrice,
} from "../price/reservesPrice.js";
import { getBaseTokenUsd, isBaseToken } from "../price/baseQuotes.js";
import { watchlist } from "../state/watchlist.js";
import { fetchPairData } from "../datasources/dexScreener.js";

/**
 * LP 风险评估（MVP）：
 * - 是否与主流基准币配对（非基准 × 非基准 → 降级）
 * - 近一次 Mint（加池）美元值（作为开盘强度加分）
 * - DexScreener 侧信道：若标注的 liquidity.usd 很低，降级
 */

export async function isBasePaired(
  chain: "BSC" | "ETH",
  token0: `0x${string}`,
  token1: `0x${string}`
) {
  return isBaseToken(chain, token0) || isBaseToken(chain, token1);
}

/** 解析一笔 V2 Mint，估算本次加池的 USD 值（当一侧为基准币时精确；否则兜底侧信道） */
export async function estimateMintUsdV2(params: {
  chain: "BSC" | "ETH";
  client: PublicClient;
  pair: `0x${string}`;
  token0: `0x${string}`;
  token1: `0x${string}`;
  amount0: bigint;
  amount1: bigint;
}): Promise<number | undefined> {
  const { chain, client, pair, token0, token1, amount0, amount1 } = params;
  try {
    const rel = await getV2RelativePrice(client, pair, token0, token1);
    if (rel) {
      const dec0 = Number(
        await getContract({
          address: token0,
          abi: ABI.erc20,
          client,
        }).read.decimals()
      );
      const dec1 = Number(
        await getContract({
          address: token1,
          abi: ABI.erc20,
          client,
        }).read.decimals()
      );
      const a0 = Number(amount0) / 10 ** dec0;
      const a1 = Number(amount1) / 10 ** dec1;

      // 若 token1 是基准币：amount1 即为“美元/基准币侧”，直接用其 USD
      if (isBaseToken(chain, token1)) {
        const usd1 = await getBaseTokenUsd(chain, token1);
        if (usd1 !== undefined) return a1 * usd1;
      }
      if (isBaseToken(chain, token0)) {
        const usd0 = await getBaseTokenUsd(chain, token0);
        if (usd0 !== undefined) return a0 * usd0;
      }
      // 若都不是基准币：用 rel + 侧信道基准价转 USD 近似
      if (isBaseToken(chain, token1)) {
        const usd1 = await getBaseTokenUsd(chain, token1);
        if (usd1 !== undefined) return (a0 * rel.p0in1 + a1) * usd1;
      }
      if (isBaseToken(chain, token0)) {
        const usd0 = await getBaseTokenUsd(chain, token0);
        if (usd0 !== undefined) return (a1 * rel.p1in0 + a0) * usd0;
      }
    }

    // 兜底：DexScreener pair 查询 liquidity.usd（可能不是“本次”）
    const data = await fetchPairData(chain, pair);
    const liq = Number(data?.pair?.liquidity?.usd ?? 0);
    return Number.isFinite(liq) && liq > 0 ? liq : undefined;
  } catch {
    return undefined;
  }
}

/** 更新 watchlist 的加池记录（在 V2 Mint 回调里调用） */
export async function onV2MintRecord(key: string, usd?: number) {
  if (usd === undefined) return;
  watchlist.patchMeta(key, { lastMintUsd: usd });
}

/** 简易 LP 风险打分（越低越安全；仅用于闸门） */
export async function lpRiskScore(params: {
  chain: "BSC" | "ETH";
  type: "v2" | "v3";
  addr: `0x${string}`;
  token0: `0x${string}`;
  token1: `0x${string}`;
}): Promise<{ score: number; notes: string[] }> {
  const notes: string[] = [];
  let score = 0;

  // 基础：是否与基准币配对
  const basePaired = await isBasePaired(
    params.chain,
    params.token0,
    params.token1
  );
  if (!basePaired) {
    score += 2;
    notes.push("not base paired");
  } else {
    notes.push("base paired");
  }

  // 侧信道：总体 LP 美元（非严格，作为趋势参考）
  try {
    const data = await fetchPairData(params.chain, params.addr);
    const liq = Number(data?.pair?.liquidity?.usd ?? 0);
    if (Number.isFinite(liq) && liq > 0) {
      if (liq < 3000) {
        score += 2;
        notes.push(`low liq ${liq.toFixed(0)} USD`);
      } else if (liq < 8000) {
        score += 1;
        notes.push(`medium liq ${liq.toFixed(0)} USD`);
      } else {
        notes.push(`good liq ${liq.toFixed(0)} USD`);
      }
    }
  } catch {}

  return { score, notes };
}
