export type AgentBackendKind = "codex" | "prime";

export type AgentBackendCapability =
  | "threads"
  | "streaming"
  | "reasoning"
  | "tools"
  | "subagents"
  | "refine"
  | "heartbeats"
  | "autonomous";

export type AgentBackendInfo = {
  kind: AgentBackendKind;
  label: string;
  command: string;
  available: boolean;
  capabilities: AgentBackendCapability[];
  activeSessions?: number;
};

export interface AgentBackend {
  readonly kind: AgentBackendKind;

  getInfo(): Promise<AgentBackendInfo>;

  close(): Promise<void>;
}
