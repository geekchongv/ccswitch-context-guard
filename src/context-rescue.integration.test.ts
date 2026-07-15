import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdirSync } from "node:fs";
import { AppConfig, ChatCompletionRequest } from "./types.js";
import { Logger } from "./logger.js";
import { SessionStore } from "./session-store.js";
import { Orchestrator } from "./orchestrator.js";
import { createServer } from "./server.js";

async function readBody(request: http.IncomingMessage): Promise<ChatCompletionRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatCompletionRequest;
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function configFor(upstreamPort: number): AppConfig {
  return {
    server: { host: "127.0.0.1", port: 0, autoPort: false },
    upstream: {
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
      chatPath: "/v1/messages",
      timeoutMs: 5000,
      aiRoutes: ["/v1/messages"],
      autoDiscover: false,
    },
    tokenPolicy: {
      compactThreshold: 180000,
      hardLimit: 200000,
      responseReserve: 12000,
      chunkTarget: 90000,
      safetyMargin: 8000,
      compactMode: "warn",
      compactWarningText: "compact",
      autoReduceMaxTokens: true,
      retryOnContextError: true,
      minOutputTokens: 1024,
      toolResultClearingEnabled: true,
      toolResultClearTrigger: Number.MAX_SAFE_INTEGER,
      toolResultClearTarget: 2000,
      toolResultKeepRecent: 1,
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
    logging: { level: "error", directory: "./test-output/context-rescue/logs" },
    runtime: { directory: "./test-output/context-rescue/runtime" },
    ui: { enabled: false, openOnStart: false },
    claudeConfigPatch: { enabled: false },
    claudeDesktopConfigPatch: { enabled: false },
  };
}

function replayPayload(): ChatCompletionRequest {
  const messages: NonNullable<ChatCompletionRequest["messages"]> = [];
  for (let index = 0; index < 5; index += 1) {
    messages.push({
      role: "assistant",
      content: [{ type: "tool_use", id: `toolu_${index}`, name: "Read", input: { file_path: `f${index}.ts` } }],
    });
    messages.push({
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: `toolu_${index}`,
        content: `result-${index} ` + "large source output. ".repeat(1000),
      }],
    });
  }
  return {
    system: [{ type: "text", text: "coding agent" }],
    tools: [{ name: "Read", input_schema: { type: "object" } }],
    messages,
    max_tokens: 1024,
  };
}

test("HTTP proxy rescues an Agent context error and returns the retry response", async () => {
  mkdirSync("test-output/context-rescue/logs", { recursive: true });
  mkdirSync("test-output/context-rescue/runtime/sessions", { recursive: true });
  const upstreamBodies: ChatCompletionRequest[] = [];
  const upstream = http.createServer(async (request, response) => {
    upstreamBodies.push(await readBody(request));
    response.writeHead(upstreamBodies.length === 1 ? 400 : 200, { "content-type": "application/json" });
    response.end(upstreamBodies.length === 1
      ? JSON.stringify({ error: { message: "This model's maximum context length is 200000 tokens. However, you requested 1024 output tokens and your prompt contains at least 198977 input tokens, for a total of at least 200001 tokens. (parameter=input_tokens, value=198977)" } })
      : JSON.stringify({ content: [{ type: "text", text: "http rescue ok" }] }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === "object");

  const config = configFor(upstreamAddress.port);
  const logger = new Logger(config.logging);
  const proxy = createServer(config, logger, new Orchestrator(config, logger, new SessionStore(config.runtime.directory)));
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const proxyAddress = proxy.address();
  assert.ok(proxyAddress && typeof proxyAddress === "object");

  try {
    const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(replayPayload()),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /http rescue ok/);
    assert.equal(upstreamBodies.length, 2);
    assert.equal(JSON.stringify(upstreamBodies[0]).includes("cleared by CCProxy Agent"), false);
    assert.equal(JSON.stringify(upstreamBodies[1]).includes("cleared by CCProxy Agent"), true);
    const retryText = JSON.stringify(upstreamBodies[1]);
    assert.match(retryText, /result-4/);
    assert.match(retryText, /middle of tool result truncated|large source output/);
    assert.equal(upstreamBodies[1]?.max_tokens, 1024);
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
});

test("HTTP proxy rejects oversized request bodies with 413", async () => {
  const upstream = http.createServer((_request, response) => {
    response.writeHead(500);
    response.end();
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === "object");
  const config = configFor(upstreamAddress.port);
  config.server.maxRequestBodyBytes = 1_000_000;
  const logger = new Logger(config.logging);
  const proxy = createServer(config, logger, new Orchestrator(config, logger, new SessionStore(config.runtime.directory)));
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const proxyAddress = proxy.address();
  assert.ok(proxyAddress && typeof proxyAddress === "object");

  try {
    const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "x".repeat(1_100_000) }] }),
    });
    assert.equal(response.status, 413);
    assert.match(await response.text(), /request body too large/);
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
});
