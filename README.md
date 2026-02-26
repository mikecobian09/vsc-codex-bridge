# VSC Codex Bridge

Extension-first bridge to control Codex from your phone while working on the same Mac workspace.

## 1) Install and Use (Super Simple)

### Download
- VSIX (tracked in this repo): [releases/vsc-codex-bridge-latest.vsix](./releases/vsc-codex-bridge-latest.vsix)
- VSIX (latest): [vsc-codex-bridge-latest.vsix](https://github.com/mikecobian09/vsc-codex-bridge/releases/latest/download/vsc-codex-bridge-latest.vsix)
- Releases page (fallback): [GitHub Releases](https://github.com/mikecobian09/vsc-codex-bridge/releases/latest)

### Step-by-step (5 minutes)
1. Open VS Code.
2. Run `Extensions: Install from VSIX...`.
3. Select `vsc-codex-bridge-latest.vsix`.
4. Open your project folder in VS Code.
5. Open Settings and set `vscCodexBridge.hubToken` to a strong token.
6. Keep defaults:
   - `vscCodexBridge.manageHubInExtension = true`
   - `vscCodexBridge.managedHubBindHost = 0.0.0.0`
   - `vscCodexBridge.managedHubPort = 7777`
7. Run command `VSC Codex Bridge: Start Bridge`.
8. Run command `VSC Codex Bridge: Open PWA`.
9. On your phone, open `http://<YOUR-MAC-IP>:7777/?token=<YOUR_TOKEN>`.

That is it. Single-extension install only.

### Install from repository artifact
1. Download [`releases/vsc-codex-bridge-latest.vsix`](./releases/vsc-codex-bridge-latest.vsix).
2. In VS Code run `Extensions: Install from VSIX...`.
3. Choose the downloaded file.
4. Reload VS Code when prompted.

## 2) Product Direction (Updated)

Current direction is **extension-only**:
- VS Code extension starts and manages Hub runtime.
- Hub serves the PWA directly.
- One installable artifact for users: the VSIX.

The previous standalone desktop flow has been removed from the main product path and documentation.

## 3) Current Status

Implemented and working baseline:
- Bridge extension with real `codex app-server` integration.
- Hub registration + heartbeat with auto re-register recovery.
- Managed Hub lifecycle from extension (`start/stop/restart`).
- PWA chat UX with workspace/thread selection, streaming timeline, approvals, stop, steer, and polling fallback.
- PWA can start a brand new conversation inside the selected workspace (`+ New conversation` in drawer).
- LAN-first default bind (`0.0.0.0`) for managed Hub mode.

## 4) Runtime Topology

`PWA <-> Hub <-> Bridge Extension <-> codex app-server <-> macOS filesystem`

Notes:
- One bridge per VS Code workspace window.
- Hub is shared at configured host/port (default `0.0.0.0:7777`).
- Bridge internally talks to Hub through `127.0.0.1` when bind host is wildcard (`0.0.0.0`).

## 5) Essential Commands

From VS Code Command Palette:
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

## 6) Required Settings

Extension settings (`vscCodexBridge.*`):
- `manageHubInExtension`: `true` (default)
- `managedHubBindHost`: `0.0.0.0` (default, LAN/Tailscale-friendly)
- `managedHubPort`: `7777` (default)
- `hubToken`: required when using non-localhost access
- `autoStartBridge`: `true` (default)
- `appServerMode`: `spawn` (recommended)

## 7) Security Quick Notes

- If Hub is reachable from LAN/Tailscale, use a strong `hubToken`.
- Do not expose this system publicly without hardening.
- Rotate token if you shared onboarding URLs.

## 8) Local Development

From repository root:

```bash
npm install
npm --prefix packages/bridge-vscode install
npm run build
npm run test:bridge
npm run test:hub
```

Build VSIX locally:

```bash
npm run build:bridge:vsix
```

Build and install VSIX locally:

```bash
npm run install:bridge:vsix
```

Fast extension rebuild/reinstall loop:

```bash
./.local/scripts/reload-bridge.sh
```

## 9) Simplified Roadmap

1. Stabilize cross-surface real-time parity (plugin <-> PWA updates).
2. Expand automated E2E coverage for bridge/hub/pwa lifecycle.
3. Harden shared schemas and error contracts across all boundaries.
4. Improve onboarding and release automation for one-click VSIX adoption.

## 10) Documentation Index

- Architecture: [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)
- Security: [docs/SECURITY.md](./docs/SECURITY.md)
- Releases: [docs/RELEASES.md](./docs/RELEASES.md)
- Troubleshooting: [docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md)
- Contributor guide: [CONTRIBUTING.md](./CONTRIBUTING.md)
- AI agent operational guide: [AGENTS.md](./AGENTS.md)

## 11) License

MIT. See [LICENSE](./LICENSE).
