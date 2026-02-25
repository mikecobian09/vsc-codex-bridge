"use strict";

/**
 * VSC Codex Bridge - Electron Menubar App
 *
 * This runtime provides:
 * - tray controls for hub lifecycle,
 * - a Control Center window (settings + diagnostics),
 * - live workspace visibility from the hub registry.
 */

const { app, Tray, Menu, shell, nativeImage, clipboard, BrowserWindow, ipcMain } = require("electron");
const { spawn } = require("child_process");
const { mkdirSync, readFileSync, appendFileSync, existsSync, writeFileSync } = require("fs");
const { resolve, dirname } = require("path");
const { randomBytes } = require("crypto");
const { networkInterfaces } = require("os");

const POLL_INTERVAL_MS = 3_000;
const HUB_REQUEST_TIMEOUT_MS = 2_000;
const HUB_STOP_TIMEOUT_MS = 4_500;
const CONTROL_CENTER_WIDTH = 1_060;
const CONTROL_CENTER_HEIGHT = 760;

/**
 * @typedef RuntimePaths
 * @property {"development" | "packaged"} mode
 * @property {string} repoRoot
 * @property {string} hubConfigPath
 * @property {string} appSettingsPath
 * @property {string} hubEntryPath
 * @property {string} defaultPublicDir
 * @property {boolean} skipHubCompile
 */

/**
 * Hub runtime state and operations used by tray and control-center UI.
 */
class HubMenubarRuntime {
  /**
   * @param {RuntimePaths} runtimePaths
   */
  constructor(runtimePaths) {
    this.runtimePaths = runtimePaths;
    this.repoRoot = runtimePaths.repoRoot;
    this.configPath = runtimePaths.hubConfigPath;
    this.appSettingsPath = runtimePaths.appSettingsPath;
    this.logPath =
      runtimePaths.mode === "packaged"
        ? resolve(app.getPath("userData"), "hub-menubar.log")
        : resolve(runtimePaths.repoRoot, ".local/logs/hub-menubar.log");

    this.tray = null;
    this.pollTimer = null;
    this.operationQueue = Promise.resolve();
    this.operationInFlight = false;

    this.managedProcess = null;
    this.managedStatus = "stopped"; // stopped | starting | running | stopping | error
    this.lastError = null;
    this.lastExit = null;

    this.hubUrl = "http://127.0.0.1:7777";
    this.hubReachable = false;
    this.hubHealth = null;
    this.connectedWorkspaces = [];
    this.hubConfig = {
      bindHost: "127.0.0.1",
      port: 7777,
      authToken: "",
      verboseLogs: false,
      corsAllowedOrigins: [],
      publicDir: runtimePaths.defaultPublicDir,
    };
    this.authToken = "";
    this.appSettings = {
      launchAtLogin: runtimePaths.mode === "packaged",
      autoStartHubOnLaunch: true,
    };
  }

  async initialize() {
    this.loadHubConfig();
    this.loadAppSettings();
    this.applyLoginItemSettings();
    this.createTray();
    await this.refreshSnapshot();

    if (this.appSettings.autoStartHubOnLaunch) {
      await this.ensureHubRunningOnLaunch();
    }

    this.pollTimer = setInterval(() => {
      void this.refreshSnapshot();
    }, POLL_INTERVAL_MS);
  }

