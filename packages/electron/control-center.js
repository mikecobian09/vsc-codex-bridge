"use strict";

/**
 * Renderer logic for Electron control-center window.
 * Communicates with main process via preload-exposed bridgeHub API.
 */

const bridgeApi = window.bridgeHub || null;
console.log(`[control-center renderer] loaded bridgeHub=${Boolean(bridgeApi)}`);

const POLL_MS = 2_500;

const elements = {
  hubDot: document.getElementById("hub-dot"),
  hubStatus: document.getElementById("hub-status"),
  workspaceCount: document.getElementById("workspace-count"),
  settingsStatus: document.getElementById("settings-status"),
  securityBanner: document.getElementById("security-banner"),

  bindHost: document.getElementById("bind-host"),
  port: document.getElementById("port"),
  authToken: document.getElementById("auth-token"),
  mobileUrl: document.getElementById("mobile-url"),
  mobileTokenMask: document.getElementById("mobile-token-mask"),
  mobileUrlList: document.getElementById("mobile-url-list"),
  corsOrigins: document.getElementById("cors-origins"),
  verboseLogs: document.getElementById("verbose-logs"),
  launchAtLogin: document.getElementById("launch-at-login"),
  autoStartHubOnLaunch: document.getElementById("auto-start-hub-on-launch"),

  refreshBtn: document.getElementById("refresh-btn"),
  openPwaBtn: document.getElementById("open-pwa-btn"),
  copyMobileUrlBtn: document.getElementById("copy-mobile-url-btn"),
  openMobileUrlBtn: document.getElementById("open-mobile-url-btn"),
  copyTokenBtn: document.getElementById("copy-token-btn"),
  generateTokenBtn: document.getElementById("generate-token-btn"),
  saveBtn: document.getElementById("save-btn"),
  saveRestartBtn: document.getElementById("save-restart-btn"),
  startBtn: document.getElementById("start-btn"),
  stopBtn: document.getElementById("stop-btn"),
  restartBtn: document.getElementById("restart-btn"),
  revealLogBtn: document.getElementById("reveal-log-btn"),

  diagHubStatus: document.getElementById("diag-hub-status"),
  diagReachable: document.getElementById("diag-reachable"),
  diagManaged: document.getElementById("diag-managed"),
  workspaceList: document.getElementById("workspace-list"),
  lastError: document.getElementById("last-error"),
  healthJson: document.getElementById("health-json"),
  logTail: document.getElementById("log-tail"),
  configPath: document.getElementById("config-path"),
};

let busy = false;
let formDirty = false;
let pollTimer = null;
let unsubscribeState = null;
let unsubscribeBootstrap = null;
let lastKnownMobileUrl = "";
let lastKnownToken = "";

for (const field of [
  elements.bindHost,
  elements.port,
  elements.authToken,
  elements.corsOrigins,
  elements.verboseLogs,
  elements.launchAtLogin,
  elements.autoStartHubOnLaunch,
]) {
  field?.addEventListener("input", () => {
    formDirty = true;
  });
  field?.addEventListener("change", () => {
    formDirty = true;
  });
}

elements.refreshBtn?.addEventListener("click", () => {
  void refreshAll(true, false);
});

elements.openPwaBtn?.addEventListener("click", () => {
  void runAction("open-pwa", "Opened PWA in browser.");
});

elements.copyMobileUrlBtn?.addEventListener("click", () => {
  void copyTextToClipboard(elements.mobileUrl?.value || lastKnownMobileUrl, "Mobile URL");
});

elements.openMobileUrlBtn?.addEventListener("click", () => {
  void runAction("open-mobile-url", "Opened mobile URL in browser.");
});

elements.copyTokenBtn?.addEventListener("click", () => {
  const tokenFromInput = String(elements.authToken?.value || "").trim();
  const token = tokenFromInput || lastKnownToken;
  void copyTextToClipboard(token, "Auth token");
});

elements.generateTokenBtn?.addEventListener("click", () => {
  const token = generateAuthToken();
  elements.authToken.value = token;
  formDirty = true;
  setStatusMessage("Generated a new auth token in the form. Save (or Save + Restart) to apply it.");
});

elements.saveBtn?.addEventListener("click", () => {
  void saveSettings(false);
});

elements.saveRestartBtn?.addEventListener("click", () => {
  void saveSettings(true);
});

elements.startBtn?.addEventListener("click", () => {
  void runAction("start-hub", "Start request sent.");
});

elements.stopBtn?.addEventListener("click", () => {
  void runAction("stop-hub", "Stop request sent.");
});

elements.restartBtn?.addEventListener("click", () => {
  void runAction("restart-hub", "Restart request sent.");
});

elements.revealLogBtn?.addEventListener("click", () => {
  void runAction("reveal-log", "Opened log file location.");
});

