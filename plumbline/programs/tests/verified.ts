// record_verified_score: Groth16 proofs of the plumbline/zk guest (330-byte journal), verified onchain.
// Fixtures (plumbline/zk/proofs):
//   synthetic-payout:   test-root guest image, synthetic TDX quote bound to statement-v1-payout.json
//                       (4/6, payout = the test entrant key).
//   synthetic-nopayout: test-root guest image, synthetic TDX quote bound to statement-v1.json (the bundle-v1
//                       statement, no payout field) => journal payout = 32 zero bytes.
//   intel-unbound:      production guest image (Intel root), real Intel-signed TDX quote from an H200
//                       confidential VM; its report_data is not our statement, so the journal says bound = 0.
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ComputeBudgetProgram, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import * as fs from "fs";
import { PlumblineRegistry } from "../target/types/plumbline_registry";

const load = (name: string) => {
  const j = JSON.parse(fs.readFileSync(`tests/fixtures/${name}-groth16.json`, "utf8"));
  const b = (h: string) => Buffer.from(h.slice(2), "hex");
  return { imageId: Array.from(b(j.imageId)), journal: b(j.journal), seal: b(j.seal) };
};
const INTEL_ROOT = Array.from(Buffer.from("44a0196b2b99f889b8e149e95b807a350e7424964399e885a7cbb8ccfab674d3", "hex"));
const PAYOUT = "G86RoeNmR7dTKjxsqhZZBnh15mvQgfU7W3BCnCcS3dfk";

