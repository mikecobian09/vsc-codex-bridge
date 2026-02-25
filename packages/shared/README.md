# @vsc-codex-bridge/shared

Shared contracts and runtime validators consumed by:
- `packages/hub`
- `packages/bridge-vscode`
- `packages/pwa` (future integration)

Current baseline:
- request contract types (`SendMessageRequest`, `SteerRequest`, `ApprovalDecisionRequest`)
- runtime parsers/validators for mutating payloads

This package is intentionally small and will grow as API/WS schema migration progresses.
