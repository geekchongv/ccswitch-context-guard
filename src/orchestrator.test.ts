import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync } from "node:fs";
import { once } from "node:events";
import { AppConfig, ChatCompletionRequest } from "./types.js";
import { Logger } from "./logger.js";
import { SessionStore } from "./session-store.js";
import { Orchestrator } from "./orchestrator.js";
import { estimateRequestTokens } from "./token-estimator.js";

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
    ui: {
      enabled: false,
      openOnStart: false,
    },
    claudeConfigPatch: {
      enabled: false,
    },
    claudeDesktopConfigPatch: {
      enabled: false,
    },
  };
}

function buildToolHistory(resultRepeats = 3000): ChatCompletionRequest {
  const messages: NonNullable<ChatCompletionRequest["messages"]> = [];
  for (let index = 0; index < 6; index += 1) {
    messages.push({
      role: "assistant",
      content: [{
        type: "tool_use",
        id: `toolu_${index}`,
        name: "Read",
        input: { file_path: `source-${index}.ts` },
      }],
    });
    messages.push({
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: `toolu_${index}`,
        content: `tool-output-${index} ` + "source code output with line details. ".repeat(resultRepeats),
      }],
    });
  }
  return {
    system: [{ type: "text", text: "You are a coding agent. Preserve tool protocol." }],
    tools: [{ name: "Read", description: "Read a file", input_schema: { type: "object" } }],
    messages,
    max_tokens: 4096,
  };
}

function requestToolParts(request: ChatCompletionRequest, type: string): Array<Record<string, unknown>> {
  return (request.messages ?? []).flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.filter((part) => (part as Record<string, unknown>).type === type)
      : [],
  ) as Array<Record<string, unknown>>;
}

test("orchestrator proactively clears old tool results without breaking protocol", async () => {
  mkdirSync("test-output/logs", { recursive: true });
  mkdirSync("test-output/runtime/sessions", { recursive: true });
  const received: ChatCompletionRequest[] = [];
  const upstream = http.createServer(async (request, response) => {
    received.push((await readJson(request)) as ChatCompletionRequest);
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ content: [{ type: "text", text: "cleared safely" }] }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  assert.ok(address && typeof address === "object");

  try {
    const config = buildTestConfig(address.port);
    config.tokenPolicy.toolResultClearingEnabled = true;
    config.tokenPolicy.toolResultClearTrigger = 5_000;
    config.tokenPolicy.toolResultClearTarget = 3_000;
    config.tokenPolicy.toolResultKeepRecent = 2;
    const orchestrator = new Orchestrator(config, new Logger(config.logging), new SessionStore(config.runtime.directory));
    const response = await orchestrator.handle("/v1/messages", buildToolHistory(500));

    assert.equal(response.status, 200);
    assert.equal(received.length, 1);
    const uses = requestToolParts(received[0], "tool_use");
    const results = requestToolParts(received[0], "tool_result");
    assert.equal(uses.length, 6);
    assert.equal(results.length, 6);
    assert.deepEqual(uses.map((part) => part.id), results.map((part) => part.tool_use_id));
    assert.equal(results.slice(0, 4).every((part) => String(part.content).includes("cleared by CCProxy Agent")), true);
    assert.equal(results.slice(-2).every((part) => String(part.content).startsWith("tool-output-")), true);
  } finally {
    upstream.close();
    await once(upstream, "close");
  }
});

test("orchestrator replays the 198977 plus 1024 context error with structural tool-result rescue", async () => {
  mkdirSync("test-output/logs", { recursive: true });
  mkdirSync("test-output/runtime/sessions", { recursive: true });
  const received: ChatCompletionRequest[] = [];
  const upstream = http.createServer(async (request, response) => {
    received.push((await readJson(request)) as ChatCompletionRequest);
    response.writeHead(received.length === 1 ? 400 : 200, { "content-type": "application/json; charset=utf-8" });
    if (received.length === 1) {
      response.end(JSON.stringify({
        error: {
          message: "This model's maximum context length is 200000 tokens. However, you requested 1024 output tokens and your prompt contains at least 198977 input tokens, for a total of at least 200001 tokens. Please reduce the length of the input prompt or the number of requested output tokens. (parameter=input_tokens, value=198977)",
        },
      }));
    } else {
      response.end(JSON.stringify({ content: [{ type: "text", text: "rescue ok" }] }));
    }
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  assert.ok(address && typeof address === "object");

  try {
    const config = buildTestConfig(address.port);
    config.tokenPolicy.toolResultClearingEnabled = true;
    config.tokenPolicy.toolResultClearTrigger = Number.MAX_SAFE_INTEGER;
    config.tokenPolicy.toolResultClearTarget = 3_000;
    config.tokenPolicy.toolResultKeepRecent = 2;
    const orchestrator = new Orchestrator(config, new Logger(config.logging), new SessionStore(config.runtime.directory));
    const replayRequest = buildToolHistory(300);
    replayRequest.max_tokens = 1024;
    const response = await orchestrator.handle("/v1/messages", replayRequest);

    assert.equal(response.status, 200);
    assert.equal(received.length, 2);
    assert.equal(JSON.stringify(received[0]).includes("cleared by CCProxy Agent"), false);
    const retryUses = requestToolParts(received[1], "tool_use");
    const retryResults = requestToolParts(received[1], "tool_result");
    assert.deepEqual(retryUses.map((part) => part.id), retryResults.map((part) => part.tool_use_id));
    assert.equal(retryResults.slice(0, 4).every((part) => String(part.content).includes("cleared by CCProxy Agent")), true);
    assert.equal(retryResults.slice(-2).every((part) => String(part.content).startsWith("tool-output-")), true);
    assert.equal(received[1]?.max_tokens, 1024);
  } finally {
    upstream.close();
    await once(upstream, "close");
  }
});

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

test("orchestrator retries with provider-reported token counts when local estimate is low", async () => {
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
            "This model's maximum context length is 200000 tokens. However, you requested 4096 output tokens and your prompt contains at least 195905 input tokens, for a total of at least 200001 tokens. Please reduce the length of the input prompt or the number of requested output tokens. (parameter=input_tokens, value=195905)",
        }),
      );
      return;
    }

    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(
      JSON.stringify({
        content: [{ type: "text", text: "provider count retry ok" }],
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
      messages: [{ role: "user", content: "local estimate is much lower than provider count" }],
      max_tokens: 4096,
    };

    const response = await orchestrator.handle("/v1/messages", request);
    const payload = (await response.json()) as { content: { text: string }[] };

    assert.equal(response.status, 200);
    assert.equal(payload.content[0]?.text, "provider count retry ok");
    assert.deepEqual(receivedMaxTokens, [4096, 1024]);
  } finally {
    upstream.close();
    await once(upstream, "close");
  }
});

