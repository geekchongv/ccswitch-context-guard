import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, existsSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import path from "node:path";
import { setBaseDirectory } from "./paths.js";
import { Logger } from "./logger.js";
import { LoggingConfig } from "./types.js";

const ROTATION_BYTES = 5 * 1024 * 1024;
const testBaseDir = path.resolve("./test-output/logger-base");

function buildLoggingConfig(): LoggingConfig {
  return { level: "info", directory: "logs" };
}

function logFilePath(): string {
  return path.join(testBaseDir, "logs", "ccproxy-agent.log");
}

function archiveFilePath(): string {
  return `${logFilePath()}.1`;
}

function resetLoggerDir(): void {
  rmSync(testBaseDir, { recursive: true, force: true });
  mkdirSync(path.join(testBaseDir, "logs"), { recursive: true });
  setBaseDirectory(testBaseDir);
}

test("logger rotates the active file into a .1 archive once it exceeds the size cap", () => {
  resetLoggerDir();

  // 预置一个已经逼近上限的日志文件，下一次写入会先把它归档再写新行。
  writeFileSync(logFilePath(), "x".repeat(ROTATION_BYTES), "utf8");

  const logger = new Logger(buildLoggingConfig());
  logger.info("the line that tips it over", { marker: "rotation-trigger" });

  assert.ok(existsSync(archiveFilePath()), "归档文件 .1 应在轮转后存在");
  const archived = readFileSync(archiveFilePath(), "utf8");
  assert.ok(archived.startsWith("x".repeat(100)), "归档内容应来自原文件前缀");
  assert.ok(!archived.includes("rotation-trigger"), "触发轮转的那一行应写入轮转后的新文件,而非归档");

  const active = readFileSync(logFilePath(), "utf8");
  assert.ok(active.length < archived.length, "轮转后活动文件应比归档小");
  assert.ok(active.includes("rotation-trigger"), "触发行应写入轮转后的活动文件");
});

test("logger keeps rotating across multiple cap crossings", () => {
  resetLoggerDir();

  const logger = new Logger(buildLoggingConfig());

  // 写入顺序为「先检查再追加」,所以归档在「下一次写入」时发生:
  //   burst-a 写入 -> 活动文件变大(此时尚未归档)
  //   burst-b 写入 -> 检查到活动文件超阈值 -> 归档(burst-a) -> 写 burst-b
  //   burst-c 写入 -> 再次归档(burst-b) -> 写 burst-c
  logger.info("burst-a", { blob: "a".repeat(ROTATION_BYTES + 1024) });
  assert.ok(!existsSync(archiveFilePath()), "首次写入不应立即归档,归档发生在下一次写入时");

  logger.info("burst-b", { blob: "b".repeat(ROTATION_BYTES + 1024) });
  assert.ok(existsSync(archiveFilePath()), "第二次写入应触发对上一轮内容的归档");
  let archived = readFileSync(archiveFilePath(), "utf8");
  assert.ok(archived.includes("burst-a"), "归档应包含上一轮活动文件的内容(burst-a)");

  logger.info("burst-c", { blob: "c".repeat(ROTATION_BYTES + 1024) });
  archived = readFileSync(archiveFilePath(), "utf8");
  assert.ok(archived.includes("burst-b"), "再次写入后归档应更新为包含 burst-b");
  assert.ok(!archived.includes("burst-a"), "归档只保留最近一份,burst-a 应已被覆盖");

  const active = readFileSync(logFilePath(), "utf8");
  assert.ok(active.includes("burst-c"), "最新写入应落在活动文件中");
});
