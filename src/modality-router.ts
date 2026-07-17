import {
  ChatCompletionRequest,
  ChatMessage,
  ChatMessagePart,
  ChatMessagePartImage,
  ChatMessagePartText,
  JsonValue,
  VisionAnalysisResult,
  VisionConfig,
} from "./types.js";

interface ExtractedImage {
  url: string;
  mediaType?: string;
  bytes?: number;
}

interface ImageExtraction {
  images: ExtractedImage[];
  textHints: string[];
}

export interface VisionInputDiagnostics {
  supportedImageCount: number;
  imageLikePartCount: number;
  imageLikePartTypes: string[];
  imageLikePartKeys: string[];
}

type OpenAiVisionContentPart =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image_url";
      image_url: {
        url: string;
      };
    };

function estimateBase64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function urlFromImageUrlValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (isRecord(value)) {
    return stringValue(value.url);
  }

  return undefined;
}

function mediaTypeFromRecord(record: Record<string, unknown>): string | undefined {
  return (
    stringValue(record.media_type) ??
    stringValue(record.mediaType) ??
    stringValue(record.mime_type) ??
    stringValue(record.mimeType) ??
    stringValue(record.type)
  );
}

function isImageMediaType(value: string | undefined): boolean {
  return Boolean(value && /^image(\/|$)/i.test(value));
}

function imageFromData(data: string, mediaType = "image/png"): ExtractedImage {
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(data)) {
    const [, parsedMediaType, parsedData] = data.match(/^data:([^;]+);base64,(.+)$/i) ?? [];
    return {
      url: data,
      mediaType: parsedMediaType,
      bytes: parsedData ? estimateBase64Bytes(parsedData) : undefined,
    };
  }

  return {
    url: `data:${mediaType};base64,${data}`,
    mediaType,
    bytes: estimateBase64Bytes(data),
  };
}

function partText(part: ChatMessagePart): string | null {
  if ("text" in part && typeof part.text === "string") {
    return part.text;
  }

  return null;
}

function imageFromPart(part: ChatMessagePart): ExtractedImage | null {
  const typed = part as ChatMessagePartImage;
  const source = isRecord(typed.source) ? typed.source : undefined;

  const sourceData = stringValue(source?.data);
  if (typed.type === "image" && sourceData) {
    const mediaType = stringValue(source?.media_type) ?? stringValue(source?.mediaType) ?? "image/png";
    return imageFromData(sourceData, mediaType);
  }

  const topLevelData = stringValue(typed.data);
  if ((typed.type === "image" || typed.type === "input_image") && topLevelData) {
    const mediaType = typed.media_type ?? typed.mediaType ?? "image/png";
    return imageFromData(topLevelData, mediaType);
  }

  const imageUrl = urlFromImageUrlValue(typed.image_url);
  if ((typed.type === "image_url" || typed.type === "input_image" || "image_url" in typed) && imageUrl) {
    return { url: imageUrl };
  }

  const sourceImageUrl = urlFromImageUrlValue(source?.image_url);
  if (sourceImageUrl) {
    return { url: sourceImageUrl };
  }

  const sourceUrl = stringValue(source?.url) ?? stringValue(source?.uri);
  if (sourceUrl) {
    return { url: sourceUrl };
  }

  const topLevelUrl = stringValue(typed.url);
  if ((typed.type === "input_image" || typed.type === "image" || "url" in typed) && topLevelUrl) {
    return { url: topLevelUrl };
  }

  return null;
}

