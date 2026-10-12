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
 * The latest Stripe payout. limit=1 keeps every match on the same payout, dated by when it was
 * created. The bank account it paid out to is the account id. Only `paid` payouts count.
 *
 * Every rule is anchored to the payout's own fields by Stripe's pretty-printing: they sit on lines
 * indented by exactly six spaces, while operator-set `metadata` keys sit deeper and JSON strings
 * cannot hold raw newlines. Without that, a metadata key such as "status": "paid" on a pending
 * payout would satisfy the status rule (keys after `metadata` sort later). `livemode` is pinned, so
 * test-mode payouts (free to fake) and live ones are different sources.
 */
function stripePayout(live: boolean): RevenueSourceSpec {
  const field = (rule: string) => `\\n {6}${rule}`;
  return {
    name: live ? "stripe-payout" : "stripe-payout-test",
    provider: 11,
    url: "https://api.stripe.com/v1/payouts?limit=1",
    matches: [
      field('"id":\\s*"(?<item>po_[A-Za-z0-9]+)"'),
      field('"amount":\\s*(?<amount_cents>[0-9]+)'),
      field('"created":\\s*(?<at>[0-9]+)'),
      field('"currency":\\s*"(?<currency>[a-z]{3})"'),
      field(`"livemode":\\s*${live}`),
      field('"status":\\s*"paid"'),
    ],
    accountRule: field('"destination":\\s*"(?<account>(?:ba|card)_[A-Za-z0-9]+)"'),
    auth: "bearer",
  };
}

export const STRIPE_PAYOUT = stripePayout(true);
export const STRIPE_PAYOUT_TEST = stripePayout(false);

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

export const REVENUE_SOURCES: readonly RevenueSourceSpec[] = [VAST_HOST_PAYOUT, STRIPE_PAYOUT, STRIPE_PAYOUT_TEST, RAZORPAY_PAYMENT];

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

/**
 * Throws unless a proof's parameters are exactly this spec's request: same URL and method, an
 * empty body, every spec rule enforced as a plain (non-inverted) regex and no other rule, and
 * redactions that reveal only the rules' spans (the account span OPRF-hashed). A source registered
 * from such parameters cannot be loosened by whoever made the proof file.
 */
export function assertRevenueProofMatches(parameters: string, spec: RevenueSourceSpec): void {
  const p = JSON.parse(parameters) as Record<string, unknown>;
  const fail = (why: string): never => {
    throw new Error(`proof parameters do not match ${spec.name}: ${why}`);
  };
  // Keys zkFetch may add that do not change what is checked.
  const benign: Record<string, (v: unknown) => boolean> = {
    url: (v) => v === spec.url,
    method: (v) => v === "GET",
    body: (v) => v === "" || v === undefined,
    geoLocation: (v) => v === "" || v === undefined,
    headers: (v) => v === undefined || (typeof v === "object" && v !== null && Object.keys(v).length === 0),
    paramValues: (v) => v === undefined || (typeof v === "object" && v !== null && Object.keys(v).length === 0),
    responseMatches: () => true,
    responseRedactions: () => true,
  };
  for (const [k, v] of Object.entries(p)) {
    const ok = benign[k];
    if (!ok) fail(`unexpected parameter "${k}"`);
    else if (!ok(v)) fail(`unexpected value for "${k}"`);
  }
  if (p.url !== spec.url) fail(`url is ${String(p.url)}`);

  const want = rules(spec);
  const matches = (p.responseMatches ?? []) as Record<string, unknown>[];
  for (const m of matches) {
    const extra = Object.keys(m).filter((k) => k !== "type" && k !== "value" && !(k === "invert" && m.invert === false));
    if (m.type !== "regex" || extra.length > 0) fail(`match ${JSON.stringify(m)} is not a plain regex`);
  }
  const got = matches.map((m) => m.value as string).sort();
  if (JSON.stringify(got) !== JSON.stringify([...want].sort())) fail("responseMatches differ from the spec's rules");

  const redactions = (p.responseRedactions ?? []) as Record<string, unknown>[];
  for (const r of redactions) {
    const isAccount = r.regex === spec.accountRule;
    const keys = Object.keys(r).sort().join(",");
    const ok = isAccount ? keys === "hash,regex" && r.hash === "oprf-raw" : keys === "regex" && spec.matches.includes(r.regex as string);
    if (!ok) fail(`redaction ${JSON.stringify(r)} is not one of the spec's`);
  }
  if (redactions.length !== want.length) fail("responseRedactions differ from the spec's rules");
}
