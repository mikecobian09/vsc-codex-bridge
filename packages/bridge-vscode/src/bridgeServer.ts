import { createServer, IncomingMessage, Server, ServerResponse } from "http";
import { AddressInfo } from "net";
import { URL } from "url";
import { WebSocket, WebSocketServer } from "ws";
import { BridgeStoreError } from "./errors";
import { Logger } from "./logger";
import {
  ApprovalDecisionRequest,
  BridgeEventEnvelope,
  InternalBridgeConfig,
  SendMessageRequest,
  SteerRequest,
} from "./types";
import { safeJsonParse } from "./utils";
import { BridgeStoreLike } from "./storeContracts";

const MAX_JSON_BODY_BYTES = 1_000_000;

type SubscriberSet = Set<WebSocket>;

export class BridgeServer {
  private server: Server | null = null;
  private wsServer: WebSocketServer | null = null;
  private host = "127.0.0.1";
  private port = 0;
  private requestSeq = 0;
  private readonly subscribers = new Map<string, SubscriberSet>();
  private unsubscribeStoreEvents: (() => void) | null = null;

  public constructor(
    private readonly config: InternalBridgeConfig,
    private readonly store: BridgeStoreLike,
    private readonly logger: Logger,
  ) {}

  public async start(): Promise<void> {
    if (this.server) {
      return;
    }

    this.server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });

    this.wsServer = new WebSocketServer({ noServer: true });

    this.server.on("upgrade", (request, socket, head) => {
      this.handleUpgrade(request, socket, head);
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.config.bindPort, this.config.bindHost, () => resolve());
    });

    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Could not resolve bridge server address.");
    }

    const info = address as AddressInfo;
    this.host = info.address;
    this.port = info.port;

    this.store.setPort(this.port);

    this.unsubscribeStoreEvents = this.store.onTurnEvent((event) => {
      this.broadcastTurnEvent(event);
    });

    this.logger.info(`Bridge internal API listening on http://${this.host}:${this.port}`);
  }

  public async stop(): Promise<void> {
    this.unsubscribeStoreEvents?.();
    this.unsubscribeStoreEvents = null;

    for (const clients of this.subscribers.values()) {
      for (const client of clients) {
        client.close();
      }
    }
    this.subscribers.clear();

    if (this.wsServer) {
      this.wsServer.removeAllListeners();
      this.wsServer = null;
    }

    if (!this.server) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
    });

    this.server = null;
    this.port = 0;
    this.logger.info("Bridge internal API stopped.");
  }

  public getAddress(): { host: string; port: number } {
    return { host: this.host, port: this.port };
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestId = this.nextRequestId();
    const startedAt = Date.now();
    const method = request.method ?? "GET";
    const parsedUrl = this.parseRequestUrl(request);
    const path = parsedUrl.pathname;

    this.logger.debug(`[${requestId}] HTTP ${method} ${path}`);

    try {
      if (method === "GET" && path === "/internal/v1/meta") {
        this.writeJson(response, 200, this.store.getBridgeMeta());
        return;
      }

      if (method === "GET" && path === "/internal/v1/threads") {
        this.writeJson(response, 200, {
          items: await this.store.listThreads(),
        });
        return;
      }

      const threadPathMatch = matchPath(path, /^\/internal\/v1\/threads\/([^/]+)$/);
      if (method === "GET" && threadPathMatch) {
        const threadId = decodeURIComponent(threadPathMatch[1]);
        this.writeJson(response, 200, await this.store.getThread(threadId));
        return;
      }

      const messagePathMatch = matchPath(path, /^\/internal\/v1\/threads\/([^/]+)\/message$/);
      if (method === "POST" && messagePathMatch) {
        const body = parseSendMessageRequest(await this.readJsonBody(request));
        const threadId = decodeURIComponent(messagePathMatch[1]);

        this.writeJson(response, 200, await this.store.startTurn(threadId, body));
        return;
      }

      const interruptPathMatch = matchPath(path, /^\/internal\/v1\/turns\/([^/]+)\/interrupt$/);
      if (method === "POST" && interruptPathMatch) {
        const turnId = decodeURIComponent(interruptPathMatch[1]);
        const turn = await this.store.interruptTurn(turnId);
        this.writeJson(response, 200, {
          turnId: turn.turnId,
          status: turn.status,
        });
        return;
      }

      const steerPathMatch = matchPath(path, /^\/internal\/v1\/turns\/([^/]+)\/steer$/);
      if (method === "POST" && steerPathMatch) {
        const turnId = decodeURIComponent(steerPathMatch[1]);
        const body = parseSteerRequest(await this.readJsonBody(request));
        const turn = await this.store.steerTurn(turnId, body);
        this.writeJson(response, 200, {
          turnId: turn.turnId,
          status: turn.status,
        });
        return;
      }

      const approvalPathMatch = matchPath(path, /^\/internal\/v1\/approvals\/([^/]+)\/decision$/);
      if (method === "POST" && approvalPathMatch) {
        const approvalId = decodeURIComponent(approvalPathMatch[1]);
        const body = parseApprovalDecisionRequest(await this.readJsonBody(request));
        const turn = await this.store.decideApproval(approvalId, body.decision);

        this.writeJson(response, 200, {
          turnId: turn.turnId,
          status: turn.status,
        });
        return;
      }

      this.writeJson(response, 404, {
        error: "NOT_FOUND",
        message: `Route not found: ${method} ${path}`,
      });
    } catch (error) {
      const { status, payload } = normalizeError(error);
      this.writeJson(response, status, payload);
      this.logger.warn(`[${requestId}] Request failed: ${String(error)}`);
    } finally {
      const elapsedMs = Date.now() - startedAt;
      this.logger.debug(`[${requestId}] HTTP ${method} ${path} -> ${response.statusCode} (${elapsedMs} ms)`);
    }
  }

  private handleUpgrade(request: IncomingMessage, socket: any, head: Buffer): void {
    if (!this.wsServer) {
      socket.destroy();
      return;
    }

    const parsedUrl = this.parseRequestUrl(request);
    const match = matchPath(parsedUrl.pathname, /^\/internal\/v1\/turns\/([^/]+)\/stream$/);

    if (!match) {
      socket.destroy();
      return;
    }

    const turnId = decodeURIComponent(match[1]);

    this.wsServer.handleUpgrade(request, socket, head, (client) => {
      this.registerSubscriber(turnId, client);
    });
  }

  private registerSubscriber(turnId: string, client: WebSocket): void {
    let subscribers = this.subscribers.get(turnId);
    if (!subscribers) {
      subscribers = new Set<WebSocket>();
      this.subscribers.set(turnId, subscribers);
    }

    subscribers.add(client);

    void this.sendInitialStreamState(turnId, client);

    client.on("close", () => {
      const set = this.subscribers.get(turnId);
      if (!set) {
        return;
      }

      set.delete(client);
      if (set.size === 0) {
        this.subscribers.delete(turnId);
      }
    });
  }

  private broadcastTurnEvent(event: BridgeEventEnvelope): void {
    const subscribers = this.subscribers.get(event.context.turnId);
    if (!subscribers || subscribers.size === 0) {
      return;
    }

    const payload = JSON.stringify(event);
    for (const subscriber of subscribers) {
      if (subscriber.readyState === WebSocket.OPEN) {
        subscriber.send(payload);
      }
    }
  }

  private async sendInitialStreamState(turnId: string, client: WebSocket): Promise<void> {
    try {
      client.send(JSON.stringify(await this.store.createHelloEvent(turnId)));
      client.send(JSON.stringify(await this.store.createStateEvent(turnId)));
    } catch (error) {
      this.logger.warn(`Unable to send initial WS state for turn ${turnId}: ${String(error)}`);
    }
  }

  private parseRequestUrl(request: IncomingMessage): URL {
    const hostHeader = request.headers.host ?? "127.0.0.1";
    const url = request.url ?? "/";
    return new URL(url, `http://${hostHeader}`);
  }

  private async readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let totalSize = 0;

    for await (const chunk of request) {
      const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalSize += piece.length;

      if (totalSize > MAX_JSON_BODY_BYTES) {
        throw new BridgeStoreError("INVALID_INPUT", "JSON payload too large.");
      }

      chunks.push(piece);
    }

    if (chunks.length === 0) {
      return {};
    }

    const text = Buffer.concat(chunks).toString("utf8");
    const parsed = safeJsonParse(text);

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new BridgeStoreError("INVALID_INPUT", "Request body must be a JSON object.");
    }

    return parsed as Record<string, unknown>;
  }

  private writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
    response.statusCode = statusCode;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify(payload));
  }

  private nextRequestId(): string {
    this.requestSeq += 1;
    return `bridge-${this.requestSeq}`;
  }
}

