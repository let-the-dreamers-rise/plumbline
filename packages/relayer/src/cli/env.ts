import { existsSync } from "node:fs";
import { Wallet } from "ethers";
import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { PublicKey } from "@solana/web3.js";
import { DEFAULT_PROGRAM_ID } from "@pct/oracle";
import type { RelayerConfig } from "../relayer.js";

if (existsSync(".env")) process.loadEnvFile(".env");

const env = (name: string, fallback?: string): string => {
  const v = process.env[name]?.trim() || fallback;
  if (v === undefined) throw new Error(`${name} is not set (see packages/relayer/README.md)`);
  return v;
};

export const testnet = env("HL_TESTNET", "true") !== "false";
export const transport = new HttpTransport({ isTestnet: testnet });
export const info = new InfoClient({ transport });

export function exchange(): { client: ExchangeClient; address: string } {
  const wallet = new Wallet(env("HL_PRIVATE_KEY"));
  return { client: new ExchangeClient({ transport, wallet }), address: wallet.address };
}

export const programId = process.env.PCT_PROGRAM_ID?.trim() ? new PublicKey(process.env.PCT_PROGRAM_ID.trim()) : DEFAULT_PROGRAM_ID;
export const solanaRpc = env("SOLANA_RPC_URL", "https://api.devnet.solana.com");

const dex = env("HL_DEX", "pct");
export const relayerConfig: RelayerConfig = {
  dex,
  coin: env("HL_COIN", `${dex}:H100`),
  szDecimals: Number(env("HL_SZ_DECIMALS", "2")),
  sku: 0,
  kind: 0,
  maxAgeS: Number(env("RELAY_MAX_AGE_S", "1800")),
  maxStepBps: Number(env("RELAY_MAX_STEP_BPS", "100")),
};
export const intervalMs = Number(env("RELAY_INTERVAL_MS", "3000"));
export const dryRun = env("DRY_RUN", "false") === "true";
