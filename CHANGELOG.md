# Changelog

## v0.3.1

- Fixed Claude Desktop gateway authentication failures by preserving upstream request headers in the AI orchestration path.
- Preserves `Authorization`, `x-api-key`, `anthropic-version`, and other non-hop request headers when forwarding `/v1/messages` and `/v1/chat/completions`.
- Added a regression test that verifies Desktop gateway authorization headers survive orchestration.

## v0.3.0

- Added Claude Desktop 3P config patching through `%LOCALAPPDATA%/Claude-3p/configLibrary`.
- Preserves ccswitch-generated Desktop gateway paths such as `/claude-desktop`.
- Restores Desktop gateway config on shutdown and recovers stale patches after crashes.
- Treats prefixed routes such as `/claude-desktop/v1/messages` as AI routes.
- Added regression test for Desktop gateway patch and restore.

## v0.2.0

- Added automatic `max_tokens` reduction before forwarding requests.
- Added one-shot retry after upstream context-limit `400` errors.
- Added Chinese logs for context-limit parsing and retry behavior.
- Added session flags for `maxTokensReduced` and `retriedAfterContextError`.
- Added a regression test for the `136001 input + 64000 output > 200000` failure mode.

## v0.1.0

- Added local proxy above ccswitch.
- Added Claude CLI config patching and restore on shutdown.
- Added compact warning mode.
- Added fallback chunking.
- Added local logs and runtime session snapshots.
