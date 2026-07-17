# Changelog

## v0.4.98

- Fixed Claude Desktop vision routing for image blocks that provide `source.url`, `source.uri`, or `input_image.image_url` instead of only Anthropic base64 `source.data`.
- Added safe vision input diagnostics when a request contains image-like blocks that still do not match a supported format, without logging image payloads, URLs, or secret file identifiers.
- Added regression tests for Claude Desktop URL-backed images, OpenAI-style `input_image` blocks, and unsupported image-like diagnostic logging.

## v0.4.97

- Added macOS Intel and Apple Silicon release builds in DMG and ZIP formats, with macOS-native writable configuration paths.
- Added GUI-managed Vision API keys encrypted by Electron safe storage (Windows DPAPI / macOS Keychain), with legacy environment-variable fallback retained for CLI users.
- Added adaptive local-gateway 429 protection: bounded concurrency, shared cooldown, `Retry-After` support, serialized internal retry, and visible recovery events.
- Expanded CI and tag releases to validate and package on both Windows and macOS, then publish combined checksums.
- Added regression tests for rate-limit recovery, post-429 serialization, secret redaction, and UI configuration references.

## v0.4.95

- Rebuilt the Electron interface as a polished CC Switch-style desktop control center with a clear routing overview, health status, protection events, grouped settings, and live logs.
- Fixed the corrupted Chinese interface text and added accessible labels, empty states, inline validation, keyboard shortcuts, loading feedback, and persistent light/dark themes.
- Added a project-owned application icon for Windows packages and updated the default window dimensions for the new information architecture.
- Replaced the stale hard-coded runtime version with `package.json` as the single source of truth so packaged UI and release metadata remain synchronized.
- Preserved the existing proxy, configuration, insight, and IPC contracts; all 71 automated tests and packaged secret checks continue to pass.

## v0.4.93

- Removed private `config.json` from every package path and added first-start generation of a secret-free local config.
- Added release artifact scanning that rejects private config files and configured secret bytes.
- Added SHA256 generation, verified packaged smoke testing, and tag-driven GitHub Release automation.
- Added Windows GUI packaging and real EXE smoke coverage to CI.
- Added Issue Forms, a pull request template, Code of Conduct, support guide, and Dependabot configuration.
- Updated README platform claims, installation steps, version references, architecture links, and current limitations.

## v0.4.92

- Changed Agent context rescue to clear old results first and preserve bounded head/tail evidence from the newest result.
- Fixed stale response entity headers after JSON replay and warning injection.
- Added Anthropic and OpenAI SSE compact warning support.
- Added request body limits, stale Hook token refresh, synthesis context retry, and packaged temp cleanup.
- Added regression tests for response replay, SSE warnings, Hook recovery, request limits, and tool-result truncation.

## v0.4.91

- Calibrated default token thresholds for provider/local estimator differences.
- Added provider usage comparison and upstream error body diagnostics.
- Added Desktop gateway drift monitoring and Agent protocol rescue.

## v0.4.5

- Closed the remaining chunking overflow path: final synthesis requests no longer re-inject the full original `messages` JSON after chunk execution.
- Added hard-cap aware synthesis truncation so both chunk calls and the final synthesis call stay within the same input budget.
- Capped synthesis output tokens at 4,000 to avoid recreating the original `input + 64k output` context-limit failure pattern.
- Added regression tests proving oversized original messages and excessive chunk outputs are truncated before synthesis.
- Published a clean Windows GUI release zip with the portable exe, `config.example.json`, README, docs, license, changelog, and SHA256 checksum.

## v0.4.4

- Changed the default UI startup behavior: the local dashboard remains available, but `ui.openOnStart` now defaults to `false` so CLI/script startup no longer opens a browser tab automatically.
- Fixed the token-chunking bug where a single oversized message became an uncapped chunk that exceeded the model's hard context limit, causing upstream HTTP 400 ("196001 input tokens"). Chunking now splits oversized messages on paragraph, sentence, then token boundaries, with a hard cap that every chunk must stay under.
- Unified token counting on `tokenx` (Chinese-aware, ~96% accurate), replacing the inconsistent `length/3.0` and `length/3.5` heuristics used by the estimator and chunker. Budget decisions and chunk sizes are now based on the same accurate counter.
- Fixed base64 image inflation: image parts are now counted as a bounded `[image]` placeholder (~1 token) instead of serializing their base64 payload, which previously inflated a 100 KB image to ~33k tokens.
- Added per-chunk estimated-size logging in the orchestrator with a regression sentinel that warns if any chunk exceeds the hard cap.
- Added `src/token-counter.test.ts` and `src/chunking.test.ts`, including a `196001` regression test asserting no chunk ever crosses the hard cap.

## v0.4.3

- Reduced log noise: demoted routine startup and per-request diagnostic logs to `debug`, reserving `info` for decisions a user acts on (request completed, vision preprocessing, compact triggered, failures).
- Captured upstream error response bodies for diagnosis: non-success upstream responses are now replayed to the caller with their body intact, and the first 2 KB of the upstream body is logged on failure.
- Added log file rotation: the agent log archives to `.1` once it exceeds 5 MB, preventing unbounded growth. Rotation now repeats across a session instead of firing once.
- Surfaced a warning when a request looks like it carries images but vision preprocessing did not match a supported image format.
- Excluded the Electron main/preload sources from the Node `tsc` build to keep `npm run build` focused on the proxy entry point.

## v0.4.2

- Added a product-focused health panel to the desktop console.
- Added a protection event feed for token budgeting, `max_tokens` reductions, context-limit retries, compact reminders, chunking, and vision preprocessing.
- Added structured product insights derived from existing runtime logs.
- Added dashboard screenshots to the README.
- Added v0.4.2 release notes.

## v0.4.1

- Added automatic listen-port fallback when the configured proxy port is busy.
- Added upstream auto-discovery for common local ccswitch ports.
- Added a built-in local dashboard with status and live runtime logs.
- Opens the dashboard on startup by default when `ui.openOnStart` is enabled.
- Added a local-only dashboard shutdown action that restores patched Claude settings before exit.
- Applies Claude CLI/Desktop config patches only after the proxy is actually listening.

## v0.4.0

- Added true multimodal vision summarization for Claude Desktop image inputs.
- Extracts Anthropic/OpenAI-style image blocks and calls configured vision models.
- Supports comparing `qwen3-vl-30b-a3b-instruct` and `Qwen3.6-35B-A3B`.
- Injects a structured `[VISION SUMMARY]` block for downstream text-only models such as GLM-5.2.
- Strips image blocks after summarization by default so non-vision downstream models do not receive unsupported image payloads.
- Reads the vision API key from `CCPROXY_VISION_API_KEY` instead of committing secrets to config.

## v0.3.2

- Fixed Claude Desktop probe failures caused by forwarding hop-by-hop HTTP headers into Node fetch.
- Filters `connection`, `keep-alive`, `transfer-encoding`, `upgrade`, and related hop-by-hop headers before upstream calls.
- Added a regression test for orchestrated Desktop requests with connection-style headers.

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