if (bridgeApi?.onStateChanged) {
  unsubscribeState = bridgeApi.onStateChanged((state) => {
    if (state && typeof state === "object") {
      renderState(state);
    }
  });
}

if (bridgeApi?.onBootstrap) {
  unsubscribeBootstrap = bridgeApi.onBootstrap((payload) => {
    applyBootstrapPayload(payload);
  });
}

window.addEventListener("beforeunload", () => {
  if (typeof unsubscribeState === "function") {
    unsubscribeState();
  }
  if (typeof unsubscribeBootstrap === "function") {
    unsubscribeBootstrap();
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
});

void bootstrap();

async function bootstrap() {
  if (!bridgeApi) {
    console.error("[control-center renderer] bridgeHub unavailable");
    setBridgeUnavailable("Control bridge is not available. Close and reopen the Control Center.");
    return;
  }

  console.log("[control-center renderer] bootstrap refresh start");
  await refreshAll(true, false);
  console.log("[control-center renderer] bootstrap refresh complete");
  pollTimer = setInterval(() => {
    void refreshAll(false, true);
  }, POLL_MS);
}

/**
 * @param {boolean} forceConfig
 * @param {boolean} background
 */
async function refreshAll(forceConfig, background) {
  if (!bridgeApi) {
    if (!background) {
      setBridgeUnavailable("Control bridge is not available.");
    }
    return;
  }

  try {
    if (!background) {
      setBusy(true);
    }
    const [stateResult, configResult, appSettingsResult, diagnosticsResult] = await Promise.allSettled([
      bridgeApi.getState(),
      bridgeApi.getConfig(),
      bridgeApi.getAppSettings(),
      bridgeApi.getDiagnostics({ maxLogLines: 260 }),
    ]);

    const errors = [];

    if (stateResult.status === "fulfilled" && stateResult.value) {
      renderState(stateResult.value);
    } else if (stateResult.status === "rejected") {
      errors.push(`state: ${stringifyError(stateResult.reason)}`);
    }

    if (configResult.status === "fulfilled" && configResult.value) {
      applyConfigToForm(configResult.value, forceConfig);
    } else if (configResult.status === "rejected") {
      errors.push(`config: ${stringifyError(configResult.reason)}`);
    }

    if (appSettingsResult.status === "fulfilled" && appSettingsResult.value) {
      applyAppSettingsToForm(appSettingsResult.value, forceConfig);
    } else if (appSettingsResult.status === "rejected") {
      errors.push(`appSettings: ${stringifyError(appSettingsResult.reason)}`);
    }

    if (diagnosticsResult.status === "fulfilled" && diagnosticsResult.value) {
      renderDiagnostics(diagnosticsResult.value);
    } else if (diagnosticsResult.status === "rejected") {
      errors.push(`diagnostics: ${stringifyError(diagnosticsResult.reason)}`);
    }

    if (errors.length > 0 && !background) {
      console.error(`[control-center renderer] refresh warnings: ${errors.join(" | ")}`);
      setStatusMessage(`Refresh warnings: ${errors.join(" | ")}`);
    }
  } catch (error) {
    console.error(`[control-center renderer] refresh failed: ${stringifyError(error)}`);
    if (!background) {
      setStatusMessage(`Refresh failed: ${stringifyError(error)}`);
    }
  } finally {
    if (!background) {
      setBusy(false);
    }
  }
}

/**
 * @param {boolean} withRestart
 */
async function saveSettings(withRestart) {
  if (!bridgeApi) {
    setBridgeUnavailable("Control bridge is not available.");
    return;
  }

  try {
    setBusy(true);
    const patch = {
      bindHost: String(elements.bindHost.value || "").trim(),
      port: Number(elements.port.value),
      authToken: String(elements.authToken.value || ""),
      corsAllowedOrigins: String(elements.corsOrigins.value || ""),
      verboseLogs: Boolean(elements.verboseLogs.checked),
    };
    const appPatch = {
      launchAtLogin: Boolean(elements.launchAtLogin.checked),
      autoStartHubOnLaunch: Boolean(elements.autoStartHubOnLaunch.checked),
    };

    await bridgeApi.saveConfig(patch);
    await bridgeApi.saveAppSettings(appPatch);
    formDirty = false;
    setStatusMessage("Configuration saved.");

    if (withRestart) {
      await bridgeApi.runAction("restart-hub");
      setStatusMessage("Configuration saved and hub restart requested.");
    }

    await refreshAll(true, false);
  } catch (error) {
    setStatusMessage(`Save failed: ${stringifyError(error)}`);
  } finally {
    setBusy(false);
  }
}

/**
 * @param {string} action
 * @param {string} message
 */
async function runAction(action, message) {
  if (!bridgeApi) {
    setBridgeUnavailable("Control bridge is not available.");
    return;
  }

  try {
    setBusy(true);
    await bridgeApi.runAction(action);
    setStatusMessage(message);
    await refreshAll(false, false);
  } catch (error) {
    setStatusMessage(`Action failed: ${stringifyError(error)}`);
  } finally {
    setBusy(false);
  }
}

/**
 * @param {Record<string, unknown>} state
 */
function renderState(state) {
  const statusLabel = String(state.hubStatus || "unknown");
  elements.hubStatus.textContent = statusLabel;
  elements.diagHubStatus.textContent = statusLabel;

  const workspaceCount = Number(state.connectedWorkspaceCount || 0);
  elements.workspaceCount.textContent = String(workspaceCount);

  const reachable = Boolean(state.hubReachable);
  elements.diagReachable.textContent = reachable ? "yes" : "no";

  const managed = Boolean(state.managedProcessAlive);
  elements.diagManaged.textContent = managed ? "alive" : "not managed";

  elements.hubDot.classList.remove("ok", "warn", "bad");
  if (statusLabel.includes("error")) {
    elements.hubDot.classList.add("bad");
  } else if (reachable) {
    elements.hubDot.classList.add("ok");
  } else {
    elements.hubDot.classList.add("warn");
  }

  renderMobileConnect(state);
  updateSecurityBanner();
}

/**
 * @param {Record<string, unknown>} config
 * @param {boolean} force
 */
function applyConfigToForm(config, force) {
  if (!force && formDirty) {
    return;
  }

  elements.bindHost.value = String(config.bindHost || "127.0.0.1");
  elements.port.value = String(config.port || 7777);
  elements.authToken.value = String(config.authToken || "");
  elements.corsOrigins.value = String(config.corsAllowedOrigins || "");
  elements.verboseLogs.checked = Boolean(config.verboseLogs);
  formDirty = false;
  updateSecurityBanner();
}

/**
 * @param {Record<string, unknown>} appSettings
 * @param {boolean} force
 */
function applyAppSettingsToForm(appSettings, force) {
  if (!force && formDirty) {
    return;
  }

  elements.launchAtLogin.checked = Boolean(appSettings.launchAtLogin);
  elements.autoStartHubOnLaunch.checked = Boolean(appSettings.autoStartHubOnLaunch);
  formDirty = false;
  updateSecurityBanner();
}

/**
 * @param {Record<string, unknown>} diagnostics
 */
function renderDiagnostics(diagnostics) {
  const state = diagnostics.state || {};
  const health = diagnostics.health || {};
  const recentLog = String(diagnostics.recentLog || "");
  const workspaces = Array.isArray(state.connectedWorkspaces) ? state.connectedWorkspaces : [];

  elements.workspaceList.innerHTML = "";
  if (workspaces.length === 0) {
    const item = document.createElement("li");
    item.textContent = "No workspace connected";
    elements.workspaceList.appendChild(item);
  } else {
    for (const workspace of workspaces) {
      const item = document.createElement("li");
      const workspaceName = String(workspace.workspaceName || "unknown");
      const bridgeId = String(workspace.bridgeId || "");
      item.textContent = `${workspaceName} (${bridgeId})`;
      elements.workspaceList.appendChild(item);
    }
  }

  const lastError = state.lastError ? String(state.lastError) : "none";
  elements.lastError.textContent = lastError;
  elements.healthJson.textContent = safeJson(health);
  elements.logTail.textContent = recentLog || "[no log entries yet]";
  elements.configPath.textContent = String(state.configPath || "");
  updateSecurityBanner();
}

/**
 * @param {boolean} value
 */
function setBusy(value) {
  busy = value;
  for (const button of [
    elements.refreshBtn,
    elements.openPwaBtn,
    elements.copyMobileUrlBtn,
    elements.openMobileUrlBtn,
    elements.copyTokenBtn,
    elements.generateTokenBtn,
    elements.saveBtn,
    elements.saveRestartBtn,
    elements.startBtn,
    elements.stopBtn,
    elements.restartBtn,
    elements.revealLogBtn,
  ]) {
    if (button) {
      button.disabled = value;
    }
  }
}

/**
 * @param {unknown} payload
 */
function applyBootstrapPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return;
  }

  if (payload.state && typeof payload.state === "object") {
    renderState(payload.state);
  }
  if (payload.config && typeof payload.config === "object") {
    applyConfigToForm(payload.config, true);
  }
  if (payload.appSettings && typeof payload.appSettings === "object") {
    applyAppSettingsToForm(payload.appSettings, true);
  }
  if (payload.diagnostics && typeof payload.diagnostics === "object") {
    renderDiagnostics(payload.diagnostics);
  }
}

