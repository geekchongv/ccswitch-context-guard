import { writeFileSync } from "node:fs";
import path from "node:path";
import { OrchestrationRecord } from "./types.js";
import { getBaseDirectory } from "./paths.js";

export class SessionStore {
  public constructor(private readonly runtimeDirectory: string) {}

  public save(requestId: string, snapshot: Record<string, unknown>): void {
    const filePath = path.resolve(getBaseDirectory(), this.runtimeDirectory, "sessions", `${requestId}.json`);
    writeFileSync(filePath, JSON.stringify(snapshot, null, 2), "utf8");
  }

  public saveRecord(record: OrchestrationRecord): void {
    this.save(record.requestId, record as unknown as Record<string, unknown>);
  }
}
