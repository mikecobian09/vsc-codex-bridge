import { BridgeHeartbeatPayload, BridgeMeta, BridgeRecord, BridgeRegistrationPayload } from "./types";

/**
 * In-memory registry for active bridges.
 *
 * The hub treats a bridge as active when its last heartbeat is inside the configured TTL window.
 * Stale entries are marked and can be pruned by the caller.
 */
export class BridgeRegistry {
  private readonly bridges = new Map<string, BridgeRecord>();

  public constructor(private readonly ttlMs: number) {}

  public register(payload: BridgeRegistrationPayload, sourceHost: string, nowIso: string): BridgeRecord {
    const existing = this.bridges.get(payload.bridgeId);
    const host = normalizeHost(payload.host, sourceHost);

    const meta: BridgeMeta = {
      bridgeId: payload.bridgeId,
      workspaceName: payload.workspaceName,
      cwd: payload.cwd,
      port: payload.port,
      pid: payload.pid,
      startedAt: payload.startedAt,
      bridgeVersion: payload.bridgeVersion,
      status: "online",
      heartbeatAt: payload.heartbeatAt ?? nowIso,
    };

    const record: BridgeRecord = {
      meta,
      host,
      registeredAt: payload.registeredAt ?? existing?.registeredAt ?? nowIso,
      lastHeartbeatAt: payload.heartbeatAt ?? nowIso,
      stale: false,
    };

    this.bridges.set(payload.bridgeId, record);
    return cloneRecord(record);
  }

  public heartbeat(bridgeId: string, payload: BridgeHeartbeatPayload, nowIso: string): BridgeRecord | null {
    const record = this.bridges.get(bridgeId);
    if (!record) {
      return null;
    }

    record.lastHeartbeatAt = payload.heartbeatAt || nowIso;
    record.meta.heartbeatAt = payload.heartbeatAt || nowIso;
    record.meta.status = "online";
    record.stale = false;

    return cloneRecord(record);
  }

  public get(bridgeId: string): BridgeRecord | null {
    const record = this.bridges.get(bridgeId);
    if (!record) {
      return null;
    }

    if (this.isStale(record, Date.now())) {
      record.stale = true;
      return null;
    }

    return cloneRecord(record);
  }

  public listActive(): BridgeRecord[] {
    const now = Date.now();
    const active: BridgeRecord[] = [];

    for (const record of this.bridges.values()) {
      if (this.isStale(record, now)) {
        record.stale = true;
        continue;
      }

      record.stale = false;
      active.push(cloneRecord(record));
    }

    active.sort((left, right) => {
      const byWorkspace = left.meta.workspaceName.localeCompare(right.meta.workspaceName);
      if (byWorkspace !== 0) {
        return byWorkspace;
      }
      return left.meta.bridgeId.localeCompare(right.meta.bridgeId);
    });

    return active;
  }

  public pruneStale(): string[] {
    const now = Date.now();
    const removed: string[] = [];

    for (const [bridgeId, record] of this.bridges.entries()) {
      if (!this.isStale(record, now)) {
        continue;
      }

      this.bridges.delete(bridgeId);
      removed.push(bridgeId);
    }

    return removed;
  }

  public snapshot(): { total: number; active: number } {
    const total = this.bridges.size;
    const active = this.listActive().length;
    return { total, active };
  }

  private isStale(record: BridgeRecord, nowMs: number): boolean {
    const heartbeatMs = Date.parse(record.lastHeartbeatAt);
    if (!Number.isFinite(heartbeatMs)) {
      return true;
    }

    return nowMs - heartbeatMs > this.ttlMs;
  }
}

function normalizeHost(payloadHost: string | undefined, sourceHost: string): string {
  const candidate = (payloadHost ?? "").trim();
  if (candidate) {
    return candidate;
  }
  return sourceHost;
}

function cloneRecord(record: BridgeRecord): BridgeRecord {
  return {
    meta: { ...record.meta },
    host: record.host,
    registeredAt: record.registeredAt,
    lastHeartbeatAt: record.lastHeartbeatAt,
    stale: record.stale,
  };
}
