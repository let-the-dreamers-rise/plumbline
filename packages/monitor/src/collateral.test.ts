import { describe, expect, it } from "vitest";
import { describe as describeCollateral, normalizeModel, parseCollateral, parseName } from "./collateral.js";
import { enrichmentFor, parseAppLoans } from "./enrich.js";
import { fixture, fixtureJson } from "./fixtures.js";

const meta = (id: string) => parseCollateral(id, `https://metadata.usd.ai/v1/${id}`, fixtureJson(`metadata-${id}.json`));

describe("collateral metadata", () => {
  it("reads a portfolio token (1008: B300 [130], $77.7M)", () => {
    const c = meta("1008");
    expect(c.components).toEqual([{ model: "B300", label: "B300", units: 130, gpus: 1040 }]);
    expect(c.gpuCount).toBe(1040);
    expect(c.valueUsd).toBeCloseTo(77_720_676.36, 2);
    expect(c.usefulLifeDays).toBe(1095);
    expect(c.manufacturer).toBe("Supermicro");
  });

  it("reads per-server tokens and treats network gear as non-GPU collateral", () => {
    expect(meta("401").gpuCount).toBe(8);
    expect(meta("401").components[0]!.model).toBe("RTX PRO 6000");
    expect(meta("101").components[0]!.model).toBe("H200");
    const network = meta("259");
    expect(network.components[0]).toMatchObject({ model: null, gpus: 0 });
    expect(network.gpuCount).toBe(0);
    expect(network.valueUsd).toBeGreaterThan(0);
  });

  it("parses mixed names and normalizes model labels from every source", () => {
    expect(parseName("B300 [9] / RTX PRO 6000 [18]").map((c) => [c.model, c.units, c.gpus])).toEqual([
      ["B300", 9, 72],
      ["RTX PRO 6000", 18, 144],
    ]);
    expect(normalizeModel("NVIDIA DGX B300")).toBe("B300");
    expect(normalizeModel("GB200 NVL72")).toBe("GB200");
    expect(normalizeModel("pro6000se")).toBe("RTX PRO 6000");
    expect(normalizeModel("Supermicro NVIDIA RTX 6000 Pro Server")).toBe("RTX PRO 6000");
    expect(normalizeModel("InfiniBand Network")).toBeNull();
  });

  it("groups many per-server tokens in one line", () => {
    const servers = [meta("401"), meta("401"), meta("259")];
    expect(describeCollateral(servers)).toBe("2 x Supermicro NVIDIA RTX 6000 Pro Server, 1 x InfiniBand Network (E-W)");
  });

  it("rejects a document without a name", () => {
    expect(() => parseCollateral("1", "u", { attributes: [] })).toThrow(/no name/);
    expect(() => parseCollateral("1", "u", null)).toThrow();
  });
});

describe("app.usd.ai enrichment", () => {
  it("reads location, offtake code, token ids and the app's APR from a recorded excerpt", () => {
    const list = parseAppLoans(fixture("app-loans-excerpt.html"));
    const e = enrichmentFor(list, "1001");
    expect(e).not.toBeNull();
    expect(e!.locationName).toBe("TX, USA");
    expect(e!.offTakeCode).toBe(0);
    expect(e!.borrower).toBe("0x8cfde17b2919d6c571cca1763a1cfd2677df9b3a");
    expect(e!.loanHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(e!.appAprPct).toBeCloseTo(11.479, 2);
  });

  it("returns nothing for a page in another format", () => {
    expect(parseAppLoans("<html><body>maintenance</body></html>")).toEqual([]);
    expect(enrichmentFor([], "1001")).toBeNull();
  });
});
