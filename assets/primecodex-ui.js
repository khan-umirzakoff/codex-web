(() => {
  const CONTROL_URL = "/__backend/primecodex/control";
  const SESSIONS_URL = "/__backend/primecodex/sessions";
  const TOGGLE_ATTR = "data-primecodex-backend-toggle";
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
      await expandPrimeSidebarSessions();
    } finally {
      updating = false;
      render();
    }
  }

  function removeToggle() {
    document.querySelector(`[${TOGGLE_ATTR}]`)?.remove();
  }

  function positionToggle(button, reasoningButton) {
    const rect = reasoningButton.getBoundingClientRect();
    const width = 58;
    button.style.position = "fixed";
    button.style.left = `${Math.max(8, rect.left - width - 6)}px`;
    button.style.top = `${rect.top}px`;
    button.style.width = `${width}px`;
    button.style.height = `${rect.height}px`;
    button.style.zIndex = "2147483000";
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
    if (!state?.enabled) {
      removeToggle();
      return;
    }

    const reasoningButton = document.querySelector(
      'button[data-composer-navigation-target="reasoning"]',
    );
    if (!reasoningButton?.parentElement) {
      removeToggle();
      return;
    }

    const projectButton = document.querySelector(
      'button[data-composer-navigation-target="workspace-project"]',
    );
    const projectLabel = projectButton?.innerText?.trim() || null;
    if (projectLabel !== lastProjectLabel) {
      lastProjectLabel = projectLabel;
      void syncProjectContext();
    }

    let button = document.querySelector(`[${TOGGLE_ATTR}]`);
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.setAttribute(TOGGLE_ATTR, "");
      button.setAttribute(
        "data-composer-navigation-target",
        "primecodex-backend",
      );
      button.className = reasoningButton.className;
      button.style.paddingInline = "10px";
      button.style.whiteSpace = "nowrap";
      button.addEventListener("click", () => {
        const next = state?.activeBackend === "prime" ? "codex" : "prime";
        void setBackend(next);
      });
      document.body.appendChild(button);
    }

    positionToggle(button, reasoningButton);

    const isPrime = state.activeBackend === "prime";
    button.textContent = isPrime ? "Prime" : "Codex";
    button.setAttribute(
      "aria-label",
      `Workspace backend: ${isPrime ? "Prime Agent" : "Codex"}`,
    );
    button.title = `Workspace backend: ${isPrime ? "Prime Agent" : "Codex"}`;
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
