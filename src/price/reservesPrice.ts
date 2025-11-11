import { PublicClient, getContract } from "viem";
import { PARSED_ABI } from "../chains/abis.js";
import { getBaseTokenUsd, isBaseToken } from "./baseQuotes.js";
import { logger } from "../logger.js";

/**
 * 工具：读取 ERC20 decimals（带本地缓存）
 */
const decimalsCache = new Map<string, number>();
export async function getTokenDecimals(
  client: PublicClient,
  addr: `0x${string}`
): Promise<number> {
  const k = `${client.chain?.id}:${addr.toLowerCase()}`;
  const hit = decimalsCache.get(k);
  if (hit !== undefined) return hit;
  try {
    const d = Number(
      await client.readContract({
        address: addr,
        abi: PARSED_ABI.erc20,
        functionName: "decimals",
      })
    );
    if (Number.isFinite(d)) {
      decimalsCache.set(k, d);
      return d;
    }
  } catch (e) {
    logger.warn({ addr, err: String(e) }, "decimals lookup failed, fallback 18");
  }
  const fallback = 18;
  decimalsCache.set(k, fallback);
  return fallback;
}

/**
 * —— V2 相对价格（token0 ↔ token1）——
 * UniswapV2-like：price(token0 in token1) = (reserve1 / 10^dec1) / (reserve0 / 10^dec0)
 */
export async function getV2RelativePrice(
  client: PublicClient,
  pair: `0x${string}`,
  token0: `0x${string}`,
  token1: `0x${string}`
): Promise<{ p0in1: number; p1in0: number } | undefined> {
  const c = getContract({ address: pair, abi: PARSED_ABI.v2Pair, client });
  const [r0, r1] = (await c.read.getReserves()) as unknown as [
    bigint,
    bigint,
    number
  ];
  const [d0, d1] = await Promise.all([
    getTokenDecimals(client, token0),
    getTokenDecimals(client, token1),
  ]);
  const R0 = Number(r0) / 10 ** d0;
  const R1 = Number(r1) / 10 ** d1;
  if (R0 <= 0 || R1 <= 0) return undefined;
  const p0in1 = R1 / R0;
  const p1in0 = R0 / R1;
  return { p0in1, p1in0 };
}

/**
 * —— V3 相对价格（基于 slot0.sqrtPriceX96）——
 * price(token1 per token0) = (sqrtPriceX96^2 / 2^192) * 10^(dec0 - dec1)
 * 于是：
 *   p1_per_0 = ratio
 *   p0_per_1 = 1 / ratio
 */
export async function getV3RelativePrice(
  client: PublicClient,
  pool: `0x${string}`,
  token0: `0x${string}`,
  token1: `0x${string}`
): Promise<{ p0in1: number; p1in0: number } | undefined> {
  const c = getContract({ address: pool, abi: PARSED_ABI.v3Pool, client });

  const [sqrtPriceX96] = (await c.read.slot0()) as unknown as [
    bigint,
    number,
    number,
    number,
    number,
    number,
    boolean
  ];

  const [d0, d1] = await Promise.all([
    getTokenDecimals(client, token0),
    getTokenDecimals(client, token1),
  ]);

  // sqrtPriceX96 是 Q64.96 定点；先转成浮点再计算比价
  const sp = Number(sqrtPriceX96) / 2 ** 96; // ≈ sqrt(price1/price0)
  const ratio = sp * sp * 10 ** (d0 - d1); // price(token1 per token0)
  if (!Number.isFinite(ratio) || ratio <= 0) return undefined;

  return { p0in1: 1 / ratio, p1in0: ratio };
}

/**
 * —— 折USD价格 ——（当两边有“基准币”时）
 * 如果 token0/1 任一为基准币：用其 USD 价把相对价换成 USD；
 * 若两边都不是基准币：返回 undefined（由上层再找路由/侧信道）
 */
export async function deriveUsdFromRelative(
  chain: "BSC" | "ETH",
  baseTokenUsdGetter: (addr: `0x${string}`) => Promise<number | undefined>,
  token0: `0x${string}`,
  token1: `0x${string}`,
  rel: { p0in1: number; p1in0: number }
): Promise<{ price0Usd?: number; price1Usd?: number }> {
  // 若 token1 是基准币：price0Usd = p0in1 * price1Usd
  if (isBaseToken(chain, token1)) {
    const usd1 = await baseTokenUsdGetter(token1);
    if (usd1 !== undefined)
      return { price0Usd: rel.p0in1 * usd1, price1Usd: usd1 };
  }
  // 若 token0 是基准币：price1Usd = p1in0 * price0Usd
  if (isBaseToken(chain, token0)) {
    const usd0 = await baseTokenUsdGetter(token0);
    if (usd0 !== undefined)
      return { price1Usd: rel.p1in0 * usd0, price0Usd: usd0 };
  }
  return {};
}

/**
 * —— 便捷函数：从 V2 Pair 直接给出 USD 价格 ——（在一侧为基准币时）
 */
export async function v2PricesUsdIfBase(
  chain: "BSC" | "ETH",
  client: PublicClient,
  pair: `0x${string}`,
  token0: `0x${string}`,
  token1: `0x${string}`
): Promise<{ price0Usd?: number; price1Usd?: number }> {
  const rel = await getV2RelativePrice(client, pair, token0, token1);
  if (!rel) return {};
  return deriveUsdFromRelative(
    chain,
    (a) => getBaseTokenUsd(chain, a),
    token0,
    token1,
    rel
  );
}

/**
 * —— 便捷函数：从 V3 Pool 直接给出 USD 价格 ——（在一侧为基准币时）
 */
export async function v3PricesUsdIfBase(
  chain: "BSC" | "ETH",
  client: PublicClient,
  pool: `0x${string}`,
  token0: `0x${string}`,
  token1: `0x${string}`
): Promise<{ price0Usd?: number; price1Usd?: number }> {
  const rel = await getV3RelativePrice(client, pool, token0, token1);
  if (!rel) return {};
  return deriveUsdFromRelative(
    chain,
    (a) => getBaseTokenUsd(chain, a),
    token0,
    token1,
    rel
  );
}

/**
 * —— 将“代币数量变动”折成 USD ——（已知哪一侧是目标代币 & 另一侧为基准币时）
 * 适用于在 Swap 事件中把 amount0/amount1 直接换成 USD 贡献值。
 *
 * direction:
 *  - 'token0'：目标是 token0，传入其 delta（正=买入token0，负=卖出token0）
 *  - 'token1'：目标是 token1
 */
export async function deltaToUsdIfBase(
  chain: "BSC" | "ETH",
  {
    client,
    marketType,
    addr,
    token0,
    token1,
  }: {
    client: PublicClient;
    marketType: "v2" | "v3";
    addr: `0x${string}`; // pair or pool
    token0: `0x${string}`;
    token1: `0x${string}`;
  },
  direction: "token0" | "token1",
  delta: number
): Promise<number | undefined> {
  const price =
    marketType === "v2"
      ? await v2PricesUsdIfBase(chain, client, addr, token0, token1)
      : await v3PricesUsdIfBase(chain, client, addr, token0, token1);

  if (!price) return undefined;

  if (direction === "token0" && price.price0Usd !== undefined) {
    return delta * price.price0Usd;
  }
  if (direction === "token1" && price.price1Usd !== undefined) {
    return delta * price.price1Usd;
  }
  return undefined;
}
