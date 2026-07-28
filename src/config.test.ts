import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { loadConfig, saveConfig } from "./config.js";
import { setBaseDirectory } from "./paths.js";

test("loadConfig creates a secret-free config.json on first startup", () => {
  const root = path.resolve("test-output", "first-run-config");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const previousConfig = process.env.CCPROXY_CONFIG;
  delete process.env.CCPROXY_CONFIG;
  setBaseDirectory(root);

  try {
    const config = loadConfig();
    const configPath = path.join(root, "config.json");
    assert.equal(existsSync(configPath), true);
    assert.equal(config.vision.apiKey, undefined);
    assert.equal(config.tokenPolicy.hardLimit, 200_000);
    assert.equal(config.tokenPolicy.compactThreshold, 160_000);
    assert.equal(config.tokenPolicy.toolResultClearTrigger, 140_000);
    const persisted = JSON.parse(readFileSync(configPath, "utf8")) as { vision: Record<string, unknown> };
    assert.equal(persisted.vision.apiKey, undefined);
    assert.equal(persisted.vision.apiKeyEnv, "CCPROXY_VISION_API_KEY");
  } finally {
    setBaseDirectory(null);
    if (previousConfig === undefined) delete process.env.CCPROXY_CONFIG;
    else process.env.CCPROXY_CONFIG = previousConfig;
  }
});

test("loadConfig migrates the legacy 130k context policy without touching unrelated settings", () => {
  const root = path.resolve("test-output", "legacy-context-policy");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "config.json"), JSON.stringify({
    server: { port: 16666 },
    tokenPolicy: {
      hardLimit: 130_000,
      compactThreshold: 90_000,
      compactMode: "warn",
      toolResultClearTrigger: 80_000,
      toolResultClearTarget: 65_000,
    },
  }), "utf8");
  setBaseDirectory(root);

  try {
    const config = loadConfig();
    assert.equal(config.server.port, 16666);
    assert.equal(config.tokenPolicy.hardLimit, 200_000);
    assert.equal(config.tokenPolicy.compactThreshold, 160_000);
    assert.equal(config.tokenPolicy.compactMode, "proxy");
    assert.equal(config.tokenPolicy.toolResultClearTrigger, 140_000);
    assert.equal(config.tokenPolicy.toolResultClearTarget, 100_000);
    const persisted = JSON.parse(readFileSync(path.join(root, "config.json"), "utf8"));
    assert.equal(persisted.tokenPolicy.hardLimit, 200_000);
  } finally {
    setBaseDirectory(null);
  }
});

test("saveConfig never persists a vision API key or renderer-only status", () => {
  const root = path.resolve("test-output", "saved-config-redaction");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  setBaseDirectory(root);
  try {
    const config = loadConfig();
    config.vision.apiKey = "must-not-be-written";
    (config.vision as typeof config.vision & { apiKeyConfigured?: boolean }).apiKeyConfigured = true;
    saveConfig(config);
    const raw = readFileSync(path.join(root, "config.json"), "utf8");
    const persisted = JSON.parse(raw) as { vision: Record<string, unknown> };
    assert.doesNotMatch(raw, /must-not-be-written/);
    assert.equal(persisted.vision.apiKey, undefined);
    assert.equal(persisted.vision.apiKeyConfigured, undefined);
  } finally {
    setBaseDirectory(null);
  }
});
