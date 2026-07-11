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

export interface CompactWarningResult {
  response: Response;
  appended: boolean;
}

function replayHeaders(headers: Headers, contentType?: string): Headers {
  const next = new Headers(headers);
  next.delete("content-length");
  next.delete("content-encoding");
  next.delete("transfer-encoding");
  if (contentType) next.set("content-type", contentType);
  return next;
}

function appendToSse(body: string, warningText: string): { body: string; appended: boolean } {
  const anthropicStop = body.lastIndexOf("event: message_stop");
  if (anthropicStop >= 0) {
    const indexes = [...body.matchAll(/"index"\s*:\s*(\d+)/g)].map((match) => Number(match[1]));
    const index = indexes.length > 0 ? Math.max(...indexes) + 1 : 0;
    const insertionPoint = body.lastIndexOf("event: message_delta", anthropicStop);
    const point = insertionPoint >= 0 ? insertionPoint : anthropicStop;
    const prefix = point > 0 && body[point - 1] !== "\n" ? "\n\n" : "";
    const block = [
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index, content_block: { type: "text", text: "" } })}`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index, delta: { type: "text_delta", text: `\n\n${warningText}` } })}`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index })}`,
      "",
    ].join("\n\n");
    return { body: `${body.slice(0, point)}${prefix}${block}${body.slice(point)}`, appended: true };
  }

  const blocks = body.split(/\r?\n\r?\n/);
  const doneIndex = blocks.findIndex((block) => /^data:\s*\[DONE\]\s*$/m.test(block));
  if (doneIndex >= 0) {
    let insertionIndex = doneIndex;
    for (let index = doneIndex - 1; index >= 0; index -= 1) {
      if (/"finish_reason"\s*:\s*"/.test(blocks[index])) insertionIndex = index;
    }
    blocks.splice(insertionIndex, 0, `data: ${JSON.stringify({
      choices: [{ index: 0, delta: { content: `\n\n${warningText}` }, finish_reason: null }],
    })}`);
    return { body: blocks.join("\n\n"), appended: true };
  }

  return { body, appended: false };
}

export async function appendCompactWarning(response: Response, warningText: string): Promise<CompactWarningResult> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok) {
    return { response, appended: false };
  }

  if (contentType.includes("text/event-stream")) {
    const result = appendToSse(await response.text(), warningText);
    return {
      appended: result.appended,
      response: new Response(result.body, {
        status: response.status,
        statusText: response.statusText,
        headers: replayHeaders(response.headers, "text/event-stream; charset=utf-8"),
      }),
    };
  }

  if (!contentType.includes("application/json")) {
    return { response, appended: false };
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const appended = appendToAnthropicContent(payload, warningText) || appendToOpenAiContent(payload, warningText);

  if (!appended) {
    return {
      appended: false,
      response: new Response(JSON.stringify(payload), {
        status: response.status,
        statusText: response.statusText,
        headers: replayHeaders(response.headers, "application/json; charset=utf-8"),
      }),
    };
  }

  return {
    appended: true,
    response: new Response(JSON.stringify(payload), {
      status: response.status,
      statusText: response.statusText,
      headers: replayHeaders(response.headers, "application/json; charset=utf-8"),
    }),
  };
}
