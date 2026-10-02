import { createSignDataForClaim, getIdentifierFromClaimInfo } from "@reclaimprotocol/js-sdk";
import { Wallet, getBytes, keccak256, toUtf8Bytes } from "ethers";
import type { ReclaimProof } from "./claim.js";
import { KIND_IDS, VALUE_MODE_AMOUNT_HOURS, type SourceArgs } from "./program.js";

/**
 * An operator revenue source: a third-party system of record (never the operator's own server)
 * whose response exposes `account`, an amount (`amount` in dollars or `amount_cents`), and
 * optionally `hours`, `at` (unix seconds the revenue was earned) and `item` (a payout id nullifier).
 */
export interface RevenueSourceSpec {
  readonly name: string;
  readonly provider: number;
  readonly url: string;
  readonly matches: readonly string[];
}

export const VAST_HOST_PAYOUT: RevenueSourceSpec = {
  name: "vast-host-payout",
  provider: 3,
  url: "https://console.vast.ai/api/v0/users/me/host-earnings",
  matches: ['"earnings":(?<amount>[0-9.]+)', '"gpu_hours":(?<hours>[0-9.]+)', '"host_id":"(?<account>[^"]+)"'],
};

/**
 * Latest Stripe payout (weekly payout schedule; works in test mode with a restricted key that can
 * read payouts). limit=1 keeps every match on the same payout; the payout id is the nullifier and
 * its arrival date picks the loan period. A live deployment would also pin "livemode": true.
 */
export const STRIPE_PAYOUT: RevenueSourceSpec = {
  name: "stripe-payout",
  provider: 11,
  url: "https://api.stripe.com/v1/payouts?limit=1",
  matches: [
    '"id":\\s*"(?<item>po_[A-Za-z0-9]+)"',
    '"amount":\\s*(?<amount_cents>[0-9]+)',
    '"arrival_date":\\s*(?<at>[0-9]+)',
    '"destination":\\s*"(?<account>ba_[A-Za-z0-9]+)"',
    '"status":\\s*"(?:paid|in_transit)"',
  ],
};

export const REVENUE_SOURCES = [VAST_HOST_PAYOUT, STRIPE_PAYOUT] as const;

/** The claim parameters string a zkFetch of this source carries (its keccak is the source pin). */
export function revenueParameters(s: RevenueSourceSpec): string {
  return JSON.stringify({
    body: "",
    method: "GET",
    responseMatches: s.matches.map((value) => ({ type: "regex", value })),
    responseRedactions: s.matches.map((regex) => ({ regex })),
    url: s.url,
  });
}

export function revenueSourceArgs(s: RevenueSourceSpec): SourceArgs {
  return {
    sourceId: getBytes(keccak256(toUtf8Bytes(s.name))),
    paramsHash: getBytes(keccak256(toUtf8Bytes(revenueParameters(s)))),
    providerId: s.provider,
    sku: 0,
    kind: KIND_IDS.revenue,
    gpuCount: 1,
    valueMode: VALUE_MODE_AMOUNT_HOURS,
    requiresNullifier: true,
  };
}

/** Deterministic TEST attestor shared with the Rust fixtures. Never register it on a real deployment. */
export const TEST_ATTESTOR = new Wallet(keccak256(toUtf8Bytes("pct-test-attestor")));
const TEST_OWNER = "0x" + "ab".repeat(20);

/** Signs a revenue claim with the test attestor using Reclaim's own sign-data and identifier code. */
export async function signTestRevenueClaim(
  source: RevenueSourceSpec,
  extracted: Record<string, string>,
  timestampS: number,
): Promise<ReclaimProof> {
  const context = JSON.stringify({
    contextAddress: "0x0000000000000000000000000000000000000000",
    contextMessage: "",
    extractedParameters: Object.fromEntries(Object.entries(extracted).sort(([a], [b]) => (a < b ? -1 : 1))),
    providerHash: "0x" + "00".repeat(32),
  });
  const claimData = { provider: "http", parameters: revenueParameters(source), context, owner: TEST_OWNER, timestampS, epoch: 1 };
  return {
    identifier: getIdentifierFromClaimInfo(claimData),
    claimData,
    signatures: [await TEST_ATTESTOR.signMessage(createSignDataForClaim(claimData))],
    witnesses: [{ id: TEST_ATTESTOR.address.toLowerCase() }],
  };
}
