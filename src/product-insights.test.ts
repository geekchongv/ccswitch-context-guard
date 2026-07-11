import test from "node:test";
import assert from "node:assert/strict";
import { buildHealthSummary, extractProtectionEvents } from "./product-insights.js";
import { LogEntry } from "./logger.js";

const baseConfig = {
  server: { host: "127.0.0.1", port: 15723, autoPort: true },
  upstream: {
    baseUrl: "http://127.0.0.1:15722",
    chatPath: "/v1/chat/completions",
    timeoutMs: 120000,
    autoDiscover: true,
  },
  tokenPolicy: {
    compactThreshold: 180000,
    hardLimit: 200000,
    safetyMargin: 8000,
    responseReserve: 4096,
    chunkTarget: 90000,
    compactMode: "warn" as const,
    compactWarningText: "compact please",
    autoReduceMaxTokens: true,
    retryOnContextError: true,
    minOutputTokens: 1024,
  },
  vision: {
    enabled: true,
    baseUrl: "http://127.0.0.1:15722",
    chatPath: "/v1/chat/completions",
    model: "qwen3-vl",
    models: ["qwen3-vl"],
    compareModels: false,
    apiKeyEnv: "CCPROXY_VISION_API_KEY",
    timeoutMs: 120000,
    maxImagesPerRequest: 4,
    maxImageBytes: 12000000,
    summaryMaxTokens: 1500,
    stripImagesAfterSummary: true,
    systemPrompt: "summarize",
  },
  logging: { level: "info" as const, directory: "logs" },
  runtime: { directory: "runtime" },
  claudeConfigPatch: { enabled: true, settingsPath: undefined },
  claudeDesktopConfigPatch: { enabled: true, configPath: undefined },
  ui: { enabled: true, openOnStart: true },
};

test("buildHealthSummary reports proxy, upstream, patch, and vision state", () => {
  const health = buildHealthSummary({
    status: {
      version: "0.4.2",
      listen: "http://127.0.0.1:15723",
      upstream: "http://127.0.0.1:15722/v1/chat/completions",
      upstreamSource: "discovered",
      patcherApplied: true,
      startedAt: "2026-07-10T00:00:00.000Z",
      pid: 123,
    },
    config: baseConfig,
    env: { CCPROXY_VISION_API_KEY: "set" },
  });

  assert.deepEqual(
    health.items.map((item) => [item.id, item.state]),
    [
      ["proxy", "ok"],
      ["upstream", "ok"],
      ["claude", "ok"],
      ["vision", "ok"],
    ],
  );
  assert.equal(health.score.ok, 4);
  assert.equal(health.items[1]?.detail, "discovered upstream");
});

test("extractProtectionEvents turns structured logs into user-facing guard events", () => {
  const logs: LogEntry[] = [
    {
      timestamp: "2026-07-10T00:00:01.000Z",
      level: "info",
      message: "Token预算评估",
      metadata: {
        inputTokens: 46449,
        expectedOutputTokens: 4096,
        totalTokens: 50545,
        decision: "safe",
        visionUsed: false,
      },
    },
    {
      timestamp: "2026-07-10T00:00:02.000Z",
      level: "warn",
      message: "已自动降低max_tokens，避免总token撞上上下文硬上限",
      metadata: {
        originalMaxTokens: 64000,
        adjustedMaxTokens: 55999,
        inputTokens: 136001,
        hardLimit: 200000,
      },
    },
    {
      timestamp: "2026-07-10T00:00:03.000Z",
      level: "warn",
      message: "已降低max_tokens并自动重试一次",
      metadata: {
        originalMaxTokens: 64000,
        adjustedMaxTokens: 55999,
        contextLimit: 200000,
        inputTokens: 136001,
      },
    },
  ];

  const events = extractProtectionEvents(logs);

  assert.equal(events.length, 3);
  assert.equal(events[0]?.kind, "budget");
  assert.equal(events[0]?.title, "Token budget checked");
  assert.equal(events[1]?.kind, "max_tokens");
  assert.match(events[1]?.summary ?? "", /64,000 -> 55,999/);
  assert.equal(events[2]?.kind, "retry");
  assert.equal(events[2]?.severity, "success");
});

test("extractProtectionEvents surfaces observer-only tool telemetry", () => {
  const events = extractProtectionEvents([{
    timestamp: "2026-07-11T00:00:00.000Z",
    level: "info",
    message: "Claude tool batch observed",
    metadata: {
      toolCount: 3,
      outputChars: 12000,
      repeatedCalls: 1,
      truncatedResults: 1,
      mode: "observe",
    },
  }]);

  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "tool");
  assert.equal(events[0]?.severity, "warning");
  assert.match(events[0]?.summary ?? "", /observe only/);
});

test("extractProtectionEvents surfaces structural tool-result clearing", () => {
  const events = extractProtectionEvents([{
    timestamp: "2026-07-11T00:00:00.000Z",
    level: "warn",
    message: "Cleared old Agent tool results after upstream context error",
    metadata: {
      clearedResults: 5,
      estimatedTokensCleared: 48000,
      beforeInputTokens: 198977,
      afterInputTokens: 149500,
    },
  }]);

  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "tool");
  assert.equal(events[0]?.severity, "success");
  assert.match(events[0]?.summary ?? "", /198,977 -> 149,500/);
});
