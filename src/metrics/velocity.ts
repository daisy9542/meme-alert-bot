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
  const oneMinuteStats = windows.oneMinute(chain, type, addr);
  const baseline = windows.baselineAvgPerMin(chain, type, addr);
  const tenMinuteStats = windows.tenMinutesStats(chain, type, addr);
  const tradeCountBaseline = Math.max(0, tenMinuteStats.buyTxs - oneMinuteStats.buyTxs);
  const meetsSampleRequirement = tradeCountBaseline >= 3;
  if (!meetsSampleRequirement || baseline <= 0) {
    return {
      ratio: meetsSampleRequirement ? Infinity : undefined,
      one: oneMinuteStats.totalUsd,
      base: baseline,
      sufficientHistory: meetsSampleRequirement,
    } as const;
  }
  return {
    ratio: oneMinuteStats.totalUsd / baseline,
    one: oneMinuteStats.totalUsd,
    base: baseline,
    sufficientHistory: true,
  };
}
