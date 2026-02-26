const STORAGE_KEY = "vsc_codex_bridge_pwa_state_v2";
const POLL_INTERVAL_MS = 1_000;
const API_TIMEOUT_MS = 10_000;
const OBSERVED_ACTIVE_TURN_TTL_MS = 90_000;
const THINKING_GRACE_MS = 3_000;
const RECENT_COMPLETION_WINDOW_MS = 10_000;
const BUILD_VERSION = "20260226-27";
const DEBUG_THINKING_LOGS = true;
const MAX_EVENT_LINES = 400;
const MOBILE_BREAKPOINT_PX = 900;
const STICK_TO_BOTTOM_THRESHOLD_PX = 120;
const JUMP_BUTTON_THRESHOLD_PX = 20;
const HEADER_HIDE_AFTER_SCROLL_PX = 32;
const HEADER_HIDE_DELTA_PX = 10;
const HEADER_SHOW_DELTA_PX = 4;
const MAX_ACTIVITY_EVENTS_PER_TURN = 120;
const MAX_ACTIVITY_DETAILS_CHARS = 380;
const WS_RECONNECT_BASE_MS = 900;
const WS_RECONNECT_MAX_MS = 12_000;
const WS_RECONNECT_JITTER_RATIO = 0.2;
const TIMELINE_WINDOW_INITIAL_MESSAGES = 140;
const TIMELINE_WINDOW_STEP_MESSAGES = 120;
const KEYBOARD_OPEN_THRESHOLD_PX = 90;
const DEFAULT_HUB_ORIGIN = resolveHubOrigin();
const NEW_THREAD_DRAFT_PREFIX = "__draft_new_thread__";

/**
 * Central UI state for the PWA.
 *
 * Notes:
 * - This UI is intentionally optimistic and keeps local state responsive.
 * - Server source of truth remains the selected bridge thread detail endpoint.
 */
const state = {
  hubOrigin: DEFAULT_HUB_ORIGIN,
  token: "",
  modelId: "",
  accessMode: "full-access",

  selectedBridgeId: null,
  selectedThreadId: null,
  selectedTurnId: null,

  bridges: [],
  threadByBridge: new Map(),
  draftThreadByBridge: new Map(),
  threadDetail: null,
  threadDetailBridgeId: null,

  ws: null,
  pollTimer: null,
  refreshTimer: null,
  wsReconnectTimer: null,
  wsReconnectAttempt: 0,
  suppressStreamReconnectUntil: 0,

  liveAssistantByTurn: new Map(),
  activityEventsByTurn: new Map(),
  expandedActivityTurnIds: new Set(),
  observedActiveTurnByThread: new Map(),
  timelineRenderLimitByThread: new Map(),
  pendingJumpThreadId: null,

  isDrawerOpen: false,
  loadingThreadsBridgeId: null,
  isOffline: typeof navigator !== "undefined" ? navigator.onLine === false : false,
  isHubReachable: true,
  lastHubErrorMessage: null,
  hubSecurity: null,
  viewportBaseHeight: 0,
  keyboardInsetPx: 0,
  isKeyboardOpen: false,
  isThinking: false,
  activeTurnStatus: null,
  lastThinkingSeenAt: 0,
  lastSelectedThreadUpdatedAt: null,
  lastThinkingDebugKey: "",
  isTopbarExpanded: false,
  isTopbarHidden: false,
  lastMessagesScrollTop: 0,
  messagesRenderSignature: "",
  isThreadSelectionLoading: false,

  // Guards async requests from stale updates.
  requestCounter: 0,
  threadDetailRequestCounter: 0,
  threadDetailInFlight: false,
  threadDetailRefreshQueued: false,

  // Dictation capability state.
  dictation: {
    supported: false,
    active: false,
    shouldStayActive: false,
    recognition: null,
  },
};

const dom = {
  topbar: document.getElementById("topbar"),
  topbarToggle: document.getElementById("topbar-toggle"),
  menuToggle: document.getElementById("menu-toggle"),
  drawerClose: document.getElementById("drawer-close"),
  drawerBackdrop: document.getElementById("drawer-backdrop"),
  drawer: document.getElementById("drawer"),

  hubToken: document.getElementById("hub-token"),
  modelId: document.getElementById("model-id"),
  accessMode: document.getElementById("access-mode"),
  saveConfig: document.getElementById("save-config"),
  loadBridges: document.getElementById("load-bridges"),
  status: document.getElementById("status"),
  securityStatus: document.getElementById("security-status"),

  threadTitle: document.getElementById("thread-title"),
  threadMeta: document.getElementById("thread-meta"),
  connectionPill: document.getElementById("connection-pill"),
  streamPill: document.getElementById("stream-pill"),
  thinkingPill: document.getElementById("thinking-pill"),

  workspaceTree: document.getElementById("workspace-tree"),
  connectionBanner: document.getElementById("connection-banner"),
  connectionBannerText: document.getElementById("connection-banner-text"),
  connectionBannerRetry: document.getElementById("connection-banner-retry"),
  messages: document.getElementById("messages"),
  jumpBottom: document.getElementById("jump-bottom"),
  approvalsStrip: document.getElementById("approvals-strip"),
  thinkingIndicator: document.getElementById("thinking-indicator"),
  thinkingJumpThread: document.getElementById("thinking-jump-thread"),
  events: document.getElementById("events"),

  prompt: document.getElementById("prompt"),
  micToggle: document.getElementById("mic-toggle"),
  dictationHint: document.getElementById("dictation-hint"),
  interruptTurn: document.getElementById("interrupt-turn"),
  primaryAction: document.getElementById("primary-action"),
};

bootstrap();

/**
 * Initializes state, handlers and first data load.
 */
function bootstrap() {
  installDebugHooks();
  debugThinkingLog("bootstrap", { build: BUILD_VERSION });
  restoreState();
  const tokenLoadedFromUrl = consumeTokenFromUrl();
  bindEvents();
  setupDictationSupport();
  initializeConnectivityState();
  updateViewportMetrics();

  updateConversationHeader(null);
  renderWorkspaceTree();
  renderMessages(null);
  renderApprovals(null);
  updateThinkingState(null);
  updateStreamPill("idle", "Stream idle");
  updateConnectionBanner();
  renderSecurityStatus();
  updatePrimaryAction();
  setTopbarExpanded(false);
  syncScrollAffordances();

  setStatus(tokenLoadedFromUrl ? "Token loaded from URL." : "Ready.");

  // If no prior selection exists, open menu to guide first connection.
  if (!state.selectedBridgeId || !state.selectedThreadId) {
    openDrawer();
  }

  void loadBridges();
}

/**
 * Connects all UI listeners.
 */
function bindEvents() {
  dom.menuToggle.addEventListener("click", () => {
    toggleDrawer();
  });

  dom.topbarToggle.addEventListener("click", () => {
    setTopbarExpanded(!state.isTopbarExpanded);
  });

  dom.drawerClose.addEventListener("click", () => {
    closeDrawer();
  });

  dom.drawerBackdrop.addEventListener("click", () => {
    closeDrawer();
  });

  dom.saveConfig.addEventListener("click", () => {
    state.token = dom.hubToken.value.trim();
    state.modelId = dom.modelId.value.trim();
    state.accessMode = dom.accessMode.value;

    persistState();
    setStatus("Configuration saved.");
  });

  dom.loadBridges.addEventListener("click", () => {
    state.token = dom.hubToken.value.trim();
    state.modelId = dom.modelId.value.trim();
    state.accessMode = dom.accessMode.value;

    persistState();
    void loadBridges();
  });

  dom.prompt.addEventListener("input", () => {
    updatePrimaryAction();
  });

  dom.prompt.addEventListener("focus", () => {
    updateViewportMetrics();

    if (window.innerWidth <= MOBILE_BREAKPOINT_PX) {
      window.setTimeout(() => {
        scrollMessagesToBottom("smooth");
      }, 140);
    }
  });

  dom.prompt.addEventListener("blur", () => {
    window.setTimeout(() => {
      updateViewportMetrics();
    }, 80);
  });

  dom.messages.addEventListener("scroll", () => {
    onMessagesScroll();
  });

  dom.jumpBottom.addEventListener("click", () => {
    scrollMessagesToBottom("smooth");
  });

  dom.primaryAction.addEventListener("click", () => {
    void handlePrimaryAction();
  });

  dom.thinkingJumpThread.addEventListener("click", () => {
    void jumpToWorkspaceActiveThread();
  });

  dom.interruptTurn.addEventListener("click", () => {
    void interruptCurrentTurn();
  });

  dom.connectionBannerRetry.addEventListener("click", () => {
    void retryConnectivityNow();
  });

  dom.micToggle.addEventListener("click", () => {
    toggleDictation();
  });

  window.addEventListener("online", () => {
    state.isOffline = false;
    if (!state.ws) {
      updateStreamPill("idle", "Stream idle");
    }
    setStatus("Network restored. Reconnecting...");
    updateConnectionBanner();
    void retryConnectivityNow();
  });

  window.addEventListener("offline", () => {
    state.isOffline = true;
    markHubReachable(false, "offline");
    clearStreamReconnectState(true);
    updateStreamPill("warn", "Stream offline");
    setStatus("Browser is offline.");
    updateConnectionBanner();
  });

  window.addEventListener("beforeunload", () => {
    stopDictation();
    closeStreamAndPolling();
  });

  window.addEventListener("resize", () => {
    updateViewportMetrics();

    if (window.innerWidth > MOBILE_BREAKPOINT_PX) {
      // Keep menu closed on desktop unless explicitly toggled.
      return;
    }

    // On mobile, backdrop state can desync on orientation changes.
    if (!state.isDrawerOpen) {
      dom.drawerBackdrop.hidden = true;
    }
  });

  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", () => {
      updateViewportMetrics();
    });

    window.visualViewport.addEventListener("scroll", () => {
      updateViewportMetrics();
    });
  }
}

/**
 * Restores the local persisted app state.
 */
function restoreState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      applyStateToInputs();
      return;
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      applyStateToInputs();
      return;
    }

    if (typeof parsed.token === "string") {
      state.token = parsed.token;
    }

    if (typeof parsed.modelId === "string") {
      state.modelId = parsed.modelId;
    }

    if (typeof parsed.accessMode === "string") {
      state.accessMode = parsed.accessMode === "plan-only" ? "plan-only" : "full-access";
    }

    if (typeof parsed.selectedBridgeId === "string") {
      state.selectedBridgeId = parsed.selectedBridgeId;
    }

    if (typeof parsed.selectedThreadId === "string") {
      state.selectedThreadId = parsed.selectedThreadId;
    }
  } catch {
    // Keep defaults when local state is corrupted.
  }

  applyStateToInputs();
}

/**
 * Reads `token` query parameter for quick mobile onboarding.
 * Persists token locally, then removes it from URL to avoid leaking via history/screenshots.
 */
function consumeTokenFromUrl() {
  try {
    const currentUrl = new URL(window.location.href);
    const token = safeUrlToken(currentUrl.searchParams.get("token") || currentUrl.searchParams.get("authToken"));
    if (!token) {
      return false;
    }

    state.token = token;
    applyStateToInputs();
    persistState();

    currentUrl.searchParams.delete("token");
    currentUrl.searchParams.delete("authToken");

    const query = currentUrl.searchParams.toString();
    const sanitizedPath = `${currentUrl.pathname}${query ? `?${query}` : ""}${currentUrl.hash || ""}`;
    window.history.replaceState(null, "", sanitizedPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reflects in-memory state into form controls.
 */
function applyStateToInputs() {
  dom.hubToken.value = state.token;
  dom.modelId.value = state.modelId;
  dom.accessMode.value = state.accessMode;
}

/**
 * @param {unknown} value
 */
function safeUrlToken(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

/**
 * Persists the subset of state that should survive refreshes.
 */
function persistState() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      token: state.token,
      modelId: state.modelId,
      accessMode: state.accessMode,
      selectedBridgeId: state.selectedBridgeId,
      selectedThreadId: state.selectedThreadId,
    }),
  );
}

/**
 * Shared API helper for hub endpoints.
 */
async function apiRequest(path, options = {}) {
  const url = new URL(path, state.hubOrigin).toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, API_TIMEOUT_MS);

  const headers = {
    "content-type": "application/json",
    ...(options.headers || {}),
  };

  if (state.token) {
    headers.authorization = `Bearer ${state.token}`;
  }

  let response = null;
  try {
    response = await fetch(url, {
      ...options,
      headers,
      signal: controller.signal,
    });
    markHubReachable(true);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      markHubReachable(false, "timeout");
      throw new Error(`Request timeout after ${API_TIMEOUT_MS} ms for ${path}.`);
    }
    markHubReachable(false, String(error));
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();

  let payload = null;
  let parseError = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch (error) {
    parseError = error;
    payload = null;
  }

  if (response.ok && text && parseError) {
    throw new Error(`Hub returned invalid JSON for ${path}.`);
  }

  if (!response.ok) {
    const message = payload?.message || text || `HTTP ${response.status}`;
    throw new Error(message);
  }

  return payload;
}

/**
 * Connects to hub and refreshes available workspaces.
 */
async function loadBridges() {
  setStatus("Connecting to hub...");

  try {
    const payload = await apiRequest("/api/v1/bridges", { method: "GET" });
    const items = Array.isArray(payload?.items) ? payload.items : [];

    state.bridges = items;
    const bridgeIds = new Set(items.map((item) => item.bridgeId));
    for (const draftBridgeId of state.draftThreadByBridge.keys()) {
      if (!bridgeIds.has(draftBridgeId)) {
        state.draftThreadByBridge.delete(draftBridgeId);
      }
    }

    if (state.selectedBridgeId && !items.some((item) => item.bridgeId === state.selectedBridgeId)) {
      state.selectedBridgeId = null;
      state.selectedThreadId = null;
    }

    if (!state.selectedBridgeId && items.length > 0) {
      state.selectedBridgeId = items[0].bridgeId;
    }

    renderWorkspaceTree();
    await refreshHubSecurityStatus();

    if (state.selectedBridgeId) {
      await loadThreads(state.selectedBridgeId, {
        preferredThreadId: state.selectedThreadId,
        showStatus: false,
      });

      setStatus(`Connected. Loaded ${items.length} workspace(s).`);
    } else {
      clearSelectionState();
      setStatus("Connected, but no active workspaces found.");
    }

    updateConnectionPill("ok", items.length > 0 ? "Connected" : "Connected (0 workspaces)");
    if (!state.ws && !state.wsReconnectTimer) {
      updateStreamPill("idle", "Stream idle");
    }
  } catch (error) {
    state.bridges = [];
    clearSelectionState();
    renderWorkspaceTree();

    setStatus(`Connection failed: ${String(error)}`, true);
    updateConnectionPill("danger", "Connection failed");
    updateStreamPill("warn", "Stream offline");
    state.hubSecurity = null;
    renderSecurityStatus();
  }
}

