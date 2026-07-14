const api = window.ccproxy;

let config = null;
let status = null;
let logs = [];
let insights = null;
let noticeTimer = null;
let activePage = "overview";

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

const pageCopy = {
  overview: ["运行概览", "查看代理链路与上下文保护状态"],
  config: ["代理设置", "配置网络、Token 策略与 Claude 集成"],
  vision: ["多模态", "管理图片预处理与视觉模型路由"],
  logs: ["运行日志", "检查实时事件与代理诊断信息"],
};

function setNotice(message, kind = "info") {
  const notice = $("notice");
  window.clearTimeout(noticeTimer);
  notice.textContent = message;
  notice.className = `notice show${kind === "error" ? " error" : ""}`;
  noticeTimer = window.setTimeout(() => {
    notice.className = "notice";
  }, 4200);
}

function setLoading(isLoading) {
  document.querySelectorAll("button:not(#themeToggle)").forEach((button) => {
    button.disabled = isLoading;
  });
  document.body.setAttribute("aria-busy", String(isLoading));
}

function formatAddress(value) {
  return value || "—";
}

function formatTime(timestamp) {
  if (!timestamp) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).format(new Date(timestamp));
}

function renderLog(entry) {
  const meta = entry.metadata === undefined ? "" : ` ${JSON.stringify(entry.metadata)}`;
  return `[${entry.timestamp}] [${String(entry.level).toUpperCase()}] ${entry.message}${meta}`;
}

function renderLogs() {
  const recent = logs.slice(-1000).map(renderLog);
  $("logsBox").textContent = recent.join("\n") || "暂无日志。代理启动后，运行事件会显示在这里。";
  $("recentLogs").textContent = recent.slice(-10).join("\n") || "暂无日志。代理启动后，运行事件会显示在这里。";
  if (activePage === "logs") $("logsBox").scrollTop = $("logsBox").scrollHeight;
}

function healthLabel(item) {
  return {
    proxy: "本地代理",
    upstream: "CC Switch 上游",
    claude: "Claude 路由",
    vision: "视觉能力",
  }[item.id] || item.label;
}

function healthDetail(item) {
  const detail = String(item.detail || "");
  const translations = {
    "not running": "尚未运行",
    "waiting for proxy start": "等待代理启动",
    "not patched yet": "尚未完成路由接管",
    "CLI/Desktop patched": "CLI / Desktop 路由已接管",
    disabled: "未启用",
    ready: "已就绪",
  };
  return translations[detail] || detail.replace(" upstream", " · 已连接");
}

function renderHealth() {
  const health = insights?.health;
  const box = $("healthGrid");
  if (!health) {
    box.innerHTML = '<div class="empty">正在等待健康检查结果…</div>';
    $("healthScore").textContent = "等待检查";
    return;
  }

  $("healthScore").textContent = `${health.score.ok} 正常 · ${health.score.warn} 注意 · ${health.score.off} 未启用`;
  box.innerHTML = health.items.map((item) => `
    <div class="health-item">
      <span class="health-dot ${item.state}"></span>
      <div><strong>${escapeHtml(healthLabel(item))}</strong><p>${escapeHtml(healthDetail(item))}</p></div>
    </div>
  `).join("");
}

function eventIcon(kind) {
  return { budget: "B", max_tokens: "↘", retry: "R", compact: "C", tool: "T", chunk: "S", vision: "V", request: "✓" }[kind] || "·";
}

function renderProtectionEvents() {
  const events = insights?.events || [];
  $("protectionCount").textContent = `${events.length} 条`;
  const box = $("protectionEvents");
  if (!events.length) {
    box.innerHTML = '<div class="empty">暂无保护事件<br>Token 预算调整、Compact 提醒和视觉预处理会显示在这里。</div>';
    return;
  }

  box.innerHTML = events.slice().reverse().map((event) => `
    <div class="event ${event.severity}">
      <div class="event-icon">${escapeHtml(eventIcon(event.kind))}</div>
      <div><div class="event-title">${escapeHtml(event.title)}</div><div class="event-summary">${escapeHtml(event.summary)}</div></div>
      <div class="event-time">${escapeHtml(formatTime(event.timestamp))}</div>
    </div>
  `).join("");
}

