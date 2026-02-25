#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
EXT_DIR="$REPO_ROOT/packages/bridge-vscode"
OUT_DIR="$REPO_ROOT/.local/release/extensions"

INSTALL_EXTENSION=0
RESTART_VSCODE=0

show_help() {
  cat <<'USAGE'
Usage: package-bridge-extension.sh [options]

Options:
  --install      Install VSIX into local VS Code after packaging.
  --restart      Restart Visual Studio Code app after install (macOS only).
  -h, --help     Show this help message.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install)
      INSTALL_EXTENSION=1
      shift
      ;;
    --restart)
      RESTART_VSCODE=1
      shift
      ;;
    -h|--help)
      show_help
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      show_help >&2
      exit 1
      ;;
  esac
done

mkdir -p "$OUT_DIR"

if [[ ! -d "$EXT_DIR/node_modules" ]]; then
  echo "[1/4] Installing extension dependencies"
  npm --prefix "$EXT_DIR" install
fi

echo "[2/4] Compiling extension"
npm --prefix "$EXT_DIR" run compile

VERSION="$(node -e "console.log(require(process.argv[1]).version)" "$EXT_DIR/package.json")"
VSIX_VERSIONED="$OUT_DIR/vsc-codex-bridge-${VERSION}.vsix"
VSIX_LATEST="$OUT_DIR/vsc-codex-bridge-latest.vsix"

echo "[3/4] Packaging VSIX"
rm -f "$VSIX_VERSIONED" "$VSIX_LATEST"

VSCE_CMD=()
if [[ -x "$EXT_DIR/node_modules/.bin/vsce" ]]; then
  VSCE_CMD=("$EXT_DIR/node_modules/.bin/vsce")
elif command -v vsce >/dev/null 2>&1; then
  VSCE_CMD=("$(command -v vsce)")
elif npx --no-install @vscode/vsce --version >/dev/null 2>&1; then
  VSCE_CMD=(npx --no-install @vscode/vsce)
else
  echo "VSCE is not available offline." >&2
  echo "Install it once, then retry:" >&2
  echo "  npm --prefix \"$EXT_DIR\" install --save-dev @vscode/vsce" >&2
  exit 1
fi

(
  cd "$EXT_DIR"
  "${VSCE_CMD[@]}" package --allow-missing-repository --out "$VSIX_VERSIONED"
)
cp "$VSIX_VERSIONED" "$VSIX_LATEST"

if [[ "$INSTALL_EXTENSION" -eq 1 ]]; then
  CODE_BIN="${CODE_CLI:-}"
  if [[ -z "$CODE_BIN" ]]; then
    for candidate in code code-insiders codium; do
      if command -v "$candidate" >/dev/null 2>&1; then
        CODE_BIN="$candidate"
        break
      fi
    done
  fi

  if [[ -z "$CODE_BIN" ]]; then
    echo "No VS Code CLI found. Set CODE_CLI or install 'code' in PATH." >&2
    exit 1
  fi

  echo "[4/4] Installing VSIX into VS Code ($CODE_BIN)"
  "$CODE_BIN" --install-extension "$VSIX_VERSIONED" --force >/dev/null

  if [[ "$RESTART_VSCODE" -eq 1 ]]; then
    if [[ "$(uname -s)" == "Darwin" ]] && command -v osascript >/dev/null 2>&1; then
      echo "Restarting full Visual Studio Code app"
      osascript -e 'tell application "Visual Studio Code" to quit' >/dev/null 2>&1 || true
      sleep 1
      open -a "Visual Studio Code" "$REPO_ROOT"
    else
      echo "Automatic restart is only available on macOS with osascript." >&2
    fi
  fi
fi

echo "Done."
echo "VSIX versioned: $VSIX_VERSIONED"
echo "VSIX latest:    $VSIX_LATEST"
