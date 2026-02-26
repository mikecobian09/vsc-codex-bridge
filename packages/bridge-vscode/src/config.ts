import * as vscode from "vscode";
import { accessSync, constants, existsSync, readdirSync } from "fs";
import { delimiter, join } from "path";
import { AppServerMode, BackendMode, ExtensionConfig } from "./types";

const CONFIG_NAMESPACE = "vscCodexBridge";

export function readConfig(): ExtensionConfig {
  const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);

  const bindHost = normalizeString(config.get<string>("bindHost"), "127.0.0.1");
  const bindPort = normalizePort(config.get<number>("bindPort"), 0);

  const hubUrl = normalizeString(config.get<string>("hubUrl"), "http://127.0.0.1:7777");
  const hubRegisterPath = normalizePath(config.get<string>("hubRegisterPath"), "/api/v1/internal/bridges/register");
  const hubHeartbeatPath = normalizePath(
    config.get<string>("hubHeartbeatPath"),
    "/api/v1/internal/bridges/:bridgeId/heartbeat",
  );
  const hubToken = normalizeString(config.get<string>("hubToken"), "");
  const heartbeatIntervalMs = normalizeHeartbeat(config.get<number>("heartbeatIntervalMs"), 5000);

  const appServerCommand = resolveAppServerCommand(normalizeString(config.get<string>("appServerCommand"), "codex"));
  const appServerExtraArgs = normalizeStringArray(config.get<string[]>("appServerExtraArgs"));
  const appServerHost = normalizeString(config.get<string>("appServerHost"), "127.0.0.1");
  const appServerMode = normalizeAppServerMode(config.get<string>("appServerMode"));
  const appServerAttachUrl = normalizeWebSocketUrl(config.get<string>("appServerAttachUrl"));
  const appServerStartupTimeoutMs = normalizeHeartbeat(config.get<number>("appServerStartupTimeoutMs"), 15000);
  const appServerExperimentalApi = Boolean(config.get<boolean>("appServerExperimentalApi", true));

  const backendMode = normalizeBackendMode(config.get<string>("backendMode"));
  const fullAccessAutoApprove = Boolean(config.get<boolean>("fullAccessAutoApprove", true));
  const autoStartBridge = Boolean(config.get<boolean>("autoStartBridge", true));
  const managedHubEnabled = Boolean(config.get<boolean>("manageHubInExtension", true));
  const managedHubBindHost = normalizeString(config.get<string>("managedHubBindHost"), "0.0.0.0");
  const managedHubPort = normalizePort(config.get<number>("managedHubPort"), 7777);
  const verboseLogs = Boolean(config.get<boolean>("verboseLogs", false));

  const resolvedHubUrl = managedHubEnabled
    ? `http://${normalizeHubClientHost(managedHubBindHost)}:${managedHubPort}`
    : hubUrl;

  return {
    internal: {
      bindHost,
      bindPort,
    },
    hub: {
      hubUrl: resolvedHubUrl,
      hubRegisterPath,
      hubHeartbeatPath,
      hubToken,
      heartbeatIntervalMs,
    },
    appServer: {
      mode: appServerMode,
      attachUrl: appServerAttachUrl,
      command: appServerCommand,
      extraArgs: appServerExtraArgs,
      host: appServerHost,
      startupTimeoutMs: appServerStartupTimeoutMs,
      experimentalApi: appServerExperimentalApi,
    },
    runtime: {
      backendMode,
      fullAccessAutoApprove,
      autoStartBridge,
    },
    managedHub: {
      enabled: managedHubEnabled,
      bindHost: managedHubBindHost,
      port: managedHubPort,
    },
    verboseLogs,
  };
}

function normalizeString(value: string | undefined, fallback: string): string {
  if (!value) {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function normalizePath(value: string | undefined, fallback: string): string {
  const path = normalizeString(value, fallback);
  return path.startsWith("/") ? path : `/${path}`;
}

function normalizePort(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return fallback;
  }
  if (value < 0 || value > 65535) {
    return fallback;
  }
  return Math.floor(value);
}

function normalizeHeartbeat(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return fallback;
  }

  const rounded = Math.floor(value);
  if (rounded < 1000) {
    return 1000;
  }

  return rounded;
}

