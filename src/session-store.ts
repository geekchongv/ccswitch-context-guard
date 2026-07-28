import { existsSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { OrchestrationRecord } from "./types.js";
import { getBaseDirectory } from "./paths.js";

export class SessionStore {
  private savedSincePrune = 0;

  public constructor(
    private readonly runtimeDirectory: string,
    private readonly maxRecords = 500,
    private readonly retentionDays = 7,
  ) {
    this.prune();
  }

  public save(requestId: string, snapshot: Record<string, unknown>): void {
    const filePath = path.resolve(getBaseDirectory(), this.runtimeDirectory, "sessions", `${requestId}.json`);
    writeFileSync(filePath, JSON.stringify(snapshot, null, 2), "utf8");
    this.savedSincePrune += 1;
    if (this.savedSincePrune >= 25) {
      this.prune();
      this.savedSincePrune = 0;
    }
  }

  public saveRecord(record: OrchestrationRecord): void {
    this.save(record.requestId, record as unknown as Record<string, unknown>);
  }

  public prune(): void {
    const directory = path.resolve(getBaseDirectory(), this.runtimeDirectory, "sessions");
    if (!existsSync(directory)) return;
    const cutoff = Date.now() - Math.max(1, this.retentionDays) * 86_400_000;
    const files = readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        const filePath = path.join(directory, name);
        return { filePath, mtimeMs: statSync(filePath).mtimeMs };
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs);
    const keep = Math.max(10, this.maxRecords);
    for (const [index, file] of files.entries()) {
      if (index >= keep || file.mtimeMs < cutoff) {
        try {
          unlinkSync(file.filePath);
        } catch {
          // Retention cleanup is best effort and must not block requests.
        }
      }
    }
  }
}
