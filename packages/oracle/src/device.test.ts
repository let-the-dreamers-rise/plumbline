import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { Writer, discriminator } from "./borsh.js";
import { DEFAULT_PROGRAM_ID, OracleInstructions, decodeDevice, journalChipId } from "./program.js";

const fixture = (name: string) =>
  JSON.parse(readFileSync(`oracle/programs/pct_oracle/tests/fixtures/${name}`, "utf8")) as { journal: string; seal: string };
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex.replace(/^0x/, ""), "hex"));

describe("device registry", () => {
  const ix = new OracleInstructions();
  const journal = bytes(fixture("covenant-strong-groth16.json").journal);
  const chipId = journalChipId(journal);

  it("derives the Device PDA from [\"device\", chip id]", () => {
    const [expected] = PublicKey.findProgramAddressSync([Buffer.from("device"), chipId], DEFAULT_PROGRAM_ID);
    expect(ix.pdas.device(chipId).equals(expected)).toBe(true);
    expect(() => ix.pdas.device(new Uint8Array(31))).toThrow();
  });

  it("finds the same chip in both fixture proofs (same NVIDIA sample report)", () => {
    const watch = journalChipId(bytes(fixture("covenant-strong-watch114-groth16.json").journal));
    expect(ix.pdas.device(watch).equals(ix.pdas.device(chipId))).toBe(true);
  });

  it("appends the writable Device PDA to prove_covenant only when asked", () => {
    const lender = Keypair.generate().publicKey;
    const loan = { lender, operatorKey: new Uint8Array(32).fill(3) };
    const plain = ix.proveCovenant(lender, new Uint8Array(32), loan, new Uint8Array(256), journal, 5);
    const withDevice = ix.proveCovenant(lender, new Uint8Array(32), loan, new Uint8Array(256), journal, 5, { deviceRegistry: true });
    expect(plain.keys).toHaveLength(8);
    expect(withDevice.keys).toHaveLength(9);
    const last = withDevice.keys[8]!;
    expect(last.pubkey.equals(ix.pdas.device(chipId)) && last.isWritable && !last.isSigner).toBe(true);
    expect(withDevice.data.equals(plain.data)).toBe(true);
  });

  it("builds release_device and set_device_registry", () => {
    const lender = Keypair.generate().publicKey;
    const release = ix.releaseDevice(lender, chipId);
    expect(release.keys.map((k) => [k.isSigner, k.isWritable])).toEqual([
      [true, false],
      [false, true],
    ]);
    expect(release.keys[1]!.pubkey.equals(ix.pdas.device(chipId))).toBe(true);
    expect(release.data.equals(Buffer.from(discriminator("global", "release_device")))).toBe(true);
    const toggle = ix.setDeviceRegistry(lender, true);
    expect(toggle.keys[2]!.pubkey.equals(ix.pdas.zkConfig())).toBe(true);
    expect(toggle.data[toggle.data.length - 1]).toBe(1);
  });

  it("decodes a Device account and reports a released GPU as unpledged", () => {
    const loan = Keypair.generate().publicKey;
    const lender = Keypair.generate().publicKey;
    const account = (l: PublicKey, k: PublicKey) =>
      new Writer().raw(discriminator("account", "Device")).raw(chipId).pubkey(l).pubkey(k).i64(10).u32(2).i64(20).u32(3).u8(254).bytes();
    const d = decodeDevice(account(loan, lender));
    expect(Buffer.from(d.chipId).equals(Buffer.from(chipId))).toBe(true);
    expect(d.loan?.equals(loan) && d.lender?.equals(lender)).toBe(true);
    expect([d.firstSeenAt, d.firstSeenPeriod, d.boundAt, d.boundPeriod]).toEqual([10n, 2, 20n, 3]);
    const freed = decodeDevice(account(PublicKey.default, PublicKey.default));
    expect([freed.loan, freed.lender]).toEqual([null, null]);
    expect(() => decodeDevice(new Uint8Array(120))).toThrow();
  });
});
