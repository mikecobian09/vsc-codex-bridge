import * as vscode from "vscode";
import { readConfig } from "./config";
import { BridgeServer } from "./bridgeServer";
import { HubClient, HubRegistrationState } from "./hubClient";
import { Logger } from "./logger";
import { AppServerStore } from "./appServerStore";
import { BridgeStore } from "./store";
import { BridgeStoreLike } from "./storeContracts";
import { BridgeInfo, ExtensionConfig } from "./types";
import { createBridgeId, nowIso } from "./utils";

export class BridgeController {
  private store: BridgeStoreLike | null = null;
  private server: BridgeServer | null = null;
  private hubClient: HubClient | null = null;
  private running = false;
  private startInProgress = false;
  private lastStartError: string | null = null;
  private lifecycleQueue: Promise<void> = Promise.resolve();

  private config: ExtensionConfig;

  public constructor(
    private readonly extensionVersion: string,
    private readonly logger: Logger,
    private readonly statusBar: vscode.StatusBarItem,
  ) {
    this.config = readConfig();
    this.logger.setVerbose(this.config.verboseLogs);
    this.refreshStatusBar();
  }

  public async start(): Promise<void> {
    return this.runInLifecycleQueue(async () => {
      await this.startInternal();
    });
  }

  public async stop(): Promise<void> {
    return this.runInLifecycleQueue(async () => {
      await this.stopInternal();
    });
  }

  public async restart(): Promise<void> {
    return this.runInLifecycleQueue(async () => {
      await this.restartInternal();
    });
  }

  public async reloadConfigAndRestartIfRunning(): Promise<void> {
    return this.runInLifecycleQueue(async () => {
      await this.reloadConfigAndRestartIfRunningInternal();
    });
  }

  private async startInternal(): Promise<void> {
    if (this.running || this.startInProgress) {
      return;
    }

    this.startInProgress = true;
    this.config = readConfig();
    this.logger.setVerbose(this.config.verboseLogs);

    try {
      const workspace = resolveWorkspaceContext(this.logger);
      const bridgeInfo: BridgeInfo = {
        bridgeId: createBridgeId(workspace.cwd),
        workspaceName: workspace.name,
        cwd: workspace.cwd,
        port: 0,
        pid: process.pid,
        startedAt: nowIso(),
        bridgeVersion: this.extensionVersion,
      };

      if (this.config.runtime.backendMode === "app-server") {
        this.store = new AppServerStore(
          bridgeInfo,
          this.config.runtime,
          this.config.appServer,
          this.logger,
          this.extensionVersion,
        );
      } else {
        this.store = new BridgeStore(bridgeInfo, this.config.runtime);
      }

      const store = this.store;
      await store.start?.();

      this.server = new BridgeServer(this.config.internal, store, this.logger);
      await this.server.start();

      this.hubClient = new HubClient(this.config.hub, this.logger, () => {
        return store.getBridgeMeta();
      });
      await this.hubClient.start();

      this.running = true;
      this.lastStartError = null;
      this.refreshStatusBar();

      const address = this.server.getAddress();
      this.logger.info(`Bridge started (${bridgeInfo.bridgeId}) for workspace ${workspace.name}`);
      this.logger.info(`Internal API address: http://${address.host}:${address.port}`);
      this.logger.info(`Bridge backend mode: ${this.config.runtime.backendMode}`);
    } catch (error) {
      const formatted = formatStartupError(error, this.config);
      this.lastStartError = formatted;
      this.logger.error(`Bridge start failed: ${formatted}`);
      await this.stopInternal();
      throw new Error(formatted);
    } finally {
      this.startInProgress = false;
    }
  }

  private async stopInternal(): Promise<void> {
    await this.hubClient?.stop();
    this.hubClient = null;

    await this.server?.stop();
    this.server = null;

    await this.store?.dispose();
    this.store = null;

    this.running = false;
    this.refreshStatusBar();
  }

  private async restartInternal(): Promise<void> {
    await this.stopInternal();
    await this.startInternal();
  }

  private async reloadConfigAndRestartIfRunningInternal(): Promise<void> {
    const previous = this.config;
    this.config = readConfig();
    this.logger.setVerbose(this.config.verboseLogs);

    const changed = JSON.stringify(previous) !== JSON.stringify(this.config);
    if (!changed) {
      return;
    }

    if (this.running) {
      this.logger.info("Configuration changed, restarting bridge.");
      await this.restartInternal();
      return;
    }

    if (this.config.runtime.autoStartBridge) {
      this.logger.info("Configuration changed and auto-start is enabled, starting bridge.");
      await this.startInternal();
      return;
    }

    this.refreshStatusBar();
  }

