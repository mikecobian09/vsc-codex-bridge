# Troubleshooting

This page covers the most common runtime failures and practical fixes.

## 1) PWA shows `0 workspaces`

Checks:
1. Confirm hub is up:
   - `http://127.0.0.1:7777/healthz`
2. Confirm bridge is running in the target VS Code workspace:
   - Command Palette -> `VSC Codex Bridge: Show Status`
3. Confirm hub auth token in PWA matches hub config token.
4. Confirm hub is reachable from your current network path (LAN/Tailscale).

Fixes:
- Restart bridge in the workspace (`VSC Codex Bridge: Restart Bridge`).
- Restart hub from menubar Control Center (`Restart Hub`).
- If hub restarted, wait a few seconds: bridge auto re-register should recover workspaces.

## 2) PWA does not update in real time

Checks:
1. Observe stream pill in PWA (`Live`, `Reconnecting`, `Idle`).
2. Open browser devtools console and inspect `[pwa:<build>]` logs.
3. Hard refresh browser once to ensure latest assets are loaded.

Notes:
- PWA combines WebSocket streaming with polling fallback.
- Temporary network blips can force short reconnect cycles.

## 3) `Codex is thinking...` stuck or missing

Checks:
1. Verify latest PWA build is served (cache-busting query is versioned).
2. Verify selected thread actually has an active turn.
3. Confirm `thread/read` endpoint returns updated status.

Fixes:
- Hard refresh browser tab.
- Re-open selected thread from workspace drawer.
- Restart bridge if active turn state looks stale.

## 4) Message from PWA creates another thread or fails with thread errors

Symptoms:
- `thread not found` on send.
- New thread appears unexpectedly.

Current behavior:
- Bridge now force-creates a new thread when stale thread IDs fail with `thread not found`.

Fixes:
- Re-select target thread in drawer.
- Retry send once.
- If still failing, restart bridge and hub.

## 5) Extension cannot launch `codex` (`Could not launch 'codex'`)

Checks:
1. Ensure OpenAI ChatGPT extension is installed in VS Code.
2. Confirm bridge setting uses default command or correct path.

Notes:
- Bridge auto-resolves bundled `codex` binary from OpenAI extension when GUI `PATH` is limited.

## 6) Attach mode keeps failing (`ECONNREFUSED`, timeout)

Reality check:
- Attach mode is currently experimental and not reliable enough for daily usage.
- Recommended mode is `spawn`.

Fix:
- Set `vscCodexBridge.appServerMode` to `spawn`.

Research references:
- `docs/ATTACH_RESEARCH.md`
- `scripts/collect-attach-diagnostics.sh`

## 7) Hub reachable locally but not through LAN/Tailscale

Checks:
1. Hub bind host is not localhost-only.
2. Correct interface IP is used (LAN or Tailscale).
3. macOS firewall allows inbound port (default `7777`).
4. Token auth is configured and used.

Fixes:
- In Control Center set `bindHost` to `0.0.0.0` (or specific interface), then `Save + Restart`.
- Use mobile quick-connect URL in Control Center.

## 8) Control Center settings cannot be saved in packaged app

Checks:
1. App has write permissions to:
   - `~/Library/Application Support/vsc-codex-bridge-hub-menubar/`
2. Runtime logs in menubar log file for write errors.

Fixes:
- Restart app once.
- Ensure app is launched from `/Applications` install, not transient mount path.

## 9) VSIX package command warns about missing repository

Symptom:
- `A 'repository' field is missing ...`

Current tooling:
- Packaging script already uses `--allow-missing-repository`.

Fix:
- Use root command:
  - `npm run build:bridge:vsix`

## 10) Quick diagnostic bundle (manual)

Collect these before opening an issue:
1. Extension output logs (`VSC Codex Bridge` output channel).
2. Hub logs (`/tmp/vsc-codex-hub.log` or menubar log path).
3. `hub.config.json` (redact token before sharing).
4. Browser console logs from PWA.
5. Exact steps and timestamps.