/**
 * @param {string} message
 */
function setBridgeUnavailable(message) {
  setStatusMessage(message);
  for (const button of [
    elements.refreshBtn,
    elements.openPwaBtn,
    elements.copyMobileUrlBtn,
    elements.openMobileUrlBtn,
    elements.copyTokenBtn,
    elements.generateTokenBtn,
    elements.saveBtn,
    elements.saveRestartBtn,
    elements.startBtn,
    elements.stopBtn,
    elements.restartBtn,
    elements.revealLogBtn,
  ]) {
    if (button) {
      button.disabled = true;
    }
  }
}

/**
 * @param {string} message
 */
function setStatusMessage(message) {
  if (!elements.settingsStatus) {
    return;
  }

  const prefix = busy ? "[busy] " : "";
  elements.settingsStatus.textContent = `${prefix}${message}`;
}

/**
 * @param {unknown} value
 */
function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * @param {unknown} value
 */
function stringifyError(value) {
  if (value instanceof Error) {
    return value.message;
  }
  return String(value);
}

function updateSecurityBanner() {
  if (!elements.securityBanner) {
    return;
  }

  const bindHost = String(elements.bindHost?.value || "").trim();
  const token = String(elements.authToken?.value || "").trim();
  const isLocalOnly = isLocalBindHost(bindHost);
  const tone = deriveSecurityTone(isLocalOnly, token);
  const message = deriveSecurityMessage(isLocalOnly, token);

  elements.securityBanner.dataset.tone = tone;
  elements.securityBanner.textContent = message;
}

