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
solana-test-validator --reset --bpf-program 2jvEsAiBYWPeiSzb54qMgBbtbQivQkK5ZiTkp2bgZ6kz target/deploy/pct_oracle.so
npm run oracle:e2e   # from the repo root, in another terminal
```

This registers the five fixture sources, submits the fixture claims, checks that a reused
invoice is rejected, cranks both H100 books and expects a live paid index of $2.49.

## Deploy to devnet

The program id is fixed by `declare_id!` in `src/lib.rs`, so deploying needs the keypair whose
public key is `2jvEsAiBYWPeiSzb54qMgBbtbQivQkK5ZiTkp2bgZ6kz` (Anchor created it where the program
was first built, usually `target/deploy/pct_oracle-keypair.json` under that build's target dir).
If it is lost, make a new one, put its public key in `declare_id!` and `Anchor.toml`, rebuild,
and set `PCT_PROGRAM_ID` for the CLIs.

```bash
solana config set --url devnet
solana airdrop 2   # repeat or use https://faucet.solana.com; the program needs about 2.4 SOL of rent
solana program deploy target/deploy/pct_oracle.so --program-id <path/to/pct_oracle-keypair.json>
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
