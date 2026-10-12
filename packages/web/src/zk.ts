import { Connection, PublicKey } from "@solana/web3.js";
import { OraclePdas, Reader, discriminator } from "@pct/oracle";
import { programData } from "./events.js";

export type ZkStatus = "pass" | "watch" | "none";

/** The private covenant on one loan, as the verify page and badge show it. No revenue figures: coverage only. */
export interface ZkView {
  status: ZkStatus;
  coverageBps: number;
  asOfPeriod: number;
  claims: number;
  chipId: string;
  measurements: string;
  vmMeasurement: string;
  vmBound: boolean;
  challenge: string;
  provenAt: number;
  imageId: string | null;
  attestorThreshold: number | null;
  proofTx: string | null;
  /** Lamports the proving transaction paid into the treasury (0 when proofs are free). */
  feeLamports: number;
  /** "public": proven from the published NVIDIA sample report and VoltageGPU quote; "own": evidence made against this loan's challenge. */
  evidence: "public" | "own" | null;
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const COVENANT_DISC = hex(discriminator("account", "ZkCovenant"));
const CONFIG_DISC = hex(discriminator("account", "ZkConfig"));
const PROVEN_DISC = hex(discriminator("event", "CovenantProven"));
const PROVE_IX = hex(discriminator("global", "prove_covenant"));

/** The challenge a prove_covenant call answered: word 1 of its public values (seal vec, then public_values vec). */
export function provedChallenge(ixData: Uint8Array): string | null {
  if (hex(ixData.subarray(0, 8)) !== PROVE_IX) return null;
  const r = new Reader(ixData.subarray(8));
  r.take(r.u32());
  const pv = r.take(r.u32());
  return pv.length >= 64 ? hex(pv.subarray(32, 64)) : null;
}

/** Decodes a ZkCovenant account (layout of `ZkCovenant` in instructions/zk.rs). */
export function decodeZkCovenant(data: Uint8Array) {
  if (hex(data.subarray(0, 8)) !== COVENANT_DISC) throw new Error("not a ZkCovenant account");
  const r = new Reader(data.subarray(8));
  const loan = new PublicKey(r.take(32)).toBase58();
  const challenge = hex(r.take(32));
  const status = r.u8();
  return {
    loan,
    challenge,
    status: (status === 1 ? "pass" : status === 2 ? "watch" : "none") as ZkStatus,
    coverageBps: Number(r.u64()),
    asOfPeriod: r.u32(),
    claims: r.u32(),
    chipId: hex(r.take(32)),
    measurements: hex(r.take(32)),
    vmMeasurement: hex(r.take(32)),
    vmBound: r.u8() === 1,
    provenAt: Number(r.i64()),
  };
}

/** Decodes the ZkConfig account (layout of `ZkConfig` in instructions/zk.rs). */
export function decodeZkConfig(data: Uint8Array) {
  if (hex(data.subarray(0, 8)) !== CONFIG_DISC) throw new Error("not a ZkConfig account");
  const r = new Reader(data.subarray(8));
  const imageId = hex(r.take(32));
  const attestorThreshold = r.u8();
  const requireVmBound = r.u8() === 1;
  const vmMeasurement = hex(r.take(32));
  r.u8(); // bump
  return { imageId, attestorThreshold, requireVmBound, vmMeasurement, feeLamports: Number(r.u64()) };
}

/** `CovenantProven` events in one transaction's logs: the loan and the fee the proof paid. */
export function covenantProven(logs: readonly string[], programId?: string): { loan: string; feeLamports: number }[] {
  return programData(logs, programId)
    .filter((d) => hex(d.subarray(0, 8)) === PROVEN_DISC)
    .map((d) => {
      const r = new Reader(d.subarray(8));
      const loan = new PublicKey(r.take(32)).toBase58();
      r.take(1 + 8 + 4 + 4 + 32 + 32 + 1); // status, coverage, period, claims, chip id, vm measurement, vm bound
      return { loan, feeLamports: Number(r.u64()) };
    });
}

/**
 * The newest successful transaction on the covenant account that proved this loan, and the challenge
 * it answered (the program clears the stored challenge once a proof lands, so it is read from the proof).
 */
async function proofTx(connection: Connection, covenant: PublicKey, loan: string, programId: PublicKey): Promise<{ sig: string; challenge: string | null; feeLamports: number } | null> {
  const sigs = (await connection.getSignaturesForAddress(covenant, { limit: 20 }, "confirmed")).filter((s) => s.err === null);
  for (const s of sigs) {
    const tx = await connection.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const ev = tx && covenantProven(tx.meta?.logMessages ?? [], programId.toBase58()).find((e) => e.loan === loan);
    if (!tx || !ev) continue;
    const msg = tx.transaction.message;
    const keys = msg.staticAccountKeys;
    const ix = msg.compiledInstructions.find((i) => keys[i.programIdIndex]?.equals(programId) && provedChallenge(i.data) !== null);
    return { sig: s.signature, challenge: ix ? provedChallenge(ix.data) : null, feeLamports: ev.feeLamports };
  }
  return null;
}

const evidence = (): ZkView["evidence"] => {
  const e = process.env.PCT_EVIDENCE?.trim();
  return e === "public" || e === "own" ? e : null;
};

/** The zk block for a loan, or null when no challenge or proof exists for it yet. */
export async function loadZk(connection: Connection, programId: PublicKey, loan: PublicKey): Promise<ZkView | null> {
  const pdas = new OraclePdas(programId);
  const covenant = pdas.zkCovenant(loan);
  const [cov, cfg] = await connection.getMultipleAccountsInfo([covenant, pdas.zkConfig()], "confirmed");
  if (!cov) return null;
  const z = decodeZkCovenant(cov.data);
  const c = cfg ? decodeZkConfig(cfg.data) : null;
  const proof = z.status === "none" ? null : await proofTx(connection, covenant, loan.toBase58(), programId);
  const cleared = /^0+$/.test(z.challenge);
  return {
    status: z.status,
    coverageBps: z.coverageBps,
    asOfPeriod: z.asOfPeriod,
    claims: z.claims,
    chipId: z.chipId,
    measurements: z.measurements,
    vmMeasurement: z.vmMeasurement,
    vmBound: z.vmBound,
    challenge: cleared && proof?.challenge ? proof.challenge : z.challenge,
    provenAt: z.provenAt,
    imageId: c?.imageId ?? null,
    attestorThreshold: c?.attestorThreshold ?? null,
    proofTx: proof?.sig ?? null,
    feeLamports: proof?.feeLamports ?? 0,
    evidence: z.status === "none" ? null : evidence(),
  };
}

/**
 * Shields-style "GPU VERIFIED | PASS 1.15x · wk 2961" badge. With PCT_EVIDENCE=public the proofs use
 * NVIDIA's published sample report, so the left side reads "SAMPLE GPU" instead.
 */
export function badge(status: ZkStatus, coverageBps: number, asOf: number, sample = evidence() === "public"): string {
  const label = status === "pass" ? `PASS ${(coverageBps / 10000).toFixed(2)}x` : status === "watch" ? `WATCH ${(coverageBps / 10000).toFixed(2)}x` : "UNPROVEN";
  const color = status === "pass" ? "#24733f" : status === "watch" ? "#8a6500" : "#63666b";
  const right = status === "none" ? label : `${label} · wk ${asOf}`;
  const left = sample ? "SAMPLE GPU" : "GPU VERIFIED";
  const w1 = Math.round(26 + left.length * 7.2),
    w2 = Math.round(14 + right.length * 7.2);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w1 + w2}" height="22" role="img" aria-label="${sample ? "Sample GPU evidence" : "GPU verified"}: ${right}">
<rect width="${w1}" height="22" fill="#1b1d20"/><rect x="${w1}" width="${w2}" height="22" fill="${color}"/>
<g fill="#fff" font-family="ui-monospace,Menlo,Consolas,monospace" font-size="11" font-weight="600">
<text x="8" y="15">${left}</text><text x="${w1 + 7}" y="15">${right}</text></g></svg>`;
}
