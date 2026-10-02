import { Connection } from "@solana/web3.js";
import { Relayer, readBook, type SetOracle } from "../relayer.js";
import { dryRun, exchange, intervalMs, programId, relayerConfig, solanaRpc, testnet } from "./env.js";

// Pushes the Solana H100 paid index into the HIP-3 market's oracle every RELAY_INTERVAL_MS.
// DRY_RUN=true prints the setOracle actions without a Hyperliquid key.
const connection = new Connection(solanaRpc, "confirmed");
const send = dryRun
  ? async (a: SetOracle) => console.log(JSON.stringify(a))
  : (() => {
      const { client } = exchange();
      return (a: SetOracle) => client.perpDeploy(a);
    })();
const relayer = new Relayer(relayerConfig, () => readBook(connection, relayerConfig.sku, relayerConfig.kind, programId), send);

console.log(`relaying ${relayerConfig.coin} on ${testnet ? "testnet" : "MAINNET"} from ${solanaRpc}${dryRun ? " (dry run)" : ""}`);
const once = process.argv.includes("--once");
for (;;) {
  const started = Date.now();
  try {
    const r = await relayer.tick();
    console.log(`${new Date().toISOString()} ${r.posted ?? "hold"}  ${r.note}`);
  } catch (err) {
    console.log(`${new Date().toISOString()} error: ${(err as Error).message}`);
  }
  if (once) break;
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, intervalMs - (Date.now() - started))));
}