  public isRunning(): boolean {
    return this.running;
  }

  public shouldAutoStart(): boolean {
    return this.config.runtime.autoStartBridge;
  }

  public getStatusSummary(): string {
    if (!this.running || !this.store || !this.server) {
      return "Bridge is stopped.";
    }

    const meta = this.store.getBridgeMeta();
    const address = this.server.getAddress();

    return [
      `Bridge: running`,
      `Bridge ID: ${meta.bridgeId}`,
      `Workspace: ${meta.workspaceName}`,
      `CWD: ${meta.cwd}`,
      `Internal API: http://${address.host}:${address.port}`,
      `Hub: ${this.config.hub.hubUrl}`,
      `Backend: ${this.config.runtime.backendMode}`,
      `Auto-start on window open: ${this.config.runtime.autoStartBridge}`,
      `App-server mode: ${this.config.appServer.mode}`,
      `Mode default: full-access auto-approve = ${this.config.runtime.fullAccessAutoApprove}`,
    ].join("\n");
  }

  public getDiagnostics(): Record<string, unknown> {
    const address = this.server?.getAddress() ?? null;
    const bridgeMeta = this.store?.getBridgeMeta() ?? null;
    const hubRegistration: HubRegistrationState = this.hubClient?.getRegistrationState() ?? {
      isRegistered: false,
      registrationInFlight: false,
      lastRegisterAttemptAt: null,
      lastRegisterSuccessAt: null,
      lastRegisterError: null,
      currentRetryDelayMs: 1000,
    };

    return {
      ts: nowIso(),
      running: this.running,
      startInProgress: this.startInProgress,
      lastStartError: this.lastStartError,
      address,
      bridge: bridgeMeta,
      hubRegistration,
      config: {
        hubUrl: this.config.hub.hubUrl,
        hubRegisterPath: this.config.hub.hubRegisterPath,
        hubHeartbeatPath: this.config.hub.hubHeartbeatPath,
        backendMode: this.config.runtime.backendMode,
        bindHost: this.config.internal.bindHost,
        bindPort: this.config.internal.bindPort,
        appServerMode: this.config.appServer.mode,
        appServerAttachUrl: this.config.appServer.attachUrl,
        appServerCommand: this.config.appServer.command,
        appServerHost: this.config.appServer.host,
        appServerStartupTimeoutMs: this.config.appServer.startupTimeoutMs,
        autoStartBridge: this.config.runtime.autoStartBridge,
        fullAccessAutoApprove: this.config.runtime.fullAccessAutoApprove,
        verboseLogs: this.config.verboseLogs,
      },
    };
  }

  private refreshStatusBar(): void {
    this.statusBar.text = this.running ? "$(plug) Bridge: On" : "$(circle-slash) Bridge: Off";
    this.statusBar.tooltip = this.running ? "VSC Codex Bridge is running" : "VSC Codex Bridge is stopped";
  }

  private runInLifecycleQueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.lifecycleQueue.then(operation, operation);
    this.lifecycleQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function resolveWorkspaceContext(logger: Logger): { name: string; cwd: string } {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    throw new Error("No workspace folder is open. Open a folder to start the bridge.");
  }

  if (workspaceFolders.length > 1) {
    logger.warn("Multiple workspace folders detected; bridge will use the first folder (single-root mode).");
  }

  const folder = workspaceFolders[0];
  return {
    name: folder.name,
    cwd: folder.uri.fsPath,
  };
}

function formatStartupError(error: unknown, config: ExtensionConfig): string {
  const text = String(error ?? "");

  if (text.includes("ENOENT")) {
    return `Could not launch '${config.appServer.command}'. Ensure Codex CLI is available or set vscCodexBridge.appServerCommand to an absolute codex binary path.`;
  }

  if (text.includes("ECONNREFUSED")) {
    return `Could not connect to app-server websocket in time. Check app-server startup timeout and command output.`;
  }

  if (text.toLowerCase().includes("no workspace folder")) {
    return "Open a workspace folder in VS Code before starting the bridge.";
  }

  return text;
}
