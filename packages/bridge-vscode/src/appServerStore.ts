import { EventEmitter } from "events";
import { BridgeStoreError } from "./errors";
import { AppServerClient, AppServerRpcError, ServerRequestMessage } from "./appServerClient";
import { Logger } from "./logger";
import { BridgeStoreLike } from "./storeContracts";
import {
  AccessMode,
  AppServerConfig,
  ApprovalDecision,
  ApprovalRecord,
  BridgeEventEnvelope,
  BridgeInfo,
  BridgeMeta,
  BridgeRuntimeConfig,
  SendMessageRequest,
  SendMessageResponse,
  SteerRequest,
  ThreadDetail,
  ThreadMessage,
  ThreadSummary,
  TurnRecord,
  TurnStatus,
} from "./types";
import { newId, nowIso } from "./utils";

type ApprovalKind = "commandExecution" | "fileChange";
type RequestId = string | number;

interface PendingApproval {
  rpcId: RequestId;
  turnId: string;
  threadId: string;
  kind: ApprovalKind;
}

interface ThreadLike {
  id: string;
  preview?: string;
  createdAt?: number;
  updatedAt?: number;
  cwd?: string;
  turns?: unknown[];
}

interface TurnLike {
  id: string;
  status?: string;
  items?: unknown[];
}

interface TurnContext {
  threadId: string;
  turnId: string;
}

export class AppServerStore implements BridgeStoreLike {
  private readonly emitter = new EventEmitter();
  private readonly appServer: AppServerClient;

  private seq = 0;

  private readonly turnRecords = new Map<string, TurnRecord>();
  private readonly activeTurnByThread = new Map<string, string>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();

  public constructor(
    private readonly bridgeInfo: BridgeInfo,
    private readonly runtimeConfig: BridgeRuntimeConfig,
    appServerConfig: AppServerConfig,
    private readonly logger: Logger,
    extensionVersion: string,
  ) {
    this.appServer = new AppServerClient(
      appServerConfig,
      logger,
      {
        onNotification: (method, params) => {
          this.onAppServerNotification(method, params);
        },
        onServerRequest: (request) => {
          return this.onAppServerRequest(request);
        },
      },
      extensionVersion,
    );
  }

  public async start(): Promise<void> {
    await this.appServer.start();
  }

  public setPort(port: number): void {
    this.bridgeInfo.port = port;
  }

  public getBridgeMeta(): BridgeMeta {
    return {
      ...this.bridgeInfo,
      status: "online",
      heartbeatAt: nowIso(),
    };
  }

