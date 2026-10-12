import { describe, expect, it } from "vitest";
import { discriminator, Writer } from "@pct/oracle";
import { Keypair } from "@solana/web3.js";
import { badge, covenantProven, decodeZkConfig, decodeZkCovenant, provedChallenge } from "./zk.js";

const PID = Keypair.generate().publicKey.toBase58();

describe("zk accounts", () => {
  it("decodes ZkCovenant in declaration order", () => {
    const loan = Keypair.generate().publicKey;
    const data = new Writer()
      .raw(discriminator("account", "ZkCovenant"))
      .pubkey(loan)
      .raw(new Uint8Array(32).fill(1))
      .u8(1)
      .u64(11_500n)
      .u32(2961)
      .u32(4)
      .raw(new Uint8Array(32).fill(2))
      .raw(new Uint8Array(32).fill(3))
      .raw(new Uint8Array(32).fill(4))
      .u8(0)
      .i64(1_791_600_000n)
      .u8(255)
      .bytes();
    expect(decodeZkCovenant(data)).toEqual({
      loan: loan.toBase58(),
      challenge: "01".repeat(32),
      status: "pass",
      coverageBps: 11_500,
      asOfPeriod: 2961,
      claims: 4,
      chipId: "02".repeat(32),
      measurements: "03".repeat(32),
      vmMeasurement: "04".repeat(32),
      vmBound: false,
      provenAt: 1_791_600_000,
    });
  });

  it("decodes ZkConfig and refuses other accounts", () => {
    const data = new Writer().raw(discriminator("account", "ZkConfig")).raw(new Uint8Array(32).fill(9)).u8(2).u8(1).raw(new Uint8Array(32)).u8(254).u64(1_300_000n).bytes();
    expect(decodeZkConfig(data)).toEqual({ imageId: "09".repeat(32), attestorThreshold: 2, requireVmBound: true, vmMeasurement: "00".repeat(32), feeLamports: 1_300_000 });
    expect(() => decodeZkCovenant(data)).toThrow("not a ZkCovenant");
  });

  it("reads CovenantProven's loan and fee, only when our program logged it", () => {
    const loan = Keypair.generate().publicKey;
    const ev = new Writer()
      .raw(discriminator("event", "CovenantProven"))
      .pubkey(loan)
      .u8(2)
      .u64(11_403n)
      .u32(2961)
      .u32(4)
      .raw(new Uint8Array(64))
      .u8(0)
      .u64(1_300_000n)
      .bytes()
      .toString("base64");
    const ours = [`Program ${PID} invoke [1]`, `Program data: ${ev}`, `Program ${PID} success`];
    const other = Keypair.generate().publicKey.toBase58();
    const theirs = [`Program ${other} invoke [1]`, `Program data: ${ev}`, `Program ${other} success`];
    expect(covenantProven(ours, PID)).toEqual([{ loan: loan.toBase58(), feeLamports: 1_300_000 }]);
    expect(covenantProven(theirs, PID)).toEqual([]);
  });
});

describe("badge", () => {
  it("labels pass, watch and unproven", () => {
    expect(badge("pass", 11_500, 2961)).toContain("PASS 1.15x · wk 2961");
    expect(badge("watch", 11_403, 2961)).toContain("WATCH 1.14x · wk 2961");
    expect(badge("none", 0, 0)).toContain(">UNPROVEN<");
  });
  it("says SAMPLE GPU when the proofs use published sample evidence", () => {
    expect(badge("pass", 11_500, 2961, true)).toContain(">SAMPLE GPU<");
    expect(badge("pass", 11_500, 2961, true)).not.toContain("GPU VERIFIED");
    expect(badge("pass", 11_500, 2961, false)).toContain(">GPU VERIFIED<");
  });
});

describe("provedChallenge", () => {
  it("reads the GPU nonce from prove_covenant's public values", () => {
    const pv = new Uint8Array(262);
    pv.fill(5, 32, 64);
    const data = new Writer().raw(discriminator("global", "prove_covenant")).vec(new Uint8Array(256)).vec(pv).u32(2961).bytes();
    expect(provedChallenge(data)).toBe("05".repeat(32));
    expect(provedChallenge(new Writer().raw(discriminator("global", "draw_private")).u64(1n).bytes())).toBeNull();
  });
});
