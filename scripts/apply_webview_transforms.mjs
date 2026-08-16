import fs from "node:fs";
import path from "node:path";

const asarDir = process.argv[2];
if (!asarDir) throw new Error("usage: apply_webview_transforms.mjs <asar-dir>");

function read(relativePath) {
  return fs.readFileSync(path.join(asarDir, relativePath), "utf8");
}

function write(relativePath, source) {
  fs.writeFileSync(path.join(asarDir, relativePath), source);
}

function replaceOnce(source, from, to, label) {
  const first = source.indexOf(from);
  if (first < 0) throw new Error(`transform anchor not found: ${label}`);
  if (source.indexOf(from, first + from.length) >= 0) {
    throw new Error(`transform anchor is not unique: ${label}`);
  }
  return source.slice(0, first) + to + source.slice(first + from.length);
}

function replaceRegexOnce(source, pattern, replacer, label) {
  const matches = [...source.matchAll(pattern)];
  if (matches.length === 0) {
    throw new Error(`transform anchor not found: ${label}`);
  }
  if (matches.length !== 1) {
    throw new Error(`transform anchor is not unique: ${label}`);
  }
  return source.replace(pattern, replacer);
}

function ensureAfter(source, anchor, addition, label) {
  if (source.includes(addition)) return source;
  return replaceOnce(source, anchor, `${anchor}${addition}`, label);
}

function findAssetContaining(needle) {
  const assetsDir = path.join(asarDir, "webview", "assets");
  const matches = [];
  for (const name of fs.readdirSync(assetsDir)) {
    if (!name.endsWith(".js")) continue;
    const full = path.join(assetsDir, name);
    const source = fs.readFileSync(full, "utf8");
    if (source.includes(needle)) matches.push({ name, source });
  }
  if (matches.length !== 1) {
    throw new Error(
      `expected one asset containing ${JSON.stringify(needle)}, found ${matches.length}: ${matches.map((match) => match.name).join(", ")}`,
    );
  }
  return matches[0];
}

