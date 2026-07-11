import { ChatCompletionRequest, ChatMessagePart } from "./types.js";
import { countPartTokens } from "./token-counter.js";
import { estimateRequestTokens } from "./token-estimator.js";

export const CLEARED_TOOL_RESULT_TEXT =
  "[tool result cleared by CCProxy Agent; the original tool call and tool_use_id are preserved]";

export interface ToolResultClearingResult {
  request: ChatCompletionRequest;
  applied: boolean;
  clearedResults: number;
  estimatedTokensCleared: number;
  beforeInputTokens: number;
  afterInputTokens: number;
}

interface ToolResultLocation {
  messageIndex: number;
  partIndex: number;
  tokens: number;
}

function isToolResult(part: ChatMessagePart): boolean {
  return Boolean(part && typeof part === "object" && !Array.isArray(part) &&
    (part as Record<string, unknown>).type === "tool_result");
}

function clearedPart(part: ChatMessagePart): ChatMessagePart {
  return {
    ...(part as Record<string, unknown>),
    content: CLEARED_TOOL_RESULT_TEXT,
  } as ChatMessagePart;
}

export function clearOldToolResults(
  request: ChatCompletionRequest,
  targetInputTokens: number,
  keepRecent = 3,
): ToolResultClearingResult {
  const beforeInputTokens = estimateRequestTokens(request, 0).inputTokens;
  const messages = request.messages ?? [];
  const locations: ToolResultLocation[] = [];

  for (const [messageIndex, message] of messages.entries()) {
    if (!Array.isArray(message.content)) continue;
    for (const [partIndex, part] of message.content.entries()) {
      if (isToolResult(part) && (part as Record<string, unknown>).content !== CLEARED_TOOL_RESULT_TEXT) {
        locations.push({ messageIndex, partIndex, tokens: countPartTokens(part) });
      }
    }
  }

  const clearable = locations.slice(0, Math.max(0, locations.length - Math.max(0, keepRecent)));
  if (beforeInputTokens <= targetInputTokens || clearable.length === 0) {
    return {
      request,
      applied: false,
      clearedResults: 0,
      estimatedTokensCleared: 0,
      beforeInputTokens,
      afterInputTokens: beforeInputTokens,
    };
  }

  const nextMessages = messages.map((message) => ({
    ...message,
    content: Array.isArray(message.content) ? [...message.content] : message.content,
  }));
  let estimatedInputTokens = beforeInputTokens;
  let clearedResults = 0;
  let estimatedTokensCleared = 0;

  for (const location of clearable) {
    if (estimatedInputTokens <= targetInputTokens) break;
    const message = nextMessages[location.messageIndex];
    if (!message || !Array.isArray(message.content)) continue;
    const originalPart = message.content[location.partIndex];
    if (!originalPart) continue;
    const replacement = clearedPart(originalPart);
    const saved = Math.max(0, location.tokens - countPartTokens(replacement));
    message.content[location.partIndex] = replacement;
    estimatedInputTokens -= saved;
    estimatedTokensCleared += saved;
    clearedResults += 1;
  }

  const nextRequest: ChatCompletionRequest = { ...request, messages: nextMessages };
  const afterInputTokens = estimateRequestTokens(nextRequest, 0).inputTokens;
  return {
    request: nextRequest,
    applied: clearedResults > 0,
    clearedResults,
    estimatedTokensCleared,
    beforeInputTokens,
    afterInputTokens,
  };
}
