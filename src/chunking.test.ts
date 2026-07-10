import test from "node:test";
import assert from "node:assert/strict";
import { buildChunkPlan, buildSynthesisRequest } from "./chunking.js";
import { estimateRequestTokens } from "./token-estimator.js";
import { ChatCompletionRequest } from "./types.js";

const CHUNK_TARGET = 90_000;
const HARD_CAP = 180_000;

/** 每块的实际 inputTokens(含 preamble + wrapper),用于断言硬上限。 */
function chunkInputTokens(chunk: ChatCompletionRequest): number {
  return estimateRequestTokens(chunk, 12_000).inputTokens;
}

test("buildChunkPlan packs small messages into a single chunk", () => {
  const request: ChatCompletionRequest = {
    messages: [
      { role: "system", content: "rules" },
      { role: "user", content: "first task" },
      { role: "assistant", content: "done" },
      { role: "user", content: "second task" },
    ],
    max_tokens: 4000,
  };

  const plan = buildChunkPlan(request, CHUNK_TARGET, HARD_CAP);
  assert.equal(plan.length, 1);
  assert.ok(chunkInputTokens(plan[0]) <= HARD_CAP);
});

test("a single oversized string message is split and every chunk stays under the hard cap", () => {
  // 真实文本重复到远超 chunkTarget,触发拆分。
  const sample = "The proxy estimates the current message size and warns the user before the request reaches the upstream hard limit. ";
  const request: ChatCompletionRequest = {
    messages: [{ role: "user", content: sample.repeat(8000) }],
    max_tokens: 4000,
  };

  const plan = buildChunkPlan(request, CHUNK_TARGET, HARD_CAP);
  assert.ok(plan.length > 1, `应被拆成多块,实际 ${plan.length}`);
  for (const chunk of plan) {
    assert.ok(
      chunkInputTokens(chunk) <= HARD_CAP,
      `块 ${chunkInputTokens(chunk)} 超过硬上限 ${HARD_CAP}`,
    );
  }
});

test("a giant line with no paragraph or sentence breaks is still split under the hard cap", () => {
  // 一整行无标点无换行:走第三级 token 硬切。输入需远超 hardCap 才会真正触发拆分。
  const sample = "The proxy estimates message size and warns before the upstream hard limit is reached ";
  const request: ChatCompletionRequest = {
    messages: [{ role: "user", content: sample.repeat(20000).replace(/\. /g, "") }],
    max_tokens: 4000,
  };

  const plan = buildChunkPlan(request, CHUNK_TARGET, HARD_CAP);
  assert.ok(plan.length > 1, `总量超 hardCap 应被拆成多块,实际 ${plan.length}`);
  for (const chunk of plan) {
    assert.ok(chunkInputTokens(chunk) <= HARD_CAP);
  }
});

test("an array-content message with multiple large text parts is split by part", () => {
  const sample = "The proxy estimates the current message size and warns the user before the request reaches the upstream hard limit. ";
  const request: ChatCompletionRequest = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: sample.repeat(4000) },
          { type: "text", text: sample.repeat(4000) },
        ],
      },
    ],
    max_tokens: 4000,
  };

  const plan = buildChunkPlan(request, CHUNK_TARGET, HARD_CAP);
  assert.ok(plan.length > 1);
  for (const chunk of plan) {
    assert.ok(chunkInputTokens(chunk) <= HARD_CAP);
  }
});

test("an image part is never split and stays as a bounded placeholder", () => {
  // 单条消息含一个 base64 图片 + 超大文本:图片占位符 ~1 token,文本被拆。
  const sample = "The proxy estimates the current message size and warns the user before the request reaches the upstream hard limit. ";
  const request: ChatCompletionRequest = {
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(100_000) } },
          { type: "text", text: sample.repeat(4000) },
        ],
      },
    ],
    max_tokens: 4000,
  };

  const plan = buildChunkPlan(request, CHUNK_TARGET, HARD_CAP);
  for (const chunk of plan) {
    assert.ok(chunkInputTokens(chunk) <= HARD_CAP);
  }
  // 图片块应原样保留(未被拆成多条)。
  const allContents = plan.flatMap((c) => c.messages ?? []);
  const hasImage = allContents.some((m) => {
    if (typeof m.content === "string") {
      return false;
    }
    return m.content.some((p) => "type" in p && p.type === "image");
  });
  assert.ok(hasImage, "图片块应保留在结果中");
});

