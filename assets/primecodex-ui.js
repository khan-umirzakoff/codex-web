(() => {
  const CONTROL_URL = "/__backend/primecodex/control";
  const SESSIONS_URL = "/__backend/primecodex/sessions";
  const MODE_SWITCH_ATTR = "data-primecodex-mode-switch";
  const MODE_MENU_ATTR = "data-primecodex-mode-menu";
  const MODE_STYLE_ATTR = "data-primecodex-mode-style";
  const MODE_SWITCH_VERSION = "native-slot-v2";
  const NATIVE_MODE_TRIGGER_SELECTOR =
    'button[aria-label^="Switch mode, current mode:"]';
  let state = null;
  let updating = false;
  let pendingBackend = null;
  let modeSwitchObserver = null;
  let observedModeHeader = null;
  let lastProjectLabel = null;
  let lastPathname = location.pathname;
  let primeThreadIds = new Set();

  function requestCodexGlobalState(key) {
    const bridge = window.electronBridge;
    if (!bridge?.sendMessageFromView) return Promise.resolve(null);
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        window.removeEventListener("message", onMessage);
        resolve(null);
      }, 2500);
      function onMessage(event) {
        const payload = event.data;
        if (
          payload?.type !== "fetch-response" ||
          payload.requestId !== requestId
        )
          return;
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        if (payload.responseType !== "success") {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(payload.bodyJsonString || "{}"));
        } catch {
          resolve(null);
        }
      }
      window.addEventListener("message", onMessage);
      void bridge
        .sendMessageFromView({
          requestId,
          method: "POST",
          url: "vscode://codex/get-global-state",
          body: JSON.stringify({ key }),
          type: "fetch",
        })
        .catch(() => {
          clearTimeout(timer);
          window.removeEventListener("message", onMessage);
          resolve(null);
        });
    });
  }

  async function postControl(patch) {
    const response = await fetch(CONTROL_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (response.ok) state = await response.json();
  }

  async function syncProjectContext() {
    const [activeResult, projectsResult] = await Promise.all([
      requestCodexGlobalState("active-workspace-roots"),
      requestCodexGlobalState("local-projects"),
    ]);
    const active = Array.isArray(activeResult?.value) ? activeResult.value : [];
    const projectId = typeof active[0] === "string" ? active[0] : null;
    const projects =
      projectsResult?.value && typeof projectsResult.value === "object"
        ? projectsResult.value
        : {};
    const metadataProject = projectId ? projects[projectId] : null;
    let roots = Array.isArray(metadataProject?.rootPaths)
      ? metadataProject.rootPaths.filter(
          (value) => typeof value === "string" && value.length > 0,
        )
      : [];
    if (roots.length === 0 && projectId?.startsWith("/")) roots = [projectId];
    await postControl({
      selectedProjectId: projectId,
      projectCwd: roots[0] ?? null,
      projectRoots: roots.length > 0 ? roots : null,
    });
  }

  async function fetchState() {
    try {
      const response = await fetch(CONTROL_URL, { cache: "no-store" });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  }

  async function refreshSessionIndex() {
    try {
      const response = await fetch(SESSIONS_URL, { cache: "no-store" });
      if (!response.ok) return;
      const payload = await response.json();
      primeThreadIds = new Set(
        Array.isArray(payload?.primeThreadIds) ? payload.primeThreadIds : [],
      );
    } catch {}
  }

  function sidebarThreadId(row) {
    const raw = row.getAttribute("data-app-action-sidebar-thread-id") || "";
    const separator = raw.indexOf(":");
    return separator >= 0 ? raw.slice(separator + 1) : raw;
  }

  function applySidebarFilter() {
    if (!state?.enabled) return;
    const showPrime = state.activeBackend === "prime";
    for (const row of document.querySelectorAll(
      "[data-app-action-sidebar-thread-id]",
    )) {
      const item = row.closest('[role="listitem"]') || row;
      const isPrime = primeThreadIds.has(sidebarThreadId(row));
      const visible = showPrime ? isPrime : !isPrime;
      item.style.display = visible ? "" : "none";
      item.toggleAttribute("data-primecodex-hidden", !visible);
    }
  }

  function normalizeVisibleModelLabel(element, showPrime) {
    for (const leaf of element.querySelectorAll("span,div")) {
      if (leaf.children.length > 0) continue;
      const text = (leaf.textContent || "").trim();
      if (!text) continue;
      if (!showPrime && text.startsWith("Prime · GPT-")) {
        leaf.textContent = text.slice("Prime · ".length);
      } else if (showPrime && /^GPT-/.test(text)) {
        leaf.textContent = `Prime · ${text}`;
      }
    }
  }

  function applyModelPickerFilter() {
    if (!state?.enabled) return;
    const showPrime = state.activeBackend === "prime";

    const reasoningButton = document.querySelector(
      'button[data-composer-navigation-target="reasoning"]',
    );
    if (reasoningButton) normalizeVisibleModelLabel(reasoningButton, showPrime);

    const candidates = document.querySelectorAll(
      '[role="menuitem"], [role="menuitemradio"], [role="option"], [data-radix-collection-item], button',
    );
    for (const item of candidates) {
      const text = (item.innerText || "").trim().replace(/\s+/g, " ");
      const menu = item.closest('[role="menu"]');
      const menuText = (menu?.innerText || "").trim();
      const isPrimeModel = text.startsWith("Prime · GPT-");
      const isHybridModelMenu = menuText.includes("Prime · GPT-");

      if (isHybridModelMenu) {
        const visible = showPrime ? isPrimeModel : !isPrimeModel;
        item.style.display = visible ? "" : "none";
        item.toggleAttribute("data-primecodex-model-hidden", !visible);
        continue;
      }

      const isNativeModel =
        !isPrimeModel && (/^GPT-/.test(text) || /^o\d/i.test(text));
      if (!isPrimeModel && !isNativeModel) continue;

      const isReasoningMenu =
        menuText.includes("Reasoning") && menuText.includes("Extra High");
      if (isReasoningMenu) {
        item.style.display = "";
        normalizeVisibleModelLabel(item, showPrime);
        continue;
      }

      const visible = showPrime ? isPrimeModel : isNativeModel;
      item.style.display = visible ? "" : "none";
      item.toggleAttribute("data-primecodex-model-hidden", !visible);
    }
  }

  async function expandPrimeSidebarSessions() {
    if (state?.activeBackend !== "prime") return;
    for (let pass = 0; pass < 8; pass += 1) {
      const sidebar = document.querySelector("aside");
      if (!sidebar) return;
      const buttons = [...sidebar.querySelectorAll("button")].filter(
        (button) =>
          (button.innerText || "").trim() === "Show more" &&
          !button.disabled &&
          button.getBoundingClientRect().height > 0,
      );
      if (buttons.length === 0) return;
      for (const button of buttons) button.click();
      await new Promise((resolve) => setTimeout(resolve, 180));
      applySidebarFilter();
    }
  }

  async function armActiveBackendForNewTask() {
    if (!state?.enabled || location.pathname !== "/") return;
    const activeBackend = state.activeBackend || "codex";
    if (state.newThreadBackend === activeBackend) return;
    await postControl({ newThreadBackend: activeBackend });
  }

  async function setBackend(activeBackend) {
    closeModeMenu();
    if (updating) {
      pendingBackend = activeBackend;
      return;
    }
    updating = true;
    try {
      // Flip the visible/backend state first. Project synchronization can take a
      // couple of seconds while the Electron global-state bridge wakes up, and
      // should not make the native-style selector look unresponsive.
      await postControl({
        activeBackend,
        newThreadBackend: activeBackend,
      });
      render();
      await syncProjectContext();
      await refreshSessionIndex();
      applySidebarFilter();
      applyModelPickerFilter();
      void expandPrimeSidebarSessions();
      if (location.pathname !== "/") {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: { type: "navigate-to-route", path: "/" },
          }),
        );
      }
    } finally {
      updating = false;
      render();
      const queuedBackend = pendingBackend;
      pendingBackend = null;
      if (queuedBackend && queuedBackend !== state?.activeBackend) {
        void setBackend(queuedBackend);
      }
    }
  }

  function backendLabel(backend) {
    return backend === "prime" ? "Prime" : "Codex";
  }

  function backendAccessibleLabel(backend) {
    return backend === "prime" ? "Prime Agent" : "Codex";
  }

  function backendDescription(backend) {
    return backend === "prime"
      ? "RLM harness and subagents"
      : "Build, debug, and ship";
  }

  function closeModeMenu() {
    const control = document.querySelector(`[${MODE_SWITCH_ATTR}]`);
    const menu = document.querySelector(`[${MODE_MENU_ATTR}]`);
    if (!control || !menu) return;
    menu.hidden = true;
    const trigger = control.querySelector("[data-primecodex-mode-trigger]");
    trigger?.setAttribute("aria-expanded", "false");
  }

  function positionModeMenu(control, menu) {
    const trigger = control.querySelector("[data-primecodex-mode-trigger]");
    if (!trigger || menu.hidden) return;
    const rect = trigger.getBoundingClientRect();
    menu.style.left = `${Math.round(rect.left)}px`;
    menu.style.top = `${Math.round(rect.bottom + 4)}px`;
    menu.style.width = "240px";
  }

  function toggleModeMenu(control) {
    const menu = document.querySelector(`[${MODE_MENU_ATTR}]`);
    if (!menu) return;
    const opening = menu.hidden;
    if (!opening) {
      closeModeMenu();
      return;
    }
    menu.hidden = false;
    control
      .querySelector("[data-primecodex-mode-trigger]")
      ?.setAttribute("aria-expanded", "true");
    positionModeMenu(control, menu);
  }

  function checkIcon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    svg.style.width = "16px";
    svg.style.height = "16px";
    svg.style.flex = "0 0 auto";
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("fill", "currentColor");
    path.setAttribute(
      "d",
      "M13.03 4.97a.75.75 0 0 1 0 1.06l-6.25 6.25a.75.75 0 0 1-1.06 0L2.97 9.53a.75.75 0 0 1 1.06-1.06l2.22 2.22 5.72-5.72a.75.75 0 0 1 1.06 0Z",
    );
    svg.appendChild(path);
    return svg;
  }

  function chevronIcon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("data-primecodex-mode-chevron", "");
    svg.style.width = "12px";
    svg.style.height = "12px";
    svg.classList.add("icon-2xs", "shrink-0", "text-tertiary");
    svg.style.flex = "0 0 auto";
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("fill", "currentColor");
    path.setAttribute(
      "d",
      "M3.47 5.72a.75.75 0 0 1 1.06 0L8 9.19l3.47-3.47a.75.75 0 1 1 1.06 1.06l-4 4a.75.75 0 0 1-1.06 0l-4-4a.75.75 0 0 1 0-1.06Z",
    );
    svg.appendChild(path);
    return svg;
  }

  function createModeMenu() {
    const menu = document.createElement("div");
    menu.setAttribute(MODE_MENU_ATTR, "");
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "Agent backend");
    menu.hidden = true;
    menu.className =
      "border-token-border bg-token-main-surface-primary text-token-foreground";
    menu.style.position = "fixed";
    menu.style.zIndex = "2147483001";
    menu.style.boxSizing = "border-box";
    menu.style.padding = "6px";
    menu.style.borderWidth = "1px";
    menu.style.borderStyle = "solid";
    menu.style.borderRadius = "12px";
    menu.style.boxShadow = "0 8px 28px rgba(0, 0, 0, 0.18)";

    for (const backend of ["codex", "prime"]) {
      const option = document.createElement("button");
      option.type = "button";
      option.dataset.primecodexBackend = backend;
      option.setAttribute("role", "menuitemradio");
      option.className =
        "text-token-foreground hover:bg-token-list-hover-background";
      option.style.width = "100%";
      option.style.display = "flex";
      option.style.alignItems = "center";
      option.style.gap = "12px";
      option.style.padding = "10px 10px";
      option.style.border = "0";
      option.style.borderRadius = "8px";
      option.style.background = "transparent";
      option.style.font = "inherit";
      option.style.textAlign = "left";
      option.style.cursor = "pointer";

      const copy = document.createElement("span");
      copy.style.display = "flex";
      copy.style.minWidth = "0";
      copy.style.flex = "1";
      copy.style.flexDirection = "column";
      copy.style.gap = "2px";

      const title = document.createElement("span");
      title.dataset.primecodexOptionTitle = "";
      title.textContent = backend === "prime" ? "Prime Agent" : "Codex";
      title.className = "font-openai-sans";
      title.style.fontSize = "16px";
      title.style.lineHeight = "20px";
      title.style.fontWeight = "500";

      const subtext = document.createElement("span");
      subtext.textContent = backendDescription(backend);
      subtext.className = "text-token-description-foreground";
      subtext.style.fontSize = "13px";
      subtext.style.lineHeight = "18px";
      subtext.style.fontWeight = "400";

      copy.append(title, subtext);
      const check = checkIcon();
      check.dataset.primecodexModeCheck = "";
      option.append(copy, check);
      option.addEventListener("click", () => {
        closeModeMenu();
        void setBackend(backend);
      });
      menu.appendChild(option);
    }

    document.body.appendChild(menu);
    return menu;
  }

  function removeModeSwitch() {
    document.querySelector(`[${MODE_SWITCH_ATTR}]`)?.remove();
    document.querySelector(`[${MODE_MENU_ATTR}]`)?.remove();
    document.querySelector(`[${MODE_STYLE_ATTR}]`)?.remove();
    for (const nativeTrigger of document.querySelectorAll(
      "[data-primecodex-native-mode-trigger]",
    )) {
      nativeTrigger.style.removeProperty("display");
      nativeTrigger.removeAttribute("data-primecodex-native-mode-trigger");
    }
    const scrollArea = document.querySelector(
      "aside.app-shell-left-panel .vertical-scroll-fade-mask",
    );
    if (scrollArea?.style.paddingBottom.includes("52px")) {
      scrollArea.style.removeProperty("padding-bottom");
    }
  }

  function ensureModeSwitchStyle() {
    if (document.querySelector(`[${MODE_STYLE_ATTR}]`)) return;
    const style = document.createElement("style");
    style.setAttribute(MODE_STYLE_ATTR, "");
    style.textContent = `
      aside.app-shell-left-panel button[aria-label^="Switch mode, current mode:"] {
        display: none !important;
      }
    `;
    document.head.appendChild(style);
  }

  function observeModeSwitchHeader(header) {
    if (observedModeHeader === header && modeSwitchObserver) return;
    modeSwitchObserver?.disconnect();
    observedModeHeader = header;
    modeSwitchObserver = new MutationObserver(() => {
      if (!document.querySelector(`[${MODE_SWITCH_ATTR}]`)) {
        queueMicrotask(ensureModeSwitch);
      }
    });
    modeSwitchObserver.observe(header, { childList: true, subtree: true });
  }

  function ensureModeSwitch() {
    const aside = document.querySelector("aside.app-shell-left-panel");
    if (!state?.enabled || !aside) {
      removeModeSwitch();
      return;
    }
    const asideRect = aside.getBoundingClientRect();
    if (asideRect.width < 120 || asideRect.height < 120) {
      removeModeSwitch();
      return;
    }

    const nav = aside.querySelector('nav[role="navigation"]');
    const header = nav?.firstElementChild;
    if (!header) {
      removeModeSwitch();
      return;
    }
    ensureModeSwitchStyle();
    observeModeSwitchHeader(header);

    const nativeTrigger = [
      ...header.querySelectorAll(NATIVE_MODE_TRIGGER_SELECTOR),
    ].find(
      (candidate) => !candidate.hasAttribute("data-primecodex-mode-trigger"),
    );
    const nativeHost = nativeTrigger?.parentElement ?? null;
    if (nativeTrigger) {
      nativeTrigger.setAttribute("data-primecodex-native-mode-trigger", "");
      nativeTrigger.style.setProperty("display", "none", "important");
    }

    let control = document.querySelector(`[${MODE_SWITCH_ATTR}]`);
    if (control?.dataset.primecodexModeSwitchVersion !== MODE_SWITCH_VERSION) {
      removeModeSwitch();
      control = null;
    }

    let menu = document.querySelector(`[${MODE_MENU_ATTR}]`);
    if (!control) {
      control = document.createElement("div");
      control.setAttribute(MODE_SWITCH_ATTR, "");
      control.dataset.primecodexModeSwitchVersion = MODE_SWITCH_VERSION;
      control.className = nativeHost
        ? "contents"
        : "ml-2 flex h-8 shrink-0 items-center";

      const trigger = nativeTrigger
        ? nativeTrigger.cloneNode(true)
        : document.createElement("button");
      trigger.type = "button";
      trigger.dataset.primecodexModeTrigger = "";
      trigger.removeAttribute("data-primecodex-native-mode-trigger");
      trigger.removeAttribute("id");
      trigger.removeAttribute("aria-controls");
      trigger.removeAttribute("data-state");
      trigger.style.removeProperty("display");
      trigger.setAttribute("aria-haspopup", "menu");
      trigger.setAttribute("aria-expanded", "false");
      if (!nativeTrigger) {
        trigger.className =
          "flex h-8 min-w-0 cursor-interaction items-center gap-1 rounded-xl px-2 !text-[17px] !leading-6 font-medium text-token-foreground hover:bg-token-list-hover-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0";
        trigger.style.marginInlineStart = "-8px";
        const label = document.createElement("span");
        label.className =
          "truncate font-openai-sans font-semibold text-token-foreground";
        trigger.append(label, chevronIcon());
      }
      const label =
        trigger.querySelector("span.font-openai-sans.font-semibold") ??
        trigger.querySelector("span");
      if (label) label.dataset.primecodexModeLabel = "";
      trigger.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleModeMenu(control);
      });
      control.appendChild(trigger);
      if (nativeHost && nativeTrigger) {
        nativeHost.insertBefore(control, nativeTrigger);
      } else {
        header.prepend(control);
      }
      if (!menu) menu = createModeMenu();
    } else {
      const expectedHost = nativeHost ?? header;
      if (control.parentElement !== expectedHost) {
        if (nativeHost && nativeTrigger) {
          nativeHost.insertBefore(control, nativeTrigger);
        } else {
          header.prepend(control);
        }
      }
    }
    if (!menu) menu = createModeMenu();

    const scrollArea = aside.querySelector(".vertical-scroll-fade-mask");
    if (scrollArea?.style.paddingBottom.includes("52px")) {
      scrollArea.style.removeProperty("padding-bottom");
    }

    const activeBackend = state.activeBackend || "codex";
    const trigger = control.querySelector("[data-primecodex-mode-trigger]");
    const label = control.querySelector("[data-primecodex-mode-label]");
    if (label) label.textContent = backendLabel(activeBackend);
    if (trigger) {
      trigger.setAttribute(
        "aria-label",
        `Switch backend, current backend: ${backendAccessibleLabel(activeBackend)}`,
      );
    }
    for (const option of menu.querySelectorAll("[data-primecodex-backend]")) {
      const active = option.dataset.primecodexBackend === activeBackend;
      option.setAttribute("aria-checked", String(active));
      const check = option.querySelector("[data-primecodex-mode-check]");
      if (check) check.style.visibility = active ? "visible" : "hidden";
    }

    if (!menu.hidden) positionModeMenu(control, menu);
  }

  function render() {
    if (location.pathname !== lastPathname) {
      lastPathname = location.pathname;
      if (lastPathname === "/") {
        void (async () => {
          state = (await fetchState()) ?? state;
          await syncProjectContext();
          await armActiveBackendForNewTask();
          render();
        })();
      }
    }

    applySidebarFilter();
    applyModelPickerFilter();
    if (!state?.enabled) {
      removeModeSwitch();
      return;
    }

    ensureModeSwitch();

    const projectButton = document.querySelector(
      'button[data-composer-navigation-target="workspace-project"]',
    );
    const projectLabel = projectButton?.innerText?.trim() || null;
    if (projectLabel !== lastProjectLabel) {
      lastProjectLabel = projectLabel;
      void syncProjectContext();
    }
  }

  async function init() {
    state = await fetchState();
    await refreshSessionIndex();
    await syncProjectContext();
    await armActiveBackendForNewTask();
    render();
    document.addEventListener("pointerdown", (event) => {
      const control = document.querySelector(`[${MODE_SWITCH_ATTR}]`);
      const menu = document.querySelector(`[${MODE_MENU_ATTR}]`);
      if (!control || !menu || menu.hidden) return;
      if (!control.contains(event.target) && !menu.contains(event.target)) {
        closeModeMenu();
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeModeMenu();
    });
    window.addEventListener("resize", () => {
      const control = document.querySelector(`[${MODE_SWITCH_ATTR}]`);
      const menu = document.querySelector(`[${MODE_MENU_ATTR}]`);
      if (control && menu && !menu.hidden) positionModeMenu(control, menu);
    });
    setInterval(render, 250);
    setInterval(
      () => void refreshSessionIndex().then(applySidebarFilter),
      3000,
    );
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void init(), {
      once: true,
    });
  } else {
    void init();
  }
})();
