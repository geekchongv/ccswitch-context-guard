import { appendFileSync } from "node:fs";
import path from "node:path";
import { LoggingConfig } from "./types.js";
import { getBaseDirectory } from "./paths.js";

const levelWeight: Record<LoggingConfig["level"], number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class Logger {
  private readonly filePath: string;

  public constructor(private readonly config: LoggingConfig) {
    this.filePath = path.resolve(getBaseDirectory(), config.directory, "ccproxy-agent.log");
  }

  public debug(message: string, metadata?: unknown): void {
    this.write("debug", message, metadata);
  }

  public info(message: string, metadata?: unknown): void {
    this.write("info", message, metadata);
  }

  public warn(message: string, metadata?: unknown): void {
    this.write("warn", message, metadata);
  }

  public error(message: string, metadata?: unknown): void {
    this.write("error", message, metadata);
  }

  private write(level: LoggingConfig["level"], message: string, metadata?: unknown): void {
    if (levelWeight[level] < levelWeight[this.config.level]) {
      return;
    }

    const timestamp = new Date().toISOString();
    const suffix = metadata === undefined ? "" : ` ${JSON.stringify(metadata)}`;
    const line = `[${timestamp}] [${level.toUpperCase()}] ${message}${suffix}`;

    console.log(line);
    appendFileSync(this.filePath, `${line}\n`, "utf8");
  }
}
