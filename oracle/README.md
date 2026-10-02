# pct_oracle

Solana program that verifies Reclaim zkTLS claims of GPU prices onchain and publishes a
paid-price index per (SKU, kind). The TypeScript client and CLIs live in `packages/oracle`.

## Build and test (Linux or WSL)

Needs Rust 1.89 (pinned in `rust-toolchain.toml`) and the Agave 3.1 CLI. If `release.anza.xyz`
is unreachable, the same release is on GitHub:
`https://github.com/anza-xyz/agave/releases/download/v3.1.14/solana-release-x86_64-unknown-linux-gnu.tar.bz2`.

```bash
cargo build-sbf --manifest-path programs/pct_oracle/Cargo.toml   # writes target/deploy/pct_oracle.so
cargo test -- --nocapture                                        # 15 unit + 4 LiteSVM flow tests
```

The flow tests load `target/deploy/pct_oracle.so`, so build first.

## End to end on a local validator

```bash
solana-test-validator --reset --limit-ledger-size 50000000 --bpf-program 2jvEsAiBYWPeiSzb54qMgBbtbQivQkK5ZiTkp2bgZ6kz target/deploy/pct_oracle.so
npm run oracle:e2e   # from the repo root, in another terminal
```

This registers the five fixture sources, submits the fixture claims, checks that a reused
invoice is rejected, cranks both H100 books and expects a live paid index of $2.49.
(`--limit-ledger-size` keeps transaction history, which the dashboard reads.)

## Dashboard

```bash
SOLANA_RPC_URL=http://127.0.0.1:8899 npm run web   # http://localhost:8787
```

Shows the paid index against the proven list price, every accepted proof with its transaction,
a per-proof "Verify" walkthrough, and an off-chain recompute of the index (TypeScript reference
math with the onchain config) that must match the onchain value.

## Deploy to devnet

`dist/pct_oracle.so` is a prebuilt copy of the program for id `2jvEsAiBYWPeiSzb54qMgBbtbQivQkK5ZiTkp2bgZ6kz`
(Agave 3.1.14, platform-tools v1.52), so a machine with only the Solana CLI can deploy it without
compiling. Rebuild and recopy it whenever the program changes. sha256:
`82714ac89ebd691ff5a32c908dfcf20ed85b7d27db58791344f56ea568539f37`.

The program id is fixed by `declare_id!` in `src/lib.rs`, so deploying needs the keypair whose
public key is `2jvEsAiBYWPeiSzb54qMgBbtbQivQkK5ZiTkp2bgZ6kz` (Anchor created it where the program
was first built, usually `target/deploy/pct_oracle-keypair.json` under that build's target dir).
If it is lost, make a new one, put its public key in `declare_id!` and `Anchor.toml`, rebuild,
and set `PCT_PROGRAM_ID` for the CLIs.

```bash
solana config set --url devnet
solana airdrop 2   # repeat or use https://faucet.solana.com; the program needs about 2.4 SOL of rent
solana program deploy dist/pct_oracle.so --program-id target/deploy/pct_oracle-keypair.json
```

## Feed it real proofs (from the repo root)

```bash
npm run prove:list            # and/or prove:invoice; proofs land in proofs/
npm run oracle:init           # config (attestors from the proofs), books, one source per spec
npm run oracle:submit         # uploads and submits every proof; reused invoices are refused
npm run oracle:crank          # recomputes each book and prints the index
```

The CLIs read `SOLANA_RPC_URL` (default devnet), `SOLANA_KEYPAIR` (default
`~/.config/solana/id.json`) and optionally `PCT_PROGRAM_ID` and `PCT_ATTESTORS`.

A source is pinned to the exact claim parameters of the first proof `oracle:init` sees for it,
so later proofs of that source must use the same URL and match rules (otherwise `ParamsMismatch`).

## Operator revenue proofs (possible pivot): what already fits and what doesn't

An operator proving rental revenue from their own billing system goes through the same zkTLS ->
`submit_observation` path as a renter's invoice, with these differences:

- **Fits as is.** Source registration (URL + match rules pinned by `params_hash`), attestor
  signature checks, and parsing `amount` + `hours` into $/GPU-hr (`VALUE_MODE_AMOUNT_HOURS`) work
  for a provider-side billing export unchanged. The TS client, CLIs and dashboard read the same
  accounts.
- **Breaks: receipts.** A paid source's receipt key is `keccak(account)`, so one account can be
  submitted only once. An operator reporting every period would be refused after the first
  report. Fix: key on `keccak(account || period)` with a `period` field captured from the response
  (or the claim timestamp bucketed to a period).
- **Missing: per-operator history.** Observations fold into one `Book` per (SKU, kind), a ring of
  32 prices. Lenders want a feed per borrower (revenue, utilization, $/GPU-hr over time). That
  needs a per-operator account keyed by the hashed account id, plus a third `kind` (operator
  revenue) so it never mixes into the renter price index.
- **Different trust edge.** A renter's invoice is adverse to the provider; an operator's own
  revenue export is self-reported by the borrower, so the source pin must point at a third-party
  system of record (Stripe, the marketplace payout API), not the operator's own server.
