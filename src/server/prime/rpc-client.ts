import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { PrimeAgentDaemonRpcClient } from "./daemon-rpc-client";
import { StrictJsonlDecoder, serializeJsonLine } from "./jsonl";

export type PrimeThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type PrimeRpcCommand = {
  type: string;
  [key: string]: unknown;
};

export type PrimeRpcResponse = {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
};

export type PrimeRpcEvent = {
  type: string;
  [key: string]: unknown;
};

export type PrimeAgentRpcClientOptions = {
  command: string;
  cwd: string;
  provider?: string;
  model?: string;
  thinking?: PrimeThinkingLevel;
  resume?: string;
  fork?: string;
};

type PendingRequest = {
  resolve: (response: PrimeRpcResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class PrimeAgentRpcClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private daemon: PrimeAgentDaemonRpcClient | null = null;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly listeners = new Set<(event: PrimeRpcEvent) => void>();
  private requestId = 0;
  private stderr = "";

  constructor(private readonly options: PrimeAgentRpcClientOptions) {}

  async start(): Promise<void> {
    if (this.process || this.daemon) {
      throw new Error("Prime Agent RPC client is already started");
    }

    this.daemon =
      (await PrimeAgentDaemonRpcClient.tryCreate(this.options)) ?? null;
    if (this.daemon) return;

    const args = ["--mode", "rpc", "--cwd", this.options.cwd];
    if (this.options.provider) {
      args.push("--provider", this.options.provider);
    }
    if (this.options.model) {
      args.push("--model", this.options.model);
    }
    if (this.options.thinking) {
      args.push("--thinking", this.options.thinking);
    }
    if (this.options.resume) {
      args.push("--resume", this.options.resume);
    }
    if (this.options.fork) {
      args.push("--fork", this.options.fork);
    }

    const child = spawn(this.options.command, args, {
      cwd: this.options.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = child;

    const decoder = new StrictJsonlDecoder();
    child.stdout.on("data", (chunk: Buffer) => {
      for (const line of decoder.push(chunk)) {
        this.handleLine(line);
      }
    });
    child.stdout.on("end", () => {
      for (const line of decoder.end()) {
        this.handleLine(line);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString("utf8");
    });
    child.on("exit", (code, signal) => {
      const reason = new Error(
        `Prime Agent RPC exited (${signal ?? code ?? "unknown"}). ${this.stderr}`.trim(),
      );
      this.rejectPending(reason);
      this.process = null;
    });
    child.on("error", (error) => {
      this.rejectPending(error);
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    if (child.exitCode !== null) {
      throw new Error(
        `Prime Agent RPC exited immediately with code ${child.exitCode}. ${this.stderr}`.trim(),
      );
    }
  }

  async stop(): Promise<void> {
    if (this.daemon) {
      const daemon = this.daemon;
      this.daemon = null;
      await daemon.stop();
      return;
    }

    const child = this.process;
    if (!child) {
      return;
    }

    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 1_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.process = null;
  }

  async killResidentSession(): Promise<boolean> {
    const daemon = this.daemon;
    if (!daemon) return false;
    this.daemon = null;
    await daemon.kill();
    return true;
  }

  static async killResident(
    options: PrimeAgentRpcClientOptions,
  ): Promise<boolean> {
    const daemon = await PrimeAgentDaemonRpcClient.tryCreate(options);
    if (!daemon) return false;
    await daemon.kill();
    return true;
  }

  onEvent(listener: (event: PrimeRpcEvent) => void): () => void {
    if (this.daemon) return this.daemon.onEvent(listener);
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async request(
    command: PrimeRpcCommand,
    timeoutMs = 30_000,
  ): Promise<PrimeRpcResponse> {
    if (this.daemon) return this.daemon.request(command, timeoutMs);

    const child = this.process;
    if (!child?.stdin.writable) {
      throw new Error("Prime Agent RPC client is not running");
    }

    const id = `primecodex_${++this.requestId}`;
    const payload = { ...command, id };

    const response = await new Promise<PrimeRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(
          new Error(
            `Timed out waiting for Prime Agent response to ${command.type}. ${this.stderr}`.trim(),
          ),
        );
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });
      child.stdin.write(serializeJsonLine(payload));
    });

    if (!response.success) {
      throw new Error(response.error ?? `Prime Agent ${command.type} failed`);
    }

    return response;
  }

  private handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }

    let message: PrimeRpcResponse | PrimeRpcEvent;
    try {
      message = JSON.parse(line) as PrimeRpcResponse | PrimeRpcEvent;
    } catch {
      return;
    }

    if (message.type === "response" && "id" in message && message.id) {
      const pending = this.pendingRequests.get(String(message.id));
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(String(message.id));
        pending.resolve(message as PrimeRpcResponse);
        return;
      }
    }

    for (const listener of this.listeners) {
      try {
        listener(message as PrimeRpcEvent);
      } catch {
        // One UI subscriber must not break the RPC stream for other subscribers.
      }
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }
}