/**
 * Loads thread list for one workspace and opens the preferred thread.
 */
async function loadThreads(bridgeId, options = {}) {
  const previousBridgeId = state.selectedBridgeId;
  const switchingBridge = previousBridgeId !== bridgeId;
  const showStatus = options.showStatus !== false;
  const preferredThreadId =
    options.preferredThreadId ?? (state.selectedBridgeId === bridgeId ? state.selectedThreadId : null);

  state.selectedBridgeId = bridgeId;
  if (switchingBridge) {
    // Immediately clear old thread content so workspace switches never display stale chat.
    resetActiveThreadView();
    state.selectedThreadId = null;
    state.isThreadSelectionLoading = true;
    renderMessages(null, { force: true });
    updatePrimaryAction();
  }
  state.loadingThreadsBridgeId = bridgeId;
  persistState();
  renderWorkspaceTree();

  if (showStatus) {
    setStatus(`Loading threads for workspace ${threadIdShort(bridgeId)}...`);
  }

  const requestId = ++state.requestCounter;

  try {
    const payload = await apiRequest(`/api/v1/bridges/${encodeURIComponent(bridgeId)}/threads`, {
      method: "GET",
    });

    // Ignore stale responses when a newer request has started.
    if (requestId !== state.requestCounter) {
      return;
    }

    const items = Array.isArray(payload?.items) ? payload.items : [];
    state.threadByBridge.set(bridgeId, items);
    state.loadingThreadsBridgeId = null;

    if (preferredThreadId && isDraftThreadId(preferredThreadId)) {
      const draft = ensureDraftThreadForBridge(bridgeId, preferredThreadId);
      state.selectedThreadId = draft.threadId;
      state.selectedTurnId = null;
      state.threadDetail = null;
      state.threadDetailBridgeId = null;
      state.liveAssistantByTurn.clear();
      state.messagesRenderSignature = "";
      state.threadDetailRefreshQueued = false;
      state.isThreadSelectionLoading = false;
      closeStreamAndPolling();

      persistState();
      renderWorkspaceTree();
      updateConversationHeader({ thread: draft, messages: [], turns: [] });
      renderMessages({ thread: draft, messages: [], turns: [] }, { force: true });
      renderApprovals(null);
      updateThinkingState(null);
      updatePrimaryAction();

      if (showStatus) {
        setStatus("New conversation ready.");
      }
      return;
    }

    if (items.length === 0) {
      state.selectedThreadId = null;
      state.selectedTurnId = null;
      state.threadDetail = null;
      state.threadDetailBridgeId = null;
      state.liveAssistantByTurn.clear();
      state.messagesRenderSignature = "";
      state.threadDetailRefreshQueued = false;
      state.isThreadSelectionLoading = false;
      closeStreamAndPolling();

      renderWorkspaceTree();
      renderMessages(null);
      renderApprovals(null);
      updateConversationHeader(null);
      updateThinkingState(null);
      updatePrimaryAction();

      if (showStatus) {
        setStatus("No threads in selected workspace.");
      }
      persistState();
      return;
    }

    const preferred =
      items.find((item) => item.threadId === preferredThreadId) || items.find((item) => item.activeTurnId) || items[0];

    state.selectedThreadId = preferred.threadId;
    persistState();

    renderWorkspaceTree();
    await openThread(preferred.threadId, { showStatus });
  } catch (error) {
    if (requestId !== state.requestCounter) {
      return;
    }

    state.loadingThreadsBridgeId = null;
    state.threadByBridge.set(bridgeId, []);
    state.isThreadSelectionLoading = false;
    renderWorkspaceTree();
    renderMessages(state.threadDetail, { force: true });
    updatePrimaryAction();

    setStatus(`Thread load failed: ${String(error)}`, true);
  }
}

/**
 * Opens one thread and fetches full detail.
 */
async function openThread(threadId, options = { showStatus: true }) {
  if (!state.selectedBridgeId) {
    return;
  }

  if (isDraftThreadId(threadId)) {
    await startNewConversationDraft(state.selectedBridgeId);
    return;
  }

  const viewOnDifferentBridge = state.threadDetailBridgeId && state.threadDetailBridgeId !== state.selectedBridgeId;
  if (state.selectedThreadId !== threadId || viewOnDifferentBridge) {
    resetActiveThreadView();
    state.isThreadSelectionLoading = true;
  }

  state.selectedThreadId = threadId;
  if (!state.timelineRenderLimitByThread.has(threadId)) {
    state.timelineRenderLimitByThread.set(threadId, TIMELINE_WINDOW_INITIAL_MESSAGES);
  }
  persistState();

  renderWorkspaceTree();
  updateConversationHeader(null);
  renderMessages(null, { force: true });
  updatePrimaryAction();
  await refreshThreadDetail({ showStatus: options.showStatus });

  // Close drawer after selection on mobile for app-like behavior.
  if (window.innerWidth <= MOBILE_BREAKPOINT_PX) {
    closeDrawer();
  }
}

/**
 * Creates/selects a local draft thread entry used to start a brand new conversation.
 * The real thread id is resolved after the first message is sent.
 */
async function startNewConversationDraft(bridgeId) {
  if (!bridgeId) {
    setStatus("Select a workspace first.", true);
    return;
  }

  const selectedBridgeId = state.selectedBridgeId;
  if (selectedBridgeId !== bridgeId) {
    await loadThreads(bridgeId, { showStatus: false });
  }

  const draft = ensureDraftThreadForBridge(bridgeId);

  state.selectedBridgeId = bridgeId;
  resetActiveThreadView();
  stopPolling();
  state.selectedThreadId = draft.threadId;
  state.selectedTurnId = null;
  state.threadDetail = null;
  state.threadDetailBridgeId = null;
  state.isThreadSelectionLoading = false;

  persistState();
  renderWorkspaceTree();
  updateConversationHeader({ thread: draft, messages: [], turns: [] });
  renderMessages({ thread: draft, messages: [], turns: [] }, { force: true });
  renderApprovals(null);
  updateThinkingState(null);
  updatePrimaryAction();
  setStatus("New conversation ready. Write a prompt and tap send.");

  if (window.innerWidth <= MOBILE_BREAKPOINT_PX) {
    closeDrawer();
  }
}

function ensureDraftThreadForBridge(bridgeId, existingThreadId = null) {
  const now = new Date().toISOString();
  const threadId = existingThreadId || draftThreadIdForBridge(bridgeId);

  const draft = {
    threadId,
    title: "New conversation",
    createdAt: now,
    updatedAt: now,
    status: "idle",
    activeTurnId: null,
  };

  state.draftThreadByBridge.set(bridgeId, draft);
  return draft;
}

/**
 * Pulls thread detail and updates timeline + thinking state.
 */
async function refreshThreadDetail(options = { showStatus: false }) {
  if (!state.selectedBridgeId || !state.selectedThreadId) {
    return;
  }
  if (isDraftThreadId(state.selectedThreadId)) {
    return;
  }

  if (state.threadDetailInFlight) {
    state.threadDetailRefreshQueued = true;
    return;
  }
  state.threadDetailRefreshQueued = false;

  // Keep selected thread synchronized even when WS events are sparse.
  ensurePolling();

  const requestedBridgeId = state.selectedBridgeId;
  const requestedThreadId = state.selectedThreadId;
  const requestId = ++state.threadDetailRequestCounter;
  state.threadDetailInFlight = true;

  if (options.showStatus) {
    setStatus("Loading thread...");
  }

  try {
    const payload = await apiRequest(
      `/api/v1/bridges/${encodeURIComponent(requestedBridgeId)}/threads/${encodeURIComponent(requestedThreadId)}`,
      {
        method: "GET",
      },
    );

    // Ignore stale responses if a newer thread-detail request already started,
    // or if the user switched bridge/thread while this request was in flight.
    if (requestId !== state.threadDetailRequestCounter) {
      return;
    }

    if (state.selectedBridgeId !== requestedBridgeId || state.selectedThreadId !== requestedThreadId) {
      return;
    }

    state.threadDetail = payload;
    state.threadDetailBridgeId = requestedBridgeId;
    state.isThreadSelectionLoading = false;
    reconcileObservedActiveTurn(payload);
    captureRecentThreadActivity(payload);

    updateConversationHeader(payload);
    renderMessages(payload);
    renderApprovals(payload);
    updateThinkingState(payload);
    updatePrimaryAction();

    const activeTurn = findActiveTurn(payload) || findActiveTurnFromSelectedThreadSummary();
    if (activeTurn) {
      if (state.selectedTurnId !== activeTurn.turnId) {
        state.selectedTurnId = activeTurn.turnId;
        openTurnStream(activeTurn.turnId);
      }
    } else {
      state.selectedTurnId = null;
      closeTurnStream({ resetReconnect: true });
      updateStreamPill("idle", "Stream idle");
    }

    renderWorkspaceTree();

    if (options.showStatus) {
      setStatus(`Thread loaded (${threadIdShort(state.selectedThreadId)}).`);
    }
  } catch (error) {
    if (requestId !== state.threadDetailRequestCounter) {
      return;
    }

    if (state.selectedBridgeId !== requestedBridgeId || state.selectedThreadId !== requestedThreadId) {
      return;
    }

    setStatus(`Thread refresh failed: ${String(error)}`, true);
    state.isThreadSelectionLoading = false;
    renderMessages(state.threadDetail, { force: true });
    // Keep last known state during transient failures to avoid false Idle transitions.
    updateThinkingState(state.threadDetail);
    updatePrimaryAction();
    debugThinkingLog("refreshThreadDetail:error", {
      error: String(error),
      requestedBridgeId,
      requestedThreadId,
    });
  } finally {
    if (requestId === state.threadDetailRequestCounter) {
      state.threadDetailInFlight = false;
      if (state.threadDetailRefreshQueued && state.selectedBridgeId && state.selectedThreadId) {
        state.threadDetailRefreshQueued = false;
        queueMicrotask(() => {
          void refreshThreadDetail({ showStatus: false });
        });
      }
    }
  }
}

/**
 * Clears per-thread render/stream state while keeping current workspace selection.
 * Used when switching workspace/thread to avoid displaying stale timeline content.
 */
function resetActiveThreadView() {
  closeTurnStream({ resetReconnect: true });
  state.threadDetail = null;
  state.threadDetailBridgeId = null;
  state.selectedTurnId = null;
  state.liveAssistantByTurn.clear();
  state.lastSelectedThreadUpdatedAt = null;
  state.messagesRenderSignature = "";
  state.threadDetailRefreshQueued = false;
  state.isThreadSelectionLoading = false;

  renderMessages(null, { force: true });
  renderApprovals(null);
  updateThinkingState(null);
  updatePrimaryAction();
}

/**
 * Renders left drawer workspace->threads hierarchy.
 */
function renderWorkspaceTree() {
  dom.workspaceTree.innerHTML = "";

  if (state.bridges.length === 0) {
    const empty = document.createElement("li");
    empty.className = "tree-empty";
    empty.textContent = "No active workspaces.";
    dom.workspaceTree.appendChild(empty);
    return;
  }

  for (const bridge of state.bridges) {
    const card = document.createElement("li");
    card.className = "workspace-card";

    const workspaceBtn = document.createElement("button");
    workspaceBtn.type = "button";
    workspaceBtn.className = "workspace-card__header";

    if (bridge.bridgeId === state.selectedBridgeId) {
      workspaceBtn.classList.add("is-active");
    }

    const workspaceTitle = document.createElement("span");
    workspaceTitle.className = "workspace-card__title";
    const workspaceTitleText = bridge.workspaceName || `Workspace ${threadIdShort(bridge.bridgeId)}`;
    workspaceTitle.textContent = workspaceTitleText;
    workspaceTitle.title = workspaceTitleText;

    const workspaceMeta = document.createElement("span");
    workspaceMeta.className = "workspace-card__meta";

    if (state.loadingThreadsBridgeId === bridge.bridgeId) {
      workspaceMeta.textContent = "Loading threads...";
    } else {
      workspaceMeta.textContent = `${threadIdShort(bridge.bridgeId)} - ${bridge.host || "127.0.0.1"}:${bridge.port}`;
    }

    workspaceBtn.appendChild(workspaceTitle);
    workspaceBtn.appendChild(workspaceMeta);

    workspaceBtn.addEventListener("click", () => {
      void loadThreads(bridge.bridgeId, {
        preferredThreadId: state.selectedBridgeId === bridge.bridgeId ? state.selectedThreadId : null,
      });
    });

    card.appendChild(workspaceBtn);

    const threads = state.threadByBridge.get(bridge.bridgeId) || [];
    const draft = state.draftThreadByBridge.get(bridge.bridgeId) || null;
    const shouldExpand = bridge.bridgeId === state.selectedBridgeId;

    if (shouldExpand) {
      const actionsRow = document.createElement("div");
      actionsRow.className = "workspace-card__actions";

      const newThreadBtn = document.createElement("button");
      newThreadBtn.type = "button";
      newThreadBtn.className = "workspace-card__new-thread";
      newThreadBtn.textContent = "+ New conversation";
      newThreadBtn.addEventListener("click", () => {
        void startNewConversationDraft(bridge.bridgeId);
      });
      actionsRow.appendChild(newThreadBtn);
      card.appendChild(actionsRow);

      const visibleThreads = draft
        ? [draft, ...threads.filter((item) => item.threadId !== draft.threadId)]
        : threads;

      if (visibleThreads.length === 0 && state.loadingThreadsBridgeId !== bridge.bridgeId) {
        const emptyThreads = document.createElement("div");
        emptyThreads.className = "tree-empty";
        emptyThreads.textContent = "No threads.";
        card.appendChild(emptyThreads);
      } else if (visibleThreads.length > 0) {
        const threadList = document.createElement("ul");
        threadList.className = "thread-list";

        for (const thread of visibleThreads) {
          const li = document.createElement("li");

          const threadBtn = document.createElement("button");
          threadBtn.type = "button";
          threadBtn.className = "thread-item";
          const draftThread = isDraftThreadId(thread.threadId);

          if (draftThread) {
            threadBtn.classList.add("is-draft");
          }

          if (thread.threadId === state.selectedThreadId) {
            threadBtn.classList.add("is-active");
          }

          const threadTitle = document.createElement("span");
          threadTitle.className = "thread-item__title";
          const threadTitleText = thread.title || `Thread ${threadIdShort(thread.threadId)}`;
          threadTitle.textContent = threadTitleText;
          threadTitle.title = threadTitleText;

          const statusLabel = draftThread
            ? "not sent yet"
            : thread.activeTurnId
              ? `running ${threadIdShort(thread.activeTurnId)}`
              : `${thread.status || "idle"} - ${formatDateTime(thread.updatedAt)}`;

          const threadMeta = document.createElement("span");
          threadMeta.className = "thread-item__meta";
          const threadMetaText = `${threadIdShort(thread.threadId)} - ${statusLabel}`;
          threadMeta.textContent = threadMetaText;
          threadMeta.title = threadMetaText;

          threadBtn.appendChild(threadTitle);
          threadBtn.appendChild(threadMeta);

          threadBtn.addEventListener("click", () => {
            if (draftThread) {
              void startNewConversationDraft(bridge.bridgeId);
              return;
            }
            void openThread(thread.threadId);
          });

          li.appendChild(threadBtn);
          threadList.appendChild(li);
        }

        card.appendChild(threadList);
      }
    }

    dom.workspaceTree.appendChild(card);
  }
}

