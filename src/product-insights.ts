import { LogEntry } from "./logger.js";
import { AppConfig } from "./types.js";
import { DashboardStatus } from "./dashboard.js";

export type HealthState = "ok" | "warn" | "off";

export interface HealthItem {
  id: "proxy" | "upstream" | "claude" | "vision";
  label: string;
  state: HealthState;
  detail: string;
}

export interface HealthSummary {
  items: HealthItem[];
  score: {
    ok: number;
    warn: number;
    off: number;
  };
}

export type ProtectionEventKind =
  | "budget"
  | "max_tokens"
  | "retry"
  | "compact"
  | "chunk"
  | "tool"
  | "vision"
  | "request";

export interface ProtectionEvent {
  timestamp: string;
  kind: ProtectionEventKind;
  severity: "info" | "success" | "warning";
  title: string;
  summary: string;
  metadata?: unknown;
}

export interface BuildHealthSummaryInput {
  status: DashboardStatus | null;
  config: AppConfig;
  env?: NodeJS.ProcessEnv;
}

function metadata(entry: LogEntry): Record<string, unknown> {
  return entry.metadata && typeof entry.metadata === "object" && !Array.isArray(entry.metadata)
    ? entry.metadata as Record<string, unknown>
    : {};
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function formatTokens(value: unknown): string {
  const numeric = numberValue(value);
  return numeric === undefined ? "unknown" : numeric.toLocaleString("en-US");
}

function score(items: HealthItem[]): HealthSummary["score"] {
  return {
    ok: items.filter((item) => item.state === "ok").length,
    warn: items.filter((item) => item.state === "warn").length,
    off: items.filter((item) => item.state === "off").length,
  };
}

export function buildHealthSummary(input: BuildHealthSummaryInput): HealthSummary {
  const { status, config, env = process.env } = input;
  const visionEnvName = config.vision.apiKeyEnv;
  const visionKeyAvailable = Boolean(visionEnvName && env[visionEnvName]);
  const items: HealthItem[] = [
    {
      id: "proxy",
      label: "Proxy",
      state: status ? "ok" : "off",
      detail: status ? `${status.listen} / PID ${status.pid}` : "not running",
    },
    {
      id: "upstream",
      label: "Upstream",
      state: status ? "ok" : "warn",
      detail: status ? `${status.upstreamSource} upstream` : "waiting for proxy start",
    },
    {
      id: "claude",
      label: "Claude routing",
      state: status?.patcherApplied ? "ok" : "warn",
      detail: status?.patcherApplied ? "CLI/Desktop patched" : "not patched yet",
    },
    {
      id: "vision",
      label: "Vision",
      state: !config.vision.enabled ? "off" : visionKeyAvailable || !visionEnvName ? "ok" : "warn",
      detail: !config.vision.enabled
        ? "disabled"
        : visionKeyAvailable || !visionEnvName
          ? "ready"
          : `${visionEnvName} is not set`,
    },
  ];

  return { items, score: score(items) };
}

export function extractProtectionEvents(entries: LogEntry[], limit = 12): ProtectionEvent[] {
  const events = entries.flatMap((entry): ProtectionEvent[] => {
    const data = metadata(entry);

    if (entry.message === "Token预算评估") {
      return [{
        timestamp: entry.timestamp,
        kind: "budget",
        severity: booleanValue(data.visionUsed) ? "success" : "info",
        title: "Token budget checked",
        summary: `${formatTokens(data.inputTokens)} input + ${formatTokens(data.expectedOutputTokens)} output = ${formatTokens(data.totalTokens)} total (${String(data.decision ?? "unknown")})`,
        metadata: entry.metadata,
      }];
    }

    if (entry.message.includes("已自动降低max_tokens")) {
      return [{
        timestamp: entry.timestamp,
        kind: "max_tokens",
        severity: "success",
        title: "max_tokens reduced before send",
        summary: `${formatTokens(data.originalMaxTokens)} -> ${formatTokens(data.adjustedMaxTokens)} to avoid the context limit`,
        metadata: entry.metadata,
      }];
    }

    if (entry.message.includes("已降低max_tokens并自动重试一次")) {
      return [{
        timestamp: entry.timestamp,
        kind: "retry",
        severity: "success",
        title: "Context-limit retry succeeded",
        summary: `${formatTokens(data.originalMaxTokens)} -> ${formatTokens(data.adjustedMaxTokens)} after upstream reported ${formatTokens(data.contextLimit)} context limit`,
        metadata: entry.metadata,
      }];
    }

    if (entry.message.includes("已触发compact提醒模式") || entry.message.includes("已在模型输出末尾追加compact提醒")) {
      return [{
        timestamp: entry.timestamp,
        kind: "compact",
        severity: "warning",
        title: "Compact reminder injected",
        summary: `Session reached ${formatTokens(data.totalTokens)} tokens near threshold ${formatTokens(data.compactThreshold)}`,
        metadata: entry.metadata,
      }];
    }

    if (entry.message.includes("已触发分块执行")) {
      return [{
        timestamp: entry.timestamp,
        kind: "chunk",
        severity: "warning",
        title: "Chunking fallback started",
        summary: `Request exceeded the hard limit with ${formatTokens(data.totalTokens)} tokens`,
        metadata: entry.metadata,
      }];
    }

    if (entry.message.includes("检测到图片并完成预处理")) {
      return [{
        timestamp: entry.timestamp,
        kind: "vision",
        severity: "success",
        title: "Image input summarized",
        summary: `${formatTokens(data.imageCount)} image(s) converted to text before forwarding`,
        metadata: entry.metadata,
      }];
    }

    if (entry.message === "请求已转发完成") {
      const protectedRequest =
        booleanValue(data.compacted) ||
        booleanValue(data.compactWarning) ||
        booleanValue(data.chunked) ||
        booleanValue(data.maxTokensReduced);
      if (!protectedRequest) return [];
      return [{
        timestamp: entry.timestamp,
        kind: "request",
        severity: "success",
        title: "Protected request completed",
        summary: `HTTP ${String(data.status ?? "unknown")} with guardrails applied`,
        metadata: entry.metadata,
      }];
    }

    if (entry.message === "Claude tool batch observed") {
      const repeated = numberValue(data.repeatedCalls) ?? 0;
      const truncated = numberValue(data.truncatedResults) ?? 0;
      return [{
        timestamp: entry.timestamp,
        kind: "tool",
        severity: repeated > 0 || truncated > 0 ? "warning" : "info",
        title: "Claude tool batch observed",
        summary: `${formatTokens(data.toolCount)} calls / ${formatTokens(data.outputChars)} output chars / ${repeated} repeated / ${truncated} truncated (observe only)`,
        metadata: entry.metadata,
      }];
    }

    if (entry.message.includes("Cleared old Agent tool results")) {
      return [{
        timestamp: entry.timestamp,
        kind: "tool",
        severity: "success",
        title: "Old tool results cleared safely",
        summary: `${formatTokens(data.clearedResults)} results / ${formatTokens(data.estimatedTokensCleared)} estimated tokens freed / ${formatTokens(data.beforeInputTokens)} -> ${formatTokens(data.afterInputTokens)}`,
        metadata: entry.metadata,
      }];
    }

    if (entry.message === "Claude native compact observed") {
      return [{
        timestamp: entry.timestamp,
        kind: "compact",
        severity: "success",
        title: "Claude native compact completed",
        summary: `Session ${String(data.sessionId ?? "unknown")} reset its observation state`,
        metadata: entry.metadata,
      }];
    }

    return [];
  });

  return events.slice(-limit);
}
