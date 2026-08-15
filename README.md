# codex-web

a browser frontend for codex desktop, running on a machine you control.

https://github.com/user-attachments/assets/0a33cbd8-741c-412c-9e75-46dfe9324596

## PrimeCodex hybrid mode

This fork can keep the original Codex web UI while routing each new task to
either native Codex or Prime Agent.

```bash
npm install
npm run primecodex
```

Then open <http://127.0.0.1:8214>.

The normal desktop product-mode slot at the top of the sidebar is reused as a
native-looking `Codex` / `Prime` dropdown. Codex mode shows Codex sessions,
Codex models, and creates Codex tasks; Prime mode shows Prime Agent sessions,
Prime-prefixed models, and creates Prime tasks. Switching does not reload the
page. Prime mode expands the sidebar history so all available non-archived
Prime sessions are surfaced.

Internally, creation of a visible Prime task is still armed as a one-shot
request so invisible Codex helper threads (for example title generation) stay
on native Codex. The visible `Prime` app mode remains selected and automatically
re-arms Prime creation when the user returns to the new-task screen.

Existing Prime Agent root sessions are indexed directly from Prime Agent's
session store, grouped in the normal Codex project sidebar, and can be reopened
from there. The inactive backend's rows are hidden without a browser refresh.
Prime tasks use Prime Agent's own
session persistence, reasoning effort, streaming events, command/tool events,
and daemon attachment when an already-running session is reopened. Native
Codex task lifecycle actions are mapped for Prime threads too: continue/fork
(including historical-turn and worktree forks), archive/unarchive, ephemeral
side tasks, and rich composer context such as attached files and local images.
Side-task developer instructions are persisted as hidden Prime context, and
closing a side task removes its ephemeral Prime backing session.

Live Prime activity is translated into Codex-native timeline items instead of
dumping the Prime TUI trace into chat. Reasoning and recaps use collapsed
reasoning entries; IPython/bash work uses command cards with expandable output;
IPython file diffs use normal Codex patch cards; and RLM child updates surface
as subagent activity.

### Syncing with the installed ChatGPT Desktop app

On macOS, PrimeCodex can rebuild its browser bundle directly from the currently
installed ChatGPT Desktop app and automatically use the matching bundled Codex
app-server binary:

```bash
npm run sync:desktop
```

The installed `app.asar` is treated as generated upstream input and remains
outside Git. PrimeCodex's bridge, browser shim, UI layer, and semantic transforms
remain Git-tracked. The sync is staged and only swaps `scratch/asar` after all
required transforms succeed, so a failed Desktop update does not destroy the
last working generated bundle.

### Syncing this fork with codex-web

Keep this repository's `origin` pointed at the fork and `upstream` pointed at
`0xcaff/codex-web`. To bring upstream changes into PrimeCodex:

```bash
git fetch upstream
git checkout main
git merge upstream/main
npm run build:server
npm run build:browser
git push origin main
```

Most PrimeCodex changes live in the compatibility bridge, server additions,
browser shim, and semantic renderer transforms, so upstream updates can
normally be merged while preserving the Prime Agent integration. When the
Desktop renderer changes, run `npm run sync:desktop`; a transform intentionally
fails instead of silently patching the wrong code if one of its semantic anchors
has changed.

Prime Agent must already be installed and authenticated. Override its command
or defaults when needed:

```bash
PRIME_AGENT_CLI_PATH=/path/to/prime-agent \
PRIMECODEX_PRIME_THINKING=xhigh \
npm run primecodex
```

Prime Agent executes with the current user's permissions; this UI is not a
security sandbox. Keep the default localhost bind for local use. Put a private
authenticated tunnel such as Tailscale in front of it before remote access.

## motivation

the agents were never meant to stay trapped in a terminal window for long.
codex desktop brought the power of agents to your local computer, where your
files, credentials, and tools already live.

