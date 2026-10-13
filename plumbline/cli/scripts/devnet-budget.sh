#!/usr/bin/env bash
# Localnet rehearsal of the devnet kit's SOL budget (plumbline devnet-kit/deploy-devnet.ps1 + the first
# two steps of devnet-demo.ps1). A throwaway payer gets EXACTLY $BUDGET SOL on a private test validator
# (no devnet, no faucet), then runs the kit's sequence and prints the balance after each step.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH=/opt/solana-2.1.21/solana-release/bin:$PATH
PROGRAMS=${PROGRAMS:-../programs/target/deploy}
BUDGET=${BUDGET:-6.48}
RPC_PORT=${RPC_PORT:-18999}
URL=http://127.0.0.1:$RPC_PORT
WORK=$(mktemp -d)
VPID=
cleanup() { [ -n "$VPID" ] && kill "$VPID" 2>/dev/null && wait "$VPID" 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT

solana-keygen new --no-bip39-passphrase -s -o "$WORK/payer.json" >/dev/null
PAYER=$(solana-keygen pubkey "$WORK/payer.json")
solana-test-validator -r -q --ledger "$WORK/ledger" --rpc-port "$RPC_PORT" --faucet-port $((RPC_PORT + 1010)) \
  --gossip-port $((RPC_PORT + 1020)) --dynamic-port-range $((RPC_PORT + 1030))-$((RPC_PORT + 1130)) > "$WORK/validator.log" 2>&1 &
VPID=$!
for _ in $(seq 90); do solana -u "$URL" cluster-version >/dev/null 2>&1 && break; sleep 1; done
# Local test validator's own faucet, on this private ledger only.
solana -u "$URL" airdrop "$BUDGET" "$PAYER" >/dev/null
S=(-u "$URL" -k "$WORK/payer.json")
bal() { solana "${S[@]}" balance --lamports "$PAYER" | awk '{print $1}'; }
step() { local b; b=$(bal); printf '%-34s %14s lamports  (%s SOL)  spent %s\n' "$1" "$b" "$(python3 -c "print($b/1e9)")" "$(python3 -c "print(($PREV-$b)/1e9)")"; PREV=$b; }
PREV=$(bal); printf '%-34s %14s lamports  (%s SOL)\n' "start" "$PREV" "$(python3 -c "print($PREV/1e9)")"
for p in registry bounty; do
  so="$PROGRAMS/plumbline_${p}.so"; len=$(stat -c %s "$so")
  echo "rent for ${p} program data ($len bytes + 45 header): $(solana -u "$URL" rent $((len + 45)) | head -1)"
  solana "${S[@]}" program deploy "$so" --program-id "$PROGRAMS/plumbline_${p}-keypair.json" --max-len "$len" \
    --with-compute-unit-price 1000 >/dev/null
  step "deploy $p (--max-len $len)"
done
pl() { bin/plumbline --cluster "$URL" --keypair "$WORK/payer.json" "$@"; }
pl registry init-config --image-id 0x68049079fafddc9192761eb4461fb8cb036e92275fb91aa7ef61801c975114c6 \
  --root-sha 44a0196b2b99f889b8e149e95b807a350e7424964399e885a7cbb8ccfab674d3 >"$WORK/init.txt"
step "registry init-config"
pl registry show-config | sed 's/^/    /'
SUITE=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
pl suite register "$SUITE" >/dev/null
step "suite register"
pl bounty create --suite "$SUITE" --reward 0.05 --target 2/3 --require-registered-suite >/dev/null
step "bounty create 0.05 SOL"
echo "left after deploy-devnet.ps1 + suite/bounty: $(python3 -c "print($(bal)/1e9)") SOL of $BUDGET"

# devnet-demo.ps1 rehearsal with the TEST ONLY payout fixture: localnet only, so point the config at the
# test-root guest (on devnet the config keeps the production image and a real proof is used).
PROOF=${PROOF:-../programs/tests/fixtures/synthetic-payout-groth16.json}
pl --json proof inspect "$PROOF" > "$WORK/p.json"
J() { python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$@"; }
pl registry set-config --image-id "$(J "$WORK/p.json" imageId)" --root-sha "$(J "$WORK/p.json" root)" --compose-hash "$(J "$WORK/p.json" composeHash)" >/dev/null
step "registry set-config (rehearsal)"
pl proof inspect "$PROOF" --check-config | tail -1
DSUITE=$(J "$WORK/p.json" suiteCommitment)
pl suite register "$DSUITE" >/dev/null;                          step "demo: suite register"
pl --json bounty create --suite "$DSUITE" --reward 0.05 --target 2/3 --require-registered-suite > "$WORK/b.json"
step "demo: bounty create 0.05 SOL"
pl --json record "$PROOF" > "$WORK/r.json";                     step "demo: record proof"
pl claim "$(J "$WORK/b.json" bounty)" --score "$(J "$WORK/r.json" score)"
step "demo: claim (paid to the proof's payout)"
echo "payout $(J "$WORK/p.json" payout) balance: $(solana -u "$URL" balance "$(J "$WORK/p.json" payout)")"
echo "left after everything: $(python3 -c "print($(bal)/1e9)") SOL of $BUDGET"
echo "BUDGET OK"
