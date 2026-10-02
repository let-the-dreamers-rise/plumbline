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
