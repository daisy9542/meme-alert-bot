import axios, { AxiosError } from "axios";
import { TTLStore } from "../state/stores.js";
import { CHAINS } from "../config.js";

type ChainLabel = "BSC" | "ETH";
interface DexTokenResponse {
  pairs?: Array<any>;
}
interface DexPairResponse {
  pair?: any;
}
interface DexTrendingResponse {
  pairs?: Array<any>;
}

const TOKEN_TTL_MS = 45_000; // 稍微拉长，减轻频率
const PAIR_TTL_MS = 45_000;
const TRENDING_TTL_MS = 30_000;

// —— 统一的 axios 实例，带 UA/Accept，避免被风控 —— //
const ds = axios.create({
  baseURL: "https://api.dexscreener.com",
  timeout: 8000,
  headers: {
    "User-Agent":
      "meme-alert-bot/1.0 (+https://github.com/yourname/meme-alert-bot)",
    Accept: "application/json",
    "Accept-Encoding": "gzip, deflate, br",
  },
});

// 简单重试（对 403/429/5xx 做 2 次指数退避）
async function getWithRetry<T>(url: string, tries = 3): Promise<T> {
  let delay = 400;
  for (let i = 0; i < tries; i++) {
    try {
      const { data } = await ds.get<T>(url);
      return data;
    } catch (e) {
      const err = e as AxiosError;
      const status = err.response?.status ?? 0;
      const retriable = status === 403 || status === 429 || status >= 500;
      if (!retriable || i === tries - 1) throw e;
      await new Promise((r) =>
        setTimeout(r, delay + Math.floor(Math.random() * 150))
      );
      delay *= 2;
    }
  }
  // 逻辑不会走到这
  throw new Error("unreachable");
}

const tokenCache = new TTLStore<DexTokenResponse>(TOKEN_TTL_MS);
const pairCache = new TTLStore<DexPairResponse>(PAIR_TTL_MS);
const trendingCache = new TTLStore<DexTrendingResponse>(TRENDING_TTL_MS);

function chainSlug(chain: ChainLabel) {
  return chain === "BSC" ? "bsc" : "ethereum";
}

// —— 基础：token / pair —— //
export async function fetchTokenData(chain: ChainLabel, token: `0x${string}`) {
  const key = `${chain}:token:${token.toLowerCase()}`;
  const cached = tokenCache.get(key);
  if (cached) return cached;
  const data = await getWithRetry<DexTokenResponse>(
    `/latest/dex/tokens/${token}`
  );
  tokenCache.set(key, data);
  return data;
}

export async function fetchPairData(chain: ChainLabel, pair: `0x${string}`) {
  const key = `${chain}:pair:${pair.toLowerCase()}`;
  const cached = pairCache.get(key);
  if (cached) return cached;
  const slug = chainSlug(chain);
  const data = await getWithRetry<DexPairResponse>(
    `/latest/dex/pairs/${slug}/${pair}`
  );
  pairCache.set(key, data);
  return data;
}

export function invalidatePair(chain: ChainLabel, pair: `0x${string}`) {
  pairCache.delete(`${chain}:pair:${pair.toLowerCase()}`);
}

// —— Trending：先尝试官方 trending，失败则降级到“热门基准币池” —— //
export async function fetchTrendingPairs(chain: ChainLabel, limit: number) {
  const key = `${chain}:trending:${limit}`;
  const cached = trendingCache.get(key);
  if (cached) return cached;

  const slug = chainSlug(chain);

  // 1) 先试官方 trending
  try {
    const data = await getWithRetry<DexTrendingResponse>(
      `/latest/dex/trending?chain=${slug}&limit=${limit}`
    );
    trendingCache.set(key, data);
    return data;
  } catch (e) {
    // 如果是 403/429/5xx，走降级；其它错误也降级
  }

  // 2) 降级：用“与基准币配对的热门池”近似 trending
  //    从每个基准币的 /tokens/<base> 取 pairs，筛选：liquidity.usd 高、近5~15分钟成交活跃
  const bases = Object.values(
    chain === "BSC" ? CHAINS.bsc.baseTokens : CHAINS.ethereum.baseTokens
  ) as `0x${string}`[];
  const MIN_LIQ_USD = 50_000; // 你可以读 STRATEGY.MIN_LIQ_USD
  const MAX_PER_BASE = Math.max(
    5,
    Math.min(40, Math.floor((limit * 1.2) / Math.max(1, bases.length)))
  );

  const buckets: any[] = [];
  for (const b of bases) {
    try {
      const tok = await getWithRetry<DexTokenResponse>(
        `/latest/dex/tokens/${b}`
      );
      const pairs = (tok?.pairs ?? [])
        .filter((p: any) => p?.chainId === slug || p?.chain === slug)
        .filter((p: any) => Number(p?.liquidity?.usd ?? 0) >= MIN_LIQ_USD)
        // 排序：优先 5 分钟成交额 / txns、再看 15 分钟
        .sort((a: any, c: any) => {
          const a5 =
            Number(a?.txns?.m5?.buys ?? 0) + Number(a?.txns?.m5?.sells ?? 0);
          const c5 =
            Number(c?.txns?.m5?.buys ?? 0) + Number(c?.txns?.m5?.sells ?? 0);
          if (c5 !== a5) return c5 - a5;
          const a15 =
            Number(a?.txns?.h1?.buys ?? 0) + Number(a?.txns?.h1?.sells ?? 0);
          const c15 =
            Number(c?.txns?.h1?.buys ?? 0) + Number(c?.txns?.h1?.sells ?? 0);
          return c15 - a15;
        })
        .slice(0, MAX_PER_BASE);
      buckets.push(...pairs);
    } catch {
      // 某个 base 失败无妨，继续
    }
  }

  // 去重 & 截断
  const seen = new Set<string>();
  const merged = [];
  for (const p of buckets) {
    const addr = p.pairAddress ?? p.pair ?? p.liquidity?.pair ?? p.poolAddress;
    if (!addr) continue;
    const k = `${slug}:${String(addr).toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(p);
    if (merged.length >= limit) break;
  }

  const fallback: DexTrendingResponse = { pairs: merged };
  trendingCache.set(key, fallback);
  return fallback;
}
