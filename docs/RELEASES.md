# Release Artifacts and Publishing

This document tracks release artifact outputs and publication links.

## Local Build Outputs

- Extension VSIX (versioned): `.local/release/extensions/vsc-codex-bridge-<version>.vsix`
- Extension VSIX (latest alias): `.local/release/extensions/vsc-codex-bridge-latest.vsix`
- Hub app bundle (macOS): `.local/release/macos/VSC Codex Bridge Hub.app`
- Hub installer (macOS PKG): `.local/release/macos/VSC-Codex-Bridge-Hub-<version>-macos.pkg`
- Hub archive (macOS ZIP): `.local/release/macos/VSC-Codex-Bridge-Hub-<version>-macos.zip`
- Hub disk image (macOS DMG, best effort): `.local/release/macos/VSC-Codex-Bridge-Hub-<version>-macos.dmg`

## Build Commands

Extension VSIX:

```bash
npm run build:bridge:vsix
```

If packaging is run in a restricted/offline environment and VSCE is missing, install it once:

```bash
npm --prefix packages/bridge-vscode install --save-dev @vscode/vsce
```

Extension VSIX + local install:

```bash
npm run install:bridge:vsix
```

Hub macOS installers:

```bash
npm run build:electron:macos-installer
```

## Published Links

Replace these with actual GitHub release URLs when assets are published:

- Extension VSIX: `TBD`
- Hub macOS PKG: `TBD`
- Hub macOS ZIP: `TBD`
- Hub macOS DMG: `TBD`

## Release Checklist

- Build all packages: `npm run build`
- Run relevant tests:
  - `npm run test:bridge`
  - `npm run test:hub`
- Build VSIX and installer artifacts.
- Verify install paths manually on a clean environment.
- Publish artifacts to GitHub Releases.
- Update release links in `README.md` and this file.
- Tag release in git.

## Notes

- Current macOS artifacts are unsigned/not notarized.
- DMG generation may fail in some CI/sandboxed environments; PKG and ZIP are the reliable fallback artifacts.
