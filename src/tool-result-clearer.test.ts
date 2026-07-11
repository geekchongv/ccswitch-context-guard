import test from "node:test";
import assert from "node:assert/strict";
import { ChatCompletionRequest } from "./types.js";
import { clearOldToolResults, CLEARED_TOOL_RESULT_TEXT } from "./tool-result-clearer.js";

function buildAgentRequest(resultSize = 20_000): ChatCompletionRequest {
  const messages: NonNullable<ChatCompletionRequest["messages"]> = [];
  for (let index = 0; index < 6; index += 1) {
    messages.push({
      role: "assistant",
      content: [{
        type: "tool_use",
        id: `toolu_${index}`,
        name: "Read",
        input: { file_path: `file-${index}.ts` },
      }],
    });
    messages.push({
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: `toolu_${index}`,
        content: `result-${index} ` + "source output with implementation details. ".repeat(resultSize),
      }],
    });
  }
  return { tools: [{ name: "Read" }], messages, max_tokens: 4096 };
}

function toolParts(request: ChatCompletionRequest, type: string): Array<Record<string, unknown>> {
  return (request.messages ?? []).flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.filter((part) => (part as Record<string, unknown>).type === type)
      : [],
  ) as Array<Record<string, unknown>>;
}

test("clearOldToolResults preserves protocol order and the three most recent results", () => {
  const request = buildAgentRequest();
  const originalJson = JSON.stringify(request);
  const result = clearOldToolResults(request, 1, 3);

  assert.equal(result.applied, true);
  assert.equal(result.clearedResults, 3);
  assert.ok(result.afterInputTokens < result.beforeInputTokens);
  assert.equal(JSON.stringify(request), originalJson, "the original request must not be mutated");

  const uses = toolParts(result.request, "tool_use");
  const results = toolParts(result.request, "tool_result");
  assert.equal(uses.length, 6);
  assert.equal(results.length, 6);
  assert.deepEqual(uses.map((part) => part.id), results.map((part) => part.tool_use_id));
  assert.deepEqual(
    uses.map((part) => (part.input as Record<string, unknown>).file_path),
    Array.from({ length: 6 }, (_, index) => `file-${index}.ts`),
  );
  assert.deepEqual(results.slice(0, 3).map((part) => part.content), Array(3).fill(CLEARED_TOOL_RESULT_TEXT));
  assert.ok(results.slice(-3).every((part) => String(part.content).startsWith("result-")));
});

test("clearOldToolResults is a no-op below target or without clearable history", () => {
  const request = buildAgentRequest(1);
  const belowTarget = clearOldToolResults(request, Number.MAX_SAFE_INTEGER, 3);
  assert.equal(belowTarget.applied, false);
  assert.equal(belowTarget.request, request);

  const keepAll = clearOldToolResults(request, 1, 6);
  assert.equal(keepAll.applied, false);
  assert.equal(keepAll.clearedResults, 0);
});
