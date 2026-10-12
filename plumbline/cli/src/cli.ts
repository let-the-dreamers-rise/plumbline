// plumbline: sponsor + entrant command line. Localnet by default, devnet with --cluster devnet, mainnet never.
import * as fs from "node:fs";
import * as path from "node:path";
import { Command, CommanderError, Option } from "commander";
import { assertNotMainnet, explorerUrl, resolveCluster, type Cluster } from "./cluster.js";
import {
  claimable, Connection, errorText, LAMPORTS_PER_SOL, parseProof, PlumblineChain, type BountyView, type ScoreView,
} from "./chain/index.js";
import { checkBundle, payoutToHex, type QuoteCheck } from "./bundle.js";
import { assembleBundle, attest, enter, type Shard } from "./enclave.js";
import { newChallenge, readSealedSuite, sealSuite, SEALED_FORMAT, type Attestation } from "./seal.js";
import { loadKeypair } from "./wallet.js";

export type Io = { out: (s: string) => void; err: (s: string) => void };
export type Deps = Io & {
  /** Build the chain client. Tests replace this; `signer` = whether a keypair is needed. */
  chain?: (cluster: Cluster, keypair: string | undefined, signer: boolean) => Promise<PlumblineChain>;
};

// ---------- argument parsing helpers (exported for tests) ----------
export function parseSol(s: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,9}))?$/.exec(s.trim());
  if (!m) throw new Error(`not a SOL amount: ${s} (e.g. 1.5)`);
  const lamports = BigInt(m[1]) * BigInt(LAMPORTS_PER_SOL) + BigInt((m[2] ?? "").padEnd(9, "0"));
  if (lamports <= 0n) throw new Error("reward must be > 0");
  return lamports;
}
export function parseTarget(s: string): { minCorrect: number; minTotal: number } {
  let m = /^(\d+)\s*\/\s*(\d+)$/.exec(s.trim());
  if (!m) { const p = /^(\d{1,3})%$/.exec(s.trim()); if (p) m = [s, p[1], "100"] as any; }
  if (!m) throw new Error(`target must look like 2/3 or 80%: ${s}`);
  const minCorrect = Number(m[1]), minTotal = Number(m[2]);
  if (!(minTotal > 0) || minCorrect > minTotal || minTotal > 0xffffffff) throw new Error("target needs 0 < total and correct <= total");
  return { minCorrect, minTotal };
}
export const parseHex32 = (s: string, what: string) => {
  const h = s.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error(`${what} must be 64 hex chars`);
  return Buffer.from(h, "hex");
};
export function parseShard(s: string, isUrl: boolean): Shard {
  const i = s.lastIndexOf("=");
  if (i < 1) throw new Error(`--${isUrl ? "shard-url" : "shard"} wants <${isUrl ? "url" : "file"}>=<sha256>[:size]`);
  const [sha, size] = s.slice(i + 1).split(":");
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error(`shard sha256 must be 64 lowercase hex: ${sha}`);
  const target = s.slice(0, i);
  if (isUrl && !/^https:\/\//.test(target)) throw new Error("--shard-url must be https://");
  const shard: Shard = isUrl ? { url: target, sha256: sha } : { file: target, sha256: sha };
  if (size !== undefined) shard.size = Number(size);
  return shard;
}
/** A suite argument: 64-hex commitment, or a sealed-suite file from `plumbline seal` (its public commitment). */
export function suiteArg(s: string): Buffer {
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(s.trim())) return parseHex32(s, "suite commitment");
  if (fs.existsSync(s)) return parseHex32(readSealedSuite(s).suite_commitment, "suite commitment");
  throw new Error(`--suite wants a 64-hex commitment or a ${SEALED_FORMAT} file`);
}

const collect = (v: string, prev: string[] = []) => [...prev, v];
const sol = (l: bigint) => `${Number(l) / LAMPORTS_PER_SOL} SOL`;
const jsonOut = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);

async function defaultChain(cluster: Cluster, keypair: string | undefined, signer: boolean) {
  const conn = new Connection(cluster.url, "confirmed");
  try { await assertNotMainnet(conn); }
  catch (e: any) { if (e?.name === "MainnetRefused") throw e; throw new Error(`cannot reach ${cluster.name} RPC ${cluster.url}: ${e?.message ?? e}`); }
  return new PlumblineChain(conn, signer ? loadKeypair(keypair) : undefined);
}

