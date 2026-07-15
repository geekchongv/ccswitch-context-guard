import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { safeStorage } from "electron";
import { getBaseDirectory } from "./paths.js";

interface StoredSecrets {
  visionApiKey?: string;
}

function getSecretsPath(): string {
  return path.join(getBaseDirectory(), "secrets.json");
}

function readSecrets(): StoredSecrets {
  const secretsPath = getSecretsPath();
  if (!existsSync(secretsPath)) return {};
  try {
    return JSON.parse(readFileSync(secretsPath, "utf8")) as StoredSecrets;
  } catch {
    return {};
  }
}

function writeSecrets(secrets: StoredSecrets): void {
  const secretsPath = getSecretsPath();
  if (!secrets.visionApiKey) {
    rmSync(secretsPath, { force: true });
    return;
  }
  mkdirSync(path.dirname(secretsPath), { recursive: true });
  writeFileSync(secretsPath, `${JSON.stringify(secrets, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  if (process.platform !== "win32") chmodSync(secretsPath, 0o600);
}

export function hasVisionApiKey(): boolean {
  return Boolean(readSecrets().visionApiKey);
}

export function readVisionApiKey(): string | undefined {
  const encrypted = readSecrets().visionApiKey;
  if (!encrypted || !safeStorage.isEncryptionAvailable()) return undefined;
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
  } catch {
    return undefined;
  }
}

export function saveVisionApiKey(apiKey: string): void {
  const normalized = apiKey.trim();
  if (!normalized) return;
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("系统安全存储当前不可用，API Key 未保存");
  }
  const encrypted = safeStorage.encryptString(normalized).toString("base64");
  writeSecrets({ ...readSecrets(), visionApiKey: encrypted });
}

export function clearVisionApiKey(): void {
  writeSecrets({ ...readSecrets(), visionApiKey: undefined });
}
