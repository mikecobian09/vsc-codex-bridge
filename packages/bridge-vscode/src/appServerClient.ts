import { ChildProcess, spawn } from "child_process";
import { createServer, Server as NetServer } from "net";
import WebSocket from "ws";
import { discoverAppServerAttachUrls } from "./appServerDiscovery";
import { Logger } from "./logger";
import { AppServerConfig } from "./types";

type RequestId = string | number;

interface JsonRpcRequest {
  id: RequestId;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  id: RequestId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

export interface ServerRequestMessage {
  id: RequestId;
  method: string;
  params: unknown;
}

export interface AppServerClientHandlers {
  onNotification?: (method: string, params: unknown) => void;
  onServerRequest?: (request: ServerRequestMessage) => Promise<boolean>;
}

export class AppServerRpcError extends Error {
  public constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "AppServerRpcError";
  }
}

export class AppServerClient {
  private process: ChildProcess | null = null;
  private socket: WebSocket | null = null;
  private running = false;
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<string, PendingRequest>();

  public constructor(
    private readonly config: AppServerConfig,
    private readonly logger: Logger,
    private readonly handlers: AppServerClientHandlers,
    private readonly clientVersion: string,
  ) {}

  public async start(): Promise<void> {
    if (this.running) {
      return;
    }

    if (this.config.mode === "attach") {
      const attached = await this.tryAttachMode();
      if (attached) {
        return;
      }

      throw new Error(
        "Attach mode failed to connect to a running app-server. Update vscCodexBridge.appServerAttachUrl or switch vscCodexBridge.appServerMode to 'spawn'.",
      );
    }

    await this.startSpawnMode();
  }

  public async stop(): Promise<void> {
    const closePromises: Promise<void>[] = [];

    closePromises.push(...this.buildSocketClosePromises());
    closePromises.push(...this.buildProcessClosePromises());

    rejectAllPending(this.pendingRequests, new Error("app-server client stopped"));

    if (closePromises.length > 0) {
      await Promise.all(closePromises);
    }

    this.running = false;
  }

  private async tryAttachMode(): Promise<boolean> {
    if (this.config.mode !== "attach") {
      return false;
    }

    const failedUrls = new Set<string>();

    if (this.config.attachUrl) {
      const attached = await this.tryAttachUrl(this.config.attachUrl, "configured");
      if (attached) {
        return true;
      }
      failedUrls.add(this.config.attachUrl);
    }

    const discoveredUrls = await discoverAppServerAttachUrls();
    const uniqueDiscoveredUrls = discoveredUrls.filter((url) => !failedUrls.has(url));

    if (uniqueDiscoveredUrls.length === 0) {
      if (this.config.attachUrl) {
        this.logger.warn("Attach mode failed with configured URL and auto-discovery found no running app-server.");
      } else {
        this.logger.warn("app-server attach mode selected, but no attach URL was configured or auto-detected.");
      }
      return false;
    }

    for (const discoveredUrl of uniqueDiscoveredUrls) {
      this.logger.info(`Auto-detected app-server URL for attach mode: ${discoveredUrl}`);
      const attached = await this.tryAttachUrl(discoveredUrl, "auto-detected");
      if (attached) {
        return true;
      }

      failedUrls.add(discoveredUrl);
    }

    if (this.config.attachUrl) {
      this.logger.warn("Attach mode failed with configured URL and all auto-detected URLs.");
    } else {
      this.logger.warn("Attach mode failed for all auto-detected URLs.");
    }

    return false;
  }

  private async tryAttachUrl(url: string, source: "configured" | "auto-detected"): Promise<boolean> {
    try {
      this.logger.info(`Connecting to existing app-server (${source} attach URL): ${url}`);
      await this.connectSocket(url);
      await this.initializeSession();

      this.running = true;
      this.logger.info(`Connected to app-server at ${url} (attach mode)`);
      return true;
    } catch (error) {
      this.logger.warn(`Attach mode failed at ${url}: ${String(error)}`);
      await this.closeSocketOnly(`attach mode fallback (${source})`);
      return false;
    }
  }

