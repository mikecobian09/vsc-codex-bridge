#!/usr/bin/env node
"use strict";

/**
 * Prepares embedded runtime assets for VSIX packaging.
 *
 * Assets copied into `packages/bridge-vscode/runtime`:
 * - hub compiled output
 * - shared compiled contracts
 * - pwa dist bundle
 * - hub ws dependency
 */

const { cpSync, existsSync, mkdirSync, rmSync } = require("fs");
const { resolve, join } = require("path");
const { execSync } = require("child_process");

const extRoot = resolve(__dirname, "..");
const repoRoot = resolve(extRoot, "..", "..");
const runtimeRoot = resolve(extRoot, "runtime");

const sharedOut = resolve(repoRoot, "packages/shared/out");
const hubOut = resolve(repoRoot, "packages/hub/out");
const hubWs = resolve(repoRoot, "packages/hub/node_modules/ws");
const pwaDist = resolve(repoRoot, "packages/pwa/dist");

function run(cmd) {
  execSync(cmd, {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
}

function requirePath(path, message) {
  if (existsSync(path)) {
    return;
  }
  throw new Error(`${message}: ${path}`);
}

function copyDir(from, to, filter) {
  mkdirSync(resolve(to, ".."), { recursive: true });
  cpSync(from, to, {
    recursive: true,
    force: true,
    filter,
  });
}

try {
  console.log("[prepare-runtime] Building shared/hub/pwa runtime artifacts...");
  run("npm --prefix packages/shared run compile");
  run("npm --prefix packages/hub run compile");
  run("npm --prefix packages/pwa run build");

  requirePath(sharedOut, "Shared runtime output not found");
  requirePath(hubOut, "Hub runtime output not found");
  requirePath(hubWs, "Hub ws dependency not found");
  requirePath(pwaDist, "PWA dist output not found");

  rmSync(runtimeRoot, { recursive: true, force: true });

  copyDir(sharedOut, join(runtimeRoot, "shared", "out"), (source) => !source.endsWith(".d.ts"));
  copyDir(hubOut, join(runtimeRoot, "hub", "out"), (source) => {
    if (source.includes(`${join("out", "test")}`)) {
      return false;
    }
    if (source.endsWith(".map") || source.endsWith(".d.ts")) {
      return false;
    }
    return true;
  });
  copyDir(hubWs, join(runtimeRoot, "hub", "node_modules", "ws"));
  copyDir(pwaDist, join(runtimeRoot, "pwa", "dist"));

  console.log("[prepare-runtime] Embedded runtime prepared at packages/bridge-vscode/runtime");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[prepare-runtime] Failed: ${message}`);
  process.exit(1);
}
