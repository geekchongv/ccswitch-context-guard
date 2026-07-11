import { createHash, randomUUID } from "node:crypto";
import { Logger } from "./logger.js";

interface HookPayload {
  session_id?: string;
  hook_event_name?: string;
  tool_calls?: Array<{
    tool_name?: string;
    tool_input?: unknown;
    tool_response?: unknown;
  }>;
}

interface SessionObservation {
  turnCalls: number;
  recentFingerprints: string[];
  repeatedCalls: number;
  truncatedResults: number;
}

const MAX_RECENT_FINGERPRINTS = 20;
const TRUNCATION_PATTERN = /truncat|output.{0,30}(saved|limit|large)|too large|截断|输出.{0,20}(限制|过大)/i;

function stableValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableValue).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(toolName: string, toolInput: unknown): string {
  return createHash("sha256")
    .update(`${toolName}\n${stableValue(toolInput)}`)
    .digest("hex")
    .slice(0, 16);
}

function responseText(response: unknown): string {
  if (typeof response === "string") {
    return response;
  }
  try {
    return JSON.stringify(response);
  } catch {
    return "";
  }
}

export class HookObserver {
  public readonly token = randomUUID();
  private readonly sessions = new Map<string, SessionObservation>();

  public constructor(private readonly logger: Logger) {}

  public observe(payload: HookPayload): void {
    const sessionId = payload.session_id;
    const eventName = payload.hook_event_name;
    if (!sessionId || !eventName) {
      this.logger.warn("Claude hook payload ignored", { reason: "missing session_id or hook_event_name" });
      return;
    }

    if (eventName === "SessionEnd") {
      this.sessions.delete(sessionId);
      this.logger.info("Claude hook session ended", { sessionId: sessionId.slice(0, 8) });
      return;
    }

    if (eventName === "UserPromptSubmit" || eventName === "PostCompact") {
      this.sessions.set(sessionId, {
        turnCalls: 0,
        recentFingerprints: [],
        repeatedCalls: 0,
        truncatedResults: 0,
      });
      this.logger.info(eventName === "PostCompact" ? "Claude native compact observed" : "Claude hook turn started", {
        sessionId: sessionId.slice(0, 8),
      });
      return;
    }

    if (eventName !== "PostToolBatch") {
      return;
    }

    const state = this.sessions.get(sessionId) ?? {
      turnCalls: 0,
      recentFingerprints: [],
      repeatedCalls: 0,
      truncatedResults: 0,
    };
    const calls = payload.tool_calls ?? [];
    let batchRepeated = 0;
    let batchTruncated = 0;
    let outputChars = 0;

    for (const call of calls) {
      const toolName = call.tool_name ?? "unknown";
      const callFingerprint = fingerprint(toolName, call.tool_input);
      if (state.recentFingerprints.includes(callFingerprint)) {
        batchRepeated += 1;
      }
      state.recentFingerprints.push(callFingerprint);
      state.recentFingerprints = state.recentFingerprints.slice(-MAX_RECENT_FINGERPRINTS);

      const text = responseText(call.tool_response);
      outputChars += text.length;
      if (TRUNCATION_PATTERN.test(text)) {
        batchTruncated += 1;
      }
    }

    state.turnCalls += calls.length;
    state.repeatedCalls += batchRepeated;
    state.truncatedResults += batchTruncated;
    this.sessions.set(sessionId, state);

    this.logger.info("Claude tool batch observed", {
      sessionId: sessionId.slice(0, 8),
      toolCount: calls.length,
      turnCalls: state.turnCalls,
      repeatedCalls: batchRepeated,
      truncatedResults: batchTruncated,
      outputChars,
      mode: "observe",
    });
  }
}
