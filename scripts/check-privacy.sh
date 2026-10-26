#!/usr/bin/env bash
# Fail when tracked files leak local machine details (absolute home paths,
# local workspace names, personal email). Run before release.
set -euo pipefail
cd "$(dirname "$0")/.."

patterns=(
  '/home/[A-Za-z0-9._-]+'
  '/Users/[A-Za-z0-9._-]+'
  '[A-Za-z]:\\\\Users'
)

failed=0
for pattern in "${patterns[@]}"; do
  if matches=$(git grep -n -I -E "$pattern" -- . ':!package-lock.json' 2>/dev/null); then
    if [[ -n "$matches" ]]; then
      echo "PRIVACY: found forbidden pattern: $pattern" >&2
      echo "$matches" >&2
      failed=1
    fi
  fi
done

if [[ "$failed" -ne 0 ]]; then
  echo "PRIVACY: tracked files leak local machine details; fix before release." >&2
  exit 1
fi
echo "PRIVACY: tracked files contain no local home paths / local workspace names"
