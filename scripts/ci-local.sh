#!/bin/sh
set -eu

echo "[ci:local] app lint"
pnpm -C apps/readest-app lint

echo "[ci:local] app txt converter tests"
pnpm -C apps/readest-app test -- src/__tests__/utils/txt-converter.test.ts

echo "[ci:local] app build"
pnpm -C apps/readest-app build
