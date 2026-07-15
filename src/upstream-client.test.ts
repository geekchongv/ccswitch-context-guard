import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { UpstreamClient } from "./upstream-client.js";
import { UpstreamConfig } from "./types.js";

async function listen(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, port: address.port };
}

function config(port: number, overrides: Partial<UpstreamConfig> = {}): UpstreamConfig {
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    chatPath: "/v1/messages",
    timeoutMs: 2_000,
    adaptiveRateLimit: true,
    maxConcurrentRequests: 2,
    rateLimitFallbackDelayMs: 5,
    rateLimitMaxRetries: 1,
    ...overrides,
  };
}

test("UpstreamClient waits and retries one 429 inside the proxy", async () => {
  let calls = 0;
  const startedAt = Date.now();
  const { server, port } = await listen((_request, response) => {
    calls += 1;
    if (calls === 1) {
      response.writeHead(429, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "local gateway rate limit" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });

  try {
    const client = new UpstreamClient(config(port, { rateLimitFallbackDelayMs: 20 }));
    const response = await client.postJson("/v1/messages", { messages: [] });
    assert.equal(response.status, 200);
    assert.equal(calls, 2);
    assert.ok(Date.now() - startedAt >= 15);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("UpstreamClient reduces future traffic to one request after a 429", async () => {
  let calls = 0;
  let active = 0;
  let maxActiveAfterRecovery = 0;
  let recovered = false;
  const { server, port } = await listen(async (_request, response) => {
    calls += 1;
    active += 1;
    if (recovered) maxActiveAfterRecovery = Math.max(maxActiveAfterRecovery, active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active -= 1;

    if (calls === 1) {
      response.writeHead(429, { "retry-after": "0" });
      response.end("limited");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });

  try {
    const client = new UpstreamClient(config(port));
    assert.equal((await client.postJson("/v1/messages", {})).status, 200);
    recovered = true;
    await Promise.all([
      client.postJson("/v1/messages", { id: 1 }),
      client.postJson("/v1/messages", { id: 2 }),
    ]);
    assert.equal(maxActiveAfterRecovery, 1);
  } finally {
    server.close();
    await once(server, "close");
  }
});
