#!/usr/bin/env bash
# Verify that the emotion-analyzer bundle is actually installed into a DSH profile.
# Usage: bash scripts/check-install.sh [profile]   (default: web)
set -euo pipefail

PROFILE="${1:-web}"
PROFILE_DIR="${DSH_HOME:-$HOME/.dsh}/profiles/$PROFILE"
PKG="$PROFILE_DIR/package.json"

if [[ ! -f "$PKG" ]]; then
  echo "FAIL: profile not found: $PROFILE_DIR" >&2
  exit 1
fi

node - "$PKG" <<'NODE'
const fs = require('node:fs')
const pkg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const name = 'dsh-emotion-analyzer'
const dep = pkg.dependencies?.[name]
const bundles = pkg.dsh?.profile?.bundles ?? []
if (!dep) {
  console.error(`FAIL: ${name} is not a dependency of this profile`)
  process.exit(1)
}
if (!bundles.includes(name)) {
  console.error(`FAIL: ${name} is a dependency but missing from dsh.profile.bundles.`)
  console.error('Fix: dsh plugin --profile <profile> remove ' + name)
  console.error('     dsh plugin --profile <profile> add .')
  process.exit(1)
}
console.log('OK: dependency + bundle layer present:', dep)
NODE

if command -v dsh >/dev/null 2>&1; then
  if dsh --profile "$PROFILE" --dump-config 2>/dev/null | grep -q '^# == dsh-emotion-analyzer'; then
    echo "OK: --dump-config contains the dsh-emotion-analyzer layer"
  else
    echo "FAIL: --dump-config does not contain the dsh-emotion-analyzer layer" >&2
    exit 1
  fi
fi

echo "OK: remember to restart 'dsh web' before expecting new code to load"
