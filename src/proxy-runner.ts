import http from "node:http";
import { spawn } from "node:child_process";
import { loadConfig } from "./config.js";
import { Logger, LogEntry } from "./logger.js";
import { SessionStore } from "./session-store.js";
import { Orchestrator } from "./orchestrator.js";
import { createServer } from "./server.js";
import { ClaudeConfigPatcher } from "./claude-config-patcher.js";
import { resolveFreePort } from "./port-resolver.js";
import { discoverUpstream } from "./upstream-discoverer.js";
import { AppConfig } from "./types.js";
import { DashboardStatus } from "./dashboard.js";

const MAX_PORT_TRIES = 100;
const VERSION = "0.4.1";

export type ProxyStatus = DashboardStatus;

export interface ProxyHandle {
  config: AppConfig;
  logger: Logger;
  server: http.Server;
  patcher: ClaudeConfigPatcher;
  getStatus(): ProxyStatus;
  shutdown(reason: string): Promise<void>;
}

export interface StartProxyOptions {
  onStatus?: (status: ProxyStatus) => void;
  openDashboard?: boolean;
}

function openDashboard(url: string, logger: Logger): void {
  const command =
    process.platform === "win32"
      ? "cmd"
      : process.platform === "darwin"
        ? "open"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];

  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    logger.info("Opened dashboard", { url });
  } catch (error) {
    logger.warn("Failed to open dashboard automatically", {
      url,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function startProxy(options: StartProxyOptions = {}): Promise<ProxyHandle> {
  const config = loadConfig();
  const logger = new Logger(config.logging);
  const sessionStore = new SessionStore(config.runtime.directory);
  const orchestrator = new Orchestrator(config, logger, sessionStore);
  const patcher = new ClaudeConfigPatcher(config, logger);
  const startedAt = new Date().toISOString();

  let status: ProxyStatus = {
    version: VERSION,
    listen: `http://${config.server.host}:${config.server.port}`,
    upstream: `${config.upstream.baseUrl}${config.upstream.chatPath}`,
    upstreamSource: "configured",
    patcherApplied: false,
    startedAt,
    pid: process.pid,
  };

  let server: http.Server;
  let shutdownStarted = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shutdownStarted) {
      return;
    }
    shutdownStarted = true;
    logger.info("Shutting down ccproxy-agent", { reason });
    patcher.restore();
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
      setTimeout(resolve, 1500);
    });
  };

  server = createServer(config, logger, orchestrator, {
    getStatus: () => status,
    requestShutdown: (reason) => {
      void shutdown(reason).then(() => process.exit(0));
    },
  });

  if (config.server.autoPort ?? true) {
    logger.info("Resolving available listen port", {
      host: config.server.host,
      preferredPort: config.server.port,
      maxTries: MAX_PORT_TRIES,
    });
    const resolvedPort = await resolveFreePort(
      config.server.host,
      config.server.port,
      MAX_PORT_TRIES,
      logger,
    );
    config.server.port = resolvedPort;
  } else {
    logger.info("autoPort disabled; using configured listen port", {
      host: config.server.host,
      port: config.server.port,
    });
  }

  let upstreamSource: "configured" | "discovered" = "configured";
  if (config.upstream.autoDiscover ?? true) {
    const discovery = await discoverUpstream(config.upstream.baseUrl, logger);
    config.upstream.baseUrl = discovery.baseUrl;
    upstreamSource = discovery.source;
  } else {
    logger.info("autoDiscover disabled; using configured upstream", { baseUrl: config.upstream.baseUrl });
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.server.port, config.server.host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  patcher.apply();

  status = {
    version: VERSION,
    listen: `http://${config.server.host}:${config.server.port}`,
    upstream: `${config.upstream.baseUrl}${config.upstream.chatPath}`,
    upstreamSource,
    patcherApplied: true,
    startedAt,
    pid: process.pid,
  };

  logger.info("ccproxy-agent started", {
    listen: status.listen,
    upstream: status.upstream,
    upstreamSource,
    dashboard: config.ui.enabled ? status.listen : null,
  });
  options.onStatus?.(status);

  if (config.ui.enabled && (options.openDashboard ?? config.ui.openOnStart)) {
    openDashboard(status.listen, logger);
  }

  return {
    config,
    logger,
    server,
    patcher,
    getStatus: () => status,
    shutdown,
  };
}

export type { LogEntry };
