// Relayer pipeline with the prover and the chain mocked. The mock chain enforces the program's claim
// rules (via the same claimable() the CLI uses) and pays only VerifiedScore.payout.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// web3.js comes through the cli package so there is a single copy of PublicKey
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimable, Keypair, parseJournal, parseProof, PublicKey, type BountyView, type Proof, type ScoreView } from "../../cli/src/chain/index.js";
import { makeBundle, proofJsonFor } from "../../cli/test/fixtures.js";
import { loadConfig } from "../src/config.js";
import { Relayer, type ChainPort } from "../src/pipeline.js";
import { CommandProver, type ProverPort } from "../src/prover.js";
import { httpServer, Inbox } from "../src/service.js";
import { State } from "../src/state.js";

const Z = "00".repeat(32);

class MockChain implements ChainPort {
  slot = 1000n;
  scores = new Map<string, ScoreView>();
  bounties: BountyView[] = [];
  paid: { bounty: string; to: string; amount: bigint }[] = [];
  records = 0;
  failRecordOnce = false;

  addBounty(o: Partial<BountyView> = {}) {
    const b: BountyView = { address: Keypair.generate().publicKey.toBase58(), sponsor: Keypair.generate().publicKey.toBase58(), nonce: 1n,
      suiteCommitment: "7c".repeat(32), minCorrect: 2, minTotal: 3, amount: 1_000_000_000n, mint: null, deadlineSlot: 5000n, claimGraceSlots: 0n,
      requireRegisteredSuite: false, requiredComposeHash: Z, requiredImageId: Z, createdSlot: 900n, status: "open", winnerStatementHash: Z,
      winnerModelIdHash: Z, winnerPayout: PublicKey.default.toBase58(), paidSlot: 0n, ...o };
    this.bounties.push(b);
    return b;
  }
  async scoreByStatement(h: string) { return this.scores.get(h) ?? null; }
  async fetchScore(a: string) { return [...this.scores.values()].find((s) => s.address === a) ?? null; }
  async recordVerifiedScore(p: Proof) {
    const j = parseJournal(p.journal);
    const h = j.statementHash.toString("hex");
    if (this.failRecordOnce) { this.failRecordOnce = false; this.insert(j); throw new Error("already in use"); }
    if (this.scores.has(h)) throw new Error("already in use");
    if (j.bound !== 1) throw new Error("QuoteNotBound");
    this.records++;
    return { signature: `rec-${h.slice(0, 6)}`, score: this.insert(j).address };
  }
  insert(j: ReturnType<typeof parseJournal>) {
    const s: ScoreView = { address: Keypair.generate().publicKey.toBase58(), statementHash: j.statementHash.toString("hex"), modelIdHash: j.modelIdHash.toString("hex"),
      suiteCommitment: j.suiteCommitment.toString("hex"), quoteHash: Z, mrTd: "00".repeat(48), composeHash: j.composeHash.toString("hex"), imageId: "11".repeat(32),
      correct: j.correct, total: j.total, bindingVersion: 1, suiteRegistered: false, submitter: Keypair.generate().publicKey.toBase58(), slot: this.slot++,
      unixTimestamp: 0n, payout: new PublicKey(j.payout).toBase58() };
    this.scores.set(s.statementHash, s);
    return s;
  }
  async listBounties(o: { suite: string; openOnly: boolean }) {
    return this.bounties.filter((b) => b.suiteCommitment === o.suite && (!o.openOnly || b.status === "open")).map((b) => ({ ...b }));
  }
  async claim(bounty: string, score: string) {
    const b = this.bounties.find((x) => x.address === bounty)!;
    const s = (await this.fetchScore(score))!;
    const ok = claimable(b, s);
    if (!ok.ok) throw new Error(ok.reason);
    b.status = "paid"; b.winnerPayout = s.payout; b.winnerStatementHash = s.statementHash;
    this.paid.push({ bounty, to: s.payout, amount: b.amount });
    return { signature: `claim-${bounty.slice(0, 6)}`, payout: s.payout };
  }
}

class FakeProver implements ProverPort {
  calls = 0;
  constructor(private make: (statementHash: string) => any) {}
  async prove(inputs: { statement: Buffer }, dir: string) {
    this.calls++;
    fs.mkdirSync(dir, { recursive: true });
    const h = (await import("node:crypto")).createHash("sha256").update(inputs.statement).digest("hex");
    const proofPath = path.join(dir, "proof.json");
    const json = this.make(h);
    fs.writeFileSync(proofPath, JSON.stringify(json));
    return { proof: parseProof(json), proofPath };
  }
}

let dir: string, logs: { step: string; [k: string]: unknown }[];
const log = (step: string, f: Record<string, unknown> = {}) => { logs.push({ step, ...f }); };
const steps = () => logs.map((l) => l.step);
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "plumbline-relayer-")); logs = []; });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function setup(bundles: ReturnType<typeof makeBundle>[], over: (h: string, b: ReturnType<typeof makeBundle>) => any = (_h, b) => proofJsonFor(b)) {
  const chain = new MockChain();
  const byHash = new Map(bundles.map((b) => [b.statementHash, b]));
  const prover = new FakeProver((h) => over(h, byHash.get(h)!));
  const state = new State(path.join(dir, "state.json"));
  const relayer = new Relayer({ chain, prover, state, log, workDir: path.join(dir, "work"), quoteCheck: "binding" });
  const inbox = new Inbox(path.join(dir, "inbox"), relayer, log);
  return { chain, prover, state, relayer, inbox };
}