/**
 * @param {string} host
 */
function isLocalBindHost(host) {
  const normalized = host.toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

/**
 * @param {boolean} isLocalOnly
 * @param {string} token
 */
function deriveSecurityTone(isLocalOnly, token) {
  if (!isLocalOnly && token.length === 0) {
    return "danger";
  }
  if (!isLocalOnly && token.length > 0 && token.length < 16) {
    return "warn";
  }
  if (!isLocalOnly) {
    return "ok";
  }
  return "ok";
}

/**
 * @param {boolean} isLocalOnly
 * @param {string} token
 */
function deriveSecurityMessage(isLocalOnly, token) {
  if (!isLocalOnly && token.length === 0) {
    return "Risky profile: hub is exposed beyond localhost and no auth token is configured.";
  }
  if (!isLocalOnly && token.length < 16) {
    return "Warning: hub is exposed beyond localhost. Use a stronger token (recommended: 16+ chars).";
  }
  if (!isLocalOnly) {
    return "Remote-ready profile: network bind enabled and auth token configured.";
  }
  if (token.length > 0) {
    return "Local-only profile with token enabled.";
  }
  return "Local-only profile.";
}

/**
 * @param {Record<string, unknown>} state
 */
function renderMobileConnect(state) {
  const mobileConnect = state?.mobileConnect && typeof state.mobileConnect === "object" ? state.mobileConnect : {};
  const recommendedUrl = String(mobileConnect.recommendedUrl || state?.hubUrl || "");
  const token = String(mobileConnect.token || "");
  const tokenMasked = String(mobileConnect.tokenMasked || "");
  const urls = Array.isArray(mobileConnect.urls) ? mobileConnect.urls : [];

  lastKnownMobileUrl = recommendedUrl;
  lastKnownToken = token;

  if (elements.mobileUrl) {
    elements.mobileUrl.value = recommendedUrl;
  }
  if (elements.mobileTokenMask) {
    elements.mobileTokenMask.textContent = tokenMasked || "not configured";
  }
  if (!elements.mobileUrlList) {
    return;
  }

  elements.mobileUrlList.innerHTML = "";
  if (urls.length === 0) {
    const item = document.createElement("li");
    item.textContent = "No network candidates detected yet.";
    elements.mobileUrlList.appendChild(item);
    return;
  }

  for (const candidate of urls) {
    const label = String(candidate?.label || candidate?.host || "URL");
    const url = String(candidate?.url || "");
    const item = document.createElement("li");
    item.textContent = `${label}: ${url}`;
    elements.mobileUrlList.appendChild(item);
  }
}

/**
 * @param {string} text
 * @param {string} label
 */
async function copyTextToClipboard(text, label) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    setStatusMessage(`${label} is empty.`);
    return;
  }

  try {
    await navigator.clipboard.writeText(normalized);
    setStatusMessage(`${label} copied to clipboard.`);
    return;
  } catch {
    // Fallback keeps copy available on older clipboard APIs.
  }

  const textarea = document.createElement("textarea");
  textarea.value = normalized;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  try {
    document.execCommand("copy");
    setStatusMessage(`${label} copied to clipboard.`);
  } catch (error) {
    setStatusMessage(`Failed to copy ${label.toLowerCase()}: ${stringifyError(error)}`);
  } finally {
    textarea.remove();
  }
}

function generateAuthToken() {
  const bytes = new Uint8Array(24);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  }

  const fallback = Math.random().toString(36).slice(2);
  return `token_${Date.now().toString(36)}_${fallback}`;
}