function imageFromUnknown(value: unknown): ExtractedImage | null {
  if (!isRecord(value)) {
    return null;
  }

  const partImage = imageFromPart(value as ChatMessagePart);
  if (partImage) {
    return partImage;
  }

  const type = typeof value.type === "string" ? value.type.toLowerCase() : "";
  const mediaType = mediaTypeFromRecord(value);
  const source = isRecord(value.source) ? value.source : undefined;
  const sourceMediaType = source ? mediaTypeFromRecord(source) : undefined;
  const imageLike =
    type.includes("image") ||
    isImageMediaType(mediaType) ||
    isImageMediaType(sourceMediaType) ||
    "image_url" in value;

  if (!imageLike) {
    return null;
  }

  const data = stringValue(value.data) ?? stringValue(source?.data);
  if (data) {
    return imageFromData(data, mediaType ?? sourceMediaType ?? "image/png");
  }

  const url =
    urlFromImageUrlValue(value.image_url) ??
    stringValue(value.url) ??
    stringValue(value.uri) ??
    urlFromImageUrlValue(source?.image_url) ??
    stringValue(source?.url) ??
    stringValue(source?.uri);
  if (url) {
    return { url };
  }

  return null;
}

function isImageLikePart(part: ChatMessagePart): boolean {
  if (!isRecord(part)) {
    return false;
  }

  const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
  return (
    type.includes("image") ||
    "image_url" in part ||
    "source" in part ||
    "url" in part ||
    "data" in part
  );
}

function isImageLikeValue(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const type = typeof value.type === "string" ? value.type.toLowerCase() : "";
  const source = isRecord(value.source) ? value.source : undefined;
  return (
    type.includes("image") ||
    isImageMediaType(mediaTypeFromRecord(value)) ||
    isImageMediaType(source ? mediaTypeFromRecord(source) : undefined) ||
    "image_url" in value ||
    imageFromUnknown(value) !== null
  );
}

function partType(part: ChatMessagePart): string {
  if (isRecord(part) && typeof part.type === "string") {
    return part.type;
  }

  return typeof part;
}

function partKeys(part: ChatMessagePart): string[] {
  return isRecord(part) ? Object.keys(part).sort() : [];
}

function extractMarkdownImages(content: string): ExtractedImage[] {
  const images: ExtractedImage[] = [];
  const patterns = [
    /!\[[^\]]*]\(([^)]+)\)/gi,
    /(data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+)/gi,
    /(https?:\/\/\S+\.(?:png|jpe?g|webp|gif)(?:\?\S*)?)/gi,
  ];

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const url = match[1] ?? match[0];
      if (url.startsWith("data:image/")) {
        const [, mediaType, data] = url.match(/^data:([^;]+);base64,(.+)$/i) ?? [];
        images.push({
          url,
          mediaType,
          bytes: data ? estimateBase64Bytes(data) : undefined,
        });
      } else {
        images.push({ url });
      }
    }
  }

  return images;
}

function extractImages(request: ChatCompletionRequest): ImageExtraction {
  const images: ExtractedImage[] = [];
  const textHints: string[] = [];
  const seenImageUrls = new Set<string>();
  const pushImage = (image: ExtractedImage): void => {
    if (seenImageUrls.has(image.url)) {
      return;
    }
    seenImageUrls.add(image.url);
    images.push(image);
  };

  for (const message of request.messages ?? []) {
    if (typeof message.content === "string") {
      for (const image of extractMarkdownImages(message.content)) {
        pushImage(image);
      }
      textHints.push(message.content);
      continue;
    }

    for (const part of message.content) {
      const image = imageFromPart(part);
      if (image) {
        pushImage(image);
        continue;
      }

      const text = partText(part);
      if (text) {
        textHints.push(text);
      }
    }
  }

  const visit = (value: unknown, path: string): void => {
    if (!value || typeof value !== "object") {
      return;
    }

    const image = imageFromUnknown(value);
    if (image) {
      pushImage(image);
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      if (key === "messages" || key === "tools" || key === "tool_choice") {
        continue;
      }
      visit(child, path ? `${path}.${key}` : key);
    }
  };
  visit(request, "");

  return { images, textHints };
}

