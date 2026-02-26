import { createServer, IncomingMessage, Server, ServerResponse } from "http";
import { existsSync, readFileSync, statSync } from "fs";
import { extname, join, normalize, resolve } from "path";
import { URL } from "url";
import WebSocket, { WebSocketServer } from "ws";
import { buildBridgeWsUrl, proxyJsonRequest } from "./bridgeProxy";
import {
  parseApprovalDecisionRequest,
  parseSendMessageRequest,
  parseSteerRequest,
} from "../../shared/out/contracts";
import { HubConfig, HubErrorPayload } from "./types";
import { BridgeRegistry } from "./registry";
import { Logger } from "./logger";

const MAX_JSON_BODY_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 20_000;

interface MutationRateWindow {
  windowStartedAtMs: number;
  count: number;
}

interface AuthFailure {
  payload: HubErrorPayload;
  reason: string;
}

interface CorsDecision {
  allowed: boolean;
  origin: string | null;
  reason: string | null;
}

/**
 * Hub server implementation.
 *
 * Responsibilities:
 * - receive bridge registration and heartbeats,
 * - expose public API consumed by PWA,
 * - proxy HTTP and WS traffic to the correct bridge,
 * - serve static PWA files.
 */
export class HubServer {
  private server: Server | null = null;
  private wsServer: WebSocketServer | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private requestSeq = 0;
  private mutationRateByHost = new Map<string, MutationRateWindow>();

  public constructor(
    private readonly config: HubConfig,
    private readonly registry: BridgeRegistry,
    private readonly logger: Logger,
  ) {}

