import { BudgetAssessment, ChatCompletionRequest, ChatMessage, ChatMessagePart, TokenEstimate } from "./types.js";

function estimateStringTokens(input: string): number {
  if (!input) {
    return 0;
  }

  return Math.ceil(input.length / 3.0);
}

function extractTextFromPart(part: ChatMessagePart): string {
  if ("text" in part && typeof part.text === "string") {
    return part.text;
  }

  if ("image_url" in part || "url" in part) {
    return "[image]";
  }

  return JSON.stringify(part);
}

function messageToText(message: ChatMessage): string {
  if (typeof message.content === "string") {
    return `${message.role}: ${message.content}`;
  }

  return `${message.role}: ${message.content.map(extractTextFromPart).join("\n")}`;
}

export function estimateRequestTokens(request: ChatCompletionRequest, responseReserve: number): TokenEstimate {
  const messages = request.messages ?? [];
  const messageTokens = messages.reduce((sum, message) => sum + estimateStringTokens(messageToText(message)), 0);
  const wrapperTokens = 250 + messages.length * 12;
  const expectedOutputTokens =
    request.max_completion_tokens ?? request.max_tokens ?? responseReserve;

  return {
    inputTokens: messageTokens + wrapperTokens,
    expectedOutputTokens,
    totalTokens: messageTokens + wrapperTokens + expectedOutputTokens,
  };
}

export function assessBudget(
  request: ChatCompletionRequest,
  compactThreshold: number,
  hardLimit: number,
  responseReserve: number,
  safetyMargin: number,
): BudgetAssessment {
  const estimate = estimateRequestTokens(request, responseReserve);
  const effectiveHardLimit = Math.max(1, hardLimit - safetyMargin);
  const effectiveCompactThreshold = Math.max(1, Math.min(compactThreshold, effectiveHardLimit - Math.ceil(safetyMargin / 2)));

  if (estimate.totalTokens >= effectiveHardLimit) {
    return {
      decision: "chunk_required",
      estimate,
    };
  }

  if (estimate.totalTokens >= effectiveCompactThreshold) {
    return {
      decision: "compact_required",
      estimate,
    };
  }

  return {
    decision: "safe",
    estimate,
  };
}
