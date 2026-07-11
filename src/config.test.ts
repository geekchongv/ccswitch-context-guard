import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { loadConfig } from "./config.js";
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
