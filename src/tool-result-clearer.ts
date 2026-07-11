import { ChatCompletionRequest, ChatMessagePart } from "./types.js";
import { countPartTokens } from "./token-counter.js";
import { estimateRequestTokens } from "./token-estimator.js";

export const CLEARED_TOOL_RESULT_TEXT =
  "[tool result cleared by CCProxy Agent; the original tool call and tool_use_id are preserved]";
export const TRUNCATED_TOOL_RESULT_MARKER =
  "[middle of tool result truncated by CCProxy Agent to fit the context window; use the preserved head and tail and do not repeat the tool call solely because content was truncated]";

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

function stringifyToolResultContent(part: ChatMessagePart): string {
  const content = (part as Record<string, unknown>).content;
  return typeof content === "string" ? content : JSON.stringify(content ?? "");
}

function truncatedPart(part: ChatMessagePart, characterBudget: number): ChatMessagePart {
  const content = stringifyToolResultContent(part);
  const usableCharacters = Math.max(0, characterBudget - TRUNCATED_TOOL_RESULT_MARKER.length - 4);
  const headCharacters = Math.ceil(usableCharacters / 2);
  const tailCharacters = Math.floor(usableCharacters / 2);
  const head = content.slice(0, headCharacters);
  const tail = tailCharacters > 0 ? content.slice(-tailCharacters) : "";
  return {
    ...(part as Record<string, unknown>),
    content: `${head}\n\n${TRUNCATED_TOOL_RESULT_MARKER}\n\n${tail}`,
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

/**
 * Shrinks the newest tool result while preserving evidence from both ends. This is
 * the last-resort Agent rescue after old results have already been cleared.
 */
export function truncateNewestToolResult(
  request: ChatCompletionRequest,
  targetInputTokens: number,
  minimumPreservedCharacters = 2_000,
): ToolResultClearingResult {
  const beforeInputTokens = estimateRequestTokens(request, 0).inputTokens;
  const messages = request.messages ?? [];
  let location: ToolResultLocation | undefined;

  for (const [messageIndex, message] of messages.entries()) {
    if (!Array.isArray(message.content)) continue;
    for (const [partIndex, part] of message.content.entries()) {
      if (isToolResult(part) &&
        (part as Record<string, unknown>).content !== CLEARED_TOOL_RESULT_TEXT &&
        !stringifyToolResultContent(part).includes(TRUNCATED_TOOL_RESULT_MARKER)) {
        location = { messageIndex, partIndex, tokens: countPartTokens(part) };
      }
    }
  }

  if (!location || beforeInputTokens <= targetInputTokens) {
    return {
      request,
      applied: false,
      clearedResults: 0,
      estimatedTokensCleared: 0,
      beforeInputTokens,
      afterInputTokens: beforeInputTokens,
    };
  }

  const originalMessage = messages[location.messageIndex];
  if (!originalMessage || !Array.isArray(originalMessage.content)) {
    return {
      request,
      applied: false,
      clearedResults: 0,
      estimatedTokensCleared: 0,
      beforeInputTokens,
      afterInputTokens: beforeInputTokens,
    };
  }

  const originalPart = originalMessage.content[location.partIndex];
  if (!originalPart) {
    return {
      request,
      applied: false,
      clearedResults: 0,
      estimatedTokensCleared: 0,
      beforeInputTokens,
      afterInputTokens: beforeInputTokens,
    };
  }

  const originalContent = stringifyToolResultContent(originalPart);
  const minimumBudget = Math.min(
    originalContent.length,
    Math.max(TRUNCATED_TOOL_RESULT_MARKER.length + 4, minimumPreservedCharacters),
  );
  let low = minimumBudget;
  let high = originalContent.length;
  let bestRequest: ChatCompletionRequest | undefined;
  let bestTokens = Number.POSITIVE_INFINITY;

  const buildCandidate = (characterBudget: number): { request: ChatCompletionRequest; tokens: number } => {
    const nextMessages = messages.map((message) => ({
      ...message,
      content: Array.isArray(message.content) ? [...message.content] : message.content,
    }));
    const message = nextMessages[location!.messageIndex];
    (message.content as ChatMessagePart[])[location!.partIndex] = truncatedPart(originalPart, characterBudget);
    const candidate = { ...request, messages: nextMessages };
    return { request: candidate, tokens: estimateRequestTokens(candidate, 0).inputTokens };
  };

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = buildCandidate(middle);
    if (candidate.tokens <= targetInputTokens) {
      bestRequest = candidate.request;
      bestTokens = candidate.tokens;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  if (!bestRequest) {
    const candidate = buildCandidate(minimumBudget);
    bestRequest = candidate.request;
    bestTokens = candidate.tokens;
  }

  return {
    request: bestRequest,
    applied: bestTokens < beforeInputTokens,
    clearedResults: bestTokens < beforeInputTokens ? 1 : 0,
    estimatedTokensCleared: Math.max(0, beforeInputTokens - bestTokens),
    beforeInputTokens,
    afterInputTokens: bestTokens,
  };
}
