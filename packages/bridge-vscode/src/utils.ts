import { createHash, randomUUID } from "crypto";

export function createBridgeId(cwd: string): string {
  const digest = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  return `bridge_${digest}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function safeJsonParse(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return undefined;
  }
}