  async shutdown() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.managedProcess) {
      await this.stopHubInternal();
    }
  }

  /**
   * Serialize lifecycle operations and avoid overlapping actions.
   * @param {() => Promise<void>} task
   */
  enqueueOperation(task) {
    this.operationQueue = this.operationQueue
      .then(async () => {
        this.operationInFlight = true;
        this.rebuildTrayMenu();
        this.emitStateChanged();
        try {
          await task();
        } catch (error) {
          this.setError(`Operation failed: ${stringifyError(error)}`);
        } finally {
          this.operationInFlight = false;
          this.rebuildTrayMenu();
          this.emitStateChanged();
        }
      })
      .catch((error) => {
        this.setError(`Unexpected operation queue failure: ${stringifyError(error)}`);
      });

    return this.operationQueue;
  }

  async startHub() {
    await this.enqueueOperation(async () => {
      await this.startHubInternal();
    });
  }

  async stopHub() {
    await this.enqueueOperation(async () => {
      await this.stopHubInternal();
    });
  }

  async restartHub() {
    await this.enqueueOperation(async () => {
      await this.stopHubInternal();
      await this.startHubInternal();
    });
  }

  async refreshSnapshot() {
    this.loadHubConfig();

    const healthResult = await this.fetchHubHealth();
    this.hubReachable = healthResult.ok;
    this.hubHealth = healthResult.payload;

    if (healthResult.ok) {
      const bridgesResult = await this.fetchBridges();
      this.connectedWorkspaces = bridgesResult.ok ? bridgesResult.items : [];
      if (!bridgesResult.ok) {
        this.lastError = bridgesResult.error;
      }
    } else {
      this.connectedWorkspaces = [];
    }

    this.rebuildTrayMenu();
    this.emitStateChanged();
  }

  loadHubConfig() {
    const configFileExists = existsSync(this.configPath);
    const preferNetworkBind = this.runtimePaths.mode === "packaged";
    const generatedToken = createAuthToken();

    const fallback = {
      bindHost: preferNetworkBind ? "0.0.0.0" : "127.0.0.1",
      port: 7777,
      authToken: preferNetworkBind ? generatedToken : "",
      verboseLogs: false,
      corsAllowedOrigins: [],
      publicDir: this.runtimePaths.defaultPublicDir,
    };

    let raw = {};
    if (configFileExists) {
      try {
        const text = readFileSync(this.configPath, "utf8");
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          raw = parsed;
        }
      } catch (error) {
        this.setError(`Failed to parse hub config: ${stringifyError(error)}`);
      }
    }

    const rawAuthToken = typeof raw.authToken === "string" ? raw.authToken.trim() : "";
    const shouldGenerateToken = preferNetworkBind && rawAuthToken.length === 0;
    const resolvedAuthToken = shouldGenerateToken ? generatedToken : rawAuthToken || fallback.authToken;

    const normalized = {
      ...raw,
      bindHost: safeString(raw.bindHost, fallback.bindHost),
      port: safePort(raw.port, fallback.port),
      authToken: resolvedAuthToken,
      verboseLogs: safeBoolean(raw.verboseLogs, fallback.verboseLogs),
      corsAllowedOrigins: normalizeStringArray(raw.corsAllowedOrigins),
      publicDir: safeString(raw.publicDir, fallback.publicDir),
    };

    const missingBindHost = typeof raw.bindHost !== "string" || raw.bindHost.trim().length === 0;
    const shouldPersistDefaults = !configFileExists || shouldGenerateToken || (preferNetworkBind && missingBindHost);
    if (shouldPersistDefaults) {
      try {
        mkdirSync(dirname(this.configPath), { recursive: true });
        writeFileSync(this.configPath, JSON.stringify(normalized, null, 2), "utf8");
        this.appendLog(`[runtime] Bootstrapped hub config at ${this.configPath}`);
      } catch (error) {
        this.setError(`Failed to bootstrap hub config: ${stringifyError(error)}`);
      }
    }

    this.hubConfig = normalized;
    this.authToken = normalized.authToken;
    const localHost = normalizeHostForLocalClient(normalized.bindHost);
    this.hubUrl = `http://${localHost}:${normalized.port}`;
  }

  loadAppSettings() {
    const fallback = {
      launchAtLogin: this.runtimePaths.mode === "packaged",
      autoStartHubOnLaunch: true,
    };

    let raw = {};
    if (existsSync(this.appSettingsPath)) {
      try {
        const text = readFileSync(this.appSettingsPath, "utf8");
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          raw = parsed;
        }
      } catch (error) {
        this.setError(`Failed to parse menubar settings: ${stringifyError(error)}`);
      }
    }

    this.appSettings = {
      launchAtLogin: safeBoolean(raw.launchAtLogin, fallback.launchAtLogin),
      autoStartHubOnLaunch: safeBoolean(raw.autoStartHubOnLaunch, fallback.autoStartHubOnLaunch),
    };
  }

  /**
   * Persist selected menubar settings.
   * @param {Record<string, unknown>} patch
   */
  async saveAppSettings(patch) {
    const current = { ...this.appSettings };
    const next = { ...current };

    if (Object.prototype.hasOwnProperty.call(patch, "launchAtLogin")) {
      next.launchAtLogin = safeBoolean(patch.launchAtLogin, current.launchAtLogin);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "autoStartHubOnLaunch")) {
      next.autoStartHubOnLaunch = safeBoolean(patch.autoStartHubOnLaunch, current.autoStartHubOnLaunch);
    }

    mkdirSync(dirname(this.appSettingsPath), { recursive: true });
    writeFileSync(this.appSettingsPath, JSON.stringify(next, null, 2), "utf8");

    this.appSettings = next;
    this.applyLoginItemSettings();

    this.appendLog(`[runtime] Saved menubar settings at ${this.appSettingsPath}`);
    this.rebuildTrayMenu();
    this.emitStateChanged();
    return this.getAppSettingsSnapshot();
  }

  getAppSettingsSnapshot() {
    let effectiveLaunchAtLogin = this.appSettings.launchAtLogin;
    try {
      effectiveLaunchAtLogin = Boolean(app.getLoginItemSettings().openAtLogin);
    } catch {
      // getLoginItemSettings is not available in every runtime/context.
    }

    return {
      launchAtLogin: this.appSettings.launchAtLogin,
      autoStartHubOnLaunch: this.appSettings.autoStartHubOnLaunch,
      effectiveLaunchAtLogin,
      settingsPath: this.appSettingsPath,
    };
  }

  /**
   * Persist selected settings to hub config file.
   * @param {Record<string, unknown>} patch
   */
  async saveHubConfig(patch) {
    const current = { ...this.hubConfig };
    const next = { ...current };

    if (Object.prototype.hasOwnProperty.call(patch, "bindHost")) {
      next.bindHost = safeString(patch.bindHost, current.bindHost || "127.0.0.1");
    }
    if (Object.prototype.hasOwnProperty.call(patch, "port")) {
      next.port = safePort(patch.port, current.port || 7777);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "authToken")) {
      next.authToken = typeof patch.authToken === "string" ? patch.authToken.trim() : "";
    }
    if (Object.prototype.hasOwnProperty.call(patch, "verboseLogs")) {
      next.verboseLogs = safeBoolean(patch.verboseLogs, Boolean(current.verboseLogs));
    }
    if (Object.prototype.hasOwnProperty.call(patch, "corsAllowedOrigins")) {
      next.corsAllowedOrigins = normalizeCommaList(patch.corsAllowedOrigins);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "publicDir")) {
      next.publicDir = safeString(patch.publicDir, current.publicDir || this.runtimePaths.defaultPublicDir);
    }

    mkdirSync(dirname(this.configPath), { recursive: true });
    writeFileSync(this.configPath, JSON.stringify(next, null, 2), "utf8");
    this.appendLog(`[runtime] Saved hub config at ${this.configPath}`);

    this.loadHubConfig();
    await this.refreshSnapshot();
    return this.getHubConfigSnapshot();
  }

  getHubConfigSnapshot() {
    return {
      bindHost: safeString(this.hubConfig.bindHost, "127.0.0.1"),
      port: safePort(this.hubConfig.port, 7777),
      authToken: typeof this.hubConfig.authToken === "string" ? this.hubConfig.authToken : "",
      verboseLogs: Boolean(this.hubConfig.verboseLogs),
      corsAllowedOrigins: normalizeStringArray(this.hubConfig.corsAllowedOrigins).join(", "),
      publicDir: safeString(this.hubConfig.publicDir, this.runtimePaths.defaultPublicDir),
      configPath: this.configPath,
    };
  }

  getStateSnapshot() {
    return {
      ts: new Date().toISOString(),
      hubUrl: this.hubUrl,
      hubReachable: this.hubReachable,
      hubStatus: this.describeHubStatus(),
      managedStatus: this.managedStatus,
      managedProcessAlive: this.isManagedProcessAlive(),
      operationInFlight: this.operationInFlight,
      connectedWorkspaces: this.connectedWorkspaces,
      connectedWorkspaceCount: this.connectedWorkspaces.length,
      lastError: this.lastError,
      lastExit: this.lastExit,
      configPath: this.configPath,
      appSettings: this.getAppSettingsSnapshot(),
      mobileConnect: this.getMobileConnectSnapshot(),
      runtimeMode: this.runtimePaths.mode,
      logPath: this.logPath,
    };
  }

  getMobileConnectSnapshot() {
    const token = safeString(this.authToken, "");
    const port = safePort(this.hubConfig.port, 7777);
    const candidates = collectConnectHosts();
    const urls = candidates.map((item) => ({
      kind: item.kind,
      label: item.label,
      host: item.host,
      url: buildMobileUrl(item.host, port, token),
    }));

    const recommended = urls[0] ?? null;
    return {
      token,
      tokenMasked: maskToken(token),
      recommendedUrl: recommended?.url ?? null,
      recommendedLabel: recommended?.label ?? null,
      urls,
    };
  }

  /**
   * @param {number} [maxLogLines]
   */
  getDiagnosticsSnapshot(maxLogLines) {
    const lines = clampInteger(maxLogLines, 220, 20, 2_000);
    return {
      state: this.getStateSnapshot(),
      health: this.hubHealth,
      hubConfig: this.getHubConfigSnapshot(),
      appSettings: this.getAppSettingsSnapshot(),
      runtimePaths: this.runtimePaths,
      recentLog: this.readRecentLogLines(lines),
      maxLogLines: lines,
    };
  }

  applyLoginItemSettings() {
    if (process.platform !== "darwin" && process.platform !== "win32") {
      return;
    }

    try {
      app.setLoginItemSettings({
        openAtLogin: this.appSettings.launchAtLogin,
        openAsHidden: true,
      });
    } catch (error) {
      this.appendLog(`[runtime warn] Failed to apply login item settings: ${stringifyError(error)}`);
    }
  }

  async ensureHubRunningOnLaunch() {
    if (this.hubReachable || this.isManagedProcessAlive()) {
      return;
    }

    this.appendLog("[runtime] Auto-start hub on app launch is enabled.");
    await this.startHub();
  }

  /**
   * Execute UI action from control-center renderer.
   * @param {string} action
   */
  async runUiAction(action) {
    switch (action) {
      case "start-hub":
        await this.startHub();
        break;
      case "stop-hub":
        await this.stopHub();
        break;
      case "restart-hub":
        await this.restartHub();
        break;
      case "refresh":
        await this.refreshSnapshot();
        break;
      case "open-pwa":
        await shell.openExternal(this.hubUrl);
        break;
      case "open-mobile-url": {
        const mobile = this.getMobileConnectSnapshot();
        const target = mobile.recommendedUrl || this.hubUrl;
        await shell.openExternal(target);
        break;
      }
      case "reveal-log":
        shell.showItemInFolder(this.logPath);
        break;
      case "open-control-center":
        openControlCenterWindow();
        break;
      default:
        throw new Error(`Unknown action: ${action}`);
    }

    return this.getStateSnapshot();
  }

  createTray() {
    if (this.tray) {
      return;
    }

    this.tray = new Tray(nativeImage.createEmpty());
    this.tray.setTitle("CB");
    this.tray.setToolTip("VSC Codex Bridge Hub");
    this.tray.on("click", () => {
      void this.refreshSnapshot();
    });
    this.rebuildTrayMenu();
  }

  rebuildTrayMenu() {
    if (!this.tray) {
      return;
    }

    const runningManaged = this.isManagedProcessAlive();
    const externalRunning = this.hubReachable && !runningManaged;
    const canStart = !this.operationInFlight && !runningManaged && !externalRunning;
    const canStop = !this.operationInFlight && runningManaged;
    const canRestart = !this.operationInFlight && runningManaged;

    const workspaceItems =
      this.connectedWorkspaces.length > 0
        ? this.connectedWorkspaces.map((workspace) => ({
            label: `${workspace.workspaceName}  (${workspace.bridgeId})`,
            enabled: false,
          }))
        : [{ label: "No workspace connected", enabled: false }];

    const menu = Menu.buildFromTemplate([
      {
        label: `Hub: ${this.describeHubStatus()}`,
        enabled: false,
      },
      {
        label: `URL: ${this.hubUrl}`,
        enabled: false,
      },
      {
        label: this.authToken ? "Auth token: configured" : "Auth token: not configured",
        enabled: false,
      },
      { type: "separator" },
      {
        label: "Open Control Center",
        click: () => {
          openControlCenterWindow();
        },
      },
      {
        label: "Launch At Login",
        type: "checkbox",
        checked: Boolean(this.appSettings.launchAtLogin),
        enabled: !this.operationInFlight,
        click: (item) => {
          void this.saveAppSettings({ launchAtLogin: Boolean(item.checked) });
        },
      },
      {
        label: "Auto-start Hub On App Launch",
        type: "checkbox",
        checked: Boolean(this.appSettings.autoStartHubOnLaunch),
        enabled: !this.operationInFlight,
        click: (item) => {
          void this.saveAppSettings({ autoStartHubOnLaunch: Boolean(item.checked) });
        },
      },
      { type: "separator" },
      {
        label: "Start Hub",
        enabled: canStart,
        click: () => {
          void this.startHub();
        },
      },
      {
        label: "Stop Hub",
        enabled: canStop,
        click: () => {
          void this.stopHub();
        },
      },
      {
        label: "Restart Hub",
        enabled: canRestart,
        click: () => {
          void this.restartHub();
        },
      },
      { type: "separator" },
      {
        label: "Open PWA",
        click: () => {
          void shell.openExternal(this.hubUrl);
        },
      },
      {
        label: "Copy PWA URL",
        click: () => {
          clipboard.writeText(this.hubUrl);
        },
      },
      {
        label: "Reveal Menubar Log File",
        click: () => {
          void shell.showItemInFolder(this.logPath);
        },
      },
      { type: "separator" },
      {
        label: `Connected Workspaces (${this.connectedWorkspaces.length})`,
        enabled: false,
      },
      ...workspaceItems,
      { type: "separator" },
      {
        label: "Refresh",
        enabled: !this.operationInFlight,
        click: () => {
          void this.refreshSnapshot();
        },
      },
      {
        label: "Quit",
        click: () => {
          app.quit();
        },
      },
    ]);

    this.tray.setContextMenu(menu);
    this.tray.setTitle(this.computeTrayTitle());
  }

  async startHubInternal() {
    if (this.isManagedProcessAlive()) {
      return;
    }

    await this.refreshSnapshot();
    if (this.hubReachable && !this.isManagedProcessAlive()) {
      this.setError("Hub already running externally. Stop that process first or use current instance.");
      return;
    }

    this.managedStatus = "starting";
    this.lastError = null;
    this.rebuildTrayMenu();
    this.emitStateChanged();

    if (!this.runtimePaths.skipHubCompile) {
      const compileExitCode = await this.runCommand("npm", ["--prefix", "packages/hub", "run", "compile"]);
      if (compileExitCode !== 0) {
        this.managedStatus = "error";
        this.setError(`Hub compile failed (exit=${compileExitCode}).`);
        return;
      }
    } else {
      this.appendLog("[runtime] Packaged mode detected, skipping hub compile step.");
    }

    const hubEntry = this.runtimePaths.hubEntryPath;
    if (!existsSync(hubEntry)) {
      this.managedStatus = "error";
      this.setError(`Hub entry file not found: ${hubEntry}`);
      return;
    }

    this.ensureLogFileReady();
    const childEnv = {
      ...process.env,
    };

    // Electron's executable is not a plain Node runtime. Explicitly force
    // node-mode for child hub execution so packaged apps can launch hub JS.
    childEnv.ELECTRON_RUN_AS_NODE = "1";

    if (this.runtimePaths.mode === "packaged") {
      childEnv.VSC_CODEX_HUB_CONFIG = this.configPath;
      childEnv.VSC_CODEX_HUB_PUBLIC_DIR = safeString(this.hubConfig.publicDir, this.runtimePaths.defaultPublicDir);
    }

    this.appendLog(`[runtime] Launching managed hub: ${process.execPath} ${hubEntry}`);
    const child = spawn(process.execPath, [hubEntry], {
      cwd: this.repoRoot,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.managedProcess = child;
    this.managedStatus = "running";
    this.lastExit = null;

    child.stdout?.on("data", (chunk) => {
      this.appendLog(`[hub stdout] ${chunk.toString("utf8")}`);
    });

    child.stderr?.on("data", (chunk) => {
      this.appendLog(`[hub stderr] ${chunk.toString("utf8")}`);
    });

    child.on("error", (error) => {
      if (this.managedProcess === child) {
        this.managedProcess = null;
        this.managedStatus = "error";
        this.lastError = `Failed to launch managed hub: ${stringifyError(error)}`;
        this.appendLog(`[runtime error] ${this.lastError}`);
        this.rebuildTrayMenu();
        this.emitStateChanged();
      }
    });

    child.on("exit", (code, signal) => {
      if (this.managedProcess === child) {
        this.managedProcess = null;

        if (this.managedStatus === "stopping") {
          this.managedStatus = "stopped";
        } else if (code === 0) {
          this.managedStatus = "stopped";
        } else {
          this.managedStatus = "error";
          this.lastError = `Managed hub exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"}).`;
        }

        this.lastExit = { code, signal, at: new Date().toISOString() };
        this.appendLog(
          `[runtime] Managed hub exited (code=${code ?? "null"}, signal=${signal ?? "null"}, status=${this.managedStatus}).`,
        );
        this.rebuildTrayMenu();
        this.emitStateChanged();
      }
    });

    await this.wait(900);
    await this.refreshSnapshot();
  }

  async stopHubInternal() {
    if (!this.isManagedProcessAlive()) {
      return;
    }

    this.managedStatus = "stopping";
    this.rebuildTrayMenu();
    this.emitStateChanged();

    const child = this.managedProcess;
    const gracefulStop = await this.stopChildProcess(child, HUB_STOP_TIMEOUT_MS);
    if (!gracefulStop) {
      this.setError("Managed hub did not stop gracefully; forced termination was used.");
    }

    await this.wait(350);
    await this.refreshSnapshot();
  }

  async fetchHubHealth() {
    try {
      const payload = await this.fetchJson("/healthz", false);
      return { ok: true, payload };
    } catch {
      return { ok: false, payload: null };
    }
  }

  async fetchBridges() {
    try {
      const payload = await this.fetchJson("/api/v1/bridges", true);
      const items = Array.isArray(payload?.items) ? payload.items : [];
      return { ok: true, items };
    } catch (error) {
      return {
        ok: false,
        items: [],
        error: `Failed to load workspaces: ${stringifyError(error)}`,
      };
    }
  }

  /**
   * @param {string} pathName
   * @param {boolean} includeAuth
   */
  async fetchJson(pathName, includeAuth) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HUB_REQUEST_TIMEOUT_MS);

    const headers = {};
    if (includeAuth && this.authToken) {
      headers.authorization = `Bearer ${this.authToken}`;
    }

    try {
      const url = new URL(pathName, this.hubUrl).toString();
      const response = await fetch(url, {
        method: "GET",
        headers,
        signal: controller.signal,
      });

      const text = await response.text();
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${truncate(text, 240)}`);
      }

      return text ? JSON.parse(text) : {};
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * @param {string} command
   * @param {string[]} args
   */
  async runCommand(command, args) {
    this.ensureLogFileReady();
    this.appendLog(`[runtime] Running command: ${command} ${args.join(" ")}`);

    return await new Promise((resolvePromise) => {
      const child = spawn(command, args, {
        cwd: this.repoRoot,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout?.on("data", (chunk) => {
        this.appendLog(`[command stdout] ${chunk.toString("utf8")}`);
      });

      child.stderr?.on("data", (chunk) => {
        this.appendLog(`[command stderr] ${chunk.toString("utf8")}`);
      });

      child.on("error", (error) => {
        this.appendLog(`[command error] ${stringifyError(error)}`);
        resolvePromise(1);
      });

      child.on("exit", (code) => {
        resolvePromise(code ?? 1);
      });
    });
  }

  /**
   * @param {import("child_process").ChildProcess | null} child
   * @param {number} timeoutMs
   */
  async stopChildProcess(child, timeoutMs) {
    if (!child || child.exitCode !== null || child.killed) {
      return true;
    }

    const graceful = await new Promise((resolvePromise) => {
      let done = false;
      const finalize = (value) => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        resolvePromise(value);
      };

      const timer = setTimeout(() => finalize(false), timeoutMs);
      child.once("exit", () => finalize(true));

      try {
        child.kill("SIGTERM");
      } catch {
        finalize(false);
      }
    });

    if (graceful) {
      return true;
    }

    try {
      child.kill("SIGKILL");
    } catch {
      // Ignore kill failures if process already terminated.
    }
    return false;
  }

  readRecentLogLines(maxLines) {
    const lines = clampInteger(maxLines, 220, 20, 2_000);
    if (!existsSync(this.logPath)) {
      return "";
    }

    try {
      const text = readFileSync(this.logPath, "utf8");
      const all = text.split(/\r?\n/);
      return all.slice(-lines).join("\n").trim();
    } catch (error) {
      return `[log read error] ${stringifyError(error)}`;
    }
  }

  isManagedProcessAlive() {
    return Boolean(this.managedProcess && this.managedProcess.exitCode === null && !this.managedProcess.killed);
  }

  describeHubStatus() {
    const managedAlive = this.isManagedProcessAlive();
    const external = this.hubReachable && !managedAlive;

    if (this.operationInFlight) {
      return "busy";
    }
    if (this.managedStatus === "starting") {
      return "starting (managed)";
    }
    if (this.managedStatus === "stopping") {
      return "stopping (managed)";
    }
    if (this.managedStatus === "error") {
      return this.lastError ? `error - ${truncate(this.lastError, 90)}` : "error";
    }
    if (managedAlive) {
      return "running (managed)";
    }
    if (external) {
      return "running (external)";
    }
    return "stopped";
  }

  computeTrayTitle() {
    const managedAlive = this.isManagedProcessAlive();

    if (this.operationInFlight || this.managedStatus === "starting") {
      return "CB…";
    }
    if (this.managedStatus === "stopping") {
      return "CB⏸";
    }
    if (this.managedStatus === "error") {
      return "CB!";
    }
    if (managedAlive) {
      return "CB●";
    }
    if (this.hubReachable) {
      return "CB◌";
    }
    return "CB○";
  }

  setError(message) {
    this.lastError = message;
    this.appendLog(`[runtime error] ${message}`);
    this.rebuildTrayMenu();
    this.emitStateChanged();
  }

  emitStateChanged() {
    broadcastStateChanged(this.getStateSnapshot());
  }

  ensureLogFileReady() {
    mkdirSync(dirname(this.logPath), { recursive: true });
    if (!existsSync(this.logPath)) {
      appendFileSync(this.logPath, "");
    }
  }

  /**
   * @param {string} text
   */
  appendLog(text) {
    try {
      this.ensureLogFileReady();
      const line = `[${new Date().toISOString()}] ${text.endsWith("\n") ? text : `${text}\n`}`;
      appendFileSync(this.logPath, line, "utf8");
    } catch {
      // Avoid throwing from logger path.
    }
  }

  /**
   * @param {number} ms
   */
  async wait(ms) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
  }
}

let runtime = null;
let controlCenterWindow = null;

function registerIpcHandlers() {
  ipcMain.removeHandler("menubar:get-state");
  ipcMain.removeHandler("menubar:get-config");
  ipcMain.removeHandler("menubar:get-app-settings");
  ipcMain.removeHandler("menubar:save-config");
  ipcMain.removeHandler("menubar:save-app-settings");
  ipcMain.removeHandler("menubar:get-diagnostics");
  ipcMain.removeHandler("menubar:action");

  ipcMain.handle("menubar:get-state", async () => {
    if (!runtime) {
      return null;
    }
    return runtime.getStateSnapshot();
  });

  ipcMain.handle("menubar:get-config", async () => {
    if (!runtime) {
      return null;
    }
    return runtime.getHubConfigSnapshot();
  });

  ipcMain.handle("menubar:get-app-settings", async () => {
    if (!runtime) {
      return null;
    }
    return runtime.getAppSettingsSnapshot();
  });

  ipcMain.handle("menubar:save-config", async (_event, patch) => {
    if (!runtime) {
      return null;
    }
    const payload = patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {};
    return await runtime.saveHubConfig(payload);
  });

  ipcMain.handle("menubar:save-app-settings", async (_event, patch) => {
    if (!runtime) {
      return null;
    }
    const payload = patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {};
    return await runtime.saveAppSettings(payload);
  });

  ipcMain.handle("menubar:get-diagnostics", async (_event, options) => {
    if (!runtime) {
      return null;
    }
    const maxLogLines =
      options && typeof options === "object" && !Array.isArray(options) ? options.maxLogLines : undefined;
    return runtime.getDiagnosticsSnapshot(maxLogLines);
  });

  ipcMain.handle("menubar:action", async (_event, action) => {
    if (!runtime) {
      return null;
    }
    return await runtime.runUiAction(String(action || ""));
  });
}

function openControlCenterWindow() {
  if (controlCenterWindow && !controlCenterWindow.isDestroyed()) {
    controlCenterWindow.show();
    controlCenterWindow.focus();
    return;
  }

  controlCenterWindow = new BrowserWindow({
    width: CONTROL_CENTER_WIDTH,
    height: CONTROL_CENTER_HEIGHT,
    minWidth: 840,
    minHeight: 580,
    title: "VSC Codex Bridge Hub",
    autoHideMenuBar: true,
    backgroundColor: "#101113",
    webPreferences: {
      preload: resolve(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  runtime?.appendLog("[control-center] opening window");

  controlCenterWindow.on("closed", () => {
    controlCenterWindow = null;
  });

  controlCenterWindow.webContents.on("did-finish-load", () => {
    runtime?.appendLog("[control-center] did-finish-load");
    sendControlCenterEvent("menubar:bootstrap", buildControlCenterBootstrapPayload());
  });

  controlCenterWindow.webContents.on("preload-error", (_event, preloadPath, error) => {
    runtime?.appendLog(
      `[control-center preload-error] path=${preloadPath} error=${stringifyError(error)}`
    );
  });

  controlCenterWindow.webContents.on("did-fail-load", (_event, code, description, url) => {
    runtime?.appendLog(
      `[control-center did-fail-load] code=${code} description=${description} url=${url}`
    );
  });

  controlCenterWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    runtime?.appendLog(
      `[control-center console] level=${level} line=${line} source=${sourceId || "unknown"} message=${message}`
    );
  });

  void controlCenterWindow.loadFile(resolve(__dirname, "control-center.html"));
}

/**
 * @param {Record<string, unknown>} payload
 */
function broadcastStateChanged(payload) {
  sendControlCenterEvent("menubar:state-changed", payload);
}

/**
 * Build a full payload used to bootstrap UI state right after window load.
 */
function buildControlCenterBootstrapPayload() {
  if (!runtime) {
    return null;
  }
  return {
    ts: new Date().toISOString(),
    state: runtime.getStateSnapshot(),
    config: runtime.getHubConfigSnapshot(),
    appSettings: runtime.getAppSettingsSnapshot(),
    diagnostics: runtime.getDiagnosticsSnapshot(260),
  };
}

/**
 * @param {string} channel
 * @param {unknown} payload
 */
function sendControlCenterEvent(channel, payload) {
  if (!controlCenterWindow || controlCenterWindow.isDestroyed()) {
    return;
  }
  controlCenterWindow.webContents.send(channel, payload);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (runtime) {
      void runtime.refreshSnapshot();
    }
    openControlCenterWindow();
  });

  app.whenReady().then(async () => {
    if (process.platform === "darwin" && app.dock) {
      app.dock.hide();
    }

    app.setName("VSC Codex Bridge Hub");
    const runtimePaths = resolveRuntimePaths();
    runtime = new HubMenubarRuntime(runtimePaths);
    registerIpcHandlers();
    runtime.appendLog(`[runtime] Initialized in ${runtimePaths.mode} mode.`);
    await runtime.initialize();
  });

  app.on("window-all-closed", (event) => {
    event.preventDefault();
  });

  app.on("before-quit", (event) => {
    if (!runtime) {
      return;
    }

    if (!app.isQuiting) {
      event.preventDefault();
      app.isQuiting = true;
      void runtime.shutdown().finally(() => {
        app.quit();
      });
    }
  });
}

/**
 * Resolve runtime paths for development vs packaged execution.
 * @returns {RuntimePaths}
 */
function resolveRuntimePaths() {
  const packagedAppRoot = resolve(process.resourcesPath, "app");
  const packagedHubEntryPath = resolve(packagedAppRoot, "runtime/hub/out/index.js");
  const packagedPublicDir = resolve(packagedAppRoot, "runtime/pwa/dist");
  const packagedLayoutDetected = existsSync(packagedHubEntryPath) && existsSync(packagedPublicDir);
  const runningFromAppBundle =
    typeof __dirname === "string" && __dirname.includes("/Contents/Resources/app");

  const shouldUsePackagedRuntime = app.isPackaged || runningFromAppBundle || packagedLayoutDetected;
  if (shouldUsePackagedRuntime) {
    return {
      mode: "packaged",
      repoRoot: packagedAppRoot,
      hubConfigPath: resolve(app.getPath("userData"), "hub.config.json"),
      appSettingsPath: resolve(app.getPath("userData"), "menubar.settings.json"),
      hubEntryPath: packagedHubEntryPath,
      defaultPublicDir: packagedPublicDir,
      skipHubCompile: true,
    };
  }

  const repoRoot = resolve(__dirname, "..", "..");
  return {
    mode: "development",
    repoRoot,
    hubConfigPath: resolve(repoRoot, "packages/hub/config/hub.config.json"),
    appSettingsPath: resolve(repoRoot, ".local/config/menubar.settings.json"),
    hubEntryPath: resolve(repoRoot, "packages/hub/out/index.js"),
    defaultPublicDir: resolve(repoRoot, "packages/pwa/dist"),
    skipHubCompile: false,
  };
}

function createAuthToken(bytes = 24) {
  try {
    return randomBytes(bytes).toString("hex");
  } catch {
    return `token_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  }
}

