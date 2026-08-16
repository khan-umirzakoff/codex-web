# PrimeCodex Operations Guide

This document covers day-to-day operation of PrimeCodex, private remote access through Cloudflare Tunnel, and safe updates of ChatGPT Desktop, Prime Agent, and the upstream `codex-web` repository.

## 1. Architecture and trust model

PrimeCodex keeps the UI in a browser while the actual coding agents run on the Mac:

```text
Browser / phone
      |
      | HTTPS + WebSocket
      v
Cloudflare Access + Tunnel   (remote access only)
      |
      v
127.0.0.1:8214
PrimeCodex
   |         |
   |         +--> Prime Agent / RLM / subagents
   |
   +------------> bundled Codex app-server
                     from installed ChatGPT Desktop
```

PrimeCodex is **not a security sandbox**. Anyone who can use the web UI should be treated as having the ability to operate coding agents with the permissions of the local macOS user.

For that reason:

- keep PrimeCodex bound to `127.0.0.1`;
- never port-forward port `8214` directly from the router;
- when publishing through Cloudflare Tunnel, protect the hostname with Cloudflare Access;
- restrict Access to the intended account(s) only.

## 2. Local operation

Install dependencies once:

```bash
cd ~/PROJECTS/PrimeCodex
npm install
```

Start PrimeCodex:

```bash
npm run primecodex
```

Open:

```text
http://127.0.0.1:8214
```

Check whether the server is listening:

```bash
lsof -nP -iTCP:8214 -sTCP:LISTEN
```

Check the local HTTP endpoint:

```bash
curl -I http://127.0.0.1:8214
```

When restarting after an update, stop the old foreground process with `Ctrl+C`, then run `npm run primecodex` again.

## 3. Remote access with an existing Cloudflare Tunnel

A single Cloudflare Tunnel can publish multiple applications. PrimeCodex does not need a separate tunnel if an existing tunnel is already running on the Mac.

Use a dedicated hostname, for example:

```text
prime.example.com
```

Map it to:

```text
http://127.0.0.1:8214
```

The resulting path is:

```text
https://prime.example.com
        |
        v
Cloudflare Tunnel
        |
        v
http://127.0.0.1:8214
```

### 3.1 Add the hostname to the existing tunnel

In Cloudflare Zero Trust / Cloudflare One:

1. Open the existing tunnel.
2. Add a **Published application** / public hostname route.
3. Choose the dedicated hostname, for example `prime.example.com`.
4. Set the service type to HTTP.
5. Set the origin service to:

```text
http://127.0.0.1:8214
```

Do not expose `8214` on `0.0.0.0` just for Cloudflare. `cloudflared` can reach the loopback service directly.

### 3.2 Protect the hostname with Cloudflare Access

Create a self-hosted Access application for the same hostname and add an allow policy that only permits the intended identity, for example the owner's email address or approved identity-provider account.

Recommended policy:

```text
Default: deny
Allow:   only the owner / explicitly approved users
```

If the identity provider supports MFA, enable it there as well.

Do not publish PrimeCodex to the public Internet without Access or an equivalent authenticated gateway.

### 3.3 WebSocket behavior

PrimeCodex uses the same browser origin for its backend WebSocket connection. When the page is opened as:

```text
https://prime.example.com
```

the browser connects through:

```text
wss://prime.example.com/__backend/ipc
```

No separate WebSocket hostname or port is required.

### 3.4 Remote smoke test

After configuring Tunnel + Access:

1. Turn off Wi-Fi on the phone so the test is genuinely remote.
2. Open `https://prime.example.com`.
3. Complete the Cloudflare Access login.
4. Verify the sidebar loads.
5. Switch `Codex -> Prime` and back without a page reload.
6. Open an existing session.
7. Send a small Prime task and verify live streaming.
8. Send a small native Codex task and verify live streaming.

If the page works locally but Cloudflare returns `502`, first check:

```bash
curl -I http://127.0.0.1:8214
```

If the page loads remotely but agent streaming does not, inspect the browser network tab and confirm the `wss://.../__backend/ipc` connection is established.

## 4. What is stored where

The generated Desktop renderer is not the source of truth.

### Git-tracked PrimeCodex source

Important PrimeCodex changes live in Git, including:

```text
src/server/compat/
src/server/prime/
src/server/electron/
assets/primecodex-ui.js
scripts/apply_webview_transforms.mjs
scripts/sync_desktop
patches/
```

### Generated Desktop input

The extracted ChatGPT Desktop application lives under:

```text
scratch/asar
```

`scratch` is intentionally ignored by Git. It can be regenerated from the installed ChatGPT Desktop application.

### User/session data

Prime Agent sessions are stored separately from the generated renderer:

```text
~/.prime/agent/sessions/
```

Codex sessions are stored separately as well, primarily under:

```text
~/.codex/sessions/
~/.codex/archived_sessions/
```

Running `npm run sync:desktop` does **not** delete these session stores.

Do not delete the session directories as part of a renderer update.

## 5. Updating ChatGPT / Codex Desktop

PrimeCodex should use a renderer and Codex app-server from the same installed Desktop generation.

The normal update flow is:

### Step 1 — update the official Desktop app

Update `/Applications/ChatGPT.app` normally through the official app/update mechanism.

### Step 2 — compare installed and currently synced versions

Installed Desktop version:

```bash
/usr/libexec/PlistBuddy \
  -c 'Print :CFBundleShortVersionString' \
  /Applications/ChatGPT.app/Contents/Info.plist
```

PrimeCodex's currently synced Desktop version:

```bash
cat ~/PROJECTS/PrimeCodex/scratch/desktop-version.txt
```

