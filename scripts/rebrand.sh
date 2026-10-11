#!/usr/bin/env bash
# Rename the user-facing product name, e.g. scripts/rebrand.sh Tessera SealScore. Safe to rerun with a new pair.
# Internal identifiers (pct_oracle, PDA seeds, @pct/* packages, PCT_* env vars, repo and branch names) are left alone.
set -euo pipefail
old="$1"; new="$2"; lo_old=$(echo "$old" | tr '[:upper:]' '[:lower:]'); lo_new=$(echo "$new" | tr '[:upper:]' '[:lower:]')
cd "$(dirname "$0")/.."
files=$(git ls-files README.md LICENSE Dockerfile scripts/devnet-go.ps1 'packages/web/public/*.html' 'packages/web/public/*.js' 'packages/web/src/*.ts' | xargs grep -l "$old" || true)
for f in $files; do sed -i "s/$old/$new/g" "$f"; done
sed -i "s/railway init --name $lo_old\b/railway init --name $lo_new/" README.md
echo "renamed $old -> $new in:"; echo "$files"
