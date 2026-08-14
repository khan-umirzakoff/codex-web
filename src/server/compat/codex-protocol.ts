import { randomUUID } from "node:crypto";
import type {
  PrimePersistedMessage,
  PrimeSavedSession,
} from "../prime/catalog";

export type JsonRpcId = string | number;

export type CodexRequest = {
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
};

export type CodexThreadItem = Record<string, unknown> & {
  type: string;
  id?: string;
};

export type CodexTurn = {
  id: string;
  items: CodexThreadItem[];
  itemsView: "notLoaded" | "summary" | "full";
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error: null | Record<string, unknown>;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
};

export type CodexThread = {
  id: string;
  extra: null;
  sessionId: string;
  forkedFromId: string | null;
  parentThreadId: null;
  preview: string;
  ephemeral: boolean;
  section: null;
  sectionEnteredAt: number | null;
  historyMode: "legacy";
  modelProvider: string;
  createdAt: number;
  updatedAt: number;
  recencyAt: number | null;
  status:
    | { type: "notLoaded" | "idle" | "systemError" }
    | { type: "active"; activeFlags: unknown[] };
  path: string | null;
  cwd: string;
  cliVersion: string;
  source: "appServer";
  canAcceptDirectInput: boolean | null;
  threadSource: null;
  agentNickname: null;
  agentRole: null;
  gitInfo: null;
  name: string | null;
  turns: CodexTurn[];
};

const PRIME_SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function primeThreadId(sessionId: string): string {
  if (!PRIME_SESSION_ID_RE.test(sessionId)) {
    throw new Error(`Prime Agent session id is not a UUIDv7: ${sessionId}`);
  }
  return sessionId;
}

export function parsePrimeThreadId(threadId: string): string | undefined {
  return PRIME_SESSION_ID_RE.test(threadId) ? threadId : undefined;
}

function textFromContent(content: Array<Record<string, unknown>>): string {
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => String(block.text))
    .join("");
}

function itemsFromAssistant(message: PrimePersistedMessage): CodexThreadItem[] {
  const items: CodexThreadItem[] = [];
  message.content.forEach((block, index) => {
    const id = `prime-item:${message.entryId}:${index}`;
    if (block.type === "text" && typeof block.text === "string") {
      items.push({
        type: "agentMessage",
        id,
        text: block.text,
        phase: "final_answer",
        memoryCitation: null,
      });
    } else if (
      block.type === "thinking" &&
      typeof block.thinking === "string"
    ) {
      items.push({
        type: "reasoning",
        id,
        summary: [block.thinking],
        content: [],
      });
    }
  });
  return items;
}

export function turnsFromPrimeMessages(
  messages: PrimePersistedMessage[],
): CodexTurn[] {
  const turns: CodexTurn[] = [];
  let current: CodexTurn | undefined;

  for (const message of messages) {
    if (message.role === "user") {
      current = {
        id: `prime-turn:${message.entryId}`,
        items: [
          {
            type: "userMessage",
            id: `prime-item:${message.entryId}`,
            clientId: null,
            content: [
              {
                type: "text",
                text: textFromContent(message.content),
                text_elements: [],
              },
            ],
          },
        ],
        itemsView: "full",
        status: "completed",
        error: null,
        startedAt: Math.floor(message.timestampMs / 1_000),
        completedAt: Math.floor(message.timestampMs / 1_000),
        durationMs: 0,
      };
      turns.push(current);
      continue;
    }

    if (!current) {
      current = {
        id: `prime-turn:${randomUUID()}`,
        items: [],
        itemsView: "full",
        status: "completed",
        error: null,
        startedAt: Math.floor(message.timestampMs / 1_000),
        completedAt: Math.floor(message.timestampMs / 1_000),
        durationMs: 0,
      };
      turns.push(current);
    }

    current.items.push(...itemsFromAssistant(message));
    current.completedAt = Math.floor(message.timestampMs / 1_000);
    current.durationMs = Math.max(
      0,
      (current.completedAt - (current.startedAt ?? current.completedAt)) *
        1_000,
    );
  }

  return turns;
}

function primeThreadTitle(session: PrimeSavedSession): string {
  const explicit = session.name?.trim();
  if (explicit) return explicit;

  const preview = session.preview
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\/resume\b/i, "Prime Agent session");
  if (!preview) return "Prime Agent session";
  return preview.length > 72 ? `${preview.slice(0, 69).trimEnd()}…` : preview;
}

export function threadFromPrimeSession(
  session: PrimeSavedSession,
  options: { loaded?: boolean; includeTurns?: boolean } = {},
): CodexThread {
  return {
    id: primeThreadId(session.sessionId),
    extra: null,
    sessionId: session.sessionId,
    forkedFromId: null,
    parentThreadId: null,
    preview: session.preview,
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    historyMode: "legacy",
    modelProvider: "openai",
    createdAt: Math.floor(session.createdAtMs / 1_000),
    updatedAt: Math.floor(session.updatedAtMs / 1_000),
    recencyAt: Math.floor(session.updatedAtMs / 1_000),
    status: options.loaded ? { type: "idle" } : { type: "notLoaded" },
    path: session.filePath,
    cwd: session.cwd,
    cliVersion: "prime-agent/0.7.2",
    source: "appServer",
    canAcceptDirectInput: options.loaded ? true : null,
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: primeThreadTitle(session),
    turns: options.includeTurns ? turnsFromPrimeMessages(session.messages) : [],
  };
}

export function writeJsonLine(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function rpcResult(id: JsonRpcId, result: unknown): void {
  writeJsonLine({ id, result });
}

export function rpcError(id: JsonRpcId, message: string, code = -32603): void {
  writeJsonLine({ id, error: { code, message } });
}

export function notify(method: string, params: unknown): void {
  writeJsonLine({ method, params, emittedAtMs: Date.now() });
}