  public async start(): Promise<void> {
    if (this.server) {
      return;
    }

    this.server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });

    this.server.requestTimeout = REQUEST_TIMEOUT_MS;

    this.wsServer = new WebSocketServer({ noServer: true });

    this.server.on("upgrade", (request, socket, head) => {
      void this.handleUpgrade(request, socket, head);
    });

    await new Promise<void>((resolvePromise, rejectPromise) => {
      this.server?.once("error", rejectPromise);
      this.server?.listen(this.config.port, this.config.bindHost, () => resolvePromise());
    });

    this.pruneTimer = setInterval(() => {
      const removed = this.registry.pruneStale();
      if (removed.length > 0) {
        this.logger.info(`Pruned stale bridges: ${removed.join(", ")}`);
      }
    }, this.config.heartbeatPruneIntervalMs);

    const mode = this.config.authToken ? "token" : "localhost-only";
    this.logger.info(`Hub listening on http://${this.config.bindHost}:${this.config.port} (auth=${mode})`);
    this.logger.info(`Serving PWA files from: ${this.config.publicDir}`);
  }

  public async stop(): Promise<void> {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }

    if (this.wsServer) {
      this.wsServer.removeAllListeners();
      this.wsServer.clients.forEach((socket) => {
        socket.close();
      });
      this.wsServer = null;
    }

    if (!this.server) {
      return;
    }

    await new Promise<void>((resolvePromise) => {
      this.server?.close(() => resolvePromise());
    });

    this.server = null;
    this.logger.info("Hub server stopped.");
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestId = this.nextRequestId();
    const startedAt = Date.now();
    const method = request.method ?? "GET";
    const parsedUrl = this.parseUrl(request);
    const pathname = parsedUrl.pathname;

    this.logger.debug(`[${requestId}] ${method} ${pathname}`);

    try {
      if (method === "GET" && pathname === "/healthz") {
        this.writeJson(response, 200, {
          ok: true,
          ts: new Date().toISOString(),
          bridges: this.registry.snapshot(),
        });
        return;
      }

      if (pathname.startsWith("/api/")) {
        const corsDecision = this.checkCors(request);
        if (!corsDecision.allowed) {
          this.logCorsFailure(requestId, request, parsedUrl, corsDecision.reason ?? "unknown");
          this.writeJson(response, 403, {
            error: "ORIGIN_NOT_ALLOWED",
            message: "Request origin is not allowed.",
          });
          return;
        }

        this.applyCorsHeaders(response, corsDecision.origin);

        if (method === "OPTIONS") {
          response.statusCode = 204;
          response.end();
          return;
        }

        const authError = this.checkAuth(request, parsedUrl);
        if (authError) {
          this.logAuthFailure(requestId, request, parsedUrl, authError.reason);
          this.writeJson(response, 401, authError.payload);
          return;
        }

        await this.handleApiRequest(method, parsedUrl, request, response, requestId);
        return;
      }

      if (method === "GET") {
        this.serveStaticFile(parsedUrl.pathname, response);
        return;
      }

      this.writeJson(response, 404, notFound(`${method} ${pathname}`));
    } catch (error) {
      this.logger.error(`[${requestId}] Unhandled request error: ${String(error)}`);
      this.writeJson(response, 500, {
        error: "INTERNAL_ERROR",
        message: "Unexpected hub error.",
      });
    } finally {
      const elapsedMs = Date.now() - startedAt;
      this.logger.debug(`[${requestId}] Completed in ${elapsedMs} ms`);
    }
  }

  private async handleApiRequest(
    method: string,
    parsedUrl: URL,
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
  ): Promise<void> {
    const pathname = parsedUrl.pathname;

    if (method === "POST" && pathname === "/api/v1/internal/bridges/register") {
      const body = await this.readJsonBody(request);
      const payload = requireObject(body);

      const required = ["bridgeId", "workspaceName", "cwd", "port", "pid", "startedAt", "bridgeVersion"];
      for (const key of required) {
        if (!(key in payload)) {
          this.writeJson(response, 400, {
            error: "INVALID_INPUT",
            message: `Missing required field '${key}' in bridge register payload.`,
          });
          return;
        }
      }

      const sourceHost = normalizeRemoteHost(request.socket.remoteAddress);
      const nowIso = new Date().toISOString();
      const record = this.registry.register(
        {
          bridgeId: String(payload.bridgeId),
          workspaceName: String(payload.workspaceName),
          cwd: String(payload.cwd),
          port: Number(payload.port),
          pid: Number(payload.pid),
          startedAt: String(payload.startedAt),
          bridgeVersion: String(payload.bridgeVersion),
          status: "online",
          heartbeatAt: typeof payload.heartbeatAt === "string" ? payload.heartbeatAt : nowIso,
          registeredAt: typeof payload.registeredAt === "string" ? payload.registeredAt : nowIso,
          host: typeof payload.host === "string" ? payload.host : undefined,
        },
        sourceHost,
        nowIso,
      );

      this.logger.info(
        `[${requestId}] Registered bridge ${record.meta.bridgeId} (${record.meta.workspaceName}) at ${record.host}:${record.meta.port}`,
      );

      this.writeJson(response, 200, {
        ok: true,
        bridgeId: record.meta.bridgeId,
      });
      return;
    }

    const heartbeatMatch = pathname.match(/^\/api\/v1\/internal\/bridges\/([^/]+)\/heartbeat$/);
    if (method === "POST" && heartbeatMatch) {
      const bridgeId = decodeURIComponent(heartbeatMatch[1]);
      const body = await this.readJsonBody(request);
      const payload = requireObject(body);
      const nowIso = new Date().toISOString();

      const updated = this.registry.heartbeat(
        bridgeId,
        {
          bridgeId,
          heartbeatAt: typeof payload.heartbeatAt === "string" ? payload.heartbeatAt : nowIso,
          status: "online",
        },
        nowIso,
      );

      if (!updated) {
        this.logger.debug(`[${requestId}] Heartbeat for unknown bridge ${bridgeId}`);
        this.writeJson(response, 404, {
          error: "NOT_FOUND",
          message: `Bridge ${bridgeId} is not registered.`,
        });
        return;
      }

      this.writeJson(response, 200, {
        ok: true,
        bridgeId,
        heartbeatAt: updated.lastHeartbeatAt,
      });
      return;
    }

    if (method === "GET" && pathname === "/api/v1/bridges") {
      const items = this.registry.listActive().map((record) => ({
        ...record.meta,
        host: record.host,
        registeredAt: record.registeredAt,
        lastHeartbeatAt: record.lastHeartbeatAt,
      }));

      this.writeJson(response, 200, { items });
      return;
    }

    if (method === "GET" && pathname === "/api/v1/runtime/security") {
      this.writeJson(response, 200, this.buildSecurityPosture());
      return;
    }

    const bridgeMetaMatch = pathname.match(/^\/api\/v1\/bridges\/([^/]+)\/meta$/);
    if (method === "GET" && bridgeMetaMatch) {
      const bridgeId = decodeURIComponent(bridgeMetaMatch[1]);
      const record = this.registry.get(bridgeId);
      if (!record) {
        this.writeJson(response, 404, {
          error: "NOT_FOUND",
          message: `Bridge ${bridgeId} is offline or unknown.`,
        });
        return;
      }

      this.writeJson(response, 200, {
        ...record.meta,
        host: record.host,
        registeredAt: record.registeredAt,
        lastHeartbeatAt: record.lastHeartbeatAt,
      });
      return;
    }

    const threadsMatch = pathname.match(/^\/api\/v1\/bridges\/([^/]+)\/threads$/);
    if (method === "GET" && threadsMatch) {
      const bridgeId = decodeURIComponent(threadsMatch[1]);
      await this.forwardRequestToBridge({
        response,
        bridgeId,
        method: "GET",
        path: `/internal/v1/threads${parsedUrl.search}`,
      });
      return;
    }

    const threadDetailMatch = pathname.match(/^\/api\/v1\/bridges\/([^/]+)\/threads\/([^/]+)$/);
    if (method === "GET" && threadDetailMatch) {
      const bridgeId = decodeURIComponent(threadDetailMatch[1]);
      const threadId = decodeURIComponent(threadDetailMatch[2]);
      await this.forwardRequestToBridge({
        response,
        bridgeId,
        method: "GET",
        path: `/internal/v1/threads/${encodeURIComponent(threadId)}`,
      });
      return;
    }

    const messageMatch = pathname.match(/^\/api\/v1\/bridges\/([^/]+)\/threads\/([^/]+)\/message$/);
    if (method === "POST" && messageMatch) {
      if (!this.checkMutatingRateLimit(request, response, requestId, "thread-message")) {
        return;
      }

      const bridgeId = decodeURIComponent(messageMatch[1]);
      const threadId = decodeURIComponent(messageMatch[2]);
      const body = parseSendMessageRequest(await this.readJsonBody(request));

      await this.forwardRequestToBridge({
        response,
        bridgeId,
        method: "POST",
        path: `/internal/v1/threads/${encodeURIComponent(threadId)}/message`,
        body,
      });
      return;
    }

    const interruptMatch = pathname.match(/^\/api\/v1\/bridges\/([^/]+)\/turns\/([^/]+)\/interrupt$/);
    if (method === "POST" && interruptMatch) {
      if (!this.checkMutatingRateLimit(request, response, requestId, "turn-interrupt")) {
        return;
      }

      const bridgeId = decodeURIComponent(interruptMatch[1]);
      const turnId = decodeURIComponent(interruptMatch[2]);

      await this.forwardRequestToBridge({
        response,
        bridgeId,
        method: "POST",
        path: `/internal/v1/turns/${encodeURIComponent(turnId)}/interrupt`,
        body: {},
      });
      return;
    }

    const steerMatch = pathname.match(/^\/api\/v1\/bridges\/([^/]+)\/turns\/([^/]+)\/steer$/);
    if (method === "POST" && steerMatch) {
      if (!this.checkMutatingRateLimit(request, response, requestId, "turn-steer")) {
        return;
      }

      const bridgeId = decodeURIComponent(steerMatch[1]);
      const turnId = decodeURIComponent(steerMatch[2]);
      const body = parseSteerRequest(await this.readJsonBody(request));

      await this.forwardRequestToBridge({
        response,
        bridgeId,
        method: "POST",
        path: `/internal/v1/turns/${encodeURIComponent(turnId)}/steer`,
        body,
      });
      return;
    }

    const approvalMatch = pathname.match(/^\/api\/v1\/bridges\/([^/]+)\/approvals\/([^/]+)\/decision$/);
    if (method === "POST" && approvalMatch) {
      if (!this.checkMutatingRateLimit(request, response, requestId, "approval-decision")) {
        return;
      }

      const bridgeId = decodeURIComponent(approvalMatch[1]);
      const approvalId = decodeURIComponent(approvalMatch[2]);
      const body = parseApprovalDecisionRequest(await this.readJsonBody(request));

      await this.forwardRequestToBridge({
        response,
        bridgeId,
        method: "POST",
        path: `/internal/v1/approvals/${encodeURIComponent(approvalId)}/decision`,
        body,
      });
      return;
    }

    this.writeJson(response, 404, notFound(`${method} ${pathname}`));
  }

  private checkMutatingRateLimit(
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
    routeTag: string,
  ): boolean {
    const remoteHost = normalizeRemoteHost(request.socket.remoteAddress);
    const nowMs = Date.now();

    const current = this.mutationRateByHost.get(remoteHost);
    if (!current || nowMs - current.windowStartedAtMs >= this.config.mutatingRateLimitWindowMs) {
      this.mutationRateByHost.set(remoteHost, {
        windowStartedAtMs: nowMs,
        count: 1,
      });
      return true;
    }

    current.count += 1;
    if (current.count <= this.config.mutatingRateLimitMax) {
      return true;
    }

    const retryAfterMs = Math.max(1_000, this.config.mutatingRateLimitWindowMs - (nowMs - current.windowStartedAtMs));
    response.setHeader("retry-after", String(Math.ceil(retryAfterMs / 1_000)));
    this.logger.warn(
      `[${requestId}] Rate limit exceeded for host ${remoteHost} on ${routeTag} (${current.count}/${this.config.mutatingRateLimitMax})`,
    );
    this.writeJson(response, 429, {
      error: "RATE_LIMITED",
      message: "Too many mutating requests. Please retry shortly.",
      retryAfterMs,
    });
    return false;
  }

  private async forwardRequestToBridge(args: {
    response: ServerResponse;
    bridgeId: string;
    method: "GET" | "POST";
    path: string;
    body?: unknown;
  }): Promise<void> {
    const bridge = this.registry.get(args.bridgeId);
    if (!bridge) {
      this.writeJson(args.response, 404, {
        error: "NOT_FOUND",
        message: `Bridge ${args.bridgeId} is offline or unknown.`,
      });
      return;
    }

    try {
      const proxied = await proxyJsonRequest({
        bridge,
        method: args.method,
        path: args.path,
        body: args.body,
      });

      args.response.statusCode = proxied.status;
      for (const [key, value] of Object.entries(proxied.headers)) {
        args.response.setHeader(key, value);
      }
      args.response.end(proxied.body);
    } catch (error) {
      this.logger.error(`Proxy request failed for bridge ${args.bridgeId}: ${String(error)}`);
      this.writeJson(args.response, 502, {
        error: "UPSTREAM_ERROR",
        message: `Could not reach bridge ${args.bridgeId}.`,
      });
    }
  }

  private async handleUpgrade(request: IncomingMessage, socket: any, head: Buffer): Promise<void> {
    const requestId = this.nextRequestId();
    const parsedUrl = this.parseUrl(request);
    const pathname = parsedUrl.pathname;

    const match = pathname.match(/^\/ws\/v1\/bridges\/([^/]+)\/turns\/([^/]+)$/);
    if (!match) {
      socket.destroy();
      return;
    }

    const corsDecision = this.checkCors(request);
    if (!corsDecision.allowed) {
      this.logCorsFailure(requestId, request, parsedUrl, corsDecision.reason ?? "unknown");
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    const authError = this.checkAuth(request, parsedUrl);
    if (authError) {
      this.logAuthFailure(requestId, request, parsedUrl, authError.reason);
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const bridgeId = decodeURIComponent(match[1]);
    const turnId = decodeURIComponent(match[2]);
    const bridge = this.registry.get(bridgeId);
    if (!bridge) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    if (!this.wsServer) {
      socket.destroy();
      return;
    }

    this.wsServer.handleUpgrade(request, socket, head, (clientSocket) => {
      void this.proxyTurnStream(clientSocket, bridgeId, turnId, bridge);
    });
  }

  private async proxyTurnStream(
    downstream: WebSocket,
    bridgeId: string,
    turnId: string,
    bridge: ReturnType<BridgeRegistry["get"]> extends infer T ? Exclude<T, null> : never,
  ): Promise<void> {
    const upstreamUrl = buildBridgeWsUrl(bridge, turnId);
    const upstream = new WebSocket(upstreamUrl, {
      perMessageDeflate: false,
    });

    const safeClose = (socket: WebSocket, code?: number, reason?: string): void => {
      if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
        return;
      }
      socket.close(code, reason);
    };

    upstream.on("open", () => {
      this.logger.debug(`WS proxy connected bridge=${bridgeId} turn=${turnId}`);
    });

    upstream.on("message", (data, isBinary) => {
      if (downstream.readyState === WebSocket.OPEN) {
        downstream.send(data, { binary: isBinary });
      }
    });

    downstream.on("message", (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary });
      }
    });

    upstream.on("close", () => {
      safeClose(downstream, 1000, "upstream-closed");
    });

    upstream.on("error", (error) => {
      this.logger.warn(`Upstream WS error for ${bridgeId}/${turnId}: ${String(error)}`);
      safeClose(downstream, 1011, "upstream-error");
    });

    downstream.on("close", () => {
      safeClose(upstream, 1000, "downstream-closed");
    });

    downstream.on("error", () => {
      safeClose(upstream, 1000, "downstream-error");
    });
  }

  private parseUrl(request: IncomingMessage): URL {
    const host = request.headers.host ?? `${this.config.bindHost}:${this.config.port}`;
    return new URL(request.url ?? "/", `http://${host}`);
  }

  private checkAuth(request: IncomingMessage, parsedUrl?: URL): AuthFailure | null {
    const remote = normalizeRemoteHost(request.socket.remoteAddress);
    const pathname = parsedUrl?.pathname ?? "";

    // Bridge registration/heartbeat happens from local VS Code extension.
    // Allow this local control channel without requiring token headers,
    // even when external API access is token-protected for LAN clients.
    if (pathname.startsWith("/api/v1/internal/bridges/") && isLoopbackHost(remote)) {
      return null;
    }

    if (this.config.authToken) {
      const auth = request.headers.authorization ?? "";
      if (auth === `Bearer ${this.config.authToken}`) {
        return null;
      }

      // Browsers cannot set arbitrary headers in WebSocket handshakes, so
      // the PWA sends token via query string as a controlled fallback.
      const tokenQuery = parsedUrl?.searchParams.get("token") ?? "";
      if (tokenQuery && tokenQuery === this.config.authToken) {
        return null;
      }

      return {
        reason: "missing-or-invalid-token",
        payload: {
          error: "UNAUTHORIZED",
          message: "Missing or invalid bearer token.",
        },
      };
    }

    if (!isLoopbackHost(remote)) {
      return {
        reason: "token-disabled-non-loopback-request",
        payload: {
          error: "UNAUTHORIZED",
          message: "Hub token is disabled and request is not from localhost.",
        },
      };
    }

    return null;
  }

  private checkCors(request: IncomingMessage): CorsDecision {
    const rawOrigin = typeof request.headers.origin === "string" ? request.headers.origin.trim() : "";
    if (!rawOrigin) {
      return { allowed: true, origin: null, reason: null };
    }

    const normalizedOrigin = normalizeOrigin(rawOrigin);
    if (!normalizedOrigin) {
      return { allowed: false, origin: rawOrigin, reason: "invalid-origin-header" };
    }

    const requestHost = String(request.headers.host ?? "").trim().toLowerCase();
    if (requestHost && isSameHostOrigin(normalizedOrigin, requestHost)) {
      return { allowed: true, origin: normalizedOrigin, reason: null };
    }

    const allowlist = this.config.corsAllowedOrigins.map((item) => item.trim()).filter(Boolean);
    if (allowlist.includes("*")) {
      return { allowed: true, origin: normalizedOrigin, reason: null };
    }

    for (const allowedOrigin of allowlist) {
      const normalizedAllowedOrigin = normalizeOrigin(allowedOrigin);
      if (normalizedAllowedOrigin && normalizedAllowedOrigin === normalizedOrigin) {
        return { allowed: true, origin: normalizedOrigin, reason: null };
      }
    }

    return { allowed: false, origin: normalizedOrigin, reason: "origin-not-allowlisted" };
  }

  private applyCorsHeaders(response: ServerResponse, origin: string | null): void {
    if (!origin) {
      return;
    }

    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    response.setHeader("access-control-allow-headers", "authorization,content-type");
    response.setHeader("access-control-max-age", "600");
    appendVaryHeader(response, "Origin");
  }

  private logAuthFailure(requestId: string, request: IncomingMessage, parsedUrl: URL, reason: string): void {
    const remoteHost = normalizeRemoteHost(request.socket.remoteAddress);
    const method = request.method ?? "GET";
    const origin = sanitizeHeaderValue(request.headers.origin);

    this.logger.warn(
      `[${requestId}] Auth denied (${reason}) ${method} ${parsedUrl.pathname} remote=${remoteHost}${origin ? ` origin=${origin}` : ""}`,
    );
  }

  private logCorsFailure(requestId: string, request: IncomingMessage, parsedUrl: URL, reason: string): void {
    const remoteHost = normalizeRemoteHost(request.socket.remoteAddress);
    const method = request.method ?? "GET";
    const origin = sanitizeHeaderValue(request.headers.origin) || "(missing)";

    this.logger.warn(
      `[${requestId}] CORS rejected (${reason}) ${method} ${parsedUrl.pathname} remote=${remoteHost} origin=${origin}`,
    );
  }

  private async readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    for await (const chunk of request) {
      const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += piece.length;

      if (totalBytes > MAX_JSON_BODY_BYTES) {
        throw new Error("JSON payload exceeded limit.");
      }

      chunks.push(piece);
    }

    if (chunks.length === 0) {
      return {};
    }

    const raw = Buffer.concat(chunks).toString("utf8");
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("JSON body must be an object.");
      }
      return parsed as Record<string, unknown>;
    } catch (error) {
      throw new Error(`Invalid JSON payload: ${String(error)}`);
    }
  }

  private serveStaticFile(pathname: string, response: ServerResponse): void {
    // Force relative static paths so `join(publicDir, safePath)` never discards `publicDir`.
    const safePath = normalize(pathname === "/" ? "index.html" : pathname)
      .replace(/^[/\\]+/, "")
      .replace(/^\.+/, "");
    const filePath = resolve(join(this.config.publicDir, safePath));

    const publicRoot = resolve(this.config.publicDir);
    if (!filePath.startsWith(publicRoot)) {
      this.writeJson(response, 400, {
        error: "INVALID_PATH",
        message: "Invalid static file path.",
      });
      return;
    }

    if (!existsSync(filePath) || !statSafeIsFile(filePath)) {
      this.writeJson(response, 404, {
        error: "NOT_FOUND",
        message: `Static file not found: ${pathname}`,
      });
      return;
    }

    const content = readFileSync(filePath);
    response.statusCode = 200;
    response.setHeader("content-type", contentTypeFor(filePath));
    // Development-first behavior: always serve latest UI/assets without stale browser cache.
    response.setHeader("cache-control", "no-store, no-cache, must-revalidate");
    response.setHeader("pragma", "no-cache");
    response.setHeader("expires", "0");
    response.end(content);
  }

  private writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
    response.statusCode = statusCode;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify(payload));
  }

  private nextRequestId(): string {
    this.requestSeq += 1;
    return `hub-${this.requestSeq}`;
  }

  private buildSecurityPosture(): {
    posture: "ok" | "warn" | "danger";
    bindHost: string;
    port: number;
    authEnabled: boolean;
    tokenLength: number;
    warnings: string[];
  } {
    const bindHost = this.config.bindHost;
    const token = this.config.authToken ?? "";
    const tokenLength = token.length;
    const authEnabled = tokenLength > 0;
    const localBind = isLocalBindHost(bindHost);
    const warnings: string[] = [];
    let posture: "ok" | "warn" | "danger" = "ok";

    if (!localBind && !authEnabled) {
      posture = "danger";
      warnings.push("Hub is exposed beyond localhost without auth token.");
    } else if (!localBind && tokenLength < 16) {
      posture = "warn";
      warnings.push("Hub is exposed beyond localhost with a weak token. Use 16+ chars.");
    }

    return {
      posture,
      bindHost,
      port: this.config.port,
      authEnabled,
      tokenLength,
      warnings,
    };
  }
}

