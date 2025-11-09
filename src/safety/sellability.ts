import { getContract, PublicClient } from "viem";
import { ABI } from "../chains/abis.js";
import { CHAINS } from "../config.js";
import { getTokenDecimals } from "../price/reservesPrice.js";
import { getBaseTokenUsd, isBaseToken } from "../price/baseQuotes.js";

/**
 * 简化版 Router 地址（仅用于 callStatic 读 getAmountsOut）
 * - V2 场景可用；V3 复杂路由暂不模拟，转由行情侧信道与后续卖出真实成交观测判定
 */
const Routers = {
  BSC: {
    v2: "0x10ED43C718714eb63d5aA57B78B54704E256024E", // Pancake V2 router
  },
  ETH: {
    v2: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D", // Uniswap V2 router
  },
} as const;

/** 选择一个“可用的基准币”作为卖出目标 */
function pickBase(chain: "BSC" | "ETH"): `0x${string}` {
  const base =
    chain === "BSC" ? CHAINS.bsc.baseTokens : CHAINS.ethereum.baseTokens;
  // 优先 USDT/USDC → WBNB/WETH → 其他稳定
  return (
    (base as any).USDT ??
    (base as any).USDC ??
    (base as any).WBNB ??
    (base as any).WETH ??
    (Object.values(base)[0] as `0x${string}`)
  );
}

/**
 * 可卖性快速检查（V2 路由 getAmountsOut 只读调用）
 * - 路径：token -> base
 * - 思路：准备一个极小金额（如 10^(dec-6)），若能返回正数 amountsOut，且 base 为已知基准币，则基本可卖
 * - 返回：true/false + 备注
 */
export async function checkSellabilityV2(
  chain: "BSC" | "ETH",
  client: PublicClient,
  token: `0x${string}`
): Promise<{ ok: boolean; note?: string }> {
  try {
    const routerAddr = chain === "BSC" ? Routers.BSC.v2 : Routers.ETH.v2;
    const router = getContract({
      address: routerAddr,
      abi: ABI.uniV2RouterLike,
      client,
    });
    const base = pickBase(chain);

    // 避免 token 本身就是稳定币/基准币（此时卖向同币没意义，但视为可卖）
    if (isBaseToken(chain, token)) {
      return { ok: true, note: "token is base asset" };
    }

    // 确保有可用价格（用于兜底场景的 sanity）
    const usd = await getBaseTokenUsd(chain, base);
    if (usd === undefined) {
      return { ok: false, note: "no base USD quote" };
    }

    const dec = await getTokenDecimals(client, token);
    const amountIn = BigInt(Math.max(1, 10 ** Math.max(0, dec - 6))); // 10^(dec-6)，过小避免 0
    const path = [token, base] as `0x${string}`[];

    const out = (await router.read.getAmountsOut([amountIn, path])) as bigint[];
    if (!out || out.length < 2) return { ok: false, note: "no amountsOut" };
    if (out[1] <= 0n) return { ok: false, note: "zero out" };

    return { ok: true, note: `static getAmountsOut ok` };
  } catch (e: any) {
    // 若合约以反蜜罐逻辑在静态 call 也 revert，多半不可卖/强税
    return {
      ok: false,
      note: `revert: ${String(e?.shortMessage ?? e?.message ?? e)}`,
    };
  }
}
