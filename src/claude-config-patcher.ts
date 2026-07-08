import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AppConfig } from "./types.js";
import { Logger } from "./logger.js";
import { getBaseDirectory } from "./paths.js";

interface ClaudeSettingsFile {
  env?: Record<string, string>;
  [key: string]: unknown;
}

interface PatchState {
  pid: number;
  patchedAt: string;
  settingsPath: string;
  previousBaseUrl?: string;
}

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
}

export class ClaudeConfigPatcher {
  private readonly statePath: string;
  private readonly desktopStatePath: string;
  private restored = false;

  public constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
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

    this.restoreClaudeCli();
    this.restoreClaudeDesktop();
    this.restored = true;
  }

  private applyClaudeCli(): void {
    if (!this.config.claudeConfigPatch.enabled) {
      this.logger.info("Claude config patching disabled");
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

    if (currentBaseUrl === proxyBaseUrl) {
      this.logger.info("Claude settings already point to the proxy", { settingsPath, proxyBaseUrl });
      return;
    }

    const nextSettings: ClaudeSettingsFile = {
      ...settings,
      env: {
        ...(settings.env ?? {}),
        ANTHROPIC_BASE_URL: proxyBaseUrl,
      },
    };

    this.writeSettings(settingsPath, nextSettings);
    this.writeState({
      pid: process.pid,
      patchedAt: new Date().toISOString(),
      settingsPath,
      previousBaseUrl: currentBaseUrl,
    });

    this.logger.info("Patched Claude CLI settings to point at ccproxy-agent", {
      settingsPath,
      previousBaseUrl: currentBaseUrl,
      proxyBaseUrl,
    });
  }

  private restoreClaudeCli(): void {
    if (!existsSync(this.statePath)) {
      return;
    }

    try {
      const state = JSON.parse(readFileSync(this.statePath, "utf8")) as PatchState;
      const settings = this.readSettings(state.settingsPath);
      const currentBaseUrl = settings.env?.ANTHROPIC_BASE_URL;
      const proxyBaseUrl = `http://${this.config.server.host}:${this.config.server.port}`;

      if (currentBaseUrl !== proxyBaseUrl) {
        this.logger.warn("Skipped Claude settings restore because current value no longer points at proxy", {
          settingsPath: state.settingsPath,
          currentBaseUrl,
          proxyBaseUrl,
        });
        this.safeDeleteState();
        this.restored = true;
        return;
      }

      const nextEnv = { ...(settings.env ?? {}) };
      if (state.previousBaseUrl) {
        nextEnv.ANTHROPIC_BASE_URL = state.previousBaseUrl;
      } else {
        delete nextEnv.ANTHROPIC_BASE_URL;
      }

      const nextSettings: ClaudeSettingsFile = {
        ...settings,
        env: nextEnv,
      };

      this.writeSettings(state.settingsPath, nextSettings);
      this.safeDeleteState();

      this.logger.info("Restored Claude CLI settings", {
        settingsPath: state.settingsPath,
        restoredBaseUrl: state.previousBaseUrl,
      });
    } catch (error) {
      this.logger.error("Failed to restore Claude CLI settings", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private applyClaudeDesktop(): void {
    if (!this.config.claudeDesktopConfigPatch.enabled) {
      this.logger.info("Claude Desktop config patching disabled");
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
      this.logger.info("Claude Desktop settings already point to the proxy", {
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
      this.safeDeleteDesktopState();

      this.logger.info("Restored Claude Desktop 3P gateway settings", {
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
      const proxyBaseUrl = `http://${this.config.server.host}:${this.config.server.port}`;
      if (settings.env?.ANTHROPIC_BASE_URL !== proxyBaseUrl) {
        this.safeDeleteState();
        return;
      }

      const nextEnv = { ...(settings.env ?? {}) };
      if (state.previousBaseUrl) {
        nextEnv.ANTHROPIC_BASE_URL = state.previousBaseUrl;
      } else {
        delete nextEnv.ANTHROPIC_BASE_URL;
      }

      this.writeSettings(settingsPath, {
        ...settings,
        env: nextEnv,
      });
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
