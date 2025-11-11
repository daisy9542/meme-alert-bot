import { PublicClient, getContract } from "viem";
import { PARSED_ABI } from "../chains/abis.js";
import { fetchTokenUsdViaDexScreener } from "../price/baseQuotes.js";
import {
  v2PricesUsdIfBase,
  v3PricesUsdIfBase,
  getTokenDecimals,
} from "../price/reservesPrice.js";

/**
 * 计算 FDV（近似）：totalSupply × priceUsd
 * - priceUsd 优先通过“与基准币的相对价”折算，失败时 DexScreener 兜底
 * - 维护一个短历史，用于计算“短时倍增”
 */

type ChainLabel = "BSC" | "ETH";
type MarketType = "v2" | "v3";

const FDV_CACHE_TTL_MS = 30_000;
const fdvCache = new Map<string, { ts: number; value: number }>();

function fdvCacheKey(chain: ChainLabel, token: `0x${string}`) {
  return `${chain}:${token.toLowerCase()}`;
}

/** 近历史（最多 15 分钟） */
class FdvHistory {
  private m = new Map<string, Array<{ ts: number; fdv: number }>>();
  private key(chain: ChainLabel, type: MarketType, addr: `0x${string}`) {
    return `${chain}:${type}:${addr.toLowerCase()}`;
  }
  push(chain: ChainLabel, type: MarketType, addr: `0x${string}`, fdv: number) {
    const k = this.key(chain, type, addr);
    const arr = this.m.get(k) ?? [];
    arr.push({ ts: Date.now(), fdv });
    const cutoff = Date.now() - 15 * 60_000;
    while (arr.length && arr[0].ts < cutoff) arr.shift();
    this.m.set(k, arr);
  }
  /** 返回当前 vs N 分钟前的倍数（找离 N 分钟最近的一个点） */
  getMultiplier(
    chain: ChainLabel,
    type: MarketType,
    addr: `0x${string}`,
    minutes = 3
  ) {
    const k = this.key(chain, type, addr);
    const arr = this.m.get(k) ?? [];
    if (!arr.length) return { now: undefined, ratio: undefined };
    const now = arr[arr.length - 1].fdv;
    const targetTs = Date.now() - minutes * 60_000;
    let prev = arr[0].fdv;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].ts <= targetTs) {
        prev = arr[i].fdv;
        break;
      }
    }
    if (!prev || prev <= 0) return { now, ratio: undefined };
    return { now, ratio: now / prev };
  }
}
export const fdvHistory = new FdvHistory();

/** 计算当前 FDV；需要 token 地址（目标一侧）与价格获取方式 */
export async function computeFdvNow(params: {
  chain: ChainLabel;
  client: PublicClient;
  type: MarketType;
  addr: `0x${string}`; // pair 或 pool
  token0: `0x${string}`;
  token1: `0x${string}`;
  target: "token0" | "token1";
}): Promise<number | undefined> {
  const { chain, client, type, addr, token0, token1, target } = params;
  const token = target === "token0" ? token0 : token1;
  const cacheKey = fdvCacheKey(chain, token);
  const nowTs = Date.now();
  const cached = fdvCache.get(cacheKey);
  if (cached && nowTs - cached.ts < FDV_CACHE_TTL_MS) {
    return cached.value;
  }

  // 1) totalSupply
  const erc = getContract({ address: token, abi: PARSED_ABI.erc20, client });
  const [supplyBI, dec] = await Promise.all([
    erc.read.totalSupply() as Promise<bigint>,
    getTokenDecimals(client, token),
  ]);
  const supply = Number(supplyBI) / 10 ** dec;

  // 2) priceUsd：优先池内与基准币的相对价，失败则 DexScreener
  let priceUsd: number | undefined;
  if (type === "v2") {
    const p = await v2PricesUsdIfBase(chain, client, addr, token0, token1);
    priceUsd = target === "token0" ? p.price0Usd : p.price1Usd;
  } else {
    const p = await v3PricesUsdIfBase(chain, client, addr, token0, token1);
    priceUsd = target === "token0" ? p.price0Usd : p.price1Usd;
  }
  if (priceUsd === undefined) {
    priceUsd = await fetchTokenUsdViaDexScreener(chain, token);
  }
  if (priceUsd === undefined || !Number.isFinite(priceUsd)) return undefined;

  const fdv = supply * priceUsd;
  fdvCache.set(cacheKey, { ts: nowTs, value: fdv });
  return fdv;
}
