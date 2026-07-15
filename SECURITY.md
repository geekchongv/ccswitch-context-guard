# Security Policy

## Supported Versions

Only the latest release is actively maintained. Use `v0.4.93` or newer.

The `v0.4.91` executable was withdrawn because the old packaging path could include a maintainer's local `config.json`. Release builds now exclude private config files, generate a secret-free config on first startup, and fail packaging if configured secret bytes are detected.

## Reporting A Vulnerability

Please open a private security advisory on GitHub if possible.

If that is not available, open an issue with minimal reproduction details and avoid sharing API keys, prompts, logs, or local configuration files.

## Privacy Notes

CCProxy Agent is a local proxy. It can observe request and response bodies that pass through it.

Do not publish:

- `config.json`
- `secrets.json` (encrypted locally, but still device-specific private data)
- `logs/`
- `runtime/`
- packaged personal builds
- Claude settings files
- provider tokens or API keys

Desktop Vision API keys are encrypted through Electron safe storage, backed by Windows DPAPI or macOS Keychain. The plaintext key is injected only into the in-memory proxy configuration and is not returned to the renderer or written to `config.json`.

If you used an affected personal build, delete it and rotate any credential that may have been stored in its adjacent `config.json`.
