# VSC Codex Bridge

A single-user, self-hosted bridge that connects VS Code Codex workflows to a mobile-friendly web interface.

Current state: active implementation (bridge + hub + pwa + electron menubar baseline implemented).

---

## Table of Contents
1. [Project Status](#project-status)
2. [Vision](#vision)
3. [Goals and Non-Goals](#goals-and-non-goals)
4. [Product Scope (Decisions Already Closed)](#product-scope-decisions-already-closed)
5. [Core User Flows](#core-user-flows)
6. [System Architecture](#system-architecture)
7. [Planned Repository Structure](#planned-repository-structure)
8. [API Contract (v1)](#api-contract-v1)
9. [WebSocket Event Contract (v1)](#websocket-event-contract-v1)
10. [Access Modes and Approval Policy](#access-modes-and-approval-policy)
11. [Concurrency Model](#concurrency-model)
12. [Security Model](#security-model)
13. [Networking Modes](#networking-modes)
14. [Persistence Model](#persistence-model)
15. [Observability and Diagnostics](#observability-and-diagnostics)
16. [Implementation Roadmap](#implementation-roadmap)
17. [Testing Strategy](#testing-strategy)
18. [Contribution Guidelines](#contribution-guidelines)
19. [Documentation Plan](#documentation-plan)
20. [Known Risks](#known-risks)
21. [FAQ](#faq)
22. [License and Disclaimer](#license-and-disclaimer)

---

## Project Status

This repository is currently in active build mode:
- Product requirements are maintained in an internal PRD (not committed to this repository).
- Core architecture, API contracts, and scope decisions are defined.
- `packages/bridge-vscode` is implemented as the first functional package:
  - internal HTTP/WS bridge API,
  - real `codex app-server` integration (JSON-RPC over WebSocket),
  - stable app-server `spawn` mode for production workflows,
  - experimental strict `attach` mode (no silent fallback) with multi-strategy URL discovery (`pgrep` + `lsof`), currently not reliable enough for daily use,
  - approvals, interrupt, and steer flows,
  - hub registration/heartbeat client with automatic re-registration recovery,
  - thread-status hardening to avoid stale `activeTurnId` states after turn completion,
  - stale-thread send recovery that force-creates a fresh thread when `turn/start` reports `thread not found`,
  - richer intermediate timeline mapping for reasoning and command-execution items.
- `packages/hub` is implemented with bridge registry, HTTP proxy routes, WS stream proxy, static file serving, auth baseline, safe full JSON proxying for large thread payloads, and `no-cache` static headers for fast UI iteration.
- `packages/shared` is now scaffolded as the shared-contracts baseline and already validates mutating payloads (`message/steer/approval`) used by hub ingress.
- `packages/pwa` now ships a ChatGPT-style app UX (drawer navigation, nested workspace/thread tree, sticky composer, thinking indicators, send-vs-steer action switching, voice dictation, and rich markdown/plan/diff rendering).
- PWA thread refresh logic now keeps selected-thread polling active even when WS deltas are sparse, improving live updates without manual refresh.
- PWA now avoids overlapping thread-detail requests and falls back safely to `Idle` UI state when refresh errors occur, preventing sticky `Codex is thinking...` indicators.
- PWA HTML now uses versioned JS/CSS query strings to force stale Safari/PWA clients to load fresh runtime logic after updates.
- PWA API requests now use timeout + abort handling to avoid stale in-flight detail requests keeping the UI in a permanent thinking state.
- PWA CSS now enforces `[hidden] { display: none !important; }` to ensure DOM `hidden` state is respected for thinking/status overlays in all browsers.
- PWA thinking detection now trusts thread-level active lifecycle (`thread.status` + `activeTurnId`) when turn-level snapshots are temporarily stale, so `Thinking` appears only while turns are truly active.
- PWA now also tracks active-turn state from live WS activity events, so `Thinking` remains visible during real execution even when thread snapshots briefly lag behind.
- PWA now uses selected-thread summary fallback (`/threads`) and keeps last-known turn state through transient detail-refresh errors, reducing false `Idle` drops while the agent is still running.
- PWA now also detects active turns at workspace scope (other threads) and keeps the thinking indicator visible with contextual label, while preserving composer behavior for the selected thread.
- PWA now emits debug console traces for thinking-state transitions (for example: `[pwa:20260225-18]`) and exposes `window.__bridgePwaDebug` helpers for live browser-side diagnostics.
- PWA now captures very short turn activity from fresh thread updates (`recent completion` window) so the thinking indicator is still shown briefly even when turns start and finish between polling ticks.
- PWA mobile UI has been tightened for higher message density: darker grayscale palette, chat surface without border framing, compact one-line header (expandable), and compact composer with `mic + send` embedded inside the input field.
- Message sending is now button-driven on mobile UX (`Send` button only); Enter/Shift+Enter in the textarea no longer triggers send.
- PWA activity stream now renders as collapsed-by-default cards with per-turn expand/collapse.
- Drawer/backdrop layering now stays above header/chat while open, for app-like navigation behavior.
- Mic control is now icon-based (with active visual state), and bottom spacing below the composer has been reduced to maximize visible chat.
- PWA stream surface now exposes reconnect/backoff state (`Connecting`, `Reconnecting`, `Live`, `Idle`) and auto-recovers stream connection while turn polling remains active.
- When another thread is active in the same workspace, PWA shows a direct CTA to jump into that running thread.
- Long thread rendering now uses a basic windowed strategy (`Load older`) to keep mobile timeline scrolling responsive.
- PWA now shows an explicit in-chat connectivity banner for `offline`, `hub unreachable`, and `stream reconnecting` states, including contextual retry action.
- PWA now adapts to mobile keyboard/viewport changes via `visualViewport` handling so composer and chat remain usable while typing.
- Current manual validation shows the PWA is already usable as the primary control surface for active sessions.
- Hub now includes automated regression tests for mutating proxy route forwarding (`message`, `steer`, `interrupt`, `approval`) via in-memory route-handler tests.
- Hub test suite now includes an integration happy-path (real hub + mock bridge over HTTP + WS) that validates proxy/read/send/stream behavior end-to-end; it auto-skips in restricted environments that deny local socket bind.
- Hub test suite now also includes a browser-level PWA E2E harness (Playwright-gated) that automates `connect -> select thread -> send` against real hub + mock bridge.
- Hub now emits startup security posture warnings for risky bind/auth combinations and redacts common token patterns from runtime logs.
- Hub now enforces per-host mutating rate limits (`message/interrupt/steer/approval`) with configurable window/budget.
- Hub now enforces an explicit CORS/origin allowlist policy for API/WS entrypoints and records auth-denied audit logs with token-safe metadata.
- Bridge package now includes automated `AppServerStore` regression tests for `interrupt/steer/approval` lifecycle and approval-policy behavior.
- Bridge regression suite also covers app-server event mapping for `turn/started`, assistant message deltas, and `turn/completed`.
- `packages/electron` now has a working macOS menubar baseline with:
  - tray hub controls (`start/stop/restart`),
  - open/copy PWA URL actions,
  - mobile quick-connect snapshot (recommended URL with embedded token, LAN/Tailscale candidates),
  - live connected-workspace listing,
  - Control Center window for settings + diagnostics,
  - VS Code Night-style Control Center refresh (dark neutral palette),
  - scroll-safe layout so all controls are reachable on smaller windows,
  - explicit security posture banner (local-only vs remote bind + token strength hints).
- Packaged menubar mode now bootstraps safer remote defaults automatically:
  - `bindHost: 0.0.0.0` (LAN/Tailscale reachable),
  - generated `authToken` when missing,
  - persisted user config under macOS Application Support.
- PWA now accepts `?token=<...>` (or `?authToken=<...>`) for one-tap mobile onboarding, persists token locally, and removes token from browser URL after first load.
- Detailed architecture reference: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).
- Security baseline and hardening guidance: [`docs/SECURITY.md`](./docs/SECURITY.md).

This README is intentionally detailed and designed to evolve with implementation.

### Beginner Install Guide (VSIX + PKG, step-by-step)

Use this flow if you want a straightforward setup on macOS with minimal manual configuration.

#### 0) Prerequisites

1. Install Node.js 20+.
2. Install Visual Studio Code.
3. Ensure the OpenAI ChatGPT VS Code extension is installed (the bridge uses its bundled `codex` binary fallback if your GUI `PATH` is limited).
4. Clone this repository locally.

#### 1) Build installable artifacts

From repository root:

```bash
npm install
npm --prefix packages/electron install
npm --prefix packages/bridge-vscode install
npm run build
npm run build:bridge:vsix
npm run build:electron:macos-installer
```

After this, you will have:
- extension VSIX in `.local/release/extensions/`
- hub macOS PKG in `.local/release/macos/`

#### 2) Install the VS Code bridge extension

Option A (GUI):
1. Open VS Code.
2. Open Command Palette.
3. Run `Extensions: Install from VSIX...`.
4. Select `.local/release/extensions/vsc-codex-bridge-latest.vsix`.

Option B (CLI):

```bash
npm run install:bridge:vsix
```

Verify:
- In VS Code command palette, search `VSC Codex Bridge: Show Status`.
- Ensure `vscCodexBridge.autoStartBridge` is enabled (default is `true`).

#### 3) Install the Hub menubar app (PKG)

1. Open `.local/release/macos/VSC-Codex-Bridge-Hub-<version>-macos.pkg`.
2. Complete installer steps (target `/Applications`).
3. Open `VSC Codex Bridge Hub` from Applications.
4. You should see `CB` in macOS menu bar.

#### 4) First run defaults (already preconfigured)

In packaged mode, first launch now auto-bootstraps:
- `bindHost = 0.0.0.0` (reachable from LAN/Tailscale),
- random `authToken` if none exists.

Config files are persisted under:
- `~/Library/Application Support/vsc-codex-bridge-hub-menubar/hub.config.json`
- `~/Library/Application Support/vsc-codex-bridge-hub-menubar/menubar.settings.json`

#### 5) One-tap mobile setup

1. From menu bar app, open `Control Center`.
2. In `Hub Settings`, use `Mobile quick connect`.
3. Click `Copy URL` (recommended URL already includes token query).
4. Send/open that URL on phone (AirDrop, Notes, Messages, etc.).
5. PWA will read token from URL, save it locally, and clean token from the address bar.

Tips:
- `Open URL`: opens the recommended URL directly on your Mac browser.
- `Copy token`: quick copy for manual input fallback.
- `Generate token`: creates a new token in the form; click `Save + Restart` to activate it.

#### 6) Daily usage flow

1. Open a workspace in VS Code.
2. Bridge auto-starts for that workspace (`autoStartBridge=true`).
3. Open PWA on phone.
4. Select workspace -> thread.
5. Send prompt from mobile or VS Code.
6. Monitor progress, stop, steer, and approvals from mobile.

#### 7) Tailscale/LAN notes

1. Keep token enabled when using non-localhost access.
2. If both LAN and Tailscale are available, Control Center shows candidate URLs for each interface.
3. Prefer Tailscale URL for remote/private access outside your home LAN.
4. If mobile cannot connect:
   - verify hub is running (`Hub status: online` in Control Center),
   - verify selected IP is reachable from phone,
   - verify token in PWA matches current hub token,
   - verify firewall allows inbound port `7777` on your Mac.

### Quick Start (Current Baseline)

1. Build all current packages:
```bash
npm run build
```
2. Start the hub:
```bash
npm run dev:hub
```
3. In another shell, build PWA assets when you change UI files:
```bash
npm run build:pwa
```
4. Run bridge regression tests:
```bash
npm run test:bridge
```
5. Run hub regression tests:
```bash
npm run test:hub
```
6. Run browser-level PWA E2E harness (requires Playwright available):
```bash
npm run test:e2e:pwa
```
7. Build/reload VS Code extension quickly during development:
```bash
./.local/scripts/reload-bridge.sh
```

To force a full VS Code app restart (all windows), use:
```bash
./.local/scripts/reload-bridge.sh --restart
```
8. Build extension VSIX artifact:
```bash
npm run build:bridge:vsix
```
9. Build and install extension VSIX into local VS Code:
```bash
npm run install:bridge:vsix
```
10. Open:
- `http://127.0.0.1:7777`
11. Launch the menubar app (macOS):
```bash
npm --prefix packages/electron install
npm run dev:electron
```

Launcher helper using local electron dependency:
```bash
npm run run:electron
```

Experimental fallback using VS Code's Electron binary:
```bash
npm run run:electron:vscode
```

Build macOS installable artifacts (`.app`, `.zip`, `.pkg`, and `.dmg` best-effort):
```bash
npm run build:electron:macos-installer
```

Inside the menubar menu, use `Open Control Center` to edit hub settings and see live diagnostics.
You can also enable:
- `Launch At Login` (start menubar app on macOS login),
- `Auto-start Hub On App Launch` (start hub automatically when app opens).

### Installers and Release Links

- Extension VSIX local output (scripted): `.local/release/extensions/vsc-codex-bridge-<version>.vsix`.
- Extension VSIX convenience alias (latest local build): `.local/release/extensions/vsc-codex-bridge-latest.vsix`.
- Hub macOS installer local output (`pkg`): `.local/release/macos/VSC-Codex-Bridge-Hub-<version>-macos.pkg`.
- Hub macOS app bundle local output: `.local/release/macos/VSC Codex Bridge Hub.app`.
- Planned public release link (extension VSIX): `TBD (GitHub Releases)`.
- Planned public release link (hub macOS PKG): `TBD (GitHub Releases)`.
- If VSIX packaging fails in an offline environment, install VSCE once locally: `npm --prefix packages/bridge-vscode install --save-dev @vscode/vsce`.

Release publication/checklist is documented in [`docs/RELEASES.md`](./docs/RELEASES.md).

### Hub/Bridge Resilience (Current)

- The bridge no longer assumes startup registration succeeds.
- If registration fails, the bridge retries automatically with exponential backoff + jitter.
- If heartbeat returns `404` (hub restarted and forgot bridge state), bridge re-registers automatically.
- This removes the need to manually restart VS Code bridge after most hub restarts.
- Bridge extension auto-starts by default in each VS Code workspace window (`vscCodexBridge.autoStartBridge=true`).

### App-Server Mode Recommendation (Current)

- Recommended mode: `spawn`.
- Why: it is the only consistently reliable mode in current real-world usage.
- Bridge startup now auto-resolves `codex` from the bundled OpenAI ChatGPT extension binary when VS Code `PATH` does not include `codex`.
- `attach` is still implemented and documented, but remains an open contributor challenge because no stable plugin-owned app-server attach target has been consistently reachable.
- Main reason we still want `attach`: true **bidirectional live updates** between VS Code plugin and PWA (plugin -> PWA and PWA -> plugin) without manual refresh/restart cycles.

### Attach Mode Contributor Challenge

Attach is still the preferred long-term architecture, but currently blocked by runtime observability/reachability issues.

Current failure signatures:
- Repeated attach retries ending in `ECONNREFUSED` / timeout against auto-detected localhost WS ports.
- Plugin-side warnings such as:
  - `local-environments is not supported in the extension`
  - `thread-stream-state-changed` broadcasts without registered handler
- No documented stable API in the plugin that exposes a guaranteed-live app-server WS endpoint.

What a successful contribution should prove:
1. Reliable attach URL source (not stale process metadata).
2. Stable connect/reconnect across plugin or extension-host restarts.
3. Bidirectional parity in live updates for both plugin-started and PWA-started turns without manual restarts.

Research assets:
- [`docs/ATTACH_RESEARCH.md`](./docs/ATTACH_RESEARCH.md): current findings, hypotheses, and acceptance matrix.
- `./scripts/collect-attach-diagnostics.sh`: reproducible local diagnostics snapshot for attach experiments.

---

## Vision

Build an open source personal system that lets one user:
- Keep using VS Code + Codex plugin on macOS.
- Continue and monitor Codex work from mobile (PWA).
- Operate against the real project filesystem on the Mac.
- Stop, steer, and approve actions remotely.
- Use LAN first, then Tailscale for private remote access.

The project will ship in two operational forms:
- Node.js daemon (`hub`) for technical users.
- macOS Electron menubar app for easier day-to-day operation.

---

## Goals and Non-Goals

### Goals (MVP v1)
- Discover active workspaces through one bridge per VS Code window.
- List and open conversation threads from a mobile PWA.
- Send messages and receive streamed responses.
- Handle approvals from mobile.
- Show aggregated turn diff.
- Support `Stop` and `Steer` actions during active turns.
- Allow model selection and access mode per turn.
- Keep a safe default networking/auth posture.

### Non-Goals (MVP v1)
- Multi-root workspaces.
- Multi-user collaboration and role-based access.
- Full public Internet exposure with advanced hardening.
- Mobile-side apply/revert editing workflows for diffs.

---

## Product Scope (Decisions Already Closed)

Closed decisions as of 2026-02-25:
- Product model: `single-user` only.
- `Plan-only` mode: block all execution and require explicit approval for each action.
- `Full access` mode default: auto-accept approvals per active session.
- Persistence format: local JSON files.
- Mobile notification approach for MVP: polling (no Web Push in MVP).

These decisions are part of the current baseline and should not be changed casually.

---

## Core User Flows

### 1) Mobile-controlled turn (started from PWA)
1. Open PWA (`http://<host>:7777`).
2. Select workspace.
3. Select thread.
4. Send prompt.
5. Observe streaming output.
6. Respond to approvals when requested.
7. Review aggregated diff.
8. Return to Mac and continue in VS Code.

### 2) Mobile observation of plugin-started turn
1. Start long task in VS Code plugin.
2. Open the same workspace/thread from mobile.
3. Current baseline follows polling/stream reconciliation to keep mobile progress visible.
4. Experimental attach-mode paths may improve parity in the future once a reliable attach target is solved.
5. User still sees progress incrementally (best effort).

### 3) Mid-turn control
- `Stop`: interrupt active turn.
- `Steer`: inject correction ("do X first", "do not edit Y", etc.).

---

## System Architecture

### Components

1. VS Code Bridge Extension (per window)
- Identifies `workspaceName` and `cwd`.
- Connects to local Codex app-server.
- Exposes internal HTTP/WS endpoints.
- Registers and heartbeats with hub.

2. Hub (Node.js daemon)
- Single entrypoint for PWA and Electron.
- Registry of active bridges.
- Reverse proxy for bridge HTTP and WS traffic.
- Hosts static PWA assets.
- Handles authentication and runtime config.

3. PWA (chat-first web app)
- Top-bar + left drawer UX (ChatGPT-style navigation flow).
- Nested workspace/thread tree with sticky selection.
- Infinite chat timeline with streaming assistant rendering.
- Rich response renderer (markdown, links, code blocks, plan snippets, diff blocks).
- Thinking indicator + dynamic composer action (`Send` vs `Steer`).
- Voice dictation support (browser-dependent).
- Inline approval decisions and stop/steer/model/mode controls.

4. Electron menubar app (macOS)
- Start/stop/restart hub.
- Show status and warnings.
- Open web UI and settings.
- Provide simple diagnostics access.

### High-Level Data Path

`PWA <-> Hub <-> Bridge <-> Codex app-server <-> Filesystem`

---

## Planned Repository Structure

Target monorepo layout:

```text
codex-hub/
  README.md
  LICENSE
  docs/
    SECURITY.md
    TROUBLESHOOTING.md
    ARCHITECTURE.md
  packages/
    hub/
      src/
      public/
      config/
      package.json
    pwa/
      src/
      build/
      package.json
    bridge-vscode/
      src/
      package.json
      tsconfig.json
    electron/
      main.js
      package.json
    shared/
      src/
      package.json
```

Current repo status:
- `packages/bridge-vscode` implemented.
- `packages/hub` implemented baseline.
- `packages/pwa` implemented baseline.
- `packages/electron` baseline implemented (tray controls + workspace visibility).

---

## API Contract (v1)

All public endpoints are served by hub.

Authentication:
- `Authorization: Bearer <token>` when auth is enabled.

### Public Hub API (`/api/v1`)

Bridges:
- `GET /api/v1/bridges`
- `GET /api/v1/bridges/:bridgeId/meta`

Threads:
- `GET /api/v1/bridges/:bridgeId/threads?cursor=&limit=`
- `GET /api/v1/bridges/:bridgeId/threads/:threadId`

Turns:
- `POST /api/v1/bridges/:bridgeId/threads/:threadId/message`
  - body: `{ "text": "...", "modelId": "...", "accessMode": "plan-only|full-access" }`
  - response: `{ "turnId": "..." }`
- `POST /api/v1/bridges/:bridgeId/turns/:turnId/interrupt`
- `POST /api/v1/bridges/:bridgeId/turns/:turnId/steer`
  - body: `{ "text": "..." }`

Approvals:
- `POST /api/v1/bridges/:bridgeId/approvals/:approvalId/decision`
  - body: `{ "decision": "approve|deny" }`

WebSocket:
- `GET /ws/v1/bridges/:bridgeId/turns/:turnId`

### Internal Bridge API (`/internal/v1`)

Hub-to-bridge routes:
- `GET /internal/v1/meta`
- `GET /internal/v1/threads`
- `GET /internal/v1/threads/:threadId`
- `POST /internal/v1/threads/:threadId/message`
- `POST /internal/v1/turns/:turnId/interrupt`
- `POST /internal/v1/turns/:turnId/steer`
- `POST /internal/v1/approvals/:approvalId/decision`
- `WS /internal/v1/turns/:turnId/stream`

---

## WebSocket Event Contract (v1)

Standard envelope:

```json
{
  "v": 1,
  "seq": 42,
  "ts": "2026-02-25T09:00:00.000Z",
  "bridge": {
    "bridgeId": "bridge_123",
    "workspaceName": "my-workspace",
    "cwd": "/Users/me/project"
  },
  "context": {
    "threadId": "thread_123",
    "turnId": "turn_123"
  },
  "method": "item/agentMessage/delta",
  "params": {}
}
```

Minimum event methods:
- Hub:
  - `hub/hello`
  - `hub/error`
  - `hub/state` (optional snapshot)
- Turn:
  - `turn/started`
  - `turn/plan/updated`
  - `turn/diff/updated`
  - `turn/completed`
- Item:
  - `item/started`
  - `item/agentMessage/delta`
  - `item/completed`
- Approvals:
  - `item/commandExecution/requestApproval`
  - `item/fileChange/requestApproval`

Rendering rules:
- Create assistant bubble on `item/started` for message items.
- Append text chunks on `item/agentMessage/delta`.
- Finalize item content on `item/completed`.
- Refresh plan and diff panels on turn updates.
- Open approval modal when approval event arrives.

---

## Access Modes and Approval Policy

### Plan-only
- No command/file execution is performed automatically.
- Every requested action requires explicit user approval.
- If backend does not support strict mode natively, bridge enforces policy.

### Full access
- Execution is allowed as normal.
- Default approval policy is auto-accept per active session.
- Approval events remain visible for traceability.

---

## Concurrency Model

- One active lock per `threadId`.
- New message on locked thread returns `HTTP 409 Busy`.
- User can `Stop` or `Steer` instead of starting parallel work in the same thread.

---

## Security Model

Security posture is intentionally conservative:
- Default bind should be localhost.
- If exposed to LAN/Tailscale, token auth should be enabled.
- Public Internet exposure is not supported.
- Logs must redact secrets and tokens.

Required documentation (planned):
- `SECURITY.md` with hard rules and safe deployment guidance.
- Explicit warning against port-forwarding hub to public networks.

---

## Networking Modes

### Localhost mode
- Bind: `127.0.0.1`
- Best for local development and safety.

### LAN mode
- Bind: `0.0.0.0` or specific interface.
- Use token auth.
- Access from phone via `http://<mac-lan-ip>:7777`.

### Tailscale mode
- Bind to Tailscale interface/IP.
- Keep auth enabled.
- Allows private remote access without public exposure.

---

## Persistence Model

Persistence backend for MVP is JSON files on local disk.

Planned persisted data includes:
- Hub runtime config.
- Auth and networking settings.
- Default model/access mode.
- Operational metadata required for recovery.

Future evolution (not MVP) may revisit storage choices if scale/complexity grows.

---

## Observability and Diagnostics

Expected diagnostics capabilities:
- Basic structured logs in hub and bridge.
- Warning indicators for insecure config (for example: LAN bind without token).
- Optional verbose mode for troubleshooting.
- Exportable debug bundle (redacted config + logs) in Electron flow.

---

## Implementation Roadmap

### M0 - Feasibility Spike (critical) `[~]`
- Validate thread listing and workspace scoping.
- Validate turn start/resume and delta events.
- Validate plugin-started turn visibility under polling/stream fallback (baseline achieved).
- Keep real-time attach as an open investigation track (not solved yet in this environment).

### M1 - Hub + Bridge hello world `[x]`
- Bridge registration/heartbeat.
- Workspace list visible in PWA.

### M2 - Threads and history `[~]`
- Thread list per workspace.
- Thread history rendering.

### M3 - Chat and streaming from PWA `[~]`
- Send message.
- Receive WS streaming.
- Show plan/diff panels.

### M4 - Approvals + Stop + Steer `[~]`
- Approval modal and decision posting.
- Interrupt endpoint wired.
- Mid-turn steer path wired.

### M5 - Electron menubar `[~]`
- Runtime status.
- Start/stop/restart.
- Settings + diagnostics control center.
- Open-web-UI action.

### Current Next Slice
1. Continue migrating hub/bridge HTTP + WS contracts into `packages/shared` runtime-validated schemas.
2. Expand `packages/electron` menubar with launch-at-login, diagnostics export, and packaging flow.
3. Expose risky network/auth posture banners directly in PWA settings/connection UI.
4. Add bridge-side app-server crash auto-restart with bounded exponential backoff budget.
5. Keep attach-mode R&D active in parallel, but keep production recommendation as `spawn`.
6. Resume deeper E2E expansion after these feature blocks (intentionally deferred for now).

---

## Testing Strategy

### Unit tests
- Hub registry TTL and auth middleware.
- Shared schema validation.
- PWA event reducers and streaming rendering logic.

### Integration tests
- Bridge registration with hub.
- Thread listing.
- Turn streaming lifecycle.
- Approval flow.
- Interrupt and steer behavior.

### Manual validation scripts
- Multiple VS Code windows/workspaces.
- iPhone access over LAN.
- Mid-turn stop/steer behavior.
- Hub restart and bridge re-registration.
- Polling behavior for plugin-started active turns.

---

## Contribution Guidelines

Community contribution workflow is documented in [`CONTRIBUTING.md`](./CONTRIBUTING.md).
AI coding agents should start with [`AGENTS.md`](./AGENTS.md) for repo-specific execution context and workflow expectations.

Key expectations:
- Keep changes focused and scoped.
- Prefer reliability and observability over cleverness.
- Add or update tests for behavior changes.
- Update docs in the same PR when contracts, commands, or UX behavior change.
- Keep security posture explicit; avoid silent auth/network downgrades.

---

## Documentation Plan

This README is the high-level operational document.

Current supporting docs:
- `docs/ARCHITECTURE.md`: deeper component diagrams and data paths.
- `docs/SECURITY.md`: deployment hardening and threat boundaries.
- `docs/ATTACH_RESEARCH.md`: attach-mode investigation, evidence, and contributor protocol.
- `docs/RELEASES.md`: release artifact matrix and publish checklist.
- `docs/TROUBLESHOOTING.md`: setup/runtime issue playbook and recovery steps.
- `CONTRIBUTING.md`: development workflow and PR quality bar.
- `AGENTS.md`: fast-start operating guide for AI coding agents.

As implementation progresses, this README should be updated with:
- actual setup commands,
- final package names,
- build/test/release instructions,
- compatibility matrix.

---

## Known Risks

1. Plugin-started turn observability still lacks a reliable real-time attach path to plugin-owned app-server sessions.
- Mitigation: polling/tailing fallback with acceptable latency target.

2. Policy enforcement mismatch between desired access modes and backend capabilities.
- Mitigation: enforce approval policy in bridge/hub layer.

3. Network misconfiguration by end users.
- Mitigation: secure defaults and visible warnings.

4. UX drift between plugin experience and mobile bridge experience.
- Mitigation: keep event contract and rendering rules explicit and testable.

5. Thread-targeting drift under concurrent thread activity.
- Mitigation: enforce selected-thread send invariants and add regression tests.

---

## FAQ

### Is this an official OpenAI product?
No. This is an independent open source project intended for personal use.

### Does it support multiple users?
No. Product scope is single-user.

### Does MVP include push notifications on iPhone?
No. MVP uses polling.

### Can I expose this publicly on the Internet?
Not recommended and not supported by current scope.

### What storage does MVP use?
Local JSON persistence.

---

## License and Disclaimer

Planned license: MIT.

Important disclaimer:
- Provided "AS IS", without warranties.
- Users are responsible for safe deployment and account usage.
- Do not expose hub endpoints to the public Internet.

---

## Living Document Note

This README is intentionally detailed and expected to change as implementation lands.
When behavior changes, update this file in the same PR to keep docs and code aligned.
