import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const sentinel = "CCPROXY_TEST_SECRET_SENTINEL_92f614";

function runValidator(releaseDirectory: string) {
  return spawnSync(process.execPath, [
    path.resolve("scripts", "validate-package-secrets.mjs"),
    "--release-dir",
    releaseDirectory,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, CCPROXY_SECRET_SENTINEL: sentinel },
  });
}

test("package secret validator accepts a clean release", () => {
  const relativeRoot = path.join("test-output", "package-security-clean");
  const root = path.resolve(relativeRoot);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "config.example.json"), "{}\n", "utf8");
  writeFileSync(path.join(root, "app.asar"), "clean package", "utf8");

  const result = runValidator(relativeRoot);
  assert.equal(result.status, 0, result.stderr);
});

test("package secret validator rejects private config and secret bytes", () => {
  const relativeRoot = path.join("test-output", "package-security-leak");
  const root = path.resolve(relativeRoot);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "config.json"), "{}\n", "utf8");
  writeFileSync(path.join(root, "app.asar"), sentinel, "utf8");

  const result = runValidator(relativeRoot);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /private config\.json/);
});
