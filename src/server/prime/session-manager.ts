import { randomUUID } from "node:crypto";
import {
  PrimeAgentRpcClient,
  type PrimeAgentRpcClientOptions,
  type PrimeRpcCommand,
  type PrimeRpcEvent,
  type PrimeRpcResponse,
  type PrimeThinkingLevel,
} from "./rpc-client";

export type PrimeAgentSessionCreateOptions = {
  cwd: string;
  provider?: string;
  model?: string;
  thinking?: PrimeThinkingLevel;
  resume?: string;
};

export type PrimeAgentSessionSummary = {
  id: string;
  cwd: string;
  createdAt: string;
  resume?: string;
};

type ManagedPrimeAgentSession = {
  summary: PrimeAgentSessionSummary;
  client: PrimeAgentRpcClient;
};

export class PrimeAgentSessionManager {
  private readonly sessions = new Map<string, ManagedPrimeAgentSession>();

  constructor(private readonly command: string) {}

  get size(): number {
    return this.sessions.size;
  }

  list(): PrimeAgentSessionSummary[] {
    return Array.from(this.sessions.values(), ({ summary }) => summary);
  }

  async create(
    options: PrimeAgentSessionCreateOptions,
  ): Promise<{ summary: PrimeAgentSessionSummary; state: unknown }> {
    const clientOptions: PrimeAgentRpcClientOptions = {
      command: this.command,
      ...options,
    };
    const client = new PrimeAgentRpcClient(clientOptions);
    await client.start();

    try {
      const state = (await client.request({ type: "get_state" })).data;
      const summary: PrimeAgentSessionSummary = {
        id: randomUUID(),
        cwd: options.cwd,
        createdAt: new Date().toISOString(),
        ...(options.resume ? { resume: options.resume } : {}),
      };
      this.sessions.set(summary.id, { summary, client });
      return { summary, state };
    } catch (error) {
      await client.stop();
      throw error;
    }
  }

  async request(
    id: string,
    command: PrimeRpcCommand,
  ): Promise<PrimeRpcResponse> {
    return this.get(id).client.request(command);
  }

  onEvent(id: string, listener: (event: PrimeRpcEvent) => void): () => void {
    return this.get(id).client.onEvent(listener);
  }

  async remove(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) {
      return false;
    }

    this.sessions.delete(id);
    await session.client.stop();
    return true;
  }

  async closeAll(): Promise<void> {
    const sessions = Array.from(this.sessions.values());
    this.sessions.clear();
    await Promise.allSettled(sessions.map(({ client }) => client.stop()));
  }

  private get(id: string): ManagedPrimeAgentSession {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Unknown Prime Agent session: ${id}`);
    }
    return session;
  }
}
