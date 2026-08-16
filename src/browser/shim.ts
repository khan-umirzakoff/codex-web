import {
  mapBrowserPathToInitialRoute,
  mapMemoryPathToBrowserPath,
} from "./routes";
import {
  handleLocalFilePickerMessage,
  isLocalFilePickerMessage,
} from "./files";
import {
  openSelectWorkspaceRootDialog,
  type WorkspaceDirectoryEntries,
} from "./workspace-root-dialog";
import {
  BrowserGuestDomBridge,
  type BrowserGuestInput,
  type BrowserGuestMainMessage,
} from "./browser-guest";

type IpcListener = (event: unknown, ...args: unknown[]) => void;

type RendererToMainMessage =
  | {
      type: "ipc-renderer-invoke";
      requestId: string;
      channel: string;
      args: unknown[];
    }
  | {
      type: "ipc-renderer-post-message";
      channel: string;
      message: unknown;
      portIds: string[];
    }
  | {
      type: "message-port-message";
      portId: string;
      data: unknown;
    }
  | {
      type: "message-port-close";
      portId: string;
    }
  | {
      type: "ipc-renderer-send";
      channel: string;
      args: unknown[];
    }
  | {
      type: "workspace-directory-entries-request";
      requestId: string;
      directoryPath: string | null;
      directoriesOnly: boolean;
    }
  | {
      type: "browser-webview-attach";
      attachmentId: string;
      attributes: Record<string, string>;
      width: number;
      height: number;
    }
  | {
      type: "browser-webview-detach";
      guestId: number;
    }
  | {
      type: "browser-webview-resize";
      guestId: number;
      width: number;
      height: number;
    }
  | {
      type: "browser-webview-input";
      guestId: number;
      input: BrowserGuestInput;
    };

type MainToRendererMessage =
  | {
      type: "ipc-main-event";
      channel: string;
      args: unknown[];
    }
  | {
      type: "ipc-renderer-invoke-result";
      requestId: string;
      ok: true;
      result: unknown;
    }
  | {
      type: "ipc-renderer-invoke-result";
      requestId: string;
      ok: false;
      errorMessage: string;
    }
  | {
      type: "workspace-directory-entries-result";
      requestId: string;
      ok: true;
      result: WorkspaceDirectoryEntries;
    }
  | {
      type: "workspace-directory-entries-result";
      requestId: string;
      ok: false;
      errorMessage: string;
    }
  | {
      type: "message-port-message";
      portId: string;
      data: unknown;
    }
  | {
      type: "message-port-close";
      portId: string;
    }
  | {
      type: "browser-webview-attached";
      attachmentId: string;
      guestId: number;
    }
  | {
      type: "browser-webview-frame";
      guestId: number;
      data: string;
      width: number;
      height: number;
    }
  | {
      type: "browser-webview-error";
      attachmentId: string;
      errorMessage: string;
    }
  | {
      type: "browser-webview-closed";
      guestId: number;
    };

const RECONNECT_DELAY_MS = 1_000;

type MemoryNavigationChange = {
  action: "POP" | "PUSH" | "REPLACE";
  delta: number;
  location: {
    hash: string;
    key: string;
    pathname: string;
    search: string;
    state: unknown;
  };
};

type StatsigGateEvaluation = {
  name: string;
  value: boolean;
  [key: string]: unknown;
};

type ElectronShimState = {
  initialRoute?: string;
  initialSidebarState?: boolean;
  closeSidebar?: () => void;
  onMemoryNavigationChanged?: (navigation: MemoryNavigationChange) => void;
  overrideAdapter?: {
    getGateOverride?: (
      evaluation: StatsigGateEvaluation,
      ...args: unknown[]
    ) => StatsigGateEvaluation | null;
  };
};

declare global {
  interface Window {
    __ELECTRON_SHIM__?: ElectronShimState;
    __PRIMECODEX_SHARED_OBJECT_SNAPSHOT__?: Record<string, unknown>;
  }
}

declare const __CODEX_APP_VERSION__: string;

let requestCounter = 0;
let socket: WebSocket | null = null;
let reconnectTimeoutId: number | null = null;
let hasOpenedSocket = false;
const outboundQueue: RendererToMainMessage[] = [];
const pendingInvokes = new Map<
  string,
  {
    reject: (reason?: unknown) => void;
    resolve: (value: unknown) => void;
  }
>();
const pendingDirectoryEntries = new Map<
  string,
  {
    reject: (reason?: unknown) => void;
    resolve: (value: WorkspaceDirectoryEntries) => void;
  }
