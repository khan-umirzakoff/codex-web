import { executableExists } from "./executable";
import type { AgentBackend, AgentBackendInfo, AgentBackendKind } from "./types";

export class CodexBackend implements AgentBackend {
  readonly kind: AgentBackendKind = "codex";

  constructor(
    private readonly command = process.env.CODEX_CLI_PATH ?? "codex",
  ) {}

  async getInfo(): Promise<AgentBackendInfo> {
    return {
      kind: this.kind,
      label: "Codex",
      command: this.command,
      available: await executableExists(this.command),
      capabilities: ["threads", "streaming", "reasoning", "tools", "subagents"],
    };
  }

  async close(): Promise<void> {}
}
