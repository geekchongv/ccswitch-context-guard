// End-to-end drift watcher verification.
// Uses a REAL ClaudeConfigPatcher instance with a REAL setInterval timer against
// a temp configLibrary (never touches the user's real Claude-3p config).
// Simulates ccswitch rewrites and asserts the watcher self-heals within the interval.

import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { ClaudeConfigPatcher } from "../src/claude-config-patcher.js";
import { Logger } from "../src/logger.js";
import type { AppConfig } from "../src/types.js";

const ROOT = path.resolve("test-output", "e2e-drift");
const CONFIG_LIBRARY = path.join(ROOT, "configLibrary");
const RUNTIME_DIR = "./test-output/e2e-drift/runtime";
const PROXY_PORT = 15799; // distinct from real ports
const WATCH_INTERVAL_MS = 1000; // fast for the test

const APPLIED_ID_A = "00000000-0000-4000-8000-000000e2e001";
const APPLIED_ID_B = "00000000-0000-4000-8000-000000e2e002";
const CCSWITCH_URL = "http://127.0.0.1:15721/claude-desktop";
const PROXY_URL = `http://127.0.0.1:${PROXY_PORT}/claude-desktop`;

function buildConfig(): AppConfig {
  return {
    server: { host: "127.0.0.1", port: PROXY_PORT, autoPort: false },
    upstream: { baseUrl: "http://127.0.0.1:15721", chatPath: "/v1/chat/completions", timeoutMs: 5000, aiRoutes: ["/v1/chat/completions", "/v1/messages"] },
    tokenPolicy: { compactThreshold: 180000, hardLimit: 200000, responseReserve: 12000, chunkTarget: 90000, safetyMargin: 8000, compactMode: "warn", compactWarningText: "", autoReduceMaxTokens: true, retryOnContextError: true, minOutputTokens: 1024 },
    vision: { enabled: false, baseUrl: "", chatPath: "", model: "", compareModels: false, timeoutMs: 5000, maxImagesPerRequest: 5, maxImageBytes: 5_000_000, summaryMaxTokens: 1500, stripImagesAfterSummary: true, systemPrompt: "" },
    logging: { level: "info", directory: "./test-output/e2e-drift/logs" },
    runtime: { directory: RUNTIME_DIR },
    ui: { enabled: false, openOnStart: false },
    claudeConfigPatch: { enabled: false },
    claudeDesktopConfigPatch: { enabled: true, configLibraryPath: CONFIG_LIBRARY, desktopWatchIntervalMs: WATCH_INTERVAL_MS },
  };
}

function writeMeta(appliedId: string): void {
  writeFileSync(
    path.join(CONFIG_LIBRARY, "_meta.json"),
    `${JSON.stringify({ appliedId, entries: [{ id: appliedId, name: "route" }] }, null, 2)}\n`,
    "utf8",
  );
}

function writeGateway(appliedId: string, baseUrl: string): string {
  const configPath = path.join(CONFIG_LIBRARY, `${appliedId}.json`);
  writeFileSync(
    configPath,
    `${JSON.stringify({
      inferenceProvider: "gateway",
      inferenceGatewayBaseUrl: baseUrl,
      inferenceGatewayApiKey: "secret",
      inferenceGatewayAuthScheme: "bearer",
    }, null, 2)}\n`,
    "utf8",
  );
  return configPath;
}

function readGatewayUrl(configPath: string): string {
  return (JSON.parse(readFileSync(configPath, "utf8")) as { inferenceGatewayBaseUrl: string }).inferenceGatewayBaseUrl;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHeal(configPath: string, label: string, maxWaitMs = 6000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await sleep(200);
    try {
      if (readGatewayUrl(configPath) === PROXY_URL) {
        console.log(`  [${label}] healed in ~${Date.now() - start}ms`);
        return true;
      }
    } catch {
      // mid-write, keep waiting
    }
  }
  console.error(`  [${label}] NOT healed after ${maxWaitMs}ms (still ${readGatewayUrl(configPath)})`);
  return false;
}

