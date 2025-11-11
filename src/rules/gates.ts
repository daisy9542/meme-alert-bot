import { PublicClient } from "viem";
import { STRATEGY } from "../config.js";
import {
  hasMinLiquidityV2,
  hasMinLiquidityV3,
} from "../safety/minLiquidity.js";
import { checkSellabilityV2, checkSellabilityV3 } from "../safety/sellability.js";
import { lpRiskScore } from "../safety/lpRisk.js";
import { getAvgTaxApprox } from "../safety/taxEstimator.js";
import { isBaseToken } from "../price/baseQuotes.js";

/**
 * 安全闸门聚合：
 * - 最小流动性
 * - 可卖性（V2 快速校验；V3 暂略）
 * - LP 风险（是否与基准币配对、总体LP量级）
 * - 税率均值（若已有样本）
 */
export async function passSafetyGates(params: {
  chain: "BSC" | "ETH";
  type: "v2" | "v3";
  addr: `0x${string}`;
  client: PublicClient;
  token0: `0x${string}`;
  token1: `0x${string}`;
  fee?: number;
}) {
  const { chain, type, addr, client, token0, token1, fee } = params;
  const reasons: string[] = [];
  const lpNotes: string[] = [];
  let ok = true;

  // 1) 最小流动性
  const liq =
    type === "v2"
      ? await hasMinLiquidityV2({
          chain,
          client,
          pair: addr as any,
          token0,
          token1,
          minUsd: STRATEGY.MIN_LIQ_USD,
        })
      : await hasMinLiquidityV3({
          chain,
          pool: addr as any,
          minUsd: STRATEGY.MIN_LIQ_USD,
        });
  if (!liq.ok) {
    ok = false;
    reasons.push(`minLiquidity: ${liq.note ?? "fail"}`);
  }

  // 2) 可卖性（V2）
  if (ok) {
    if (type === "v2") {
      const sellToken =
        isBaseToken(chain, token0) && !isBaseToken(chain, token1)
          ? token1
          : token0;
      const sell = await checkSellabilityV2(chain, client, sellToken);
      if (!sell.ok) {
        ok = false;
        reasons.push(`sellability: ${sell.note ?? "fail"}`);
      }
    } else {
      const sell = await checkSellabilityV3({
        chain,
        client,
        token0,
        token1,
        pool: addr,
        fee,
      });
      if (!sell.ok) {
        ok = false;
        reasons.push(`sellability v3: ${sell.note ?? "fail"}`);
      }
    }
  }

  // 3) LP 风险打分
  if (ok) {
    const { score, notes } = await lpRiskScore({
      chain,
      type,
      addr,
      token0,
      token1,
    });
    lpNotes.push(...notes);
    reasons.push(`lpRisk: ${notes.join(", ")}`);
    if (score >= 2) {
      ok = false;
      reasons.push("lpRisk score too high");
    }
  }

  // 4) 税率均值（如果有样本）
  const tax = getAvgTaxApprox(chain, type, addr);
  if (tax.sellTax !== undefined && tax.sellTax > STRATEGY.MAX_TAX_PCT) {
    ok = false;
    reasons.push(`sellTax>${Math.round(STRATEGY.MAX_TAX_PCT * 100)}%`);
  }
  if (tax.buyTax !== undefined && tax.buyTax > STRATEGY.MAX_TAX_PCT) {
    ok = false;
    reasons.push(`buyTax>${Math.round(STRATEGY.MAX_TAX_PCT * 100)}%`);
  }

  return {
    ok,
    reasons: ok ? ["ok"] : reasons,
    context: {
      liquidityUsd: liq.usd,
      taxAvg: tax,
      lpNotes,
    },
  };
}