/**
 * Renders conversation timeline with markdown + extras + live streaming bubble.
 */
function renderMessages(detail, options = {}) {
  const force = options.force === true;
  const signature = buildMessagesRenderSignature(detail);

  if (!force && signature === state.messagesRenderSignature) {
    syncScrollAffordances();
    return;
  }

  state.messagesRenderSignature = signature;

  const shouldStick = isNearBottom(dom.messages, STICK_TO_BOTTOM_THRESHOLD_PX);
  const messages = Array.isArray(detail?.messages) ? detail.messages : [];
  const turns = Array.isArray(detail?.turns) ? detail.turns : [];
  const activityTurnId = pickActivityTurnId(turns);
  const threadId = asString(detail?.thread?.threadId) || state.selectedThreadId;
  const timelineWindow = resolveTimelineWindow(messages, threadId);
  const fragment = document.createDocumentFragment();

  if (messages.length === 0 && !state.selectedTurnId) {
    if (state.isThreadSelectionLoading && state.selectedBridgeId) {
      fragment.appendChild(createThreadLoadingSkeleton());
    } else {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "No messages yet. Send the first prompt.";
      fragment.appendChild(empty);
    }
  } else {
    if (timelineWindow.hiddenCount > 0) {
      const timelineWindowControl = createTimelineWindowControl(timelineWindow);
      fragment.appendChild(timelineWindowControl);
    }

    const turnById = new Map(turns.map((turn) => [turn.turnId, turn]));
    const extrasRendered = new Set();

    for (const message of timelineWindow.items) {
      const role = normalizeRole(message.role);
      const node = createMessageNode({
        role,
        text: String(message.text || ""),
        ts: message.ts,
        turnId: message.turnId,
        kind: message.kind,
      });

      if (role === "assistant" && message.turnId && turnById.has(message.turnId) && !extrasRendered.has(message.turnId)) {
        const extras = createTurnExtras(turnById.get(message.turnId));
        if (extras) {
          node.appendChild(extras);
          extrasRendered.add(message.turnId);
        }
      }

      fragment.appendChild(node);
    }
  }

  // Render live streaming assistant text in the active turn while deltas arrive.
  if (state.selectedTurnId && state.liveAssistantByTurn.has(state.selectedTurnId)) {
    const liveText = state.liveAssistantByTurn.get(state.selectedTurnId) || "";

    const liveNode = createMessageNode({
      role: "assistant",
      text: liveText || "...",
      ts: new Date().toISOString(),
      turnId: state.selectedTurnId,
      kind: "live",
      isLive: true,
    });

    fragment.appendChild(liveNode);
  }

  if (activityTurnId) {
    const activityNode = createActivityMessageCard(activityTurnId);
    if (activityNode) {
      fragment.appendChild(activityNode);
    }
  }

  dom.messages.replaceChildren(fragment);

  if (shouldStick) {
    scrollMessagesToBottom();
  } else {
    syncScrollAffordances();
  }
}

/**
 * Creates a compact skeleton placeholder while loading a newly selected thread.
 */
function createThreadLoadingSkeleton() {
  const wrapper = document.createElement("div");
  wrapper.className = "thread-loading-skeleton";

  for (let index = 0; index < 3; index += 1) {
    const card = document.createElement("div");
    card.className = "thread-loading-card";

    const lineTop = document.createElement("span");
    lineTop.className = "thread-loading-line thread-loading-line--meta";
    card.appendChild(lineTop);

    const lineBody = document.createElement("span");
    lineBody.className = "thread-loading-line thread-loading-line--body";
    card.appendChild(lineBody);

    const lineBodyShort = document.createElement("span");
    lineBodyShort.className = "thread-loading-line thread-loading-line--short";
    card.appendChild(lineBodyShort);

    wrapper.appendChild(card);
  }

  return wrapper;
}

/**
 * Builds a compact fingerprint of the rendered timeline to avoid unnecessary full re-renders.
 */
function buildMessagesRenderSignature(detail) {
  const messages = Array.isArray(detail?.messages) ? detail.messages : [];
  const turns = Array.isArray(detail?.turns) ? detail.turns : [];
  const threadId = asString(detail?.thread?.threadId) || state.selectedThreadId || "";
  const timelineLimit = threadId ? getTimelineRenderLimit(threadId, messages.length) : messages.length;
  const timelineHidden = Math.max(0, messages.length - Math.min(messages.length, timelineLimit));
  const recentMessages = messages.slice(-24);
  const recentTurns = turns.slice(-14);
  const activityTurnId = pickActivityTurnId(turns) || "";
  const activityCount = activityTurnId ? state.activityEventsByTurn.get(activityTurnId)?.length || 0 : 0;
  const liveTurnId = state.selectedTurnId || "";
  const liveText = liveTurnId ? state.liveAssistantByTurn.get(liveTurnId) || "" : "";

  const messageSignature = recentMessages
    .map((message) => {
      const text = asString(message?.text) || "";
      return `${asString(message?.turnId) || ""}:${normalizeRole(message?.role)}:${asString(message?.ts) || ""}:${text.length}:${text.slice(-16)}`;
    })
    .join("|");

  const turnSignature = recentTurns
    .map((turn) => {
      const planLength = Array.isArray(turn?.plan) ? turn.plan.length : 0;
      const approvalsLength = Array.isArray(turn?.approvals) ? turn.approvals.length : 0;
      const diffLength = asString(turn?.diff)?.length || 0;
      const assistantLength = asString(turn?.assistantText)?.length || 0;
      return `${asString(turn?.turnId) || ""}:${asString(turn?.status) || ""}:${assistantLength}:${planLength}:${approvalsLength}:${diffLength}`;
    })
    .join("|");

  return [
    threadId,
    asString(detail?.thread?.activeTurnId) || "",
    asString(detail?.thread?.status) || "",
    messages.length,
    timelineHidden,
    messageSignature,
    turnSignature,
    liveTurnId,
    liveText.length,
    liveText.slice(-24),
    activityTurnId,
    activityCount,
  ].join("||");
}

/**
 * Updates only the streaming live bubble to avoid rebuilding the full timeline on each delta.
 */
function renderLiveAssistantDelta(turnId) {
  if (!turnId || !state.selectedTurnId || turnId !== state.selectedTurnId) {
    return;
  }

  const shouldStick = isNearBottom(dom.messages, STICK_TO_BOTTOM_THRESHOLD_PX);
  const liveText = state.liveAssistantByTurn.get(turnId) || "";
  const liveNodes = dom.messages.querySelectorAll('article.message[data-live="true"]');
  let liveNode = null;
  for (const node of liveNodes) {
    if (node.dataset.turnId === turnId) {
      liveNode = node;
      break;
    }
  }

  if (!liveNode) {
    renderMessages(state.threadDetail, { force: true });
    return;
  }

  const body = liveNode.querySelector(".message__body");
  const headerMeta = liveNode.querySelector(".message__meta");
  if (body && body.dataset.rawText !== liveText) {
    body.dataset.rawText = liveText;
    body.innerHTML = markdownToHtml(liveText || "...");
  }

  if (headerMeta) {
    headerMeta.textContent = `${threadIdShort(turnId)} - ${formatDateTime(new Date().toISOString())}`;
  }

  if (state.threadDetail) {
    state.messagesRenderSignature = buildMessagesRenderSignature(state.threadDetail);
  }

  if (shouldStick) {
    scrollMessagesToBottom();
  } else {
    syncScrollAffordances();
  }
}

/**
 * Re-renders only the activity card section when intermediate execution events arrive.
 */
function renderActivityCardInPlace(detail) {
  const shouldStick = isNearBottom(dom.messages, STICK_TO_BOTTOM_THRESHOLD_PX);
  const turns = Array.isArray(detail?.turns) ? detail.turns : [];
  const activityTurnId = pickActivityTurnId(turns);
  const existing = dom.messages.querySelector("article.message--activity");

  if (!activityTurnId) {
    existing?.remove();
    syncScrollAffordances();
    return;
  }

  const nextNode = createActivityMessageCard(activityTurnId);
  if (!nextNode) {
    existing?.remove();
    syncScrollAffordances();
    return;
  }

  if (existing) {
    existing.replaceWith(nextNode);
  } else {
    dom.messages.appendChild(nextNode);
  }

  if (state.threadDetail) {
    state.messagesRenderSignature = buildMessagesRenderSignature(state.threadDetail);
  }

  if (shouldStick) {
    scrollMessagesToBottom();
  } else {
    syncScrollAffordances();
  }
}

/**
 * Resolves a per-thread render window for long timelines.
 */
function resolveTimelineWindow(messages, threadId) {
  const totalCount = Array.isArray(messages) ? messages.length : 0;
  if (totalCount === 0) {
    return {
      threadId,
      totalCount: 0,
      hiddenCount: 0,
      visibleCount: 0,
      items: [],
    };
  }

  if (!threadId) {
    return {
      threadId,
      totalCount,
      hiddenCount: 0,
      visibleCount: totalCount,
      items: messages,
    };
  }

  const limit = getTimelineRenderLimit(threadId, totalCount);
  const visibleCount = Math.min(totalCount, limit);
  const hiddenCount = Math.max(0, totalCount - visibleCount);
  const visibleMessages = hiddenCount > 0 ? messages.slice(hiddenCount) : messages;

  return {
    threadId,
    totalCount,
    hiddenCount,
    visibleCount,
    items: visibleMessages,
  };
}

/**
 * Returns render limit for one thread with bounded defaults.
 */
function getTimelineRenderLimit(threadId, totalCount) {
  const existing = state.timelineRenderLimitByThread.get(threadId);
  const baseline =
    typeof existing === "number" && Number.isFinite(existing) && existing > 0
      ? Math.floor(existing)
      : TIMELINE_WINDOW_INITIAL_MESSAGES;
  return Math.max(TIMELINE_WINDOW_INITIAL_MESSAGES, Math.min(baseline, Math.max(totalCount, TIMELINE_WINDOW_INITIAL_MESSAGES)));
}

/**
 * Shows a compact "load older" control above rendered messages.
 */
function createTimelineWindowControl(windowState) {
  const wrapper = document.createElement("div");
  wrapper.className = "timeline-window";

  const hiddenCount = windowState.hiddenCount;
  const shownCount = windowState.visibleCount;
  const totalCount = windowState.totalCount;
  const revealCount = Math.min(hiddenCount, TIMELINE_WINDOW_STEP_MESSAGES);

  const meta = document.createElement("span");
  meta.className = "timeline-window__meta";
  meta.textContent = `Showing ${shownCount} of ${totalCount} messages`;

  const action = document.createElement("button");
  action.type = "button";
  action.className = "timeline-window__button";
  action.textContent = `Load ${revealCount} older`;

  action.addEventListener("click", () => {
    const threadId = windowState.threadId;
    if (!threadId || !state.threadDetail) {
      return;
    }

    const beforeHeight = dom.messages.scrollHeight;
    const currentLimit = getTimelineRenderLimit(threadId, totalCount);
    const nextLimit = Math.min(totalCount, currentLimit + TIMELINE_WINDOW_STEP_MESSAGES);
    state.timelineRenderLimitByThread.set(threadId, nextLimit);

    renderMessages(state.threadDetail);

    // Preserve viewport anchor after prepending older items.
    requestAnimationFrame(() => {
      const afterHeight = dom.messages.scrollHeight;
      dom.messages.scrollTop += afterHeight - beforeHeight;
      syncScrollAffordances();
    });
  });

  wrapper.appendChild(meta);
  wrapper.appendChild(action);
  return wrapper;
}

/**
 * Builds one bubble node with markdown-capable body renderer.
 */
function createMessageNode(args) {
  const article = document.createElement("article");
  article.className = `message message--${args.role}`;

  if (args.isLive) {
    article.dataset.live = "true";
  }

  if (args.turnId) {
    article.dataset.turnId = args.turnId;
  }

  if (args.kind === "steer") {
    article.dataset.kind = "steer";
  }

  const header = document.createElement("header");
  header.className = "message__header";

  const role = document.createElement("strong");
  role.className = "message__role";
  role.textContent = args.kind === "live" ? "assistant (streaming)" : args.role;

  const meta = document.createElement("span");
  meta.className = "message__meta";
  meta.textContent = `${threadIdShort(args.turnId)} - ${formatDateTime(args.ts)}`;

  header.appendChild(role);
  header.appendChild(meta);

  const body = document.createElement("div");
  body.className = "message__body";
  body.dataset.rawText = String(args.text || "");
  body.innerHTML = markdownToHtml(args.text);

  article.appendChild(header);
  article.appendChild(body);

  return article;
}

/**
 * Renders plan + diff snippets for each assistant turn.
 */
function createTurnExtras(turn) {
  if (!turn) {
    return null;
  }

  const wrapper = document.createElement("div");
  wrapper.className = "turn-extras";

  if (Array.isArray(turn.plan) && turn.plan.length > 0) {
    const plan = document.createElement("details");
    plan.className = "plan-block";

    const summary = document.createElement("summary");
    summary.textContent = `Plan (${turn.plan.length})`;
    plan.appendChild(summary);

    const list = document.createElement("ul");
    list.className = "plan-list";

    for (const item of turn.plan) {
      const li = document.createElement("li");
      li.className = `plan-item--${item.status}`;
      li.textContent = `${item.status}: ${item.text}`;
      list.appendChild(li);
    }

    plan.appendChild(list);
    wrapper.appendChild(plan);
  }

  if (typeof turn.diff === "string" && turn.diff.trim().length > 0) {
    const diffNode = createDiffNode(turn.diff);
    wrapper.appendChild(diffNode);
  }

  return wrapper.childNodes.length > 0 ? wrapper : null;
}

