#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$ROOT_DIR/packages/electron"
LOCAL_ELECTRON_BIN="$APP_DIR/node_modules/.bin/electron"
VSCODE_ELECTRON_BIN_DEFAULT="/Applications/Visual Studio Code.app/Contents/MacOS/Electron"
VSCODE_ELECTRON_BIN="${VSCODE_ELECTRON_BIN:-$VSCODE_ELECTRON_BIN_DEFAULT}"
DRY_RUN="0"
ALLOW_VSCODE_ELECTRON="0"

for arg in "$@"; do
  case "$arg" in
    --dry-run)
      DRY_RUN="1"
      ;;
    --use-vscode-electron)
      ALLOW_VSCODE_ELECTRON="1"
      ;;
    *)
      echo "Unknown argument: $arg"
      echo "Usage: $0 [--dry-run] [--use-vscode-electron]"
      exit 1
      ;;
  esac
done

resolve_electron_bin() {
  if [[ -x "$LOCAL_ELECTRON_BIN" ]]; then
    echo "$LOCAL_ELECTRON_BIN"
    return 0
  fi

  if [[ "$ALLOW_VSCODE_ELECTRON" == "1" ]] && [[ -x "$VSCODE_ELECTRON_BIN" ]]; then
    echo "$VSCODE_ELECTRON_BIN"
    return 0
  fi

  return 1
}

if ! ELECTRON_BIN="$(resolve_electron_bin)"; then
  echo "ERROR: Could not find an Electron binary."
  echo
  echo "Options:"
  echo "1) Install local dependency: npm --prefix packages/electron install"
  echo "2) (Experimental) Use VS Code Electron:"
  echo "   ./scripts/run-electron-menubar.sh --use-vscode-electron"
  echo "3) If using VS Code Electron, ensure binary exists and optionally export custom path:"
  echo "   export VSCODE_ELECTRON_BIN=\"/path/to/Electron\""
  exit 1
fi

if [[ "$DRY_RUN" == "1" ]]; then
  echo "Electron binary: $ELECTRON_BIN"
  echo "App directory  : $APP_DIR"
  if [[ "$ELECTRON_BIN" == "$VSCODE_ELECTRON_BIN" ]]; then
    echo "Mode           : VS Code Electron (experimental)"
  else
    echo "Mode           : Local electron dependency"
  fi
  exit 0
fi

echo "Launching VSC Codex Bridge menubar app..."
# Some shells/environments export ELECTRON_RUN_AS_NODE. If it is set, Electron
# behaves like plain Node.js and `require("electron")` fails inside app code.
unset ELECTRON_RUN_AS_NODE
exec "$ELECTRON_BIN" "$APP_DIR"
