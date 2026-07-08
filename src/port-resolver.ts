import net from "node:net";
import { Logger } from "./logger.js";

/**
 * 探测一个可用 TCP 端口。
 *
 * 策略:从 preferredPort 开始,用临时 net server 试探绑定;
 * 成功(收到 'listening' 事件)即立即关闭并返回该端口;
 * 失败(EADDRINUSE 等,收到 'error' 事件)则递增到下一个,最多尝试 maxTries 次。
 *
 * 注意:这是 best-effort 探测,存在 TOCTOU 竞态 —— 真正的 server.listen 仍是最终裁决者。
 * 设计上让调用方在 listen 失败时报错,而不是在这里过度防御。
 */
export async function resolveFreePort(
  host: string,
  preferredPort: number,
  maxTries: number,
  logger: Logger,
): Promise<number> {
  for (let attempt = 0; attempt < maxTries; attempt += 1) {
    const port = preferredPort + attempt;
    const outcome = await probePort(host, port);

    if (outcome.ok) {
      if (attempt > 0) {
        logger.warn("配置端口被占用,已自动切换到可用端口", {
          configuredPort: preferredPort,
          attemptedPorts: attempt,
          resolvedPort: port,
        });
      } else {
        logger.info("已确认配置端口可用", { host, port });
      }
      return port;
    }

    logger.info("端口已被占用,尝试下一个端口", {
      host,
      busyPort: port,
      nextPort: attempt + 1 < maxTries ? port + 1 : null,
      reason: outcome.reason,
    });
  }

  const lastTried = preferredPort + maxTries - 1;
  logger.error("未找到可用端口,已超过最大尝试次数", {
    host,
    preferredPort,
    maxTries,
    lastTried,
  });
  throw new Error(
    `无法在 ${host} 上找到可用端口:已从 ${preferredPort} 连续尝试 ${maxTries} 次到 ${lastTried} 均被占用`,
  );
}

/** 试探绑定单个端口。成功返回 {ok:true};失败返回 {ok:false, reason}。 */
function probePort(host: string, port: number): Promise<{ ok: true } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    // 探测 server 不应阻止进程退出。
    probe.unref();

    const cleanup = () => {
      probe.removeAllListeners();
    };

    probe.once("listening", () => {
      cleanup();
      probe.close(() => resolve({ ok: true }));
    });

    probe.once("error", (error: NodeJS.ErrnoException) => {
      cleanup();
      // EADDRINUSE 是预期的"占用";其他错误(如 EACCES)也视为不可用但带上原因。
      resolve({ ok: false, reason: error.code ?? error.message });
    });

    probe.listen(port, host);
  });
}
