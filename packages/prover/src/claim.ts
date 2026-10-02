import { parseUsdToMicro, perGpuHourMicro, type Observation } from "@pct/core";
import type { SourceSpec } from "./specs.js";

/** The parts of a Reclaim proof this module reads. Signatures are checked separately. */
export interface ProofLike {
  readonly identifier: string;
  readonly claimData: {
    readonly parameters: string;
    readonly context: string;
    readonly timestampS: number;
  };
  readonly extractedParameterValues?: Record<string, string>;
}

interface ClaimParams {
  url: string;
  responseMatches?: { type: string; value: string }[];
  responseRedactions?: { regex?: string; hash?: string }[];
}

function parseJson<T>(raw: string, what: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`proof ${what} is not valid JSON`);
  }
}

function extracted(proof: ProofLike): Record<string, string> {
  const ctx = parseJson<{ extractedParameters?: Record<string, string> }>(proof.claimData.context, "context");
  return { ...(ctx.extractedParameters ?? {}), ...(proof.extractedParameterValues ?? {}) };
}

/** Every rule in the spec must appear as a regex match the attestor enforced. */
function assertMatchesSpec(params: ClaimParams, spec: SourceSpec): void {
  const enforced = new Set((params.responseMatches ?? []).filter((m) => m.type === "regex").map((m) => m.value));
  const required = [...spec.matches, ...(spec.nullifierRule ? [spec.nullifierRule] : [])];
  const missing = required.filter((r) => !enforced.has(r.regex));
  if (missing.length > 0) throw new Error(`proof does not enforce spec rule(s): ${missing.map((m) => m.regex).join(", ")}`);
}

function priceFrom(values: Record<string, string>, spec: SourceSpec): number {
  if (values.rate !== undefined) {
    return perGpuHourMicro({ totalMicroUsd: parseUsdToMicro(values.rate), hours: 1, gpuCount: spec.gpuCount });
  }
  if (values.amount !== undefined && values.hours !== undefined) {
    const hours = Number(values.hours);
    return perGpuHourMicro({ totalMicroUsd: parseUsdToMicro(values.amount), hours, gpuCount: spec.gpuCount });
  }
  throw new Error("proof exposes neither rate nor amount+hours");
}

/**
 * Turns a (signature-verified) proof into an index observation, rejecting proofs whose
 * URL or enforced match rules differ from the registered source spec.
 */
export function proofToObservation(proof: ProofLike, specs: readonly SourceSpec[]): Observation {
  const params = parseJson<ClaimParams>(proof.claimData.parameters, "parameters");
  const spec = specs.find((s) => typeof params.url === "string" && params.url.startsWith(s.urlPrefix));
  if (!spec) throw new Error(`no registered source for ${params.url}`);
  assertMatchesSpec(params, spec);
  const values = extracted(proof);
  if (spec.nullifierRule && !values.account) throw new Error("proof is missing its account nullifier");
  return {
    sourceId: proof.identifier,
    provider: spec.provider,
    sku: spec.sku,
    kind: spec.kind,
    microUsdPerGpuHour: priceFrom(values, spec),
    observedAtS: proof.claimData.timestampS,
    weight: 1,
    nullifier: spec.nullifierRule ? values.account : undefined,
  };
}
