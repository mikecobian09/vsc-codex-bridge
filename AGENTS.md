# AGENTS.md

Fast operational guide for AI coding agents working in this repository.

## 1) Mission

`VSC Codex Bridge` connects:
- VS Code Codex workflows,
- a local bridge extension,
- a Hub service,
- and a mobile-first PWA.

Primary user value:
- start/monitor/control Codex turns from phone,
- keep working on the same Mac filesystem,
- support approvals, interrupt, and steer remotely.

Current product model:
- single user,
- JSON persistence,
- `plan-only` blocks all execution and requires per-action approval,
- `full-access` defaults to session auto-approve,
- polling is acceptable for mobile MVP notifications,
- extension-only distribution (managed Hub inside extension).

## 2) Repo Map

- `packages/bridge-vscode`: VS Code extension (bridge + managed hub runtime + internal API + app-server adapter).
- `packages/hub`: HTTP/WS hub, bridge registry, auth, static PWA host.
- `packages/pwa`: mobile web app.
- `packages/shared`: shared contracts/validators.
- `scripts/`: packaging and runtime helper scripts.
- `docs/`: architecture, security, release notes, attach research.

## 3) Ground Truth (Important)

1. Bridge runtime recommendation is `spawn` mode.
2. `attach` mode exists but is still experimental/unreliable in real plugin sessions.
3. Managed hub default bind for extension mode is `0.0.0.0` (LAN friendly).
4. PWA supports one-tap mobile onboarding via `?token=` in URL.
5. Internal PRD file (`vcs-codex-bridge.prd`) is intentionally ignored from git.

## 4) Core Commands

Run from repo root unless noted.

Build everything:
```bash
npm run build
```

Run hub in development:
```bash
npm run dev:hub
```

Build/reload extension quickly:
```bash
./.local/scripts/reload-bridge.sh
```

Build VSIX:
```bash
npm run build:bridge:vsix
```

Build and locally install VSIX:
```bash
npm run install:bridge:vsix
```

## 5) Typical Runtime Topology

`PWA <-> Hub <-> Bridge Extension <-> codex app-server`

- One bridge instance per VS Code workspace window.
- Hub is single ingress for PWA traffic.
- Bridge exposes local internal HTTP/WS API consumed by hub.

## 6) Where To Change Things

Bridge runtime / lifecycle / app-server:
- `packages/bridge-vscode/src/bridgeController.ts`
- `packages/bridge-vscode/src/managedHubRuntime.ts`
- `packages/bridge-vscode/src/appServerClient.ts`
- `packages/bridge-vscode/src/appServerStore.ts`
- `packages/bridge-vscode/src/hubClient.ts`

Hub proxy / auth / routes / ws:
- `packages/hub/src/server.ts`
- `packages/hub/src/bridgeProxy.ts`
- `packages/hub/src/registry.ts`
- `packages/hub/src/config.ts`

PWA behavior and UX:
- `packages/pwa/src/app.js`
- `packages/pwa/src/styles.css`
- `packages/pwa/src/index.html`

## 7) Debug Playbook

If PWA shows `0 workspaces`:
1. Check hub health endpoint.
2. Check bridge output log for register/heartbeat failures.
3. Verify hub token and PWA token match.
4. Confirm hub bind host/port is reachable from client network.

If PWA updates lag or freeze:
1. Inspect stream state (`Live/Reconnecting/Idle`) in UI.
2. Verify polling is still running for selected thread.
3. Inspect browser console for `[pwa:<build>]` debug traces.
4. Verify stale cached JS/CSS is not loaded (cache-busting query strings).

If attach mode fails:
1. Treat as expected until proven reliable.
2. Capture diagnostics with `scripts/collect-attach-diagnostics.sh`.
3. Prefer spawn mode for production usage.

## 8) Quality Bar Before Commit

For behavior changes:
1. Compile all packages.
2. Run relevant tests in touched packages.
3. Validate key manual flow (bridge start, hub reachable, PWA load, thread send).
4. Update docs in same commit when contracts or UX changed.

Minimum command set:
```bash
npm run build
npm run test:bridge
npm run test:hub
```

If tests are intentionally skipped, explain why in commit/PR notes.

## 9) Documentation Rules For Agents

When you change behavior, update at least one of:
- `README.md` for user-facing install/usage/runtime behavior,
- package README inside touched package,
- `docs/*` for deep technical/security/release info.

Also keep checklist/changelog in internal PRD locally updated for operator workflow.

## 10) Security and Operational Constraints

- Do not suggest public internet exposure of hub without hardening.
- Keep token auth enabled for LAN/Tailscale usage.
- Never log raw secrets/tokens.
- Avoid destructive git/file operations unless explicitly requested.

## 11) First Response Template For New Agents

When you first enter this repo, do:
1. `git status --short`
2. `npm run build`
3. read `README.md` sections: Install and Use, Required Settings, Runtime Topology
4. read `docs/ARCHITECTURE.md` and `docs/SECURITY.md`

Then confirm:
- current runtime mode assumption (`spawn`),
- current target surface (bridge/hub/pwa),
- expected verification command(s).