Bundled Codex version:

```bash
/Applications/ChatGPT.app/Contents/Resources/codex --version
```

If the installed and synced Desktop versions differ, resync PrimeCodex.

### Step 3 — sync the new installed Desktop into PrimeCodex

```bash
cd ~/PROJECTS/PrimeCodex
npm run sync:desktop
```

`sync:desktop`:

1. detects the installed ChatGPT Desktop app;
2. extracts its current `app.asar` into a staging directory;
3. applies PrimeCodex semantic transforms;
4. copies the PrimeCodex browser assets;
5. builds the browser and server code;
6. swaps the new generated `scratch/asar` into place only after the transform stage succeeds.

If the transform stage fails, the previous working `scratch/asar` is preserved.

The sync output itself is generated and should not be committed to Git.

### Step 4 — restart PrimeCodex

```bash
npm run primecodex
```

On macOS, PrimeCodex automatically prefers the Codex binary bundled with the installed ChatGPT Desktop app so the renderer and app-server protocol stay aligned.

### Step 5 — smoke-test both backends

After every Desktop rebase, verify at minimum:

- cold page load produces no fatal UI error;
- native top `Codex / Prime` selector appears once;
- Codex mode shows Codex sessions/models only;
- Prime mode shows Prime sessions/models only;
- a new Prime task streams and persists;
- a new native Codex task streams and persists;
- an old Prime session resumes correctly;
- archive/fork/side-task actions still work;
- browser console has no new runtime exceptions.

## 6. Updating Prime Agent

Check the installed version:

```bash
prime-agent --version
```

Update Prime Agent:

```bash
prime-agent update
```

Force an update/reinstall only when needed:

```bash
prime-agent update --force
```

Prime Agent session files are stored independently under `~/.prime/agent/sessions`, so updating the executable does not itself replace the session history.

For an important long-running Prime task, prefer to let the task finish before updating Prime Agent. After updating, restart PrimeCodex before validating new sessions so newly spawned workers use the updated installation.

Then test:

```bash
prime-agent --version
prime-agent
```

and run one small task through PrimeCodex Prime mode.

## 7. Updating from upstream `0xcaff/codex-web`

This fork uses two remotes:

```text
origin   -> khan-umirzakoff/codex-web
upstream -> 0xcaff/codex-web
```

Check them with:

```bash
git remote -v
```

Recommended merge flow:

```bash
cd ~/PROJECTS/PrimeCodex

git status
git fetch upstream
git checkout main
git merge upstream/main
npm install
npm run sync:desktop
npm run build:server
npm run build:browser
```

Resolve normal Git merge conflicts in Git-tracked PrimeCodex source. Do **not** resolve an upstream merge by committing `scratch/asar`.

After validation:

```bash
git push origin main
```

### Why Desktop changes are reapplied instead of Git-merged

`0xcaff/codex-web` is a Git repository, so its changes can be merged normally.

The official ChatGPT Desktop `app.asar` is distributed as a packaged application artifact, not as a Git branch with source history available to this repository. Therefore it is treated as generated upstream input:

```text
installed ChatGPT app.asar
          |
          v
extract to staging
          |
          v
Git-tracked PrimeCodex semantic transforms
          |
          v
generated scratch/asar
```

The important part is that PrimeCodex modifications are **not recreated manually on every update**. The transformations and compatibility code are Git-tracked and automatically reapplied to the new Desktop bundle.

If a semantic anchor changed in the new Desktop release, the transform should fail loudly instead of silently modifying the wrong location. Fix that transform in Git, validate it, and commit the transform update.

## 8. Recommended update order when several things changed

When Desktop, Prime Agent, and `codex-web` all have updates, use this order:

1. Make sure the PrimeCodex Git working tree is clean.
2. Fetch/merge `upstream/main`.
3. Update the official ChatGPT Desktop app.
4. Run `npm run sync:desktop`.
5. Update Prime Agent with `prime-agent update`.
6. Restart PrimeCodex.
7. Smoke-test native Codex.
8. Smoke-test Prime Agent.
9. Resume one existing Prime session.
10. Push the validated Git changes to `origin/main` if source changes were required.

Do not combine a failing Desktop rebase with unrelated refactors. First restore a clean working baseline, then continue feature work.

## 9. Recovery and rollback

### Desktop sync fails

If `npm run sync:desktop` fails during staging, the current working `scratch/asar` should remain intact. Fix the transform or compatibility code and retry.

Before an unusually risky update, an optional local generated-bundle backup may be made:

```bash
cp -a scratch/asar "scratch/asar.backup.$(date +%Y%m%d-%H%M%S)"
```

These backups are local/generated and should not be committed.

### Git source regression

Find the last known-good commit:

```bash
git log --oneline -20
```

Prefer a normal `git revert <bad-commit>` when undoing a committed regression on the shared `main` branch. Avoid destructive `git reset --hard` unless there is a deliberate reason and local work has already been protected.

### Prime session safety

Do not use renderer recovery as a reason to delete:

```text
~/.prime/agent/sessions
~/.codex/sessions
```

A broken GUI bundle and a broken session store are separate problems.

## 10. Quick update checklist

Before update:

- Git working tree clean.
- Important agent tasks finished or intentionally left running.
- Current Desktop and Prime versions recorded.

Update:

```bash
git fetch upstream
# merge upstream only if desired
npm run sync:desktop
prime-agent update
```

After update:

```bash
npm run primecodex
```

Verify:

- local page opens;
- Cloudflare hostname opens through Access;
- Codex mode works;
- Prime mode works;
- an existing Prime session resumes;
- WebSocket streaming works remotely;
- no new fatal browser/runtime errors.
