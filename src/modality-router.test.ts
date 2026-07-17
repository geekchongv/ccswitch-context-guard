import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { ChatCompletionRequest, VisionConfig } from "./types.js";
import { enrichRequestWithVision, getVisionInputDiagnostics, hasImageInput } from "./modality-router.js";

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

test("enrichRequestWithVision accepts Claude Desktop image source URLs", async () => {
  const seenImageUrls: string[] = [];
  const upstream = http.createServer(async (request, response) => {
    const body = await readJson(request);
    const messages = body.messages as Array<{ content?: Array<{ image_url?: { url?: string } }> }>;
    const imagePart = messages
      .flatMap((message) => message.content ?? [])
      .find((part) => part.image_url);
    if (imagePart?.image_url?.url) {
      seenImageUrls.push(imagePart.image_url.url);
    }

    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ choices: [{ message: { content: "desktop image ok" } }] }));
  });

  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  assert.ok(address && typeof address === "object");

  try {
    const config = {
      ...buildVisionConfig(address.port),
      models: ["qwen3-vl-30b-a3b-instruct"],
      compareModels: false,
    };
    const request: ChatCompletionRequest = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "read this screenshot" },
            {
              type: "image",
              source: {
                type: "url",
                url: "http://127.0.0.1:15722/claude-desktop/files/screenshot.png",
              },
            },
          ],
        },
      ],
    };

    assert.equal(hasImageInput(request), true);
    const result = await enrichRequestWithVision(request, config);

    assert.equal(result.vision.used, true);
    assert.deepEqual(seenImageUrls, ["http://127.0.0.1:15722/claude-desktop/files/screenshot.png"]);
    assert.match(JSON.stringify(result.request.messages), /VISION SUMMARY/);
  } finally {
    upstream.close();
    await once(upstream, "close");
  }
});

test("enrichRequestWithVision accepts OpenAI input_image image_url objects", async () => {
  const seenImageUrls: string[] = [];
  const upstream = http.createServer(async (request, response) => {
    const body = await readJson(request);
    const messages = body.messages as Array<{ content?: Array<{ image_url?: { url?: string } }> }>;
    const imagePart = messages
      .flatMap((message) => message.content ?? [])
      .find((part) => part.image_url);
    if (imagePart?.image_url?.url) {
      seenImageUrls.push(imagePart.image_url.url);
    }

    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ choices: [{ message: { content: "input image ok" } }] }));
  });

  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  assert.ok(address && typeof address === "object");

  try {
    const config = {
      ...buildVisionConfig(address.port),
      models: ["qwen3-vl-30b-a3b-instruct"],
      compareModels: false,
    };
    const request: ChatCompletionRequest = {
      messages: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "what changed?" },
            {
              type: "input_image",
              image_url: {
                url: "data:image/png;base64,ZmFrZS1pbWFnZQ==",
              },
            },
          ],
        },
      ],
    };

    assert.equal(hasImageInput(request), true);
    const result = await enrichRequestWithVision(request, config);

    assert.equal(result.vision.used, true);
    assert.deepEqual(seenImageUrls, ["data:image/png;base64,ZmFrZS1pbWFnZQ=="]);
  } finally {
    upstream.close();
    await once(upstream, "close");
  }
});

test("getVisionInputDiagnostics reports unsupported image-like parts without leaking payloads", () => {
  const request: ChatCompletionRequest = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "diagnose upload" },
          {
            type: "image",
            source: {
              type: "file",
              file_id: "file-secret-id",
            },
          } as unknown as Record<string, string>,
        ],
      },
    ],
  };

  const diagnostics = getVisionInputDiagnostics(request);

  assert.equal(hasImageInput(request), false);
  assert.equal(diagnostics.supportedImageCount, 0);
  assert.equal(diagnostics.imageLikePartCount, 1);
  assert.deepEqual(diagnostics.imageLikePartTypes, ["image"]);
  assert.deepEqual(diagnostics.imageLikePartKeys, ["source", "type"]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /file-secret-id/);
});

test("enrichRequestWithVision handles top-level Desktop attachments and strips them for text downstreams", async () => {
  const seenImageUrls: string[] = [];
  const upstream = http.createServer(async (request, response) => {
    const body = await readJson(request);
    const messages = body.messages as Array<{ content?: Array<{ image_url?: { url?: string } }> }>;
    const imagePart = messages
      .flatMap((message) => message.content ?? [])
      .find((part) => part.image_url);
    if (imagePart?.image_url?.url) {
      seenImageUrls.push(imagePart.image_url.url);
    }

    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ choices: [{ message: { content: "attachment image ok" } }] }));
  });

  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  assert.ok(address && typeof address === "object");

  try {
    const config = {
      ...buildVisionConfig(address.port),
      models: ["qwen3-vl-30b-a3b-instruct"],
      compareModels: false,
    };
    const request: ChatCompletionRequest = {
      messages: [
        {
          role: "user",
          content: "请看附件图并回答。",
        },
      ],
      tools: [{ name: "Read" }],
      attachments: [
        {
          type: "image",
          source: {
            type: "url",
            url: "http://127.0.0.1:15722/claude-desktop/attachment/screenshot.png",
          },
        },
      ],
    };

    assert.equal(hasImageInput(request), true);
    const diagnostics = getVisionInputDiagnostics(request);
    assert.equal(diagnostics.supportedImageCount, 1);
    assert.equal(diagnostics.imageLikePartCount, 1);

    const result = await enrichRequestWithVision(request, config);

    assert.equal(result.vision.used, true);
    assert.deepEqual(seenImageUrls, ["http://127.0.0.1:15722/claude-desktop/attachment/screenshot.png"]);
    assert.match(JSON.stringify(result.request.messages), /VISION SUMMARY/);
    assert.doesNotMatch(JSON.stringify(result.request), /attachments/);
    assert.match(JSON.stringify(result.request), /"tools"/);
  } finally {
    upstream.close();
    await once(upstream, "close");
  }
});
