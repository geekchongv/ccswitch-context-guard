import { estimateTokenCount } from "tokenx";
import { ChatMessage, ChatMessagePart, ChatMessagePartImage } from "./types.js";

/** 图片占位符:估算时统一记 ~1 token,绝不把 base64 原文喂给计数器(那会把一张 500KB 图算成 ~16 万 token)。 */
const IMAGE_PLACEHOLDER = "[image]";
/** 未知 part 类型走 JSON.stringify 时的字符上限,防止内嵌大字符串膨胀计数。 */
const BOUNDED_JSON_CAP = 200;

/**
 * 文本 token 计数 —— 全项目唯一的计数口径,取代旧的 length/3.0 与 length/3.5。
 * tokenx 按语言自适应 chars/token,对中文(~1-2 token/字)远比 length/3 准确。
 */
export function countTextTokens(text: string | undefined | null): number {
  return estimateTokenCount(text ?? "");
}

/** 判断一个 part 是否是图片块(判定与 modality-router.ts 的 imageFromPart 保持一致)。 */
function isImagePart(part: ChatMessagePart): boolean {
  const typed = part as ChatMessagePartImage;

  if (typed.type === "image" && typed.source?.type === "base64" && typed.source.data) {
    return true;
  }

  if (typed.type === "image_url" || "image_url" in typed) {
    return true;
  }

  if ((typed.type === "input_image" || "url" in typed) && typeof typed.url === "string") {
    return true;
  }

  return false;
}

/** 单个 part 的 token 计数:文本按实计,图片用占位符,其它有界 JSON。 */
function countPartTokens(part: ChatMessagePart): number {
  if ("text" in part && typeof part.text === "string") {
    return countTextTokens(part.text);
  }

  if (isImagePart(part)) {
    return countTextTokens(IMAGE_PLACEHOLDER);
  }

  // 未知结构:有界序列化后计数,避免内嵌超长字段膨胀。
  return countTextTokens(JSON.stringify(part).slice(0, BOUNDED_JSON_CAP));
}

/**
 * 单条消息的 token 计数(不含 role 前缀 —— 结构开销由 token-estimator 的 wrapper 公式单独算)。
 * 字符串内容直接计;数组内容按 part 求和,且对 base64 图片安全。
 */
export function countMessageTokens(message: ChatMessage): number {
  if (typeof message.content === "string") {
    return countTextTokens(message.content);
  }

  return message.content.reduce((sum, part) => sum + countPartTokens(part), 0);
}