function transformIndexHtml() {
  const file = "webview/index.html";
  let source = read(file);
  source = source.replace(
    /\s*<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>/i,
    "",
  );
  source = ensureAfter(
    source,
    "<!-- PROD_BASE_TAG_HERE -->",
    '\n    <base href="/" />',
    "base href",
  );
  source = ensureAfter(
    source,
    "<!-- PROD_CSP_TAG_HERE -->",
    '\n    <script type="module" src="./assets/preload.js"></script>\n    <script defer src="./primecodex-ui.js"></script>',
    "browser preload scripts",
  );
  source = ensureAfter(
    source,
    "<title>Codex</title>",
    '\n    <link rel="icon" type="image/svg+xml" href="./favicon.svg" />\n    <link rel="manifest" href="/manifest.json" />',
    "favicon and manifest",
  );
  if (!source.includes("--spacing-token-safe-header-left: 0px")) {
    source = source.replace(
      /(<script\s+type=["']module["'])/,
      "<style>.main-surface{--spacing-token-safe-header-left:0px}</style>\n    $1",
    );
  }
  write(file, source);
}

function transformMainBundle() {
  const asset = findAssetContaining("v5Compat:!0");
  let source = asset.source;

  if (!source.includes("window.__ELECTRON_SHIM__.initialRoute")) {
    source = replaceRegexOnce(
      source,
      /([$A-Za-z_][$\w]*\.current\?\?=)([$A-Za-z_][$\w]*)\(\{initialEntries:([$A-Za-z_][$\w]*),initialIndex:([$A-Za-z_][$\w]*),v5Compat:!0\}\);/g,
      (_match, assignment, factory, initialEntries, initialIndex) =>
        `${assignment}${factory}({initialEntries:${initialEntries}??[window.__ELECTRON_SHIM__.initialRoute],initialIndex:${initialIndex},v5Compat:!0});`,
      "memory router initial route",
    );
  }
  const routerAnchor = source.indexOf("v5Compat:!0");
  if (routerAnchor < 0) {
    throw new Error(
      "transform anchor not found: memory router navigation callback",
    );
  }
  const routerWindowStart = Math.max(0, routerAnchor - 1200);
  const routerWindowEnd = Math.min(source.length, routerAnchor + 1800);
  let routerWindow = source.slice(routerWindowStart, routerWindowEnd);
  if (
    !routerWindow.includes(
      "window.__ELECTRON_SHIM__.onMemoryNavigationChanged?.(",
    )
  ) {
    routerWindow = replaceRegexOnce(
      routerWindow,
      /([$A-Za-z_][$\w]*)=([$A-Za-z_][$\w]*)\.useCallback\(e=>\{([$A-Za-z_][$\w]*)===!1\?([$A-Za-z_][$\w]*)\(e\):\2\.startTransition\(\(\)=>\4\(e\)\)\},\[\3\]\);/g,
      (_match, target, react, transitions, commit) =>
        `${target}=${react}.useCallback(e=>{window.__ELECTRON_SHIM__.onMemoryNavigationChanged?.(e),${transitions}===!1?${commit}(e):${react}.startTransition(()=>${commit}(e))},[${transitions}]);`,
      "memory router navigation callback",
    );
  }
  source =
    source.slice(0, routerWindowStart) +
    routerWindow +
    source.slice(routerWindowEnd);

  const sidebarLiteral = "`app-shell-file-tree-open`";
  const sidebarStart = source.indexOf(sidebarLiteral);
  if (sidebarStart < 0) {
    throw new Error("transform anchor not found: initial sidebar atom");
  }
  const sidebarEnd = source.indexOf("));", sidebarStart);
  const sidebarSliceEnd =
    sidebarEnd > sidebarStart ? sidebarEnd + 3 : sidebarStart + 3000;
  let sidebarSlice = source.slice(sidebarStart, sidebarSliceEnd);
  const sidebarAtomPattern = /([$A-Za-z_][$\w]*)=Ea\(Q,!0\)/;
  if (
    !sidebarSlice.includes("Ea(Q,window.__ELECTRON_SHIM__.initialSidebarState)")
  ) {
    if (!sidebarAtomPattern.test(sidebarSlice)) {
      throw new Error("transform anchor not found: initial sidebar atom");
    }
    sidebarSlice = sidebarSlice.replace(
      sidebarAtomPattern,
      (_match, atom) =>
        `${atom}=Ea(Q,window.__ELECTRON_SHIM__.initialSidebarState)`,
    );
  }
  const sidebarAnimationPattern =
    /([$A-Za-z_][$\w]*)=Ea\(Q,\(\)=>new ([$A-Za-z_][$\w]*)\(1\)\)/;
  if (
    !sidebarSlice.includes("window.__ELECTRON_SHIM__.initialSidebarState?1:0")
  ) {
    if (!sidebarAnimationPattern.test(sidebarSlice)) {
      throw new Error(
        "transform anchor not found: initial sidebar animation atom",
      );
    }
    sidebarSlice = sidebarSlice.replace(
      sidebarAnimationPattern,
      (_match, atom, spring) =>
        `${atom}=Ea(Q,()=>new ${spring}(window.__ELECTRON_SHIM__.initialSidebarState?1:0))`,
    );
  }
  source =
    source.slice(0, sidebarStart) +
    sidebarSlice +
    source.slice(sidebarSliceEnd);

  if (
    !source.includes("overrideAdapter:window.__ELECTRON_SHIM__.overrideAdapter")
  ) {
    const statsigPattern =
      /networkConfig:\{api:[$A-Za-z_][$\w]*,logEventUrl:[$A-Za-z_][$\w]*/g;
    const statsigMatches = [...source.matchAll(statsigPattern)];
    if (statsigMatches.length !== 1) {
      throw new Error(
        `expected one app Statsig network config, found ${statsigMatches.length}`,
      );
    }
    const statsigIndex = statsigMatches[0].index;
    source =
      source.slice(0, statsigIndex) +
      "overrideAdapter:window.__ELECTRON_SHIM__.overrideAdapter," +
      source.slice(statsigIndex);
  }

  const sentryAnchor = "sFr({beforeSend:qon,dsn:e.dsn,";
  if (source.includes(sentryAnchor)) {
    source = source.replace(
      sentryAnchor,
      "sFr({enabled:!1,beforeSend:qon,dsn:e.dsn,",
    );
  }

  write(path.join("webview", "assets", asset.name), source);
}

transformIndexHtml();
transformMainBundle();
console.log("Applied PrimeCodex semantic webview transforms");
