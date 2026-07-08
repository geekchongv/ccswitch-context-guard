# CCProxy Agent

CCProxy Agent is a local safety proxy for Claude Code / Claude CLI users running behind ccswitch.

It does not replace ccswitch. It sits above it and adds context-window guardrails:

- warns when a session is close to the compact threshold
- automatically lowers `max_tokens` when input plus requested output would exceed the safe context budget
- retries once after upstream context-limit `400` errors
- temporarily points Claude CLI and Claude Desktop 3P gateway configs to the proxy on startup and restores the original config on shutdown
- writes local Chinese logs for debugging

Default topology:

```text
Claude CLI / Claude Desktop -> CCProxy Agent :15722 -> ccswitch :15721 -> model provider
```

> This is an independent community project and is not affiliated with ccswitch, Anthropic, or Claude Code.

## Why This Exists

Claude-style coding tools can fail when:

```text
input_tokens + max_tokens > model_context_limit
```

For example:

```text
This model's maximum context length is 200000 tokens.
However, you requested 64000 output tokens and your prompt contains at least 136001 input tokens.
```

CCProxy Agent can parse this class of error and retry once with a safer output budget:

```text
200000 - 8000 safety margin - 136001 input = 55999 max_tokens
```

## Features

- `max_tokens` auto-reduction before forwarding to upstream.
- One-shot retry after provider context-limit `400` responses.
- `/compact` reminder appended to JSON responses when the compact threshold is reached.
- Request budgeting for `/v1/messages` and `/v1/chat/completions`.
- Fallback chunking for requests that remain too large.
- Optional Claude CLI settings patching.
- Optional Claude Desktop 3P config patching.
- Multimodal image summarization for text-only downstream models.
- Automatic listen-port fallback when the configured port is already busy.
- Built-in local dashboard with status and runtime logs.
- Local logs and session snapshots.
- Windows exe packaging support.

## Current Limits

- Token counting before upstream is heuristic, not provider-native.
- `/compact` is a reminder by default, not a hidden Claude CLI command injection.
- Multimodal routing exists as a planned path but is disabled by default.
- Chunking is a fallback, not a full long-task planning engine.
- The project is currently tested primarily on Windows.
- Claude Desktop reads 3P config at launch, so restart Claude Desktop after starting the proxy.
- Vision API keys should be provided via environment variables, not committed into `config.json`.

## Quick Start From Source

```bash
npm install
cp config.example.json config.json
npm run dev
```

Default ports:

```text
CCProxy Agent: http://127.0.0.1:15722
ccswitch:      http://127.0.0.1:15721
```

If `15722` is already in use, CCProxy Agent automatically tries the next ports and patches Claude to the port it actually opened. The dashboard is available at the active listen URL, for example `http://127.0.0.1:15723/`.

Use the dashboard Stop button to close the proxy cleanly. It restores patched Claude settings before the process exits.

Health check:

```bash
curl http://127.0.0.1:15722/health
```

## Configuration

Copy `config.example.json` to `config.json`.

Important defaults:

```json
{
  "tokenPolicy": {
    "compactThreshold": 180000,
    "hardLimit": 200000,
    "safetyMargin": 8000,
    "compactMode": "warn",
    "autoReduceMaxTokens": true,
    "retryOnContextError": true,
    "minOutputTokens": 1024
  }
}
```

UI defaults:

```json
{
  "ui": {
    "enabled": true,
    "openOnStart": true
  }
}
```

Vision defaults:

```json
{
  "vision": {
    "enabled": true,
    "models": [
      "qwen3-vl-30b-a3b-instruct",
      "Qwen3.6-35B-A3B"
    ],
    "compareModels": true,
    "apiKeyEnv": "CCPROXY_VISION_API_KEY",
    "stripImagesAfterSummary": true
  }
}
```

Set the vision API key:

```powershell
[Environment]::SetEnvironmentVariable("CCPROXY_VISION_API_KEY", "your-token", "User")
```

When the downstream model does not support images, CCProxy Agent calls the vision models, injects a `[VISION SUMMARY]`, and removes the original image blocks before forwarding to ccswitch.

When `claudeConfigPatch.enabled` is `true`, CCProxy Agent temporarily modifies Claude CLI settings so requests go through `http://127.0.0.1:15722`. On normal shutdown it restores the previous value.

When `claudeDesktopConfigPatch.enabled` is `true`, CCProxy Agent looks for the applied Claude Desktop 3P config under:

```text
%LOCALAPPDATA%/Claude-3p/configLibrary
```

If ccswitch configured Desktop with:

```text
http://127.0.0.1:15721/claude-desktop
```

the proxy temporarily rewrites it to:

```text
http://127.0.0.1:15722/claude-desktop
```

Fully quit and reopen Claude Desktop after starting CCProxy Agent.

## Logs

Logs are written to:

```text
logs/ccproxy-agent.log
```

Useful Chinese log messages:

- `Token预算评估`: estimated input/output/total tokens.
- `已自动降低max_tokens，避免总token撞上上下文硬上限`: output budget was reduced before sending upstream.
- `上游返回上下文超限错误，已解析错误详情`: upstream returned a context-limit error and the proxy parsed it.
- `已降低max_tokens并自动重试一次`: the proxy retried once with safer output tokens.
- `已触发compact提醒模式`: the response will include a `/compact` reminder.
- `已触发分块执行`: chunking fallback started.

## Development

```bash
npm run check
npm test
npm run build
```

Package a Windows exe:

```bash
npm run package:exe
```

The generated exe is written to `release/ccproxy-agent.exe`.

## Documentation

- [Design](docs/design.md)
- [Validation](docs/validation.md)
- [v0.2 Release Notes](docs/ccproxy-agent-v0.2-release.md)
- [v0.3 Release Notes](docs/ccproxy-agent-v0.3-release.md)
- [v0.4 Release Notes](docs/ccproxy-agent-v0.4-release.md)

## Security And Privacy

CCProxy Agent is a local proxy. It can see the prompts and responses passing through it. By default, logs and session records stay on your local machine.

Do not commit your `config.json`, runtime sessions, logs, or packaged personal builds.

## 中文简介

CCProxy Agent 是一个放在 Claude CLI / Claude Desktop 和 ccswitch 中间的本地护栏代理。

它主要解决三个问题：

- 快到上下文上限时提醒你执行 `/compact`。
- `input_tokens + max_tokens` 超过模型上下文时，自动降低 `max_tokens`。
- 上游返回 context limit `400` 时，解析错误并自动重试一次。
- 支持临时接管 Claude Desktop 3P 网关配置。
- 支持 Claude Desktop 发图后由代理调用视觉模型生成摘要，再转给不支持图片的 GLM-5.2。

它不是 ccswitch 的替代品，而是 ccswitch 上层的防撞护栏。
