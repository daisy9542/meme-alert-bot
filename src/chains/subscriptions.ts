import { parseAbiItem, PublicClient } from "viem";
import { ABI } from "./abis.js";
import { CHAINS } from "../config.js";
import { logger } from "../logger.js";

type LogArgs = Record<string | number, unknown> | readonly unknown[] | undefined;

function getLogArg<T>(args: LogArgs, name: string, index: number): T | undefined {
  if (!args) return undefined;
  if (Array.isArray(args)) {
    const value = args[index];
    return (value !== undefined ? (value as T) : undefined) as T | undefined;
  }
  if (typeof args === "object") {
    const record = args as Record<string | number, unknown>;
    if (record[name] !== undefined) return record[name] as T;
    if (record[index] !== undefined) return record[index] as T;
  }
  return undefined;
}

/** —— 事件解析器 —— */
const pairCreatedItem = parseAbiItem(ABI.v2Factory[0]); // PairCreated
const poolCreatedItem = parseAbiItem(ABI.v3Factory[0]); // PoolCreated

const v2SwapItem = parseAbiItem(ABI.v2Pair[0]); // Swap (V2)
const v2MintItem = parseAbiItem(ABI.v2Pair[1]); // Mint (V2)

const v3SwapItem = parseAbiItem(ABI.v3Pool[0]); // Swap (V3)

/** 回调类型定义 */
export type FactoryHandlers = {
  onNewV2Pair: (ctx: {
    chain: "BSC" | "ETH";
    factory: `0x${string}`;
    pair: `0x${string}`;
    token0: `0x${string}`;
    token1: `0x${string}`;
    log: any;
  }) => void;

  onNewV3Pool: (ctx: {
    chain: "BSC" | "ETH";
    factory: `0x${string}`;
    pool: `0x${string}`;
    token0: `0x${string}`;
    token1: `0x${string}`;
    fee: number;
    log: any;
  }) => void;
};

export type PairHandlers = {
  onV2Swap?: (ctx: {
    chain: "BSC" | "ETH";
    pair: `0x${string}`;
    args: {
      sender: `0x${string}`;
      amount0In: bigint;
      amount1In: bigint;
      amount0Out: bigint;
      amount1Out: bigint;
      to: `0x${string}`;
    };
    log: any;
  }) => void;

  onV2Mint?: (ctx: {
    chain: "BSC" | "ETH";
    pair: `0x${string}`;
    args: { sender: `0x${string}`; amount0: bigint; amount1: bigint };
    log: any;
  }) => void;
};

export type PoolHandlers = {
  onV3Swap?: (ctx: {
    chain: "BSC" | "ETH";
    pool: `0x${string}`;
    args: {
      sender: `0x${string}`;
      recipient: `0x${string}`;
      amount0: bigint;
      amount1: bigint;
      sqrtPriceX96: bigint;
      liquidity: bigint;
      tick: number;
    };
    log: any;
  }) => void;
};

