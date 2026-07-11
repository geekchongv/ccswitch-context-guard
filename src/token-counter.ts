import { estimateTokenCount } from "tokenx";
import { ChatMessage, ChatMessagePart, ChatMessagePartImage } from "./types.js";

const IMAGE_PLACEHOLDER = "[image]";

export function countTextTokens(text: string | undefined | null): number {
  return estimateTokenCount(text ?? "");
}

function isImagePart(part: ChatMessagePart): boolean {
  const typed = part as ChatMessagePartImage;

  if (typed.type === "image" && typed.source?.type === "base64" && typed.source.data) {
    return true;
  }
  if (typed.type === "image_url" || "image_url" in typed) {
    return true;
  }
  return typed.type === "input_image" && typeof typed.url === "string";
}

function sanitizeStructuredValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeStructuredValue);
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && /^data:image\/[a-z0-9.+-]+;base64,/i.test(value)) {
      return IMAGE_PLACEHOLDER;
    }
    return value;
  }

  const object = value as Record<string, unknown>;
  if (isImagePart(object as ChatMessagePart)) {
    return IMAGE_PLACEHOLDER;
  }

  return Object.fromEntries(
    Object.entries(object).map(([key, item]) => [key, sanitizeStructuredValue(item)]),
  );
}

export function countStructuredTokens(value: unknown): number {
  if (typeof value === "string") {
    return countTextTokens(value);
  }
  return countTextTokens(JSON.stringify(sanitizeStructuredValue(value)));
}

export function countPartTokens(part: ChatMessagePart): number {
  if ("text" in part && typeof part.text === "string") {
    return countTextTokens(part.text);
  }
  if (isImagePart(part)) {
    return countTextTokens(IMAGE_PLACEHOLDER);
  }
  return countStructuredTokens(part);
}

export function countMessageTokens(message: ChatMessage): number {
  if (typeof message.content === "string") {
    return countTextTokens(message.content);
  }
  return message.content.reduce((sum, part) => sum + countPartTokens(part), 0);
}
