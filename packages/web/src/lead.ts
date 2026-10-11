/**
 * Lead form (POST /api/lead). Accepts JSON from the page script and a plain
 * application/x-www-form-urlencoded post from the same form with JavaScript off.
 */
export interface Lead {
  readonly email: string;
  readonly fleetGpus: number;
  readonly lender: string;
  readonly note: string;
  readonly at: number;
}

export type LeadResult = { readonly ok: true; readonly lead: Lead } | { readonly ok: false; readonly status: 400 | 415; readonly error: string };

export const LEAD_BODY_LIMIT = 4096;
const EMAIL_MAX = 200;
const TEXT_MAX = 500;
const FLEET_MAX = 10_000_000;
// Deliberately loose (one @, a dot in the domain, no spaces); the reply email is the real check.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type BodyKind = "json" | "form" | null;

/** Which body format a Content-Type header names; null for anything else. */
export function bodyKind(contentType: string | undefined): BodyKind {
  const mime = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (mime === "application/json") return "json";
  if (mime === "application/x-www-form-urlencoded") return "form";
  return null;
}

function fields(raw: string, kind: "json" | "form"): Record<string, unknown> | null {
  if (kind === "form") return Object.fromEntries(new URLSearchParams(raw));
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

function fleet(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : 0;
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), FLEET_MAX) : 0;
}

/** Validates a lead body; never throws. `nowS` is the receive time in unix seconds. */
export function parseLead(raw: string, contentType: string | undefined, nowS: number): LeadResult {
  const kind = bodyKind(contentType);
  if (!kind) return { ok: false, status: 415, error: "send JSON or a form post" };
  const b = fields(raw, kind);
  if (!b) return { ok: false, status: 400, error: "body is not a JSON object" };
  const email = text(b.email, EMAIL_MAX + 1);
  if (email.length > EMAIL_MAX || !EMAIL.test(email)) return { ok: false, status: 400, error: "a valid email is needed" };
  return { ok: true, lead: { email, fleetGpus: fleet(b.fleetGpus), lender: text(b.lender, TEXT_MAX), note: text(b.note, TEXT_MAX), at: nowS } };
}

/**
 * Where a no-JS form post goes back to: the page it came from (path only, so a forged Referer
 * cannot redirect off-site), with ?lead=thanks|error and the form's #lead anchor.
 */
export function leadRedirect(referer: string | undefined, outcome: "thanks" | "error"): string {
  let path = "/";
  try {
    const p = new URL(referer ?? "/", "http://localhost").pathname;
    if (p.startsWith("/") && !p.startsWith("//") && !p.startsWith("/api/")) path = p;
  } catch {
    path = "/";
  }
  return `${path}?lead=${outcome}#lead`;
}
