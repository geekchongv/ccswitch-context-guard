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
  const request: ChatCompletionRequest = {
    messages: [{ role: "user", content: "x".repeat(408000) }],
    max_tokens: 64000,
  };

  const result = assessBudget(request, 180000, 200000, 12000, 8000);
  assert.equal(result.decision, "chunk_required");
});
