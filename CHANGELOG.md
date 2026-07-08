# Changelog

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
