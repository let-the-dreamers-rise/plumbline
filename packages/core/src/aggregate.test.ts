import { describe, expect, it } from "vitest";
import {
  capProviderShares,
  computeIndex,
  DEFAULT_PARAMS,
  median,
  weightedMedian,
} from "./aggregate.js";
import type { Observation } from "./types.js";

const NOW = 1_790_000_000;

function obs(partial: Partial<Observation> & { sourceId: string; micro: number }): Observation {
  return {
    sourceId: partial.sourceId,
    provider: partial.provider ?? partial.sourceId,
    sku: partial.sku ?? "H100",
    kind: partial.kind ?? "paid",
    microUsdPerGpuHour: partial.micro,
    observedAtS: partial.observedAtS ?? NOW - 60,
    weight: partial.weight ?? 1,
    nullifier: partial.nullifier,
  };
}

describe("median", () => {
  it("returns the middle value for odd counts", () => {
    expect(median([5, 1, 3])).toBe(3);
  });
  it("returns the mean of the two middle values for even counts", () => {
    expect(median([1, 2, 3, 10])).toBe(2.5);
  });
  it("throws on empty input", () => {
    expect(() => median([])).toThrow();
  });
  it("does not mutate its input", () => {
    const input = [3, 1, 2];
    median(input);
    expect(input).toEqual([3, 1, 2]);
  });
});

describe("weightedMedian", () => {
  it("equals the plain median for equal weights and odd count", () => {
    expect(weightedMedian([{ value: 1, weight: 1 }, { value: 9, weight: 1 }, { value: 4, weight: 1 }])).toBe(4);
  });
  it("moves toward heavy weights", () => {
    expect(weightedMedian([{ value: 1, weight: 1 }, { value: 9, weight: 5 }, { value: 4, weight: 1 }])).toBe(9);
  });
  it("takes the lower value when cumulative weight hits exactly half", () => {
    expect(weightedMedian([{ value: 2, weight: 1 }, { value: 8, weight: 1 }])).toBe(2);
  });
  it("rejects zero total weight", () => {
    expect(() => weightedMedian([{ value: 2, weight: 0 }])).toThrow();
  });
});

describe("capProviderShares", () => {
  it("caps a dominant provider at the cap and redistributes", () => {
    const shares = capProviderShares(new Map([["a", 10], ["b", 1], ["c", 1], ["d", 1], ["e", 1]]), 0.25);
    expect(shares.get("a")).toBeCloseTo(0.25);
    const others = ["b", "c", "d", "e"].map((p) => shares.get(p)!);
    others.forEach((s) => expect(s).toBeCloseTo(0.1875));
    const total = [...shares.values()].reduce((x, y) => x + y, 0);
    expect(total).toBeCloseTo(1);
  });
  it("falls back to equal shares when the cap is infeasible", () => {
    const shares = capProviderShares(new Map([["a", 10], ["b", 1], ["c", 1]]), 0.25);
    ["a", "b", "c"].forEach((p) => expect(shares.get(p)).toBeCloseTo(1 / 3));
  });
  it("leaves shares alone when nobody exceeds the cap", () => {
    const shares = capProviderShares(new Map([["a", 1], ["b", 1], ["c", 1], ["d", 1], ["e", 1]]), 0.25);
    [...shares.values()].forEach((s) => expect(s).toBeCloseTo(0.2));
  });
});

