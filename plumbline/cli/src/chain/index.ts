// The one module that knows the onchain layout (program ids, account fields, instruction shapes).
// Everything else (CLI commands, relayer) talks to the chain through `PlumblineChain` and the plain
// view types below, so a change to the programs touches only this folder (and app/js/layout.js, which a test pins to the IDL).
import anchorPkg from "@coral-xyz/anchor"; // CJS package: take everything off the default export
import type * as A from "@coral-xyz/anchor";
const anchor = anchorPkg as unknown as typeof A;
const BN = anchor.BN;
import {
  ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram,
} from "@solana/web3.js";
import bs58 from "bs58";
import { loadIdls, type IdlSet } from "./idl.js";
import { parseJournal, type Proof } from "./journal.js";

export { parseJournal, parseProof, JOURNAL_LEN } from "./journal.js";
export type { Journal, Proof } from "./journal.js";
export { loadIdls } from "./idl.js";
export { PublicKey, Keypair, Connection, LAMPORTS_PER_SOL };

const ZERO32 = Buffer.alloc(32);
const hex = (a: ArrayLike<number>) => Buffer.from(a as any).toString("hex");
const num = (v: any) => (BN.isBN(v) ? BigInt(v.toString()) : BigInt(v));

export type BountyView = {
  address: string; sponsor: string; nonce: bigint; suiteCommitment: string; minCorrect: number; minTotal: number;
  amount: bigint; mint: string | null; deadlineSlot: bigint; claimGraceSlots: bigint; requireRegisteredSuite: boolean;
  requiredComposeHash: string; requiredImageId: string; createdSlot: bigint; status: "open" | "paid";
  winnerStatementHash: string; winnerModelIdHash: string; winnerPayout: string; paidSlot: bigint; lamports?: number;
};

export type ScoreView = {
  address: string; statementHash: string; modelIdHash: string; suiteCommitment: string; quoteHash: string;
  mrTd: string; composeHash: string; imageId: string; correct: number; total: number; bindingVersion: number;
  suiteRegistered: boolean; submitter: string; slot: bigint; unixTimestamp: bigint; payout: string;
};

export type CreateBountyArgs = {
  nonce: bigint; suiteCommitment: Buffer; minCorrect: number; minTotal: number; lamports: bigint;
  deadlineSlot: bigint; claimGraceSlots: bigint; requireRegisteredSuite: boolean;
  requiredComposeHash?: Buffer; requiredImageId?: Buffer;
};

/** correct/total >= minCorrect/minTotal, cross-multiplied like the program; and total >= minTotal. */
export function meetsTarget(correct: number, total: number, minCorrect: number, minTotal: number): boolean {
  return total >= minTotal && BigInt(correct) * BigInt(minTotal) >= BigInt(minCorrect) * BigInt(total);
}

/** The program's claim checks, in its order, evaluated off chain so nobody sends a doomed claim. */
export function claimable(b: BountyView, s: ScoreView): { ok: true } | { ok: false; reason: string } {
  const no = (reason: string) => ({ ok: false as const, reason });
  if (b.status !== "open") return no("AlreadyPaid");
  if (b.suiteCommitment !== s.suiteCommitment) return no("WrongSuite");
  if (b.requiredComposeHash !== hex(ZERO32) && b.requiredComposeHash !== s.composeHash) return no("WrongEnclave");
  if (b.requiredImageId !== hex(ZERO32) && b.requiredImageId !== s.imageId) return no("WrongEnclave");
  if (!meetsTarget(s.correct, s.total, b.minCorrect, b.minTotal)) return no("BelowTarget");
  if (s.slot > b.deadlineSlot) return no("ScoreAfterDeadline");
  if (s.slot < b.createdSlot) return no("ScoreBeforeBounty");
  if (s.payout === PublicKey.default.toBase58()) return no("NoPayout");
  return { ok: true };
}

export function bountyView(address: PublicKey, a: any, lamports?: number): BountyView {
  return {
    address: address.toBase58(), sponsor: a.sponsor.toBase58(), nonce: num(a.nonce), suiteCommitment: hex(a.suiteCommitment),
    minCorrect: a.minCorrect, minTotal: a.minTotal, amount: num(a.amount), mint: a.mint ? a.mint.toBase58() : null,
    deadlineSlot: num(a.deadlineSlot), claimGraceSlots: num(a.claimGraceSlots), requireRegisteredSuite: a.requireRegisteredSuite,
    requiredComposeHash: hex(a.requiredComposeHash), requiredImageId: hex(a.requiredImageId), createdSlot: num(a.createdSlot),
    status: a.status === 0 ? "open" : "paid", winnerStatementHash: hex(a.winnerStatementHash),
    winnerModelIdHash: hex(a.winnerModelIdHash), winnerPayout: a.winnerPayout.toBase58(), paidSlot: num(a.paidSlot), lamports,
  };
}

