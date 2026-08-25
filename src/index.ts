import { DraftContextService } from "./draft-context.js";
import { SleeperClient } from "./sleeper-client.js";
import { createApp } from "./server.js";

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received: ${value}`);
  }
  return parsed;
}

const port = positiveInteger(process.env.PORT, 3_000);
const sleeper = new SleeperClient({
  baseUrl: process.env.SLEEPER_API_BASE_URL,
  timeoutMs: positiveInteger(process.env.SLEEPER_REQUEST_TIMEOUT_MS, 5_000),
  playerCacheTtlMs: positiveInteger(
    process.env.SLEEPER_PLAYER_CACHE_TTL_MS,
    24 * 60 * 60 * 1_000,
  ),
});
const draftContext = new DraftContextService(sleeper);
const app = createApp(draftContext, {
  defaultUser: process.env.SLEEPER_USER_ID,
  bearerToken: process.env.MCP_BEARER_TOKEN,
  allowedOrigins: process.env.MCP_ALLOWED_ORIGINS
    ?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  maxConcurrentRequests: positiveInteger(process.env.MCP_MAX_CONCURRENT_REQUESTS, 8),
  maxRequestsPerMinute: positiveInteger(process.env.MCP_MAX_REQUESTS_PER_MINUTE, 60),
});

const host = process.env.HOST ?? "127.0.0.1";
const httpServer = app.listen(port, host, () => {
  console.log(`Sleeper Draft Assistant MCP listening on http://${host}:${port}/mcp`);
});

function shutdown(signal: string) {
  console.log(`Received ${signal}; shutting down.`);
  httpServer.close((error) => {
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
