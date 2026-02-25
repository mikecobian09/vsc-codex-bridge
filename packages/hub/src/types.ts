import type {
  AccessMode,
  ApprovalDecisionRequest,
  SendMessageRequest,
  SteerRequest,
} from "../../shared/out/contracts";

export type { AccessMode, SendMessageRequest, SteerRequest, ApprovalDecisionRequest };
export type TurnStatus = "running" | "waiting_approval" | "completed" | "interrupted" | "failed";

export interface BridgeMeta {
  bridgeId: string;
  workspaceName: string;
  cwd: string;
  port: number;
  pid: number;
  startedAt: string;
  bridgeVersion: string;
  status: "online";
  heartbeatAt: string;
}

export interface BridgeRegistrationPayload extends Partial<BridgeMeta> {
  bridgeId: string;
  workspaceName: string;
  cwd: string;
  port: number;
  pid: number;
  startedAt: string;
  bridgeVersion: string;
  status?: "online";
  heartbeatAt?: string;
  registeredAt?: string;
  host?: string;
}

export interface BridgeHeartbeatPayload {
  bridgeId: string;
  status?: "online";
  heartbeatAt: string;
}

export interface BridgeRecord {
  meta: BridgeMeta;
  host: string;
  registeredAt: string;
  lastHeartbeatAt: string;
  stale: boolean;
}

export interface HubConfig {
  bindHost: string;
  port: number;
  authToken: string;
  bridgeTtlMs: number;
  heartbeatPruneIntervalMs: number;
  mutatingRateLimitWindowMs: number;
  mutatingRateLimitMax: number;
  corsAllowedOrigins: string[];
  publicDir: string;
  verboseLogs: boolean;
}

export interface HubErrorPayload {
  error: string;
  message: string;
}