export function scoreView(address: PublicKey, a: any): ScoreView {
  return {
    address: address.toBase58(), statementHash: hex(a.statementHash), modelIdHash: hex(a.modelIdHash),
    suiteCommitment: hex(a.suiteCommitment), quoteHash: hex(a.quoteHash), mrTd: hex(a.mrTd), composeHash: hex(a.composeHash),
    imageId: hex(a.imageId), correct: a.correct, total: a.total, bindingVersion: a.bindingVersion,
    suiteRegistered: a.suiteRegistered, submitter: a.submitter.toBase58(), slot: num(a.slot),
    unixTimestamp: num(a.unixTimestamp), payout: (a.payout ?? PublicKey.default).toBase58(),
  };
}

const u64le = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const asBytes32 = (h: string | Buffer, what: string) => {
  const b = typeof h === "string" ? Buffer.from(h.replace(/^0x/, ""), "hex") : h;
  if (b.length !== 32) throw new Error(`${what} must be 32 bytes (64 hex chars)`);
  return b;
};

export class PlumblineChain {
  readonly idls: IdlSet;
  readonly registry: A.Program<any>;
  readonly bounty: A.Program<any>;
  readonly provider: A.AnchorProvider;

  constructor(readonly conn: Connection, readonly payer: Keypair = Keypair.generate(), idls: IdlSet = loadIdls()) {
    this.idls = idls;
    if (process.env.PLUMBLINE_REGISTRY_ID) idls.registry.address = process.env.PLUMBLINE_REGISTRY_ID;
    if (process.env.PLUMBLINE_BOUNTY_ID) idls.bounty.address = process.env.PLUMBLINE_BOUNTY_ID;
    this.provider = new anchor.AnchorProvider(conn, new anchor.Wallet(payer), { commitment: "confirmed" });
    this.registry = new anchor.Program(idls.registry, this.provider);
    this.bounty = new anchor.Program(idls.bounty, this.provider);
  }

  get registryId() { return this.registry.programId; }
  get bountyId() { return this.bounty.programId; }

  // ---- PDAs ----
  configPda() { return PublicKey.findProgramAddressSync([Buffer.from("config")], this.registryId)[0]; }
  suitePda(c: Buffer) { return PublicKey.findProgramAddressSync([Buffer.from("suite"), c], this.registryId)[0]; }
  verifiedPda(statementHash: Buffer) {
    return PublicKey.findProgramAddressSync([Buffer.from("verified"), statementHash], this.registryId)[0];
  }
  bountyPda(sponsor: PublicKey, suite: Buffer, nonce: bigint) {
    return PublicKey.findProgramAddressSync([Buffer.from("bounty"), sponsor.toBuffer(), suite, u64le(nonce)], this.bountyId)[0];
  }

  slot() { return this.conn.getSlot("confirmed"); }

  // ---- reads ----
  async fetchBounty(addr: PublicKey | string): Promise<BountyView | null> {
    const pk = new PublicKey(addr);
    const info = await this.conn.getAccountInfo(pk, "confirmed");
    if (!info || !info.owner.equals(this.bountyId)) return null;
    return bountyView(pk, this.bounty.coder.accounts.decode("bounty", info.data), info.lamports);
  }

  async listBounties(opts: { suite?: string | Buffer; openOnly?: boolean } = {}): Promise<BountyView[]> {
    const filters: any[] = [];
    if (opts.suite) filters.push({ memcmp: { offset: 8 + 32 + 8, bytes: bs58.encode(asBytes32(opts.suite, "suite")) } });
    const rows = await (this.bounty.account as any).bounty.all(filters);
    const out = rows.map((r: any) => bountyView(r.publicKey, r.account));
    return opts.openOnly ? out.filter((b: BountyView) => b.status === "open") : out;
  }

  async fetchScore(addr: PublicKey | string): Promise<ScoreView | null> {
    const pk = new PublicKey(addr);
    const info = await this.conn.getAccountInfo(pk, "confirmed");
    if (!info || !info.owner.equals(this.registryId)) return null;
    return scoreView(pk, this.registry.coder.accounts.decode("verifiedScore", info.data));
  }

