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
      directory: runtimeDirectory,
    },
    ui: {
      enabled: false,
      openOnStart: false,
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

test("ClaudeConfigPatcher adds native auto-compact and observer hooks without replacing user hooks", () => {
  const root = path.resolve("test-output", "cli-patcher");
  const settingsPath = path.join(root, "settings.json");
  const runtimeDirectory = "./test-output/cli-patcher/runtime";
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  mkdirSync(path.resolve(runtimeDirectory, "sessions"), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify({
    env: { USER_VALUE: "keep" },
    hooks: { Notification: [{ hooks: [{ type: "command", command: "notify" }] }] },
  }, null, 2)}\n`, "utf8");

  const config = buildConfig("", runtimeDirectory);
  config.claudeConfigPatch = {
    enabled: true,
    settingsPath,
    autoCompactEnabled: true,
    autoCompactReserveTokens: 30_000,
    hookObserverEnabled: true,
  };
  config.claudeDesktopConfigPatch.enabled = false;
  const patcher = new ClaudeConfigPatcher(config, new Logger(config.logging), { token: "hook-secret" });

  patcher.apply();
  const patched = JSON.parse(readFileSync(settingsPath, "utf8")) as {
    env: Record<string, string>;
    hooks: Record<string, unknown[]>;
  };
  assert.equal(patched.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:15722");
  assert.equal(patched.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "200000");
  assert.equal(patched.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, "85");
  assert.equal(patched.env.USER_VALUE, "keep");
  assert.equal(patched.hooks.Notification.length, 1);
  assert.equal(patched.hooks.PostToolBatch.length, 1);

  patcher.restore();
  const restored = JSON.parse(readFileSync(settingsPath, "utf8")) as {
    env: Record<string, string>;
    hooks: Record<string, unknown[]>;
  };
  assert.deepEqual(restored.env, { USER_VALUE: "keep" });
  assert.deepEqual(Object.keys(restored.hooks), ["Notification"]);
});

test("ClaudeConfigPatcher re-patches Desktop gateway when ccswitch rewrites it (drift watch)", () => {
  const root = path.resolve("test-output", "desktop-patcher-drift");
  const configLibraryPath = path.join(root, "configLibrary");
  const runtimeDirectory = "./test-output/desktop-patcher-drift/runtime";
  const appliedId = "00000000-0000-4000-8000-000000157211";
  const configPath = path.join(configLibraryPath, `${appliedId}.json`);

  rmSync(root, { recursive: true, force: true });
  mkdirSync(configLibraryPath, { recursive: true });
  mkdirSync(path.resolve("test-output", "logs"), { recursive: true });
  mkdirSync(path.resolve(runtimeDirectory, "sessions"), { recursive: true });

  writeFileSync(
    path.join(configLibraryPath, "_meta.json"),
    `${JSON.stringify({ appliedId, entries: [{ id: appliedId, name: "CC Switch" }] }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    configPath,
    `${JSON.stringify({
      inferenceProvider: "gateway",
      inferenceGatewayBaseUrl: "http://127.0.0.1:15721/claude-desktop",
      inferenceGatewayApiKey: "secret",
      inferenceGatewayAuthScheme: "bearer",
    }, null, 2)}\n`,
    "utf8",
  );

  const config = buildConfig(configLibraryPath, runtimeDirectory);
  const patcher = new ClaudeConfigPatcher(config, new Logger(config.logging));

  patcher.apply();
  patcher.startDesktopGatewayWatch();

  const afterApply = JSON.parse(readFileSync(configPath, "utf8")) as { inferenceGatewayBaseUrl: string };
  assert.equal(afterApply.inferenceGatewayBaseUrl, "http://127.0.0.1:15722/claude-desktop");

  // Simulate ccswitch rewriting the gateway config back to its own port.
  writeFileSync(
    configPath,
    `${JSON.stringify({
      inferenceProvider: "gateway",
      inferenceGatewayBaseUrl: "http://127.0.0.1:15721/claude-desktop",
      inferenceGatewayApiKey: "secret",
      inferenceGatewayAuthScheme: "bearer",
    }, null, 2)}\n`,
    "utf8",
  );

  patcher.checkDesktopGatewayDrift();
  const afterDrift = JSON.parse(readFileSync(configPath, "utf8")) as { inferenceGatewayBaseUrl: string };
  assert.equal(afterDrift.inferenceGatewayBaseUrl, "http://127.0.0.1:15722/claude-desktop");

  // Second tick with no further drift should be a no-op.
  patcher.checkDesktopGatewayDrift();
  const afterSecondTick = JSON.parse(readFileSync(configPath, "utf8")) as { inferenceGatewayBaseUrl: string };
  assert.equal(afterSecondTick.inferenceGatewayBaseUrl, "http://127.0.0.1:15722/claude-desktop");

  patcher.stopDesktopGatewayWatch();
  patcher.restore();
});

test("ClaudeConfigPatcher re-patches when ccswitch switches the active Desktop config file (appliedId change)", () => {
  const root = path.resolve("test-output", "desktop-patcher-appliedid");
  const configLibraryPath = path.join(root, "configLibrary");
  const runtimeDirectory = "./test-output/desktop-patcher-appliedid/runtime";
  const firstId = "00000000-0000-4000-8000-000000157212";
  const secondId = "00000000-0000-4000-8000-000000157213";
  const firstConfigPath = path.join(configLibraryPath, `${firstId}.json`);
  const secondConfigPath = path.join(configLibraryPath, `${secondId}.json`);
  const metaPath = path.join(configLibraryPath, "_meta.json");

  rmSync(root, { recursive: true, force: true });
  mkdirSync(configLibraryPath, { recursive: true });
  mkdirSync(path.resolve("test-output", "logs"), { recursive: true });
  mkdirSync(path.resolve(runtimeDirectory, "sessions"), { recursive: true });

  writeFileSync(
    metaPath,
    `${JSON.stringify({ appliedId: firstId, entries: [{ id: firstId, name: "Route A" }] }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    firstConfigPath,
    `${JSON.stringify({
      inferenceProvider: "gateway",
      inferenceGatewayBaseUrl: "http://127.0.0.1:15721/claude-desktop",
      inferenceGatewayApiKey: "secret",
      inferenceGatewayAuthScheme: "bearer",
    }, null, 2)}\n`,
    "utf8",
  );

  const config = buildConfig(configLibraryPath, runtimeDirectory);
  const patcher = new ClaudeConfigPatcher(config, new Logger(config.logging));

  patcher.apply();
  patcher.startDesktopGatewayWatch();

  const afterApply = JSON.parse(readFileSync(firstConfigPath, "utf8")) as { inferenceGatewayBaseUrl: string };
  assert.equal(afterApply.inferenceGatewayBaseUrl, "http://127.0.0.1:15722/claude-desktop");

  // Simulate ccswitch switching routes: _meta.appliedId flips, a new config file is active and points at ccswitch's port.
  writeFileSync(
    metaPath,
    `${JSON.stringify({ appliedId: secondId, entries: [{ id: secondId, name: "Route B" }] }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    secondConfigPath,
    `${JSON.stringify({
      inferenceProvider: "gateway",
      inferenceGatewayBaseUrl: "http://127.0.0.1:15721/claude-desktop",
      inferenceGatewayApiKey: "secret",
      inferenceGatewayAuthScheme: "bearer",
    }, null, 2)}\n`,
    "utf8",
  );

  patcher.checkDesktopGatewayDrift();
  const afterSwitch = JSON.parse(readFileSync(secondConfigPath, "utf8")) as { inferenceGatewayBaseUrl: string };
  assert.equal(afterSwitch.inferenceGatewayBaseUrl, "http://127.0.0.1:15722/claude-desktop");

  // The OLD config file (firstId) must have been restored to its pre-proxy URL, not left stranded.
  const afterSwitchOld = JSON.parse(readFileSync(firstConfigPath, "utf8")) as { inferenceGatewayBaseUrl: string };
  assert.equal(afterSwitchOld.inferenceGatewayBaseUrl, "http://127.0.0.1:15721/claude-desktop");

  patcher.stopDesktopGatewayWatch();
  patcher.restore();
  const restoredSecond = JSON.parse(readFileSync(secondConfigPath, "utf8")) as { inferenceGatewayBaseUrl: string };
  assert.equal(restoredSecond.inferenceGatewayBaseUrl, "http://127.0.0.1:15721/claude-desktop");
});

test("ClaudeConfigPatcher drift watch survives a partial/corrupt config file mid-tick without throwing", () => {
  const root = path.resolve("test-output", "desktop-patcher-corrupt");
  const configLibraryPath = path.join(root, "configLibrary");
  const runtimeDirectory = "./test-output/desktop-patcher-corrupt/runtime";
  const appliedId = "00000000-0000-4000-8000-000000157214";
  const configPath = path.join(configLibraryPath, `${appliedId}.json`);

  rmSync(root, { recursive: true, force: true });
  mkdirSync(configLibraryPath, { recursive: true });
  mkdirSync(path.resolve("test-output", "logs"), { recursive: true });
  mkdirSync(path.resolve(runtimeDirectory, "sessions"), { recursive: true });

  writeFileSync(
    path.join(configLibraryPath, "_meta.json"),
    `${JSON.stringify({ appliedId, entries: [{ id: appliedId, name: "CC Switch" }] }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    configPath,
    `${JSON.stringify({
      inferenceProvider: "gateway",
      inferenceGatewayBaseUrl: "http://127.0.0.1:15721/claude-desktop",
      inferenceGatewayApiKey: "secret",
      inferenceGatewayAuthScheme: "bearer",
    }, null, 2)}\n`,
    "utf8",
  );

  const config = buildConfig(configLibraryPath, runtimeDirectory);
  const patcher = new ClaudeConfigPatcher(config, new Logger(config.logging));

  patcher.apply();
  patcher.startDesktopGatewayWatch();

  // Simulate ccswitch mid-write: the config file is momentarily truncated/corrupt.
  writeFileSync(configPath, "{ broken json", "utf8");

  // Must not throw — the watcher swallows the parse failure and keeps running.
  assert.doesNotThrow(() => patcher.checkDesktopGatewayDrift());

  // After ccswitch "finishes" writing a valid drifted config, the next tick re-patches.
  writeFileSync(
    configPath,
    `${JSON.stringify({
      inferenceProvider: "gateway",
      inferenceGatewayBaseUrl: "http://127.0.0.1:15721/claude-desktop",
      inferenceGatewayApiKey: "secret",
      inferenceGatewayAuthScheme: "bearer",
    }, null, 2)}\n`,
    "utf8",
  );
  patcher.checkDesktopGatewayDrift();
  const afterRecover = JSON.parse(readFileSync(configPath, "utf8")) as { inferenceGatewayBaseUrl: string };
  assert.equal(afterRecover.inferenceGatewayBaseUrl, "http://127.0.0.1:15722/claude-desktop");

  patcher.stopDesktopGatewayWatch();
  patcher.restore();
});
