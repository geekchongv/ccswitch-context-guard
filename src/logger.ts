import { appendFileSync, existsSync, renameSync, statSync } from "node:fs";
import { EventEmitter } from "node:events";
import path from "node:path";
import { LoggingConfig } from "./types.js";
import { getBaseDirectory } from "./paths.js";

const levelWeight: Record<LoggingConfig["level"], number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LogEntry {
  timestamp: string;
  level: LoggingConfig["level"];
  message: string;
  metadata?: unknown;
}

const RING_BUFFER_SIZE = 1000;
/** 单个日志文件超过此大小(字节)即轮转为 .1 归档，避免无限增长。 */
const MAX_LOG_BYTES = 5 * 1024 * 1024;

export class Logger {
  private readonly filePath: string;
  private readonly archivePath: string;
  private readonly ringBuffer: LogEntry[] = [];
  private readonly emitter = new EventEmitter();

  public constructor(private readonly config: LoggingConfig) {
    this.filePath = path.resolve(getBaseDirectory(), config.directory, "ccproxy-agent.log");
    this.archivePath = `${this.filePath}.1`;
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

  /** 订阅实时日志。返回取消订阅函数。 */
  public onLog(listener: (entry: LogEntry) => void): () => void {
    this.emitter.on("log", listener);
    return () => {
      this.emitter.off("log", listener);
    };
  }

  /** 返回当前内存环形缓冲的历史日志快照(GUI 首屏用)。 */
  public snapshot(): LogEntry[] {
    return [...this.ringBuffer];
  }

  private write(level: LoggingConfig["level"], message: string, metadata?: unknown): void {
    if (levelWeight[level] < levelWeight[this.config.level]) {
      return;
    }

    const timestamp = new Date().toISOString();
    const entry: LogEntry = { timestamp, level, message, metadata };
    const suffix = metadata === undefined ? "" : ` ${JSON.stringify(metadata)}`;
    const line = `[${timestamp}] [${level.toUpperCase()}] ${message}${suffix}`;

    console.log(line);
    this.rotateIfNeeded();
    appendFileSync(this.filePath, `${line}\n`, "utf8");

    this.ringBuffer.push(entry);
    if (this.ringBuffer.length > RING_BUFFER_SIZE) {
      this.ringBuffer.shift();
    }
    this.emitter.emit("log", entry);
  }

  /** 当前日志文件超过上限时，归档为 .1。可重复触发：每次写入前都检查，达到阈值即轮转。 */
  private rotateIfNeeded(): void {
    try {
      if (!existsSync(this.filePath) || statSync(this.filePath).size < MAX_LOG_BYTES) {
        return;
      }
      // 仅保留最近一份归档，旧 .1 直接覆盖。
      renameSync(this.filePath, this.archivePath);
    } catch {
      // 轮转失败不应阻断日志写入；下次写入会再次尝试。
    }
  }
}
