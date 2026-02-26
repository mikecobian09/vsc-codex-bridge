export type AccessMode = "plan-only" | "full-access";
export type TurnStatus = "running" | "waiting_approval" | "completed" | "interrupted" | "failed";
export type ApprovalDecision = "approve" | "deny";
export type BackendMode = "app-server" | "simulated";
export type AppServerMode = "spawn" | "attach";

export interface BridgeInfo {
  bridgeId: string;
  workspaceName: string;
  cwd: string;
  port: number;
  pid: number;
  startedAt: string;
  bridgeVersion: string;
}

export interface BridgeMeta extends BridgeInfo {
  status: "online";
  heartbeatAt: string;
}

export interface ThreadSummary {
  threadId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: TurnStatus | "idle";
  activeTurnId: string | null;
}

export interface ThreadMessage {
  role: "user" | "assistant" | "system";
  text: string;
  ts: string;
  turnId?: string;
  kind?: "message" | "steer";
}

export interface PlanItem {
  id: string;
  text: string;
  status: "pending" | "in_progress" | "completed";
}

export interface ApprovalRecord {
  approvalId: string;
  type: "commandExecution" | "fileChange";
  status: "pending" | "approved" | "denied";
  requestedAt: string;
  decidedAt?: string;
  decisionSource?: "user" | "session-auto";
}

export interface TurnRecord {
  turnId: string;
  threadId: string;
  status: TurnStatus;
  accessMode: AccessMode;
  modelId: string | null;
  userText: string;
  assistantText: string;
  startedAt: string;
  completedAt: string | null;
  plan: PlanItem[];
  diff: string;
  approvals: ApprovalRecord[];
  steerHistory: string[];
}

export interface ThreadDetail {
  thread: ThreadSummary;
  messages: ThreadMessage[];
  turns: TurnRecord[];
}

export interface SendMessageRequest {
  text: string;
  modelId?: string | null;
  accessMode?: AccessMode | null;
}

export interface SendMessageResponse {
  turnId: string;
  threadId: string;
}

export interface SteerRequest {
  text: string;
}

export interface ApprovalDecisionRequest {
  decision: ApprovalDecision;
}

export interface BridgeEventEnvelope {
  v: 1;
  seq: number;
  ts: string;
  bridge: {
    bridgeId: string;
    workspaceName: string;
    cwd: string;
  };
  context: {
    threadId: string;
    turnId: string;
  };
  method: string;
  params: Record<string, unknown>;
}

export interface BridgeRuntimeConfig {
  backendMode: BackendMode;
  fullAccessAutoApprove: boolean;
  autoStartBridge: boolean;
}

export interface ManagedHubConfig {
  enabled: boolean;
  bindHost: string;
  port: number;
}

export interface AppServerConfig {
  mode: AppServerMode;
  attachUrl: string | null;
  command: string;
  extraArgs: string[];
  host: string;
  startupTimeoutMs: number;
  experimentalApi: boolean;
}

export interface InternalBridgeConfig {
  bindHost: string;
  bindPort: number;
}

export interface HubConfig {
  hubUrl: string;
  hubRegisterPath: string;
  hubHeartbeatPath: string;
  hubToken: string;
  heartbeatIntervalMs: number;
}

export interface ExtensionConfig {
  internal: InternalBridgeConfig;
  hub: HubConfig;
  appServer: AppServerConfig;
  runtime: BridgeRuntimeConfig;
  managedHub: ManagedHubConfig;
  verboseLogs: boolean;
}