  public async listThreads(): Promise<ThreadSummary[]> {
    const response = await this.appServer.request<{ data: unknown[] }>("thread/list", {
      limit: 100,
      cwd: this.bridgeInfo.cwd,
      sourceKinds: ["vscode", "appServer"],
      archived: false,
      sortKey: "updated_at",
    });

    const items = Array.isArray(response?.data) ? response.data : [];

    return items
      .map((item) => this.mapThreadSummary(item))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  public async getThread(threadId: string): Promise<ThreadDetail> {
    // For explicit thread-open requests (UI selection), always read the exact ID
    // requested by the client. Alias resolution is only used for send/recovery
    // flows where stale IDs may need remapping after forced thread recreation.
    const thread = await this.readThread(threadId, true);

    const summary = this.mapThreadSummary(thread);
    const turns: TurnRecord[] = [];
    const messages: ThreadMessage[] = [];

    const threadTurns = Array.isArray(thread.turns) ? thread.turns : [];
    for (const rawTurn of threadTurns) {
      const turn = this.mapThreadTurn(rawTurn, summary);
      turns.push(turn);

      const turnMessages = this.mapMessagesFromTurn(rawTurn, turn.turnId);
      messages.push(...turnMessages);

      const existing = this.turnRecords.get(turn.turnId);
      if (!existing) {
        this.turnRecords.set(turn.turnId, turn);
      }
    }

    return {
      thread: summary,
      messages,
      turns,
    };
  }

  public async startTurn(threadId: string, request: SendMessageRequest): Promise<SendMessageResponse> {
    const text = (request.text ?? "").trim();
    if (!text) {
      throw new BridgeStoreError("INVALID_INPUT", "Message text is required.");
    }

    const accessMode: AccessMode = request.accessMode ?? "full-access";
    const actualThreadId = threadId;

    // Always target the exact thread selected by the client.
    // If it is temporarily unloaded, readThread() handles a resume/read retry.
    await this.readThread(actualThreadId, false);
    await this.prepareThreadAccessMode(actualThreadId, accessMode);

    let turnStartResponse: { turn: { id: string } };
    try {
      turnStartResponse = await this.requestTurnStart(actualThreadId, text, request.modelId, accessMode);
    } catch (error) {
      if (isThreadNotLoadedError(error) || isThreadNotFoundError(error)) {
        // Try one explicit resume+retry before failing. Do not silently switch thread IDs.
        await this.resumeThread(actualThreadId, accessMode);
        turnStartResponse = await this.requestTurnStart(actualThreadId, text, request.modelId, accessMode);
      } else {
        throw this.mapBackendError(error);
      }
    }

    const turnId = String(turnStartResponse.turn.id);

    const existing = this.turnRecords.get(turnId);
    if (!existing) {
      this.turnRecords.set(turnId, {
        turnId,
        threadId: actualThreadId,
        status: "running",
        accessMode,
        modelId: request.modelId ?? null,
        userText: text,
        assistantText: "",
        startedAt: nowIso(),
        completedAt: null,
        plan: [],
        diff: "",
        approvals: [],
        steerHistory: [],
      });
    }

    this.activeTurnByThread.set(actualThreadId, turnId);

    return {
      turnId,
      threadId: actualThreadId,
    };
  }

  private async requestTurnStart(
    threadId: string,
    text: string,
    modelId: string | null | undefined,
    accessMode: AccessMode,
  ): Promise<{ turn: { id: string } }> {
    const baseParams = {
      threadId,
      input: [
        {
          type: "text",
          text,
          text_elements: [],
        },
      ],
      approvalPolicy: this.approvalPolicyFor(accessMode),
      model: modelId ?? undefined,
    };

    try {
      return await this.appServer.request<{ turn: { id: string } }>("turn/start", {
        ...baseParams,
        // Some app-server sessions can remain read-only unless sandbox is explicit
        // at turn start, even when access mode is full-access.
        sandbox: "workspace-write",
      });
    } catch (error) {
      // Keep compatibility with runtimes that reject unknown/unsupported fields.
      const message = lowerCaseErrorMessage(error);
      if (
        message.includes("sandbox") &&
        (message.includes("invalid") || message.includes("unknown") || message.includes("not allowed"))
      ) {
        return this.appServer.request<{ turn: { id: string } }>("turn/start", baseParams);
      }

      throw error;
    }
  }

  public async interruptTurn(turnId: string): Promise<TurnRecord> {
    const turn = this.requireTurn(turnId);

    await this.appServer.request<Record<string, never>>("turn/interrupt", {
      threadId: turn.threadId,
      turnId,
    });

    turn.status = "interrupted";
    turn.completedAt = nowIso();
    this.activeTurnByThread.delete(turn.threadId);

    return cloneTurn(turn);
  }

  public async steerTurn(turnId: string, request: SteerRequest): Promise<TurnRecord> {
    const turn = this.requireTurn(turnId);
    const text = (request.text ?? "").trim();

    if (!text) {
      throw new BridgeStoreError("INVALID_INPUT", "Steer text is required.");
    }

    await this.appServer.request<{ turnId: string }>("turn/steer", {
      threadId: turn.threadId,
      expectedTurnId: turn.turnId,
      input: [
        {
          type: "text",
          text,
          text_elements: [],
        },
      ],
    });

    turn.steerHistory.push(text);
    return cloneTurn(turn);
  }

  public async decideApproval(approvalId: string, decision: ApprovalDecision): Promise<TurnRecord> {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) {
      throw new BridgeStoreError("NOT_FOUND", `Approval ${approvalId} was not found.`);
    }

    const turn = this.requireTurn(pending.turnId);

    const approvalRecord = turn.approvals.find((approval) => approval.approvalId === approvalId);
    if (!approvalRecord) {
      throw new BridgeStoreError("NOT_FOUND", `Approval ${approvalId} does not exist in turn ${turn.turnId}.`);
    }

    if (approvalRecord.status !== "pending") {
      throw new BridgeStoreError("INVALID_STATE", `Approval ${approvalId} is not pending.`);
    }

    if (pending.kind === "commandExecution") {
      this.appServer.sendResponse(pending.rpcId, {
        decision: decision === "approve" ? "accept" : "decline",
      });
    } else {
      this.appServer.sendResponse(pending.rpcId, {
        decision: decision === "approve" ? "accept" : "decline",
      });
    }

    this.pendingApprovals.delete(approvalId);
    approvalRecord.status = decision === "approve" ? "approved" : "denied";
    approvalRecord.decidedAt = nowIso();
    approvalRecord.decisionSource = "user";

    if (decision === "approve" && turn.status === "waiting_approval") {
      turn.status = "running";
    }

    return cloneTurn(turn);
  }

  public createHelloEvent(turnId: string): BridgeEventEnvelope {
    const turn = this.requireTurn(turnId);
    return this.buildEnvelope(turn.threadId, turnId, "hub/hello", {
      message: "bridge stream connected",
    });
  }

  public createStateEvent(turnId: string): BridgeEventEnvelope {
    const turn = this.requireTurn(turnId);
    return this.buildEnvelope(turn.threadId, turnId, "hub/state", {
      turn: cloneTurn(turn),
    });
  }

