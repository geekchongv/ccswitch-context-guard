import { loadConfig } from "./config.js";
import { Logger } from "./logger.js";
import { SessionStore } from "./session-store.js";
import { Orchestrator } from "./orchestrator.js";
import { createServer } from "./server.js";
import { ClaudeConfigPatcher } from "./claude-config-patcher.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger(config.logging);
  const sessionStore = new SessionStore(config.runtime.directory);
  const orchestrator = new Orchestrator(config, logger, sessionStore);
  const patcher = new ClaudeConfigPatcher(config, logger);
  const server = createServer(config, logger, orchestrator);

  patcher.apply();

  let shutdownStarted = false;
  const shutdown = (reason: string): void => {
    if (shutdownStarted) {
      return;
    }

    shutdownStarted = true;
    logger.info("Shutting down ccproxy-agent", { reason });
    patcher.restore();
    server.close(() => {
      process.exit(0);
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGHUP", () => shutdown("SIGHUP"));
  process.on("beforeExit", () => patcher.restore());
  process.on("exit", () => patcher.restore());
  process.on("uncaughtException", (error) => {
    logger.error("Uncaught exception", {
      message: error.message,
      stack: error.stack,
    });
    shutdown("uncaughtException");
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled rejection", {
      reason: reason instanceof Error ? reason.message : String(reason),
    });
    shutdown("unhandledRejection");
  });

  server.listen(config.server.port, config.server.host, () => {
    logger.info("ccproxy-agent started", {
      listen: `http://${config.server.host}:${config.server.port}`,
      upstream: `${config.upstream.baseUrl}${config.upstream.chatPath}`,
    });
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
