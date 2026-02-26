import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { AppServerStore } from "../appServerStore";
import { BridgeStoreError } from "../errors";
import { Logger, LoggerOutputChannel } from "../logger";
import { AppServerConfig, BridgeInfo, BridgeRuntimeConfig, TurnRecord } from "../types";

interface MockRpcCall {
  method: string;
  params: unknown;
}

interface MockRpcResponse {
  id: string | number;
  payload: unknown;
}

interface MockRpcErrorResponse {
  id: string | number;
  code: number;
  message: string;
  data?: unknown;
}

interface MockAppServerClient {
  requestCalls: MockRpcCall[];
  sendResponseCalls: MockRpcResponse[];
  sendErrorResponseCalls: MockRpcErrorResponse[];
  request(method: string, params?: unknown): Promise<any>;
  sendResponse(id: string | number, payload: unknown): void;
  sendErrorResponse(id: string | number, code: number, message: string, data?: unknown): void;
  stop(): Promise<void>;
}

const DEFAULT_APP_SERVER_CONFIG: AppServerConfig = {
  mode: "spawn",
  attachUrl: null,
  command: "codex",
  extraArgs: [],
  host: "127.0.0.1",
  startupTimeoutMs: 10_000,
  experimentalApi: true,
};

const BASE_BRIDGE_INFO: BridgeInfo = {
  bridgeId: "bridge_regression_test",
  workspaceName: "Regression Workspace",
  cwd: "/tmp/regression-workspace",
  port: 0,
  pid: 1,
  startedAt: new Date().toISOString(),
  bridgeVersion: "0.1.0-test",
};

let store: AppServerStore;
let mockAppServer: MockAppServerClient;
let turn: TurnRecord;

beforeEach(() => {
  mockAppServer = createMockAppServerClient();
  store = createStore({
    backendMode: "app-server",
    fullAccessAutoApprove: true,
    autoStartBridge: true,
  });
  injectAppServerClient(store, mockAppServer);

  turn = createTurn({
    turnId: "turn_regression",
    threadId: "thread_regression",
    status: "running",
    accessMode: "full-access",
  });
  seedTurn(store, turn);
});

test("interruptTurn sends RPC, marks turn interrupted, and clears active thread pointer", async () => {
  const result = await store.interruptTurn(turn.turnId);

  assert.equal(mockAppServer.requestCalls.length, 1);
  assert.equal(mockAppServer.requestCalls[0].method, "turn/interrupt");
  assert.deepEqual(mockAppServer.requestCalls[0].params, {
    threadId: turn.threadId,
    turnId: turn.turnId,
  });

  assert.equal(result.status, "interrupted");
  assert.notEqual(result.completedAt, null);
  assert.equal(getActiveTurnMap(store).has(turn.threadId), false);
  assert.equal(getTurnRecordMap(store).get(turn.turnId)?.status, "interrupted");
});

test("steerTurn rejects empty text with INVALID_INPUT", async () => {
  await assert.rejects(
    () => store.steerTurn(turn.turnId, { text: "   " }),
    (error: unknown) => {
      assert.ok(error instanceof BridgeStoreError);
      assert.equal(error.code, "INVALID_INPUT");
      return true;
    },
  );

  assert.equal(mockAppServer.requestCalls.length, 0);
});

test("steerTurn sends RPC payload and records steer history", async () => {
  const result = await store.steerTurn(turn.turnId, { text: "focus on tests first" });

  assert.equal(mockAppServer.requestCalls.length, 1);
  assert.equal(mockAppServer.requestCalls[0].method, "turn/steer");
  assert.deepEqual(mockAppServer.requestCalls[0].params, {
    threadId: turn.threadId,
    expectedTurnId: turn.turnId,
    input: [
      {
        type: "text",
        text: "focus on tests first",
        text_elements: [],
      },
    ],
  });

  assert.deepEqual(result.steerHistory, ["focus on tests first"]);
  assert.deepEqual(getTurnRecordMap(store).get(turn.turnId)?.steerHistory, ["focus on tests first"]);
});

