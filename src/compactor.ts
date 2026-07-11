import { sliceByTokens } from "tokenx";
import { ChatMessage, ChatMessagePart, ChatCompletionRequest } from "./types.js";
import { countMessageTokens, countTextTokens } from "./token-counter.js";

const DEFAULT_COMPACT_TARGET_INPUT_TOKENS = 60_000;
const COMPACT_MEMORY_TOKENS = 6_000;
const PRESERVED_HEAD_TOKENS = 1_000;
const RECENT_TAIL_TOKENS = 2_500;
const SHORT_LATEST_MESSAGE_TOKENS = 12_000;
const TRUNCATED_SUFFIX = "\n[truncated by proxy compact]";
const IMAGE_PLACEHOLDER = "[image-content]";

function partToText(part: ChatMessagePart): string {
  if ("text" in part && typeof part.text === "string") {
    return part.text;
  }

  if ("image_url" in part || "url" in part) {
    return IMAGE_PLACEHOLDER;
  }

  return JSON.stringify(part).slice(0, 500);
}

function messageContentToText(message: ChatMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }

  return message.content.map(partToText).join("\n");
}

function truncateByTokens(text: string, maxTokens: number): string {
  if (countTextTokens(text) <= maxTokens) {
    return text;
  }

  const suffixTokens = countTextTokens(TRUNCATED_SUFFIX);
  return `${sliceByTokens(text, 0, Math.max(1, maxTokens - suffixTokens))}${TRUNCATED_SUFFIX}`;
}

function compactMessage(message: ChatMessage, maxTokens: number): ChatMessage {
  return {
    role: message.role,
    name: message.name,
    content: truncateByTokens(messageContentToText(message), maxTokens),
  };
}

function estimateMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + countMessageTokens(message), 0);
}

function buildStructuredCompactBlock(messages: ChatMessage[]): string {
  const goal = messages.at(-1) ? messageContentToText(messages.at(-1) as ChatMessage).slice(0, 1200) : "";
  const recent = messages.slice(-4).map((message) => `- ${message.role}: ${messageContentToText(message).slice(0, 500)}`);
  const older = messages.slice(0, -4);

  const constraints = older
    .filter((message) => /must|should|don't|do not|不能|必须|不要/i.test(messageContentToText(message)))
    .slice(-6)
    .map((message) => `- ${messageContentToText(message).slice(0, 240)}`);

  const completed = older
    .filter((message) => /done|completed|finished|已完成|实现|修复/i.test(messageContentToText(message)))
    .slice(-6)
    .map((message) => `- ${messageContentToText(message).slice(0, 240)}`);

  const risks = older
    .filter((message) => /risk|bug|issue|error|失败|问题|报错/i.test(messageContentToText(message)))
    .slice(-6)
    .map((message) => `- ${messageContentToText(message).slice(0, 240)}`);

  return [
    "[COMPACT MEMORY]",
    `Goal:\n${goal || "Unknown"}`,
    `Constraints:\n${constraints.join("\n") || "- None captured"}`,
    `Completed:\n${completed.join("\n") || "- None captured"}`,
    "Pending:\n- Continue from the latest user request and unresolved implementation tasks.",
    "Code Facts:\n- Preserve referenced files, APIs, limits, ports, and provider names from recent context.",
    "User Preferences:\n- Prefer a local executable with logs instead of a web dashboard.",
    `Risks:\n${risks.join("\n") || "- Repeated compression may lose nuance; review logs if behavior drifts."}`,
    `Recent High-Value Messages:\n${recent.join("\n") || "- None"}`,
    "[/COMPACT MEMORY]",
  ].join("\n\n");
}

export function compactRequest(
  request: ChatCompletionRequest,
  targetInputTokens = DEFAULT_COMPACT_TARGET_INPUT_TOKENS,
): ChatCompletionRequest {
  const messages = request.messages ?? [];
  if (messages.length <= 6 && estimateMessagesTokens(messages) <= targetInputTokens) {
    return request;
  }

  const compactBlock = truncateByTokens(buildStructuredCompactBlock(messages), COMPACT_MEMORY_TOKENS);

  if (messages.length <= 6) {
    const systemHead = messages.find((message) => message.role === "system");
    const latestUser = [...messages].reverse().find((message) => message.role === "user") ?? messages.at(-1);
    const compactedMessages: ChatMessage[] = [
      ...(systemHead ? [compactMessage(systemHead, PRESERVED_HEAD_TOKENS)] : []),
      {
        role: "system",
        content: compactBlock,
      },
      ...(latestUser ? [compactMessage(latestUser, SHORT_LATEST_MESSAGE_TOKENS)] : []),
    ];

    return {
      ...request,
      messages: compactedMessages,
    };
  }

  const preservedHead = messages.slice(0, 2).map((message) => compactMessage(message, PRESERVED_HEAD_TOKENS));
  const recentTail = messages.slice(-4).map((message) => compactMessage(message, RECENT_TAIL_TOKENS));

  return {
    ...request,
    messages: [
      ...preservedHead,
      {
        role: "system",
        content: compactBlock,
      },
      ...recentTail,
    ],
  };
}
