# VSC Codex Bridge Extension

Local VS Code extension that exposes a bridge API for the Codex Hub.

Current implementation stage:
- Internal HTTP/WS API scaffold
- Real event integration via `codex app-server` (JSON-RPC over WebSocket)
- Hub registration + heartbeat with auto-recovery
- Simulated fallback backend (for local testing)

This package already integrates with real `codex app-server` primitives and is the current implementation baseline for the monorepo.

## Local development

```bash
cd packages/bridge-vscode
npm install
npm run watch
```

Then open this folder in VS Code and run the extension in an Extension Development Host.

## Backend modes

`vscCodexBridge.backendMode`:
- `app-server` (default): uses real Codex events and approvals.
- `simulated`: keeps local in-memory mock behavior.

Core app-server settings:
- `vscCodexBridge.appServerMode` (default: `spawn`)
  - `spawn`: bridge launches its own local `codex app-server` (recommended and currently stable).
  - `attach`: bridge only connects to an existing app-server URL and fails startup if attach cannot be established.
- `vscCodexBridge.appServerAttachUrl` (default: empty)
  - Required only when `appServerMode=attach` (for example `ws://127.0.0.1:55545`).
  - If empty, bridge attempts best-effort auto-detection from local running `codex app-server` processes (`pgrep`, then `lsof` fallback).
- `vscCodexBridge.appServerCommand` (default: `codex`)
  - If `codex` is not resolvable from VS Code process `PATH`, the bridge auto-falls back to the bundled Codex binary inside the installed `openai.chatgpt` extension (when available).
- `vscCodexBridge.appServerExtraArgs` (default: `[]`)
- `vscCodexBridge.appServerHost` (default: `127.0.0.1`)
- `vscCodexBridge.appServerStartupTimeoutMs` (default: `15000`)
- `vscCodexBridge.appServerExperimentalApi` (default: `true`)
- `vscCodexBridge.autoStartBridge` (default: `true`)
  - When enabled, each VS Code workspace window auto-starts its own bridge on extension activation.
  - Disable only if you want manual start via command palette.

### Current attach status (important)

`attach` is implemented in code, but it is **not considered production-usable yet** in this environment.

Observed behavior in real runs:
- Auto-detected URLs frequently fail with `ECONNREFUSED` / connect timeout.
- Candidate ports found via process/socket discovery are often stale by the time the bridge tries to connect.
- Codex plugin logs include signals such as:
  - `local-environments is not supported in the extension`
  - repeated `thread-stream-state-changed` broadcasts with no handler
- There is currently no stable, documented plugin API that reliably exposes a live app-server WebSocket URL for attach.

Project decision for now:
- Keep bridge in `spawn` mode for day-to-day usage and reliability.
- Keep `attach` as an aspirational path for contributors.

### Why attach is still ideal

If we can make attach reliable, bridge and plugin would share the same app-server session:
- True bidirectional live updates between surfaces (VS Code plugin -> PWA and PWA -> VS Code plugin).
- Better cross-surface real-time parity (PWA <-> VS Code plugin).
- Lower risk of session drift between independently spawned app-servers.
- Cleaner architecture for advanced live-sync features.

### Strict attach behavior

When `vscCodexBridge.appServerMode=attach`, startup behavior is:
1. Try `vscCodexBridge.appServerAttachUrl`.
2. If attach fails, auto-detect local app-server URLs and retry attach candidate-by-candidate.
3. If all candidates fail, startup fails with an explicit error (no silent fallback to `spawn`).
4. Discovery now prioritizes real listening sockets (`lsof`) and only tries reachable URLs, avoiding long timeout loops on stale `pgrep` entries.

This avoids accidental split-session behavior where bridge and VS Code plugin run against different app-server processes.

### Auto-detect command (experimental attach helper)

Use command palette:
- `VSC Codex Bridge: Auto-detect App-Server Attach URL`

Behavior:
1. Detect local running `codex app-server` listen URL.
2. Save `vscCodexBridge.appServerAttachUrl` and set `vscCodexBridge.appServerMode=attach`.
3. Offer immediate bridge restart to apply attach mode.

Use this only when actively testing attach-mode research. Normal operation should stay in `spawn`.

### Contributor roadmap for attach

To unlock attach mode, contributors should focus on:
1. Reliable attach URL discovery from the real active plugin session (not stale process metadata).
2. Reachability verification before attempting long connect timeouts.
3. Clear discrimination between stale listeners and live app-server endpoints.
4. Regression coverage for restart/reconnect scenarios where plugin or extension host recycles.
5. Validation matrix proving live updates flow both ways (plugin-started and PWA-started turns) without restart.

Companion resources:
- `../../docs/ATTACH_RESEARCH.md` for current evidence and open questions.
- `../../scripts/collect-attach-diagnostics.sh` to capture attach diagnostics snapshots.

## Implemented internal routes

- `GET /internal/v1/meta`
- `GET /internal/v1/threads`
- `GET /internal/v1/threads/:threadId`
- `POST /internal/v1/threads/:threadId/message`
- `POST /internal/v1/turns/:turnId/interrupt`
- `POST /internal/v1/turns/:turnId/steer`
- `POST /internal/v1/approvals/:approvalId/decision`
- `WS /internal/v1/turns/:turnId/stream`

## Commands

- `VSC Codex Bridge: Start Bridge`
- `VSC Codex Bridge: Stop Bridge`
- `VSC Codex Bridge: Restart Bridge`
- `VSC Codex Bridge: Show Status`
- `VSC Codex Bridge: Health Check` (logs structured diagnostics to output channel)

## Packaging VSIX

From repository root:

```bash
npm run build:bridge:vsix
```

Build and install directly into local VS Code:

```bash
npm run install:bridge:vsix
```

## Registration recovery behavior

The bridge keeps a local registration state machine for hub connectivity.

- If initial registration fails (hub down, network issue, transient error), the bridge retries automatically.
- Retry uses exponential backoff with jitter:
  - base: `1000 ms`
  - max: `30000 ms`
  - jitter: `+/-20%`
- If heartbeat returns `404 Bridge ... is not registered`, the bridge marks itself unregistered and re-registers immediately.
- Health diagnostics now include `hubRegistration` fields:
  - `isRegistered`
  - `registrationInFlight`
  - `lastRegisterAttemptAt`
  - `lastRegisterSuccessAt`
  - `lastRegisterError`
  - `currentRetryDelayMs`
