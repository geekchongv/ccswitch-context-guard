import { ChatCompletionRequest, ChatMessagePart } from "./types.js";

const TOOL_PART_TYPES = new Set(["tool_use", "tool_result", "function_call", "function_call_output"]);

function partHasToolProtocol(part: ChatMessagePart): boolean {
  if (!part || typeof part !== "object" || Array.isArray(part)) {
    return false;
  }

  const type = (part as Record<string, unknown>).type;
  return typeof type === "string" && TOOL_PART_TYPES.has(type);
}

export function hasAgentToolProtocol(request: ChatCompletionRequest): boolean {
  if (Array.isArray(request.tools) && request.tools.length > 0) {
    return true;
  }

  return (request.messages ?? []).some((message) =>
    Array.isArray(message.content) && message.content.some(partHasToolProtocol),
  );
}
