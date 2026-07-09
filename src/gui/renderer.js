const api = window.ccproxy;

let config = null;
let status = null;
let logs = [];
let insights = null;

const $ = (id) => document.getElementById(id);
const bool = (id) => $(id).checked;
const num = (id) => Number($(id).value);
const val = (id) => $(id).value.trim();
const escapeHtml = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

function setNotice(message) {
  $("notice").textContent = message;
  if (message) {
    setTimeout(() => {
      if ($("notice").textContent === message) $("notice").textContent = "";
    }, 5000);
  }
}

function setLoading(isLoading) {
  document.querySelectorAll("button").forEach((button) => {
    button.disabled = isLoading;
  });
}

function renderLog(entry) {
  const meta = entry.metadata === undefined ? "" : " " + JSON.stringify(entry.metadata);
  return `[${entry.timestamp}] [${String(entry.level).toUpperCase()}] ${entry.message}${meta}`;
}

function renderLogs() {
  const text = logs.slice(-1000).map(renderLog).join("\n");
  $("logsBox").textContent = text || "No logs yet.";
  $("recentLogs").textContent = logs.slice(-18).map(renderLog).join("\n") || "No logs yet.";
}

function renderHealth() {
  const health = insights?.health;
  const box = $("healthGrid");
  if (!box) return;

  if (!health) {
    box.innerHTML = '<div class="empty">Waiting for proxy health data.</div>';
    $("healthScore").textContent = "-";
    return;
  }

  $("healthScore").textContent = `${health.score.ok} ok / ${health.score.warn} warning / ${health.score.off} off`;
  box.innerHTML = health.items.map((item) => `
    <div class="health-item ${item.state}">
      <span class="health-dot ${item.state}"></span>
      <div>
        <strong>${escapeHtml(item.label)}</strong>
        <p>${escapeHtml(item.detail)}</p>
      </div>
    </div>
  `).join("");
}

function eventIcon(kind) {
  return {
    budget: "¥",
    max_tokens: "↓",
    retry: "↻",
    compact: "/",
    chunk: "≡",
    vision: "◐",
    request: "✓",
  }[kind] || "•";
}

function renderProtectionEvents() {
  const events = insights?.events || [];
  $("protectionCount").textContent = `${events.length} recent`;
  const box = $("protectionEvents");
  if (!box) return;

  if (!events.length) {
    box.innerHTML = '<div class="empty">No protection events yet. They will appear here after token budgeting, max_tokens reduction, retries, compact reminders, chunking, or vision preprocessing.</div>';
    return;
  }

  box.innerHTML = events.slice().reverse().map((event) => `
    <div class="event ${event.severity}">
      <div class="event-icon">${escapeHtml(eventIcon(event.kind))}</div>
      <div>
        <div class="event-title">${escapeHtml(event.title)}</div>
        <div class="event-summary">${escapeHtml(event.summary)}</div>
        <div class="event-time">${new Date(event.timestamp).toLocaleString()}</div>
      </div>
    </div>
  `).join("");
}

function renderInsights() {
  renderHealth();
  renderProtectionEvents();
}

function renderStatus() {
  const dot = $("statusDot");
  if (!status) {
    dot.className = "dot off";
    $("statusText").textContent = "Stopped";
    $("listen").textContent = "-";
    $("upstream").textContent = "-";
    $("source").textContent = "-";
    $("process").textContent = "-";
    return;
  }

  dot.className = "dot ok";
  $("statusText").textContent = `Running ${status.version}`;
  $("listen").textContent = status.listen;
  $("upstream").textContent = status.upstream;
  $("source").textContent = `${status.upstreamSource}${status.patcherApplied ? " / patched" : ""}`;
  $("process").textContent = `PID ${status.pid} / ${new Date(status.startedAt).toLocaleString()}`;
}

function fillForm() {
  if (!config) return;
  $("serverHost").value = config.server.host;
  $("serverPort").value = config.server.port;
  $("serverAutoPort").checked = config.server.autoPort ?? true;
  $("upstreamAutoDiscover").checked = config.upstream.autoDiscover ?? true;
  $("upstreamBaseUrl").value = config.upstream.baseUrl;
  $("upstreamChatPath").value = config.upstream.chatPath;
  $("upstreamTimeout").value = config.upstream.timeoutMs;
  $("compactThreshold").value = config.tokenPolicy.compactThreshold;
  $("hardLimit").value = config.tokenPolicy.hardLimit;
  $("safetyMargin").value = config.tokenPolicy.safetyMargin;

  $("visionEnabled").checked = config.vision.enabled;
  $("visionCompare").checked = config.vision.compareModels;
  $("visionBaseUrl").value = config.vision.baseUrl;
  $("visionChatPath").value = config.vision.chatPath;
  $("visionModel").value = config.vision.model;
  $("visionModels").value = (config.vision.models || []).join(", ");
  $("visionApiKeyEnv").value = config.vision.apiKeyEnv || "";
  $("visionTimeout").value = config.vision.timeoutMs;
  $("visionMaxImages").value = config.vision.maxImagesPerRequest;
  $("visionMaxBytes").value = config.vision.maxImageBytes;
  $("visionSummaryTokens").value = config.vision.summaryMaxTokens;
  $("visionStripImages").checked = config.vision.stripImagesAfterSummary;
  $("visionSystemPrompt").value = config.vision.systemPrompt;
}

