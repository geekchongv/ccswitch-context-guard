export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ServerConfig {
  host: string;
  port: number;
  maxRequestBodyBytes?: number;
  /** 若为 true,配置端口被占用时自动递增探测可用端口(默认 true)。 */
  autoPort?: boolean;
}

export interface UpstreamConfig {
  baseUrl: string;
  chatPath: string;
  timeoutMs: number;
  aiRoutes?: string[];
  /** 若为 true,配置的上游不可达时自动扫描本地候选端口(默认 true)。 */
  autoDiscover?: boolean;
  /** 首次 429 后启用共享冷却并降低并发，避免客户端重试风暴。 */
  adaptiveRateLimit?: boolean;
  /** 未触发限流时允许的最大并发请求数。 */
  maxConcurrentRequests?: number;
  /** 网关未返回 Retry-After 时使用的冷却时间。 */
  rateLimitFallbackDelayMs?: number;
  /** 429 后由代理内部执行的最大重试次数。 */
  rateLimitMaxRetries?: number;
}

export interface TokenPolicyConfig {
  compactThreshold: number;
  hardLimit: number;
  responseReserve: number;
  chunkTarget: number;
  safetyMargin: number;
  compactMode: "warn" | "proxy";
  compactWarningText: string;
  autoReduceMaxTokens: boolean;
  retryOnContextError: boolean;
  minOutputTokens: number;
  toolResultClearingEnabled?: boolean;
  toolResultClearTrigger?: number;
  toolResultClearTarget?: number;
  toolResultKeepRecent?: number;
}

export interface VisionConfig {
  enabled: boolean;
  baseUrl: string;
  chatPath: string;
  model: string;
  models?: string[];
  compareModels: boolean;
  apiKeyEnv?: string;
  apiKey?: string;
  timeoutMs: number;
  maxImagesPerRequest: number;
  maxImageBytes: number;
  summaryMaxTokens: number;
  stripImagesAfterSummary: boolean;
  systemPrompt: string;
}

export interface LoggingConfig {
  level: "debug" | "info" | "warn" | "error";
  directory: string;
}

export interface RuntimeConfig {
  directory: string;
}

export interface UiConfig {
  enabled: boolean;
  openOnStart: boolean;
}

export interface ClaudeConfigPatchConfig {
  enabled: boolean;
  settingsPath?: string;
  autoCompactEnabled?: boolean;
  autoCompactReserveTokens?: number;
  hookObserverEnabled?: boolean;
}

export interface ClaudeDesktopConfigPatchConfig {
  enabled: boolean;
  configLibraryPath?: string;
  gatewayBaseUrl?: string;
  apiKey?: string;
  authScheme?: "bearer" | "x-api-key";
  /** Desktop gateway 漂移检测轮询间隔(ms),0 禁用,默认 5000。 */
  desktopWatchIntervalMs?: number;
}

export interface AppConfig {
  server: ServerConfig;
  upstream: UpstreamConfig;
  tokenPolicy: TokenPolicyConfig;
  vision: VisionConfig;
  logging: LoggingConfig;
  runtime: RuntimeConfig;
  ui: UiConfig;
  claudeConfigPatch: ClaudeConfigPatchConfig;
  claudeDesktopConfigPatch: ClaudeDesktopConfigPatchConfig;
}

export interface ChatMessagePartText {
  type: "text" | "input_text";
  text: string;
}

export interface ChatMessagePartImage {
  type: "image_url" | "input_image" | "image";
  image_url?: string | { url: string };
  url?: string;
  source?: {
    type?: string;
    media_type?: string;
    data?: string;
  };
}

export type ChatMessagePart = ChatMessagePartText | ChatMessagePartImage | Record<string, JsonValue>;

export interface ChatMessage {
  role: string;
  content: string | ChatMessagePart[];
  name?: string;
}

export interface ChatCompletionRequest {
  model?: string;
  messages?: ChatMessage[];
  stream?: boolean;
  max_tokens?: number;
  max_completion_tokens?: number;
  [key: string]: JsonValue | ChatMessage[] | undefined;
}

export interface TokenEstimate {
  inputTokens: number;
  expectedOutputTokens: number;
  totalTokens: number;
}

export type BudgetDecision = "safe" | "compact_required" | "chunk_required";

export interface BudgetAssessment {
  decision: BudgetDecision;
  estimate: TokenEstimate;
}

export interface VisionAnalysisResult {
  used: boolean;
  summary?: string;
  modelSummaries?: Array<{
    model: string;
    summary: string;
  }>;
  imageCount?: number;
  error?: string;
}

export interface OrchestrationRecord {
  requestId: string;
  timestamp: string;
  routePath?: string;
  budget: BudgetAssessment;
  compacted: boolean;
  compactWarning: boolean;
  chunked: boolean;
  maxTokensReduced: boolean;
  retriedAfterContextError: boolean;
  toolResultsCleared?: number;
  toolResultTokensCleared?: number;
  vision: VisionAnalysisResult;
}
