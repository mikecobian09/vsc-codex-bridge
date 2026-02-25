import { BridgeRecord } from "./types";

export interface ProxyResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Performs a direct proxy request from hub to a bridge internal endpoint.
 */
export async function proxyJsonRequest(options: {
  bridge: BridgeRecord;
  path: string;
  method: "GET" | "POST";
  body?: unknown;
}): Promise<ProxyResult> {
  const url = new URL(options.path, `http://${options.bridge.host}:${options.bridge.meta.port}`).toString();

  const response = await fetch(url, {
    method: options.method,
    headers: {
      "content-type": "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  // Keep full upstream payload so JSON responses remain valid for large thread histories.
  const text = await response.text();
  return {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/json; charset=utf-8",
    },
    body: text,
  };
}

/**
 * Builds the upstream websocket URL for a turn stream.
 */
export function buildBridgeWsUrl(bridge: BridgeRecord, turnId: string): string {
  return `ws://${bridge.host}:${bridge.meta.port}/internal/v1/turns/${encodeURIComponent(turnId)}/stream`;
}
