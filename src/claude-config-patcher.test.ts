import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { AppConfig } from "./types.js";
import { Logger } from "./logger.js";
import { ClaudeConfigPatcher } from "./claude-config-patcher.js";

function buildConfig(configLibraryPath: string, runtimeDirectory: string): AppConfig {
  return {
    server: {
      host: "127.0.0.1",
      port: 15722,
    },
    upstream: {
      baseUrl: "http://127.0.0.1:15721",
      chatPath: "/v1/chat/completions",
      timeoutMs: 5000,
      aiRoutes: ["/v1/chat/completions", "/v1/messages"],
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
      directory: runtimeDirectory,
    },
    claudeConfigPatch: {
      enabled: false,
    },
    claudeDesktopConfigPatch: {
      enabled: true,
      configLibraryPath,
    },
  };
}

test("ClaudeConfigPatcher patches and restores Claude Desktop 3P gateway config", () => {
  const root = path.resolve("test-output", "desktop-patcher");
  const configLibraryPath = path.join(root, "configLibrary");
  const runtimeDirectory = "./test-output/desktop-patcher/runtime";
  const appliedId = "00000000-0000-4000-8000-000000157210";
  const configPath = path.join(configLibraryPath, `${appliedId}.json`);

  rmSync(root, { recursive: true, force: true });
  mkdirSync(configLibraryPath, { recursive: true });
  mkdirSync(path.resolve("test-output", "logs"), { recursive: true });
  mkdirSync(path.resolve(runtimeDirectory, "sessions"), { recursive: true });

  writeFileSync(
    path.join(configLibraryPath, "_meta.json"),
    `${JSON.stringify({
      appliedId,
      entries: [{ id: appliedId, name: "CC Switch" }],
    }, null, 2)}\n`,
    "utf8",
  );

  writeFileSync(
    configPath,
    `${JSON.stringify({
      inferenceProvider: "gateway",
      inferenceGatewayBaseUrl: "http://127.0.0.1:15721/claude-desktop",
      inferenceGatewayApiKey: "secret",
      inferenceGatewayAuthScheme: "bearer",
      inferenceModels: [{ name: "claude-sonnet-4-6", supports1m: true }],
    }, null, 2)}\n`,
    "utf8",
  );

  const config = buildConfig(configLibraryPath, runtimeDirectory);
  const patcher = new ClaudeConfigPatcher(config, new Logger(config.logging));

  patcher.apply();
  const patched = JSON.parse(readFileSync(configPath, "utf8")) as { inferenceGatewayBaseUrl: string };
  assert.equal(patched.inferenceGatewayBaseUrl, "http://127.0.0.1:15722/claude-desktop");

  patcher.restore();
  const restored = JSON.parse(readFileSync(configPath, "utf8")) as { inferenceGatewayBaseUrl: string };
  assert.equal(restored.inferenceGatewayBaseUrl, "http://127.0.0.1:15721/claude-desktop");
});
