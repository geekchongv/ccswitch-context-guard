import { ChatMessage, ChatMessagePart, ChatCompletionRequest } from "./types.js";

function partToText(part: ChatMessagePart): string {
  if ("text" in part && typeof part.text === "string") {
    return part.text;
  }

  if ("image_url" in part || "url" in part) {
    return "[image-content]";
  }

  return JSON.stringify(part);
}

function messageContentToText(message: ChatMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }

  return message.content.map(partToText).join("\n");
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

export function compactRequest(request: ChatCompletionRequest): ChatCompletionRequest {
  const messages = request.messages ?? [];
  if (messages.length <= 6) {
    return request;
  }

  const preservedHead = messages.slice(0, 2);
  const recentTail = messages.slice(-4);
  const compactedMiddle = messages.slice(2, -4);
  const compactBlock = buildStructuredCompactBlock(compactedMiddle);

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
