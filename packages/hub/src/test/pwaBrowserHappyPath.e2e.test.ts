import assert from "node:assert/strict";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";
import { AddressInfo } from "node:net";
import { test } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { HubServer } from "../server";
import { BridgeRegistry } from "../registry";
import { Logger } from "../logger";
import { HubConfig } from "../types";

const RUN_BROWSER_E2E = process.env.RUN_PWA_BROWSER_E2E === "1";
const TEST_AUTH_TOKEN = "token_pwa_browser_e2e";
const TEST_BRIDGE_ID = "bridge_pwa_browser_e2e";
const TEST_THREAD_ID = "thread_pwa_browser_e2e";

interface MockBridgeState {
  messageCalls: number;
  lastMessageBody: Record<string, unknown> | null;
  lastTurnId: string | null;
  threadUpdatedAt: string;
  messages: Array<{
    role: "user" | "assistant";
    text: string;
    ts: string;
    turnId: string;
  }>;
  turns: Array<{
    turnId: string;
    threadId: string;
    status: "running" | "completed";
    accessMode: "full-access";
    modelId: string;
    userText: string;
    assistantText: string;
    startedAt: string;
    completedAt: string | null;
    plan: unknown[];
    diff: string;
    approvals: unknown[];
    steerHistory: string[];
  }>;
}

interface MockBridgeContext {
  readonly port: number;
  readonly state: MockBridgeState;
  stop(): Promise<void>;
}

interface BrowserLikePage {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  fill(selector: string, value: string): Promise<void>;
  click(selector: string): Promise<void>;
  waitForSelector(
    selector: string,
    options?: {
      state?: "attached" | "detached" | "visible" | "hidden";
      timeout?: number;
    },
  ): Promise<unknown>;
  waitForFunction(
    pageFunction: (...args: unknown[]) => unknown,
    arg?: unknown,
    options?: { timeout?: number },
  ): Promise<unknown>;
}

interface BrowserLikeContext {
  newPage(): Promise<BrowserLikePage>;
  close(): Promise<void>;
}

interface BrowserLike {
  newContext(): Promise<BrowserLikeContext>;
  close(): Promise<void>;
}

interface PlaywrightModuleLike {
  chromium?: {
    launch(options?: { headless?: boolean }): Promise<BrowserLike>;
  };
}

test(
  "pwa browser happy path renders workspace/thread and sends message to selected thread",
  { timeout: 120_000 },
  async (t) => {
    if (!RUN_BROWSER_E2E) {
      t.skip("Set RUN_PWA_BROWSER_E2E=1 to run browser-level PWA E2E.");
      return;
    }

    const playwrightModule = await loadPlaywrightModule();
    if (!playwrightModule?.chromium) {
      t.skip("Playwright is not installed in this runtime.");
      return;
    }

    let mockBridge: MockBridgeContext | null = null;
    let hubServer: HubServer | null = null;
    let browser: BrowserLike | null = null;
    let context: BrowserLikeContext | null = null;

    try {
      mockBridge = await startMockBridgeServer();
      const hubPort = await allocateEphemeralPort();

      const hubConfig: HubConfig = {
        bindHost: "127.0.0.1",
        port: hubPort,
        authToken: TEST_AUTH_TOKEN,
        bridgeTtlMs: 60_000,
        heartbeatPruneIntervalMs: 60_000,
        mutatingRateLimitWindowMs: 10_000,
        mutatingRateLimitMax: 80,
        corsAllowedOrigins: [],
        publicDir: ".",
        verboseLogs: false,
      };

      hubServer = new HubServer(hubConfig, new BridgeRegistry(hubConfig.bridgeTtlMs), new Logger(false));
      await hubServer.start();
      await registerBridgeInHub(hubPort, mockBridge.port);

      browser = await playwrightModule.chromium.launch({ headless: true });
      context = await browser.newContext();
      const page = await context.newPage();

      await page.goto(`http://127.0.0.1:${hubPort}/?e2e=pwa-browser-happy-path`, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });

      await page.waitForSelector("#hub-token", { timeout: 20_000 });
      await page.fill("#hub-token", TEST_AUTH_TOKEN);
      await page.click("#load-bridges");

      await page.waitForFunction(
        (threadId: unknown) => {
          const selectedThreadId = (window as any).__bridgePwaDebug?.getState?.()?.selectedThreadId;
          return selectedThreadId === threadId;
        },
        TEST_THREAD_ID,
        { timeout: 20_000 },
      );

      const promptText = "Browser E2E message from PWA";
      await page.fill("#prompt", promptText);
      await page.click("#primary-action");

      await waitForCondition(() => mockBridge?.state.messageCalls === 1, 10_000, 50);
      assert.equal(mockBridge.state.lastMessageBody?.text, promptText);

      await page.waitForFunction(
        (expectedText: unknown) => {
          const node = document.getElementById("messages");
          return Boolean(node && node.textContent && node.textContent.includes(String(expectedText)));
        },
        promptText,
        { timeout: 20_000 },
      );
    } catch (error) {
      if (isListenPermissionError(error)) {
        t.skip("Socket listen is not permitted in this runtime; skipping browser-level PWA E2E.");
        return;
      }

      if (isPlaywrightLaunchError(error)) {
        t.skip("Playwright browser binaries are unavailable in this runtime.");
        return;
      }

      throw error;
    } finally {
      if (context) {
        await context.close();
      }
      if (browser) {
        await browser.close();
      }
      if (hubServer) {
        await hubServer.stop();
      }
      if (mockBridge) {
        await mockBridge.stop();
      }
    }
  },
);

