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
  | { kind: "text"; text: string };

export type BrowserGuestRendererMessage =
  | {
      type: "browser-webview-attach";
      attachmentId: string;
      attributes: Record<string, string>;
      width: number;
      height: number;
    }
  | { type: "browser-webview-detach"; guestId: number }
  | { type: "browser-webview-activate"; guestId: number }
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

export type BrowserGuestMainMessage =
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
  | { type: "browser-webview-closed"; guestId: number };

type Runtime = {
  attachmentId: string;
  webview: HTMLElement;
  surface: HTMLImageElement;
  resizeObserver: ResizeObserver;
  guestId?: number;
  frameWidth: number;
  frameHeight: number;
  disposed: boolean;
  pendingMove?: PointerEvent;
  moveFrame?: number;
};

function isBrowserSidebarWebview(element: Element): element is HTMLElement {
  return (
    element.tagName === "WEBVIEW" &&
    element.hasAttribute("data-browser-sidebar-conversation-id") &&
    element.hasAttribute("data-browser-sidebar-browser-tab-id")
  );
}

function elementAttributes(element: Element): Record<string, string> {
  return Object.fromEntries(
    [...element.attributes].map((attribute) => [
      attribute.name,
      attribute.value,
    ]),
  );
}

function dimensions(element: HTMLElement): { width: number; height: number } {
  const rect = element.getBoundingClientRect();
  const parentRect = element.parentElement?.getBoundingClientRect();
  return {
    width: Math.max(
      1,
      Math.round(
        rect.width || parentRect?.width || element.clientWidth || 1280,
      ),
    ),
    height: Math.max(
      1,
      Math.round(
        rect.height || parentRect?.height || element.clientHeight || 720,
      ),
    ),
  };
}

function modifierBits(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): number {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0)
  );
}

function pointerButton(button: number): "left" | "middle" | "right" {
  if (button === 1) return "middle";
  if (button === 2) return "right";
  return "left";
}

export class BrowserGuestDomBridge {
  private readonly runtimes = new Set<Runtime>();
  private readonly byAttachment = new Map<string, Runtime>();
  private readonly byGuest = new Map<number, Runtime>();
  private readonly byElement = new WeakMap<HTMLElement, Runtime>();
  private readonly currentUrlByTab = new Map<string, string>();
  private observer?: MutationObserver;
  private panelStyle?: HTMLStyleElement;
  private panelSyncTimer?: ReturnType<typeof setInterval>;
  private panelLayoutSignature = "";
  private activeGuestId?: number;

  constructor(
    private readonly send: (message: BrowserGuestRendererMessage) => void,
  ) {}

