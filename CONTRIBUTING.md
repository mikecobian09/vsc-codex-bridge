# Contributing to VSC Codex Bridge

Thanks for contributing.

This project is currently optimized for:
- single-user local workflows,
- reliability and observability,
- explicit behavior over hidden magic.

## Ground Rules

- Keep PRs small and focused.
- Preserve existing behavior unless the change explicitly documents a behavior update.
- Add tests for logic changes when possible.
- Update documentation in the same PR when commands, APIs, settings, or UX flows change.
- Do not weaken security defaults silently (auth, bind host, CORS, approval behavior).

## Local Setup

1. Install dependencies per package as needed.
2. Build all packages:

```bash
npm run build
```

3. Run hub locally:

```bash
npm run dev:hub
```

4. Rebuild PWA static assets when changing UI:

```bash
npm run build:pwa
```

5. Rebuild/reinstall the VS Code extension during development:

```bash
./.local/scripts/reload-bridge.sh
```

## Testing Expectations

Run the relevant test suite(s) for your change:

```bash
npm run test:bridge
npm run test:hub
npm run test:e2e:pwa
```

If you cannot run a suite in your environment, state that explicitly in the PR notes.

## Coding Style

- Prefer explicit, readable code and predictable control flow.
- Keep comments practical and in English.
- Preserve existing module boundaries (`shared`, `hub`, `bridge-vscode`, `pwa`, `electron`).
- Avoid introducing hidden global state or implicit side effects.

## Documentation Updates

When applicable, update:
- `README.md` for setup/run/release commands,
- `docs/ARCHITECTURE.md` for structural changes,
- `docs/SECURITY.md` for auth/network/security behavior,
- `docs/RELEASES.md` for release artifacts and links.

## Release Workflow (Maintainers)

1. Build extension VSIX:

```bash
npm run build:bridge:vsix
```

2. Build macOS hub installer artifacts:

```bash
npm run build:electron:macos-installer
```

3. Upload release assets to GitHub Releases.
4. Update published links in:
- `README.md` (`Installers and Release Links` section),
- `docs/RELEASES.md` (`Published Links` section).

## Reporting Issues

Include:
- operating system + version,
- VS Code version,
- extension version,
- hub logs,
- exact reproduction steps.

For attach-mode work, also include diagnostics from:

```bash
./scripts/collect-attach-diagnostics.sh
```
