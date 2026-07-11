import test from "node:test";
import assert from "node:assert/strict";
import { compactRequest } from "./compactor.js";
import { ChatCompletionRequest } from "./types.js";
import { estimateRequestTokens } from "./token-estimator.js";

test("compactRequest leaves short conversations unchanged", () => {
  const request: ChatCompletionRequest = {
    messages: [
      { role: "system", content: "rules" },
      { role: "user", content: "task" },
    ],
  };

  const compacted = compactRequest(request);
  assert.deepEqual(compacted, request);
});

test("compactRequest inserts a structured memory block for long conversations", () => {
  const request: ChatCompletionRequest = {
    messages: [
      { role: "system", content: "rules" },
      { role: "user", content: "must preserve ports" },
      { role: "assistant", content: "done: created server" },
      { role: "user", content: "there is a bug in images" },
      { role: "assistant", content: "working on it" },
      { role: "user", content: "keep logs local" },
      { role: "assistant", content: "ack" },
    ],
  };

  const compacted = compactRequest(request);
  assert.ok(compacted.messages);
  assert.equal(compacted.messages?.length, 7);
  const memoryBlock = compacted.messages?.[2];
  assert.equal(memoryBlock?.role, "system");
  assert.match(String(memoryBlock?.content), /\[COMPACT MEMORY]/);
});

test("compactRequest hard-compacts short conversations with oversized content", () => {
  const request: ChatCompletionRequest = {
    messages: [
      { role: "system", content: "rules " + "s ".repeat(20_000) },
      { role: "user", content: "latest task " + "context ".repeat(120_000) },
    ],
    max_tokens: 1024,
  };

  const before = estimateRequestTokens(request, 12_000).inputTokens;
  const compacted = compactRequest(request, 60_000);
  const after = estimateRequestTokens(compacted, 12_000).inputTokens;

  assert.ok(before > 100_000);
  assert.ok(after < 30_000);
  assert.match(JSON.stringify(compacted.messages), /\[COMPACT MEMORY]/);
  assert.match(JSON.stringify(compacted.messages), /truncated by proxy compact/);
});

test("compactRequest truncates preserved head and tail messages", () => {
  const request: ChatCompletionRequest = {
    messages: Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message ${index} ` + "very large context ".repeat(30_000),
    })),
    max_tokens: 1024,
  };

  const compacted = compactRequest(request, 60_000);
  const after = estimateRequestTokens(compacted, 12_000).inputTokens;

  assert.ok(after < 30_000);
  assert.equal(compacted.messages?.length, 7);
  assert.match(JSON.stringify(compacted.messages), /\[COMPACT MEMORY]/);
  assert.match(JSON.stringify(compacted.messages), /truncated by proxy compact/);
});
