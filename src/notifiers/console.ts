import { logger } from "../logger.js";

/** 直接输出到控制台（同时走 logger） */
export async function tgSend(text: string) {
  // 控制台立刻可见
  console.log("\n" + text + "\n");
  // 也写入日志（便于收集）
  logger.info(text);
}

/** 生成一条纯文本告警消息（不含 Markdown） */
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
  const { level, chain, type, addr, token0, token1, target, headline, body } =
    params;

  const chainScan = chain === "BSC" ? "bscscan.com" : "etherscan.io";
  const dexText = type === "v2" ? "Pair" : "Pool";
  const urlScan = `https://${chainScan}/address/${addr}`;
  const urlT0 = `https://${chainScan}/token/${token0}`;
  const urlT1 = `https://${chainScan}/token/${token1}`;

  const lines = [
    level === "strong" ? "🚨 STRONG ALERT" : "⚠️ Alert",
    headline,
    `Chain: ${chain}   Type: ${dexText}`,
    `Target: ${target}`,
    "",
    body,
    "",
    `Links: ${urlScan} | ${urlT0} | ${urlT1}`,
  ];
  return lines.join("\n");
}
