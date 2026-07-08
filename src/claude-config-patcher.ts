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

export class ClaudeConfigPatcher {
  private readonly statePath: string;
  private restored = false;

  public constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {
    this.statePath = path.resolve(getBaseDirectory(), this.config.runtime.directory, "claude-config-patch.json");
  }

  public apply(): void {
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

  public restore(): void {
    if (this.restored || !existsSync(this.statePath)) {
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
      this.restored = true;

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

  private readSettings(settingsPath: string): ClaudeSettingsFile {
    if (!existsSync(settingsPath)) {
      return {};
    }

    return JSON.parse(readFileSync(settingsPath, "utf8")) as ClaudeSettingsFile;
  }

  private writeSettings(settingsPath: string, settings: ClaudeSettingsFile): void {
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  }

  private writeState(state: PatchState): void {
    mkdirSync(path.dirname(this.statePath), { recursive: true });
    writeFileSync(this.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  private safeDeleteState(): void {
    try {
      rmSync(this.statePath, { force: true });
    } catch {
      // Ignore cleanup errors; stale state will be recovered on next start.
    }
  }
}
