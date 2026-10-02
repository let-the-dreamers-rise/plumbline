# Paid Compute Tape

An open GPU rental price index (H100, H200, B200) built from proofs of what renters actually paid,
not what clouds advertise. Renters prove invoices with zkTLS (Reclaim zkFetch), a Solana oracle
program aggregates them, and the index feeds a compute-price perp (Hyperliquid HIP-3 testnet).

Entry for the Colosseum Crypto World's Fair hackathon (submissions due Oct 12, 2026).

## Layout

| Path | What it is |
| --- | --- |
| `packages/core` | Index math: validation, staleness, nullifier dedupe, MAD outlier rejection, 25% per-provider cap, weighted median. Reference for the onchain program. |
| `packages/prover` | zkFetch source specs, request builder (secrets stay private, only price spans revealed, account id OPRF-hashed), proof-to-observation checks, CLIs. |
| `sources/` | One JSON spec per provable paid-price source. `example-invoice.json` shows the format. |
| `proofs/` | Generated proofs (git-ignored). |

## Setup

```bash
npm install
cp .env.example .env   # then fill in RECLAIM_APP_ID and RECLAIM_APP_SECRET
npm test
```

Get the Reclaim keys by creating an app at https://dev.reclaimprotocol.org/.

## Day 1 gating test

1. **Smoke test (public data).** `npm run prove:list` proves the Azure East US 8x H100 list price
   and prints proof latency, size and $/GPU-hr. This checks the zkFetch pipeline end to end.
2. **Real invoice (the actual gate).** Rent one H100 hour on Lambda, Vast or RunPod, then:
   - In the provider console, open DevTools > Network and find the request that returns your
     billing/invoice data. Copy its URL and either the `Authorization` header or the cookie into `.env`
     (`INVOICE_URL`, `INVOICE_AUTH_HEADER` or `INVOICE_COOKIE`). Never commit `.env`.
   - `npm run probe` prints the response shape with identity strings masked, so you can see which
     fields hold the amount, hours and invoice id.
   - Copy `sources/example-invoice.json` to `sources/<provider>.json` and write regexes that capture
     `(?<amount>)` + `(?<hours>)` (or `(?<rate>)`), plus a `nullifierRule` capturing `(?<account>)`.
   - `npm run prove:invoice -- sources/<provider>.json` produces the proof. Only the captured price
     fields are revealed; the invoice id is revealed only as an OPRF hash (the nullifier).
3. `npm run verify` re-checks every saved proof's signatures and source rules and prints the H100
   paid and list index values.

Pass condition: one real paid-price proof that verifies and reveals nothing but price, hours and
the nullifier. If no provider's billing endpoint can be proven, fall back to Vast fills,
SF Compute quotes and Akash leases and call the invoice flow a contributor beta.

## Trust model (v0)

Reclaim's verifier checks attestor signatures, not a zero-knowledge proof of the TLS session, so v0
trusts Reclaim's attestor set. Hardening path: Reclaim TEE mode, k-of-n independent provers, then
aggregating attestations and the median into one SP1 proof verified on Solana.

GPU count per billed unit comes from the source spec, so a spec should also match the SKU text
(for example `8x H100`) in the response rather than relying on the config alone.
