#!/usr/bin/env node
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { CodexPrimeBridge, type PrimeCodexMode } from "./codex-prime-bridge";
import { StrictJsonlDecoder } from "../prime/jsonl";
import type { PrimeThinkingLevel } from "../prime/rpc-client";

async function executable(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function realCodexPath(): Promise<string> {
  const explicit = process.env.PRIMECODEX_REAL_CODEX_PATH;
  if (explicit) return explicit;

  const desktopAppPath =
    process.env.PRIMECODEX_DESKTOP_APP_PATH ??
    (process.platform === "darwin" ? "/Applications/ChatGPT.app" : undefined);
  if (desktopAppPath) {
    const bundled = path.join(desktopAppPath, "Contents", "Resources", "codex");
    if (await executable(bundled)) return bundled;
  }

  const ownPath = path.resolve(process.argv[1] ?? "");
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, "codex");
    if (path.resolve(candidate) !== ownPath && (await executable(candidate))) {
      return candidate;
    }
  }
  const fallback = path.join(os.homedir(), ".local", "bin", "codex");
  if (await executable(fallback)) return fallback;
  throw new Error("Could not locate the real Codex CLI");
}

function passthrough(command: string, args: string[]): void {
  const child = spawn(command, args, { stdio: "inherit", env: process.env });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
  child.on("error", (error) => {
    console.error(error.message);
    process.exit(1);
  });
}

function parseMode(): "codex" | PrimeCodexMode {
  const value = process.env.PRIMECODEX_BACKEND ?? "codex";
  return value === "prime" || value === "hybrid" ? value : "codex";
}

function parseThinking(): PrimeThinkingLevel {
  const value = process.env.PRIMECODEX_PRIME_THINKING;
  if (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  ) {
    return value;
  }
  return "xhigh";
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const realCodex = await realCodexPath();
  const mode = parseMode();
  const isAppServer = args.includes("app-server");
  if (!isAppServer || mode === "codex") {
    passthrough(realCodex, args);
    return;
  }

  const bridge = new CodexPrimeBridge({
    realCodexCommand: realCodex,
    realCodexArgs: args,
    primeCommand: process.env.PRIME_AGENT_CLI_PATH ?? "prime-agent",
    mode,
    newThreadBackend:
      process.env.PRIMECODEX_NEW_THREAD_BACKEND === "prime" ? "prime" : "codex",
    controlFile: process.env.PRIMECODEX_CONTROL_FILE,
    defaultPrimeThinking: parseThinking(),
  });

  const decoder = new StrictJsonlDecoder();
  let chain = Promise.resolve();
  process.stdin.on("data", (chunk: Buffer) => {
    for (const line of decoder.push(chunk)) {
      if (!line.trim()) continue;
      chain = chain.then(async () => {
        try {
          await bridge.handle(JSON.parse(line));
        } catch (error) {
          console.error(error instanceof Error ? error.message : String(error));
        }
      });
    }
  });
  process.stdin.on("end", () => {
    chain = chain.finally(async () => bridge.close());
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void bridge.close().finally(() => process.exit(0));
    });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
