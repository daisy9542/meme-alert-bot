import { windows } from "../state/windows.js";

/**
 * 量能倍增：最近 1 分钟成交额 / 过去 5–10 分钟均值
 * - windows.baselineAvgPerMin() 已经返回 5–10 分钟均值（近似）
 */
export function getVolumeMultiplier(
  chain: "BSC" | "ETH",
  type: "v2" | "v3",
  addr: `0x${string}`
) {
  const one = windows.oneMinute(chain, type, addr).totalUsd;
  const base = windows.baselineAvgPerMin(chain, type, addr);
  if (base <= 0) return { ratio: Infinity, one, base };
  return { ratio: one / base, one, base };
}