function renderInsights() {
  renderHealth();
  renderProtectionEvents();
}

function renderStatus() {
  const dots = [$("statusDot"), $("sideStatusDot"), $("controlStatusDot")];
  if (!status) {
    dots.forEach((dot) => { dot.className = "dot off"; });
    $("statusText").textContent = "代理已停止";
    $("controlStatus").textContent = "代理未运行";
    $("controlDetail").textContent = "点击启动以接管本地链路";
    $("listen").textContent = "—";
    $("upstream").textContent = "—";
    $("source").textContent = "—";
    $("process").textContent = "—";
    $("routeListen").textContent = "等待启动";
    $("routeUpstream").textContent = "CC Switch";
    $("sideListen").textContent = "未运行";
    $("sideVersion").textContent = "CCProxy Agent";
    $("startProxy").disabled = false;
    $("stopProxy").disabled = true;
    return;
  }

  dots.forEach((dot) => { dot.className = "dot ok"; });
  $("statusText").textContent = `运行中 · v${status.version}`;
  $("controlStatus").textContent = "保护链路已启用";
  $("controlDetail").textContent = `PID ${status.pid} · 启动于 ${formatTime(status.startedAt)}`;
  $("listen").textContent = formatAddress(status.listen);
  $("upstream").textContent = formatAddress(status.upstream);
  $("source").textContent = `${status.upstreamSource}${status.patcherApplied ? " · 已接管" : ""}`;
  $("process").textContent = `PID ${status.pid} · ${formatTime(status.startedAt)}`;
  $("routeListen").textContent = status.listen;
  $("routeUpstream").textContent = status.upstream;
  $("sideListen").textContent = status.listen;
  $("sideVersion").textContent = `v${status.version}`;
  $("startProxy").disabled = true;
  $("stopProxy").disabled = false;
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
  $("autoCompactEnabled").checked = config.claudeConfigPatch.autoCompactEnabled ?? true;
  $("autoCompactReserveTokens").value = config.claudeConfigPatch.autoCompactReserveTokens ?? 30000;
  $("hookObserverEnabled").checked = config.claudeConfigPatch.hookObserverEnabled ?? true;
  $("toolResultClearingEnabled").checked = config.tokenPolicy.toolResultClearingEnabled ?? true;
  $("toolResultClearTrigger").value = config.tokenPolicy.toolResultClearTrigger ?? 170000;
  $("toolResultClearTarget").value = config.tokenPolicy.toolResultClearTarget ?? 150000;
  $("toolResultKeepRecent").value = config.tokenPolicy.toolResultKeepRecent ?? 3;
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
  next.claudeConfigPatch.autoCompactEnabled = bool("autoCompactEnabled");
  next.claudeConfigPatch.autoCompactReserveTokens = num("autoCompactReserveTokens");
  next.claudeConfigPatch.hookObserverEnabled = bool("hookObserverEnabled");
  next.tokenPolicy.toolResultClearingEnabled = bool("toolResultClearingEnabled");
  next.tokenPolicy.toolResultClearTrigger = num("toolResultClearTrigger");
  next.tokenPolicy.toolResultClearTarget = num("toolResultClearTarget");
  next.tokenPolicy.toolResultKeepRecent = num("toolResultKeepRecent");
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

function validateConfig(next) {
  if (!next.server.port || next.server.port < 1 || next.server.port > 65535) return "监听端口必须在 1–65535 之间。";
  if (!next.upstream.baseUrl) return "请填写上游 Base URL。";
  if (next.tokenPolicy.compactThreshold >= next.tokenPolicy.hardLimit) return "Compact 提醒阈值必须小于上下文硬上限。";
  if (next.tokenPolicy.toolResultClearTarget >= next.tokenPolicy.toolResultClearTrigger) return "工具结果清理目标值必须小于触发值。";
  return null;
}

async function saveAndRestart() {
  const next = collectConfig();
  const validationError = validateConfig(next);
  if (validationError) {
    setNotice(validationError, "error");
    return;
  }
  setLoading(true);
  setNotice("正在保存配置并重启代理…");
  try {
    const result = await api.saveConfig(next);
    config = result.config;
    status = result.status;
    fillForm();
    renderStatus();
    setNotice("配置已保存，代理已重新启动。");
  } catch (error) {
    setNotice(error.message || String(error), "error");
  } finally {
    setLoading(false);
    renderStatus();
  }
}

function switchPage(page) {
  activePage = page;
  document.querySelectorAll(".section").forEach((item) => item.classList.toggle("active", item.id === page));
  document.querySelectorAll(".nav-button").forEach((item) => item.classList.toggle("active", item.dataset.page === page));
  const [title, subtitle] = pageCopy[page] || ["CCProxy Agent", ""];
  $("pageTitle").textContent = title;
  $("pageSubtitle").textContent = subtitle;
  document.querySelector(".main").scrollTop = 0;
  if (page === "logs") renderLogs();
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("ccproxy-theme", theme);
  $("themeToggle").title = theme === "dark" ? "切换到浅色主题" : "切换到深色主题";
}

async function runProxyAction(action, pendingMessage, successMessage) {
  setLoading(true);
  setNotice(pendingMessage);
  try {
    status = await action();
    renderStatus();
    setNotice(successMessage);
  } catch (error) {
    setNotice(error.message || String(error), "error");
  } finally {
    setLoading(false);
    renderStatus();
  }
}

async function boot() {
  if (!api) {
    $("statusDot").className = "dot off";
    $("statusText").textContent = "界面桥接失败";
    setNotice("无法连接桌面进程，请重新安装或更新应用。", "error");
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

  api.onStatus((next) => { status = next; renderStatus(); });
  api.onLog((entry) => { logs.push(entry); if (logs.length > 1200) logs = logs.slice(-1000); renderLogs(); });
  api.onInsights((next) => { insights = next; renderInsights(); });
  api.onStopped(() => { status = null; renderStatus(); });
}

document.querySelectorAll(".nav-button").forEach((button) => button.addEventListener("click", () => switchPage(button.dataset.page)));
document.querySelectorAll("[data-page-jump]").forEach((button) => button.addEventListener("click", () => switchPage(button.dataset.pageJump)));
$("saveConfig").addEventListener("click", saveAndRestart);
$("saveVision").addEventListener("click", saveAndRestart);
$("restartProxy").addEventListener("click", () => runProxyAction(() => api.restartProxy(), "正在重启代理…", "代理已重新启动。"));
$("startProxy").addEventListener("click", () => runProxyAction(() => api.startProxy(), "正在启动代理…", "代理已启动。"));
$("stopProxy").addEventListener("click", async () => {
  setLoading(true);
  setNotice("正在停止代理…");
  try {
    await api.stopProxy();
    status = null;
    renderStatus();
    setNotice("代理已停止。");
  } catch (error) {
    setNotice(error.message || String(error), "error");
  } finally {
    setLoading(false);
    renderStatus();
  }
});
$("clearLogs").addEventListener("click", () => { logs = []; renderLogs(); setNotice("日志显示已清空，不影响磁盘日志。"); });
$("themeToggle").addEventListener("click", () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && (activePage === "config" || activePage === "vision")) {
    event.preventDefault();
    void saveAndRestart();
  }
  if ((event.ctrlKey || event.metaKey) && event.key === ",") {
    event.preventDefault();
    switchPage("config");
  }
});

const savedTheme = localStorage.getItem("ccproxy-theme");
applyTheme(savedTheme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
boot().catch((error) => {
  $("statusDot").className = "dot off";
  $("statusText").textContent = "界面加载失败";
  setNotice(error.message || String(error), "error");
});
