const USD_PATTERN = /^\d+(\.\d{1,6})?$/;

/** "$1,234.56" -> 1_234_560_000 micro-USD. Strict: no negatives, exponents or >6 decimals. */
export function parseUsdToMicro(raw: string): number {
  const cleaned = raw.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!USD_PATTERN.test(cleaned)) throw new Error(`not a USD amount: ${JSON.stringify(raw)}`);
  const [whole, frac = ""] = cleaned.split(".");
  const micro = Number(whole) * 1_000_000 + Number(frac.padEnd(6, "0"));
  if (!Number.isSafeInteger(micro)) throw new Error(`USD amount out of range: ${raw}`);
  return micro;
}

export interface InvoiceLine {
  readonly totalMicroUsd: number;
  readonly hours: number;
  readonly gpuCount: number;
}

/** Normalizes an invoice line to integer micro-USD per GPU-hour. */
export function perGpuHourMicro(line: InvoiceLine): number {
  if (!Number.isSafeInteger(line.totalMicroUsd) || line.totalMicroUsd < 0) throw new Error("bad invoice total");
  if (!(line.hours > 0) || !Number.isFinite(line.hours)) throw new Error("bad invoice hours");
  if (!Number.isInteger(line.gpuCount) || line.gpuCount < 1) throw new Error("bad gpu count");
  return Math.round(line.totalMicroUsd / line.hours / line.gpuCount);
}

/** Posted-minus-paid spread, absolute and in basis points of the paid price. */
export function postedPaidSpread(postedMicro: number, paidMicro: number): { microUsd: number; bps: number } {
  if (!(paidMicro > 0)) throw new Error("paid price must be positive");
  const microUsd = postedMicro - paidMicro;
  return { microUsd, bps: Math.trunc((microUsd * 10_000) / paidMicro) };
}
