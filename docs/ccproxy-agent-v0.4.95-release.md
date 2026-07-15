# CCProxy Agent v0.4.95

This release replaces the original utility-style Electron shell with a complete desktop control center while preserving the existing context-protection gateway and configuration contracts.

## Highlights

- New CC Switch-inspired desktop information architecture
- Clear client → CCProxy Agent → CC Switch routing visualization
- Unified proxy controls and live process status
- Product health panel and recent protection-event timeline
- Structured network, context-guard, Claude integration, and multimodal settings
- Persistent light and dark themes
- Chinese UI encoding repaired throughout the renderer
- Application-owned Windows icon instead of the Electron default

## Interaction and safety improvements

- Settings validate ports, context thresholds, and tool-result cleanup ranges before saving.
- `Ctrl+S` saves the active settings page and `Ctrl+,` opens proxy settings.
- Start, stop, restart, and configuration mutations expose loading and error feedback.
- Empty health, event, and log states explain what data will appear instead of showing blank panels.
- The renderer keeps the existing isolated preload bridge and does not enable Node integration.

## Release integrity

- Runtime version now comes from `package.json`, preventing the packaged UI from displaying an older hard-coded version.
- The Windows package is scanned for private configuration files and configured secret bytes.
- CI runs TypeScript checks, 71 automated tests, GUI reference validation, packaging, and a packaged context-rescue smoke test before publishing.
- `SHA256SUMS.txt` is included with the Release assets.

## Install

1. Download `CCProxy-Agent-v0.4.95.exe` from this Release.
2. Keep `config.example.json` beside it only as a reference; the application creates a secret-free local `config.json` on first start.
3. Close any older CCProxy Agent instance before launching the new executable.

The portable package still includes the Electron runtime and is expected to remain around 86 MB. The interface rewrite itself adds only a small amount of application code.