/**
 * Diff renderer with file tags and line colors.
 */
function createDiffNode(diffText) {
  const block = document.createElement("div");
  block.className = "diff-block";

  const title = document.createElement("div");
  title.className = "diff-block__title";
  title.textContent = "Diff";
  block.appendChild(title);

  const files = extractDiffFiles(diffText);
  if (files.length > 0) {
    const fileRow = document.createElement("div");
    fileRow.className = "diff-files";

    for (const file of files) {
      const chip = document.createElement("span");
      chip.className = "diff-file";
      chip.textContent = file;
      fileRow.appendChild(chip);
    }

    block.appendChild(fileRow);
  }

  const linesWrap = document.createElement("div");
  linesWrap.className = "diff-lines";

  const lines = diffText.split("\n");
  for (const line of lines) {
    const div = document.createElement("pre");
    div.className = "diff-line";

    if (line.startsWith("+")) {
      div.classList.add("diff-line--add");
    } else if (line.startsWith("-")) {
      div.classList.add("diff-line--remove");
    } else if (line.startsWith("@@") || line.startsWith("diff --git") || line.startsWith("+++ ") || line.startsWith("--- ")) {
      div.classList.add("diff-line--meta");
    }

    div.textContent = line;
    linesWrap.appendChild(div);
  }

  block.appendChild(linesWrap);
  return block;
}

/**
 * Displays approval decisions in a compact strip above composer.
 */
function renderApprovals(detail) {
  const turns = Array.isArray(detail?.turns) ? detail.turns : [];
  const pending = [];

  for (const turn of turns) {
    const approvals = Array.isArray(turn.approvals) ? turn.approvals : [];
    for (const approval of approvals) {
      if (approval.status === "pending") {
        pending.push({ approval, turn });
      }
    }
  }

  dom.approvalsStrip.innerHTML = "";

  if (pending.length === 0) {
    return;
  }

  for (const item of pending) {
    const box = document.createElement("div");
    box.className = "approval-chip";

    const title = document.createElement("div");
    title.textContent = `${item.approval.type} requires approval`;

    const meta = document.createElement("div");
    meta.className = "approval-chip__meta";
    meta.textContent = `${item.approval.approvalId} - turn ${threadIdShort(item.turn.turnId)}`;

    const actions = document.createElement("div");
    actions.className = "approval-chip__actions";

    const approveBtn = document.createElement("button");
    approveBtn.className = "approve";
    approveBtn.type = "button";
    approveBtn.textContent = "Approve";
    approveBtn.addEventListener("click", () => {
      void decideApproval(item.approval.approvalId, "approve");
    });

    const denyBtn = document.createElement("button");
    denyBtn.className = "deny";
    denyBtn.type = "button";
    denyBtn.textContent = "Deny";
    denyBtn.addEventListener("click", () => {
      void decideApproval(item.approval.approvalId, "deny");
    });

    actions.appendChild(approveBtn);
    actions.appendChild(denyBtn);

    box.appendChild(title);
    box.appendChild(meta);
    box.appendChild(actions);

    dom.approvalsStrip.appendChild(box);
  }
}

/**
 * Updates top bar title/meta for current thread context.
 */
function updateConversationHeader(detail) {
  if (!state.selectedBridgeId || !state.selectedThreadId) {
    dom.threadTitle.textContent = "Select a thread";
    dom.threadMeta.textContent = "Open menu, connect hub, then pick workspace and thread.";
    return;
  }

  if (!detail?.thread) {
    if (isDraftThreadId(state.selectedThreadId)) {
      dom.threadTitle.textContent = "New conversation";
      dom.threadMeta.textContent = `Workspace ${threadIdShort(state.selectedBridgeId)}`;
      return;
    }

    dom.threadTitle.textContent = `Thread ${threadIdShort(state.selectedThreadId)}`;
    dom.threadMeta.textContent = `Workspace ${threadIdShort(state.selectedBridgeId)}`;
    return;
  }

  dom.threadTitle.textContent = detail.thread.title || `Thread ${threadIdShort(detail.thread.threadId)}`;
  dom.threadMeta.textContent = `${threadIdShort(detail.thread.threadId)} - ${detail.thread.status || "idle"} - updated ${formatDateTime(detail.thread.updatedAt)}`;
}

/**
 * Keeps all controls aligned with active turn status.
 */
function updateThinkingState(detail) {
  const now = Date.now();
  const selectedActiveTurn = findActiveTurn(detail) || findActiveTurnFromSelectedThreadSummary();
  const workspaceActiveTurn = selectedActiveTurn ? null : findAnyActiveTurnFromWorkspaceSummary();
  const visibleThinkingTurn = selectedActiveTurn || workspaceActiveTurn;
  const jumpThreadId =
    workspaceActiveTurn && workspaceActiveTurn.threadId && workspaceActiveTurn.threadId !== state.selectedThreadId
      ? workspaceActiveTurn.threadId
      : null;
  const hasGrace = !visibleThinkingTurn && now - state.lastThinkingSeenAt <= THINKING_GRACE_MS;

  if (visibleThinkingTurn) {
    state.lastThinkingSeenAt = now;

    if (selectedActiveTurn) {
      state.isThinking = true;
      state.activeTurnStatus = selectedActiveTurn.status;
      state.selectedTurnId = selectedActiveTurn.turnId;
    } else {
      // Keep composer in send mode when another thread is active.
      state.isThinking = false;
      state.activeTurnStatus = null;
    }

    dom.thinkingIndicator.hidden = false;
    setThinkingIndicatorText(workspaceActiveTurn ? "Codex is thinking in another thread" : "Codex is thinking");
    dom.thinkingPill.dataset.tone = "warn";
    setPillText(
      dom.thinkingPill,
      visibleThinkingTurn.status === "waiting_approval" ? "Waiting approval" : "Thinking",
      visibleThinkingTurn.status === "waiting_approval" ? "WAIT" : "THINK",
    );
  } else if (hasGrace) {
    // Briefly keep indicator visible so short turns are not visually missed.
    state.isThinking = false;
    state.activeTurnStatus = null;
    dom.thinkingIndicator.hidden = false;
    setThinkingIndicatorText("Codex is thinking");
    dom.thinkingPill.dataset.tone = "warn";
    setPillText(dom.thinkingPill, "Thinking", "THINK");
  } else {
    state.isThinking = false;
    state.activeTurnStatus = null;

    dom.thinkingIndicator.hidden = true;
    setThinkingIndicatorText("Codex is thinking");
    dom.thinkingPill.dataset.tone = "idle";
    setPillText(dom.thinkingPill, "Idle", "IDLE");
  }

  // Stop button only makes sense while the selected thread is running/waiting.
  dom.interruptTurn.hidden = !selectedActiveTurn;
  state.pendingJumpThreadId = jumpThreadId;
  dom.thinkingJumpThread.hidden = !jumpThreadId;

  if (jumpThreadId) {
    dom.thinkingJumpThread.textContent = `Open ${threadIdShort(jumpThreadId)}`;
    dom.thinkingJumpThread.setAttribute("aria-label", `Open active thread ${threadIdShort(jumpThreadId)}`);
  }

  const debugKey = [
    selectedActiveTurn ? "selected" : "none",
    workspaceActiveTurn ? "workspace" : "none",
    hasGrace ? "grace" : "nograce",
    dom.thinkingIndicator.hidden ? "hidden" : "visible",
    selectedActiveTurn?.turnId || "-",
    workspaceActiveTurn?.turnId || "-",
    state.selectedThreadId || "-",
    state.selectedBridgeId || "-",
  ].join("|");

  if (debugKey !== state.lastThinkingDebugKey) {
    state.lastThinkingDebugKey = debugKey;
    debugThinkingLog("updateThinkingState", {
      selectedActiveTurn,
      workspaceActiveTurn,
      hasGrace,
      indicatorHidden: dom.thinkingIndicator.hidden,
      pill: dom.thinkingPill.textContent,
      selectedThreadId: state.selectedThreadId,
      selectedBridgeId: state.selectedBridgeId,
      jumpThreadId,
    });
  }
}

/**
 * Marks short-lived turns as recent activity so the thinking indicator can remain
 * visible briefly even when a turn started+completed between polling ticks.
 */
function captureRecentThreadActivity(detail) {
  const updatedAt = asString(detail?.thread?.updatedAt);
  if (!updatedAt) {
    return;
  }

  if (state.lastSelectedThreadUpdatedAt === updatedAt) {
    return;
  }

  state.lastSelectedThreadUpdatedAt = updatedAt;

  const activeTurn = findActiveTurn(detail) || findActiveTurnFromSelectedThreadSummary();
  if (activeTurn) {
    state.lastThinkingSeenAt = Date.now();
    debugThinkingLog("captureRecentThreadActivity:active", {
      threadId: asString(detail?.thread?.threadId),
      turnId: activeTurn.turnId,
      status: activeTurn.status,
    });
    return;
  }

  const turns = Array.isArray(detail?.turns) ? detail.turns : [];
  if (turns.length === 0) {
    return;
  }

  const latest = turns[0];
  const latestStatus = asString(latest?.status);
  if (latestStatus !== "completed" && latestStatus !== "interrupted" && latestStatus !== "failed") {
    return;
  }

  const completedAt = asString(latest?.completedAt);
  const completedAtAgeMs = completedAt ? Date.now() - safeTs(completedAt) : 0;
  if (!completedAt || completedAtAgeMs <= RECENT_COMPLETION_WINDOW_MS) {
    state.lastThinkingSeenAt = Date.now();
    debugThinkingLog("captureRecentThreadActivity:recent-completion", {
      threadId: asString(detail?.thread?.threadId),
      turnId: asString(latest?.turnId),
      status: latestStatus,
      completedAt,
      completedAtAgeMs,
    });
  }
}

function updateConnectionPill(tone, text) {
  dom.connectionPill.dataset.tone = tone;
  const shortText =
    tone === "ok" ? "ON" : tone === "danger" ? "ERR" : tone === "warn" ? "RETRY" : "IDLE";
  setPillText(dom.connectionPill, text, shortText);
}

function updateStreamPill(tone, text) {
  dom.streamPill.dataset.tone = tone;
  const shortText =
    tone === "ok" ? "LIVE" : tone === "danger" ? "ERR" : tone === "warn" ? "RETRY" : "IDLE";
  setPillText(dom.streamPill, text, shortText);
  updateConnectionBanner();
}

function initializeConnectivityState() {
  state.isOffline = typeof navigator !== "undefined" ? navigator.onLine === false : false;
  if (state.isOffline) {
    state.isHubReachable = false;
    state.lastHubErrorMessage = "offline";
  }
}

function markHubReachable(isReachable, reason = null) {
  state.isHubReachable = isReachable;
  state.lastHubErrorMessage = isReachable ? null : summarizeConnectivityReason(reason);
  updateConnectionBanner();
}

function summarizeConnectivityReason(reason) {
  const normalized = String(reason || "").toLowerCase();

  if (!normalized) {
    return null;
  }

  if (normalized.includes("timeout")) {
    return "timeout";
  }

  if (normalized.includes("offline")) {
    return "offline";
  }

  if (normalized.includes("failed to fetch") || normalized.includes("fetch failed")) {
    return "network";
  }

  return "connection";
}

function updateConnectionBanner() {
  if (!dom.connectionBanner || !dom.connectionBannerText || !dom.connectionBannerRetry) {
    return;
  }

  let tone = "idle";
  let text = "";
  let show = false;
  let allowRetry = false;

  if (state.isOffline) {
    tone = "warn";
    text = "Offline. Waiting for network...";
    show = true;
  } else if (!state.isHubReachable) {
    tone = "warn";
    show = true;
    allowRetry = true;

    if (state.lastHubErrorMessage === "timeout") {
      text = "Hub is not responding (timeout). Retrying...";
    } else if (state.lastHubErrorMessage === "network") {
      text = "Cannot reach hub. Check local network and hub process.";
    } else {
      text = "Connection to hub lost. Retrying...";
    }
  } else if (state.wsReconnectTimer && state.selectedTurnId) {
    tone = "info";
    text = `Stream reconnecting (attempt ${state.wsReconnectAttempt || 1}). Polling remains active.`;
    show = true;
  }

  if (!show) {
    dom.connectionBanner.hidden = true;
    return;
  }

  dom.connectionBanner.dataset.tone = tone;
  dom.connectionBannerText.textContent = text;
  dom.connectionBannerRetry.hidden = !allowRetry;
  dom.connectionBanner.hidden = false;
}

async function refreshHubSecurityStatus() {
  try {
    const payload = await apiRequest("/api/v1/runtime/security", { method: "GET" });
    state.hubSecurity = payload && typeof payload === "object" ? payload : null;
    renderSecurityStatus();
  } catch {
    state.hubSecurity = null;
    renderSecurityStatus();
  }
}

function renderSecurityStatus() {
  if (!dom.securityStatus) {
    return;
  }

  const posture = asObject(state.hubSecurity);
  if (!posture || Object.keys(posture).length === 0) {
    dom.securityStatus.dataset.tone = "info";
    dom.securityStatus.textContent = "Security posture: unavailable.";
    return;
  }

  const tone = asString(posture.posture) || "info";
  const warnings = Array.isArray(posture.warnings) ? posture.warnings.map((item) => String(item)) : [];
  const bindHost = asString(posture.bindHost) || "unknown";
  const authEnabled = Boolean(posture.authEnabled);

  if (tone === "danger") {
    dom.securityStatus.dataset.tone = "error";
    dom.securityStatus.textContent = warnings[0] || "Security posture: risky configuration detected.";
    return;
  }

  if (tone === "warn") {
    dom.securityStatus.dataset.tone = "warn";
    dom.securityStatus.textContent = warnings[0] || "Security posture: caution recommended.";
    return;
  }

  dom.securityStatus.dataset.tone = "ok";
  dom.securityStatus.textContent = `Security posture: ${bindHost} (${authEnabled ? "token enabled" : "localhost-only mode"}).`;
}

async function retryConnectivityNow() {
  if (state.isOffline) {
    setStatus("Still offline.");
    updateConnectionBanner();
    return;
  }

  setStatus("Reconnecting to hub...");
  await loadBridges();

  if (state.selectedBridgeId && state.selectedThreadId) {
    await refreshThreadDetail();
    await refreshThreadsForSelectedBridge();
  }
}

