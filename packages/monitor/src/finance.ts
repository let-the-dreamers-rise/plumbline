/**
 * Loan math for the monitor. All functions are pure and documented with the assumption they make; the
 * snapshot repeats the assumptions next to the numbers.
 */

/** Months in a term of `days` days (1095 days is 36 months). */
export function termMonths(days: number): number {
  if (!(days > 0) || !Number.isFinite(days)) throw new Error(`term must be a positive number of days, got ${days}`);
  return Math.max(1, Math.round((days * 12) / 365));
}

/**
 * Level monthly payment that fully amortizes `principal` over `months` at `apr` (a fraction, compounded
 * monthly): P * r / (1 - (1 + r)^-n) with r = apr / 12. With apr 0 it is P / n.
 */
export function levelPayment(principal: number, apr: number, months: number): number {
  if (!(principal >= 0) || !Number.isFinite(principal)) throw new Error(`principal must be >= 0, got ${principal}`);
  if (!(apr >= 0) || !Number.isFinite(apr)) throw new Error(`apr must be >= 0, got ${apr}`);
  if (!Number.isInteger(months) || months < 1) throw new Error(`months must be a positive integer, got ${months}`);
  const r = apr / 12;
  return r === 0 ? principal / months : (principal * r) / (1 - (1 + r) ** -months);
}

/** Balance left after `paid` level payments on the same schedule. */
export function scheduledBalance(principal: number, apr: number, months: number, paid: number): number {
  const k = Math.min(Math.max(0, Math.floor(paid)), months);
  const r = apr / 12;
  if (r === 0) return principal * (1 - k / months);
  const pmt = levelPayment(principal, apr, months);
  return principal * (1 + r) ** k - (pmt * ((1 + r) ** k - 1)) / r;
}

/** Debt service per GPU-hour: the level monthly payment spread over every GPU and every hour of the month. */
export function debtServicePerGpuHour(principal: number, apr: number, months: number, gpus: number, hoursPerMonth = 730): number {
  if (!(gpus > 0)) throw new Error(`gpus must be positive, got ${gpus}`);
  return levelPayment(principal, apr, months) / gpus / hoursPerMonth;
}

/** Utilization at which market rent equals debt service (1 = every hour rented). Null without a price. */
export function breakevenUtilization(debtServicePerGpuHr: number, marketPerGpuHr: number | null, opexPerGpuHr = 0): number | null {
  if (marketPerGpuHr === null || !(marketPerGpuHr > 0)) return null;
  return (debtServicePerGpuHr + opexPerGpuHr) / marketPerGpuHr;
}

/** Coverage: (market rent x utilization - opex) / debt service, all per GPU-hour. Null without a price. */
export function coverageRatio(marketPerGpuHr: number | null, utilization: number, debtServicePerGpuHr: number, opexPerGpuHr = 0): number | null {
  if (marketPerGpuHr === null || !(debtServicePerGpuHr > 0)) return null;
  return (marketPerGpuHr * utilization - opexPerGpuHr) / debtServicePerGpuHr;
}

/** Straight-line value after `ageDays` of a `lifeDays` life, floored at zero. */
export function depreciatedValue(value: number, ageDays: number, lifeDays: number): number {
  if (!(lifeDays > 0)) throw new Error(`life must be positive, got ${lifeDays}`);
  return value * Math.max(0, 1 - Math.max(0, ageDays) / lifeDays);
}

/** Loan-to-value, or null when the value is unknown or zero. */
export function ltv(owed: number, value: number | null): number | null {
  return value !== null && value > 0 ? owed / value : null;
}

/** Median of finite numbers; null for an empty list. */
export function median(xs: readonly number[]): number | null {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (s.length === 0) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Whole months elapsed since `fromS` (average month of 365/12 days). */
export function monthsElapsed(fromS: number, nowS: number): number {
  return Math.max(0, Math.floor((nowS - fromS) / ((365 / 12) * 86_400)));
}

/** Rounds for display in JSON without float noise. */
export const round = (x: number, dp: number): number => Math.round(x * 10 ** dp) / 10 ** dp;
