/**
 * 常用 DEX 与基础代币地址清单（主网）
 * 说明：
 * - 仅包含我们当前需要的最小集（后续可扩展）
 * - V2/V3 工厂地址用于订阅新池事件
 * - baseTokens 用于价格折算（WBNB/WETH/稳定币）
 */

export const dex = {
  bsc: {
    pancakeV2: {
      factory: "0xCA143Ce32Fe78f1f7019d7d551a6402fC5350c73", // Pancake V2 Factory
      // routerV2 常见：'0x10ED43C718714eb63d5aA57B78B54704E256024E'
    },
    pancakeV3: {
      factory: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865", // Pancake V3 Factory
      // smartRouter 可按需补充
    },
    baseTokens: {
      WBNB: "0xBB4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
      USDT: "0x55d398326f99059fF775485246999027B3197955",
      BUSD: "0xe9e7cea3dedca5984780bafc599bd69add087d56", // （BUSD主网历史地址，注意监管退场后流动性可能减少）
      USDC: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
    },
  },

  ethereum: {
    uniswapV2: {
      factory: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f", // Uniswap V2 Factory
      // routerV2: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'
    },
    uniswapV3: {
      factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984", // Uniswap V3 Factory
      // swapRouter: '0xE592427A0AEce92De3Edee1F18E0157C05861564'
    },
    baseTokens: {
      WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
    },
  },
} as const;
