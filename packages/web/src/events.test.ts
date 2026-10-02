import { describe, expect, it } from "vitest";
import { discriminator, Writer } from "@pct/oracle";
import { Keypair } from "@solana/web3.js";
import { parseDrawApproved, parseObservations, parseRevenueProven } from "./events.js";

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

describe("lender events", () => {
  it("decodes RevenueProven and DrawApproved", () => {
    const loan = Keypair.generate().publicKey;
    const source = Keypair.generate().publicKey;
    const proven = new Writer()
      .raw(discriminator("event", "RevenueProven"))
      .pubkey(loan)
      .pubkey(source)
      .u16(11)
      .u32(2961)
      .u64(400_000_000n)
      .u64(0n)
      .u64(0n)
      .u64(2_666n)
      .u64(19_869n)
      .i64(1_790_820_000)
      .raw(new Uint8Array(32).fill(9))
      .bytes();
    const draw = new Writer().raw(discriminator("event", "DrawApproved")).pubkey(loan).u64(2_000_000_000n).u64(19_869n).bytes();
    const logs = [`Program data: ${proven.toString("base64")}`, `Program data: ${draw.toString("base64")}`];
    expect(parseRevenueProven(logs)).toEqual([
      {
        loan: loan.toBase58(),
        source: source.toBase58(),
        providerId: 11,
        period: 2961,
        revenueMicro: 400_000_000,
        gpuHoursMicro: 0,
        rentMicro: 0,
        periodCoverageBps: 2_666,
        trailingCoverageBps: 19_869,
        observedAt: 1_790_820_000,
        identifier: "0x" + "09".repeat(32),
      },
    ]);
    expect(parseDrawApproved(logs)).toEqual([{ loan: loan.toBase58(), lamports: 2_000_000_000, coverageBps: 19_869 }]);
  });
});
