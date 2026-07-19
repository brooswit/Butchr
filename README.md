# butchr

**An agent task harness.** butchr is a single [Bun](https://bun.sh) process — HTTP API +
dispatcher + SQLite — that orchestrates [Claude Code](https://claude.com/claude-code) agents as a
work pipeline:

1. You file a **story** (a unit of work) against a workspace.
2. A managed **story-leader** agent decomposes it into **subtasks**.
3. Each subtask gets a **build agent** running in its own **git worktree**.
4. The agent submits its diff, which lands through **review + a gate** (`./scripts/ci`) and is
   merged back.

butchr owns *task state*; it delegates **all** terminal/PTY/session management to
[`herdr`](#prerequisites), which owns the agent sessions butchr dispatches into. The dashboard is a
React 19 + [LaunchDarkly LaunchPad](https://launchpad.launchdarkly.com/) single-page app bundled by
`bun build`.

For the deep contributor documentation, see **[CONTRIBUTING.md](./CONTRIBUTING.md)**; design records
live in [`docs/rfc-*.md`](./docs).

---

## Prerequisites

A fresh box needs **all four**. The last two are where deploys actually fail:

| Requirement | Notes |
| --- | --- |
| **bun** | The only runtime. No node, no npm. |
| **git** | Every task runs in a real git worktree. |
| **`herdr` on PATH, *with its server running*** | See the warning below. |
| **`claude` CLI, installed *and authenticated*** | See the warning below. |

> **⚠️ herdr must be RUNNING, not just installed.** butchr boots fine without it and the dashboard
> looks healthy — but **no task ever moves past `queued`, and nothing errors.** Tasks just sit
> there. If you see queued tasks that never start, check herdr first:
> `systemctl --user status herdr.service`.

> **⚠️ `claude` must be authenticated on *this machine*, as the user butchr runs as.** Every agent
> — leaders, build agents, reviewers — is a Claude Code session. There is no way to script around
> this; run `claude` once interactively on the box and complete login before enabling the service.
> Note that agents are launched with `--dangerously-skip-permissions` (see
> [`BUTCHR_AGENT_CMD`](#configuration)), i.e. they run tools without prompting, as your user.

---

## Quickstart

```bash
git clone https://github.com/brooswit/Butchr.git
cd Butchr
bun install
bun run build:fe      # REQUIRED — dist/ is gitignored
bun start             # http://127.0.0.1:47800
```

**Do not skip `bun run build:fe`.** The dashboard is a build artifact: `/dist/` is gitignored, so a
fresh clone (or any `git pull` touching `public/`) has **no front end to serve** and the dashboard
misbehaves. `bun start` is `bun run build:fe && bun run src/index.ts`, so it rebuilds for you — the
explicit step above just makes the failure mode visible.

### Running it as a service (systemd, user units)

```bash
scripts/install-service.sh                  # renders + installs the units; starts NOTHING
systemctl --user enable --now herdr.service   # herdr FIRST — butchr is useless without it
systemctl --user enable --now butchr.service
loginctl enable-linger "$USER"              # survive logout + auto-start on boot
```

`scripts/install-service.sh` is idempotent. It resolves absolute paths for `bun` and `herdr` (and
**fails loudly if either is missing from PATH**), substitutes them into `deploy/butchr.service` and
`deploy/herdr.service`, installs both into `~/.config/systemd/user/`, runs `daemon-reload`, and
verifies them with `systemd-analyze`. It deliberately **enables and starts nothing** — that is an
operator action, so it just prints the commands above.

`butchr.service` runs `bun install --frozen-lockfile` and `bun run build:fe` as `ExecStartPre`
before `bun run src/index.ts`, so **a restart rebuilds `dist/` for you** and a broken front-end
build fails visibly at start instead of 404ing at runtime. It is `Restart=always` with a crash-loop
backstop (10 starts / 60s). Optional env overrides are read from
`~/.config/butchr/butchr.env`.

```bash
systemctl --user status butchr.service
journalctl --user -u butchr.service -f
```

---

## Configuration

All via environment. Defaults are real values from [`src/config.ts`](./src/config.ts).

| Variable | Default | What it does |
| --- | --- | --- |
| `BUTCHR_HOST` | `127.0.0.1` | HTTP bind host. **Read the security note below before changing.** |
| `BUTCHR_PORT` | `47800` | HTTP port (API + dashboard). |
| `BUTCHR_DATA_DIR` | `~/.local/share/butchr` | Base dir for the DB, logs, and backups. |
| `BUTCHR_DB` | `<data-dir>/butchr.db` | SQLite path. **Pin this when testing** — see gotchas. |
| `BUTCHR_LOG_FILE` | `<data-dir>/butchr.log` | Log file (rotated; 10 MB, 3 kept). |
| `BUTCHR_AGENT_CMD` | `claude --dangerously-skip-permissions …` | Template used to launch each agent. |
| `BUTCHR_HERDR_BIN` | `herdr` | Path to the herdr CLI. |
| `BUTCHR_ALLOWED_ORIGINS` | *(empty)* | Extra browser origins. **Not authentication** — see below. |
| `BUTCHR_TERMINAL_CMD` | *(auto-detect)* | Override the GUI terminal used by the open-terminal buttons. |
| `BUTCHR_MAX_RUN_MS` | `2700000` (45 min) | Runaway-agent cap before a task is force-rescued to review. |
| `BUTCHR_BACKUP_ENABLED` | `true` | Periodic DB backups into `<data-dir>/backups`. |
| `BUTCHR_URL` | `http://127.0.0.1:47800` | Where the `bin/butchr` operator CLI points. |

`src/config.ts` documents many more knobs (timeouts, dispatch backoff, auto-merge, CTO/CEO agents);
the table above is what matters for a first deploy.

### ⚠️ Security: butchr has NO authentication

There is **no login, no token, no access control of any kind.** The default bind is loopback
(`127.0.0.1`) and that is the only thing protecting it.

**`BUTCHR_ALLOWED_ORIGINS` is a browser origin/CSRF check, NOT authentication.** It does not stop a
direct HTTP client — anything that can reach the port can drive the API.

Anyone who can reach this port can create tasks, which **spawn Claude agents that run with
`--dangerously-skip-permissions` as your user** — that is arbitrary code execution on the box.
Do **not** set `BUTCHR_HOST=0.0.0.0` to "reach it from my laptop". Use an SSH tunnel:

```bash
ssh -N -L 47800:127.0.0.1:47800 user@server   # then open http://127.0.0.1:47800 locally
```

---

## Running headless (servers)

**The pipeline is fully headless.** Stories, leaders, build agents, the dashboard, review, and merge
all work with no graphical session.

The one exception: the **"Open CTO/CEO/Leader terminal"** buttons spawn a *real GUI terminal window*.
`src/terminal.ts` walks a list of known emulators in preference order — kitty and konsole first,
since they reliably spawn a standalone window from a background service, and gnome-terminal
deprioritized because when started from a daemon it hands off to `gnome-terminal-server` and often
fails to map a window. butchr self-discovers the graphical session's `DISPLAY`/`WAYLAND_DISPLAY` at
runtime, but with no display present those buttons simply do nothing useful. Nothing else is
affected.

---

## Gotchas

These have all bitten in production.

- **butchr serves STALE CODE until it is restarted.** Merging and releasing does *not* restart the
  systemd unit — the running process keeps serving the old code. Pick up merged code with
  `systemctl --user restart butchr.service` (which also rebuilds `dist/` via `ExecStartPre`).

- **`bun test` and dev commands MIGRATE THE LIVE DB.** Anything that boots butchr's code opens and
  migrates `BUTCHR_DB`, which defaults to your real install. Always pin it to a throwaway path when
  testing against a real deployment:
  ```bash
  BUTCHR_DB=/tmp/throwaway.db bun test ./test
  ```

- **`./scripts/ci` is the SOLE gate**, and **a repo with no `scripts/ci` has the gate OFF.** It runs,
  in order: `bun install --frozen-lockfile` → `bun build src/index.ts` → **two** typecheck passes
  (`tsconfig.json` for `src/`, `tsconfig.public.json` for `public/`) → `bun run build:fe` →
  `bun run assert:fe dist` (byte-level artifact assertions) → `bun run verify:fe dist` (headless
  Chrome render check) → `bun test ./test` → a "code changes must update CHANGELOG.md" rule → a
  CHANGELOG rebase-race guard.

- **⚠️ The render gate is silently OFF on a box with no browser.** `verify:fe` boots the built
  `dist/` in real headless Chrome to catch a dashboard that renders **blank** — the one failure every
  other gate step passes straight through. With no browser found it prints a loud banner and
  **exits 0**, so on a fresh headless server the gate goes green without ever checking. Arm it:
  ```bash
  sudo apt install chromium-browser      # or point $CHROME at a chrome/chromium binary
  ```

---

## Layout

| Path | What's in it |
| --- | --- |
| `src/` | The server: HTTP API, dispatcher, SQLite, git/worktree, herdr client, agent lifecycle. |
| `public/` | The dashboard — React 19 + LaunchPad. `.tsx` components with pure logic split into sibling `*-logic.ts` files. |
| `test/` | The suite (~150 files), run by `bun test ./test`. |
| `scripts/` | `ci` (the gate), `install-service.sh`, `verify-render`, `assert-fe-artifact`, `inline-sprite`, `supervise.sh`. |
| `deploy/` | systemd user-unit templates: `butchr.service`, `herdr.service`. |
| `docs/` | `rfc-*.md` design records + `docs/design/` working notes. |
| `bin/` | `butchr` — the dependency-free operator CLI over the REST API. |

- **[CONTRIBUTING.md](./CONTRIBUTING.md)** — the deep doc: architecture, the dependency rule, code
  conventions, testing, the contribution workflow, and the full
  [operations runbook](./CONTRIBUTING.md#3-operations-runbook).
- **[CHANGELOG.md](./CHANGELOG.md)** — every change lands an `[Unreleased]` entry.
- **[`docs/rfc-*.md`](./docs)** — the signed-off design records behind the current architecture.
