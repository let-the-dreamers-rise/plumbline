import type { ZkFetchRequest } from "./request.js";

/**
 * An operator revenue source: a third-party system of record (never the operator's own server).
 * `matches` are revealed: an amount (`amount` in dollars or `amount_cents`), and optionally `hours`,
 * `at` (unix seconds the revenue was earned) and `item` (a payout id, used as the nullifier).
 * `accountRule` captures the operator's account id and is OPRF-hashed, never revealed; a loan is
 * keyed by that hash. Amounts in `amount_cents` are minor units of `currency` (USD when absent).
 */
export interface RevenueSourceSpec {
  readonly name: string;
  readonly provider: number;
  readonly url: string;
  readonly matches: readonly string[];
  /** Absent when the response has no account id: the loan then binds to the claim owner. */
  readonly accountRule?: string;
  /** How the API key is sent: Stripe and Vast take a bearer token, Razorpay basic auth. */
  readonly auth: "bearer" | "basic";
}

export const VAST_HOST_PAYOUT: RevenueSourceSpec = {
  name: "vast-host-payout",
  provider: 3,
  url: "https://console.vast.ai/api/v0/users/me/host-earnings",
  matches: ['"earnings":(?<amount>[0-9.]+)', '"gpu_hours":(?<hours>[0-9.]+)'],
  accountRule: '"host_id":"(?<account>[^"]+)"',
  auth: "bearer",
};

/**
 * The latest Stripe payout. Works in test mode with a restricted key that can read payouts; use a
 * weekly payout schedule so each week has one payout. limit=1 keeps every match on the same
 * payout, dated by when it was created (arrival can be in the future). The bank account it paid
 * out to is the account id. A live deployment would also pin "livemode": true.
 */
export const STRIPE_PAYOUT: RevenueSourceSpec = {
  name: "stripe-payout",
  provider: 11,
  url: "https://api.stripe.com/v1/payouts?limit=1",
  matches: [
    '"id":\\s*"(?<item>po_[A-Za-z0-9]+)"',
    '"amount":\\s*(?<amount_cents>[0-9]+)',
    '"created":\\s*(?<at>[0-9]+)',
    '"status":\\s*"(?:paid|in_transit)"',
  ],
  accountRule: '"destination":\\s*"(?<account>(?:ba|card)_[A-Za-z0-9]+)"',
  auth: "bearer",
};

/**
 * The latest Razorpay payment (India; test mode works right after sign-up with test keys).
 * count=1 keeps every match on one payment, which must be captured and not refunded; the payment
 * id is the nullifier and amounts are paise in INR. Razorpay payment responses carry no merchant
 * id, so the loan binds to the claim owner: the operator's own Reclaim app, which is the only
 * holder of the Razorpay key secret it proves with. A lender wanting a hard binding should route
 * settlements to an escrow (Razorpay Route or a virtual account) it controls.
 */
export const RAZORPAY_PAYMENT: RevenueSourceSpec = {
  name: "razorpay-payment",
  provider: 12,
  url: "https://api.razorpay.com/v1/payments?count=1",
  matches: [
    '"id":\\s*"(?<item>pay_[A-Za-z0-9]+)"',
    '"amount":\\s*(?<amount_cents>[0-9]+)',
    '"currency":\\s*"(?<currency>[A-Z]{3})"',
    '"status":\\s*"captured"',
    '"amount_refunded":\\s*0[,}]',
    '"created_at":\\s*(?<at>[0-9]+)',
  ],
  auth: "basic",
};

export const REVENUE_SOURCES: readonly RevenueSourceSpec[] = [VAST_HOST_PAYOUT, STRIPE_PAYOUT, RAZORPAY_PAYMENT];

const rules = (spec: RevenueSourceSpec): string[] => [...spec.matches, ...(spec.accountRule ? [spec.accountRule] : [])];

export function revenueSpec(name: string): RevenueSourceSpec {
  const spec = REVENUE_SOURCES.find((s) => s.name === name || s.name.startsWith(`${name}-`));
  if (!spec) throw new Error(`unknown revenue source "${name}" (have: ${REVENUE_SOURCES.map((s) => s.name).join(", ")})`);
  return spec;
}

/** zkFetch call for a revenue source. `authHeader` ("Bearer rk_test_..." or "Basic ...") stays hidden. */
export function buildRevenueRequest(spec: RevenueSourceSpec, authHeader: string): ZkFetchRequest {
  return {
    url: spec.url,
    publicOptions: { method: "GET", headers: {} },
    secretOptions: {
      headers: { Authorization: authHeader },
      responseMatches: rules(spec).map((value) => ({ type: "regex", value })),
      responseRedactions: [
        ...spec.matches.map((regex) => ({ regex })),
        ...(spec.accountRule ? [{ regex: spec.accountRule, hash: "oprf-raw" as const }] : []),
      ],
    },
  };
}

/** Throws unless a proof's parameters are for this spec's URL and enforce every one of its rules. */
export function assertRevenueProofMatches(parameters: string, spec: RevenueSourceSpec): void {
  const p = JSON.parse(parameters) as { url?: string; responseMatches?: { type: string; value: string }[] };
  if (p.url !== spec.url) throw new Error(`proof is for ${p.url}, not ${spec.url}`);
  const enforced = new Set((p.responseMatches ?? []).filter((m) => m.type === "regex").map((m) => m.value));
  const missing = rules(spec).filter((r) => !enforced.has(r));
  if (missing.length > 0) throw new Error(`proof does not enforce: ${missing.join(", ")}`);
}
