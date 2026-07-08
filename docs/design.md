# CCProxy-Agent Design Document

## 1. Goal

`ccproxy-agent` sits above `ccswitch` and adds orchestration that `ccswitch` does not provide by itself:

- proactive `/compact` reminders before the session gets too large
- token budget enforcement before the upstream rejects a request
- automatic output-token reduction and one-shot retry for context-limit errors
- Claude Desktop 3P gateway patching
- multimodal detection and image-first routing
- structured logging for replay and debugging

The default local topology is:

`Claude CLI/Desktop -> ccproxy-agent (127.0.0.1:15722) -> ccswitch (127.0.0.1:15721) -> model provider`

## 2. Problems To Solve

### 2.1 Context over 200k is not compacted automatically

The proxy must estimate the current message size and warn the user before the request reaches the upstream hard limit. Default mode does not impersonate Claude CLI's internal `/compact` command.

### 2.2 Single call above 200k tokens fails

The proxy must estimate the total budget of:

- request messages
- tool/system context
- expected completion

If the estimate is above the configured hard limit, the proxy must first lower requested output tokens when that is enough. If the request is still too large, it must avoid direct pass-through and switch to a staged execution flow.

### 2.3 Images should be handled by a multimodal model

The proxy must detect image-bearing inputs and optionally call a dedicated vision-capable endpoint first, then inject a structured image summary into the text-model request.

## 3. Non-Goals For MVP

- no web dashboard
- no database dependency
- no perfect reproduction of Claude's internal `compact`
- no provider-specific SDK lock-in

## 4. Architecture

## 4.1 Modules

### HTTP Server

- listens on `127.0.0.1:15722`
- proxies arbitrary upstream routes
- only applies orchestration to configured AI JSON endpoints
- supports response streaming pass-through at the HTTP layer

### Orchestrator

- inspects the incoming request
- runs token estimation
- runs modality detection
- decides between:
  - pass-through
  - warn-and-forward
  - reduce-output-and-forward
  - vision-then-forward
  - staged execution

### Context Compactor

Produces a structured summary instead of a loose paragraph. Compaction output contains:

- active goal
- confirmed constraints
- completed work
- pending work
- critical code facts
- user preferences
- unresolved risks

### Token Budgeter

Uses heuristic estimation for the MVP. It measures:

- raw message text size
- image placeholder cost
- configured response reserve

It emits a policy decision:

- `safe`
- `compact_required`
- `chunk_required`

### Modality Router

Detects:

- image URLs
- local image paths
- markdown image syntax
- base64 image data URLs
- typed message parts with `image_url` or `input_image`

If images exist and a vision endpoint is configured, it sends a compact image-analysis request first.

### Upstream Client

- forwards requests to `ccswitch`
- supports retry for transient failure
- preserves streamed and non-streamed behavior by piping upstream responses

### Session Store

Stores JSON snapshots under `runtime/sessions/`:

- original request
- compacted summary
- vision summary
- orchestration decision

### Claude Desktop Config Patcher

- reads `%LOCALAPPDATA%/Claude-3p/configLibrary/_meta.json`
- patches only the currently applied profile
- rewrites `inferenceGatewayBaseUrl` from the ccswitch gateway to the ccproxy-agent gateway
- preserves the path suffix, for example `/claude-desktop`
- stores restore state under `runtime/claude-desktop-config-patch.json`
- restores the original gateway on shutdown

## 5. Request Flow

## 5.1 Normal text request

1. Receive request
2. Estimate budget
3. If safe, forward directly to `ccswitch`

## 5.2 Large context request

1. Receive request
2. Estimate budget
3. If above compact threshold, mark the response for a `/compact` reminder
4. Lower `max_tokens` if requested output would overflow the safe budget
5. Forward if now safe

## 5.3 Over-hard-limit request

1. Receive request
2. Estimate budget
3. If above hard limit, split execution into staged prompts
4. Generate intermediate summaries
5. Send final synthesis prompt upstream

MVP note: staged execution is implemented conservatively and is intended for text-heavy requests first.

## 5.5 Upstream context-limit retry

1. Forward the request
2. If upstream returns a context-limit `400`, parse the reported context limit, input tokens, and requested output tokens
3. Compute a safer output budget:

```text
contextLimit - safetyMargin - inputTokens
```

4. Retry once if the computed output budget is above `minOutputTokens`
5. Return the second response, or the original error if no safe retry is possible

## 5.6 Claude Desktop 3P request

1. ccswitch writes a Claude Desktop 3P gateway config such as `http://127.0.0.1:15721/claude-desktop`
2. CCProxy Agent starts and rewrites the applied config to `http://127.0.0.1:15722/claude-desktop`
3. Claude Desktop is restarted so it reads the patched config
4. Desktop sends requests such as `/claude-desktop/v1/messages`
5. The proxy recognizes routes ending in `/v1/messages` and applies the token guard
6. The request is forwarded to ccswitch at `http://127.0.0.1:15721/claude-desktop/v1/messages`

## 5.4 Vision request

1. Detect image content
2. Create a vision analysis prompt
3. Send it to the configured vision endpoint
4. Inject the returned visual summary into the text request
5. Continue normal budgeting and forwarding

## 6. Compaction Strategy

The compactor intentionally does not mimic a generic summarizer. It creates a structured block:

```text
[COMPACT MEMORY]
Goal:
Constraints:
Completed:
Pending:
Code Facts:
User Preferences:
Risks:
Recent High-Value Messages:
[/COMPACT MEMORY]
```

This is more stable across repeated compactions than repeatedly summarizing freeform conversation.

## 7. Configuration

`config.json` drives runtime behavior:

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 15722
  },
  "upstream": {
    "baseUrl": "http://127.0.0.1:15721",
    "chatPath": "/v1/chat/completions",
    "timeoutMs": 120000,
    "aiRoutes": ["/v1/chat/completions", "/v1/messages"]
  },
  "tokenPolicy": {
    "compactThreshold": 180000,
    "hardLimit": 200000,
    "responseReserve": 12000,
    "chunkTarget": 90000,
    "safetyMargin": 8000,
    "compactMode": "warn",
    "autoReduceMaxTokens": true,
    "retryOnContextError": true,
    "minOutputTokens": 1024
  },
  "vision": {
    "enabled": true,
    "baseUrl": "http://127.0.0.1:15721",
    "chatPath": "/v1/chat/completions",
    "model": "vision-model-name"
  }
}
```

## 8. Key Trade-Offs

### Heuristic token counting vs provider tokenizer

- chosen for MVP: heuristic counting
- reason: no provider SDK lock-in, faster implementation
- cost: estimates are approximate
- mitigation: keep safety margin

### Structured compaction vs raw transcript retention

- chosen for MVP: structured compaction
- reason: more stable continuation behavior
- cost: some nuance is lost
- mitigation: retain recent high-value messages and write snapshots to disk

### Proxy above ccswitch vs replacing ccswitch

- chosen for MVP: proxy above ccswitch
- reason: preserve current workflow and rollback path
- cost: one more local layer
- mitigation: small surface area and clear logging

## 9. Packaging Plan

After the MVP is stable:

- build with `tsc`
- package as Windows exe using `pkg` or `nexe`
- ship with `config.json`
- logs written to `logs/`

## 10. Immediate Next Steps

1. Improve provider-specific request shaping if `ccswitch` normalizes multiple schemas differently
2. Add provider-native tokenizers where available
3. Add stronger staged execution prompts for code-heavy tasks
4. Package the service into a Windows exe
5. Add richer replay tooling for failed sessions
