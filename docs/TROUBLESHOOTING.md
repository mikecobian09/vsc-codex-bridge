# Troubleshooting

This page covers common runtime failures and practical fixes for the extension-only workflow.

## 1) PWA shows `0 workspaces`

Checks:
1. Confirm Hub is up: `http://127.0.0.1:7777/healthz`
2. Confirm bridge is running in the target workspace:
   - `VSC Codex Bridge: Show Status`
3. Confirm PWA token matches `vscCodexBridge.hubToken`.
4. Confirm Hub address is reachable from your current network path.

Fixes:
- `VSC Codex Bridge: Restart Hub`
- `VSC Codex Bridge: Restart Bridge`
- Wait a few seconds for auto re-register recovery after Hub restart.

## 2) PWA does not update in real time

Checks:
1. Observe stream state in PWA (`Live`, `Reconnecting`, `Idle`).
2. Open browser devtools and inspect `[pwa:<build>]` logs.
3. Hard refresh once to ensure latest assets are loaded.

Notes:
- PWA combines WebSocket streaming with polling fallback.
- Temporary network blips can force short reconnect cycles.

## 3) `Codex is thinking...` appears stuck or missing

Checks:
1. Verify latest PWA build is loaded (cache-busting query).
2. Verify selected thread has an active turn.
3. Confirm `thread/read` returns fresh status.

Fixes:
- Hard refresh browser.
- Re-open thread from drawer.
- Restart bridge if active-turn state looks stale.

## 4) Message from PWA creates another thread or fails with thread errors

Symptoms:
- `thread not found` on send.
- New thread appears unexpectedly.

Current behavior:
- Bridge force-creates a new thread when stale thread IDs fail with `thread not found`.

Fixes:
- Re-select target thread.
- Retry send once.
- Restart bridge and hub if issue persists.

## 5) Extension cannot launch `codex` (`Could not launch 'codex'`)

Checks:
1. Ensure OpenAI ChatGPT extension is installed.
2. Confirm bridge setting uses default command or a valid custom path.

Notes:
- Bridge auto-resolves bundled `codex` binary from OpenAI extension when VS Code GUI `PATH` is limited.

## 6) Attach mode keeps failing (`ECONNREFUSED`, timeout)

Reality:
- Attach mode remains experimental.
- Recommended mode is `spawn`.

Fix:
- Set `vscCodexBridge.appServerMode=spawn`.

Research:
- `docs/ATTACH_RESEARCH.md`
- `scripts/collect-attach-diagnostics.sh`

## 7) Hub works locally but not over LAN/Tailscale

Checks:
1. `vscCodexBridge.managedHubBindHost=0.0.0.0`
2. Correct LAN/Tailscale IP is used on mobile.
3. macOS firewall allows inbound port `7777`.
4. Token is configured and sent from PWA.

Fixes:
- Run `VSC Codex Bridge: Restart Hub` after host/port/token changes.
- Open PWA with token query once:
  - `http://<mac-ip>:7777/?token=<token>`

## 8) VSIX package command warns about missing repository

Symptom:
- `A 'repository' field is missing ...`

Fix:
- Use root command:
  - `npm run build:bridge:vsix`

## 9) Quick diagnostic bundle (manual)

Collect before opening an issue:
1. Extension output logs (`VSC Codex Bridge` output channel).
2. Hub logs (`managed-hub.log` in extension global storage or `/tmp/vsc-codex-hub.log` when using dev hub).
3. Effective settings (redact token).
4. Browser console logs from PWA.
5. Exact steps and timestamps.
