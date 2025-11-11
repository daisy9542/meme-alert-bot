import { STRATEGY } from "../config.js";
import { getOneMinuteBuys } from "../metrics/volume.js";
import { getVolumeMultiplier } from "../metrics/velocity.js";
import { computeFdvNow, fdvHistory } from "../metrics/fdv.js";

/**
 * 告警评估：
 * - 输入：最近一笔成交是否“鲸鱼级”（由上游判断并传入）、watchlist.meta.lastMintUsd（大额加池加分）
 * - 计算：1m 买入额/笔数、量能倍增、FDV 增幅
 * - 输出：'none' | 'normal' | 'strong' + 说明
 */

export type AlertLevel = "none" | "normal" | "strong";

export async function evaluateAlerts(params: {
  chain: "BSC" | "ETH";
  type: "v2" | "v3";
  addr: `0x${string}`;
  client: any;
  token0: `0x${string}`;
  token1: `0x${string}`;
  target: "token0" | "token1";
  lastTradeUsd?: number;
  lastTradeIsBuy?: boolean;
  lastTradeBuyerUsd?: number; // 单笔买入的 USD（用来判断鲸鱼）
  lastMintUsd?: number; // 最近一次大额加池（权重加分）
  liquidityUsd?: number; // 当前可见 LP
}) {
  const { chain, type, addr, client, token0, token1, target } = params;

  // 1) 1m 买入额/笔数/独立买家
  const vol = getOneMinuteBuys(chain, type, addr);

  // 2) 量能倍增
  const vel = getVolumeMultiplier(chain, type, addr);

  // 3) FDV 增幅（记录并计算 3 分钟倍数）
  const fdvNow = await computeFdvNow({
    chain,
    client,
    type,
    addr,
    token0,
    token1,
    target,
  });
  let fdvRatio: number | undefined;
  if (fdvNow !== undefined) {
    fdvHistory.push(chain, type, addr, fdvNow);
    fdvRatio = fdvHistory.getMultiplier(chain, type, addr, 3).ratio;
  }

  // 判定项
  const hitBuy =
    vol.buyUsd >= STRATEGY.BUY_VOL_1M_USD && vol.buyTxs >= STRATEGY.BUY_TXS_1M;
  const hitVel =
    vel.ratio === Infinity || vel.ratio >= STRATEGY.VOLUME_MULTIPLIER;
  const hitFdv = fdvRatio !== undefined && fdvRatio >= STRATEGY.FDV_MULTIPLIER;
  const whaleRatio =
    params.lastTradeIsBuy &&
    params.lastTradeUsd !== undefined &&
    params.liquidityUsd !== undefined &&
    params.liquidityUsd > 0
      ? params.lastTradeUsd / params.liquidityUsd
      : undefined;

  const hitWhale = !!(
    params.lastTradeIsBuy &&
    ((whaleRatio !== undefined &&
      whaleRatio >= STRATEGY.WHALE_LIQUIDITY_RATIO) ||
      (params.lastTradeBuyerUsd ?? 0) >= STRATEGY.WHALE_SINGLE_BUY_USD)
  );

  // 综合评分（简单线性加权；大额加池加分）
  let score = 0;
  if (hitBuy) score += 2;
  if (hitVel) score += 2;
  if (hitFdv) score += 2;
  if (hitWhale) score += 3;
  if ((params.lastMintUsd ?? 0) >= STRATEGY.MIN_LIQ_USD * 1.2) score += 1;

  let level: AlertLevel = "none";
  if (score >= 6 && (hitWhale || (hitVel && hitFdv))) level = "strong";
  else if (score >= 3) level = "normal";

  const triggerReasons: string[] = [];
  if (hitBuy) triggerReasons.push("1 分钟买入额/笔数超阈值");
  if (hitVel) triggerReasons.push("成交量瞬时倍增");
  if (hitFdv) triggerReasons.push("FDV 3 分钟倍增");
  if (hitWhale) triggerReasons.push("出现鲸鱼级买单");

  const lines: string[] = [];
  if (triggerReasons.length) {
    lines.push(`触发因子：${triggerReasons.join("，")}`);
  }
  lines.push(
    `1 分钟买入：$${vol.buyUsd.toFixed(0)} / ${vol.buyTxs} 笔 / ${
      vol.uniqueBuyers
    } 地址`
  );
  lines.push(
    `量能倍数：${vel.ratio === Infinity ? "∞" : vel.ratio.toFixed(2)}×`
  );
  if (fdvNow !== undefined && fdvRatio !== undefined) {
    lines.push(
      `FDV：${(fdvNow / 1e6).toFixed(2)}M，总值提升 ${fdvRatio.toFixed(
        2
      )}× / 3 分钟`
    );
  }
  if (hitWhale) {
    if (whaleRatio !== undefined && Number.isFinite(whaleRatio)) {
      const tradeText =
        params.lastTradeUsd !== undefined
          ? `$${params.lastTradeUsd.toFixed(0)}`
          : "未知金额";
      lines.push(
        `鲸鱼买入：吞噬 ${(whaleRatio * 100).toFixed(2)}% 流动性（${tradeText}）`
      );
    } else {
      lines.push(
        `鲸鱼买入：单笔金额 ≥ $${STRATEGY.WHALE_SINGLE_BUY_USD.toFixed(0)}`
      );
    }
  }

  return {
    level,
    message: lines.join(" | "),
    flags: { hitBuy, hitVel, hitFdv, hitWhale },
    metrics: { oneMin: vol, velocity: vel, fdvNow, fdvRatio },
  };
}
