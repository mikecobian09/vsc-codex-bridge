# Architecture

Version: 0.1  
Last updated: 2026-02-26  
Status: Living design document

This document describes the target architecture for **VSC Codex Bridge** and should evolve alongside implementation.

---

## 1. Purpose

VSC Codex Bridge is a single-user system that enables remote control and observation of Codex sessions from mobile devices while keeping the local VS Code + plugin workflow on macOS.

Primary architectural goals:
- Keep local development ergonomics intact.
- Enable a mobile-first control plane for ongoing Codex work.
- Preserve safety boundaries and explicit execution policy modes.
- Keep deployment simple (self-hosted, LAN/Tailscale, no public cloud dependency).

---

## 2. Scope and Constraints

### In scope (MVP)
- Single-user operation.
- One bridge per VS Code window (single-root workspace).
- Hub as the only public interface for PWA clients.
- Mobile support through polling/streaming depending on event source capabilities.
- Local JSON persistence for runtime config and operational metadata.

### Out of scope (current product)
- Multi-user collaboration and role model.
- Multi-root workspace semantics.
- Public Internet exposure as a supported deployment mode.
- Mobile-side apply/revert patch workflows.

---

## 3. System Context

### High-level topology

```text
+----------------------+            +----------------------+            +----------------------+
|  PWA (Safari/iPhone) | <--------> |  Hub (Node.js)       | <--------> | Bridge (VS Code ext) |
+----------------------+   HTTP/WS  +----------------------+   HTTP/WS  +----------------------+
                                                                |
                                                                | local API
                                                                v
                                                       +----------------------+
                                                       | Codex app-server     |
                                                       +----------------------+
                                                                |
                                                                v
                                                       +----------------------+
                                                       | macOS filesystem     |
                                                       +----------------------+
```

### Trust boundaries
- Boundary A: mobile client <-> hub (network boundary).
- Boundary B: hub <-> bridge (loopback/internal control boundary).
- Boundary C: bridge/app-server <-> local filesystem (execution boundary).

---

## 4. Architectural Principles

- **Single entrypoint**: all client traffic terminates at hub.
- **Workspace isolation**: each bridge is scoped to one workspace root (`cwd`).
- **Explicit policy**: access modes are enforced by policy, not only by UI intent.
- **Fail safe defaults**: localhost-first, token protection outside localhost.
- **Observability by default**: deterministic event and error reporting.
- **Progressive fallback**: if streaming attach fails, degrade to incremental polling.

---

## 5. Component Responsibilities

## 5.1 VS Code Bridge Extension

Responsibilities:
- Detect workspace identity.
- Expose local bridge API (`/internal/v1/...`) to hub.
- Adapt Codex app-server events into normalized WS event envelope.
- Apply execution policy guardrails (`plan-only`, `full-access`).
- Maintain heartbeat to hub with liveness metadata.

Non-responsibilities:
- Public auth management.
- Multi-client session brokerage.
- Cross-workspace orchestration.

## 5.2 Hub (Node.js daemon)

Responsibilities:
- Maintain bridge registry and health state.
- Authenticate external requests.
- Proxy HTTP and WS between clients and target bridge.
- Serve static PWA assets.
- Persist runtime settings (JSON).
- Emit diagnostics and security warnings.

Non-responsibilities:
- Direct code execution on filesystem.
- Workspace-level policy inference from code content.

## 5.3 PWA

Responsibilities:
- Workspace/thread selection UI.
- Turn timeline rendering with stream deltas.
- Approvals modal handling.
- Stop/Steer controls.
- Polling fallback behavior for plugin-started turns when no live attach.

Non-responsibilities:
- Secret storage beyond session-friendly client state.
- Direct bridge communication.

## 5.4 Extension-managed runtime model

Responsibilities:
- Keep hub lifecycle close to VS Code workflow (extension-managed mode).
- Provide command-based operations (`Start Hub`, `Stop Hub`, `Restart Hub`, `Open PWA`).
- Keep one-install path for end users (VSIX only).

Non-responsibilities:
- Replacing hub web API.
- Owning bridge/hub domain logic outside extension lifecycle concerns.

---

## 6. Identity and Routing Model

### Workspace identity
- UI identifier: `workspaceName`.
- Stable routing identifier: `bridgeId = hash(cwd)`.
- Hard scoping key: absolute `cwd`.

### Required bridge metadata
- `bridgeId`
- `workspaceName`
- `cwd`
- `port`
- `pid`
- `startedAt`
- `bridgeVersion`

### Routing rule
All user actions route through `bridgeId`; UI labels are not used for uniqueness.

---

## 7. Data Flow Scenarios

## 7.1 Send message from PWA (primary path)

1. PWA sends `POST /api/v1/bridges/:bridgeId/threads/:threadId/message`.
2. Hub authenticates and validates payload.
3. Hub checks lock state for `threadId`.
4. Hub proxies to bridge internal message endpoint.
5. Bridge starts/resumes turn in app-server.
6. Bridge emits WS events.
7. Hub forwards events to PWA subscribers.
8. UI updates timeline, plan panel, and diff panel.

## 7.2 Approval request/decision path

1. Bridge emits `item/*/requestApproval`.
2. PWA opens modal with action metadata.
3. User submits decision.
4. PWA calls `POST /api/v1/bridges/:bridgeId/approvals/:approvalId/decision`.
5. Hub proxies to bridge.
6. Bridge relays decision to execution engine and emits follow-up status events.

## 7.3 Stop path