export function buildProgram(deps: Deps): Command {
  const io = deps;
  const program = new Command("plumbline");
  program
    .description("Plumbline: private-data model competitions that pay the prize themselves")
    .addOption(new Option("--cluster <name>", "localnet | devnet | RPC URL of one of them (mainnet is refused)").default("localnet"))
    .option("--keypair <path>", "signer keypair (default ANCHOR_WALLET or ~/.config/solana/id.json)")
    .option("--json", "machine-readable output")
    .configureOutput({ writeOut: (s) => io.out(s.trimEnd()), writeErr: (s) => io.err(s.trimEnd()) })
    .exitOverride()
    .hook("preAction", (_t, action) => {
      const o = action.optsWithGlobals();
      (action as any)._plumblineCluster = resolveCluster(o.cluster); // throws MainnetRefused before any I/O
    });

  const ctx = (cmd: Command) => {
    const o = cmd.optsWithGlobals();
    const cluster: Cluster = (cmd as any)._plumblineCluster ?? resolveCluster(o.cluster);
    const make = deps.chain ?? defaultChain;
    return {
      o, cluster, json: !!o.json,
      chain: (signer = false) => make(cluster, o.keypair, signer),
      print: (human: string, data?: unknown) => io.out(o.json && data !== undefined ? jsonOut(data) : human),
    };
  };

  // ---------------- bounty ----------------
  const bounty = program.command("bounty").description("create, inspect and refund bounties");
  bounty.command("create")
    .description("escrow a reward for the first verified score on a suite that meets the target")
    .requiredOption("--suite <commitment|sealed-file>", "suite commitment (64 hex) or the file from plumbline seal")
    .requiredOption("--reward <sol>", "reward in SOL, e.g. 1.5")
    .requiredOption("--target <c/t>", "minimum accuracy, e.g. 2/3 or 80%")
    .option("--deadline-slots <n>", "deadline as slots from now", "216000")
    .option("--deadline-slot <n>", "absolute deadline slot (overrides --deadline-slots)")
    .option("--grace-slots <n>", "slots after the deadline before the sponsor may refund", "1500")
    .option("--nonce <n>", "bounty nonce (default: current unix ms)")
    .option("--require-registered-suite", "suite must be registered in the registry", false)
    .option("--pin-compose <hex>", "only pay scores from this enclave compose hash")
    .option("--pin-image <hex>", "only pay scores proven with this guest image id")
    .action(async (a, cmd) => {
      const c = ctx(cmd);
      const suite = suiteArg(a.suite);
      const { minCorrect, minTotal } = parseTarget(a.target);
      const lamports = parseSol(a.reward);
      const ch = await c.chain(true);
      const now = BigInt(await ch.slot());
      const deadlineSlot = a.deadlineSlot ? BigInt(a.deadlineSlot) : now + BigInt(a.deadlineSlots);
      if (deadlineSlot <= now) throw new Error(`deadline slot ${deadlineSlot} is not after the current slot ${now}`);
      const r = await ch.createBounty({
        nonce: BigInt(a.nonce ?? Date.now()), suiteCommitment: suite, minCorrect, minTotal, lamports, deadlineSlot,
        claimGraceSlots: BigInt(a.graceSlots), requireRegisteredSuite: !!a.requireRegisteredSuite,
        requiredComposeHash: a.pinCompose ? parseHex32(a.pinCompose, "--pin-compose") : undefined,
        requiredImageId: a.pinImage ? parseHex32(a.pinImage, "--pin-image") : undefined,
      });
      c.print([`bounty ${r.bounty}`, `  ${sol(lamports)} locked for ${minCorrect}/${minTotal} on suite ${suite.toString("hex")}`,
        `  deadline slot ${deadlineSlot} (+${a.graceSlots} grace), tx ${r.signature}`, `  ${explorerUrl("address", r.bounty, c.cluster)}`].join("\n"),
      { ...r, deadlineSlot, lamports });
    });

  bounty.command("show <address>").description("show one bounty and the verified scores that could claim it")
    .action(async (address, _a, cmd) => {
      const c = ctx(cmd);
      const ch = await c.chain();
      const b = await ch.fetchBounty(address);
      if (!b) throw new Error(`no plumbline bounty at ${address}`);
      const scores = (await ch.listScores(b.suiteCommitment)).sort(rank);
      const rows = scores.map((s) => ({ ...s, claim: claimable(b, s) }));
      c.print([fmtBounty(b), "", `verified scores on this suite: ${scores.length}`,
        ...rows.map((r, i) => `  ${i + 1}. ${r.correct}/${r.total}  payout ${r.payout}  slot ${r.slot}  ${r.claim.ok ? "CAN CLAIM" : r.claim.reason}`)].join("\n"),
      { bounty: b, scores: rows });
    });

  bounty.command("list").description("list bounties (open ones by default)")
    .option("--suite <commitment|sealed-file>", "only this suite")
    .option("--all", "include paid bounties", false)
    .action(async (a, cmd) => {
      const c = ctx(cmd);
      const ch = await c.chain();
      const rows = await ch.listBounties({ suite: a.suite ? suiteArg(a.suite) : undefined, openOnly: !a.all });
      rows.sort((x, y) => Number(y.amount - x.amount));
      c.print(rows.length ? rows.map((b) => `${b.address}  ${sol(b.amount)}  ${b.minCorrect}/${b.minTotal}  ${b.status}  suite ${b.suiteCommitment.slice(0, 16)}…  deadline ${b.deadlineSlot}`).join("\n")
        : "no bounties", rows);
    });

  bounty.command("refund <address>").description("sponsor takes the reward back after deadline + grace")
    .action(async (address, _a, cmd) => {
      const c = ctx(cmd);
      const ch = await c.chain(true);
      const r = await ch.refund(address);
      c.print(`refunded ${address}, tx ${r.signature}`, r);
    });

  // ---------------- suite ----------------
  const suite = program.command("suite").description("suite registry");
  suite.command("register <commitment|sealed-file>").description("register a suite commitment in the registry (you become its author)")
    .option("--price-lamports <n>", "access price in lamports", "0")
    .action(async (s, a, cmd) => {
      const c = ctx(cmd);
      const commitment = suiteArg(s);
      const ch = await c.chain(true);
      const r = await ch.registerSuite(commitment, BigInt(a.priceLamports));
      c.print(`suite ${commitment.toString("hex")} registered at ${r.suite}, tx ${r.signature}`, r);
    });

  // ---------------- seal ----------------
  program.command("seal <suite-file>")
    .description("seal a suite to the enclave key; writes a public sealed-suite file (suite contents are never printed)")
    .requiredOption("--enclave-pubkey <hex>", "the enclave's X25519 key (64 hex), from its attestation")
    .option("--enclave <url>", "fetch and check GET /attest from this enclave with a fresh challenge")
    .option("--attestation <file>", "a saved GET /attest response to check instead of fetching")
    .option("--skip-intel-check", "localnet only: accept a stub quote (binding still checked)", false)
    .option("-o, --out <file>", "output file", "sealed-suite.json")
    .action(async (suiteFile, a, cmd) => {
      const c = ctx(cmd);
      if (a.skipIntelCheck && c.cluster.name !== "localnet") throw new Error("--skip-intel-check is localnet only");
      if (path.resolve(a.out) === path.resolve(suiteFile)) throw new Error("--out would overwrite the suite file");
      let att: Attestation | null = null;
      if (a.attestation) att = JSON.parse(fs.readFileSync(a.attestation, "utf8"));
      else if (a.enclave) att = await attest(a.enclave, newChallenge());
      const s = await sealSuite({ suitePath: suiteFile, enclavePubkey: a.enclavePubkey.toLowerCase(), attestation: att, intel: !a.skipIntelCheck });
      fs.writeFileSync(a.out, JSON.stringify(s, null, 1));
      const warn = att ? "" : "\nwarning: no attestation given, so the file has no key_release and entrants' bundles will not fully verify; pass --enclave or --attestation";
      c.print(`sealed suite written to ${a.out}\n  commitment ${s.suite_commitment}\n  enclave key ${s.enclave_pubkey}, quote check: ${s.quote_checked}${warn}`,
        { out: a.out, suite_commitment: s.suite_commitment, enclave_pubkey: s.enclave_pubkey, quote_checked: s.quote_checked });
    });

  // ---------------- enter ----------------
  program.command("enter")
    .description("submit a model to the competition enclave; saves the score bundle")
    .requiredOption("--enclave <url>", "competition enclave base URL")
    .requiredOption("--sealed <file>", "the sponsor's published sealed-suite file")
    .requiredOption("--model <id>", "model id, e.g. org/name")
    .requiredOption("--revision <sha>", "40-hex commit of the pinned revision")
    .requiredOption("--payout <pubkey>", "your Solana address; the prize can only go here")
    .option("--shard <file=sha256[:size]>", "weights file in the repo and its sha256 (repeatable)", collect, [])
    .option("--shard-url <url=sha256[:size]>", "https URL of a weights file and its sha256 (repeatable)", collect, [])
    .option("--dtype <t>", "bfloat16 | float32", "bfloat16")
    .option("--weights-sha256 <hex>", "expected statement weights_sha256 (optional cross-check)")
    .option("-o, --out <file>", "bundle output path (default bundle-<statement_sha256[:16]>.json)")
    .action(async (a, cmd) => {
      const c = ctx(cmd);
      if (!/^[0-9a-f]{40}$/.test(a.revision)) throw new Error("--revision must be a 40-hex commit");
      const payoutHex = payoutToHex(a.payout);
      const weights = [...a.shard.map((s: string) => parseShard(s, false)), ...a.shardUrl.map((s: string) => parseShard(s, true))];
      if (!weights.length) throw new Error("give at least one --shard or --shard-url");
      if (!["bfloat16", "float32"].includes(a.dtype)) throw new Error("--dtype must be bfloat16 or float32");
      const sealed = readSealedSuite(a.sealed);
      if (!sealed.challenge) throw new Error("sealed-suite file has no challenge/key_release; ask the sponsor to re-seal with --enclave");
      const req = { challenge: sealed.challenge, sealed: sealed.sealed, model_id: a.model, revision: a.revision, weights, payout: payoutHex,
        dtype: a.dtype, ...(a.weightsSha256 ? { weights_sha256: a.weightsSha256 } : {}) };
      io.err(`entering ${a.model}@${a.revision.slice(0, 10)} on suite ${sealed.suite_commitment.slice(0, 16)}… (scoring can take a while)`);
      const text = assembleBundle(await enter(a.enclave, req), sealed);
      const rep = await checkBundle(text, { quoteCheck: "binding" });
      const st = JSON.parse(text).statement;
      const problems: string[] = rep.checks.filter((x) => !x.ok).map((x) => `${x.name}${x.detail ? ` (${x.detail})` : ""}`);
      if (st.payout !== payoutHex) problems.push("statement payout is not the address you asked for");
      if (st.model_id !== a.model || st.model_revision !== a.revision) problems.push("statement names a different model");
      if (st.suite_commitment !== sealed.suite_commitment) problems.push("enclave scored a different suite");
      const out = a.out ?? `bundle-${rep.statementHash.slice(0, 16)}.json`;
      fs.writeFileSync(out, text);
      if (problems.length) throw new Error(`bundle saved to ${out} but it fails: ${problems.join("; ")}`);
      c.print(`score ${rep.correct}/${rep.n}, payout ${rep.payout}\nbundle saved to ${out}\nnext: drop it in the relayer inbox, or POST it to the relayer's /bundles`,
        { out, statementHash: rep.statementHash, correct: rep.correct, n: rep.n, payout: rep.payout });
    });

  // ---------------- verify ----------------
  program.command("verify <bundle>")
    .description("check a score bundle locally; with --onchain also look up its VerifiedScore and claimable bounties")
    .addOption(new Option("--quote-check <mode>", "full = Intel chain + both quotes; binding = statement binding only").choices(["full", "binding"]).default("full"))
    .option("--onchain", "look up the VerifiedScore for this statement", false)
    .action(async (file, a, cmd) => {
      const c = ctx(cmd);
      const rep = await checkBundle(fs.readFileSync(file, "utf8"), { quoteCheck: a.quoteCheck as QuoteCheck });
      const lines = [`statement ${rep.statementHash}`, `score ${rep.correct}/${rep.n} for ${rep.modelId}@${rep.modelRevision.slice(0, 10)}`,
        `suite ${rep.suiteCommitment}`, `payout ${rep.payout ?? "(none)"}`, ...rep.checks.map((x) => `  ${x.ok ? "ok  " : "FAIL"} ${x.name}${x.detail ? ` - ${x.detail}` : ""}`)];
      let onchain: any = null;
      if (a.onchain) {
        const ch = await c.chain();
        const s = await ch.scoreByStatement(rep.statementHash);
        if (!s) lines.push("onchain: no VerifiedScore yet");
        else {
          const bounties = await ch.listBounties({ suite: s.suiteCommitment, openOnly: true });
          const ok = bounties.filter((b) => claimable(b, s).ok);
          onchain = { score: s, payoutMatches: s.payout === rep.payout, claimable: ok.map((b) => b.address) };
          lines.push(`onchain: VerifiedScore ${s.address} at slot ${s.slot}, payout ${s.payout} ${s.payout === rep.payout ? "(matches)" : "(DOES NOT MATCH)"}`,
            `  ${explorerUrl("address", s.address, c.cluster)}`, `  claimable open bounties: ${ok.length ? ok.map((b) => b.address).join(", ") : "none"}`);
        }
      }
      c.print(lines.join("\n"), { ...rep, onchain });
      if (!rep.ok) throw new CommanderError(1, "plumbline.verify", "bundle failed verification");
    });

  // ---------------- record ----------------
  program.command("record <proof>")
    .description("record_verified_score from a Groth16 proof JSON (the relayer normally does this)")
    .action(async (file, _a, cmd) => {
      const c = ctx(cmd);
      const ch = await c.chain(true);
      const r = await ch.recordVerifiedScore(parseProof(JSON.parse(fs.readFileSync(file, "utf8"))));
      c.print(`VerifiedScore ${r.score}, tx ${r.signature}`, r);
    });

  // ---------------- claim ----------------
  program.command("claim [bounty]")
    .description("pay a bounty to the payout proven in a VerifiedScore (anyone may send it; the money only goes to that payout)")
    .option("--score <address>", "VerifiedScore account")
    .option("--statement <hex>", "statement hash of the score")
    .option("--bundle <file>", "score bundle (its statement hash)")
    .action(async (bountyAddr, a, cmd) => {
      const c = ctx(cmd);
      const ch = await c.chain(true);
      let s: ScoreView | null = null;
      if (a.score) s = await ch.fetchScore(a.score);
      else if (a.statement) s = await ch.scoreByStatement(parseHex32(a.statement, "--statement"));
      else if (a.bundle) s = await ch.scoreByStatement((await checkBundle(fs.readFileSync(a.bundle, "utf8"))).statementHash);
      else throw new Error("give --score, --statement or --bundle");
      if (!s) throw new Error("no VerifiedScore for that score yet (has the relayer recorded it?)");
      const targets: BountyView[] = bountyAddr ? [await ch.fetchBounty(bountyAddr)].filter(Boolean) as BountyView[]
        : await ch.listBounties({ suite: s.suiteCommitment, openOnly: true });
      if (!targets.length) throw new Error(bountyAddr ? `no bounty at ${bountyAddr}` : "no open bounties on this suite");
      const results: any[] = [];
      for (const b of targets) {
        const ok = claimable(b, s);
        if (!ok.ok) { results.push({ bounty: b.address, skipped: ok.reason }); continue; }
        try { results.push({ bounty: b.address, ...(await ch.claim(b.address, s.address)), amount: b.amount }); }
        catch (e) { results.push({ bounty: b.address, error: errorText(e) }); }
      }
      c.print(results.map((r) => r.signature ? `paid ${r.bounty}: ${sol(r.amount)} -> ${r.payout}, tx ${r.signature}`
        : `${r.bounty}: ${r.skipped ? `skipped (${r.skipped})` : `failed (${r.error})`}`).join("\n"), results);
      if (!results.some((r) => r.signature)) throw new CommanderError(1, "plumbline.claim", "nothing claimed");
    });

  return program;
}