function updateViewportMetrics() {
  const docEl = document.documentElement;
  if (!docEl) {
    return;
  }

  const viewport = window.visualViewport;
  const layoutHeight = Math.max(window.innerHeight || 0, docEl.clientHeight || 0);
  const viewportHeight = viewport ? Math.round(viewport.height + viewport.offsetTop) : layoutHeight;
  const visibleHeight = Math.max(300, Math.min(layoutHeight, viewportHeight || layoutHeight));
  const inputFocused = document.activeElement === dom.prompt;

  if (!state.viewportBaseHeight) {
    state.viewportBaseHeight = visibleHeight;
  } else if (!inputFocused && Math.abs(visibleHeight - state.viewportBaseHeight) > 80) {
    // Orientation/UI chrome changes should reset baseline when keyboard is not active.
    state.viewportBaseHeight = visibleHeight;
  } else if (visibleHeight > state.viewportBaseHeight) {
    state.viewportBaseHeight = visibleHeight;
  }

  const keyboardInsetPx = Math.max(0, state.viewportBaseHeight - visibleHeight);
  const keyboardOpen = inputFocused && keyboardInsetPx >= KEYBOARD_OPEN_THRESHOLD_PX;

  state.keyboardInsetPx = keyboardInsetPx;
  state.isKeyboardOpen = keyboardOpen;

  docEl.style.setProperty("--app-height", `${visibleHeight}px`);
  docEl.style.setProperty("--keyboard-inset", `${keyboardOpen ? keyboardInsetPx : 0}px`);
  document.body.classList.toggle("keyboard-open", keyboardOpen);
}

/**
 * Sets status line message and tone.
 */
function setStatus(message, isError = false) {
  dom.status.textContent = message;
  dom.status.dataset.tone = isError ? "error" : "info";
}

/**
 * Updates main action button mode: send vs steer.
 */
function updatePrimaryAction() {
  const hasThread = Boolean(state.selectedBridgeId && state.selectedThreadId);
  const hasText = dom.prompt.value.trim().length > 0;

  if (state.isThinking) {
    dom.primaryAction.dataset.mode = "steer";
    dom.primaryAction.textContent = "Steer";
    dom.primaryAction.setAttribute("aria-label", "Send steer instruction");
    dom.prompt.placeholder = "Agent is running. Type a steer instruction.";
  } else {
    dom.primaryAction.dataset.mode = "send";
    dom.primaryAction.innerHTML = '<span class="send-icon" aria-hidden="true"></span>';
    dom.primaryAction.setAttribute("aria-label", "Send message");
    dom.prompt.placeholder = "Type a message...";
  }

  dom.primaryAction.disabled = !hasThread || !hasText;
}

/**
 * Primary action dispatch.
 */
async function handlePrimaryAction() {
  if (!state.selectedBridgeId || !state.selectedThreadId) {
    setStatus("Select workspace and thread first.", true);
    return;
  }

  if (state.isThinking) {
    await sendSteerFromComposer();
  } else {
    await sendMessage();
  }
}

/**
 * Opens the currently active thread when activity is running in another thread.
 */
async function jumpToWorkspaceActiveThread() {
  const targetThreadId = state.pendingJumpThreadId;
  if (!targetThreadId) {
    return;
  }

  setStatus(`Opening active thread ${threadIdShort(targetThreadId)}...`);
  await openThread(targetThreadId, { showStatus: true });
}

/**
 * Starts a new turn in the currently selected thread.
 */
async function sendMessage() {
  const requestedThreadId = state.selectedThreadId;
  const requestStartsNewConversation = isDraftThreadId(requestedThreadId);
  const text = dom.prompt.value.trim();
  if (!text) {
    setStatus("Message is required.", true);
    return;
  }

  const modelId = dom.modelId.value.trim() || null;
  const accessMode = dom.accessMode.value;

  if (requestStartsNewConversation) {
    setStatus("Starting new conversation...");
  } else {
    setStatus(`Starting turn in ${threadIdShort(state.selectedThreadId)}...`);
  }

  try {
    const payload = await apiRequest(
      `/api/v1/bridges/${encodeURIComponent(state.selectedBridgeId)}/threads/${encodeURIComponent(requestedThreadId)}/message`,
      {
        method: "POST",
        body: JSON.stringify({
          text,
          modelId,
          accessMode,
        }),
      },
    );

    dom.prompt.value = "";
    const resolvedThreadId = asString(payload?.threadId) || requestedThreadId;
    if (requestStartsNewConversation && resolvedThreadId && !isDraftThreadId(resolvedThreadId)) {
      state.draftThreadByBridge.delete(state.selectedBridgeId);
      state.selectedThreadId = resolvedThreadId;
      persistState();
    }

    if (payload?.turnId) {
      state.selectedTurnId = payload.turnId;
      state.liveAssistantByTurn.set(payload.turnId, "");

      // Optimistically move to thinking mode before next detail refresh.
      state.isThinking = true;
      updatePrimaryAction();
      updateThinkingState({
        turns: [
          {
            turnId: payload.turnId,
            status: "running",
          },
        ],
      });

      // Keep thinking state visible even if the first detail snapshot lags.
      rememberObservedActiveTurn(
        resolvedThreadId,
        payload.turnId,
        "running",
      );

      openTurnStream(payload.turnId);
      ensurePolling();
    }

    await refreshThreadsForSelectedBridge();
    if (requestStartsNewConversation && resolvedThreadId && !isDraftThreadId(resolvedThreadId)) {
      await openThread(resolvedThreadId, { showStatus: false });
    } else {
      await refreshThreadDetail();
    }

    if (requestStartsNewConversation && resolvedThreadId && !isDraftThreadId(resolvedThreadId)) {
      setStatus(`Turn started (${threadIdShort(payload?.turnId)}) in new conversation.`);
    } else if (resolvedThreadId && resolvedThreadId !== requestedThreadId) {
      setStatus(
        `Turn started (${threadIdShort(payload?.turnId)}). Kept selected thread ${threadIdShort(requestedThreadId)}.`,
      );
    } else {
      setStatus(`Turn started (${threadIdShort(payload?.turnId)}).`);
    }
  } catch (error) {
    const errorText = String(error);
    if (requestStartsNewConversation && /busy|in progress|already running/i.test(errorText)) {
      setStatus("Cannot start a new conversation while another turn is running. Open active thread or stop it first.", true);
    } else {
      setStatus(`Send failed: ${errorText}`, true);
    }
  } finally {
    updatePrimaryAction();
  }
}

/**
 * Sends a steer instruction using the main composer text area.
 */
async function sendSteerFromComposer() {
  if (!state.selectedBridgeId || !state.selectedTurnId) {
    setStatus("No active turn to steer.", true);
    return;
  }

  const text = dom.prompt.value.trim();
  if (!text) {
    setStatus("Steer instruction cannot be empty.", true);
    return;
  }

  try {
    await apiRequest(
      `/api/v1/bridges/${encodeURIComponent(state.selectedBridgeId)}/turns/${encodeURIComponent(state.selectedTurnId)}/steer`,
      {
        method: "POST",
        body: JSON.stringify({ text }),
      },
    );

    dom.prompt.value = "";
    setStatus(`Steer sent to ${threadIdShort(state.selectedTurnId)}.`);

    await refreshThreadDetail();
  } catch (error) {
    setStatus(`Steer failed: ${String(error)}`, true);
  } finally {
    updatePrimaryAction();
  }
}

/**
 * Interrupts the active turn.
 */
async function interruptCurrentTurn() {
  if (!state.selectedBridgeId || !state.selectedTurnId) {
    setStatus("No active turn to stop.", true);
    return;
  }

  try {
    await apiRequest(
      `/api/v1/bridges/${encodeURIComponent(state.selectedBridgeId)}/turns/${encodeURIComponent(state.selectedTurnId)}/interrupt`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
    );

    setStatus(`Turn ${threadIdShort(state.selectedTurnId)} interrupted.`);
    await refreshThreadDetail();
    await refreshThreadsForSelectedBridge();
  } catch (error) {
    setStatus(`Stop failed: ${String(error)}`, true);
  }
}

/**
 * Approval decision pass-through.
 */
async function decideApproval(approvalId, decision) {
  if (!state.selectedBridgeId) {
    return;
  }

  try {
    await apiRequest(
      `/api/v1/bridges/${encodeURIComponent(state.selectedBridgeId)}/approvals/${encodeURIComponent(approvalId)}/decision`,
      {
        method: "POST",
        body: JSON.stringify({ decision }),
      },
    );

    setStatus(`Approval ${approvalId} -> ${decision}.`);
    await refreshThreadDetail();
  } catch (error) {
    setStatus(`Approval failed: ${String(error)}`, true);
  }
}

/**
 * Opens WS stream for one turn.
 */
function openTurnStream(turnId, options = {}) {
  closeTurnStream();
  clearStreamReconnectState(false);
  state.suppressStreamReconnectUntil = 0;

  if (!state.selectedBridgeId) {
    return;
  }

  const originUrl = new URL(state.hubOrigin);
  const protocol = originUrl.protocol === "https:" ? "wss://" : "ws://";
  const host = originUrl.host;
  const tokenQuery = state.token ? `?token=${encodeURIComponent(state.token)}` : "";

  const url = `${protocol}${host}/ws/v1/bridges/${encodeURIComponent(state.selectedBridgeId)}/turns/${encodeURIComponent(turnId)}${tokenQuery}`;

  const socket = new WebSocket(url);
  state.ws = socket;
  updateStreamPill("warn", "Connecting stream...");

  socket.onopen = () => {
    markHubReachable(true);
    clearStreamReconnectState(true);
    appendEventLog(`[stream] connected turn=${turnId}`);
    updateStreamPill("ok", "Stream live");

    if (options.reconnectAttempt && Number.isFinite(options.reconnectAttempt)) {
      setStatus(`Stream reconnected (${threadIdShort(turnId)}, attempt ${options.reconnectAttempt}).`);
    } else {
      setStatus(`Streaming ${threadIdShort(turnId)}...`);
    }
  };

  socket.onmessage = (event) => {
    handleTurnEvent(event.data);
  };

  socket.onerror = () => {
    updateStreamPill("warn", "Stream error");
    appendEventLog("[stream] websocket error; fallback to polling");
  };

  socket.onclose = () => {
    if (state.ws && state.ws !== socket) {
      // This socket was replaced by a newer connection.
      return;
    }

    if (state.ws === socket) {
      state.ws = null;
    }

    appendEventLog("[stream] closed");
    ensurePolling();

    if (Date.now() < state.suppressStreamReconnectUntil) {
      updateStreamPill("idle", "Stream idle");
      return;
    }

    if (shouldMaintainStreamForTurn(turnId)) {
      scheduleTurnStreamReconnect(turnId, "closed");
      return;
    }

    clearStreamReconnectState(true);
    updateStreamPill("idle", "Stream idle");
  };
}

function closeTurnStream(options = {}) {
  const resetReconnect = options.resetReconnect === true;

  if (!state.ws) {
    if (resetReconnect) {
      clearStreamReconnectState(true);
      state.suppressStreamReconnectUntil = Date.now() + 1_500;
    }
    return;
  }

  if (resetReconnect) {
    state.suppressStreamReconnectUntil = Date.now() + 1_500;
  }

  state.ws.close();
  state.ws = null;

  if (resetReconnect) {
    clearStreamReconnectState(true);
  }
}

function closeStreamAndPolling() {
  closeTurnStream({ resetReconnect: true });
  stopPolling();

  if (state.refreshTimer) {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = null;
  }

  updateStreamPill("idle", "Stream idle");
}

