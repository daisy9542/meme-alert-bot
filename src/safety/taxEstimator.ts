import { PublicClient } from "viem";
import {
  getV2RelativePrice,
  getV3RelativePrice,
} from "../price/reservesPrice.js";

/**
 * 税率粗估（近似）：
 * - 对“卖出目标 token → 基准币”的成交，估算：
 *      expectedBaseOut = tokenIn * midPrice(token/base)
 *      observedBaseOut = 事件里实际得到的基准币数量
 *      taxApprox = clamp(1 - observed / expected, 0, 1)
 * - 对“买入目标 token”的成交，可估“买入有效扣费”（同理）
 *
 * 该方法受池子深度/滑点影响，但在极端税/蜜罐场景会显著偏高，足以用于闸门剔除。
 */

export type MarketType = "v2" | "v3";
type ChainLabel = "BSC" | "ETH";

export interface TaxSample {
  ts: number;
  buyTax?: number; // 有效买入扣费近似（0~1）
  sellTax?: number; // 有效卖出扣费近似（0~1）
}

const samples = new Map<string, TaxSample[]>();

function key(chain: ChainLabel, type: MarketType, addr: `0x${string}`) {
  return `${chain}:${type}:${addr.toLowerCase()}`;
}
function pushSample(k: string, s: TaxSample, keepMs = 10 * 60_000) {
  const arr = samples.get(k) ?? [];
  arr.push(s);
  const cutoff = Date.now() - keepMs;
  while (arr.length && arr[0].ts < cutoff) arr.shift();
  samples.set(k, arr);
}
function avg(arr: number[]) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : undefined;
}

/**
 * 记录一笔成交并更新有效税率近似
 * @param direction 'sellToken' 表示目标token -> 基准币；'buyToken' 表示基准币 -> 目标token
 * @param tokenIn  目标token方向的输入数量（decimals 归一后的“自然量”）
 * @param baseOut  目标为 'sellToken' 时实际得到的基准币数量（自然量）
 * @param baseIn   目标为 'buyToken' 时实际支付的基准币数量（自然量）
 * @param client   用于取 mid price（V2 reserves / V3 slot0）
 */
export async function recordTaxApprox(params: {
  chain: ChainLabel;
  type: MarketType;
  addr: `0x${string}`;
  client: PublicClient;
  token0: `0x${string}`;
  token1: `0x${string}`;
  direction: "sellToken0" | "sellToken1" | "buyToken0" | "buyToken1";
  tokenIn?: number;
  baseOut?: number;
  baseIn?: number;
}) {
  const { chain, type, addr, client, token0, token1, direction } = params;
  const k = key(chain, type, addr);

  // mid price
  const rel =
    type === "v2"
      ? await getV2RelativePrice(client, addr as any, token0, token1)
      : await getV3RelativePrice(client, addr as any, token0, token1);
  if (!rel) return;

  const now = Date.now();
  if (
    direction === "sellToken0" &&
    params.tokenIn !== undefined &&
    params.baseOut !== undefined
  ) {
    // price(base per token0) = p1in0  (若 token1 是基准币)
    const mid = rel.p1in0;
    const expected = params.tokenIn * mid;
    const obs = params.baseOut;
    const tax = Math.max(0, Math.min(1, 1 - obs / Math.max(expected, 1e-12)));
    pushSample(k, { ts: now, sellTax: tax });
  }
  if (
    direction === "sellToken1" &&
    params.tokenIn !== undefined &&
    params.baseOut !== undefined
  ) {
    const mid = rel.p0in1;
    const expected = params.tokenIn * mid;
    const obs = params.baseOut;
    const tax = Math.max(0, Math.min(1, 1 - obs / Math.max(expected, 1e-12)));
    pushSample(k, { ts: now, sellTax: tax });
  }
  if (
    direction === "buyToken0" &&
    params.baseIn !== undefined &&
    params.tokenIn !== undefined
  ) {
    const mid = 1 / rel.p1in0; // token0 per base
    const expected = params.baseIn * mid;
    const obs = params.tokenIn;
    const tax = Math.max(0, Math.min(1, 1 - obs / Math.max(expected, 1e-12)));
    pushSample(k, { ts: now, buyTax: tax });
  }
  if (
    direction === "buyToken1" &&
    params.baseIn !== undefined &&
    params.tokenIn !== undefined
  ) {
    const mid = 1 / rel.p0in1;
    const expected = params.baseIn * mid;
    const obs = params.tokenIn;
    const tax = Math.max(0, Math.min(1, 1 - obs / Math.max(expected, 1e-12)));
    pushSample(k, { ts: now, buyTax: tax });
  }
}

/** 读取过去 N 分钟的均值（默认 10 分钟窗口） */
export function getAvgTaxApprox(
  chain: ChainLabel,
  type: MarketType,
  addr: `0x${string}`
) {
  const k = key(chain, type, addr);
  const arr = samples.get(k) ?? [];
  const buys = arr.map((s) => s.buyTax!).filter((v) => typeof v === "number");
  const sells = arr.map((s) => s.sellTax!).filter((v) => typeof v === "number");
  return {
    buyTax: avg(buys),
    sellTax: avg(sells),
  };
}
