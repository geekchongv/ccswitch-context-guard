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