  scoreByStatement(statementHash: string | Buffer) {
    return this.fetchScore(this.verifiedPda(asBytes32(statementHash, "statement hash")));
  }

  async listScores(suite?: string | Buffer): Promise<ScoreView[]> {
    const filters: any[] = [];
    if (suite) filters.push({ memcmp: { offset: 8 + 64, bytes: bs58.encode(asBytes32(suite, "suite")) } });
    const rows = await (this.registry.account as any).verifiedScore.all(filters);
    return rows.map((r: any) => scoreView(r.publicKey, r.account));
  }

  async suiteRegistered(c: Buffer) { return (await this.conn.getAccountInfo(this.suitePda(c), "confirmed")) !== null; }

  async fetchConfig() {
    const c: any = await (this.registry.account as any).config.fetchNullable(this.configPda());
    if (!c) return null;
    return { admin: c.admin.toBase58(), imageId: hex(c.imageId), root: hex(c.rootSha256), compose: hex(c.composeHash), mrTd: hex(c.mrTd) };
  }

  // ---- writes (signed by `payer`) ----
  async createBounty(a: CreateBountyArgs) {
    const suiteAcct = a.requireRegisteredSuite ? this.suitePda(a.suiteCommitment) : null;
    const bounty = this.bountyPda(this.payer.publicKey, a.suiteCommitment, a.nonce);
    const signature = await this.bounty.methods
      .createBounty(new BN(a.nonce.toString()), Array.from(a.suiteCommitment), a.minCorrect, a.minTotal,
        new BN(a.lamports.toString()), new BN(a.deadlineSlot.toString()), new BN(a.claimGraceSlots.toString()), null,
        a.requireRegisteredSuite, Array.from(a.requiredComposeHash ?? ZERO32), Array.from(a.requiredImageId ?? ZERO32))
      .accountsPartial({ bounty, sponsor: this.payer.publicKey, suite: suiteAcct, systemProgram: SystemProgram.programId })
      .rpc();
    return { signature, bounty: bounty.toBase58() };
  }

  async refund(bounty: PublicKey | string) {
    const signature = await this.bounty.methods.refund()
      .accountsPartial({ bounty: new PublicKey(bounty), sponsor: this.payer.publicKey }).rpc();
    return { signature };
  }

  async registerSuite(c: Buffer, priceLamports = 0n) {
    const suite = this.suitePda(c);
    const signature = await this.registry.methods.registerSuite(Array.from(c), new BN(priceLamports.toString()), null)
      .accountsPartial({ suite, author: this.payer.publicKey }).rpc();
    return { signature, suite: suite.toBase58() };
  }

  /** record_verified_score; passes the Suite PDA when that suite is registered. */
  async recordVerifiedScore(p: Proof) {
    const j = parseJournal(p.journal);
    const score = this.verifiedPda(j.statementHash);
    const suite = (await this.suiteRegistered(j.suiteCommitment)) ? this.suitePda(j.suiteCommitment) : null;
    const signature = await this.registry.methods.recordVerifiedScore(Array.from(j.statementHash), p.seal, p.journal)
      .accountsPartial({ score, config: this.configPda(), suite, submitter: this.payer.publicKey })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
      .rpc();
    return { signature, score: score.toBase58() };
  }

  /** claim: the payout account is read from the VerifiedScore; the caller cannot pick it. */
  async claim(bounty: PublicKey | string, score: PublicKey | string) {
    const s = await this.fetchScore(score);
    if (!s) throw new Error(`no VerifiedScore at ${score}`);
    const signature = await this.bounty.methods.claim()
      .accountsPartial({ bounty: new PublicKey(bounty), verifiedScore: new PublicKey(score), payout: new PublicKey(s.payout),
        cranker: this.payer.publicKey })
      .rpc();
    return { signature, payout: s.payout };
  }
}

/** Human-readable reason from an Anchor/RPC error. */
export function errorText(e: any): string {
  const code = e?.error?.errorCode?.code;
  if (code) return `${code}: ${e.error.errorMessage}`;
  const logs: string[] = e?.logs ?? e?.transactionLogs ?? [];
  const m = logs.find((l) => /Error Code|failed/.test(l));
  return m ? `${String(e?.message ?? e)} | ${m}` : String(e?.message ?? e);
}
