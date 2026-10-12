#!/usr/bin/env bash
# Re-proves the three Groth16 fixtures the programs' tests use (about 20 min each on 4 CPU cores; needs
# Docker for risczero/risc0-groth16-prover). Writes proofs/*.json. Run from anywhere after
# `cd risc0 && cargo build --release`. Set CARGO_TARGET_DIR if the build used one, or HOST=<binary>.
# Proving needs several GB of RAM (the recursion prover plus the Docker stark-to-snark step).
set -euo pipefail
cd "$(dirname "$0")/.."
HOST=${HOST:-${CARGO_TARGET_DIR:-risc0/target}/release/tessera-risc0-host}
F=fixtures
only=${1:-all}
if [ "$only" = all ] || [ "$only" = payout ]; then
  IMAGE=testroot OUT=proofs/synthetic-payout-groth16.json "$HOST" groth16 \
    $F/synthetic-quote-payout.bin $F/statement-v1-payout.json $F/synthetic-event-log.json
fi
if [ "$only" = all ] || [ "$only" = nopayout ]; then
  IMAGE=testroot OUT=proofs/synthetic-nopayout-groth16.json "$HOST" groth16 \
    $F/synthetic-quote.bin $F/statement-v1.json $F/synthetic-event-log-stripped.json
fi
if [ "$only" = all ] || [ "$only" = intel ]; then
  OUT=proofs/intel-unbound-groth16.json "$HOST" groth16 $F/intel-real-quote.bin $F/statement-v1.json
fi
