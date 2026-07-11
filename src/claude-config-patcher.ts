import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AppConfig } from "./types.js";
import { Logger } from "./logger.js";
import { getBaseDirectory } from "./paths.js";

interface ClaudeSettingsFile {
  env?: Record<string, string>;
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
}

interface PatchState {
  pid: number;
  patchedAt: string;
  settingsPath: string;
  previousBaseUrl?: string;
  patchedBaseUrl?: string;
  previousAutoCompactWindow?: string;
  previousAutoCompactPct?: string;
  patchedAutoCompactWindow?: string;
  patchedAutoCompactPct?: string;
  insertedHookUrls?: string[];
}

interface HookIntegration {
  token: string;
}

const HOOK_EVENTS = ["UserPromptSubmit", "PostToolBatch", "PostCompact", "SessionEnd"] as const;

interface ClaudeDesktopMetaFile {
  appliedId?: string;
  entries?: Array<{
    id?: string;
    name?: string;
  }>;
  [key: string]: unknown;
}

interface ClaudeDesktopGatewayFile {
  inferenceProvider?: string;
  inferenceGatewayBaseUrl?: string;
  inferenceGatewayApiKey?: string;
  inferenceGatewayAuthScheme?: string;
  [key: string]: unknown;
}

interface DesktopPatchState {
  pid: number;
  patchedAt: string;
  configLibraryPath: string;
  configPath: string;
  appliedId: string;
  previousGatewayBaseUrl?: string;
  previousApiKey?: string;
  previousAuthScheme?: string;
  /** Prior active config files left pointing at the proxy after an appliedId switch. */
  strandedConfigPaths?: Array<{ configPath: string; previousGatewayBaseUrl?: string }>;
}

export class ClaudeConfigPatcher {
  private readonly statePath: string;
  private readonly desktopStatePath: string;
  private restored = false;
  private desktopWatchTimer: ReturnType<typeof setInterval> | null = null;
  private desktopWatchLastAppliedId: string | null = null;
  private desktopWatchLastConfigPath: string | null = null;
  private desktopStrandedPaths: Array<{ configPath: string; previousGatewayBaseUrl?: string }> = [];

