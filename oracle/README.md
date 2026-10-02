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
`npm run lending:e2e` then runs the lender flow: open and fund a loan, prove last week's Vast and
Stripe revenue, draw, reject the same payout twice, prove a weak week, and get the draw refused.
(`--limit-ledger-size` keeps transaction history, which the dashboard reads.)

## Dashboard

```bash
SOLANA_RPC_URL=http://127.0.0.1:8899 npm run web   # http://localhost:8787
```

`/` is the lender view: per loan, trailing-quarter coverage against the covenant, latest week's
revenue, utilization and realized $/GPU-hr, proven revenue by week against the debt-service line,
each revenue proof with a "Verify" walkthrough, and draws. `/tape` is the price tape: it shows the paid index against the proven list price, every accepted proof with its transaction,
a per-proof "Verify" walkthrough, and an off-chain recompute of the index (TypeScript reference
math with the onchain config) that must match the onchain value.

## Deploy to devnet

`dist/pct_oracle.so` is a prebuilt copy of the program for id `2jvEsAiBYWPeiSzb54qMgBbtbQivQkK5ZiTkp2bgZ6kz`
(Agave 3.1.14, platform-tools v1.52), so a machine with only the Solana CLI can deploy it without
compiling. Rebuild and recopy it whenever the program changes. sha256:
`d0ce2176295c15d70a192d9131d79ce62ab883fabe520f4e4e0520490d8b026c`.

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

GPU operators prove their own rental revenue (Stripe payouts, Vast host earnings) through the same
zkTLS pipeline, and a lender reads a per-borrower feed and gates draws on it.

- **`open_loan(terms)`** creates a `Loan` PDA at `["loan", keccak(account id)]`: lender, borrower
  wallet, SKU, fleet size, period length, debt service per period, minimum coverage (11500 bps =
  USD.AI's 1.15x). It keeps the last 13 periods of proven revenue and GPU-hours.
- **`submit_revenue(sig, receipt_key)`** takes a claim from a `kind = 2` (revenue) source. It runs
  the same attestor, source-pin and freshness checks as `submit_observation`, then requires
  `keccak(extracted "account") == loan.operator_key` (the account is OPRF-hashed in real proofs).
  - Amount: `amount` in dollars or `amount_cents` (Stripe). Optional `hours` gives utilization and
    realized rent, which is also pushed into the paid H100 book, so revenue proofs feed the tape.
  - Dating: an extracted `at` (Stripe payout `created`) picks the period, else the proof time.
  - Nullifier: an extracted `item` (payout id) makes each payout count once, whenever it is
    proven; sources without one count once per operator per period.
  - Emits `RevenueProven` with the period and trailing coverage.
- **`fund_loan` / `draw`** is a toy vault: the borrower can draw only while the latest proof is for
  the current or previous period and trailing-quarter revenue (missing periods count as zero) is
  at least the minimum coverage of debt service.
- Revenue source ids are `keccak("name:paramsHash")`, so a change in zkFetch's parameter shape
  registers a new source instead of hitting the old immutable one.
- Trust edge: an operator's own export is self-reported, so revenue sources must be pinned to a
  third-party system of record (Stripe, the marketplace payout API), never the operator's server.

CU on a local validator: `submit_revenue` 108k-123k, `draw` 8.8k.

### Real proof from a Stripe test account (laptop)

1. Create a free Stripe account and stay in **test mode**. Make a test payment with card
   `4000 0000 0000 0077` (funds become available at once), then Balance > **Pay out**. If it asks
   for a bank account, use test routing `110000000` and account `000123456789`.
2. Developers > API keys > **Create restricted key** with Payouts: Read. Put it in `.env` as
   `STRIPE_KEY=rk_test_...` next to the Reclaim keys.
3. `npm run prove:revenue` proves the latest payout and saves `proofs/revenue/stripe-payout-*.json`.
   It reveals only the payout id, amount, creation time and an OPRF hash of the bank account.
4. With `SOLANA_RPC_URL` and `SOLANA_KEYPAIR` set for devnet:
   `npm run loan:open <proof file>` (registers the source, adds the attestor, opens and funds a
   loan with your wallet as borrower), `npm run loan:submit <proof file>`, `npm run loan:draw 0.5`,
   `npm run loan:show`. Terms come from `LOAN_*` env vars (see `packages/oracle/src/cli/loan.ts`).
