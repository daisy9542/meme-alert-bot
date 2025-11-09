/**
 * 最小 ABI 片段集合：
 * - 工厂事件：V2 PairCreated / V3 PoolCreated
 * - V2 Pair：Swap / Mint / getReserves / token0 / token1
 * - V3 Pool：Swap / slot0 / token0 / token1 / fee
 * - ERC20：decimals / totalSupply / symbol / name
 * - （后续 sellability/tax 可能用到的 Router 选择性补充）
 */

export const ABI = {
  // ---- Factories ----
  v2Factory: [
    "event PairCreated(address indexed token0, address indexed token1, address pair, uint)",
    // "event PairCreated(address indexed token0, address indexed token1, address pair, uint256)",
  ],

  v3Factory: [
    "event PoolCreated(address token0, address token1, uint24 fee, int24 tickSpacing, address pool)",
    "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
  ],

  // ---- V2 Pair ----
  v2Pair: [
    // events
    "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
    "event Mint(address indexed sender, uint256 amount0, uint256 amount1)",
    // views
    "function token0() view returns (address)",
    "function token1() view returns (address)",
    "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  ],

  // ---- V3 Pool ----
  v3Pool: [
    // UniswapV3Pool-like
    "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
    // views
    "function token0() view returns (address)",
    "function token1() view returns (address)",
    "function fee() view returns (uint24)",
    "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
    "function liquidity() view returns (uint128)",
  ],

  // ---- ERC20 Minimal ----
  erc20: [
    "function decimals() view returns (uint8)",
    "function totalSupply() view returns (uint256)",
    "function symbol() view returns (string)",
    "function name() view returns (string)",
    "function balanceOf(address) view returns (uint256)",
    "event Transfer(address indexed from, address indexed to, uint256 value)",
  ],

  // ---- (Optional) Router fragments for callStatic checks ----
  // 说明：sellability/taxEstimator 可能会需要模拟 swap
  // 你可以针对具体 DEX 引入其 Router 接口的精简片段。
  // 这里先给常见的 UniswapV2Router-like 片段（仅演示）
  uniV2RouterLike: [
    "function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory amounts)",
    "function getAmountsIn(uint256 amountOut, address[] calldata path) view returns (uint256[] memory amounts)",
  ],

  // ---- Uniswap V3 / Pancake V3 Quoter ----
  v3Quoter: [
    "function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)",
  ],
} as const;
