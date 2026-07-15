import http from "node:http";
import { Readable } from "node:stream";
import { AppConfig, ChatCompletionRequest } from "./types.js";
import { Logger } from "./logger.js";
import { Orchestrator } from "./orchestrator.js";
import { UpstreamClient } from "./upstream-client.js";
import { DashboardStatus, renderDashboard, renderNotFound, serializeLogs } from "./dashboard.js";
import { HookObserver } from "./hook-observer.js";

class RequestBodyTooLargeError extends Error {
  public constructor(public readonly maxBytes: number) {
    super(`request body exceeds ${maxBytes} bytes`);
  }
}

async function readRawBody(request: http.IncomingMessage, maxBytes = Number.POSITIVE_INFINITY): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      throw new RequestBodyTooLargeError(maxBytes);
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

function writeJson(response: http.ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function writeHtml(response: http.ServerResponse, statusCode: number, body: string): void {
  response.writeHead(statusCode, { "content-type": "text/html; charset=utf-8" });
  response.end(body);
}

function writeText(response: http.ServerResponse, statusCode: number, body: string): void {
  response.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
  response.end(body);
}

function isJsonRequest(request: http.IncomingMessage): boolean {
  return (request.headers["content-type"] ?? "").includes("application/json");
}

function isAiRoute(config: AppConfig, routePath: string): boolean {
  const routes = config.upstream.aiRoutes ?? [config.upstream.chatPath];
  return routes.some((route) => routePath === route || routePath.endsWith(route));
}

function copyResponseHeaders(upstreamResponse: Response, response: http.ServerResponse): void {
  const headers: Record<string, string> = {};
  upstreamResponse.headers.forEach((value, key) => {
    headers[key] = value;
  });
  response.writeHead(upstreamResponse.status, headers);
}

function getForwardedHeaders(request: http.IncomingMessage): Record<string, string> {
  const forwardedHeaders: Record<string, string> = {};
  const blockedHeaders = new Set([
    "host",
    "content-length",
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]);

  for (const [key, value] of Object.entries(request.headers)) {
    const normalizedKey = key.toLowerCase();
    if (typeof value === "string" && !blockedHeaders.has(normalizedKey)) {
      forwardedHeaders[key] = value;
    }
  }

  return forwardedHeaders;
}

async function pipeUpstreamResponse(upstreamResponse: Response, response: http.ServerResponse): Promise<void> {
  copyResponseHeaders(upstreamResponse, response);
  const contentType = upstreamResponse.headers.get("content-type") ?? "";

  if (!contentType.includes("text/event-stream")) {
    const buffer = Buffer.from(await upstreamResponse.arrayBuffer());
    response.end(buffer);
    return;
  }

  if (!upstreamResponse.body) {
    response.end();
    return;
  }

  const readable = Readable.fromWeb(upstreamResponse.body as unknown as import("node:stream/web").ReadableStream);
  await new Promise<void>((resolve, reject) => {
    readable.on("error", reject);
    response.on("error", reject);
    response.on("finish", resolve);
    readable.pipe(response);
  });
}

export interface ServerOptions {
  getStatus?: () => DashboardStatus;
  requestShutdown?: (reason: string) => void;
  hookObserver?: HookObserver;
}

function isLoopbackRequest(request: http.IncomingMessage): boolean {
  const address = request.socket.remoteAddress ?? "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export function createServer(
  config: AppConfig,
  logger: Logger,
  orchestrator: Orchestrator,
  options: ServerOptions = {},
): http.Server {
  const upstreamClient = new UpstreamClient(config.upstream, logger);

  return http.createServer(async (request, response) => {
    try {
      const routeWithQuery = request.url ?? "/";
      const routePath = routeWithQuery.split("?")[0] ?? "/";

      if (request.method === "GET" && config.ui.enabled && routePath === "/") {
        writeHtml(response, 200, renderDashboard());
        return;
      }

      if (request.method === "GET" && config.ui.enabled && routePath === "/status") {
        writeJson(response, 200, options.getStatus?.() ?? {
          version: "unknown",
          listen: `http://${config.server.host}:${config.server.port}`,
          upstream: `${config.upstream.baseUrl}${config.upstream.chatPath}`,
          upstreamSource: "configured",
          patcherApplied: false,
          startedAt: new Date().toISOString(),
          pid: process.pid,
        });
        return;
      }

      if (request.method === "GET" && config.ui.enabled && routePath === "/logs") {
        writeJson(response, 200, serializeLogs(logger.snapshot()));
        return;
      }

      if (request.method === "POST" && config.ui.enabled && routePath === "/shutdown") {
        if (!isLoopbackRequest(request)) {
          writeJson(response, 403, { ok: false, error: "shutdown is only allowed from localhost" });
          return;
        }
        writeJson(response, 202, { ok: true, message: "shutdown requested" });
        setTimeout(() => options.requestShutdown?.("dashboard"), 25);
        return;
      }

      if (request.method === "GET" && routePath === "/health") {
        writeJson(response, 200, {
          ok: true,
          service: "ccproxy-agent",
          upstream: config.upstream.baseUrl,
          dashboard: config.ui.enabled ? `http://${config.server.host}:${config.server.port}/` : null,
        });
        return;
      }

      if (request.method === "POST" && routePath.startsWith("/hooks/")) {
        if (!isLoopbackRequest(request) || !options.hookObserver) {
          writeJson(response, 403, { ok: false });
          return;
        }
        if (request.headers["x-ccproxy-hook-token"] !== options.hookObserver.token) {
          writeJson(response, 401, { ok: false });
          return;
        }

        const hookBody = await readRawBody(request, 1_000_000);
        options.hookObserver.observe(JSON.parse(hookBody.toString("utf8")) as Record<string, unknown>);
        response.writeHead(204);
        response.end();
        return;
      }

      const bodyLimit = Math.max(1_000_000, config.server.maxRequestBodyBytes ?? 64_000_000);
      const rawBody = request.method === "GET" || request.method === "HEAD"
        ? Buffer.alloc(0)
        : await readRawBody(request, bodyLimit);

      if (request.method === "POST" && isJsonRequest(request) && isAiRoute(config, routePath)) {
        logger.debug("识别为AI请求，准备进入编排层", {
          routePath,
          method: request.method,
        });
        const parsed = JSON.parse(rawBody.toString("utf8")) as ChatCompletionRequest;
        const upstreamResponse = await orchestrator.handle(routePath, parsed, getForwardedHeaders(request));
        await pipeUpstreamResponse(upstreamResponse, response);
        return;
      }

      const forwardedHeaders = getForwardedHeaders(request);

      const upstreamResponse = await upstreamClient.forward(routeWithQuery, {
        method: request.method ?? "GET",
        headers: forwardedHeaders,
        body: rawBody.length > 0 ? rawBody.toString("utf8") : undefined,
      });

      logger.debug("普通透传请求已转发到上游", {
        routePath,
        method: request.method ?? "GET",
        status: upstreamResponse.status,
      });

      await pipeUpstreamResponse(upstreamResponse, response);
    } catch (error) {
      if (request.method === "GET" && (request.url ?? "/").split("?")[0] === "/favicon.ico") {
        writeText(response, 404, renderNotFound("/favicon.ico"));
        return;
      }
      if (error instanceof RequestBodyTooLargeError) {
        writeJson(response, 413, {
          error: "request body too large",
          maxBytes: error.maxBytes,
        });
        return;
      }
      logger.error("Request handling failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      writeJson(response, 500, {
        error: "ccproxy-agent internal error",
      });
    }
  });
}
