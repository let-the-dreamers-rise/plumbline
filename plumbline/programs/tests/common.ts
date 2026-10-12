// Shared setup: both programs, the real test-root Groth16 proofs from plumbline/zk/proofs, helpers.
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { ComputeBudgetProgram, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import * as fs from "fs";
import { PlumblineBounty } from "../target/types/plumbline_bounty";
import { PlumblineRegistry } from "../target/types/plumbline_registry";

export const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
export const conn = provider.connection;
export const bounty = anchor.workspace.plumblineBounty as Program<PlumblineBounty>;
export const registry = anchor.workspace.plumblineRegistry as Program<PlumblineRegistry>;
export const me = provider.wallet.publicKey;

export type Proof = { imageId: number[]; journal: Buffer; seal: Buffer };
export const loadProof = (name: string): Proof => {
  const j = JSON.parse(fs.readFileSync(`tests/fixtures/${name}-groth16.json`, "utf8"));
  const b = (h: string) => Buffer.from(h.slice(2), "hex");
  return { imageId: Array.from(b(j.imageId)), journal: b(j.journal), seal: b(j.seal) };
};

// Journal (330 bytes): statement_hash 0 | model_id_hash 32 | suite_commitment 64 | quote_hash 96 | mr_td 128 |
// rtmrs_hash 176 | tee_tcb_svn 208 | root_sha256 224 | correct 256 | total 260 | binding_version 264 |
// bound 265 | compose_hash 266 | payout 298
/** test-root guest, synthetic quote bound to statement-v1-payout.json (4/6, payout = PAYOUT). */
export const good = loadProof("synthetic-payout");
/** test-root guest, synthetic quote bound to statement-v1.json (4/6, no payout field => zero payout). */
export const nopay = loadProof("synthetic-nopayout");
export const J = good.journal;
export const STATEMENT = J.subarray(0, 32);
export const MODEL = J.subarray(32, 64);
export const SUITE = J.subarray(64, 96);
export const COMPOSE = Array.from(J.subarray(266, 298));
export const PAYOUT = new PublicKey(J.subarray(298, 330));
export const TEST_ROOT = Array.from(J.subarray(224, 256));
export const ANY_TD = new Array(48).fill(0);
export const ZERO32 = new Array(32).fill(0);

export const rpda = (...s: Buffer[]) => PublicKey.findProgramAddressSync(s, registry.programId)[0];
export const bpda = (...s: Buffer[]) => PublicKey.findProgramAddressSync(s, bounty.programId)[0];
export const regConfig = rpda(Buffer.from("config"));
export const regSuite = rpda(Buffer.from("suite"), SUITE);
export const verifiedOf = (p: Proof) => rpda(Buffer.from("verified"), p.journal.subarray(0, 32));
export const verifiedPda = verifiedOf(good);
export const bountyPda = (sponsor: PublicKey, suite: Buffer, nonce: number) => {
  const n = Buffer.alloc(8); n.writeBigUInt64LE(BigInt(nonce));
  return bpda(Buffer.from("bounty"), sponsor.toBuffer(), suite, n);
};

export async function fails(p: Promise<any>, needle: string) {
  try { await p; } catch (e: any) { expect(String(e) + JSON.stringify(e.logs ?? [])).to.contain(needle); return; }
  expect.fail(`expected failure containing ${needle}`);
}
export const slot = () => conn.getSlot("processed");
export async function waitPastSlot(s: number) {
  while ((await slot()) <= s + 1) await new Promise((r) => setTimeout(r, 200));
}
export async function funded(sol = 10) {
  const k = Keypair.generate();
  await conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, sol * LAMPORTS_PER_SOL), "confirmed");
  return k;
}
export async function events(sig: string) {
  let tx = null;
  for (let i = 0; i < 50 && !tx; i++) {
    tx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!tx) await new Promise((r) => setTimeout(r, 200));
  }
  const parser = new anchor.EventParser(bounty.programId, bounty.coder);
  return Array.from(parser.parseLogs(tx!.meta!.logMessages!));
}

/** Registry setup as verified.ts does it: config from the test-root proof, suite registered. */
export async function setupRegistry() {
  const programData = PublicKey.findProgramAddressSync([registry.programId.toBuffer()],
    new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"))[0];
  await registry.methods.initConfig(good.imageId, TEST_ROOT, COMPOSE, ANY_TD)
    .accountsPartial({ config: regConfig, admin: me, programData }).rpc();
  await registry.methods.registerSuite(Array.from(SUITE), new BN(0), null)
    .accountsPartial({ suite: regSuite, author: me }).rpc();
}

/** record_verified_score with a real Groth16 proof (4/6 on the fixture suite). */
export async function recordVerifiedScore(p: Proof = good) {
  await registry.methods.recordVerifiedScore(Array.from(p.journal.subarray(0, 32)), p.seal, p.journal)
    .accountsPartial({ score: verifiedOf(p), config: regConfig, suite: regSuite, submitter: me })
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
    .rpc();
  return registry.account.verifiedScore.fetch(verifiedOf(p));
}

export type Terms = {
  nonce: number; suite?: Buffer; minCorrect: number; minTotal: number; amount?: number; deadline: number;
  grace?: number; mint?: PublicKey | null; requireSuite?: boolean; suiteAcct?: PublicKey | null;
  compose?: number[]; image?: number[];
};
export function createBounty(sponsor: Keypair, t: Terms) {
  const suite = t.suite ?? SUITE;
  return bounty.methods.createBounty(new BN(t.nonce), Array.from(suite), t.minCorrect, t.minTotal,
    new BN(t.amount ?? LAMPORTS_PER_SOL), new BN(t.deadline), new BN(t.grace ?? 0), t.mint ?? null,
    t.requireSuite ?? false, t.compose ?? ZERO32, t.image ?? ZERO32)
    .accountsPartial({ bounty: bountyPda(sponsor.publicKey, suite, t.nonce), sponsor: sponsor.publicKey,
      suite: t.suiteAcct ?? null, systemProgram: SystemProgram.programId })
    .signers([sponsor]).rpc();
}
export function claim(b: PublicKey, score: PublicKey, payout: PublicKey, cranker: Keypair) {
  return bounty.methods.claim()
    .accountsPartial({ bounty: b, verifiedScore: score, payout, cranker: cranker.publicKey })
    .signers([cranker]).rpc();
}
