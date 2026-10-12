import { describe, expect, it } from "vitest";
import { fixtureJson } from "./fixtures.js";
import { buildArchive, parseAkash, parseRunpod, parseVast, summarize } from "./prices.js";

describe("price parsers on recorded responses", () => {
  it("Vast: per-GPU price from bundle price / GPUs, NVL left out", () => {
    const q = parseVast(fixtureJson("vast.json"));
    expect(q.length).toBeGreaterThan(0);
    expect(q.every((x) => x.usdPerGpuHr > 0)).toBe(true);
    expect(new Set(q.map((x) => x.model))).not.toContain(undefined);
    const raw = fixtureJson<{ offers: { gpu_name: string }[] }>("vast.json").offers;
    const nvl = raw.filter((o) => o.gpu_name === "H100 NVL").length;
    expect(q.length).toBe(raw.length - nvl);
  });

  it("RunPod: secure and community list prices for the mapped SKUs only", () => {
    const q = parseRunpod(fixtureJson("runpod.json"));
    const b200 = q.filter((x) => x.model === "B200").map((x) => x.usdPerGpuHr).sort();
    expect(b200).toEqual([5.98, 7.99]);
    expect(q.some((x) => /MIG|NVL|PCIe|Workstation/.test(x.detail))).toBe(false);
  });

  it("Akash: console median per model, workstation edition left out", () => {
    const q = parseAkash(fixtureJson("akash.json"));
    expect(q.find((x) => x.model === "H100")?.usdPerGpuHr).toBe(2.56);
    expect(q.filter((x) => x.model === "RTX PRO 6000")).toHaveLength(1);
    expect(q.find((x) => x.model === "B300")).toBeUndefined(); // listed with price null
  });

  it("throws on a response of the wrong shape", () => {
    expect(() => parseVast({})).toThrow(/offers/);
    expect(() => parseRunpod({ errors: [] })).toThrow(/gpuTypes/);
    expect(() => parseAkash(null)).toThrow(/models/);
  });
});

describe("summarize", () => {
  const q = (model: "H100" | "B200", usdPerGpuHr: number) => ({ model, usdPerGpuHr, detail: "t" });

  it("takes each source's median, then the median across sources", () => {
    const s = summarize({
      "vast.ai": [q("H100", 1), q("H100", 2), q("H100", 100)],
      runpod: [q("H100", 3), q("H100", 5)],
      akash: [q("H100", 2.5)],
    });
    expect(s.H100.sources.map((x) => [x.source, x.medianUsdPerGpuHr, x.quotes])).toEqual([
      ["vast.ai", 2, 3],
      ["runpod", 4, 2],
      ["akash", 2.5, 1],
    ]);
    expect(s.H100.medianUsdPerGpuHr).toBe(2.5);
  });

  it("leaves a model without quotes as null", () => {
    const s = summarize({ runpod: [q("B200", 6), q("B200", 8)] });
    expect(s.B200.medianUsdPerGpuHr).toBe(7);
    expect(s.GB200).toEqual({ medianUsdPerGpuHr: null, sources: [] });
  });

  it("builds a dated archive with the method and errors", () => {
    const a = buildArchive({ akash: [q("H100", 2)] }, new Date("2026-10-12T20:00:00Z"), ["vast.ai: HTTP 503"]);
    expect(a.date).toBe("2026-10-12");
    expect(a.schema).toBe("plumbline.gpu-prices/v1");
    expect(a.models.H100.medianUsdPerGpuHr).toBe(2);
    expect(a.errors).toEqual(["vast.ai: HTTP 503"]);
    expect(a.method).toMatch(/median/);
  });
});
