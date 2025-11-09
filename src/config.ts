import "dotenv/config";
import { z } from "zod";
import { dex } from "./chains/dexAddresses.js";

/** 环境变量校验与默认值 */
const EnvSchema = z.object({
  BSC_WSS: z.string().url().or(z.string().min(1)).describe("BSC WSS RPC URL"),
  ETH_WSS: z.string().url().or(z.string().min(1)).describe("ETH WSS RPC URL"),

  // TG_BOT_TOKEN: z.string().min(1),
  // TG_CHAT_ID: z.string().min(1),

  MIN_LIQ_USD: z.string().optional(),
  BUY_VOL_1M_USD: z.string().optional(),
  BUY_TXS_1M: z.string().optional(),
  VOLUME_MULTIPLIER: z.string().optional(),
  FDV_MULTIPLIER: z.string().optional(),
  WHALE_SINGLE_BUY_USD: z.string().optional(),
});

const env = EnvSchema.parse(process.env);

/** 策略与阈值（可在 .env 覆盖） */
export const STRATEGY = {
  MIN_LIQ_USD: Number(env.MIN_LIQ_USD ?? 5000),
  BUY_VOL_1M_USD: Number(env.BUY_VOL_1M_USD ?? 15000),
  BUY_TXS_1M: Number(env.BUY_TXS_1M ?? 8),
  VOLUME_MULTIPLIER: Number(env.VOLUME_MULTIPLIER ?? 5),
  FDV_MULTIPLIER: Number(env.FDV_MULTIPLIER ?? 3),
  WHALE_SINGLE_BUY_USD: Number(env.WHALE_SINGLE_BUY_USD ?? 5000),
  MAX_TAX_PCT: 0.2, // 粗估可接受税率上限（20%）
};

/** 需要监听的链与 DEX 工厂 */
export const CHAINS = {
  bsc: {
    id: 56,
    name: "BSC",
    wss: env.BSC_WSS,
    dex: {
      pancakeV2Factory: dex.bsc.pancakeV2.factory,
      pancakeV3Factory: dex.bsc.pancakeV3.factory,
    },
    baseTokens: dex.bsc.baseTokens,
  },
  ethereum: {
    id: 1,
    name: "ETH",
    wss: env.ETH_WSS,
    dex: {
      uniV2Factory: dex.ethereum.uniswapV2.factory,
      uniV3Factory: dex.ethereum.uniswapV3.factory,
    },
    baseTokens: dex.ethereum.baseTokens,
  },
} as const;

/** Telegram 配置 */
// export const TELEGRAM = {
//   token: env.TG_BOT_TOKEN,
//   chatId: env.TG_CHAT_ID,
// };

/** 一些通用常量 */
export const CONSTANTS = {
  WINDOW_MS: {
    ONE_MIN: 60_000,
    FIVE_MIN: 300_000,
    TEN_MIN: 600_000,
  },
};
