// plumbline relayer: tsx src/main.ts [--config relayer.json] [--once]
//   --once: process what is in the inbox, then exit (no HTTP server).
import { assertNotMainnet, resolveCluster } from "../../cli/src/cluster.js";
import { Connection, PlumblineChain } from "../../cli/src/chain/index.js";
import { loadKeypair } from "../../cli/src/wallet.js";
import { loadConfig, quoteCheckFor } from "./config.js";
import { jsonLogger, Relayer } from "./pipeline.js";
import { CommandProver } from "./prover.js";
import { httpServer, Inbox } from "./service.js";
import { State } from "./state.js";

const argv = process.argv.slice(2);
const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

async function main() {
  const cfg = loadConfig(flag("--config"));
  const cluster = resolveCluster(cfg.cluster); // refuses mainnet
  const log = jsonLogger(cfg.logFile);
  const conn = new Connection(cluster.url, "confirmed");
  try { await assertNotMainnet(conn); }
  catch (e: any) { if (e?.name === "MainnetRefused") throw e; throw new Error(`cannot reach RPC ${cluster.url}: ${e?.message ?? e}`); }
  const payer = loadKeypair(cfg.keypair); // fee payer only
  const chain = new PlumblineChain(conn, payer);
  const quoteCheck = quoteCheckFor(cfg, cluster.name);
  log("relayer.start", {
    cluster: cluster.name, rpc: cluster.url, feePayer: payer.publicKey.toBase58(), registry: chain.registryId.toBase58(),
    bounty: chain.bountyId.toBase58(), idl: chain.idls.source.bounty, quoteCheck,
    inbox: cfg.inbox, state: cfg.stateFile,
  });
  const state = new State(cfg.stateFile);
  const relayer = new Relayer({ chain: {
    scoreByStatement: (h) => chain.scoreByStatement(h), fetchScore: (a) => chain.fetchScore(a),
    recordVerifiedScore: (p) => chain.recordVerifiedScore(p), listBounties: (o) => chain.listBounties(o),
    claim: (b, s) => chain.claim(b, s),
  }, prover: new CommandProver(cfg.prover, log), state, log, workDir: cfg.workDir, quoteCheck });
  const inbox = new Inbox(cfg.inbox, relayer, log);
  if (argv.includes("--once")) { await inbox.scan(); return; }
  inbox.start(cfg.pollMs);
  httpServer(inbox, state, log, { onAccepted: () => inbox.scan() }).listen(cfg.port, cfg.host, () => log("http.listen", { host: cfg.host, port: cfg.port }));
}

main().catch((e) => { process.stderr.write(`relayer: ${e?.message ?? e}\n`); process.exit(e?.name === "MainnetRefused" ? 3 : 1); });
