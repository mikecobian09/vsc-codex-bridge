# VSC Codex Bridge Extension

VS Code extension that provides:
- the local bridge API,
- a managed Hub runtime,
- and PWA hosting for mobile control.

## Quick Install

Download VSIX:
- Repo artifact: [releases/vsc-codex-bridge-latest.vsix](../../releases/vsc-codex-bridge-latest.vsix)
- Direct: [vsc-codex-bridge-latest.vsix](https://github.com/mikecobian09/vsc-codex-bridge/releases/latest/download/vsc-codex-bridge-latest.vsix)
- Releases page: [GitHub Releases](https://github.com/mikecobian09/vsc-codex-bridge/releases/latest)

Install in VS Code:
1. `Extensions: Install from VSIX...`
2. Select `vsc-codex-bridge-latest.vsix`

## First Run (Recommended)

1. Open your workspace.
2. Set `vscCodexBridge.hubToken` to a strong value.
3. Keep defaults:
   - `vscCodexBridge.manageHubInExtension=true`
   - `vscCodexBridge.managedHubBindHost=0.0.0.0`
   - `vscCodexBridge.managedHubPort=7777`
4. Run `VSC Codex Bridge: Start Bridge`.
5. Run `VSC Codex Bridge: Open PWA`.

## Backend Modes

`vscCodexBridge.backendMode`:
- `app-server` (default): real Codex events and approvals.
- `simulated`: local in-memory behavior for testing.

App-server settings:
- `vscCodexBridge.appServerMode`:
  - `spawn` (recommended stable mode)
  - `attach` (experimental)
- `vscCodexBridge.appServerAttachUrl`
- `vscCodexBridge.appServerCommand`
- `vscCodexBridge.appServerExtraArgs`
- `vscCodexBridge.appServerHost`
- `vscCodexBridge.appServerStartupTimeoutMs`
- `vscCodexBridge.appServerExperimentalApi`

## Managed Hub Mode

Settings:
- `vscCodexBridge.manageHubInExtension` (default: `true`)
- `vscCodexBridge.managedHubBindHost` (default: `0.0.0.0`)
- `vscCodexBridge.managedHubPort` (default: `7777`)
- `vscCodexBridge.hubToken`

Behavior:
- Extension starts/stops/restarts hub process.
- If another process already serves the same hub address, extension uses it as external/shared hub.
- In multi-window VS Code sessions, practical behavior is one shared hub address.
- PWA supports `+ New conversation` drafts and resolves a real thread id on first send.

## Commands

- `VSC Codex Bridge: Start Bridge`
- `VSC Codex Bridge: Stop Bridge`
- `VSC Codex Bridge: Restart Bridge`
- `VSC Codex Bridge: Start Hub`
- `VSC Codex Bridge: Stop Hub`
- `VSC Codex Bridge: Restart Hub`
- `VSC Codex Bridge: Open PWA`
- `VSC Codex Bridge: Control Panel`
- `VSC Codex Bridge: Show Status`
- `VSC Codex Bridge: Health Check`
- `VSC Codex Bridge: Self Check`
- `VSC Codex Bridge: Auto-detect App-Server Attach URL`

## Implemented Internal Routes

- `GET /internal/v1/meta`
- `GET /internal/v1/threads`
- `GET /internal/v1/threads/:threadId`
- `POST /internal/v1/threads/:threadId/message`
- `POST /internal/v1/turns/:turnId/interrupt`
- `POST /internal/v1/turns/:turnId/steer`
- `POST /internal/v1/approvals/:approvalId/decision`
- `WS /internal/v1/turns/:turnId/stream`

## Registration Recovery Behavior

Bridge registration is self-healing:
- startup register retries with exponential backoff + jitter,
- heartbeat `404 not registered` triggers immediate re-register,
- diagnostics include registration state and retry metadata.

## Local Development

From repository root:

```bash
npm --prefix packages/bridge-vscode install
npm --prefix packages/bridge-vscode run compile
npm run build:bridge:vsix
npm run install:bridge:vsix
```
