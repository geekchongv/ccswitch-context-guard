import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { ChatCompletionRequest, VisionConfig } from "./types.js";
import { enrichRequestWithVision } from "./modality-router.js";

async function readJson(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function buildVisionConfig(port: number): VisionConfig {
  return {
    enabled: true,
    baseUrl: `http://127.0.0.1:${port}`,
    chatPath: "/v1/chat/completions",
    model: "qwen3-vl-30b-a3b-instruct",
    models: ["qwen3-vl-30b-a3b-instruct", "Qwen3.6-35B-A3B"],
    compareModels: true,
    apiKey: "test-token",
    timeoutMs: 5000,
    maxImagesPerRequest: 5,
    maxImageBytes: 5_000_000,
    summaryMaxTokens: 1500,
    stripImagesAfterSummary: true,
    systemPrompt: "describe image",
  };
}

test("enrichRequestWithVision calls both configured vision models and strips image blocks", async () => {
  const seenModels: string[] = [];
  const seenAuthHeaders: Array<string | undefined> = [];
  const upstream = http.createServer(async (request, response) => {
    const body = await readJson(request);
    const model = String(body.model);
    seenModels.push(model);
    seenAuthHeaders.push(request.headers.authorization);

    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: `${model} saw screenshot text`,
            },
          },
        ],
      }),
    );
  });

  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  assert.ok(address && typeof address === "object");

  try {
    const request: ChatCompletionRequest = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is on this screen?" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: Buffer.from("fake-image").toString("base64"),
              },
            },
          ],
        },
      ],
      max_tokens: 1024,
    };

    const result = await enrichRequestWithVision(request, buildVisionConfig(address.port));

    assert.equal(result.vision.used, true);
    assert.deepEqual(seenModels, ["qwen3-vl-30b-a3b-instruct", "Qwen3.6-35B-A3B"]);
    assert.deepEqual(seenAuthHeaders, ["Bearer test-token", "Bearer test-token"]);
    assert.match(result.vision.summary ?? "", /qwen3-vl-30b-a3b-instruct saw screenshot text/);
    assert.match(result.vision.summary ?? "", /Qwen3\.6-35B-A3B saw screenshot text/);

    const serialized = JSON.stringify(result.request.messages);
    assert.match(serialized, /VISION SUMMARY/);
    assert.doesNotMatch(serialized, /fake-image/);
  } finally {
    upstream.close();
    await once(upstream, "close");
  }
});
