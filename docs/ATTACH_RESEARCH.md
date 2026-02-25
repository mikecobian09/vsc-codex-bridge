# Attach Research

Last updated: 2026-02-25

## Why this research exists

`attach` is still the preferred long-term architecture because it should enable true bidirectional live updates between both surfaces:

- VS Code plugin -> PWA
- PWA -> VS Code plugin

The project currently runs in `spawn` mode for reliability, while `attach` remains an open research track.

## Current status

- `attach` path is implemented in bridge code (`appServerClient.ts` + `appServerDiscovery.ts`).
- Startup intentionally fails fast in `attach` mode if no reachable endpoint is found.
- In field usage, attach attempts repeatedly fail with `ECONNREFUSED` / timeout.
- `spawn` remains the operational default.

## Evidence snapshot (local environment)

Environment:
- macOS
- VS Code + `openai.chatgpt-0.4.76-darwin-arm64`
- Bridge extension in active development workspace

### 1) Plugin log does not expose a stable websocket `--listen` endpoint

In Codex extension logs, we consistently see:

- `[CodexMcpConnection] Spawning codex app-server`
- `Desktop bridge listening on UNIX socket ...`
- repeated `thread-stream-state-changed` broadcasts without handler
- repeated `local-environments is not supported in the extension`

This suggests the plugin runtime currently uses an internal IPC model that does not provide a stable documented websocket endpoint for third-party attach.

### 2) Discovery candidates are mostly stale

A runtime reachability sweep against URLs extracted from:

`pgrep -fal "codex app-server" | ... --listen ws://127.0.0.1:<port>`

showed:

- `PGREP_URLS=26`
- `REACHABLE=1`

Meaning most candidate ports discovered from process arguments were stale (historical orphan process metadata, no active listener).

### 3) Bridge attach logs show repeat timeout loops

Bridge logs show long sequences like:

- `Auto-detected app-server URL for attach mode: ws://127.0.0.1:54152`
- `Attach mode failed ... connect ECONNREFUSED 127.0.0.1:54152`

repeating across many discovered ports.

## Main conclusions

1. There is no proven stable plugin-owned websocket endpoint to attach against in this environment/version.
2. Process-argument discovery (`pgrep`) is not trustworthy alone because stale processes dominate results.
3. Socket discovery (`lsof`) is better, but still does not solve plugin-owned endpoint discovery if that endpoint is not exposed or is short-lived.
4. `spawn` is currently the only reproducible, stable mode for daily use.

## What would make attach viable

Attach should only be considered production-ready if all are true:

1. Stable endpoint source:
   - A reliable plugin/runtime-provided endpoint source exists (not stale process scraping).
2. Reachability consistency:
   - Attach success survives extension reload and VS Code window restart.
3. Bidirectional parity:
   - Plugin-started and PWA-started turns update both surfaces in near real time without restart.
4. Recovery behavior:
   - If endpoint rotates, bridge recovers deterministically without manual intervention.

## Contributor research protocol

Use this checklist for every attach experiment:

1. Confirm current mode and config in `.vscode/settings.json`.
2. Capture diagnostics snapshot:
   - `./scripts/collect-attach-diagnostics.sh`
3. If testing attach:
   - set `vscCodexBridge.appServerMode=attach`
   - optionally set `vscCodexBridge.appServerAttachUrl`
   - restart bridge
4. Record bridge logs:
   - attach candidate URLs attempted
   - first failure reason per URL (`ECONNREFUSED`, timeout, handshake, etc.)
5. Record plugin logs:
   - `Spawning codex app-server`
   - `thread-stream-state-changed`
   - any endpoint or transport hints
6. Validate bidirectional behavior:
   - start a turn in plugin and watch PWA live updates
   - start a turn in PWA and watch plugin live updates
7. Document result as:
   - pass/fail for each direction
   - reproducibility notes

## Open research questions

1. Does the plugin expose any undocumented API/event with the active app-server transport endpoint?
2. Is plugin `codex app-server` running over a transport that is intentionally non-attachable from third-party clients?
3. Is there a safe way to bridge plugin IPC (without reverse engineering unsupported internals)?
4. Can we negotiate a stable integration point upstream?

## Practical recommendation (today)

- Use `spawn` mode in normal operation.
- Keep attach work as an explicit R&D track with reproducible diagnostics and acceptance matrix.
