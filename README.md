<div align="center">

# 🛡️ CCProxy Agent

**The local guardrail that stops Claude Code from blowing past its context window.**

A transparent safety proxy that sits between Claude CLI / Claude Desktop and [ccswitch](https://github.com/geekchongv/ccswitch-context-guard) — auto-managing token budgets, retrying context-limit errors, and routing multimodal inputs.

</div>

<p align="center">
  <img alt="CI" src="https://img.shields.io/github/actions/workflow/status/geekchongv/ccswitch-context-guard/ci.yml?branch=main&label=CI&style=flat-square">
  <img alt="version" src="https://img.shields.io/badge/version-v0.4.1-2ea44f?style=flat-square">
  <img alt="release" src="https://img.shields.io/github/v/release/geekchongv/ccswitch-context-guard?style=flat-square&color=blue">
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue?style=flat-square">
  <img alt="language" src="https://img.shields.io/badge/lang-TypeScript-3178c6?style=flat-square">
  <img alt="license" src="https://img.shields.io/github/license/geekchongv/ccswitch-context-guard?style=flat-square">
  <img alt="stars" src="https://img.shields.io/github/stars/geekchongv/ccswitch-context-guard?style=flat-square&color=ff69b4">
  <img alt="downloads" src="https://img.shields.io/github/downloads/geekchongv/ccswitch-context-guard/total?style=flat-square&color=9cf">
</p>

<p align="center">
  <a href="#-quick-start">🚀 Quick Start</a> ·
  <a href="#-features">✨ Features</a> ·
  <a href="#-how-it-works">⚙️ How It Works</a> ·
  <a href="#-configuration">🔧 Configuration</a> ·
  <a href="CONTRIBUTING.md">🤝 Contributing</a> ·
  <a href="#-中文说明">🇨🇳 中文说明</a>
</p>

---

> ⚠️ This is an independent community project and is **not** affiliated with ccswitch, Anthropic, or Claude Code.

## 💡 Why This Exists

Ever seen this error mid-coding session?

```text
This model's maximum context length is 200000 tokens.
However, you requested 64000 output tokens and your prompt contains at least 136001 input tokens.
```

That's a hard stop — your session dies, work is lost, and you restart. **CCProxy Agent fixes this automatically** by:

- 📉 Lowering `max_tokens` *before* the request even leaves your machine
- 🔁 Parsing the upstream `400` and retrying **once** with a safe budget
- 🧮 The math is dead simple: `200000 − 8000 safety − 136001 input = 55999 max_tokens`

It's not a replacement for ccswitch — it's the **crumple zone** above it.

## 🏗️ Topology

```text
                 ┌─────────────────┐     ┌──────────────┐     ┌────────────────┐
  Claude CLI ──▶ │  CCProxy Agent  │ ──▶ │   ccswitch   │ ──▶ │  model provider │
  Claude Desktop │  :15722 (guard) │     │  :15721      │     │  (GLM, Qwen...) │
                 └─────────────────┘     └──────────────┘     └────────────────┘
                  token budgeting ·       local switch         upstream LLM
                  retry · vision ·
                  compact reminder
```

The proxy intercepts `/v1/messages` and `/v1/chat/completions`, applies guardrails, then forwards to ccswitch. On startup it temporarily re-points Claude CLI / Claude Desktop configs at itself and **restores them cleanly on shutdown**.

## ✨ Features

| | Feature | What it does |
|---|---|---|
| 🧠 | **Auto token budgeting** | Reduces `max_tokens` before forwarding so `input + output` never exceeds the context limit |
| 🔁 | **One-shot retry** | Parses upstream context-limit `400` errors and retries with a safer output budget |
| 🪧 | **Compact reminder** | Appends a `/compact` hint to responses when the session nears the threshold |
| 🖼️ | **Vision summarization** | Routes Claude Desktop images through vision models, injects `[VISION SUMMARY]` for text-only downstreams like GLM-5.2 |
| 🧩 | **Fallback chunking** | Splits requests that remain too large after budgeting |
| 🔌 | **Claude CLI patching** | Temporarily redirects Claude CLI settings → proxy, restores on exit |
| 🖥️ | **Claude Desktop 3P patching** | Rewrites Desktop gateway config under `%LOCALAPPDATA%/Claude-3p/configLibrary` |
| 🔌 | **Port fallback** | Auto-jumps to the next free port (`15722 → 15723 → …`) if busy |
| 🔍 | **Upstream auto-discovery** | Finds a reachable local ccswitch when the configured upstream is down |
| 📊 | **Built-in dashboard** | Status, routing, process info & live logs at the active proxy URL |
| 🪵 | **Local Chinese logs** | Human-readable `Token预算评估` / `已自动降低max_tokens` style messages |
| 📦 | **Windows exe packaging** | Ship a portable `CCProxy-Agent.exe` |

## 🚀 Quick Start

```bash
git clone https://github.com/geekchongv/ccswitch-context-guard.git
cd ccswitch-context-guard
npm install
cp config.example.json config.json
npm run dev
```

That's it. The proxy starts on `http://127.0.0.1:15722` and the dashboard opens automatically.

**Health check:**

```bash
curl http://127.0.0.1:15722/health
```

> 💡 Use the dashboard **Stop** button to close cleanly — it restores your patched Claude settings before exit.

### Prefer a packaged exe?

Grab the latest release, drop in your `config.json`, and run:

```text
CCProxy-Agent-v0.4.1.exe
```

## ⚙️ How It Works

### Token budgeting (before the request leaves)

```text
   safe budget = hardLimit − safetyMargin
   max_tokens  = safe budget − estimated_input_tokens

   e.g.  200000 − 8000 − 136001  =  55999   ✅ never overflows
```

### Context-limit retry (after a 400)

```text
   upstream ──400──▶ parse "200000 ... 136001 input ... 64000 output"
                   ──▶ recompute max_tokens
                   ──▶ retry once ──▶ 200 OK
```

### Vision routing (Claude Desktop → text-only model)

```text
   image blocks ──▶ vision model (qwen3-vl) ──▶ [VISION SUMMARY]
                 ──▶ strip original images ──▶ forward to GLM-5.2
```

## 🔧 Configuration

Copy `config.example.json` → `config.json`. Key sections:

<details>
<summary><b>🎫 Token policy</b></summary>

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

</details>

<details>
<summary><b>🖼️ Vision</b></summary>

```json
{
  "vision": {
    "enabled": true,
    "models": ["qwen3-vl-30b-a3b-instruct", "Qwen3.6-35B-A3B"],
    "compareModels": true,
    "apiKeyEnv": "CCPROXY_VISION_API_KEY",
    "stripImagesAfterSummary": true
  }
}
```

Set the key via env var (don't commit it):

```powershell
[Environment]::SetEnvironmentVariable("CCPROXY_VISION_API_KEY", "your-token", "User")
```

</details>

<details>
<summary><b>🖥️ Claude Desktop 3P patching</b></summary>

When `claudeDesktopConfigPatch.enabled` is `true`, the proxy rewrites the ccswitch Desktop gateway path:

```text
  http://127.0.0.1:15721/claude-desktop   ──▶   http://127.0.0.1:15722/claude-desktop
```

> ⚠️ Fully quit and reopen Claude Desktop after starting the proxy — it reads 3P config only at launch.

</details>

## 📜 Logs

Written to `logs/ccproxy-agent.log`. Useful Chinese log lines:

| Message | Meaning |
|---|---|
| `Token预算评估` | Estimated input / output / total tokens |
| `已自动降低max_tokens…` | Output budget reduced before sending upstream |
| `上游返回上下文超限错误…` | Upstream returned a context-limit error, parsed |
| `已降低max_tokens并自动重试一次` | Retried once with a safer budget |
| `已触发compact提醒模式` | Response will include a `/compact` reminder |
| `已触发分块执行` | Chunking fallback started |

## 🛠️ Development

```bash
npm run check      # typecheck
npm test           # run test suite
npm run build      # compile TS → dist
npm run package:exe   # build portable Windows exe → release/
```

## 📚 Documentation

- 📐 [Design](docs/design.md)
- ✅ [Validation](docs/validation.md)
- 📦 [v0.4.1 Release Notes](docs/ccproxy-agent-v0.4.1-release.md)
- 📦 [v0.4 Release Notes](docs/ccproxy-agent-v0.4-release.md)
- 📦 [v0.3 Release Notes](docs/ccproxy-agent-v0.3-release.md)
- 📦 [v0.2 Release Notes](docs/ccproxy-agent-v0.2-release.md)
- 📝 [Full Changelog](CHANGELOG.md)

## 🔒 Security & Privacy

CCProxy Agent is a **local** proxy — it can see prompts/responses passing through it, but by default everything stays on your machine.

- ✅ Logs and session snapshots are local-only
- ✅ Vision API keys come from env vars, never `config.json`
- 🚫 **Never commit** your `config.json`, `runtime/`, `logs/`, or personal builds

See [SECURITY.md](SECURITY.md) for details.

## ⚠️ Current Limits

- Token counting before upstream is **heuristic**, not provider-native
- `/compact` is a reminder by default, not hidden Claude CLI command injection
- Multimodal routing is a planned path, disabled by default beyond summarization
- Chunking is a fallback, not a full long-task planning engine
- Primarily tested on **Windows**

---

<div align="center">

## 🇨🇳 中文说明

**CCProxy Agent** 是一个放在 Claude CLI / Claude Desktop 和 ccswitch 中间的本地护栏代理。

它不是 ccswitch 的替代品，而是 ccswitch 上层的**防撞护栏**，主要解决这些问题：

- 📉 快到上下文上限时提醒你执行 `/compact`
- 🧠 `input_tokens + max_tokens` 超过模型上下文时，**自动降低** `max_tokens`
- 🔁 上游返回 context limit `400` 时，解析错误并**自动重试一次**
- 🖥️ 临时接管 Claude Desktop 3P 网关配置
- 🖼️ Claude Desktop 发图后调用视觉模型生成摘要，再转给不支持图片的 GLM-5.2

**默认拓扑：**

```text
Claude CLI / Claude Desktop  ──▶  CCProxy Agent :15722  ──▶  ccswitch :15721  ──▶  模型
                                  (自动降低 / 重试 / 摘要 / 提醒)
```

**快速开始：**

```bash
npm install
cp config.example.json config.json
npm run dev
```

**核心日志：**

- `Token预算评估`：估算的输入 / 输出 / 总 token
- `已自动降低max_tokens，避免总token撞上上下文硬上限`
- `上游返回上下文超限错误，已解析错误详情`
- `已降低max_tokens并自动重试一次`
- `已触发compact提醒模式`

</div>

---

<div align="center">

**Made with 🛡️ for the Claude Code + ccswitch community.**

If this saved your session, a ⭐ on GitHub means a lot.

[Report a bug](https://github.com/geekchongv/ccswitch-context-guard/issues) · [Request a feature](https://github.com/geekchongv/ccswitch-context-guard/issues) · [Contributing](CONTRIBUTING.md) · [View releases](https://github.com/geekchongv/ccswitch-context-guard/releases)

</div>
