# Security

Version: 0.1  
Last updated: 2026-02-25  
Status: Living security baseline

This document defines the security posture for VSC Codex Bridge.

---

## 1. Security Objectives

Primary objectives:
- Protect the local development machine from unsafe remote control.
- Prevent unauthorized access to hub and bridge capabilities.
- Keep credentials and sensitive metadata out of logs and UI leaks.
- Preserve explicit user control over execution in risky paths.
- Keep deployment guidance simple and safe for single-user self-hosting.

---

## 2. Product Security Scope

### Supported threat boundary (current)
- Single trusted user operating own devices.
- Private network paths only (localhost, LAN with auth, Tailscale with auth).
- No supported public Internet deployment.

### Explicitly unsupported assumptions
- Multi-tenant user model.
- Strong identity federation/OIDC.
- Enterprise hardening profile.
- Public hostile network exposure without additional infrastructure.

---

## 3. Assets to Protect

Critical assets:
- Token used to authenticate hub API access.
- Execution control plane (message, approval, stop, steer endpoints).
- Filesystem integrity of local code workspace.
- Conversation/thread data containing proprietary code context.
- Session policy state (especially auto-approval session flags).

Sensitive metadata:
- Workspace absolute paths.
- Local network addresses and interface details.
- Logs containing command context or prompts.

---

## 4. Threat Model (MVP)

### 4.1 Threat actors
- Opportunistic actor on same LAN.
- Malware/process on local machine probing localhost ports.
- User misconfiguration exposing hub beyond intended boundary.
- Accidental leakage via logs, screenshots, or copied debug bundles.

### 4.2 Key risks
1. Unauthorized API calls that trigger execution.
2. Token theft or accidental disclosure.
3. Hub exposed on public interface without protection.
4. Approval bypass due to policy mismatch between UI and backend.
5. Sensitive data leakage in logs.

### 4.3 Security assumptions
- Machine-level OS account is trusted by owner.
- Tailscale identity layer is trusted when enabled.
- TLS for LAN HTTP is not guaranteed in MVP; network trust must be private.

---

## 5. Security Controls Baseline

## 5.1 Network exposure controls
- Default bind mode: `127.0.0.1`.
- If binding to LAN/Tailscale, token auth must be enabled.
- Warn loudly if unsafe bind/auth combination is detected.
- Do not support blind public bind as a documented deployment mode.

## 5.2 Authentication controls
- Hub accepts Bearer token for API access.
- Token generation must use cryptographically secure randomness.
- Token value should be shown only on explicit user action.
- Token rotation should be supported without app reinstall.

## 5.3 Authorization controls
- Single-user model means no roles, but still enforce endpoint-level checks:
  - authentication required for mutating actions;
  - policy checks before execution;
  - thread lock checks for turn actions.

## 5.4 Policy enforcement controls
- `Plan-only`:
  - deny execution by default;
  - require per-action approval.
- `Full-access`:
  - allow execution;
  - auto-approve by active session default;
  - still emit approval events for traceability.

---

## 6. Secure Configuration Defaults

Recommended defaults:
- Bind: localhost.
- Auth: enabled if any non-localhost bind is active.
- Verbose logs: disabled by default.
- Token storage: local file with owner-only permissions where possible.
- Auto-approval: scoped to active session only, never global forever.

Config anti-patterns to avoid:
- LAN bind with auth disabled.
- Reusing a weak token value.
- Long-lived auto-approval with no visible indicator.

---

## 7. Secret and Token Management

### Token lifecycle requirements
- Generate:
  - high entropy token (minimum 128 bits equivalent randomness).
- Store:
  - local config, avoid plain token in logs.
- Use:
  - send in Authorization header, never query string.
- Rotate:
  - regenerate token in settings UI/CLI.
- Revoke:
  - previous token immediately invalid after rotation.

### Handling guidance
- Never commit tokens to repository.
- Never paste token in screenshots/issues.
- Redact tokens in exported debug bundles.

---

## 8. Transport and Interface Security

### Hub public interface
- HTTP on private network for MVP.
- No public Internet recommendation.
- If user insists on remote access, prefer Tailscale over port forwarding.

### Bridge interface
- Bridge internal API should bind to loopback only.
- Hub-to-bridge communication remains local-only.

