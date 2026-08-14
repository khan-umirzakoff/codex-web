import { executableExists } from "./executable";
import type { AgentBackend, AgentBackendInfo, AgentBackendKind } from "./types";
import {
  PrimeAgentSessionManager,
  type PrimeAgentSessionCreateOptions,
} from "../prime/session-manager";
import type { PrimeRpcCommand, PrimeRpcEvent } from "../prime/rpc-client";

export class PrimeAgentBackend implements AgentBackend {
  readonly kind: AgentBackendKind = "prime";
  readonly sessions: PrimeAgentSessionManager;

  constructor(
    private readonly command = process.env.PRIME_AGENT_CLI_PATH ??
      "prime-agent",
  ) {
    this.sessions = new PrimeAgentSessionManager(command);
  }

  async getInfo(): Promise<AgentBackendInfo> {
    return {
      kind: this.kind,
      label: "Prime Agent",
      command: this.command,
      available: await executableExists(this.command),
      capabilities: [
        "threads",
        "streaming",
        "reasoning",
        "tools",
        "subagents",
        "refine",
        "heartbeats",
        "autonomous",
      ],
      activeSessions: this.sessions.size,
    };
  }

  createSession(options: PrimeAgentSessionCreateOptions) {
    return this.sessions.create(options);
  }

  request(sessionId: string, command: PrimeRpcCommand) {
    return this.sessions.request(sessionId, command);
  }

  onEvent(sessionId: string, listener: (event: PrimeRpcEvent) => void) {
    return this.sessions.onEvent(sessionId, listener);
  }

  removeSession(sessionId: string) {
    return this.sessions.remove(sessionId);
  }

  async close(): Promise<void> {
    await this.sessions.closeAll();
  }
}
