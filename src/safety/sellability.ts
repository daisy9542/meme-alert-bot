import { getContract, PublicClient } from "viem";
import { ABI } from "../chains/abis.js";
import { CHAINS } from "../config.js";
import { getTokenDecimals } from "../price/reservesPrice.js";
import { getBaseTokenUsd, isBaseToken } from "../price/baseQuotes.js";
import { fetchPairData } from "../datasources/dexScreener.js";

/** ---- 常用路由 / Factory / Quoter 地址 ---- */
const Routers = {
  BSC: {
    v2: "0x10ED43C718714eb63d5aA57B78B54704E256024E", // Pancake V2 router
  },
  ETH: {
    v2: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D", // Uniswap V2 router
  },
} as const;

const V3Factories = {
  // PancakeSwap V3 Factory (BSC)
  BSC: "0x1097053Fd2ea711dad45caCcc45EfF7548fCB362",
  // Uniswap V3 Factory (Ethereum)
  ETH: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
} as const;

const V3Quoters = {
  // PancakeSwap V3 QuoterV2 (BSC)
  BSC: "0x78Df70615ffc8066cC0887917f2Cd72092C86409",
  // Uniswap V3 Quoter (Ethereum)
  ETH: "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6",
} as const;

/** ---- 选择“常见基准币集合”做 V2 多路径枚举 ---- */
function pickCommonBases(chain: "BSC" | "ETH"): `0x${string}`[] {
  const base =
    chain === "BSC" ? CHAINS.bsc.baseTokens : CHAINS.ethereum.baseTokens;

  // 尝试按优先级组织：原生包裹币 → 主流稳定 → 其他
  const order = ["WBNB", "WETH", "USDT", "USDC", "BUSD", "DAI"];
  const got: `0x${string}`[] = [];

  for (const k of order) {
    const addr = (base as any)[k];
    if (addr) got.push(addr);
  }
  // 兜底：把剩余的（若有）也补上
  for (const v of Object.values(base)) {
    if (!got.includes(v as `0x${string}`)) got.push(v as `0x${string}`);
  }
  // 去重
  return Array.from(new Set(got));
}

/** ---- 单一“首选基准币”（用于 sanity）---- */
function pickBase(chain: "BSC" | "ETH"): `0x${string}` {
  const base =
    chain === "BSC" ? CHAINS.bsc.baseTokens : CHAINS.ethereum.baseTokens;
  return (
    (base as any).USDT ??
    (base as any).USDC ??
    (base as any).WBNB ??
    (base as any).WETH ??
    (Object.values(base)[0] as `0x${string}`)
  );
}

/** ---- DexScreener 旁证：最近是否有卖单（弱信号）---- */
async function hasRecentSells(chain: "BSC" | "ETH", pool: `0x${string}`) {
  try {
    const data = await fetchPairData(chain, pool);
    const txns = data?.pair?.txns;
    const sellsM5 = Number(txns?.m5?.sells ?? 0);
    const sellsH1 = Number(txns?.h1?.sells ?? 0);
    if (sellsM5 > 0 || sellsH1 > 0) {
      return { ok: true, sellsM5, sellsH1 };
    }
    return { ok: false, note: "unobserved sells on DexScreener" };
  } catch (e: any) {
    return {
      ok: false,
      note: `dexscreener unavailable: ${String(e?.message ?? e)}`,
    };
  }
}

/**
 * 可卖性快速检查（V2，多路径枚举，静态只读）
 * - 会尝试 1 跳（token→base）与 2 跳（token→mid→dst）
 * - 任一路径返回正数，视为“存在可行路由”→ 弱肯定
 */
export async function checkSellabilityV2(
  chain: "BSC" | "ETH",
  client: PublicClient,
  token: `0x${string}`
): Promise<{ ok: boolean; note?: string; path?: `0x${string}`[] }> {
  try {
    // token 本身就是基准币：视为可卖（换基准币没意义，但不阻断）
    if (isBaseToken(chain, token)) {
      return { ok: true, note: "token is base asset" };
    }

    // sanity：确保有基准币美元价（你的 price 侧兜底需要）
    const sanityBase = pickBase(chain);
    const usd = await getBaseTokenUsd(chain, sanityBase);
    if (usd === undefined) {
      return { ok: false, note: "no base USD quote" };
    }

    const bases = pickCommonBases(chain);
    const routerAddr = chain === "BSC" ? Routers.BSC.v2 : Routers.ETH.v2;

    const router = getContract({
      address: routerAddr,
      abi: ABI.uniV2RouterLike,
      client,
    });

    const dec = await getTokenDecimals(client, token);
    const exponent = BigInt(dec > 6 ? dec - 6 : 0);
    const baseAmt = 10n ** exponent || 1n; // 10^(dec-6)，至少 1

    // 先试 1 跳：token -> base
    for (const base of bases) {
      const path = [token, base] as `0x${string}`[];
      try {
        const out = (await router.read.getAmountsOut([
          baseAmt,
          path,
        ])) as bigint[];
        if (out && out.length >= 2 && out[out.length - 1] > 0n) {
          return { ok: true, note: `V2 static ok: 1 hop`, path };
        }
      } catch {
        /* ignore */
      }
    }

    // 再试 2 跳：token -> mid -> dst
    for (const mid of bases) {
      if (mid.toLowerCase() === token.toLowerCase()) continue;
      for (const dst of bases) {
        if (dst === mid) continue;
        const path = [token, mid, dst] as `0x${string}`[];
        try {
          const out = (await router.read.getAmountsOut([
            baseAmt,
            path,
          ])) as bigint[];
          if (out && out.length >= 3 && out[out.length - 1] > 0n) {
            return { ok: true, note: `V2 static ok: 2 hops`, path };
          }
        } catch {
          /* ignore */
        }
      }
    }

    return { ok: false, note: "no static route found (V2)" };
  } catch (e: any) {
    return {
      ok: false,
      note: `V2 check error: ${String(e?.shortMessage ?? e?.message ?? e)}`,
    };
  }
}

