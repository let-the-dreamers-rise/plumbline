#!/usr/bin/env bash
# CLI against a real local validator with the built plumbline programs deployed (upgradeable):
# record/claim are covered by the mocked tests until plumbline/zk produces a 330-byte proof.
# suite register -> bounty create -> list/show -> wait out the deadline -> refund.
# Local only: fresh throwaway keypair, its own ledger and ports (RPC_PORT, default 18899).
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH=/opt/solana-2.1.21/solana-release/bin:$PATH
PROGRAMS=../programs/target/deploy
RPC_PORT=${RPC_PORT:-18899}
URL=http://127.0.0.1:$RPC_PORT
WORK=$(mktemp -d)
LEDGER=$WORK/ledger
KP=$WORK/payer.json
VPID=
cleanup() { [ -n "$VPID" ] && kill "$VPID" 2>/dev/null && wait "$VPID" 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT

solana-keygen new --no-bip39-passphrase -s -o "$KP" >/dev/null
solana-test-validator -r -q --ledger "$LEDGER" --rpc-port "$RPC_PORT" --faucet-port $((RPC_PORT + 1010)) \
  --gossip-port $((RPC_PORT + 1020)) --dynamic-port-range $((RPC_PORT + 1030))-$((RPC_PORT + 1130)) > "$WORK/validator.log" 2>&1 &
VPID=$!
for _ in $(seq 90); do solana -u "$URL" cluster-version >/dev/null 2>&1 && break; sleep 1; done
solana -u "$URL" airdrop 100 "$(solana-keygen pubkey "$KP")" >/dev/null
for p in registry bounty; do
  solana -u "$URL" -k "$KP" program deploy --program-id "$PROGRAMS/plumbline_${p}-keypair.json" "$PROGRAMS/plumbline_${p}.so" >/dev/null
done

pl() { bin/plumbline --cluster "$URL" --keypair "$KP" "$@"; }
SUITE=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
echo "== suite register";  pl suite register "$SUITE"
echo "== bounty create";   pl --json bounty create --suite "$SUITE" --reward 1.5 --target 2/3 --deadline-slots 25 --grace-slots 0 --nonce 1 --require-registered-suite | tee "$WORK/b.json"
B=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["bounty"])' "$WORK/b.json")
echo "== bounty list";     pl bounty list | grep -q "$B"
echo "== bounty show";     pl bounty show "$B"
echo "== refund too early"; OUT=$(pl bounty refund "$B" 2>&1 || true); echo "$OUT"; grep -q RefundTooEarly <<<"$OUT" || { echo "expected RefundTooEarly"; exit 1; }
echo "== waiting past the deadline"; sleep 15
echo "== refund";          pl bounty refund "$B"
if pl bounty show "$B" >/dev/null 2>&1; then echo "bounty still exists after refund"; exit 1; fi
echo "LOCALNET SMOKE OK"
