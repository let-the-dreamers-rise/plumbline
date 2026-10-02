import { describeShape } from "../probe.js";
import { loadEnv, optionalEnv, requireEnv } from "../env.js";

// Plain fetch (no proof) of a billing endpoint to see its shape. Identity strings are masked.
loadEnv();
const url = process.argv[2] ?? requireEnv("INVOICE_URL");
const headers: Record<string, string> = { accept: "application/json" };
const auth = optionalEnv("INVOICE_AUTH_HEADER");
const cookie = optionalEnv("INVOICE_COOKIE");
if (auth) headers.Authorization = auth;
if (cookie) headers.Cookie = cookie;

const res = await fetch(url, { headers });
console.log(`HTTP ${res.status} ${res.headers.get("content-type") ?? ""}`);
const text = await res.text();
try {
  console.log(describeShape(JSON.parse(text)).join("\n"));
} catch {
  console.log(`Not JSON (${text.length} bytes). zkFetch can still prove HTML with regex matches.`);
}
