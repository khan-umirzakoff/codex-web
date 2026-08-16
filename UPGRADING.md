# Upgrading PrimeCodex

PrimeCodex has three independent update sources:

1. the official ChatGPT/Codex Desktop application;
2. Prime Agent;
3. the upstream `0xcaff/codex-web` Git repository.

For the complete operational procedure, Cloudflare deployment notes, version checks, smoke tests, rollback, and session-safety rules, see [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

## ChatGPT / Codex Desktop

Update the official Desktop app normally, then rebuild PrimeCodex from the currently installed app:

```bash
cd ~/PROJECTS/PrimeCodex
npm run sync:desktop
```

The Desktop `app.asar` is generated upstream input and is intentionally not committed to Git. `sync:desktop` extracts the installed app into staging, applies Git-tracked PrimeCodex semantic transforms, and only replaces the current generated bundle after the transform stage succeeds.

PrimeCodex automatically prefers the Codex app-server binary bundled with the installed ChatGPT Desktop application on macOS so the renderer and protocol stay aligned.

After syncing:

```bash
npm run primecodex
```

Smoke-test both native Codex and Prime mode before continuing feature work.

## Prime Agent

```bash
prime-agent --version
prime-agent update
```

Use `prime-agent update --force` only when a forced reinstall/update is needed.

Prime Agent session history is stored separately under `~/.prime/agent/sessions`.

## Upstream codex-web

Keep `origin` pointed at the PrimeCodex fork and `upstream` pointed at `0xcaff/codex-web`:

```bash
git fetch upstream
git checkout main
git merge upstream/main
npm install
npm run sync:desktop
npm run build:server
npm run build:browser
```

After validation:

```bash
git push origin main
```

Do not commit `scratch/asar`. Merge Git source with Git; regenerate the official Desktop bundle through `sync:desktop`.