  private async startSpawnMode(): Promise<void> {
    const port = await findAvailablePort(this.config.host);
    const listenUrl = `ws://${this.config.host}:${port}`;
    const args = ["app-server", "--listen", listenUrl, ...this.config.extraArgs];
    this.logger.info(`Starting app-server: ${this.config.command} ${args.join(" ")}`);

    const processRef = spawn(this.config.command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.process = processRef;

    processRef.stdout?.on("data", (chunk) => {
      this.logger.debug(`[app-server stdout] ${String(chunk).trimEnd()}`);
    });
    processRef.stderr?.on("data", (chunk) => {
      this.logger.debug(`[app-server stderr] ${String(chunk).trimEnd()}`);
    });

    const exitPromise = new Promise<never>((_, reject) => {
      processRef.once("error", (error) => {
        reject(new Error(`Failed to launch app-server process: ${String(error)}`));
      });
      processRef.once("exit", (code, signal) => {
        reject(new Error(`app-server exited before initialization (code=${code}, signal=${signal ?? "none"})`));
      });
    });

    try {
      await Promise.race([this.connectSocket(listenUrl), exitPromise]);
      await this.initializeSession();
    } catch (error) {
      await this.closeSocketOnly("spawn startup failure");
      await this.stopProcessOnly();
      throw error;
    }

    this.running = true;
    this.logger.info(`Connected to app-server at ${listenUrl}`);
  }

  private async initializeSession(): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "vsc-codex-bridge",
        title: "VSC Codex Bridge",
        version: this.clientVersion,
      },
      capabilities: {
        experimentalApi: this.config.experimentalApi,
      },
    });
    this.notify("initialized");
  }

  private buildSocketClosePromises(): Promise<void>[] {
    const closePromises: Promise<void>[] = [];

    if (this.socket) {
      const ws = this.socket;
      if (ws) {
        closePromises.push(
          new Promise<void>((resolve) => {
            this.socket = null;

            ws.once("close", () => resolve());
            ws.once("error", () => resolve());

            try {
              ws.close();
            } catch {
              resolve();
            }

            setTimeout(() => resolve(), 1000);
          }),
        );
      }
    }

    return closePromises;
  }

  private buildProcessClosePromises(): Promise<void>[] {
    const closePromises: Promise<void>[] = [];

    if (this.process) {
      const processRef = this.process;
      if (processRef) {
        closePromises.push(
          new Promise<void>((resolve) => {
            this.process = null;

            processRef.once("exit", () => resolve());
            try {
              processRef.kill();
            } catch {
              resolve();
            }

            setTimeout(() => {
              try {
                processRef.kill("SIGKILL");
              } catch {
                // no-op
              }
              resolve();
            }, 1500);
          }),
        );
      }
    }

    return closePromises;
  }

  private async closeSocketOnly(reason: string): Promise<void> {
    if (!this.socket) {
      return;
    }

    this.logger.debug(`Closing app-server websocket (${reason}).`);
    await Promise.all(this.buildSocketClosePromises());
    rejectAllPending(this.pendingRequests, new Error(`app-server websocket closed: ${reason}`));
  }

  private async stopProcessOnly(): Promise<void> {
    if (!this.process) {
      return;
    }

    this.logger.debug("Stopping spawned app-server process.");
    await Promise.all(this.buildProcessClosePromises());
  }

  public async request<T>(method: string, params?: unknown): Promise<T> {
    this.ensureSocket();

    const id = this.nextRequestId;
    this.nextRequestId += 1;

    const request: JsonRpcRequest = {
      id,
      method,
      params,
    };

    return new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(idKey(id), { resolve: resolve as (value: unknown) => void, reject });

      try {
        this.socket?.send(JSON.stringify(request));
      } catch (error) {
        this.pendingRequests.delete(idKey(id));
        reject(error);
      }
    });
  }

  public notify(method: string, params?: unknown): void {
    this.ensureSocket();

    const notification: JsonRpcNotification = {
      method,
      params,
    };

    this.socket?.send(JSON.stringify(notification));
  }

  public sendResponse(id: RequestId, result: unknown): void {
    this.ensureSocket();
    const response: JsonRpcResponse = {
      id,
      result,
    };
    this.socket?.send(JSON.stringify(response));
  }

  public sendErrorResponse(id: RequestId, code: number, message: string, data?: unknown): void {
    this.ensureSocket();
    const response: JsonRpcResponse = {
      id,
      error: {
        code,
        message,
        data,
      },
    };
    this.socket?.send(JSON.stringify(response));
  }

  private async connectSocket(url: string): Promise<void> {
    const deadline = Date.now() + this.config.startupTimeoutMs;
    let lastError: unknown = null;

    while (Date.now() < deadline) {
      const remainingMs = deadline - Date.now();
      try {
        await this.connectSocketOnce(url, Math.max(300, remainingMs));
        return;
      } catch (error) {
        lastError = error;
        await sleep(120);
      }
    }

    throw new Error(
      `Timeout connecting to app-server (${this.config.startupTimeoutMs} ms). Last error: ${String(lastError)}`,
    );
  }

  private async connectSocketOnce(url: string, timeoutMs: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out waiting for websocket handshake (${timeoutMs} ms)`));
      }, timeoutMs);

      const socket = new WebSocket(url, { perMessageDeflate: false });

      const fail = (error: unknown): void => {
        clearTimeout(timeout);
        try {
          socket.close();
        } catch {
          // no-op
        }
        reject(error);
      };

      socket.once("open", () => {
        clearTimeout(timeout);

        this.socket = socket;

        socket.on("message", (message) => {
          this.handleMessage(message);
        });

        socket.on("error", (error) => {
          this.logger.warn(`app-server websocket error: ${String(error)}`);
        });

        socket.on("close", () => {
          this.logger.warn("app-server websocket closed.");
          this.socket = null;
          rejectAllPending(this.pendingRequests, new Error("app-server websocket closed"));
        });

        resolve();
      });

      socket.once("error", fail);
      socket.once("unexpected-response", (_request, response) => {
        fail(new Error(`Unexpected app-server WS response: ${response.statusCode}`));
      });
    });
  }

  private handleMessage(payload: WebSocket.RawData): void {
    const text = typeof payload === "string" ? payload : payload.toString("utf8");

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      this.logger.warn(`Ignoring non-JSON app-server payload: ${String(error)}`);
      return;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return;
    }

    const message = parsed as Record<string, unknown>;

    const hasMethod = typeof message.method === "string";
    const hasId = typeof message.id === "string" || typeof message.id === "number";

    if (hasMethod && hasId) {
      const request: ServerRequestMessage = {
        id: message.id as RequestId,
        method: String(message.method),
        params: message.params,
      };

      void this.handleServerRequest(request);
      return;
    }

    if (hasMethod) {
      this.handlers.onNotification?.(String(message.method), message.params);
      return;
    }

    if (hasId && (Object.prototype.hasOwnProperty.call(message, "result") || Object.prototype.hasOwnProperty.call(message, "error"))) {
      this.handleResponse(message as unknown as JsonRpcResponse);
    }
  }

  private async handleServerRequest(request: ServerRequestMessage): Promise<void> {
    try {
      const handled = (await this.handlers.onServerRequest?.(request)) ?? false;
      if (!handled) {
        this.sendErrorResponse(request.id, -32601, `Unsupported server request method: ${request.method}`);
      }
    } catch (error) {
      this.sendErrorResponse(request.id, -32000, `Failed to handle server request: ${String(error)}`);
    }
  }

  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pendingRequests.get(idKey(response.id));
    if (!pending) {
      return;
    }

    this.pendingRequests.delete(idKey(response.id));

    if (response.error) {
      pending.reject(new AppServerRpcError(response.error.code, response.error.message, response.error.data));
      return;
    }

    pending.resolve(response.result);
  }

  private ensureSocket(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("app-server websocket is not connected.");
    }
  }
}

function idKey(id: RequestId): string {
  return String(id);
}

function rejectAllPending(pendingRequests: Map<string, PendingRequest>, error: Error): void {
  for (const entry of pendingRequests.values()) {
    entry.reject(error);
  }
  pendingRequests.clear();
}

async function findAvailablePort(host: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server: NetServer = createServer();

    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to resolve ephemeral app-server port.")));
        return;
      }

      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
