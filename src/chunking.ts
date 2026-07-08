import { ChatCompletionRequest, ChatMessage } from "./types.js";

function toText(message: ChatMessage): string {
  if (typeof message.content === "string") {
    return `${message.role}: ${message.content}`;
  }

  return `${message.role}: ${JSON.stringify(message.content)}`;
}

function chunkMessages(messages: ChatMessage[], chunkTarget: number): ChatMessage[][] {
  const chunks: ChatMessage[][] = [];
  let current: ChatMessage[] = [];
  let currentSize = 0;

  for (const message of messages) {
    const text = toText(message);
    const estimated = Math.ceil(text.length / 3.5);

    if (current.length > 0 && currentSize + estimated > chunkTarget) {
      chunks.push(current);
      current = [];
      currentSize = 0;
    }

    current.push(message);
    currentSize += estimated;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

export function buildChunkPlan(request: ChatCompletionRequest, chunkTarget: number): ChatCompletionRequest[] {
  const messages = request.messages ?? [];
  const chunks = chunkMessages(messages, chunkTarget);

  return chunks.map((chunk, index) => ({
    ...request,
    messages: [
      {
        role: "system",
        content:
          index === 0
            ? "Process this chunk and preserve all actionable constraints for later synthesis."
            : "Continue processing this chunk. Preserve constraints and new findings for final synthesis.",
      },
      ...chunk,
    ],
    max_tokens: Math.min(request.max_tokens ?? 4000, 4000),
    stream: false,
  }));
}

export function buildSynthesisRequest(
  originalRequest: ChatCompletionRequest,
  chunkOutputs: string[],
): ChatCompletionRequest {
  return {
    ...originalRequest,
    stream: false,
    messages: [
      {
        role: "system",
        content:
          "Synthesize the chunk results into one final answer. Preserve all constraints and avoid contradictions.",
      },
      {
        role: "user",
        content: [
          "Original task:",
          JSON.stringify(originalRequest.messages ?? []),
          "",
          "Chunk outputs:",
          ...chunkOutputs.map((output, index) => `Chunk ${index + 1}:\n${output}`),
        ].join("\n"),
      },
    ],
  };
}