### CORS/origin handling
- Keep origin allowlist explicit once browser deployment patterns stabilize.
- Reject unknown origins in hardened mode.

---

## 9. Data Protection and Logging

### Logging policy
Do log:
- operational state changes;
- request IDs and route metadata;
- policy decisions (approved/denied path) without secret values.

Do not log:
- raw auth tokens;
- full sensitive prompt content unless verbose troubleshooting is explicitly enabled;
- full file contents by default.

### Redaction policy
Redact at minimum:
- `Authorization` header.
- Token-like fields in config dumps.
- Potential secret environment values when captured in diagnostics.

### Debug bundle policy
- Include logs and config snapshots with redaction.
- Include version/build metadata.
- Exclude tokens and personally sensitive identifiers when possible.

---

## 10. Execution Safety Model

Execution-related endpoints are high-risk:
- message send
- approval decision
- interrupt
- steer

Controls:
- Authenticate all mutating endpoints.
- Validate payload schema strictly.
- Enforce access mode policy in backend path.
- Record audit event for each execution-impacting action.

---

## 11. Polling Security Considerations

Polling is used for MVP mobile progress updates when stream attach is unavailable.

Security implications:
- Increased request frequency can expand observable metadata.
- Ensure polling endpoints require same auth checks as primary endpoints.
- Throttle excessive polling to prevent accidental self-DoS.

Recommended guardrails:
- minimum polling interval;
- server-side request rate limits per token/session;
- explicit client-side backoff on failures.

---

## 12. Hardening Checklist (Operational)

Before daily use:
- [ ] Hub bound to localhost, or private interface with token enabled.
- [ ] Strong token generated and not reused from another service.
- [ ] No public router port forwarding to hub.
- [ ] Logs configured with redaction enabled.
- [ ] Access mode default reviewed.

Before enabling LAN access from phone:
- [ ] Confirm trusted LAN environment.
- [ ] Confirm token is enabled and tested.
- [ ] Confirm insecure config warning is not present.
- [ ] Confirm device lock and basic mobile security settings are enabled.

Before enabling Tailscale access:
- [ ] Use only authenticated tailnet devices.
- [ ] Keep hub auth token enabled.
- [ ] Verify no overlapping public exposure exists.

---

## 13. Incident Response (Single-user Practical)

If compromise is suspected:
1. Stop hub process immediately.
2. Rotate auth token.
3. Inspect logs for suspicious requests.
4. Verify bind settings and disable unsafe exposure.
5. Reopen service in localhost mode first.

If token leaked publicly:
1. Revoke/rotate immediately.
2. Invalidate active sessions.
3. Review recent approvals and execution history.
4. Consider local machine malware scan if unknown activity appears.

---

## 14. Vulnerability Reporting

Until a dedicated process is added:
- Open a private channel if possible before filing a public issue for critical vulnerabilities.
- Include reproducible steps, affected version/commit, and impact summary.
- Avoid posting secrets, tokens, or private code in reports.

Future improvement:
- Add dedicated SECURITY.md policy section with disclosure SLA and contact.

---

## 15. Security Testing Strategy

Minimum tests to prioritize:
- Authentication required for mutating routes.
- Token rotation invalidates previous token.
- Redaction coverage for logs and debug exports.
- Plan-only execution is blocked without explicit per-action approval.
- Full-access session auto-approval is session-scoped and expires correctly.

Recommended additional tests:
- malformed payload rejection;
- replay/duplicate approval handling idempotency;
- rate limiting behavior for polling endpoints.

---

## 16. Known Security Limitations (MVP)

- No enterprise-grade identity model.
- No guaranteed end-to-end TLS in all LAN setups.
- Single-user trust model can still be undermined by local compromise.
- Polling increases request surface compared to pure push.

These limitations are acceptable only under the documented self-hosted trust assumptions.

---

## 17. Future Security Enhancements

Candidates for post-MVP:
- Optional mTLS or reverse-proxy TLS termination guidance.
- Per-device tokens and token scoping.
- Session timeout and explicit auto-approval expiration controls.
- Basic anomaly detection (unexpected endpoint spikes).
- Signed audit trail export.

---

## 18. Change Control

Any change affecting authentication, authorization, exposure, or redaction must:
- update this document,
- include test updates,
- include migration notes in PR description,
- be treated as high-review-priority changes.

