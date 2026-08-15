import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type PrimePersistedMessage = {
  entryId: string;
  timestampMs: number;
  role: "user" | "assistant" | "goal";
  content: Array<Record<string, unknown>>;
};

export type PrimeSavedSession = {
  sessionId: string;
  filePath: string;
  cwd: string;
  createdAtMs: number;
  updatedAtMs: number;
  preview: string;
  name?: string;
  model?: string;
  provider?: string;
  thinking?: string;
  gitInfo?: {
    sha: string | null;
    branch: string | null;
    originUrl: string | null;
  };
  archived: boolean;
  messages: PrimePersistedMessage[];
};

type PrimeEntry = {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  cwd?: string;
  rlmDepth?: number;
  name?: string;
  modelId?: string;
  provider?: string;
  thinkingLevel?: string;
  git?: {
    repoUrl?: string;
    commit?: string;
    branch?: string;
  };
  customType?: string;
  content?: string | Array<Record<string, unknown>>;
  state?: { status?: string } | string;
  message?: {
    role?: string;
    content?: Array<Record<string, unknown>>;
    timestamp?: number;
  };
};

function parseTimestamp(value: string | undefined, fallback = 0): number {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function firstText(
  content: Array<Record<string, unknown>> | undefined,
): string {
  if (!content) return "";
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
  }
  return "";
}

function activeBranch(entries: PrimeEntry[]): PrimeEntry[] {
  const byId = new Map<string, PrimeEntry>();
  let leaf: PrimeEntry | undefined;

  for (const entry of entries) {
    if (entry.type === "session") continue;
    if (entry.id) {
      byId.set(entry.id, entry);
      leaf = entry;
    }
  }

  const branch: PrimeEntry[] = [];
  const visited = new Set<string>();
  let current = leaf;

  while (current?.id && !visited.has(current.id)) {
    visited.add(current.id);
    branch.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  return branch.reverse();
}

function parseSessionFile(
  filePath: string,
  source: string,
): PrimeSavedSession | null {
  const entries: PrimeEntry[] = [];
  for (const line of source.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as PrimeEntry);
    } catch {
      // Prime Agent also skips malformed JSONL records when loading sessions.
    }
  }

  const header = entries.find((entry) => entry.type === "session");
  if (!header?.id || !header.cwd || (header.rlmDepth ?? 0) !== 0) {
    return null;
  }

  const createdAtMs = parseTimestamp(header.timestamp);
  let updatedAtMs = createdAtMs;
  let name: string | undefined;
  let model: string | undefined;
  let provider: string | undefined;
  let thinking: string | undefined;
  let archived = false;

  for (const entry of entries) {
    updatedAtMs = Math.max(updatedAtMs, parseTimestamp(entry.timestamp));
    if (entry.type === "session_name" && entry.name) name = entry.name;
    if (entry.type === "model_change") {
      model = entry.modelId ?? model;
      provider = entry.provider ?? provider;
    }
    if (entry.type === "thinking_level_change" && entry.thinkingLevel) {
      thinking = entry.thinkingLevel;
    }
    if (entry.type === "session_state") {
      const status =
        typeof entry.state === "string" ? entry.state : entry.state?.status;
      if (status === "archived") archived = true;
      if (status === "active") archived = false;
    }
  }

  let gitContext = header.git;
  const branch = activeBranch(entries);
  for (const entry of branch) {
    if (entry.type === "git_state" && entry.git) gitContext = entry.git;
  }

  const messages: PrimePersistedMessage[] = [];
  for (const entry of branch) {
    if (
      entry.type === "custom_message" &&
      entry.customType === "goal_context" &&
      entry.id
    ) {
      const content =
        typeof entry.content === "string"
          ? [{ type: "text", text: entry.content }]
          : Array.isArray(entry.content)
            ? entry.content
            : [];
      messages.push({
        entryId: entry.id,
        timestampMs: parseTimestamp(entry.timestamp, updatedAtMs),
        role: "goal",
        content,
      });
      continue;
    }
    if (entry.type !== "message" || !entry.id || !entry.message) continue;
    if (entry.message.role !== "user" && entry.message.role !== "assistant") {
      continue;
    }
    messages.push({
      entryId: entry.id,
      timestampMs:
        entry.message.timestamp ?? parseTimestamp(entry.timestamp, updatedAtMs),
      role: entry.message.role,
      content: entry.message.content ?? [],
    });
  }

  const firstUser = messages.find((message) => message.role === "user");
  const preview = firstText(firstUser?.content);

  return {
    sessionId: header.id,
    filePath,
    cwd: header.cwd,
    createdAtMs,
    updatedAtMs,
    preview,
    ...(name ? { name } : {}),
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    ...(thinking ? { thinking } : {}),
    ...(gitContext
      ? {
          gitInfo: {
            sha: gitContext.commit ?? null,
            branch: gitContext.branch ?? null,
            originUrl: gitContext.repoUrl ?? null,
          },
        }
      : {}),
    archived,
    messages,
  };
}