>();
const rendererListeners = new Map<string, Set<IpcListener>>();
const messagePorts = new Map<string, MessagePort>();
const browserGuestBridge = new BrowserGuestDomBridge((message) =>
  enqueueMessage(message),
);

function unimplemented(method: string): never {
  debugger;
  throw new Error(`[electron-stub] ${method} is not implemented`);
}

export function emitRendererEvent(channel: string, args: unknown[]): void {
  const listeners = rendererListeners.get(channel);
  if (!listeners || listeners.size === 0) {
    return;
  }
  const event = { sender: null };
  for (const listener of listeners) {
    listener(event, ...args);
  }
}

function handleIncomingMessage(message: MainToRendererMessage): void {
  if (
    message.type === "browser-webview-attached" ||
    message.type === "browser-webview-frame" ||
    message.type === "browser-webview-error" ||
    message.type === "browser-webview-closed"
  ) {
    browserGuestBridge.handleMessage(message as BrowserGuestMainMessage);
    return;
  }

  if (message.type === "ipc-main-event") {
    emitRendererEvent(message.channel, message.args);
    return;
  }

  if (message.type === "ipc-renderer-invoke-result") {
    const pending = pendingInvokes.get(message.requestId);
    if (!pending) {
      return;
    }
    pendingInvokes.delete(message.requestId);
    if (message.ok) {
      pending.resolve(message.result);
      return;
    }
    pending.reject(new Error(message.errorMessage));
    return;
  }

  if (message.type === "message-port-message") {
    messagePorts.get(message.portId)?.postMessage(message.data);
    return;
  }

  if (message.type === "message-port-close") {
    const port = messagePorts.get(message.portId);
    messagePorts.delete(message.portId);
    port?.close();
    return;
  }

  if (message.type === "workspace-directory-entries-result") {
    const pending = pendingDirectoryEntries.get(message.requestId);
    if (!pending) {
      return;
    }
    pendingDirectoryEntries.delete(message.requestId);
    if (message.ok) {
      pending.resolve(message.result);
      return;
    }
    pending.reject(new Error(message.errorMessage));
  }
}

function flushOutboundQueue(): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  for (const message of outboundQueue.splice(0)) {
    socket.send(JSON.stringify(message));
  }
}

function scheduleReconnect(): void {
  if (reconnectTimeoutId !== null) {
    return;
  }
  reconnectTimeoutId = window.setTimeout(() => {
    reconnectTimeoutId = null;
    ensureSocket();
  }, RECONNECT_DELAY_MS);
}

function ensureSocket(): void {
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  socket = new WebSocket(
    `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/__backend/ipc`,
  );
  socket.addEventListener("open", () => {
    const reconnect = hasOpenedSocket;
    hasOpenedSocket = true;
    if (reconnect) browserGuestBridge.socketOpened();
    flushOutboundQueue();
  });
  socket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(String(event.data)) as MainToRendererMessage;
      handleIncomingMessage(message);
    } catch (error) {
      console.error(
        "[electron-stub] failed to parse IPC bridge message",
        error,
      );
    }
  });
  socket.addEventListener("close", () => {
    for (const port of messagePorts.values()) {
      port.close();
    }
    messagePorts.clear();
    scheduleReconnect();
  });
  socket.addEventListener("error", () => {
    scheduleReconnect();
  });
}

function enqueueMessage(message: RendererToMainMessage): void {
  outboundQueue.push(message);
  ensureSocket();
  flushOutboundQueue();
}

function nextRequestId(): string {
  requestCounter += 1;
  return `ipc_bridge_${requestCounter}`;
}

function invokeMain(channel: string, args: unknown[]): Promise<unknown> {
  const requestId = nextRequestId();
  return new Promise((resolve, reject) => {
    pendingInvokes.set(requestId, { resolve, reject });
    enqueueMessage({
      type: "ipc-renderer-invoke",
      requestId,
      channel,
      args,
    });
  });
}

function addIpcListener(channel: string, listener: IpcListener): void {
  const listeners = rendererListeners.get(channel) ?? new Set<IpcListener>();
  listeners.add(listener);
  rendererListeners.set(channel, listeners);
}