  start(): void {
    if (typeof document === "undefined" || this.observer) return;
    this.ensurePanelStyle();
    this.scan(document);
    this.syncRightPanelGeometry();
    this.observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof Element) this.scan(node);
        }
      }
      for (const runtime of [...this.runtimes]) {
        if (!runtime.webview.isConnected) this.disposeRuntime(runtime);
      }
      this.syncRightPanelGeometry();
    });
    this.observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["aria-pressed", "aria-selected", "data-tab-id"],
      childList: true,
      subtree: true,
    });
    this.panelSyncTimer = setInterval(() => {
      this.syncRightPanelGeometry();
    }, 250);
  }

  socketOpened(): void {
    this.activeGuestId = undefined;
    for (const runtime of this.runtimes) {
      if (runtime.disposed || !runtime.webview.isConnected) continue;
      if (runtime.guestId !== undefined) {
        this.byGuest.delete(runtime.guestId);
        runtime.guestId = undefined;
      }
      this.requestAttach(runtime);
    }
  }

  rememberNavigation(
    conversationId: string,
    browserTabId: string,
    url: string,
  ): void {
    if (!url) return;
    this.currentUrlByTab.set(`${conversationId}\0${browserTabId}`, url);
  }

  handleMessage(message: BrowserGuestMainMessage): boolean {
    if (message.type === "browser-webview-attached") {
      const runtime = this.byAttachment.get(message.attachmentId);
      if (!runtime || runtime.disposed) return true;
      runtime.guestId = message.guestId;
      this.byGuest.set(message.guestId, runtime);
      delete runtime.surface.dataset.primecodexBrowserError;
      runtime.surface.removeAttribute("title");
      runtime.surface.alt = "Browser page";
      this.syncRightPanelGeometry();
      const size = dimensions(runtime.webview);
      this.send({
        type: "browser-webview-resize",
        guestId: message.guestId,
        width: size.width,
        height: size.height,
      });
      return true;
    }

    if (message.type === "browser-webview-frame") {
      const runtime = this.byGuest.get(message.guestId);
      if (!runtime || runtime.disposed) return true;
      runtime.frameWidth = message.width;
      runtime.frameHeight = message.height;
      runtime.surface.src = `data:image/jpeg;base64,${message.data}`;
      runtime.surface.dataset.primecodexBrowserReady = "true";
      delete runtime.surface.dataset.primecodexBrowserError;
      this.syncRightPanelGeometry();
      return true;
    }

    if (message.type === "browser-webview-error") {
      const runtime = this.byAttachment.get(message.attachmentId);
      if (!runtime || runtime.disposed) return true;
      runtime.surface.alt = `Browser unavailable: ${message.errorMessage}`;
      runtime.surface.title = message.errorMessage;
      runtime.surface.dataset.primecodexBrowserError = message.errorMessage;
      console.error("[primecodex-browser]", message.errorMessage);
      return true;
    }

    if (message.type === "browser-webview-closed") {
      const runtime = this.byGuest.get(message.guestId);
      if (!runtime) return true;
      this.byGuest.delete(message.guestId);
      runtime.guestId = undefined;
      return true;
    }

    return false;
  }

  dispose(): void {
    this.observer?.disconnect();
    this.observer = undefined;
    if (this.panelSyncTimer) clearInterval(this.panelSyncTimer);
    this.panelSyncTimer = undefined;
    for (const runtime of [...this.runtimes]) this.disposeRuntime(runtime);
    document.documentElement.removeAttribute(
      "data-primecodex-browser-panel-open",
    );
    document.documentElement.style.removeProperty(
      "--primecodex-browser-panel-width",
    );
    this.panelStyle?.remove();
    this.panelStyle = undefined;
    this.panelLayoutSignature = "";
  }

  private scan(root: ParentNode): void {
    if (root instanceof Element && isBrowserSidebarWebview(root)) {
      this.attachElement(root);
    }
    for (const element of root.querySelectorAll?.(
      "webview[data-browser-sidebar-conversation-id][data-browser-sidebar-browser-tab-id]",
    ) ?? []) {
      if (element instanceof HTMLElement) this.attachElement(element);
    }
  }

  private attachElement(webview: HTMLElement): void {
    if (this.byElement.has(webview)) return;
    const surface = document.createElement("img");
    surface.dataset.primecodexBrowserGuestSurface = "true";
    surface.alt = "Browser page";
    surface.draggable = false;
    surface.tabIndex = 0;
    Object.assign(surface.style, {
      background: webview.style.backgroundColor || "var(--color-surface, #fff)",
      height: "100%",
      inset: "0",
      objectFit: "fill",
      outline: "none",
      position: "absolute",
      userSelect: "none",
      width: "100%",
      zIndex: "0",
    });

    // Preserve the native <webview> node and its attributes so the existing
    // renderer lifecycle keeps working. Only the pixels/input surface are
    // replaced in a normal browser, where Electron's guest element is inert.
    // In Chromium, <webview> is an unknown inline element instead of Electron's
    // replaced guest element. Make it participate in layout so the native
    // BrowserSidebar sizing code and our ResizeObserver see the real panel size.
    webview.style.display = "block";
    webview.style.opacity = "0";
    webview.style.pointerEvents = "none";
    const parent = webview.parentElement;
    if (parent) {
      const cursorOverlay = parent.querySelector(
        "[data-browser-sidebar-cursor-overlay-host]",
      );
      parent.insertBefore(surface, cursorOverlay ?? webview.nextSibling);
    }

    const runtime: Runtime = {
      attachmentId: crypto.randomUUID(),
      webview,
      surface,
      resizeObserver: new ResizeObserver(() => this.resizeRuntime(runtime)),
      frameWidth: 1280,
      frameHeight: 720,
      disposed: false,
    };
    this.runtimes.add(runtime);
    this.byAttachment.set(runtime.attachmentId, runtime);
    this.byElement.set(webview, runtime);
    runtime.resizeObserver.observe(webview);
    this.installInputHandlers(runtime);
    this.requestAttach(runtime);
    this.syncRightPanelGeometry();
  }

  private requestAttach(runtime: Runtime): void {
    if (runtime.disposed) return;
    this.byAttachment.delete(runtime.attachmentId);
    runtime.attachmentId = crypto.randomUUID();
    this.byAttachment.set(runtime.attachmentId, runtime);
    const size = dimensions(runtime.webview);
    const attributes = elementAttributes(runtime.webview);
    const conversationId =
      attributes["data-browser-sidebar-conversation-id"] ?? "";
    const browserTabId =
      attributes["data-browser-sidebar-browser-tab-id"] ?? "";
    const rememberedUrl = this.currentUrlByTab.get(
      `${conversationId}\0${browserTabId}`,
    );
    if (
      rememberedUrl &&
      (!attributes.src || attributes.src === "about:blank")
    ) {
      attributes.src = rememberedUrl;
    }
    this.send({
      type: "browser-webview-attach",
      attachmentId: runtime.attachmentId,
      attributes,
      width: size.width,
      height: size.height,
    });
  }

  private resizeRuntime(runtime: Runtime): void {
    if (runtime.disposed || runtime.guestId === undefined) return;
    const size = dimensions(runtime.webview);
    this.send({
      type: "browser-webview-resize",
      guestId: runtime.guestId,
      width: size.width,
      height: size.height,
    });
  }

  private disposeRuntime(runtime: Runtime): void {
    if (runtime.disposed) return;
    runtime.disposed = true;
    runtime.resizeObserver.disconnect();
    if (runtime.moveFrame !== undefined)
      cancelAnimationFrame(runtime.moveFrame);
    this.runtimes.delete(runtime);
    this.byAttachment.delete(runtime.attachmentId);
    if (runtime.guestId !== undefined) {
      this.byGuest.delete(runtime.guestId);
      this.send({ type: "browser-webview-detach", guestId: runtime.guestId });
    }
    runtime.surface.remove();
    this.syncRightPanelGeometry();
  }

  private ensurePanelStyle(): void {
    if (this.panelStyle?.isConnected) return;
    const style = document.createElement("style");
    style.dataset.primecodexBrowserPanelLayout = "true";
    style.textContent = `
      html[data-primecodex-browser-panel-open="true"]
        aside[data-app-shell-focus-area="right-panel"] {
        position: fixed !important;
        inset: 0 0 0 auto !important;
        width: var(--primecodex-browser-panel-width) !important;
        height: 100vh !important;
        z-index: 80 !important;
        opacity: 1 !important;
        transform: none !important;
      }
      html[data-primecodex-browser-panel-open="true"]
        [data-primecodex-browser-host-shift="true"] {
        transform: translateX(calc(-1 * var(--primecodex-browser-panel-width))) !important;
      }
    `;
    document.head.append(style);
    this.panelStyle = style;
  }

  private syncRightPanelGeometry(): void {
    const root = document.documentElement;
    const aside = document.querySelector<HTMLElement>(
      'aside[data-app-shell-focus-area="right-panel"]',
    );
    const nativeToggleOpen = [
      ...document.querySelectorAll<HTMLElement>(
        'button[aria-label="Toggle side panel"]',
      ),
    ].some((button) => button.getAttribute("aria-pressed") === "true");
    const hasRightPanelTabs = Boolean(
      aside?.querySelector('[data-app-shell-tabs="true"] [role="tab"]'),
    );
    const isOpen = nativeToggleOpen || hasRightPanelTabs;
    const selectedTab = aside?.querySelector<HTMLElement>(
      '[role="tab"][aria-selected="true"]',
    );
    const selectedTabId = selectedTab
      ?.closest<HTMLElement>(
        '[data-app-shell-tab-controller="right"][data-tab-id]',
      )
      ?.getAttribute("data-tab-id");
    const runtime = selectedTabId
      ? [...this.runtimes].find(
          (candidate) =>
            candidate.webview.getAttribute(
              "data-browser-sidebar-browser-tab-id",
            ) === selectedTabId,
        )
      : undefined;

    if (
      runtime?.guestId !== undefined &&
      runtime.guestId !== this.activeGuestId
    ) {
      this.activeGuestId = runtime.guestId;
      this.send({ type: "browser-webview-activate", guestId: runtime.guestId });
    }

    if (!aside || !isOpen) {
      root.removeAttribute("data-primecodex-browser-panel-open");
      root.style.removeProperty("--primecodex-browser-panel-width");
      for (const candidate of this.runtimes) {
        candidate.webview.parentElement?.removeAttribute(
          "data-primecodex-browser-host-shift",
        );
      }
      this.notifyNativePanelGeometryChanged("closed");
      return;
    }

    // Measure the native shell without our compatibility transform first.
    // Some Desktop builds eventually lay the right panel inside the viewport
    // themselves. Others park it exactly at the right edge and rely on an
    // Electron BrowserWindow expansion that does not exist in a web browser.
    // Only compensate for the parked-outside case so newer native layouts are
    // never shifted twice.
    root.removeAttribute("data-primecodex-browser-panel-open");
    const tabs = aside.querySelector<HTMLElement>(
      '[data-app-shell-tabs="true"]',
    );
    const naturalAside = aside.getBoundingClientRect();
    const naturalTabs = tabs?.getBoundingClientRect();
    const width =
      naturalTabs?.width ||
      runtime?.webview.parentElement?.getBoundingClientRect().width ||
      runtime?.webview.getBoundingClientRect().width ||
      aside.firstElementChild?.getBoundingClientRect().width ||
      0;
    if (!Number.isFinite(width) || width <= 0) return;

    const parkedOutsideViewport =
      naturalAside.width <= 1 ||
      naturalAside.left >= window.innerWidth - 2 ||
      (naturalTabs?.left ?? 0) >= window.innerWidth - 2 ||
      (naturalTabs?.right ?? 0) > window.innerWidth + 2;
    if (!parkedOutsideViewport) {
      root.style.removeProperty("--primecodex-browser-panel-width");
      this.notifyNativePanelGeometryChanged("native");
      return;
    }

    const roundedWidth = Math.round(width * 1000) / 1000;
    root.style.setProperty(
      "--primecodex-browser-panel-width",
      `${roundedWidth}px`,
    );
    root.setAttribute("data-primecodex-browser-panel-open", "true");

    for (const candidate of this.runtimes) {
      const host = candidate.webview.parentElement;
      if (!host) continue;
      host.removeAttribute("data-primecodex-browser-host-shift");
      const naturalHost = host.getBoundingClientRect();
      if (naturalHost.left >= window.innerWidth - 2) {
        host.setAttribute("data-primecodex-browser-host-shift", "true");
      }
    }
    this.notifyNativePanelGeometryChanged(`fixed:${roundedWidth}`);
  }

  private notifyNativePanelGeometryChanged(signature: string): void {
    if (this.panelLayoutSignature === signature) return;
    this.panelLayoutSignature = signature;

    // The native BrowserSidebar hook measures its host in a layout effect and
    // publishes those bounds to BrowserSidebarManager. Our browser-only panel
    // compensation changes geometry outside React, so explicitly trigger the
    // same resize path after the CSS has taken effect. A second animation frame
    // catches the native panel's own follow-up layout without turning the 250ms
    // compatibility poll into a resize loop.
    requestAnimationFrame(() => {
      window.dispatchEvent(new Event("resize"));
      requestAnimationFrame(() => {
        window.dispatchEvent(new Event("resize"));
      });
    });
  }

  private installInputHandlers(runtime: Runtime): void {
    const { surface } = runtime;
    const point = (event: { clientX: number; clientY: number }) => {
      const rect = surface.getBoundingClientRect();
      return {
        x:
          ((event.clientX - rect.left) / Math.max(1, rect.width)) *
          runtime.frameWidth,
        y:
          ((event.clientY - rect.top) / Math.max(1, rect.height)) *
          runtime.frameHeight,
      };
    };
    const sendInput = (input: BrowserGuestInput): void => {
      if (runtime.guestId === undefined) return;
      this.send({
        type: "browser-webview-input",
        guestId: runtime.guestId,
        input,
      });
    };

    surface.addEventListener("pointerdown", (event) => {
      if (event.button > 2) return;
      event.preventDefault();
      surface.focus({ preventScroll: true });
      runtime.webview.focus({ preventScroll: true });
      try {
        surface.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is best effort in headless test browsers.
      }
      const p = point(event);
      sendInput({
        kind: "pointer",
        phase: "down",
        x: p.x,
        y: p.y,
        button: pointerButton(event.button),
        buttons: event.buttons,
        clickCount: event.detail || 1,
        modifiers: modifierBits(event),
      });
    });

    surface.addEventListener("pointerup", (event) => {
      if (event.button > 2) return;
      event.preventDefault();
      const p = point(event);
      sendInput({
        kind: "pointer",
        phase: "up",
        x: p.x,
        y: p.y,
        button: pointerButton(event.button),
        buttons: event.buttons,
        clickCount: event.detail || 1,
        modifiers: modifierBits(event),
      });
    });

    surface.addEventListener("pointermove", (event) => {
      runtime.pendingMove = event;
      if (runtime.moveFrame !== undefined) return;
      runtime.moveFrame = requestAnimationFrame(() => {
        runtime.moveFrame = undefined;
        const pending = runtime.pendingMove;
        runtime.pendingMove = undefined;
        if (!pending) return;
        const p = point(pending);
        sendInput({
          kind: "pointer",
          phase: "move",
          x: p.x,
          y: p.y,
          buttons: pending.buttons,
          modifiers: modifierBits(pending),
        });
      });
    });

    surface.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const p = point(event);
        sendInput({
          kind: "wheel",
          x: p.x,
          y: p.y,
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          modifiers: modifierBits(event),
        });
      },
      { passive: false },
    );

    surface.addEventListener("contextmenu", (event) => event.preventDefault());

    surface.addEventListener("keydown", (event) => {
      event.preventDefault();
      const text =
        event.key.length === 1 && !event.ctrlKey && !event.metaKey
          ? event.key
          : undefined;
      sendInput({
        kind: "key",
        phase: "down",
        key: event.key,
        code: event.code,
        text,
        modifiers: modifierBits(event),
      });
    });

    surface.addEventListener("keyup", (event) => {
      event.preventDefault();
      sendInput({
        kind: "key",
        phase: "up",
        key: event.key,
        code: event.code,
        modifiers: modifierBits(event),
      });
    });

    surface.addEventListener("paste", (event) => {
      const text = event.clipboardData?.getData("text/plain");
      if (!text) return;
      event.preventDefault();
      sendInput({ kind: "text", text });
    });
  }
}
