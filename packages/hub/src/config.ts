import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { HubConfig } from "./types";

interface HubConfigFile {
  bindHost?: string;
  port?: number;
  authToken?: string;
  bridgeTtlMs?: number;
  heartbeatPruneIntervalMs?: number;
  mutatingRateLimitWindowMs?: number;
  mutatingRateLimitMax?: number;
  corsAllowedOrigins?: string[];
  publicDir?: string;
  verboseLogs?: boolean;
}

/**
 * Loads runtime configuration from JSON and environment variables.
 *
 * Precedence order:
 * 1. Environment variables.
 * 2. JSON file content.
 * 3. Built-in defaults.
 */
export function loadConfig(cwd: string): { config: HubConfig; configPath: string } {
  const configPath = process.env.VSC_CODEX_HUB_CONFIG
    ? resolve(process.env.VSC_CODEX_HUB_CONFIG)
    : resolve(cwd, "packages/hub/config/hub.config.json");

  const fileConfig = loadConfigFile(configPath);

  const bindHost = normalizeString(process.env.VSC_CODEX_HUB_BIND_HOST, fileConfig.bindHost, "127.0.0.1");
  const port = normalizeNumber(process.env.VSC_CODEX_HUB_PORT, fileConfig.port, 7777, 1, 65535);
  const authToken = normalizeString(process.env.VSC_CODEX_HUB_TOKEN, fileConfig.authToken, "");
  const bridgeTtlMs = normalizeNumber(
    process.env.VSC_CODEX_HUB_BRIDGE_TTL_MS,
    fileConfig.bridgeTtlMs,
    15_000,
    2_000,
    120_000,
  );
  const heartbeatPruneIntervalMs = normalizeNumber(
    process.env.VSC_CODEX_HUB_PRUNE_INTERVAL_MS,
    fileConfig.heartbeatPruneIntervalMs,
    5_000,
    1_000,
    60_000,
  );
  const mutatingRateLimitWindowMs = normalizeNumber(
    process.env.VSC_CODEX_HUB_MUTATION_RATE_WINDOW_MS,
    fileConfig.mutatingRateLimitWindowMs,
    10_000,
    1_000,
    60_000,
  );
  const mutatingRateLimitMax = normalizeNumber(
    process.env.VSC_CODEX_HUB_MUTATION_RATE_MAX,
    fileConfig.mutatingRateLimitMax,
    80,
    5,
    10_000,
  );
  const corsAllowedOrigins = normalizeStringList(
    process.env.VSC_CODEX_HUB_CORS_ALLOWED_ORIGINS,
    fileConfig.corsAllowedOrigins,
    [],
  );

  const defaultPublicDir = resolve(cwd, "packages/pwa/dist");
  const publicDir = normalizeString(process.env.VSC_CODEX_HUB_PUBLIC_DIR, fileConfig.publicDir, defaultPublicDir);
  const verboseLogs = normalizeBoolean(process.env.VSC_CODEX_HUB_VERBOSE, fileConfig.verboseLogs, false);

  const config: HubConfig = {
    bindHost,
    port,
    authToken,
    bridgeTtlMs,
    heartbeatPruneIntervalMs,
    mutatingRateLimitWindowMs,
    mutatingRateLimitMax,
    corsAllowedOrigins,
    publicDir,
    verboseLogs,
  };

  persistConfigIfMissing(configPath, config);

  return { config, configPath };
}

function loadConfigFile(configPath: string): HubConfigFile {
  if (!existsSync(configPath)) {
    return {};
  }

  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as HubConfigFile;
  } catch {
    return {};
  }
}

function persistConfigIfMissing(configPath: string, config: HubConfig): void {
  if (existsSync(configPath)) {
    return;
  }

  mkdirSync(dirname(configPath), { recursive: true });
  const payload: HubConfigFile = {
    bindHost: config.bindHost,
    port: config.port,
    authToken: config.authToken,
    bridgeTtlMs: config.bridgeTtlMs,
    heartbeatPruneIntervalMs: config.heartbeatPruneIntervalMs,
    mutatingRateLimitWindowMs: config.mutatingRateLimitWindowMs,
    mutatingRateLimitMax: config.mutatingRateLimitMax,
    corsAllowedOrigins: config.corsAllowedOrigins,
    publicDir: config.publicDir,
    verboseLogs: config.verboseLogs,
  };

  writeFileSync(configPath, JSON.stringify(payload, null, 2));
}

function normalizeString(primary: string | undefined, secondary: string | undefined, fallback: string): string {
  const value = (primary ?? secondary ?? fallback).trim();
  return value || fallback;
}

function normalizeNumber(
  primary: string | undefined,
  secondary: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const fromEnv = primary ? Number(primary) : undefined;
  const candidate = Number.isFinite(fromEnv) ? fromEnv : secondary;

  if (!Number.isFinite(candidate)) {
    return fallback;
  }

  const bounded = Math.floor(candidate as number);
  if (bounded < min) {
    return min;
  }
  if (bounded > max) {
    return max;
  }
  return bounded;
}

function normalizeBoolean(primary: string | undefined, secondary: boolean | undefined, fallback: boolean): boolean {
  if (typeof primary === "string") {
    const value = primary.trim().toLowerCase();
    return value === "1" || value === "true" || value === "yes";
  }

  if (typeof secondary === "boolean") {
    return secondary;
  }

  return fallback;
}

function normalizeStringList(
  primary: string | undefined,
  secondary: string[] | undefined,
  fallback: string[],
): string[] {
  const source = primary
    ? primary.split(",").map((item) => item.trim())
    : Array.isArray(secondary)
      ? secondary
      : fallback;

  const unique = new Set<string>();
  for (const value of source) {
    if (typeof value !== "string") {
      continue;
    }
    const normalized = value.trim();
    if (!normalized) {
      continue;
    }
    unique.add(normalized);
  }

  return [...unique];
}
