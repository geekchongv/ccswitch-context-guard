# CCProxy Agent v0.2 Release Notes

## Summary

v0.2 focuses on the real 200k failure mode seen in Claude CLI:

```text
input tokens + requested output tokens > model context limit
```

Instead of only warning after the fact, the proxy can now lower `max_tokens` before forwarding and can retry once after an upstream context-limit `400`.

## New Capabilities

- Automatically lowers `max_tokens` when the estimated total would exceed the safe context budget.
- Parses provider errors like `maximum context length is 200000`.
- Retries once after context-limit `400` by using the provider-reported input token count.
- Records `maxTokensReduced` and `retriedAfterContextError` in session snapshots.
- Adds clearer Chinese logs for budget reduction, upstream context errors, and retry behavior.

## Default Policy

```json
{
  "compactThreshold": 180000,
  "hardLimit": 200000,
  "safetyMargin": 8000,
  "compactMode": "warn",
  "autoReduceMaxTokens": true,
  "retryOnContextError": true,
  "minOutputTokens": 1024
}
```

The effective hard line is:

```text
hardLimit - safetyMargin = 192000
```

If the proxy sees a request like:

```text
input: 136001
requested output: 64000
context limit: 200000
```

it retries with:

```text
200000 - 8000 - 136001 = 55999 output tokens
```

## Validation

Verified with automated tests:

- TypeScript check passes.
- Existing compaction and budget tests pass.
- New upstream mock test reproduces a context-limit `400`, then verifies automatic retry with `max_tokens = 55999`.

Commands:

```bash
npm run check
npm test
```

## Still Not Solved

- Token counting is still heuristic before the request reaches upstream.
- `/compact` is still a reminder by default, not an injected Claude CLI command.
- Multimodal routing remains disabled by default.
- Chunking is still a fallback, not a full long-task planning engine.