describe("verified scores (RISC Zero Groth16, payout in the journal)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.plumblineRegistry as Program<PlumblineRegistry>;
  const me = provider.wallet.publicKey;
  const pda = (...s: Buffer[]) => PublicKey.findProgramAddressSync(s, program.programId)[0];
  const config = pda(Buffer.from("config"));
  const programData = PublicKey.findProgramAddressSync([program.programId.toBuffer()],
    new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"))[0];

  const good = load("synthetic-payout");
  const nopay = load("synthetic-nopayout");
  const unbound = load("intel-unbound");
  const testRoot = Array.from(good.journal.subarray(224, 256));
  const compose = Array.from(good.journal.subarray(266, 298));
  const mrTd = Array.from(good.journal.subarray(128, 176));
  const ANY_TD = new Array(48).fill(0);
  const stmt = (j: Buffer) => Array.from(j.subarray(0, 32));
  const verified = (j: Buffer) => pda(Buffer.from("verified"), j.subarray(0, 32));
  const suite = pda(Buffer.from("suite"), good.journal.subarray(64, 96));

  async function submit(p: { seal: Buffer; journal: Buffer }, opts: { statement?: number[]; suite?: PublicKey | null } = {}) {
    const statement = opts.statement ?? stmt(p.journal);
    return program.methods.recordVerifiedScore(statement, p.seal, p.journal)
      .accountsPartial({ score: pda(Buffer.from("verified"), Buffer.from(statement)), config, suite: opts.suite ?? null, submitter: me })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
      .rpc();
  }
  async function fails(p: Promise<any>, needle: string) {
    try { await p; } catch (e: any) { expect(String(e) + JSON.stringify(e.logs ?? [])).to.contain(needle); return; }
    expect.fail(`expected failure containing ${needle}`);
  }
  const setConfig = (imageId: number[], root: number[], c: number[] = compose, td: number[] = mrTd) =>
    program.methods.setConfig(imageId, root, c, td).accountsPartial({ config, admin: me }).rpc();

  it("fixtures: 330-byte journals, the payout proof binds the test key, the other proves zeros", () => {
    for (const p of [good, nopay, unbound]) expect(p.journal.length).to.equal(330);
    expect(new PublicKey(good.journal.subarray(298, 330)).toBase58()).to.equal(PAYOUT);
    expect(nopay.journal.subarray(298, 330).every((x) => x === 0)).to.equal(true);
    expect([good.journal[265], nopay.journal[265]]).to.deep.equal([1, 1]);
    expect(Buffer.from(nopay.imageId).equals(Buffer.from(good.imageId))).to.equal(true);
  });

  it("only the upgrade authority can initialise the config", async () => {
    const other = Keypair.generate();
    await provider.connection.confirmTransaction(await provider.connection.requestAirdrop(other.publicKey, LAMPORTS_PER_SOL), "confirmed");
    await fails(program.methods.initConfig(good.imageId, testRoot, compose, mrTd)
      .accountsPartial({ config, admin: other.publicKey, programData }).signers([other]).rpc(), "NotUpgradeAuthority");
    await program.methods.initConfig(good.imageId, testRoot, compose, mrTd).accountsPartial({ config, admin: me, programData }).rpc();
    const c = await program.account.config.fetch(config);
    expect(Buffer.from(c.imageId).equals(Buffer.from(good.imageId))).to.equal(true);
    await fails(program.methods.setConfig(good.imageId, testRoot, compose, mrTd)
      .accountsPartial({ config, admin: other.publicKey }).signers([other]).rpc(), "NotAuthor");
  });

  it("rejects a proof whose guest pinned a different root than the config", async () => {
    await setConfig(good.imageId, INTEL_ROOT);
    await fails(submit(good), "WrongRoot");
    await setConfig(good.imageId, testRoot);
  });

  it("rejects an edited journal (score or payout), a bad seal, a short journal and a mismatched statement argument", async () => {
    const j = Buffer.from(good.journal); j[256] ^= 1; // correct count
    await fails(submit({ seal: good.seal, journal: j }), "BadProof");
    const jp = Buffer.from(good.journal); jp[320] ^= 1; // payout: a relayer cannot redirect the prize
    await fails(submit({ seal: good.seal, journal: jp }), "BadProof");
    const s = Buffer.from(good.seal); s[10] ^= 1;
    await fails(submit({ seal: s, journal: good.journal }), "BadProof");
    await fails(submit({ seal: good.seal, journal: good.journal.subarray(0, 298) }), "BadJournal");
    const other = Array.from(good.journal.subarray(0, 32)).map((x, i) => (i === 0 ? x ^ 1 : x));
    await fails(submit(good, { statement: other }), "JournalMismatch");
  });

  it("rejects a score from a different enclave (compose hash or TD image)", async () => {
    expect(compose.some((x) => x !== 0)).to.equal(true);
    await setConfig(good.imageId, testRoot, compose.map((x, i) => (i === 0 ? x ^ 1 : x)));
    await fails(submit(good), "WrongEnclave");
    await setConfig(good.imageId, testRoot, compose, mrTd.map((x, i) => (i === 0 ? x ^ 1 : x)));
    await fails(submit(good), "WrongEnclave");
    await setConfig(good.imageId, testRoot, compose, ANY_TD); // mr_td unpinned: accepted below
  });

  it("rejects a proof for a different guest image", async () => {
    await setConfig(unbound.imageId, testRoot);
    await fails(submit(good), "BadProof");
    await setConfig(good.imageId, testRoot, compose, ANY_TD);
  });

  it("rejects a real Intel quote that does not commit to the statement", async () => {
    await setConfig(unbound.imageId, INTEL_ROOT);
    expect(unbound.journal[265]).to.equal(0);
    // same statement as the no-payout synthetic proof, so this runs before that one is recorded
    await fails(submit(unbound), "QuoteNotBound");
    expect(unbound.journal.subarray(266, 298).every((x) => x === 0)).to.equal(true); // no dstack event log
    await setConfig(good.imageId, testRoot, compose, ANY_TD);
  });

  it("records the proven score with every field, including the payout, taken from the journal", async () => {
    let got: any = null;
    const l = program.addEventListener("verifiedScoreRecorded", (e) => { got = e; });
    const sig = await submit(good, { suite });
    const r = await program.account.verifiedScore.fetch(verified(good.journal));
    const j = good.journal;
    expect(Buffer.from(r.statementHash).equals(j.subarray(0, 32))).to.equal(true);
    expect(Buffer.from(r.modelIdHash).equals(j.subarray(32, 64))).to.equal(true);
    expect(Buffer.from(r.suiteCommitment).equals(j.subarray(64, 96))).to.equal(true);
    expect(Buffer.from(r.quoteHash).equals(j.subarray(96, 128))).to.equal(true);
    expect(Buffer.from(r.mrTd).equals(j.subarray(128, 176))).to.equal(true);
    expect(Buffer.from(r.rtmrsHash).equals(j.subarray(176, 208))).to.equal(true);
    expect(Buffer.from(r.teeTcbSvn).equals(j.subarray(208, 224))).to.equal(true);
    expect(Buffer.from(r.composeHash).equals(j.subarray(266, 298))).to.equal(true);
    expect(r.payout.toBase58()).to.equal(PAYOUT);
    expect([r.correct, r.total, r.bindingVersion]).to.deep.equal([4, 6, 1]);
    expect(Buffer.from(r.imageId).equals(Buffer.from(good.imageId))).to.equal(true);
    expect(r.suiteRegistered).to.equal(true);
    expect(r.submitter.toBase58()).to.equal(me.toBase58());
    const tx = await provider.connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    expect(r.slot.toNumber()).to.equal(tx!.slot);
    console.log(`      record_verified_score: ${tx!.meta!.computeUnitsConsumed} CU, tx ${tx!.transaction.message.serialize().length + 65} bytes`);
    for (let i = 0; i < 50 && !got; i++) await new Promise((r) => setTimeout(r, 100));
    await program.removeEventListener(l);
    expect(got.payout.toBase58()).to.equal(PAYOUT);
    const s = await program.account.suite.fetch(suite);
    expect(s.scoreCount.toNumber()).to.equal(2);
  });

  it("records a statement without a payout field with a zero payout (the escrow refuses it, not the registry)", async () => {
    await submit(nopay, { suite });
    const r = await program.account.verifiedScore.fetch(verified(nopay.journal));
    expect(r.payout.toBase58()).to.equal(PublicKey.default.toBase58());
    // the bundle-v1 statement: the unverified fixture record and this verified one coexist
    const fx = JSON.parse(fs.readFileSync("tests/fixtures/bundle-v1.args.json", "utf8"));
    expect(Buffer.from(r.statementHash).toString("hex")).to.equal(fx.statement_hash);
    expect((await program.account.suite.fetch(suite)).scoreCount.toNumber()).to.equal(3);
  });

  it("rejects the same statement twice (replay)", async () => {
    await fails(submit(good), "already in use");
    await fails(submit(nopay), "already in use");
  });
});