function shouldCloseSidebarForMemoryPath(path: string): boolean {
  return (
    path === "/" ||
    path.startsWith("/local/") ||
    path === "/skills" ||
    path === "/automations"
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeBrowserSidebarSyncMessage(value: unknown): unknown {
  if (!isRecord(value) || value.type !== "browser-sidebar-sync") return value;
  if (!isRecord(value.payload)) return value;

  const payload = value.payload;
  if (
    payload.hostKind !== "right-panel" ||
    typeof payload.conversationId !== "string" ||
    typeof payload.browserTabId !== "string" ||
    !isRecord(payload.bounds)
  ) {
    return value;
  }

  const bounds = payload.bounds;
  if (
    typeof bounds.x !== "number" ||
    typeof bounds.y !== "number" ||
    typeof bounds.width !== "number" ||
    typeof bounds.height !== "number"
  ) {
    return value;
  }

  const rawX = bounds.x;
  const rawY = bounds.y;
  const rawWidth = bounds.width;
  const rawHeight = bounds.height;
  let nextX = rawX;
  let nextY = rawY;
  let nextWidth = rawWidth;
  let nextHeight = rawHeight;

  const parkedOutsideViewport =
    rawWidth > 1 &&
    (rawX >= window.innerWidth - 2 || rawX + rawWidth > window.innerWidth + 2);
  if (parkedOutsideViewport) {
    // Native Desktop parks the right panel immediately outside the renderer
    // viewport and expands the Electron BrowserWindow around it. The web shell
    // cannot expand its browser viewport, so mirror the CSS compatibility
    // transform before BrowserSidebarManager computes comment popup geometry.
    nextX = Math.max(0, rawX - rawWidth);
  } else {
    const webview = [
      ...document.querySelectorAll<HTMLElement>(
        "webview[data-browser-sidebar-conversation-id][data-browser-sidebar-browser-tab-id]",
      ),
    ].find(
      (candidate) =>
        candidate.getAttribute("data-browser-sidebar-conversation-id") ===
          payload.conversationId &&
        candidate.getAttribute("data-browser-sidebar-browser-tab-id") ===
          payload.browserTabId,
    );
    const rect = webview?.getBoundingClientRect();
    if (
      rect &&
      rect.width > 1 &&
      rect.height > 1 &&
      rect.left >= -2 &&
      rect.left < window.innerWidth - 2 &&
      rect.right <= window.innerWidth + 2
    ) {
      nextX = rect.x;
      nextY = rect.y;
      nextWidth = rect.width;
      nextHeight = rect.height;
    }
  }

  if (
    Math.abs(rawX - nextX) < 0.5 &&
    Math.abs(rawY - nextY) < 0.5 &&
    Math.abs(rawWidth - nextWidth) < 0.5 &&
    Math.abs(rawHeight - nextHeight) < 0.5
  ) {
    return value;
  }

  return {
    ...value,
    payload: {
      ...payload,
      bounds: {
        ...bounds,
        x: nextX,
        y: nextY,
        width: nextWidth,
        height: nextHeight,
      },
    },
  };
}

function isUnhandledAddWorkspaceRootOptionMessage(value: unknown): value is {
  root?: unknown;
  type: "electron-add-new-workspace-root-option";
} {
  return (
    isRecord(value) &&
    value.type === "electron-add-new-workspace-root-option" &&
    typeof value.root !== "string"
  );
}

function rememberBrowserSidebarNavigation(value: unknown): void {
  if (
    !isRecord(value) ||
    value.type !== "browser-sidebar-command" ||
    typeof value.conversationId !== "string" ||
    typeof value.browserTabId !== "string" ||
    !isRecord(value.command) ||
    value.command.type !== "navigate" ||
    typeof value.command.url !== "string" ||
    !value.command.url
  ) {
    return;
  }

  browserGuestBridge.rememberNavigation(
    value.conversationId,
    value.browserTabId,
    value.command.url,
  );
}

function isOpenInBrowserMessage(value: unknown): value is {
  type: "open-in-browser";
  url: string;
} {
  return (
    isRecord(value) &&
    value.type === "open-in-browser" &&
    typeof value.url === "string"
  );
}

function requestWorkspaceDirectoryEntries(
  directoryPath: string | null,
): Promise<WorkspaceDirectoryEntries> {
  const requestId = nextRequestId();
  return new Promise((resolve, reject) => {
    pendingDirectoryEntries.set(requestId, { resolve, reject });
    enqueueMessage({
      type: "workspace-directory-entries-request",
      requestId,
      directoryPath,
      directoriesOnly: true,
    });
  });
}

const themeMediaQuery = matchMedia("(prefers-color-scheme: dark)");
const mobileMediaQuery = matchMedia("(max-width: 768px)");
const initialSidebarState = !mobileMediaQuery.matches;
const electronShim = (window.__ELECTRON_SHIM__ ??= {});
const buildFlavor: "prod" | "dev" | "agent" | string = "prod";

Object.assign(globalThis, {
  process: {
    arch: "arm64",
    platform: "darwin",
    versions: {
      electron: "41.2.0",
    },
  },
});

electronShim.overrideAdapter = {
  getGateOverride(evaluation) {
    if (evaluation.name === "2911712394") {
      return {
        ...evaluation,
        value: true,
      };
    }

    if (evaluation.name === "1042620455") {
      // Remote control (Slingshot).
      return {
        ...evaluation,
        value: true,
      };
    }

    return null;
  },
};

const initialRoute = mapBrowserPathToInitialRoute(
  window.location.pathname,
  window.location.search,
);
electronShim.initialRoute = initialRoute.memoryPath;

if (initialRoute.browserPath) {
  window.history.pushState(undefined, "", initialRoute.browserPath);
}

electronShim.initialSidebarState = initialSidebarState;
electronShim.closeSidebar = () => {
  const aside = document.querySelector("aside.app-shell-left-panel");
  if (
    !(aside instanceof HTMLElement) ||
    aside.getBoundingClientRect().width < 2
  ) {
    return;
  }
  const trigger = document.querySelector(
    '[data-app-shell-sidebar-trigger="true"], [data-app-shell-sidebar-trigger]',
  );
  if (trigger instanceof HTMLElement) trigger.click();
};
electronShim.onMemoryNavigationChanged = (navigation) => {
  const path = navigation.location.pathname;
  if (
    navigation.action !== "POP" &&
    mobileMediaQuery.matches &&
    shouldCloseSidebarForMemoryPath(path)
  ) {
    electronShim.closeSidebar?.();
  }

  const browserPath = mapMemoryPathToBrowserPath(path);
  if (browserPath == null) {
    return;
  }

  if (browserPath.titleChange) {
    document.title = browserPath.titleChange;
  }

  if (window.location.pathname === browserPath.path) {
    window.history.replaceState(undefined, "", browserPath.path);
    return;
  }

  window.history.pushState(undefined, "", browserPath.path);
};

export const ipcRenderer = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (channel === "codex_desktop:message-from-view" && args.length === 1) {
      rememberBrowserSidebarNavigation(args[0]);
      args[0] = normalizeBrowserSidebarSyncMessage(args[0]);

      if (isOpenInBrowserMessage(args[0])) {
        window.open(args[0].url, "_blank", "noopener,noreferrer");
      }

      if (isLocalFilePickerMessage(args[0])) {
        return handleLocalFilePickerMessage(args[0]);
      }

      if (isUnhandledAddWorkspaceRootOptionMessage(args[0])) {
        return openSelectWorkspaceRootDialog({
          listDirectory: requestWorkspaceDirectoryEntries,
        }).then((root) => {
          if (!root) {
            return undefined;
          }

          return invokeMain(channel, [{ ...args[0], root }]);
        });
      }
    }

    return invokeMain(channel, args);
  },
  on(channel: string, listener: IpcListener): unknown {
    addIpcListener(channel, listener);
    return this;
  },
  once(channel: string, listener: IpcListener): unknown {
    const wrapped: IpcListener = (event, ...args) => {
      this.removeListener(channel, wrapped);
      listener(event, ...args);
    };
    addIpcListener(channel, wrapped);
    return this;
  },
  addListener(channel: string, listener: IpcListener): unknown {
    addIpcListener(channel, listener);
    return this;
  },
  removeListener(channel: string, listener: IpcListener): unknown {
    rendererListeners.get(channel)?.delete(listener);
    return this;
  },
  off(channel: string, listener: IpcListener): unknown {
    return this.removeListener(channel, listener);
  },
  send(channel: string, ...args: unknown[]): void {
    if (channel === "codex_desktop:message-from-view" && args.length === 1) {
      rememberBrowserSidebarNavigation(args[0]);
      args[0] = normalizeBrowserSidebarSyncMessage(args[0]);
    }
    enqueueMessage({
      type: "ipc-renderer-send",
      channel,
      args,
    });
  },
  postMessage(
    channel: string,
    message: unknown,
    transfer?: Transferable[],
  ): void {
    if (transfer && transfer.length > 0) {
      const portIds = transfer.map((transferable) => {
        if (!(transferable instanceof MessagePort)) {
          throw new TypeError(
            "Only MessagePort transfers are supported by the browser IPC bridge.",
          );
        }

        const portId = `message_port_${nextRequestId()}`;
        messagePorts.set(portId, transferable);
        transferable.addEventListener("message", (event) => {
          enqueueMessage({
            type: "message-port-message",
            portId,
            data: event.data,
          });
        });
        transferable.addEventListener("messageerror", () => {
          messagePorts.delete(portId);
          enqueueMessage({ type: "message-port-close", portId });
        });
        transferable.start();
        return portId;
      });

      enqueueMessage({
        type: "ipc-renderer-post-message",
        channel,
        message,
        portIds,
      });
      return;
    }

    enqueueMessage({
      type: "ipc-renderer-send",
      channel,
      args: [message],
    });
  },
  sendSync(channel: string, ..._args: unknown[]): unknown {
    if (channel === "codex_desktop:get-sentry-init-options") {
      return {
        codexAppSessionId: "42626fde-7064-471f-b44d-b1a7ad849c7f",
        buildFlavor,
        buildNumber: null,
        appVersion: __CODEX_APP_VERSION__,
        enabled: false,
      };
    }

    if (channel === "codex_desktop:get-build-flavor") {
      return buildFlavor;
    }

    if (channel === "codex_desktop:get-uses-owl-app-shell") {
      return false;
    }

    if (channel === "codex_desktop:get-shared-object-snapshot") {
      return {
        ...(window.__PRIMECODEX_SHARED_OBJECT_SNAPSHOT__ ?? {}),
        host_config: { id: "local", display_name: "Local", kind: "local" },
        remote_ssh_connections: [],
        remote_wsl_connections: [],
        remote_control_connections_state: {
          available: false,
          accessRequired: false,
          authRequired: false,
          clientAuthorized: false,
        },
        local_remote_control_client_id: null,
        pending_worktrees: [],
      };
    }

    if (channel === "codex_desktop:get-initial-sidebar-bootstrap") {
      return {
        globalStateEntries: [],
        workspaceRootOptions: {
          roots: [],
          labels: {},
        },
        projectlessWorkspaceRoot: {
          workspaceRoot: null,
        },
        catalogEntries: [],
      };
    }

    if (channel === "codex_desktop:get-system-theme-variant") {
      return themeMediaQuery.matches ? "dark" : "light";
    }

    if (channel === "codex_desktop:start-file-drag") {
      // Native Electron can initiate an OS drag from a local path. A browser
      // cannot do that synchronously; false is the native \"not started\"
      // result and lets the renderer fall back without throwing.
      return false;
    }

    return unimplemented("ipcRenderer.sendSync");
  },
};