describe("relayer pipeline", () => {
  it("inbox bundle -> prove -> record -> claims exactly the bounties the score meets, paid to the proven payout", async () => {
    const b = makeBundle({ correct: 5, n: 6 });
    const { chain, prover, state, inbox } = setup([b]);
    const meets = chain.addBounty({ minCorrect: 2, minTotal: 3 });
    const tooHigh = chain.addBounty({ minCorrect: 6, minTotal: 6 });
    const newer = chain.addBounty({ createdSlot: 2000n }); // created after the score's slot
    const otherSuite = chain.addBounty({ suiteCommitment: "99".repeat(32) });
    fs.writeFileSync(path.join(inbox.dir, "bundle-a.json"), b.text);
    const [out] = await inbox.scan();
    expect(out.status).toBe("claimed");
    expect(prover.calls).toBe(1);
    expect(chain.records).toBe(1);
    expect(chain.paid).toEqual([{ bounty: meets.address, to: b.payout, amount: 1_000_000_000n }]);
    const e = state.get(b.statementHash)!;
    expect(e.status).toBe("claimed");
    expect(e.claims[meets.address].signature).toMatch(/^claim-/);
    expect(e.claims[tooHigh.address].skipped).toBe("BelowTarget");
    expect(e.claims[newer.address].skipped).toBe("ScoreBeforeBounty");
    expect(e.claims[otherSuite.address]).toBeUndefined();
    expect(fs.existsSync(path.join(inbox.done, "bundle-a.json"))).toBe(true);
    expect(steps()).toEqual(expect.arrayContaining(["bundle.received", "bundle.checked", "prove.start", "prove.done", "record.start", "record.done",
      "claim.scan", "claim.skip", "claim.start", "claim.done", "bundle.done", "inbox.moved"]));
    // state survives a restart
    expect(new State(path.join(dir, "state.json")).get(b.statementHash)!.status).toBe("claimed");
  });

  it("is idempotent: a repeated bundle is not proved or recorded again and nothing is paid twice", async () => {
    const b = makeBundle();
    const { chain, prover, inbox } = setup([b]);
    chain.addBounty();
    fs.writeFileSync(path.join(inbox.dir, "x.json"), b.text);
    await inbox.scan();
    fs.writeFileSync(path.join(inbox.dir, "x-again.json"), b.text);
    const [again] = await inbox.scan();
    expect(again.status).toBe("claimed");
    expect([prover.calls, chain.records, chain.paid.length]).toEqual([1, 1, 1]);
    expect(steps()).toContain("record.skip");
  });

  it("skips proving when someone else already recorded the statement, and still claims", async () => {
    const b = makeBundle();
    const { chain, prover, relayer } = setup([b]);
    chain.insert(parseJournal(parseProof(proofJsonFor(b)).journal));
    const bounty = chain.addBounty({ createdSlot: 0n });
    const out = await relayer.handle(b.text, "test");
    expect(out.status).toBe("claimed");
    expect(prover.calls).toBe(0);
    expect(chain.paid[0]).toMatchObject({ bounty: bounty.address, to: b.payout });
  });

  it("treats a lost record race as success", async () => {
    const b = makeBundle();
    const { chain, relayer } = setup([b]);
    chain.addBounty({ createdSlot: 0n });
    chain.failRecordOnce = true;
    const out = await relayer.handle(b.text, "test");
    expect(out.status).toBe("claimed");
    expect(steps()).toContain("record.raced");
  });

  it("rejects a bundle that fails the local checks without running the prover", async () => {
    const bad = makeBundle({ breakBinding: true });
    const noPayout = makeBundle({ payout: null });
    const { prover, inbox, state } = setup([bad, noPayout]);
    fs.writeFileSync(path.join(inbox.dir, "bad.json"), bad.text);
    fs.writeFileSync(path.join(inbox.dir, "nopayout.json"), noPayout.text);
    fs.writeFileSync(path.join(inbox.dir, "junk.json"), "{not json");
    const outs = await inbox.scan();
    expect(outs.map((o) => o.status).sort()).toEqual(["rejected", "rejected", "unreadable"]);
    expect(prover.calls).toBe(0);
    expect(fs.readdirSync(inbox.rejected).sort()).toEqual(["bad.json", "junk.json", "nopayout.json"]);
    expect(state.get(noPayout.statementHash)!.error).toMatch(/payout/);
  });

  it("refuses a proof whose journal does not match the bundle (payout, binding) and records nothing", async () => {
    const b = makeBundle();
    const thief = Keypair.generate().publicKey.toBuffer().toString("hex");
    for (const [over, why] of [[{ payoutHex: thief }, /payout/], [{ bound: 0 }, /bound = 0/]] as const) {
      for (const f of ["state.json", "work"]) fs.rmSync(path.join(dir, f), { recursive: true, force: true }); // fresh run each case
      const { chain, relayer, state } = setup([b], (_h, x) => proofJsonFor(x, over));
      chain.addBounty({ createdSlot: 0n });
      const out = await relayer.handle(b.text, "test");
      expect(out.status).toBe("failed");
      expect(out.detail).toMatch(why);
      expect([chain.records, chain.paid.length]).toEqual([0, 0]);
      expect(state.get(b.statementHash)!.attempts).toBe(1);
    }
  });

  it("reuses a proof from an interrupted run instead of proving again", async () => {
    const b = makeBundle();
    const first = setup([b]);
    first.chain.recordVerifiedScore = async () => { throw new Error("RPC down"); };
    expect((await first.relayer.handle(b.text, "t")).status).toBe("failed");
    expect(first.prover.calls).toBe(1);
    // restart with a working chain, same state file and work dir
    const chain = new MockChain();
    const prover = new FakeProver(() => { throw new Error("should not prove again"); });
    const relayer = new Relayer({ chain, prover, state: new State(path.join(dir, "state.json")), log, workDir: path.join(dir, "work"), quoteCheck: "binding" });
    const out = await relayer.handle(b.text, "t");
    expect(out.status).toBe("recorded"); // no bounties: recorded, nothing to claim
    expect(steps()).toContain("prove.reuse");
  });

  it("has no payout setting: the config refuses one", () => {
    const f = path.join(dir, "cfg.json");
    fs.writeFileSync(f, JSON.stringify({ payout: Keypair.generate().publicKey.toBase58() }));
    expect(() => loadConfig(f, {})).toThrow(/no payout setting/);
    fs.writeFileSync(f, JSON.stringify({ inbox: "in", prover: { command: ["x"] } }));
    const c = loadConfig(f, {});
    expect([c.inbox, c.prover.command, c.cluster]).toEqual(["in", ["x"], "localnet"]);
  });
});

