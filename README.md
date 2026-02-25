# VSC Codex Bridge

A single-user, self-hosted bridge that connects VS Code Codex workflows to a mobile-friendly web interface.

Current state: planning and architecture phase.

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

This repository is currently in specification mode:
- Product requirements are maintained in an internal PRD (not committed to this repository).
- Core architecture, API contracts, and scope decisions are defined.
- Implementation code is not yet scaffolded in this repository.
- Detailed architecture reference: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).
- Security baseline and hardening guidance: [`docs/SECURITY.md`](./docs/SECURITY.md).

This README is intentionally detailed and designed to evolve with implementation.

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
3. System attempts to attach to active turn stream.
4. If attach is unavailable, fallback to polling/tailing.
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

3. PWA (mobile-first web client)
- Workspace and thread selectors.
- Chat timeline with streaming rendering.
- Plan and diff panels.
- Approval modal.
- Stop/Steer/model/mode controls.

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
      src/
      package.json
    shared/
      src/
      package.json
```

Current repo status is smaller and pre-scaffold.

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

### M0 - Feasibility Spike (critical)
- Validate thread listing and workspace scoping.
- Validate turn start/resume and delta events.
- Validate whether plugin-started turns can be attached in real time.
- Decide final strategy: true attach vs polling fallback.

### M1 - Hub + Bridge hello world
- Bridge registration/heartbeat.
- Workspace list visible in PWA.

### M2 - Threads and history
- Thread list per workspace.
- Thread history rendering.

### M3 - Chat and streaming from PWA
- Send message.
- Receive WS streaming.
- Show plan/diff panels.

### M4 - Approvals + Stop + Steer
- Approval modal and decision posting.
- Interrupt endpoint wired.
- Mid-turn steer path wired.

### M5 - Electron menubar
- Runtime status.
- Start/stop/restart.
- Basic settings and open-web-UI action.

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

This project is currently pre-implementation; contributions should focus on clarity and correctness.

### Before opening a PR
- Read this README and the docs in `docs/`.
- Keep scope aligned with single-user model.
- Avoid introducing unsupported assumptions as hard commitments.

### PR expectations
- Small, focused changes.
- Clear rationale and tradeoffs.
- Tests where relevant.
- Documentation updates whenever behavior or contracts change.

### Coding principles (target)
- Type-safe contracts in shared package.
- Explicit error handling.
- Fail-safe defaults over convenience defaults.
- No silent security downgrades.

---

## Documentation Plan

This README is the high-level operational document.

Current supporting docs:
- `docs/ARCHITECTURE.md`: deeper component diagrams and data paths.
- `docs/SECURITY.md`: deployment hardening and threat boundaries.

Planned additional docs:
- `docs/TROUBLESHOOTING.md`: setup and runtime issue playbooks.

As implementation progresses, this README should be updated with:
- actual setup commands,
- final package names,
- build/test/release instructions,
- compatibility matrix.

---

## Known Risks

1. Plugin-started turn observability may not support real-time attach.
- Mitigation: polling/tailing fallback with acceptable latency target.

2. Policy enforcement mismatch between desired access modes and backend capabilities.
- Mitigation: enforce approval policy in bridge/hub layer.

3. Network misconfiguration by end users.
- Mitigation: secure defaults and visible warnings.

4. UX drift between plugin experience and mobile bridge experience.
- Mitigation: keep event contract and rendering rules explicit and testable.

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
