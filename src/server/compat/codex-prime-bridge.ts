import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { extname } from "node:path";
import {
  type CodexRequest,
  type CodexThread,
  type CodexThreadItem,
  type CodexTurn,
  type JsonRpcId,
  notify,
  parsePrimeThreadId,
  primeThreadId,
  rpcError,
  rpcResult,
  threadFromPrimeSession,
  turnsFromPrimeMessages,
  writeJsonLine,
} from "./codex-protocol";
import { PrimeSessionCatalog, type PrimeSavedSession } from "../prime/catalog";
import { StrictJsonlDecoder, serializeJsonLine } from "../prime/jsonl";
import {
  PrimeAgentRpcClient,
  type PrimeRpcEvent,
  type PrimeThinkingLevel,
} from "../prime/rpc-client";
import {
  readPrimeCodexControlState,
  writePrimeCodexControlState,
} from "../primecodex-control";

export type PrimeCodexMode = "prime" | "hybrid";

const PRIME_MODEL_PREFIX = "prime/";

type PrimeState = {
  model?: {
    id?: string;
    provider?: string;
    contextWindow?: number;
  };
  thinkingLevel?: string;
  isStreaming?: boolean;
  isCompacting?: boolean;
  sessionFile?: string;
  sessionId?: string;
  goal?: {
    active?: boolean;
    status?: string;
    goalId?: string;
    objective?: string;
    tokenBudget?: number;
    tokensUsed?: number;
    timeUsedSeconds?: number;
    continuationsUsed?: number;
    createdAt?: number;
    updatedAt?: number;
    lastReason?: string;
    lastError?: string;
  };
  sessionActions?: {
    queuedCount?: number;
    steering?: string[];
    followUps?: string[];
    active?: {
      kind?: string;
      phase?: string;
      label?: string;
    };
  };
};

type PrimeCompatSession = {
  threadId: string;
  sessionId: string;
  cwd: string;
  client: PrimeAgentRpcClient;
  state: PrimeState;
  currentTurn?: PrimeTurnContext;
};

type PrimeToolRuntime = {
  item: CodexThreadItem;
  output: string;
  startedAtMs: number;
};

type PrimeDiff = {
  path: string;
  oldStr: string;
  newStr: string;
  startLine?: number;
};

type PrimeImageContent = {
  type: "image";
  data: string;
  mimeType: string;
};

type PrimeTurnContext = {
  id: string;
  userItem: CodexThreadItem;
  items: CodexThreadItem[];
  startedAtMs: number;
  ready: boolean;
  bufferedEvents: PrimeRpcEvent[];
  agentItem?: CodexThreadItem;
  reasoningItem?: CodexThreadItem;
  tools: Map<string, PrimeToolRuntime>;
  bashRun?: PrimeToolRuntime & { runId?: string };
  subagentIds: Set<string>;
  compactionItem?: CodexThreadItem;
  lastRecap?: string;
  interrupted: boolean;
  failed: boolean;
  pendingAgentEnd?: boolean;
  latestUsage?: Record<string, unknown>;
};

type ResponseHandler = (message: Record<string, unknown>) => void;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function codexGoalFromPrime(
  threadId: string,
  value: unknown,
): Record<string, unknown> | null {
  const goal = asRecord(value);
  const objective = optionalString(goal.objective);
  const primeStatus = optionalString(goal.status);
  if (!objective || !primeStatus || primeStatus === "idle") return null;

  const status =
    primeStatus === "active"
      ? "active"
      : primeStatus === "paused"
        ? "paused"
        : primeStatus === "budget_limited"
          ? "budgetLimited"
          : primeStatus === "complete"
            ? "complete"
            : "blocked";
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const createdAt = numberOrNull(goal.createdAt);
  const updatedAt = numberOrNull(goal.updatedAt);
  return {
    threadId,
    objective,
    status,
    tokenBudget: numberOrNull(goal.tokenBudget),
    tokensUsed: numberOrNull(goal.tokensUsed) ?? 0,
    timeUsedSeconds: numberOrNull(goal.timeUsedSeconds) ?? 0,
    createdAt:
      createdAt == null
        ? nowSeconds
        : Math.floor(createdAt > 1e11 ? createdAt / 1_000 : createdAt),
    updatedAt:
      updatedAt == null
        ? nowSeconds
        : Math.floor(updatedAt > 1e11 ? updatedAt / 1_000 : updatedAt),
  };
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((entry) => {
      const block = asRecord(entry);
      return block.type === "text" && typeof block.text === "string";
    })
    .map((entry) => String(asRecord(entry).text))
    .join("");
}

function injectedUserItemText(value: unknown): string | undefined {
  const item = asRecord(value);
  if (item.type !== "message" || item.role !== "user") return undefined;
  if (!Array.isArray(item.content)) return undefined;
  const parts = item.content
    .map((raw) => asRecord(raw))
    .filter(
      (block) =>
        (block.type === "input_text" || block.type === "text") &&
        typeof block.text === "string",
    )
    .map((block) => String(block.text));
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function imageMimeType(filePath: string): string | undefined {
  switch (extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return undefined;
  }
}

async function primeInput(
  input: unknown[],
): Promise<{ message: string; images: PrimeImageContent[] }> {
  const text: string[] = [];
  const images: PrimeImageContent[] = [];

  for (const raw of input) {
    const entry = asRecord(raw);
    switch (entry.type) {
      case "text":
        if (typeof entry.text === "string" && entry.text) text.push(entry.text);
        break;
      case "mention": {
        const filePath = optionalString(entry.path);
        if (filePath) {
          const name = optionalString(entry.name);
          text.push(`Attached file${name ? ` ${name}` : ""}: ${filePath}`);
        }
        break;
      }
      case "skill": {
        const skillPath = optionalString(entry.path);
        const name = optionalString(entry.name);
        if (skillPath) {
          text.push(`Attached skill${name ? ` ${name}` : ""}: ${skillPath}`);
        }
        break;
      }
      case "localImage": {
        const imagePath = optionalString(entry.path);
        const mimeType = imagePath ? imageMimeType(imagePath) : undefined;
        if (imagePath && mimeType) {
          const data = await fs
            .readFile(imagePath)
            .then((value) => value.toString("base64"));
          images.push({ type: "image", data, mimeType });
        } else if (imagePath) {
          text.push(`Attached image file: ${imagePath}`);
        }
        break;
      }
      case "image": {
        const url = optionalString(entry.url);
        const match = url?.match(/^data:(image\/[^;]+);base64,(.+)$/s);
        if (match?.[1] && match[2]) {
          images.push({ type: "image", mimeType: match[1], data: match[2] });
        } else if (url) {
          text.push(`Attached image URL: ${url}`);
        }
        break;
      }
      case "localAudio": {
        const audioPath = optionalString(entry.path);
        if (audioPath) text.push(`Attached audio file: ${audioPath}`);
        break;
      }
      case "audio": {
        const url = optionalString(entry.url);
        if (url) text.push(`Attached audio URL: ${url}`);
        break;
      }
    }
  }

  return {
    message:
      text.join("\n").trim() ||
      (images.length > 0 ? "Please review the attached image." : ""),
    images,
  };
}

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  if (typeof record.output === "string") return record.output;
  const content = contentText(record.content);
  if (content) return content;
  const details = asRecord(record.details);
  return [details.stdout, details.stderr, details.result]
    .filter(
      (part): part is string => typeof part === "string" && part.length > 0,
    )
    .join("\n");
}

function primeDiffs(value: unknown): PrimeDiff[] {
  const details = asRecord(asRecord(value).details);
  if (!Array.isArray(details.diffs)) return [];
  return details.diffs.flatMap((entry) => {
    const diff = asRecord(entry);
    if (
      typeof diff.path !== "string" ||
      typeof diff.oldStr !== "string" ||
      typeof diff.newStr !== "string"
    ) {
      return [];
    }
    return [
      {
        path: diff.path,
        oldStr: diff.oldStr,
        newStr: diff.newStr,
        ...(typeof diff.startLine === "number"
          ? { startLine: diff.startLine }
          : {}),
      },
    ];
  });
}

function diffLines(text: string): string[] {
  if (text.length === 0) return [];
  const normalized = text.replace(/\r\n/g, "\n");
  const withoutFinalNewline = normalized.endsWith("\n")
    ? normalized.slice(0, -1)
    : normalized;
  return withoutFinalNewline.split("\n");
}

function unifiedDiff(diff: PrimeDiff): string {
  const startLine = Math.max(1, Math.floor(diff.startLine ?? 1));
  const oldLines = diffLines(diff.oldStr);
  const newLines = diffLines(diff.newStr);
  const body = [
    ...(diff.oldStr.length === 0 ? [] : oldLines.map((line) => `-${line}`)),
    ...(diff.newStr.length === 0 ? [] : newLines.map((line) => `+${line}`)),
  ];
  return [
    `@@ -${startLine},${oldLines.length} +${startLine},${newLines.length} @@`,
    ...body,
  ].join("\n");
}

function primeFileChangeItem(
  callId: string,
  result: unknown,
  failed: boolean,
): CodexThreadItem | undefined {
  const diffs = primeDiffs(result);
  if (diffs.length === 0) return undefined;
  return {
    type: "fileChange",
    id: `prime-file:${callId}`,
    status: failed ? "failed" : "completed",
    changes: diffs.map((diff) => ({
      path: diff.path,
      kind: { type: "update", move_path: null },
      diff: unifiedDiff(diff),
    })),
  };
}

