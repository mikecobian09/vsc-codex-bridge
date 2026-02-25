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

const TEST_AUTH_TOKEN = "token_e2e_happy_path";
const TEST_BRIDGE_ID = "bridge_e2e_happy_path";
const TEST_THREAD_ID = "thread_e2e_happy_path";
const TEST_TURN_ID = "turn_e2e_happy_path";

interface MockBridgeContext {
  readonly port: number;
  readonly state: {
    lastMessageBody: Record<string, unknown> | null;
    messageCalls: number;
  };
  stop(): Promise<void>;
}

test("hub happy path proxies list/read/message endpoints and relays turn WS stream", async (t) => {
  let mockBridge: MockBridgeContext | null = null;
  let hubServer: HubServer | null = null;

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

    const bridgesPayload = await fetchJson(`http://127.0.0.1:${hubPort}/api/v1/bridges`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${TEST_AUTH_TOKEN}`,
      },
    });
    assert.ok(Array.isArray(bridgesPayload.items));
    assert.equal(bridgesPayload.items.length, 1);
    assert.equal(bridgesPayload.items[0].bridgeId, TEST_BRIDGE_ID);

    const threadListPayload = await fetchJson(
      `http://127.0.0.1:${hubPort}/api/v1/bridges/${encodeURIComponent(TEST_BRIDGE_ID)}/threads`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${TEST_AUTH_TOKEN}`,
        },
      },
    );
    assert.ok(Array.isArray(threadListPayload.items));
    assert.equal(threadListPayload.items.length, 1);
    assert.equal(threadListPayload.items[0].threadId, TEST_THREAD_ID);

    const threadDetailPayload = await fetchJson(
      `http://127.0.0.1:${hubPort}/api/v1/bridges/${encodeURIComponent(TEST_BRIDGE_ID)}/threads/${encodeURIComponent(TEST_THREAD_ID)}`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${TEST_AUTH_TOKEN}`,
        },
      },
    );
    assert.equal(threadDetailPayload.thread.threadId, TEST_THREAD_ID);
    assert.equal(threadDetailPayload.thread.activeTurnId, TEST_TURN_ID);
    assert.ok(Array.isArray(threadDetailPayload.messages));
    assert.ok(Array.isArray(threadDetailPayload.turns));

    const messageBody = {
      text: "run end-to-end happy path",
      modelId: "gpt-5-codex",
      accessMode: "full-access",
    };

    const sendMessagePayload = await fetchJson(
      `http://127.0.0.1:${hubPort}/api/v1/bridges/${encodeURIComponent(TEST_BRIDGE_ID)}/threads/${encodeURIComponent(TEST_THREAD_ID)}/message`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${TEST_AUTH_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(messageBody),
      },
    );
    assert.equal(sendMessagePayload.threadId, TEST_THREAD_ID);
    assert.equal(sendMessagePayload.turnId, TEST_TURN_ID);
    assert.equal(mockBridge.state.messageCalls, 1);
    assert.deepEqual(mockBridge.state.lastMessageBody, messageBody);

    const streamUrl =
      `ws://127.0.0.1:${hubPort}/ws/v1/bridges/${encodeURIComponent(TEST_BRIDGE_ID)}/turns/${encodeURIComponent(TEST_TURN_ID)}` +
      `?token=${encodeURIComponent(TEST_AUTH_TOKEN)}`;
    const downstreamClient = new WebSocket(streamUrl, { perMessageDeflate: false });

    await once(downstreamClient, "open");
    const firstMessage = await waitForWebSocketMessage(downstreamClient, 2_500);
    const firstEvent = JSON.parse(firstMessage.toString("utf8"));

    assert.equal(firstEvent.method, "turn/started");
    assert.equal(firstEvent.context.threadId, TEST_THREAD_ID);
    assert.equal(firstEvent.context.turnId, TEST_TURN_ID);

    await closeWebSocket(downstreamClient);
  } catch (error) {
    if (isListenPermissionError(error)) {
      t.skip("Socket listen is not permitted in this runtime; skipping integration happy-path.");
      return;
    }
    throw error;
  } finally {
    if (hubServer) {
      await hubServer.stop();
    }
    if (mockBridge) {
      await mockBridge.stop();
    }
  }
});