type BrowserCommentPopupRuntime = {
  frameName: string;
  iframe: HTMLIFrameElement;
  popup: Window;
  closed: boolean;
};

const browserCommentPopups = new Map<string, BrowserCommentPopupRuntime>();

function parseBrowserCommentPopupFeatures(features: string | undefined): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const values = new Map<string, number>();
  for (const part of (features ?? "").split(",")) {
    const [rawKey, rawValue] = part.split("=", 2);
    if (!rawKey || rawValue === undefined) continue;
    const value = Number(rawValue);
    if (Number.isFinite(value)) values.set(rawKey.trim().toLowerCase(), value);
  }
  return {
    x: values.get("left") ?? values.get("x") ?? 0,
    y: values.get("top") ?? values.get("y") ?? 0,
    width: Math.max(220, values.get("width") ?? 294),
    height: Math.max(120, values.get("height") ?? 208),
  };
}

function positionBrowserCommentPopup(
  runtime: BrowserCommentPopupRuntime,
  bounds: { x: number; y: number; width: number; height: number },
): void {
  const localX = bounds.x - (window.screenX || 0);
  const localY = bounds.y - (window.screenY || 0);
  const width = Math.min(bounds.width, Math.max(220, window.innerWidth - 16));
  const height = Math.min(
    bounds.height,
    Math.max(120, window.innerHeight - 16),
  );
  const x = Math.min(
    Math.max(8, localX),
    Math.max(8, window.innerWidth - width - 8),
  );
  const y = Math.min(
    Math.max(8, localY),
    Math.max(8, window.innerHeight - height - 8),
  );
  Object.assign(runtime.iframe.style, {
    left: `${x}px`,
    top: `${y}px`,
    width: `${width}px`,
    height: `${height}px`,
  });
}

