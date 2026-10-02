import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getBytes, keccak256 } from "ethers";
import { AZURE_H100_LIST, invoiceSpecFromConfig } from "@pct/prover";
import { Writer, discriminator } from "./borsh.js";
import { attestorsOf, keccakBytes, providerId, receiptKey, sourceArgsFor, toSubmission } from "./claim.js";
import { fixtureProof, type Fixtures } from "./fixtures.js";
import { OracleInstructions, VALUE_MODE_AMOUNT_HOURS, VALUE_MODE_RATE, decodeBook } from "./program.js";
import { Keypair } from "@solana/web3.js";

const fx = JSON.parse(readFileSync("oracle/programs/pct_oracle/tests/fixtures/claims.json", "utf8")) as Fixtures;

describe("borsh", () => {
  it("encodes little-endian ints, strings and vecs", () => {
    const b = new Writer().u16(0x0102).u32(7).i64(-1).string("ab").vec(Uint8Array.of(9)).bytes();
    expect([...b]).toEqual([2, 1, 7, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 2, 0, 0, 0, 97, 98, 1, 0, 0, 0, 9]);
  });

  it("rejects values that do not fit", () => {
    expect(() => new Writer().u8(256)).toThrow();
    expect(() => new Writer().u16(-1)).toThrow();
    expect(() => new Writer().fixed(new Uint8Array(3), 20)).toThrow();
  });

  it("uses Anchor's sha256 discriminators", () => {
    // sha256("global:initialize")[..8], the well-known Anchor value.
    expect(Buffer.from(discriminator("global", "initialize")).toString("hex")).toBe("afaf6d1f0d989bed");
  });
});

describe("claims", () => {
  it("paid receipt key is keccak of the nullifier, list key is keccak(identifier || ts)", () => {
    const paid = fixtureProof(fx.claims[0]!, fx.attestor);
    const account = (JSON.parse(paid.claimData.context) as { extractedParameters: { account: string } }).extractedParameters.account;
    expect(receiptKey(paid, true)).toEqual(keccakBytes(account));

    const list = fixtureProof(fx.claims[4]!, fx.attestor);
    const ts = Buffer.alloc(4);
    ts.writeUInt32LE(list.claimData.timestampS);
    expect(receiptKey(list, false)).toEqual(getBytes(keccak256(Buffer.concat([getBytes(list.identifier), ts]))));
  });

  it("splits a proof into buffer parts and a 65-byte signature", () => {
    const s = toSubmission(fixtureProof(fx.claims[1]!, fx.attestor), true);
    expect(Buffer.from(s.parameters).toString()).toBe(fx.claims[1]!.parameters);
    expect(s.sig.signature).toHaveLength(65);
    expect(s.sig.owner).toBe(fx.claims[1]!.owner);
  });

  it("refuses a paid proof without a nullifier", () => {
    const list = fixtureProof(fx.claims[4]!, fx.attestor);
    expect(() => receiptKey(list, true)).toThrow(/nullifier/);
  });

  it("collects unique attestors", () => {
    const proofs = fx.claims.map((c) => fixtureProof(c, fx.attestor.toUpperCase().replace("0X", "0x")));
    expect(attestorsOf(proofs).map((a) => Buffer.from(a).toString("hex"))).toEqual([fx.attestor.slice(2)]);
  });

  it("derives source args from a spec", () => {
    const list = sourceArgsFor(AZURE_H100_LIST, "{}");
    expect(list).toMatchObject({ sku: 0, kind: 1, gpuCount: 8, valueMode: VALUE_MODE_RATE, requiresNullifier: false, providerId: 5 });
    expect(list.paramsHash).toEqual(keccakBytes("{}"));
    const invoice = invoiceSpecFromConfig({
      id: "lambda-h100",
      provider: "lambda",
      sku: "H100",
      gpuCount: 1,
      url: "https://cloud.lambdalabs.com/api/invoices",
      matches: [{ regex: '"amount":"(?<amount>[0-9.]+)","hours":(?<hours>[0-9.]+)' }],
      nullifierRule: { regex: '"id":"(?<account>[^"]+)"' },
    });
    expect(sourceArgsFor(invoice, "{}")).toMatchObject({ kind: 0, valueMode: VALUE_MODE_AMOUNT_HOURS, requiresNullifier: true, providerId: 1 });
    expect(providerId("SomeNewCloud")).toBeGreaterThanOrEqual(1000);
    expect(providerId("SomeNewCloud")).toBe(providerId("somenewcloud"));
  });
});

describe("instructions", () => {
  it("orders submit_observation accounts like the Anchor struct", () => {
    const ix = new OracleInstructions();
    const me = Keypair.generate().publicKey;
    const sourceId = keccakBytes("x");
    const s = toSubmission(fixtureProof(fx.claims[0]!, fx.attestor), true);
    const built = ix.submitObservation(me, { sourceId, sku: 0, kind: 0 }, s.sig, s.receiptKey);
    const source = ix.pdas.source(sourceId);
    expect(built.keys.map((k) => k.pubkey.toBase58())).toEqual(
      [me, ix.pdas.config(), source, ix.pdas.book(0, 0), ix.pdas.buffer(me), ix.pdas.receipt(source, s.receiptKey)]
        .map((k) => k.toBase58())
        .concat("11111111111111111111111111111111"),
    );
    expect(built.data.subarray(0, 8)).toEqual(Buffer.from(discriminator("global", "submit_observation")));
  });

  it("decodes a Book account", () => {
    const data = Buffer.alloc(8 + 4 + 32 * 22 + 8 + 3 + 8 + 1);
    Buffer.from(discriminator("account", "Book")).copy(data, 0);
    data.writeUInt8(1, 8 + 3); // len
    data.writeUInt16LE(7, 12);
    data.writeBigUInt64LE(2_490_000n, 14);
    const tail = 12 + 32 * 22;
    data.writeBigUInt64LE(2_490_000n, tail);
    data.writeUInt8(1, tail + 8);
    const book = decodeBook(data);
    expect(book.slots).toEqual([{ providerId: 7, priceMicro: 2_490_000n, observedAt: 0n, weight: 0 }]);
    expect(book.status).toBe("live");
    expect(book.valueMicro).toBe(2_490_000n);
  });
});
