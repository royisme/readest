#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
APP_DIR="$ROOT_DIR/apps/readest-app"

if [[ -z "${TTS_LIVE_BASE_URL:-}" ]]; then
  echo "Missing required env: TTS_LIVE_BASE_URL"
  echo "Example: export TTS_LIVE_BASE_URL=http://127.0.0.1:8000/v1"
  exit 1
fi

if [[ -z "${TTS_LIVE_TXT_PATH:-}" ]]; then
  echo "Missing required env: TTS_LIVE_TXT_PATH"
  echo "Example: export TTS_LIVE_TXT_PATH=$ROOT_DIR/test_input.txt"
  exit 1
fi

export TTS_LIVE_TEST="${TTS_LIVE_TEST:-1}"
export TTS_LIVE_LIMIT_SEGMENTS="${TTS_LIVE_LIMIT_SEGMENTS:-6}"
export TTS_LIVE_RESPONSE_FORMAT="${TTS_LIVE_RESPONSE_FORMAT:-mp3}"
export TTS_LIVE_SEGMENT_PREFERRED="${TTS_LIVE_SEGMENT_PREFERRED:-220}"
export TTS_LIVE_SEGMENT_ABSOLUTE="${TTS_LIVE_SEGMENT_ABSOLUTE:-500}"
export TTS_LIVE_TIMEOUT_MS="${TTS_LIVE_TIMEOUT_MS:-180000}"
export TTS_LIVE_REQUEST_TIMEOUT_MS="${TTS_LIVE_REQUEST_TIMEOUT_MS:-60000}"

echo "Running remote TTS live smoke..."
echo "base: $TTS_LIVE_BASE_URL"
echo "txt:  $TTS_LIVE_TXT_PATH"
echo "limit segments: $TTS_LIVE_LIMIT_SEGMENTS"

cd "$APP_DIR"
pnpm exec vitest run src/__tests__/services/tts/remoteTxtAudio.live.test.ts
