/**
 * 交易滑动窗口（USD 维度）
 * - 记录 10 分钟内的成交摘要（按“事件粒度”，而非按固定分桶存储）
 * - 暴露：1 分钟买入额/笔数/独立买家；1 分钟总成交额；过去 10 分钟总额；
 * - 基线：用“过去 10 分钟（含当前）减去最近 1 分钟”，再 / 9 得到 5–10 分钟均值（近似）
 *
 * 说明：
 * - 价格换算（token -> USD）不在这里做；调用方传入已折算好的 usd 值
 * - “买入/卖出”由上游根据路径/方向判断（比如以“目标token”为基准）
 */

export type ChainLabel = "BSC" | "ETH";
export type MarketType = "v2" | "v3";

export interface TradeEvent {
  ts: number;
  usd: number; // 该笔成交折合 USD
  isBuy: boolean; // 是否买入“目标token”
  buyer?: `0x${string}`; // 用于去重统计独立买家
}

class SlidingWindow {
  private events: TradeEvent[] = [];
  private buyers1m = new Set<string>(); // 最近1分钟的独立买家（快速查询用）
  private lastActiveTs = 0;

  constructor(private keepMs = 10 * 60_000) {
    this.lastActiveTs = Date.now();
  }

  private prune(now = Date.now()) {
    const cutoff = now - this.keepMs;
    while (this.events.length && this.events[0].ts < cutoff) {
      this.events.shift();
    }
  }

  record(ev: TradeEvent) {
    this.events.push(ev);
    this.lastActiveTs = ev.ts;
    // 轻 prune，避免频繁 O(n)
    if (this.events.length % 128 === 0) this.prune(ev.ts);
  }

  /** 最近 X 毫秒内的聚合 */
  private aggregateWithin(ms: number, now = Date.now()) {
    const start = now - ms;
    let totalUsd = 0;
    let buyUsd = 0;
    let buyTxs = 0;
    this.buyers1m.clear();

    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if (e.ts < start) break;
      totalUsd += e.usd;
      if (e.isBuy) {
        buyUsd += e.usd;
        buyTxs++;
        if (e.buyer) this.buyers1m.add(e.buyer.toLowerCase());
      }
    }
    return {
      totalUsd,
      buyUsd,
      buyTxs,
      uniqueBuyers: this.buyers1m.size,
    };
  }

  /** 最近 1 分钟指标 */
  oneMinute(now = Date.now()) {
    this.prune(now);
    return this.aggregateWithin(60_000, now);
  }

  /** 最近 10 分钟总额 */
  tenMinutesTotal(now = Date.now()) {
    this.prune(now);
    return this.aggregateWithin(10 * 60_000, now).totalUsd;
  }

  /**
   * 5–10 分钟“基线均值”（近似做法）：
   *   baseline = (total_10m - total_1m) / 9
   * 若 10 分钟总额 <= 1 分钟总额，则返回 0
   */
  baselineAvgPerMin(now = Date.now()) {
    const total10 = this.tenMinutesTotal(now);
    const total1 = this.oneMinute(now).totalUsd;
    const rest = Math.max(0, total10 - total1);
    return rest / 9;
  }

  lastActivityTs() {
    if (this.events.length) {
      return this.events[this.events.length - 1].ts;
    }
    return this.lastActiveTs;
  }
}

/** 多市场窗口管理 */
class WindowsManager {
  private m = new Map<string, SlidingWindow>();
  constructor(
    private keepMs = 10 * 60_000,
    private idleDropMs = 2 * 60 * 60_000
  ) {}

  key(chain: ChainLabel, type: MarketType, addr: `0x${string}`) {
    return `${chain}:${type}:${addr.toLowerCase()}`;
  }

  get(chain: ChainLabel, type: MarketType, addr: `0x${string}`) {
    const k = this.key(chain, type, addr);
    let w = this.m.get(k);
    if (!w) {
      w = new SlidingWindow(this.keepMs);
      this.m.set(k, w);
    }
    return w;
  }

  /** 记录一笔成交（已折USD） */
  recordTrade(params: {
    chain: ChainLabel;
    type: MarketType;
    addr: `0x${string}`;
    usd: number;
    isBuy: boolean;
    buyer?: `0x${string}`;
    ts?: number;
  }) {
    const w = this.get(params.chain, params.type, params.addr);
    w.record({
      ts: params.ts ?? Date.now(),
      usd: params.usd,
      isBuy: params.isBuy,
      buyer: params.buyer,
    });
    this.pruneIdle();
  }

  /** 快捷查询：1 分钟聚合 */
  oneMinute(chain: ChainLabel, type: MarketType, addr: `0x${string}`) {
    const w = this.get(chain, type, addr);
    const res = w.oneMinute();
    this.pruneIdle();
    return res;
  }

  /** 快捷查询：5–10 分钟基线均值 */
  baselineAvgPerMin(chain: ChainLabel, type: MarketType, addr: `0x${string}`) {
    const res = this.get(chain, type, addr).baselineAvgPerMin();
    this.pruneIdle();
    return res;
  }

  /** 最近 10 分钟总额 */
  tenMinutesTotal(chain: ChainLabel, type: MarketType, addr: `0x${string}`) {
    const res = this.get(chain, type, addr).tenMinutesTotal();
    this.pruneIdle();
    return res;
  }

  private pruneIdle(now = Date.now()) {
    for (const [key, window] of this.m.entries()) {
      const last = window.lastActivityTs();
      if (now - last > this.idleDropMs) {
        this.m.delete(key);
      }
    }
  }
}

export const windows = new WindowsManager();
