# CCProxy Agent v0.4.94

Hotfix release: the v0.4.93 portable package could not start because the Electron entry file was missing from the asar archive. v0.4.94 fixes the build so CI once again produces a runnable Windows portable EXE.

## Build fix

- `build:gui` now bundles `electron-main.ts` to `dist/electron-main.js` (the entry referenced by `package.json` `"main"`), in addition to `gui-preload.ts`.
- `build:gui` cleans `dist` first to prevent stale or missing entry files from drifting into the packaged archive.
- Without this, `electron-builder` packed an asar whose entry file was absent and the EXE failed at launch with `Application entry file ... was not found in this archive`.

## What this release contains

- Security-hardened open-source packaging (unchanged from v0.4.93):
  - Private `config.json` is not copied beside the EXE or included in `app.asar`.
  - First startup creates a secret-free `config.json` beside the portable executable.
  - Packaging scans the full release directory for private config files and configured secret bytes.
  - Every release includes `SHA256SUMS.txt` and `config.example.json`.
- Context recovery (unchanged from v0.4.93):
  - Agent rescue clears old tool results first.
  - The newest oversized tool result preserves bounded head and tail evidence instead of being erased.
  - JSON replay removes stale entity headers.
  - Anthropic and OpenAI SSE compact reminders are supported.
  - Chunk synthesis failures enter a one-shot context retry path.

## Install

1. Download `CCProxy-Agent-v0.4.94.exe`.
2. Verify it with `SHA256SUMS.txt`.
3. Run the EXE; a clean `config.json` is generated automatically.
4. Configure CC Switch and optional Vision access in the desktop UI.

Windows may display a SmartScreen warning because the community build is not currently distributed with a commercial Authenticode certificate.
