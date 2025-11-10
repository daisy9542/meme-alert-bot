import { TTLStore } from "../state/stores.js";
import { CHAINS } from "../config.js";
import { fetchTokenData } from "../datasources/dexScreener.js";

/**
 * 从 DexScreener 获取 token 的 USD 价格（选择流动性最大的交易对）
 * 文档示例：GET https://api.dexscreener.com/latest/dex/tokens/{tokenAddress}
 * 响应中每个 pair 含 priceUsd 与 liquidity.usd；我们按 chain 过滤并选最大流动性
 */
const QUOTE_TTL_MS = 30_000;
const cache = new TTLStore<number>(QUOTE_TTL_MS);

function chainIdForDex(chainLabel: "BSC" | "ETH"): string {
  return chainLabel === "BSC" ? "bsc" : "ethereum";
}

export async function fetchTokenUsdViaDexScreener(
  chain: "BSC" | "ETH",
  tokenAddress: `0x${string}`
): Promise<number | undefined> {
  const key = `dexscreener:${chain}:${tokenAddress.toLowerCase()}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  try {
    const data = await fetchTokenData(chain, tokenAddress);
    const pairs: any[] = data?.pairs ?? [];
    if (!Array.isArray(pairs) || pairs.length === 0) return undefined;

    const cid = chainIdForDex(chain);
    // 过滤目标链，并按流动性 USD 降序，取第一
    const best = pairs
      .filter(
        (p) =>
          (p.chainId === cid || p.chain === cid) &&
          p.priceUsd &&
          p.liquidity?.usd
      )
      .sort(
        (a, b) => Number(b.liquidity.usd ?? 0) - Number(a.liquidity.usd ?? 0)
      )[0];

    if (!best) return undefined;
    const price = Number(best.priceUsd);
    if (!Number.isFinite(price)) return undefined;
    cache.set(key, price);
    return price;
  } catch {
    return undefined;
  }
}

/**
 * 获取“基准币”的 USD 报价：
 * - 优先 DexScreener
 * - 失败时对稳定币回退为 ~1 美元
 */
export async function getBaseTokenUsd(
  chain: "BSC" | "ETH",
  tokenAddress: `0x${string}`
): Promise<number | undefined> {
  const addr = tokenAddress.toLowerCase();
  const base =
    chain === "BSC" ? CHAINS.bsc.baseTokens : CHAINS.ethereum.baseTokens;
  const isStable =
    addr === base.USDT.toLowerCase() ||
    ((base as any).USDC && addr === (base as any).USDC.toLowerCase()) ||
    ((base as any).BUSD && addr === (base as any).BUSD.toLowerCase()) ||
    ((base as any).DAI && addr === (base as any).DAI.toLowerCase());

  const fromApi = await fetchTokenUsdViaDexScreener(chain, tokenAddress);
  if (fromApi !== undefined) return fromApi;

  if (isStable) return 1; // 简单回退：稳定币退 1 美元（极端行情可再加权）
  return undefined;
}

/** 批量预取（便于定时 warm cache） */
export async function prefetchBaseQuotes(chain: "BSC" | "ETH") {
  const base =
    chain === "BSC" ? CHAINS.bsc.baseTokens : CHAINS.ethereum.baseTokens;
  const addrs = Object.values(base) as `0x${string}`[];
  await Promise.allSettled(addrs.map((a) => getBaseTokenUsd(chain, a)));
}

/** 判断某地址是否是“基准币”之一（便于价格折算路径判断） */
export function isBaseToken(chain: "BSC" | "ETH", addr: `0x${string}`) {
  const a = addr.toLowerCase();
  const base =
    chain === "BSC" ? CHAINS.bsc.baseTokens : CHAINS.ethereum.baseTokens;
  return Object.values(base).some((x) => x.toLowerCase() === a);
}
