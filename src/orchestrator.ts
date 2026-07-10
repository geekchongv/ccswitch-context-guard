import { randomUUID } from "node:crypto";
import { AppConfig, ChatCompletionRequest, OrchestrationRecord } from "./types.js";
import { Logger } from "./logger.js";
import { SessionStore } from "./session-store.js";
import { assessBudget, estimateRequestTokens } from "./token-estimator.js";
import { compactRequest } from "./compactor.js";
import { enrichRequestWithVision, hasImageInput } from "./modality-router.js";
import { buildChunkPlan, buildSynthesisRequest } from "./chunking.js";
import { UpstreamClient } from "./upstream-client.js";
import { appendCompactWarning } from "./response-warning.js";

interface MaxTokensAdjustment {
  request: ChatCompletionRequest;
  adjusted: boolean;
  originalMaxTokens: number;
  adjustedMaxTokens: number;
  reason: "proactive_budget" | "upstream_context_error";
}

interface ContextLimitError {
  detected: boolean;
  contextLimit?: number;
  inputTokens?: number;
  requestedOutputTokens?: number;
  message: string;
}

function extractAssistantText(payload: Record<string, unknown>): string {
  if (typeof payload.content === "string") {
    return payload.content;
  }

  if (Array.isArray(payload.content)) {
    const parts = payload.content
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

    if (parts.length > 0) {
      return parts.join("\n");
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

  return JSON.stringify(payload);
}

function getRequestedOutputTokens(request: ChatCompletionRequest, fallback: number): number {
  return request.max_completion_tokens ?? request.max_tokens ?? fallback;
}

function setRequestedOutputTokens(request: ChatCompletionRequest, value: number): ChatCompletionRequest {
  const nextRequest = { ...request };
  const roundedValue = Math.max(1, Math.floor(value));

  if (typeof request.max_completion_tokens === "number") {
    nextRequest.max_completion_tokens = roundedValue;
    return nextRequest;
  }

  nextRequest.max_tokens = roundedValue;
  return nextRequest;
}

function cloneHeaders(headers: Headers): Headers {
  const cloned = new Headers();
  headers.forEach((value, key) => cloned.set(key, value));
  return cloned;
}

function parseContextLimitError(status: number, bodyText: string): ContextLimitError {
  if (status !== 400 || !/maximum context length|context length|input_tokens/i.test(bodyText)) {
    return {
      detected: false,
      message: bodyText,
    };
  }

  const contextLimit = bodyText.match(/maximum context length is\s+(\d+)/i)?.[1];
  const requestedOutput = bodyText.match(/requested\s+(\d+)\s+output tokens/i)?.[1];
  const inputTokens = bodyText.match(/prompt contains at least\s+(\d+)\s+input tokens/i)?.[1];

  return {
    detected: true,
    contextLimit: contextLimit ? Number(contextLimit) : undefined,
    inputTokens: inputTokens ? Number(inputTokens) : undefined,
    requestedOutputTokens: requestedOutput ? Number(requestedOutput) : undefined,
    message: bodyText,
  };
}

async function inspectContextLimitResponse(response: Response): Promise<{
  contextError: ContextLimitError;
  replayResponse: Response;
}> {
  const bodyText = await response.text();
  const headers = cloneHeaders(response.headers);
  const contextError = parseContextLimitError(response.status, bodyText);

  return {
    contextError,
    replayResponse: new Response(bodyText, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
  };
}

/**
 * 消费上游错误响应，截取 body 前若干字符用于诊断日志，同时返回一个可重新读取的 Response 供下游回传。
 * 仅用于 !ok 的响应；成功响应不应走这里。
 */
async function captureUpstreamError(
  response: Response,
  previewBytes = 2000,
): Promise<{ replayResponse: Response; bodyPreview: string }> {
  const bodyText = await response.text();
  const headers = cloneHeaders(response.headers);

  return {
    bodyPreview: bodyText.slice(0, previewBytes),
    replayResponse: new Response(bodyText, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
  };
}

export class Orchestrator {
  private readonly upstreamClient: UpstreamClient;

  public constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly sessionStore: SessionStore,
  ) {
    this.upstreamClient = new UpstreamClient(config.upstream);
  }

  public async handle(
    routePath: string,
    request: ChatCompletionRequest,
    upstreamHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const requestId = randomUUID();
    const timestamp = new Date().toISOString();

    this.logger.info("收到请求", { requestId, routePath });

    const withVision = await enrichRequestWithVision(request, this.config.vision);
    let workingRequest = withVision.request;
    let compacted = false;
    let compactWarning = false;
    let chunked = false;
    let maxTokensReduced = false;
    let retriedAfterContextError = false;

    let budget = assessBudget(
      workingRequest,
      this.config.tokenPolicy.compactThreshold,
      this.config.tokenPolicy.hardLimit,
      this.config.tokenPolicy.responseReserve,
      this.config.tokenPolicy.safetyMargin,
    );

    this.logger.debug("Token预算评估", {
      requestId,
      routePath,
      inputTokens: budget.estimate.inputTokens,
      expectedOutputTokens: budget.estimate.expectedOutputTokens,
      totalTokens: budget.estimate.totalTokens,
      decision: budget.decision,
      visionUsed: withVision.vision.used,
    });

    if (withVision.vision.used) {
      this.logger.info("检测到图片并完成预处理", {
        requestId,
        imageCount: withVision.vision.imageCount,
        summaryPreview: withVision.vision.summary?.slice(0, 160) ?? "",
      });
    } else if (this.config.vision.enabled && hasImageInput(request)) {
      // 视觉已启用、请求里疑似带图，却没能识别出可处理的图片 —— 通常是上游格式未覆盖。
      this.logger.warn("请求疑似包含图片但视觉预处理未命中，原始图片将直通下游", {
        requestId,
        routePath,
        visionUsed: false,
      });
    }

    const proactiveAdjustment = this.reduceMaxTokensIfNeeded(workingRequest, budget, "proactive_budget");
    if (proactiveAdjustment.adjusted) {
      workingRequest = proactiveAdjustment.request;
      maxTokensReduced = true;
      budget = assessBudget(
        workingRequest,
        this.config.tokenPolicy.compactThreshold,
        this.config.tokenPolicy.hardLimit,
        this.config.tokenPolicy.responseReserve,
        this.config.tokenPolicy.safetyMargin,
      );
      this.logger.warn("已自动降低max_tokens，避免总token撞上上下文硬上限", {
        requestId,
        routePath,
        reason: proactiveAdjustment.reason,
        originalMaxTokens: proactiveAdjustment.originalMaxTokens,
        adjustedMaxTokens: proactiveAdjustment.adjustedMaxTokens,
        inputTokens: budget.estimate.inputTokens,
        totalTokensAfterAdjustment: budget.estimate.totalTokens,
        hardLimit: this.config.tokenPolicy.hardLimit,
        safetyMargin: this.config.tokenPolicy.safetyMargin,
      });
    }

    if (budget.decision === "compact_required") {
      if (this.config.tokenPolicy.compactMode === "proxy") {
        const beforeCompactTokens = budget.estimate.totalTokens;
        workingRequest = compactRequest(workingRequest);
        compacted = true;
        budget = assessBudget(
          workingRequest,
          this.config.tokenPolicy.compactThreshold,
          this.config.tokenPolicy.hardLimit,
          this.config.tokenPolicy.responseReserve,
          this.config.tokenPolicy.safetyMargin,
        );
        this.logger.warn("已触发代理上下文压缩", {
          requestId,
          routePath,
          beforeCompactTokens,
          afterCompactTokens: budget.estimate.totalTokens,
          postCompactDecision: budget.decision,
        });
      } else {
        compactWarning = true;
        this.logger.warn("已触发compact提醒模式", {
          requestId,
          routePath,
          totalTokens: budget.estimate.totalTokens,
        });
      }
    } else {
      this.logger.debug("未触发上下文压缩", {
        requestId,
        routePath,
        totalTokens: budget.estimate.totalTokens,
      });
    }

    if (budget.decision === "chunk_required") {
      chunked = true;
      this.logger.warn("已触发分块执行", {
        requestId,
        routePath,
        totalTokens: budget.estimate.totalTokens,
        chunkTarget: this.config.tokenPolicy.chunkTarget,
      });
      const chunkHardCap =
        this.config.tokenPolicy.hardLimit -
        this.config.tokenPolicy.safetyMargin -
        this.config.tokenPolicy.responseReserve;
      const chunkPlan = buildChunkPlan(
        workingRequest,
        this.config.tokenPolicy.chunkTarget,
        chunkHardCap,
      );
      const chunkOutputs: string[] = [];

      this.logger.debug("分块计划已生成", {
        requestId,
        routePath,
        chunkCount: chunkPlan.length,
        chunkHardCap,
      });

      for (const [index, chunkRequest] of chunkPlan.entries()) {
        const chunkInputTokens = estimateRequestTokens(
          chunkRequest,
          this.config.tokenPolicy.responseReserve,
        ).inputTokens;
        if (chunkInputTokens > chunkHardCap) {
          // 拆分器应保证不会发生;此日志为回归哨兵,一旦出现说明拆分逻辑有缺陷。
          this.logger.warn("分块估算超出硬上限", {
            requestId,
            routePath,
            chunkIndex: index + 1,
            chunkInputTokens,
            chunkHardCap,
          });
        } else {
          this.logger.debug("分块估算大小", {
            requestId,
            routePath,
            chunkIndex: index + 1,
            chunkCount: chunkPlan.length,
            chunkInputTokens,
            chunkHardCap,
          });
        }
        const chunkResponse = await this.upstreamClient.postJson(routePath, chunkRequest, upstreamHeaders);
        if (!chunkResponse.ok) {
          const { replayResponse, bodyPreview } = await captureUpstreamError(chunkResponse);
          this.logger.error("分块执行失败", {
            requestId,
            routePath,
            chunkIndex: index + 1,
            status: chunkResponse.status,
            upstreamBody: bodyPreview,
          });
          this.saveRecord({
            requestId,
            timestamp,
            routePath,
            budget,
            compacted,
            compactWarning,
            chunked,
            maxTokensReduced,
            retriedAfterContextError,
            vision: withVision.vision,
          });
          return replayResponse;
        }

        const chunkPayload = (await chunkResponse.json()) as Record<string, unknown>;
        chunkOutputs.push(extractAssistantText(chunkPayload));
        this.logger.debug("分块执行完成", {
          requestId,
          routePath,
          chunkIndex: index + 1,
          chunkCount: chunkPlan.length,
        });
      }

      const synthesisRequest = buildSynthesisRequest(workingRequest, chunkOutputs, chunkHardCap);
      const synthesisResponse = await this.upstreamClient.postJson(routePath, synthesisRequest, upstreamHeaders);

      this.logger.info("请求完成", {
        requestId,
        routePath,
        status: synthesisResponse.status,
        chunked,
        visionUsed: withVision.vision.used,
        inputTokens: budget.estimate.inputTokens,
      });

      this.saveRecord({
        requestId,
        timestamp,
        routePath,
        budget,
        compacted,
        compactWarning,
        chunked,
        maxTokensReduced,
        retriedAfterContextError,
        vision: withVision.vision,
      });

      return synthesisResponse;
    }

    let response = await this.upstreamClient.postJson(routePath, workingRequest, upstreamHeaders);

    if (this.config.tokenPolicy.retryOnContextError && !response.ok) {
      const inspected = await inspectContextLimitResponse(response);
      response = inspected.replayResponse;

      if (inspected.contextError.detected) {
        const retryAdjustment = this.reduceMaxTokensAfterContextError(
          workingRequest,
          inspected.contextError,
        );

        this.logger.warn("上游返回上下文超限错误，已解析错误详情", {
          requestId,
          routePath,
          status: response.status,
          contextLimit: inspected.contextError.contextLimit,
          inputTokens: inspected.contextError.inputTokens,
          canRetry: retryAdjustment.adjusted,
        });

        if (retryAdjustment.adjusted) {
          workingRequest = retryAdjustment.request;
          maxTokensReduced = true;
          retriedAfterContextError = true;
          this.logger.warn("已降低max_tokens并自动重试一次", {
            requestId,
            routePath,
            originalMaxTokens: retryAdjustment.originalMaxTokens,
            adjustedMaxTokens: retryAdjustment.adjustedMaxTokens,
          });
          response = await this.upstreamClient.postJson(routePath, workingRequest, upstreamHeaders);
        }
      }
    }

    // 失败响应：补记上游 body 供诊断，并确保回传一个可重新读取的 Response。
    if (!response.ok) {
      const { replayResponse, bodyPreview } = await captureUpstreamError(response);
      response = replayResponse;
      this.logger.warn("上游返回非成功状态", {
        requestId,
        routePath,
        status: response.status,
        chunked,
        visionUsed: withVision.vision.used,
        inputTokens: budget.estimate.inputTokens,
        upstreamBody: bodyPreview,
      });
    }

    if (compactWarning) {
      response = await appendCompactWarning(response, this.config.tokenPolicy.compactWarningText);
      this.logger.warn("已在模型输出末尾追加compact提醒", {
        requestId,
        routePath,
      });
    }

    if (response.ok) {
      this.logger.info("请求完成", {
        requestId,
        routePath,
        status: response.status,
        compacted,
        compactWarning,
        chunked,
        maxTokensReduced,
        visionUsed: withVision.vision.used,
        inputTokens: budget.estimate.inputTokens,
      });
    }

    this.saveRecord({
      requestId,
      timestamp,
      routePath,
      budget,
      compacted,
      compactWarning,
      chunked,
      maxTokensReduced,
      retriedAfterContextError,
      vision: withVision.vision,
    });

    return response;
  }

  private saveRecord(record: OrchestrationRecord): void {
    this.sessionStore.saveRecord(record);
    this.logger.debug("已保存会话编排记录", {
      requestId: record.requestId,
      routePath: record.routePath,
      compacted: record.compacted,
      compactWarning: record.compactWarning,
      chunked: record.chunked,
      maxTokensReduced: record.maxTokensReduced,
      retriedAfterContextError: record.retriedAfterContextError,
      visionUsed: record.vision.used,
    });
  }

  private reduceMaxTokensIfNeeded(
    request: ChatCompletionRequest,
    budget: ReturnType<typeof assessBudget>,
    reason: MaxTokensAdjustment["reason"],
    hardLimit = this.config.tokenPolicy.hardLimit,
  ): MaxTokensAdjustment {
    const originalMaxTokens = getRequestedOutputTokens(request, this.config.tokenPolicy.responseReserve);
    const effectiveHardLimit = hardLimit - this.config.tokenPolicy.safetyMargin;
    const availableOutputTokens = effectiveHardLimit - budget.estimate.inputTokens;
    const adjustedMaxTokens = Math.floor(availableOutputTokens);

    if (
      !this.config.tokenPolicy.autoReduceMaxTokens ||
      adjustedMaxTokens >= originalMaxTokens ||
      adjustedMaxTokens < this.config.tokenPolicy.minOutputTokens
    ) {
      return {
        request,
        adjusted: false,
        originalMaxTokens,
        adjustedMaxTokens: originalMaxTokens,
        reason,
      };
    }

    return {
      request: setRequestedOutputTokens(request, adjustedMaxTokens),
      adjusted: true,
      originalMaxTokens,
      adjustedMaxTokens,
      reason,
    };
  }

  private reduceMaxTokensAfterContextError(
    request: ChatCompletionRequest,
    contextError: ContextLimitError,
  ): MaxTokensAdjustment {
    if (typeof contextError.inputTokens === "number" && typeof contextError.contextLimit === "number") {
      const originalMaxTokens = getRequestedOutputTokens(request, this.config.tokenPolicy.responseReserve);
      const safetyAvailableOutputTokens = Math.floor(
        contextError.contextLimit - this.config.tokenPolicy.safetyMargin - contextError.inputTokens,
      );
      const absoluteAvailableOutputTokens = Math.floor(contextError.contextLimit - contextError.inputTokens - 1);
      const adjustedMaxTokens =
        safetyAvailableOutputTokens >= this.config.tokenPolicy.minOutputTokens
          ? safetyAvailableOutputTokens
          : Math.max(1, absoluteAvailableOutputTokens);

      if (adjustedMaxTokens < originalMaxTokens && contextError.inputTokens < contextError.contextLimit) {
        return {
          request: setRequestedOutputTokens(request, adjustedMaxTokens),
          adjusted: true,
          originalMaxTokens,
          adjustedMaxTokens,
          reason: "upstream_context_error",
        };
      }
    }

    const syntheticBudget = {
      estimate: {
        inputTokens: contextError.inputTokens ?? assessBudget(
          request,
          this.config.tokenPolicy.compactThreshold,
          this.config.tokenPolicy.hardLimit,
          this.config.tokenPolicy.responseReserve,
          this.config.tokenPolicy.safetyMargin,
        ).estimate.inputTokens,
        expectedOutputTokens: contextError.requestedOutputTokens ?? getRequestedOutputTokens(
          request,
          this.config.tokenPolicy.responseReserve,
        ),
        totalTokens: 0,
      },
      decision: "safe" as const,
    };

    return this.reduceMaxTokensIfNeeded(
      request,
      syntheticBudget,
      "upstream_context_error",
      contextError.contextLimit ?? this.config.tokenPolicy.hardLimit,
    );
  }
}