function collectConnectHosts() {
  const interfaces = networkInterfaces();
  const seen = new Set();
  const hosts = [];

  for (const [name, list] of Object.entries(interfaces)) {
    if (!Array.isArray(list)) {
      continue;
    }

    for (const item of list) {
      if (!item || item.internal || item.family !== "IPv4") {
        continue;
      }

      const host = safeString(item.address, "");
      if (!host || seen.has(host)) {
        continue;
      }

      seen.add(host);
      const kind = classifyHostKind(host);
      const label =
        kind === "tailscale"
          ? `Tailscale (${host})`
          : kind === "lan"
            ? `LAN (${host})`
            : `Network (${host})`;

      hosts.push({
        host,
        kind,
        label,
        iface: name,
        priority: kind === "tailscale" ? 0 : kind === "lan" ? 1 : 2,
      });
    }
  }

  hosts.sort((left, right) => {
    if (left.priority !== right.priority) {
      return left.priority - right.priority;
    }
    return left.host.localeCompare(right.host);
  });

  hosts.push({
    host: "127.0.0.1",
    kind: "loopback",
    label: "Localhost (127.0.0.1)",
    iface: "lo0",
    priority: 99,
  });

  return hosts;
}

function classifyHostKind(host) {
  const parts = parseIPv4(host);
  if (!parts) {
    return "network";
  }

  const [a, b] = parts;
  if (a === 100 && b >= 64 && b <= 127) {
    return "tailscale";
  }

  if (a === 10) {
    return "lan";
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return "lan";
  }
  if (a === 192 && b === 168) {
    return "lan";
  }

  return "network";
}

