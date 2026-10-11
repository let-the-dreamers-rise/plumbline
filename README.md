# Tessera

Verified revenue for GPU-backed lending. GPU operators prove their rental revenue straight from a
third-party system of record (Razorpay payments, Stripe payouts, marketplace host earnings) with zkTLS (Reclaim
zkFetch). A Solana program checks each proof, keeps a per-loan revenue and utilization history,
and gates draws on a covenant (trailing-quarter revenue at least 1.15x debt service). Lenders read
a live feed instead of trusting PDF statements. Every proof with GPU-hours also adds realized
$/GPU-hr to an open H100 price tape, which can feed a compute-price perp (Hyperliquid HIP-3 testnet).

**The product.** Tessera (repository: paid-compute-tape) is the verification platform for GPU fleets. Operators prove, weekly, that their fleet is real NVIDIA hardware (the GPU's own attestation, chain-verified to NVIDIA's root), runs in a measured Intel TDX enclave, and earned enough to cover its debt service (zkTLS payout proofs from two attestors), all inside one RISC Zero proof. A Solana program verifies the 256-byte proof and records PASS or WATCH on the loan. Anyone can verify at `/loan/<address>`, embed `/badge/<address>.svg`, or read `/api/loan/<address>`. Pricing: $0.25 per GPU per week, charged per proof, first four proofs free; verification is free. The Tape (`/tape`) is the public H100 paid-price index built from the same proofs.

Lender flow: `npm run lending:e2e` and the dashboard (`npm run web`) on a local validator; real
Razorpay (or Stripe) test-mode proofs with `npm run prove:revenue` and `npm run loan:*` (see
`oracle/README.md`).

Entry for the Colosseum Crypto World's Fair hackathon (submissions due Oct 12, 2026).

## Layout

| Path | What it is |
| --- | --- |
| `packages/core` | Index math: validation, staleness, nullifier dedupe, MAD outlier rejection, 25% per-provider cap, weighted median. Reference for the onchain program. |
| `packages/prover` | zkFetch source specs, request builder (secrets stay private, only price spans revealed, account id OPRF-hashed), proof-to-observation checks, CLIs. |
| `sources/` | One JSON spec per provable paid-price source. `example-invoice.json` shows the format. |
| `packages/oracle` | TS client for the Solana program: price proofs, loans, revenue proofs, draws; CLIs `oracle:*` and `loan:*`. |
| `packages/web` | Product site and dashboard, read straight from Solana: product page (`/`; the Hallmark design at `/hallmark/`, the first landing at `/simple`), prove (`/prove`), docs (`/docs`), lender view (`/lender`), price tape (`/tape`), per-loan verify page (`/loan/<address>`), badge (`/badge/<address>.svg`) and JSON (`/api/loan/<address>`). Set `PCT_EVIDENCE=public` when the proofs use the published sample evidence. |
| `packages/relayer` | Pushes the onchain index to a Hyperliquid HIP-3 market (`hl:deploy`, `hl:relay`). |
| `oracle/` | Anchor program `pct_oracle` and its LiteSVM tests; prebuilt `dist/pct_oracle.so`. |
| `proofs/` | Generated proofs (git-ignored). |

## Setup

```bash
npm install
cp .env.example .env   # then fill in RECLAIM_APP_ID and RECLAIM_APP_SECRET
npm test
```

Get the Reclaim keys by creating an app at https://dev.reclaimprotocol.org/.

## Hosting the site

The `Dockerfile` runs `packages/web` (site, verify pages, badges, lead form) on `$PORT`. On Railway, from the repo root:

```bash
npm i -g @railway/cli
railway login
railway init --name tessera
railway up --detach                  # first deploy creates the service
railway service                      # link it (pick the service just created)
railway variables --set "SOLANA_RPC_URL=https://api.devnet.solana.com" --set "PCT_PROGRAM_ID=2jvEsAiBYWPeiSzb54qMgBbtbQivQkK5ZiTkp2bgZ6kz" --set "PCT_EVIDENCE=public" --set "LEADS_FILE=/data/leads.jsonl"
railway volume add --mount-path /data   # keeps leads.jsonl across deploys
railway domain                       # prints the public URL
railway up --detach                  # redeploy with the variables
```

`.railwayignore` and `.dockerignore` upload only the web workspace: no keys, `.env`, proofs or logs.

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

## License

MIT, see [LICENSE](LICENSE). The H100 attestation verifier, the Groth16 verifier program and the guest are open source and reusable.
