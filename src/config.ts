import { existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AppConfig } from "./types.js";
import { getBaseDirectory } from "./paths.js";

const defaultConfig: AppConfig = {
  server: {
    host: "127.0.0.1",
    port: 15722,
  },
  upstream: {
    baseUrl: "http://127.0.0.1:15721",
    chatPath: "/v1/chat/completions",
    timeoutMs: 120000,
    aiRoutes: ["/v1/chat/completions", "/v1/messages"],
  },
  tokenPolicy: {
    compactThreshold: 180000,
    hardLimit: 200000,
    responseReserve: 12000,
    chunkTarget: 90000,
    safetyMargin: 8000,
    compactMode: "warn",
    compactWarningText:
      "[上下文提醒] 当前会话已经接近上下文上限，建议你现在执行 /compact 后再继续。",
    autoReduceMaxTokens: true,
    retryOnContextError: true,
    minOutputTokens: 1024,
  },
  vision: {
    enabled: false,
    baseUrl: "http://127.0.0.1:15721",
    chatPath: "/v1/chat/completions",
    model: "",
    systemPrompt:
      "Analyze the provided image for a coding assistant. Return a concise, structured summary of visible UI, text, errors, and actionable details.",
  },
  logging: {
    level: "info",
    directory: "./logs",
  },
  runtime: {
    directory: "./runtime",
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

function mergeConfig(base: AppConfig, override: Partial<AppConfig>): AppConfig {
  return {
    ...base,
    ...override,
    server: { ...base.server, ...override.server },
    upstream: { ...base.upstream, ...override.upstream },
    tokenPolicy: { ...base.tokenPolicy, ...override.tokenPolicy },
    vision: { ...base.vision, ...override.vision },
    logging: { ...base.logging, ...override.logging },
    runtime: { ...base.runtime, ...override.runtime },
    claudeConfigPatch: { ...base.claudeConfigPatch, ...override.claudeConfigPatch },
    claudeDesktopConfigPatch: { ...base.claudeDesktopConfigPatch, ...override.claudeDesktopConfigPatch },
  };
}

export function loadConfig(): AppConfig {
  const baseDirectory = getBaseDirectory();
  const configPath = process.env.CCPROXY_CONFIG
    ? path.resolve(process.env.CCPROXY_CONFIG)
    : path.resolve(baseDirectory, "config.json");

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
