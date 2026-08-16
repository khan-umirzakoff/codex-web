import {
  CdpBrowserGuest,
  type BrowserGuestFrame,
  type BrowserGuestInput,
} from "../browser-guest/cdp";

type StubFunction = (...args: unknown[]) => unknown;
type StubListener = (...args: unknown[]) => void;
type StubMessagePort = {
  close: () => void;
  on: (event: string, listener: StubListener) => unknown;
  postMessage: (message: unknown) => void;
  start: () => void;
};
type StubWebContents = {
  id: number;
  mainFrame: {
    url: string;
  };
  getURL: () => string;
  isDestroyed: () => boolean;
  off: (event: string, listener: StubListener) => unknown;
  on: (event: string, listener: StubListener) => unknown;
  once: (event: string, listener: StubListener) => unknown;
  removeListener: (event: string, listener: StubListener) => unknown;
  send: (channel: string, ...args: unknown[]) => void;
};

export type BrowserWebviewGuestAttachRequest = {
  attachmentId: string;
  attributes: Record<string, string>;
  width: number;
  height: number;
};

export type BrowserWebviewGuestCallbacks = {
  onAttached: (guestId: number) => void;
  onFrame: (guestId: number, frame: BrowserGuestFrame) => void;
  onClosed?: (guestId: number) => void;
};

type IpcMainEvent = {
  returnValue: unknown;
  processId: number;
  frameId: number;
  sender: StubWebContents;
  senderFrame: {
    url: string;
  };
  ports: StubMessagePort[];
  reply: (channel: string, ...args: unknown[]) => void;
};

type IpcMainBridgeState = {
  broadcastToRenderer?: (message: {
    type: "ipc-main-event";
    channel: string;
    args: unknown[];
  }) => void;
  initialSharedObjects?: Record<string, unknown>;
  handleRendererInvoke?: (
    channel: string,
    args: unknown[],
    sourceUrl?: string,
  ) => Promise<unknown>;
  handleRendererPostMessage?: (
    channel: string,
    message: unknown,
    ports: StubMessagePort[],
    sourceUrl?: string,
  ) => void;
  handleRendererSend?: (
    channel: string,
    args: unknown[],
    sourceUrl?: string,
  ) => void;
  handleWebContentsInvoke?: (
    sender: StubWebContents,
    channel: string,
    args: unknown[],
  ) => Promise<unknown>;
  handleWebContentsSend?: (
    sender: StubWebContents,
    channel: string,
    args: unknown[],
  ) => void;
};

function getIpcMainBridgeState(): IpcMainBridgeState {
  const globals = globalThis as typeof globalThis & {
    __codexElectronIpcBridge?: IpcMainBridgeState;
  };
  if (!globals.__codexElectronIpcBridge) {
    globals.__codexElectronIpcBridge = {};
  }
  return globals.__codexElectronIpcBridge;
}

function log(method: string, args: unknown[]): void {
  console.log(`[electron-main-stub] ${method}`, args);
}

function createDeepStub(pathLabel: string): StubFunction {
  const fn: StubFunction = (...args: unknown[]) => {
    log(`${pathLabel}()`, args);
    return undefined;
  };

  return new Proxy(fn, {
    apply(_target, _thisArg, argArray) {
      log(`${pathLabel}()`, argArray);
      return undefined;
    },
    construct(_target, argArray) {
      log(`new ${pathLabel}()`, argArray);
      return {};
    },
    get(_target, prop) {
      if (prop === "then") {
        return undefined;
      }

      if (prop === Symbol.toPrimitive) {
        return () => pathLabel;
      }

      return createDeepStub(`${pathLabel}.${String(prop)}`);
    },
  });
}

function createEmitterStub(label: string): {
  addListener: (event: string, listener: StubListener) => unknown;
  emit: (event: string, ...args: unknown[]) => boolean;
  off: (event: string, listener: StubListener) => unknown;
  on: (event: string, listener: StubListener) => unknown;
  once: (event: string, listener: StubListener) => unknown;
  removeListener: (event: string, listener: StubListener) => unknown;
} {
  const listeners = new Map<string, Set<StubListener>>();

  const api = {
    on(event: string, listener: StubListener): unknown {
      log(`${label}.on`, [event, listener]);
      const eventListeners = listeners.get(event) ?? new Set<StubListener>();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
      return api;
    },
    once(event: string, listener: StubListener): unknown {
      log(`${label}.once`, [event, listener]);
      const wrapped: StubListener = (...args: unknown[]) => {
        api.removeListener(event, wrapped);
        listener(...args);
      };
      return api.on(event, wrapped);
    },
    addListener(event: string, listener: StubListener): unknown {
      log(`${label}.addListener`, [event, listener]);
      return api.on(event, listener);
    },
    removeListener(event: string, listener: StubListener): unknown {
      log(`${label}.removeListener`, [event, listener]);
      listeners.get(event)?.delete(listener);
      return api;
    },
    off(event: string, listener: StubListener): unknown {
      log(`${label}.off`, [event, listener]);
      return api.removeListener(event, listener);
    },
    emit(event: string, ...args: unknown[]): boolean {
      log(`${label}.emit`, [event, ...args]);
      for (const listener of listeners.get(event) ?? []) {
        listener(...args);
      }
      return true;
    },
  };

  return api;
}

