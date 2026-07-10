import { Logger } from "./logger.js";

export interface UpstreamDiscoveryResult {
  baseUrl: string;
  source: "configured" | "discovered";
}

export interface DiscoverOptions {
  candidatePorts?: number[];
  probeTimeoutMs?: number;
}

/** ccswitch 及同类工具常见监听端口,按优先级排序。 */
const DEFAULT_CANDIDATE_PORTS = [15721, 15722, 15723, 15724, 15725, 9527, 8080, 3000, 11434];
const DEFAULT_PROBE_TIMEOUT_MS = 800;

/**
 * 发现可用上游(ccswitch)。
 *
 * 策略:
 * 1. 先验证配置的 configuredBaseUrl 是否可达(命中 /health 或 /v1/models)。
 * 2. 若不可达,在 127.0.0.1 上扫描候选端口,返回第一个响应正常且疑似 ccswitch 的服务。
 * 3. 扫描全部失败时,沿用配置值(不抛错 —— 让真实转发在请求时报错,保留可调试性)。
 */
export async function discoverUpstream(
  configuredBaseUrl: string,
  logger: Logger,
  options: DiscoverOptions = {},
): Promise<UpstreamDiscoveryResult> {
  const candidatePorts = options.candidatePorts ?? DEFAULT_CANDIDATE_PORTS;
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  // 1. 验证配置的上游
  const configuredProbe = await probeUpstream(configuredBaseUrl, probeTimeoutMs);
  if (configuredProbe) {
    logger.debug("已确认配置的上游可达", { baseUrl: configuredBaseUrl });
    return { baseUrl: configuredBaseUrl, source: "configured" };
  }

  logger.warn("配置的上游不可达,开始扫描本地候选端口", {
    configuredBaseUrl,
    candidatePorts,
  });

  // 2. 扫描候选端口
  for (const port of candidatePorts) {
    const candidate = `http://127.0.0.1:${port}`;
    const probe = await probeUpstream(candidate, probeTimeoutMs);
    if (probe) {
      logger.warn("已在候选端口发现可用上游,已自动切换", {
        configuredBaseUrl,
        discoveredBaseUrl: candidate,
        port,
      });
      return { baseUrl: candidate, source: "discovered" };
    }
    logger.debug("候选端口无响应,继续扫描", { candidateBaseUrl: candidate });
  }

  // 3. 全部失败,沿用配置值
  logger.error("未在候选端口发现可用上游,沿用配置值(转发可能失败)", {
    configuredBaseUrl,
    scannedPorts: candidatePorts,
  });
  return { baseUrl: configuredBaseUrl, source: "configured" };
}

/** 探测一个 baseUrl 是否像 ccswitch:命中 /health 或 /v1/models(返回 JSON 含 data 数组)。 */
async function probeUpstream(baseUrl: string, timeoutMs: number): Promise<boolean> {
  try {
    const healthOk = await probeRoute(baseUrl, "/health", timeoutMs);
    if (healthOk) {
      return true;
    }
  } catch {
    // /health 不通,继续试 /v1/models
  }

  try {
    return await probeModelsRoute(baseUrl, "/v1/models", timeoutMs);
  } catch {
    return false;
  }
}

async function probeRoute(baseUrl: string, route: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${route}`, {
      method: "GET",
      signal: controller.signal,
    });
    return response.ok;
  } finally {
    clearTimeout(timeout);
  }
}

/** /v1/models 需要额外校验响应体是 JSON 且含 data 数组,避免误识别无关 HTTP 服务。 */
async function probeModelsRoute(baseUrl: string, route: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${route}`, {
      method: "GET",
      signal: controller.signal,
    });
    if (!response.ok) {
      return false;
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      return false;
    }
    const payload = (await response.json()) as unknown;
    return Boolean(payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data));
  } finally {
    clearTimeout(timeout);
  }
}