test("decideApproval approve transitions waiting_approval -> running and clears pending map", async () => {
  turn.status = "waiting_approval";
  const approvalId = "approval_regression_approve";
  turn.approvals.push({
    approvalId,
    type: "commandExecution",
    status: "pending",
    requestedAt: new Date().toISOString(),
  });
  getPendingApprovalsMap(store).set(approvalId, {
    rpcId: "rpc-approve",
    turnId: turn.turnId,
    threadId: turn.threadId,
    kind: "commandExecution",
  });

  const result = await store.decideApproval(approvalId, "approve");

  assert.equal(mockAppServer.sendResponseCalls.length, 1);
  assert.deepEqual(mockAppServer.sendResponseCalls[0], {
    id: "rpc-approve",
    payload: {
      decision: "accept",
    },
  });

  assert.equal(getPendingApprovalsMap(store).has(approvalId), false);
  assert.equal(result.status, "running");
  assert.equal(result.approvals[0].status, "approved");
  assert.equal(result.approvals[0].decisionSource, "user");
});

test("decideApproval called twice for same approval yields one success and one NOT_FOUND", async () => {
  const approvalId = "approval_regression_race";
  turn.approvals.push({
    approvalId,
    type: "fileChange",
    status: "pending",
    requestedAt: new Date().toISOString(),
  });
  getPendingApprovalsMap(store).set(approvalId, {
    rpcId: "rpc-race",
    turnId: turn.turnId,
    threadId: turn.threadId,
    kind: "fileChange",
  });

  const [first, second] = await Promise.allSettled([
    store.decideApproval(approvalId, "approve"),
    store.decideApproval(approvalId, "deny"),
  ]);

  assert.equal(first.status, "fulfilled");
  assert.equal(second.status, "rejected");
  assert.ok(second.status === "rejected");
  assert.ok(second.reason instanceof BridgeStoreError);
  assert.equal((second.reason as BridgeStoreError).code, "NOT_FOUND");
});

test("server approval request auto-approves in full-access mode and emits event metadata", async () => {
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  const unsubscribe = store.onTurnEvent((event) => {
    events.push({ method: event.method, params: event.params });
  });

  const handled = await callOnAppServerRequest(store, {
    id: "rpc-auto",
    method: "item/commandExecution/requestApproval",
    params: {
      approvalId: "approval_auto",
      threadId: turn.threadId,
      turnId: turn.turnId,
      itemId: "item-1",
    },
  });

  unsubscribe();

  assert.equal(handled, true);
  assert.equal(mockAppServer.sendResponseCalls.length, 1);
  assert.deepEqual(mockAppServer.sendResponseCalls[0], {
    id: "rpc-auto",
    payload: {
      decision: "acceptForSession",
    },
  });

  assert.equal(getPendingApprovalsMap(store).has("approval_auto"), false);
  const approval = getTurnRecordMap(store).get(turn.turnId)?.approvals.find((item) => item.approvalId === "approval_auto");
  assert.equal(approval?.status, "approved");
  assert.equal(approval?.decisionSource, "session-auto");

  assert.equal(events.length, 1);
  assert.equal(events[0].method, "item/commandExecution/requestApproval");
  assert.equal(events[0].params.autoApproved, true);
});

test("server approval request in plan-only mode keeps pending approval until explicit decision", async () => {
  const planOnlyTurn = createTurn({
    turnId: "turn_plan_only",
    threadId: "thread_plan_only",
    status: "running",
    accessMode: "plan-only",
  });
  seedTurn(store, planOnlyTurn);

  const handled = await callOnAppServerRequest(store, {
    id: "rpc-manual",
    method: "item/fileChange/requestApproval",
    params: {
      approvalId: "approval_manual",
      threadId: planOnlyTurn.threadId,
      turnId: planOnlyTurn.turnId,
      itemId: "item-manual",
    },
  });

  assert.equal(handled, true);
  assert.equal(mockAppServer.sendResponseCalls.length, 0);
  assert.equal(getPendingApprovalsMap(store).has("approval_manual"), true);
  assert.equal(getTurnRecordMap(store).get(planOnlyTurn.turnId)?.status, "waiting_approval");
});

test("notification mapper marks turn as running and tracks active turn on turn/started", () => {
  callOnAppServerNotification(store, "turn/started", {
    threadId: turn.threadId,
    turn: {
      id: turn.turnId,
      status: "running",
    },
  });

  assert.equal(getTurnRecordMap(store).get(turn.turnId)?.status, "running");
  assert.equal(getActiveTurnMap(store).get(turn.threadId), turn.turnId);
});

