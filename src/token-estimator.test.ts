import test from "node:test";
import assert from "node:assert/strict";
import { assessBudget } from "./token-estimator.js";
import { ChatCompletionRequest } from "./types.js";

test("assessBudget returns safe for small requests", () => {
  const request: ChatCompletionRequest = {
    messages: [{ role: "user", content: "hello" }],
  };

  const result = assessBudget(request, 180000, 200000, 12000, 8000);
  assert.equal(result.decision, "safe");
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
