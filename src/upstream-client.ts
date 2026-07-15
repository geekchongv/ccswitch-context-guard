import { setTimeout as delay } from "node:timers/promises";
import { UpstreamConfig } from "./types.js";
import { Logger } from "./logger.js";

export class UpstreamClient {
  private activeRequests = 0;
  private readonly waiters: Array<() => void> = [];
  private concurrencyLimit: number;
  private cooldownUntil = 0;
  private retryTail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly config: UpstreamConfig,
    private readonly logger?: Logger,
  ) {
    this.concurrencyLimit = Math.max(1, config.maxConcurrentRequests ?? 2);
  }

  private async acquire(): Promise<void> {
    if (this.activeRequests < this.concurrencyLimit) {
      this.activeRequests += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    while (this.waiters.length > 0 && this.activeRequests < this.concurrencyLimit) {
      this.activeRequests += 1;
      this.waiters.shift()?.();
      break;
    }
  }

  private async waitForCooldown(): Promise<void> {
    const remaining = this.cooldownUntil - Date.now();
    if (remaining > 0) await delay(remaining);
  }

  private retryDelayMs(response: Response): number {
    const fallback = Math.max(0, this.config.rateLimitFallbackDelayMs ?? 60_000);
    const header = response.headers.get("retry-after")?.trim();
    if (!header) return fallback;
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 300_000);
    const date = Date.parse(header);
    return Number.isFinite(date) ? Math.min(Math.max(0, date - Date.now()), 300_000) : fallback;
  }

  private async fetchOnce(routePath: string, init: {
    method: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      return await fetch(`${this.config.baseUrl}${routePath}`, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async serializedRateLimitRetry(operation: () => Promise<Response>): Promise<Response> {
    let releaseRetry!: () => void;
    const previous = this.retryTail;
    this.retryTail = new Promise<void>((resolve) => { releaseRetry = resolve; });
    await previous;
    try {
      await this.waitForCooldown();
      return await operation();
    } finally {
      releaseRetry();
    }
  }

  public async forward(
    routePath: string,
    init: {
      method: string;
      headers?: Record<string, string>;
      body?: string;
    },
  ): Promise<Response> {
    await this.acquire();
    try {
      await this.waitForCooldown();
      let response = await this.fetchOnce(routePath, init);

      if (response.status === 429 && (this.config.adaptiveRateLimit ?? true)) {
        const retryDelayMs = this.retryDelayMs(response);
        this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + retryDelayMs);
        this.concurrencyLimit = 1;
        this.logger?.warn("Upstream rate limit detected", {
          routePath,
          retryDelayMs,
          concurrencyLimit: this.concurrencyLimit,
          retryAfter: response.headers.get("retry-after"),
        });

        const maxRetries = Math.min(3, Math.max(0, this.config.rateLimitMaxRetries ?? 1));
        for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
          response = await this.serializedRateLimitRetry(() => this.fetchOnce(routePath, init));
          if (response.status !== 429) {
            this.logger?.info("Upstream rate limit retry succeeded", { routePath, status: response.status, attempt });
            break;
          }
          const nextDelayMs = this.retryDelayMs(response);
          this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + nextDelayMs);
          this.logger?.warn("Upstream rate limit retry still blocked", { routePath, retryDelayMs: nextDelayMs, attempt });
        }
      }

      if (response.status >= 500) {
        await delay(250);
      }

      return response;
    } finally {
      this.release();
    }
  }

  public async postJson(routePath: string, payload: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return this.forward(routePath, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  }
}
