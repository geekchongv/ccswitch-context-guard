import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { HookObserver } from "./hook-observer.js";
import { Logger } from "./logger.js";

test("HookObserver records only aggregate tool telemetry", () => {
  mkdirSync("test-output/logs", { recursive: true });
  const logger = new Logger({ level: "info", directory: "./test-output/logs" });
  const observer = new HookObserver(logger);

  observer.observe({ session_id: "session-123", hook_event_name: "UserPromptSubmit" });
  observer.observe({
    session_id: "session-123",
    hook_event_name: "PostToolBatch",
    tool_calls: [{
      tool_name: "Read",
      tool_input: { file_path: "secret.ts" },
      tool_response: "output truncated because it was too large",
    }],
  });
  observer.observe({
    session_id: "session-123",
    hook_event_name: "PostToolBatch",
    tool_calls: [{
      tool_name: "Read",
      tool_input: { file_path: "secret.ts" },
      tool_response: "output truncated because it was too large",
    }],
  });

  const entry = logger.snapshot().filter((item) => item.message === "Claude tool batch observed").at(-1);
  assert.ok(entry);
  assert.deepEqual(entry.metadata, {
    sessionId: "session-",
    toolCount: 1,
    turnCalls: 2,
    repeatedCalls: 1,
    truncatedResults: 1,
    outputChars: 41,
    mode: "observe",
  });
  assert.equal(JSON.stringify(entry).includes("secret.ts"), false);
});

test("HookObserver emits session metadata with a prompt hash instead of prompt content", () => {
  mkdirSync("test-output/logs", { recursive: true });
  const events: unknown[] = [];
  const observer = new HookObserver(
    new Logger({ level: "error", directory: "./test-output/logs" }),
    (event) => events.push(event),
  );
  observer.observe({
    session_id: "session-private",
    hook_event_name: "UserPromptSubmit",
    cwd: "C:\\work\\project",
    prompt: "private prompt body",
  });
  assert.equal(events.length, 1);
  assert.equal(JSON.stringify(events).includes("private prompt body"), false);
  assert.match(JSON.stringify(events), /promptFingerprint/);
});
