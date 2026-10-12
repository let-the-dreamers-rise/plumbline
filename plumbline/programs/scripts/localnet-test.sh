#!/usr/bin/env bash
# Build both programs, then run the tests, each phase on a fresh solana-test-validator with real
# (upgradeable) deploys of the registry and the bounty (so init_config's upgrade-authority check works).
# Local only: never points at devnet/mainnet. Plain `anchor test` misreports port 8899 as in use here.
#   phase 1: tests/registry.ts + tests/verified.ts
#   phase 2: tests/bounty.ts (validator preloaded with the two forged score accounts)
# Each phase needs its own ledger because a proof can be recorded only once per chain.
# RPC_PORT (default 8899) lets it run next to another local validator; PHASES="registry" or "bounty" runs one.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH=/opt/solana-2.1.21/solana-release/bin:/opt/anchor-0.31.1:$PATH
[ -f ~/.config/solana/id.json ] || solana-keygen new --no-bip39-passphrase -s -o ~/.config/solana/id.json >/dev/null
[ "${SKIP_BUILD:-}" = 1 ] || anchor build
[ -f tests/fixtures/forged/wrong-pda.json ] || yarn -s ts-node -P tsconfig.json scripts/make-forged.ts tests/fixtures/forged
RPC_PORT=${RPC_PORT:-8899}
URL=http://127.0.0.1:$RPC_PORT
export ANCHOR_PROVIDER_URL=$URL ANCHOR_WALLET=$HOME/.config/solana/id.json
LEDGER=${LEDGER:-/tmp/plumbline-ledger}
PORTS=(--rpc-port "$RPC_PORT" --faucet-port $((RPC_PORT + 1010)) --gossip-port $((RPC_PORT + 1020)) \
  --dynamic-port-range $((RPC_PORT + 1030))-$((RPC_PORT + 1130)))
VPID=
cleanup() { [ -n "$VPID" ] && kill "$VPID" 2>/dev/null && wait "$VPID" 2>/dev/null || true; }
trap cleanup EXIT

run_phase() { # $1 = space-separated test files, rest = extra validator args
  local files=$1; shift
  cleanup; rm -rf "$LEDGER"
  solana-test-validator -r -q --ledger "$LEDGER" "${PORTS[@]}" "$@" > "$LEDGER.log" 2>&1 &
  VPID=$!
  for i in $(seq 90); do solana -u "$URL" cluster-version >/dev/null 2>&1 && break; sleep 1; done
  solana -u "$URL" airdrop 100 >/dev/null
  anchor deploy --provider.cluster "$URL" >/dev/null
  # shellcheck disable=SC2086
  yarn -s ts-mocha -p ./tsconfig.json -t 1000000 $files
}

FORGED=()
for f in tests/fixtures/forged/*.json; do FORGED+=(--account "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["pubkey"])' "$f")" "$f"); done
PHASES=${PHASES:-registry bounty}
[[ " $PHASES " == *" registry "* ]] && run_phase "tests/registry.ts tests/verified.ts"
[[ " $PHASES " == *" bounty "* ]] && run_phase tests/bounty.ts "${FORGED[@]}"
echo "LOCALNET OK"
