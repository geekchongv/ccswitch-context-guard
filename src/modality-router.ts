import { ChatCompletionRequest, ChatMessage, ChatMessagePart, VisionAnalysisResult, VisionConfig } from "./types.js";

function partHasImage(part: ChatMessagePart): boolean {
  if ("type" in part && (part.type === "image_url" || part.type === "input_image")) {
    return true;
  }

  if ("image_url" in part || "url" in part) {
    return true;
  }

  return false;
}

function messageHasImage(message: ChatMessage): boolean {
  if (typeof message.content === "string") {
    return /!\[[^\]]*]\([^)]+\)|data:image\/|https?:\/\/\S+\.(png|jpe?g|webp|gif)|[A-Za-z]:\\.*\.(png|jpe?g|webp|gif)/i.test(
      message.content,
    );
  }

  return message.content.some(partHasImage);
}

function collectImageHints(request: ChatCompletionRequest): string[] {
  const messages = request.messages ?? [];
  return messages
    .filter(messageHasImage)
    .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)));
}

export function hasImageInput(request: ChatCompletionRequest): boolean {
  return (request.messages ?? []).some(messageHasImage);
}

export async function enrichRequestWithVision(
  request: ChatCompletionRequest,
  visionConfig: VisionConfig,
): Promise<{ request: ChatCompletionRequest; vision: VisionAnalysisResult }> {
  if (!visionConfig.enabled || !visionConfig.model || !hasImageInput(request)) {
    return {
      request,
      vision: { used: false },
    };
  }

  const imageHints = collectImageHints(request);
  const response = await fetch(`${visionConfig.baseUrl}${visionConfig.chatPath}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: visionConfig.model,
      messages: [
        {
          role: "system",
          content: visionConfig.systemPrompt,
        },
        {
          role: "user",
          content: imageHints.join("\n\n"),
        },
      ],
      max_tokens: 800,
      stream: false,
    }),
  });

  if (!response.ok) {
    return {
      request,
      vision: {
        used: false,
      },
    };
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const summary = extractAssistantText(payload);
  if (!summary) {
    return {
      request,
      vision: { used: false },
    };
  }

  const nextMessages = [...(request.messages ?? [])];
  nextMessages.splice(Math.max(nextMessages.length - 1, 0), 0, {
    role: "system",
    content: `[VISION SUMMARY]\n${summary}\n[/VISION SUMMARY]`,
  });

  return {
    request: {
      ...request,
      messages: nextMessages,
    },
    vision: {
      used: true,
      summary,
    },
  };
}

function extractAssistantText(payload: Record<string, unknown>): string {
  if (typeof payload.content === "string") {
    return payload.content;
  }

  if (Array.isArray(payload.content)) {
    const textParts = payload.content
      .map((item) => {
        if (item && typeof item === "object") {
          const typed = item as Record<string, unknown>;
          if (typeof typed.text === "string") {
            return typed.text;
          }
          if (typeof typed.thinking === "string") {
            return typed.thinking;
          }
        }

        return "";
      })
      .filter(Boolean);

    if (textParts.length > 0) {
      return textParts.join("\n");
    }
  }

  const choices = payload.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as Record<string, unknown>;
    const message = first.message as Record<string, unknown> | undefined;
    if (message && typeof message.content === "string") {
      return message.content;
    }
  }

  const output = payload.output;
  if (Array.isArray(output)) {
    return output
      .map((item) => JSON.stringify(item))
      .join("\n");
  }

  return "";
}