  public onTurnEvent(listener: (event: BridgeEventEnvelope) => void): () => void {
    this.emitter.on("turn-event", listener);
    return () => this.emitter.off("turn-event", listener);
  }

  public async dispose(): Promise<void> {
    this.emitter.removeAllListeners();
    await this.appServer.stop();
  }

  private async readThread(threadId: string, includeTurns: boolean): Promise<ThreadLike> {
    try {
      const response = await this.appServer.request<{ thread: ThreadLike }>("thread/read", {
        threadId,
        includeTurns,
      });

      return response.thread;
    } catch (error) {
      if (isThreadNotLoadedError(error)) {
        await this.resumeThread(threadId, "full-access");

        const response = await this.appServer.request<{ thread: ThreadLike }>("thread/read", {
          threadId,
          includeTurns,
        });
        return response.thread;
      }

      throw this.mapBackendError(error);
    }
  }

  private mapBackendError(error: unknown): BridgeStoreError {
    if (error instanceof BridgeStoreError) {
      return error;
    }

    const lowerMessage = lowerCaseErrorMessage(error);

    if (error instanceof AppServerRpcError) {
      if (lowerMessage.includes("invalid thread id") || lowerMessage.includes("thread not loaded") || lowerMessage.includes("not found")) {
        return new BridgeStoreError("NOT_FOUND", error.message);
      }

      if (lowerMessage.includes("already running") || lowerMessage.includes("in progress") || lowerMessage.includes("busy")) {
        return new BridgeStoreError("BUSY", error.message);
      }

      if (error.code === -32600) {
        return new BridgeStoreError("INVALID_INPUT", error.message);
      }

      return new BridgeStoreError("INVALID_STATE", error.message);
    }

    if (lowerMessage.includes("invalid thread id") || lowerMessage.includes("thread not loaded") || lowerMessage.includes("not found")) {
      return new BridgeStoreError("NOT_FOUND", formatBackendErrorMessage(error));
    }

    if (lowerMessage.includes("already running") || lowerMessage.includes("in progress") || lowerMessage.includes("busy")) {
      return new BridgeStoreError("BUSY", formatBackendErrorMessage(error));
    }

    return new BridgeStoreError("INVALID_STATE", String(error));
  }

  private async prepareThreadAccessMode(threadId: string, accessMode: AccessMode): Promise<void> {
    if (accessMode !== "full-access") {
      return;
    }

    await this.resumeThread(threadId, accessMode);
  }

  private async resumeThread(threadId: string, accessMode: AccessMode): Promise<void> {
    const baseParams = {
      threadId,
      persistExtendedHistory: true,
    };

    const sandbox = accessMode === "full-access" ? "workspace-write" : undefined;
    if (!sandbox) {
      await this.appServer.request("thread/resume", baseParams);
      return;
    }

    try {
      await this.appServer.request("thread/resume", {
        ...baseParams,
        sandbox,
      });
    } catch (error) {
      const message = lowerCaseErrorMessage(error);
      if (
        message.includes("sandbox") &&
        (message.includes("invalid") || message.includes("unknown") || message.includes("not allowed"))
      ) {
        await this.appServer.request("thread/resume", baseParams);
        return;
      }
      throw error;
    }
  }

  private approvalPolicyFor(accessMode: AccessMode): "on-request" | "never" {
    if (accessMode === "plan-only") {
      return "on-request";
    }

    return this.runtimeConfig.fullAccessAutoApprove ? "never" : "on-request";
  }

  private onAppServerNotification(method: string, params: unknown): void {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      return;
    }

    const context = this.extractNotificationContext(method, params as Record<string, unknown>);
    if (!context) {
      this.logger.debug(`Ignoring app-server notification without context: ${method}`);
      return;
    }

    const turn = this.ensureTurnRecord(context.turnId, context.threadId);
    this.updateTurnRecordFromNotification(turn, method, params as Record<string, unknown>);

