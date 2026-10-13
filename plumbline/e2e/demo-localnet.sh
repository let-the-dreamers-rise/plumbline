#!/usr/bin/env bash
# TEST ONLY, localnet only. Demo recordings for the video, on a fresh solana-test-validator with upgradeable
# deploys of programs/target/deploy (no build, no proving: it reuses the repo's test-root Groth16 proofs).
#   bash demo-localnet.sh refusals              -> demo-refusals.ts (forged score accounts preloaded)
#   bash demo-localnet.sh screens <out-dir>     -> demo-seed.ts, then demo-screens.mjs (desktop + phone PNGs)
# RPC_PORT (default 28899; faucet +1010, gossip +1020, dynamic +1030..+1130), APP_PORT (default 28081).
set -euo pipefail
E2E=$(cd "$(dirname "$0")" && pwd)
PL=$(dirname "$E2E")
export PATH=/opt/solana-2.1.21/solana-release/bin:/opt/anchor-0.31.1:$PATH
MODE=${1:?refusals|screens}
RPC_PORT=${RPC_PORT:-28899}
APP_PORT=${APP_PORT:-28081}
URL=http://127.0.0.1:$RPC_PORT
LEDGER=$(mktemp -d /tmp/plumbline-demo-ledger.XXXXXX)
WORK=$(mktemp -d /tmp/plumbline-demo-work.XXXXXX)
export ANCHOR_PROVIDER_URL=$URL ANCHOR_WALLET=$HOME/.config/solana/id.json TS_NODE_TRANSPILE_ONLY=1
VPID= APID=
cleanup() {
  [ -n "$APID" ] && kill "$APID" 2>/dev/null || true
  [ -n "$VPID" ] && kill "$VPID" 2>/dev/null && wait "$VPID" 2>/dev/null || true
  rm -rf "$LEDGER" "$WORK"
}
trap cleanup EXIT
cd "$PL/programs"
EXTRA=()
if [ "$MODE" = refusals ]; then
  for f in tests/fixtures/forged/*.json; do EXTRA+=(--account "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["pubkey"])' "$f")" "$f"); done
fi
solana-test-validator -r -q --ledger "$LEDGER" --rpc-port "$RPC_PORT" --faucet-port $((RPC_PORT + 1010)) \
  --gossip-port $((RPC_PORT + 1020)) --dynamic-port-range $((RPC_PORT + 1030))-$((RPC_PORT + 1130)) "${EXTRA[@]}" > "$WORK/validator.log" 2>&1 &
VPID=$!
for i in $(seq 90); do solana -u "$URL" cluster-version >/dev/null 2>&1 && break; sleep 1; done
solana -u "$URL" airdrop 100 > "$WORK/airdrop.log" 2>&1
anchor deploy --provider.cluster "$URL" > "$WORK/deploy.log" 2>&1 || { cat "$WORK/deploy.log"; exit 1; }
# node 22 would strip the types itself and load the file as ESM; run it through ts-node as CommonJS like ts-mocha does
TSN() { TS_NODE_PROJECT=tsconfig.json node --no-experimental-strip-types -r ts-node/register -e 'require(process.argv[1])' "$1"; }
if [ "$MODE" = refusals ]; then
  TSN "$E2E/demo-refusals.ts"
  exit
fi
OUT=$(realpath "${2:?out-dir}")
TSN "$E2E/demo-seed.ts" > "$WORK/seed.json"
cat "$WORK/seed.json"
# the bundle behind the recorded payout proof, assembled from the zk test fixtures (synthetic test-root quote)
# with no key-release part, so the page's full Intel check fails by design; the payout checks are what this shot is for
python3 - "$PL/zk/fixtures" "$OUT/demo-bundle-payout.json" <<'PY'
import hashlib, json, sys
fx, out = sys.argv[1], sys.argv[2]
stmt = open(f"{fx}/statement-v1-payout.json", "rb").read().strip()
quote = open(f"{fx}/synthetic-quote-payout.bin", "rb").read()
log = json.load(open(f"{fx}/synthetic-event-log.json"))
b = {"statement": json.loads(stmt), "statement_sha256": hashlib.sha256(stmt).hexdigest(),
     "score": {"quote": quote.hex(), "event_log": json.dumps(log), "report_data": quote[568:600].hex()},
     "note": "TEST ONLY demo bundle: zk/fixtures statement-v1-payout.json + synthetic-quote-payout.bin (test-root quote, not Intel); no key-release quote"}
json.dump(b, open(out, "w"), indent=1)
print("bundle", out, "statement", b["statement_sha256"])
PY
node "$PL/app/test/serve.mjs" "$APP_PORT" > "$WORK/app.log" 2>&1 &
APID=$!
for i in $(seq 30); do curl -s -o /dev/null "http://127.0.0.1:$APP_PORT/" && break; sleep 0.5; done
node "$E2E/demo-screens.mjs" "http://127.0.0.1:$APP_PORT" "$URL" "$WORK/seed.json" "$OUT/demo-bundle-payout.json" "$OUT"
