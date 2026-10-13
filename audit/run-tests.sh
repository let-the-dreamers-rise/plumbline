#!/usr/bin/env bash
# One command for an auditor: line counts, then every test the scope has.
#   ./audit/run-tests.sh          unit tests + Rust integration tests for pct_oracle (needs cargo)
#   ./audit/run-tests.sh --all    also builds the SBF binary and runs the sealed-eval Anchor tests
#                                 (needs the Solana and Anchor 0.31.1 toolchains and a local validator)
# Localnet only. Nothing here touches devnet or mainnet, and no key is read except the local test wallet.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/plumbline-audit-target}"

./audit/loc.sh
echo
echo "== pct_oracle: unit tests (Groth16 verifier, Reclaim claim parsing, coverage math, state)"
(cd oracle && cargo test --lib)

if [[ "${1:-}" == "--all" ]]; then
  echo
  echo "== pct_oracle: SBF build + integration tests (flow, lending, registry, zk)"
  (cd oracle && cargo build-sbf --manifest-path programs/pct_oracle/Cargo.toml --sbf-out-dir "$CARGO_TARGET_DIR/deploy" && cargo test -- --nocapture)
  echo
  echo "== sealed-eval registry + bounty: Anchor tests on a local validator (real Groth16 fixtures)"
  (cd plumbline/programs && ./scripts/localnet-test.sh)
fi
