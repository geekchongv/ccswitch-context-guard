import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AppConfig, BudgetAssessment, ChatCompletionRequest, OrchestrationRecord } from "./types.js";
import { ContextUsageSnapshot, buildContextUsage } from "./product-insights.js";
import { getBaseDirectory } from "./paths.js";
import type { HookSessionEvent } from "./hook-observer.js";

export type SessionClient = "claude-code" | "claude-desktop" | "unknown";
export type SessionRuntimeStatus = "waiting" | "active" | "healthy" | "cleanup" | "compact" | "critical" | "ended" | "error";

export interface SessionTimelineEvent {
  timestamp: string;
  kind: "started" | "request" | "compact" | "cleanup" | "rate-limit" | "error" | "ended";
  label: string;
}

export interface SessionView {
  id: string;
  displayId: string;
  title: string;
  projectName?: string;
  client: SessionClient;
  model?: string;
  routePath?: string;
  status: SessionRuntimeStatus;
  context: ContextUsageSnapshot;
  requestCount: number;
  inFlightRequests: number;
  compactCount: number;
  cleanupCount: number;
  errorCount: number;
  createdAt: string;
  lastActiveAt: string;
  endedAt?: string;
  events: SessionTimelineEvent[];
}

export interface SessionRegistrySnapshot {
  sessions: SessionView[];
  activeCount: number;
  highestUsageSessionId?: string;
  updatedAt: string;
}

interface PendingHookSession {
  sessionId: string;
  observedAt: number;
  promptFingerprint?: string;
}

interface PersistedSessionIndex {
  version: 1;
  sessions: SessionView[];
}

const MAX_SESSION_EVENTS = 20;
const PENDING_HOOK_TTL_MS = 60_000;
const ACTIVE_SESSION_WINDOW_MS = 15 * 60_000;

function safeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function canonicalSessionId(value: string): string {
  return `sid-${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (!part || typeof part !== "object") return "";
    const item = part as Record<string, unknown>;
    return safeString(item.text) ?? safeString(item.type) ?? "";
  }).join("\n");
}

function explicitSessionId(request: ChatCompletionRequest, headers: Record<string, string>): string | undefined {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  for (const key of ["x-claude-session-id", "x-session-id", "anthropic-session-id", "x-conversation-id"]) {
    const value = safeString(normalizedHeaders[key]);
    if (value) return value;
  }

  const body = request as Record<string, unknown>;
  const metadata = body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
    ? body.metadata as Record<string, unknown>
    : {};
  for (const value of [
    body.session_id,
    body.sessionId,
    body.conversation_id,
    metadata.session_id,
    metadata.sessionId,
    metadata.conversation_id,
  ]) {
    const sessionId = safeString(value);
    if (sessionId) return sessionId;
  }
  return undefined;
}

function requestPromptFingerprint(request: ChatCompletionRequest): string | undefined {
  const prompt = [...(request.messages ?? [])]
    .reverse()
    .find((message) => message.role === "user");
  const text = prompt ? messageText(prompt.content).trim() : "";
  return text ? createHash("sha256").update(text).digest("hex").slice(0, 24) : undefined;
}

function requestFingerprint(request: ChatCompletionRequest, routePath: string): string {
  const prefix = (request.messages ?? []).slice(0, 4).map((message) => ({
    role: message.role,
    name: message.name,
    content: messageText(message.content).slice(0, 600),
  }));
  return createHash("sha256")
    .update(JSON.stringify({ routePath, model: request.model ?? "", prefix }))
    .digest("hex")
    .slice(0, 24);
}

function clientForRoute(routePath: string): SessionClient {
  if (routePath.includes("claude-desktop")) return "claude-desktop";
  if (routePath.endsWith("/v1/messages") || routePath.endsWith("/v1/chat/completions")) return "claude-code";
  return "unknown";
}

function projectName(cwd?: string): string | undefined {
  if (!cwd) return undefined;
  const name = path.basename(cwd.replace(/[\\/]+$/, ""));
  return name || undefined;
}

export class SessionRegistry {
  private readonly sessions = new Map<string, SessionView>();
  private readonly fingerprintToSession = new Map<string, string>();
  private readonly latestBudgetRequestBySession = new Map<string, string>();
  private readonly pendingHookSessions: PendingHookSession[] = [];
  private readonly emitter = new EventEmitter();
  private readonly indexPath: string;

  public constructor(private readonly config: AppConfig) {
    this.indexPath = path.resolve(getBaseDirectory(), config.runtime.directory, "session-index.json");
    this.load();
  }

  public onChange(listener: (snapshot: SessionRegistrySnapshot) => void): () => void {
    this.emitter.on("change", listener);
    return () => this.emitter.off("change", listener);
  }

  public observeHook(event: HookSessionEvent): void {
    const now = Date.now();
    const sessionId = canonicalSessionId(event.sessionId);
    const session = this.ensureSession(sessionId, {
      projectName: projectName(event.cwd),
      client: "claude-code",
      timestamp: event.timestamp,
    });

    if (event.eventName === "SessionEnd") {
      this.consumePendingSession(sessionId);
      for (const [fingerprint, mappedSessionId] of this.fingerprintToSession.entries()) {
        if (mappedSessionId === sessionId) this.fingerprintToSession.delete(fingerprint);
      }
      session.status = "ended";
      session.inFlightRequests = 0;
      session.endedAt = event.timestamp;
      session.lastActiveAt = event.timestamp;
      this.addEvent(session, "ended", "Claude 会话已结束", event.timestamp);
      this.persist();
      this.emit();
      return;
    }

    if (event.eventName === "UserPromptSubmit" || event.eventName === "PostCompact") {
      this.prunePending(now);
      this.pendingHookSessions.push({
        sessionId,
        observedAt: now,
        promptFingerprint: event.promptFingerprint,
      });
      session.status = event.eventName === "PostCompact" ? "healthy" : "waiting";
      session.lastActiveAt = event.timestamp;
      if (event.eventName === "PostCompact") {
        session.compactCount += 1;
        this.addEvent(session, "compact", "Claude 原生压缩完成", event.timestamp);
      }
      this.emit();
    }
  }

  public resolveRequest(
    request: ChatCompletionRequest,
    routePath: string,
    headers: Record<string, string>,
  ): string {
    const fingerprint = requestFingerprint(request, routePath);
    const explicit = explicitSessionId(request, headers);
    if (explicit) {
      const canonical = canonicalSessionId(explicit);
      this.consumePendingSession(canonical);
      this.fingerprintToSession.set(fingerprint, canonical);
      this.ensureSession(canonical, {
        client: clientForRoute(routePath),
        model: request.model,
        routePath,
      });
      return canonical;
    }

    const mapped = this.fingerprintToSession.get(fingerprint);
    if (mapped) {
      this.consumePendingSession(mapped);
      return mapped;
    }

    const pending = this.claimPendingHookSession(requestPromptFingerprint(request));
    const sessionId = pending ?? `local-${fingerprint}`;
    this.fingerprintToSession.set(fingerprint, sessionId);
    this.ensureSession(sessionId, {
      client: clientForRoute(routePath),
      model: request.model,
      routePath,
    });
    return sessionId;
  }

  public requestStarted(
    sessionId: string,
    input: { requestId: string; routePath: string; model?: string; timestamp: string },
  ): void {
    const session = this.ensureSession(sessionId, {
      client: clientForRoute(input.routePath),
      model: input.model,
      routePath: input.routePath,
      timestamp: input.timestamp,
    });
    session.inFlightRequests += 1;
    session.status = "active";
    session.lastActiveAt = input.timestamp;
    this.emit();
  }

  public updateBudget(
    sessionId: string,
    requestId: string,
    budget: BudgetAssessment,
    timestamp = new Date().toISOString(),
  ): void {
    const session = this.ensureSession(sessionId, { timestamp });
    this.latestBudgetRequestBySession.set(sessionId, requestId);
    session.context = this.contextFromTokens(budget.estimate.inputTokens, timestamp);
    const contextStatus = this.statusFromContext(session.context);
    session.status = session.inFlightRequests > 0 && (contextStatus === "healthy" || contextStatus === "waiting")
      ? "active"
      : contextStatus;
    session.lastActiveAt = timestamp;
    this.emit();
  }

  public requestCompleted(record: OrchestrationRecord): void {
    if (!record.sessionId) return;
    const completedAt = new Date().toISOString();
    const session = this.ensureSession(record.sessionId, {
      routePath: record.routePath,
      timestamp: completedAt,
    });
    session.inFlightRequests = Math.max(0, session.inFlightRequests - 1);
    session.requestCount += 1;
    const latestBudgetRequest = this.latestBudgetRequestBySession.get(record.sessionId);
    const observedInputTokens = Math.max(
      record.budget.estimate.inputTokens,
      record.providerInputTokens ?? 0,
    );
    if (!latestBudgetRequest || latestBudgetRequest === record.requestId) {
      session.context = this.contextFromTokens(observedInputTokens, completedAt);
    }
    session.lastActiveAt = completedAt;
    const failed = (record.responseStatus ?? 200) >= 400;
    if (failed) {
      session.errorCount += 1;
      session.status = "error";
      this.addEvent(session, "error", `请求失败 · HTTP ${record.responseStatus}`, completedAt);
    } else {
      session.status = session.endedAt ? "ended" : this.statusFromContext(session.context);
      this.addEvent(session, "request", `请求完成 · ${this.formatTokens(observedInputTokens)}`, completedAt);
    }
    if (record.compacted) {
      session.compactCount += 1;
      this.addEvent(session, "compact", "代理上下文压缩完成", completedAt);
    }
    if ((record.toolResultsCleared ?? 0) > 0) {
      session.cleanupCount += 1;
      this.addEvent(session, "cleanup", `清理 ${record.toolResultsCleared} 个旧工具结果`, completedAt);
    }
    this.persist();
    this.emit();
  }

  public requestFailed(sessionId: string, label: string, timestamp = new Date().toISOString()): void {
    const session = this.ensureSession(sessionId, { timestamp });
    session.inFlightRequests = Math.max(0, session.inFlightRequests - 1);
    session.errorCount += 1;
    session.status = "error";
    session.lastActiveAt = timestamp;
    this.addEvent(session, "error", label, timestamp);
    this.persist();
    this.emit();
  }

  public snapshot(): SessionRegistrySnapshot {
    const sessions = [...this.sessions.values()]
      .sort((left, right) => {
        if (left.status === "ended" && right.status !== "ended") return 1;
        if (right.status === "ended" && left.status !== "ended") return -1;
        if (left.inFlightRequests > 0 && right.inFlightRequests === 0) return -1;
        if (right.inFlightRequests > 0 && left.inFlightRequests === 0) return 1;
        return right.lastActiveAt.localeCompare(left.lastActiveAt);
      })
      .map((session) => structuredClone(session));
    const now = Date.now();
    const active = sessions.filter((session) =>
      session.status !== "ended"
      && (session.inFlightRequests > 0 || now - new Date(session.lastActiveAt).getTime() <= ACTIVE_SESSION_WINDOW_MS));
    const candidates = sessions.filter((session) => session.status !== "ended");
    const highest = candidates.slice().sort((left, right) => right.context.usagePercent - left.context.usagePercent)[0];
    return {
      sessions,
      activeCount: active.length,
      highestUsageSessionId: highest?.id,
      updatedAt: new Date().toISOString(),
    };
  }

  public overviewContext(): ContextUsageSnapshot {
    const snapshot = this.snapshot();
    return snapshot.sessions.find((session) => session.id === snapshot.highestUsageSessionId)?.context
      ?? buildContextUsage([], this.config);
  }

  private claimPendingHookSession(promptFingerprint?: string): string | undefined {
    const now = Date.now();
    this.prunePending(now);
    if (promptFingerprint) {
      const index = this.pendingHookSessions.findIndex(
        (pending) => pending.promptFingerprint === promptFingerprint,
      );
      if (index >= 0) return this.pendingHookSessions.splice(index, 1)[0]?.sessionId;
    }
    return this.pendingHookSessions.shift()?.sessionId;
  }

  private consumePendingSession(sessionId: string): void {
    const index = this.pendingHookSessions.findIndex((pending) => pending.sessionId === sessionId);
    if (index >= 0) this.pendingHookSessions.splice(index, 1);
  }

  private prunePending(now: number): void {
    while (this.pendingHookSessions.length > 0 && now - this.pendingHookSessions[0]!.observedAt > PENDING_HOOK_TTL_MS) {
      this.pendingHookSessions.shift();
    }
  }

  private ensureSession(sessionId: string, input: {
    projectName?: string;
    client?: SessionClient;
    model?: string;
    routePath?: string;
    timestamp?: string;
  }): SessionView {
    const existing = this.sessions.get(sessionId);
    const timestamp = input.timestamp ?? new Date().toISOString();
    if (existing) {
      if (input.projectName) existing.projectName = input.projectName;
      if (input.client && input.client !== "unknown") existing.client = input.client;
      if (input.model) existing.model = input.model;
      if (input.routePath) existing.routePath = input.routePath;
      existing.title = this.sessionTitle(existing);
      return existing;
    }

    const session: SessionView = {
      id: sessionId,
      displayId: createHash("sha256").update(sessionId).digest("hex").slice(0, 8),
      title: "",
      projectName: input.projectName,
      client: input.client ?? "unknown",
      model: input.model,
      routePath: input.routePath,
      status: "waiting",
      context: buildContextUsage([], this.config),
      requestCount: 0,
      inFlightRequests: 0,
      compactCount: 0,
      cleanupCount: 0,
      errorCount: 0,
      createdAt: timestamp,
      lastActiveAt: timestamp,
      events: [],
    };
    session.title = this.sessionTitle(session);
    this.addEvent(session, "started", "会话开始", timestamp);
    this.sessions.set(sessionId, session);
    return session;
  }

  private sessionTitle(session: SessionView): string {
    const client = session.client === "claude-desktop" ? "Desktop" : "Code";
    return session.projectName
      ? `${session.projectName} · ${client}`
      : `Claude ${client} · ${session.displayId}`;
  }

  private contextFromTokens(tokens: number, timestamp: string): ContextUsageSnapshot {
    return buildContextUsage([{
      timestamp,
      level: "info",
      message: "请求完成",
      metadata: { proxyInputTokens: tokens },
    }], this.config);
  }

  private statusFromContext(context: ContextUsageSnapshot): SessionRuntimeStatus {
    return context.stage === "idle" ? "waiting" : context.stage;
  }

  private addEvent(
    session: SessionView,
    kind: SessionTimelineEvent["kind"],
    label: string,
    timestamp: string,
  ): void {
    session.events.push({ timestamp, kind, label });
    session.events = session.events.slice(-MAX_SESSION_EVENTS);
  }

  private formatTokens(tokens: number): string {
    return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
  }

  private load(): void {
    if (!existsSync(this.indexPath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.indexPath, "utf8")) as PersistedSessionIndex;
      if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) return;
      for (const session of parsed.sessions) {
        session.inFlightRequests = 0;
        if (session.status === "active") session.status = this.statusFromContext(session.context);
        this.sessions.set(session.id, session);
      }
      this.pruneSessions();
    } catch {
      // A corrupt runtime index must not prevent the proxy from starting.
    }
  }

  private persist(): void {
    this.pruneSessions();
    const payload: PersistedSessionIndex = {
      version: 1,
      sessions: [...this.sessions.values()],
    };
    writeFileSync(this.indexPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  private pruneSessions(): void {
    const retentionDays = Math.max(1, this.config.runtime.sessionRetentionDays ?? 7);
    const maxSessions = Math.max(10, this.config.runtime.sessionMaxSessions ?? 100);
    const cutoff = Date.now() - retentionDays * 86_400_000;
    const sorted = [...this.sessions.values()].sort((left, right) => right.lastActiveAt.localeCompare(left.lastActiveAt));
    const keep = new Set(
      sorted
        .filter((session) => new Date(session.lastActiveAt).getTime() >= cutoff)
        .slice(0, maxSessions)
        .map((session) => session.id),
    );
    for (const sessionId of this.sessions.keys()) {
      if (!keep.has(sessionId)) this.sessions.delete(sessionId);
    }
  }

  private emit(): void {
    this.emitter.emit("change", this.snapshot());
  }
}