function normalizeRemoteHost(address: string | undefined): string {
  if (!address) {
    return "127.0.0.1";
  }

  if (address.startsWith("::ffff:")) {
    return address.slice(7);
  }

  return address;
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function isLocalBindHost(host: string): boolean {
  const normalized = String(host || "").trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function normalizeOrigin(origin: string): string | null {
  try {
    const parsed = new URL(origin);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol !== "http:" && protocol !== "https:") {
      return null;
    }
    return parsed.origin.toLowerCase();
  } catch {
    return null;
  }
}

function isSameHostOrigin(origin: string, host: string): boolean {
  try {
    const parsed = new URL(origin);
    return parsed.host.toLowerCase() === host;
  } catch {
    return false;
  }
}

function appendVaryHeader(response: ServerResponse, token: string): void {
  const existing = response.getHeader("vary");
  const incoming = token.toLowerCase();

  if (!existing) {
    response.setHeader("vary", token);
    return;
  }

  const current = String(existing)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  const hasToken = current.some((item) => item.toLowerCase() === incoming);
  if (!hasToken) {
    current.push(token);
    response.setHeader("vary", current.join(", "));
  }
}

function sanitizeHeaderValue(value: string | string[] | undefined): string {
  if (!value) {
    return "";
  }

  const asString = Array.isArray(value) ? value.join(",") : value;
  return asString.slice(0, 160).replace(/\s+/g, " ").trim();
}

function requireObject(value: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected JSON object payload.");
  }

  return value;
}

function contentTypeFor(filePath: string): string {
  const extension = extname(filePath).toLowerCase();

  switch (extension) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".webmanifest":
      return "application/manifest+json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    default:
      return "application/octet-stream";
  }
}

function statSafeIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function notFound(route: string): HubErrorPayload {
  return {
    error: "NOT_FOUND",
    message: `Route not found: ${route}`,
  };
}