function collectConfig() {
  const next = structuredClone(config);
  next.server.host = val("serverHost") || "127.0.0.1";
  next.server.port = num("serverPort");
  next.server.autoPort = bool("serverAutoPort");
  next.upstream.autoDiscover = bool("upstreamAutoDiscover");
  next.upstream.baseUrl = val("upstreamBaseUrl");
  next.upstream.chatPath = val("upstreamChatPath") || "/v1/chat/completions";
  next.upstream.timeoutMs = num("upstreamTimeout");
  next.tokenPolicy.compactThreshold = num("compactThreshold");
  next.tokenPolicy.hardLimit = num("hardLimit");
  next.tokenPolicy.safetyMargin = num("safetyMargin");

  next.vision.enabled = bool("visionEnabled");
  next.vision.compareModels = bool("visionCompare");
  next.vision.baseUrl = val("visionBaseUrl");
  next.vision.chatPath = val("visionChatPath") || "/v1/chat/completions";
  next.vision.model = val("visionModel");
  next.vision.models = val("visionModels").split(",").map((item) => item.trim()).filter(Boolean);
  next.vision.apiKeyEnv = val("visionApiKeyEnv") || undefined;
  next.vision.timeoutMs = num("visionTimeout");
  next.vision.maxImagesPerRequest = num("visionMaxImages");
  next.vision.maxImageBytes = num("visionMaxBytes");
  next.vision.summaryMaxTokens = num("visionSummaryTokens");
  next.vision.stripImagesAfterSummary = bool("visionStripImages");
  next.vision.systemPrompt = $("visionSystemPrompt").value;
  next.ui.openOnStart = false;
  return next;
}

async function saveAndRestart() {
  setLoading(true);
  setNotice("Saving config and restarting proxy...");
  try {
    const result = await api.saveConfig(collectConfig());
    config = result.config;
    status = result.status;
    fillForm();
    renderStatus();
    setNotice("Config saved. Proxy restarted.");
  } catch (error) {
    setNotice(error.message || String(error));
  } finally {
    setLoading(false);
  }
}

function switchPage(page) {
  document.querySelectorAll(".section").forEach((item) => item.classList.toggle("active", item.id === page));
  document.querySelectorAll(".nav button").forEach((item) => item.classList.toggle("active", item.dataset.page === page));
  $("pageTitle").textContent = document.querySelector(`[data-page="${page}"]`)?.textContent || "CCProxy Agent";
}

async function boot() {
  if (!api) {
    $("statusText").textContent = "Preload failed";
    setNotice("Preload bridge is unavailable. Please use the latest fixed build.");
    return;
  }

  const state = await api.getState();
  config = state.config;
  status = state.status;
  logs = state.logs || [];
  insights = state.insights || null;
  fillForm();
  renderStatus();
  renderLogs();
  renderInsights();

  api.onStatus((next) => {
    status = next;
    renderStatus();
  });
  api.onLog((entry) => {
    logs.push(entry);
    renderLogs();
  });
  api.onInsights((next) => {
    insights = next;
    renderInsights();
  });
  api.onStopped(() => {
    status = null;
    renderStatus();
  });
}

document.querySelectorAll(".nav button").forEach((button) => {
  button.addEventListener("click", () => switchPage(button.dataset.page));
});
document.querySelectorAll("[data-page-jump]").forEach((button) => {
  button.addEventListener("click", () => switchPage(button.dataset.pageJump));
});

$("saveConfig").addEventListener("click", saveAndRestart);
$("saveVision").addEventListener("click", saveAndRestart);
$("restartProxy").addEventListener("click", async () => {
  setLoading(true);
  setNotice("Restarting proxy...");
  try {
    status = await api.restartProxy();
    renderStatus();
    setNotice("Proxy restarted.");
  } catch (error) {
    setNotice(error.message || String(error));
  } finally {
    setLoading(false);
  }
});
$("stopProxy").addEventListener("click", async () => {
  setLoading(true);
  setNotice("Stopping proxy...");
  try {
    await api.stopProxy();
    status = null;
    renderStatus();
    setNotice("Proxy stopped.");
  } catch (error) {
    setNotice(error.message || String(error));
  } finally {
    setLoading(false);
  }
});
$("startProxy").addEventListener("click", async () => {
  setLoading(true);
  setNotice("Starting proxy...");
  try {
    status = await api.startProxy();
    renderStatus();
    setNotice(status ? "Proxy started." : "Proxy did not return a status.");
  } catch (error) {
    setNotice(error.message || String(error));
  } finally {
    setLoading(false);
  }
});
$("clearLogs").addEventListener("click", () => {
  logs = [];
  renderLogs();
});

boot().catch((error) => {
  $("statusText").textContent = "UI error";
  setNotice(error.message || String(error));
});