function ensurePolling() {
  if (!state.selectedBridgeId || !state.selectedThreadId) {
    return;
  }
  if (isDraftThreadId(state.selectedThreadId)) {
    return;
  }

  if (state.pollTimer) {
    return;
  }

  state.pollTimer = setInterval(() => {
    if (!state.selectedBridgeId || !state.selectedThreadId) {
      return;
    }

    void refreshThreadDetail();
    void refreshThreadsForSelectedBridge();
  }, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (!state.pollTimer) {
    return;
  }

  clearInterval(state.pollTimer);
  state.pollTimer = null;
}

function clearStreamReconnectState(resetAttempt) {
  if (state.wsReconnectTimer) {
    clearTimeout(state.wsReconnectTimer);
    state.wsReconnectTimer = null;
  }

  if (resetAttempt) {
    state.wsReconnectAttempt = 0;
  }

  updateConnectionBanner();
}

function computeStreamReconnectDelayMs(attempt) {
  const normalizedAttempt = Math.max(1, attempt);
  const exponential = Math.min(WS_RECONNECT_MAX_MS, WS_RECONNECT_BASE_MS * 2 ** (normalizedAttempt - 1));
  const jitterRatio = 1 + (Math.random() * 2 - 1) * WS_RECONNECT_JITTER_RATIO;
  return Math.max(WS_RECONNECT_BASE_MS, Math.round(exponential * jitterRatio));
}

function scheduleTurnStreamReconnect(turnId, reason) {
  if (!shouldMaintainStreamForTurn(turnId) || state.wsReconnectTimer) {
    return;
  }

  state.wsReconnectAttempt += 1;
  const attempt = state.wsReconnectAttempt;
  const delayMs = computeStreamReconnectDelayMs(attempt);
  const delaySeconds = (delayMs / 1000).toFixed(1);

  updateStreamPill("warn", `Reconnecting (${attempt})`);
  setStatus(`Stream ${reason}. Reconnecting in ${delaySeconds}s...`);
  appendEventLog(`[stream] reconnect scheduled turn=${turnId} attempt=${attempt} delayMs=${delayMs}`);

  state.wsReconnectTimer = setTimeout(() => {
    state.wsReconnectTimer = null;

    if (!shouldMaintainStreamForTurn(turnId)) {
      clearStreamReconnectState(true);
      updateStreamPill("idle", "Stream idle");
      return;
    }

    openTurnStream(turnId, { reconnectAttempt: attempt });
  }, delayMs);
}

function shouldMaintainStreamForTurn(turnId) {
  if (!turnId || !state.selectedBridgeId || !state.selectedThreadId) {
    return false;
  }

  if (state.selectedTurnId !== turnId) {
    return false;
  }

  const activeTurn = findActiveTurn(state.threadDetail) || findActiveTurnFromSelectedThreadSummary();
  if (activeTurn && activeTurn.turnId === turnId) {
    return true;
  }

  const threadId = asString(state.threadDetail?.thread?.threadId) || state.selectedThreadId;
  const observed = threadId ? state.observedActiveTurnByThread.get(threadId) : null;
  if (observed && observed.turnId === turnId) {
    return Date.now() - observed.lastSeenAt <= OBSERVED_ACTIVE_TURN_TTL_MS;
  }

  return false;
}

/**
 * Handles incoming bridge WS event stream.
 */
function handleTurnEvent(rawData) {
  let event = null;
  try {
    event = JSON.parse(rawData);
  } catch {
    appendEventLog(`[stream] non-JSON payload: ${String(rawData)}`);
    return;
  }

  appendEventLog(`${event.method} ${JSON.stringify(event.params || {})}`);
  trackObservedActiveTurn(event);
  const isSelectedThreadEvent = isEventForSelectedThread(event);
  const activityChanged = recordTurnActivityEvent(event);
  let timelineChanged = false;
  let approvalsChanged = false;
  let thinkingChanged = false;
  let liveOnlyTurnId = null;

  if (event.method === "hub/state") {
    const hubState = applyHubStateEvent(event);
    timelineChanged = timelineChanged || hubState.requiresFullRender;
    approvalsChanged = approvalsChanged || hubState.approvalsChanged;
    thinkingChanged = thinkingChanged || hubState.thinkingChanged;
    if (hubState.assistantTextChanged && !hubState.requiresFullRender) {
      liveOnlyTurnId = hubState.turnId;
    }
  }

  if (event.method === "item/agentMessage/delta") {
    const turnId = event?.context?.turnId;
    const delta = typeof event?.params?.delta === "string" ? event.params.delta : "";

    if (turnId && delta) {
      const previous = state.liveAssistantByTurn.get(turnId) || "";
      state.liveAssistantByTurn.set(turnId, `${previous}${delta}`);
      liveOnlyTurnId = turnId;
    }
  }

  if (event.method === "turn/completed") {
    timelineChanged = applyTurnCompletedEvent(event) || timelineChanged;
    thinkingChanged = true;
    approvalsChanged = true;

    const completedTurnId = event?.context?.turnId;
    if (completedTurnId) {
      state.liveAssistantByTurn.delete(completedTurnId);
    }

    void refreshThreadsForSelectedBridge();
  }

  if (event.method === "turn/started") {
    timelineChanged = applyTurnStartedEvent(event) || timelineChanged;
    thinkingChanged = true;
  }

  if (isSelectedThreadEvent) {
    if (timelineChanged) {
      renderMessages(state.threadDetail);
    } else if (liveOnlyTurnId) {
      renderLiveAssistantDelta(liveOnlyTurnId);
    } else if (activityChanged) {
      renderActivityCardInPlace(state.threadDetail);
    }

    if ((timelineChanged || approvalsChanged) && state.threadDetail) {
      renderApprovals(state.threadDetail);
    }

    if ((timelineChanged || thinkingChanged) && state.threadDetail) {
      updateThinkingState(state.threadDetail);
    }

    if (timelineChanged || thinkingChanged) {
      updatePrimaryAction();
    }
  }

  scheduleThreadRefresh();
}

function isEventForSelectedThread(event) {
  const eventTurnId = asString(event?.context?.turnId);
  if (eventTurnId && state.selectedTurnId && eventTurnId === state.selectedTurnId) {
    return true;
  }

  const selectedThreadId = state.threadDetail?.thread?.threadId || state.selectedThreadId;
  const eventThreadId = asString(event?.context?.threadId);

  if (!selectedThreadId || !eventThreadId) {
    return false;
  }

  return selectedThreadId === eventThreadId;
}

function applyHubStateEvent(event) {
  const result = {
    turnId: null,
    assistantTextChanged: false,
    requiresFullRender: false,
    thinkingChanged: false,
    approvalsChanged: false,
  };

  const snapshot = asObject(event?.params?.turn);
  const snapshotTurnId = asString(snapshot.turnId) || asString(event?.context?.turnId);
  if (!snapshotTurnId) {
    return result;
  }
  result.turnId = snapshotTurnId;

  const snapshotStatus = asString(snapshot.status);
  const snapshotAssistantText = asString(snapshot.assistantText);

  if (snapshotAssistantText !== null && (snapshotStatus === "running" || snapshotStatus === "waiting_approval")) {
    const previousAssistant = state.liveAssistantByTurn.get(snapshotTurnId);
    if (previousAssistant !== snapshotAssistantText) {
      state.liveAssistantByTurn.set(snapshotTurnId, snapshotAssistantText);
      result.assistantTextChanged = true;
    }
  } else if (snapshotStatus && snapshotStatus !== "running" && snapshotStatus !== "waiting_approval") {
    if (state.liveAssistantByTurn.has(snapshotTurnId)) {
      state.liveAssistantByTurn.delete(snapshotTurnId);
      result.assistantTextChanged = true;
    }
  }

  if (!state.threadDetail || !Array.isArray(state.threadDetail.turns)) {
    return result;
  }

  const targetTurn = state.threadDetail.turns.find((turn) => turn.turnId === snapshotTurnId);
  if (!targetTurn) {
    return result;
  }

  if (state.threadDetail.thread?.threadId === targetTurn.threadId && snapshotStatus) {
    const normalizedStatus = normalizeTurnStatus(snapshotStatus);
    const previousThreadStatus = state.threadDetail.thread.status;
    const previousActiveTurnId = state.threadDetail.thread.activeTurnId;

    if (isRunningTurnStatus(normalizedStatus)) {
      state.threadDetail.thread.activeTurnId = snapshotTurnId;
    } else if (previousActiveTurnId === snapshotTurnId) {
      state.threadDetail.thread.activeTurnId = null;
    }
    state.threadDetail.thread.status = normalizedStatus;

    if (
      previousThreadStatus !== state.threadDetail.thread.status ||
      previousActiveTurnId !== state.threadDetail.thread.activeTurnId
    ) {
      result.thinkingChanged = true;
    }
  }

  if (snapshotStatus) {
    const normalizedStatus = normalizeTurnStatus(snapshotStatus);
    if (targetTurn.status !== normalizedStatus) {
      targetTurn.status = normalizedStatus;
      result.thinkingChanged = true;
      if (!isRunningTurnStatus(normalizedStatus)) {
        result.requiresFullRender = true;
      }
    }
  }

  if (snapshotAssistantText !== null) {
    if (targetTurn.assistantText !== snapshotAssistantText) {
      targetTurn.assistantText = snapshotAssistantText;
    }
  }

  if (Array.isArray(snapshot.plan)) {
    const nextPlan = snapshot.plan
      .map((item) => normalizePlanItem(item))
      .filter((item) => item !== null);
    if (!isDeepEqualJson(targetTurn.plan, nextPlan)) {
      targetTurn.plan = nextPlan;
      result.requiresFullRender = true;
    }
  }

  const diffText = asString(snapshot.diff);
  if (diffText !== null) {
    if (targetTurn.diff !== diffText) {
      targetTurn.diff = diffText;
      result.requiresFullRender = true;
    }
  }

  if (Array.isArray(snapshot.approvals)) {
    const nextApprovals = snapshot.approvals
      .map((item) => normalizeApprovalItem(item))
      .filter((item) => item !== null);
    if (!isDeepEqualJson(targetTurn.approvals, nextApprovals)) {
      targetTurn.approvals = nextApprovals;
      result.requiresFullRender = true;
      result.approvalsChanged = true;
      result.thinkingChanged = true;
    }
  }

  return result;
}

function applyTurnStartedEvent(event) {
  const turnId = asString(event?.context?.turnId);
  if (!turnId || !state.threadDetail?.thread) {
    return false;
  }

  if (state.threadDetail.thread.activeTurnId !== turnId) {
    state.threadDetail.thread.activeTurnId = turnId;
    state.threadDetail.thread.status = "running";
  }

  rememberObservedActiveTurn(state.threadDetail.thread.threadId, turnId, "running");

  let changed = true;
  if (Array.isArray(state.threadDetail.turns)) {
    const existing = state.threadDetail.turns.find((turn) => turn.turnId === turnId);
    if (existing) {
      existing.status = "running";
      existing.completedAt = null;
    } else {
      state.threadDetail.turns.unshift({
        turnId,
        threadId: state.threadDetail.thread.threadId,
        status: "running",
        accessMode: state.accessMode === "plan-only" ? "plan-only" : "full-access",
        modelId: dom.modelId.value.trim() || null,
        userText: "",
        assistantText: "",
        startedAt: asString(event?.ts) || new Date().toISOString(),
        completedAt: null,
        plan: [],
        diff: "",
        approvals: [],
        steerHistory: [],
      });
    }
  } else {
    changed = false;
  }

  if (!state.selectedTurnId) {
    state.selectedTurnId = turnId;
  }

  return changed;
}

function applyTurnCompletedEvent(event) {
  const turnId = asString(event?.context?.turnId);
  if (!turnId || !state.threadDetail?.thread) {
    return false;
  }

  const turnPayload = asObject(event?.params?.turn);
  const rawStatus = asString(turnPayload.status);
  const status = normalizeTurnStatus(rawStatus || "completed");

  let changed = false;

  if (state.threadDetail.thread.activeTurnId === turnId) {
    state.threadDetail.thread.activeTurnId = null;
    state.threadDetail.thread.status = status;
    changed = true;
  }

  forgetObservedActiveTurn(state.threadDetail.thread.threadId, turnId);

  if (Array.isArray(state.threadDetail.turns)) {
    const existing = state.threadDetail.turns.find((turn) => turn.turnId === turnId);
    if (existing) {
      existing.status = status;
      existing.completedAt = asString(turnPayload.completedAt) || asString(event?.ts) || new Date().toISOString();
      changed = true;
    }
  }

  if (state.selectedTurnId === turnId) {
    state.selectedTurnId = null;
    changed = true;
  }

  state.liveAssistantByTurn.delete(turnId);
  return changed;
}

function recordTurnActivityEvent(event) {
  const turnId = asString(event?.context?.turnId);
  const threadId = asString(event?.context?.threadId);
  if (!turnId || !threadId) {
    return false;
  }

  const entry = buildActivityEventEntry(event);
  if (!entry) {
    return false;
  }

  const existing = state.activityEventsByTurn.get(turnId) || [];
  const previous = existing[existing.length - 1];

  // Prevent accidental duplicates when stream reconnects quickly.
  if (
    previous &&
    previous.method === entry.method &&
    previous.label === entry.label &&
    previous.detail === entry.detail &&
    previous.ts === entry.ts
  ) {
    return false;
  }

  existing.push(entry);
  if (existing.length > MAX_ACTIVITY_EVENTS_PER_TURN) {
    existing.splice(0, existing.length - MAX_ACTIVITY_EVENTS_PER_TURN);
  }

  state.activityEventsByTurn.set(turnId, existing);
  return isEventForSelectedThread(event);
}

function buildActivityEventEntry(event) {
  const method = asString(event?.method);
  const params = asObject(event?.params);
  if (!method) {
    return null;
  }

  if (method === "hub/hello" || method === "item/agentMessage/delta") {
    return null;
  }

  const ts = asString(event?.ts) || new Date().toISOString();
  const base = {
    ts,
    method,
    tone: "info",
    label: method,
    detail: null,
  };

  if (method === "hub/state") {
    const turn = asObject(params.turn);
    const status = asString(turn.status) || "running";
    return {
      ...base,
      label: `Stream synchronized (${status})`,
    };
  }

  if (method === "turn/started") {
    return {
      ...base,
      label: "Turn started",
    };
  }

  if (method === "turn/completed") {
    const turn = asObject(params.turn);
    const status = asString(turn.status) || "completed";
    return {
      ...base,
      tone: status === "failed" ? "warn" : "ok",
      label: `Turn completed (${status})`,
    };
  }

  if (method === "turn/plan/updated") {
    const steps = Array.isArray(params.plan) ? params.plan.length : 0;
    return {
      ...base,
      label: `Plan updated (${steps} steps)`,
    };
  }

  if (method === "turn/diff/updated") {
    const diff = asString(params.diff) || "";
    const lines = diff.length > 0 ? diff.split("\n").length : 0;
    return {
      ...base,
      label: `Diff updated (${lines} lines)`,
    };
  }

  if (method === "item/started") {
    const itemType = asString(params.itemType) || "item";
    return {
      ...base,
      label: `Started ${itemType}`,
    };
  }

  if (method === "item/completed") {
    return summarizeCompletedItemEvent(base, params);
  }

  if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
    const approvalId = asString(params.approvalId) || "n/a";
    const autoApproved = Boolean(params.autoApproved);
    return {
      ...base,
      tone: autoApproved ? "ok" : "warn",
      label: autoApproved ? "Approval auto-accepted for session" : "Approval requested",
      detail: `approvalId: ${approvalId}`,
    };
  }

  if (method === "item/tool/requestUserInput") {
    return {
      ...base,
      tone: "warn",
      label: "Tool requested user input",
      detail: truncateDetail(compactJson(params), MAX_ACTIVITY_DETAILS_CHARS),
    };
  }

  if (method === "item/tool/call") {
    const toolName = asString(params.toolName) || asString(asObject(params.tool).name) || "tool";
    return {
      ...base,
      label: `Tool call: ${toolName}`,
      detail: truncateDetail(compactJson(params), MAX_ACTIVITY_DETAILS_CHARS),
    };
  }

  return {
    ...base,
    label: method,
    detail: truncateDetail(compactJson(params), MAX_ACTIVITY_DETAILS_CHARS),
  };
}

function summarizeCompletedItemEvent(base, params) {
  const item = asObject(params.item);
  const itemTypeRaw = asString(item.type) || "item";
  const itemType = itemTypeRaw.toLowerCase();

  if (itemType === "agentmessage" || itemType === "agent_message") {
    return {
      ...base,
      tone: "ok",
      label: "Assistant message completed",
    };
  }

  if (itemType === "commandexecution" || itemType === "command_execution") {
    const command =
      asString(item.command) || asString(item.commandLine) || asString(asObject(item.command).raw) || asString(item.description);
    const exitCode = asNumber(item.exitCode) ?? asNumber(parseNumberString(asString(item.exitCode)));
    const stdout = asString(item.stdout);
    const stderr = asString(item.stderr);

    const detailParts = [];
    if (command) {
      detailParts.push(`$ ${command}`);
    }
    if (exitCode !== null) {
      detailParts.push(`exit code: ${exitCode}`);
    }
    if (stdout) {
      detailParts.push(`stdout:\n${stdout}`);
    }
    if (stderr) {
      detailParts.push(`stderr:\n${stderr}`);
    }

    return {
      ...base,
      tone: exitCode !== null && exitCode !== 0 ? "warn" : "ok",
      label: command ? "Command completed" : "Command execution completed",
      detail: truncateDetail(detailParts.join("\n"), MAX_ACTIVITY_DETAILS_CHARS),
    };
  }

  if (itemType === "filechange" || itemType === "file_change") {
    const files = Array.isArray(item.files) ? item.files.length : null;
    const label = files !== null ? `File change completed (${files} files)` : "File change completed";
    return {
      ...base,
      tone: "ok",
      label,
      detail: truncateDetail(compactJson(item), MAX_ACTIVITY_DETAILS_CHARS),
    };
  }

  return {
    ...base,
    label: `Completed ${itemTypeRaw}`,
    detail: truncateDetail(compactJson(item), MAX_ACTIVITY_DETAILS_CHARS),
  };
}