describe("HTTP POST /bundles", () => {
  it("stores the bundle in the inbox, processes it, and reports status", async () => {
    const b = makeBundle();
    const { chain, inbox, state } = setup([b]);
    chain.addBounty();
    let processed: Promise<unknown> = Promise.resolve();
    const server = httpServer(inbox, state, log, { onAccepted: () => { processed = inbox.scan(); } });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(server.address() as any).port}`;
    try {
      const r = await fetch(`${url}/bundles`, { method: "POST", body: b.text });
      expect(r.status).toBe(202);
      await processed;
      const st = await (await fetch(`${url}/status?statement=${b.statementHash}`)).json();
      expect(st.status).toBe("claimed");
      expect((await fetch(`${url}/bundles`, { method: "POST", body: "nope" })).status).toBe(400);
      expect((await fetch(`${url}/bundles`, { method: "POST", body: JSON.stringify({ x: 1 }) })).status).toBe(400);
      const big = await fetch(`${url}/bundles`, { method: "POST", body: "x".repeat(5 * 1024 * 1024) }).catch(() => ({ status: 413 }));
      expect(big.status).toBe(413);
      expect((await fetch(`${url}/health`)).status).toBe(200);
    } finally { server.close(); }
  });
});

describe("CommandProver", () => {
  it("writes the guest inputs, substitutes placeholders and reads the proof from {out}", async () => {
    const b = makeBundle();
    const proofFile = path.join(dir, "canned.json");
    fs.writeFileSync(proofFile, JSON.stringify(proofJsonFor(b)));
    const script = path.join(dir, "fake-host.mjs");
    // stands in for `tessera-risc0-host groth16 <quote> <statement> <event_log>` with OUT=<path>
    fs.writeFileSync(script, `import fs from "node:fs";
const [mode, q, st, ev] = process.argv.slice(2);
if (mode !== "groth16") process.exit(2);
for (const f of [q, st, ev]) if (!fs.existsSync(f)) process.exit(3);
fs.copyFileSync(process.env.CANNED, process.env.OUT);`);
    const p = new CommandProver({ command: [process.execPath, script, "groth16", "{quote}", "{statement}", "{event_log}"], env: { OUT: "{out}", CANNED: proofFile } }, log);
    const { proof, proofPath } = await p.prove({ quote: Buffer.from("q"), statement: b.canonical, eventLog: "[]" }, path.join(dir, "job"));
    expect(parseJournal(proof.journal).statementHash.toString("hex")).toBe(b.statementHash);
    expect(fs.readFileSync(path.join(dir, "job", "statement.json")).equals(b.canonical)).toBe(true);
    expect(proofPath).toBe(path.join(dir, "job", "proof.json"));
    const failing = new CommandProver({ command: [process.execPath, script, "execute"] });
    await expect(failing.prove({ quote: Buffer.alloc(1), statement: Buffer.alloc(1), eventLog: "[]" }, path.join(dir, "job2"))).rejects.toThrow(/exited 2/);
  });
});
