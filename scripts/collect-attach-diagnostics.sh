#!/usr/bin/env bash

set -euo pipefail

# Diagnostic helper for attach-mode research.
# It is intentionally read-only and prints a reproducible snapshot to stdout.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_ROOT="${HOME}/Library/Application Support/Code/logs"
MAX_BRIDGE_LOG_LINES="${MAX_BRIDGE_LOG_LINES:-160}"
MAX_CODEX_LOG_LINES="${MAX_CODEX_LOG_LINES:-220}"

print_section() {
  local title="$1"
  echo
  echo "## ${title}"
}

print_kv() {
  local key="$1"
  local value="$2"
  printf "%-36s %s\n" "${key}:" "${value}"
}

latest_bridge_log() {
  find "${LOG_ROOT}" -type f -name "*VSC Codex Bridge.log" 2>/dev/null | sort | tail -n 1
}

latest_codex_log() {
  find "${LOG_ROOT}" -type f -path "*/exthost/openai.chatgpt/Codex.log" 2>/dev/null | sort | tail -n 1
}

recent_bridge_logs_with_pattern() {
  local pattern="$1"
  local max_lines="$2"
  local tmp_files

  tmp_files="$(mktemp)"
  find "${LOG_ROOT}" -type f -name "*VSC Codex Bridge.log" 2>/dev/null | sort | tail -n 30 > "${tmp_files}"

  while IFS= read -r file; do
    [[ -z "${file}" ]] && continue
    grep -nE "${pattern}" "${file}" 2>/dev/null | sed -e "s|^|${file}:|" || true
  done < "${tmp_files}" | tail -n "${max_lines}"

  rm -f "${tmp_files}"
}

recent_codex_logs_with_pattern() {
  local pattern="$1"
  local max_lines="$2"
  local tmp_files

  tmp_files="$(mktemp)"
  find "${LOG_ROOT}" -type f -path "*/exthost/openai.chatgpt/Codex.log" 2>/dev/null | sort | tail -n 20 > "${tmp_files}"

  while IFS= read -r file; do
    [[ -z "${file}" ]] && continue
    grep -nE "${pattern}" "${file}" 2>/dev/null | sed -e "s|^|${file}:|" || true
  done < "${tmp_files}" | tail -n "${max_lines}"

  rm -f "${tmp_files}"
}

print_section "Attach Diagnostics Snapshot"
print_kv "timestamp_utc" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
print_kv "root_dir" "${ROOT_DIR}"
print_kv "uname" "$(uname -a)"

print_section "Bridge Workspace Settings"
if [[ -f "${ROOT_DIR}/.vscode/settings.json" ]]; then
  cat "${ROOT_DIR}/.vscode/settings.json"
else
  echo "(no .vscode/settings.json found)"
fi

print_section "codex app-server Processes (pgrep)"
if command -v pgrep >/dev/null 2>&1; then
  pgrep -fal "codex app-server" || true
else
  echo "(pgrep not available)"
fi

print_section "Active TCP Listeners (lsof subset)"
if command -v lsof >/dev/null 2>&1; then
  lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -E "^codex|^Code\\\\x20H" || true
else
  echo "(lsof not available)"
fi

print_section "Reachability Check from --listen URLs"
tmp_urls="$(mktemp)"
trap 'rm -f "${tmp_urls}"' EXIT

if command -v pgrep >/dev/null 2>&1; then
  pgrep -fal "codex app-server" \
    | sed -nE 's/.*--listen[[:space:]]+(ws:\/\/127\.0\.0\.1:[0-9]+).*/\1/p' \
    | sort -u > "${tmp_urls}"
fi

total_urls="$(wc -l < "${tmp_urls}" | tr -d ' ')"
print_kv "candidate_urls" "${total_urls}"

reachable_urls=0
while IFS= read -r url; do
  [[ -z "${url}" ]] && continue
  port="${url##*:}"
  if nc -z 127.0.0.1 "${port}" >/dev/null 2>&1; then
    echo "OPEN   ${url}"
    reachable_urls=$((reachable_urls + 1))
  else
    echo "CLOSED ${url}"
  fi
done < "${tmp_urls}"

print_kv "reachable_urls" "${reachable_urls}"

print_section "Latest Bridge Log Highlights"
bridge_log="$(latest_bridge_log)"
if [[ -n "${bridge_log}" && -f "${bridge_log}" ]]; then
  print_kv "path" "${bridge_log}"
  recent_bridge_logs_with_pattern "Attach mode failed|Auto-detected app-server URL|Connected to app-server|Bridge start failed|ECONNREFUSED|Timeout connecting|attach mode" "${MAX_BRIDGE_LOG_LINES}"
else
  echo "(no bridge log found)"
fi

print_section "Latest Codex Plugin Log Highlights"
codex_log="$(latest_codex_log)"
if [[ -n "${codex_log}" && -f "${codex_log}" ]]; then
  print_kv "path" "${codex_log}"
  recent_codex_logs_with_pattern "Spawning codex app-server|thread-stream-state-changed|local-environments|open-in-target|listening on UNIX socket|listening on: ws://" "${MAX_CODEX_LOG_LINES}"
else
  echo "(no Codex plugin log found)"
fi

print_section "End"
echo "Done."
