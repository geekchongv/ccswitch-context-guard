function appendToAnthropicContent(payload: Record<string, unknown>, warningText: string): boolean {
  const content = payload.content;

  if (typeof content === "string") {
    payload.content = `${content}\n\n${warningText}`;
    return true;
  }

  if (Array.isArray(content)) {
    content.push({
      type: "text",
      text: `\n\n${warningText}`,
    });
    return true;
  }

  return false;
}

function appendToOpenAiContent(payload: Record<string, unknown>, warningText: string): boolean {
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return false;
  }

  const first = choices[0] as Record<string, unknown>;
  const message = first.message as Record<string, unknown> | undefined;
  if (!message || typeof message.content !== "string") {
    return false;
  }

  message.content = `${message.content}\n\n${warningText}`;
  return true;
}

export async function appendCompactWarning(response: Response, warningText: string): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok || !contentType.includes("application/json")) {
    return response;
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const appended = appendToAnthropicContent(payload, warningText) || appendToOpenAiContent(payload, warningText);

  if (!appended) {
    return new Response(JSON.stringify(payload), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.delete("content-length");

  return new Response(JSON.stringify(payload), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
