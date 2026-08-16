import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

export type BrowserGuestFrame = {
  data: string;
  width: number;
  height: number;
};

export type BrowserGuestInput =
  | {
      kind: "pointer";
      phase: "down" | "move" | "up";
      x: number;
      y: number;
      button?: "left" | "middle" | "right";
      buttons?: number;
      clickCount?: number;
      modifiers?: number;
    }
  | {
      kind: "wheel";
      x: number;
      y: number;
      deltaX: number;
      deltaY: number;
      modifiers?: number;
    }
  | {
      kind: "key";
      phase: "down" | "up";
      key: string;
      code?: string;
      text?: string;
      modifiers?: number;
    }
  | {
      kind: "text";
      text: string;
    };

type CdpMessage = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
};

type PendingRequest = {
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type TargetInfo = {
  id: string;
  webSocketDebuggerUrl: string;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clampDimension(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.min(4096, Math.round(value)));
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveBrowserExecutable(): Promise<string> {
  const configured = process.env.PRIMECODEX_BROWSER_EXECUTABLE?.trim();
  if (configured) {
    if (!(await fileExists(configured))) {
      throw new Error(
        `PRIMECODEX_BROWSER_EXECUTABLE does not exist: ${configured}`,
      );
    }
    return configured;
  }

  const absoluteCandidates =
    process.platform === "darwin"
      ? [
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : process.platform === "win32"
        ? [
            path.join(
              process.env.PROGRAMFILES ?? "C:\\Program Files",
              "Microsoft",
              "Edge",
              "Application",
              "msedge.exe",
            ),
            path.join(
              process.env.PROGRAMFILES ?? "C:\\Program Files",
              "Google",
              "Chrome",
              "Application",
              "chrome.exe",
            ),
          ]
        : [];

  for (const candidate of absoluteCandidates) {
    if (await fileExists(candidate)) return candidate;
  }

  const pathCandidates = [
    "microsoft-edge",
    "microsoft-edge-stable",
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
  ];
  for (const candidate of pathCandidates) {
    const probe = spawnSync(
      process.platform === "win32" ? "where" : "which",
      [candidate],
      { encoding: "utf8" },
    );
    const resolved =
      probe.status === 0 ? probe.stdout.trim().split(/\r?\n/)[0] : "";
    if (resolved) return resolved;
  }

  throw new Error(
    "PrimeCodex Browser requires Microsoft Edge, Google Chrome, or Chromium. " +
      "Set PRIMECODEX_BROWSER_EXECUTABLE to the browser executable path.",
  );
}

class CdpConnection {
  private readonly socket: WebSocket;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly eventListeners = new Set<(message: CdpMessage) => void>();
  private nextId = 0;
  private closed = false;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (data) => this.handleMessage(String(data)));
    socket.on("close", () => this.handleClose(new Error("CDP socket closed")));
    socket.on("error", (error) => this.handleClose(error));
  }

  static async connect(url: string): Promise<CdpConnection> {
    const socket = new WebSocket(url, { perMessageDeflate: false });
    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        cleanup();
        resolve();
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const cleanup = (): void => {
        socket.off("open", onOpen);
        socket.off("error", onError);
      };
      socket.once("open", onOpen);
      socket.once("error", onError);
    });
    return new CdpConnection(socket);
  }

  onEvent(listener: (message: CdpMessage) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  async request(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 15_000,
  ): Promise<Record<string, unknown>> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error(`CDP socket is not open for ${method}`);
    }

    const id = ++this.nextId;
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for CDP ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return promise;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.close();
    this.handleClose(new Error("CDP connection closed"));
  }

  private handleMessage(source: string): void {
    let message: CdpMessage;
    try {
      message = JSON.parse(source) as CdpMessage;
    } catch {
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(
          new Error(
            `CDP request failed (${message.error.code ?? "unknown"}): ${message.error.message ?? "unknown error"}`,
          ),
        );
      } else {
        pending.resolve(record(message.result));
      }
      return;
    }

    for (const listener of this.eventListeners) {
      try {
        listener(message);
      } catch {
        // A frame/navigation listener must not break the CDP stream.
      }
    }
  }

  private handleClose(error: Error): void {
    if (!this.closed) this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

class CdpBrowserProcess {
  private static singleton: Promise<CdpBrowserProcess> | undefined;

  private constructor(
    readonly port: number,
    private readonly child: ChildProcess,
    private readonly userDataDir: string,
  ) {}

  static get(): Promise<CdpBrowserProcess> {
    CdpBrowserProcess.singleton ??= CdpBrowserProcess.launch().catch(
      (error) => {
        CdpBrowserProcess.singleton = undefined;
        throw error;
      },
    );
    return CdpBrowserProcess.singleton;
  }

  private static async launch(): Promise<CdpBrowserProcess> {
    const executable = await resolveBrowserExecutable();
    const userDataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "primecodex-browser-"),
    );
    const child = spawn(
      executable,
      [
        "--headless=new",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        `--user-data-dir=${userDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-sync",
        "--metrics-recording-only",
        "--mute-audio",
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    child.stderr?.on("data", (chunk) => {
      if (process.env.PRIMECODEX_DEBUG_BROWSER === "1") {
        process.stderr.write(`[primecodex-browser] ${String(chunk)}`);
      }
    });

    const activePortFile = path.join(userDataDir, "DevToolsActivePort");
    const deadline = Date.now() + 10_000;
    let port = 0;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(
          `Browser guest process exited before DevTools started (${child.exitCode})`,
        );
      }
      try {
        const [portLine] = (await fs.readFile(activePortFile, "utf8")).split(
          /\r?\n/,
        );
        const parsed = Number(portLine);
        if (Number.isInteger(parsed) && parsed > 0) {
          port = parsed;
          break;
        }
      } catch {
        // Chrome writes DevToolsActivePort once the debugger endpoint is ready.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    if (!port) {
      child.kill("SIGTERM");
      throw new Error("Timed out waiting for browser guest DevTools endpoint");
    }

    const instance = new CdpBrowserProcess(port, child, userDataDir);
    process.once("exit", () => instance.disposeSync());
    return instance;
  }

  async createTarget(): Promise<TargetInfo> {
    const response = await fetch(
      `http://127.0.0.1:${this.port}/json/new?${encodeURIComponent("about:blank")}`,
      { method: "PUT" },
    );
    if (!response.ok) {
      throw new Error(
        `Unable to create browser guest target: HTTP ${response.status}`,
      );
    }
    const target = (await response.json()) as Partial<TargetInfo>;
    if (!target.id || !target.webSocketDebuggerUrl) {
      throw new Error("Browser guest target did not return a DevTools socket");
    }
    return { id: target.id, webSocketDebuggerUrl: target.webSocketDebuggerUrl };
  }

  async closeTarget(targetId: string): Promise<void> {
    await fetch(`http://127.0.0.1:${this.port}/json/close/${targetId}`).catch(
      () => undefined,
    );
  }

  private disposeSync(): void {
    this.child.kill("SIGTERM");
    void fs.rm(this.userDataDir, { recursive: true, force: true });
  }
}

