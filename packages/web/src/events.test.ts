import { describe, expect, it } from "vitest";
import { discriminator, Writer } from "@pct/oracle";
import { Keypair } from "@solana/web3.js";
import { parseObservations } from "./events.js";

describe("parseObservations", () => {
  it("decodes ObservationAccepted from Anchor's Program data log and ignores everything else", () => {
    const source = Keypair.generate().publicKey;
    const identifier = new Uint8Array(32).fill(7);
    const body = new Writer().raw(discriminator("event", "ObservationAccepted")).raw(source.toBytes()).u16(3).u8(0).u8(0).i64(2_100_000).i64(1_790_900_000).raw(identifier).bytes();
    const other = new Writer().raw(discriminator("event", "IndexUpdated")).u8(0).bytes();
    const logs = ["Program log: Instruction: SubmitObservation", `Program data: ${other.toString("base64")}`, `Program data: ${body.toString("base64")}`];
    expect(parseObservations(logs)).toEqual([
      { source: source.toBase58(), providerId: 3, sku: 0, kind: 0, priceMicro: 2_100_000, observedAt: 1_790_900_000, identifier: "0x" + "07".repeat(32) },
    ]);
  });
});