/** —— 工厂订阅：新建 Pair/Pool —— */
export function watchFactories(
  clients: { bsc: PublicClient; ethereum: PublicClient },
  handlers: FactoryHandlers
) {
  // BSC - Pancake V2
  clients.bsc.watchEvent({
    address: CHAINS.bsc.dex.pancakeV2Factory as `0x${string}`,
    event: pairCreatedItem,
    onLogs: (logs) => {
      for (const l of logs) {
        const token0 =
          getLogArg<`0x${string}`>(l.args, "token0", 0) ??
          getLogArg<`0x${string}`>(l.args, "arg0", 0);
        const token1 =
          getLogArg<`0x${string}`>(l.args, "token1", 1) ??
          getLogArg<`0x${string}`>(l.args, "arg1", 1);
        const pair = getLogArg<`0x${string}`>(l.args, "pair", 2);
        if (!token0 || !token1 || !pair) {
          logger.warn({ args: l.args }, "PairCreated log missing fields");
          continue;
        }
        logger.info({ pair }, "BSC V2 PairCreated");
        handlers.onNewV2Pair({
          chain: "BSC",
          factory: CHAINS.bsc.dex.pancakeV2Factory as `0x${string}`,
          pair,
          token0,
          token1,
          log: l,
        });
      }
    },
    onError: (e) => logger.error(e, "BSC V2 PairCreated subscription error"),
  });

  // BSC - Pancake V3
  clients.bsc.watchEvent({
    address: CHAINS.bsc.dex.pancakeV3Factory as `0x${string}`,
    event: poolCreatedItem,
    onLogs: (logs) => {
      for (const l of logs) {
        const token0 = getLogArg<`0x${string}`>(l.args, "token0", 0);
        const token1 = getLogArg<`0x${string}`>(l.args, "token1", 1);
        const feeRaw = getLogArg<number | bigint>(l.args, "fee", 2);
        const pool = getLogArg<`0x${string}`>(l.args, "pool", 4);
        if (!token0 || !token1 || feeRaw === undefined || !pool) {
          logger.warn({ args: l.args }, "PoolCreated log missing fields");
          continue;
        }
        const fee = typeof feeRaw === "bigint" ? Number(feeRaw) : Number(feeRaw);
        logger.info({ pool, fee }, "BSC V3 PoolCreated");
        handlers.onNewV3Pool({
          chain: "BSC",
          factory: CHAINS.bsc.dex.pancakeV3Factory as `0x${string}`,
          pool,
          token0,
          token1,
          fee: Number(fee),
          log: l,
        });
      }
    },
    onError: (e) => logger.error(e, "BSC V3 PoolCreated subscription error"),
  });

  // ETH - Uniswap V2
  clients.ethereum.watchEvent({
    address: CHAINS.ethereum.dex.uniV2Factory as `0x${string}`,
    event: pairCreatedItem,
    onLogs: (logs) => {
      for (const l of logs) {
        const token0 =
          getLogArg<`0x${string}`>(l.args, "token0", 0) ??
          getLogArg<`0x${string}`>(l.args, "arg0", 0);
        const token1 =
          getLogArg<`0x${string}`>(l.args, "token1", 1) ??
          getLogArg<`0x${string}`>(l.args, "arg1", 1);
        const pair = getLogArg<`0x${string}`>(l.args, "pair", 2);
        if (!token0 || !token1 || !pair) {
          logger.warn({ args: l.args }, "PairCreated log missing fields");
          continue;
        }
        logger.info({ pair }, "ETH V2 PairCreated");
        handlers.onNewV2Pair({
          chain: "ETH",
          factory: CHAINS.ethereum.dex.uniV2Factory as `0x${string}`,
          pair,
          token0,
          token1,
          log: l,
        });
      }
    },
    onError: (e) => logger.error(e, "ETH V2 PairCreated subscription error"),
  });

  // ETH - Uniswap V3
  clients.ethereum.watchEvent({
    address: CHAINS.ethereum.dex.uniV3Factory as `0x${string}`,
    event: poolCreatedItem,
    onLogs: (logs) => {
      for (const l of logs) {
        const token0 = getLogArg<`0x${string}`>(l.args, "token0", 0);
        const token1 = getLogArg<`0x${string}`>(l.args, "token1", 1);
        const feeRaw = getLogArg<number | bigint>(l.args, "fee", 2);
        const pool = getLogArg<`0x${string}`>(l.args, "pool", 4);
        if (!token0 || !token1 || feeRaw === undefined || !pool) {
          logger.warn({ args: l.args }, "PoolCreated log missing fields");
          continue;
        }
        const fee = typeof feeRaw === "bigint" ? Number(feeRaw) : Number(feeRaw);
        logger.info({ pool, fee }, "ETH V3 PoolCreated");
        handlers.onNewV3Pool({
          chain: "ETH",
          factory: CHAINS.ethereum.dex.uniV3Factory as `0x${string}`,
          pool,
          token0,
          token1,
          fee: Number(fee),
          log: l,
        });
      }
    },
    onError: (e) => logger.error(e, "ETH V3 PoolCreated subscription error"),
  });
}

