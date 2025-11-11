import { logger } from "../logger.js";

/** 直接输出到控制台（同时走 logger） */
export async function tgSend(text: string) {
  console.log("\n" + text + "\n");
  logger.warn(text);
}

const DS_SLUG = {
  BSC: "bsc",
  ETH: "ethereum",
} as const;

const GMGN_SLUG = {
  BSC: "bsc",
  ETH: "eth",
} as const;

/** 生成一条中文告警消息 */
export function buildAlertMessage(params: {
  level: "normal" | "strong";
  chain: "BSC" | "ETH";
  type: "v2" | "v3";
  addr: `0x${string}`;
  token0: `0x${string}`;
  token1: `0x${string}`;
  target: "token0" | "token1";
  headline: string;
  body: string;
}) {
  const { level, chain, type, addr, token0, token1, target, body } = params;
  const levelText = level === "strong" ? "🚨 强烈预警" : "⚠️ 预警";
  const typeText = type === "v2" ? "V2 交易对" : "V3 流动池";
  const targetText = target === "token0" ? "Token0" : "Token1";

  const chainScan = chain === "BSC" ? "bscscan.com" : "etherscan.io";
  const scanLink = `https://${chainScan}/address/${addr}`;
  const token0Link = `https://${chainScan}/token/${token0}`;
  const token1Link = `https://${chainScan}/token/${token1}`;

  const quickLinks = buildQuickLinks(chain, addr);

  const lines = [
    `${levelText}｜${typeText}`,
    `链：${chain} ｜ 监控侧：${targetText}`,
    body,
  ];

  const referenceLines = [
    `区块浏览器：${scanLink}`,
    `Token0：${token0Link}`,
    `Token1：${token1Link}`,
  ];

  if (quickLinks) {
    referenceLines.push(`快捷跳转：${quickLinks}`);
  }

  return [...lines, "", ...referenceLines].join("\n");
}

function buildQuickLinks(chain: "BSC" | "ETH", addr: `0x${string}`) {
  const links: Array<{ label: string; url?: string }> = [
    {
      label: "DexScreener",
      url: `https://dexscreener.com/${DS_SLUG[chain]}/${addr}`,
    },
  ];

  return links
    .filter(({ url }) => !!url)
    .map(({ label, url }) => `${label}: ${url}`)
    .join(" ｜ ");
}
