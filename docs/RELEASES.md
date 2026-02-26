# Release Artifacts and Publishing

This project now ships primarily as an **extension-only** product.

## Public Artifact

- VSIX (latest): `vsc-codex-bridge-latest.vsix`
- Release page: `https://github.com/mikecobian09/vsc-codex-bridge/releases/latest`
- Direct download URL: `https://github.com/mikecobian09/vsc-codex-bridge/releases/latest/download/vsc-codex-bridge-latest.vsix`

## Local Build Outputs

- Extension VSIX (versioned): `.local/release/extensions/vsc-codex-bridge-<version>.vsix`
- Extension VSIX (latest alias): `.local/release/extensions/vsc-codex-bridge-latest.vsix`

## Repository-Tracked Artifact

- `releases/vsc-codex-bridge-latest.vsix` (committed for easy direct install/download from repo)

## Build Commands

Build VSIX:

```bash
npm run build:bridge:vsix
```

Build VSIX and install into local VS Code:

```bash
npm run install:bridge:vsix
```

If packaging runs in a restricted/offline environment and VSCE is missing, install once:

```bash
npm --prefix packages/bridge-vscode install --save-dev @vscode/vsce
```

## Versioning Strategy (Current)

- Repository baseline version is tracked in root `package.json`.
- Packages are released in lockstep as one product line.
- Release tag format: `vMAJOR.MINOR.PATCH`.
- Artifact naming format:
  - `vsc-codex-bridge-<version>.vsix`
  - `vsc-codex-bridge-latest.vsix` (convenience alias)

## Published Links

Keep these current after each release:
- Repo tracked artifact: `https://github.com/mikecobian09/vsc-codex-bridge/raw/main/releases/vsc-codex-bridge-latest.vsix`
- VSIX latest page: `https://github.com/mikecobian09/vsc-codex-bridge/releases/latest`
- VSIX direct download: `https://github.com/mikecobian09/vsc-codex-bridge/releases/latest/download/vsc-codex-bridge-latest.vsix`

## Release Checklist

1. `npm run build`
2. `npm run test:bridge`
3. `npm run test:hub`
4. `npm run build:bridge:vsix`
5. Validate local install from VSIX in a clean VS Code profile.
6. Copy latest VSIX into `releases/vsc-codex-bridge-latest.vsix`.
7. Publish VSIX asset to GitHub Releases.
8. Update README and this file if links or naming changed.
9. Tag release in git.
