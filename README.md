# meme-alert-bot

一个用于**实时监测 EVM 链 meme 币**（先覆盖 BSC/ETH）的告警机器人（MVP）：
- 订阅 DEX 工厂事件（V2 `PairCreated` / V3 `PoolCreated`），发现新池
- 通过“安全闸门”筛选（可卖性、税率、LP 风险、最小流动性）
- 对通过闸门的池订阅 `Swap/Mint`，做滑动窗口统计
- 计算三大指标：**1 分钟买入额/笔数**、**量能倍增**、**FDV 增幅**
- 鲸鱼判定：默认将单笔买入额 ≥ 当前可见 LP 的 **3%** 视为鲸鱼
- 触发**普通/强烈**预警（默认：控制台输出；可替换为 Telegram/Discord）

> 当前版本语言：TypeScript（ESM），运行器：`tsx`，链库：`viem`。

## 目录结构

```txt
meme-alert-bot/
├─ src/
│ ├─ index.ts # 入口：整合订阅、闸门、指标与告警
│ ├─ config.ts # 阈值/链路/WSS等配置（读 .env）
│ ├─ logger.ts # pino 日志（开发态 pretty）
│ ├─ chains/
│ │ ├─ evmClient.ts # viem PublicClient 工厂（BSC/ETH）
│ │ ├─ subscriptions.ts # 订阅封装：工厂、新池、Swap/Mint
│ │ ├─ abis.ts # 事件/合约 ABI 片段（最小集）
│ │ └─ dexAddresses.ts # 常用 DEX/基准币地址清单
│ ├─ state/
│ │ ├─ stores.ts # 轻量 KV/TTL/去重
│ │ ├─ watchlist.ts # 待检/激活/拒绝的市场清单
│ │ └─ windows.ts # 10min 滑窗（含 1min 统计与基线）
│ ├─ price/
│ │ ├─ baseQuotes.ts # 基准币 USD 报价（DexScreener + 缓存）
│ │ └─ reservesPrice.ts # V2/V3 相对价 & USD 折算工具
│ ├─ safety/
│ │ ├─ sellability.ts # 可卖性静态校验（V2 callStatic）
│ │ ├─ taxEstimator.ts # 交易税率粗估（近似）
│ │ ├─ lpRisk.ts # LP 风险 & “大额加池”记录
│ │ └─ minLiquidity.ts # 最小流动性判定（优先链上，兜底侧信道）
│ ├─ metrics/
│ │ ├─ volume.ts # 1min 买入额/笔数/独立买家
│ │ ├─ velocity.ts # 量能倍增（1min vs 5–10min）
│ │ └─ fdv.ts # FDV 计算与3分钟倍增
│ ├─ rules/
│ │ ├─ gates.ts # 安全闸门聚合判断
│ │ └─ alerts.ts # 预警打分（普通/强烈）
│ └─ notifiers/
│ └─ telegram.ts # 通知层（当前实现为控制台输出）
├─ package.json
├─ tsconfig.json
├─ .env.example
└─ .gitignore
```

## 快速开始

### 1) 安装依赖

```bash
pnpm i
```

### 2) 配置环境变量

按需填写 `.env`

```ini
BSC_WSS=wss://<your-bsc-wss>
ETH_WSS=wss://<your-eth-wss>

# 策略阈值（可保留默认）
MIN_LIQ_USD=5000
BUY_VOL_1M_USD=15000
BUY_TXS_1M=8
VOLUME_MULTIPLIER=5
FDV_MULTIPLIER=3
WHALE_SINGLE_BUY_USD=5000
WHALE_LIQUIDITY_RATIO=0.03
```

### 3) 本地运行（开发模式）

```bash
pnpm run dev
```

### 4) 生产运行（编译后）

```bash
pnpm run build
pnpm run start
```
