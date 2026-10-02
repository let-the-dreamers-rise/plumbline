import { describe, expect, it } from "vitest";
import { proofToObservation, type ProofLike } from "./claim.js";
import { buildZkFetchRequest } from "./request.js";
import { AZURE_H100_LIST, invoiceSpecFromConfig, type SourceSpec } from "./specs.js";

const INVOICE_CONFIG = {
  id: "lambda-invoice",
  provider: "lambda",
  sku: "H100",
  gpuCount: 1,
  url: "https://cloud.example.com/api/billing/invoices?limit=1",
  matches: [{ regex: '"description":"1x H100[^"]*","amount":"(?<amount>[0-9.]+)","hours":(?<hours>[0-9.]+)' }],
  nullifierRule: { regex: '"invoice_id":"(?<account>[^"]+)"' },
};

function fakeProof(spec: SourceSpec, values: Record<string, string>, overrides: Partial<{ url: string; matches: string[] }> = {}): ProofLike {
  const matches = overrides.matches ?? [...spec.matches, ...(spec.nullifierRule ? [spec.nullifierRule] : [])].map((m) => m.regex);
  return {
    identifier: "0xabc",
    claimData: {
      parameters: JSON.stringify({
        url: overrides.url ?? spec.url,
        method: "GET",
        responseMatches: matches.map((value) => ({ type: "regex", value })),
        responseRedactions: [],
      }),
      context: JSON.stringify({ extractedParameters: values }),
      timestampS: 1_790_000_000,
    },
  };
}

describe("invoiceSpecFromConfig", () => {
  it("builds a paid-price spec", () => {
    const spec = invoiceSpecFromConfig(INVOICE_CONFIG);
    expect(spec.kind).toBe("paid");
    expect(spec.urlPrefix).toBe("https://cloud.example.com/api/billing/invoices");
  });
  it.each([
    ["non-object", null],
    ["http url", { ...INVOICE_CONFIG, url: "http://cloud.example.com/x" }],
    ["missing id", { ...INVOICE_CONFIG, id: "" }],
    ["bad sku", { ...INVOICE_CONFIG, sku: "A100" }],
    ["bad gpuCount", { ...INVOICE_CONFIG, gpuCount: 0 }],
    ["no matches", { ...INVOICE_CONFIG, matches: [] }],
    ["no price groups", { ...INVOICE_CONFIG, matches: [{ regex: "(?<amount>\\d+)" }] }],
    ["bad regex", { ...INVOICE_CONFIG, matches: [{ regex: "(?<rate>" }] }],
    ["nullifier without account", { ...INVOICE_CONFIG, nullifierRule: { regex: "(?<id>x)" } }],
  ])("rejects %s", (_label, raw) => {
    expect(() => invoiceSpecFromConfig(raw)).toThrow();
  });
});

describe("buildZkFetchRequest", () => {
  it("keeps credentials in secret options only", () => {
    const spec = invoiceSpecFromConfig(INVOICE_CONFIG);
    const req = buildZkFetchRequest(spec, { authHeader: "Bearer s3cret", cookie: "sid=1" });
    expect(JSON.stringify(req.publicOptions)).not.toContain("s3cret");
    expect(req.secretOptions.headers).toEqual({ Authorization: "Bearer s3cret" });
    expect(req.secretOptions.cookieStr).toBe("sid=1");
  });
  it("reveals only matched spans and hashes the account id", () => {
    const spec = invoiceSpecFromConfig(INVOICE_CONFIG);
    const req = buildZkFetchRequest(spec);
    expect(req.secretOptions.responseMatches).toHaveLength(2);
    expect(req.secretOptions.responseRedactions.at(-1)).toEqual({ regex: INVOICE_CONFIG.nullifierRule.regex, hash: "oprf-raw" });
  });
  it("has no secrets for the public Azure source", () => {
    const req = buildZkFetchRequest(AZURE_H100_LIST);
    expect(req.secretOptions.headers).toBeUndefined();
    expect(req.url).toContain("Standard_ND96isr_H100_v5");
  });
});

describe("proofToObservation", () => {
  const invoice = invoiceSpecFromConfig(INVOICE_CONFIG);
  const specs = [AZURE_H100_LIST, invoice];

  it("turns an Azure list proof into a per-GPU list observation", () => {
    const o = proofToObservation(fakeProof(AZURE_H100_LIST, { rate: "98.32" }), specs);
    expect(o).toMatchObject({ provider: "azure", kind: "list", microUsdPerGpuHour: 12_290_000 });
  });

  it("turns an invoice proof into a paid observation with a nullifier", () => {
    const o = proofToObservation(fakeProof(invoice, { amount: "4.98", hours: "2", account: "0xhash" }), specs);
    expect(o).toMatchObject({ kind: "paid", microUsdPerGpuHour: 2_490_000, nullifier: "0xhash" });
  });

  it("rejects proofs from unregistered URLs", () => {
    expect(() => proofToObservation(fakeProof(invoice, { rate: "1" }, { url: "https://evil.example/x" }), specs)).toThrow(/no registered/);
  });

  it("rejects proofs whose attestor did not enforce the spec's rules", () => {
    const p = fakeProof(invoice, { amount: "1", hours: "1", account: "0x1" }, { matches: ["(?<amount>.*)"] });
    expect(() => proofToObservation(p, specs)).toThrow(/does not enforce/);
  });

  it("rejects invoice proofs without a nullifier", () => {
    expect(() => proofToObservation(fakeProof(invoice, { amount: "1", hours: "1" }), specs)).toThrow(/nullifier/);
  });

  it("rejects proofs exposing no price", () => {
    expect(() => proofToObservation(fakeProof(AZURE_H100_LIST, {}), specs)).toThrow(/neither/);
  });

  it("rejects malformed parameters", () => {
    const p = fakeProof(AZURE_H100_LIST, { rate: "1" });
    const broken = { ...p, claimData: { ...p.claimData, parameters: "{nope" } };
    expect(() => proofToObservation(broken, specs)).toThrow(/JSON/);
  });

  it("accepts the real Azure response with the shipped regex", () => {
    const body = '{"Items":[{"currencyCode":"USD","tierMinimumUnits":0.0,"retailPrice":98.32,"unitPrice":98.32}]}';
    const m = body.match(new RegExp(AZURE_H100_LIST.matches[0].regex));
    expect(m?.groups?.rate).toBe("98.32");
  });
});
