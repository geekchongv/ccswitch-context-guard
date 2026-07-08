import { startProxy } from "./proxy-runner.js";

async function main(): Promise<void> {
  const handle = await startProxy();

  const shutdown = (reason: string): void => {
    handle.shutdown(reason).then(() => {
      process.exit(0);
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGHUP", () => shutdown("SIGHUP"));
  process.on("beforeExit", () => handle.patcher.restore());
  process.on("exit", () => handle.patcher.restore());
  process.on("uncaughtException", (error) => {
    handle.logger.error("Uncaught exception", {
      message: error.message,
      stack: error.stack,
    });
    shutdown("uncaughtException");
  });
  process.on("unhandledRejection", (reason) => {
    handle.logger.error("Unhandled rejection", {
      reason: reason instanceof Error ? reason.message : String(reason),
    });
    shutdown("unhandledRejection");
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
