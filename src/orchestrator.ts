import { randomUUID } from "node:crypto";
import { AppConfig, ChatCompletionRequest, OrchestrationRecord } from "./types.js";
import { Logger } from "./logger.js";
import { SessionStore } from "./session-store.js";
import { assessBudget, estimateRequestTokens } from "./token-estimator.js";
import { compactRequest } from "./compactor.js";
import { enrichRequestWithVision, forceTextOnlyRequest, getVisionInputDiagnostics } from "./modality-router.js";
import { buildChunkPlan, buildSynthesisRequest } from "./chunking.js";
import { UpstreamClient } from "./upstream-client.js";
import { appendCompactWarning } from "./response-warning.js";
import { hasAgentToolProtocol } from "./agent-protocol.js";
import { clearOldToolResults, truncateNewestToolResult } from "./tool-result-clearer.js";

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

const PROVIDER_CONTEXT_RETRY_TOKEN_BUFFER = 256;

function resolveToolResultPolicy(config: AppConfig): { trigger: number; target: number; keepRecent: number } {
  const maximumTrigger = Math.max(
    1,
    config.tokenPolicy.hardLimit - config.tokenPolicy.safetyMargin - config.tokenPolicy.minOutputTokens,
  );
  const trigger = Math.max(
    1,
    Math.min(config.tokenPolicy.toolResultClearTrigger ?? 170_000, maximumTrigger),
  );
  const targetGap = Math.max(1000, config.tokenPolicy.responseReserve);
  const target = Math.max(
    1,
    Math.min(config.tokenPolicy.toolResultClearTarget ?? 150_000, trigger - targetGap),
  );
  return {
    trigger,
    target,
    keepRecent: Math.max(0, Math.floor(config.tokenPolicy.toolResultKeepRecent ?? 3)),
  };
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
  cloned.delete("content-length");
  cloned.delete("content-encoding");
  cloned.delete("transfer-encoding");
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

function isNonMultimodalModelError(status: number, bodyText: string): boolean {
  return status === 400 && /not\s+a\s+multimodal\s+model|does\s+not\s+support\s+(?:image|vision|multimodal)/i.test(bodyText);
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

interface UpstreamUsage {
  inputTokens?: number;
  outputTokens?: number;
  replayResponse: Response;
}

/**
 * 消费成功响应 body，提取上游报告的 usage token 计数，重建一个可重新读取的 Response 返回。
 * 用于和代理本地估算值对照，定位"代理估算 vs 上游实际"的差距来源。
 * SSE 流 / 非 JSON / 解析失败时原样返回，inputTokens 留 undefined。
 */
async function captureUpstreamUsage(response: Response): Promise<UpstreamUsage> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok || !contentType.includes("application/json") || contentType.includes("text/event-stream")) {
    return { replayResponse: response };
  }

  let payload: Record<string, unknown>;
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    return { replayResponse: response };
  }

  const usage = payload.usage as Record<string, unknown> | undefined;
  const inputTokens = usage?.input_tokens ?? usage?.prompt_tokens;
  const outputTokens = usage?.output_tokens ?? usage?.completion_tokens;

  return {
    inputTokens: typeof inputTokens === "number" ? inputTokens : undefined,
    outputTokens: typeof outputTokens === "number" ? outputTokens : undefined,
    replayResponse: new Response(JSON.stringify(payload), {
      status: response.status,
      statusText: response.statusText,
      headers: cloneHeaders(response.headers),
    }),
  };
}

/**
 * 收集请求过程中的非默认 flag/计数器，仅在出现非默认值时才纳入。
 * 成功路径日志默认只打 token 对照，避免每次都拖着全 false 的噪声字段。
 */
function collectRequestFlags(flags: {
  compacted: boolean;
  compactWarning: boolean;
  chunked: boolean;
  maxTokensReduced: boolean;
  visionUsed: boolean;
  toolResultsCleared: number;
  toolResultTokensCleared: number;
}): Record<string, unknown> {
  const active: Record<string, unknown> = {};
  if (flags.compacted) active.compacted = true;
  if (flags.compactWarning) active.compactWarning = true;
  if (flags.chunked) active.chunked = true;
  if (flags.maxTokensReduced) active.maxTokensReduced = true;
  if (flags.visionUsed) active.visionUsed = true;
  if (flags.toolResultsCleared > 0) active.toolResultsCleared = flags.toolResultsCleared;
  if (flags.toolResultTokensCleared > 0) active.toolResultTokensCleared = flags.toolResultTokensCleared;
  return active;
}