function createActivityMessageCard(turnId) {
  const events = state.activityEventsByTurn.get(turnId) || [];
  if (events.length === 0) {
    return null;
  }

  const article = document.createElement("article");
  article.className = "message message--system message--activity";

  const panel = document.createElement("details");
  panel.className = "activity-panel";
  panel.open = state.expandedActivityTurnIds.has(turnId);

  const summary = document.createElement("summary");
  summary.className = "activity-panel__summary";

  const summaryTitle = document.createElement("strong");
  summaryTitle.className = "activity-panel__title";
  summaryTitle.textContent = "activity stream";

  const summaryMeta = document.createElement("span");
  summaryMeta.className = "activity-panel__meta";
  summaryMeta.textContent = `${threadIdShort(turnId)} - ${events.length} event(s)`;

  const summaryHint = document.createElement("span");
  summaryHint.className = "activity-panel__hint";

  const syncSummaryHint = () => {
    summaryHint.textContent = panel.open ? "hide" : "show";
  };
  syncSummaryHint();

  panel.addEventListener("toggle", () => {
    if (panel.open) {
      state.expandedActivityTurnIds.add(turnId);
    } else {
      state.expandedActivityTurnIds.delete(turnId);
    }
    syncSummaryHint();
  });

  summary.appendChild(summaryTitle);
  summary.appendChild(summaryMeta);
  summary.appendChild(summaryHint);
  panel.appendChild(summary);

  const body = document.createElement("div");
  body.className = "activity-feed";

  const recentEvents = events.slice(-40);
  for (const entry of recentEvents) {
    const line = document.createElement("div");
    line.className = `activity-line activity-line--${entry.tone}`;

    const lineHead = document.createElement("div");
    lineHead.className = "activity-line__head";

    const ts = document.createElement("span");
    ts.className = "activity-line__ts";
    ts.textContent = formatTime(entry.ts);

    const text = document.createElement("span");
    text.className = "activity-line__text";
    text.textContent = entry.label;

    lineHead.appendChild(ts);
    lineHead.appendChild(text);
    line.appendChild(lineHead);

    if (entry.detail) {
      const detail = document.createElement("pre");
      detail.className = "activity-line__detail";
      detail.textContent = entry.detail;
      line.appendChild(detail);
    }

    body.appendChild(line);
  }

  panel.appendChild(body);
  article.appendChild(panel);
  return article;
}

function pickActivityTurnId(turns) {
  if (state.selectedTurnId && hasActivityForTurn(state.selectedTurnId)) {
    return state.selectedTurnId;
  }

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const candidateId = asString(turns[index]?.turnId);
    if (candidateId && hasActivityForTurn(candidateId)) {
      return candidateId;
    }
  }

  return null;
}

function hasActivityForTurn(turnId) {
  return (state.activityEventsByTurn.get(turnId)?.length || 0) > 0;
}

function scheduleThreadRefresh() {
  if (state.refreshTimer) {
    return;
  }

  state.refreshTimer = setTimeout(() => {
    state.refreshTimer = null;
    void refreshThreadDetail();
  }, 250);
}

/**
 * Refreshes only the selected workspace thread list.
 */
async function refreshThreadsForSelectedBridge() {
  if (!state.selectedBridgeId) {
    return;
  }

  try {
    const payload = await apiRequest(`/api/v1/bridges/${encodeURIComponent(state.selectedBridgeId)}/threads`, {
      method: "GET",
    });

    const items = Array.isArray(payload?.items) ? payload.items : [];
    state.threadByBridge.set(state.selectedBridgeId, items);

    if (items.length === 0) {
      renderWorkspaceTree();
      updateThinkingState(state.threadDetail);
      updatePrimaryAction();
      return;
    }

    if (state.selectedThreadId && isDraftThreadId(state.selectedThreadId)) {
      renderWorkspaceTree();
      updateThinkingState(state.threadDetail);
      updatePrimaryAction();
      return;
    }

    if (!state.selectedThreadId) {
      const fallback = items.find((item) => item.activeTurnId) || items[0];
      state.selectedThreadId = fallback.threadId;
      persistState();
    } else if (!items.some((item) => item.threadId === state.selectedThreadId)) {
      debugThinkingLog("refreshThreadsForSelectedBridge:keep-selected-thread", {
        selectedBridgeId: state.selectedBridgeId,
        selectedThreadId: state.selectedThreadId,
        itemsCount: items.length,
      });
    }

    renderWorkspaceTree();
    updateThinkingState(state.threadDetail);
    updatePrimaryAction();
  } catch (error) {
    // Background refresh failures are non-fatal for UI flow.
    debugThinkingLog("refreshThreadsForSelectedBridge:error", {
      error: String(error),
      selectedBridgeId: state.selectedBridgeId,
      selectedThreadId: state.selectedThreadId,
    });
  }
}

/**
 * Maintains a bounded text log of stream events.
 */
function appendEventLog(line) {
  const ts = new Date().toISOString();
  const next = `[${ts}] ${line}`;

  const lines = dom.events.textContent.length > 0 ? dom.events.textContent.trim().split("\n") : [];
  lines.push(next);

  const bounded = lines.slice(Math.max(0, lines.length - MAX_EVENT_LINES));
  dom.events.textContent = `${bounded.join("\n")}\n`;
  dom.events.scrollTop = dom.events.scrollHeight;
}

/**
 * Drawer controls.
 */
function openDrawer() {
  state.isDrawerOpen = true;
  dom.drawer.classList.add("is-open");
  dom.drawer.setAttribute("aria-hidden", "false");
  dom.drawerBackdrop.hidden = false;
}

function closeDrawer() {
  state.isDrawerOpen = false;
  dom.drawer.classList.remove("is-open");
  dom.drawer.setAttribute("aria-hidden", "true");
  dom.drawerBackdrop.hidden = true;
}

function toggleDrawer() {
  if (state.isDrawerOpen) {
    closeDrawer();
    return;
  }

  openDrawer();
}

/**
 * Enables browser speech dictation when available.
 */
function setupDictationSupport() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!Recognition) {
    state.dictation.supported = false;
    dom.micToggle.disabled = true;
    dom.dictationHint.textContent = "Voice dictation is unavailable in this browser.";
    return;
  }

  state.dictation.supported = true;

  const recognition = new Recognition();
  recognition.lang = navigator.language || "en-US";
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onstart = () => {
    state.dictation.active = true;
    updateDictationUi();
    dom.dictationHint.textContent = "Listening...";
  };

  recognition.onresult = (event) => {
    let finalText = "";
    let interimText = "";

    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const transcript = String(result[0]?.transcript || "");

      if (result.isFinal) {
        finalText += transcript;
      } else {
        interimText += transcript;
      }
    }

    if (finalText.trim().length > 0) {
      appendTextToPrompt(finalText.trim());
      updatePrimaryAction();
    }

    dom.dictationHint.textContent = interimText.trim().length > 0 ? `Listening: ${interimText.trim()}` : "Listening...";
  };

  recognition.onerror = (event) => {
    dom.dictationHint.textContent = `Voice error: ${event.error}`;
  };

  recognition.onend = () => {
    if (state.dictation.shouldStayActive) {
      // Keep listening unless user explicitly toggled off.
      try {
        recognition.start();
        return;
      } catch {
        // Ignore immediate restart race and fall through.
      }
    }

    state.dictation.active = false;
    updateDictationUi();

    if (dom.dictationHint.textContent === "Listening...") {
      dom.dictationHint.textContent = "";
    }
  };

  state.dictation.recognition = recognition;
  updateDictationUi();
}

function toggleDictation() {
  if (!state.dictation.supported || !state.dictation.recognition) {
    return;
  }

  if (state.dictation.active) {
    stopDictation();
    return;
  }

  state.dictation.shouldStayActive = true;
  try {
    state.dictation.recognition.start();
  } catch {
    // Ignore startup races when browser still finalizing previous session.
  }
}

function stopDictation() {
  if (!state.dictation.supported || !state.dictation.recognition) {
    return;
  }

  state.dictation.shouldStayActive = false;

  try {
    state.dictation.recognition.stop();
  } catch {
    // Stopping an already-stopped recognizer can throw in some browsers.
  }
}

function updateDictationUi() {
  if (!state.dictation.supported) {
    dom.micToggle.setAttribute("aria-label", "Voice dictation unavailable");
    return;
  }

  if (state.dictation.active) {
    dom.micToggle.classList.add("is-active");
    dom.micToggle.setAttribute("aria-label", "Stop voice dictation");
  } else {
    dom.micToggle.classList.remove("is-active");
    dom.micToggle.setAttribute("aria-label", "Start voice dictation");
  }
}

function appendTextToPrompt(text) {
  const current = dom.prompt.value.trim();
  dom.prompt.value = current.length > 0 ? `${current} ${text}` : text;
}

/**
 * Simple markdown renderer with safe HTML escaping and common formatting.
 */
function markdownToHtml(markdown) {
  const input = String(markdown || "").replace(/\r\n/g, "\n");
  const lines = input.split("\n");

  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    const fence = line.match(/^```([^\s]+)?\s*$/);
    if (fence) {
      const lang = fence[1] || "text";
      index += 1;

      const codeLines = [];
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }

      if (index < lines.length) {
        index += 1;
      }

      blocks.push(
        `<pre class="md-code"><code class="language-${escapeAttr(lang)}">${escapeHtml(codeLines.join("\n"))}</code></pre>`,
      );
      continue;
    }

    if (/^#{1,6}\s+/.test(line)) {
      const hashes = line.match(/^#+/)[0].length;
      const level = Math.min(6, hashes);
      const content = line.replace(/^#{1,6}\s+/, "");
      blocks.push(`<h${level}>${renderInlineMarkdown(content)}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s*[-*_]{3,}\s*$/.test(line)) {
      blocks.push("<hr />");
      index += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoteLines = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push(`<blockquote>${quoteLines.map((item) => renderInlineMarkdown(item)).join("<br />")}</blockquote>`);
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*+]\s+/, ""));
        index += 1;
      }

      blocks.push(`<ul>${items.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</ul>`);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+\.\s+/, ""));
        index += 1;
      }

      blocks.push(`<ol>${items.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</ol>`);
      continue;
    }

    const paragraph = [];
    while (index < lines.length && lines[index].trim().length > 0 && !isMarkdownBlockStart(lines[index])) {
      paragraph.push(lines[index]);
      index += 1;
    }

    const paragraphText = paragraph.join(" ").trim();
    blocks.push(`<p>${renderInlineMarkdown(paragraphText)}</p>`);
  }

  return blocks.join("\n");
}