function createMessagePortStub(label: string): {
  on: (event: string, listener: StubListener) => unknown;
  postMessage: (...args: unknown[]) => void;
  start: () => void;
} {
  const emitter = createEmitterStub(label);
  return {
    on: emitter.on,
    postMessage(...args: unknown[]): void {
      log(`${label}.postMessage`, args);
    },
    start(): void {
      log(`${label}.start`, []);
    },
  };
}

const rendererUrl = "http://localhost:5175/";
const rendererMainFrame = {
  url: rendererUrl,
};
const rendererWebContentsEmitter = createEmitterStub("ipcMainEvent.sender");
const rendererWebContents: StubWebContents = {
  id: 1001,
  mainFrame: rendererMainFrame,
  getURL: () => rendererMainFrame.url,
  isDestroyed: () => false,
  off: rendererWebContentsEmitter.off,
  on: rendererWebContentsEmitter.on,
  once: rendererWebContentsEmitter.once,
  removeListener: rendererWebContentsEmitter.removeListener,
  send: (channel: string, ...args: unknown[]): void => {
    getIpcMainBridgeState().broadcastToRenderer?.({
      type: "ipc-main-event",
      channel,
      args,
    });
  },
};

function createIpcMainEvent(
  ports: StubMessagePort[] = [],
  senderOverride?: StubWebContents,
): IpcMainEvent {
  const sender =
    senderOverride ??
    (BrowserWindow.fromWebContents(rendererWebContents)
      ?.webContents as unknown as StubWebContents | undefined) ??
    rendererWebContents;
  const event: IpcMainEvent = {
    returnValue: undefined,
    processId: 1,
    frameId: 1,
    sender,
    senderFrame: sender.mainFrame,
    ports,
    reply: (channel: string, ...args: unknown[]): void => {
      getIpcMainBridgeState().broadcastToRenderer?.({
        type: "ipc-main-event",
        channel,
        args,
      });
    },
  };

  return event;
}

function createIpcMainStub(): {
  handle: (
    channel: string,
    handler: (event: unknown, ...args: unknown[]) => unknown,
  ) => void;
  off: (event: string, listener: StubListener) => unknown;
  on: (event: string, listener: StubListener) => unknown;
  removeHandler: (channel: string) => void;
} {
  const emitter = createEmitterStub("ipcMain");
  const handlers = new Map<
    string,
    (event: unknown, ...args: unknown[]) => unknown
  >();
  const bridgeState = getIpcMainBridgeState();

  const pendingPostMessages = new Map<
    string,
    Array<{ message: unknown; ports: StubMessagePort[] }>
  >();
  const registeredPostMessageChannels = new Set<string>();

  bridgeState.handleRendererPostMessage = (
    channel: string,
    message: unknown,
    ports: StubMessagePort[],
  ): void => {
    if (registeredPostMessageChannels.has(channel)) {
      emitter.emit(channel, createIpcMainEvent(ports), message);
      return;
    }
    const pending = pendingPostMessages.get(channel) ?? [];
    pending.push({ message, ports });
    pendingPostMessages.set(channel, pending);
  };

  bridgeState.handleRendererInvoke = async (
    channel: string,
    args: unknown[],
  ): Promise<unknown> => {
    const handler = handlers.get(channel);
    if (!handler) {
      throw new Error(`[electron-main-stub] No ipcMain.handle for ${channel}`);
    }
    const event = createIpcMainEvent();
    return await Promise.resolve(handler(event, ...args));
  };

  bridgeState.handleRendererSend = (
    channel: string,
    args: unknown[],
    sourceUrl?: string,
  ): void => {
    const event = createIpcMainEvent();
    emitter.emit(channel, event, ...args);
  };

  bridgeState.handleWebContentsInvoke = async (
    sender: StubWebContents,
    channel: string,
    args: unknown[],
  ): Promise<unknown> => {
    const debugBrowser = process.env.PRIMECODEX_DEBUG_BROWSER === "1";
    const handler = handlers.get(channel);
    if (debugBrowser) {
      console.error(
        `[primecodex-browser] main invoke ${channel} sender=${String(sender.id)} handler=${handler ? "yes" : "no"}`,
        args[0] && typeof args[0] === "object"
          ? { type: (args[0] as { type?: unknown }).type }
          : undefined,
      );
    }
    if (!handler) {
      throw new Error(`[electron-main-stub] No ipcMain.handle for ${channel}`);
    }
    try {
      const result = await Promise.resolve(
        handler(createIpcMainEvent([], sender), ...args),
      );
      if (debugBrowser) {
        console.error(`[primecodex-browser] main invoke ok ${channel}`, result);
      }
      return result;
    } catch (error) {
      if (debugBrowser) {
        console.error(
          `[primecodex-browser] main invoke failed ${channel}`,
          error,
        );
      }
      throw error;
    }
  };

  bridgeState.handleWebContentsSend = (
    sender: StubWebContents,
    channel: string,
    args: unknown[],
  ): void => {
    emitter.emit(channel, createIpcMainEvent([], sender), ...args);
  };

  return {
    on(channel: string, listener: StubListener): unknown {
      const result = emitter.on(channel, listener);
      registeredPostMessageChannels.add(channel);
      const pending = pendingPostMessages.get(channel);
      if (pending) {
        pendingPostMessages.delete(channel);
        for (const { message, ports } of pending) {
          emitter.emit(channel, createIpcMainEvent(ports), message);
        }
      }
      return result;
    },
    off: emitter.off,
    handle(
      channel: string,
      handler: (event: unknown, ...args: unknown[]) => unknown,
    ): void {
      log("ipcMain.handle", [channel, handler]);
      handlers.set(channel, handler);
      if (channel === "codex_desktop:message-from-view") {
        const initialSharedObjects = bridgeState.initialSharedObjects;
        if (
          initialSharedObjects &&
          Object.keys(initialSharedObjects).length > 0
        ) {
          queueMicrotask(() => {
            for (const [key, value] of Object.entries(initialSharedObjects)) {
              Promise.resolve(
                handler(createIpcMainEvent(), {
                  type: "shared-object-set",
                  key,
                  value,
                }),
              ).catch((error) => {
                console.error(
                  `[electron-main-stub] failed to seed shared object ${key}`,
                  error,
                );
              });
            }
          });
        }
      }
    },
    removeHandler(channel: string): void {
      log("ipcMain.removeHandler", [channel]);
      handlers.delete(channel);
    },
  };
}