async function registerBridgeInHub(hubPort: number, bridgePort: number): Promise<void> {
  const registerPayload = {
    bridgeId: TEST_BRIDGE_ID,
    workspaceName: "E2E Workspace",
    cwd: "/tmp/e2e-workspace",
    port: bridgePort,
    pid: 12345,
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

async function fetchJson(url: string, init: RequestInit): Promise<any> {
  const response = await fetch(url, init);
  const text = await response.text();

  assert.equal(response.ok, true, `Request failed (${response.status}) for ${url}: ${text}`);

  if (!text) {
    return null;
  }

  return JSON.parse(text);
}

async function startMockBridgeServer(): Promise<MockBridgeContext> {
  const state = {
    lastMessageBody: null as Record<string, unknown> | null,
    messageCalls: 0,
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
      const eventPayload = {
        v: 1,
        seq: 1,
        ts: new Date().toISOString(),
        method: "turn/started",
        context: {
          threadId: TEST_THREAD_ID,
          turnId,
        },
        params: {
          turn: {
            turnId,
            status: "running",
          },
        },
      };
      clientSocket.send(JSON.stringify(eventPayload));
    });
  });

  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");

  const address = httpServer.address() as AddressInfo;
  const port = address.port;

  return {
    port,
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
  state: MockBridgeContext["state"],
): Promise<void> {
  const parsedUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const pathname = parsedUrl.pathname;
  const method = request.method ?? "GET";

  if (method === "GET" && pathname === "/internal/v1/threads") {
    writeJson(response, 200, {
      items: [
        {
          threadId: TEST_THREAD_ID,
          title: "E2E Thread",
          status: "running",
          activeTurnId: TEST_TURN_ID,
          updatedAt: new Date().toISOString(),
        },
      ],
    });
    return;
  }

  if (method === "GET" && pathname === `/internal/v1/threads/${encodeURIComponent(TEST_THREAD_ID)}`) {
    writeJson(response, 200, {
      thread: {
        threadId: TEST_THREAD_ID,
        title: "E2E Thread",
        status: "running",
        activeTurnId: TEST_TURN_ID,
        updatedAt: new Date().toISOString(),
      },
      messages: [
        {
          role: "user",
          text: "hello",
          ts: new Date().toISOString(),
          turnId: TEST_TURN_ID,
        },
      ],
      turns: [
        {
          turnId: TEST_TURN_ID,
          threadId: TEST_THREAD_ID,
          status: "running",
          accessMode: "full-access",
          modelId: "gpt-5-codex",
          userText: "hello",
          assistantText: "",
          startedAt: new Date().toISOString(),
          completedAt: null,
          plan: [],
          diff: "",
          approvals: [],
          steerHistory: [],
        },
      ],
    });
    return;
  }

  if (method === "POST" && pathname === `/internal/v1/threads/${encodeURIComponent(TEST_THREAD_ID)}/message`) {
    const body = await readJsonBody(request);
    state.lastMessageBody = body;
    state.messageCalls += 1;

    writeJson(response, 200, {
      threadId: TEST_THREAD_ID,
      turnId: TEST_TURN_ID,
    });
    return;
  }

  writeJson(response, 404, {
    error: "NOT_FOUND",
    message: `Mock bridge route not found: ${method} ${pathname}`,
  });
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

async function waitForWebSocketMessage(socket: WebSocket, timeoutMs: number): Promise<Buffer> {
  return await new Promise<Buffer>((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      cleanup();
      rejectPromise(new Error(`Timed out waiting for websocket message after ${timeoutMs} ms.`));
    }, timeoutMs);

    const onMessage = (data: WebSocket.RawData): void => {
      cleanup();
      if (Buffer.isBuffer(data)) {
        resolvePromise(data);
        return;
      }

      if (Array.isArray(data)) {
        resolvePromise(Buffer.concat(data));
        return;
      }

      resolvePromise(Buffer.from(data as ArrayBuffer));
    };

    const onError = (error: Error): void => {
      cleanup();
      rejectPromise(error);
    };

    const onClose = (): void => {
      cleanup();
      rejectPromise(new Error("Websocket closed before message was received."));
    };

    const cleanup = (): void => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("error", onError);
      socket.off("close", onClose);
    };

    socket.on("message", onMessage);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
}

async function closeWebSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return;
  }

  await new Promise<void>((resolvePromise) => {
    socket.once("close", () => resolvePromise());
    socket.close();
  });
}

function isListenPermissionError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EACCES";
}
