import { setTimeout as delay } from "node:timers/promises";
import { UpstreamConfig } from "./types.js";

export class UpstreamClient {
  public constructor(private readonly config: UpstreamConfig) {}

  public async forward(
    routePath: string,
    init: {
      method: string;
      headers?: Record<string, string>;
      body?: string;
    },
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(`${this.config.baseUrl}${routePath}`, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: controller.signal,
      });

      if (response.status >= 500) {
        await delay(250);
      }

      return response;
    } finally {
      clearTimeout(timeout);
    }
  }

  public async postJson(routePath: string, payload: unknown): Promise<Response> {
    return this.forward(routePath, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  }
}