    this.emitter.emit(
      "turn-event",
      this.buildEnvelope(context.threadId, context.turnId, method, params as Record<string, unknown>),
    );
  }

  private async onAppServerRequest(request: ServerRequestMessage): Promise<boolean> {
    const params = asObject(request.params);

    if (request.method === "item/commandExecution/requestApproval" || request.method === "item/fileChange/requestApproval") {
      const threadId = asString(params.threadId);
      const turnId = asString(params.turnId);
      const itemId = asString(params.itemId);

      if (!threadId || !turnId || !itemId) {
        this.appServer.sendErrorResponse(request.id, -32602, "Approval request missing threadId/turnId/itemId");
        return true;
      }

      const kind: ApprovalKind = request.method === "item/commandExecution/requestApproval" ? "commandExecution" : "fileChange";
      const providedApprovalId = asString(params.approvalId);
      const approvalId = providedApprovalId || newId("approval");

      const turn = this.ensureTurnRecord(turnId, threadId);
      this.upsertApproval(turn, approvalId, kind, "pending");

      const autoApprove = turn.accessMode === "full-access" && this.runtimeConfig.fullAccessAutoApprove;
      this.pendingApprovals.set(approvalId, {
        rpcId: request.id,
        turnId,
        threadId,
        kind,
      });

      this.emitter.emit(
        "turn-event",
        this.buildEnvelope(threadId, turnId, request.method, {
          ...params,
          approvalId,
          autoApproved: autoApprove,
        }),
      );

      if (autoApprove) {
        this.appServer.sendResponse(request.id, {
          decision: "acceptForSession",
        });

        this.pendingApprovals.delete(approvalId);
        this.upsertApproval(turn, approvalId, kind, "approved", "session-auto");
      } else {
        turn.status = "waiting_approval";
      }

      return true;
    }

    if (request.method === "item/tool/requestUserInput") {
      const context = this.extractNotificationContext(request.method, params);
      if (context) {
        this.ensureTurnRecord(context.turnId, context.threadId);
        this.emitter.emit("turn-event", this.buildEnvelope(context.threadId, context.turnId, request.method, params));
      }

      this.appServer.sendResponse(request.id, {
        answers: {},
      });
      return true;
    }

    if (request.method === "item/tool/call") {
      const context = this.extractNotificationContext(request.method, params);
      if (context) {
        this.ensureTurnRecord(context.turnId, context.threadId);
        this.emitter.emit("turn-event", this.buildEnvelope(context.threadId, context.turnId, request.method, params));
      }

      this.appServer.sendResponse(request.id, {
        contentItems: [
          {
            type: "input_text",
            text: "Dynamic tool calls are not implemented in bridge yet.",
          },
        ],
        success: false,
      });
      return true;
    }

    return false;
  }

  private upsertApproval(
    turn: TurnRecord,
    approvalId: string,
    kind: ApprovalKind,
    status: ApprovalRecord["status"],
    decisionSource?: ApprovalRecord["decisionSource"],
  ): void {
    let approval = turn.approvals.find((item) => item.approvalId === approvalId);
    if (!approval) {
      approval = {
        approvalId,
        type: kind,
        status,
        requestedAt: nowIso(),
      };
      turn.approvals.push(approval);
    }

    approval.status = status;

    if (status !== "pending") {
      approval.decidedAt = nowIso();
      approval.decisionSource = decisionSource ?? approval.decisionSource ?? "user";
    }
  }

  private extractNotificationContext(
    method: string,
    params: Record<string, unknown>,
  ): TurnContext | null {
    if (method === "turn/started" || method === "turn/completed") {
      const turn = asObject(params.turn);
      const context = this.resolveTurnContext({
        threadId: pickString(params, ["threadId", "thread_id"]),
        turnId: pickString(turn, ["id", "turnId", "turn_id"]),
      });
      if (context) {
        return context;
      }
    }

    const candidates: Array<{ threadId: string | null; turnId: string | null }> = [
      {
        threadId: pickString(params, ["threadId", "thread_id"]),
        turnId: pickString(params, ["turnId", "turn_id"]),
      },
      (() => {
        const context = asObject(params.context);
        return {
          threadId: pickString(context, ["threadId", "thread_id"]),
          turnId: pickString(context, ["turnId", "turn_id"]),
        };
      })(),
      (() => {
        const turn = asObject(params.turn);
        return {
          threadId: pickString(turn, ["threadId", "thread_id"]),
          turnId: pickString(turn, ["id", "turnId", "turn_id"]),
        };
      })(),
      (() => {
        const item = asObject(params.item);
        return {
          threadId: pickString(item, ["threadId", "thread_id"]),
          turnId: pickString(item, ["turnId", "turn_id"]),
        };
      })(),
      (() => {
        const event = asObject(params.event);
        return {
          threadId: pickString(event, ["threadId", "thread_id"]),
          turnId: pickString(event, ["turnId", "turn_id"]),
        };
      })(),
      (() => {
        const eventContext = asObject(asObject(params.event).context);
        return {
          threadId: pickString(eventContext, ["threadId", "thread_id"]),
          turnId: pickString(eventContext, ["turnId", "turn_id"]),
        };
      })(),
      (() => {
        const eventParams = asObject(asObject(params.event).params);
        return {
          threadId: pickString(eventParams, ["threadId", "thread_id"]),
          turnId: pickString(eventParams, ["turnId", "turn_id"]),
        };
      })(),
      (() => {
        const eventTurn = asObject(asObject(asObject(params.event).params).turn);
        return {
          threadId: pickString(eventTurn, ["threadId", "thread_id"]),
          turnId: pickString(eventTurn, ["id", "turnId", "turn_id"]),
        };
      })(),
    ];

    for (const candidate of candidates) {
      const resolved = this.resolveTurnContext(candidate);
      if (resolved) {
        return resolved;
      }
    }

    return null;
  }

  private resolveTurnContext(input: { threadId: string | null; turnId: string | null }): TurnContext | null {
    let threadId = input.threadId;
    let turnId = input.turnId;

    if (!turnId && threadId) {
      turnId = this.activeTurnByThread.get(threadId) ?? this.findMostRecentTurnIdForThread(threadId);
    }

    if (!threadId && turnId) {
      threadId = this.turnRecords.get(turnId)?.threadId ?? null;
    }

    if (!threadId || !turnId) {
      return null;
    }

    return {
      threadId,
      turnId,
    };
  }

  private findMostRecentTurnIdForThread(threadId: string): string | null {
    let newest: TurnRecord | null = null;

    for (const turn of this.turnRecords.values()) {
      if (turn.threadId !== threadId) {
        continue;
      }

      if (!newest || turn.startedAt > newest.startedAt) {
        newest = turn;
      }
    }

    return newest?.turnId ?? null;
  }

  private updateTurnRecordFromNotification(
    turn: TurnRecord,
    method: string,
    params: Record<string, unknown>,
  ): void {
    if (method === "turn/started") {
      const turnObj = asObject(params.turn);
      turn.status = mapAppTurnStatus(pickString(turnObj, ["status"]) ?? pickString(params, ["status"]), "running");
      this.activeTurnByThread.set(turn.threadId, turn.turnId);
      return;
    }

    if (method === "turn/completed") {
      const turnObj = asObject(params.turn);
      turn.status = mapAppTurnStatus(pickString(turnObj, ["status"]) ?? pickString(params, ["status"]), "completed");
      turn.completedAt = nowIso();
      this.activeTurnByThread.delete(turn.threadId);
      return;
    }

    if (method === "turn/diff/updated") {
      turn.diff = asString(params.diff) ?? "";
      return;
    }

    if (method === "turn/plan/updated") {
      const planRaw = Array.isArray(params.plan) ? params.plan : [];
      turn.plan = planRaw
        .map((step) => {
          const stepObj = asObject(step);
          const stepText = asString(stepObj.step);
          const status = asString(stepObj.status);

          if (!stepText || !status) {
            return null;
          }

          return {
            id: newId("plan"),
            text: stepText,
            status: mapPlanStatus(status),
          };
        })
        .filter((item): item is TurnRecord["plan"][number] => Boolean(item));
      return;
    }

    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      const kind: ApprovalKind = method === "item/commandExecution/requestApproval" ? "commandExecution" : "fileChange";
      const approvalId = pickString(params, ["approvalId", "approval_id"]) ?? newId("approval");
      this.upsertApproval(turn, approvalId, kind, "pending");
      turn.status = "waiting_approval";
      return;
    }

    if (method === "item/agentMessage/delta") {
      const delta = asString(params.delta) ?? "";
      turn.assistantText += delta;
      return;
    }

    const genericDelta = asString(params.delta);
    if (
      genericDelta &&
      (method.endsWith("/delta") || method.includes("delta")) &&
      (method.includes("message") || method.includes("assistant") || method.includes("agent"))
    ) {
      turn.assistantText += genericDelta;
      return;
    }

    if (method === "item/completed") {
      const item = asObject(params.item);
      if (asString(item.type) === "agentMessage") {
        turn.assistantText = asString(item.text) ?? turn.assistantText;
      }
    }
  }

  private ensureTurnRecord(turnId: string, threadId: string): TurnRecord {
    const existing = this.turnRecords.get(turnId);
    if (existing) {
      return existing;
    }

    const created: TurnRecord = {
      turnId,
      threadId,
      status: "running",
      accessMode: "full-access",
      modelId: null,
      userText: "",
      assistantText: "",
      startedAt: nowIso(),
      completedAt: null,
      plan: [],
      diff: "",
      approvals: [],
      steerHistory: [],
    };

    this.turnRecords.set(turnId, created);
    return created;
  }

  private mapThreadSummary(rawThread: unknown): ThreadSummary {
    const thread = asObject(rawThread);
    const threadId = asString(thread.id) ?? "unknown-thread";

    const preview = (asString(thread.preview) ?? "").trim();
    const title = preview.length > 0 ? preview : `Thread ${threadId.slice(0, 8)}`;

    const createdAt = unixToIso(asNumber(thread.createdAt));
    const updatedAt = unixToIso(asNumber(thread.updatedAt));
    const rawTurns = Array.isArray(thread.turns) ? thread.turns : [];
    const activeFromMap = this.activeTurnByThread.get(threadId) ?? null;
    const activeFromThread =
      pickString(thread, ["activeTurnId", "active_turn_id", "currentTurnId", "current_turn_id"]) ??
      pickString(asObject(thread.activeTurn), ["id", "turnId", "turn_id"]);

    let activeTurnId: string | null = null;

    if (activeFromMap) {
      const mappedRawTurn = findRawTurnById(rawTurns, activeFromMap);
      const mappedRawStatus = asString(asObject(mappedRawTurn).status);
      const mappedTrackedStatus = this.turnRecords.get(activeFromMap)?.status;

      if (isActiveRawTurnStatus(mappedRawStatus) || isActiveTurnStatus(mappedTrackedStatus)) {
        activeTurnId = activeFromMap;
      } else {
        this.activeTurnByThread.delete(threadId);
      }
    }

    if (!activeTurnId && activeFromThread) {
      const hintedRawTurn = findRawTurnById(rawTurns, activeFromThread);
      const hintedRawStatus = asString(asObject(hintedRawTurn).status);

      if (!hintedRawTurn || isActiveRawTurnStatus(hintedRawStatus)) {
        activeTurnId = activeFromThread;
      }
    }

    if (!activeTurnId) {
      for (const rawTurn of rawTurns) {
        const turnObj = asObject(rawTurn);
        const candidateId = asString(turnObj.id);
        if (!candidateId) {
          continue;
        }

        if (isActiveRawTurnStatus(asString(turnObj.status))) {
          activeTurnId = candidateId;
          break;
        }
      }
    }

    if (activeTurnId) {
      this.activeTurnByThread.set(threadId, activeTurnId);
    } else {
      this.activeTurnByThread.delete(threadId);
    }

    let status: ThreadSummary["status"] = "idle";
    if (activeTurnId) {
      const trackedStatus = this.turnRecords.get(activeTurnId)?.status;
      if (isActiveTurnStatus(trackedStatus)) {
        status = trackedStatus;
      } else {
        const rawActiveTurn = findRawTurnById(rawTurns, activeTurnId);
        status = mapAppTurnStatus(asString(asObject(rawActiveTurn).status), "running");
      }
    }

    return {
      threadId,
      title,
      createdAt,
      updatedAt,
      status,
      activeTurnId,
    };
  }

  private mapThreadTurn(rawTurn: unknown, summary: ThreadSummary): TurnRecord {
    const turnObj = asObject(rawTurn);
    const turnId = asString(turnObj.id) ?? newId("turn");
    const hasCompletionHint = Boolean(asNumber(turnObj.completedAt) || asNumber(turnObj.endedAt) || asNumber(turnObj.finishedAt));
    const isActiveTurn = summary.activeTurnId === turnId;

    let fallbackStatus: TurnStatus = "completed";
    if (!hasCompletionHint && isActiveTurn) {
      fallbackStatus = summary.status === "waiting_approval" ? "waiting_approval" : "running";
    }

    let status = mapAppTurnStatus(asString(turnObj.status), fallbackStatus);

    // Some app-server snapshots can lag and still report the active turn as completed
    // while thread summary already marks it running/waiting. Keep both views consistent.
    if (isActiveTurn && !isActiveTurnStatus(status)) {
      status = summary.status === "waiting_approval" ? "waiting_approval" : "running";
    }

    const messages = this.mapMessagesFromTurn(rawTurn, turnId);
    const userText = messages.find((message) => message.role === "user")?.text ?? "";
    const assistantText = messages.filter((message) => message.role === "assistant").map((message) => message.text).join("\n\n");

    return {
      turnId,
      threadId: summary.threadId,
      status,
      accessMode: "full-access",
      modelId: null,
      userText,
      assistantText,
      startedAt: summary.updatedAt,
      completedAt: isActiveTurnStatus(status) ? null : summary.updatedAt,
      plan: [],
      diff: "",
      approvals: [],
      steerHistory: [],
    };
  }

  private mapMessagesFromTurn(rawTurn: unknown, turnId: string): ThreadMessage[] {
    const turnObj = asObject(rawTurn);
    const items = Array.isArray(turnObj.items) ? turnObj.items : [];

    const messages: ThreadMessage[] = [];
    for (const rawItem of items) {
      const item = asObject(rawItem);
      const type = asString(item.type);

      if (type === "userMessage") {
        const content = Array.isArray(item.content) ? item.content : [];
        const text = content
          .map((entry) => asString(asObject(entry).text) ?? "")
          .filter((value) => value.length > 0)
          .join("\n");

        if (text) {
          messages.push({
            role: "user",
            text,
            ts: nowIso(),
            turnId,
            kind: "message",
          });
        }
      }

      if (type === "agentMessage") {
        const text = asString(item.text) ?? "";
        messages.push({
          role: "assistant",
          text,
          ts: nowIso(),
          turnId,
          kind: "message",
        });
      }

      const intermediate = summarizeIntermediateItem(type, item);
      if (intermediate) {
        messages.push({
          role: "system",
          text: intermediate,
          ts: nowIso(),
          turnId,
          kind: "message",
        });
      }
    }

    return messages;
  }

  private requireTurn(turnId: string): TurnRecord {
    const turn = this.turnRecords.get(turnId);
    if (!turn) {
      throw new BridgeStoreError("NOT_FOUND", `Turn ${turnId} was not found.`);
    }
    return turn;
  }

  private buildEnvelope(
    threadId: string,
    turnId: string,
    method: string,
    params: Record<string, unknown>,
  ): BridgeEventEnvelope {
    this.seq += 1;

    return {
      v: 1,
      seq: this.seq,
      ts: nowIso(),
      bridge: {
        bridgeId: this.bridgeInfo.bridgeId,
        workspaceName: this.bridgeInfo.workspaceName,
        cwd: this.bridgeInfo.cwd,
      },
      context: {
        threadId,
        turnId,
      },
      method,
      params,
    };
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pickString(value: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const candidate = asString(value[key]);
    if (candidate && candidate.trim().length > 0) {
      return candidate;
    }
  }

  return null;
}