function toolCommand(toolName: string, args: unknown): string {
  const record = asRecord(args);
  const preferred = [record.code, record.command, record.cmd].find(
    (value) => typeof value === "string" && value.length > 0,
  );
  if (typeof preferred === "string") return preferred;
  if (Object.keys(record).length === 0) return toolName;
  return `${toolName} ${JSON.stringify(record)}`;
}

function toPrimeThinking(value: unknown): PrimeThinkingLevel | undefined {
  if (value === "ultra") return "xhigh";
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
  return undefined;
}

function modelFromState(state: PrimeState): string {
  return state.model?.id ?? "gpt-5.6-sol";
}

function reasoningFromState(state: PrimeState): string {
  return state.thinkingLevel ?? "xhigh";
}

function primeHasPendingContinuation(state: PrimeState): boolean {
  const actions = state.sessionActions;
  return Boolean((actions?.queuedCount ?? 0) > 0 || actions?.active);
}

function primeProvider(value: unknown): string {
  const provider = optionalString(value);
  if (!provider || provider === "openai") return "openai-codex";
  return provider;
}

function primeModelId(value: unknown): string | undefined {
  const model = optionalString(value);
  if (!model) return undefined;
  return model.startsWith(PRIME_MODEL_PREFIX)
    ? model.slice(PRIME_MODEL_PREFIX.length)
    : model;
}

function sessionFromState(
  state: PrimeState,
  cwd: string,
  now = Date.now(),
): PrimeSavedSession {
  if (!state.sessionId || !state.sessionFile) {
    throw new Error("Prime Agent did not return a persistent session id/file");
  }
  return {
    sessionId: state.sessionId,
    filePath: state.sessionFile,
    cwd,
    createdAtMs: now,
    updatedAtMs: now,
    preview: "",
    model: state.model?.id,
    provider: state.model?.provider,
    thinking: state.thinkingLevel,
    archived: false,
    messages: [],
  };
}

function sessionStartResult(
  thread: CodexThread,
  state: PrimeState,
  uiModel = modelFromState(state),
): Record<string, unknown> {
  return {
    thread,
    model: uiModel,
    modelProvider: "openai",
    serviceTier: "default",
    cwd: thread.cwd,
    runtimeWorkspaceRoots: [thread.cwd],
    instructionSources: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    activePermissionProfile: null,
    reasoningEffort: reasoningFromState(state),
    multiAgentMode: "explicitRequestOnly",
  };
}

class RealCodexProxy {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly responseHandlers = new Map<string, ResponseHandler>();
  private stopping = false;

  constructor(command: string, args: string[]) {
    this.child = spawn(command, args, {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.pipe(process.stderr);

    const decoder = new StrictJsonlDecoder();
    this.child.stdout.on("data", (chunk: Buffer) => {
      for (const line of decoder.push(chunk)) this.handleLine(line);
    });
    this.child.stdout.on("end", () => {
      for (const line of decoder.end()) this.handleLine(line);
    });
    this.child.on("exit", (code, signal) => {
      if (this.stopping) return;
      if (signal) process.kill(process.pid, signal);
      else process.exitCode = code ?? 1;
    });
  }

  send(value: unknown, responseHandler?: ResponseHandler): void {
    const record = asRecord(value);
    if (responseHandler && record.id !== undefined) {
      this.responseHandlers.set(String(record.id), responseHandler);
    }
    this.child.stdin.write(serializeJsonLine(value));
  }

  stop(): void {
    this.stopping = true;
    this.child.kill("SIGTERM");
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      process.stdout.write(`${line}\n`);
      return;
    }

    if (message.id !== undefined) {
      const key = String(message.id);
      const handler = this.responseHandlers.get(key);
      if (handler) {
        this.responseHandlers.delete(key);
        handler(message);
        return;
      }
    }
    writeJsonLine(message);
  }
}

export type CodexPrimeBridgeOptions = {
  realCodexCommand: string;
  realCodexArgs: string[];
  primeCommand: string;
  mode: PrimeCodexMode;
  newThreadBackend: "codex" | "prime";
  controlFile?: string;
  defaultPrimeThinking: PrimeThinkingLevel;
};

export class CodexPrimeBridge {
  private readonly codex: RealCodexProxy;
  private readonly catalog = new PrimeSessionCatalog();
  private readonly livePrimeThreads = new Map<string, PrimeCompatSession>();
  private readonly ephemeralPrimeThreads = new Set<string>();
  private pendingPrimeCwd: string | undefined;

  constructor(private readonly options: CodexPrimeBridgeOptions) {
    this.codex = new RealCodexProxy(
      options.realCodexCommand,
      options.realCodexArgs,
    );
  }

