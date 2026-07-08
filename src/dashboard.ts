import { LogEntry } from "./logger.js";

export interface DashboardStatus {
  version: string;
  listen: string;
  upstream: string;
  upstreamSource: string;
  patcherApplied: boolean;
  startedAt: string;
  pid: number;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderDashboard(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CCProxy Agent</title>
  <style>
    :root {
      color-scheme: light;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f5f7fa;
      color: #18202f;
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; }
    .shell { max-width: 1180px; margin: 0 auto; padding: 24px; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
    h1 { margin: 0; font-size: 24px; line-height: 1.2; letter-spacing: 0; }
    .subtle { color: #687386; font-size: 13px; }
    .status-pill { display: inline-flex; align-items: center; gap: 8px; min-height: 32px; padding: 0 12px; border: 1px solid #cfd7e3; border-radius: 6px; background: #ffffff; font-weight: 600; }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: #9aa4b2; }
    .dot.ok { background: #12805c; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 16px; }
    .panel { border: 1px solid #d9e0ea; border-radius: 8px; background: #ffffff; box-shadow: 0 1px 2px rgba(16, 24, 40, .04); }
    .metric { padding: 14px; min-height: 88px; }
    .metric label { display: block; color: #687386; font-size: 12px; margin-bottom: 8px; }
    .metric strong { display: block; font-size: 15px; line-height: 1.35; overflow-wrap: anywhere; }
    .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px; border-bottom: 1px solid #e5eaf1; }
    .actions { display: flex; align-items: center; gap: 8px; }
    .toolbar h2 { margin: 0; font-size: 16px; letter-spacing: 0; }
    button { border: 1px solid #c8d2df; border-radius: 6px; background: #ffffff; color: #18202f; min-height: 32px; padding: 0 12px; cursor: pointer; font: inherit; }
    button:hover { background: #f2f5f8; }
    button.danger { border-color: #e2a2a2; color: #9f1d1d; }
    button.danger:hover { background: #fff1f1; }
    pre { margin: 0; padding: 14px; min-height: 380px; max-height: 58vh; overflow: auto; background: #0d1117; color: #d6deeb; border-radius: 0 0 8px 8px; font: 12px/1.55 Consolas, "Liberation Mono", monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
    .warn { color: #a45b00; }
    .error { color: #c62828; }
    @media (max-width: 860px) {
      .shell { padding: 16px; }
      header { align-items: flex-start; flex-direction: column; }
      .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header>
      <div>
        <h1>CCProxy Agent</h1>
        <div class="subtle">Local proxy console</div>
      </div>
      <div class="status-pill"><span id="status-dot" class="dot"></span><span id="status-text">Loading</span></div>
    </header>

    <section class="grid">
      <div class="panel metric"><label>Listen</label><strong id="listen">-</strong></div>
      <div class="panel metric"><label>Upstream</label><strong id="upstream">-</strong></div>
      <div class="panel metric"><label>Source</label><strong id="source">-</strong></div>
      <div class="panel metric"><label>Process</label><strong id="process">-</strong></div>
    </section>

    <section class="panel">
      <div class="toolbar">
        <h2>Runtime Logs</h2>
        <div class="actions">
          <button id="refresh" type="button">Refresh</button>
          <button id="stop" class="danger" type="button">Stop</button>
        </div>
      </div>
      <pre id="logs">Loading...</pre>
    </section>
  </main>

  <script>
    const text = (id, value) => { document.getElementById(id).textContent = value || "-"; };
    const renderLog = (entry) => {
      const meta = entry.metadata === undefined ? "" : " " + JSON.stringify(entry.metadata);
      return "[" + entry.timestamp + "] [" + String(entry.level).toUpperCase() + "] " + entry.message + meta;
    };
    async function refresh() {
      const [statusRes, logsRes] = await Promise.all([fetch("/status"), fetch("/logs")]);
      const status = await statusRes.json();
      const logs = await logsRes.json();
      document.getElementById("status-dot").className = "dot ok";
      text("status-text", "Running " + status.version);
      text("listen", status.listen);
      text("upstream", status.upstream);
      text("source", status.upstreamSource + (status.patcherApplied ? " / patched" : " / not patched"));
      text("process", "PID " + status.pid + " / " + new Date(status.startedAt).toLocaleString());
      const lines = logs.entries.map(renderLog);
      text("logs", lines.length ? lines.join("\\n") : "No logs yet.");
    }
    document.getElementById("refresh").addEventListener("click", refresh);
    document.getElementById("stop").addEventListener("click", async () => {
      const button = document.getElementById("stop");
      button.disabled = true;
      button.textContent = "Stopping";
      await fetch("/shutdown", { method: "POST" });
      text("status-text", "Stopping");
      text("logs", "Shutdown requested. You can close this window.");
    });
    refresh().catch((error) => {
      document.getElementById("status-dot").className = "dot";
      text("status-text", "Unavailable");
      text("logs", error.message || String(error));
    });
    setInterval(refresh, 3000);
  </script>
</body>
</html>`;
}

export function serializeLogs(entries: LogEntry[]): { entries: LogEntry[] } {
  return { entries };
}

export function renderNotFound(path: string): string {
  return `Not found: ${escapeHtml(path)}`;
}
