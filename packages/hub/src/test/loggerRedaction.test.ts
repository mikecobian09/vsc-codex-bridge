import assert from "node:assert/strict";
import { test } from "node:test";
import { Logger } from "../logger";

test("logger redacts bearer token, URL token query, and authToken JSON field", () => {
  const logger = new Logger(true);
  const lines: string[] = [];

  const originalLog = console.log;
  try {
    console.log = (...args: unknown[]) => {
      lines.push(args.map((item) => String(item)).join(" "));
    };

    logger.info(
      'auth=Bearer super-secret-token-123 url=http://127.0.0.1:7777/ws?token=my-query-token payload={"authToken":"my-config-token"}',
    );
  } finally {
    console.log = originalLog;
  }

  assert.equal(lines.length, 1);
  const line = lines[0];
  assert.equal(line.includes("super-secret-token-123"), false);
  assert.equal(line.includes("my-query-token"), false);
  assert.equal(line.includes("my-config-token"), false);
  assert.equal(line.includes("Bearer ***REDACTED***"), true);
  assert.equal(line.includes("token=***REDACTED***"), true);
  assert.equal(line.includes('"authToken":"***REDACTED***"'), true);
});

