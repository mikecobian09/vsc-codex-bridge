import { Logger } from "./logger";
import { BridgeMeta, HubConfig } from "./types";
import { nowIso } from "./utils";

const HUB_ERROR_LOG_THROTTLE_MS = 30_000;
const REGISTER_RETRY_BASE_MS = 1_000;
const REGISTER_RETRY_MAX_MS = 30_000;
const REGISTER_RETRY_JITTER_RATIO = 0.2;

type RegisterReason = "startup" | "heartbeat-unregistered" | "heartbeat-404" | "retry";

export interface HubRegistrationState {
  isRegistered: boolean;
  registrationInFlight: boolean;
  lastRegisterAttemptAt: number | null;
  lastRegisterSuccessAt: number | null;
  lastRegisterError: string | null;
  currentRetryDelayMs: number;
}

export class HubRequestError extends Error {
  public constructor(
    public readonly kind: "http" | "network",
    message: string,
    public readonly status?: number,
    public readonly responseBody?: string,
  ) {
    super(message);
    this.name = "HubRequestError";
  }
}

export class HubClient {
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private registerRetryTimer: NodeJS.Timeout | null = null;

  private running = false;
  private lastErrorLogAt = 0;

  private isRegistered = false;
  private registrationInFlight = false;
  private lastRegisterAttemptAt: number | null = null;
  private lastRegisterSuccessAt: number | null = null;
  private lastRegisterError: string | null = null;
  private currentRetryDelayMs = REGISTER_RETRY_BASE_MS;

  public constructor(
    private readonly config: HubConfig,
    private readonly logger: Logger,
    private readonly getBridgeMeta: () => BridgeMeta,
  ) {}

  public async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;

    // Do not block startup on registration: recovery state machine handles retries.
    void this.attemptRegister("startup", true);

    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat();
    }, this.config.heartbeatIntervalMs);
  }

  public async stop(): Promise<void> {
    this.running = false;
    this.isRegistered = false;
    this.registrationInFlight = false;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.registerRetryTimer) {
      clearTimeout(this.registerRetryTimer);
      this.registerRetryTimer = null;
    }
  }

  public getRegistrationState(): HubRegistrationState {
    return {
      isRegistered: this.isRegistered,
      registrationInFlight: this.registrationInFlight,
      lastRegisterAttemptAt: this.lastRegisterAttemptAt,
      lastRegisterSuccessAt: this.lastRegisterSuccessAt,
      lastRegisterError: this.lastRegisterError,
      currentRetryDelayMs: this.currentRetryDelayMs,
    };
  }

  private async heartbeat(): Promise<void> {
    if (!this.running) {
      return;
    }

    const meta = this.getBridgeMeta();

    if (!this.isRegistered) {
      this.logger.debug(
        `Heartbeat skipped while bridge is not registered (${meta.bridgeId}); retry delay ${this.currentRetryDelayMs} ms.`,
      );
      void this.attemptRegister("heartbeat-unregistered");
      return;
    }

    const heartbeatPath = this.config.hubHeartbeatPath.replace(":bridgeId", encodeURIComponent(meta.bridgeId));

    try {
      await this.postJson(heartbeatPath, {
        bridgeId: meta.bridgeId,
        heartbeatAt: nowIso(),
        status: meta.status,
      });
      this.logger.debug(`Heartbeat sent for ${meta.bridgeId}`);
    } catch (error) {
      if (error instanceof HubRequestError && error.kind === "http" && error.status === 404) {
        this.isRegistered = false;
        this.lastRegisterError = error.message;
        this.logger.warn(`Bridge ${meta.bridgeId} is no longer registered in hub (heartbeat returned 404).`);
        void this.attemptRegister("heartbeat-404", true);
        return;
      }

      this.logHubError(`Heartbeat failed (${meta.bridgeId})`, error);
    }
  }

  private async attemptRegister(reason: RegisterReason, force = false): Promise<void> {
    if (!this.running) {
      return;
    }

    if (this.registrationInFlight) {
      return;
    }

    if (this.registerRetryTimer && !force) {
      return;
    }

    if (force && this.registerRetryTimer) {
      clearTimeout(this.registerRetryTimer);
      this.registerRetryTimer = null;
    }

    const meta = this.getBridgeMeta();
    this.registrationInFlight = true;
    this.lastRegisterAttemptAt = Date.now();

    try {
      await this.postJson(this.config.hubRegisterPath, {
        ...meta,
        registeredAt: nowIso(),
      });

      if (!this.running) {
        return;
      }

      const wasRegistered = this.isRegistered;
      this.isRegistered = true;
      this.lastRegisterSuccessAt = Date.now();
      this.lastRegisterError = null;
      this.currentRetryDelayMs = REGISTER_RETRY_BASE_MS;

      if (wasRegistered) {
        this.logger.debug(`Bridge registration refreshed in hub (${meta.bridgeId}) [${reason}].`);
      } else {
        this.logger.info(`Bridge registered in hub (${meta.bridgeId}) [${reason}].`);
      }
    } catch (error) {
      if (!this.running) {
        return;
      }

      this.isRegistered = false;
      this.lastRegisterError = String(error);

      this.logHubError(`Bridge registration failed (${meta.bridgeId}) [${reason}]`, error);
      this.scheduleRegisterRetry(reason);
    } finally {
      this.registrationInFlight = false;
    }
  }

  private scheduleRegisterRetry(reason: RegisterReason): void {
    if (!this.running) {
      return;
    }

    if (this.registerRetryTimer) {
      return;
    }

    const delayMs = withJitter(this.currentRetryDelayMs, REGISTER_RETRY_JITTER_RATIO);
    this.currentRetryDelayMs = Math.min(REGISTER_RETRY_MAX_MS, this.currentRetryDelayMs * 2);

    this.logger.debug(`Scheduling bridge registration retry in ${delayMs} ms (${reason}).`);

    this.registerRetryTimer = setTimeout(() => {
      this.registerRetryTimer = null;
      void this.attemptRegister("retry");
    }, delayMs);
  }

  private async postJson(path: string, payload: Record<string, unknown>): Promise<void> {
    const url = new URL(path, this.config.hubUrl).toString();

    const headers: Record<string, string> = {
      "content-type": "application/json",
    };

    if (this.config.hubToken) {
      headers.authorization = `Bearer ${this.config.hubToken}`;
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
    } catch (error) {
      throw new HubRequestError("network", `Hub network error: ${String(error)}`);
    }

    if (!response.ok) {
      const body = await response.text();
      throw new HubRequestError("http", `Hub HTTP ${response.status}: ${truncate(body, 400)}`, response.status, body);
    }
  }

  private logHubError(message: string, error: unknown): void {
    const now = Date.now();
    if (now - this.lastErrorLogAt < HUB_ERROR_LOG_THROTTLE_MS) {
      this.logger.debug(`${message}: ${String(error)}`);
      return;
    }

    this.lastErrorLogAt = now;
    this.logger.warn(`${message}: ${String(error)}`);
  }
}

function withJitter(baseDelayMs: number, jitterRatio: number): number {
  const minFactor = 1 - jitterRatio;
  const maxFactor = 1 + jitterRatio;
  const factor = minFactor + Math.random() * (maxFactor - minFactor);

  return Math.max(250, Math.floor(baseDelayMs * factor));
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}