/** —— Pair 订阅：V2 Swap/Mint —— */
export function watchV2Pair(
  client: PublicClient,
  chainLabel: "BSC" | "ETH",
  pair: `0x${string}`,
  handlers: PairHandlers
) {
  client.watchEvent({
    address: pair,
    event: v2SwapItem,
    onLogs: (logs) => {
      for (const l of logs) {
        const sender = getLogArg<`0x${string}`>(l.args, "sender", 0);
        const amount0In = getLogArg<bigint>(l.args, "amount0In", 1);
        const amount1In = getLogArg<bigint>(l.args, "amount1In", 2);
        const amount0Out = getLogArg<bigint>(l.args, "amount0Out", 3);
        const amount1Out = getLogArg<bigint>(l.args, "amount1Out", 4);
        const to = getLogArg<`0x${string}`>(l.args, "to", 5);
        if (
          !sender ||
          amount0In === undefined ||
          amount1In === undefined ||
          amount0Out === undefined ||
          amount1Out === undefined ||
          !to
        ) {
          logger.warn({ args: l.args, pair }, "V2 Swap log missing fields");
          continue;
        }
        handlers.onV2Swap?.({
          chain: chainLabel,
          pair,
          args: { sender, amount0In, amount1In, amount0Out, amount1Out, to },
          log: l,
        });
      }
    },
    onError: (e) => logger.error({ pair }, "V2 Swap subscribe error"),
  });

  client.watchEvent({
    address: pair,
    event: v2MintItem,
    onLogs: (logs) => {
      for (const l of logs) {
        const sender = getLogArg<`0x${string}`>(l.args, "sender", 0);
        const amount0 = getLogArg<bigint>(l.args, "amount0", 1);
        const amount1 = getLogArg<bigint>(l.args, "amount1", 2);
        if (!sender || amount0 === undefined || amount1 === undefined) {
          logger.warn({ args: l.args, pair }, "V2 Mint log missing fields");
          continue;
        }
        handlers.onV2Mint?.({
          chain: chainLabel,
          pair,
          args: { sender, amount0, amount1 },
          log: l,
        });
      }
    },
    onError: (e) => logger.error({ pair }, "V2 Mint subscribe error"),
  });
}

/** —— Pool 订阅：V3 Swap —— */
export function watchV3Pool(
  client: PublicClient,
  chainLabel: "BSC" | "ETH",
  pool: `0x${string}`,
  handlers: PoolHandlers
) {
  client.watchEvent({
    address: pool,
    event: v3SwapItem,
    onLogs: (logs) => {
      for (const l of logs) {
        const sender = getLogArg<`0x${string}`>(l.args, "sender", 0);
        const recipient = getLogArg<`0x${string}`>(l.args, "recipient", 1);
        const amount0 = getLogArg<bigint>(l.args, "amount0", 2);
        const amount1 = getLogArg<bigint>(l.args, "amount1", 3);
        const sqrtPriceX96 = getLogArg<bigint>(l.args, "sqrtPriceX96", 4);
        const liquidity = getLogArg<bigint>(l.args, "liquidity", 5);
        const tickRaw = getLogArg<number | bigint>(l.args, "tick", 6);
        if (
          !sender ||
          !recipient ||
          amount0 === undefined ||
          amount1 === undefined ||
          sqrtPriceX96 === undefined ||
          liquidity === undefined ||
          tickRaw === undefined
        ) {
          logger.warn({ args: l.args, pool }, "V3 Swap log missing fields");
          continue;
        }
        const tick =
          typeof tickRaw === "bigint" ? Number(tickRaw) : Number(tickRaw);
        handlers.onV3Swap?.({
          chain: chainLabel,
          pool,
          args: {
            sender,
            recipient,
            amount0,
            amount1,
            sqrtPriceX96,
            liquidity,
            tick: Number(tick),
          },
          log: l,
        });
      }
    },
    onError: (e) => logger.error({ pool }, "V3 Swap subscribe error"),
  });
}