test("notification mapper appends assistant delta on item/agentMessage/delta", () => {
  callOnAppServerNotification(store, "item/agentMessage/delta", {
    threadId: turn.threadId,
    turnId: turn.turnId,
    delta: "partial-stream",
  });

  assert.equal(getTurnRecordMap(store).get(turn.turnId)?.assistantText, "partial-stream");
});

test("notification mapper marks turn completed and clears active turn pointer on turn/completed", () => {
  callOnAppServerNotification(store, "turn/completed", {
    threadId: turn.threadId,
    turn: {
      id: turn.turnId,
      status: "completed",
    },
  });

  const updated = getTurnRecordMap(store).get(turn.turnId);
  assert.equal(updated?.status, "completed");
  assert.notEqual(updated?.completedAt, null);
  assert.equal(getActiveTurnMap(store).has(turn.threadId), false);
});

test("startTurn with draft thread id creates a brand new conversation thread", async () => {
  mockAppServer.request = async (method: string, params?: unknown): Promise<any> => {
    mockAppServer.requestCalls.push({ method, params });
    if (method === "thread/start") {
      return {
        thread: { id: "thread_new_from_draft" },
        turn: { id: "turn_new_from_draft" },
      };
    }

    throw new Error(`Unexpected RPC call: ${method}`);
  };

  const result = await store.startTurn("__draft_new_thread__bridge_test", {
    text: "new conversation from draft",
    accessMode: "full-access",
  });

  assert.equal(result.threadId, "thread_new_from_draft");
  assert.equal(result.turnId, "turn_new_from_draft");
  assert.equal(getActiveTurnMap(store).get("thread_new_from_draft"), "turn_new_from_draft");
  assert.equal(getTurnRecordMap(store).get("turn_new_from_draft")?.threadId, "thread_new_from_draft");
  assert.equal(mockAppServer.requestCalls[0]?.method, "thread/start");
});

test("draft thread fallback uses turn/start with explicit threadId when thread/start is unavailable", async () => {
  let fallbackThreadId = "";

  mockAppServer.request = async (method: string, params?: unknown): Promise<any> => {
    mockAppServer.requestCalls.push({ method, params });

    if (method === "thread/start") {
      throw new Error("Method not found: thread/start");
    }

    if (method === "turn/start") {
      const payload = params as { threadId?: string };
      fallbackThreadId = String(payload.threadId || "");
      assert.ok(fallbackThreadId.length > 0);
      return {
        turn: { id: "turn_new_from_turn_start_fallback" },
      };
    }

    if (method === "thread/list") {
      return { data: [] };
    }

    throw new Error(`Unexpected RPC call: ${method}`);
  };

  const result = await store.startTurn("__draft_new_thread__bridge_test", {
    text: "new conversation fallback",
    accessMode: "full-access",
  });

  assert.equal(result.turnId, "turn_new_from_turn_start_fallback");
  assert.equal(result.threadId, fallbackThreadId);
  assert.equal(getTurnRecordMap(store).get("turn_new_from_turn_start_fallback")?.threadId, fallbackThreadId);
  assert.equal(mockAppServer.requestCalls[0]?.method, "thread/start");
  assert.equal(mockAppServer.requestCalls[1]?.method, "turn/start");
  assert.equal(mockAppServer.requestCalls.filter((call) => call.method === "thread/list").length, 0);
});

test("draft thread fallback retries with explicit turn/start when thread/start reports busy", async () => {
  let fallbackThreadId = "";

  mockAppServer.request = async (method: string, params?: unknown): Promise<any> => {
    mockAppServer.requestCalls.push({ method, params });

    if (method === "thread/start") {
      throw new Error("Thread is busy with an active turn.");
    }

    if (method === "turn/start") {
      const payload = params as { threadId?: string };
      fallbackThreadId = String(payload.threadId || "");
      assert.ok(fallbackThreadId.length > 0);
      return {
        turn: { id: "turn_new_from_busy_fallback" },
      };
    }

    throw new Error(`Unexpected RPC call: ${method}`);
  };

  const result = await store.startTurn("__draft_new_thread__bridge_test", {
    text: "new conversation busy fallback",
    accessMode: "full-access",
  });

  assert.equal(result.turnId, "turn_new_from_busy_fallback");
  assert.equal(result.threadId, fallbackThreadId);
  assert.equal(getTurnRecordMap(store).get("turn_new_from_busy_fallback")?.threadId, fallbackThreadId);
  assert.equal(mockAppServer.requestCalls[0]?.method, "thread/start");
  assert.equal(mockAppServer.requestCalls[1]?.method, "turn/start");
});

