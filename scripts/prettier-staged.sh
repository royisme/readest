#!/usr/bin/env sh
set -eu

STAGED_FILES="$(git diff --cached --name-only --diff-filter=ACMR | grep -E '\.(js|jsx|ts|tsx|css|json|md|html|yml)$' || true)"

if [ -z "$STAGED_FILES" ]; then
  exit 0
fi

echo "$STAGED_FILES" | xargs pnpm exec prettier --write
echo "$STAGED_FILES" | xargs git add