function summarizeIntermediateItem(type: string | null, item: Record<string, unknown>): string | null {
  if (!type || type === "userMessage" || type === "agentMessage") {
    return null;
  }

  const normalizedType = type.toLowerCase();

  if (normalizedType === "reasoning") {
    const summaryLines = extractReasoningSummary(item);
    if (summaryLines.length > 0) {
      return summaryLines.join("\n");
    }
  }

  if (normalizedType === "commandexecution" || normalizedType === "command_execution") {
    const command =
      asString(item.command) ||
      asString(item.commandLine) ||
      asString(item.description) ||
      asString(asObject(item.command).raw) ||
      "command";
    const status = asString(item.status)?.trim().toLowerCase() ?? "";
    const exitCode = asNumber(item.exitCode);

    const lines: string[] = [];
    if (status === "completed") {
      lines.push(`Background terminal finished with ${command}`);
    } else if (status === "inprogress" || status === "in_progress" || status === "running") {
      lines.push(`Background terminal started with ${command}`);
    } else {
      lines.push(`[command] ${command}`);
    }

    if (exitCode !== null) {
      lines.push(`exit code: ${exitCode}`);
    }

    const aggregatedOutput = asString(item.aggregatedOutput);
    if (aggregatedOutput) {
      lines.push(`output:\n${trimText(aggregatedOutput, 260)}`);
    } else {
      const stdout = asString(item.stdout);
      if (stdout) {
        lines.push(`stdout:\n${trimText(stdout, 220)}`);
      }

      const stderr = asString(item.stderr);
      if (stderr) {
        lines.push(`stderr:\n${trimText(stderr, 220)}`);
      }
    }

    const commandActionSummary = summarizeCommandActions(item.commandActions);
    if (commandActionSummary) {
      lines.push(commandActionSummary);
    }

    return lines.join("\n");
  }

  if (normalizedType === "filechange" || normalizedType === "file_change") {
    const files = Array.isArray(item.files) ? item.files : [];
    if (files.length === 0) {
      return "[file-change] applied file updates";
    }

    const names = files
      .map((entry) => {
        const obj = asObject(entry);
        return asString(obj.path) || asString(obj.filePath) || asString(obj.file) || null;
      })
      .filter((value): value is string => Boolean(value));

    if (names.length === 0) {
      return `[file-change] ${files.length} file(s) updated`;
    }

    return `[file-change] ${names.slice(0, 6).join(", ")}${names.length > 6 ? ", ..." : ""}`;
  }

  if (normalizedType === "toolcall" || normalizedType === "tool_call") {
    const tool = asString(item.toolName) || asString(asObject(item.tool).name) || "tool";
    return `[tool] ${tool}`;
  }

  const directText =
    asString(item.text) ||
    asString(item.message) ||
    asString(item.summary) ||
    extractTextFromContent(item.content) ||
    extractTextFromContent(item.output) ||
    null;

  if (directText) {
    return `[${type}] ${trimText(directText, 260)}`;
  }

  return null;
}