async function main(): Promise<void> {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(CONFIG_LIBRARY, { recursive: true });
  mkdirSync(path.resolve("test-output/e2e-drift/logs"), { recursive: true });
  mkdirSync(path.resolve(RUNTIME_DIR, "sessions"), { recursive: true });

  const config = buildConfig();
  const logger = new Logger(config.logging);
  const patcher = new ClaudeConfigPatcher(config, logger);

  // --- Boot: apply + start watcher ---
  writeMeta(APPLIED_ID_A);
  const pathA = writeGateway(APPLIED_ID_A, CCSWITCH_URL);
  patcher.apply();
  patcher.startDesktopGatewayWatch();
  console.log("Boot: gateway =", readGatewayUrl(pathA), "(expect", PROXY_URL + ")");
  if (readGatewayUrl(pathA) !== PROXY_URL) throw new Error("boot patch failed");

  // --- Scenario 1: ccswitch rewrites the SAME config file back to its port ---
  console.log("\nScenario 1: ccswitch rewrites same file (URL drift)...");
  writeGateway(APPLIED_ID_A, CCSWITCH_URL);
  console.log("  after ccswitch rewrite:", readGatewayUrl(pathA), "(expect", CCSWITCH_URL + ")");
  const s1 = await waitForHeal(pathA, "S1-URL-drift");
  if (!s1) throw new Error("Scenario 1 failed");

  // --- Scenario 2: ccswitch switches routes (appliedId A -> B) ---
  console.log("\nScenario 2: ccswitch switches appliedId A->B...");
  writeMeta(APPLIED_ID_B);
  const pathB = writeGateway(APPLIED_ID_B, CCSWITCH_URL);
  const s2new = await waitForHeal(pathB, "S2-new-file");
  if (!s2new) throw new Error("Scenario 2 failed: new file not patched");
  // OLD file (pathA) must be restored to ccswitch URL, not left stranded at proxy
  await sleep(500);
  const oldUrl = readGatewayUrl(pathA);
  console.log("  old file (pathA) after switch:", oldUrl, "(expect", CCSWITCH_URL + ")");
  if (oldUrl !== CCSWITCH_URL) throw new Error(`Scenario 2 failed: old file stranded at ${oldUrl}`);

  // --- Scenario 3: ccswitch writes a corrupt/partial file mid-tick ---
  console.log("\nScenario 3: ccswitch writes corrupt file mid-tick...");
  writeFileSync(pathB, "{ broken json", "utf8");
  // watcher tick must not throw; poll until a valid drifted file gets re-patched
  await sleep(WATCH_INTERVAL_MS + 200);
  // now ccswitch "finishes" writing a valid drifted config
  writeGateway(APPLIED_ID_B, CCSWITCH_URL);
  const s3 = await waitForHeal(pathB, "S3-corrupt-recover");
  if (!s3) throw new Error("Scenario 3 failed");

  // --- Shutdown: restore ---
  console.log("\nShutdown: restore()");
  patcher.stopDesktopGatewayWatch();
  patcher.restore();
  const restoredB = readGatewayUrl(pathB);
  const restoredA = readGatewayUrl(pathA);
  console.log("  restored pathB:", restoredB, "(expect", CCSWITCH_URL + ")");
  console.log("  restored pathA:", restoredA, "(expect", CCSWITCH_URL + ")");
  if (restoredB !== CCSWITCH_URL) throw new Error(`restore failed: pathB still ${restoredB}`);
  if (restoredA !== CCSWITCH_URL) throw new Error(`restore failed: pathA still ${restoredA}`);

  console.log("\nALL E2E SCENARIOS PASSED");
}

main().catch((error) => {
  console.error("\nE2E FAILED:", error instanceof Error ? error.message : error);
  process.exit(1);
});
