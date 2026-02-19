#!/bin/sh
set -eu

staged_files="$(git diff --cached --name-only --diff-filter=ACMR | rg -N '\.(js|jsx|ts|tsx|css|json|md|html|yml)$' || true)"

if [ -z "$staged_files" ]; then
  exit 0
fi

echo "$staged_files" | xargs pnpm prettier --write
echo "$staged_files" | xargs git add
