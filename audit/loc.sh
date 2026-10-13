#!/usr/bin/env bash
# Prints the audit scope's line counts (Rust, non-test files) so SCOPE.md can be checked against the code.
set -euo pipefail
cd "$(dirname "$0")/.."
echo "commit $(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
echo
echo "pct_oracle (oracle/programs/pct_oracle/src)"
find oracle/programs/pct_oracle/src -name '*.rs' | sort | xargs wc -l
echo
echo "sealed-eval registry and bounty (plumbline/programs)"
find plumbline/programs/registry/src plumbline/programs/bounty/src -name '*.rs' | sort | xargs wc -l
