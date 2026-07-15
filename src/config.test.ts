import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
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
    const persisted = JSON.parse(readFileSync(configPath, "utf8")) as { vision: Record<string, unknown> };
    assert.equal(persisted.vision.apiKey, undefined);
    assert.equal(persisted.vision.apiKeyEnv, "CCPROXY_VISION_API_KEY");
  } finally {
    setBaseDirectory(null);
    if (previousConfig === undefined) delete process.env.CCPROXY_CONFIG;
    else process.env.CCPROXY_CONFIG = previousConfig;
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
