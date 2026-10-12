import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { expect } from "chai";
import { createHash } from "crypto";
import * as fs from "fs";
import { PlumblineRegistry } from "../target/types/plumbline_registry";

const hex = (s: string) => Array.from(Buffer.from(s, "hex"));
const rand = (n: number) => Array.from(anchor.web3.Keypair.generate().secretKey.slice(0, n));
const sha = (s: string) => Array.from(createHash("sha256").update(s).digest());

describe("plumbline registry (unverified records, suites)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.plumblineRegistry as Program<PlumblineRegistry>;
  const me = provider.wallet.publicKey;

  const scorePda = (h: number[]) =>
    PublicKey.findProgramAddressSync([Buffer.from("score"), Buffer.from(h)], program.programId)[0];
  const suitePda = (c: number[]) =>
    PublicKey.findProgramAddressSync([Buffer.from("suite"), Buffer.from(c)], program.programId)[0];

  const fx = JSON.parse(fs.readFileSync("tests/fixtures/bundle-v1.args.json", "utf8"));
  const bundle = JSON.parse(fs.readFileSync("tests/fixtures/bundle-v1.json", "utf8"));
  const commitment = hex(fx.suite_commitment);

  async function record(a: any, opts: { suite?: PublicKey | null; signer?: Keypair } = {}) {
    let b = program.methods
      .recordScore(a.statement_hash, a.model_id_hash, a.suite_commitment, a.quote_hash, a.mr_td,
        a.correct, a.total, a.binding_version)
      .accountsPartial({ score: scorePda(a.statement_hash), suite: opts.suite ?? null,
        submitter: opts.signer?.publicKey ?? me });
    if (opts.signer) b = b.signers([opts.signer]);
    return b.rpc();
  }
  const fxArgs = () => ({
    statement_hash: hex(fx.statement_hash), model_id_hash: hex(fx.model_id_hash),
    suite_commitment: commitment, quote_hash: hex(fx.quote_hash), mr_td: hex(fx.mr_td),
    correct: fx.correct, total: fx.total, binding_version: fx.binding_version,
  });
  const randArgs = (over: any = {}) => ({
    statement_hash: rand(32), model_id_hash: rand(32), suite_commitment: rand(32),
    quote_hash: rand(32), mr_td: rand(48), correct: 3, total: 10, binding_version: 2, ...over,
  });
  async function fails(p: Promise<any>, needle: string) {
    try { await p; } catch (e: any) { expect(String(e) + JSON.stringify(e.logs ?? [])).to.contain(needle); return; }
    expect.fail(`expected failure containing ${needle}`);
  }

  it("fixture args match the bundle's statement (bundle_to_args.py derivation)", () => {
    const canon = (o: any): string => JSON.stringify(Object.keys(o).sort().reduce((r: any, k) => (r[k] = o[k], r), {}));
    expect(createHash("sha256").update(canon(bundle.statement)).digest("hex")).to.equal(fx.statement_hash);
    expect(fx.statement_hash).to.equal(bundle.statement_sha256);
  });

  it("registers a suite priced in lamports", async () => {
    await program.methods.registerSuite(commitment, new anchor.BN(0.5 * LAMPORTS_PER_SOL), null)
      .accountsPartial({ suite: suitePda(commitment), author: me }).rpc();
    const s = await program.account.suite.fetch(suitePda(commitment));
    expect(s.author.toBase58()).to.equal(me.toBase58());
    expect(Buffer.from(s.suiteCommitment).toString("hex")).to.equal(fx.suite_commitment);
    expect(s.price.toNumber()).to.equal(0.5 * LAMPORTS_PER_SOL);
    expect(s.priceMint).to.equal(null);
    expect(s.scoreCount.toNumber()).to.equal(0);
  });

  it("rejects registering the same suite twice", async () => {
    await fails(program.methods.registerSuite(commitment, new anchor.BN(1), null)
      .accountsPartial({ suite: suitePda(commitment), author: me }).rpc(), "already in use");
  });

  it("records the fixture bundle's score against the registered suite", async () => {
    const a = fxArgs();
    const sig = await record(a, { suite: suitePda(commitment) });
    const r = await program.account.scoreRecord.fetch(scorePda(a.statement_hash));
    expect(Buffer.from(r.statementHash).toString("hex")).to.equal(fx.statement_hash);
    expect(Buffer.from(r.modelIdHash).toString("hex")).to.equal(fx.model_id_hash);
    expect(Buffer.from(r.quoteHash).toString("hex")).to.equal(fx.quote_hash);
    expect(Buffer.from(r.mrTd).toString("hex")).to.equal(bundle.measurements.mr_td);
    expect(r.correct).to.equal(4);
    expect(r.total).to.equal(6);
    expect(r.bindingVersion).to.equal(1);
    expect(r.suiteRegistered).to.equal(true);
    expect(r.submitter.toBase58()).to.equal(me.toBase58());
    const tx = await provider.connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    expect(r.slot.toNumber()).to.equal(tx!.slot);
    const s = await program.account.suite.fetch(suitePda(commitment));
    expect(s.scoreCount.toNumber()).to.equal(1);
  });

  it("rejects a duplicate statement hash, even from another submitter", async () => {
    const other = Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(other.publicKey, LAMPORTS_PER_SOL), "confirmed");
    await fails(record(fxArgs(), { suite: suitePda(commitment), signer: other }), "already in use");
    await fails(record({ ...fxArgs(), correct: 6 }), "already in use");
  });

  it("records a score for an unregistered suite without a suite account", async () => {
    const a = randArgs();
    await record(a);
    const r = await program.account.scoreRecord.fetch(scorePda(a.statement_hash));
    expect(r.suiteRegistered).to.equal(false);
    expect(r.bindingVersion).to.equal(2);
  });

  it("rejects a suite account that belongs to a different commitment", async () => {
    await fails(record(randArgs(), { suite: suitePda(commitment) }), "ConstraintSeeds");
  });

  it("validates score fields", async () => {
    await fails(record(randArgs({ correct: 11, total: 10 })), "BadScore");
    await fails(record(randArgs({ correct: 0, total: 0 })), "BadScore");
    await fails(record(randArgs({ binding_version: 3 })), "BadBindingVersion");
    await fails(record(randArgs({ quote_hash: new Array(32).fill(0) })), "ZeroHash");
    await fails(record(randArgs({ mr_td: new Array(48).fill(0) })), "ZeroHash");
  });

  it("lets only the author change the price, including to a USDC mint", async () => {
    const other = Keypair.generate();
    await fails(program.methods.setSuitePrice(new anchor.BN(1), null)
      .accountsPartial({ suite: suitePda(commitment), author: other.publicKey }).signers([other]).rpc(), "NotAuthor");
    const usdc = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"); // devnet USDC
    await program.methods.setSuitePrice(new anchor.BN(25_000_000), usdc)
      .accountsPartial({ suite: suitePda(commitment), author: me }).rpc();
    const s = await program.account.suite.fetch(suitePda(commitment));
    expect(s.price.toNumber()).to.equal(25_000_000);
    expect(s.priceMint!.toBase58()).to.equal(usdc.toBase58());
  });

  it("emits ScoreRecorded", async () => {
    const a = randArgs();
    let got: any = null;
    const l = program.addEventListener("scoreRecorded", (e) => { got = e; });
    await record(a);
    for (let i = 0; i < 50 && !got; i++) await new Promise((r) => setTimeout(r, 100));
    await program.removeEventListener(l);
    expect(got).to.not.equal(null);
    expect(Buffer.from(got.statementHash).toString("hex")).to.equal(Buffer.from(a.statement_hash).toString("hex"));
  });
});