export function rank(a: ScoreView, b: ScoreView): number {
  const d = b.correct * a.total - a.correct * b.total; // higher accuracy first, no floats
  return d !== 0 ? d : Number(a.slot - b.slot); // ties: earlier slot first
}

function fmtBounty(b: BountyView): string {
  return [`bounty ${b.address} (${b.status})`, `  sponsor ${b.sponsor}`, `  reward ${sol(b.amount)}, target ${b.minCorrect}/${b.minTotal}`,
    `  suite ${b.suiteCommitment}`, `  created slot ${b.createdSlot}, deadline ${b.deadlineSlot}, grace ${b.claimGraceSlots}`,
    ...(b.status === "paid" ? [`  paid to ${b.winnerPayout} at slot ${b.paidSlot}`] : [])].join("\n");
}

/** Run with argv (without node/script); returns the exit code. */
export async function run(argv: string[], deps: Deps): Promise<number> {
  const program = buildProgram(deps);
  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (e: any) {
    if (e instanceof CommanderError) {
      if (e.code === "commander.helpDisplayed" || e.code === "commander.version" || e.exitCode === 0) return 0;
      if (!e.code.startsWith("commander.")) deps.err(e.message);
      return e.exitCode || 1;
    }
    deps.err(`error: ${errorText(e)}`);
    return e?.name === "MainnetRefused" ? 3 : 1;
  }
}
