# CCProxy Agent v0.4.8

## Native compact, protocol-safe Agent requests, and loop telemetry

- Configures new Claude Code CLI processes to use the upstream hard limit as their effective auto-compact window and reserve 30,000 tokens for native compaction by default.
- Preserves existing user auto-compact environment values instead of overwriting them.
- Installs authenticated localhost HTTP hooks for `UserPromptSubmit`, `PostToolBatch`, `PostCompact`, and `SessionEnd` when observation is enabled.
- Records aggregate, in-memory tool telemetry only: call counts, fingerprints, output character counts, repeated calls, and truncation flags.
- Keeps observation fail-open and does not block or rewrite tool calls in this release.
- Detects Agent tool protocol from declared tools and tool message parts.
- Skips generic chunking and proxy text compaction for Agent tool sessions, preserving `tool_use` / `tool_result` structure.
- Continues to support generic chunking for stateless oversized document requests.
- Restores only settings and hook entries owned by the running proxy.

The GUI exposes native compact, compact reserve, and tool observation controls. Restart Claude Code after changing native compact settings because its environment is loaded when the CLI process starts.