export function getVisionInputDiagnostics(request: ChatCompletionRequest): VisionInputDiagnostics {
  const extraction = extractImages(request);
  const imageLikeParts: Array<ChatMessagePart | "markdown-image"> = [];

  for (const message of request.messages ?? []) {
    if (typeof message.content === "string") {
      if (extractMarkdownImages(message.content).length > 0) {
        imageLikeParts.push("markdown-image");
      }
      continue;
    }

    imageLikeParts.push(...message.content.filter(isImageLikePart));
  }

  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") {
      return;
    }

    if (isImageLikeValue(value)) {
      imageLikeParts.push(value as ChatMessagePart);
      return;
    }

    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      if (key === "messages" || key === "tools" || key === "tool_choice") {
        continue;
      }
      visit(child);
    }
  };
  visit(request);

  return {
    supportedImageCount: extraction.images.length,
    imageLikePartCount: imageLikeParts.length,
    imageLikePartTypes: [...new Set(imageLikeParts.map((part) => (typeof part === "string" ? part : partType(part))))],
    imageLikePartKeys: [
      ...new Set(
        imageLikeParts.flatMap((part) => (typeof part === "string" ? ["markdown"] : partKeys(part))),
      ),
    ],
  };
}

function limitImages(images: ExtractedImage[], visionConfig: VisionConfig): ExtractedImage[] {
  return images
    .filter((image) => image.bytes === undefined || image.bytes <= visionConfig.maxImageBytes)
    .slice(0, visionConfig.maxImagesPerRequest);
}

function stripImageParts(request: ChatCompletionRequest): ChatCompletionRequest {
  const messages = (request.messages ?? []).map((message): ChatMessage => {
    if (typeof message.content === "string") {
      return message;
    }

    const content = message.content
      .filter((part) => !imageFromPart(part))
      .map((part) => part as ChatMessagePartText | Record<string, JsonValue>);

    return {
      ...message,
      content: content.length > 0 ? content : "[图片已由代理视觉模型识别，详见 VISION SUMMARY]",
    };
  });

  return {
    ...(stripImagePayloads(request) as ChatCompletionRequest),
    messages,
  };
}

function stripImagePayloads(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }

  if (imageFromUnknown(value) || isImageLikeValue(value)) {
    return undefined;
  }

  if (Array.isArray(value)) {
    const stripped = value
      .map((item) => stripImagePayloads(item))
      .filter((item) => item !== undefined);
    return stripped.length > 0 ? stripped : undefined;
  }

  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "messages") {
      next[key] = child;
      continue;
    }

    const stripped = stripImagePayloads(child);
    if (stripped !== undefined) {
      next[key] = stripped;
    }
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

function resolveVisionEndpoint(visionConfig: VisionConfig): string {
  if (/\/v1\/chat\/completions\/?$/i.test(visionConfig.baseUrl)) {
    return visionConfig.baseUrl;
  }

  return `${visionConfig.baseUrl.replace(/\/$/, "")}${visionConfig.chatPath}`;
}

function resolveVisionModels(visionConfig: VisionConfig): string[] {
  const models = visionConfig.models?.length ? visionConfig.models : [visionConfig.model];
  return [...new Set(models.filter(Boolean))];
}

function resolveApiKey(visionConfig: VisionConfig): string | undefined {
  if (visionConfig.apiKey) {
    return visionConfig.apiKey;
  }

  if (visionConfig.apiKeyEnv) {
    return process.env[visionConfig.apiKeyEnv];
  }

  return undefined;
}

