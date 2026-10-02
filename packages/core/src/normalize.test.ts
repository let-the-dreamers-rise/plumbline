import { describe, expect, it } from "vitest";
import { parseUsdToMicro, perGpuHourMicro, postedPaidSpread } from "./normalize.js";

describe("parseUsdToMicro", () => {
  it.each([
    ["2.49", 2_490_000],
    ["$2.49", 2_490_000],
    [" $1,234.5 ", 1_234_500_000],
    ["0.000001", 1],
  ])("parses %s", (input, expected) => {
    expect(parseUsdToMicro(input)).toBe(expected);
  });
  it.each(["", "abc", "-1", "1.2.3", "1e5"])("rejects %s", (input) => {
    expect(() => parseUsdToMicro(input)).toThrow();
  });
});

describe("perGpuHourMicro", () => {
  it("divides an invoice total by hours and GPUs", () => {
    expect(perGpuHourMicro({ totalMicroUsd: 19_920_000, hours: 1, gpuCount: 8 })).toBe(2_490_000);
  });
  it("rounds half up to whole micro-dollars", () => {
    expect(perGpuHourMicro({ totalMicroUsd: 10, hours: 3, gpuCount: 1 })).toBe(3);
  });
  it.each([
    { totalMicroUsd: 1, hours: 0, gpuCount: 1 },
    { totalMicroUsd: 1, hours: 1, gpuCount: 0 },
    { totalMicroUsd: -1, hours: 1, gpuCount: 1 },
    { totalMicroUsd: 1, hours: 1, gpuCount: 1.5 },
  ])("rejects %o", (line) => {
    expect(() => perGpuHourMicro(line)).toThrow();
  });
});

describe("postedPaidSpread", () => {
  it("reports the absolute and relative gap", () => {
    expect(postedPaidSpread(4_170_000, 2_710_000)).toEqual({ microUsd: 1_460_000, bps: 5387 });
  });
  it("rejects a non-positive paid price", () => {
    expect(() => postedPaidSpread(1, 0)).toThrow();
  });
});
