import type { SourceSpec } from "./specs.js";

export interface Secrets {
  /** Full header value, e.g. "Bearer abc" (sent as Authorization). Hidden from the verifier. */
  readonly authHeader?: string;
  readonly cookie?: string;
}

export interface ZkFetchRequest {
  readonly url: string;
  readonly publicOptions: { method: "GET"; headers: Record<string, string> };
  readonly secretOptions: {
    headers?: Record<string, string>;
    cookieStr?: string;
    responseMatches: { type: "regex"; value: string }[];
    responseRedactions: { regex: string; hash?: "oprf-raw" }[];
  };
}

/**
 * Builds the zkFetch call for a spec. Redactions reveal only the matched spans, so the
 * verifier sees the price fields and nothing else; the account id is OPRF-hashed.
 */
export function buildZkFetchRequest(spec: SourceSpec, secrets: Secrets = {}): ZkFetchRequest {
  const rules = spec.matches.map((m) => m.regex);
  const nullifier = spec.nullifierRule?.regex;
  return {
    url: spec.url,
    publicOptions: { method: "GET", headers: { ...(spec.headers ?? {}) } },
    secretOptions: {
      ...(secrets.authHeader ? { headers: { Authorization: secrets.authHeader } } : {}),
      ...(secrets.cookie ? { cookieStr: secrets.cookie } : {}),
      responseMatches: [...rules, ...(nullifier ? [nullifier] : [])].map((value) => ({ type: "regex", value })),
      responseRedactions: [
        ...rules.map((regex) => ({ regex })),
        ...(nullifier ? [{ regex: nullifier, hash: "oprf-raw" as const }] : []),
      ],
    },
  };
}
