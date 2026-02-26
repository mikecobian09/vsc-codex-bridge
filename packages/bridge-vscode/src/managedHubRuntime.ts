import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { request as httpRequest } from "http";
import { ChildProcess, spawn } from "child_process";
import { join, resolve } from "path";
import * as vscode from "vscode";
import { ExtensionConfig } from "./types";
import { Logger } from "./logger";

interface RuntimePaths {
  mode: "packaged" | "development";
  hubEntryPath: string;
  pwaDistPath: string;
}

export interface ManagedHubState {
  mode: "disabled" | "starting" | "running" | "external" | "stopped" | "error";
  hubUrl: string;
  pwaUrl: string;
  pid: number | null;
  runtimeMode: "packaged" | "development" | null;
  runtimeHubEntryPath: string | null;
  runtimePwaDistPath: string | null;
  configPath: string | null;
  logPath: string | null;
  lastError: string | null;
}

/**
 * Starts/stops an embedded Hub process from the extension host.
 *
 * Design goals:
 * - allow users to install only the extension and still get bridge + hub + PWA,
 * - prefer bundled runtime assets when packaged,
 * - support source-workspace fallback in development mode.
 */
export class ManagedHubRuntime {
  private process: ChildProcess | null = null;
  private state: ManagedHubState = {
    mode: "stopped",
    hubUrl: "http://127.0.0.1:7777",
    pwaUrl: "http://127.0.0.1:7777",
    pid: null,
    runtimeMode: null,
    runtimeHubEntryPath: null,
    runtimePwaDistPath: null,
    configPath: null,
    logPath: null,
    lastError: null,
  };

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: Logger,
  ) {}

  public async start(config: ExtensionConfig): Promise<void> {
    if (!config.managedHub.enabled) {
      this.state.mode = "disabled";
      this.state.hubUrl = config.hub.hubUrl;
      this.state.pwaUrl = config.hub.hubUrl;
      return;
    }

    const hubUrl = `http://${normalizeHubClientHost(config.managedHub.bindHost)}:${config.managedHub.port}`;
    this.state.hubUrl = hubUrl;
    this.state.pwaUrl = buildPwaUrl(hubUrl, config.hub.hubToken);

    if (this.process?.pid && !this.process.killed) {
      this.logger.debug(`Managed hub already running (pid=${this.process.pid}).`);
      this.state.mode = "running";
      this.state.pid = this.process.pid;
      return;
    }

    if (await isHubHealthy(hubUrl)) {
      this.logger.info(`Hub already reachable at ${hubUrl}. Using external process.`);
      this.state.mode = "external";
      this.state.pid = null;
      this.state.lastError = null;
      return;
    }

    const runtimePaths = resolveRuntimePaths(this.context.extensionPath);
    if (!runtimePaths) {
      const message =
        "Embedded hub runtime not found. Rebuild VSIX so it includes runtime assets (hub/shared/pwa), or disable manageHubInExtension.";
      this.state.mode = "error";
      this.state.lastError = message;
      throw new Error(message);
    }

    const storagePath = this.context.globalStorageUri.fsPath;
    mkdirSync(storagePath, { recursive: true });

    const configPath = join(storagePath, "managed-hub.config.json");
    const logPath = join(storagePath, "managed-hub.log");
    this.state.runtimeMode = runtimePaths.mode;
    this.state.runtimeHubEntryPath = runtimePaths.hubEntryPath;
    this.state.runtimePwaDistPath = runtimePaths.pwaDistPath;
    this.state.configPath = configPath;
    this.state.logPath = logPath;
    this.state.mode = "starting";

    const payload = {
      bindHost: config.managedHub.bindHost,
      port: config.managedHub.port,
      authToken: config.hub.hubToken,
      publicDir: runtimePaths.pwaDistPath,
      verboseLogs: config.verboseLogs,
    };
    writeFileSync(configPath, JSON.stringify(payload, null, 2), "utf8");

    this.appendRuntimeLog(logPath, `Starting managed hub in ${runtimePaths.mode} mode: ${runtimePaths.hubEntryPath}`);

    const childEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      VSC_CODEX_HUB_CONFIG: configPath,
      VSC_CODEX_HUB_BIND_HOST: config.managedHub.bindHost,
      VSC_CODEX_HUB_PORT: String(config.managedHub.port),
      VSC_CODEX_HUB_TOKEN: config.hub.hubToken,
      VSC_CODEX_HUB_PUBLIC_DIR: runtimePaths.pwaDistPath,
      VSC_CODEX_HUB_VERBOSE: config.verboseLogs ? "1" : "0",
    };

    const child = spawn(process.execPath, [runtimePaths.hubEntryPath], {
      cwd: this.context.extensionPath,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.process = child;
    this.state.pid = child.pid ?? null;

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = String(chunk).trim();
      if (!text) {
        return;
      }
      this.logger.debug(`[managed-hub stdout] ${text}`);
      if (this.state.logPath) {
        this.appendRuntimeLog(this.state.logPath, `[stdout] ${text}`);
      }
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = String(chunk).trim();
      if (!text) {
        return;
      }
      this.logger.debug(`[managed-hub stderr] ${text}`);
      if (this.state.logPath) {
        this.appendRuntimeLog(this.state.logPath, `[stderr] ${text}`);
      }
    });

    child.on("exit", (code, signal) => {
      void this.handleManagedProcessExit(code, signal);
    });

    const healthy = await waitForHealth(hubUrl, 15_000);
    if (!healthy) {
      const message = `Managed hub did not become healthy at ${hubUrl} within timeout.`;
      this.state.mode = "error";
      this.state.lastError = message;
      this.logger.error(message);
      await this.stop();
      throw new Error(message);
    }

    this.state.mode = this.process ? "running" : "external";
    this.state.lastError = null;
    this.logger.info(
      this.state.mode === "running"
        ? `Managed hub is running at ${hubUrl}`
        : `Hub is reachable at ${hubUrl}; using external/shared process.`,
    );
  }

  public async stop(): Promise<void> {
    if (this.state.mode === "external") {
      this.state.mode = "stopped";
      this.state.pid = null;
      return;
    }

    const current = this.process;
    this.process = null;
    this.state.mode = "stopped";
    this.state.pid = null;
    this.state.lastError = null;

    if (!current || !current.pid || current.killed) {
      return;
    }

    current.kill("SIGTERM");
    const exited = await waitForProcessExit(current, 4_000);
    if (exited) {
      return;
    }

    this.logger.warn("Managed hub did not exit after SIGTERM, forcing SIGKILL.");
    current.kill("SIGKILL");
    await waitForProcessExit(current, 2_000);
  }

  public async restart(config: ExtensionConfig): Promise<void> {
    await this.stop();
    await this.start(config);
  }

  public isRunning(): boolean {
    return this.state.mode === "running" || this.state.mode === "external";
  }

  public getState(): ManagedHubState {
    return { ...this.state };
  }

  public getPwaUrl(): string {
    return this.state.pwaUrl;
  }

  private appendRuntimeLog(logPath: string, line: string): void {
    try {
      appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`);
    } catch {
      // Logging should never fail runtime operations.
    }
  }

  private async handleManagedProcessExit(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (this.state.mode === "stopped" || this.state.mode === "disabled") {
      return;
    }

    this.process = null;
    this.state.pid = null;

    // Multi-window coordination:
    // If another extension host already owns a healthy hub on the same address,
    // treat this exit as expected and switch to external/shared mode.
    if (await isHubHealthy(this.state.hubUrl)) {
      this.state.mode = "external";
      this.state.lastError = null;
      this.logger.info(
        `Managed hub child exited (code=${String(code)}, signal=${String(signal)}), but hub remains healthy at ${this.state.hubUrl}. Using external/shared hub.`,
      );
      return;
    }

    const message = `Managed hub exited (code=${String(code)}, signal=${String(signal)})`;
    this.logger.warn(message);
    this.state.mode = "error";
    this.state.lastError = message;
  }
}

function resolveRuntimePaths(extensionPath: string): RuntimePaths | null {
  const packaged = {
    mode: "packaged" as const,
    hubEntryPath: join(extensionPath, "runtime", "hub", "out", "index.js"),
    pwaDistPath: join(extensionPath, "runtime", "pwa", "dist"),
  };
  if (existsSync(packaged.hubEntryPath) && existsSync(packaged.pwaDistPath)) {
    return packaged;
  }

  // Local development fallback: extension is loaded from monorepo sources.
  const repoRoot = resolve(extensionPath, "..", "..");
  const development = {
    mode: "development" as const,
    hubEntryPath: join(repoRoot, "packages", "hub", "out", "index.js"),
    pwaDistPath: join(repoRoot, "packages", "pwa", "dist"),
  };
  if (existsSync(development.hubEntryPath) && existsSync(development.pwaDistPath)) {
    return development;
  }

  return null;
}

async function waitForHealth(hubUrl: string, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isHubHealthy(hubUrl)) {
      return true;
    }
    await sleep(250);
  }
  return false;
}

async function isHubHealthy(hubUrl: string): Promise<boolean> {
  try {
    const url = new URL("/healthz", hubUrl);
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const req = httpRequest(
        {
          method: "GET",
          hostname: url.hostname,
          port: Number(url.port || 80),
          path: url.pathname + url.search,
          timeout: 1_500,
        },
        (response) => {
          response.resume();
          if (response.statusCode === 200) {
            resolvePromise();
            return;
          }
          rejectPromise(new Error(`status=${String(response.statusCode)}`));
        },
      );
      req.on("error", rejectPromise);
      req.on("timeout", () => {
        req.destroy(new Error("timeout"));
      });
      req.end();
    });
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }

  return new Promise<boolean>((resolvePromise) => {
    const timer = setTimeout(() => {
      cleanup();
      resolvePromise(false);
    }, timeoutMs);

    const onExit = () => {
      cleanup();
      resolvePromise(true);
    };

    const cleanup = (): void => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
    };

    child.on("exit", onExit);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function normalizeHubClientHost(host: string): string {
  const normalized = host.trim().toLowerCase();
  if (normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]") {
    return "127.0.0.1";
  }
  return host;
}

function buildPwaUrl(hubUrl: string, token: string): string {
  if (!token) {
    return hubUrl;
  }

  try {
    const url = new URL(hubUrl);
    url.searchParams.set("token", token);
    return url.toString();
  } catch {
    return hubUrl;
  }
}