function createStore(runtimeConfig: BridgeRuntimeConfig): AppServerStore {
  const logger = new Logger(createSilentLoggerChannel(), false);
  return new AppServerStore(
    { ...BASE_BRIDGE_INFO },
    runtimeConfig,
    { ...DEFAULT_APP_SERVER_CONFIG },
    logger,
    "0.1.0-test",
  );
}

function createSilentLoggerChannel(): LoggerOutputChannel {
  return {
    appendLine(): void {
      // Silence test logs.
    },
    show(): void {
      // No-op in tests.
    },
    dispose(): void {
      // No-op in tests.
    },
  };
}

function createMockAppServerClient(): MockAppServerClient {
  const requestCalls: MockRpcCall[] = [];
  const sendResponseCalls: MockRpcResponse[] = [];
  const sendErrorResponseCalls: MockRpcErrorResponse[] = [];

  return {
    requestCalls,
    sendResponseCalls,
    sendErrorResponseCalls,
    async request(method: string, params?: unknown): Promise<any> {
      requestCalls.push({ method, params });
      return {};
    },
    sendResponse(id: string | number, payload: unknown): void {
      sendResponseCalls.push({ id, payload });
    },
    sendErrorResponse(id: string | number, code: number, message: string, data?: unknown): void {
      sendErrorResponseCalls.push({ id, code, message, data });
    },
    async stop(): Promise<void> {
      // No-op in tests.
    },
  };
}

function injectAppServerClient(storeInstance: AppServerStore, mockClient: MockAppServerClient): void {
  (storeInstance as unknown as { appServer: MockAppServerClient }).appServer = mockClient;
}

function seedTurn(storeInstance: AppServerStore, turnRecord: TurnRecord): void {
  getTurnRecordMap(storeInstance).set(turnRecord.turnId, turnRecord);
  getActiveTurnMap(storeInstance).set(turnRecord.threadId, turnRecord.turnId);
}

function createTurn(args: {
  turnId: string;
  threadId: string;
  status: TurnRecord["status"];
  accessMode: TurnRecord["accessMode"];
}): TurnRecord {
  return {
    turnId: args.turnId,
    threadId: args.threadId,
    status: args.status,
    accessMode: args.accessMode,
    modelId: null,
    userText: "user text",
    assistantText: "",
    startedAt: new Date().toISOString(),
    completedAt: null,
    plan: [],
    diff: "",
    approvals: [],
    steerHistory: [],
  };
}

function getTurnRecordMap(storeInstance: AppServerStore): Map<string, TurnRecord> {
  return (storeInstance as unknown as { turnRecords: Map<string, TurnRecord> }).turnRecords;
}

function getActiveTurnMap(storeInstance: AppServerStore): Map<string, string> {
  return (storeInstance as unknown as { activeTurnByThread: Map<string, string> }).activeTurnByThread;
}

function getPendingApprovalsMap(storeInstance: AppServerStore): Map<string, unknown> {
  return (storeInstance as unknown as { pendingApprovals: Map<string, unknown> }).pendingApprovals;
}

async function callOnAppServerRequest(
  storeInstance: AppServerStore,
  request: {
    id: string | number;
    method: string;
    params: Record<string, unknown>;
  },
): Promise<boolean> {
  return (storeInstance as unknown as { onAppServerRequest: (request: unknown) => Promise<boolean> }).onAppServerRequest(request);
}

function callOnAppServerNotification(
  storeInstance: AppServerStore,
  method: string,
  params: Record<string, unknown>,
): void {
  (storeInstance as unknown as { onAppServerNotification: (method: string, params: unknown) => void }).onAppServerNotification(
    method,
    params,
  );
}
