import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync } from "node:fs";
import { once } from "node:events";
import { AppConfig, ChatCompletionRequest } from "./types.js";
import { Logger } from "./logger.js";
import { SessionStore } from "./session-store.js";
import { Orchestrator } from "./orchestrator.js";

async function readJson(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function buildTestConfig(port: number): AppConfig {
  return {
    server: {
      host: "127.0.0.1",
      port: 0,
    },
    upstream: {
      baseUrl: `http://127.0.0.1:${port}`,
      chatPath: "/v1/messages",
      timeoutMs: 5000,
      aiRoutes: ["/v1/messages"],
    },
    tokenPolicy: {
      compactThreshold: 180000,
      hardLimit: 200000,
      responseReserve: 12000,
      chunkTarget: 90000,
      safetyMargin: 8000,
      compactMode: "warn",
      compactWarningText: "[上下文提醒] 当前会话已经接近上下文上限，建议你现在执行 /compact 后再继续。",
      autoReduceMaxTokens: true,
      retryOnContextError: true,
      minOutputTokens: 1024,
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
    logging: {
      level: "error",
      directory: "./test-output/logs",
    },
    runtime: {
      directory: "./test-output/runtime",
    },
    claudeConfigPatch: {
      enabled: false,
    },
    claudeDesktopConfigPatch: {
      enabled: false,
    },
  };
}

test("orchestrator lowers max_tokens and retries once after upstream context limit 400", async () => {
  mkdirSync("test-output/logs", { recursive: true });
  mkdirSync("test-output/runtime/sessions", { recursive: true });

  const receivedMaxTokens: number[] = [];
  const upstream = http.createServer(async (request, response) => {
    const body = await readJson(request);
    receivedMaxTokens.push(Number(body.max_tokens));

    if (receivedMaxTokens.length === 1) {
      response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
      response.end(
        JSON.stringify({
          error:
            "This model's maximum context length is 200000 tokens. However, you requested 64000 output tokens and your prompt contains at least 136001 input tokens, for a total of at least 200001 tokens. Please reduce the length of the input prompt or the number of requested output tokens. (parameter=input_tokens, value=136001)",
        }),
      );
      return;
    }

    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(
      JSON.stringify({
        content: [{ type: "text", text: "retry ok" }],
      }),
    );
  });

  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  assert.ok(address && typeof address === "object");

  try {
    const config = buildTestConfig(address.port);
    const orchestrator = new Orchestrator(
      config,
      new Logger(config.logging),
      new SessionStore(config.runtime.directory),
    );
    const request: ChatCompletionRequest = {
      messages: [{ role: "user", content: "trigger upstream context error" }],
      max_tokens: 64000,
    };

    const response = await orchestrator.handle("/v1/messages", request);
    const payload = (await response.json()) as { content: { text: string }[] };

    assert.equal(response.status, 200);
    assert.equal(payload.content[0]?.text, "retry ok");
    assert.deepEqual(receivedMaxTokens, [64000, 55999]);
  } finally {
    upstream.close();
    await once(upstream, "close");
  }
});

test("orchestrator preserves authorization headers for Claude Desktop gateway requests", async () => {
  mkdirSync("test-output/logs", { recursive: true });
  mkdirSync("test-output/runtime/sessions", { recursive: true });

  const receivedAuthorizationHeaders: Array<string | undefined> = [];
  const upstream = http.createServer(async (request, response) => {
    await readJson(request);
    receivedAuthorizationHeaders.push(request.headers.authorization);

    if (request.headers.authorization !== "Bearer desktop-token") {
      response.writeHead(401, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "missing authorization" }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(
      JSON.stringify({
        content: [{ type: "text", text: "auth ok" }],
      }),
    );
  });

  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  assert.ok(address && typeof address === "object");

  try {
    const config = buildTestConfig(address.port);
    const orchestrator = new Orchestrator(
      config,
      new Logger(config.logging),
      new SessionStore(config.runtime.directory),
    );
    const request: ChatCompletionRequest = {
      messages: [{ role: "user", content: "hello desktop gateway" }],
      max_tokens: 1024,
    };

    const response = await orchestrator.handle(
      "/claude-desktop/v1/messages",
      request,
      {
        authorization: "Bearer desktop-token",
        "anthropic-version": "2023-06-01",
      },
    );
    const payload = (await response.json()) as { content: { text: string }[] };

    assert.equal(response.status, 200);
    assert.equal(payload.content[0]?.text, "auth ok");
    assert.deepEqual(receivedAuthorizationHeaders, ["Bearer desktop-token"]);
  } finally {
    upstream.close();
    await once(upstream, "close");
  }
});

test("server filters hop-by-hop headers before forwarding orchestrated Desktop requests", async () => {
  mkdirSync("test-output/logs", { recursive: true });
  mkdirSync("test-output/runtime/sessions", { recursive: true });

  const receivedHeaders: http.IncomingHttpHeaders[] = [];
  const upstream = http.createServer(async (request, response) => {
    await readJson(request);
    receivedHeaders.push(request.headers);

    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(
      JSON.stringify({
        content: [{ type: "text", text: "headers ok" }],
      }),
    );
  });

  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === "object");

  const proxyServer = http.createServer();

  try {
    const config = buildTestConfig(upstreamAddress.port);
    const { createServer } = await import("./server.js");
    const orchestrator = new Orchestrator(
      config,
      new Logger(config.logging),
      new SessionStore(config.runtime.directory),
    );
    const server = createServer(config, new Logger(config.logging), orchestrator);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const proxyAddress = server.address();
    assert.ok(proxyAddress && typeof proxyAddress === "object");

    const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/claude-desktop/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer desktop-token",
        connection: "keep-alive",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 16,
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(receivedHeaders[0]?.authorization, "Bearer desktop-token");
    assert.equal(receivedHeaders[0]?.connection, "keep-alive");
    assert.equal(receivedHeaders[0]?.["content-type"], "application/json");

    server.close();
    await once(server, "close");
  } finally {
    proxyServer.close();
    upstream.close();
    await once(upstream, "close");
  }
});
