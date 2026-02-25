# VSC Codex Bridge Hub

Node.js daemon that acts as the single public entry point for mobile/web clients.

## Current capabilities

- Receives bridge registration and heartbeat.
- Maintains an in-memory active bridge registry with stale pruning.
- Exposes public bridge/thread/turn/approval API routes.
- Proxies turn streaming over WebSocket (`PWA -> Hub -> Bridge`).
- Serves static PWA files from `packages/pwa/dist` by default.
- Supports bearer-token authentication.
  - For browser WebSocket handshakes, token can be provided as `?token=...` fallback.
- Enforces per-host mutation rate limits (`message`, `interrupt`, `steer`, `approval`).
- Enforces explicit origin checks for API/WS with configurable cross-origin allowlist.
- Emits auth-denied audit logs with token-safe metadata.

## Configuration

Configuration is loaded from:

1. Environment variables (highest priority)
2. `packages/hub/config/hub.config.json`
3. Built-in defaults

Environment variables:

- `VSC_CODEX_HUB_BIND_HOST` (default: `127.0.0.1`)
- `VSC_CODEX_HUB_PORT` (default: `7777`)
- `VSC_CODEX_HUB_TOKEN` (default: empty)
- `VSC_CODEX_HUB_BRIDGE_TTL_MS` (default: `15000`)
- `VSC_CODEX_HUB_PRUNE_INTERVAL_MS` (default: `5000`)
- `VSC_CODEX_HUB_MUTATION_RATE_WINDOW_MS` (default: `10000`)
- `VSC_CODEX_HUB_MUTATION_RATE_MAX` (default: `80`)
- `VSC_CODEX_HUB_CORS_ALLOWED_ORIGINS` (default: empty; comma-separated allowlist)
- `VSC_CODEX_HUB_PUBLIC_DIR` (default: `packages/pwa/dist`)
- `VSC_CODEX_HUB_VERBOSE` (`true|false`, default: `false`)

When token is empty, hub only accepts localhost API access.
When CORS allowlist is empty, cross-origin browser requests are denied by default (same-origin remains allowed).

## Development

```bash
cd packages/hub
npm install
npm run compile
npm start
```

## API baseline

Internal bridge routes:

- `POST /api/v1/internal/bridges/register`
- `POST /api/v1/internal/bridges/:bridgeId/heartbeat`

Public routes:

- `GET /healthz`
- `GET /api/v1/bridges`
- `GET /api/v1/bridges/:bridgeId/meta`
- `GET /api/v1/bridges/:bridgeId/threads`
- `GET /api/v1/bridges/:bridgeId/threads/:threadId`
- `POST /api/v1/bridges/:bridgeId/threads/:threadId/message`
- `POST /api/v1/bridges/:bridgeId/turns/:turnId/interrupt`
- `POST /api/v1/bridges/:bridgeId/turns/:turnId/steer`
- `POST /api/v1/bridges/:bridgeId/approvals/:approvalId/decision`
- `GET /ws/v1/bridges/:bridgeId/turns/:turnId`
