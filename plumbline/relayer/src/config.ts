// Relayer configuration: defaults < JSON file (--config / PLUMBLINE_RELAYER_CONFIG) < env.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { QuoteCheck } from "../../cli/src/bundle.js";
import type { ProverConfig } from "./prover.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ZK = path.resolve(here, "../../zk");

export type RelayerConfig = {
  cluster: string; keypair?: string; inbox: string; stateFile: string; workDir: string; logFile?: string;
  port: number; host: string; pollMs: number; quoteCheck?: QuoteCheck; prover: ProverConfig;
};

export const DEFAULTS: RelayerConfig = {
  cluster: "localnet",
  inbox: "inbox", stateFile: "relayer-state.json", workDir: "work", logFile: "relayer.log",
  port: 8787, host: "127.0.0.1", pollMs: 5000,
  prover: {
    // the plumbline zk host (Groth16 mode, Docker prover). Set IMAGE=testroot only for localnet tests.
    command: [path.join(ZK, "risc0/target/release/tessera-risc0-host"), "groth16", "{quote}", "{statement}", "{event_log}"],
    env: { OUT: "{out}" },
    cwd: path.join(ZK, "risc0"),
    timeoutMs: 3 * 3600_000,
  },
};

export function loadConfig(file?: string, env: NodeJS.ProcessEnv = process.env): RelayerConfig {
  const f = file ?? env.PLUMBLINE_RELAYER_CONFIG;
  const fromFile = f ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
  const c: RelayerConfig = { ...DEFAULTS, ...fromFile, prover: { ...DEFAULTS.prover, ...(fromFile.prover ?? {}) } };
  if (env.PLUMBLINE_CLUSTER) c.cluster = env.PLUMBLINE_CLUSTER;
  if (env.ANCHOR_WALLET && !c.keypair) c.keypair = env.ANCHOR_WALLET;
  if (env.PLUMBLINE_PROVER_CMD) c.prover = { ...c.prover, command: JSON.parse(env.PLUMBLINE_PROVER_CMD) };
  if ("payout" in fromFile) throw new Error("the relayer has no payout setting: the payout is inside the proof");
  return c;
}

/** Localnet uses synthetic/stub quotes; anything else must pass the full Intel-chain check first. */
export const quoteCheckFor = (c: RelayerConfig, clusterName: string): QuoteCheck => c.quoteCheck ?? (clusterName === "localnet" ? "binding" : "full");