test("orchestrator preserves oversized Agent tool protocol instead of generic chunking", async () => {
  mkdirSync("test-output/logs", { recursive: true });
  mkdirSync("test-output/runtime/sessions", { recursive: true });
  const received: ChatCompletionRequest[] = [];
  const upstream = http.createServer(async (request, response) => {
    received.push((await readJson(request)) as ChatCompletionRequest);
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ content: [{ type: "text", text: "agent request preserved" }] }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  assert.ok(address && typeof address === "object");

  try {
    const base = buildTestConfig(address.port);
    const config: AppConfig = {
      ...base,
      tokenPolicy: {
        ...base.tokenPolicy,
        compactThreshold: 1500,
        hardLimit: 4000,
        safetyMargin: 200,
        responseReserve: 100,
        chunkTarget: 2000,
      },
    };
    const orchestrator = new Orchestrator(
      config,
      new Logger(config.logging),
      new SessionStore(config.runtime.directory),
    );
    const request: ChatCompletionRequest = {
      tools: [{ name: "Read", description: "Read a file", input_schema: { type: "object" } }],
      messages: [{ role: "user", content: "large agent context ".repeat(3000) }],
      max_tokens: 100,
    };

    const response = await orchestrator.handle("/v1/messages", request);
    assert.equal(response.status, 200);
    assert.equal(received.length, 1);
    assert.equal(JSON.stringify(received[0]).includes("Process this chunk"), false);
    assert.equal(JSON.stringify(received[0]).includes("[COMPACT MEMORY]"), false);
    assert.ok(Array.isArray(received[0]?.tools));
  } finally {
    upstream.close();
    await once(upstream, "close");
  }
});

test("orchestrator retries with minimum output when provider count leaves no safety margin", async () => {
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
            "This model's maximum context length is 200000 tokens. However, you requested 3839 output tokens and your prompt contains at least 196162 input tokens, for a total of at least 200001 tokens. Please reduce the length of the input prompt or the number of requested output tokens. (parameter=input_tokens, value=196162)",
        }),
      );
      return;
    }

    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(
      JSON.stringify({
        content: [{ type: "text", text: "minimum output retry ok" }],
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
      messages: [{ role: "user", content: "compact retry is already near provider hard limit" }],
      max_tokens: 3839,
    };

    const response = await orchestrator.handle("/v1/messages", request);
    const payload = (await response.json()) as { content: { text: string }[] };

    assert.equal(response.status, 200);
    assert.equal(payload.content[0]?.text, "minimum output retry ok");
    assert.deepEqual(receivedMaxTokens, [3839, 1024]);
  } finally {
    upstream.close();
    await once(upstream, "close");
  }
});

