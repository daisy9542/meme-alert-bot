/**
 * 轻量内存型 KV/Set 封装（后续可无缝替换为 Redis）
 */

export class KVStore<V> {
  private m = new Map<string, V>();
  get size() {
    return this.m.size;
  }
  has(key: string) {
    return this.m.has(key);
  }
  get(key: string) {
    return this.m.get(key);
  }
  set(key: string, v: V) {
    this.m.set(key, v);
    return this;
  }
  delete(key: string) {
    return this.m.delete(key);
  }
  keys() {
    return this.m.keys();
  }
  values() {
    return this.m.values();
  }
  entries() {
    return this.m.entries();
  }
  toObject(): Record<string, V> {
    return Object.fromEntries(this.m.entries());
  }
}

/** 简单 TTL Map（毫秒级），用于缓存侧信道价格等 */
export class TTLStore<V> {
  private m = new Map<string, { v: V; exp: number }>();
  constructor(private defaultTtlMs: number) {}

  get(key: string): V | undefined {
    const rec = this.m.get(key);
    if (!rec) return undefined;
    if (Date.now() > rec.exp) {
      this.m.delete(key);
      return undefined;
    }
    return rec.v;
  }
  set(key: string, v: V, ttlMs?: number) {
    this.m.set(key, { v, exp: Date.now() + (ttlMs ?? this.defaultTtlMs) });
  }
  has(key: string) {
    return this.get(key) !== undefined;
  }
  delete(key: string) {
    return this.m.delete(key);
  }
}

/** 去重集合（带可选 TTL），常用于避免重复订阅 */
export class DedupSet {
  private m = new Map<string, number>();
  constructor(private ttlMs = 0) {}
  has(key: string) {
    if (!this.ttlMs) return this.m.has(key);
    const exp = this.m.get(key);
    if (!exp) return false;
    if (Date.now() > exp) {
      this.m.delete(key);
      return false;
    }
    return true;
  }
  add(key: string) {
    if (!this.ttlMs) {
      this.m.set(key, Number.MAX_SAFE_INTEGER);
      return;
    }
    this.m.set(key, Date.now() + this.ttlMs);
  }
  delete(key: string) {
    return this.m.delete(key);
  }
}
