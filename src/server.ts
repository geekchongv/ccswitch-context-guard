import http from "node:http";
import { Readable } from "node:stream";
import { AppConfig, ChatCompletionRequest } from "./types.js";
import { Logger } from "./logger.js";
import { Orchestrator } from "./orchestrator.js";
import { UpstreamClient } from "./upstream-client.js";

async function readRawBody(request: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  return Buffer.concat(chunks);
}

function writeJson(response: http.ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
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

export function createServer(config: AppConfig, logger: Logger, orchestrator: Orchestrator): http.Server {
  const upstreamClient = new UpstreamClient(config.upstream);

  return http.createServer(async (request, response) => {
    try {
      const routeWithQuery = request.url ?? "/";
      const routePath = routeWithQuery.split("?")[0] ?? "/";

      if (request.method === "GET" && routePath === "/health") {
        writeJson(response, 200, {
          ok: true,
          service: "ccproxy-agent",
          upstream: config.upstream.baseUrl,
        });
        return;
      }

      const rawBody = request.method === "GET" || request.method === "HEAD" ? Buffer.alloc(0) : await readRawBody(request);

      if (request.method === "POST" && isJsonRequest(request) && isAiRoute(config, routePath)) {
        logger.info("识别为AI请求，准备进入编排层", {
          routePath,
          method: request.method,
        });
        const parsed = JSON.parse(rawBody.toString("utf8")) as ChatCompletionRequest;
        const upstreamResponse = await orchestrator.handle(routePath, parsed);
        await pipeUpstreamResponse(upstreamResponse, response);
        return;
      }

      const forwardedHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        if (typeof value === "string" && key.toLowerCase() !== "host") {
          forwardedHeaders[key] = value;
        }
      }

      const upstreamResponse = await upstreamClient.forward(routeWithQuery, {
        method: request.method ?? "GET",
        headers: forwardedHeaders,
        body: rawBody.length > 0 ? rawBody.toString("utf8") : undefined,
      });

      logger.info("普通透传请求已转发到上游", {
        routePath,
        method: request.method ?? "GET",
        status: upstreamResponse.status,
      });

      await pipeUpstreamResponse(upstreamResponse, response);
    } catch (error) {
      logger.error("Request handling failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      writeJson(response, 500, {
        error: "ccproxy-agent internal error",
      });
    }
  });
}
