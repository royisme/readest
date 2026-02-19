#!/usr/bin/env bash
set -euo pipefail

SOURCE_ICON="src-tauri/icons/icon.png"
DST_DIR="src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset"
ICONS_CONFIG_FILE="src-tauri/tauri.ios.icons.conf.json"

if [ ! -d "$DST_DIR" ]; then
  echo "[sync-ios-icons] Skip: destination directory not found: $DST_DIR"
  echo "[sync-ios-icons] Hint: run 'pnpm tauri ios init' first."
  exit 0
fi

LOCAL_ICONSET_DIR=""
if [ -f "$ICONS_CONFIG_FILE" ]; then
  LOCAL_ICONSET_DIR="$(
    node -e 'const fs=require("fs"); const p=process.argv[1]; const c=JSON.parse(fs.readFileSync(p, "utf8")); process.stdout.write(c.iosIconSetDir || "");' "$ICONS_CONFIG_FILE"
  )"
fi

if [ -n "$LOCAL_ICONSET_DIR" ] && [ -d "$LOCAL_ICONSET_DIR" ]; then
  rm -rf "$DST_DIR"/*
  cp -R "$LOCAL_ICONSET_DIR"/. "$DST_DIR"/
  if [ ! -f "$DST_DIR/Contents.json" ]; then
    echo "[sync-ios-icons] Error: custom iconset must include Contents.json: $LOCAL_ICONSET_DIR"
    exit 1
  fi
  echo "[sync-ios-icons] Synced custom iOS iconset from $LOCAL_ICONSET_DIR"
  exit 0
fi

if [ ! -f "$SOURCE_ICON" ]; then
  echo "[sync-ios-icons] Skip: source icon not found: $SOURCE_ICON"
  echo "[sync-ios-icons] Hint: configure $ICONS_CONFIG_FILE with iosIconSetDir to use manual assets."
  exit 0
fi

# Fallback: generate icons from a single source image.
pnpm tauri icon "$SOURCE_ICON" >/dev/null

if [ ! -f "$DST_DIR/Contents.json" ]; then
  echo "[sync-ios-icons] Error: missing $DST_DIR/Contents.json after icon generation"
  exit 1
fi

echo "[sync-ios-icons] Regenerated iOS icons from $SOURCE_ICON into $DST_DIR (fallback mode)"
