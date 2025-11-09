import { createPublicClient, http, webSocket, PublicClient } from "viem";
import { mainnet, bsc as bscChain } from "viem/chains";
import { CHAINS } from "../config.js";
import { logger } from "../logger.js";

/**
 * 根据 config 创建多链 viem PublicClient（优先 WSS，降级 HTTP）
 * - 生产建议使用稳定的付费 WSS，避免被限流
 */
export type EvmClients = {
  bsc: PublicClient;
  ethereum: PublicClient;
};

export function createEvmClients(): EvmClients {
  const bsc = createPublicClient({
    chain: bscChain,
    transport: CHAINS.bsc.wss ? webSocket(CHAINS.bsc.wss) : http(), // 降级；仅供开发联调
    pollingInterval: 1_500,
  });

  const ethereum = createPublicClient({
    chain: mainnet,
    transport: CHAINS.ethereum.wss ? webSocket(CHAINS.ethereum.wss) : http(),
    pollingInterval: 1_500,
  });

  logger.info("EVM clients created (BSC & ETH)");
  return { bsc, ethereum };
}
