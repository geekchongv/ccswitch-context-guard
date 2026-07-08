import { loadConfig } from "./config.js";

async function probe(): Promise<void> {
  const config = loadConfig();
  const routes = [
    "/health",
    "/v1/models",
    "/models",
    "/v1/chat/completions",
    "/v1/messages",
  ];

  for (const route of routes) {
    try {
      const response = await fetch(`${config.upstream.baseUrl}${route}`, {
        method: "GET",
      });
      console.log(`${route} -> ${response.status}`);
    } catch (error) {
      console.log(`${route} -> ERROR ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

probe().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
