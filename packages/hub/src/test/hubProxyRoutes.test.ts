import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { BridgeRegistry } from "../registry";
import { HubServer } from "../server";
import { Logger } from "../logger";
import { HubConfig } from "../types";

interface CapturedForwardRequest {
  bridgeId: string;
  method: "GET" | "POST";
  path: string;
  body?: Record<string, unknown>;
}

interface MockResponseState {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

const TEST_HUB_CONFIG: HubConfig = {
  bindHost: "127.0.0.1",
  port: 7777,
  authToken: "",
  bridgeTtlMs: 60_000,
  heartbeatPruneIntervalMs: 60_000,
  mutatingRateLimitWindowMs: 10_000,
  mutatingRateLimitMax: 80,
  corsAllowedOrigins: [],
  publicDir: ".",
  verboseLogs: false,
};

let hubServer: HubServer;
let capturedForwards: CapturedForwardRequest[];

/**
 * For these regression tests we call route handlers in-memory without opening sockets.
 * This keeps tests deterministic in restricted/sandboxed environments and still validates:
 * - path routing and parameter extraction,
 * - forwarded internal route path,
 * - forwarded body shape for each mutating endpoint.
 */
beforeEach(() => {
  hubServer = new HubServer(TEST_HUB_CONFIG, new BridgeRegistry(TEST_HUB_CONFIG.bridgeTtlMs), new Logger(false));
  capturedForwards = [];

  // Replace the private bridge-forward helper with an in-memory capture stub.
  (hubServer as any).forwardRequestToBridge = async (args: CapturedForwardRequest & { response: ServerResponse }) => {
    capturedForwards.push({
      bridgeId: args.bridgeId,
      method: args.method,
      path: args.path,
      body: args.body,
    });

    args.response.statusCode = 200;
    args.response.setHeader("content-type", "application/json; charset=utf-8");
    args.response.end(JSON.stringify({ ok: true }));
  };
});

test("routes message endpoint to internal thread message path with body passthrough", async () => {
  const bridgeId = "bridge_for_message";
  const threadId = "thread-message";
  const requestBody = {
    text: "run proxy regression test",
    modelId: "gpt-5-codex",
    accessMode: "full-access",
  };

  const request = createJsonRequest(requestBody);
  const response = createMockResponse();
  const parsedUrl = new URL(
    `/api/v1/bridges/${encodeURIComponent(bridgeId)}/threads/${encodeURIComponent(threadId)}/message`,
    "http://127.0.0.1:7777",
  );

  await (hubServer as any).handleApiRequest("POST", parsedUrl, request, response.raw, "test-message");

  assert.equal(capturedForwards.length, 1);
  assert.deepEqual(capturedForwards[0], {
    bridgeId,
    method: "POST",
    path: `/internal/v1/threads/${encodeURIComponent(threadId)}/message`,
    body: requestBody,
  });
});

test("routes steer endpoint to internal turn steer path with body passthrough", async () => {
  const bridgeId = "bridge_for_steer";
  const turnId = "turn-steer";
  const requestBody = {
    text: "focus only on tests",
  };

  const request = createJsonRequest(requestBody);
  const response = createMockResponse();
  const parsedUrl = new URL(
    `/api/v1/bridges/${encodeURIComponent(bridgeId)}/turns/${encodeURIComponent(turnId)}/steer`,
    "http://127.0.0.1:7777",
  );

  await (hubServer as any).handleApiRequest("POST", parsedUrl, request, response.raw, "test-steer");

  assert.equal(capturedForwards.length, 1);
  assert.deepEqual(capturedForwards[0], {
    bridgeId,
    method: "POST",
    path: `/internal/v1/turns/${encodeURIComponent(turnId)}/steer`,
    body: requestBody,
  });
});

test("routes interrupt endpoint to internal turn interrupt path and injects empty object body", async () => {
  const bridgeId = "bridge_for_interrupt";
  const turnId = "turn-interrupt";

  // Interrupt route does not consume inbound JSON body. Hub must still forward an empty object payload.
  const request = createJsonRequest(null);
  const response = createMockResponse();
  const parsedUrl = new URL(
    `/api/v1/bridges/${encodeURIComponent(bridgeId)}/turns/${encodeURIComponent(turnId)}/interrupt`,
    "http://127.0.0.1:7777",
  );

  await (hubServer as any).handleApiRequest("POST", parsedUrl, request, response.raw, "test-interrupt");

  assert.equal(capturedForwards.length, 1);
  assert.deepEqual(capturedForwards[0], {
    bridgeId,
    method: "POST",
    path: `/internal/v1/turns/${encodeURIComponent(turnId)}/interrupt`,
    body: {},
  });
});

test("routes approval decision endpoint to internal approval path with decision body", async () => {
  const bridgeId = "bridge_for_approval";
  const approvalId = "approval-123";
  const requestBody = {
    decision: "approve",
  };

  const request = createJsonRequest(requestBody);
  const response = createMockResponse();
  const parsedUrl = new URL(
    `/api/v1/bridges/${encodeURIComponent(bridgeId)}/approvals/${encodeURIComponent(approvalId)}/decision`,
    "http://127.0.0.1:7777",
  );

  await (hubServer as any).handleApiRequest("POST", parsedUrl, request, response.raw, "test-approval");

  assert.equal(capturedForwards.length, 1);
  assert.deepEqual(capturedForwards[0], {
    bridgeId,
    method: "POST",
    path: `/internal/v1/approvals/${encodeURIComponent(approvalId)}/decision`,
    body: requestBody,
  });
});

test("forward helper returns NOT_FOUND when bridge is missing", async () => {
  const realHubServer = new HubServer(
    TEST_HUB_CONFIG,
    new BridgeRegistry(TEST_HUB_CONFIG.bridgeTtlMs),
    new Logger(false),
  );
  const response = createMockResponse();

  await (realHubServer as any).forwardRequestToBridge({
    response: response.raw,
    bridgeId: "missing-bridge",
    method: "POST",
    path: "/internal/v1/turns/turn-x/interrupt",
    body: {},
  });

  assert.equal(response.state.statusCode, 404);
  const payload = JSON.parse(response.state.body);
  assert.equal(payload.error, "NOT_FOUND");
  assert.equal(payload.message, "Bridge missing-bridge is offline or unknown.");
});

test("exposes runtime security posture endpoint without leaking token", async () => {
  const runtimeConfig: HubConfig = {
    ...TEST_HUB_CONFIG,
    bindHost: "0.0.0.0",
    authToken: "short-token",
  };
  const realHubServer = new HubServer(runtimeConfig, new BridgeRegistry(runtimeConfig.bridgeTtlMs), new Logger(false));
  const response = createMockResponse();
  const request = createGetRequest();
  const parsedUrl = new URL("/api/v1/runtime/security", "http://127.0.0.1:7777");

  await (realHubServer as any).handleApiRequest("GET", parsedUrl, request, response.raw, "test-security");

  assert.equal(response.state.statusCode, 200);
  const payload = JSON.parse(response.state.body);
  assert.equal(payload.posture, "warn");
  assert.equal(payload.bindHost, "0.0.0.0");
  assert.equal(payload.authEnabled, true);
  assert.equal(payload.tokenLength, "short-token".length);
  assert.ok(Array.isArray(payload.warnings));
  assert.equal(typeof payload.authToken, "undefined");
});

function createJsonRequest(body: Record<string, unknown> | null): IncomingMessage {
  const payload = body === null ? "" : JSON.stringify(body);
  const readable = Readable.from(payload ? [payload] : []);
  const request = readable as unknown as IncomingMessage;
  request.headers = { "content-type": "application/json" };
  request.method = "POST";
  request.url = "/";
  request.socket = { remoteAddress: "127.0.0.1" } as any;
  return request;
}

function createGetRequest(): IncomingMessage {
  const readable = Readable.from([]);
  const request = readable as unknown as IncomingMessage;
  request.headers = {};
  request.method = "GET";
  request.url = "/";
  request.socket = { remoteAddress: "127.0.0.1" } as any;
  return request;
}

function createMockResponse(): { raw: ServerResponse; state: MockResponseState } {
  const state: MockResponseState = {
    statusCode: 200,
    headers: {},
    body: "",
  };

  const raw = {
    statusCode: 200,
    setHeader(name: string, value: string): void {
      state.headers[name.toLowerCase()] = String(value);
    },
    end(value?: string): void {
      if (typeof (this as { statusCode?: number }).statusCode === "number") {
        state.statusCode = (this as { statusCode: number }).statusCode;
      }
      state.body = value ?? "";
    },
  } as unknown as ServerResponse;

  return { raw, state };
}