function closeBrowserCommentPopup(runtime: BrowserCommentPopupRuntime): void {
  if (runtime.closed) return;
  runtime.closed = true;
  try {
    runtime.popup.dispatchEvent(new PageTransitionEvent("pagehide"));
  } catch {
    runtime.popup.dispatchEvent(new Event("pagehide"));
  }
  runtime.iframe.remove();
  browserCommentPopups.delete(runtime.frameName);
}

function installBrowserCommentPopupPolyfill(): void {
  const nativeOpen = window.open.bind(window);
  window.open = ((url?: string | URL, target?: string, features?: string) => {
    const href = String(url ?? "");
    const frameName = target ?? "";
    if (
      href !== "about:blank" ||
      !frameName.startsWith("codex-renderer-window:browserCommentPopup:")
    ) {
      return nativeOpen(href, target, features);
    }

    const existing = browserCommentPopups.get(frameName);
    if (existing && !existing.closed && existing.iframe.isConnected) {
      existing.iframe.style.display = "block";
      existing.iframe.focus();
      return existing.popup;
    }

    const bounds = parseBrowserCommentPopupFeatures(features);
    const iframe = document.createElement("iframe");
    iframe.name = frameName;
    iframe.src = "about:blank";
    iframe.setAttribute("data-primecodex-browser-comment-popup", frameName);
    Object.assign(iframe.style, {
      position: "fixed",
      border: "0",
      margin: "0",
      padding: "0",
      background: "transparent",
      colorScheme: "light dark",
      zIndex: "2147483000",
      overflow: "hidden",
      display: "block",
      visibility: "hidden",
      pointerEvents: "none",
    });
    document.body.append(iframe);

    const popupWindow = iframe.contentWindow;
    if (!popupWindow) {
      iframe.remove();
      return null;
    }

    const runtime: BrowserCommentPopupRuntime = {
      frameName,
      iframe,
      popup: popupWindow,
      closed: false,
    };
    positionBrowserCommentPopup(runtime, bounds);

    const proxy = new Proxy(popupWindow, {
      get(targetWindow, prop) {
        if (prop === "closed")
          return runtime.closed || !runtime.iframe.isConnected;
        if (prop === "close") return () => closeBrowserCommentPopup(runtime);
        if (prop === "focus") {
          return () => {
            runtime.iframe.style.display = "block";
            runtime.iframe.focus();
          };
        }
        const value = Reflect.get(targetWindow, prop, targetWindow);
        return typeof value === "function" ? value.bind(targetWindow) : value;
      },
    }) as Window;
    runtime.popup = proxy;
    browserCommentPopups.set(frameName, runtime);

    ipcRenderer.send("primecodex:browser-comment-popup-created", {
      frameName,
      bounds,
    });
    return proxy;
  }) as typeof window.open;

  ipcRenderer.on(
    "primecodex:browser-comment-popup-command",
    (_event, payload) => {
      if (!payload || typeof payload !== "object" || Array.isArray(payload))
        return;
      const command = payload as {
        frameName?: string;
        type?: string;
        bounds?: { x?: number; y?: number; width?: number; height?: number };
      };
      if (!command.frameName) return;
      const runtime = browserCommentPopups.get(command.frameName);
      if (!runtime) return;

      if (command.type === "set-bounds" && command.bounds) {
        const current = runtime.iframe.getBoundingClientRect();
        positionBrowserCommentPopup(runtime, {
          x: command.bounds.x ?? current.x + (window.screenX || 0),
          y: command.bounds.y ?? current.y + (window.screenY || 0),
          width: command.bounds.width ?? current.width,
          height: command.bounds.height ?? current.height,
        });
        return;
      }
      if (command.type === "show") {
        runtime.iframe.style.visibility = "visible";
        runtime.iframe.style.pointerEvents = "auto";
        return;
      }
      if (command.type === "hide") {
        // Electron keeps a hidden BrowserWindow laid out; display:none would
        // collapse the native comment editor's first measurement to 0x0.
        runtime.iframe.style.visibility = "hidden";
        runtime.iframe.style.pointerEvents = "none";
        return;
      }
      if (command.type === "focus") {
        runtime.iframe.focus();
        return;
      }
      if (command.type === "close") {
        closeBrowserCommentPopup(runtime);
      }
    },
  );
}

ensureSocket();
browserGuestBridge.start();
installBrowserCommentPopupPolyfill();

export const contextBridge = {
  exposeInMainWorld(_key: string, _api: unknown): void {
    Reflect.set(window, _key, _api);
  },
};

export const webUtils = {
  getPathForFile(_file: File): string | null {
    return unimplemented("webUtils.getPathForFile");
  },
};