1. User clicks stop during active turn.
2. PWA calls interrupt endpoint.
3. Bridge interrupts active execution.
4. Bridge emits terminal `turn/completed` with `interrupted` status.
5. Lock is released.

## 7.4 Steer path

1. User submits steer text while turn is active.
2. PWA posts steer payload.
3. Bridge injects steering instruction into turn context.
4. New plan/diff updates are emitted and rendered.

## 7.5 Plugin-started turn observation

Desired:
- Attach to active stream and forward events.

Fallback:
- Poll thread state incrementally at fixed interval.

Acceptance condition:
- Running state and incremental progress are visible even when true stream attach is unavailable.

---

## 8. API and Event Contracts

Canonical contracts are maintained in README/docs until shared package schemas exist.

Implementation target:
- Move all public/internal request and WS schemas into `packages/shared`.
- Enforce schema validation at ingress (hub) and egress (bridge adapter).

### Contract governance
- Version field required for WS envelopes (`v`).
- Backward-compatible changes must be additive.
- Breaking changes require version bump and migration notes.

---

## 9. Access Mode Policy Architecture

## 9.1 Plan-only

Policy requirements:
- No automatic command or file execution.
- Each action requires explicit approval.
- Policy is enforced server-side even if client is compromised or stale.

Control point:
- Bridge policy layer (closest to execution path).

## 9.2 Full-access

Policy requirements:
- Execution allowed.
- Default approval behavior is auto-accept per active session.
- Approval events still emitted for audit/traceability.

Control point:
- Hub session state + bridge execution adapter.

---

## 10. Concurrency and State Management

## 10.1 Thread lock model

- One active turn per `threadId`.
- Lock acquisition at turn start.
- Lock release on terminal state (`completed`, `failed`, `interrupted`, timeout cleanup).
- New message while locked returns `409 Busy`.

## 10.2 Turn lifecycle (target)

```text
idle -> started -> running -> (approval_waiting <-> running)* -> completed
                                  |                    |
                                  +-> interrupted -----+
                                  +-> failed
```

## 10.3 Bridge lifecycle

```text
booting -> registered -> healthy -> degraded -> disconnected
```

Health signals:
- Heartbeat freshness.
- Proxy roundtrip success.
- Internal queue pressure.

---

## 11. Reliability and Degradation Strategy

### Failures and fallback behavior
- Bridge unreachable:
  - mark workspace offline;
  - preserve UI state;
  - allow retry.
- WS disconnect:
  - auto-reconnect with bounded backoff;
  - recover with state snapshot endpoint when available.
- Plugin-turn attach unavailable:
  - switch to polling mode;
  - display mode indicator to user.

### Idempotency considerations
- Interrupt and approval decisions should be safe for retried requests.
- Client retries should carry correlation IDs once request envelope is formalized.

---

## 12. Persistence Design (MVP JSON)

### Proposed storage files
- `hub-config.json`
- `hub-runtime.json`
- `sessions.json`
- `known-bridges.json` (optional cache)

### Data classes
- Security config (token enabled, token hash reference, bind mode).
- UX defaults (model, access mode).
- Session metadata (active session auto-approval state).
- Diagnostics metadata (last startup status, crash markers).

### Persistence rules
- Atomic writes using temp file + rename.
- JSON schema validation at load.
- Invalid config fallback to safe defaults + warning.

---

## 13. Observability

### Logging categories
- `auth`
- `routing`
- `bridge-registry`
- `turn-lifecycle`
- `approval-policy`
- `network`
- `errors`

### Recommended log fields
- timestamp
- level
- subsystem
- requestId/correlationId
- bridgeId/threadId/turnId (if available)
- decision and policy mode (for approval events)

### Metrics to add early
- active bridges
- active turns
- ws subscribers
- approval latency
- interrupt latency
- poll fallback usage rate

---

## 14. Performance Expectations

MVP targets:
- Bridge re-registration after hub restart under 10s.
- PWA-originated streaming update latency under 1s average.
- Polling fallback update cadence up to 2s.

Initial assumptions:
- Single-user, low parallelism.
- Limited number of concurrent active turns.
- LAN/Tailscale network quality better than public WAN.

---

## 15. Deployment Architecture

## 15.1 Development mode
- Run hub locally.
- Run bridge extension in VS Code development host.
- Serve PWA through hub.

## 15.2 Operational mode
- Hub managed by extension runtime (default) or standalone daemon in development.
- PWA consumed from mobile browser.
- Optional Tailscale path for private remote access.

## 15.3 Unsupported mode
- Public Internet exposure without strong reverse proxy hardening and additional controls.

---

## 16. Architecture Decision Records (ADR) Backlog

Recommended ADRs to formalize:
1. ADR-001: Single-user boundary and implications.
2. ADR-002: JSON persistence in MVP.
3. ADR-003: Access mode policy enforcement points.
4. ADR-004: Polling fallback for plugin-started turns.
5. ADR-005: Bridge identity (`hash(cwd)`) strategy.

---

## 17. Open Technical Questions

1. What exact heartbeat cadence gives best stability vs overhead?
2. Should hub keep short-lived event replay buffer for reconnecting clients?
3. How should session-scoped auto-approval expire (time-based vs turn-based)?
4. Do we need per-action policy categories in `plan-only` (read-only vs mutating)?
5. What is the minimum viable correlation strategy for cross-service tracing?

---

## 18. Change Management

When architecture changes:
- Update this document and relevant sections in README.
- Update internal product requirements if assumptions changed.
- Add or update ADR where a foundational decision changed.
- Record migration impact if API/event contract changed.
