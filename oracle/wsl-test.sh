#!/usr/bin/env bash
# Builds the SBF program and runs all tests in WSL, with build output on the Linux filesystem
# and low CPU priority so the laptop stays usable. Pass --unit to skip the SBF build.
set -euo pipefail
cd "$(dirname "$0")"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/pct-target}"
if [[ "${1:-}" == "--unit" ]]; then
  shift
  nice -n 19 cargo test -j 2 --lib "$@"
  exit 0
fi
nice -n 19 cargo build-sbf --manifest-path programs/pct_oracle/Cargo.toml --sbf-out-dir "$CARGO_TARGET_DIR/deploy" -- -j 2
nice -n 19 cargo test -j 2 "$@" -- --nocapture
