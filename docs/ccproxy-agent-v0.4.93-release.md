# CCProxy Agent v0.4.93

This is the security-hardened open-source release of CCProxy Agent.

## Security packaging

- Private `config.json` is no longer copied beside the EXE or included in `app.asar`.
- First startup creates a secret-free `config.json` beside the portable executable.
- Packaging scans the full release directory for private config files and configured secret bytes.
- Every release includes `SHA256SUMS.txt` and `config.example.json`.

## Context recovery

- Agent rescue clears old tool results first.
- The newest oversized tool result preserves bounded head and tail evidence instead of being erased.
- JSON replay removes stale entity headers.
- Anthropic and OpenAI SSE compact reminders are supported.
- Chunk synthesis failures enter a one-shot context retry path.

## Open-source readiness

- Added Bug Report and Feature Request forms.
- Added a pull request template, Code of Conduct, support guide, and Dependabot.
- CI now validates the GUI, builds the Windows portable EXE, scans it for secrets, and runs the real packaged rescue smoke test.
- Documentation and production limitations are published in the project Wiki.

## Install

1. Download `CCProxy-Agent-v0.4.93.exe`.
2. Verify it with `SHA256SUMS.txt`.
3. Run the EXE; a clean `config.json` is generated automatically.
4. Configure CC Switch and optional Vision access in the desktop UI.

Windows may display a SmartScreen warning because the community build is not currently distributed with a commercial Authenticode certificate.
