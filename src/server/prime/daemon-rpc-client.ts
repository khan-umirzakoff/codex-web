import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  PrimeAgentRpcClientOptions,
  PrimeRpcCommand,
  PrimeRpcEvent,
  PrimeRpcResponse,
} from "./rpc-client";

type DaemonResponse = {
  success: boolean;
  data?: unknown;
  error?: string;
};

type DaemonClientLike = {
  connect(timeoutMs?: number): Promise<void>;
  request(
    command: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<DaemonResponse>;
  onMessage(listener: (message: Record<string, unknown>) => void): () => void;
  close(): void;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function moduleRoot(): string {
  return (
    process.env.PRIME_AGENT_MODULE_ROOT?.trim() ||
    join(
      homedir(),
      ".prime-agent-app",
      "node_modules",
      "prime-agent",
      "dist",
      "modes",
    )
  );
}

/**
 * Non-owning RPC facade for a Prime Agent session that is already resident in
 * Prime's daemon. Prime's normal `--mode rpc --resume` path intentionally owns
 * the session lease, so it cannot reopen a transcript that the daemon already
 * owns. This adapter uses Prime's public daemon wire protocol instead and
 * exposes the subset of RPC commands PrimeCodex consumes.
 */
export class PrimeAgentDaemonRpcClient {
  private readonly listeners = new Set<(event: PrimeRpcEvent) => void>();
  private state: Record<string, unknown>;
  private stopped = false;

  private constructor(
    private readonly client: DaemonClientLike,
    private readonly activeSessionId: string,
    state: Record<string, unknown>,
    private readonly unsubscribeDaemon: () => void,
  ) {
    this.state = state;
  }

  static async tryCreate(
    options: PrimeAgentRpcClientOptions,
  ): Promise<PrimeAgentDaemonRpcClient | undefined> {
    // Forking must create an independent runtime. Attaching to a resident
    // daemon session and then invoking Prime's in-session fork would replace
    // the source runtime, which breaks Codex side-task/fork semantics.
    if (!options.resume || options.fork) return undefined;

    let client: DaemonClientLike | undefined;
    try {
      const root = moduleRoot();
      const daemonClientModule = (await import(
        pathToFileURL(join(root, "daemon", "daemon-client.js")).href
      )) as {
        DaemonClient: new (socketPath: string) => DaemonClientLike;
      };
      const daemonSocketModule = (await import(
        pathToFileURL(join(root, "daemon", "daemon-socket.js")).href
      )) as {
        defaultDaemonSocketPath: () => string;
      };

      client = new daemonClientModule.DaemonClient(
        daemonSocketModule.defaultDaemonSocketPath(),
      );
      await client.connect(1_500);

      const listed = await client.request(
        { type: "list", all: true, includeClientOwned: true },
        3_000,
      );
      if (!listed.success) {
        client.close();
        return undefined;
      }

      const sessions = asRecord(listed.data).sessions;
      const resident = Array.isArray(sessions)
        ? sessions
            .map(asRecord)
            .find(
              (session) =>
                session.sessionId === options.resume &&
                typeof session.activeSessionId === "string",
            )
        : undefined;
      const activeSessionId = resident?.activeSessionId;
      if (typeof activeSessionId !== "string") {
        client.close();
        return undefined;
      }

      let instance: PrimeAgentDaemonRpcClient | undefined;
      const unsubscribe = client.onMessage((message) => {
        instance?.handleDaemonMessage(message);
      });
      const attached = await client.request(
        {
          type: "attach",
          activeSessionId,
          supportsExtensionUi: false,
          clientId: `primecodex:${process.pid}:${Date.now()}`,
          capabilities: ["attach_snapshot", "event_sequence", "slim_attach"],
        },
        10_000,
      );
      if (!attached.success) {
        unsubscribe();
        client.close();
        throw new Error(attached.error ?? "Prime Agent daemon attach failed");
      }

      const snapshot = asRecord(asRecord(attached.data).snapshot);
      instance = new PrimeAgentDaemonRpcClient(
        client,
        activeSessionId,
        asRecord(snapshot.state),
        unsubscribe,
      );
      return instance;
    } catch (error) {
      client?.close();
      // The daemon is optional. Missing socket/modules mean this is simply an
      // inactive session and the caller should fall back to normal RPC resume.
      if (
        error instanceof Error &&
        /attach failed|session.*not found|unknown session/i.test(error.message)
      ) {
        throw error;
      }
      return undefined;
    }
  }

  onEvent(listener: (event: PrimeRpcEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribeDaemon();
    try {
      await this.client.request(
        { type: "detach", activeSessionId: this.activeSessionId },
        2_000,
      );
    } catch {
      // Closing the socket also releases this non-owning attachment.
    }
    this.client.close();
  }

  async kill(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribeDaemon();
    try {
      const response = await this.client.request(
        { type: "kill", activeSessionId: this.activeSessionId },
        10_000,
      );
      if (!response.success) {
        throw new Error(response.error ?? "Prime Agent daemon kill failed");
      }
    } finally {
      this.client.close();
    }
  }

  async request(
    command: PrimeRpcCommand,
    timeoutMs = 30_000,
  ): Promise<PrimeRpcResponse> {
    if (this.stopped) {
      throw new Error("Prime Agent daemon attachment is not running");
    }

    let data: unknown;
    switch (command.type) {
      case "get_state": {
        this.state = asRecord(
          await this.requestData(
            {
              type: "get_connection_state",
              activeSessionId: this.activeSessionId,
            },
            timeoutMs,
          ),
        );
        data = this.rpcState();
        break;
      }
      case "prompt":
        await this.requestData(
          {
            type: "prompt",
            activeSessionId: this.activeSessionId,
            message: command.message,
            images: command.images,
            streamingBehavior: command.streamingBehavior,
            source: "rpc",
          },
          Math.max(timeoutMs, 60_000),
        );
        break;
      case "abort":
      case "compact":
      case "set_thinking_level":
      case "set_session_name":
      case "append_custom_message":
      case "steer":
      case "follow_up":
        await this.requestData(
          { ...command, activeSessionId: this.activeSessionId },
          timeoutMs,
        );
        break;
      case "set_model":
      case "get_session_stats":
      case "get_messages":
      case "get_available_models":
        data = await this.requestData(
          { ...command, activeSessionId: this.activeSessionId },
          timeoutMs,
        );
        break;
      default:
        throw new Error(
          `PrimeCodex daemon attachment does not yet support ${command.type}`,
        );
    }

    return {
      type: "response",
      command: command.type,
      success: true,
      ...(data === undefined ? {} : { data }),
    };
  }

  private rpcState(): Record<string, unknown> {
    const state = this.state;
    return {
      model: state.model,
      thinkingLevel: state.thinkingLevel,
      isStreaming: state.isStreaming,
      isCompacting: state.isCompacting,
      steeringMode: state.steeringMode,
      followUpMode: state.followUpMode,
      sessionFile: state.sessionFile,
      sessionId: state.sessionId,
      sessionName: state.sessionName,
      autoCompactionEnabled: state.autoCompactionEnabled,
      messageCount: state.messageCount,
      sessionActions: state.sessionActions,
      goal: state.goal,
    };
  }

  private async requestData(
    command: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    const response = await this.client.request(command, timeoutMs);
    if (!response.success) {
      throw new Error(response.error ?? `Prime Agent ${command.type} failed`);
    }
    return response.data;
  }

  private handleDaemonMessage(message: Record<string, unknown>): void {
    if (
      typeof message.activeSessionId === "string" &&
      message.activeSessionId !== this.activeSessionId
    ) {
      return;
    }

    if (message.type === "session_event") {
      const event = asRecord(message.event) as PrimeRpcEvent;
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch {
          // One UI subscriber must not break the daemon stream.
        }
      }
      return;
    }

    if (message.type === "session_resynced") {
      this.state = asRecord(asRecord(message.snapshot).state);
    }
  }
}