function normalizeStringArray(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

function normalizeBackendMode(value: string | undefined): BackendMode {
  if (value === "simulated") {
    return "simulated";
  }
  return "app-server";
}

function normalizeAppServerMode(value: string | undefined): AppServerMode {
  if (value === "attach") {
    return "attach";
  }
  return "spawn";
}

function normalizeWebSocketUrl(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      return null;
    }
  } catch {
    return null;
  }

  return trimmed;
}

function normalizeHubClientHost(host: string): string {
  const normalized = host.trim().toLowerCase();
  if (normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]") {
    return "127.0.0.1";
  }
  return host;
}

function resolveAppServerCommand(configuredCommand: string): string {
  const normalized = normalizeString(configuredCommand, "codex");

  // Respect explicit custom command/path configured by the user.
  if (normalized !== "codex") {
    return normalized;
  }

  // Fast path when PATH already resolves the codex executable.
  if (isCommandResolvableOnPath("codex")) {
    return "codex";
  }

  // VS Code GUI sessions can have a reduced PATH. In that case, try the
  // bundled codex binary shipped by the OpenAI ChatGPT extension.
  const bundled = findBundledCodexFromOpenAiExtension();
  return bundled ?? "codex";
}

function findBundledCodexFromOpenAiExtension(): string | null {
  const openaiExtension = vscode.extensions.getExtension("openai.chatgpt");
  if (!openaiExtension) {
    return null;
  }

  const binRoot = join(openaiExtension.extensionPath, "bin");
  if (!existsSync(binRoot)) {
    return null;
  }

  const preferredSubdir = preferredCodexSubdir();
  const candidateNames = codexExecutableNames();

  if (preferredSubdir) {
    for (const name of candidateNames) {
      const candidate = join(binRoot, preferredSubdir, name);
      if (isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }

  return findExecutableRecursively(binRoot, new Set(candidateNames), 4);
}

function preferredCodexSubdir(): string | null {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return "macos-aarch64";
  }
  if (process.platform === "darwin" && process.arch === "x64") {
    return "macos-x64";
  }
  if (process.platform === "linux" && process.arch === "arm64") {
    return "linux-aarch64";
  }
  if (process.platform === "linux" && process.arch === "x64") {
    return "linux-x64";
  }
  if (process.platform === "win32" && process.arch === "arm64") {
    return "windows-aarch64";
  }
  if (process.platform === "win32" && process.arch === "x64") {
    return "windows-x64";
  }

  return null;
}

function codexExecutableNames(): string[] {
  if (process.platform === "win32") {
    return ["codex.exe", "codex.cmd", "codex.bat", "codex"];
  }
  return ["codex"];
}

function findExecutableRecursively(rootDir: string, names: Set<string>, maxDepth: number): string | null {
  if (maxDepth < 0) {
    return null;
  }

  let entries: { name: string; isDirectory: () => boolean }[] = [];
  try {
    entries = readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      continue;
    }
    if (!names.has(entry.name)) {
      continue;
    }

    const candidate = join(rootDir, entry.name);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const nested = findExecutableRecursively(join(rootDir, entry.name), names, maxDepth - 1);
    if (nested) {
      return nested;
    }
  }

  return null;
}

function isCommandResolvableOnPath(command: string): boolean {
  const pathValue = process.env.PATH ?? "";
  if (!pathValue) {
    return false;
  }

  const paths = pathValue.split(delimiter).filter((segment) => segment.trim().length > 0);
  const suffixes =
    process.platform === "win32"
      ? [""].concat((process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").map((item) => item.toLowerCase()))
      : [""];

  for (const basePath of paths) {
    for (const suffix of suffixes) {
      const candidate =
        process.platform === "win32" ? join(basePath, `${command}${suffix}`) : join(basePath, command);

      if (isExecutableFile(candidate)) {
        return true;
      }
    }
  }

  return false;
}

function isExecutableFile(filePath: string): boolean {
  if (!existsSync(filePath)) {
    return false;
  }

  try {
    if (process.platform === "win32") {
      return true;
    }

    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