function extractTextFromContent(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const parts: string[] = [];
  for (const entry of value) {
    const object = asObject(entry);
    const text = asString(object.text) || asString(object.value) || asString(object.content);
    if (text && text.trim().length > 0) {
      parts.push(text.trim());
    }
  }

  if (parts.length === 0) {
    return null;
  }

  return parts.join("\n");
}

function extractReasoningSummary(item: Record<string, unknown>): string[] {
  const summary = item.summary;
  if (!Array.isArray(summary)) {
    return [];
  }

  return summary
    .map((entry) => {
      if (typeof entry !== "string") {
        return "";
      }

      return stripMarkdownEmphasis(entry).trim();
    })
    .filter((entry) => entry.length > 0);
}

function summarizeCommandActions(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  const readCount = countActions(value, "read");
  const searchCount = countActions(value, "search");

  const lines: string[] = [];
  if (readCount > 0) {
    lines.push(`Explorado(s) ${readCount} archivo${readCount === 1 ? "" : "s"}`);
  }

  if (searchCount > 0) {
    lines.push(`Explorado(s) ${searchCount} búsqueda${searchCount === 1 ? "" : "s"}`);
  }

  if (lines.length === 0) {
    return null;
  }

  return lines.join("\n");
}

function countActions(actions: unknown[], expectedType: string): number {
  let total = 0;
  for (const entry of actions) {
    const action = asObject(entry);
    const type = asString(action.type)?.trim().toLowerCase() ?? "";
    if (type === expectedType) {
      total += 1;
    }
  }

  return total;
}