async function callVisionModel(
  model: string,
  images: ExtractedImage[],
  textHints: string[],
  visionConfig: VisionConfig,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), visionConfig.timeoutMs);
  const apiKey = resolveApiKey(visionConfig);
  const userContent: OpenAiVisionContentPart[] = [
    {
      type: "text",
      text: [
        "请分析这些图片，并结合用户上下文输出给文本模型使用的结构化摘要。",
        "用户上下文：",
        textHints.join("\n\n").slice(0, 6000),
      ].join("\n"),
    },
    ...images.map((image) => ({
      type: "image_url" as const,
      image_url: {
        url: image.url,
      },
    })),
  ];

  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };

    if (apiKey) {
      headers.authorization = `Bearer ${apiKey}`;
    }

    const response = await fetch(resolveVisionEndpoint(visionConfig), {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model,
        enable_thinking: false,
        messages: [
          {
            role: "system",
            content: visionConfig.systemPrompt,
          },
          {
            role: "user",
            content: userContent,
          },
        ],
        max_tokens: visionConfig.summaryMaxTokens,
        stream: false,
      }),
    });

    if (!response.ok) {
      return `[${model}] 视觉模型调用失败：HTTP ${response.status}`;
    }

    const payload = (await response.json()) as Record<string, unknown>;
    return extractAssistantText(payload) || `[${model}] 未返回可用视觉摘要`;
  } finally {
    clearTimeout(timeout);
  }
}

export function hasImageInput(request: ChatCompletionRequest): boolean {
  return extractImages(request).images.length > 0;
}

export async function enrichRequestWithVision(
  request: ChatCompletionRequest,
  visionConfig: VisionConfig,
): Promise<{ request: ChatCompletionRequest; vision: VisionAnalysisResult }> {
  if (!visionConfig.enabled) {
    return {
      request,
      vision: { used: false },
    };
  }

  const extraction = extractImages(request);
  const images = limitImages(extraction.images, visionConfig);
  if (images.length === 0) {
    return {
      request,
      vision: { used: false },
    };
  }

  const models = visionConfig.compareModels
    ? resolveVisionModels(visionConfig)
    : resolveVisionModels(visionConfig).slice(0, 1);

  if (models.length === 0) {
    return {
      request,
      vision: { used: false, imageCount: images.length, error: "vision model is not configured" },
    };
  }

  const modelSummaries = await Promise.all(
    models.map(async (model) => ({
      model,
      summary: await callVisionModel(model, images, extraction.textHints, visionConfig),
    })),
  );

  const summary = modelSummaries
    .map((item) => [`## ${item.model}`, item.summary].join("\n"))
    .join("\n\n");

  const baseRequest = visionConfig.stripImagesAfterSummary ? stripImageParts(request) : request;
  const nextMessages = [...(baseRequest.messages ?? [])];
  nextMessages.splice(Math.max(nextMessages.length - 1, 0), 0, {
    role: "system",
    content: [
      "[VISION SUMMARY]",
      `图片数量：${images.length}`,
      "以下内容由代理调用多模态模型生成，下游文本模型不能直接看到原图，请以该摘要作为图片事实来源。",
      summary,
      "[/VISION SUMMARY]",
    ].join("\n"),
  });

  return {
    request: {
      ...baseRequest,
      messages: nextMessages,
    },
    vision: {
      used: true,
      summary,
      modelSummaries,
      imageCount: images.length,
    },
  };
}

function extractAssistantText(payload: Record<string, unknown>): string {
  if (typeof payload.content === "string") {
    return payload.content;
  }

  if (Array.isArray(payload.content)) {
    const textParts = payload.content
      .map((item) => {
        if (item && typeof item === "object") {
          const typed = item as Record<string, unknown>;
          if (typeof typed.text === "string") {
            return typed.text;
          }
          if (typeof typed.thinking === "string") {
            return typed.thinking;
          }
        }

        return "";
      })
      .filter(Boolean);

    if (textParts.length > 0) {
      return textParts.join("\n");
    }
  }

  const choices = payload.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as Record<string, unknown>;
    const message = first.message as Record<string, unknown> | undefined;
    if (message && typeof message.content === "string") {
      return message.content;
    }
  }

  const output = payload.output;
  if (Array.isArray(output)) {
    return output.map((item) => JSON.stringify(item)).join("\n");
  }

  return "";
}