function isMarkdownBlockStart(line) {
  return (
    /^```/.test(line) ||
    /^#{1,6}\s+/.test(line) ||
    /^\s*[-*_]{3,}\s*$/.test(line) ||
    /^\s*>\s?/.test(line) ||
    /^\s*[-*+]\s+/.test(line) ||
    /^\s*\d+\.\s+/.test(line)
  );
}

function renderInlineMarkdown(text) {
  let html = escapeHtml(text);

  // Preserve explicit markdown links before processing additional syntax.
  const linkTokens = [];
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label, url) => {
    const token = `__LINK_TOKEN_${linkTokens.length}__`;
    const safeUrl = escapeAttr(url);
    linkTokens.push(`<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${label}</a>`);
    return token;
  });

  // Inline code spans.
  html = html.replace(/`([^`]+)`/g, (_match, code) => `<code>${code}</code>`);

  // Bold and italic emphasis.
  html = html.replace(/\*\*([^*]+)\*\*/g, (_match, bold) => `<strong>${bold}</strong>`);
  html = html.replace(/\*([^*]+)\*/g, (_match, italic) => `<em>${italic}</em>`);

  // Auto-link raw URLs.
  html = html.replace(/(^|\s)(https?:\/\/[^\s<]+)/g, (_match, prefix, url) => {
    const safeUrl = escapeAttr(url);
    return `${prefix}<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${url}</a>`;
  });

  // Restore explicit links.
  html = html.replace(/__LINK_TOKEN_(\d+)__/g, (_match, indexText) => {
    const tokenIndex = Number(indexText);
    return linkTokens[tokenIndex] || "";
  });

  return html;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/\s/g, "%20");
}

function extractDiffFiles(diffText) {
  const files = new Set();
  const lines = String(diffText || "").split("\n");

  for (const line of lines) {
    const diffGitMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (diffGitMatch) {
      files.add(diffGitMatch[2]);
      continue;
    }

    const plusMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (plusMatch) {
      files.add(plusMatch[1]);
      continue;
    }
  }

  return Array.from(files);
}

function findActiveTurn(detail) {
  const turns = Array.isArray(detail?.turns) ? detail.turns : [];
  const activeTurnId = asString(detail?.thread?.activeTurnId);
  const threadStatus = asString(detail?.thread?.status);
  const threadId = asString(detail?.thread?.threadId) || state.selectedThreadId;

  if (activeTurnId) {
    const active = turns.find((turn) => turn.turnId === activeTurnId);
    if (active && isRunningTurnStatus(active.status)) {
      return active;
    }

    // Thread summary is authoritative for active lifecycle; use it when turn-level
    // snapshots are temporarily stale (for example: activeTurnId set but turn.status completed).
    if (isRunningThreadStatus(threadStatus)) {
      return {
        turnId: activeTurnId,
        status: threadStatus === "waiting_approval" ? "waiting_approval" : "running",
      };
    }
  }

  // Fallback when bridge metadata is temporarily stale: pick a running/waiting turn from detail.
  const runningTurns = turns.filter((turn) => isRunningTurnStatus(turn?.status));
  if (runningTurns.length === 0) {
    if (isRunningThreadStatus(threadStatus) && state.selectedTurnId) {
      return {
        turnId: state.selectedTurnId,
        status: threadStatus === "waiting_approval" ? "waiting_approval" : "running",
      };
    }

    const observed = threadId ? state.observedActiveTurnByThread.get(threadId) : null;
    if (observed) {
      const observedTurn = turns.find((turn) => turn.turnId === observed.turnId);
      if (observedTurn && !isRunningTurnStatus(observedTurn.status)) {
        state.observedActiveTurnByThread.delete(threadId);
      } else if (Date.now() - observed.lastSeenAt <= OBSERVED_ACTIVE_TURN_TTL_MS) {
        return {
          turnId: observed.turnId,
          status: observed.status,
        };
      } else {
        state.observedActiveTurnByThread.delete(threadId);
      }
    }

    return null;
  }

  if (state.selectedTurnId) {
    const selectedRunning = runningTurns.find((turn) => turn.turnId === state.selectedTurnId);
    if (selectedRunning) {
      return selectedRunning;
    }
  }

  runningTurns.sort((left, right) => safeTs(right?.startedAt) - safeTs(left?.startedAt));
  return runningTurns[0];
}

function findActiveTurnFromSelectedThreadSummary() {
  if (!state.selectedBridgeId || !state.selectedThreadId) {
    return null;
  }

  const threadItems = state.threadByBridge.get(state.selectedBridgeId) || [];
  const summary = threadItems.find((item) => item.threadId === state.selectedThreadId);
  if (!summary) {
    return null;
  }

  const activeTurnId = asString(summary.activeTurnId);
  const status = asString(summary.status);

  if (!activeTurnId || !isRunningThreadStatus(status)) {
    return null;
  }

  return {
    turnId: activeTurnId,
    status: status === "waiting_approval" ? "waiting_approval" : "running",
  };
}

function findAnyActiveTurnFromWorkspaceSummary() {
  if (!state.selectedBridgeId) {
    return null;
  }

  const threadItems = state.threadByBridge.get(state.selectedBridgeId) || [];
  const activeItems = threadItems.filter((item) => {
    const activeTurnId = asString(item.activeTurnId);
    const status = asString(item.status);
    return Boolean(activeTurnId && isRunningThreadStatus(status));
  });

  if (activeItems.length === 0) {
    return null;
  }

  activeItems.sort((left, right) => safeTs(right?.updatedAt) - safeTs(left?.updatedAt));
  const chosen = activeItems[0];
  const turnId = asString(chosen.activeTurnId);
  const status = asString(chosen.status);

  if (!turnId || !isRunningThreadStatus(status)) {
    return null;
  }

  return {
    threadId: chosen.threadId,
    turnId,
    status: status === "waiting_approval" ? "waiting_approval" : "running",
  };
}

function setThinkingIndicatorText(text) {
  const label = dom.thinkingIndicator.querySelector("span");
  if (!label) {
    return;
  }

  label.textContent = text;
}

function debugThinkingLog(message, payload = null) {
  if (!DEBUG_THINKING_LOGS) {
    return;
  }

  const prefix = `[pwa:${BUILD_VERSION}]`;
  if (payload) {
    console.debug(prefix, message, payload);
    return;
  }

  console.debug(prefix, message);
}

function installDebugHooks() {
  if (typeof window === "undefined") {
    return;
  }

  window.__bridgePwaDebug = {
    build: BUILD_VERSION,
    getState() {
      const selectedSummary = getSelectedThreadSummary();
      return {
        selectedBridgeId: state.selectedBridgeId,
        selectedThreadId: state.selectedThreadId,
        selectedTurnId: state.selectedTurnId,
        isThinking: state.isThinking,
        activeTurnStatus: state.activeTurnStatus,
        pendingJumpThreadId: state.pendingJumpThreadId,
        streamConnected: Boolean(state.ws),
        streamReconnectAttempt: state.wsReconnectAttempt,
        streamReconnectScheduled: Boolean(state.wsReconnectTimer),
        isOffline: state.isOffline,
        isHubReachable: state.isHubReachable,
        lastHubErrorMessage: state.lastHubErrorMessage,
        keyboardInsetPx: state.keyboardInsetPx,
        isKeyboardOpen: state.isKeyboardOpen,
        viewportBaseHeight: state.viewportBaseHeight,
        lastThinkingSeenAt: state.lastThinkingSeenAt,
        thinkingIndicatorHidden: dom.thinkingIndicator.hidden,
        thinkingIndicatorText: dom.thinkingIndicator.querySelector("span")?.textContent || null,
        thinkingPill: dom.thinkingPill.textContent,
        selectedThreadSummary: selectedSummary,
      };
    },
    getThreads() {
      if (!state.selectedBridgeId) {
        return [];
      }
      return (state.threadByBridge.get(state.selectedBridgeId) || []).map((item) => ({
        threadId: item.threadId,
        status: item.status,
        activeTurnId: item.activeTurnId,
        updatedAt: item.updatedAt,
      }));
    },
    forceThinkingVisible() {
      dom.thinkingIndicator.hidden = false;
      setThinkingIndicatorText("Forced debug visibility");
    },
  };
}

function getSelectedThreadSummary() {
  if (!state.selectedBridgeId || !state.selectedThreadId) {
    return null;
  }

  const threadItems = state.threadByBridge.get(state.selectedBridgeId) || [];
  return threadItems.find((item) => item.threadId === state.selectedThreadId) || null;
}

function normalizeRole(role) {
  if (role === "assistant" || role === "user" || role === "system") {
    return role;
  }

  return "assistant";
}

function clearSelectionState() {
  state.selectedBridgeId = null;
  state.selectedThreadId = null;
  state.selectedTurnId = null;
  state.threadDetail = null;
  state.threadDetailBridgeId = null;
  state.liveAssistantByTurn.clear();
  state.draftThreadByBridge.clear();
  state.observedActiveTurnByThread.clear();
  state.timelineRenderLimitByThread.clear();
  state.lastSelectedThreadUpdatedAt = null;
  state.pendingJumpThreadId = null;
  state.messagesRenderSignature = "";
  state.threadDetailRefreshQueued = false;
  state.isThreadSelectionLoading = false;

  closeStreamAndPolling();

  renderMessages(null);
  renderApprovals(null);
  updateConversationHeader(null);
  updateThinkingState(null);
  updatePrimaryAction();
  setTopbarHidden(false);
  syncScrollAffordances();

  persistState();
}

function isNearBottom(element, thresholdPx) {
  const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
  return distance <= thresholdPx;
}

/**
 * Timeline scroll policy:
 * - Show jump button when user is away from latest messages.
 * - Hide header on downward scroll, show it again with a small upward movement.
 */
function onMessagesScroll() {
  state.lastMessagesScrollTop = dom.messages.scrollTop;
  syncScrollAffordances();
}

function setTopbarHidden(hidden) {
  if (state.isTopbarHidden === hidden) {
    return;
  }

  state.isTopbarHidden = hidden;
  dom.topbar.classList.toggle("is-hidden", hidden);
}

function setTopbarExpanded(expanded) {
  state.isTopbarExpanded = expanded;
  dom.topbar.classList.toggle("is-expanded", expanded);
  dom.topbar.classList.toggle("is-collapsed", !expanded);
  dom.topbarToggle.setAttribute("aria-expanded", expanded ? "true" : "false");
  dom.topbarToggle.setAttribute("aria-label", expanded ? "Minimize header" : "Expand header");
  syncTopbarPillLabels();
}

function syncScrollAffordances() {
  const isScrollable = dom.messages.scrollHeight > dom.messages.clientHeight + 8;
  const isAtBottom = isNearBottom(dom.messages, JUMP_BUTTON_THRESHOLD_PX);
  dom.jumpBottom.classList.toggle("is-visible", isScrollable && !isAtBottom);
}

function scrollMessagesToBottom(behavior = "auto") {
  dom.messages.scrollTo({
    top: dom.messages.scrollHeight,
    behavior,
  });

  state.lastMessagesScrollTop = dom.messages.scrollTop;
  syncScrollAffordances();
}

function normalizePlanItem(rawItem) {
  const item = asObject(rawItem);
  const text = asString(item.text) || asString(item.step);
  if (!text) {
    return null;
  }

  const rawStatus = asString(item.status);
  let status = "pending";
  if (rawStatus === "completed") {
    status = "completed";
  } else if (rawStatus === "in_progress" || rawStatus === "inProgress") {
    status = "in_progress";
  }

  return {
    id: asString(item.id) || `plan_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    text,
    status,
  };
}

function setPillText(pillElement, fullText, shortText) {
  const full = String(fullText || "");
  const short = String(shortText || full);
  pillElement.dataset.full = full;
  pillElement.dataset.short = short;
  pillElement.textContent = state.isTopbarExpanded ? full : short;
}

function syncTopbarPillLabels() {
  for (const pill of [dom.connectionPill, dom.streamPill, dom.thinkingPill]) {
    const full = String(pill.dataset.full || pill.textContent || "");
    const short = String(pill.dataset.short || full);
    pill.textContent = state.isTopbarExpanded ? full : short;
  }
}

function normalizeApprovalItem(rawItem) {
  const item = asObject(rawItem);
  const approvalId = asString(item.approvalId);
  const type = asString(item.type);
  const status = asString(item.status);
  const requestedAt = asString(item.requestedAt);

  if (!approvalId || !type || !status || !requestedAt) {
    return null;
  }

  return {
    approvalId,
    type,
    status,
    requestedAt,
    decidedAt: asString(item.decidedAt) || undefined,
    decisionSource: asString(item.decisionSource) || undefined,
  };
}

function formatTime(value) {
  if (!value || typeof value !== "string") {
    return "--:--:--";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "--:--:--";
  }

  return parsed.toLocaleTimeString();
}

function truncateDetail(value, maxLength) {
  if (typeof value !== "string") {
    return "";
  }

  const compact = value.trim();
  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, maxLength)}...`;
}

function compactJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function isDeepEqualJson(left, right) {
  try {
    return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
  } catch {
    return false;
  }
}

function asObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value;
}

function asString(value) {
  return typeof value === "string" ? value : null;
}

function asNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRunningTurnStatus(status) {
  return status === "running" || status === "waiting_approval";
}

function isRunningThreadStatus(status) {
  return status === "running" || status === "waiting_approval";
}

/**
 * Tracks active turn intent from live WS events, even when periodic thread snapshots
 * momentarily lag behind real execution state.
 */
function trackObservedActiveTurn(event) {
  const turnId = asString(event?.context?.turnId);
  if (!turnId) {
    return;
  }

  const eventMethod = asString(event?.method) || "";
  const eventThreadId =
    asString(event?.context?.threadId) || asString(state.threadDetail?.thread?.threadId) || state.selectedThreadId;
  if (!eventThreadId) {
    return;
  }

  if (eventMethod === "turn/completed") {
    forgetObservedActiveTurn(eventThreadId, turnId);
    return;
  }

  if (eventMethod === "hub/state") {
    const rawStatus = asString(asObject(event?.params?.turn).status);
    const status = normalizeTurnStatus(rawStatus);
    if (isRunningTurnStatus(status)) {
      rememberObservedActiveTurn(eventThreadId, turnId, status);
    } else {
      forgetObservedActiveTurn(eventThreadId, turnId);
    }
    return;
  }

  if (eventMethod === "item/commandExecution/requestApproval" || eventMethod === "item/fileChange/requestApproval") {
    rememberObservedActiveTurn(eventThreadId, turnId, "waiting_approval");
    return;
  }

  // Any other in-turn event implies the turn is still active.
  rememberObservedActiveTurn(eventThreadId, turnId, "running");
}

function rememberObservedActiveTurn(threadId, turnId, status) {
  if (!threadId || !turnId) {
    return;
  }

  const normalizedStatus = status === "waiting_approval" ? "waiting_approval" : "running";
  state.observedActiveTurnByThread.set(threadId, {
    turnId,
    status: normalizedStatus,
    lastSeenAt: Date.now(),
  });
}

function forgetObservedActiveTurn(threadId, turnId) {
  if (!threadId) {
    return;
  }

  const current = state.observedActiveTurnByThread.get(threadId);
  if (!current) {
    return;
  }

  if (!turnId || current.turnId === turnId) {
    state.observedActiveTurnByThread.delete(threadId);
  }
}

function reconcileObservedActiveTurn(detail) {
  const threadId = asString(detail?.thread?.threadId);
  if (!threadId) {
    return;
  }

  const turns = Array.isArray(detail?.turns) ? detail.turns : [];
  const activeTurnId = asString(detail?.thread?.activeTurnId);
  const threadStatus = asString(detail?.thread?.status);

  if (activeTurnId && isRunningThreadStatus(threadStatus)) {
    rememberObservedActiveTurn(threadId, activeTurnId, threadStatus === "waiting_approval" ? "waiting_approval" : "running");
    return;
  }

  const observed = state.observedActiveTurnByThread.get(threadId);
  if (!observed) {
    return;
  }

  const observedTurn = turns.find((turn) => turn.turnId === observed.turnId);
  if (observedTurn && !isRunningTurnStatus(observedTurn.status)) {
    state.observedActiveTurnByThread.delete(threadId);
    return;
  }

  if (Date.now() - observed.lastSeenAt > OBSERVED_ACTIVE_TURN_TTL_MS && !isRunningThreadStatus(threadStatus)) {
    state.observedActiveTurnByThread.delete(threadId);
  }
}

function safeTs(value) {
  if (typeof value !== "string") {
    return 0;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseNumberString(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return NaN;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function normalizeTurnStatus(status) {
  if (status === "running" || status === "waiting_approval" || status === "completed" || status === "interrupted" || status === "failed") {
    return status;
  }

  if (status === "inProgress") {
    return "running";
  }

  if (status === "cancelled" || status === "canceled") {
    return "interrupted";
  }

  if (status === "error" || status === "errored") {
    return "failed";
  }

  return "completed";
}

function draftThreadIdForBridge(bridgeId) {
  return `${NEW_THREAD_DRAFT_PREFIX}${bridgeId}`;
}

function isDraftThreadId(threadId) {
  return typeof threadId === "string" && threadId.startsWith(NEW_THREAD_DRAFT_PREFIX);
}

function threadIdShort(value) {
  if (!value || typeof value !== "string") {
    return "n/a";
  }

  return value.slice(0, 8);
}

function formatDateTime(value) {
  if (!value || typeof value !== "string") {
    return "n/a";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "n/a";
  }

  return parsed.toLocaleString();
}

/**
 * Derives hub origin from current PWA URL so no manual hub host setup is needed.
 */
function resolveHubOrigin() {
  if (typeof window !== "undefined" && window.location?.origin?.startsWith("http")) {
    return window.location.origin;
  }

  return "http://127.0.0.1:7777";
}