/**
 * 可卖性快速检查（V3）
 * - 使用“池内对手币”做 Quoter 询价（不是全局 USDT/USDC）
 * - 校验 Factory.getPool 与 fee 档匹配
 * - 多尺度探针（1/10/100 * 10^(dec-6)）
 * - DexScreener 最近卖单作为弱旁证
 */
export async function checkSellabilityV3(params: {
  chain: "BSC" | "ETH";
  client: PublicClient;
  token0: `0x${string}`;
  token1: `0x${string}`;
  pool: `0x${string}`;
  fee?: number; // 若未传，默认 3000；也可外层循环 500/3000/10000
}): Promise<{ ok: boolean; note?: string; details?: any }> {
  try {
    const { chain, client, token0, token1 } = params;
    const fee = params.fee ?? 3000;

    // 判定池内哪一侧是“基准币”；如果两边都不是或两边都是，策略如下：
    const is0Base = isBaseToken(chain, token0);
    const is1Base = isBaseToken(chain, token1);

    // 两边都不是：缺少常用基准维度（仍可能能卖，但我们在本函数按规则认为弱否）
    if (!is0Base && !is1Base) {
      return { ok: false, note: "no recognized base token in pool" };
    }
    // 两边都是：大概率是稳定币/原生包裹币互换，视为可卖
    if (is0Base && is1Base) {
      // 仍可检查 pool 与 fee 匹配性
      const poolOk = await verifyPool(
        client,
        chain,
        token0,
        token1,
        fee,
        params.pool
      );
      if (!poolOk.ok) return poolOk;
      const sells = await hasRecentSells(chain, params.pool);
      return {
        ok: true,
        note: `both sides are base; sells=${
          sells.ok
            ? `m5:${(sells as any).sellsM5} h1:${(sells as any).sellsH1}`
            : sells.note
        }`,
      };
    }

    // 目标 token = 非基准币的一侧；对手币 = 池内的基准币
    const target = is0Base ? token1 : token0;
    const baseInPool = is0Base ? token0 : token1;

    // 校验：factory.getPool(token0, token1, fee) 是否等于传入的 pool
    const poolCheck = await verifyPool(
      client,
      chain,
      token0,
      token1,
      fee,
      params.pool
    );
    if (!poolCheck.ok) return poolCheck;

    // 多尺度 amountIn 探针（1/10/100 * 10^(dec-6)）
    const dec = await getTokenDecimals(client, target);
    const exp = BigInt(dec > 6 ? dec - 6 : 0);
    const unit = 10n ** exp || 1n;
    const probes = [1n * unit, 10n * unit, 100n * unit];

    const quoterAddr = V3Quoters[chain] as `0x${string}`;
    const results: Array<{ amtIn: bigint; out?: bigint; err?: string }> = [];

    for (const amt of probes) {
      try {
        const out = (await client.readContract({
          address: quoterAddr,
          abi: ABI.v3Quoter,
          functionName: "quoteExactInputSingle",
          args: [target, baseInPool, fee, amt, 0n],
        })) as bigint;

        results.push({ amtIn: amt, out });
      } catch (e: any) {
        results.push({
          amtIn: amt,
          err: String(e?.shortMessage ?? e?.message ?? e),
        });
      }
    }

    // 简单裁决：任一探针返回 > 0 即视为“有可成交区间”（弱肯定）
    const anyPositive = results.some((r) => (r.out ?? 0n) > 0n);
    if (!anyPositive) {
      return {
        ok: false,
        note: "v3 quoter no positive quote",
        details: results,
      };
    }

    // DexScreener 旁证（不作为硬否定）
    const sells = await hasRecentSells(chain, params.pool);

    return {
      ok: true,
      note: `v3 quoter ok${
        sells.ok
          ? `; sells m5=${(sells as any).sellsM5} h1=${(sells as any).sellsH1}`
          : `; ${sells.note}`
      }`,
      details: results,
    };
  } catch (e: any) {
    return {
      ok: false,
      note: `v3 check error: ${String(e?.shortMessage ?? e)}`,
    };
  }
}

/** ---- 校验 Factory.getPool 与 fee 档匹配，并对 pool 地址做一致性检查 ---- */
async function verifyPool(
  client: PublicClient,
  chain: "BSC" | "ETH",
  token0: `0x${string}`,
  token1: `0x${string}`,
  fee: number,
  expectedPool: `0x${string}`
): Promise<{ ok: true } | { ok: false; note: string }> {
  try {
    // factory.getPool 要求 token0 < token1（地址排序），UniswapV3/PancakeV3 均遵循此规则
    const [a, b] =
      token0.toLowerCase() < token1.toLowerCase()
        ? [token0, token1]
        : [token1, token0];

    const factory = V3Factories[chain] as `0x${string}`;
    const onChainPool = (await client.readContract({
      address: factory,
      abi: ABI.v3Factory,
      functionName: "getPool",
      args: [a, b, fee],
    })) as `0x${string}`;

    if (
      !onChainPool ||
      onChainPool.toLowerCase() === "0x0000000000000000000000000000000000000000"
    ) {
      return { ok: false, note: "factory.getPool returned zero address" };
    }
    if (onChainPool.toLowerCase() !== expectedPool.toLowerCase()) {
      return { ok: false, note: "fee tier mismatch or wrong pool address" };
    }
    return { ok: true };
  } catch (e: any) {
    return {
      ok: false,
      note: `factory.getPool error: ${String(
        e?.shortMessage ?? e?.message ?? e
      )}`,
    };
  }
}
