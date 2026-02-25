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
  mutatingRateLimitMax: 2,
  corsAllowedOrigins: [],
  publicDir: ".",
  verboseLogs: false,
};

let hubServer: HubServer;
let capturedForwards: CapturedForwardRequest[];

beforeEach(() => {
  hubServer = new HubServer(TEST_HUB_CONFIG, new BridgeRegistry(TEST_HUB_CONFIG.bridgeTtlMs), new Logger(false));
  capturedForwards = [];

  // Replace bridge forwarding to keep tests in-memory and deterministic.
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

test("mutating endpoint is rate-limited per host after configured request budget", async () => {
  const bridgeId = "bridge_rate_limit";
  const threadId = "thread_rate_limit";
  const parsedUrl = new URL(
    `/api/v1/bridges/${encodeURIComponent(bridgeId)}/threads/${encodeURIComponent(threadId)}/message`,
    "http://127.0.0.1:7777",
  );

  const firstResponse = createMockResponse();
  await (hubServer as any).handleApiRequest(
    "POST",
    parsedUrl,
    createJsonRequest({ text: "message-1" }, "127.0.0.1"),
    firstResponse.raw,
    "test-rate-1",
  );
  assert.equal(firstResponse.state.statusCode, 200);

  const secondResponse = createMockResponse();
  await (hubServer as any).handleApiRequest(
    "POST",
    parsedUrl,
    createJsonRequest({ text: "message-2" }, "127.0.0.1"),
    secondResponse.raw,
    "test-rate-2",
  );
  assert.equal(secondResponse.state.statusCode, 200);

  const thirdResponse = createMockResponse();
  await (hubServer as any).handleApiRequest(
    "POST",
    parsedUrl,
    createJsonRequest({ text: "message-3" }, "127.0.0.1"),
    thirdResponse.raw,
    "test-rate-3",
  );
  assert.equal(thirdResponse.state.statusCode, 429);

  const payload = JSON.parse(thirdResponse.state.body);
  assert.equal(payload.error, "RATE_LIMITED");
  assert.equal(typeof payload.retryAfterMs, "number");
  assert.ok(payload.retryAfterMs > 0);
  assert.equal(capturedForwards.length, 2);
});

test("rate-limit budget is isolated per remote host", async () => {
  const bridgeId = "bridge_rate_limit_scope";
  const threadId = "thread_rate_limit_scope";
  const parsedUrl = new URL(
    `/api/v1/bridges/${encodeURIComponent(bridgeId)}/threads/${encodeURIComponent(threadId)}/message`,
    "http://127.0.0.1:7777",
  );

  // Consume full budget for host A.
  for (let index = 0; index < 3; index += 1) {
    const response = createMockResponse();
    await (hubServer as any).handleApiRequest(
      "POST",
      parsedUrl,
      createJsonRequest({ text: `host-a-${index}` }, "127.0.0.1"),
      response.raw,
      `test-rate-host-a-${index}`,
    );

    if (index < 2) {
      assert.equal(response.state.statusCode, 200);
    } else {
      assert.equal(response.state.statusCode, 429);
    }
  }

  // Another host should still be accepted.
  const hostBResponse = createMockResponse();
  await (hubServer as any).handleApiRequest(
    "POST",
    parsedUrl,
    createJsonRequest({ text: "host-b-0" }, "192.168.1.21"),
    hostBResponse.raw,
    "test-rate-host-b-0",
  );
  assert.equal(hostBResponse.state.statusCode, 200);
  assert.equal(capturedForwards.length, 3);
});

function createJsonRequest(body: Record<string, unknown>, remoteAddress: string): IncomingMessage {
  const payload = JSON.stringify(body);
  const readable = Readable.from([payload]);
  const request = readable as unknown as IncomingMessage;
  request.headers = { "content-type": "application/json" };
  request.method = "POST";
  request.url = "/";
  request.socket = { remoteAddress } as any;
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
