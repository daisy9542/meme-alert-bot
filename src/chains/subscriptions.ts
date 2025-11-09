import { parseAbiItem, PublicClient } from "viem";
import { ABI } from "./abis.js";
import { CHAINS } from "../config.js";
import { logger } from "../logger.js";

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
        const { token0, token1, pair } = l.args as any;
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
        const { token0, token1, fee, pool } = l.args as any;
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
        const { token0, token1, pair } = l.args as any;
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
        const { token0, token1, fee, pool } = l.args as any;
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
        const { sender, amount0In, amount1In, amount0Out, amount1Out, to } =
          l.args as any;
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
        const { sender, amount0, amount1 } = l.args as any;
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
        const {
          sender,
          recipient,
          amount0,
          amount1,
          sqrtPriceX96,
          liquidity,
          tick,
        } = l.args as any;
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
