import { PublicClient } from "viem";

/** 快速判定地址是否存在合约代码 */
export async function hasOnchainCode(
  client: PublicClient,
  addr: `0x${string}`
) {
  try {
    const bytecode = await client.getBytecode({ address: addr });
    return !!bytecode && bytecode !== "0x";
  } catch {
    return false;
  }
}
