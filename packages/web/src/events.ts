import { PublicKey } from "@solana/web3.js";
import { DEFAULT_PROGRAM_ID, Reader, discriminator } from "@pct/oracle";

/**
 * The "Program data:" payloads logged while `programId` itself was executing. Any program can log
 * bytes that look like our events, so a line only counts when the innermost running program is ours.
 */
export function programData(logs: readonly string[], programId: string = DEFAULT_PROGRAM_ID.toBase58()): Buffer[] {
  const stack: string[] = [];
  const out: Buffer[] = [];
  for (const line of logs) {
    const invoke = /^Program (\w+) invoke \[\d+\]$/.exec(line);
    if (invoke) {
      stack.push(invoke[1]!);
      continue;
    }
    if (/^Program \w+ (success|failed)/.test(line)) {
      stack.pop();
      continue;
    }
    if (line.startsWith("Program data: ") && stack.at(-1) === programId) out.push(Buffer.from(line.slice("Program data: ".length), "base64"));
  }
  return out;
}

export interface ObservationAccepted {
  source: string;
  providerId: number;
  sku: number;
  kind: number;
  priceMicro: number;
  observedAt: number;
  /** Reclaim claim identifier: keccak(provider \n parameters \n context), the thing the attestor signed. */
  identifier: string;
}

const OBS_DISC = Buffer.from(discriminator("event", "ObservationAccepted")).toString("hex");

/** Decodes Anchor `emit!` events (logged as "Program data: <base64>") from one transaction's logs. */
export function parseObservations(logs: readonly string[], programId?: string): ObservationAccepted[] {
  const out: ObservationAccepted[] = [];
  for (const data of programData(logs, programId)) {
    if (data.subarray(0, 8).toString("hex") !== OBS_DISC) continue;
    const r = new Reader(data.subarray(8));
    out.push({
      source: new PublicKey(r.take(32)).toBase58(),
      providerId: r.u16(),
      sku: r.u8(),
      kind: r.u8(),
      priceMicro: Number(r.u64()),
      observedAt: Number(r.i64()),
      identifier: "0x" + Buffer.from(r.take(32)).toString("hex"),
    });
  }
  return out;
}

export interface RevenueProven {
  loan: string;
  source: string;
  providerId: number;
  period: number;
  revenueMicro: number;
  gpuHoursMicro: number;
  /** Realized rent per GPU-hour; 0 when the proof had no hours. */
  rentMicro: number;
  periodCoverageBps: number;
  trailingCoverageBps: number;
  observedAt: number;
  identifier: string;
}

export interface DrawApproved {
  loan: string;
  lamports: number;
  coverageBps: number;
}

const REVENUE_DISC = Buffer.from(discriminator("event", "RevenueProven")).toString("hex");
const DRAW_DISC = Buffer.from(discriminator("event", "DrawApproved")).toString("hex");

function events(logs: readonly string[], disc: string, programId?: string): Reader[] {
  return programData(logs, programId)
    .filter((d) => d.subarray(0, 8).toString("hex") === disc)
    .map((d) => new Reader(d.subarray(8)));
}

export function parseRevenueProven(logs: readonly string[], programId?: string): RevenueProven[] {
  return events(logs, REVENUE_DISC, programId).map((r) => ({
    loan: new PublicKey(r.take(32)).toBase58(),
    source: new PublicKey(r.take(32)).toBase58(),
    providerId: r.u16(),
    period: r.u32(),
    revenueMicro: Number(r.u64()),
    gpuHoursMicro: Number(r.u64()),
    rentMicro: Number(r.u64()),
    periodCoverageBps: Number(r.u64()),
    trailingCoverageBps: Number(r.u64()),
    observedAt: Number(r.i64()),
    identifier: "0x" + Buffer.from(r.take(32)).toString("hex"),
  }));
}

export function parseDrawApproved(logs: readonly string[], programId?: string): DrawApproved[] {
  return events(logs, DRAW_DISC, programId).map((r) => ({
    loan: new PublicKey(r.take(32)).toBase58(),
    lamports: Number(r.u64()),
    coverageBps: Number(r.u64()),
  }));
}
