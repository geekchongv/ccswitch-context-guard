import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const packageMetadata = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const releaseDirectory = path.join(root, `release-gui-v${packageMetadata.version}`);
const exePath = path.join(releaseDirectory, `CCProxy-Agent-v${packageMetadata.version}.exe`);
const tempRoot = path.join(root, "test-output", "packaged-smoke");
const configPath = path.join(tempRoot, "config.json");
const portableTemp = path.join(tempRoot, `portable-${Date.now()}`);
const proxyPort = 15922;
if (!fs.existsSync(exePath) || fs.statSync(exePath).size === 0) {
  throw new Error(`packaged executable is missing or empty: ${exePath}`);
}
fs.mkdirSync(tempRoot, { recursive: true });
fs.mkdirSync(portableTemp, { recursive: true });

const upstreamBodies = [];
const upstream = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  upstreamBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  response.writeHead(upstreamBodies.length === 1 ? 400 : 200, { "content-type": "application/json" });
  response.end(upstreamBodies.length === 1
    ? JSON.stringify({ error: { message: "This model's maximum context length is 200000 tokens. However, you requested 1024 output tokens and your prompt contains at least 198977 input tokens, for a total of at least 200001 tokens. (parameter=input_tokens, value=198977)" } })
    : JSON.stringify({ content: [{ type: "text", text: "packaged rescue ok" }] }));
});
await new Promise((resolve, reject) => {
  upstream.once("error", reject);
  upstream.listen(0, "127.0.0.1", resolve);
});
const upstreamAddress = upstream.address();
if (!upstreamAddress || typeof upstreamAddress === "string") throw new Error("mock upstream did not start");

fs.writeFileSync(configPath, `${JSON.stringify({
  server: { host: "127.0.0.1", port: proxyPort, autoPort: false },
  upstream: {
    baseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    chatPath: "/v1/messages",
    aiRoutes: ["/v1/messages"],
    autoDiscover: false,
  },
  tokenPolicy: {
    toolResultClearingEnabled: true,
    toolResultClearTrigger: Number.MAX_SAFE_INTEGER,
    toolResultClearTarget: 2000,
    toolResultKeepRecent: 1,
  },
  ui: { enabled: true, openOnStart: false },
  claudeConfigPatch: { enabled: false, hookObserverEnabled: false },
  claudeDesktopConfigPatch: { enabled: false },
}, null, 2)}\n`, "utf8");

const child = spawn(exePath, [], {
  env: {
    ...process.env,
    CCPROXY_CONFIG: configPath,
    TEMP: portableTemp,
    TMP: portableTemp,
  },
  stdio: "ignore",
  windowsHide: true,
});

function payload() {
  const messages = [];
  for (let index = 0; index < 5; index += 1) {
    messages.push({
      role: "assistant",
      content: [{ type: "tool_use", id: `toolu_${index}`, name: "Read", input: { file_path: `file-${index}.ts` } }],
    });
    messages.push({
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: `toolu_${index}`,
        content: `result-${index} ` + "packaged tool output. ".repeat(1000),
      }],
    });
  }
  return {
    system: [{ type: "text", text: "coding agent" }],
    tools: [{ name: "Read", input_schema: { type: "object" } }],
    messages,
    max_tokens: 1024,
  };
}

async function waitForHealth() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/health`);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("packaged proxy did not become healthy");
}

try {
  const health = await waitForHealth();
  const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload()),
  });
  const body = await response.text();
  if (!response.ok || !body.includes("packaged rescue ok")) {
    throw new Error(`packaged rescue failed: HTTP ${response.status} ${body}`);
  }
  if (upstreamBodies.length !== 2) throw new Error(`expected 2 upstream calls, got ${upstreamBodies.length}`);
  if (JSON.stringify(upstreamBodies[0]).includes("cleared by CCProxy Agent")) {
    throw new Error("first upstream request was unexpectedly pre-cleared");
  }
  if (!JSON.stringify(upstreamBodies[1]).includes("cleared by CCProxy Agent")) {
    throw new Error("retry did not contain cleared tool-result placeholders");
  }
  if (upstreamBodies[1].max_tokens !== 1024) {
    throw new Error(`retry max_tokens changed unexpectedly: ${upstreamBodies[1].max_tokens}`);
  }
  await fetch(`http://127.0.0.1:${proxyPort}/shutdown`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  console.log(JSON.stringify({
    health,
    upstreamCalls: upstreamBodies.length,
    retryPreservedMaxTokens: upstreamBodies[1].max_tokens,
    structuralClearingObserved: true,
  }, null, 2));
} finally {
  try {
    await fetch(`http://127.0.0.1:${proxyPort}/shutdown`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  } catch {}
  const exited = child.exitCode !== null || await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!exited) child.kill();
  await new Promise((resolve) => upstream.close(resolve));
  fs.rmSync(configPath, { force: true });
  fs.rmSync(portableTemp, { recursive: true, force: true });
}