let appReady = false;
let appReadyPromise: Promise<void> | null = null;
const appPathOverrides = new Map<string, string>();
const commandLineSwitches = new Map<string, string>();
const commandLineArguments: string[] = [];

const appBase = {
  ...createEmitterStub("app"),
  name: "Codex",
  isPackaged: false,
  getName(): string {
    log("app.getName", []);
    return "Codex";
  },
  getVersion(): string {
    return globalThis.__CODEX_SHIM_VALUES__.version;
  },
  getLocale(): string {
    log("app.getLocale", []);
    return "en-US";
  },
  getSystemLocale(): string {
    log("app.getSystemLocale", []);
    return "en-US";
  },
  getPreferredSystemLanguages(): string[] {
    log("app.getPreferredSystemLanguages", []);
    return ["en-US"];
  },
  getPath(name: string): string {
    log("app.getPath", [name]);
    const override = appPathOverrides.get(name);
    if (override) return override;
    const home = process.env.HOME ?? process.cwd();
    const root =
      process.env.PRIMECODEX_ELECTRON_DATA_DIR ??
      `${home}/.primecodex/electron`;
    if (name === "home") return home;
    if (name === "temp") return process.env.TMPDIR ?? "/tmp";
    return `${root}/${name}`;
  },
  getAppMetrics(): unknown[] {
    log("app.getAppMetrics", []);
    return [];
  },
  getAppPath(): string {
    log("app.getAppPath", []);
    return (
      (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ??
      process.cwd()
    );
  },
  async getGPUInfo(infoLevel: string): Promise<{ gpuDevice: unknown[] }> {
    log("app.getGPUInfo", [infoLevel]);
    return { gpuDevice: [] };
  },
  setName(name: string): void {
    log("app.setName", [name]);
  },
  setPath(name: string, value: string): void {
    log("app.setPath", [name, value]);
    appPathOverrides.set(name, value);
  },
  setAppUserModelId(value: string): void {
    log("app.setAppUserModelId", [value]);
  },
  requestSingleInstanceLock(): boolean {
    log("app.requestSingleInstanceLock", []);
    return true;
  },
  isReady(): boolean {
    log("app.isReady", []);
    return appReady;
  },
  whenReady(): Promise<void> {
    log("app.whenReady", []);
    if (appReady) return Promise.resolve();
    appReadyPromise ??= new Promise<void>((resolve) => {
      setImmediate(() => {
        appReady = true;
        resolve();
      });
    });
    return appReadyPromise;
  },
  commandLine: {
    appendSwitch(name: string, value?: string): void {
      log("app.commandLine.appendSwitch", [name, value]);
      commandLineSwitches.set(name, value ?? "");
    },
    appendArgument(value: string): void {
      log("app.commandLine.appendArgument", [value]);
      commandLineArguments.push(value);
    },
    getSwitchValue(name: string): string {
      log("app.commandLine.getSwitchValue", [name]);
      return commandLineSwitches.get(name) ?? "";
    },
    hasSwitch(name: string): boolean {
      log("app.commandLine.hasSwitch", [name]);
      return commandLineSwitches.has(name);
    },
    removeSwitch(name: string): void {
      log("app.commandLine.removeSwitch", [name]);
      commandLineSwitches.delete(name);
    },
  },
  on(event: string, listener: (...args: unknown[]) => void): unknown {
    log("app.on", [event, listener]);
    return app;
  },
  once(event: string, listener: (...args: unknown[]) => void): unknown {
    log("app.once", [event, listener]);
    return app;
  },
  quit(): void {
    log("app.quit", []);
  },
  exit(code?: number): void {
    log("app.exit", [code]);
  },
};

const app = new Proxy(appBase as Record<string, unknown>, {
  get(target, prop) {
    if (prop in target) {
      return target[prop as keyof typeof target];
    }

    return createDeepStub(`app.${String(prop)}`);
  },
}) as typeof appBase;

class BrowserWindow {
  static nextId = 1;
  static allWindows: BrowserWindow[] = [];
  static focusedWindow: BrowserWindow | null = null;
  id: number;
  private destroyed = false;
  private visible = true;
  private title = "Codex";
  private bounds = { x: 0, y: 0, width: 1280, height: 820 };
  primeCodexPopupFrameName?: string;
  webContents: Record<string, unknown>;
  private readonly emitter: ReturnType<typeof createEmitterStub>;

  constructor(...args: unknown[]) {
    log("new BrowserWindow", args);
    this.id = BrowserWindow.nextId++;
    const options =
      args[0] && typeof args[0] === "object"
        ? (args[0] as {
            show?: boolean;
            x?: number;
            y?: number;
            width?: number;
            height?: number;
          })
        : undefined;
    this.visible = options?.show !== false;
    this.bounds = {
      x: options?.x ?? 0,
      y: options?.y ?? 0,
      width: options?.width ?? 1280,
      height: options?.height ?? 820,
    };
    this.emitter = createEmitterStub(`BrowserWindow#${this.id}`);

    const webContentsEmitter = createEmitterStub(
      `BrowserWindow#${this.id}.webContents`,
    );
    this.webContents = new Proxy(
      {
        ...webContentsEmitter,
        id: this.id * 1000 + 1,
        mainFrame: {
          url: "",
        },
        getURL: (): string => {
          log(`BrowserWindow#${this.id}.webContents.getURL`, []);
          return String(
            (this.webContents.mainFrame as { url?: string } | undefined)?.url ??
              "",
          );
        },
        isDestroyed: (): boolean => this.destroyed,
        loadURL: async (url: string): Promise<void> => {
          log(`BrowserWindow#${this.id}.webContents.loadURL`, [url]);
          (this.webContents.mainFrame as { url: string }).url = url;
        },
        loadFile: async (...loadFileArgs: unknown[]): Promise<void> => {
          log(`BrowserWindow#${this.id}.webContents.loadFile`, loadFileArgs);
        },
        openDevTools: (...openDevToolsArgs: unknown[]): void => {
          log(
            `BrowserWindow#${this.id}.webContents.openDevTools`,
            openDevToolsArgs,
          );
        },
        send: (...sendArgs: unknown[]): void => {
          log(`BrowserWindow#${this.id}.webContents.send`, sendArgs);
          if (sendArgs.length === 0 || typeof sendArgs[0] !== "string") {
            return;
          }
          const [channel, ...args] = sendArgs as [string, ...unknown[]];
          getIpcMainBridgeState().broadcastToRenderer?.({
            type: "ipc-main-event",
            channel,
            args,
          });
        },
      } as Record<string, unknown>,
      {
        get: (target, prop) => {
          if (prop in target) {
            return target[prop as keyof typeof target];
          }
          return createDeepStub(
            `BrowserWindow#${this.id}.webContents.${String(prop)}`,
          );
        },
      },
    );

    const proxy = new Proxy(this, {
      get: (target, prop) => {
        if (prop === "then") return undefined;
        if (prop in target) {
          return target[prop as keyof typeof target];
        }
        return createDeepStub(`BrowserWindow#${target.id}.${String(prop)}`);
      },
    });
    BrowserWindow.allWindows.push(proxy);
    BrowserWindow.focusedWindow = proxy;
    return proxy;
  }

  static getAllWindows(): BrowserWindow[] {
    log("BrowserWindow.getAllWindows", []);
    return BrowserWindow.allWindows.filter((window) => !window.destroyed);
  }

  static getFocusedWindow(): BrowserWindow | null {
    log("BrowserWindow.getFocusedWindow", []);
    if (BrowserWindow.focusedWindow && !BrowserWindow.focusedWindow.destroyed) {
      return BrowserWindow.focusedWindow;
    }
    return BrowserWindow.getAllWindows()[0] ?? null;
  }

  static fromWebContents(
    webContents: { id?: unknown; hostWebContents?: unknown } | null | undefined,
  ): BrowserWindow | null {
    log("BrowserWindow.fromWebContents", [webContents]);
    if (!webContents) {
      return null;
    }

    if (
      webContents instanceof CdpBrowserGuest &&
      webContents.hostWebContents &&
      webContents.hostWebContents !== webContents
    ) {
      return BrowserWindow.fromWebContents(
        webContents.hostWebContents as {
          id?: unknown;
          hostWebContents?: unknown;
        },
      );
    }

    return (
      BrowserWindow.getAllWindows().find(
        (window) =>
          window.webContents === webContents ||
          window.webContents.id === webContents.id,
      ) ?? null
    );
  }

  on(event: string, listener: StubListener): unknown {
    return this.emitter.on(event, listener);
  }

  once(event: string, listener: StubListener): unknown {
    return this.emitter.once(event, listener);
  }

  off(event: string, listener: StubListener): unknown {
    return this.emitter.off(event, listener);
  }

  removeListener(event: string, listener: StubListener): unknown {
    return this.emitter.removeListener(event, listener);
  }

  async loadURL(url: string): Promise<void> {
    log(`BrowserWindow#${this.id}.loadURL`, [url]);
    (this.webContents.mainFrame as { url: string }).url = url;
  }

  close(): void {
    log(`BrowserWindow#${this.id}.close`, []);
    this.emitter.emit("close", {
      preventDefault: () => undefined,
    });
    this.destroy();
  }

  destroy(): void {
    log(`BrowserWindow#${this.id}.destroy`, []);
    this.destroyed = true;
    this.visible = false;
    if (BrowserWindow.focusedWindow === this) {
      BrowserWindow.focusedWindow = null;
    }
    this.emitter.emit("closed");
    this.syncPrimeCodexPopup("close");
  }

  isDestroyed(): boolean {
    log(`BrowserWindow#${this.id}.isDestroyed`, []);
    return this.destroyed;
  }

  isFocused(): boolean {
    log(`BrowserWindow#${this.id}.isFocused`, []);
    return BrowserWindow.focusedWindow === this && !this.destroyed;
  }

  isVisible(): boolean {
    log(`BrowserWindow#${this.id}.isVisible`, []);
    return this.visible && !this.destroyed;
  }

  removeMenu(): void {
    log(`BrowserWindow#${this.id}.removeMenu`, []);
  }

  getTitle(): string {
    log(`BrowserWindow#${this.id}.getTitle`, []);
    return this.title;
  }

  setTitle(nextTitle: string): void {
    log(`BrowserWindow#${this.id}.setTitle`, [nextTitle]);
    this.title = nextTitle;
  }

  getBounds(): { height: number; width: number; x: number; y: number } {
    log(`BrowserWindow#${this.id}.getBounds`, []);
    return { ...this.bounds };
  }

  getContentBounds(): { height: number; width: number; x: number; y: number } {
    log(`BrowserWindow#${this.id}.getContentBounds`, []);
    return { ...this.bounds };
  }

  setBounds(nextBounds: {
    height?: number;
    width?: number;
    x?: number;
    y?: number;
  }): void {
    log(`BrowserWindow#${this.id}.setBounds`, [nextBounds]);
    this.bounds = {
      x: nextBounds.x ?? this.bounds.x,
      y: nextBounds.y ?? this.bounds.y,
      width: nextBounds.width ?? this.bounds.width,
      height: nextBounds.height ?? this.bounds.height,
    };
    this.syncPrimeCodexPopup("set-bounds", { bounds: this.bounds });
  }

  show(): void {
    log(`BrowserWindow#${this.id}.show`, []);
    this.visible = true;
    this.emitter.emit("show");
    this.syncPrimeCodexPopup("show");
  }

  showInactive(): void {
    log(`BrowserWindow#${this.id}.showInactive`, []);
    this.visible = true;
    this.emitter.emit("show");
    this.syncPrimeCodexPopup("show");
  }

  hide(): void {
    log(`BrowserWindow#${this.id}.hide`, []);
    this.visible = false;
    this.emitter.emit("hide");
    this.syncPrimeCodexPopup("hide");
  }

  focus(): void {
    log(`BrowserWindow#${this.id}.focus`, []);
    BrowserWindow.focusedWindow = this;
    this.emitter.emit("focus");
    this.syncPrimeCodexPopup("focus");
  }

  private syncPrimeCodexPopup(
    type: string,
    payload: Record<string, unknown> = {},
  ): void {
    const frameName = this.primeCodexPopupFrameName;
    if (!frameName) return;
    getIpcMainBridgeState().broadcastToRenderer?.({
      type: "ipc-main-event",
      channel: "primecodex:browser-comment-popup-command",
      args: [{ frameName, type, ...payload }],
    });
  }
}

const browserGuestWebContents = new Map<number, CdpBrowserGuest>();
let nextBrowserWebviewInstanceId = 1;

function rendererOwnerWebContents(): Record<string, unknown> | undefined {
  return (
    BrowserWindow.fromWebContents(rendererWebContents)?.webContents ??
    BrowserWindow.getFocusedWindow()?.webContents ??
    BrowserWindow.getAllWindows()[0]?.webContents
  );
}

function emitWebContentsEvent(
  webContents: Record<string, unknown>,
  event: string,
  ...args: unknown[]
): boolean {
  const emit = webContents.emit;
  if (typeof emit !== "function") return false;
  return Boolean(emit.call(webContents, event, ...args));
}

export async function attachBrowserWebviewGuest(
  request: BrowserWebviewGuestAttachRequest,
  callbacks: BrowserWebviewGuestCallbacks,
): Promise<number> {
  const owner = rendererOwnerWebContents();
  if (!owner) {
    throw new Error(
      "PrimeCodex browser guest has no renderer owner WebContents",
    );
  }

  const instanceId = nextBrowserWebviewInstanceId++;
  const baseParams: Record<string, unknown> = {
    ...request.attributes,
    src: request.attributes.src ?? "about:blank",
    partition: request.attributes.partition ?? "",
    instanceId,
    viewInstanceId: instanceId,
  };

  let webPreferences: Record<string, unknown> | undefined;
  let acceptedParams: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const params = { ...baseParams };
    const preferences: Record<string, unknown> = {};
    const event = {
      defaultPrevented: false,
      preventDefault(): void {
        this.defaultPrevented = true;
      },
    };
    const handled = emitWebContentsEvent(
      owner,
      "will-attach-webview",
      event,
      preferences,
      params,
    );
    // EventEmitter.emit() returns false when the native BrowserSidebarManager
    // has not registered its listener yet. Treating that as an accepted attach
    // races cold startup and silently loses the native browser-page preload.
    if (handled && !event.defaultPrevented) {
      webPreferences = preferences;
      acceptedParams = params;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  if (!webPreferences || !acceptedParams) {
    throw new Error(
      "Native BrowserSidebarManager rejected the browser guest attachment",
    );
  }

  let guest!: CdpBrowserGuest;
  guest = new CdpBrowserGuest({
    width: request.width,
    height: request.height,
    preloadPath:
      typeof webPreferences.preload === "string"
        ? webPreferences.preload
        : undefined,
    onFrame: (frame) => callbacks.onFrame(guest.id, frame),
    onIpcInvoke: async (channel, args) => {
      const invoke = getIpcMainBridgeState().handleWebContentsInvoke;
      if (!invoke) {
        throw new Error(
          `[electron-main-stub] guest IPC invoke unavailable for ${channel}`,
        );
      }
      return await invoke(guest as unknown as StubWebContents, channel, args);
    },
    onIpcSend: (channel, args) => {
      getIpcMainBridgeState().handleWebContentsSend?.(
        guest as unknown as StubWebContents,
        channel,
        args,
      );
    },
  });
  guest.viewInstanceId = instanceId;
  guest.hostWebContents = owner;
  guest.session = webPreferences.session;
  browserGuestWebContents.set(guest.id, guest);
  guest.once("destroyed", () => {
    browserGuestWebContents.delete(guest.id);
    callbacks.onClosed?.(guest.id);
  });

  try {
    await guest.start();
    emitWebContentsEvent(owner, "did-attach-webview", {}, guest);
    callbacks.onAttached(guest.id);
    return guest.id;
  } catch (error) {
    browserGuestWebContents.delete(guest.id);
    await guest.close().catch(() => undefined);
    throw error;
  }
}

export async function detachBrowserWebviewGuest(
  guestId: number,
): Promise<void> {
  const guest = browserGuestWebContents.get(guestId);
  if (!guest) return;
  browserGuestWebContents.delete(guestId);
  await guest.close();
}

export async function resizeBrowserWebviewGuest(
  guestId: number,
  width: number,
  height: number,
): Promise<void> {
  await browserGuestWebContents.get(guestId)?.setViewport(width, height);
}

export function activateBrowserWebviewGuest(guestId: number): void {
  browserGuestWebContents.get(guestId)?.focus();
}

export async function dispatchBrowserWebviewGuestInput(
  guestId: number,
  input: BrowserGuestInput,
): Promise<void> {
  const guest = browserGuestWebContents.get(guestId);
  if (!guest) return;
  await guest.dispatchInput(input);
}

class WebContentsView {
  constructor(...args: unknown[]) {
    log("new WebContentsView", args);
  }
}

class Menu {
  static applicationMenu: Menu | null = null;
  items: MenuItem[] = [];

  constructor(items: MenuItem[] = []) {
    this.items = items;
  }

  static buildFromTemplate(template: unknown[]): Menu {
    log("Menu.buildFromTemplate", [template]);
    const items = template.map((entry) => new MenuItem(entry));
    return new Menu(items);
  }

  static setApplicationMenu(menu: Menu | null): void {
    log("Menu.setApplicationMenu", [menu]);
    Menu.applicationMenu = menu;
  }

  static getApplicationMenu(): Menu | null {
    log("Menu.getApplicationMenu", []);
    return Menu.applicationMenu;
  }

  getMenuItemById(id: string): MenuItem | undefined {
    log("Menu.getMenuItemById", [id]);
    const queue = [...this.items];
    while (queue.length > 0) {
      const candidate = queue.shift();
      if (!candidate) {
        continue;
      }
      if (candidate.id === id) {
        return candidate;
      }
      if (candidate.submenu) {
        queue.push(...candidate.submenu.items);
      }
    }
    return undefined;
  }

  append(item: MenuItem): void {
    log("Menu.append", [item]);
    this.items.push(item);
  }

  insert(pos: number, item: MenuItem): void {
    log("Menu.insert", [pos, item]);
    const index = Math.max(0, Math.min(pos, this.items.length));
    this.items.splice(index, 0, item);
  }

  popup(...args: unknown[]): void {
    log("Menu.popup", args);
  }
}

class MenuItem {
  checked?: boolean;
  click?: (...args: unknown[]) => unknown;
  enabled?: boolean;
  id?: string;
  label?: string;
  role?: string;
  submenu?: Menu;
  type?: string;
  visible?: boolean;

  constructor(...args: unknown[]) {
    log("new MenuItem", args);
    const [options] = args as [Record<string, unknown>?];
    if (!options || typeof options !== "object") {
      return;
    }
    this.checked =
      typeof options.checked === "boolean" ? options.checked : undefined;
    this.click =
      typeof options.click === "function"
        ? (options.click as (...args: unknown[]) => unknown)
        : undefined;
    this.enabled =
      typeof options.enabled === "boolean" ? options.enabled : undefined;
    this.id = typeof options.id === "string" ? options.id : undefined;
    this.label = typeof options.label === "string" ? options.label : undefined;
    this.role = typeof options.role === "string" ? options.role : undefined;
    this.type = typeof options.type === "string" ? options.type : undefined;
    this.visible =
      typeof options.visible === "boolean" ? options.visible : undefined;

    const submenu = options.submenu;
    if (Array.isArray(submenu)) {
      this.submenu = Menu.buildFromTemplate(submenu);
      return;
    }
    if (submenu instanceof Menu) {
      this.submenu = submenu;
    }
  }
}

class Tray {
  constructor(...args: unknown[]) {
    log("new Tray", args);
  }
}

class Notification {
  constructor(...args: unknown[]) {
    log("new Notification", args);
  }

  show(): void {
    log("Notification.show", []);
  }
}

const dialog = {
  async showMessageBox(...args: unknown[]): Promise<{ response: number }> {
    log("dialog.showMessageBox", args);
    return { response: 0 };
  },
  showErrorBox(title: string, content: string): void {
    log("dialog.showErrorBox", [title, content]);
    console.error(`[dialog.showErrorBox] ${title}: ${content}`);
  },
};

const crashReporter = {
  start(...args: unknown[]): void {
    log("crashReporter.start", args);
  },
};

const net = {
  async fetch(input: string | URL, init?: RequestInit): Promise<Response> {
    // log("net.fetch", [input, init]);
    if (typeof globalThis.fetch === "function") {
      return globalThis.fetch(input as URL | RequestInfo, init);
    }
    return new Response("", { status: 204 });
  },
  request(...args: unknown[]): {
    getHeader: (name: string) => string | undefined;
    once: (event: string, listener: StubListener) => unknown;
    setHeader: (name: string, value: string) => void;
  } {
    // log("net.request", args);
    const headers = new Map<string, string>();
    const request = {
      setHeader(name: string, value: string): void {
        // log("net.request.setHeader", [name, value]);
        headers.set(name.toLowerCase(), value);
      },
      getHeader(name: string): string | undefined {
        // log("net.request.getHeader", [name]);
        return headers.get(name.toLowerCase());
      },
      once(event: string, listener: StubListener): unknown {
        // log("net.request.once", [event, listener]);
        return request;
      },
    };
    return request;
  },
};

const autoUpdater = createEmitterStub("autoUpdater");
const ipcMain = createIpcMainStub();
ipcMain.on(
  "primecodex:browser-comment-popup-created",
  (event: unknown, payload: unknown) => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      return;
    const record = payload as Record<string, unknown>;
    const frameName =
      typeof record.frameName === "string" ? record.frameName : "";
    if (!frameName.startsWith("codex-renderer-window:browserCommentPopup:")) {
      return;
    }

    const owner = (event as IpcMainEvent).sender as StubWebContents & {
      emit?: (event: string, ...args: unknown[]) => boolean;
    };
    if (typeof owner.emit !== "function") return;

    const bounds =
      record.bounds &&
      typeof record.bounds === "object" &&
      !Array.isArray(record.bounds)
        ? (record.bounds as Record<string, unknown>)
        : {};
    const popup = new BrowserWindow({
      show: false,
      x: typeof bounds.x === "number" ? bounds.x : undefined,
      y: typeof bounds.y === "number" ? bounds.y : undefined,
      width: typeof bounds.width === "number" ? bounds.width : 294,
      height: typeof bounds.height === "number" ? bounds.height : 208,
    });
    popup.primeCodexPopupFrameName = frameName;
    owner.emit("did-create-window", popup, {
      frameName,
      url: "about:blank",
      options: {},
      disposition: "new-window",
    });
  },
);
const nativeTheme = {
  ...createEmitterStub("nativeTheme"),
  shouldUseDarkColors: false,
  shouldUseHighContrastColors: false,
  shouldUseInvertedColorScheme: false,
  themeSource: "system",
};
const nativeImage = {
  createEmpty(): { isEmpty: () => boolean } {
    log("nativeImage.createEmpty", []);
    return {
      isEmpty: () => true,
    };
  },
  createFromPath(imagePath: string): { isEmpty: () => boolean } {
    log("nativeImage.createFromPath", [imagePath]);
    return {
      isEmpty: () => !imagePath,
    };
  },
};
const systemPreferences = {
  async getFontFamilies(): Promise<string[]> {
    log("systemPreferences.getFontFamilies", []);
    return [
      "Arial",
      "Helvetica",
      "Times New Roman",
      "Courier New",
      "Menlo",
      "Monaco",
      "SF Pro",
      "SF Mono",
    ];
  },
  getMediaAccessStatus(): "granted" {
    log("systemPreferences.getMediaAccessStatus", []);
    return "granted";
  },
  async askForMediaAccess(): Promise<boolean> {
    log("systemPreferences.askForMediaAccess", []);
    return true;
  },
};
const powerMonitor = {
  ...createEmitterStub("powerMonitor"),
  getSystemIdleState(idleThreshold: number): "active" | "idle" | "locked" {
    log("powerMonitor.getSystemIdleState", [idleThreshold]);
    return "active";
  },
  isOnBatteryPower(): boolean {
    log("powerMonitor.isOnBatteryPower", []);
    return false;
  },
};
const screen = {
  ...createEmitterStub("screen"),
  getAllDisplays(): Array<{
    id: number;
    scaleFactor: number;
    size: { height: number; width: number };
    workArea: { height: number; width: number; x: number; y: number };
    workAreaSize: { height: number; width: number };
    bounds: { height: number; width: number; x: number; y: number };
  }> {
    log("screen.getAllDisplays", []);
    return [this.getPrimaryDisplay()];
  },
  getDisplayMatching(): {
    id: number;
    scaleFactor: number;
    size: { height: number; width: number };
    workArea: { height: number; width: number; x: number; y: number };
    workAreaSize: { height: number; width: number };
    bounds: { height: number; width: number; x: number; y: number };
  } {
    log("screen.getDisplayMatching", []);
    return this.getPrimaryDisplay();
  },
  getPrimaryDisplay(): {
    id: number;
    scaleFactor: number;
    size: { height: number; width: number };
    workArea: { height: number; width: number; x: number; y: number };
    workAreaSize: { height: number; width: number };
    bounds: { height: number; width: number; x: number; y: number };
  } {
    log("screen.getPrimaryDisplay", []);
    return {
      id: 1,
      scaleFactor: 2,
      size: { width: 1440, height: 900 },
      workArea: { x: 0, y: 0, width: 1440, height: 900 },
      workAreaSize: { width: 1440, height: 900 },
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
    };
  },
};
const protocol = {
  registerSchemesAsPrivileged(...args: unknown[]): void {
    log("protocol.registerSchemesAsPrivileged", args);
  },
  handle(...args: unknown[]): void {
    log("protocol.handle", args);
  },
  registerStringProtocol(...args: unknown[]): void {
    log("protocol.registerStringProtocol", args);
  },
};
function createSessionStub(label: string): {
  cookies: {
    get: (filter: Record<string, unknown>) => Promise<unknown[]>;
    off: (event: string, listener: StubListener) => unknown;
    on: (event: string, listener: StubListener) => unknown;
    once: (event: string, listener: StubListener) => unknown;
    removeListener: (event: string, listener: StubListener) => unknown;
  };
  getUserAgent: () => string;
  loadExtension: (extensionPath: string) => Promise<{
    id: string;
    name: string;
    path: string;
    version: string;
  }>;
  off: (event: string, listener: StubListener) => unknown;
  on: (event: string, listener: StubListener) => unknown;
  once: (event: string, listener: StubListener) => unknown;
  protocol: typeof protocol;
  removeListener: (event: string, listener: StubListener) => unknown;
  setPermissionCheckHandler: (...args: unknown[]) => void;
  setPermissionRequestHandler: (...args: unknown[]) => void;
  webRequest: {
    onBeforeRequest: (...args: unknown[]) => void;
    onBeforeSendHeaders: (...args: unknown[]) => void;
  };
} {
  const emitter = createEmitterStub(label);
  const cookiesEmitter = createEmitterStub(`${label}.cookies`);
  return {
    cookies: {
      async get(filter: Record<string, unknown>): Promise<unknown[]> {
        log(`${label}.cookies.get`, [filter]);
        return [];
      },
      off: cookiesEmitter.off,
      on: cookiesEmitter.on,
      once: cookiesEmitter.once,
      removeListener: cookiesEmitter.removeListener,
    },
    async loadExtension(extensionPath: string): Promise<{
      id: string;
      name: string;
      path: string;
      version: string;
    }> {
      log(`${label}.loadExtension`, [extensionPath]);
      return {
        id: "stub-extension",
        name: "Stub Extension",
        path: extensionPath,
        version: "0.0.0",
      };
    },
    getUserAgent(): string {
      log(`${label}.getUserAgent`, []);
      return "Mozilla/5.0 AppleWebKit/537.36 Chrome/120 Safari/537.36";
    },
    off: emitter.off,
    on: emitter.on,
    once: emitter.once,
    protocol,
    removeListener: emitter.removeListener,
    setPermissionCheckHandler(...args: unknown[]): void {
      log(`${label}.setPermissionCheckHandler`, args);
    },
    setPermissionRequestHandler(...args: unknown[]): void {
      log(`${label}.setPermissionRequestHandler`, args);
    },
    webRequest: {
      onBeforeRequest(...args: unknown[]): void {
        log(`${label}.webRequest.onBeforeRequest`, args);
      },
      onBeforeSendHeaders(...args: unknown[]): void {
        log(`${label}.webRequest.onBeforeSendHeaders`, args);
      },
    },
  };
}
const partitionSessions = new Map<
  string,
  ReturnType<typeof createSessionStub>
>();
const session = {
  defaultSession: createSessionStub("session.defaultSession"),
  fromPartition(partition: string): ReturnType<typeof createSessionStub> {
    log("session.fromPartition", [partition]);
    let partitionSession = partitionSessions.get(partition);
    if (!partitionSession) {
      partitionSession = createSessionStub(
        `session.fromPartition(${partition})`,
      );
      partitionSessions.set(partition, partitionSession);
    }
    return partitionSession;
  },
};
const utilityProcess = {
  fork: undefined,
};
const webContents = {
  fromId(id: number): Record<string, unknown> | undefined {
    log("webContents.fromId", [id]);
    const browserGuest = browserGuestWebContents.get(id);
    if (browserGuest) return browserGuest as unknown as Record<string, unknown>;
    return BrowserWindow.getAllWindows().find(
      (window) => window.webContents.id === id,
    )?.webContents;
  },
  getAllWebContents(): Record<string, unknown>[] {
    log("webContents.getAllWebContents", []);
    return [
      ...BrowserWindow.getAllWindows().map((window) => window.webContents),
      ...[...browserGuestWebContents.values()].map(
        (guest) => guest as unknown as Record<string, unknown>,
      ),
    ];
  },
  getFocusedWebContents(): Record<string, unknown> | null {
    log("webContents.getFocusedWebContents", []);
    return BrowserWindow.getFocusedWindow()?.webContents ?? null;
  },
};
class MessageChannelMain {
  port1 = createMessagePortStub("MessageChannelMain.port1");
  port2 = createMessagePortStub("MessageChannelMain.port2");
}

const electronModule = new Proxy(
  {
    app,
    BrowserWindow,
    ipcMain,
    autoUpdater,
    crashReporter,
    MessageChannelMain,
    Menu,
    MenuItem,
    net,
    nativeImage,
    nativeTheme,
    Notification,
    powerMonitor,
    protocol,
    screen,
    session,
    systemPreferences,
    Tray,
    utilityProcess,
    WebContentsView,
    webContents,
    dialog,
  } as Record<string, unknown>,
  {
    get(target, prop) {
      if (prop in target) {
        return target[prop as keyof typeof target];
      }

      return createDeepStub(`electron.${String(prop)}`);
    },
  },
);

export {
  app,
  autoUpdater,
  BrowserWindow,
  ipcMain,
  Menu,
  MenuItem,
  MessageChannelMain,
  net,
  nativeImage,
  nativeTheme,
  Notification,
  powerMonitor,
  protocol,
  screen,
  session,
  systemPreferences,
  Tray,
  utilityProcess,
  WebContentsView,
  webContents,
  crashReporter,
  dialog,
};
export default electronModule;
