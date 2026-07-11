import test from "node:test";
import assert from "node:assert/strict";
import { appendCompactWarning } from "./response-warning.js";

test("appendCompactWarning rewrites JSON without stale entity headers", async () => {
  const body = '{\n  "content": [{ "type": "text", "text": "done" }]\n}';
  const result = await appendCompactWarning(new Response(body, {
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
      "content-encoding": "gzip",
    },
  }), "run /compact");

  assert.equal(result.appended, true);
  assert.equal(result.response.headers.get("content-length"), null);
  assert.equal(result.response.headers.get("content-encoding"), null);
  assert.match(await result.response.text(), /run \/compact/);
});

test("appendCompactWarning injects an Anthropic SSE content block", async () => {
  const body = [
    "event: content_block_start",
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    "",
    "event: content_block_delta",
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"done"}}',
    "",
    "event: content_block_stop",
    'data: {"type":"content_block_stop","index":0}',
    "",
    "event: message_delta",
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
    "",
    "event: message_stop",
    'data: {"type":"message_stop"}',
    "",
  ].join("\n");
  const result = await appendCompactWarning(new Response(body, {
    headers: { "content-type": "text/event-stream", "content-length": String(body.length) },
  }), "run /compact");

  assert.equal(result.appended, true);
  assert.equal(result.response.headers.get("content-length"), null);
  const replay = await result.response.text();
  assert.match(replay, /run \/compact/);
  assert.match(replay, /"index":1/);
  assert.ok(replay.indexOf("run /compact") < replay.indexOf("event: message_delta"));
});

test("appendCompactWarning injects an OpenAI SSE delta before completion", async () => {
  const body = [
    'data: {"choices":[{"index":0,"delta":{"content":"done"},"finish_reason":null}]}',
    "",
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const result = await appendCompactWarning(new Response(body, {
    headers: { "content-type": "text/event-stream" },
  }), "run /compact");

  assert.equal(result.appended, true);
  const replay = await result.response.text();
  assert.ok(replay.indexOf("run /compact") < replay.indexOf('"finish_reason":"stop"'));
});
