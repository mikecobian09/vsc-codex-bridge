import { resolve } from "path";
import { loadConfig } from "./config";
import { Logger } from "./logger";
import { BridgeRegistry } from "./registry";
import { HubServer } from "./server";

async function main(): Promise<void> {
  // The hub package may be launched from different working directories.
  // Resolve repository root relative to compiled output for stable defaults.
  const repoRoot = resolve(__dirname, "..", "..", "..");
  const { config, configPath } = loadConfig(repoRoot);
  const logger = new Logger(config.verboseLogs);

  logger.info(`Loaded hub configuration from ${configPath}`);
  logSecurityPosture(config, logger);

  const registry = new BridgeRegistry(config.bridgeTtlMs);
  const server = new HubServer(config, registry, logger);

  await server.start();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down hub.`);
    await server.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

void main().catch((error) => {
  console.error(`[hub] Fatal startup error: ${String(error)}`);
  process.exit(1);
});

function logSecurityPosture(config: ReturnType<typeof loadConfig>["config"], logger: Logger): void {
  const loopback = isLoopbackHost(config.bindHost);
  const hasToken = config.authToken.trim().length > 0;

  if (!loopback && !hasToken) {
    logger.warn(
      "Security risk: hub is bound to a non-loopback interface without auth token. Set authToken before LAN exposure.",
    );
  } else if (!loopback && hasToken) {
    logger.info("LAN/Tailscale mode detected with token auth enabled.");
  } else if (loopback && !hasToken) {
    logger.info("Localhost mode without token (safe for single-machine local use).");
  }

  if (hasToken && config.authToken.length < 24) {
    logger.warn("Auth token appears short; prefer a long random token (recommended: >= 24 chars).");
  }

  logger.info(
    `Mutation rate limit: max ${config.mutatingRateLimitMax} requests per ${config.mutatingRateLimitWindowMs} ms per client.`,
  );

  if (config.corsAllowedOrigins.length > 0) {
    logger.info(`CORS allowlist enabled for: ${config.corsAllowedOrigins.join(", ")}`);
  } else {
    logger.info("CORS allowlist not configured (cross-origin requests are denied by default).");
  }
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