export class PrimeSessionCatalog {
  constructor(
    private readonly sessionDir = path.join(
      os.homedir(),
      ".prime",
      "agent",
      "sessions",
    ),
  ) {}

  async list(): Promise<PrimeSavedSession[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.sessionDir);
    } catch {
      return [];
    }

    const sessions = await Promise.all(
      names
        .filter((name) => name.endsWith(".jsonl"))
        .map(async (name) => {
          const filePath = path.join(this.sessionDir, name);
          try {
            return parseSessionFile(
              filePath,
              await fs.readFile(filePath, "utf8"),
            );
          } catch {
            return null;
          }
        }),
    );

    return sessions
      .filter((session): session is PrimeSavedSession => session !== null)
      .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
  }

  async find(sessionId: string): Promise<PrimeSavedSession | undefined> {
    return (await this.list()).find(
      (session) => session.sessionId === sessionId,
    );
  }

  async setArchived(sessionId: string, archived: boolean): Promise<void> {
    const saved = await this.find(sessionId);
    if (!saved) throw new Error(`Prime Agent session not found: ${sessionId}`);

    const source = await fs.readFile(saved.filePath, "utf8");
    const ids = new Set<string>();
    let leafId: string | null = null;
    for (const line of source.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as PrimeEntry;
        if (entry.type !== "session" && entry.id) {
          ids.add(entry.id);
          leafId = entry.id;
        }
      } catch {
        // Match Prime Agent's tolerant JSONL loader.
      }
    }

    let id = randomBytes(4).toString("hex");
    while (ids.has(id)) id = randomBytes(4).toString("hex");
    const entry = {
      type: "session_state",
      id,
      parentId: leafId,
      timestamp: new Date().toISOString(),
      state: { status: archived ? "archived" : "active" },
    };
    await fs.appendFile(saved.filePath, `${JSON.stringify(entry)}\n`, "utf8");
  }

  async delete(sessionId: string): Promise<void> {
    const saved = await this.find(sessionId);
    if (!saved) return;
    await fs.rm(saved.filePath, { force: true });
    await fs.rm(
      path.resolve(this.sessionDir, "..", "session-artifacts", sessionId),
      {
        recursive: true,
        force: true,
      },
    );
  }

  async rollbackTurns(
    sessionId: string,
    numTurns: number,
  ): Promise<PrimeSavedSession> {
    if (!Number.isInteger(numTurns) || numTurns <= 0) {
      throw new Error("numTurns must be a positive integer");
    }
    const saved = await this.find(sessionId);
    if (!saved) throw new Error(`Prime Agent session not found: ${sessionId}`);

    const turnBoundaries = saved.messages.filter(
      (message) => message.role === "user" || message.role === "goal",
    );
    if (numTurns > turnBoundaries.length) {
      throw new Error(
        `Cannot rollback ${numTurns} turns from a session with ${turnBoundaries.length} turns`,
      );
    }
    const firstRolledBackTurn =
      turnBoundaries[turnBoundaries.length - numTurns];
    if (!firstRolledBackTurn) {
      throw new Error("Cannot resolve the first Prime turn to roll back");
    }
    const source = await fs.readFile(saved.filePath, "utf8");
    let targetParentId: string | null | undefined;
    const ids = new Set<string>();
    for (const line of source.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as PrimeEntry;
        if (entry.id) ids.add(entry.id);
        if (entry.id === firstRolledBackTurn.entryId) {
          targetParentId = entry.parentId ?? null;
        }
      } catch {
        // Match Prime Agent's tolerant JSONL loader.
      }
    }
    if (targetParentId === undefined) {
      throw new Error(
        `Cannot resolve Prime rollback entry ${firstRolledBackTurn.entryId}`,
      );
    }

    let id = randomBytes(8).toString("hex");
    while (ids.has(id)) id = randomBytes(8).toString("hex");
    const marker = {
      type: "custom",
      id,
      parentId: targetParentId,
      timestamp: new Date().toISOString(),
      customType: "primecodex.rollback",
      data: {
        numTurns,
        firstRolledBackEntryId: firstRolledBackTurn.entryId,
      },
    };
    await fs.appendFile(saved.filePath, `${JSON.stringify(marker)}\n`, "utf8");

    const refreshed = await parseSessionFile(
      saved.filePath,
      await fs.readFile(saved.filePath, "utf8"),
    );
    if (!refreshed) throw new Error("Prime rollback marker was not persisted");
    return refreshed;
  }

  async updateGitInfo(
    sessionId: string,
    patch: {
      sha?: string | null;
      branch?: string | null;
      originUrl?: string | null;
    } | null,
  ): Promise<PrimeSavedSession> {
    const saved = await this.find(sessionId);
    if (!saved) throw new Error(`Prime Agent session not found: ${sessionId}`);

    const current = saved.gitInfo ?? {
      sha: null,
      branch: null,
      originUrl: null,
    };
    const next =
      patch == null
        ? { sha: null, branch: null, originUrl: null }
        : {
            sha: Object.prototype.hasOwnProperty.call(patch, "sha")
              ? (patch.sha ?? null)
              : current.sha,
            branch: Object.prototype.hasOwnProperty.call(patch, "branch")
              ? (patch.branch ?? null)
              : current.branch,
            originUrl: Object.prototype.hasOwnProperty.call(patch, "originUrl")
              ? (patch.originUrl ?? null)
              : current.originUrl,
          };

    const source = await fs.readFile(saved.filePath, "utf8");
    const ids = new Set<string>();
    let leafId: string | null = null;
    for (const line of source.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as PrimeEntry;
        if (entry.type !== "session" && entry.id) {
          ids.add(entry.id);
          leafId = entry.id;
        }
      } catch {
        // Match Prime Agent's tolerant JSONL loader.
      }
    }

    let id = randomBytes(4).toString("hex");
    while (ids.has(id)) id = randomBytes(4).toString("hex");
    const entry = {
      type: "git_state",
      id,
      parentId: leafId,
      timestamp: new Date().toISOString(),
      git: {
        ...(next.originUrl ? { repoUrl: next.originUrl } : {}),
        ...(next.sha ? { commit: next.sha } : {}),
        ...(next.branch ? { branch: next.branch } : {}),
      },
    };
    await fs.appendFile(saved.filePath, `${JSON.stringify(entry)}\n`, "utf8");

    const refreshed = parseSessionFile(
      saved.filePath,
      await fs.readFile(saved.filePath, "utf8"),
    );
    if (!refreshed) throw new Error("Prime git metadata was not persisted");
    return refreshed;
  }

  async reparent(sessionId: string, parentSession: string): Promise<void> {
    const saved = await this.find(sessionId);
    if (!saved) throw new Error(`Prime Agent session not found: ${sessionId}`);

    const source = await fs.readFile(saved.filePath, "utf8");
    const lines = source.split("\n");
    let replaced = false;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line?.trim()) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry.type !== "session") continue;
        lines[index] = JSON.stringify({ ...entry, parentSession });
        replaced = true;
        break;
      } catch {
        // Keep malformed records untouched, matching Prime's tolerant loader.
      }
    }
    if (!replaced) {
      throw new Error(`Prime Agent session header not found: ${sessionId}`);
    }

    const tempPath = `${saved.filePath}.primecodex-${process.pid}.tmp`;
    await fs.writeFile(tempPath, lines.join("\n"), "utf8");
    await fs.rename(tempPath, saved.filePath);
  }

  async appendContextMessage(
    sessionId: string,
    customType: string,
    content: string,
  ): Promise<void> {
    const saved = await this.find(sessionId);
    if (!saved) throw new Error(`Prime Agent session not found: ${sessionId}`);

    const source = await fs.readFile(saved.filePath, "utf8");
    const ids = new Set<string>();
    let leafId: string | null = null;
    for (const line of source.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as PrimeEntry;
        if (entry.type !== "session" && entry.id) {
          ids.add(entry.id);
          leafId = entry.id;
        }
      } catch {
        // Match Prime Agent's tolerant JSONL loader.
      }
    }

    let id = randomBytes(4).toString("hex");
    while (ids.has(id)) id = randomBytes(4).toString("hex");
    const entry = {
      type: "custom_message",
      customType,
      content,
      display: false,
      details: { source: "primecodex" },
      id,
      parentId: leafId,
      timestamp: new Date().toISOString(),
    };
    await fs.appendFile(saved.filePath, `${JSON.stringify(entry)}\n`, "utf8");
  }
}
