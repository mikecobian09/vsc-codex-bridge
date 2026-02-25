import {
  ApprovalDecision,
  BridgeEventEnvelope,
  BridgeMeta,
  SendMessageRequest,
  SendMessageResponse,
  SteerRequest,
  ThreadDetail,
  ThreadSummary,
  TurnRecord,
} from "./types";

export type Awaitable<T> = T | Promise<T>;

export interface BridgeStoreLike {
  setPort(port: number): void;
  getBridgeMeta(): BridgeMeta;
  listThreads(): Awaitable<ThreadSummary[]>;
  getThread(threadId: string): Awaitable<ThreadDetail>;
  startTurn(threadId: string, request: SendMessageRequest): Awaitable<SendMessageResponse>;
  interruptTurn(turnId: string): Awaitable<TurnRecord>;
  steerTurn(turnId: string, request: SteerRequest): Awaitable<TurnRecord>;
  decideApproval(approvalId: string, decision: ApprovalDecision): Awaitable<TurnRecord>;
  createHelloEvent(turnId: string): Awaitable<BridgeEventEnvelope>;
  createStateEvent(turnId: string): Awaitable<BridgeEventEnvelope>;
  onTurnEvent(listener: (event: BridgeEventEnvelope) => void): () => void;
  start?(): Awaitable<void>;
  dispose(): Awaitable<void>;
}
