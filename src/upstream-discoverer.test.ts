import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync } from "node:fs";
import { once } from "node:events";
import { AppConfig } from "./types.js";
import { Logger } from "./logger.js";
import { discoverUpstream } from "./upstream-discoverer.js";

function makeLogger(): Logger {
  const directory = "./test-output/upstream-discoverer";
  mkdirSync(directory, { recursive: true });
  const config: AppConfig["logging"] = {
    level: "error",
    directory,
  };
  return new Logger(config);
}

/** 起一个最小上游: /health 200, /v1/models 返回 {data:[]}。 */
async function startFakeUpstream(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((request, response) => {
    const route = (request.url ?? "").split("?")[0];
    if (route === "/health") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (route === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ data: [] }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "not found" }));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, port: address.port };
}

test("配置的上游可达时返回 configured", async () => {
  const { server, port } = await startFakeUpstream();
  try {
    const result = await discoverUpstream(`http://127.0.0.1:${port}`, makeLogger(), {
      probeTimeoutMs: 1000,
    });
    assert.equal(result.source, "configured");
    assert.equal(result.baseUrl, `http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("配置不可达时扫描候选端口并发现上游", async () => {
  const { server, port } = await startFakeUpstream();
  try {
    const result = await discoverUpstream("http://127.0.0.1:1", makeLogger(), {
      candidatePorts: [port],
      probeTimeoutMs: 1000,
    });
    assert.equal(result.source, "discovered");
    assert.equal(result.baseUrl, `http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("配置不可达且候选为空时沿用配置值不抛错", async () => {
  const result = await discoverUpstream("http://127.0.0.1:1", makeLogger(), {
    candidatePorts: [],
    probeTimeoutMs: 500,
  });
  assert.equal(result.source, "configured");
  assert.equal(result.baseUrl, "http://127.0.0.1:1");
});

test("/v1/models 返回非 JSON 的服务不被误识别", async () => {
  const server = http.createServer((request, response) => {
    const route = (request.url ?? "").split("?")[0];
    if (route === "/health") {
      response.writeHead(500);
      response.end("nope");
      return;
    }
    if (route === "/v1/models") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<html>not a model server</html>");
      return;
    }
    response.writeHead(404);
    response.end();
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const result = await discoverUpstream("http://127.0.0.1:1", makeLogger(), {
      candidatePorts: [address.port],
      probeTimeoutMs: 1000,
    });
    // 非法上游不被识别 -> 沿用配置值
    assert.equal(result.source, "configured");
    assert.equal(result.baseUrl, "http://127.0.0.1:1");
  } finally {
    server.close();
    await once(server, "close");
  }
});
