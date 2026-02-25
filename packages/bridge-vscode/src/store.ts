import { EventEmitter } from "events";
import { BridgeStoreError } from "./errors";
import { BridgeStoreLike } from "./storeContracts";
import {
  AccessMode,
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

interface ThreadState {
  summary: ThreadSummary;
  messages: ThreadMessage[];
  turnIds: string[];
}

interface ApprovalRef {
  turnId: string;
  approvalIndex: number;
}

interface ExecutionState {
  itemId: string;
  chunks: string[];
  nextChunkIndex: number;
  timer: NodeJS.Timeout;
}

export class BridgeStore implements BridgeStoreLike {
  private readonly emitter = new EventEmitter();
  private readonly threads = new Map<string, ThreadState>();
  private readonly turns = new Map<string, TurnRecord>();
  private readonly threadLocks = new Map<string, string>();
  private readonly approvals = new Map<string, ApprovalRef>();
  private readonly execution = new Map<string, ExecutionState>();

  private seq = 0;

  public constructor(
    private readonly bridgeInfo: BridgeInfo,
    private readonly runtimeConfig: BridgeRuntimeConfig,
  ) {}

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

  public listThreads(): ThreadSummary[] {
    return Array.from(this.threads.values())
      .map((thread) => ({ ...thread.summary }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  public getThread(threadId: string): ThreadDetail {
    const thread = this.requireThread(threadId);
    const turns = thread.turnIds
      .map((turnId) => this.turns.get(turnId))
      .filter((turn): turn is TurnRecord => Boolean(turn))
      .map((turn) => cloneTurn(turn));

    return {
      thread: { ...thread.summary },
      messages: [...thread.messages],
      turns,
    };
  }

  public startTurn(threadId: string, request: SendMessageRequest): SendMessageResponse {
    const text = (request.text ?? "").trim();
    if (!text) {
      throw new BridgeStoreError("INVALID_INPUT", "Message text is required.");
    }

    const thread = this.getOrCreateThread(threadId);
    if (thread.summary.activeTurnId) {
      throw new BridgeStoreError("BUSY", "Thread is busy with an active turn.");
    }

    const accessMode: AccessMode = request.accessMode ?? "full-access";
    const modelId = request.modelId ?? null;
    const turnId = newId("turn");
    const startedAt = nowIso();

    const turn: TurnRecord = {
      turnId,
      threadId,
      status: "running",
      accessMode,
      modelId,
      userText: text,
      assistantText: "",
      startedAt,
      completedAt: null,
      plan: buildDefaultPlan(text),
      diff: "",
      approvals: [],
      steerHistory: [],
    };

    this.turns.set(turnId, turn);
    thread.turnIds.push(turnId);

    thread.summary.updatedAt = startedAt;
    thread.summary.status = "running";
    thread.summary.activeTurnId = turnId;

    thread.messages.push({
      role: "user",
      text,
      ts: startedAt,
      turnId,
      kind: "message",
    });

    this.threadLocks.set(threadId, turnId);

    this.emitTurnEvent(turn, "turn/started", {
      accessMode,
      modelId,
      userText: text,
    });

    this.emitTurnEvent(turn, "turn/plan/updated", {
      items: turn.plan,
    });

    const approval = this.createApproval(turn);

    if (accessMode === "plan-only") {
      turn.status = "waiting_approval";
      thread.summary.status = "waiting_approval";
      this.emitTurnEvent(turn, "item/commandExecution/requestApproval", {
        approvalId: approval.approvalId,
        type: approval.type,
        mode: "plan-only",
        autoApproved: false,
      });
      return {
        turnId,
        threadId,
      };
    }

    if (this.runtimeConfig.fullAccessAutoApprove) {
      approval.status = "approved";
      approval.decidedAt = nowIso();
      approval.decisionSource = "session-auto";
      this.approvals.delete(approval.approvalId);

      this.emitTurnEvent(turn, "item/commandExecution/requestApproval", {
        approvalId: approval.approvalId,
        type: approval.type,
        mode: "full-access",
        autoApproved: true,
      });

      this.startExecution(turn);
      return {
        turnId,
        threadId,
      };
    }

    turn.status = "waiting_approval";
    thread.summary.status = "waiting_approval";

    this.emitTurnEvent(turn, "item/commandExecution/requestApproval", {
      approvalId: approval.approvalId,
      type: approval.type,
      mode: "full-access",
      autoApproved: false,
    });

    return {
      turnId,
      threadId,
    };
  }

  public interruptTurn(turnId: string): TurnRecord {
    const turn = this.requireTurn(turnId);

    if (isTerminal(turn.status)) {
      throw new BridgeStoreError("INVALID_STATE", "Turn is already in terminal state.");
    }

    this.stopExecution(turnId);
    this.finishTurn(turn, "interrupted", {
      reason: "Interrupted by user",
    });

    return cloneTurn(turn);
  }

  public steerTurn(turnId: string, request: SteerRequest): TurnRecord {
    const turn = this.requireTurn(turnId);
    const text = (request.text ?? "").trim();

    if (!text) {
      throw new BridgeStoreError("INVALID_INPUT", "Steer text is required.");
    }

    if (isTerminal(turn.status)) {
      throw new BridgeStoreError("INVALID_STATE", "Cannot steer a completed turn.");
    }

    turn.steerHistory.push(text);
    turn.plan.push({
      id: newId("plan"),
      text: `Steer: ${text}`,
      status: "in_progress",
    });

    const thread = this.requireThread(turn.threadId);
    thread.summary.updatedAt = nowIso();
    thread.messages.push({
      role: "system",
      text,
      ts: nowIso(),
      turnId,
      kind: "steer",
    });

    this.emitTurnEvent(turn, "turn/plan/updated", {
      items: turn.plan,
      steerText: text,
    });

    return cloneTurn(turn);
  }

  public decideApproval(approvalId: string, decision: ApprovalDecision): TurnRecord {
    const ref = this.approvals.get(approvalId);
    if (!ref) {
      throw new BridgeStoreError("NOT_FOUND", `Approval ${approvalId} was not found or already decided.`);
    }

    const turn = this.requireTurn(ref.turnId);
    const approval = turn.approvals[ref.approvalIndex];

    if (approval.status !== "pending") {
      throw new BridgeStoreError("INVALID_STATE", "Approval is not pending.");
    }

    approval.status = decision === "approve" ? "approved" : "denied";
    approval.decisionSource = "user";
    approval.decidedAt = nowIso();
    this.approvals.delete(approvalId);

    if (decision === "deny") {
      this.stopExecution(turn.turnId);
      this.finishTurn(turn, "interrupted", {
        reason: "Approval denied by user",
        approvalId,
      });
      return cloneTurn(turn);
    }

    if (turn.status === "waiting_approval") {
      turn.status = "running";
      const thread = this.requireThread(turn.threadId);
      thread.summary.status = "running";
      thread.summary.updatedAt = nowIso();
      this.startExecution(turn);
    }

    return cloneTurn(turn);
  }

  public createHelloEvent(turnId: string): BridgeEventEnvelope {
    const turn = this.requireTurn(turnId);
    return this.buildEnvelope(turn, "hub/hello", {
      message: "bridge stream connected",
    });
  }

  public createStateEvent(turnId: string): BridgeEventEnvelope {
    const turn = this.requireTurn(turnId);
    return this.buildEnvelope(turn, "hub/state", {
      turn: cloneTurn(turn),
    });
  }

  public onTurnEvent(listener: (event: BridgeEventEnvelope) => void): () => void {
    this.emitter.on("turn-event", listener);
    return () => this.emitter.off("turn-event", listener);
  }

  public dispose(): void {
    for (const execution of this.execution.values()) {
      clearInterval(execution.timer);
    }
    this.execution.clear();
    this.emitter.removeAllListeners();
  }

  private startExecution(turn: TurnRecord): void {
    if (this.execution.has(turn.turnId)) {
      return;
    }

    const itemId = newId("item");
    const response = buildSimulatedAssistantResponse(turn.userText, turn.accessMode);
    const chunks = chunkText(response, 22);

    this.emitTurnEvent(turn, "item/started", {
      itemId,
      itemType: "agentMessage",
    });

    const execution: ExecutionState = {
      itemId,
      chunks,
      nextChunkIndex: 0,
      timer: setInterval(() => {
        this.tickExecution(turn.turnId);
      }, 120),
    };

    this.execution.set(turn.turnId, execution);
  }

  private tickExecution(turnId: string): void {
    const execution = this.execution.get(turnId);
    const turn = this.turns.get(turnId);

    if (!execution || !turn) {
      return;
    }

    if (turn.status !== "running") {
      return;
    }

    if (execution.nextChunkIndex < execution.chunks.length) {
      const delta = execution.chunks[execution.nextChunkIndex];
      execution.nextChunkIndex += 1;
      turn.assistantText += delta;

      this.emitTurnEvent(turn, "item/agentMessage/delta", {
        itemId: execution.itemId,
        delta,
      });
      return;
    }

    this.stopExecution(turnId);

    this.emitTurnEvent(turn, "item/completed", {
      itemId: execution.itemId,
      text: turn.assistantText,
    });

    turn.diff = buildSimulatedDiff(turn.userText);

    this.emitTurnEvent(turn, "turn/diff/updated", {
      diff: turn.diff,
    });

    const thread = this.requireThread(turn.threadId);
    thread.messages.push({
      role: "assistant",
      text: turn.assistantText,
      ts: nowIso(),
      turnId: turn.turnId,
      kind: "message",
    });

    this.finishTurn(turn, "completed");
  }

  private finishTurn(
    turn: TurnRecord,
    status: TurnStatus,
    extraParams: Record<string, unknown> = {},
  ): void {
    turn.status = status;
    turn.completedAt = nowIso();

    const thread = this.requireThread(turn.threadId);
    thread.summary.status = status;
    thread.summary.updatedAt = turn.completedAt;
    thread.summary.activeTurnId = null;

    this.threadLocks.delete(turn.threadId);

    this.emitTurnEvent(turn, "turn/completed", {
      status,
      ...extraParams,
    });
  }

  private stopExecution(turnId: string): void {
    const execution = this.execution.get(turnId);
    if (!execution) {
      return;
    }

    clearInterval(execution.timer);
    this.execution.delete(turnId);
  }

  private createApproval(turn: TurnRecord): ApprovalRecord {
    const approval: ApprovalRecord = {
      approvalId: newId("approval"),
      type: "commandExecution",
      status: "pending",
      requestedAt: nowIso(),
    };

    const approvalIndex = turn.approvals.push(approval) - 1;
    this.approvals.set(approval.approvalId, {
      turnId: turn.turnId,
      approvalIndex,
    });

    return approval;
  }

  private emitTurnEvent(turn: TurnRecord, method: string, params: Record<string, unknown>): void {
    this.emitter.emit("turn-event", this.buildEnvelope(turn, method, params));
  }

  private buildEnvelope(turn: TurnRecord, method: string, params: Record<string, unknown>): BridgeEventEnvelope {
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
        threadId: turn.threadId,
        turnId: turn.turnId,
      },
      method,
      params,
    };
  }

  private getOrCreateThread(threadId: string): ThreadState {
    const existing = this.threads.get(threadId);
    if (existing) {
      return existing;
    }

    const now = nowIso();
    const summary: ThreadSummary = {
      threadId,
      title: `Thread ${threadId}`,
      createdAt: now,
      updatedAt: now,
      status: "idle",
      activeTurnId: null,
    };

    const thread: ThreadState = {
      summary,
      messages: [],
      turnIds: [],
    };

    this.threads.set(threadId, thread);
    return thread;
  }

  private requireThread(threadId: string): ThreadState {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw new BridgeStoreError("NOT_FOUND", `Thread ${threadId} was not found.`);
    }
    return thread;
  }

  private requireTurn(turnId: string): TurnRecord {
    const turn = this.turns.get(turnId);
    if (!turn) {
      throw new BridgeStoreError("NOT_FOUND", `Turn ${turnId} was not found.`);
    }
    return turn;
  }
}

function isTerminal(status: TurnStatus): boolean {
  return status === "completed" || status === "interrupted" || status === "failed";
}

function cloneTurn(turn: TurnRecord): TurnRecord {
  return {
    ...turn,
    plan: turn.plan.map((item) => ({ ...item })),
    approvals: turn.approvals.map((approval) => ({ ...approval })),
    steerHistory: [...turn.steerHistory],
  };
}

function buildDefaultPlan(userText: string): TurnRecord["plan"] {
  return [
    {
      id: newId("plan"),
      text: "Analyze request context",
      status: "completed",
    },
    {
      id: newId("plan"),
      text: `Implement request: ${truncate(userText, 72)}`,
      status: "in_progress",
    },
    {
      id: newId("plan"),
      text: "Summarize updates and next checks",
      status: "pending",
    },
  ];
}

function buildSimulatedAssistantResponse(userText: string, mode: AccessMode): string {
  const prefix = mode === "plan-only" ? "Plan-only approval completed. " : "Full-access session approved. ";
  return `${prefix}Bridge simulation response for: \"${userText}\". This extension is ready for hub integration and will later connect to the real Codex app-server stream.`;
}

function buildSimulatedDiff(userText: string): string {
  const normalized = userText.replace(/\s+/g, " ").trim();
  return [
    "diff --git a/simulated/file.txt b/simulated/file.txt",
    "index 0000000..1111111 100644",
    "--- a/simulated/file.txt",
    "+++ b/simulated/file.txt",
    "@@ -0,0 +1,2 @@",
    `+Bridge simulated change for: ${truncate(normalized, 60)}`,
    "+TODO: replace simulation with real Codex app-server integration",
  ].join("\n");
}

function chunkText(text: string, chunkSize: number): string[] {
  if (text.length <= chunkSize) {
    return [text];
  }

  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += chunkSize) {
    chunks.push(text.slice(index, index + chunkSize));
  }

  return chunks;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}