async function loadPlaywrightModule(): Promise<PlaywrightModuleLike | null> {
  try {
    const dynamicImport = new Function("moduleName", "return import(moduleName);") as (
      moduleName: string,
    ) => Promise<unknown>;
    const moduleValue = await dynamicImport("playwright");
    return moduleValue as PlaywrightModuleLike;
  } catch {
    return null;
  }
}

async function registerBridgeInHub(hubPort: number, bridgePort: number): Promise<void> {
  const registerPayload = {
    bridgeId: TEST_BRIDGE_ID,
    workspaceName: "PWA Browser E2E Workspace",
    cwd: "/tmp/pwa-browser-e2e",
    port: bridgePort,
    pid: 22222,
    startedAt: new Date().toISOString(),
    bridgeVersion: "0.1.0-test",
  };

  const response = await fetch(`http://127.0.0.1:${hubPort}/api/v1/internal/bridges/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(registerPayload),
  });

  const text = await response.text();
  assert.equal(response.status, 200, `bridge register failed: ${text}`);
}

async function startMockBridgeServer(): Promise<MockBridgeContext> {
  const state: MockBridgeState = {
    messageCalls: 0,
    lastMessageBody: null,
    lastTurnId: null,
    threadUpdatedAt: new Date().toISOString(),
    messages: [],
    turns: [],
  };

  const wsServer = new WebSocketServer({ noServer: true });
  const httpServer = createServer(async (request, response) => {
    await handleMockBridgeHttpRequest(request, response, state);
  });

  httpServer.on("upgrade", (request, socket, head) => {
    const parsedUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const streamMatch = parsedUrl.pathname.match(/^\/internal\/v1\/turns\/([^/]+)\/stream$/);
    if (!streamMatch) {
      socket.destroy();
      return;
    }

    wsServer.handleUpgrade(request, socket, head, (clientSocket) => {
      const turnId = decodeURIComponent(streamMatch[1]);
      void emitMockTurnStreamEvents(clientSocket, state, turnId);
    });
  });

  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");

  const address = httpServer.address() as AddressInfo;
  return {
    port: address.port,
    state,
    async stop(): Promise<void> {
      wsServer.clients.forEach((socket) => {
        socket.close();
      });
      wsServer.close();

      await new Promise<void>((resolvePromise) => {
        httpServer.close(() => resolvePromise());
      });
    },
  };
}

async function handleMockBridgeHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  state: MockBridgeState,
): Promise<void> {
  const parsedUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const pathname = parsedUrl.pathname;
  const method = request.method ?? "GET";

  if (method === "GET" && pathname === "/internal/v1/threads") {
    writeJson(response, 200, {
      items: [
        {
          threadId: TEST_THREAD_ID,
          title: "PWA Browser E2E Thread",
          status: state.lastTurnId ? currentTurnStatus(state) : "idle",
          activeTurnId: currentTurnStatus(state) === "running" ? state.lastTurnId : null,
          updatedAt: state.threadUpdatedAt,
        },
      ],
    });
    return;
  }

  if (method === "GET" && pathname === `/internal/v1/threads/${encodeURIComponent(TEST_THREAD_ID)}`) {
    writeJson(response, 200, {
      thread: {
        threadId: TEST_THREAD_ID,
        title: "PWA Browser E2E Thread",
        status: state.lastTurnId ? currentTurnStatus(state) : "idle",
        activeTurnId: currentTurnStatus(state) === "running" ? state.lastTurnId : null,
        updatedAt: state.threadUpdatedAt,
      },
      messages: state.messages,
      turns: state.turns,
    });
    return;
  }

  if (method === "POST" && pathname === `/internal/v1/threads/${encodeURIComponent(TEST_THREAD_ID)}/message`) {
    const body = await readJsonBody(request);
    state.lastMessageBody = body;
    state.messageCalls += 1;

    const nowIso = new Date().toISOString();
    const turnId = `turn_pwa_browser_${state.messageCalls}`;
    const userText = String(body.text ?? "");

    state.lastTurnId = turnId;
    state.threadUpdatedAt = nowIso;
    state.messages.push({
      role: "user",
      text: userText,
      ts: nowIso,
      turnId,
    });
    state.turns.unshift({
      turnId,
      threadId: TEST_THREAD_ID,
      status: "running",
      accessMode: "full-access",
      modelId: "gpt-5-codex",
      userText,
      assistantText: "",
      startedAt: nowIso,
      completedAt: null,
      plan: [],
      diff: "",
      approvals: [],
      steerHistory: [],
    });

    writeJson(response, 200, {
      threadId: TEST_THREAD_ID,
      turnId,
    });
    return;
  }

  writeJson(response, 404, {
    error: "NOT_FOUND",
    message: `Mock bridge route not found: ${method} ${pathname}`,
  });
}

async function emitMockTurnStreamEvents(socket: WebSocket, state: MockBridgeState, turnId: string): Promise<void> {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }

  const threadId = TEST_THREAD_ID;

  const sendEvent = (method: string, params: Record<string, unknown>): void => {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(
      JSON.stringify({
        v: 1,
        seq: 1,
        ts: new Date().toISOString(),
        method,
        context: {
          threadId,
          turnId,
        },
        params,
      }),
    );
  };

  sendEvent("turn/started", {
    turn: {
      id: turnId,
      status: "running",
    },
  });

  await sleep(60);
  sendEvent("item/agentMessage/delta", {
    delta: "Mock assistant reply",
  });

  await sleep(60);
  finalizeTurnAsCompleted(state, turnId, "Mock assistant reply");
  sendEvent("turn/completed", {
    turn: {
      id: turnId,
      status: "completed",
      completedAt: new Date().toISOString(),
    },
  });
}

function finalizeTurnAsCompleted(state: MockBridgeState, turnId: string, assistantText: string): void {
  const nowIso = new Date().toISOString();
  const turn = state.turns.find((item) => item.turnId === turnId);
  if (turn) {
    turn.status = "completed";
    turn.assistantText = assistantText;
    turn.completedAt = nowIso;
  }

  state.messages.push({
    role: "assistant",
    text: assistantText,
    ts: nowIso,
    turnId,
  });
  state.threadUpdatedAt = nowIso;
}

function currentTurnStatus(state: MockBridgeState): "running" | "completed" {
  if (!state.lastTurnId) {
    return "completed";
  }

  const current = state.turns.find((item) => item.turnId === state.lastTurnId);
  return current?.status === "running" ? "running" : "completed";
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

async function allocateEphemeralPort(): Promise<number> {
  const allocator = createServer();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    allocator.once("error", rejectPromise);
    allocator.listen(0, "127.0.0.1", () => resolvePromise());
  });

  const address = allocator.address();
  assert.ok(address && typeof address === "object");
  const port = (address as AddressInfo).port;

  await new Promise<void>((resolvePromise) => {
    allocator.close(() => resolvePromise());
  });

  return port;
}

async function waitForCondition(
  check: () => boolean,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await sleep(pollIntervalMs);
  }

  throw new Error(`Condition not met within ${timeoutMs} ms.`);
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function isListenPermissionError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EACCES";
}

function isPlaywrightLaunchError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const message = String((error as { message?: unknown }).message ?? "");
  return message.includes("Executable doesn't exist") || message.includes("browserType.launch");
}
