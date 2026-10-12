/**
 * Public addresses, endpoints and defaults for the GPU Credit Monitor. Every address here was read
 * from USD.AI's docs or its loan-router repository (deployments/arbitrum.json); see
 * strategy/credit-monitor-feasibility.md for how each was verified.
 */
export const USER_AGENT = "Plumbline-credit-monitor/0.1 (+https://github.com/let-the-dreamers-rise/paid-compute-tape)";

export const ARBITRUM_RPC = "https://arb1.arbitrum.io/rpc";
export const ARBISCAN = "https://arbiscan.io";

export const ROUTER_V1 = "0x0C2ED170F2bB1DF1a44292Ad621B577b3C9597D1";
export const ROUTER_V2 = "0x1C2ED170de32846316784c4fd58A5e3C7563E12f";
export const ROUTERS = [ROUTER_V1, ROUTER_V2] as const;
export const COLLATERAL_NFT = "0xb31f04f920f24eda3ad276d55c5afefad6230c5d";
export const USDAI = "0x0a1a1a107e45b7ced86833863f482bc5f4ed82ef";
export const SUSDAI = "0x0b2b2b2076d95dda7817e785989fe353fe955ef9";
/** USD.AI's amortizing interest-rate model (deployments/arbitrum.json). */
export const AMORTIZED_RATE_MODEL = "0x060ce8d04fac0d85baa4208331059d8cab7a6aa1";
export const SIMPLE_RATE_MODEL = "0x5d57017dbb71c65bf581fe08d5e5dc072bed8b13";

/** No router log exists before this block (both routers scanned from block 360M on 2026-10-12). */
export const START_BLOCK = 400_000_000;
/** arb1.arbitrum.io accepts eth_getLogs over 10M blocks per call. */
export const LOG_WINDOW = 10_000_000;
/** A log window is cached once its last block is this far behind the head. */
export const FINALITY_BLOCKS = 10_000;

export const METADATA_BASE = "https://metadata.usd.ai/v1/";
export const APP_LOANS_URL = "https://app.usd.ai/loans";

export const VAST_URL = "https://console.vast.ai/api/v0/bundles/";
export const RUNPOD_URL = "https://api.runpod.io/graphql";
export const AKASH_URL = "https://console-api.akash.network/v1/gpu-prices";

/** Token amounts on the routers use 18 decimals (USDai). */
export const WAD = 10n ** 18n;
export const SECONDS_PER_YEAR = 365 * 86_400;
/** Tranches below this many tokens are placeholder or fee tranches (1 wei to 1 USDai seen live) and are ignored for APR. */
export const MIN_MATERIAL_TRANCHE = 1_000n * WAD;

export const DEFAULT_ASSUMPTIONS = {
  /** Share of hours a GPU is rented, for the coverage estimate. */
  utilization: 0.7,
  /** Straight-line depreciation life for the depreciation-adjusted LTV, from origination. */
  depreciationYears: 5,
  /** Operating cost per GPU-hour subtracted before coverage. 0 means coverage is gross of opex. */
  opexPerGpuHr: 0,
  /** A loan is flagged when breakeven utilization is above this. */
  breakevenFlag: 0.8,
  /** Hours in an average month (365 x 24 / 12). */
  hoursPerMonth: 730,
} as const;

export type Assumptions = { readonly [K in keyof typeof DEFAULT_ASSUMPTIONS]: number };

/**
 * GPUs per collateral unit. USD.AI's metadata counts servers ("B300 [130]" is 130 servers); HGX and DGX
 * servers carry 8 GPUs, as do RTX PRO 6000 servers, and a GB200 NVL72 rack carries 72.
 */
export const GPUS_PER_UNIT: Readonly<Record<string, number>> = {
  H100: 8,
  H200: 8,
  B200: 8,
  B300: 8,
  GB200: 72,
  "RTX PRO 6000": 8,
};

export const MODELS = ["H100", "H200", "B200", "B300", "GB200", "RTX PRO 6000"] as const;
export type GpuModel = (typeof MODELS)[number];
