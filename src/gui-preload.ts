import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import { AppConfig } from "./types.js";
import { LogEntry } from "./logger.js";
import { ProxyStatus } from "./proxy-runner.js";
import { HealthSummary, ProtectionEvent } from "./product-insights.js";

type RendererConfig = AppConfig & {
  vision: AppConfig["vision"] & { apiKeyConfigured: boolean };
};

interface SecretUpdate {
  visionApiKey?: string;
  clearVisionApiKey?: boolean;
}

contextBridge.exposeInMainWorld("ccproxy", {
  getState: () => ipcRenderer.invoke("app:getState") as Promise<{
    status: ProxyStatus | null;
    config: RendererConfig;
    logs: LogEntry[];
    insights: {
      health: HealthSummary;
      events: ProtectionEvent[];
    };
  }>,
  saveConfig: (config: AppConfig, secretUpdate?: SecretUpdate) => ipcRenderer.invoke("app:saveConfig", config, secretUpdate) as Promise<{
    status: ProxyStatus | null;
    config: RendererConfig;
  }>,
  restartProxy: () => ipcRenderer.invoke("app:restartProxy") as Promise<ProxyStatus | null>,
  stopProxy: () => ipcRenderer.invoke("app:stopProxy") as Promise<boolean>,
  startProxy: () => ipcRenderer.invoke("app:startProxy") as Promise<ProxyStatus | null>,
  onStatus: (listener: (status: ProxyStatus) => void) => {
    const wrapped = (_event: IpcRendererEvent, status: ProxyStatus) => listener(status);
    ipcRenderer.on("proxy:status", wrapped);
    return () => ipcRenderer.off("proxy:status", wrapped);
  },
  onLog: (listener: (entry: LogEntry) => void) => {
    const wrapped = (_event: IpcRendererEvent, entry: LogEntry) => listener(entry);
    ipcRenderer.on("proxy:log", wrapped);
    return () => ipcRenderer.off("proxy:log", wrapped);
  },
  onInsights: (listener: (insights: { health: HealthSummary; events: ProtectionEvent[] }) => void) => {
    const wrapped = (_event: IpcRendererEvent, insights: { health: HealthSummary; events: ProtectionEvent[] }) => {
      listener(insights);
    };
    ipcRenderer.on("proxy:insights", wrapped);
    return () => ipcRenderer.off("proxy:insights", wrapped);
  },
  onStopped: (listener: (payload: { reason: string }) => void) => {
    const wrapped = (_event: IpcRendererEvent, payload: { reason: string }) => listener(payload);
    ipcRenderer.on("proxy:stopped", wrapped);
    return () => ipcRenderer.off("proxy:stopped", wrapped);
  },
});