function stripMarkdownEmphasis(value: string): string {
  return value.replace(/\*\*([^*]+)\*\*/g, "$1");
}

function trimText(value: string, maxLength: number): string {
  const compact = value.trim();
  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, maxLength)}...`;
}

function isActiveRawTurnStatus(status: string | null): boolean {
  if (!status) {
    return false;
  }

  const normalized = status.trim().toLowerCase();
  return (
    normalized === "running" ||
    normalized === "inprogress" ||
    normalized === "in_progress" ||
    normalized === "waiting_approval" ||
    normalized === "waitingapproval" ||
    normalized === "awaiting_approval" ||
    normalized === "requiresapproval" ||
    normalized === "needsapproval" ||
    normalized === "started" ||
    normalized === "queued" ||
    normalized === "pending" ||
    normalized === "executing"
  );
}

function findRawTurnById(turns: unknown[], turnId: string): unknown | null {
  for (const rawTurn of turns) {
    const object = asObject(rawTurn);
    if (asString(object.id) === turnId) {
      return rawTurn;
    }
  }

  return null;
}

function isActiveTurnStatus(status: TurnStatus | undefined): status is "running" | "waiting_approval" {
  return status === "running" || status === "waiting_approval";
}

function unixToIso(value: number | null): string {
  if (!value || value <= 0) {
    return nowIso();
  }
  return new Date(value * 1000).toISOString();
}

function mapAppTurnStatus(status: string | null, fallback: TurnStatus = "running"): TurnStatus {
  if (!status) {
    return fallback;
  }

  const normalized = status.trim().toLowerCase();
  if (normalized.length === 0) {
    return fallback;
  }

  if (
    normalized === "completed" ||
    normalized === "complete" ||
    normalized === "done" ||
    normalized === "succeeded" ||
    normalized === "success" ||
    normalized === "finished"
  ) {
    return "completed";
  }

  if (
    normalized === "interrupted" ||
    normalized === "interrupt" ||
    normalized === "cancelled" ||
    normalized === "canceled" ||
    normalized === "aborted" ||
    normalized === "stopped"
  ) {
    return "interrupted";
  }

  if (normalized === "failed" || normalized === "error" || normalized === "errored") {
    return "failed";
  }

  if (
    normalized === "waiting_approval" ||
    normalized === "waitingapproval" ||
    normalized === "requiresapproval" ||
    normalized === "awaiting_approval" ||
    normalized === "needsapproval"
  ) {
    return "waiting_approval";
  }

  if (
    normalized === "inprogress" ||
    normalized === "in_progress" ||
    normalized === "running" ||
    normalized === "started" ||
    normalized === "pending" ||
    normalized === "queued" ||
    normalized === "executing"
  ) {
    return "running";
  }

  return fallback;
}

function mapPlanStatus(status: string): TurnRecord["plan"][number]["status"] {
  switch (status) {
    case "completed":
      return "completed";
    case "inProgress":
      return "in_progress";
    default:
      return "pending";
  }
}

function isThreadNotFoundError(error: unknown): boolean {
  const message = lowerCaseErrorMessage(error);
  if (!message) {
    return false;
  }

  return message.includes("thread not found") || message.includes("invalid thread id") || message.includes("not found");
}

function isThreadNotLoadedError(error: unknown): boolean {
  const message = lowerCaseErrorMessage(error);
  return Boolean(message) && message.includes("thread not loaded");
}

function lowerCaseErrorMessage(error: unknown): string {
  if (error instanceof AppServerRpcError) {
    return error.message.toLowerCase();
  }

  if (error instanceof Error) {
    return error.message.toLowerCase();
  }

  if (typeof error === "string") {
    return error.toLowerCase();
  }

  return "";
}

function formatBackendErrorMessage(error: unknown): string {
  if (error instanceof AppServerRpcError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return String(error);
}

function cloneTurn(turn: TurnRecord): TurnRecord {
  return {
    ...turn,
    plan: turn.plan.map((item) => ({ ...item })),
    approvals: turn.approvals.map((item) => ({ ...item })),
    steerHistory: [...turn.steerHistory],
  };
}