test("orchestrator compacts before retrying a provider context-limit failure", async () => {
  mkdirSync("test-output/logs", { recursive: true });
  mkdirSync("test-output/runtime/sessions", { recursive: true });

  const receivedBodies: ChatCompletionRequest[] = [];
  const upstream = http.createServer(async (request, response) => {
    const body = await readJson(request) as ChatCompletionRequest;
    receivedBodies.push(body);

    if (receivedBodies.length === 1) {
      response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
      response.end(
        JSON.stringify({
          error:
            "This model's maximum context length is 200000 tokens. However, you requested 3839 output tokens and your prompt contains at least 196162 input tokens, for a total of at least 200001 tokens. Please reduce the length of the input prompt or the number of requested output tokens. (parameter=input_tokens, value=196162)",
        }),
      );
      return;
    }

    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(
      JSON.stringify({
        content: [{ type: "text", text: "compacted retry ok" }],
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
      messages: Array.from({ length: 12 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `message ${index} ` + "context ".repeat(1000),
      })),
      max_tokens: 3839,
    };

    const response = await orchestrator.handle("/v1/messages", request);
    const payload = (await response.json()) as { content: { text: string }[] };
    const firstBody = receivedBodies[0];
    const retryBody = receivedBodies[1];

    assert.equal(response.status, 200);
    assert.equal(payload.content[0]?.text, "compacted retry ok");
    assert.ok(firstBody);
    assert.ok(firstBody.messages);
    assert.ok(retryBody);
    assert.ok(retryBody.messages);
    const retryText = JSON.stringify(retryBody.messages);

    assert.ok(firstBody.messages.length > retryBody.messages.length);
    assert.match(retryText, /\[COMPACT MEMORY\]/);
    assert.equal(retryBody.max_tokens, 1024);
  } finally {
    upstream.close();
    await once(upstream, "close");
  }
});

test("orchestrator replays an upstream non-context failure body to the caller", async () => {
  mkdirSync("test-output/logs", { recursive: true });
  mkdirSync("test-output/runtime/sessions", { recursive: true });

  const upstreamErrorBody = JSON.stringify({ error: "model is overloaded" });

  const upstream = http.createServer(async (_request, response) => {
    // 非 context-limit 的普通失败：编排层不应重试，而应原样回传 body 与状态码。
    response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    response.end(upstreamErrorBody);
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
      messages: [{ role: "user", content: "trigger generic upstream failure" }],
      max_tokens: 1024,
    };

    const response = await orchestrator.handle("/v1/messages", request);
    const text = await response.text();

    assert.equal(response.status, 500);
    assert.equal(text, upstreamErrorBody);
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

test("orchestrator chunks an oversized request and every chunk stays under the hard cap", async () => {
  mkdirSync("test-output/logs", { recursive: true });
  mkdirSync("test-output/runtime/sessions", { recursive: true });

  // 用很小的 tokenPolicy 强制触发 chunk_required。
  const hardLimit = 4000;
  const safetyMargin = 200;
  const responseReserve = 100;
  const chunkTarget = 2000;
  const hardCap = hardLimit - safetyMargin - responseReserve; // 3700

  const receivedChunks: ChatCompletionRequest[] = [];
  const upstream = http.createServer(async (request, response) => {
    const body = (await readJson(request)) as ChatCompletionRequest;
    receivedChunks.push(body);
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ content: [{ type: "text", text: "chunk ok" }] }));
  });

  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  assert.ok(address && typeof address === "object");

  try {
    const base = buildTestConfig(address.port);
    const config: AppConfig = {
      ...base,
      tokenPolicy: {
        ...base.tokenPolicy,
        compactThreshold: 1500,
        hardLimit,
        safetyMargin,
        responseReserve,
        chunkTarget,
      },
    };
    const orchestrator = new Orchestrator(
      config,
      new Logger(config.logging),
      new SessionStore(config.runtime.directory),
    );
    // 样本重复到 tokenx 计数远超 hardLimit,触发分块执行。
    const sample = "The proxy estimates message size and warns before the limit is reached. ";
    const request: ChatCompletionRequest = {
      messages: [{ role: "user", content: sample.repeat(1000) }],
      max_tokens: 100,
    };

    const response = await orchestrator.handle("/v1/messages", request);
    assert.equal(response.status, 200);

    // receivedChunks 包含分块请求 + 最后的合成请求;两者都必须在硬上限内。
    const chunkRequests = receivedChunks.filter(
      (c) => typeof c.messages?.[0]?.content === "string" && /Process this chunk|Continue processing/.test(c.messages[0].content),
    );
    assert.ok(chunkRequests.length > 1, `应分多块执行,实际 ${chunkRequests.length} 块`);

    for (const [i, chunk] of chunkRequests.entries()) {
      const inputTokens = estimateRequestTokens(chunk, responseReserve).inputTokens;
      assert.ok(
        inputTokens <= hardCap,
        `第 ${i + 1} 块 inputTokens=${inputTokens} 超过硬上限 ${hardCap}`,
      );
    }

    const synthesisRequest = receivedChunks.find(
      (c) => typeof c.messages?.[0]?.content === "string" && /Synthesize the chunk results/.test(c.messages[0].content),
    );
    assert.ok(synthesisRequest, "应发送最终合成请求");
    const synthesisInputTokens = estimateRequestTokens(synthesisRequest, responseReserve).inputTokens;
    assert.ok(
      synthesisInputTokens <= hardCap,
      `合成请求 inputTokens=${synthesisInputTokens} 超过硬上限 ${hardCap}`,
    );
  } finally {
    upstream.close();
    await once(upstream, "close");
  }
});
