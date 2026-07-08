import path from "node:path";

let override: string | null = null;

/**
 * 覆盖基准目录。Electron 启动时调用,把 config/logs/runtime 解析到 exe 同级目录;
 * 因为 Electron 下 process.execPath 是 Electron 二进制本身,默认值不可靠。
 * 传 null 清除覆盖。
 */
export function setBaseDirectory(directory: string | null): void {
  override = directory ? path.resolve(directory) : null;
}

export function getBaseDirectory(): string {
  if (override) {
    return override;
  }

  if ((process as NodeJS.Process & { pkg?: unknown }).pkg) {
    return path.dirname(process.execPath);
  }

  return process.cwd();
}
