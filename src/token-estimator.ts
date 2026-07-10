import { BudgetAssessment, ChatCompletionRequest, TokenEstimate } from "./types.js";
import { countMessageTokens } from "./token-counter.js";

export function estimateRequestTokens(request: ChatCompletionRequest, responseReserve: number): TokenEstimate {
  const messages = request.messages ?? [];
  const messageTokens = messages.reduce((sum, message) => sum + countMessageTokens(message), 0);
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
