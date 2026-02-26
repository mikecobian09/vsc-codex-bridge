# Changelog

All notable changes to this project are documented in this file.

This project follows a practical Keep-a-Changelog style.

## [Unreleased]

### Added
- README rewritten with a beginner-first installation tutorial at the top.
- Direct VSIX download link for GitHub Releases in README and extension README.
- PRD v6.0 update with extension-only direction and refreshed exhaustive checklist.
- Tracked install artifact folder `releases/` with `vsc-codex-bridge-latest.vsix` and usage notes.

### Changed
- Product messaging and docs now prioritize extension-managed Hub as the default and primary path.
- Release docs simplified to VSIX-first publishing.
- Root scripts cleaned to remove deprecated desktop workflow commands from the primary workflow.
- New-conversation draft flow now retries with explicit `turn/start` thread targeting when `thread/start` is unavailable or reports `busy`, fixing `409 Conflict` cases when sending first message from PWA.

## [0.1.0] - 2026-02-25

### Added
- Initial monorepo baseline (`bridge-vscode`, `hub`, `pwa`, `shared`).
- VS Code bridge extension with app-server integration (spawn baseline, experimental attach).
- Hub registry/proxy/auth baseline and PWA static hosting.
- Mobile-first PWA with workspace/thread navigation, send/stop/steer, approvals, and activity stream.
- Packaging scripts for VSIX build/install.
- Documentation set: architecture, security, releases, troubleshooting, contributor and AI-agent onboarding.

### Security
- Token-safe log redaction and auth baseline for non-localhost usage.
- Mutating endpoint rate limiting and CORS allowlist policy in hub.

### Notes
- `attach` mode remains experimental and is not the recommended default.