codex-web brings codex desktop to the browser while keeping the backend on a
machine you control (a linux box in the cloud, your home lab, or a desktop / mac
mini). agents keep running after your laptop closes. you can reconnect from any
device with a browser.

this project aims to be as thin a wrapper as possible to ensure upstream changes
to the codex desktop app can be integrated quickly.

## usage

`codex-web` serves the browser client and hosts the desktop-side bridge. by
default, it listens on `127.0.0.1:8214`.

it will use `codex` from `PATH` if available, or `CODEX_CLI_PATH` if you set
it.

run it with `npx`:

```bash
npx --yes github:0xcaff/codex-web
```

or with nix:

```bash
nix run github:0xcaff/codex-web
```

then open <http://127.0.0.1:8214> in a browser.

### sign in

ensure the codex cli on the host machine is signed in before starting the
server.

```bash
codex login --device-auth
```

### proxying to app-server (advanced usage)

it’s often useful to run the app server separately, so a crash or restart of
codex-web doesn’t interrupt the codex process executing commands.

it's possible to hook codex-web up to an already-running app server using the
`codex_remote_proxy` script.

start a long-lived app server somewhere:

```bash
mkdir -p /tmp/codex-app-server
cd /tmp/codex-app-server
codex app-server --listen unix://codex-app-server.sock
```

then run `codex-web` with the proxy helper:

```bash
nix shell github:0xcaff/codex-web github:0xcaff/codex-web#codex_remote_proxy -c bash -lc '
  export CODEX_UNIX_SOCKET=/tmp/codex-app-server/codex-app-server.sock
  export CODEX_CLI_PATH="$(command -v codex_remote_proxy)"
  codex-web
'
```

`codex app-server proxy --sock ...` is a raw stdio protocol bridge for another
program to use; when run directly in a terminal it will wait for protocol input
rather than opening an interactive prompt.

## security

run `codex-web` only on trusted networks. treat anyone who can reach the
`codex-web` server as someone who can operate codex on the host machine as the
same user running the server.

if you need authn or authz, implement it outside of `codex-web`: proxy it through
wireguard, tailscale, or an ssh tunnel and put an authentication gateway or
reverse proxy in front.

someone with access to the web ui may be able to:

- run commands on the host, limited only by the permissions of the `codex-web`
  server process.
- read or modify files, environment variables, credentials, ssh keys, and other
  local resources that are accessible to that process.
- use the codex / chatgpt account already signed in on the host. this may
  consume usage quota or billing credits, and may expose account metadata shown
  by the app or cli, such as name or email address.

## features

- hostable on macOS, Linux (and anything codex cli + node will run on)
- reachable from the browser
- thin wrapper, so updates should land fast
- working today:
  - subagents
  - inline images
  - editor sidepanel
  - transcription

## roadmap

some parts of the desktop experience are not wired up yet:

- browser panel support, likely rebuilt around iframes
- computer use on linux, which could become a very powerful feature
- terminal support
- git worker integration
- whatever else people find and file issues for

## issues welcome

if something is broken, missing, or rough around the edges, please file an
issue.

using `codex-web` in an interesting way? post about it on x and tag me
[@0xcaff](https://x.com/0xcaff).

using this at a company and need something more tailored? email me and we can
talk.

## alternatives

- [davej/pocodex](https://github.com/davej/pocodex) i used this until the wheels fell off. i needed subagents
  and an inline image viewer. this didn't have them and was having a hard time
  keeping up with upstream codex updates.
- the native codex remote feature (behind a feature flag) is great for
  connecting to remote codex hosts over ssh to manage long running tasks but
  this only works if you have codex desktop on your client device. this means it
  doesn't work on mobile.
- upcoming first party mobile app from openai. `codex-web` exists and works
  today. i can't wait for the mobile app but judging by the other openai mobile
  apps, i'm a little bit skeptical about the quality of the mobile experience.
  time will tell.
