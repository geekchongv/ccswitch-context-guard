import test from "node:test";
import assert from "node:assert/strict";
import { countTextTokens, countMessageTokens } from "./token-counter.js";
import { ChatMessage } from "./types.js";

test("countTextTokens returns 0 for empty or whitespace-only text", () => {
  assert.equal(countTextTokens(""), 0);
  assert.equal(countTextTokens("   "), countMessageTokens({ role: "user", content: "   " }));
});

test("countMessageTokens counts string content directly", () => {
  const message: ChatMessage = { role: "user", content: "hello world" };
  assert.equal(countMessageTokens(message), countTextTokens("hello world"));
  assert.ok(countMessageTokens(message) > 0);
});

test("countMessageTokens sums array text parts", () => {
  const message: ChatMessage = {
    role: "user",
    content: [
      { type: "text", text: "hello " },
      { type: "text", text: "world" },
    ],
  };
  assert.equal(
    countMessageTokens(message),
    countTextTokens("hello ") + countTextTokens("world"),
  );
});

test("an image part is NOT inflated by its base64 payload", () => {
  // 100k 字符的 base64:旧实现经 JSON.stringify 会算成约 33000 token;这里应只是占位符量级。
  const hugeBase64 = "A".repeat(100_000);
  const message: ChatMessage = {
    role: "user",
    content: [
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: hugeBase64 },
      },
    ],
  };

  const tokens = countMessageTokens(message);
  assert.ok(tokens <= 5, `图片占位符应只占 ~1 token,实际 ${tokens}(base64 膨胀了)`);
  assert.ok(tokens < 1000, "base64 绝不应被当成 token 计数");
});

test("image_url and input_image parts are also treated as bounded placeholders", () => {
  const urlMessage: ChatMessage = {
    role: "user",
    content: [{ type: "image_url", image_url: { url: "https://example.com/" + "x".repeat(50_000) + ".png" } }],
  };
  const inputImageMessage: ChatMessage = {
    role: "user",
    content: [{ type: "input_image", url: "https://example.com/" + "y".repeat(50_000) + ".png" }],
  };

  assert.ok(countMessageTokens(urlMessage) <= 5);
  assert.ok(countMessageTokens(inputImageMessage) <= 5);
});

test("CJK text is counted materially higher than the old length/3 heuristic", () => {
  // 旧 length/3 启发式对中文严重低估:24 字 → 8 token。tokenx 实测约 16。这里守住"不能退化回 length/N"。
  const text = "你好世界,这是一段中文测试文本。";
  const tokens = countTextTokens(text);
  const oldHeuristic = Math.ceil(text.length / 3);

  assert.ok(tokens > oldHeuristic, `中文计数 ${tokens} 应高于旧 length/3 估值 ${oldHeuristic}`);
});

test("unknown part text is fully counted so tool-like payloads cannot hide context", () => {
  const message: ChatMessage = {
    role: "user",
    content: [
      { type: "custom", payload: "Z".repeat(500_000) } as never,
    ],
  };

  const tokens = countMessageTokens(message);
  assert.ok(tokens > 10_000, `large unknown text must be materially counted, got ${tokens}`);
});
