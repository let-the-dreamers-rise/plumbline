#!/usr/bin/env bash
# TEST ONLY. Builds the prover host with the repo's test-root guest re-pinned to an e2e root.
#   build-prover.sh <dir-with-test-root.der>   -> <dir>/tessera-risc0-host, <dir>/image-id.txt
# A copy of plumbline/zk (lib, risc0 sources, fixtures) goes to <dir>/zk; the only file that differs from
# the repo is fixtures/test-root.der. The guest code is byte-identical, so the image id differs from the
# repo's test-root id only because the embedded root differs.
# CARGO_TARGET_DIR: E2E_ZK_TARGET (default ~/.cache/plumbline-e2e/zk-target, ~3 GB). Point it at an
# existing risc0 3.0.6 target dir to skip the ~40 min from-scratch build of risc0's kernels.
set -euo pipefail
OUT=$(cd "$1" && pwd)
ZK=$(cd "$(dirname "$0")/../zk" && pwd)
[ -f "$OUT/test-root.der" ] || { echo "no $OUT/test-root.der"; exit 1; }
rm -rf "$OUT/zk"; mkdir -p "$OUT/zk/risc0"
cp -a "$ZK/lib" "$ZK/fixtures" "$OUT/zk/"
rm -rf "$OUT/zk/lib/target"
(cd "$ZK/risc0" && tar cf - --exclude=./target .) | (cd "$OUT/zk/risc0" && tar xf -)
cp "$OUT/test-root.der" "$OUT/zk/fixtures/test-root.der"
# everything but the root is identical to the repo
diff -r --exclude=test-root.der --exclude=target --exclude=proofs "$ZK/lib" "$OUT/zk/lib" >/dev/null
diff -r --no-dereference --exclude=target "$ZK/risc0" "$OUT/zk/risc0" >/dev/null
# Fresh mtimes: cargo hashes path packages relative to the workspace, so a copy at another path reuses
# the previous copy's units; methods/build.rs reruns only when remap-rustc.sh changes. Touching every
# copied file makes the guests rebuild against this root.
find "$OUT/zk" -type f -exec touch {} +
export CARGO_TARGET_DIR=${E2E_ZK_TARGET:-$HOME/.cache/plumbline-e2e/zk-target}
mkdir -p "$CARGO_TARGET_DIR"
(cd "$OUT/zk/risc0" && cargo build --release -q -p tessera-risc0-host)
# copy, not hardlink: the target dir's binary is replaced by the next build there
cp "$CARGO_TARGET_DIR/release/tessera-risc0-host" "$OUT/tessera-risc0-host.tmp"
mv "$OUT/tessera-risc0-host.tmp" "$OUT/tessera-risc0-host"
# image id of the e2e test-root guest (the host prints it before reading inputs fail)
IMAGE=testroot "$OUT/tessera-risc0-host" execute /dev/null /dev/null 2>/dev/null | sed -n 's/^image id //p' > "$OUT/image-id.txt" || true
[ -s "$OUT/image-id.txt" ] || { echo "could not read the image id"; exit 1; }
