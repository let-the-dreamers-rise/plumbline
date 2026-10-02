import { PublicKey } from "@solana/web3.js";
import { Reader, discriminator } from "@pct/oracle";

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
export function parseObservations(logs: readonly string[]): ObservationAccepted[] {
  const out: ObservationAccepted[] = [];
  for (const line of logs) {
    if (!line.startsWith("Program data: ")) continue;
    const data = Buffer.from(line.slice("Program data: ".length), "base64");
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

function events(logs: readonly string[], disc: string): Reader[] {
  return logs
    .filter((l) => l.startsWith("Program data: "))
    .map((l) => Buffer.from(l.slice("Program data: ".length), "base64"))
    .filter((d) => d.subarray(0, 8).toString("hex") === disc)
    .map((d) => new Reader(d.subarray(8)));
}

export function parseRevenueProven(logs: readonly string[]): RevenueProven[] {
  return events(logs, REVENUE_DISC).map((r) => ({
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

export function parseDrawApproved(logs: readonly string[]): DrawApproved[] {
  return events(logs, DRAW_DISC).map((r) => ({
    loan: new PublicKey(r.take(32)).toBase58(),
    lamports: Number(r.u64()),
    coverageBps: Number(r.u64()),
  }));
}
