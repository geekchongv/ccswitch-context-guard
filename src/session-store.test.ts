import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { SessionStore } from "./session-store.js";
import { setBaseDirectory } from "./paths.js";

test("SessionStore prunes per-request diagnostics to the configured maximum", () => {
  const root = path.resolve("test-output", "session-store-retention");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(path.join(root, "runtime", "sessions"), { recursive: true });
  setBaseDirectory(root);
  try {
    const store = new SessionStore("runtime", 10, 7);
    for (let index = 0; index < 14; index += 1) {
      store.save(`request-${index}`, { requestId: `request-${index}` });
    }
    store.prune();
    assert.equal(readdirSync(path.join(root, "runtime", "sessions")).length, 10);
  } finally {
    setBaseDirectory(null);
  }
});
