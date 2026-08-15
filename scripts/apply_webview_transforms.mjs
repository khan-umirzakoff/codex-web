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

  source = replaceOnce(
    source,
    "a.current??=bdn({initialEntries:n,initialIndex:r,v5Compat:!0});",
    "a.current??=bdn({initialEntries:n??[window.__ELECTRON_SHIM__.initialRoute],initialIndex:r,v5Compat:!0});",
    "memory router initial route",
  );
  source = replaceOnce(
    source,
    "l=$C.useCallback(e=>{i===!1?c(e):$C.startTransition(()=>c(e))},[i]);",
    "l=$C.useCallback(e=>{window.__ELECTRON_SHIM__.onMemoryNavigationChanged?.(e),i===!1?c(e):$C.startTransition(()=>c(e))},[i]);",
    "memory router navigation callback",
  );

  source = replaceOnce(
    source,
    "Z5n=`app-shell-bottom-panel-launcher-visible`,Q5n=`app-shell-file-tree-open`,$5n=100,tk=Ea(Q,!0),",
    "Z5n=`app-shell-bottom-panel-launcher-visible`,Q5n=`app-shell-file-tree-open`,$5n=100,tk=Ea(Q,window.__ELECTRON_SHIM__.initialSidebarState),",
    "initial sidebar atom",
  );
  source = replaceOnce(
    source,
    "i7n=Ea(Q,()=>new BBe(1)),",
    "i7n=Ea(Q,()=>new BBe(window.__ELECTRON_SHIM__.initialSidebarState?1:0)),",
    "initial sidebar animation atom",
  );

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
