import { createSignDataForClaim, getIdentifierFromClaimInfo } from "@reclaimprotocol/js-sdk";
import { Wallet, getBytes, keccak256, toUtf8Bytes } from "ethers";
import type { ReclaimProof } from "./claim.js";
import { KIND_IDS, VALUE_MODE_AMOUNT_HOURS, type SourceArgs } from "./program.js";
import { buildRevenueRequest, type RevenueSourceSpec } from "@pct/prover";

export { RAZORPAY_PAYMENT, REVENUE_SOURCES, STRIPE_PAYOUT, VAST_HOST_PAYOUT, type RevenueSourceSpec } from "@pct/prover";

/**
 * A claim parameters string for this source in zkFetch's shape, used for test fixtures. Register
 * real sources from a real proof's own parameters string instead (revenueSourceArgs(spec, it)).
 */
export function revenueParameters(s: RevenueSourceSpec): string {
  const { secretOptions } = buildRevenueRequest(s, "");
  return JSON.stringify({
    body: "",
    method: "GET",
    responseMatches: secretOptions.responseMatches,
    responseRedactions: secretOptions.responseRedactions,
    url: s.url,
  });
}

/**
 * Registration args; `parameters` is the exact parameters string the source's proofs carry. The
 * source id is keccak("name:paramsHash"), so a change in zkFetch's parameters shape registers a new
 * source instead of colliding with the old, immutable one.
 */
export function revenueSourceArgs(s: RevenueSourceSpec, parameters: string = revenueParameters(s)): SourceArgs {
  const paramsHash = keccak256(toUtf8Bytes(parameters));
  return {
    sourceId: getBytes(keccak256(toUtf8Bytes(`${s.name}:${paramsHash}`))),
    paramsHash: getBytes(paramsHash),
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
export const TEST_OWNER = "0x" + "ab".repeat(20);

/** Signs a revenue claim with the test attestor using Reclaim's own sign-data and identifier code. */
export async function signTestRevenueClaim(
  source: RevenueSourceSpec,
  extracted: Record<string, string>,
  timestampS: number,
  owner: string = TEST_OWNER,
): Promise<ReclaimProof> {
  const context = JSON.stringify({
    contextAddress: "0x0000000000000000000000000000000000000000",
    contextMessage: "",
    extractedParameters: Object.fromEntries(Object.entries(extracted).sort(([a], [b]) => (a < b ? -1 : 1))),
    providerHash: "0x" + "00".repeat(32),
  });
  const claimData = { provider: "http", parameters: revenueParameters(source), context, owner, timestampS, epoch: 1 };
  return {
    identifier: getIdentifierFromClaimInfo(claimData),
    claimData,
    signatures: [await TEST_ATTESTOR.signMessage(createSignDataForClaim(claimData))],
    witnesses: [{ id: TEST_ATTESTOR.address.toLowerCase() }],
  };
}
