import axios from "axios";
import { TTLStore } from "../state/stores.js";
import { CHAINS } from "../config.js";

type ChainLabel = "BSC" | "ETH";
interface DexTokenResponse {
  pairs?: Array<any>;
}
interface DexPairResponse {
  pair?: any;
}

const TOKEN_TTL_MS = 30_000;
const PAIR_TTL_MS = 30_000;

const tokenCache = new TTLStore<DexTokenResponse>(TOKEN_TTL_MS);
const pairCache = new TTLStore<DexPairResponse>(PAIR_TTL_MS);

function chainSlug(chain: ChainLabel) {
  return chain === "BSC" ? "bsc" : "ethereum";
}

export async function fetchTokenData(chain: ChainLabel, token: `0x${string}`) {
  const key = `${chain}:token:${token.toLowerCase()}`;
  const cached = tokenCache.get(key);
  if (cached) return cached;
  const url = `https://api.dexscreener.com/latest/dex/tokens/${token}`;
  const { data } = await axios.get(url, { timeout: 7000 });
  tokenCache.set(key, data);
  return data as DexTokenResponse;
}

export async function fetchPairData(chain: ChainLabel, pair: `0x${string}`) {
  const key = `${chain}:pair:${pair.toLowerCase()}`;
  const cached = pairCache.get(key);
  if (cached) return cached;
  const slug = chainSlug(chain);
  const url = `https://api.dexscreener.com/latest/dex/pairs/${slug}/${pair}`;
  const { data } = await axios.get(url, { timeout: 7000 });
  pairCache.set(key, data);
  return data as DexPairResponse;
}

export function invalidatePair(chain: ChainLabel, pair: `0x${string}`) {
  pairCache.delete(`${chain}:pair:${pair.toLowerCase()}`);
}