  async handle(value: unknown): Promise<void> {
    const request = asRecord(value) as CodexRequest;
    if (!request.method) {
      this.codex.send(value);
      return;
    }

    try {
      if (request.method === "thread/list" && request.id !== undefined) {
        await this.handleThreadList(request);
        return;
      }

      if (
        request.method === "model/list" &&
        request.id !== undefined &&
        this.options.mode === "hybrid"
      ) {
        this.handleHybridModelList(request);
        return;
      }

      if (
        request.method === "thread/start" &&
        request.id !== undefined &&
        (await this.shouldCreatePrimeThread(request.params ?? {}))
      ) {
        await this.handlePrimeThreadStart(request.id, request.params ?? {});
        return;
      }

      const threadId = optionalString(request.params?.threadId);
      if (threadId && (await this.isPrimeThread(threadId))) {
        if (request.id === undefined) {
          return;
        }
        await this.handlePrimeRequest(
          request.id,
          request.method,
          threadId,
          request.params ?? {},
        );
        return;
      }

      // The renderer intentionally keeps native and Prime-prefixed model rows in
      // one cache so switching workspace mode is instant. If a Prime-prefixed
      // model happens to still be selected while Codex mode is active, normalize
      // it before forwarding the new thread to native Codex.
      if (request.method === "thread/start") {
        const model = optionalString(request.params?.model);
        if (model?.startsWith(PRIME_MODEL_PREFIX)) {
          this.codex.send({
            ...request,
            params: {
              ...(request.params ?? {}),
              model: model.slice(PRIME_MODEL_PREFIX.length),
            },
          });
          return;
        }
      }

      this.codex.send(value);
    } catch (error) {
      if (request.id !== undefined) {
        rpcError(
          request.id,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  async close(): Promise<void> {
    this.codex.stop();
    await Promise.allSettled(
      Array.from(this.livePrimeThreads.values(), ({ client }) => client.stop()),
    );
    this.livePrimeThreads.clear();
  }

  private async shouldCreatePrimeThread(
    params: Record<string, unknown>,
  ): Promise<boolean> {
    if (this.options.mode === "prime") return true;
    if (this.options.mode !== "hybrid") return false;

    const controlFile = this.options.controlFile;
    if (!controlFile) {
      return this.options.newThreadBackend === "prime";
    }
    const control = await readPrimeCodexControlState(controlFile, {
      activeBackend: this.options.newThreadBackend,
      newThreadBackend: this.options.newThreadBackend,
    });
    if (control.newThreadBackend !== "prime") return false;

    this.pendingPrimeCwd = control.projectCwd;

    // The Codex renderer can create invisible helper threads (for example for
    // title generation) immediately after the user-visible thread. Treat the
    // Prime selection as "the next task" so those helpers stay on native Codex
    // instead of leaking into Prime's saved-session list.
    await writePrimeCodexControlState(controlFile, {
      ...control,
      newThreadBackend: "codex",
    });
    return true;
  }

  private async isPrimeThread(threadId: string): Promise<boolean> {
    if (this.livePrimeThreads.has(threadId)) return true;
    const sessionId = parsePrimeThreadId(threadId);
    if (!sessionId) return false;
    return (await this.catalog.find(sessionId)) !== undefined;
  }

  private handleHybridModelList(request: CodexRequest): void {
    this.codex.send(request, (message) => {
      if (message.error) {
        writeJsonLine(message);
        return;
      }
      const result = asRecord(message.result);
      const nativeModels = Array.isArray(result.data) ? result.data : [];
      const primeModels = nativeModels.map((value) => {
        const model = asRecord(value);
        const id = optionalString(model.id);
        if (!id) return model;
        const efforts = Array.isArray(model.supportedReasoningEfforts)
          ? model.supportedReasoningEfforts.filter(
              (entry) => asRecord(entry).reasoningEffort !== "ultra",
            )
          : [];
        return {
          ...model,
          id: `${PRIME_MODEL_PREFIX}${id}`,
          model: `${PRIME_MODEL_PREFIX}${id}`,
          displayName: `Prime · ${optionalString(model.displayName) ?? id}`,
          description:
            `Prime Agent RLM harness · ${optionalString(model.description) ?? ""}`.trim(),
          supportedReasoningEfforts: efforts,
          additionalSpeedTiers: [],
          serviceTiers: [],
          defaultServiceTier: null,
          isDefault: false,
        };
      });
      writeJsonLine({
        ...message,
        result: {
          ...result,
          // Keep both model families in the renderer cache. The injected UI
          // filters the visible picker by workspace mode, so Codex ↔ Prime does
          // not require a page reload or query-cache reset.
          data: [...nativeModels, ...primeModels],
        },
      });
    });
  }

  private async handleThreadList(request: CodexRequest): Promise<void> {
    const id = request.id as JsonRpcId;
    const params = request.params ?? {};
    const primeThreads = await this.listPrimeThreads(params);

    if (this.options.mode === "prime") {
      rpcResult(id, {
        data: primeThreads,
        nextCursor: null,
        backwardsCursor: null,
      });
      return;
    }

    this.codex.send(request, (message) => {
      if (message.error) {
        writeJsonLine(message);
        return;
      }
      const result = asRecord(message.result);
      const data = Array.isArray(result.data) ? result.data : [];
      const merged = [...data, ...primeThreads].sort((left, right) => {
        const l = numberOrNull(asRecord(left).updatedAt) ?? 0;
        const r = numberOrNull(asRecord(right).updatedAt) ?? 0;
        return r - l;
      });
      writeJsonLine({
        ...message,
        result: { ...result, data: merged },
      });
    });
  }

  private async listPrimeThreads(
    params: Record<string, unknown>,
  ): Promise<CodexThread[]> {
    if (params.cursor) return [];
    const archived = params.archived === true;
    const cwdFilter = Array.isArray(params.cwd)
      ? params.cwd.filter((value): value is string => typeof value === "string")
      : typeof params.cwd === "string"
        ? [params.cwd]
        : [];
    const searchTerm = optionalString(params.searchTerm)?.toLowerCase();
    let sessions = (await this.catalog.list()).filter(
      (session) => session.archived === archived,
    );
    if (cwdFilter.length > 0) {
      sessions = sessions.filter((session) => cwdFilter.includes(session.cwd));
    }
    if (searchTerm) {
      sessions = sessions.filter((session) =>
        `${session.name ?? ""}\n${session.preview}`
          .toLowerCase()
          .includes(searchTerm),
      );
    }

    const direction = params.sortDirection === "asc" ? 1 : -1;
    sessions.sort(
      (left, right) => direction * (right.updatedAtMs - left.updatedAtMs),
    );
    const limit =
      typeof params.limit === "number" && params.limit > 0
        ? Math.floor(params.limit)
        : sessions.length;
    return sessions.slice(0, limit).map((session) =>
      threadFromPrimeSession(session, {
        loaded: this.livePrimeThreads.has(primeThreadId(session.sessionId)),
      }),
    );
  }

  private async handlePrimeThreadStart(
    id: JsonRpcId,
    params: Record<string, unknown>,
  ): Promise<void> {
    const cwd =
      this.pendingPrimeCwd ?? optionalString(params.cwd) ?? process.cwd();
    this.pendingPrimeCwd = undefined;
    const client = new PrimeAgentRpcClient({
      command: this.options.primeCommand,
      cwd,
      ...(primeModelId(params.model)
        ? {
            model: primeModelId(params.model),
            provider: primeProvider(params.modelProvider),
          }
        : {}),
      thinking: this.options.defaultPrimeThinking,
    });
    await client.start();
    try {
      const state = asRecord(
        (await client.request({ type: "get_state" })).data,
      ) as PrimeState;
      const stateSession = sessionFromState(state, cwd);
      const saved =
        (await this.catalog.find(stateSession.sessionId)) ?? stateSession;
      const thread = threadFromPrimeSession(saved, { loaded: true });
      const session: PrimeCompatSession = {
        threadId: thread.id,
        sessionId: saved.sessionId,
        cwd,
        client,
        state,
      };
      this.bindPrimeSession(session);
      this.livePrimeThreads.set(thread.id, session);
      rpcResult(id, sessionStartResult(thread, state, this.uiModel(state)));
      notify("thread/started", { thread });
    } catch (error) {
      await client.stop();
      throw error;
    }
  }

  private async handlePrimeRequest(
    id: JsonRpcId,
    method: string,
    threadId: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    switch (method) {
      case "thread/read":
        await this.handlePrimeThreadRead(id, threadId, params);
        return;
      case "thread/resume":
        await this.handlePrimeThreadResume(id, threadId, params);
        return;
      case "thread/turns/list":
        await this.handlePrimeTurnsList(id, threadId, params);
        return;
      case "thread/items/list":
        await this.handlePrimeItemsList(id, threadId, params);
        return;
      case "thread/name/set":
        await this.handlePrimeThreadName(id, threadId, params);
        return;
      case "thread/archive":
        await this.handlePrimeThreadArchive(id, threadId);
        return;
      case "thread/unarchive":
        await this.handlePrimeThreadUnarchive(id, threadId);
        return;
      case "thread/fork":
        await this.handlePrimeThreadFork(id, threadId, params);
        return;
      case "thread/unsubscribe":
        await this.handlePrimeThreadUnsubscribe(id, threadId);
        return;
      case "thread/delete":
        await this.handlePrimeThreadDelete(id, threadId);
        return;
      case "thread/compact/start":
        await this.handlePrimeThreadCompact(id, threadId);
        return;
      case "thread/rollback":
        await this.handlePrimeThreadRollback(id, threadId, params);
        return;
      case "thread/settings/update":
        await this.handlePrimeThreadSettingsUpdate(id, threadId, params);
        return;
      case "thread/metadata/update":
        await this.handlePrimeThreadMetadataUpdate(id, threadId, params);
        return;
      case "thread/inject_items":
        await this.handlePrimeThreadInjectItems(id, threadId, params);
        return;
      case "thread/backgroundTerminals/clean":
        // Prime command/tool processes are owned by Prime itself and are
        // interrupted via turn/interrupt. There is no separate Codex terminal
        // registry to clean for a Prime-backed thread.
        rpcResult(id, {});
        return;
      case "thread/goal/get":
        await this.handlePrimeThreadGoalGet(id, threadId);
        return;
      case "thread/goal/set":
        await this.handlePrimeThreadGoalSet(id, threadId, params);
        return;
      case "thread/goal/clear":
        await this.handlePrimeThreadGoalClear(id, threadId);
        return;
      case "turn/start":
        await this.handlePrimeTurnStart(id, threadId, params);
        return;
      case "turn/steer":
        await this.handlePrimeTurnSteer(id, threadId, params);
        return;
      case "turn/interrupt":
        await this.handlePrimeTurnInterrupt(id, threadId);
        return;
      default:
        rpcError(
          id,
          `PrimeCodex does not yet support ${method} for Prime threads`,
          -32601,
        );
    }
  }

  private async handlePrimeThreadRead(
    id: JsonRpcId,
    threadId: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const saved = await this.requireSavedPrimeThread(threadId);
    rpcResult(id, {
      thread: threadFromPrimeSession(saved, {
        loaded: this.livePrimeThreads.has(threadId),
        includeTurns: params.includeTurns === true,
      }),
    });
  }

  private async handlePrimeThreadResume(
    id: JsonRpcId,
    threadId: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const session = await this.ensurePrimeSession(threadId, params);
    const saved = await this.requireSavedPrimeThread(threadId);
    const allTurns = turnsFromPrimeMessages(saved.messages);
    const thread = threadFromPrimeSession(saved, {
      loaded: true,
      includeTurns: params.excludeTurns !== true,
    });
    const result = sessionStartResult(
      thread,
      session.state,
      this.uiModel(session.state),
    );
    const initialTurnsPage = asRecord(params.initialTurnsPage);
    const pageLimit =
      typeof initialTurnsPage.limit === "number" && initialTurnsPage.limit > 0
        ? Math.floor(initialTurnsPage.limit)
        : allTurns.length;
    rpcResult(id, {
      ...result,
      initialTurnsPage: params.initialTurnsPage
        ? {
            data: allTurns.slice(-pageLimit),
            nextCursor: null,
            backwardsCursor: null,
          }
        : null,
      turnsBackwardsCursor: null,
      itemsBackwardsCursor: null,
    });
  }

  private async handlePrimeTurnsList(
    id: JsonRpcId,
    threadId: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const saved = await this.requireSavedPrimeThread(threadId);
    let turns = turnsFromPrimeMessages(saved.messages);
    if (params.sortDirection !== "asc") turns = [...turns].reverse();
    const limit =
      typeof params.limit === "number" && params.limit > 0
        ? Math.floor(params.limit)
        : turns.length;
    rpcResult(id, {
      data: turns.slice(0, limit),
      nextCursor: null,
      backwardsCursor: null,
    });
  }

  private async handlePrimeItemsList(
    id: JsonRpcId,
    threadId: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const saved = await this.requireSavedPrimeThread(threadId);
    let entries = turnsFromPrimeMessages(saved.messages).flatMap((turn) =>
      turn.items.map((item) => ({ turnId: turn.id, item })),
    );
    const turnId = optionalString(params.turnId);
    if (turnId) entries = entries.filter((entry) => entry.turnId === turnId);
    if (params.sortDirection === "desc") entries = [...entries].reverse();
    const limit =
      typeof params.limit === "number" && params.limit > 0
        ? Math.floor(params.limit)
        : entries.length;
    rpcResult(id, {
      data: entries.slice(0, limit),
      nextCursor: null,
      backwardsCursor: null,
    });
  }

  private async handlePrimeThreadName(
    id: JsonRpcId,
    threadId: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const name = optionalString(params.name);
    if (!name) throw new Error("thread/name/set requires a name");
    const session = await this.ensurePrimeSession(threadId);
    await session.client.request({ type: "set_session_name", name });
    rpcResult(id, {});
    notify("thread/name/updated", { threadId, threadName: name });
  }

  private async handlePrimeThreadArchive(
    id: JsonRpcId,
    threadId: string,
  ): Promise<void> {
    const saved = await this.requireSavedPrimeThread(threadId);
    const live = this.livePrimeThreads.get(threadId);
    if (live?.currentTurn) {
      await live.client.request({ type: "abort" }).catch(() => undefined);
    }

    let daemonArchived = false;
    if (live) {
      daemonArchived = await live.client.killResidentSession();
      if (!daemonArchived) await live.client.stop();
      this.livePrimeThreads.delete(threadId);
    } else {
      daemonArchived = await PrimeAgentRpcClient.killResident({
        command: this.options.primeCommand,
        cwd: saved.cwd,
        resume: saved.sessionId,
      });
    }
    if (!daemonArchived) await this.catalog.setArchived(saved.sessionId, true);

    rpcResult(id, {});
    notify("thread/archived", { threadId });
  }

  private async handlePrimeThreadUnarchive(
    id: JsonRpcId,
    threadId: string,
  ): Promise<void> {
    const saved = await this.requireSavedPrimeThread(threadId);
    await this.catalog.setArchived(saved.sessionId, false);
    const refreshed = await this.requireSavedPrimeThread(threadId);
    const thread = threadFromPrimeSession(refreshed, { loaded: false });
    rpcResult(id, { thread });
    notify("thread/unarchived", { threadId });
  }

  private async handlePrimeThreadFork(
    id: JsonRpcId,
    threadId: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const source = await this.requireSavedPrimeThread(threadId);
    const cwd = optionalString(params.cwd) ?? source.cwd;
    const requestedModel = primeModelId(params.model) ?? source.model;
    const requestedThinking =
      toPrimeThinking(params.effort) ??
      (source.thinking as PrimeThinkingLevel | undefined);
    let client = new PrimeAgentRpcClient({
      command: this.options.primeCommand,
      cwd,
      fork: source.filePath,
      ...(source.provider ? { provider: primeProvider(source.provider) } : {}),
      ...(requestedModel ? { model: requestedModel } : {}),
      ...(requestedThinking ? { thinking: requestedThinking } : {}),
    });

    await client.start();
    try {
      let state = asRecord(
        (await client.request({ type: "get_state" })).data,
      ) as PrimeState;
      const intermediateSessionId = state.sessionId;

      const beforeTurnId = optionalString(params.beforeTurnId);
      const lastTurnId = optionalString(params.lastTurnId);
      if (beforeTurnId && lastTurnId) {
        throw new Error(
          "PrimeCodex thread/fork cannot combine beforeTurnId and lastTurnId",
        );
      }

      let forkEntryId: string | undefined;
      if (beforeTurnId) {
        forkEntryId = this.primeUserEntryForTurn(source, beforeTurnId);
      } else if (lastTurnId) {
        forkEntryId = this.nextPrimeUserEntryAfterTurn(source, lastTurnId);
      }

      if (forkEntryId) {
        await client.request({ type: "fork", entryId: forkEntryId });
        state = asRecord(
          (await client.request({ type: "get_state" })).data,
        ) as PrimeState;
        if (
          intermediateSessionId &&
          intermediateSessionId !== state.sessionId
        ) {
          const finalSessionId = state.sessionId;
          if (!finalSessionId) {
            throw new Error("Prime Agent boundary fork returned no session id");
          }

          // Prime RPC forks the already-created clone in place. Stop it briefly
          // so we can remove that staging session and keep the final fork linked
          // directly to the original source session.
          await client.stop();
          await this.catalog.reparent(finalSessionId, source.filePath);
          await this.catalog.delete(intermediateSessionId);

          client = new PrimeAgentRpcClient({
            command: this.options.primeCommand,
            cwd,
            resume: finalSessionId,
            ...(source.provider
              ? { provider: primeProvider(source.provider) }
              : {}),
            ...(requestedModel ? { model: requestedModel } : {}),
            ...(requestedThinking ? { thinking: requestedThinking } : {}),
          });
          await client.start();
          state = asRecord(
            (await client.request({ type: "get_state" })).data,
          ) as PrimeState;
        }
      }

      const developerInstructions = optionalString(
        params.developerInstructions,
      )?.trim();
      if (developerInstructions && state.sessionId) {
        const finalSessionId = state.sessionId;
        await client.stop();
        await this.catalog.appendContextMessage(
          finalSessionId,
          "primecodex.developer_instructions",
          developerInstructions,
        );
        client = new PrimeAgentRpcClient({
          command: this.options.primeCommand,
          cwd,
          resume: finalSessionId,
          ...(source.provider
            ? { provider: primeProvider(source.provider) }
            : {}),
          ...(requestedModel ? { model: requestedModel } : {}),
          ...(requestedThinking ? { thinking: requestedThinking } : {}),
        });
        await client.start();
        state = asRecord(
          (await client.request({ type: "get_state" })).data,
        ) as PrimeState;
      }

      const saved = sessionFromState(state, cwd);
      const ephemeral = params.ephemeral === true;
      if (ephemeral) {
        this.ephemeralPrimeThreads.add(primeThreadId(saved.sessionId));
        await this.catalog
          .setArchived(saved.sessionId, true)
          .catch(() => undefined);
      }

      const refreshed = (await this.catalog.find(saved.sessionId)) ?? saved;
      const thread: CodexThread = {
        ...threadFromPrimeSession(refreshed, {
          loaded: true,
          includeTurns: params.excludeTurns !== true,
        }),
        cwd,
        ephemeral,
        forkedFromId: threadId,
      };
      const session: PrimeCompatSession = {
        threadId: thread.id,
        sessionId: saved.sessionId,
        cwd,
        client,
        state,
      };
      this.bindPrimeSession(session);
      this.livePrimeThreads.set(thread.id, session);
      rpcResult(id, sessionStartResult(thread, state, this.uiModel(state)));
      notify("thread/started", { thread });
    } catch (error) {
      await client.stop();
      throw error;
    }
  }

  private primeUserEntryForTurn(
    source: PrimeSavedSession,
    turnId: string,
  ): string {
    const prefix = "prime-turn:";
    const entryId = turnId.startsWith(prefix)
      ? turnId.slice(prefix.length)
      : "";
    if (
      !entryId ||
      !source.messages.some(
        (message) => message.role === "user" && message.entryId === entryId,
      )
    ) {
      throw new Error(`PrimeCodex cannot resolve fork turn ${turnId}`);
    }
    return entryId;
  }

  private nextPrimeUserEntryAfterTurn(
    source: PrimeSavedSession,
    turnId: string,
  ): string | undefined {
    const currentEntryId = this.primeUserEntryForTurn(source, turnId);
    let seen = false;
    for (const message of source.messages) {
      if (message.role !== "user") continue;
      if (seen) return message.entryId;
      if (message.entryId === currentEntryId) seen = true;
    }
    return undefined;
  }

  private async handlePrimeThreadUnsubscribe(
    id: JsonRpcId,
    threadId: string,
  ): Promise<void> {
    const live = this.livePrimeThreads.get(threadId);
    if (live) {
      if (live.currentTurn) {
        await live.client.request({ type: "abort" }).catch(() => undefined);
      }
      await live.client.stop();
      this.livePrimeThreads.delete(threadId);
    }
    if (this.ephemeralPrimeThreads.delete(threadId)) {
      const sessionId = parsePrimeThreadId(threadId);
      if (sessionId) await this.catalog.delete(sessionId);
    }
    rpcResult(id, {});
  }

  private async handlePrimeThreadDelete(
    id: JsonRpcId,
    threadId: string,
  ): Promise<void> {
    const saved = await this.requireSavedPrimeThread(threadId);
    const live = this.livePrimeThreads.get(threadId);
    if (live?.currentTurn) {
      await live.client.request({ type: "abort" }).catch(() => undefined);
    }

    if (live) {
      const killed = await live.client.killResidentSession();
      if (!killed) await live.client.stop();
      this.livePrimeThreads.delete(threadId);
    } else {
      await PrimeAgentRpcClient.killResident({
        command: this.options.primeCommand,
        cwd: saved.cwd,
        resume: saved.sessionId,
      }).catch(() => false);
    }

    this.ephemeralPrimeThreads.delete(threadId);
    await this.catalog.delete(saved.sessionId);
    rpcResult(id, {});
    notify("thread/deleted", { threadId });
  }

  private async handlePrimeThreadCompact(
    id: JsonRpcId,
    threadId: string,
  ): Promise<void> {
    const session = await this.ensurePrimeSession(threadId);
    if (session.currentTurn) {
      throw new Error(
        "Cannot compact a Prime thread while a turn is in progress",
      );
    }

    const turn = this.beginPrimeSyntheticTurn(session);
    try {
      await session.client.request({ type: "compact" }, 180_000);
      await this.refreshPrimeState(session);

      const codexTurn = this.codexTurn(turn, "inProgress");
      notify("thread/status/changed", {
        threadId,
        status: { type: "active", activeFlags: [] },
      });
      notify("turn/started", { threadId, turn: codexTurn });
      turn.ready = true;
      for (const event of turn.bufferedEvents.splice(0)) {
        this.translatePrimeEvent(session, event);
      }
      if (session.currentTurn === turn) this.finishPrimeTurn(session);

      rpcResult(id, {});
      notify("thread/compacted", { threadId, turnId: turn.id });
    } catch (error) {
      if (session.currentTurn === turn) session.currentTurn = undefined;
      throw error;
    }
  }

  private async handlePrimeThreadRollback(
    id: JsonRpcId,
    threadId: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const numTurns = numberOrNull(params.numTurns);
    if (numTurns === null || !Number.isInteger(numTurns) || numTurns <= 0) {
      throw new Error("thread/rollback requires a positive integer numTurns");
    }

    const saved = await this.requireSavedPrimeThread(threadId);
    const availableTurns = saved.messages.filter(
      (message) => message.role === "user" || message.role === "goal",
    ).length;
    if (numTurns > availableTurns) {
      throw new Error(
        `Cannot rollback ${numTurns} turns from a session with ${availableTurns} turns`,
      );
    }
    const live = this.livePrimeThreads.get(threadId);
    if (live?.currentTurn) {
      throw new Error(
        "Cannot rollback a Prime thread while a turn is in progress",
      );
    }

    if (live) {
      const killed = await live.client.killResidentSession();
      if (!killed) await live.client.stop();
      this.livePrimeThreads.delete(threadId);
    } else {
      await PrimeAgentRpcClient.killResident({
        command: this.options.primeCommand,
        cwd: saved.cwd,
        resume: saved.sessionId,
      }).catch(() => false);
    }

    const refreshed = await this.catalog.rollbackTurns(
      saved.sessionId,
      numTurns,
    );
    rpcResult(id, {
      thread: threadFromPrimeSession(refreshed, {
        loaded: false,
        includeTurns: true,
      }),
    });
  }

  private async handlePrimeThreadSettingsUpdate(
    id: JsonRpcId,
    threadId: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const session = await this.ensurePrimeSession(threadId);
    if (session.currentTurn) {
      throw new Error(
        "Cannot change Prime thread settings while a turn is in progress",
      );
    }

    const requestedModelRaw = optionalString(params.model);
    const requestedModel = requestedModelRaw?.startsWith(PRIME_MODEL_PREFIX)
      ? requestedModelRaw.slice(PRIME_MODEL_PREFIX.length)
      : requestedModelRaw;
    if (requestedModel && requestedModel !== modelFromState(session.state)) {
      await session.client.request({
        type: "set_model",
        provider: primeProvider(session.state.model?.provider),
        modelId: requestedModel,
      });
    }

    const thinking = toPrimeThinking(params.effort);
    if (thinking && thinking !== session.state.thinkingLevel) {
      await session.client.request({
        type: "set_thinking_level",
        level: thinking,
      });
    }

    session.state = asRecord(
      (await session.client.request({ type: "get_state" })).data,
    ) as PrimeState;
    // Prime does not implement Codex approval/sandbox/personality settings.
    // Emit the real Prime-effective settings before resolving the request so the
    // renderer does not optimistically retain unsupported values.
    this.emitThreadSettings(session);
    rpcResult(id, {});
  }

  private async handlePrimeThreadMetadataUpdate(
    id: JsonRpcId,
    threadId: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const saved = await this.requireSavedPrimeThread(threadId);
    let refreshed = saved;
    if (Object.prototype.hasOwnProperty.call(params, "gitInfo")) {
      const raw = params.gitInfo;
      let patch: {
        sha?: string | null;
        branch?: string | null;
        originUrl?: string | null;
      } | null;
      if (raw === null) {
        patch = null;
      } else {
        const gitInfo = asRecord(raw);
        patch = {};
        for (const key of ["sha", "branch", "originUrl"] as const) {
          if (!Object.prototype.hasOwnProperty.call(gitInfo, key)) continue;
          const value = gitInfo[key];
          if (
            value !== null &&
            (typeof value !== "string" || value.length === 0)
          ) {
            throw new Error(
              `thread/metadata/update gitInfo.${key} must be a non-empty string or null`,
            );
          }
          patch[key] = value as string | null;
        }
      }
      refreshed = await this.catalog.updateGitInfo(saved.sessionId, patch);
    }

    rpcResult(id, {
      thread: threadFromPrimeSession(refreshed, {
        loaded: this.livePrimeThreads.has(threadId),
      }),
    });
  }

  private async unloadPrimeSessionForExternalMutation(
    threadId: string,
  ): Promise<void> {
    const live = this.livePrimeThreads.get(threadId);
    if (!live) return;
    if (live.currentTurn) {
      throw new Error(
        "Cannot mutate Prime thread history while a turn is in progress",
      );
    }

    const saved = await this.requireSavedPrimeThread(threadId);
    const killedResident = await live.client
      .killResidentSession()
      .catch(() => false);
    if (!killedResident) await live.client.stop();
    this.livePrimeThreads.delete(threadId);

    // Prime's daemon kill path archives the persisted session. inject_items is
    // a history mutation, not an archive action, so restore the prior lifecycle.
    if (killedResident && !saved.archived) {
      await this.catalog.setArchived(saved.sessionId, false);
    }
  }

  private async handlePrimeThreadInjectItems(
    id: JsonRpcId,
    threadId: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    if (!Array.isArray(params.items)) {
      throw new Error("thread/inject_items requires an items array");
    }
    if (params.items.length === 0) {
      rpcResult(id, {});
      return;
    }

    const injected = params.items.map(injectedUserItemText);
    if (injected.some((text) => text === undefined)) {
      throw new Error(
        "PrimeCodex currently supports thread/inject_items user message text items only",
      );
    }
    const texts = injected as string[];
    const saved = await this.requireSavedPrimeThread(threadId);
    const live = this.livePrimeThreads.get(threadId);

    // Resident daemon sessions can accept a hidden custom message directly,
    // preserving their in-memory context without a restart. Prime's standalone
    // RPC mode does not expose this daemon command, so do not probe it and pay
    // the request timeout there.
    if (live?.client.isDaemonBacked()) {
      for (const text of texts) {
        await live.client.request({
          type: "append_custom_message",
          message: {
            customType: "primecodex.injected_item",
            content: text,
            display: false,
            details: { source: "primecodex", kind: "thread/inject_items" },
          },
        });
      }
      rpcResult(id, {});
      return;
    }

    // Prime's standalone RPC mode does not expose append_custom_message. Stop
    // the idle runtime, append through Prime's native JSONL custom-message
    // format, then resume so the in-memory context includes the injected item.
    await this.unloadPrimeSessionForExternalMutation(threadId);
    for (const text of texts) {
      await this.catalog.appendContextMessage(
        saved.sessionId,
        "primecodex.injected_item",
        text,
      );
    }
    await this.ensurePrimeSession(threadId);
    rpcResult(id, {});
  }

  private async refreshPrimeState(
    session: PrimeCompatSession,
  ): Promise<PrimeState> {
    session.state = asRecord(
      (await session.client.request({ type: "get_state" })).data,
    ) as PrimeState;
    return session.state;
  }

  private beginPrimeSyntheticTurn(
    session: PrimeCompatSession,
  ): PrimeTurnContext {
    const turn: PrimeTurnContext = {
      id: `prime-synthetic-turn:${randomUUID()}`,
      userItem: {
        type: "userMessage",
        id: `prime-synthetic-input:${randomUUID()}`,
        clientId: null,
        content: [],
      },
      items: [],
      startedAtMs: Date.now(),
      ready: false,
      bufferedEvents: [],
      tools: new Map(),
      subagentIds: new Set(),
      interrupted: false,
      failed: false,
    };
    session.currentTurn = turn;
    return turn;
  }

  private async runPrimeGoalCommand(
    session: PrimeCompatSession,
    command: string,
    options: { expectAgentTurn?: boolean } = {},
  ): Promise<PrimeState> {
    const turn =
      options.expectAgentTurn === true && !session.currentTurn
        ? this.beginPrimeSyntheticTurn(session)
        : undefined;
    try {
      await session.client.request({ type: "prompt", message: command });
      const state = await this.refreshPrimeState(session);
      if (!turn) return state;

      const ranAgent =
        state.isStreaming === true ||
        turn.bufferedEvents.some((event) =>
          [
            "agent_start",
            "agent_end",
            "message_update",
            "tool_execution_start",
            "bash_start",
            "rlm_child_update",
          ].includes(event.type),
        );
      if (!ranAgent) {
        if (session.currentTurn === turn) session.currentTurn = undefined;
        return state;
      }

      const persisted = await this.catalog.find(session.sessionId);
      const goalBoundary = persisted?.messages.findLast(
        (entry) => entry.role === "goal",
      );
      if (goalBoundary) turn.id = `prime-turn:${goalBoundary.entryId}`;

      const codexTurn = this.codexTurn(turn, "inProgress");
      this.emitThreadSettings(session);
      notify("thread/status/changed", {
        threadId: session.threadId,
        status: { type: "active", activeFlags: [] },
      });
      notify("turn/started", { threadId: session.threadId, turn: codexTurn });
      turn.ready = true;
      for (const event of turn.bufferedEvents.splice(0)) {
        this.translatePrimeEvent(session, event);
      }
      return state;
    } catch (error) {
      if (turn && session.currentTurn === turn) session.currentTurn = undefined;
      throw error;
    }
  }

  private async handlePrimeThreadGoalGet(
    id: JsonRpcId,
    threadId: string,
  ): Promise<void> {
    const session = await this.ensurePrimeSession(threadId);
    const state = await this.refreshPrimeState(session);
    rpcResult(id, { goal: codexGoalFromPrime(threadId, state.goal) });
  }

  private async handlePrimeThreadGoalSet(
    id: JsonRpcId,
    threadId: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const session = await this.ensurePrimeSession(threadId);
    let state = await this.refreshPrimeState(session);
    const currentGoal = asRecord(state.goal);
    const requestedObjective =
      typeof params.objective === "string"
        ? params.objective.trim()
        : undefined;
    const requestedStatus = optionalString(params.status);
    const hasTokenBudget = Object.prototype.hasOwnProperty.call(
      params,
      "tokenBudget",
    );
    const requestedBudget = hasTokenBudget
      ? numberOrNull(params.tokenBudget)
      : numberOrNull(currentGoal.tokenBudget);
    const currentObjective = optionalString(currentGoal.objective);
    const targetObjective = requestedObjective ?? currentObjective;

    if (requestedObjective !== undefined || hasTokenBudget) {
      if (!targetObjective) {
        throw new Error("thread/goal/set requires a goal objective");
      }
      if (
        hasTokenBudget &&
        params.tokenBudget !== null &&
        requestedBudget === null
      ) {
        throw new Error(
          "thread/goal/set tokenBudget must be a positive integer or null",
        );
      }
      if (
        requestedBudget !== null &&
        (!Number.isInteger(requestedBudget) || requestedBudget <= 0)
      ) {
        throw new Error(
          "thread/goal/set tokenBudget must be a positive integer or null",
        );
      }
      const budgetArg =
        requestedBudget === null ? "" : `--budget ${requestedBudget} `;
      state = await this.runPrimeGoalCommand(
        session,
        `/goal ${budgetArg}${targetObjective}`,
        {
          expectAgentTurn: !session.currentTurn && requestedStatus !== "paused",
        },
      );
    }

    const goal = asRecord(state.goal);
    const primeStatus = optionalString(goal.status);
    if (requestedStatus === "active") {
      if (!optionalString(goal.objective)) {
        throw new Error(
          "Cannot activate a Prime thread without a goal objective",
        );
      }
      if (primeStatus === "paused" || primeStatus === "budget_limited") {
        state = await this.runPrimeGoalCommand(session, "/goal resume", {
          expectAgentTurn: !session.currentTurn,
        });
      } else if (
        primeStatus === "active" &&
        state.isStreaming !== true &&
        !session.currentTurn &&
        requestedObjective === undefined &&
        !hasTokenBudget
      ) {
        // Prime keeps an active goal persisted across restarts, but an idle
        // resumed session needs an explicit resume edge to restart autonomous
        // continuation. Pause+resume preserves the objective and accounting.
        await this.runPrimeGoalCommand(session, "/goal pause");
        state = await this.runPrimeGoalCommand(session, "/goal resume", {
          expectAgentTurn: true,
        });
      }
    } else if (requestedStatus === "paused" && primeStatus === "active") {
      if (session.currentTurn || state.isStreaming === true) {
        if (session.currentTurn) session.currentTurn.interrupted = true;
        await session.client.request({ type: "abort" });
      }
      state = await this.runPrimeGoalCommand(session, "/goal pause");
    } else if (
      requestedStatus &&
      requestedStatus !== "active" &&
      requestedStatus !== "paused"
    ) {
      throw new Error(
        `PrimeCodex cannot directly set Prime goal status ${requestedStatus}`,
      );
    }

    const mapped = codexGoalFromPrime(threadId, state.goal);
    if (!mapped)
      throw new Error("Prime Agent did not return an active thread goal");
    rpcResult(id, { goal: mapped });
  }

  private async handlePrimeThreadGoalClear(
    id: JsonRpcId,
    threadId: string,
  ): Promise<void> {
    const session = await this.ensurePrimeSession(threadId);
    const state = await this.refreshPrimeState(session);
    const hadGoal = codexGoalFromPrime(threadId, state.goal) !== null;
    if (!hadGoal) {
      rpcResult(id, { cleared: false });
      return;
    }

    if (session.currentTurn || state.isStreaming === true) {
      if (session.currentTurn) session.currentTurn.interrupted = true;
      await session.client.request({ type: "abort" });
    }
    await this.runPrimeGoalCommand(session, "/goal clear");
    rpcResult(id, { cleared: true });
  }

  private async handlePrimeTurnStart(
    id: JsonRpcId,
    threadId: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const session = await this.ensurePrimeSession(threadId);
    if (session.currentTurn) {
      throw new Error("Prime Agent already has a turn in progress");
    }

    const input = Array.isArray(params.input) ? params.input : [];
    const preparedInput = await primeInput(input);
    const message = preparedInput.message;
    if (!message) throw new Error("PrimeCodex received an empty task input");

    const requestedModel = primeModelId(params.model);
    if (requestedModel && requestedModel !== modelFromState(session.state)) {
      await session.client.request({
        type: "set_model",
        provider: primeProvider(session.state.model?.provider),
        modelId: requestedModel,
      });
    }
    const thinking = toPrimeThinking(params.effort);
    if (thinking) {
      await session.client.request({
        type: "set_thinking_level",
        level: thinking,
      });
      session.state.thinkingLevel = thinking;
    }

    const turn: PrimeTurnContext = {
      id: randomUUID(),
      userItem: {
        type: "userMessage",
        id: randomUUID(),
        clientId: optionalString(params.clientUserMessageId) ?? null,
        content: input,
      },
      items: [],
      startedAtMs: Date.now(),
      ready: false,
      bufferedEvents: [],
      tools: new Map(),
      subagentIds: new Set(),
      interrupted: false,
      failed: false,
    };
    session.currentTurn = turn;

    try {
      await session.client.request({
        type: "prompt",
        message,
        ...(preparedInput.images.length > 0
          ? { images: preparedInput.images }
          : {}),
      });

      // Prime persists the admitted user message before returning from prompt.
      // Canonicalize the live turn/item IDs to the same IDs reconstructed from
      // saved history so message-level "Continue in new task" works before a
      // page reload as well as after one.
      const persisted = await this.catalog.find(session.sessionId);
      const latestUser = persisted?.messages.findLast(
        (entry) => entry.role === "user",
      );
      if (latestUser) {
        turn.id = `prime-turn:${latestUser.entryId}`;
        turn.userItem.id = `prime-item:${latestUser.entryId}`;
      }

      const codexTurn = this.codexTurn(turn, "inProgress");
      rpcResult(id, { turn: codexTurn });
      this.emitThreadSettings(session);
      notify("thread/status/changed", {
        threadId,
        status: { type: "active", activeFlags: [] },
      });
      notify("turn/started", { threadId, turn: codexTurn });
      notify("item/started", {
        item: turn.userItem,
        threadId,
        turnId: turn.id,
        startedAtMs: turn.startedAtMs,
      });
      notify("item/completed", {
        item: turn.userItem,
        threadId,
        turnId: turn.id,
        completedAtMs: Date.now(),
      });
      turn.ready = true;
      for (const event of turn.bufferedEvents.splice(0)) {
        this.translatePrimeEvent(session, event);
      }
    } catch (error) {
      session.currentTurn = undefined;
      throw error;
    }
  }

  private async handlePrimeTurnSteer(
    id: JsonRpcId,
    threadId: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const session = await this.ensurePrimeSession(threadId);
    const turn = session.currentTurn;
    if (!turn) {
      throw new Error(
        `Cannot steer Prime thread ${threadId} without an active turn`,
      );
    }

    const expectedTurnId = optionalString(params.expectedTurnId);
    if (!expectedTurnId) {
      throw new Error("turn/steer requires expectedTurnId");
    }
    if (expectedTurnId !== turn.id) {
      // Match native Codex' retryable precondition wording. The renderer parses
      // the currently-active turn id from this message and retries once.
      throw new Error(
        `expected active turn id \`${expectedTurnId}\` but found \`${turn.id}\``,
      );
    }

    const input = Array.isArray(params.input) ? params.input : [];
    const preparedInput = await primeInput(input);
    if (!preparedInput.message) {
      throw new Error("PrimeCodex received an empty steering input");
    }

    await session.client.request({
      type: "steer",
      message: preparedInput.message,
      ...(preparedInput.images.length > 0
        ? { images: preparedInput.images }
        : {}),
    });
    rpcResult(id, { turnId: turn.id });
  }

  private async handlePrimeTurnInterrupt(
    id: JsonRpcId,
    threadId: string,
  ): Promise<void> {
    const session = this.livePrimeThreads.get(threadId);
    if (!session?.currentTurn) {
      rpcResult(id, {});
      return;
    }
    session.currentTurn.interrupted = true;
    await session.client.request({ type: "abort" });
    rpcResult(id, {});
  }

  private async ensurePrimeSession(
    threadId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<PrimeCompatSession> {
    const existing = this.livePrimeThreads.get(threadId);
    if (existing) return existing;

    const sessionId = parsePrimeThreadId(threadId);
    if (!sessionId) throw new Error(`Not a Prime thread: ${threadId}`);
    const saved = await this.catalog.find(sessionId);
    if (!saved) throw new Error(`Prime Agent session not found: ${sessionId}`);

    const client = new PrimeAgentRpcClient({
      command: this.options.primeCommand,
      cwd: optionalString(overrides.cwd) ?? saved.cwd,
      resume: sessionId,
      ...(primeModelId(overrides.model)
        ? {
            model: primeModelId(overrides.model),
            provider: primeProvider(overrides.modelProvider ?? saved.provider),
          }
        : saved.model
          ? {
              model: saved.model,
              provider: primeProvider(saved.provider),
            }
          : {}),
      thinking:
        toPrimeThinking(saved.thinking) ?? this.options.defaultPrimeThinking,
    });
    await client.start();
    try {
      const state = asRecord(
        (await client.request({ type: "get_state" })).data,
      ) as PrimeState;
      const session: PrimeCompatSession = {
        threadId,
        sessionId,
        cwd: optionalString(overrides.cwd) ?? saved.cwd,
        client,
        state,
      };
      this.bindPrimeSession(session);
      this.livePrimeThreads.set(threadId, session);
      return session;
    } catch (error) {
      await client.stop();
      throw error;
    }
  }

  private bindPrimeSession(session: PrimeCompatSession): void {
    session.client.onEvent((event) => {
      if (event.type === "goal_update") {
        const turn = session.currentTurn;
        if (turn && !turn.ready) {
          turn.bufferedEvents.push(event);
          return;
        }
        this.handlePrimeGoalUpdate(session, event);
        return;
      }
      const turn = session.currentTurn;
      if (!turn) return;
      if (!turn.ready) {
        turn.bufferedEvents.push(event);
        return;
      }
      this.translatePrimeEvent(session, event);
    });
  }

  private handlePrimeGoalUpdate(
    session: PrimeCompatSession,
    event: PrimeRpcEvent,
  ): void {
    const goal = asRecord(event.goal);
    session.state.goal = goal as PrimeState["goal"];
    const mapped = codexGoalFromPrime(session.threadId, goal);
    if (!mapped) {
      notify("thread/goal/cleared", { threadId: session.threadId });
      return;
    }
    notify("thread/goal/updated", {
      threadId: session.threadId,
      turnId: session.currentTurn?.id ?? null,
      goal: mapped,
    });
  }

  private translatePrimeEvent(
    session: PrimeCompatSession,
    event: PrimeRpcEvent,
  ): void {
    const turn = session.currentTurn;
    if (!turn) return;
    const threadId = session.threadId;

    if (event.type === "goal_update") {
      this.handlePrimeGoalUpdate(session, event);
      return;
    }

    if (event.type === "session_action_update") {
      const actions = asRecord(event.actions);
      const active = asRecord(actions.active);
      session.state.sessionActions = {
        queuedCount: numberOrNull(actions.queuedCount) ?? 0,
        steering: Array.isArray(actions.steering)
          ? actions.steering.filter(
              (value): value is string => typeof value === "string",
            )
          : [],
        followUps: Array.isArray(actions.followUps)
          ? actions.followUps.filter(
              (value): value is string => typeof value === "string",
            )
          : [],
        ...(Object.keys(active).length > 0
          ? {
              active: {
                kind: optionalString(active.kind),
                phase: optionalString(active.phase),
                label: optionalString(active.label),
              },
            }
          : {}),
      };
      if (turn.pendingAgentEnd && !primeHasPendingContinuation(session.state)) {
        this.finishPrimeTurn(session);
      }
      return;
    }

    if (event.type === "message_update") {
      const update = asRecord(event.assistantMessageEvent);
      if (update.type === "text_start") {
        this.ensureAgentItem(threadId, turn);
      } else if (update.type === "text_delta") {
        const item = this.ensureAgentItem(threadId, turn);
        const delta = optionalString(update.delta) ?? "";
        item.text = `${typeof item.text === "string" ? item.text : ""}${delta}`;
        notify("item/agentMessage/delta", {
          threadId,
          turnId: turn.id,
          itemId: item.id,
          delta,
        });
      } else if (update.type === "thinking_start") {
        this.ensureReasoningItem(threadId, turn);
      } else if (update.type === "thinking_delta") {
        const item = this.ensureReasoningItem(threadId, turn);
        const delta = optionalString(update.delta) ?? "";
        const summary = Array.isArray(item.summary) ? item.summary : [""];
        summary[0] = `${typeof summary[0] === "string" ? summary[0] : ""}${delta}`;
        item.summary = summary;
        notify("item/reasoning/summaryTextDelta", {
          threadId,
          turnId: turn.id,
          itemId: item.id,
          delta,
          summaryIndex: 0,
        });
      } else if (update.type === "error") {
        turn.failed = update.reason !== "aborted";
        turn.interrupted = update.reason === "aborted";
      }
      return;
    }

    if (event.type === "recap_update") {
      const recap = optionalString(event.recap)?.trim();
      if (!recap || recap === turn.lastRecap) return;
      turn.lastRecap = recap;
      const item = this.ensureReasoningItem(threadId, turn);
      const summary = Array.isArray(item.summary) ? item.summary : [""];
      const prefix =
        typeof summary[0] === "string" && summary[0].length > 0 ? "\n" : "";
      const delta = `${prefix}${recap}`;
      summary[0] = `${typeof summary[0] === "string" ? summary[0] : ""}${delta}`;
      item.summary = summary;
      notify("item/reasoning/summaryTextDelta", {
        threadId,
        turnId: turn.id,
        itemId: item.id,
        delta,
        summaryIndex: 0,
      });
      return;
    }

    if (event.type === "message_end") {
      const message = asRecord(event.message);
      if (message.role === "assistant") {
        const thinkingText = Array.isArray(message.content)
          ? message.content
              .map((entry) => asRecord(entry))
              .filter(
                (entry) =>
                  entry.type === "thinking" &&
                  typeof entry.thinking === "string",
              )
              .map((entry) => String(entry.thinking))
              .filter(Boolean)
              .join("\n")
          : "";
        if (thinkingText) {
          const item =
            turn.reasoningItem ?? this.ensureReasoningItem(threadId, turn);
          item.summary = [thinkingText];
        }
        if (turn.agentItem) {
          const fullText = contentText(message.content);
          if (fullText) turn.agentItem.text = fullText;
          this.completeItem(threadId, turn, turn.agentItem);
          turn.agentItem = undefined;
        }
        if (turn.reasoningItem) {
          this.completeItem(threadId, turn, turn.reasoningItem);
          turn.reasoningItem = undefined;
        }
        if (message.usage && typeof message.usage === "object") {
          turn.latestUsage = asRecord(message.usage);
        }
        if (message.stopReason === "aborted") turn.interrupted = true;
        if (message.stopReason === "error") turn.failed = true;
      }
      return;
    }

    if (event.type === "tool_execution_start") {
      const callId = optionalString(event.toolCallId) ?? randomUUID();
      const toolName = optionalString(event.toolName) ?? "tool";
      const item: CodexThreadItem = {
        type: "commandExecution",
        id: `prime-tool:${callId}`,
        pluginId: null,
        scriptPath: null,
        command: toolCommand(toolName, event.args),
        cwd: session.cwd,
        processId: null,
        source: "agent",
        status: "inProgress",
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
      };
      const startedAtMs = Date.now();
      turn.tools.set(callId, { item, output: "", startedAtMs });
      notify("item/started", {
        item,
        threadId,
        turnId: turn.id,
        startedAtMs,
      });
      return;
    }

    if (event.type === "tool_execution_update") {
      const callId = optionalString(event.toolCallId);
      if (!callId) return;
      const runtime = turn.tools.get(callId);
      if (!runtime) return;
      const nextOutput = outputText(event.partialResult);
      if (!nextOutput) return;
      const delta = nextOutput.startsWith(runtime.output)
        ? nextOutput.slice(runtime.output.length)
        : nextOutput;
      runtime.output = nextOutput;
      runtime.item.aggregatedOutput = nextOutput;
      if (delta) {
        notify("item/commandExecution/outputDelta", {
          threadId,
          turnId: turn.id,
          itemId: runtime.item.id,
          delta,
        });
      }
      return;
    }

    if (event.type === "tool_execution_end") {
      const callId = optionalString(event.toolCallId);
      if (!callId) return;
      const runtime = turn.tools.get(callId);
      if (!runtime) return;
      const finalOutput = outputText(event.result) || runtime.output;
      const isError = event.isError === true;
      runtime.item.aggregatedOutput = finalOutput || null;
      runtime.item.status = isError ? "failed" : "completed";
      runtime.item.exitCode = isError ? 1 : 0;
      runtime.item.durationMs = Date.now() - runtime.startedAtMs;
      this.completeItem(threadId, turn, runtime.item);
      turn.tools.delete(callId);

      const fileChange = primeFileChangeItem(callId, event.result, isError);
      if (fileChange) {
        const startedAtMs = runtime.startedAtMs;
        notify("item/started", {
          item: { ...fileChange, status: "inProgress" },
          threadId,
          turnId: turn.id,
          startedAtMs,
        });
        this.completeItem(threadId, turn, fileChange);
      }
      return;
    }

    if (event.type === "bash_start") {
      if (event.transient === true) return;
      const runId = optionalString(event.runId);
      const item: CodexThreadItem = {
        type: "commandExecution",
        id: `prime-bash:${runId ?? randomUUID()}`,
        pluginId: null,
        scriptPath: null,
        command: optionalString(event.command) ?? "bash",
        cwd: session.cwd,
        processId: null,
        source: "agent",
        status: "inProgress",
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
      };
      const startedAtMs = Date.now();
      turn.bashRun = {
        item,
        output: "",
        startedAtMs,
        ...(runId ? { runId } : {}),
      };
      notify("item/started", {
        item,
        threadId,
        turnId: turn.id,
        startedAtMs,
      });
      return;
    }

    if (event.type === "bash_output") {
      const runtime = turn.bashRun;
      if (!runtime) return;
      const delta = optionalString(event.chunk) ?? "";
      if (!delta) return;
      runtime.output += delta;
      runtime.item.aggregatedOutput = runtime.output;
      notify("item/commandExecution/outputDelta", {
        threadId,
        turnId: turn.id,
        itemId: runtime.item.id,
        delta,
      });
      return;
    }

    if (event.type === "bash_end") {
      const runtime = turn.bashRun;
      if (!runtime) return;
      const exitCode = numberOrNull(event.exitCode);
      const cancelled = event.cancelled === true;
      const errorMessage = optionalString(event.errorMessage);
      if (errorMessage) {
        const prefix =
          runtime.output && !runtime.output.endsWith("\n") ? "\n" : "";
        runtime.output += `${prefix}${errorMessage}`;
      }
      runtime.item.aggregatedOutput = runtime.output || null;
      runtime.item.status =
        exitCode === 0 && !cancelled ? "completed" : "failed";
      runtime.item.exitCode = exitCode ?? (cancelled ? 130 : 1);
      runtime.item.durationMs = Date.now() - runtime.startedAtMs;
      this.completeItem(threadId, turn, runtime.item);
      turn.bashRun = undefined;
      return;
    }

    if (event.type === "compaction_start") {
      if (turn.compactionItem) return;
      const item: CodexThreadItem = {
        type: "contextCompaction",
        id: `prime-compaction:${randomUUID()}`,
        completed: false,
        source: event.reason === "manual" ? "manual" : "automatic",
      };
      turn.compactionItem = item;
      notify("item/started", {
        item,
        threadId,
        turnId: turn.id,
        startedAtMs: Date.now(),
      });
      return;
    }

    if (event.type === "compaction_end") {
      const item = turn.compactionItem ?? {
        type: "contextCompaction",
        id: `prime-compaction:${randomUUID()}`,
        completed: false,
        source: event.reason === "manual" ? "manual" : "automatic",
      };
      if (!turn.compactionItem) {
        notify("item/started", {
          item,
          threadId,
          turnId: turn.id,
          startedAtMs: Date.now(),
        });
      }
      item.completed = true;
      this.completeItem(threadId, turn, item);
      turn.compactionItem = undefined;
      return;
    }

    if (event.type === "rlm_child_update") {
      const child = asRecord(event.child);
      const childId = optionalString(child.id);
      if (!childId) return;
      const status = optionalString(child.status) ?? "running";
      const itemId = `prime-subagent:${childId}`;
      const agentThreadId =
        optionalString(child.activeSessionId) ??
        optionalString(child.sessionName) ??
        childId;
      const label =
        optionalString(child.sessionName) ??
        optionalString(child.label) ??
        `agent-${childId.slice(0, 8)}`;
      const first = !turn.subagentIds.has(childId);
      turn.subagentIds.add(childId);
      const item: CodexThreadItem = {
        type: "subAgentActivity",
        id: itemId,
        agentThreadId,
        agentPath: `root/${label}`,
        kind:
          status === "cancelled"
            ? "interrupted"
            : first
              ? "started"
              : "interacted",
      };
      const existingIndex = turn.items.findIndex(
        (entry) => entry.id === itemId,
      );
      if (existingIndex >= 0) turn.items[existingIndex] = { ...item };
      else turn.items.push({ ...item });
      notify("item/completed", {
        item,
        threadId,
        turnId: turn.id,
        completedAtMs: Date.now(),
      });
      return;
    }

    if (event.type === "ipython_sent_agent_message") {
      const message = asRecord(event.message);
      const target = asRecord(message.target);
      const targetName =
        optionalString(target.sessionName) ??
        optionalString(target.sessionId) ??
        "agent";
      const body = optionalString(message.message) ?? "";
      const delivery = optionalString(message.deliveryStatus) ?? "sent";
      const callId = optionalString(event.toolCallId) ?? randomUUID();
      const item: CodexThreadItem = {
        type: "commandExecution",
        id: `prime-agent-message:${callId}:${randomUUID()}`,
        pluginId: null,
        scriptPath: null,
        command: `agent_message.send → ${targetName}`,
        cwd: session.cwd,
        processId: null,
        source: "agent",
        status: "completed",
        commandActions: [],
        aggregatedOutput: body ? `${delivery}: ${body}` : delivery,
        exitCode: 0,
        durationMs: 0,
      };
      notify("item/started", {
        item: { ...item, status: "inProgress" },
        threadId,
        turnId: turn.id,
        startedAtMs: Date.now(),
      });
      this.completeItem(threadId, turn, item);
      return;
    }

    if (event.type === "agent_end") {
      turn.pendingAgentEnd = true;
      if (!primeHasPendingContinuation(session.state)) {
        this.finishPrimeTurn(session);
      }
    }
  }

  private ensureAgentItem(
    threadId: string,
    turn: PrimeTurnContext,
  ): CodexThreadItem {
    if (turn.agentItem) return turn.agentItem;
    const item: CodexThreadItem = {
      type: "agentMessage",
      id: randomUUID(),
      text: "",
      phase: "final_answer",
      memoryCitation: null,
    };
    turn.agentItem = item;
    notify("item/started", {
      item,
      threadId,
      turnId: turn.id,
      startedAtMs: Date.now(),
    });
    return item;
  }

  private ensureReasoningItem(
    threadId: string,
    turn: PrimeTurnContext,
  ): CodexThreadItem {
    if (turn.reasoningItem) return turn.reasoningItem;
    const item: CodexThreadItem = {
      type: "reasoning",
      id: randomUUID(),
      summary: [""],
      content: [],
    };
    turn.reasoningItem = item;
    notify("item/started", {
      item,
      threadId,
      turnId: turn.id,
      startedAtMs: Date.now(),
    });
    return item;
  }

  private completeItem(
    threadId: string,
    turn: PrimeTurnContext,
    item: CodexThreadItem,
  ): void {
    turn.items.push({ ...item });
    notify("item/completed", {
      item,
      threadId,
      turnId: turn.id,
      completedAtMs: Date.now(),
    });
  }

  private finishPrimeTurn(session: PrimeCompatSession): void {
    const turn = session.currentTurn;
    if (!turn) return;
    for (const runtime of turn.tools.values()) {
      runtime.item.status = "failed";
      runtime.item.durationMs = Date.now() - runtime.startedAtMs;
      this.completeItem(session.threadId, turn, runtime.item);
    }
    turn.tools.clear();

    if (turn.bashRun) {
      turn.bashRun.item.status = turn.interrupted ? "failed" : "completed";
      turn.bashRun.item.exitCode = turn.interrupted ? 130 : 0;
      turn.bashRun.item.durationMs = Date.now() - turn.bashRun.startedAtMs;
      turn.bashRun.item.aggregatedOutput = turn.bashRun.output || null;
      this.completeItem(session.threadId, turn, turn.bashRun.item);
      turn.bashRun = undefined;
    }

    if (turn.compactionItem) {
      turn.compactionItem.completed = true;
      this.completeItem(session.threadId, turn, turn.compactionItem);
      turn.compactionItem = undefined;
    }

    if (turn.agentItem) {
      this.completeItem(session.threadId, turn, turn.agentItem);
      turn.agentItem = undefined;
    }
    if (turn.reasoningItem) {
      this.completeItem(session.threadId, turn, turn.reasoningItem);
      turn.reasoningItem = undefined;
    }

    if (turn.latestUsage) {
      const usage = turn.latestUsage;
      const breakdown = {
        totalTokens: numberOrNull(usage.totalTokens) ?? 0,
        inputTokens: numberOrNull(usage.input) ?? 0,
        cachedInputTokens: numberOrNull(usage.cacheRead) ?? 0,
        cacheWriteInputTokens: numberOrNull(usage.cacheWrite) ?? 0,
        outputTokens: numberOrNull(usage.output) ?? 0,
        reasoningOutputTokens: 0,
      };
      notify("thread/tokenUsage/updated", {
        threadId: session.threadId,
        turnId: turn.id,
        tokenUsage: {
          total: breakdown,
          last: breakdown,
          modelContextWindow: session.state.model?.contextWindow ?? null,
        },
      });
    }

    // Native Codex keeps follow-up Queue in the renderer and submits it as a
    // fresh turn/start as soon as this completion notification arrives. Clear
    // the Prime in-flight guard first so that queued turn cannot race with the
    // tail of the previous turn.
    session.currentTurn = undefined;
    notify("thread/status/changed", {
      threadId: session.threadId,
      status: { type: "idle" },
    });
    const status = turn.interrupted
      ? "interrupted"
      : turn.failed
        ? "failed"
        : "completed";
    notify("turn/completed", {
      threadId: session.threadId,
      turn: this.codexTurn(turn, status),
    });
  }

  private codexTurn(
    turn: PrimeTurnContext,
    status: CodexTurn["status"],
  ): CodexTurn {
    const completed = status === "inProgress" ? null : Date.now();
    return {
      id: turn.id,
      items: status === "inProgress" ? [] : turn.items,
      itemsView: status === "inProgress" ? "notLoaded" : "summary",
      status,
      error:
        status === "failed" ? { message: "Prime Agent turn failed" } : null,
      startedAt: Math.floor(turn.startedAtMs / 1_000),
      completedAt: completed ? Math.floor(completed / 1_000) : null,
      durationMs: completed ? completed - turn.startedAtMs : null,
    };
  }

  private emitThreadSettings(session: PrimeCompatSession): void {
    const model = this.uiModel(session.state);
    const effort = reasoningFromState(session.state);
    notify("thread/settings/updated", {
      threadId: session.threadId,
      threadSettings: {
        cwd: session.cwd,
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "dangerFullAccess" },
        activePermissionProfile: null,
        model,
        modelProvider: "openai",
        serviceTier: "default",
        effort,
        summary: null,
        collaborationMode: {
          mode: "default",
          settings: {
            model,
            reasoning_effort: effort,
            developer_instructions: null,
          },
        },
        multiAgentMode: "explicitRequestOnly",
        personality: null,
      },
    });
  }

  private async requireSavedPrimeThread(
    threadId: string,
  ): Promise<PrimeSavedSession> {
    const sessionId = parsePrimeThreadId(threadId);
    if (!sessionId) throw new Error(`Not a Prime thread: ${threadId}`);
    const saved = await this.catalog.find(sessionId);
    if (!saved) throw new Error(`Prime Agent session not found: ${sessionId}`);
    return saved;
  }

  private uiModel(state: PrimeState): string {
    const model = modelFromState(state);
    return this.options.mode === "hybrid"
      ? `${PRIME_MODEL_PREFIX}${model}`
      : model;
  }
}
