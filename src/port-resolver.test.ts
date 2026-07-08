import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdirSync } from "node:fs";
import { once } from "node:events";
import { AppConfig } from "./types.js";
import { Logger } from "./logger.js";
import { resolveFreePort } from "./port-resolver.js";

function makeLogger(): Logger {
  const directory = "./test-output/port-resolver";
  mkdirSync(directory, { recursive: true });
  const config: AppConfig["logging"] = {
    level: "error",
    directory,
  };
  return new Logger(config);
}

async function bindBlocker(port: number): Promise<net.Server> {
  const server = net.createServer();
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return server;
}

test("resolveFreePort 返回配置端口当它空闲时", async () => {
  // 用临时端口探测一个空闲口作为 preferred
  const scout = net.createServer();
  scout.listen(0, "127.0.0.1");
  await once(scout, "listening");
  const addr = scout.address();
  assert.ok(addr && typeof addr === "object");
  const freePort = addr.port;
  scout.close();
  await once(scout, "close");

  const port = await resolveFreePort("127.0.0.1", freePort, 5, makeLogger());
  assert.equal(port, freePort);
});

test("resolveFreePort 跳过被占用的端口并返回下一个可用口", async () => {
  const scout = net.createServer();
  scout.listen(0, "127.0.0.1");
  await once(scout, "listening");
  const addr = scout.address();
  assert.ok(addr && typeof addr === "object");
  const blockerPort = addr.port;
  scout.close();
  await once(scout, "close");

  // 占住 blockerPort
  const blocker = await bindBlocker(blockerPort);
  try {
    const port = await resolveFreePort("127.0.0.1", blockerPort, 10, makeLogger());
    assert.notEqual(port, blockerPort);
    assert.ok(port > blockerPort, "应递增到大于被占用端口的端口");
  } finally {
    blocker.close();
    await once(blocker, "close");
  }
});

test("resolveFreePort 超过最大尝试次数后抛出", async () => {
  // 占住一个端口,maxTries=1:只尝试这一次,被占即抛错。
  const blocker = await bindBlocker(0);
  const addr = blocker.address();
  assert.ok(addr && typeof addr === "object");
  const busyPort = addr.port;

  try {
    await assert.rejects(
      resolveFreePort("127.0.0.1", busyPort, 1, makeLogger()),
      /无法在 127.0.0.1 上找到可用端口/,
    );
  } finally {
    blocker.close();
    await once(blocker, "close");
  }
});
