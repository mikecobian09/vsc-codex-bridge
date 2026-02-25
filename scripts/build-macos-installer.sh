#!/usr/bin/env bash

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script currently supports macOS only." >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ELECTRON_BASE_APP="$ROOT_DIR/packages/electron/node_modules/electron/dist/Electron.app"
APP_NAME="VSC Codex Bridge Hub"

if [[ ! -d "$ELECTRON_BASE_APP" ]]; then
  echo "Electron base app not found at $ELECTRON_BASE_APP" >&2
  echo "Run: npm --prefix packages/electron install" >&2
  exit 1
fi

if ! command -v hdiutil >/dev/null 2>&1; then
  echo "hdiutil not found. Cannot build DMG on this system." >&2
  exit 1
fi

VERSION="$(node -e "console.log(require(process.argv[1]).version)" "$ROOT_DIR/package.json")"
RELEASE_DIR="$ROOT_DIR/.local/release/macos"
STAGE_DIR="$RELEASE_DIR/stage"
APP_STAGE_DIR="$STAGE_DIR/app"
APP_BUNDLE_PATH="$RELEASE_DIR/$APP_NAME.app"
ZIP_PATH="$RELEASE_DIR/VSC-Codex-Bridge-Hub-${VERSION}-macos.zip"
PKG_PATH="$RELEASE_DIR/VSC-Codex-Bridge-Hub-${VERSION}-macos.pkg"
DMG_PATH="$RELEASE_DIR/VSC-Codex-Bridge-Hub-${VERSION}-macos.dmg"

rm -rf "$STAGE_DIR" "$APP_BUNDLE_PATH" "$ZIP_PATH" "$PKG_PATH" "$DMG_PATH"
mkdir -p "$APP_STAGE_DIR/runtime/hub/node_modules" "$APP_STAGE_DIR/runtime/shared" "$APP_STAGE_DIR/runtime/pwa"

echo "[1/8] Build runtime artifacts"
npm --prefix "$ROOT_DIR/packages/shared" run compile
npm --prefix "$ROOT_DIR/packages/hub" run compile
npm --prefix "$ROOT_DIR/packages/pwa" run build
npm --prefix "$ROOT_DIR/packages/electron" run lint:syntax

echo "[2/8] Assemble packaged app runtime"
cp "$ROOT_DIR/packages/electron/main.js" "$APP_STAGE_DIR/main.js"
cp "$ROOT_DIR/packages/electron/preload.js" "$APP_STAGE_DIR/preload.js"
cp "$ROOT_DIR/packages/electron/control-center.js" "$APP_STAGE_DIR/control-center.js"
cp "$ROOT_DIR/packages/electron/control-center.html" "$APP_STAGE_DIR/control-center.html"
cp "$ROOT_DIR/LICENSE" "$APP_STAGE_DIR/LICENSE"

cp -R "$ROOT_DIR/packages/hub/out" "$APP_STAGE_DIR/runtime/hub/out"
cp -R "$ROOT_DIR/packages/hub/node_modules/ws" "$APP_STAGE_DIR/runtime/hub/node_modules/ws"
cp -R "$ROOT_DIR/packages/shared/out" "$APP_STAGE_DIR/runtime/shared/out"
cp -R "$ROOT_DIR/packages/pwa/dist" "$APP_STAGE_DIR/runtime/pwa/dist"

cat > "$APP_STAGE_DIR/package.json" <<JSON
{
  "name": "vsc-codex-bridge-hub-menubar",
  "version": "${VERSION}",
  "private": true,
  "main": "main.js",
  "description": "Packaged macOS menubar app for VSC Codex Bridge Hub"
}
JSON

echo "[3/8] Create .app bundle"
cp -R "$ELECTRON_BASE_APP" "$APP_BUNDLE_PATH"
rm -rf "$APP_BUNDLE_PATH/Contents/Resources/app"
cp -R "$APP_STAGE_DIR" "$APP_BUNDLE_PATH/Contents/Resources/app"

echo "[4/8] Patch app metadata"
PLIST_PATH="$APP_BUNDLE_PATH/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName $APP_NAME" "$PLIST_PATH" >/dev/null 2>&1 || true
/usr/libexec/PlistBuddy -c "Set :CFBundleName $APP_NAME" "$PLIST_PATH" >/dev/null 2>&1 || true
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.mikecobian09.vsc-codex-bridge-hub" "$PLIST_PATH" >/dev/null 2>&1 || true
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$PLIST_PATH" >/dev/null 2>&1 || true
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $VERSION" "$PLIST_PATH" >/dev/null 2>&1 || true
/usr/libexec/PlistBuddy -c "Set :LSUIElement true" "$PLIST_PATH" >/dev/null 2>&1 || true

echo "[5/8] Create ZIP"
ditto -c -k --sequesterRsrc --keepParent "$APP_BUNDLE_PATH" "$ZIP_PATH"

echo "[6/8] Create PKG installer"
pkgbuild --component "$APP_BUNDLE_PATH" --install-location "/Applications" "$PKG_PATH" >/dev/null

echo "[7/8] Create DMG (best effort)"
if hdiutil create -volname "$APP_NAME" -srcfolder "$APP_BUNDLE_PATH" -ov -format UDZO "$DMG_PATH" >/dev/null; then
  echo "DMG created."
else
  echo "WARNING: DMG build failed in this environment. ZIP and PKG are still available." >&2
fi

echo "[8/8] Done"
echo "App: $APP_BUNDLE_PATH"
echo "ZIP: $ZIP_PATH"
echo "PKG: $PKG_PATH"
echo "DMG: $DMG_PATH"
