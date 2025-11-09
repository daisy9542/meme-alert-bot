import { PublicClient, getContract } from "viem";
import { ABI } from "../chains/abis.js";
import { windows } from "../state/windows.js";
import { deltaToUsdIfBase, getTokenDecimals } from "../price/reservesPrice.js";
import { fetchTokenUsdViaDexScreener } from "../price/baseQuotes.js";

/**
 * 将一笔 Swap 事件折算为 USD，并写入 1 分钟/10 分钟滑窗
 * - marketType: 'v2' | 'v3'
 * - target: 'token0' | 'token1'  表示“我们要监控的目标token是哪一侧”
 * - 事件字段来自 subscriptions.ts 的回调
 */

export async function onV2SwapToWindows(params: {
  chain: "BSC" | "ETH";
  client: PublicClient;
  addr: `0x${string}`; // pair
  token0: `0x${string}`;
  token1: `0x${string}`;
  target: "token0" | "token1";
  sender: `0x${string}`;
  to: `0x${string}`;
  amount0In: bigint;
  amount1In: bigint;
  amount0Out: bigint;
  amount1Out: bigint;
}): Promise<{ usd: number; isBuy: boolean } | undefined> {
  const { chain, client, addr, token0, token1, target } = params;

  // 归一化数量（自然量）
  const [d0, d1] = await Promise.all([
    getTokenDecimals(client, token0),
    getTokenDecimals(client, token1),
  ]);
  // token0 数量变化（买入 token0 => amount0Out > 0）
  const delta0 =
    Number(params.amount0Out) / 10 ** d0 - Number(params.amount0In) / 10 ** d0;
  const delta1 =
    Number(params.amount1Out) / 10 ** d1 - Number(params.amount1In) / 10 ** d1;

  let isBuy = false;
  let deltaTarget = 0;
  let buyer: `0x${string}` | undefined;

  if (target === "token0") {
    isBuy = delta0 > 0;
    deltaTarget = Math.abs(delta0);
  } else {
    isBuy = delta1 > 0;
    deltaTarget = Math.abs(delta1);
  }
  buyer = isBuy ? params.to : params.sender;

  // 折 USD（优先：基准币路径；否则 DexScreener 兜底）
  const usdByBase = await deltaToUsdIfBase(
    chain,
    { client, marketType: "v2", addr, token0, token1 },
    target,
    deltaTarget
  );
  const targetAddr = target === "token0" ? token0 : token1;
  const fallbackPrice = await fetchTokenUsdViaDexScreener(chain, targetAddr);
  const priceUsd =
    usdByBase ??
    (fallbackPrice !== undefined ? fallbackPrice * deltaTarget : undefined);

  if (
    typeof priceUsd === "number" &&
    Number.isFinite(priceUsd) &&
    priceUsd > 0
  ) {
    windows.recordTrade({
      chain,
      type: "v2",
      addr,
      usd: priceUsd,
      isBuy,
      buyer,
    });
    return { usd: priceUsd, isBuy };
  }
  return undefined;
}

export async function onV3SwapToWindows(params: {
  chain: "BSC" | "ETH";
  client: PublicClient;
  addr: `0x${string}`; // pool
  token0: `0x${string}`;
  token1: `0x${string}`;
  target: "token0" | "token1";
  sender: `0x${string}`;
  recipient: `0x${string}`;
  amount0: bigint; // 注意：V3 为有符号，>0 表示进池，<0 表示出池
  amount1: bigint;
}): Promise<{ usd: number; isBuy: boolean } | undefined> {
  const { chain, client, addr, token0, token1, target } = params;
  const [d0, d1] = await Promise.all([
    getTokenDecimals(client, token0),
    getTokenDecimals(client, token1),
  ]);
  // V3：amountX > 0 进池，amountX < 0 出池（给交易者）
  const delta0 = -Number(params.amount0) / 10 ** d0; // 统一成“交易者角度的正增量”
  const delta1 = -Number(params.amount1) / 10 ** d1;

  let isBuy = false;
  let deltaTarget = 0;
  let buyer: `0x${string}` | undefined;

  if (target === "token0") {
    isBuy = delta0 > 0;
    deltaTarget = Math.abs(delta0);
  } else {
    isBuy = delta1 > 0;
    deltaTarget = Math.abs(delta1);
  }
  buyer = isBuy ? params.recipient : params.sender;

  const usdByBase = await deltaToUsdIfBase(
    chain,
    { client, marketType: "v3", addr, token0, token1 },
    target,
    deltaTarget
  );
  const targetAddr = target === "token0" ? token0 : token1;
  const fallbackPrice = await fetchTokenUsdViaDexScreener(chain, targetAddr);
  const priceUsd =
    usdByBase ??
    (fallbackPrice !== undefined ? fallbackPrice * deltaTarget : undefined);

  if (
    typeof priceUsd === "number" &&
    Number.isFinite(priceUsd) &&
    priceUsd > 0
  ) {
    windows.recordTrade({
      chain,
      type: "v3",
      addr,
      usd: priceUsd,
      isBuy,
      buyer,
    });
    return { usd: priceUsd, isBuy };
  }
  return undefined;
}

/** 读取 1 分钟买入额/笔数/独立买家 */
export function getOneMinuteBuys(
  chain: "BSC" | "ETH",
  type: "v2" | "v3",
  addr: `0x${string}`
) {
  const { buyUsd, buyTxs, uniqueBuyers, totalUsd } = windows.oneMinute(
    chain,
    type,
    addr
  );
  return { buyUsd, buyTxs, uniqueBuyers, totalUsd };
}