test("the 196001 regression: an enormous message never produces a chunk over the hard cap", () => {
  // 复现 196001 场景:单块曾达 19.6 万 token 撞 20 万硬限。现在每块必须 <= hardCap。
  const sample = "The proxy estimates the current message size and warns the user before the request reaches the upstream hard limit. ";
  const request: ChatCompletionRequest = {
    messages: [{ role: "user", content: sample.repeat(12000) }],
    max_tokens: 4000,
  };

  const plan = buildChunkPlan(request, CHUNK_TARGET, HARD_CAP);
  assert.ok(plan.length > 1);
  const maxInput = Math.max(...plan.map(chunkInputTokens));
  assert.ok(maxInput <= HARD_CAP, `最大块 ${maxInput} 超过硬上限 ${HARD_CAP}`);
});

test("buildChunkPlan keeps the system preamble and caps max_tokens", () => {
  const request: ChatCompletionRequest = {
    messages: [{ role: "user", content: sample().repeat(8000) }],
    max_tokens: 99999,
  };

  const plan = buildChunkPlan(request, CHUNK_TARGET, HARD_CAP);
  assert.ok(plan.length >= 1);
  assert.equal(plan[0].messages?.[0]?.role, "system");
  assert.match(String(plan[0].messages?.[0]?.content), /Process this chunk/);
  if (plan.length > 1) {
    assert.match(String(plan[1].messages?.[0]?.content), /Continue processing/);
  }
  for (const chunk of plan) {
    assert.equal(chunk.max_tokens, 4000);
    assert.equal(chunk.stream, false);
  }
});

test("buildSynthesisRequest does not re-inject the full oversized original messages", () => {
  const hugeOriginal = sample().repeat(12_000);
  const request: ChatCompletionRequest = {
    messages: [
      { role: "system", content: "Keep the answer concise." },
      { role: "user", content: hugeOriginal },
    ],
    max_tokens: 64_000,
  };

  const synthesis = buildSynthesisRequest(request, ["chunk result"], HARD_CAP);
  const inputTokens = estimateRequestTokens(synthesis, 12_000).inputTokens;
  const userContent = String(synthesis.messages?.[1]?.content ?? "");

  assert.ok(inputTokens <= HARD_CAP, `synthesis inputTokens=${inputTokens} 超过硬上限 ${HARD_CAP}`);
  assert.equal(synthesis.max_tokens, 4000);
  assert.ok(userContent.includes("Original task preview:"));
  assert.ok(userContent.includes("[truncated]"));
  assert.ok(!userContent.includes(JSON.stringify(request.messages ?? [])), "不应完整塞回原始 messages JSON");
});

test("buildSynthesisRequest truncates excessive chunk outputs under the hard cap", () => {
  const request: ChatCompletionRequest = {
    messages: [{ role: "user", content: "Summarize all chunks." }],
    max_tokens: 4000,
  };
  const chunkOutputs = Array.from({ length: 80 }, (_, index) => `chunk ${index}: ${sample().repeat(400)}`);

  const synthesis = buildSynthesisRequest(request, chunkOutputs, HARD_CAP);
  const inputTokens = estimateRequestTokens(synthesis, 12_000).inputTokens;
  const userContent = String(synthesis.messages?.[1]?.content ?? "");

  assert.ok(inputTokens <= HARD_CAP, `synthesis inputTokens=${inputTokens} 超过硬上限 ${HARD_CAP}`);
  assert.ok(userContent.includes("[truncated]"));
});

function sample(): string {
  return "The proxy estimates the current message size and warns the user before the request reaches the upstream hard limit. ";
}
