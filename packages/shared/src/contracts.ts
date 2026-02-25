/**
 * Shared request contracts consumed by bridge, hub, and clients.
 */
export type AccessMode = "plan-only" | "full-access";

export interface SendMessageRequest {
  text: string;
  modelId?: string | null;
  accessMode?: AccessMode | null;
}

export interface SteerRequest {
  text: string;
}

export interface ApprovalDecisionRequest {
  decision: "approve" | "deny";
}

/**
 * Parse and validate a send-message payload.
 * Throws a descriptive error when payload is invalid.
 */
export function parseSendMessageRequest(value: unknown): SendMessageRequest {
  const payload = requireObject(value, "send message payload");

  const text = requireNonEmptyString(payload.text, "text");
  const modelId = parseOptionalStringOrNull(payload.modelId, "modelId");
  const accessMode = parseOptionalAccessModeOrNull(payload.accessMode, "accessMode");

  return {
    text,
    ...(modelId !== undefined ? { modelId } : {}),
    ...(accessMode !== undefined ? { accessMode } : {}),
  };
}

/**
 * Parse and validate a steer payload.
 * Throws a descriptive error when payload is invalid.
 */
export function parseSteerRequest(value: unknown): SteerRequest {
  const payload = requireObject(value, "steer payload");
  return {
    text: requireNonEmptyString(payload.text, "text"),
  };
}

/**
 * Parse and validate an approval-decision payload.
 * Throws a descriptive error when payload is invalid.
 */
export function parseApprovalDecisionRequest(value: unknown): ApprovalDecisionRequest {
  const payload = requireObject(value, "approval decision payload");
  const decision = payload.decision;

  if (decision !== "approve" && decision !== "deny") {
    throw new Error("Field 'decision' must be 'approve' or 'deny'.");
  }

  return { decision };
}

export function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }

  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Field '${field}' must be a string.`);
  }

  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Field '${field}' must not be empty.`);
  }

  return normalized;
}

function parseOptionalStringOrNull(value: unknown, field: string): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`Field '${field}' must be a string, null, or omitted.`);
  }

  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Field '${field}' must not be empty when provided.`);
  }
  return normalized;
}

function parseOptionalAccessModeOrNull(value: unknown, field: string): AccessMode | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (value === "plan-only" || value === "full-access") {
    return value;
  }
  throw new Error(`Field '${field}' must be 'plan-only', 'full-access', null, or omitted.`);
}
