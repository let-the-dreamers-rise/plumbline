import { Connection } from "@solana/web3.js";
import { formatHlPrice } from "../price.js";
import { readBook } from "../relayer.js";
import { exchange, info, programId, relayerConfig, solanaRpc, testnet } from "./env.js";

// Day 2 gate: registers the H100 paid-price perp on a new HIP-3 dex (testnet by default).
// The initial oracle price is the live Solana index, or HL_INITIAL_PX when the index is not live.
if (!testnet && !process.argv.includes("--mainnet")) throw new Error("refusing to deploy on mainnet without --mainnet");
const { client, address } = exchange();
const book = await readBook(new Connection(solanaRpc, "confirmed"), relayerConfig.sku, relayerConfig.kind, programId).catch(() => null);
const initial = process.env.HL_INITIAL_PX?.trim() || (book?.status === "live" ? formatHlPrice(book.valueMicro, relayerConfig.szDecimals) : undefined);
if (!initial) throw new Error("index is not live; set HL_INITIAL_PX (e.g. 2.71)");

const existing = (await info.perpDexs()).filter((d) => d?.name === relayerConfig.dex);
const owner = existing[0]?.deployer?.toLowerCase();
if (owner && owner !== address.toLowerCase()) throw new Error(`dex "${relayerConfig.dex}" belongs to ${owner}; set HL_DEX to an unused name`);
console.log(`deployer ${address}; dex ${relayerConfig.dex} ${existing.length ? "exists" : "is new"}; initial px ${initial}`);

const result = await client.perpDeploy({
  registerAsset2: {
    maxGas: process.env.HL_MAX_GAS ? Number(process.env.HL_MAX_GAS) : null,
    assetRequest: {
      coin: relayerConfig.coin,
      szDecimals: relayerConfig.szDecimals,
      oraclePx: initial,
      marginTableId: Number(process.env.HL_MARGIN_TABLE_ID ?? 5),
      marginMode: (process.env.HL_MARGIN_MODE as "strictIsolated" | "noCross" | "normal" | undefined) ?? "strictIsolated",
    },
    dex: relayerConfig.dex,
    schema: existing.length
      ? null
      : { fullName: "Paid Compute Tape", collateralToken: 0, oracleUpdater: (process.env.HL_ORACLE_UPDATER as `0x${string}` | undefined) ?? null },
  },
});
console.log(JSON.stringify(result));
