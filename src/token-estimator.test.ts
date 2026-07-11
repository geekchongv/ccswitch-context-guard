import test from "node:test";
import assert from "node:assert/strict";
import { assessBudget, estimateRequestTokens } from "./token-estimator.js";
import { ChatCompletionRequest } from "./types.js";

test("assessBudget returns safe for small requests", () => {
  const request: ChatCompletionRequest = {
    messages: [{ role: "user", content: "hello" }],
  };

  const result = assessBudget(request, 180000, 200000, 12000, 8000);
  assert.equal(result.decision, "safe");
});

test("estimateRequestTokens includes top-level system, tools, and nested tool results", () => {
  const largeText = "context payload with file output and source details. ".repeat(10_000);
  const request: ChatCompletionRequest = {
    system: [{ type: "text", text: largeText }],
    tools: [{ name: "Read", description: largeText, input_schema: { type: "object" } }],
    messages: [{
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: largeText }],
    }],
    max_tokens: 1024,
  };

  const estimate = estimateRequestTokens(request, 12000);
  assert.ok(estimate.inputTokens > 100_000, `prompt-bearing fields were undercounted: ${estimate.inputTokens}`);
});

test("top-level image base64 remains bounded during structured counting", () => {
  const request: ChatCompletionRequest = {
    system: [{
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "A".repeat(500_000) },
    }],
    messages: [{ role: "user", content: "inspect image" }],
  };

  assert.ok(estimateRequestTokens(request, 1000).inputTokens < 1000);
});

test("assessBudget returns chunk_required when above hard limit", () => {
  const request: ChatCompletionRequest = {
    messages: [{ role: "user", content: "x".repeat(900000) }],
  };

  const result = assessBudget(request, 1000, 2000, 100, 200);
  assert.equal(result.decision, "chunk_required");
});

test("assessBudget returns chunk_required near the hard limit because of safety margin", () => {
  // 计数口径切换到 tokenx 后,纯重复字符(如 "x".repeat)会被严重低估,无法稳定逼近上限。
  // 这里用一段真实英文样本重复到 input≈128k token,加 64k 输出 + wrapper 后 total≈192k,
  // 刚好越过 effectiveHardLimit(200k - 8k safety = 192k),验证 safety margin 的作用。
  const sample = "The proxy estimates the current message size and warns the user before the request reaches the upstream hard limit. ";
  const request: ChatCompletionRequest = {
    messages: [{ role: "user", content: sample.repeat(4924) }],
    max_tokens: 64000,
  };

  const result = assessBudget(request, 180000, 200000, 12000, 8000);
  assert.equal(result.decision, "chunk_required");
});
