import { execFile } from "child_process";
import { Socket } from "net";

const DISCOVERY_TIMEOUT_MS = 1500;
const DISCOVERY_MAX_BUFFER_BYTES = 256 * 1024;

interface DetectedCandidate {
  pid: number;
  url: string;
}

/**
 * Attempts to discover a running local Codex app-server websocket URL by
 * scanning process arguments. This is best-effort and currently implemented
 * for macOS/Linux via `pgrep`.
 */
export async function discoverAppServerAttachUrl(): Promise<string | null> {
  const urls = await discoverAppServerAttachUrls();
  return urls.length > 0 ? urls[0] : null;
}

/**
 * Returns a prioritized list of candidate local Codex app-server websocket URLs.
 * Ordering favors newer processes first.
 */
export async function discoverAppServerAttachUrls(): Promise<string[]> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return [];
  }

  const lsofCandidates = (await discoverViaLsof()).sort((left, right) => right.pid - left.pid);
  // Prefer socket-level discovery. If lsof finds listeners, trust those candidates.
  if (lsofCandidates.length > 0) {
    const urls = dedupeCandidates(lsofCandidates).map((candidate) => candidate.url);
    return prioritizeReachableUrls(urls);
  }

  // Fallback path when lsof cannot provide candidates in this environment.
  const pgrepCandidates = (await discoverViaPgrep()).sort((left, right) => right.pid - left.pid);
  const candidates = dedupeCandidates(pgrepCandidates);

  if (candidates.length === 0) {
    return [];
  }

  const urls = candidates.map((candidate) => candidate.url);
  return prioritizeReachableUrls(urls);
}

async function discoverViaPgrep(): Promise<DetectedCandidate[]> {
  try {
    const output = await execFileText("pgrep", ["-fal", "codex app-server"]);
    return parseAppServerCandidates(output);
  } catch {
    return [];
  }
}

async function discoverViaLsof(): Promise<DetectedCandidate[]> {
  try {
    const output = await execFileText("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"]);
    return parseLsofCandidates(output);
  } catch {
    return [];
  }
}

function dedupeCandidates(candidates: DetectedCandidate[]): DetectedCandidate[] {
  const seen = new Set<string>();
  const unique: DetectedCandidate[] = [];

  for (const candidate of candidates) {
    const key = `${candidate.pid}|${candidate.url}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(candidate);
  }

  return unique;
}

function parseAppServerCandidates(output: string): DetectedCandidate[] {
  const lines = output.split(/\r?\n/);
  const candidates: DetectedCandidate[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const pidMatch = trimmed.match(/^(\d+)\s+(.+)$/);
    if (!pidMatch) {
      continue;
    }

    const pid = Number(pidMatch[1]);
    if (!Number.isFinite(pid)) {
      continue;
    }

    const command = pidMatch[2];
    const listenMatch = command.match(/--listen\s+(ws[s]?:\/\/[^\s]+)/i);
    if (!listenMatch) {
      continue;
    }

    const url = normalizeLocalWebSocketUrl(listenMatch[1]);
    if (!url) {
      continue;
    }

    candidates.push({
      pid,
      url,
    });
  }

  return candidates;
}

function parseLsofCandidates(output: string): DetectedCandidate[] {
  const lines = output.split(/\r?\n/);
  const candidates: DetectedCandidate[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("COMMAND")) {
      continue;
    }

    const match = trimmed.match(/^(\S+)\s+(\d+)\s+\S+.+\bTCP\s+(.+?)\s+\(LISTEN\)$/);
    if (!match) {
      continue;
    }

    const command = match[1].toLowerCase();
    if (command !== "codex") {
      continue;
    }

    const pid = Number(match[2]);
    if (!Number.isFinite(pid)) {
      continue;
    }

    const endpoint = match[3];
    const endpointMatch = endpoint.match(/(?:127\.0\.0\.1|localhost|\[::1\]|\*):(\d+)$/i);
    if (!endpointMatch) {
      continue;
    }

    const port = Number(endpointMatch[1]);
    if (!Number.isFinite(port) || port <= 0) {
      continue;
    }

    candidates.push({
      pid,
      url: `ws://127.0.0.1:${port}`,
    });
  }

  return candidates;
}

function normalizeLocalWebSocketUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      return null;
    }

    const host = url.hostname.toLowerCase();
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
      return null;
    }

    if (!url.port) {
      return null;
    }

    return `${url.protocol}//${url.hostname}:${url.port}`;
  } catch {
    return null;
  }
}

async function prioritizeReachableUrls(urls: string[]): Promise<string[]> {
  const reachable: string[] = [];

  for (const url of urls) {
    const ok = await isTcpReachable(url, 300);
    if (ok) {
      reachable.push(url);
    }
  }

  // Fail fast when no candidate is reachable to avoid long attach timeout loops
  // against stale process-argument URLs.
  return reachable;
}

async function isTcpReachable(rawUrl: string, timeoutMs: number): Promise<boolean> {
  try {
    const parsed = new URL(rawUrl);
    const port = Number(parsed.port);
    if (!Number.isFinite(port) || port <= 0) {
      return false;
    }

    const host = parsed.hostname || "127.0.0.1";

    return await new Promise<boolean>((resolve) => {
      const socket = new Socket();

      const finalize = (result: boolean): void => {
        socket.removeAllListeners();
        try {
          socket.destroy();
        } catch {
          // no-op
        }
        resolve(result);
      };

      socket.setTimeout(timeoutMs);
      socket.once("connect", () => finalize(true));
      socket.once("timeout", () => finalize(false));
      socket.once("error", () => finalize(false));

      try {
        socket.connect(port, host);
      } catch {
        finalize(false);
      }
    });
  } catch {
    return false;
  }
}

function execFileText(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        timeout: DISCOVERY_TIMEOUT_MS,
        maxBuffer: DISCOVERY_MAX_BUFFER_BYTES,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(stdout);
      },
    );
  });
}
