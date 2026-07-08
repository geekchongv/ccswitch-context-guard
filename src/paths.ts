import path from "node:path";

export function getBaseDirectory(): string {
  if ((process as NodeJS.Process & { pkg?: unknown }).pkg) {
    return path.dirname(process.execPath);
  }

  return process.cwd();
}
