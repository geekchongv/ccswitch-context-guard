import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { SessionRegistry } from "./session-registry.js";
import { AppConfig, BudgetAssessment, ChatCompletionRequest, OrchestrationRecord } from "./types.js";
import { setBaseDirectory } from "./paths.js";

function buildConfig(root: string): AppConfig {
  return {
    server: { host: "127.0.0.1", port: 15722 },
    upstream: { baseUrl: "http://127.0.0.1:15721", chatPath: "/v1/messages", timeoutMs: 5000 },
    tokenPolicy: {
      compactThreshold: 160_000,
      hardLimit: 200_000,
      responseReserve: 12_000,
      chunkTarget: 90_000,
      safetyMargin: 8_000,
      compactMode: "proxy",
      compactWarningText: "compact",
      autoReduceMaxTokens: true,
      retryOnContextError: true,
      minOutputTokens: 1024,
      toolResultClearingEnabled: true,
      toolResultClearTrigger: 140_000,
      toolResultClearTarget: 100_000,
      toolResultKeepRecent: 3,
    },
    vision: {
      enabled: false,
      baseUrl: "",
      chatPath: "",
      model: "",
      compareModels: false,
      timeoutMs: 5000,
      maxImagesPerRequest: 5,
      maxImageBytes: 5_000_000,
      summaryMaxTokens: 1500,
      stripImagesAfterSummary: true,
      systemPrompt: "",
    },
    logging: { level: "error", directory: path.join(root, "logs") },
    runtime: {
      directory: "runtime",
      sessionMaxRecords: 500,
      sessionMaxSessions: 100,
      sessionRetentionDays: 7,
    },
    ui: { enabled: false, openOnStart: false },
    claudeConfigPatch: {
      enabled: true,
      autoCompactEnabled: true,
      autoCompactReserveTokens: 30_000,
    },
    claudeDesktopConfigPatch: { enabled: false },
  };
}

