import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { toSubmission, type ReclaimProof } from "./claim.js";
import {
  DEFAULT_PROGRAM_ID,
  OracleInstructions,
  WRITE_CHUNK,
  decodeBook,
  type BookState,
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

  async send(...ixs: TransactionInstruction[]): Promise<string> {
    return sendAndConfirmTransaction(this.connection, new Transaction().add(...ixs), [this.payer], { commitment: "confirmed" });
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
   * Uploads the claim into this payer's buffer and submits it. The program closes the buffer on
   * success; on failure we close it so the next submission can reopen it.
   */
  async submitProof(proof: ReclaimProof, source: SourceArgs): Promise<SubmitResult> {
    const me = this.payer.publicKey;
    const s = toSubmission(proof, source.requiresNullifier);
    const receipt = this.ix.pdas.receipt(this.ix.pdas.source(source.sourceId), s.receiptKey);
    if (await this.exists(receipt)) throw new AlreadySubmittedError(receipt);
    if (await this.exists(this.ix.pdas.buffer(me))) await this.send(this.ix.closeBuffer(me));
    await this.send(this.ix.openBuffer(me, s.provider.length, s.parameters.length, s.context.length));
    try {
      const data = Buffer.concat([s.provider, s.parameters, s.context]);
      for (let off = 0; off < data.length; off += WRITE_CHUNK) {
        await this.send(this.ix.writeBuffer(me, off, data.subarray(off, off + WRITE_CHUNK)));
      }
      const signature = await this.send(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        this.ix.submitObservation(me, source, s.sig, s.receiptKey),
      );
      return { signature, computeUnits: await this.computeUnits(signature) };
    } catch (err) {
      if (await this.exists(this.ix.pdas.buffer(me))) await this.send(this.ix.closeBuffer(me)).catch(() => undefined);
      throw err;
    }
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

/** The receipt for this invoice (or list-price proof) already exists onchain. */
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
