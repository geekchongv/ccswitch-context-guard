# CCProxy Agent v0.4.9

## Protocol-safe context rescue

This release closes the `198977 input + 1024 output = 200001` failure observed through CC Switch.

- Token estimation now includes top-level system prompts, tool schemas, tool calls, and complete nested tool-result text.
- Recognized image Base64 remains bounded and is never counted as source text.
- Agent requests proactively clear older tool-result bodies at 170,000 estimated input tokens and target 150,000 by default.
- Every tool call, tool result, `tool_use_id`, role, and message position is preserved. The three most recent tool results remain intact by default.
- An upstream context-limit response triggers one structural rescue retry even when the original request already uses `max_tokens = 1024`.
- Output budgeting after structural clearing uses the new request estimate instead of the stale pre-clear provider count.
- Stateless chunk and synthesis budgets now include top-level prompt fields.
- The GUI exposes clearing enablement, trigger, target, and recent-result retention controls.
- Release validation includes unit tests, protocol tests, exact provider-error replay, HTTP proxy integration, GUI reference validation, and a packaged portable-EXE rescue smoke test.

The version was advanced instead of replacing the existing v0.4.8 portable executable because same-version Electron portable builds can reuse an older extracted temp directory on Windows.