export class Orchestrator {
  private readonly upstreamClient: UpstreamClient;

  public constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly sessionStore: SessionStore,
  ) {
    this.upstreamClient = new UpstreamClient(config.upstream, logger);
  }

  private async postStatelessWithContextRetry(
    routePath: string,
    request: ChatCompletionRequest,
    upstreamHeaders: Record<string, string>,
    requestId: string,
    phase: string,
  ): Promise<{ response: Response; retried: boolean }> {
    const firstResponse = await this.upstreamClient.postJson(routePath, request, upstreamHeaders);
    if (firstResponse.ok || !this.config.tokenPolicy.retryOnContextError) {
      return { response: firstResponse, retried: false };
    }

    const inspected = await inspectContextLimitResponse(firstResponse);
    if (!inspected.contextError.detected) {
      return { response: inspected.replayResponse, retried: false };
    }

    let retryRequest = compactRequest(request);
    const retryBudget = assessBudget(
      retryRequest,
      this.config.tokenPolicy.compactThreshold,
      this.config.tokenPolicy.hardLimit,
      this.config.tokenPolicy.responseReserve,
      this.config.tokenPolicy.safetyMargin,
    );
    const adjustment = this.reduceMaxTokensIfNeeded(
      retryRequest,
      retryBudget,
      "upstream_context_error",
      inspected.contextError.contextLimit ?? this.config.tokenPolicy.hardLimit,
    );
    retryRequest = adjustment.request;
    this.logger.warn("Retrying stateless phase after upstream context error", {
      requestId,
      routePath,
      phase,
      providerInputTokens: inspected.contextError.inputTokens,
      providerContextLimit: inspected.contextError.contextLimit,
      maxTokensReduced: adjustment.adjusted,
    });
    return {
      response: await this.upstreamClient.postJson(routePath, retryRequest, upstreamHeaders),
      retried: true,
    };
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
    const agentToolProtocol = hasAgentToolProtocol(workingRequest);
    let compacted = false;
    let compactWarning = false;
    let chunked = false;
    let maxTokensReduced = false;
    let retriedAfterContextError = false;
    let toolResultsCleared = 0;
    let toolResultTokensCleared = 0;

    if (agentToolProtocol && (this.config.tokenPolicy.toolResultClearingEnabled ?? true)) {
      const { trigger, target, keepRecent } = resolveToolResultPolicy(this.config);
      const inputTokens = estimateRequestTokens(
        workingRequest,
        this.config.tokenPolicy.responseReserve,
      ).inputTokens;
      if (inputTokens >= trigger) {
        const clearing = clearOldToolResults(workingRequest, target, keepRecent);
        if (clearing.applied) {
          workingRequest = clearing.request;
          toolResultsCleared += clearing.clearedResults;
          toolResultTokensCleared += clearing.estimatedTokensCleared;
          this.logger.warn("Cleared old Agent tool results before forwarding", {
            requestId,
            routePath,
            reason: "proactive_threshold",
            clearedResults: clearing.clearedResults,
            estimatedTokensCleared: clearing.estimatedTokensCleared,
            beforeInputTokens: clearing.beforeInputTokens,
            afterInputTokens: clearing.afterInputTokens,
            keepRecent,
            targetInputTokens: target,
          });
        }
      }
    }

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
    } else if (this.config.vision.enabled) {
      const visionDiagnostics = getVisionInputDiagnostics(request);
      // 视觉已启用、请求里疑似带图，却没能识别出可处理的图片 —— 通常是上游格式未覆盖。
      if (visionDiagnostics.imageLikePartCount > 0) {
        this.logger.warn("请求疑似包含图片但视觉预处理未命中，原始图片将直通下游", {
          requestId,
          routePath,
          visionUsed: false,
          ...visionDiagnostics,
        });
      }
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
      if (agentToolProtocol) {
        this.logger.warn("Agent tool session deferred to Claude native compact", {
          requestId,
          routePath,
          totalTokens: budget.estimate.totalTokens,
          compactThreshold: this.config.tokenPolicy.compactThreshold,
        });
      } else if (this.config.tokenPolicy.compactMode === "proxy") {
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

    if (budget.decision === "chunk_required" && !agentToolProtocol) {
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
      const synthesisResult = await this.postStatelessWithContextRetry(
        routePath,
        synthesisRequest,
        upstreamHeaders,
        requestId,
        "chunk_synthesis",
      );
      const synthesisResponse = synthesisResult.response;
      retriedAfterContextError ||= synthesisResult.retried;
      if (!synthesisResponse.ok) {
        const { replayResponse, bodyPreview } = await captureUpstreamError(synthesisResponse);
        this.logger.error("Chunk synthesis failed", {
          requestId,
          routePath,
          status: synthesisResponse.status,
          retriedAfterContextError: synthesisResult.retried,
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
      const synthesisUsage = await captureUpstreamUsage(synthesisResponse);

      this.logger.info("请求完成", {
        requestId,
        routePath,
        status: synthesisResponse.status,
        proxyInputTokens: budget.estimate.inputTokens,
        upstreamInputTokens: synthesisUsage.inputTokens,
        upstreamOutputTokens: synthesisUsage.outputTokens,
        ...collectRequestFlags({
          compacted,
          compactWarning,
          chunked,
          maxTokensReduced,
          visionUsed: withVision.vision.used,
          toolResultsCleared,
          toolResultTokensCleared,
        }),
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

      return synthesisUsage.replayResponse;
    }

    if (budget.decision === "chunk_required" && agentToolProtocol) {
      this.logger.warn("Skipped generic chunking for Agent tool protocol", {
        requestId,
        routePath,
        totalTokens: budget.estimate.totalTokens,
      });
    }

    let response = await this.upstreamClient.postJson(routePath, workingRequest, upstreamHeaders);

    if (this.config.tokenPolicy.retryOnContextError && !response.ok) {
      const inspected = await inspectContextLimitResponse(response);
      response = inspected.replayResponse;

      if (inspected.contextError.detected) {
        let toolResultRescueApplied = false;
        const beforeContextErrorCompactTokens = estimateRequestTokens(
          workingRequest,
          this.config.tokenPolicy.responseReserve,
        ).inputTokens;
        if (!agentToolProtocol) {
          const compactRetryRequest = compactRequest(workingRequest);
          const afterContextErrorCompactTokens = estimateRequestTokens(
            compactRetryRequest,
            this.config.tokenPolicy.responseReserve,
          ).inputTokens;
          if (
            afterContextErrorCompactTokens < beforeContextErrorCompactTokens &&
            (
              (inspected.contextError.inputTokens ?? beforeContextErrorCompactTokens) >= this.config.tokenPolicy.compactThreshold ||
              inspected.contextError.detected
            )
          ) {
            workingRequest = compactRetryRequest;
            compacted = true;
            budget = assessBudget(
              workingRequest,
              this.config.tokenPolicy.compactThreshold,
              this.config.tokenPolicy.hardLimit,
              this.config.tokenPolicy.responseReserve,
              this.config.tokenPolicy.safetyMargin,
            );
            this.logger.warn("上游返回上下文超限后已触发代理端压缩", {
              requestId,
              routePath,
              beforeCompactInputTokens: beforeContextErrorCompactTokens,
              afterCompactInputTokens: afterContextErrorCompactTokens,
              providerInputTokens: inspected.contextError.inputTokens,
              postCompactDecision: budget.decision,
            });
          }
        } else {
          // Rescue in two stages: clear older results first, then preserve bounded
          // head/tail evidence from the newest result instead of erasing it.
          const policy = resolveToolResultPolicy(this.config);
          const configuredTarget = policy.target;
          const currentInputTokens = estimateRequestTokens(workingRequest, 0).inputTokens;
          const providerInputTokens = inspected.contextError.inputTokens ?? currentInputTokens;
          const providerContextLimit = inspected.contextError.contextLimit ?? this.config.tokenPolicy.hardLimit;
          const undercountRatio = providerInputTokens > 0 ? currentInputTokens / providerInputTokens : 1;
          const desiredProviderInput = Math.max(
            1,
            providerContextLimit - this.config.tokenPolicy.responseReserve - this.config.tokenPolicy.safetyMargin,
          );
          const providerTokensToCut = Math.max(0, providerInputTokens - desiredProviderInput);
          const rescueTarget = Math.max(
            1,
            Math.min(
              configuredTarget,
              Math.floor(currentInputTokens - providerTokensToCut * undercountRatio),
              Math.floor(currentInputTokens * 0.5),
            ),
          );
          const clearingEnabled = this.config.tokenPolicy.toolResultClearingEnabled ?? true;
          const oldClearing = clearingEnabled
            ? clearOldToolResults(workingRequest, rescueTarget, 1)
            : null;
          let rescuedRequest = oldClearing?.request ?? workingRequest;
          const latestTruncation = clearingEnabled && estimateRequestTokens(rescuedRequest, 0).inputTokens > rescueTarget
            ? truncateNewestToolResult(rescuedRequest, rescueTarget)
            : null;
          if (latestTruncation?.applied) {
            rescuedRequest = latestTruncation.request;
          }

          if (oldClearing?.applied || latestTruncation?.applied) {
            workingRequest = rescuedRequest;
            toolResultRescueApplied = true;
            toolResultsCleared += (oldClearing?.clearedResults ?? 0) + (latestTruncation?.clearedResults ?? 0);
            toolResultTokensCleared +=
              (oldClearing?.estimatedTokensCleared ?? 0) + (latestTruncation?.estimatedTokensCleared ?? 0);
            budget = assessBudget(
              workingRequest,
              this.config.tokenPolicy.compactThreshold,
              this.config.tokenPolicy.hardLimit,
              this.config.tokenPolicy.responseReserve,
              this.config.tokenPolicy.safetyMargin,
            );
            this.logger.warn("Cleared old Agent tool results after upstream context error", {
              requestId,
              routePath,
              reason: "upstream_context_error",
              clearedOldResults: oldClearing?.clearedResults ?? 0,
              truncatedNewestResult: latestTruncation?.applied ?? false,
              estimatedTokensCleared:
                (oldClearing?.estimatedTokensCleared ?? 0) + (latestTruncation?.estimatedTokensCleared ?? 0),
              beforeInputTokens: oldClearing?.beforeInputTokens ?? latestTruncation?.beforeInputTokens,
              afterInputTokens: latestTruncation?.afterInputTokens ?? oldClearing?.afterInputTokens,
              providerInputTokens: inspected.contextError.inputTokens,
              providerContextLimit: inspected.contextError.contextLimit,
              keepRecent: 1,
              targetInputTokens: rescueTarget,
              undercountRatio: Number(undercountRatio.toFixed(3)),
            });
          } else {
            this.logger.warn("Preserved Agent tool protocol after upstream context error", {
              requestId,
              routePath,
              providerInputTokens: inspected.contextError.inputTokens,
              toolResultClearingAvailable: false,
            });
          }
        }

        const retryAdjustment = toolResultRescueApplied
          ? this.reduceMaxTokensIfNeeded(
              workingRequest,
              budget,
              "upstream_context_error",
              inspected.contextError.contextLimit ?? this.config.tokenPolicy.hardLimit,
            )
          : this.reduceMaxTokensAfterContextError(
              workingRequest,
              inspected.contextError,
            );

        this.logger.warn("上游返回上下文超限错误，已解析错误详情", {
          requestId,
          routePath,
          status: response.status,
          contextLimit: inspected.contextError.contextLimit,
          inputTokens: inspected.contextError.inputTokens,
          upstreamBody: inspected.contextError.message.slice(0, 500),
          canRetry: retryAdjustment.adjusted || toolResultRescueApplied,
        });

        if (retryAdjustment.adjusted || toolResultRescueApplied) {
          if (retryAdjustment.adjusted) {
            workingRequest = retryAdjustment.request;
            maxTokensReduced = true;
          }
          retriedAfterContextError = true;
          this.logger.warn("已降低max_tokens并自动重试一次", {
            requestId,
            routePath,
            originalMaxTokens: retryAdjustment.originalMaxTokens,
            adjustedMaxTokens: retryAdjustment.adjustedMaxTokens,
            toolResultRescueApplied,
          });
          response = await this.upstreamClient.postJson(routePath, workingRequest, upstreamHeaders);
        }
      }
    }

    if (!response.ok) {
      const { replayResponse, bodyPreview } = await captureUpstreamError(response);
      if (isNonMultimodalModelError(replayResponse.status, bodyPreview)) {
        const textOnlyRequest = forceTextOnlyRequest(workingRequest);
        const beforeSerialized = JSON.stringify(workingRequest);
        const afterSerialized = JSON.stringify(textOnlyRequest);
        if (afterSerialized !== beforeSerialized) {
          workingRequest = textOnlyRequest;
          this.logger.warn("上游拒绝多模态请求，已剥离图片/附件字段并自动重试一次", {
            requestId,
            routePath,
            status: replayResponse.status,
            visionUsed: withVision.vision.used,
            beforeBytes: Buffer.byteLength(beforeSerialized, "utf8"),
            afterBytes: Buffer.byteLength(afterSerialized, "utf8"),
          });
          response = await this.upstreamClient.postJson(routePath, workingRequest, upstreamHeaders);
        } else {
          response = replayResponse;
          this.logger.warn("上游拒绝多模态请求，但代理未发现可剥离的图片/附件字段", {
            requestId,
            routePath,
            status: replayResponse.status,
            visionUsed: withVision.vision.used,
            diagnostics: getVisionInputDiagnostics(workingRequest),
          });
        }
      } else {
        response = replayResponse;
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
        proxyInputTokens: budget.estimate.inputTokens,
        upstreamBody: bodyPreview,
        ...collectRequestFlags({
          compacted,
          compactWarning,
          chunked,
          maxTokensReduced,
          visionUsed: withVision.vision.used,
          toolResultsCleared,
          toolResultTokensCleared,
        }),
      });
    }

    if (compactWarning) {
      const warningResult = await appendCompactWarning(response, this.config.tokenPolicy.compactWarningText);
      response = warningResult.response;
      this.logger.warn(warningResult.appended
        ? "已在模型输出末尾追加compact提醒"
        : "compact提醒未能写入当前响应格式", {
        requestId,
        routePath,
        appended: warningResult.appended,
      });
    }

    if (response.ok) {
      const usage = await captureUpstreamUsage(response);
      response = usage.replayResponse;
      this.logger.info("请求完成", {
        requestId,
        routePath,
        status: response.status,
        proxyInputTokens: budget.estimate.inputTokens,
        upstreamInputTokens: usage.inputTokens,
        upstreamOutputTokens: usage.outputTokens,
        ...collectRequestFlags({
          compacted,
          compactWarning,
          chunked,
          maxTokensReduced,
          visionUsed: withVision.vision.used,
          toolResultsCleared,
          toolResultTokensCleared,
        }),
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
      toolResultsCleared,
      toolResultTokensCleared,
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
      toolResultsCleared: record.toolResultsCleared,
      toolResultTokensCleared: record.toolResultTokensCleared,
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
      const absoluteAvailableOutputTokens = Math.floor(
        contextError.contextLimit - contextError.inputTokens - PROVIDER_CONTEXT_RETRY_TOKEN_BUFFER,
      );
      const minOutputWithRetryBuffer = this.config.tokenPolicy.minOutputTokens + PROVIDER_CONTEXT_RETRY_TOKEN_BUFFER;
      const adjustedMaxTokens =
        safetyAvailableOutputTokens >= this.config.tokenPolicy.minOutputTokens
          ? safetyAvailableOutputTokens
          : contextError.contextLimit - contextError.inputTokens >= minOutputWithRetryBuffer
            ? this.config.tokenPolicy.minOutputTokens
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
