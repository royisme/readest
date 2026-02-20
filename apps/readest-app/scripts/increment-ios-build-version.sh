#!/usr/bin/env bash
set -euo pipefail

PLIST_PATH="${1:-}"
CONFIGURATION="${2:-}"

if [[ -z "${PLIST_PATH}" ]]; then
  echo "[ios-version] missing plist path"
  exit 1
fi

if [[ "${CONFIGURATION}" != "Release" && "${CONFIGURATION}" != "release" ]]; then
  echo "[ios-version] skip version bump for configuration=${CONFIGURATION}"
  exit 0
fi

if [[ ! -f "${PLIST_PATH}" ]]; then
  echo "[ios-version] plist not found: ${PLIST_PATH}"
  exit 1
fi

CURRENT_VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "${PLIST_PATH}" 2>/dev/null || true)

if [[ -z "${CURRENT_VERSION}" ]]; then
  NEXT_VERSION="1"
else
  if [[ "${CURRENT_VERSION}" =~ ^[0-9]+$ ]]; then
    NEXT_VERSION="$((CURRENT_VERSION + 1))"
  elif [[ "${CURRENT_VERSION}" =~ ^([0-9]+\.)*([0-9]+)$ ]]; then
    PREFIX="${CURRENT_VERSION%.*}"
    LAST="${CURRENT_VERSION##*.}"
    INCREMENTED="$((LAST + 1))"
    if [[ "${PREFIX}" == "${CURRENT_VERSION}" ]]; then
      NEXT_VERSION="${INCREMENTED}"
    else
      NEXT_VERSION="${PREFIX}.${INCREMENTED}"
    fi
  else
    NEXT_VERSION="1"
  fi
fi

/usr/libexec/PlistBuddy -c "Set :CFBundleVersion ${NEXT_VERSION}" "${PLIST_PATH}" >/dev/null

echo "[ios-version] ${CURRENT_VERSION:-<unset>} -> ${NEXT_VERSION} (${CONFIGURATION})"
