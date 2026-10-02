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
`df63dddc8cf9998f9d098cb5bdd9f6b2648adfd5905f4134423bd21e044ec9f3`.

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

## Operator revenue proofs for GPU lenders

GPU operators prove their own rental revenue (Stripe balance, Vast host payouts) through the same
zkTLS pipeline, and a lender reads a per-borrower feed and gates draws on it.

- **`open_loan(terms)`** creates a `Loan` PDA at `["loan", keccak(account id)]`: lender, borrower
  wallet, SKU, fleet size, period length, debt service per period, minimum coverage (11500 bps =
  USD.AI's 1.15x). It keeps the last 13 periods of proven revenue and GPU-hours.
- **`submit_revenue(sig)`** takes a claim from a `kind = 2` (revenue) source. It runs the same
  attestor, source-pin and freshness checks as `submit_observation`, then requires
  `keccak(extracted "account") == loan.operator_key`. The receipt is keyed on
  `keccak(operator_key || period)`, so each source counts once per operator per period. When the
  claim carries `hours`, realized rent (amount / hours) is also pushed into the paid H100 book, so
  every revenue proof feeds the price tape. Emits `RevenueProven` with period and trailing coverage.
- **`fund_loan` / `draw`** is a toy vault: the borrower can draw only while the latest proof is for
  the current or previous period and trailing-quarter revenue (missing periods count as zero) is
  at least the minimum coverage of debt service.
- Trust edge: an operator's own export is self-reported, so revenue sources must be pinned to a
  third-party system of record (Stripe, the marketplace payout API), never the operator's server.

CU: `submit_revenue` 84k-88k, `draw` 8.8k. Fixtures: `npx tsx scripts/make-revenue-fixtures.ts`.
