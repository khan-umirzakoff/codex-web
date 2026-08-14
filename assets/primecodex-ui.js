(() => {
  const CONTROL_URL = "/__backend/primecodex/control";
  const SESSIONS_URL = "/__backend/primecodex/sessions";
  const MODE_SWITCH_ATTR = "data-primecodex-mode-switch";
  let state = null;
  let updating = false;
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
      const isPrimeModel = text.startsWith("Prime · GPT-");
      const isNativeModel =
        !isPrimeModel && (/^GPT-/.test(text) || /^o\d/i.test(text));
      if (!isPrimeModel && !isNativeModel) continue;

      const menu = item.closest('[role="menu"]');
      const menuText = (menu?.innerText || "").trim();
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
    if (updating) return;
    updating = true;
    try {
      await syncProjectContext();
      await postControl({
        activeBackend,
        newThreadBackend: activeBackend,
      });
      await refreshSessionIndex();
      applySidebarFilter();
      applyModelPickerFilter();
      await expandPrimeSidebarSessions();
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
    }
  }

  function removeModeSwitch() {
    document.querySelector(`[${MODE_SWITCH_ATTR}]`)?.remove();
  }

  function styleModeButton(button, active) {
    button.style.height = "28px";
    button.style.border = "0";
    button.style.borderRadius = "8px";
    button.style.padding = "0 14px";
    button.style.font = "inherit";
    button.style.fontSize = "13px";
    button.style.fontWeight = active ? "500" : "400";
    button.style.cursor = "pointer";
    button.style.background = active
      ? "var(--color-background-elevated-primary)"
      : "transparent";
    button.style.color = active
      ? "var(--color-text-primary, currentColor)"
      : "var(--color-text-tertiary, currentColor)";
    button.style.opacity = active ? "1" : "0.72";
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

    let control = document.querySelector(`[${MODE_SWITCH_ATTR}]`);
    if (!control) {
      control = document.createElement("div");
      control.setAttribute(MODE_SWITCH_ATTR, "");
      control.setAttribute("role", "group");
      control.setAttribute("aria-label", "Agent backend");
      control.style.position = "fixed";
      control.style.display = "grid";
      control.style.gridTemplateColumns = "1fr 1fr";
      control.style.gap = "2px";
      control.style.height = "32px";
      control.style.padding = "2px";
      control.style.boxSizing = "border-box";
      control.style.border = "1px solid var(--color-border)";
      control.style.borderRadius = "10px";
      control.style.background = "var(--color-background-control)";
      control.style.boxShadow = "0 1px 2px rgba(0,0,0,.18)";
      control.style.zIndex = "2147483000";

      for (const backend of ["codex", "prime"]) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.primecodexBackend = backend;
        button.textContent = backend === "codex" ? "Codex" : "Prime";
        button.addEventListener("click", () => void setBackend(backend));
        control.appendChild(button);
      }
      document.body.appendChild(control);
    }

    const footer = aside.querySelector(
      ".absolute.inset-x-0.bottom-0.z-20",
    );
    const footerTop = footer?.getBoundingClientRect().top ?? asideRect.bottom - 46;
    const width = Math.min(220, Math.max(160, asideRect.width - 16));
    control.style.left = `${asideRect.left + 8}px`;
    control.style.top = `${Math.max(asideRect.top + 8, footerTop - 40)}px`;
    control.style.width = `${width}px`;

    const scrollArea = aside.querySelector(".vertical-scroll-fade-mask");
    if (scrollArea) {
      scrollArea.style.paddingBottom =
        "calc(var(--sidebar-footer-height, 46px) + 52px)";
    }

    const activeBackend = state.activeBackend || "codex";
    for (const button of control.querySelectorAll("button")) {
      const active = button.dataset.primecodexBackend === activeBackend;
      styleModeButton(button, active);
      button.setAttribute("aria-pressed", String(active));
    }
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
    setInterval(render, 250);
    setInterval(() => void refreshSessionIndex().then(applySidebarFilter), 3000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void init(), {
      once: true,
    });
  } else {
    void init();
  }
})();