export class CdpCapturedImage {
  constructor(
    private readonly png: Buffer,
    private readonly width: number,
    private readonly height: number,
  ) {}

  getSize(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  isEmpty(): boolean {
    return this.png.length === 0;
  }

  toPNG(): Buffer {
    return this.png;
  }

  toBitmap(): Buffer {
    return this.png;
  }

  crop(_rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): CdpCapturedImage {
    // BrowserSidebar only uses crop for clipboard screenshots. The CDP capture
    // path already supports clipping when capturePage(rect) is called directly;
    // retaining the full image here is a safe fallback for native call sites
    // which crop an already captured NativeImage.
    return this;
  }
}

export type CdpBrowserGuestOptions = {
  onFrame?: (frame: BrowserGuestFrame) => void;
  onIpcInvoke?: (channel: string, args: unknown[]) => Promise<unknown>;
  onIpcSend?: (channel: string, args: unknown[]) => void;
  preloadPath?: string;
  width?: number;
  height?: number;
};

export class CdpBrowserGuest extends EventEmitter {
  private static nextGuestId = 50_000;

  readonly id = CdpBrowserGuest.nextGuestId++;
  hostWebContents: unknown = null;
  readonly mainFrame = { url: "about:blank" };
  readonly navigationHistory = {
    getActiveIndex: (): number => this.navigationIndex,
    getEntryAtIndex: (index: number): Record<string, unknown> | null =>
      this.navigationEntries[index] ?? null,
    getAllEntries: (): Array<Record<string, unknown>> => {
      if (
        this.navigationEntries.length === 1 &&
        this.navigationEntries[0]?.url === "about:blank"
      ) {
        // Electron has a special path for replacing its initial about:blank
        // navigation entry. CDP targets do not need that optimization; exposing
        // an empty history makes the native BrowserSidebar call loadURL(), which
        // maps cleanly to Page.navigate.
        return [];
      }
      return this.navigationEntries.map((entry) => ({ ...entry }));
    },
    restore: async (snapshot: {
      entries?: Array<Record<string, unknown>>;
      index?: number;
    }): Promise<void> => {
      const entries = Array.isArray(snapshot?.entries) ? snapshot.entries : [];
      const index =
        typeof snapshot?.index === "number" && Number.isInteger(snapshot.index)
          ? snapshot.index
          : entries.length - 1;
      const target = entries[index];
      const url = target && typeof target.url === "string" ? target.url : "";
      if (url) await this.loadURL(url);
    },
  };
  viewInstanceId = 0;
  session: unknown;
  readonly debugger: {
    attach: (_protocolVersion?: string) => void;
    detach: () => void;
    isAttached: () => boolean;
    sendCommand: (
      method: string,
      params?: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
  };

  private connection: CdpConnection | undefined;
  private targetId: string | undefined;
  private destroyed = false;
  private loading = false;
  private canGoBackValue = false;
  private canGoForwardValue = false;
  private navigationIndex = -1;
  private navigationEntries: Array<Record<string, unknown>> = [];
  private debuggerAttached = false;
  private title = "";
  private width: number;
  private height: number;
  private readonly onFrame?: (frame: BrowserGuestFrame) => void;
  private readonly onIpcInvoke?: (
    channel: string,
    args: unknown[],
  ) => Promise<unknown>;
  private readonly onIpcSend?: (channel: string, args: unknown[]) => void;
  private readonly preloadPath?: string;
  private pageRuntimeReady = false;
  private captureFrameInFlight = false;
  private captureFrameQueued = false;
  private readonly pendingHostMessages: Array<{
    channel: string;
    args: unknown[];
  }> = [];
  private removeCdpListener?: () => void;
  private windowOpenHandler?: (details: Record<string, unknown>) => unknown;
  private frameSnapshotTimer?: ReturnType<typeof setTimeout>;
  private frameSnapshotInFlight = false;

  constructor(options: CdpBrowserGuestOptions = {}) {
    super();
    this.width = clampDimension(options.width ?? 1280, 1280);
    this.height = clampDimension(options.height ?? 720, 720);
    this.onFrame = options.onFrame;
    this.onIpcInvoke = options.onIpcInvoke;
    this.onIpcSend = options.onIpcSend;
    this.preloadPath = options.preloadPath;
    this.debugger = {
      attach: () => {
        this.debuggerAttached = true;
      },
      detach: () => {
        this.debuggerAttached = false;
      },
      isAttached: () => this.debuggerAttached,
      sendCommand: async (method, params = {}) =>
        this.requireConnection().request(method, params),
    };
  }

  async start(): Promise<void> {
    if (this.connection) return;
    const browser = await CdpBrowserProcess.get();
    const target = await browser.createTarget();
    this.targetId = target.id;
    const connection = await CdpConnection.connect(target.webSocketDebuggerUrl);
    this.connection = connection;
    this.removeCdpListener = connection.onEvent((message) =>
      this.handleCdpEvent(message),
    );

    await Promise.all([
      connection.request("Page.enable"),
      connection.request("Runtime.enable"),
      connection.request("Network.enable"),
    ]);
    await this.installBrowserPageRuntime();
    await this.setViewport(this.width, this.height);
    await this.refreshNavigationHistory().catch(() => undefined);
    await connection
      .request("Page.startScreencast", {
        format: "jpeg",
        quality: 78,
        maxWidth: this.width,
        maxHeight: this.height,
        everyNthFrame: 1,
      })
      .catch(() => undefined);
  }

  getURL(): string {
    return this.mainFrame.url;
  }

  getTitle(): string {
    return this.title;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isLoading(): boolean {
    return this.loading;
  }

  isLoadingMainFrame(): boolean {
    return this.loading;
  }

  isAudioMuted(): boolean {
    return true;
  }

  isAudible(): boolean {
    return false;
  }

  isCurrentlyAudible(): boolean {
    return false;
  }

  isCapturingUserMedia(): boolean {
    return false;
  }

  isBeingCaptured(): boolean {
    return false;
  }

  isTabCaptureActive(): boolean {
    return false;
  }

  setBackgroundThrottling(_enabled: boolean): void {}

  getOSProcessId(): number {
    return 0;
  }

  setAudioMuted(_muted: boolean): void {}

  setWindowOpenHandler(
    handler: (details: Record<string, unknown>) => unknown,
  ): void {
    this.windowOpenHandler = handler;
  }

  async loadURL(url: string): Promise<void> {
    if (this.destroyed) return;
    const navigationEvent = {
      isMainFrame: true,
      url,
      defaultPrevented: false,
      preventDefault(): void {
        this.defaultPrevented = true;
      },
    };
    this.emit("will-frame-navigate", navigationEvent, url);
    this.emit("will-navigate", navigationEvent, url);
    if (navigationEvent.defaultPrevented) return;

    this.loading = true;
    this.emit("did-start-loading");
    this.emit("did-start-navigation", {}, url, false, true);
    const result = await this.requireConnection().request("Page.navigate", {
      url,
    });
    if (typeof result.errorText === "string" && result.errorText) {
      this.loading = false;
      this.emit("did-fail-load", {}, -2, result.errorText, url, true);
      this.emit("did-stop-loading");
      throw new Error(`Browser navigation failed: ${result.errorText}`);
    }
  }

  stop(): void {
    void this.connection?.request("Page.stopLoading").catch(() => undefined);
  }

  reload(): void {
    void this.connection?.request("Page.reload", { ignoreCache: false });
  }

  reloadIgnoringCache(): void {
    void this.connection?.request("Page.reload", { ignoreCache: true });
  }

  canGoBack(): boolean {
    return this.canGoBackValue;
  }

  canGoForward(): boolean {
    return this.canGoForwardValue;
  }

  goBack(): void {
    void this.navigateHistory(-1);
  }

  goForward(): void {
    void this.navigateHistory(1);
  }

  async executeJavaScript(source: string): Promise<unknown> {
    const result = await this.requireConnection().request("Runtime.evaluate", {
      expression: source,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    const exception = record(result.exceptionDetails);
    if (Object.keys(exception).length > 0) {
      throw new Error(
        String(
          record(exception.exception).description ??
            exception.text ??
            "Browser executeJavaScript failed",
        ),
      );
    }
    return record(result.result).value;
  }

  async capturePage(rect?: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): Promise<CdpCapturedImage> {
    const metrics = await this.requireConnection().request(
      "Page.getLayoutMetrics",
    );
    const viewport = record(metrics.cssVisualViewport);
    const width = clampDimension(
      rect?.width ?? finite(viewport.clientWidth, this.width),
      this.width,
    );
    const height = clampDimension(
      rect?.height ?? finite(viewport.clientHeight, this.height),
      this.height,
    );
    const params: Record<string, unknown> = {
      format: "png",
      captureBeyondViewport: false,
      fromSurface: true,
    };
    if (rect) {
      params.clip = {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        scale: 1,
      };
    }
    const result = await this.requireConnection().request(
      "Page.captureScreenshot",
      params,
    );
    return new CdpCapturedImage(
      Buffer.from(String(result.data ?? ""), "base64"),
      width,
      height,
    );
  }

  async setViewport(width: number, height: number): Promise<void> {
    this.width = clampDimension(width, this.width);
    this.height = clampDimension(height, this.height);
    if (!this.connection) return;
    await this.connection.request("Emulation.setDeviceMetricsOverride", {
      width: this.width,
      height: this.height,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: this.width,
      screenHeight: this.height,
    });
    if (this.mainFrame.url !== "about:blank" && !this.loading) {
      this.scheduleFrameSnapshot();
    }
  }

  async dispatchInput(input: BrowserGuestInput): Promise<void> {
    const connection = this.requireConnection();
    if (input.kind === "pointer") {
      await connection.request("Input.dispatchMouseEvent", {
        type:
          input.phase === "down"
            ? "mousePressed"
            : input.phase === "up"
              ? "mouseReleased"
              : "mouseMoved",
        x: input.x,
        y: input.y,
        button: input.phase === "move" ? "none" : (input.button ?? "left"),
        buttons: input.buttons ?? 0,
        clickCount: input.clickCount ?? 1,
        modifiers: input.modifiers ?? 0,
      });
      this.scheduleFrameSnapshot(input.phase === "move" ? 40 : 0);
      return;
    }

    if (input.kind === "wheel") {
      await connection.request("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: input.x,
        y: input.y,
        deltaX: input.deltaX,
        deltaY: input.deltaY,
        modifiers: input.modifiers ?? 0,
      });
      this.scheduleFrameSnapshot(40);
      return;
    }

    if (input.kind === "text") {
      await connection.request("Input.insertText", { text: input.text });
      this.scheduleFrameSnapshot();
      return;
    }

    await connection.request("Input.dispatchKeyEvent", {
      type: input.phase === "down" ? "keyDown" : "keyUp",
      key: input.key,
      code: input.code ?? "",
      text: input.phase === "down" ? (input.text ?? "") : "",
      unmodifiedText: input.phase === "down" ? (input.text ?? "") : "",
      modifiers: input.modifiers ?? 0,
    });
    this.scheduleFrameSnapshot();
  }

  sendInputEvent(event: Record<string, unknown>): void {
    const type = String(event.type ?? "");
    const modifiers = Array.isArray(event.modifiers)
      ? event.modifiers.reduce((bits, modifier) => {
          if (modifier === "alt") return bits | 1;
          if (modifier === "control") return bits | 2;
          if (modifier === "meta" || modifier === "command") return bits | 4;
          if (modifier === "shift") return bits | 8;
          return bits;
        }, 0)
      : 0;
    if (type === "keyDown" || type === "keyUp") {
      void this.dispatchInput({
        kind: "key",
        phase: type === "keyDown" ? "down" : "up",
        key: String(event.keyCode ?? event.key ?? ""),
        modifiers,
      }).catch(() => undefined);
    }
  }

  setZoomFactor(factor: number): void {
    if (!Number.isFinite(factor) || factor <= 0) return;
    void this.connection
      ?.request("Emulation.setPageScaleFactor", { pageScaleFactor: factor })
      .catch(() => undefined);
  }

  findInPage(text: string): number {
    void this.connection
      ?.request("Runtime.evaluate", {
        expression: `window.find(${JSON.stringify(text)})`,
        returnByValue: true,
      })
      .catch(() => undefined);
    return Date.now() & 0x7fffffff;
  }

  stopFindInPage(_action?: string): void {}

  print(): void {
    void this.connection
      ?.request("Page.printToPDF", { transferMode: "ReturnAsBase64" })
      .catch(() => undefined);
  }

  focus(): void {
    this.emit("focus");
    this.scheduleFrameSnapshot();
  }

  blur(): void {
    this.emit("blur");
  }

  send(channel: string, ...args: unknown[]): void {
    if (process.env.PRIMECODEX_DEBUG_BROWSER === "1") {
      const first = record(args[0]);
      console.error(
        `[primecodex-browser] host->guest ${channel}${typeof first.type === "string" ? ` ${first.type}` : ""}`,
      );
    }
    if (!this.connection || !this.pageRuntimeReady) {
      this.pendingHostMessages.push({ channel, args });
      return;
    }
    void this.emitPageIpc(channel, args);
  }

  inspectElement(_x: number, _y: number): void {}

  async close(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.loading = false;
    if (this.frameSnapshotTimer) clearTimeout(this.frameSnapshotTimer);
    this.frameSnapshotTimer = undefined;
    this.removeCdpListener?.();
    this.removeCdpListener = undefined;
    this.connection?.close();
    this.connection = undefined;
    const targetId = this.targetId;
    this.targetId = undefined;
    if (targetId) {
      const browser = await CdpBrowserProcess.get().catch(() => undefined);
      await browser?.closeTarget(targetId);
    }
    this.emit("destroyed");
    this.removeAllListeners();
  }

  destroy(): void {
    void this.close();
  }

  private async installBrowserPageRuntime(): Promise<void> {
    if (!this.preloadPath) {
      if (process.env.PRIMECODEX_DEBUG_BROWSER === "1") {
        console.error(
          "[primecodex-browser] native browser preload path missing",
        );
      }
      return;
    }
    if (process.env.PRIMECODEX_DEBUG_BROWSER === "1") {
      console.error(
        `[primecodex-browser] native browser preload ${this.preloadPath}`,
      );
    }
    const connection = this.requireConnection();
    let preloadSource: string;
    try {
      preloadSource = await fs.readFile(this.preloadPath, "utf8");
    } catch (error) {
      console.warn(
        `[primecodex-browser] failed to read native browser preload ${this.preloadPath}:`,
        error,
      );
      return;
    }

    const requirePattern = /require\(["']electron["']\)/;
    if (!requirePattern.test(preloadSource)) {
      console.warn(
        `[primecodex-browser] native browser preload no longer imports Electron in the expected form`,
      );
      return;
    }
    preloadSource = preloadSource.replace(
      requirePattern,
      "globalThis.__PRIMECODEX_BROWSER_ELECTRON__",
    );

    await connection.request("Runtime.addBinding", {
      name: "__primecodexBrowserIpc",
    });

    const shim = String.raw`
(() => {
  if (globalThis.__PRIMECODEX_BROWSER_ELECTRON__) return;
  const listeners = new Map();
  const pending = new Map();
  let nextId = 1;
  const emit = (channel, args) => {
    for (const listener of [...(listeners.get(channel) || [])]) {
      try { listener({}, ...(args || [])); } catch (error) { console.error(error); }
    }
  };
  globalThis.__primecodexBrowserIpcEmit = emit;
  globalThis.__primecodexBrowserIpcResolve = (id, ok, json) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    let value = null;
    try { value = json == null ? null : JSON.parse(json); } catch {}
    if (ok) entry.resolve(value);
    else entry.reject(new Error(typeof value === 'string' ? value : 'Browser IPC failed'));
  };
  const dispatch = (kind, channel, args, id) => {
    globalThis.__primecodexBrowserIpc(JSON.stringify({ kind, channel, args, id }));
  };
  const ipcRenderer = {
    on(channel, listener) {
      const set = listeners.get(channel) || new Set();
      set.add(listener); listeners.set(channel, set); return this;
    },
    once(channel, listener) {
      const wrapped = (...args) => { this.removeListener(channel, wrapped); listener(...args); };
      return this.on(channel, wrapped);
    },
    off(channel, listener) { return this.removeListener(channel, listener); },
    removeListener(channel, listener) {
      const set = listeners.get(channel); set?.delete(listener); if (set?.size === 0) listeners.delete(channel); return this;
    },
    invoke(channel, ...args) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        dispatch('invoke', channel, args, id);
      });
    },
    send(channel, ...args) { dispatch('send', channel, args); },
    sendSync(channel) {
      if (channel === 'codex_desktop:get-browser-webmcp-enabled') return false;
      return undefined;
    },
  };
  globalThis.__PRIMECODEX_BROWSER_ELECTRON__ = {
    ipcRenderer,
    contextBridge: {
      internalContextBridge: null,
      exposeInMainWorld(name, value) { globalThis[name] = value; },
      executeInMainWorld({ func, args = [] }) { return func(...args); },
    },
    webFrame: { setVisualZoomLevelLimits() {} },
  };
})();
`;
    const bootSource = `${shim}
${preloadSource}
//# sourceURL=primecodex-native-browser-page-preload.js`;
    await connection.request("Page.addScriptToEvaluateOnNewDocument", {
      source: bootSource,
    });
    await connection
      .request("Runtime.evaluate", { expression: bootSource })
      .catch((error) =>
        console.warn(
          "[primecodex-browser] failed to initialize native page runtime",
          error,
        ),
      );
    this.pageRuntimeReady = true;
    await this.flushHostMessages();
  }

  private async handlePageIpc(payload: string): Promise<void> {
    let message: {
      kind?: string;
      channel?: string;
      args?: unknown[];
      id?: number;
    };
    try {
      message = JSON.parse(payload) as typeof message;
    } catch {
      return;
    }
    const channel = typeof message.channel === "string" ? message.channel : "";
    const args = Array.isArray(message.args) ? message.args : [];
    if (!channel) return;
    if (process.env.PRIMECODEX_DEBUG_BROWSER === "1") {
      let argsJson = "[]";
      try {
        argsJson = JSON.stringify(args);
      } catch {
        argsJson = "[unserializable]";
      }
      console.error(
        `[primecodex-browser] guest->host ${message.kind ?? "unknown"} ${channel} ${argsJson}`,
      );
    }
    if (message.kind === "send") {
      this.onIpcSend?.(channel, args);
      return;
    }
    if (message.kind !== "invoke" || typeof message.id !== "number") return;
    try {
      const result = this.onIpcInvoke
        ? await this.onIpcInvoke(channel, args)
        : null;
      await this.resolvePageIpc(message.id, true, result ?? null);
    } catch (error) {
      await this.resolvePageIpc(
        message.id,
        false,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async resolvePageIpc(
    id: number,
    ok: boolean,
    value: unknown,
  ): Promise<void> {
    if (!this.connection || this.destroyed) return;
    let json: string;
    try {
      json = JSON.stringify(value);
    } catch {
      json = JSON.stringify(null);
    }
    await this.connection
      .request("Runtime.evaluate", {
        expression: `globalThis.__primecodexBrowserIpcResolve?.(${id},${ok ? "true" : "false"},${JSON.stringify(json)})`,
      })
      .catch(() => undefined);
  }

  private async emitPageIpc(channel: string, args: unknown[]): Promise<void> {
    if (!this.connection || this.destroyed) return;
    let json: string;
    try {
      json = JSON.stringify(args);
    } catch {
      json = "[]";
    }
    await this.connection
      .request("Runtime.evaluate", {
        expression: `globalThis.__primecodexBrowserIpcEmit?.(${JSON.stringify(channel)},JSON.parse(${JSON.stringify(json)}))`,
      })
      .catch(() => undefined);
  }

  private async flushHostMessages(): Promise<void> {
    const messages = this.pendingHostMessages.splice(0);
    for (const message of messages) {
      await this.emitPageIpc(message.channel, message.args);
    }
  }

  private requireConnection(): CdpConnection {
    if (!this.connection || this.destroyed) {
      throw new Error("Browser guest is not attached");
    }
    return this.connection;
  }

  private async fetchNavigationHistory(): Promise<{
    currentIndex: number;
    entries: Array<Record<string, unknown>>;
  }> {
    const result = await this.requireConnection().request(
      "Page.getNavigationHistory",
    );
    return {
      currentIndex: finite(result.currentIndex, -1),
      entries: Array.isArray(result.entries) ? result.entries.map(record) : [],
    };
  }

  private async refreshNavigationHistory(): Promise<void> {
    const { currentIndex, entries } = await this.fetchNavigationHistory();
    this.navigationIndex = currentIndex;
    this.navigationEntries = entries;
    this.canGoBackValue = currentIndex > 0 && entries.length > 1;
    this.canGoForwardValue =
      currentIndex >= 0 && currentIndex < entries.length - 1;
  }

  private async navigateHistory(delta: number): Promise<void> {
    const { currentIndex, entries } = await this.fetchNavigationHistory();
    const target = entries[currentIndex + delta];
    const entryId = target?.id;
    if (typeof entryId === "number") {
      await this.requireConnection().request("Page.navigateToHistoryEntry", {
        entryId,
      });
    }
  }

  private handleCdpEvent(message: CdpMessage): void {
    const method = message.method;
    const params = record(message.params);
    if (!method) return;

    if (method === "Runtime.bindingCalled") {
      if (
        params.name === "__primecodexBrowserIpc" &&
        typeof params.payload === "string"
      ) {
        void this.handlePageIpc(params.payload);
      }
      return;
    }

    if (method === "Page.screencastFrame") {
      const sessionId = params.sessionId;
      const metadata = record(params.metadata);
      const width = clampDimension(
        finite(metadata.deviceWidth, this.width),
        this.width,
      );
      const height = clampDimension(
        finite(metadata.deviceHeight, this.height),
        this.height,
      );
      const data = typeof params.data === "string" ? params.data : "";
      if (data && this.onFrame) {
        this.onFrame({ data, width, height });
      }
      if (typeof sessionId === "number") {
        void this.connection
          ?.request("Page.screencastFrameAck", { sessionId })
          .catch(() => undefined);
      }
      return;
    }

    if (method === "Page.frameStartedLoading") {
      this.loading = true;
      this.emit("did-start-loading");
      return;
    }

    if (method === "Page.frameNavigated") {
      const frame = record(params.frame);
      if (frame.parentId) return;
      const url =
        typeof frame.url === "string" ? frame.url : this.mainFrame.url;
      this.mainFrame.url = url;
      this.emit("did-navigate", {}, url, 200, "OK");
      void this.refreshNavigationHistory();
      void this.refreshTitle();
      return;
    }

    if (method === "Page.navigatedWithinDocument") {
      const url =
        typeof params.url === "string" ? params.url : this.mainFrame.url;
      this.mainFrame.url = url;
      this.emit("did-navigate-in-page", {}, url, true, 0, 0);
      void this.refreshNavigationHistory();
      void this.refreshTitle();
      return;
    }

    if (method === "Page.domContentEventFired") {
      this.emit("dom-ready");
      return;
    }

    if (method === "Page.loadEventFired") {
      this.loading = false;
      this.emit("did-finish-load");
      this.emit("did-stop-loading");
      void this.refreshTitle();
      this.scheduleFrameSnapshot();
      return;
    }

    if (method === "Page.frameStoppedLoading") {
      this.loading = false;
      this.emit("did-stop-loading");
      this.scheduleFrameSnapshot();
      return;
    }

    if (method === "Page.javascriptDialogOpening") {
      void this.connection
        ?.request("Page.handleJavaScriptDialog", { accept: false })
        .catch(() => undefined);
    }
  }

  private scheduleFrameSnapshot(delayMs = 0): void {
    if (this.destroyed || !this.connection || !this.onFrame) return;
    if (this.frameSnapshotTimer) clearTimeout(this.frameSnapshotTimer);
    this.frameSnapshotTimer = setTimeout(
      () => {
        this.frameSnapshotTimer = undefined;
        void this.emitFrameSnapshot();
      },
      Math.max(0, delayMs),
    );
  }

  private async emitFrameSnapshot(): Promise<void> {
    if (this.destroyed || !this.connection || !this.onFrame) return;
    if (this.frameSnapshotInFlight) {
      this.scheduleFrameSnapshot(30);
      return;
    }

    this.frameSnapshotInFlight = true;
    try {
      const result = await this.connection.request("Page.captureScreenshot", {
        format: "jpeg",
        quality: 78,
        captureBeyondViewport: false,
        fromSurface: true,
      });
      const data = typeof result.data === "string" ? result.data : "";
      if (data) {
        this.onFrame({ data, width: this.width, height: this.height });
      }
    } catch (error) {
      if (process.env.PRIMECODEX_DEBUG_BROWSER === "1") {
        console.error(
          "[primecodex-browser] fallback frame capture failed",
          error,
        );
      }
    } finally {
      this.frameSnapshotInFlight = false;
    }
  }

  private async refreshTitle(): Promise<void> {
    try {
      const value = await this.executeJavaScript("document.title");
      const title = typeof value === "string" ? value : "";
      if (title !== this.title) {
        this.title = title;
        this.emit("page-title-updated", {}, title, true);
      }
    } catch {
      // Cross-document transitions may invalidate the execution context briefly.
    }
  }
}
