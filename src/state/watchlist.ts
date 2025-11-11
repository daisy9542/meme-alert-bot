import { KVStore } from "./stores.js";

export type ChainLabel = "BSC" | "ETH";
export type MarketType = "v2" | "v3";

export type WatchStatus = "pending" | "active" | "rejected";

export interface WatchEntry {
  key: string; // `${chain}:${type}:${addr}`
  chain: ChainLabel;
  type: MarketType;
  address: `0x${string}`; // pair（v2）或 pool（v3）
  token0: `0x${string}`;
  token1: `0x${string}`;
  fee?: number; // v3 可选
  firstSeen: number; // ts
  lastUpdated: number;
  status: WatchStatus;
  reason?: string; // 被拒绝原因或备注
  meta: {
    lastMintUsd?: number; // 最近一次加池美元值（给权重加分）
    baseTokenHint?: `0x${string}`; // 识别哪个是主流基准币（价格换算用的“报价资产”）
    liquidityUsd?: number; // 激活时可见的 LP 美元
  };
}

/** 统一 key 生成 */
export function marketKey(
  chain: ChainLabel,
  type: MarketType,
  address: `0x${string}`
) {
  return `${chain}:${type}:${address.toLowerCase()}`;
}

/** Watchlist in-memory 实现 */
class WatchlistStore {
  private store = new KVStore<WatchEntry>();
  constructor(
    private activeTtlMs = 24 * 60 * 60_000,
    private inactiveTtlMs = 60 * 60_000
  ) {}

  enqueueNew(
    params: Omit<
      WatchEntry,
      "firstSeen" | "lastUpdated" | "status" | "reason" | "meta" | "key"
    > & { fee?: number }
  ) {
    const key = marketKey(params.chain, params.type, params.address);
    if (this.store.has(key)) return this.store.get(key)!;
    const entry: WatchEntry = {
      key,
      ...params,
      firstSeen: Date.now(),
      lastUpdated: Date.now(),
      status: "pending",
      meta: {},
    };
    this.store.set(key, entry);
    return entry;
  }

  get(key: string) {
    return this.store.get(key);
  }
  has(key: string) {
    return this.store.has(key);
  }

  /** 通过“安全闸门”后设置为 active */
  activate(key: string, patch?: Partial<WatchEntry["meta"]>) {
    const e = this.store.get(key);
    if (!e) return;
    e.status = "active";
    e.lastUpdated = Date.now();
    e.meta = { ...e.meta, ...(patch ?? {}) };
  }

  /** 未通过闸门，拒绝并附带原因 */
  reject(key: string, reason: string) {
    const e = this.store.get(key);
    if (!e) return;
    e.status = "rejected";
    e.reason = reason;
    e.lastUpdated = Date.now();
  }

  /** 更新附加元信息（例如记录一次大额加池） */
  patchMeta(key: string, patch: Partial<WatchEntry["meta"]>) {
    const e = this.store.get(key);
    if (!e) return;
    e.meta = { ...e.meta, ...patch };
    e.lastUpdated = Date.now();
  }

  list(status?: WatchStatus) {
    const out: WatchEntry[] = [];
    for (const [, v] of this.store.entries()) {
      if (!status || v.status === status) out.push(v);
    }
    return out;
  }

  /** 清理过期条目，返回被移除的 key */
  sweep(now = Date.now()) {
    const removed: string[] = [];
    for (const [key, entry] of this.store.entries()) {
      const ttl = entry.status === "active" ? this.activeTtlMs : this.inactiveTtlMs;
      if (now - entry.lastUpdated > ttl) {
        this.store.delete(key);
        removed.push(key);
      }
    }
    return removed;
  }
}

export const watchlist = new WatchlistStore();
