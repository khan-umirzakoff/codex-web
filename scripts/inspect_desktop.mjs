import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as asar from "@electron/asar";

const appPath = process.env.CHATGPT_APP_PATH ?? "/Applications/ChatGPT.app";
const appAsar = path.join(appPath, "Contents", "Resources", "app.asar");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "primecodex-inspect-"));

const patterns = [
  "v5Compat",
  "app-shell-bottom-panel-launcher-visible",
  "data-app-shell-sidebar-trigger",
  "spellcheck:`true`",
  "enable_mcp_apps",
  "overrideAdapter",
  "logEventUrl",
  "composer_prefill",
  "initialPrompt",
  "defaultTextKind",
  "threadProjectAssignments",
  "thread-workspace-state-v1",
  "beforeSend",
  "dsn:",
  "buildFlavor",
  "document.title",
  "atfs",
  "get-global-state",
];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && /\.(?:js|html)$/.test(entry.name))
      out.push(full);
  }
  return out;
}

try {
  asar.extractAll(appAsar, tmp);
  const roots = [
    path.join(tmp, "webview"),
    path.join(tmp, ".vite", "build"),
  ].filter(fs.existsSync);
  const files = roots.flatMap((root) => walk(root));
  for (const pattern of patterns) {
    console.log(`\n### ${pattern}`);
    let hits = 0;
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      let from = 0;
      while (hits < 5) {
        const index = source.indexOf(pattern, from);
        if (index < 0) break;
        const start = Math.max(0, index - 350);
        const end = Math.min(source.length, index + pattern.length + 650);
        console.log(`FILE ${path.relative(tmp, file)} @ ${index}`);
        console.log(source.slice(start, end).replace(/\s+/g, " "));
        hits += 1;
        from = index + pattern.length;
      }
      if (hits >= 5) break;
    }
    if (hits === 0) console.log("NO MATCH");
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
