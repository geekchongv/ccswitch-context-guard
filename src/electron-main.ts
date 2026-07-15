import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { startProxy, ProxyHandle } from "./proxy-runner.js";
import { AppConfig } from "./types.js";
import { loadConfig, saveConfig } from "./config.js";
import { setBaseDirectory } from "./paths.js";
import { buildHealthSummary, extractProtectionEvents } from "./product-insights.js";
import {
  clearVisionApiKey,
  hasVisionApiKey,
  readVisionApiKey,
  saveVisionApiKey,
} from "./secret-store.js";

let mainWindow: BrowserWindow | null = null;
let proxyHandle: ProxyHandle | null = null;
let isQuitting = false;
const headless = process.env.CCPROXY_HEADLESS === "1";

// The control center is text/forms only. Software rendering avoids driver-specific
// GPU crashes on managed Windows desktops and headless packaging verification.
app.disableHardwareAcceleration();
if (process.platform === "win32") {
  // Electron's helper GPU process can be blocked on managed Windows images.
  // With hardware acceleration disabled, keeping software compositing in-process
  // avoids a fatal helper crash without exposing remote content to the renderer.
  app.commandLine.appendSwitch("in-process-gpu");
}

function getRendererPath(): string {
  return path.join(app.getAppPath(), "dist", "gui", "index.html");
}

function getPackagedBaseDirectory(): string {
  const portableExecutableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  if (portableExecutableDir) {
    return portableExecutableDir;
  }

  const portableExecutableFile = process.env.PORTABLE_EXECUTABLE_FILE;
  if (portableExecutableFile) {
    return path.dirname(portableExecutableFile);
  }

  if (process.platform === "darwin") {
    return app.getPath("userData");
  }

  return path.dirname(process.execPath);
}

function loadRuntimeConfig(): AppConfig {
  const config = loadConfig();
  if (config.vision.apiKey && !hasVisionApiKey()) {
    try {
      saveVisionApiKey(config.vision.apiKey);
      saveConfig(config);
    } catch {
      // Keep the legacy in-memory key usable if the OS keychain is temporarily unavailable.
    }
  }
  const storedApiKey = readVisionApiKey();
  if (storedApiKey) config.vision.apiKey = storedApiKey;
  return config;
}

function rendererConfig(config: AppConfig): AppConfig & {
  vision: AppConfig["vision"] & { apiKeyConfigured: boolean };
} {
  const safeConfig = structuredClone(config) as AppConfig & {
    vision: AppConfig["vision"] & { apiKeyConfigured: boolean };
  };
  delete safeConfig.vision.apiKey;
  safeConfig.vision.apiKeyConfigured = hasVisionApiKey() || Boolean(config.vision.apiKey) || Boolean(
    config.vision.apiKeyEnv && process.env[config.vision.apiKeyEnv],
  );
  return safeConfig;
}

function sendToWindow(channel: string, payload: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send(channel, payload);
}

function getInsights() {
  const config = proxyHandle?.config ?? loadRuntimeConfig();
  const logs = proxyHandle?.logger.snapshot() ?? [];
  return {
    health: buildHealthSummary({
      status: proxyHandle?.getStatus() ?? null,
      config,
    }),
    events: extractProtectionEvents(logs, 16),
  };
}

function sendInsights(): void {
  sendToWindow("proxy:insights", getInsights());
}

async function stopProxy(reason: string): Promise<void> {
  if (!proxyHandle) {
    return;
  }
  const handle = proxyHandle;
  proxyHandle = null;
  await handle.shutdown(reason);
  sendToWindow("proxy:stopped", { reason });
}

async function startGuiProxy(): Promise<void> {
  proxyHandle = await startProxy({
    config: loadRuntimeConfig(),
    openDashboard: false,
    onStatus: (status) => {
      sendToWindow("proxy:status", status);
      sendInsights();
    },
  });
  proxyHandle.logger.onLog((entry) => {
    sendToWindow("proxy:log", entry);
    sendInsights();
  });
  sendToWindow("proxy:status", proxyHandle.getStatus());
  sendInsights();
}

async function restartProxy(reason: string): Promise<void> {
  await stopProxy(`restart:${reason}`);
  await startGuiProxy();
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 900,
    minHeight: 620,
    title: "CCProxy Agent",
    backgroundColor: "#f7f6f3",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist", "gui-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on("close", async (event) => {
    if (isQuitting) {
      return;
    }
    event.preventDefault();
    isQuitting = true;
    await stopProxy("window-close");
    mainWindow?.destroy();
    app.quit();
  });

  void mainWindow.loadURL(pathToFileURL(getRendererPath()).toString());
}

ipcMain.handle("app:getState", () => ({
  status: proxyHandle?.getStatus() ?? null,
  config: rendererConfig(proxyHandle?.config ?? loadRuntimeConfig()),
  logs: proxyHandle?.logger.snapshot() ?? [],
  insights: getInsights(),
}));

ipcMain.handle("app:saveConfig", async (_event, config: AppConfig, secretUpdate?: {
  visionApiKey?: string;
  clearVisionApiKey?: boolean;
}) => {
  if (secretUpdate?.visionApiKey?.trim()) {
    saveVisionApiKey(secretUpdate.visionApiKey);
  } else if (secretUpdate?.clearVisionApiKey) {
    clearVisionApiKey();
  }
  saveConfig(config);
  await restartProxy("config-save");
  return {
    status: proxyHandle?.getStatus() ?? null,
    config: rendererConfig(proxyHandle?.config ?? loadRuntimeConfig()),
  };
});

ipcMain.handle("app:restartProxy", async () => {
  await restartProxy("manual");
  return proxyHandle?.getStatus() ?? null;
});

ipcMain.handle("app:stopProxy", async () => {
  await stopProxy("manual");
  return true;
});

ipcMain.handle("app:startProxy", async () => {
  if (!proxyHandle) {
    await startGuiProxy();
  }
  return proxyHandle?.getStatus() ?? null;
});

app.whenReady().then(async () => {
  setBaseDirectory(app.isPackaged ? getPackagedBaseDirectory() : process.cwd());
  if (!headless) createWindow();
  await startGuiProxy();
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
