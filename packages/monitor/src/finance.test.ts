import { describe, expect, it } from "vitest";
import {
  breakevenUtilization,
  coverageRatio,
  debtServicePerGpuHour,
  depreciatedValue,
  levelPayment,
  ltv,
  median,
  monthsElapsed,
  scheduledBalance,
  termMonths,
} from "./finance.js";

describe("amortization", () => {
  it("matches the textbook level payment", () => {
    // 100,000 at 12% over 12 months: 8,884.88 a month.
    expect(levelPayment(100_000, 0.12, 12)).toBeCloseTo(8884.88, 2);
    expect(levelPayment(120_000, 0, 12)).toBe(10_000);
  });

  it("amortizes to zero at the end of the schedule", () => {
    expect(scheduledBalance(1_000_000, 0.085, 36, 36)).toBeCloseTo(0, 4);
    expect(scheduledBalance(1_000_000, 0.085, 36, 0)).toBe(1_000_000);
    expect(scheduledBalance(1_200, 0, 12, 6)).toBe(600);
    const after12 = scheduledBalance(1_000_000, 0.085, 36, 12);
    expect(after12).toBeLessThan(1_000_000 * (2 / 3) + 40_000);
    expect(after12).toBeGreaterThan(1_000_000 * (2 / 3));
  });

  it("converts days to months the way the snapshot states", () => {
    expect(termMonths(1095)).toBe(36);
    expect(termMonths(990)).toBe(33);
    expect(termMonths(1)).toBe(1);
    expect(() => termMonths(0)).toThrow();
  });

  it("rejects bad inputs", () => {
    expect(() => levelPayment(-1, 0.1, 12)).toThrow();
    expect(() => levelPayment(1, -0.1, 12)).toThrow();
    expect(() => levelPayment(1, 0.1, 0)).toThrow();
    expect(() => levelPayment(1, 0.1, 1.5)).toThrow();
    expect(() => debtServicePerGpuHour(1, 0.1, 12, 0)).toThrow();
  });
});

describe("debt service per GPU-hour", () => {
  it("reproduces the feasibility doc's loan 1008 example (about $2.26/GPU-hr)", () => {
    // 54.4M at 8.5% over 36 months on 130 B300 servers x 8 GPUs.
    const ds = debtServicePerGpuHour(54_404_473, 0.085, 36, 1040);
    expect(ds).toBeCloseTo(2.262, 2);
    expect(ds * 730).toBeCloseTo(1651, -1); // about $1,650 per GPU per month
  });
});

describe("breakeven and coverage", () => {
  it("breakeven utilization is debt service over market price", () => {
    expect(breakevenUtilization(2.26, 9.04)).toBeCloseTo(0.25, 4);
    expect(breakevenUtilization(2, 4, 1)).toBeCloseTo(0.75, 6);
    expect(breakevenUtilization(2, null)).toBeNull();
    expect(breakevenUtilization(2, 0)).toBeNull();
  });

  it("coverage is rent at the assumed utilization over debt service", () => {
    expect(coverageRatio(8, 0.7, 2)).toBeCloseTo(2.8, 6);
    expect(coverageRatio(8, 0.7, 2, 1.6)).toBeCloseTo(2, 6);
    expect(coverageRatio(null, 0.7, 2)).toBeNull();
    expect(coverageRatio(8, 0.7, 0)).toBeNull();
  });

  it("coverage at breakeven utilization is exactly 1", () => {
    const be = breakevenUtilization(2.26, 7.2)!;
    expect(coverageRatio(7.2, be, 2.26)).toBeCloseTo(1, 10);
  });
});

describe("LTV and depreciation", () => {
  it("depreciates straight line and floors at zero", () => {
    expect(depreciatedValue(100, 0, 5 * 365)).toBe(100);
    expect(depreciatedValue(100, 365, 5 * 365)).toBeCloseTo(80, 6);
    expect(depreciatedValue(100, 10 * 365, 5 * 365)).toBe(0);
    expect(depreciatedValue(100, -5, 365)).toBe(100);
    expect(() => depreciatedValue(100, 1, 0)).toThrow();
  });

  it("LTV is null without a value", () => {
    expect(ltv(54.4, 77.72)).toBeCloseTo(0.7, 2);
    expect(ltv(1, null)).toBeNull();
    expect(ltv(1, 0)).toBeNull();
  });

  it("counts whole months elapsed", () => {
    const month = (365 / 12) * 86_400;
    expect(monthsElapsed(0, month * 3.5)).toBe(3);
    expect(monthsElapsed(100, 50)).toBe(0);
  });
});

describe("median", () => {
  it("handles odd, even, empty and non-finite input", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(median([NaN, 5, Infinity])).toBe(5);
  });

  it("does not reorder its input", () => {
    const xs = [3, 1, 2];
    median(xs);
    expect(xs).toEqual([3, 1, 2]);
  });
});
