import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { revenueReceiptKeyFor, toSubmission, type ReclaimProof, type Submission } from "./claim.js";
import {
  DEFAULT_PROGRAM_ID,
  OracleInstructions,
  WRITE_CHUNK,
  decodeBook,
  decodeConfig,
  decodeLoan,
  type BookState,
  type ConfigState,
  type LoanState,
  type LoanTerms,
  type IndexParams,
  type SourceArgs,
} from "./program.js";

export interface SubmitResult {
  signature: string;
  computeUnits: number | null;
}

/** Thin RPC wrapper that sends pct_oracle transactions signed by one keypair. */
export class OracleClient {
  readonly ix: OracleInstructions;

  constructor(
    readonly connection: Connection,
    readonly payer: Keypair,
    programId: PublicKey = DEFAULT_PROGRAM_ID,
  ) {
    this.ix = new OracleInstructions(programId);
  }

  /**
   * Sends and confirms. Buffer writes repeat byte for byte across proofs (same provider and
   * parameters), so a write can be identical to an earlier one under the same blockhash; the
   * cluster then drops it as already processed although it never touched the current buffer.
   * Retry those on a fresh blockhash.
   */
  async send(...ixs: TransactionInstruction[]): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await sendAndConfirmTransaction(this.connection, new Transaction().add(...ixs), [this.payer], { commitment: "confirmed" });
      } catch (err) {
        if (attempt >= 4 || !String((err as Error).message).includes("already been processed")) throw err;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  async exists(address: PublicKey): Promise<boolean> {
    return (await this.connection.getAccountInfo(address, "confirmed")) !== null;
  }

  /** Creates the config if missing, else updates attestors and params. */
  async upsertConfig(attestors: Uint8Array[], params: IndexParams): Promise<string> {
    const me = this.payer.publicKey;
    if (await this.exists(this.ix.pdas.config())) return this.send(this.ix.updateConfig(me, attestors, params));
    return this.send(this.ix.initializeConfig(me, attestors, params));
  }

  async ensureBook(sku: number, kind: number): Promise<string | null> {
    if (await this.exists(this.ix.pdas.book(sku, kind))) return null;
    return this.send(this.ix.initBook(this.payer.publicKey, sku, kind));
  }

  /** Registers a source; returns null when one with this id already exists (sources are immutable). */
  async ensureSource(args: SourceArgs): Promise<string | null> {
    if (await this.exists(this.ix.pdas.source(args.sourceId))) return null;
    return this.send(this.ix.registerSource(this.payer.publicKey, args));
  }

  /**
   * Uploads the claim into this payer's buffer and runs `submit`. The program closes the buffer on
   * success; on failure we close it so the next submission can reopen it.
   */
  private async uploadAndSubmit(s: Submission, receipt: PublicKey, submit: TransactionInstruction): Promise<SubmitResult> {
    const me = this.payer.publicKey;
    if (await this.exists(receipt)) throw new AlreadySubmittedError(receipt);
    if (await this.exists(this.ix.pdas.buffer(me))) await this.send(this.ix.closeBuffer(me));
    await this.send(this.ix.openBuffer(me, s.provider.length, s.parameters.length, s.context.length));
    try {
      const data = Buffer.concat([s.provider, s.parameters, s.context]);
      for (let off = 0; off < data.length; off += WRITE_CHUNK) {
        await this.send(this.ix.writeBuffer(me, off, data.subarray(off, off + WRITE_CHUNK)));
      }
      const signature = await this.send(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), submit);
      return { signature, computeUnits: await this.computeUnits(signature) };
    } catch (err) {
      if (await this.exists(this.ix.pdas.buffer(me))) await this.send(this.ix.closeBuffer(me)).catch(() => undefined);
      throw err;
    }
  }

  async submitProof(proof: ReclaimProof, source: SourceArgs): Promise<SubmitResult> {
    const s = toSubmission(proof, source.requiresNullifier);
    const receipt = this.ix.pdas.receipt(source.providerId, source.kind, s.receiptKey);
    return this.uploadAndSubmit(s, receipt, this.ix.submitObservation(this.payer.publicKey, source, s.sig, s.receiptKey));
  }

  /** Opens a loan with this payer as lender, and funds it when `lamports` > 0. Skips the open if it exists. */
  async openLoan(terms: LoanTerms, lamports: bigint = 0n): Promise<string | null> {
    const me = this.payer.publicKey;
    const ixs: TransactionInstruction[] = [];
    if (!(await this.exists(this.ix.pdas.loan(me, terms.operatorKey)))) ixs.push(this.ix.openLoan(me, terms));
    if (lamports > 0n) ixs.push(this.ix.fundLoan(me, terms.operatorKey, lamports));
    return ixs.length > 0 ? this.send(...ixs) : null;
  }

  /** Submits an operator revenue proof against `lender`'s loan for `operatorKey` (default lender: this payer). */
  async submitRevenue(
    proof: ReclaimProof,
    source: { sourceId: Uint8Array; providerId: number },
    operatorKey: Uint8Array,
    lender: PublicKey = this.payer.publicKey,
  ): Promise<SubmitResult> {
    const loan = await this.loan(operatorKey, lender);
    if (!loan) throw new Error("no loan for this operator");
    const s = toSubmission(proof, false);
    const receiptKey = revenueReceiptKeyFor(proof, operatorKey, loan.periodS);
    const receipt = this.ix.pdas.revenueReceipt(source.providerId, this.ix.pdas.loan(lender, operatorKey), receiptKey);
    return this.uploadAndSubmit(s, receipt, this.ix.submitRevenue(this.payer.publicKey, source, loan, s.sig, receiptKey));
  }

  /** The borrower draws from the loan; the program refuses unless the covenant holds. */
  async draw(borrower: Keypair, operatorKey: Uint8Array, lamports: bigint, lender: PublicKey = this.payer.publicKey): Promise<SubmitResult> {
    const tx = new Transaction().add(this.ix.draw(borrower.publicKey, { lender, operatorKey }, lamports));
    const signature = await sendAndConfirmTransaction(this.connection, tx, [borrower], { commitment: "confirmed" });
    return { signature, computeUnits: await this.computeUnits(signature) };
  }

  /** The lender (this payer) takes undrawn funds back. */
  async withdraw(operatorKey: Uint8Array, lamports: bigint): Promise<string> {
    return this.send(this.ix.withdraw(this.payer.publicKey, operatorKey, lamports));
  }

  async config(): Promise<ConfigState | null> {
    const info = await this.connection.getAccountInfo(this.ix.pdas.config(), "confirmed");
    return info ? decodeConfig(info.data) : null;
  }

  async loan(operatorKey: Uint8Array, lender: PublicKey = this.payer.publicKey): Promise<LoanState | null> {
    const info = await this.connection.getAccountInfo(this.ix.pdas.loan(lender, operatorKey), "confirmed");
    return info ? decodeLoan(info.data) : null;
  }

  async crank(sku: number, kind: number): Promise<SubmitResult> {
    const signature = await this.send(this.ix.crankIndex(sku, kind));
    return { signature, computeUnits: await this.computeUnits(signature) };
  }

  async book(sku: number, kind: number): Promise<BookState | null> {
    const info = await this.connection.getAccountInfo(this.ix.pdas.book(sku, kind), "confirmed");
    return info ? decodeBook(info.data) : null;
  }

  private async computeUnits(signature: string): Promise<number | null> {
    const tx = await this.connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    return tx?.meta?.computeUnitsConsumed ?? null;
  }
}

/** The receipt for this invoice, list-price proof or revenue item/period already exists onchain. */
export class AlreadySubmittedError extends Error {
  constructor(readonly receipt: PublicKey) {
    super(`already submitted (receipt ${receipt.toBase58()} exists)`);
  }
}

/** Pulls the program's error log line out of a failed send, for readable CLI output. */
export function programError(err: unknown): string {
  const logs = (err as { logs?: string[]; transactionLogs?: string[] }).logs ?? (err as { transactionLogs?: string[] }).transactionLogs;
  const line = logs?.find((l) => l.includes("Error Code:") || l.includes("already in use"));
  return line ?? (err as Error).message;
}