describe("computeIndex", () => {
  const base = [
    obs({ sourceId: "inv-1", provider: "lambda", micro: 2_490_000 }),
    obs({ sourceId: "inv-2", provider: "runpod", micro: 2_690_000 }),
    obs({ sourceId: "inv-3", provider: "vast", micro: 2_100_000 }),
    obs({ sourceId: "inv-4", provider: "sfcompute", micro: 2_800_000 }),
  ];

  it("publishes a live weighted median of paid prices", () => {
    const r = computeIndex(base, "H100", "paid", { ...DEFAULT_PARAMS, nowS: NOW });
    expect(r.status).toBe("live");
    expect(r.valueMicroUsd).toBe(2_490_000);
    expect(r.used).toHaveLength(4);
  });

  it("freezes with fewer than three distinct live sources", () => {
    const r = computeIndex(base.slice(0, 2), "H100", "paid", { ...DEFAULT_PARAMS, nowS: NOW });
    expect(r.status).toBe("frozen");
    expect(r.valueMicroUsd).toBeNull();
    expect(r.reason).toMatch(/sources/);
  });

  it("drops stale observations", () => {
    const stale = obs({ sourceId: "old", micro: 9_000_000, observedAtS: NOW - 100_000 });
    const r = computeIndex([...base, stale], "H100", "paid", { ...DEFAULT_PARAMS, nowS: NOW });
    expect(r.used.map((o) => o.sourceId)).not.toContain("old");
    expect(r.rejected.find((x) => x.obs.sourceId === "old")?.reason).toBe("stale");
  });

  it("drops observations from the future", () => {
    const future = obs({ sourceId: "fut", micro: 2_500_000, observedAtS: NOW + 3_600 });
    const r = computeIndex([...base, future], "H100", "paid", { ...DEFAULT_PARAMS, nowS: NOW });
    expect(r.rejected.find((x) => x.obs.sourceId === "fut")?.reason).toBe("future");
  });

  it("never mixes list prices into the paid index", () => {
    const list = obs({ sourceId: "azure", kind: "list", micro: 6_980_000 });
    const r = computeIndex([...base, list], "H100", "paid", { ...DEFAULT_PARAMS, nowS: NOW });
    expect(r.used.map((o) => o.sourceId)).not.toContain("azure");
  });

  it("rejects MAD outliers", () => {
    const spoof = obs({ sourceId: "spoof", provider: "evil", micro: 40_000_000 });
    const r = computeIndex([...base, spoof], "H100", "paid", { ...DEFAULT_PARAMS, nowS: NOW });
    expect(r.rejected.find((x) => x.obs.sourceId === "spoof")?.reason).toBe("outlier");
    expect(r.valueMicroUsd).toBe(2_490_000);
  });

  it("counts a reused invoice nullifier once, keeping the newest", () => {
    const a = obs({ sourceId: "w1", provider: "lambda", micro: 1_000_000, nullifier: "n1", observedAtS: NOW - 300 });
    const b = obs({ sourceId: "w2", provider: "lambda", micro: 2_300_000, nullifier: "n1", observedAtS: NOW - 200 });
    const r = computeIndex([...base, a, b], "H100", "paid", { ...DEFAULT_PARAMS, nowS: NOW });
    expect(r.rejected.find((x) => x.obs.sourceId === "w1")?.reason).toBe("duplicate");
    expect(r.used.map((o) => o.sourceId)).toContain("w2");
  });

  it("stops one provider flooding the index", () => {
    const flood = Array.from({ length: 20 }, (_, i) =>
      obs({ sourceId: `flood-${i}`, provider: "lambda", micro: 2_200_000 }),
    );
    const r = computeIndex([...base, ...flood], "H100", "paid", { ...DEFAULT_PARAMS, nowS: NOW });
    expect(r.valueMicroUsd).not.toBe(2_200_000);
  });

  it("rejects malformed prices", () => {
    const bad = obs({ sourceId: "bad", micro: -5 });
    const r = computeIndex([...base, bad], "H100", "paid", { ...DEFAULT_PARAMS, nowS: NOW });
    expect(r.rejected.find((x) => x.obs.sourceId === "bad")?.reason).toBe("invalid");
  });

  it("filters by sku", () => {
    const b200 = obs({ sourceId: "b", sku: "B200", micro: 5_000_000 });
    const r = computeIndex([...base, b200], "H100", "paid", { ...DEFAULT_PARAMS, nowS: NOW });
    expect(r.used.map((o) => o.sourceId)).not.toContain("b");
  });
});