function sid(value: string): string {
  return `sid-${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function budget(inputTokens: number): BudgetAssessment {
  return {
    decision: inputTokens >= 160_000 ? "compact_required" : "safe",
    estimate: {
      inputTokens,
      expectedOutputTokens: 12_000,
      totalTokens: inputTokens + 12_000,
    },
  };
}

function completion(sessionId: string, requestId: string, inputTokens: number): OrchestrationRecord {
  return {
    requestId,
    sessionId,
    timestamp: new Date().toISOString(),
    routePath: "/v1/messages",
    budget: budget(inputTokens),
    compacted: false,
    compactWarning: false,
    chunked: false,
    maxTokensReduced: false,
    retriedAfterContextError: false,
    vision: { used: false },
  };
}

test("SessionRegistry keeps concurrent Claude sessions isolated and selects the highest usage for overview", () => {
  const root = path.resolve("test-output", "session-registry-isolation");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(path.join(root, "runtime", "sessions"), { recursive: true });
  setBaseDirectory(root);
  try {
    const registry = new SessionRegistry(buildConfig(root));
    const requestA: ChatCompletionRequest = {
      model: "claude-a",
      messages: [{ role: "user", content: "project alpha request" }],
    };
    const requestB: ChatCompletionRequest = {
      model: "claude-b",
      messages: [{ role: "user", content: "project beta request" }],
    };
    registry.observeHook({
      sessionId: "session-alpha",
      eventName: "UserPromptSubmit",
      cwd: "C:\\work\\alpha",
      timestamp: "2026-07-28T10:00:00.000Z",
    });
    const sessionA = registry.resolveRequest(requestA, "/v1/messages", {});
    assert.equal(sessionA, sid("session-alpha"));

    // A subsequent prompt from the mapped session must consume its pending hook
    // instead of leaking it into the next new session.
    registry.observeHook({
      sessionId: "session-alpha",
      eventName: "UserPromptSubmit",
      cwd: "C:\\work\\alpha",
      timestamp: "2026-07-28T10:00:01.000Z",
    });
    assert.equal(registry.resolveRequest(requestA, "/v1/messages", {}), sid("session-alpha"));

    registry.observeHook({
      sessionId: "session-beta",
      eventName: "UserPromptSubmit",
      cwd: "C:\\work\\beta",
      timestamp: "2026-07-28T10:00:02.000Z",
    });
    const sessionB = registry.resolveRequest(requestB, "/v1/messages", {});
    assert.equal(sessionB, sid("session-beta"));

    registry.requestStarted(sessionA, {
      requestId: "request-a",
      routePath: "/v1/messages",
      model: "claude-a",
      timestamp: "2026-07-28T10:00:03.000Z",
    });
    registry.updateBudget(sessionA, "request-a", budget(150_000), "2026-07-28T10:00:03.000Z");
    registry.requestCompleted(completion(sessionA, "request-a", 150_000));
    registry.requestStarted(sessionB, {
      requestId: "request-b",
      routePath: "/v1/messages",
      model: "claude-b",
      timestamp: "2026-07-28T10:00:04.000Z",
    });
    registry.updateBudget(sessionB, "request-b", budget(30_000), "2026-07-28T10:00:04.000Z");
    registry.requestCompleted(completion(sessionB, "request-b", 30_000));

    const snapshot = registry.snapshot();
    assert.equal(snapshot.sessions.length, 2);
    assert.equal(snapshot.highestUsageSessionId, sid("session-alpha"));
    assert.equal(snapshot.sessions.find((session) => session.id === sid("session-alpha"))?.context.currentTokens, 150_000);
    assert.equal(snapshot.sessions.find((session) => session.id === sid("session-beta"))?.context.currentTokens, 30_000);
    assert.equal(registry.overviewContext().currentTokens, 150_000);
  } finally {
    setBaseDirectory(null);
  }
});

test("SessionRegistry persists metadata without prompt content and honors explicit session ids", () => {
  const root = path.resolve("test-output", "session-registry-persistence");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(path.join(root, "runtime", "sessions"), { recursive: true });
  setBaseDirectory(root);
  try {
    const registry = new SessionRegistry(buildConfig(root));
    const request: ChatCompletionRequest = {
      model: "claude",
      metadata: { session_id: "explicit-session" },
      messages: [{ role: "user", content: "private prompt must not be persisted" }],
    };
    const sessionId = registry.resolveRequest(request, "/v1/messages", {});
    assert.equal(sessionId, sid("explicit-session"));
    registry.requestStarted(sessionId, {
      requestId: "request",
      routePath: "/v1/messages",
      timestamp: "2026-07-28T10:00:00.000Z",
    });
    registry.requestCompleted(completion(sessionId, "request", 42_000));

    const raw = readFileSync(path.join(root, "runtime", "session-index.json"), "utf8");
    assert.doesNotMatch(raw, /private prompt/);
    assert.doesNotMatch(raw, /explicit-session/);
    const restored = new SessionRegistry(buildConfig(root)).snapshot();
    assert.equal(restored.sessions[0]?.id, sid("explicit-session"));
    assert.equal(restored.sessions[0]?.context.currentTokens, 42_000);
  } finally {
    setBaseDirectory(null);
  }
});

test("SessionRegistry matches concurrent hook sessions by prompt hash even when requests arrive out of order", () => {
  const root = path.resolve("test-output", "session-registry-concurrent-hooks");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(path.join(root, "runtime", "sessions"), { recursive: true });
  setBaseDirectory(root);
  try {
    const registry = new SessionRegistry(buildConfig(root));
    const alphaPrompt = "alpha concurrent prompt";
    const betaPrompt = "beta concurrent prompt";
    const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);
    registry.observeHook({
      sessionId: "session-alpha",
      eventName: "UserPromptSubmit",
      promptFingerprint: hash(alphaPrompt),
      timestamp: new Date().toISOString(),
    });
    registry.observeHook({
      sessionId: "session-beta",
      eventName: "UserPromptSubmit",
      promptFingerprint: hash(betaPrompt),
      timestamp: new Date().toISOString(),
    });

    assert.equal(registry.resolveRequest({
      messages: [{ role: "user", content: betaPrompt }],
    }, "/v1/messages", {}), sid("session-beta"));
    assert.equal(registry.resolveRequest({
      messages: [{ role: "user", content: alphaPrompt }],
    }, "/v1/messages", {}), sid("session-alpha"));
  } finally {
    setBaseDirectory(null);
  }
});

test("SessionRegistry does not let an older concurrent request overwrite newer context", () => {
  const root = path.resolve("test-output", "session-registry-request-order");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(path.join(root, "runtime", "sessions"), { recursive: true });
  setBaseDirectory(root);
  try {
    const registry = new SessionRegistry(buildConfig(root));
    const sessionId = registry.resolveRequest({
      session_id: "ordered-session",
      messages: [{ role: "user", content: "same session" }],
    }, "/v1/messages", {});
    registry.requestStarted(sessionId, {
      requestId: "older",
      routePath: "/v1/messages",
      timestamp: "2026-07-28T10:00:00.000Z",
    });
    registry.updateBudget(sessionId, "older", budget(120_000));
    registry.requestStarted(sessionId, {
      requestId: "newer",
      routePath: "/v1/messages",
      timestamp: "2026-07-28T10:00:01.000Z",
    });
    registry.updateBudget(sessionId, "newer", budget(80_000));
    registry.requestCompleted(completion(sessionId, "older", 120_000));
    assert.equal(registry.snapshot().sessions[0]?.context.currentTokens, 80_000);
    registry.requestCompleted(completion(sessionId, "newer", 80_000));
    assert.equal(registry.snapshot().sessions[0]?.context.currentTokens, 80_000);
  } finally {
    setBaseDirectory(null);
  }
});

test("SessionRegistry surfaces non-success upstream responses as session errors", () => {
  const root = path.resolve("test-output", "session-registry-error-status");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(path.join(root, "runtime", "sessions"), { recursive: true });
  setBaseDirectory(root);
  try {
    const registry = new SessionRegistry(buildConfig(root));
    const sessionId = registry.resolveRequest({
      session_id: "error-session",
      messages: [{ role: "user", content: "request" }],
    }, "/v1/messages", {});
    registry.requestStarted(sessionId, {
      requestId: "failed",
      routePath: "/v1/messages",
      timestamp: new Date().toISOString(),
    });
    registry.updateBudget(sessionId, "failed", budget(20_000));
    registry.requestCompleted({
      ...completion(sessionId, "failed", 20_000),
      responseStatus: 502,
    });
    const session = registry.snapshot().sessions[0];
    assert.equal(session?.status, "error");
    assert.equal(session?.errorCount, 1);
    assert.match(session?.events.at(-1)?.label ?? "", /HTTP 502/);
  } finally {
    setBaseDirectory(null);
  }
});
