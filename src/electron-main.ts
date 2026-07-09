import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { startProxy, ProxyHandle } from "./proxy-runner.js";
import { AppConfig } from "./types.js";
import { loadConfig, saveConfig } from "./config.js";
import { setBaseDirectory } from "./paths.js";
import { buildHealthSummary, extractProtectionEvents } from "./product-insights.js";

let mainWindow: BrowserWindow | null = null;
let proxyHandle: ProxyHandle | null = null;
let isQuitting = false;

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

  return path.dirname(process.execPath);
}

function sendToWindow(channel: string, payload: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send(channel, payload);
}

function getInsights() {
  const config = proxyHandle?.config ?? loadConfig();
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
    width: 1180,
    height: 760,
    minWidth: 940,
    minHeight: 620,
    title: "CCProxy Agent",
    backgroundColor: "#f5f7fa",
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
  config: proxyHandle?.config ?? loadConfig(),
  logs: proxyHandle?.logger.snapshot() ?? [],
  insights: getInsights(),
}));

ipcMain.handle("app:saveConfig", async (_event, config: AppConfig) => {
  saveConfig(config);
  await restartProxy("config-save");
  return {
    status: proxyHandle?.getStatus() ?? null,
    config: proxyHandle?.config ?? loadConfig(),
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
  createWindow();
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
