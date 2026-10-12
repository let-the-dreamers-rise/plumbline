import { groupNames, type SourceSpec } from "@pct/prover";
import { getBytes, keccak256, toUtf8Bytes } from "ethers";
import {
  KIND_IDS,
  SKU_IDS,
  VALUE_MODE_AMOUNT_HOURS,
  VALUE_MODE_RATE,
  revenueItemKey,
  revenueReceiptKey,
  type ClaimSig,
  type SourceArgs,
} from "./program.js";

/** The fields of a Reclaim proof (zkFetch output) the oracle program needs. */
export interface ReclaimProof {
  readonly identifier: string;
  readonly claimData: {
    readonly provider: string;
    readonly parameters: string;
    readonly context: string;
    readonly owner: string;
    readonly timestampS: number;
    readonly epoch: number;
  };
  readonly signatures: readonly string[];
  readonly witnesses?: readonly { readonly id: string }[];
}

/** Stable onchain provider ids; unknown providers get a hash-derived id above 1000. */
export const PROVIDER_IDS: Readonly<Record<string, number>> = {
  lambda: 1,
  runpod: 2,
  vast: 3,
  sfcompute: 4,
  azure: 5,
  aws: 6,
  gcp: 7,
  coreweave: 8,
  nebius: 9,
  together: 10,
  stripe: 11,
  razorpay: 12,
};

export function providerId(provider: string): number {
  const known = PROVIDER_IDS[provider.toLowerCase()];
  if (known !== undefined) return known;
  const h = keccakBytes(provider.toLowerCase());
  return 1000 + (((h[0]! << 8) | h[1]!) % 64_000);
}

export const keccakBytes = (data: Uint8Array | string): Uint8Array =>
  getBytes(keccak256(typeof data === "string" ? toUtf8Bytes(data) : data));

export function sourceIdFor(spec: Pick<SourceSpec, "id">): Uint8Array {
  return keccakBytes(spec.id);
}

/** Registration args for a spec. `parameters` is the exact claim parameters string a proof of it carries. */
export function sourceArgsFor(spec: SourceSpec, parameters: string): SourceArgs {
  return {
    sourceId: sourceIdFor(spec),
    paramsHash: keccakBytes(parameters),
    providerId: providerId(spec.provider),
    sku: SKU_IDS[spec.sku],
    kind: KIND_IDS[spec.kind],
    gpuCount: spec.gpuCount,
    valueMode: groupNames(spec.matches).has("rate") ? VALUE_MODE_RATE : VALUE_MODE_AMOUNT_HOURS,
    requiresNullifier: spec.nullifierRule !== undefined,
  };
}

export interface Submission {
  /** provider | parameters | context, in the order the program's buffer expects. */
  provider: Uint8Array;
  parameters: Uint8Array;
  context: Uint8Array;
  sig: ClaimSig;
  receiptKey: Uint8Array;
}

function signatureBytes(proof: ReclaimProof): Uint8Array {
  const sig = proof.signatures[0];
  if (!sig) throw new Error("proof has no attestor signature");
  const bytes = getBytes(sig);
  if (bytes.length !== 65) throw new Error(`attestor signature must be 65 bytes, got ${bytes.length}`);
  return bytes;
}

/** Same rule as expected_receipt_key in submit.rs: hashed nullifier for paid sources, else claim id + time. */
export function receiptKey(proof: ReclaimProof, requiresNullifier: boolean): Uint8Array {
  if (requiresNullifier) {
    const ctx = JSON.parse(proof.claimData.context) as { extractedParameters?: Record<string, string> };
    const account = ctx.extractedParameters?.account;
    if (!account) throw new Error("paid proof has no account nullifier in its context");
    return keccakBytes(account);
  }
  const ts = new Uint8Array(4);
  new DataView(ts.buffer).setUint32(0, proof.claimData.timestampS, true);
  return keccakBytes(new Uint8Array([...getBytes(proof.identifier), ...ts]));
}

/** A loan's operator key: keccak of the account id its revenue proofs reveal (OPRF-hashed in production). */
export const operatorKey = (accountId: string): Uint8Array => keccakBytes(accountId);

export function extractedOf(proof: ReclaimProof): Record<string, string> {
  const ctx = JSON.parse(proof.claimData.context) as { extractedParameters?: Record<string, string> };
  return ctx.extractedParameters ?? {};
}

/** The operator a revenue proof is for: its extracted account, else the claim owner (see lending.rs). */
export function accountOf(proof: ReclaimProof): string {
  return extractedOf(proof).account ?? proof.claimData.owner.toLowerCase();
}

/** The loan period a revenue proof counts toward: its extracted `at` when present, else proof time. */
export function revenuePeriod(proof: ReclaimProof, periodS: number): number {
  const at = extractedOf(proof).at;
  return Math.floor((at !== undefined ? Number(at) : proof.claimData.timestampS) / periodS);
}

/** Same rule as handle_submit_revenue: one receipt per payout `item`, else one per loan period. */
export function revenueReceiptKeyFor(proof: ReclaimProof, opKey: Uint8Array, periodS: number): Uint8Array {
  const item = extractedOf(proof).item;
  return item !== undefined ? revenueItemKey(opKey, item) : revenueReceiptKey(opKey, revenuePeriod(proof, periodS));
}

export function toSubmission(proof: ReclaimProof, requiresNullifier: boolean): Submission {
  const c = proof.claimData;
  return {
    provider: toUtf8Bytes(c.provider),
    parameters: toUtf8Bytes(c.parameters),
    context: toUtf8Bytes(c.context),
    sig: { owner: c.owner.toLowerCase(), timestampS: c.timestampS, epoch: c.epoch, signature: signatureBytes(proof) },
    receiptKey: receiptKey(proof, requiresNullifier),
  };
}

/** Attestor addresses (20 bytes) that signed the given proofs, deduplicated. */
export function attestorsOf(proofs: readonly ReclaimProof[]): Uint8Array[] {
  const ids = new Set(proofs.flatMap((p) => (p.witnesses ?? []).map((w) => w.id.toLowerCase())));
  return [...ids].map((id) => getBytes(id));
}
