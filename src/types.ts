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
}

export interface UpstreamConfig {
  baseUrl: string;
  chatPath: string;
  timeoutMs: number;
  aiRoutes?: string[];
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

export interface ClaudeConfigPatchConfig {
  enabled: boolean;
  settingsPath?: string;
}

export interface ClaudeDesktopConfigPatchConfig {
  enabled: boolean;
  configLibraryPath?: string;
  gatewayBaseUrl?: string;
  apiKey?: string;
  authScheme?: "bearer" | "x-api-key";
}

export interface AppConfig {
  server: ServerConfig;
  upstream: UpstreamConfig;
  tokenPolicy: TokenPolicyConfig;
  vision: VisionConfig;
  logging: LoggingConfig;
  runtime: RuntimeConfig;
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
  vision: VisionAnalysisResult;
}
