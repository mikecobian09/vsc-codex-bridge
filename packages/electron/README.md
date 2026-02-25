# @vsc-codex-bridge/electron

macOS menubar controller for the VSC Codex Bridge hub.

## Current capabilities

- Runs as a tray/menubar app (`CB`).
- Hub lifecycle controls:
  - `Start Hub`
  - `Stop Hub` (managed process only)
  - `Restart Hub` (managed process only)
- Opens PWA URL in browser.
- Copies PWA URL to clipboard.
- Shows connected workspaces (`/api/v1/bridges`) directly in menu.
- Polls hub status every 3 seconds.
- Includes Control Center window with:
  - settings editor (`bindHost`, `port`, `authToken`, `corsAllowedOrigins`, `verboseLogs`),
  - app behavior settings (`launchAtLogin`, `autoStartHubOnLaunch`),
  - live diagnostics (`hub status`, `health snapshot`, `workspace list`, `menubar log tail`),
  - UI aligned with PWA visual language (same dark grayscale palette and card system).
- Supports launch-at-login on macOS/Windows using Electron login item settings.
- Can auto-start hub automatically when the menubar app launches.
- Writes operational logs to:
  - `.local/logs/hub-menubar.log`

## Runtime behavior notes

- In development mode, hub config is read from:
  - `packages/hub/config/hub.config.json`
- In packaged mode, hub config is read/written at:
  - `~/Library/Application Support/<app>/hub.config.json`
- If `bindHost` is `0.0.0.0` or `::`, the app still connects through `127.0.0.1`.
- If hub is running externally (not started by this app), menu shows it as `running (external)` and stop/restart are disabled for safety.

## Run locally

```bash
npm --prefix packages/electron install
npm --prefix packages/electron run dev
```

From repository root:

```bash
npm run dev:electron
```

Launcher helper (uses local `electron` dependency):

```bash
npm run run:electron
```

Experimental fallback using VS Code's Electron binary:

```bash
npm run run:electron:vscode
```

Build installable macOS artifacts (`.app`, `.zip`, `.pkg`, `.dmg` best-effort):

```bash
npm run build:electron:macos-installer
```

## Current limitations

- Produced `.app`/`.dmg` are unsigned (Gatekeeper prompt expected until signed/notarized pipeline is added).
- No diagnostics export bundle yet.
