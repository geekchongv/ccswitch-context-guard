# Contributing to CCProxy Agent

First off — thanks for taking the time to contribute! 🛡️

This project is an independent community effort. Every bug report, feature idea, doc fix, or line of code makes it better for everyone running Claude Code behind ccswitch.

> 💬 This guide is bilingual. Jump to the [中文说明](#-中文说明) section at the bottom.

---

## 📋 Table of Contents

- [Code of Conduct](#-code-of-conduct)
- [Before You Start](#-before-you-start)
- [Ways to Contribute](#-ways-to-contribute)
- [Development Setup](#-development-setup)
- [Project Layout](#-project-layout)
- [Code Style](#-code-style)
- [Testing](#-testing)
- [Submitting Changes](#-submitting-changes)
- [Commit Messages](#-commit-messages)
- [Reporting Bugs](#-reporting-bugs)
- [Feature Requests](#-feature-requests)
- [Security](#-security)

---

## 🤝 Code of Conduct

Be kind. Be patient. Assume good intent. Disagree on ideas, not people.

We follow the spirit of the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/). Trolling, harassment, or personal attacks are not tolerated.

---

## 🧭 Before You Start

Before writing code, please:

1. **Search existing [issues](https://github.com/geekchongv/ccswitch-context-guard/issues)** — your idea or bug may already be in progress.
2. **Open a discussion issue first** for anything bigger than a typo or small fix. A 10-minute chat saves a 10-hour rejected PR.
3. **Check the [current limits](README.md#-current-limits)** in the README — some "missing" features are known and intentional.

---

## 🎯 Ways to Contribute

You don't have to write code to help:

| Way | How |
|---|---|
| 🐛 **Report bugs** | Open an issue with reproduction steps |
| 💡 **Suggest features** | Open an issue describing the use case, not just the solution |
| 📝 **Improve docs** | Fix typos, clarify wording, add examples |
| 🔍 **Test on other platforms** | This project is Windows-first — macOS/Linux reports are gold |
| ⭐ **Star & share** | Helps others discover the project |
| 🔧 **Submit code** | Fix a bug or build a feature (see below) |

---

## 🛠️ Development Setup

### Prerequisites

- **Node.js 22+** (the CI runs on Node 22; v24 works fine locally)
- **npm** (bundled with Node)
- **Git**
- On Windows: PowerShell (used by the packaging scripts)

### Get the code

```bash
# 1. Fork the repo on GitHub, then clone your fork
git clone https://github.com/<YOUR_USERNAME>/ccswitch-context-guard.git
cd ccswitch-context-guard

# 2. Add the upstream remote so you can sync later
git remote add upstream https://github.com/geekchongv/ccswitch-context-guard.git

# 3. Install dependencies
npm install

# 4. Create your local config
cp config.example.json config.json
#   edit config.json with your ports / upstream / vision key

# 5. Start in dev mode
npm run dev
```

The proxy starts on `http://127.0.0.1:15722`. The optional dashboard is available at that URL, but it does not open a browser automatically by default.

### Keep your fork in sync

Before starting new work:

```bash
git fetch upstream
git checkout main
git merge upstream/main
git push origin main
```

### Verify everything works

```bash
npm run check    # typecheck — must pass with zero errors
npm test         # run the test suite — must be green
```

---

## 📁 Project Layout

```
src/
├── index.ts              # CLI entry point
├── server.ts             # HTTP server + routing
├── proxy-runner.ts       # request orchestration
├── orchestrator.ts       # core guardrail logic (budget / retry / vision)
├── upstream-client.ts    # forwards to ccswitch
├── upstream-discoverer.ts# finds a reachable ccswitch port
├── token-estimator.ts    # heuristic token counting
├── compactor.ts          # /compact reminder + chunking fallback
├── modality-router.ts    # vision image → summary routing
├── claude-config-patcher.ts  # Claude CLI / Desktop config patch + restore
├── port-resolver.ts      # picks the next free port
├── dashboard.ts          # built-in status dashboard
├── electron-main.ts      # GUI app entry
├── gui/                  # dashboard frontend assets
├── *.test.ts             # tests live next to the code they cover
└── ...
```

> Tests sit **alongside** their source files (`compactor.ts` ↔ `compactor.test.ts`). Follow this pattern for new code.

---

## 💻 Code Style

This project has **no ESLint or Prettier config** — consistency is enforced by TypeScript's `strict` mode and by reading the surrounding code. Match what's already there.

### The rules that matter

- ✅ **TypeScript `strict` mode** — no `any` without a comment explaining why, no implicit `any`, no unchecked `null`.
- ✅ **ESM with `NodeNext`** — imports use the `.js` extension even though source is `.ts`:
  ```ts
  // ✅ correct
  import { compactRequest } from "./compactor.js";

  // ❌ wrong — will fail at runtime
  import { compactRequest } from "./compactor";
  ```
- ✅ **Node 22+ APIs are fine** — `node:test`, `node:assert/strict`, native `fetch`, `structuredClone`, etc.
- ✅ **No external runtime deps for core logic** — the proxy itself stays dependency-light. `esbuild`, `electron`, `pkg`, `tsx` are dev/build tooling only. If you think a new runtime dep is needed, open an issue first.
- ✅ **Comments match the file's language** — source comments are English; runtime log messages to `logs/ccproxy-agent.log` are **Chinese** (that's intentional for users debugging locally).
- ✅ **Match naming & density** — look at the file you're editing and copy its style: function naming, comment density, error-handling pattern.

### A few anti-patterns to avoid

- ❌ Don't commit `config.json`, `logs/`, `runtime/`, or anything from `.gitignore`. They contain local secrets and sessions.
- ❌ Don't add `console.log` to shipped code — use the logger (`src/logger.ts`).
- ❌ Don't swallow errors silently. Either handle them or let them bubble up with context.

---

## 🧪 Testing

Tests use the built-in **`node:test`** runner (no Jest/Vitest).

### Run the suite

```bash
npm test
```

### Write a test

Tests live next to the code. Example pattern (see `src/compactor.test.ts`):

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { compactRequest } from "./compactor.js";
import { ChatCompletionRequest } from "./types.js";

test("compactRequest leaves short conversations unchanged", () => {
  const request: ChatCompletionRequest = {
    messages: [
      { role: "system", content: "rules" },
      { role: "user", content: "task" },
    ],
  };

  assert.deepEqual(compactRequest(request), request);
});
```

### What we expect from your PR

- **Every new behavior gets a test.** If you add a branch to `compactRequest`, add a test that exercises it.
- **Bug fixes include a regression test** that fails before your fix and passes after.
- `npm run check && npm test` must be green before you push.

---

## 📤 Submitting Changes

### 1. Branch from `main`

```bash
git checkout main
git pull upstream main
git checkout -b fix/my-bug-fix        # or feat/my-new-thing
```

Use a descriptive branch name:
- `fix/token-overflow-edge-case`
- `feat/macos-port-detection`
- `docs/clarify-vision-config`

### 2. Keep commits focused

One logical change per commit. If your PR does three unrelated things, split it into three PRs.

### 3. Make sure CI passes locally first

```bash
npm run check
npm test
npm run build        # if you touched compilation
```

### 4. Push and open a Pull Request

```bash
git push origin fix/my-bug-fix
```

Then open a PR against `main`. In the PR description:

- **What** — what does this change do?
- **Why** — what problem does it solve? Link the issue (`Closes #123`).
- **How** — a quick note on approach, especially if non-obvious.
- **Testing** — how did you verify it? What cases did you cover?

### 5. Respond to review

Reviews are about the code, not you. If a reviewer asks for changes:

- Push new commits to the same branch (don't force-push unless asked).
- Mark conversations resolved only after the reviewer confirms.
- Ask questions if feedback is unclear — better to ask than to guess.

---

## 📝 Commit Messages

We use **Conventional Commits** — it keeps the history readable and auto-feeds the changelog.

```
<type>(<scope>): <subject>

<body — optional, why not what>

<footer — optional, e.g. Closes #123>
```

### Types

| Type | Use for |
|---|---|
| `feat` | A new feature |
| `fix` | A bug fix |
| `docs` | Documentation only |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `test` | Adding or fixing tests |
| `chore` | Build, tooling, deps — nothing user-facing |
| `perf` | Performance improvement |

### Examples

```
fix(orchestrator): clamp max_tokens above minOutputTokens floor

feat(vision): support comparing three vision models instead of two

docs(readme): clarify Claude Desktop restart requirement

test(port-resolver): add case for EADDRINUSE on all default ports
```

- Keep the subject under **72 chars**, imperative mood (`add` not `added`).
- No period at the end of the subject.
- Reference issues in the footer: `Closes #42` or `Refs #42`.

---

## 🐛 Reporting Bugs

A good bug report is reproducible. Open an [issue](https://github.com/geekchongv/ccswitch-context-guard/issues/new) and include:

1. **What you did** — exact steps or commands.
2. **What you expected** — the behavior you wanted.
3. **What happened** — the actual behavior, plus any error text.
4. **Environment**:
   - OS (Windows 11 / macOS 14 / Ubuntu 22.04 …)
   - Node version (`node -v`)
   - CCProxy Agent version (e.g. `v0.4.1`)
   - Downstream model + provider (e.g. GLM-5.2 via ccswitch)
5. **Logs** — relevant lines from `logs/ccproxy-agent.log`. **Redact any API keys, tokens, or private prompts first.**

> ⚠️ Never paste real API keys, full auth headers, or sensitive prompts into an issue.

---

## 💡 Feature Requests

We'd rather hear about the **problem** than the **solution**. When requesting a feature:

- Describe the **use case** — what are you trying to do that the proxy doesn't let you do today?
- Explain **who else** might hit this — helps us prioritize.
- If you have a proposed implementation, sketch it — but be open to alternatives.

Vague requests like "add X" without a use case tend to stall. "I can't tell when the proxy silently reduced my tokens" → that's actionable.

---

## 🔒 Security

CCProxy Agent is a **local proxy** that can see prompts and responses passing through it. Before contributing:

- 🔑 **Never commit secrets.** API keys go in env vars (`CCPROXY_VISION_API_KEY`), not `config.json`. `config.json` is gitignored for a reason.
- 🚫 **Don't add logging that dumps full request/response bodies** by default — that's a privacy regression.
- 🐛 Found a security issue? **Don't open a public issue.** See [SECURITY.md](SECURITY.md) and open a private security advisory.

---

## ❓ Questions?

- 💬 Open a [discussion or issue](https://github.com/geekchongv/ccswitch-context-guard/issues) — that's the fastest way to reach the maintainer.
- 📖 Skim the [design doc](docs/design.md) and [release notes](docs/) for context on why things are the way they are.

---

## 🇨🇳 中文说明

感谢你愿意为 CCProxy Agent 做贡献!这里快速说明几条最重要的约定:

**开发环境**

- Node.js 22+,`npm install` 后 `npm run dev` 启动。
- 本地配置文件是 `config.json`(已 gitignore,**不要提交**,里面可能有你的 API key)。

**代码风格**

- TypeScript `strict` 模式,不开 lint,靠类型检查 + 跟周围代码保持一致。
- ESM 项目,import 要带 `.js` 后缀(哪怕源码是 `.ts`):`import { x } from "./y.js"`。
- 源码注释用英文,运行时日志(`logs/` 里的中文消息)保持中文——这是给本地用户调试用的。
- 核心逻辑不引入运行时依赖,`esbuild`/`electron`/`pkg`/`tsx` 都是构建工具。

**测试**

- 用 Node 自带的 `node:test`,不要引入 Jest。
- 测试文件放在源码旁边(`compactor.ts` ↔ `compactor.test.ts`)。
- 新功能要带测试,修 bug 要带回归测试。
- 提交前务必跑通:`npm run check && npm test`。

**提交流程**

1. Fork → 建分支(`fix/xxx` / `feat/xxx` / `docs/xxx`)
2. Conventional Commits 规范(`fix: ...`、`feat: ...`、`docs: ...`)
3. 提 PR 到 `main`,说明 What / Why / How / Testing
4. 一个 commit 只做一件事,无关改动拆成多个 PR

**安全**

- 不要提交 `config.json` / `logs/` / `runtime/`,可能含密钥和会话内容。
- 发现安全问题别开公开 issue,按 [SECURITY.md](SECURITY.md) 走私密渠道。

---

<div align="center">

<sub>If this guide is ever out of date, the <code>package.json</code> scripts and <code>tsconfig.json</code> are the source of truth.</sub>

</div>