  public constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly hookIntegration?: HookIntegration,
  ) {
    this.statePath = path.resolve(getBaseDirectory(), this.config.runtime.directory, "claude-config-patch.json");
    this.desktopStatePath = path.resolve(
      getBaseDirectory(),
      this.config.runtime.directory,
      "claude-desktop-config-patch.json",
    );
  }

  public apply(): void {
    this.applyClaudeCli();
    this.applyClaudeDesktop();
  }

  public restore(): void {
    if (this.restored) {
      return;
    }

    this.stopDesktopGatewayWatch();
    this.restoreClaudeCli();
    this.restoreClaudeDesktop();
    this.restored = true;
  }

  public checkDesktopGatewayDrift(): void {
    if (!this.config.claudeDesktopConfigPatch.enabled) {
      return;
    }

    try {
      this.checkDesktopGatewayDriftUnsafe();
    } catch (error) {
      // ccswitch rewrites config files non-atomically (truncate-then-write); a
      // tick landing in that window yields a partial file whose JSON.parse throws.
      // Swallow so the interval keeps running instead of escalating to uncaughtException.
      this.logger.debug("Desktop gateway drift check failed, will retry next tick", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private checkDesktopGatewayDriftUnsafe(): void {
    const target = this.resolveDesktopConfigTarget();
    if (!target) {
      this.logger.debug("Desktop gateway drift check skipped because no applied 3P config was found", {
        configLibraryPath: this.config.claudeDesktopConfigPatch.configLibraryPath,
      });
      return;
    }

    const gatewayConfig = this.readDesktopGatewayConfig(target.configPath);
    const currentGatewayBaseUrl = gatewayConfig.inferenceGatewayBaseUrl;
    const proxyGatewayBaseUrl = this.buildDesktopProxyGatewayBaseUrl(currentGatewayBaseUrl);
    const appliedIdChanged = target.appliedId !== this.desktopWatchLastAppliedId;

    if (!proxyGatewayBaseUrl) {
      this.logger.debug("Desktop gateway drift check skipped because gateway URL could not be resolved", {
        configPath: target.configPath,
        hasCurrentGatewayBaseUrl: Boolean(currentGatewayBaseUrl),
      });
      return;
    }

    if (currentGatewayBaseUrl === proxyGatewayBaseUrl && !appliedIdChanged) {
      this.logger.debug("Desktop gateway drift check: no drift", {
        configPath: target.configPath,
        proxyGatewayBaseUrl,
      });
      this.desktopWatchLastAppliedId = target.appliedId;
      return;
    }

    this.logger.warn("检测到 Claude Desktop 网关配置漂移,正在重新 patch", {
      configPath: target.configPath,
      currentGatewayBaseUrl,
      proxyGatewayBaseUrl,
      appliedId: target.appliedId,
      previousAppliedId: this.desktopWatchLastAppliedId,
    });

    if (appliedIdChanged && this.desktopWatchLastConfigPath && this.desktopWatchLastConfigPath !== target.configPath) {
      this.restoreStrandedConfigPath(this.desktopWatchLastConfigPath);
    }

    this.applyClaudeDesktop();
    this.desktopWatchLastAppliedId = target.appliedId;
    this.desktopWatchLastConfigPath = target.configPath;
  }

  private restoreStrandedConfigPath(configPath: string): void {
    try {
      if (!existsSync(configPath)) {
        return;
      }
      const state = existsSync(this.desktopStatePath)
        ? (JSON.parse(readFileSync(this.desktopStatePath, "utf8")) as DesktopPatchState)
        : null;
      const previousGatewayBaseUrl = state?.previousGatewayBaseUrl;
      const gatewayConfig = this.readDesktopGatewayConfig(configPath);
      const proxyGatewayBaseUrl = this.buildDesktopProxyGatewayBaseUrl(previousGatewayBaseUrl);
      if (gatewayConfig.inferenceGatewayBaseUrl !== proxyGatewayBaseUrl) {
        // Not pointing at the proxy (already taken over by ccswitch) — leave it alone.
        return;
      }
      const nextConfig: ClaudeDesktopGatewayFile = { ...gatewayConfig };
      if (previousGatewayBaseUrl) {
        nextConfig.inferenceGatewayBaseUrl = previousGatewayBaseUrl;
      } else {
        delete nextConfig.inferenceGatewayBaseUrl;
      }
      this.writeDesktopGatewayConfig(configPath, nextConfig);
      this.desktopStrandedPaths.push({ configPath, previousGatewayBaseUrl });
      this.logger.warn("已恢复被切换路由遗留的旧 Desktop 网关配置", {
        configPath,
        restoredGatewayBaseUrl: previousGatewayBaseUrl,
      });
    } catch (error) {
      this.logger.error("Failed to restore stranded Desktop config path", {
        configPath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  public startDesktopGatewayWatch(): void {
    const interval = this.config.claudeDesktopConfigPatch.desktopWatchIntervalMs ?? 5000;
    if (interval <= 0) {
      this.logger.debug("Desktop gateway drift watch disabled", { intervalMs: interval });
      return;
    }
    if (this.desktopWatchTimer) {
      return;
    }

    const initialTarget = this.resolveDesktopConfigTarget();
    this.desktopWatchLastAppliedId = initialTarget?.appliedId ?? null;
    this.desktopWatchLastConfigPath = initialTarget?.configPath ?? null;
    this.desktopWatchTimer = setInterval(() => this.checkDesktopGatewayDrift(), interval);
    this.desktopWatchTimer.unref?.();
    this.logger.info("已启动 Claude Desktop 网关漂移监听", { intervalMs: interval });
  }

  public stopDesktopGatewayWatch(): void {
    if (!this.desktopWatchTimer) {
      return;
    }
    clearInterval(this.desktopWatchTimer);
    this.desktopWatchTimer = null;
  }

  private applyClaudeCli(): void {
    if (!this.config.claudeConfigPatch.enabled) {
      this.logger.debug("Claude config patching disabled");
      return;
    }

    const settingsPath = this.config.claudeConfigPatch.settingsPath;
    if (!settingsPath) {
      this.logger.warn("Claude config patching skipped because settingsPath is missing");
      return;
    }

    this.recoverStalePatch(settingsPath);

    const settings = this.readSettings(settingsPath);
    const currentBaseUrl = settings.env?.ANTHROPIC_BASE_URL;
    const proxyBaseUrl = `http://${this.config.server.host}:${this.config.server.port}`;

    const nextEnv: Record<string, string> = {
      ...(settings.env ?? {}),
      ANTHROPIC_BASE_URL: proxyBaseUrl,
    };
    const state: PatchState = {
      pid: process.pid,
      patchedAt: new Date().toISOString(),
      settingsPath,
      previousBaseUrl: currentBaseUrl,
      patchedBaseUrl: proxyBaseUrl,
    };

    if (this.config.claudeConfigPatch.autoCompactEnabled ?? true) {
      const hardLimit = this.config.tokenPolicy.hardLimit;
      const reserve = Math.max(1, this.config.claudeConfigPatch.autoCompactReserveTokens ?? 30_000);
      const pct = Math.max(1, Math.min(95, Math.floor(((hardLimit - reserve) / hardLimit) * 100)));

      if (nextEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW === undefined) {
        state.previousAutoCompactWindow = undefined;
        state.patchedAutoCompactWindow = String(hardLimit);
        nextEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW = state.patchedAutoCompactWindow;
      }
      if (nextEnv.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE === undefined) {
        state.previousAutoCompactPct = undefined;
        state.patchedAutoCompactPct = String(pct);
        nextEnv.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = state.patchedAutoCompactPct;
      }
    }

    let nextHooks = settings.hooks;
    if ((this.config.claudeConfigPatch.hookObserverEnabled ?? true) && this.hookIntegration) {
      const result = this.addObserverHooks(settings.hooks, proxyBaseUrl, this.hookIntegration.token);
      nextHooks = result.hooks;
      state.insertedHookUrls = result.urls;
    }

    const nextSettings: ClaudeSettingsFile = {
      ...settings,
      env: nextEnv,
      ...(nextHooks ? { hooks: nextHooks } : {}),
    };

    this.writeSettings(settingsPath, nextSettings);
    this.writeState(state);

    this.logger.info("Patched Claude CLI settings to point at ccproxy-agent", {
      settingsPath,
      previousBaseUrl: currentBaseUrl,
      proxyBaseUrl,
      autoCompactWindow: state.patchedAutoCompactWindow ?? nextEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW,
      autoCompactPct: state.patchedAutoCompactPct ?? nextEnv.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE,
      hookObserver: Boolean(state.insertedHookUrls?.length),
    });
  }

  private restoreClaudeCli(): void {
    if (!existsSync(this.statePath)) {
      return;
    }

    try {
      const state = JSON.parse(readFileSync(this.statePath, "utf8")) as PatchState;
      const settings = this.readSettings(state.settingsPath);
      const nextSettings = this.restoreOwnedCliSettings(settings, state);

      this.writeSettings(state.settingsPath, nextSettings);
      this.safeDeleteState();

      this.logger.debug("Restored Claude CLI settings", {
        settingsPath: state.settingsPath,
        restoredBaseUrl: state.previousBaseUrl,
        removedHookCount: state.insertedHookUrls?.length ?? 0,
      });
    } catch (error) {
      this.logger.error("Failed to restore Claude CLI settings", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private applyClaudeDesktop(): void {
    if (!this.config.claudeDesktopConfigPatch.enabled) {
      this.logger.debug("Claude Desktop config patching disabled");
      return;
    }

    const target = this.resolveDesktopConfigTarget();
    if (!target) {
      this.logger.warn("Claude Desktop config patching skipped because no applied 3P config was found", {
        configLibraryPath: this.config.claudeDesktopConfigPatch.configLibraryPath,
      });
      return;
    }

    this.recoverStaleDesktopPatch(target);

    const gatewayConfig = this.readDesktopGatewayConfig(target.configPath);
    const currentGatewayBaseUrl = gatewayConfig.inferenceGatewayBaseUrl;
    const proxyGatewayBaseUrl = this.buildDesktopProxyGatewayBaseUrl(currentGatewayBaseUrl);

    if (!proxyGatewayBaseUrl) {
      this.logger.warn("Claude Desktop config patching skipped because gateway URL could not be resolved", {
        configPath: target.configPath,
        hasCurrentGatewayBaseUrl: Boolean(currentGatewayBaseUrl),
      });
      return;
    }

    if (currentGatewayBaseUrl === proxyGatewayBaseUrl) {
      this.logger.debug("Claude Desktop settings already point to the proxy", {
        configPath: target.configPath,
        proxyGatewayBaseUrl,
      });
      return;
    }

    if (gatewayConfig.inferenceProvider && gatewayConfig.inferenceProvider !== "gateway") {
      this.logger.warn("Claude Desktop config patching skipped because inferenceProvider is not gateway", {
        configPath: target.configPath,
        inferenceProvider: gatewayConfig.inferenceProvider,
      });
      return;
    }

    const nextConfig: ClaudeDesktopGatewayFile = {
      ...gatewayConfig,
      inferenceProvider: "gateway",
      inferenceGatewayBaseUrl: proxyGatewayBaseUrl,
    };

    if (this.config.claudeDesktopConfigPatch.apiKey) {
      nextConfig.inferenceGatewayApiKey = this.config.claudeDesktopConfigPatch.apiKey;
    }

    if (this.config.claudeDesktopConfigPatch.authScheme) {
      nextConfig.inferenceGatewayAuthScheme = this.config.claudeDesktopConfigPatch.authScheme;
    }

    this.writeDesktopGatewayConfig(target.configPath, nextConfig);
    this.writeDesktopState({
      pid: process.pid,
      patchedAt: new Date().toISOString(),
      configLibraryPath: target.configLibraryPath,
      configPath: target.configPath,
      appliedId: target.appliedId,
      previousGatewayBaseUrl: currentGatewayBaseUrl,
      previousApiKey: gatewayConfig.inferenceGatewayApiKey,
      previousAuthScheme: gatewayConfig.inferenceGatewayAuthScheme,
      strandedConfigPaths: this.desktopStrandedPaths.length > 0 ? this.desktopStrandedPaths : undefined,
    });

    this.logger.info("Patched Claude Desktop 3P gateway to point at ccproxy-agent", {
      configPath: target.configPath,
      previousGatewayBaseUrl: currentGatewayBaseUrl,
      proxyGatewayBaseUrl,
    });
  }

  private restoreClaudeDesktop(): void {
    if (!existsSync(this.desktopStatePath)) {
      return;
    }

    try {
      const state = JSON.parse(readFileSync(this.desktopStatePath, "utf8")) as DesktopPatchState;
      const gatewayConfig = this.readDesktopGatewayConfig(state.configPath);
      const currentGatewayBaseUrl = gatewayConfig.inferenceGatewayBaseUrl;
      const proxyGatewayBaseUrl = this.buildDesktopProxyGatewayBaseUrl(state.previousGatewayBaseUrl);

      if (currentGatewayBaseUrl !== proxyGatewayBaseUrl) {
        this.logger.warn("Skipped Claude Desktop restore because current value no longer points at proxy", {
          configPath: state.configPath,
          currentGatewayBaseUrl,
          proxyGatewayBaseUrl,
        });
        this.safeDeleteDesktopState();
        return;
      }

      const nextConfig: ClaudeDesktopGatewayFile = {
        ...gatewayConfig,
      };

      if (state.previousGatewayBaseUrl) {
        nextConfig.inferenceGatewayBaseUrl = state.previousGatewayBaseUrl;
      } else {
        delete nextConfig.inferenceGatewayBaseUrl;
      }

      if (state.previousApiKey) {
        nextConfig.inferenceGatewayApiKey = state.previousApiKey;
      } else if (this.config.claudeDesktopConfigPatch.apiKey) {
        delete nextConfig.inferenceGatewayApiKey;
      }

      if (state.previousAuthScheme) {
        nextConfig.inferenceGatewayAuthScheme = state.previousAuthScheme;
      } else if (this.config.claudeDesktopConfigPatch.authScheme) {
        delete nextConfig.inferenceGatewayAuthScheme;
      }

      this.writeDesktopGatewayConfig(state.configPath, nextConfig);

      for (const stranded of state.strandedConfigPaths ?? []) {
        if (stranded.configPath === state.configPath) continue;
        try {
          if (!existsSync(stranded.configPath)) continue;
          const strandedConfig = this.readDesktopGatewayConfig(stranded.configPath);
          const strandedProxyUrl = this.buildDesktopProxyGatewayBaseUrl(stranded.previousGatewayBaseUrl);
          if (strandedConfig.inferenceGatewayBaseUrl !== strandedProxyUrl) continue;
          const nextStranded: ClaudeDesktopGatewayFile = { ...strandedConfig };
          if (stranded.previousGatewayBaseUrl) {
            nextStranded.inferenceGatewayBaseUrl = stranded.previousGatewayBaseUrl;
          } else {
            delete nextStranded.inferenceGatewayBaseUrl;
          }
          this.writeDesktopGatewayConfig(stranded.configPath, nextStranded);
          this.logger.debug("Restored stranded Desktop config path", {
            configPath: stranded.configPath,
            restoredGatewayBaseUrl: stranded.previousGatewayBaseUrl,
          });
        } catch (strandedError) {
          this.logger.error("Failed to restore stranded Desktop config path", {
            configPath: stranded.configPath,
            message: strandedError instanceof Error ? strandedError.message : String(strandedError),
          });
        }
      }

      this.safeDeleteDesktopState();

      this.logger.debug("Restored Claude Desktop 3P gateway settings", {
        configPath: state.configPath,
        restoredGatewayBaseUrl: state.previousGatewayBaseUrl,
      });
    } catch (error) {
      this.logger.error("Failed to restore Claude Desktop settings", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private recoverStalePatch(settingsPath: string): void {
    if (!existsSync(this.statePath)) {
      return;
    }

    try {
      const state = JSON.parse(readFileSync(this.statePath, "utf8")) as PatchState;
      if (state.pid === process.pid) {
        return;
      }

      const settings = this.readSettings(settingsPath);
      this.writeSettings(settingsPath, this.restoreOwnedCliSettings(settings, state));
      this.safeDeleteState();

      this.logger.warn("Recovered stale Claude config patch from a previous run", {
        settingsPath,
        restoredBaseUrl: state.previousBaseUrl,
        stalePid: state.pid,
      });
    } catch (error) {
      this.logger.error("Failed to recover stale Claude config patch state", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private recoverStaleDesktopPatch(target: { configPath: string }): void {
    if (!existsSync(this.desktopStatePath)) {
      return;
    }

    try {
      const state = JSON.parse(readFileSync(this.desktopStatePath, "utf8")) as DesktopPatchState;
      if (state.pid === process.pid) {
        return;
      }

      const gatewayConfig = this.readDesktopGatewayConfig(target.configPath);
      const proxyGatewayBaseUrl = this.buildDesktopProxyGatewayBaseUrl(state.previousGatewayBaseUrl);
      if (gatewayConfig.inferenceGatewayBaseUrl !== proxyGatewayBaseUrl) {
        this.safeDeleteDesktopState();
        return;
      }

      this.writeDesktopGatewayConfig(target.configPath, {
        ...gatewayConfig,
        inferenceGatewayBaseUrl: state.previousGatewayBaseUrl,
      });
      this.safeDeleteDesktopState();

      this.logger.warn("Recovered stale Claude Desktop config patch from a previous run", {
        configPath: target.configPath,
        restoredGatewayBaseUrl: state.previousGatewayBaseUrl,
        stalePid: state.pid,
      });
    } catch (error) {
      this.logger.error("Failed to recover stale Claude Desktop config patch state", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private resolveDesktopConfigTarget(): { configLibraryPath: string; metaPath: string; configPath: string; appliedId: string } | null {
    const configLibraryPath = this.config.claudeDesktopConfigPatch.configLibraryPath;
    if (!configLibraryPath) {
      return null;
    }

    const metaPath = path.resolve(configLibraryPath, "_meta.json");
    if (!existsSync(metaPath)) {
      return null;
    }

    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as ClaudeDesktopMetaFile;
    const appliedId = meta.appliedId;
    if (!appliedId || !/^[\w-]+$/.test(appliedId)) {
      return null;
    }

    const configPath = path.resolve(configLibraryPath, `${appliedId}.json`);
    if (!existsSync(configPath)) {
      return null;
    }

    return {
      configLibraryPath,
      metaPath,
      configPath,
      appliedId,
    };
  }

  private buildDesktopProxyGatewayBaseUrl(previousGatewayBaseUrl?: string): string | null {
    const configuredGatewayBaseUrl = this.config.claudeDesktopConfigPatch.gatewayBaseUrl;
    if (configuredGatewayBaseUrl) {
      return configuredGatewayBaseUrl;
    }

    const proxyBaseUrl = `http://${this.config.server.host}:${this.config.server.port}`;
    if (!previousGatewayBaseUrl) {
      return proxyBaseUrl;
    }

    try {
      const previousUrl = new URL(previousGatewayBaseUrl);
      const proxyUrl = new URL(proxyBaseUrl);
      proxyUrl.pathname = previousUrl.pathname;
      proxyUrl.search = previousUrl.search;
      proxyUrl.hash = previousUrl.hash;
      return proxyUrl.toString().replace(/\/$/, previousUrl.pathname.endsWith("/") ? "/" : "");
    } catch {
      return proxyBaseUrl;
    }
  }

  private readSettings(settingsPath: string): ClaudeSettingsFile {
    if (!existsSync(settingsPath)) {
      return {};
    }

    return JSON.parse(readFileSync(settingsPath, "utf8")) as ClaudeSettingsFile;
  }

  private addObserverHooks(
    hooksValue: Record<string, unknown> | undefined,
    proxyBaseUrl: string,
    token: string,
  ): { hooks: Record<string, unknown>; urls: string[] } {
    const hooks = { ...(hooksValue ?? {}) };
    const urls: string[] = [];

    for (const eventName of HOOK_EVENTS) {
      const url = `${proxyBaseUrl}/hooks/${eventName.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()}`;
      const existing = Array.isArray(hooks[eventName]) ? [...hooks[eventName] as unknown[]] : [];
      let refreshed = false;
      const nextExisting = existing.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
        const typedEntry = entry as Record<string, unknown>;
        if (!Array.isArray(typedEntry.hooks)) return entry;
        const nextHookEntries = typedEntry.hooks.map((hook) => {
          if (!hook || typeof hook !== "object" || Array.isArray(hook)) return hook;
          const typedHook = hook as Record<string, unknown>;
          if (typedHook.type !== "http" || typedHook.url !== url) return hook;
          refreshed = true;
          return {
            ...typedHook,
            headers: {
              ...(typedHook.headers && typeof typedHook.headers === "object" ? typedHook.headers : {}),
              "x-ccproxy-hook-token": token,
            },
          };
        });
        return { ...typedEntry, hooks: nextHookEntries };
      });

      if (!refreshed) {
        nextExisting.push({
          matcher: "",
          hooks: [{
            type: "http",
            url,
            timeout: 5,
            headers: { "x-ccproxy-hook-token": token },
          }],
        });
      }
      hooks[eventName] = nextExisting;
      urls.push(url);
    }

    return { hooks, urls };
  }

  private restoreOwnedCliSettings(settings: ClaudeSettingsFile, state: PatchState): ClaudeSettingsFile {
    const nextEnv = { ...(settings.env ?? {}) };
    const proxyBaseUrl = state.patchedBaseUrl ?? `http://${this.config.server.host}:${this.config.server.port}`;

    if (nextEnv.ANTHROPIC_BASE_URL === proxyBaseUrl) {
      if (state.previousBaseUrl) nextEnv.ANTHROPIC_BASE_URL = state.previousBaseUrl;
      else delete nextEnv.ANTHROPIC_BASE_URL;
    }
    if (state.patchedAutoCompactWindow && nextEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW === state.patchedAutoCompactWindow) {
      if (state.previousAutoCompactWindow) nextEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW = state.previousAutoCompactWindow;
      else delete nextEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    }
    if (state.patchedAutoCompactPct && nextEnv.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE === state.patchedAutoCompactPct) {
      if (state.previousAutoCompactPct) nextEnv.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = state.previousAutoCompactPct;
      else delete nextEnv.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
    }

    const hooks = { ...(settings.hooks ?? {}) };
    for (const [eventName, value] of Object.entries(hooks)) {
      if (!Array.isArray(value)) continue;
      const filtered = value.filter((entry) =>
        !(state.insertedHookUrls ?? []).some((url) => JSON.stringify(entry).includes(url)),
      );
      if (filtered.length > 0) hooks[eventName] = filtered;
      else delete hooks[eventName];
    }

    const nextSettings: ClaudeSettingsFile = { ...settings, env: nextEnv };
    if (Object.keys(hooks).length > 0) nextSettings.hooks = hooks;
    else delete nextSettings.hooks;
    return nextSettings;
  }

  private readDesktopGatewayConfig(configPath: string): ClaudeDesktopGatewayFile {
    return JSON.parse(readFileSync(configPath, "utf8")) as ClaudeDesktopGatewayFile;
  }

  private writeSettings(settingsPath: string, settings: ClaudeSettingsFile): void {
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  }

  private writeDesktopGatewayConfig(configPath: string, config: ClaudeDesktopGatewayFile): void {
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }

  private writeState(state: PatchState): void {
    mkdirSync(path.dirname(this.statePath), { recursive: true });
    writeFileSync(this.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  private writeDesktopState(state: DesktopPatchState): void {
    mkdirSync(path.dirname(this.desktopStatePath), { recursive: true });
    writeFileSync(this.desktopStatePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  private safeDeleteState(): void {
    try {
      rmSync(this.statePath, { force: true });
    } catch {
      // Ignore cleanup errors; stale state will be recovered on next start.
    }
  }

  private safeDeleteDesktopState(): void {
    try {
      rmSync(this.desktopStatePath, { force: true });
    } catch {
      // Ignore cleanup errors; stale state will be recovered on next start.
    }
  }
}
