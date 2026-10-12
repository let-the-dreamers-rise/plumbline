// Pay-on-proof against real registry VerifiedScores (test-root Groth16 proofs, 4/6 on the fixture suite):
// `good` carries the payout proven in the statement, `nopay` is the same score without a payout field.
// Run by scripts/localnet-test.sh on a validator preloaded with the two forged accounts from make-forged.ts.
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import * as crypto from "crypto";
import * as fs from "fs";
import { ComputeBudgetProgram } from "@solana/web3.js";
import {
  bounty, bountyPda, claim, COMPOSE, conn, createBounty, events, fails, funded, good, MODEL, nopay, PAYOUT,
  recordVerifiedScore, registry, regConfig, regSuite, rpda, setupRegistry, slot, STATEMENT, SUITE, verifiedOf,
  verifiedPda, waitPastSlot,
} from "./common";

const forged = (n: string) => new PublicKey(JSON.parse(fs.readFileSync(`tests/fixtures/forged/${n}.json`, "utf8")).pubkey);
const SOL = LAMPORTS_PER_SOL;

describe("pay-on-proof bounty (payout proven in the score)", () => {
  let sponsor: Keypair, stranger: Keypair, cranker: Keypair, relayer: Keypair;
  const OTHER_SUITE = crypto.randomBytes(32);
  let far: number, near: number, scoreSlot: number;
  const B = (nonce: number, suite: Buffer = SUITE) => bountyPda(sponsor.publicKey, suite, nonce);
  // nonces
  const HAPPY = 1, BELOW = 2, WRONG_SUITE = 3, LATE = 4, OPEN = 5, REFUND = 6, PINNED = 7, RATIO = 8, NOPAY = 9,
    PINNED_IMAGE = 10, AFTER_SCORE = 11, GRACE = 12;

  before(async () => {
    [sponsor, stranger, cranker, relayer] = await Promise.all([funded(20), funded(), funded(), funded()]);
    await setupRegistry();
    const now = await slot();
    far = now + 100_000;
    near = now + 30;
  });

  it("the proof's payout is the test entrant's key and nobody holds it here", async () => {
    expect(PAYOUT.toBase58()).to.equal("G86RoeNmR7dTKjxsqhZZBnh15mvQgfU7W3BCnCcS3dfk");
    expect(await conn.getBalance(PAYOUT)).to.equal(0);
    expect(nopay.journal.subarray(298, 330).every((x) => x === 0)).to.equal(true);
    expect(Buffer.from(nopay.journal.subarray(32, 64)).equals(MODEL)).to.equal(true); // same model and suite
  });

  it("create_bounty rejects bad terms", async () => {
    const base = { nonce: 99, minCorrect: 2, minTotal: 3, deadline: far };
    await fails(createBounty(sponsor, { ...base, minCorrect: 4, minTotal: 3 }), "BadTarget");
    await fails(createBounty(sponsor, { ...base, minTotal: 0, minCorrect: 0 }), "BadTarget");
    await fails(createBounty(sponsor, { ...base, amount: 0 }), "ZeroAmount");
    await fails(createBounty(sponsor, { ...base, mint: Keypair.generate().publicKey }), "MintNotSupported");
    await fails(createBounty(sponsor, { ...base, deadline: (await slot()) - 1 }), "DeadlineInPast");
    await fails(createBounty(sponsor, { ...base, suite: Buffer.alloc(32) }), "ZeroHash");
    await fails(createBounty(sponsor, { ...base, requireSuite: true }), "SuiteNotRegistered");
    await fails(createBounty(sponsor, { ...base, requireSuite: true, suiteAcct: sponsor.publicKey }), "SuiteNotRegistered");
    // registered-suite requirement with an unregistered commitment: the PDA does not exist
    await fails(createBounty(sponsor, { ...base, suite: OTHER_SUITE, requireSuite: true,
      suiteAcct: rpda(Buffer.from("suite"), OTHER_SUITE) }), "SuiteNotRegistered");
    // the registry config account is registry-owned but not the Suite PDA
    await fails(createBounty(sponsor, { ...base, requireSuite: true, suiteAcct: regConfig }), "SuiteNotRegistered");
  });

  it("creates bounties and escrows the lamports in the bounty PDA", async () => {
    const before = await conn.getBalance(sponsor.publicKey);
    const sig = await createBounty(sponsor, { nonce: HAPPY, minCorrect: 2, minTotal: 3, deadline: far, requireSuite: true, suiteAcct: regSuite });
    expect((await events(sig)).map((e) => e.name)).to.deep.equal(["bountyCreated"]);
    await createBounty(sponsor, { nonce: BELOW, minCorrect: 5, minTotal: 6, deadline: far });
    await createBounty(sponsor, { nonce: WRONG_SUITE, suite: OTHER_SUITE, minCorrect: 1, minTotal: 2, deadline: far });
    await createBounty(sponsor, { nonce: LATE, minCorrect: 1, minTotal: 2, deadline: near });
    await createBounty(sponsor, { nonce: OPEN, minCorrect: 1, minTotal: 2, deadline: far });
    await createBounty(sponsor, { nonce: REFUND, minCorrect: 1, minTotal: 2, deadline: near, grace: 10 });
    await createBounty(sponsor, { nonce: PINNED, minCorrect: 1, minTotal: 2, deadline: far, compose: COMPOSE.map((x, i) => (i ? x : x ^ 1)) });
    await createBounty(sponsor, { nonce: PINNED_IMAGE, minCorrect: 1, minTotal: 2, deadline: far, image: good.imageId.map((x, i) => (i ? x : x ^ 1)) });
    await createBounty(sponsor, { nonce: RATIO, minCorrect: 667, minTotal: 1000, deadline: far });
    await createBounty(sponsor, { nonce: NOPAY, minCorrect: 1, minTotal: 2, deadline: far });
    await createBounty(sponsor, { nonce: GRACE, minCorrect: 1, minTotal: 2, deadline: near, grace: 100_000 });
    const b = await bounty.account.bounty.fetch(B(HAPPY));
    const rent = await conn.getMinimumBalanceForRentExemption(bounty.account.bounty.size);
    expect(await conn.getBalance(B(HAPPY))).to.equal(rent + SOL);
    expect(b.amount.toNumber()).to.equal(SOL);
    expect(b.requireRegisteredSuite).to.equal(true);
    expect(b.createdSlot.toNumber()).to.be.greaterThan(0);
    expect(before - (await conn.getBalance(sponsor.publicKey))).to.be.greaterThan(11 * SOL);
  });

  it("records the real verified scores through the registry (Groth16, after the near deadline)", async () => {
    await waitPastSlot(near + 10); // also past REFUND's deadline + grace
    const s = await recordVerifiedScore(good);
    expect([s.correct, s.total]).to.deep.equal([4, 6]);
    expect(Buffer.from(s.modelIdHash).equals(MODEL)).to.equal(true);
    expect(s.payout.toBase58()).to.equal(PAYOUT.toBase58());
    scoreSlot = s.slot.toNumber();
    expect(scoreSlot).to.be.greaterThan(near);
    const n = await recordVerifiedScore(nopay);
    expect(n.payout.toBase58()).to.equal(PublicKey.default.toBase58());
    expect([n.correct, n.total]).to.deep.equal([4, 6]);
  });

  it("the proof cannot be replayed into a second record", async () => {
    await fails(registry.methods.recordVerifiedScore(Array.from(STATEMENT), good.seal, good.journal)
      .accountsPartial({ score: verifiedPda, config: regConfig, suite: regSuite, submitter: relayer.publicKey })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
      .signers([relayer]).rpc(), "already in use");
  });

  it("happy path: a relayer cranks, the money goes only to the proven payout (4/6 meets 2/3 exactly)", async () => {
    // the relayer (or anyone) cannot redirect it to themselves or to another wallet
    await fails(claim(B(HAPPY), verifiedPda, relayer.publicKey, relayer), "BadPayout");
    await fails(claim(B(HAPPY), verifiedPda, sponsor.publicKey, relayer), "BadPayout");
    const sig = await claim(B(HAPPY), verifiedPda, PAYOUT, relayer);
    expect(await conn.getBalance(PAYOUT)).to.equal(SOL);
    const b = await bounty.account.bounty.fetch(B(HAPPY));
    expect(b.status).to.equal(1);
    expect(Buffer.from(b.winnerStatementHash).equals(STATEMENT)).to.equal(true);
    expect(Buffer.from(b.winnerModelIdHash).equals(MODEL)).to.equal(true);
    expect(b.winnerPayout.toBase58()).to.equal(PAYOUT.toBase58());
    const ev = await events(sig);
    expect(ev.map((e) => e.name)).to.deep.equal(["bountyClaimed"]);
    const tx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    console.log(`      claim: ${tx!.meta!.computeUnitsConsumed} CU`);
    expect([ev[0].data.correct, ev[0].data.total, ev[0].data.scoreSlot.toNumber()]).to.deep.equal([4, 6, scoreSlot]);
    expect(ev[0].data.payout.toBase58()).to.equal(PAYOUT.toBase58());
    expect(ev[0].data.cranker.toBase58()).to.equal(relayer.publicKey.toBase58());
    const rent = await conn.getMinimumBalanceForRentExemption(bounty.account.bounty.size);
    expect(await conn.getBalance(B(HAPPY))).to.equal(rent);
  });

  it("replayed claim fails (same or another cranker)", async () => {
    await fails(claim(B(HAPPY), verifiedPda, PAYOUT, relayer), "AlreadyPaid");
    await fails(claim(B(HAPPY), verifiedPda, PAYOUT, cranker), "AlreadyPaid");
    expect(await conn.getBalance(PAYOUT)).to.equal(SOL);
  });

  it("a score without a proven payout pays nobody", async () => {
    await fails(claim(B(NOPAY), verifiedOf(nopay), PAYOUT, cranker), "NoPayout");
    await fails(claim(B(NOPAY), verifiedOf(nopay), cranker.publicKey, cranker), "NoPayout");
  });

  it("a wrong payout account fails even when everything else qualifies", async () => {
    await fails(claim(B(OPEN), verifiedPda, Keypair.generate().publicKey, cranker), "BadPayout");
    await fails(claim(B(OPEN), verifiedPda, verifiedPda, cranker), "BadPayout");
  });

  it("below target fails (4/6 < 5/6, and 4/6 against 667/1000)", async () => {
    await fails(claim(B(BELOW), verifiedPda, PAYOUT, cranker), "BelowTarget");
    await fails(claim(B(RATIO), verifiedPda, PAYOUT, cranker), "BelowTarget");
  });

  it("wrong suite fails", async () => {
    await fails(claim(B(WRONG_SUITE, OTHER_SUITE), verifiedPda, PAYOUT, cranker), "WrongSuite");
  });

  it("score recorded after the deadline fails", async () => {
    await fails(claim(B(LATE), verifiedPda, PAYOUT, cranker), "ScoreAfterDeadline");
  });

  it("score recorded before the bounty was created fails", async () => {
    await waitPastSlot(scoreSlot);
    await createBounty(sponsor, { nonce: AFTER_SCORE, minCorrect: 1, minTotal: 2, deadline: far });
    const b = await bounty.account.bounty.fetch(B(AFTER_SCORE));
    expect(b.createdSlot.toNumber()).to.be.greaterThan(scoreSlot);
    await fails(claim(B(AFTER_SCORE), verifiedPda, PAYOUT, cranker), "ScoreBeforeBounty");
  });

  it("a bounty that pins a different enclave compose hash or guest image fails", async () => {
    await fails(claim(B(PINNED), verifiedPda, PAYOUT, cranker), "WrongEnclave");
    await fails(claim(B(PINNED_IMAGE), verifiedPda, PAYOUT, cranker), "WrongEnclave");
  });

  it("rejects a forged 6/6 score at the right PDA address but not owned by the registry", async () => {
    await fails(claim(B(OPEN), forged("not-registry"), PAYOUT, cranker), "ScoreNotFromRegistry");
  });

  it("rejects a registry-owned 6/6 score that is not at its [verified, statement_hash] PDA (genesis-forged)", async () => {
    await fails(claim(B(OPEN), forged("wrong-pda"), PAYOUT, cranker), "BadScorePda");
  });

  it("rejects an unverified registry ScoreRecord (record_score, 6/6) and non-registry accounts", async () => {
    const stmt = crypto.randomBytes(32);
    const rec = rpda(Buffer.from("score"), stmt);
    await registry.methods.recordScore(Array.from(stmt), Array.from(MODEL), Array.from(SUITE), Array.from(crypto.randomBytes(32)),
      Array.from(good.journal.subarray(128, 176)), 6, 6, 1).accountsPartial({ score: rec, suite: null }).rpc();
    await fails(claim(B(OPEN), rec, PAYOUT, cranker), "NotAVerifiedScore");
    await fails(claim(B(OPEN), regSuite, PAYOUT, cranker), "NotAVerifiedScore");
    await fails(claim(B(OPEN), regConfig, PAYOUT, cranker), "NotAVerifiedScore");
    await fails(claim(B(OPEN), cranker.publicKey, PAYOUT, cranker), "ScoreNotFromRegistry");
  });

  it("refund: not before deadline + grace, not by another signer, and not once paid", async () => {
    await fails(bounty.methods.refund().accountsPartial({ bounty: B(OPEN), sponsor: sponsor.publicKey }).signers([sponsor]).rpc(), "RefundTooEarly");
    // past the deadline but inside the claim grace window: still too early
    const g = await bounty.account.bounty.fetch(B(GRACE));
    expect(await slot()).to.be.greaterThan(g.deadlineSlot.toNumber());
    await fails(bounty.methods.refund().accountsPartial({ bounty: B(GRACE), sponsor: sponsor.publicKey }).signers([sponsor]).rpc(), "RefundTooEarly");
    await fails(bounty.methods.refund().accountsPartial({ bounty: B(REFUND), sponsor: stranger.publicKey }).signers([stranger]).rpc(), "NotSponsor");
    await fails(bounty.methods.refund().accountsPartial({ bounty: B(HAPPY), sponsor: sponsor.publicKey }).signers([sponsor]).rpc(), "AlreadyPaid");
  });

  it("refund after deadline + grace returns escrow and rent to the sponsor and closes the bounty", async () => {
    const b = await bounty.account.bounty.fetch(B(REFUND));
    expect(await slot()).to.be.greaterThan(b.deadlineSlot.toNumber() + b.claimGraceSlots.toNumber());
    const held = await conn.getBalance(B(REFUND));
    const before = await conn.getBalance(sponsor.publicKey);
    const sig = await bounty.methods.refund().accountsPartial({ bounty: B(REFUND), sponsor: sponsor.publicKey }).signers([sponsor]).rpc();
    expect((await conn.getBalance(sponsor.publicKey)) - before).to.equal(held); // fee is paid by the provider wallet
    expect(await conn.getAccountInfo(B(REFUND))).to.equal(null);
    const ev = await events(sig);
    expect(ev.map((e) => e.name)).to.deep.equal(["bountyRefunded"]);
    expect(ev[0].data.amount.toNumber()).to.equal(SOL);
    await fails(claim(B(REFUND), verifiedPda, PAYOUT, cranker), "AccountNotInitialized");
  });
});
