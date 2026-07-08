import test from "node:test";
import assert from "node:assert/strict";
import { compactRequest } from "./compactor.js";
import { ChatCompletionRequest } from "./types.js";

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