function parseIPv4(host) {
  const parts = host.split(".");
  if (parts.length !== 4) {
    return null;
  }

  const numbers = parts.map((part) => Number(part));
  for (const value of numbers) {
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      return null;
    }
  }

  return numbers;
}

function buildMobileUrl(host, port, token) {
  const url = new URL(`http://${host}:${port}/`);
  if (token) {
    url.searchParams.set("token", token);
  }
  return url.toString();
}

function maskToken(token) {
  if (!token) {
    return "";
  }
  if (token.length <= 8) {
    return token;
  }
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

/**
 * @param {unknown} value
 * @param {string} fallback
 */
function safeString(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim();
  return normalized || fallback;
}

/**
 * @param {unknown} value
 * @param {boolean} fallback
 */
function safeBoolean(value, fallback) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes") {
      return true;
    }
    if (normalized === "false" || normalized === "0" || normalized === "no") {
      return false;
    }
  }
  return fallback;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 */
function safePort(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const bounded = Math.max(1, Math.min(65_535, Math.floor(parsed)));
  return bounded;
}

/**
 * @param {unknown} value
 */
function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const current = item.trim();
    if (!current) {
      continue;
    }
    normalized.push(current);
  }
  return normalized;
}

/**
 * @param {unknown} value
 */
function normalizeCommaList(value) {
  if (typeof value !== "string") {
    return [];
  }

  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  const unique = new Set(items);
  return [...unique];
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 */
function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

/**
 * Convert broad bind addresses to a concrete loopback host for local requests.
 * @param {string} host
 */
function normalizeHostForLocalClient(host) {
  const normalized = (host || "").trim().toLowerCase();
  if (!normalized || normalized === "0.0.0.0" || normalized === "::" || normalized === "::0") {
    return "127.0.0.1";
  }
  return normalized;
}

/**
 * @param {unknown} error
 */
function stringifyError(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * @param {string} value
 * @param {number} maxLength
 */
function truncate(value, maxLength) {
  if (typeof value !== "string") {
    return "";
  }
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}
