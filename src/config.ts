import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AppConfig } from "./types.js";
import { getBaseDirectory } from "./paths.js";

const defaultConfig: AppConfig = {
  server: {
    host: "127.0.0.1",
    port: 15722,
    autoPort: true,
  },
  upstream: {
    baseUrl: "http://127.0.0.1:15721",
    chatPath: "/v1/chat/completions",
    timeoutMs: 120000,
    aiRoutes: ["/v1/chat/completions", "/v1/messages"],
    autoDiscover: true,
  },
  tokenPolicy: {
    compactThreshold: 180000,
    hardLimit: 200000,
    responseReserve: 12000,
    chunkTarget: 90000,
    safetyMargin: 8000,
    compactMode: "proxy",
    compactWarningText:
      "[上下文提醒] 当前会话已经接近上下文上限，建议你现在执行 /compact 后再继续。",
    autoReduceMaxTokens: true,
    retryOnContextError: true,
    minOutputTokens: 1024,
  },
  vision: {
    enabled: false,
    baseUrl: "https://mgallery.haier.net",
    chatPath: "/v1/chat/completions",
    model: "qwen3-vl-30b-a3b-instruct",
    models: ["qwen3-vl-30b-a3b-instruct", "Qwen3.6-35B-A3B"],
    compareModels: true,
    apiKeyEnv: "CCPROXY_VISION_API_KEY",
    timeoutMs: 120000,
    maxImagesPerRequest: 5,
    maxImageBytes: 5_000_000,
    summaryMaxTokens: 1500,
    stripImagesAfterSummary: true,
    systemPrompt:
      "你是给编程助手使用的视觉分析器。请用中文提取图片中的关键信息：1) OCR文字；2) UI/页面结构；3) 报错或异常；4) 和用户问题相关的可执行线索。保持简洁但不要漏掉关键配置、模型名、URL、端口、按钮和错误信息。",
  },
  logging: {
    level: "info",
    directory: "./logs",
  },
  runtime: {
    directory: "./runtime",
  },
  ui: {
    enabled: true,
    openOnStart: false,
  },
  claudeConfigPatch: {
    enabled: true,
    settingsPath: path.join(os.homedir(), ".claude", "settings.json"),
  },
  claudeDesktopConfigPatch: {
    enabled: true,
    configLibraryPath: path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "Claude-3p", "configLibrary"),
  },
};

export function mergeConfig(base: AppConfig, override: Partial<AppConfig>): AppConfig {
  return {
    ...base,
    ...override,
    server: { ...base.server, ...override.server },
    upstream: { ...base.upstream, ...override.upstream },
    tokenPolicy: { ...base.tokenPolicy, ...override.tokenPolicy },
    vision: { ...base.vision, ...override.vision },
    logging: { ...base.logging, ...override.logging },
    runtime: { ...base.runtime, ...override.runtime },
    ui: { ...base.ui, ...override.ui },
    claudeConfigPatch: { ...base.claudeConfigPatch, ...override.claudeConfigPatch },
    claudeDesktopConfigPatch: { ...base.claudeDesktopConfigPatch, ...override.claudeDesktopConfigPatch },
  };
}

export function getConfigPath(): string {
  const baseDirectory = getBaseDirectory();
  return process.env.CCPROXY_CONFIG
    ? path.resolve(process.env.CCPROXY_CONFIG)
    : path.resolve(baseDirectory, "config.json");
}

export function loadConfig(): AppConfig {
  const baseDirectory = getBaseDirectory();
  const configPath = getConfigPath();

  let config = defaultConfig;

  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    config = mergeConfig(defaultConfig, parsed);
  }

  mkdirSync(path.resolve(baseDirectory, config.logging.directory), { recursive: true });
  mkdirSync(path.resolve(baseDirectory, config.runtime.directory, "sessions"), { recursive: true });

  return config;
}

export function saveConfig(config: AppConfig): void {
  const configPath = getConfigPath();
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}