function matchPath(pathname: string, expression: RegExp): RegExpMatchArray | null {
  return pathname.match(expression);
}

function normalizeError(error: unknown): { status: number; payload: Record<string, unknown> } {
  if (error instanceof BridgeStoreError) {
    switch (error.code) {
      case "NOT_FOUND":
        return {
          status: 404,
          payload: {
            error: error.code,
            message: error.message,
          },
        };
      case "BUSY":
        return {
          status: 409,
          payload: {
            error: error.code,
            message: error.message,
          },
        };
      case "INVALID_INPUT":
        return {
          status: 400,
          payload: {
            error: error.code,
            message: error.message,
          },
        };
      case "INVALID_STATE":
      default:
        return {
          status: 409,
          payload: {
            error: error.code,
            message: error.message,
          },
        };
    }
  }

  return {
    status: 500,
    payload: {
      error: "INTERNAL_ERROR",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

function parseSendMessageRequest(body: Record<string, unknown>): SendMessageRequest {
  const text = body.text;
  if (typeof text !== "string") {
    throw new BridgeStoreError("INVALID_INPUT", "Field 'text' must be a string.");
  }

  const modelIdValue = body.modelId;
  const modelId = typeof modelIdValue === "string" ? modelIdValue : null;

  const accessModeValue = body.accessMode;
  const accessMode =
    accessModeValue === "plan-only" || accessModeValue === "full-access" ? accessModeValue : undefined;

  return {
    text,
    modelId,
    accessMode,
  };
}

function parseSteerRequest(body: Record<string, unknown>): SteerRequest {
  const text = body.text;
  if (typeof text !== "string") {
    throw new BridgeStoreError("INVALID_INPUT", "Field 'text' must be a string.");
  }

  return {
    text,
  };
}

function parseApprovalDecisionRequest(body: Record<string, unknown>): ApprovalDecisionRequest {
  const decision = body.decision;
  if (decision !== "approve" && decision !== "deny") {
    throw new BridgeStoreError("INVALID_INPUT", "Field 'decision' must be 'approve' or 'deny'.");
  }

  return {
    decision,
  };
}
