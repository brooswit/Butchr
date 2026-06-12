# Contributing to butchr

The single living doc for butchr: what it is, how to run and operate it, the rules
the codebase holds itself to, the conventions to match, and how a change gets
proposed, gated, and merged. **This guide is the one human-facing document** —
when behavior changes, this file moves with it (see
[§8](#8-living-docs-update-on-every-change)).

The only other maintained artifact is the **[CHANGELOG.md](./CHANGELOG.md)**
(Keep a Changelog). **butchr appends the `[Unreleased]` entry for you at merge**
(and bumps the version) — you don't hand-edit it. Write a clear task summary
instead; the full living-docs convention is
[§8](#8-living-docs-update-on-every-change).

Architecture is not re-documented in prose — **the code is the reference.** The
file map in [§5](#5-code-conventions) and the module headers in `src/` describe
what lives where; each `BUTCHR_*` config var is documented inline where it's
defined in `src/config.ts`; the REST/SSE/MCP surface is the route table in
`src/server.ts`.

---

## 1. What butchr is

butchr is a lightweight service + webapp that organizes agent work around git
repositories: **directories are workspaces, tasks are git worktrees.** It handles
the full lifecycle from task creation through review and merge, delegating all
terminal/agent session management to **[herdr](https://github.com/)**.

- **Stack:** Bun · SQLite (`bun:sqlite`) · herdr · git — **zero npm dependencies.**
- **Webapp:** vanilla JS single-page app, no framework, no build step.

**Core concepts:**

- **Directory** — a git repository registered with butchr. Maps 1:1 to a herdr
  workspace. Adding it provisions the workspace; removing it tears it down.
- **Task** — the atomic unit of work, and a *filesystem artifact*, not just a DB
  row: a directory at `<repo>/.butchr/tasks/<task-id>/`, a `task.md` inside it
  (prompt + metadata + review notes), and a git worktree at `<repo>/<task-id>`
  on a branch named `<task-id>`.
- **Task ID** — `adjective-noun-4hex` (e.g. `swift-falcon-3a2f`), immutable,
  doubles as branch and worktree directory name.

SQLite tracks runtime state; `task.md` on disk is the source of truth for the
prompt and metadata. The full set of task states and the transitions between
them lives in the state machine in `src/tasks.ts` (with the persisted columns in
`src/db.ts`) — the agent runs **interactively** and drives the review handshake
itself via the `request_review` MCP tool, and on "request changes" the same live
agent resumes in-context rather than being restarted.

**Concurrency — fully concurrent.** Every queued task is dispatched immediately
and runs in parallel; there is no per-directory "one at a time" limit. Each task
gets its own git worktree on its own branch, so tasks are isolated at the
filesystem level. **The catch:** concurrent tasks in one directory each branch
off the directory's current HEAD and don't see each other's changes until merged,
so two editing the same lines can conflict at merge time (resolved during
approve/merge). This is accepted by design — isolation over coordination; if you
need tasks to build on each other, merge the first before queueing the second, or
express the ordering with `blocked_by`. `BUTCHR_MAX_CONCURRENT` caps the total
simultaneously running tasks across all directories (`0` = unlimited, default).

---

## 2. Local dev setup & running

butchr is a **single [Bun](https://bun.sh) process** (HTTP server + dispatcher
loop) with state in SQLite (`bun:sqlite`) and all PTY/agent-session work
delegated to **herdr**.

**Requirements:**

- Bun ≥ 1.1 (`package.json` `engines.bun`).
- `git` on `PATH`.
- `herdr` on `PATH`, **with its server running** (`herdr server`, or launch the
  herdr TUI) — required for *dispatch* to make progress. butchr starts fine
  without it and resumes dispatch automatically once herdr is reachable, but no
  task moves past `queued` while herdr is down. You can run, build, type-check,
  and `bun test` without a live herdr (tests stub it out — see §7).

**Run it** from the repo root:

```sh
bun run start            # = bun run src/index.ts
bun run dev              # watch mode: bun --watch run src/index.ts
```

Then open the webapp at **http://127.0.0.1:47800**.

**Where things live** (all overridable via `BUTCHR_*` env — every var is
documented inline in `src/config.ts`):

| What | Default | Override |
|------|---------|----------|
| HTTP host:port | `127.0.0.1:47800` | `BUTCHR_HOST` / `BUTCHR_PORT` |
| State dir | `~/.local/share/butchr/` | `BUTCHR_DATA_DIR` |
| SQLite db | `~/.local/share/butchr/butchr.db` | `BUTCHR_DB` |
| Log file | `~/.local/share/butchr/butchr.log` | `BUTCHR_LOG_FILE` |

The state dir also holds `prompts/`, `runs/`, `mcp/`, and `ask/` working files.
Inside each *registered* repo, butchr keeps a `.butchr/` folder (task.md +
per-task metadata, git-ignored on registration) and one git worktree per task at
`<repo>/<task-id>/`.

The agent command runs via `bash -lc` with the **worktree as cwd**; override
`BUTCHR_AGENT_CMD` to use any agent CLI. The default launches Claude Code
**interactively** (no `-p`), so the pane stays live and attachable, and the agent
signals completion by calling the `request_review` MCP tool rather than by
exiting (a fallback watcher still sweeps a headless one-shot agent to `review` on
exit). Two placeholders are substituted by the dispatcher: `{{PROMPT_FILE}}` (the
rendered prompt path) and `{{MCP_CONFIG}}` (the per-task MCP config wiring the
agent to butchr's `request_review` tool).

---

## 3. Operations runbook

Running butchr unattended on a machine. butchr is one Bun process (HTTP server +
dispatcher loop); state lives in SQLite; terminal/agent sessions are owned by
**herdr**, which must be running for dispatch to progress.

### Start

```sh
bun run src/index.ts
```

Detached (survives the shell), with output to the log:

```sh
nohup bun run src/index.ts >> ~/.local/share/butchr/butchr.log 2>&1 &
disown
```

(butchr also tees its own console output to the log file, so the `nohup` redirect
is belt-and-suspenders.) For an unattended setup, prefer the supervisor or the
systemd units below. butchr exits **non-zero** on any unhandled error (so a
supervisor relaunches a fresh process) and **0** on Ctrl-C / SIGTERM (so a clean
stop stays stopped).

### Crash supervision (keep butchr up)

Run butchr under the bundled supervisor so it relaunches itself if it crashes:

```sh
bun run start:supervised      # = bash scripts/supervise.sh
```

The supervisor (`scripts/supervise.sh`, plain bash, no deps) restarts the server
whenever it exits **non-zero**, backing off between restarts and bailing on a
tight crash loop. A **clean** exit (code 0, including the Ctrl-C / SIGTERM
shutdown butchr traps) stops the supervisor too. Tune it with `BUTCHR_RESTART_DELAY`
(default `2`s), `BUTCHR_MAX_RESTARTS` (default `10`, `0` = never give up), and
`BUTCHR_CRASH_WINDOW` (default `60`s). Auto-restart is **safe** because butchr
re-adopts its state on boot (see "Startup self-heal").

### Auto-recovery (systemd user services) — recommended

The production answer to "butchr died on power loss and had to be hand-restarted."
It runs butchr **and** herdr under the systemd **user** manager with
`Restart=always`, so they relaunch on any crash and start on boot. A health
watchdog timer probes `/health` every ~30s and restarts butchr if the endpoint is
unreachable or the dispatcher tick has gone stale. Everything lives in `deploy/`
(unit templates) and `scripts/` (installer + watchdog) — plain shell + systemd,
no extra dependencies, no `src/` changes.

| File | Role |
|------|------|
| `deploy/butchr.service` | butchr server (`bun run src/index.ts`), `Restart=always`, journald logging |
| `deploy/herdr.service` | `herdr server` (PTY/session manager butchr dispatches into), `Restart=always` |
| `deploy/butchr-health.service` + `.timer` | watchdog: curls `/health`, restarts butchr if down/stale |
| `scripts/install-service.sh` | renders the templates with real paths, installs them, `daemon-reload`, prints the enable commands |
| `scripts/health-watchdog.sh` | the probe the timer runs (dependency-free curl + bash) |

The `deploy/*` files are **templates** — `@REPO_DIR@`/`@BUN@`/`@HERDR@` are
substituted with absolute paths at install time. Don't point systemd at `deploy/`
directly; install first:

```sh
bash scripts/install-service.sh           # idempotent: re-render + reload, then prints enable cmds
```

It writes to `~/.config/systemd/user/`, runs `daemon-reload`, validates with
`systemd-analyze --user verify`, and **prints** (does not run) the enable
commands. Enable + start them yourself:

```sh
systemctl --user enable --now herdr.service
systemctl --user enable --now butchr.service
systemctl --user enable --now butchr-health.timer
loginctl enable-linger "$USER"            # survive logout / start on boot
```

Both **butchr and herdr must run** — with herdr down, no task progresses past
`queued` (butchr stays "healthy" but idle). `butchr.service` softly `Wants` herdr,
so starting butchr pulls herdr in. Status / logs / health:

```sh
systemctl --user status butchr.service herdr.service
journalctl --user -u butchr.service -f          # follow butchr logs
journalctl --user -u butchr-health.service      # watchdog probe results / restarts
curl -s http://127.0.0.1:47800/health | jq
```

Disable / stop with the matching `systemctl --user disable --now …` (and
`loginctl disable-linger "$USER"`). A `systemctl --user stop` is a **manual** stop —
`Restart=always` doesn't override it, so a deliberately stopped service stays
down. **Tuning:** the units cap restarts at 10/60s (`StartLimitIntervalSec`/
`StartLimitBurst`); a non-default `BUTCHR_PORT` needs a matching
`BUTCHR_HEALTH_URL` for the watchdog; drop `BUTCHR_*` overrides in
`~/.config/butchr/butchr.env` (read via `EnvironmentFile=-`). Use the systemd
units **or** `scripts/supervise.sh` — not both.

### Restart safely

**Find the process by the PORT it's listening on, and kill that PID:**

```sh
ss -ltnp | grep :47800
# ... users:(("bun",pid=12345,fd=...))
kill 12345
```

**Do NOT** `pkill -f 'bun run src/index.ts'`. `bun run` launches the server under
a wrapping shell, so that pattern matches **multiple** processes — including the
subshell — and, run from a session that itself matches, it can kill the killer
before the real server dies, leaving a half-killed orphan. Always resolve the
listening PID via the port and kill exactly that one. After the kill, start again
with the Start command — restart is safe because butchr re-adopts its state on
boot (see "Startup self-heal").

### DB snapshots & restore

The SQLite DB (`BUTCHR_DB`, default `<data>/butchr.db`) is the **source of truth**
for all task state + history. **Snapshots happen automatically** (no action
needed): a periodic snapshot every `BUTCHR_BACKUP_INTERVAL_MS` (default 15 min)
**plus one on every clean shutdown**. Each uses `VACUUM INTO` (a consistent online
backup — not a raw copy that would tear a WAL-mode DB), writing
`backups/butchr-<timestamp>.db` under `BUTCHR_BACKUP_DIR` (default
`<data>/backups/`). The newest `BUTCHR_BACKUP_KEEP` (default 24) are retained;
older ones pruned. `BUTCHR_BACKUP_ENABLED=0` turns it off. Check the latest
snapshot on `/health` (the `backup` field).

**Restore is OFFLINE** — a running server holds the DB open, so stop butchr first:

```sh
butchr backups                                       # list local snapshots
# 1. Stop butchr (resolve the PID by port — see "Restart safely").
butchr restore latest                                # newest snapshot in BUTCHR_BACKUP_DIR
butchr restore butchr-2026-06-10T18-15-00-123Z.db    # a bare name resolves in the backup dir
butchr restore /path/to/snapshot.db                  # or an absolute path
# 3. Start butchr again. It re-adopts state on boot.
```

`restore` copies the chosen snapshot over `BUTCHR_DB`, first saving the current DB
aside to `<db>.pre-restore-<timestamp>` and removing stale `-wal`/`-shm` sidecars.
It **refuses** if a server still answers on `BUTCHR_URL` — pass `--force` to
override. `backups`/`restore` are the only CLI commands that touch the filesystem
directly instead of the REST API.

### Operator CLI (`butchr`)

A dependency-free operator CLI ships in `bin/butchr` — a thin REST client (Bun's
stdlib `fetch`, zero deps) so you can drive butchr from the shell. It's wired into
`package.json` `bin`, so `bun link` puts a `butchr` on your PATH; otherwise run it
in-repo with `bun bin/butchr …`. It targets `http://127.0.0.1:47800` by default
(override with **`BUTCHR_URL`**), exits **non-zero** on any error, and takes a
**`--json`** flag to print the raw API payload.

```sh
butchr health                          # server health snapshot (exit 1 if degraded)
butchr ls [--dir <id>] [--status <s>]  # compact id/status/ci table (idle shows status*)
butchr new <dir> -m "<prompt>"         # create a task; <dir> is a directory id OR path
        [--blocked-by id,id]           #   start it blocked on those task ids
butchr show <id>                       # status, ci, summary, review notes, blockers
butchr approve <id>                    # approve a task in review (merges its branch)
butchr reject <id> -m "<note>"         # send a reviewed task back for rework
butchr requeue <id>                    # re-queue a failed/stuck task for a fresh dispatch
butchr block <id> --on id,id           # replace blocked_by (use --on '' to clear)
butchr backups                         # list local DB snapshots (OFFLINE)
butchr restore <file|latest> [--force] # restore the DB from a snapshot (OFFLINE)
butchr --help                          # full usage
```

Each subcommand maps onto exactly one REST route (the route table in
`src/server.ts`); the CLI adds no server behavior. The lone exceptions are
`backups` / `restore`, which are **offline** filesystem operations.

### Health

```sh
curl -s http://127.0.0.1:47800/health | jq    # also at /api/health; or: butchr health
```

Returns **200** when healthy, **503** when degraded. Key fields: `status`
(`"ok"`/`"degraded"`); `db.ok` (SQLite reachable — `false` ⇒ 503); `tick.alive`
(dispatcher-loop liveness — `false` ⇒ 503 if it ticked once but not within ~5 tick
intervals, i.e. the loop wedged); `herdr.reachable` (**best-effort, does NOT
affect the verdict** — butchr stays healthy with herdr down, but no task
progresses past `queued`; check this first if tasks are stuck in `queued`);
`tasks` (counts grouped by status); `backup` (snapshot resilience); `version` /
`uptimeSec`. **`healthy = db.ok && tick.alive`** — herdr being down alone won't
trip 503.

### Startup self-heal

On boot (`src/index.ts`) butchr repairs state left by a prior run, **after**
re-adopting running agents (`reconcileRunningTasks`) so live/just-merged work is
never mistaken for garbage. Watch the log for: re-adopted running agents; rescued
tasks whose agent died while butchr was offline; finalized tasks left mid-wrap-up
(`recoverFinalizingTasks`); and `reapOrphans` (`src/reaper.ts`), a conservative
once-on-boot sweep that removes **leaked git worktrees + branches** and **herdr
husks** for tasks in a terminal state (`merged` / `aborted` / `rejected`) or with
no DB row — it never touches the main worktree or a worktree whose task is still
queued/running/review/finalizing, and skips herdr deregistration entirely when
herdr is down (worktree reaping still runs). This is the automated fix for the old
"an aborted task's worktree/branch survived a restart" bug.

### herdr model

butchr delegates all PTY/session management to herdr, mapped by **task id**: one
herdr workspace per registered directory (created on registration, torn down on
unregister); one tab + one pane per task; **the herdr agent name IS the task id**
(`agentStart(task.id, …)`, `agentExists(id)`, `agentRead(id)`,
`agentDeregister(id)` all key off it). To inspect a running task by hand:
`herdr agent attach <task-id>`. If a directory's workspace vanishes (herdr
restart / manual close) butchr recreates it on the next dispatch — no manual
re-registration.

### Open terminal (DISPLAY)

The dashboard's **Open terminal** button (and the CTO terminal button) spawns a
**GUI terminal emulator** attached to a task's live agent pane — a flagship "work
with the agent in a real terminal" feature. Spawning a window needs the graphical
session's env (`DISPLAY` + `XAUTHORITY` for X11, or `WAYLAND_DISPLAY` for Wayland).
**A systemd `--user` service does NOT inherit these** from the graphical session, so
butchr handles it at two levels:

- **Runtime self-discovery (primary).** When butchr has no `DISPLAY`/`WAYLAND_DISPLAY`,
  `openTerminal` (`src/terminal.ts`) discovers the active session's display itself —
  via `loginctl` (the user's graphical session → its `Type`/`Display`), falling back
  to an X socket under `/tmp/.X11-unix` (`:0`) and a default `XAUTHORITY`
  (`~/.Xauthority`) — and injects it into the spawned emulator's env. Discovery is
  best-effort and bounded (it never throws or hangs); only if **no** display is
  discoverable does the UI fall back to showing the manual `herdr agent attach <id>`
  command to run yourself.
- **Imported env (defense-in-depth).** `scripts/install-service.sh` runs
  `systemctl --user import-environment DISPLAY XAUTHORITY WAYLAND_DISPLAY` so a
  (re)started `butchr.service` inherits the graphical env directly. These are
  **not** persisted across logins — after a fresh login (or if the display changes)
  re-import and restart:

  ```sh
  systemctl --user import-environment DISPLAY XAUTHORITY WAYLAND_DISPLAY
  systemctl --user restart butchr.service
  ```

You can also bypass detection entirely with **`BUTCHR_TERMINAL_CMD`** (a template
where `{{CMD}}` is the shell-quoted attach command) to use a specific emulator,
`ssh -X`, a tmux popup, etc.

---

## 4. The zero-dependency rule

**butchr ships with zero npm/runtime dependencies, and that is a hard
constraint.** There is no `dependencies` / `devDependencies` block in
`package.json` and no `node_modules` — everything is built on the Bun standard
library (`Bun.serve`, `Bun.spawn`, `bun:sqlite`, `fetch`, `node:fs`/`node:path`/
`node:os`) plus the external `git` and `herdr` binaries. The webapp under
`public/` is vanilla JS — no framework, no build step.

**Do not add an npm dependency without explicit approval from the CTO** (ask via
the butchr `ask` tool if you're an agent, or open it as a question first). This
keeps install/boot trivial (just Bun + the repo), keeps the supply-chain surface
at zero, and keeps the supervised/systemd deploy a single `bun run`. If you
think you need a library, first check whether the Bun stdlib already covers it —
it usually does (the MCP transport, the SSE stream, the operator CLI, and the
log rotator are all hand-rolled for exactly this reason).

---

## 5. Code conventions

**TypeScript / Bun, strict mode.** `tsconfig.json` is `strict: true` with
`verbatimModuleSyntax` and `allowImportingTsExtensions`. Match the existing
style:

- **Import with the `.ts` extension** (`import { run } from "./exec.ts"`) —
  required by the bundler resolution + `verbatimModuleSyntax`.
- `node:`-prefix stdlib imports (`node:fs`, `node:path`, `node:os`).
- One module per concern; modules are small and single-purpose. The file map
  below shows what lives where:

```
src/
  index.ts        entry: recover state, start dispatcher + server
  config.ts       env-driven config (every BUTCHR_* var documented inline)
  db.ts           SQLite schema + helpers
  ids.ts          task / directory id generation
  taskmd.ts       task.md read/write/append + prompt rendering
  exec.ts         spawn helpers (run / runOrThrow)
  git.ts          worktree / merge / diff / cleanup
  herdr.ts        herdr CLI wrapper
  events.ts       SSE pub/sub
  terminal.ts     open a GUI terminal attached to a running task
  directories.ts  directory service + HttpError
  tasks.ts        task service + state transitions (taskView projection)
  dispatcher.ts   dispatcher loop + per-task fallback watcher + workspace self-heal
  conformance.ts  read-only review gate (judge diff vs prompt)
  expand.ts       brief → task-prompt expander
  cto.ts          idea → task-spec generator (CTO-fork)
  server.ts       REST + SSE + MCP + static file serving (the route table)
public/
  index.html / style.css / app.js   vanilla webapp
```

- Prefer explicit, descriptive names and a comment block at the top of each
  module explaining its role. Comments explain **why**, not what.

**Shelling out — use the `exec` helpers.** All subprocess work goes through
`src/exec.ts`:

- `run(cmd: string[], { cwd? })` → `{ code, stdout, stderr, ok }`, never throws.
- `runOrThrow(cmd, opts)` → same, but throws a useful message on non-zero exit.

Pass argv as a **string array** (never a shell string) so there's no quoting/
injection surface. The one place a shell is used deliberately is launching the
agent and the verify/CI gate via `bash -lc` — keep new subprocess calls on the
array form.

**herdr access — go through `src/herdr.ts`.** Never call the `herdr` binary
directly from feature code. `herdr.ts` is the single wrapper: it runs the CLI
via `run()`, parses herdr's `{id, result}` JSON envelope, throws on `error`, and
exposes typed functions (`isUp`, `workspaceCreate`, `agentStart`, `agentRead`,
`agentDeregister`, …). The herdr **agent name is the task id** — keep that
invariant. Add new herdr interactions as functions here so the rest of the code
stays herdr-agnostic.

**Errors — `HttpError` for anything user-facing.** `src/directories.ts` defines
`class HttpError extends Error { status }`. Throw `new HttpError(<status>,
<message>)` from service code for expected failures (404 not found, 400 bad
input, 409 conflict, 502/503 upstream). The server's `handleError`
(`src/server.ts`) turns an `HttpError` into `{ error: message }` at its status;
anything else becomes a 500. Don't catch-and-stringify in handlers — let it
propagate.

**DB migrations — additive `ensureColumn` only.** The schema in `src/db.ts` is a
`CREATE TABLE IF NOT EXISTS` baseline plus a series of guarded
`ensureColumn(table, column, decl)` calls. `ensureColumn` checks
`PRAGMA table_info` and runs `ALTER TABLE … ADD COLUMN` only if the column is
missing, so existing databases upgrade in place with no data loss and no
migration framework. **New columns are added the same way: append an
`ensureColumn(...)` line — never edit the baseline `CREATE TABLE` for an existing
column, never write a destructive migration, never drop/rename a column.** New
columns must be nullable or carry a `DEFAULT` (existing rows get backfilled to
it).

**Serialization — `taskView`.** `taskView(id)` in `src/tasks.ts` is the
canonical task projection returned by the API and emitted over SSE: it merges the
DB row with the on-disk `task.md` (prompt, context, review notes) and computes
`blocked_by` / `blockerStates` / `deadBlockers` / `spawned_subtasks`. Return
`taskView(id)` from new endpoints and SSE events instead of raw rows so the shape
the webapp and CLI consume stays consistent. The matching `DirectoryView`
(`listDirectories`) is the directory equivalent.

---

## 6. How to add things

Keep changes small, match the surrounding module, and update the relevant section
of **this doc** in the same change (see [§8](#8-living-docs-update-on-every-change)).

**A REST route.** Routes register with `route(method, path, handler)` in
`src/server.ts` (path params like `:id` are parsed into the handler's second
arg `p`, so `p.id`). The handler returns a `json(data, status?)` `Response` and
throws `HttpError` on failure. Keep the handler thin — validate input, call the
service function in `tasks.ts`/`directories.ts`, return `json(taskView(...))`.
Add the operator CLI in `bin/butchr` too if it should be drivable from the shell
(each CLI subcommand maps onto exactly one route and adds no server logic).

**A `BUTCHR_*` config var.** Add a field to the `config` object in
`src/config.ts` using the typed env helpers (`env`, `envInt`, `envBool`,
`envList`) with a sensible default and a doc comment (that comment **is** the
reference for the var). Reference it as `config.<field>` (never read
`process.env` directly outside `config.ts`). If it's operationally relevant, note
it in [§3](#3-operations-runbook).

**A DB column / migration.** Append an `ensureColumn("tasks", "<col>", "<decl>")`
(or `directories`) line in `src/db.ts` next to the others, nullable or with a
`DEFAULT` (see §5). Surface it through `taskView` if the API should expose it.

**A webapp view.** Edit `public/app.js` / `index.html` / `style.css` — vanilla
JS, hash-routed, SSE-driven, no framework or build step. Consume the existing
REST + `/api/events` SSE contract; if you need new data, add the route first.

---

## 7. Testing

Tests run under Bun's built-in runner:

```sh
bun test                 # whole suite (test/*.test.ts)
bun test test/ci-gate.test.ts   # a single file
```

**Test seams — exercise behavior without a live claude/herdr stack.** The suite
is pure and in-process: it never spawns a real agent, herdr, or `bun build`/`bun
test` subprocess. The seams that make that possible (set these up in
`beforeAll`, mirror an existing test like `test/ci-gate.test.ts`):

- **Temp DB + data dir.** Point `BUTCHR_DATA_DIR` and `BUTCHR_DB` at
  `mkdtempSync(...)` dirs (and `BUTCHR_LOG_FILE=""` to silence file logging)
  **before importing `src/db.ts`/`src/tasks.ts`** — the db/config singletons read
  env at import time, so set env first, then `await import(...)`. Because those
  singletons are shared across test files in one run, give each file a **unique
  directory id** to keep rows from colliding.
- **`BUTCHR_HERDR_BIN=true`** — points the herdr binary at `/usr/bin/true`, so
  every herdr probe is a harmless no-op exit-0 (no herdr server needed).
- **`setCiRunner(fn)`** (`src/tasks.ts`) — inject a fake CI runner so the
  review-gate wiring is exercised without shelling out to `bun build`/`bun test`.
- **`setVerifyRunner(fn)`** (`src/verify.ts`) — inject a fake post-merge verify
  result so the revert-on-red decision is tested without a real gate run. Pass
  nothing to restore the default.
- A real **temp git repo** (`git init` + one commit) stands in for a registered
  directory so worktree/`task.md` paths resolve.

Clean up temp dirs in `afterAll`. Add a test alongside the feature it covers, and
treat the test suite as the behavioral source of truth.

**Build / type-check gate.** There is no separate typecheck step; the bundler is
the gate. A clean exit means it builds and type-resolves:

```sh
bun build src/index.ts --target bun --outfile /dev/null
```

Run **both** `bun test` and the build before proposing a change — they are the
same checks CI and the post-merge verify gate run (`BUTCHR_VERIFY_CMD` defaults
to exactly `bun build src/index.ts --target bun --outfile /dev/null && bun test`).

---

## 8. Living docs: update on every change

> **The golden rule of contributing to butchr: docs are part of the change, not a
> follow-up.** This doc is the **single source of truth** for how butchr works,
> and it is meant to describe butchr *as it actually exists in the tree right
> now*. The CI/verify gates only check that it builds and tests pass — keeping
> this doc honest is on you, and a reviewer will send a change back for skipping
> it.

**(a) Update this doc when a public surface changes — this is on you.** When a
**REST route, SSE event, config/env var, DB column, task state, MCP tool, or CLI
command** changes — added, changed, or removed — update the relevant section of
**CONTRIBUTING.md** in the same change so it never lags the code. Pure-internal
refactors that change no observable behavior don't need a docs edit — but if in
doubt, update it. Architecture details that belong in the code itself (a module's
role, a config var's semantics, the exact route table) live in the code and its
comments; this doc points at them rather than duplicating them, so keep those
comments honest too.

**(b) The [CHANGELOG.md](./CHANGELOG.md) entry is recorded by butchr at merge — do
NOT hand-edit it.** Every task used to append its own `[Unreleased]` bullet, so
under concurrency every task touched the same file and they all collided at merge.
butchr now appends the entry itself, **inside the serialized merge lock, after the
rebase**, derived from your **task summary** (the optional `summary` you pass to
`request_review`) and the task id — filed under `### Changed` in `[Unreleased]`.
So: **write a clear, user-facing summary** of what changed and why it matters (not
which files you touched) and butchr turns it into the changelog line. It's
idempotent (a re-merge won't double-add) and a docs-only diff skips the version
bump. **Do not edit CHANGELOG.md in your task** — an edit there just reintroduces
the collisions this removed.

**(c) The `version` in [package.json](./package.json) is bumped by butchr at merge —
do NOT hand-edit it.** On a successful merge butchr **patch-bumps** the version (the
simple per-task default), skipping the bump for a **docs-only** diff. You don't
touch `package.json`. `/health` reads it at import, so the bumped file is enough for
the API to report the new version. **Release cuts stay manual and human-driven**:
at release time someone (1) renames `[Unreleased]` to a new `[x.y.z] - YYYY-MM-DD`
heading, (2) starts a fresh empty `[Unreleased]` above it, and (3) sets the version
to the release `x.y.z` (a backwards-incompatible interface/config/data-model change
makes it a **minor** while pre-1.0, otherwise the accumulated patch bumps stand) —
the reserved `1.0.0` bump is the future "interfaces are now stable" promise.

Keep this doc honest and the repo stays self-describing: CONTRIBUTING.md answers
*how it works now*, while butchr keeps CHANGELOG.md (*what changed and when*) and
the version (*which surface you're on*) current for you at merge.

---

## 9. Contribution workflow

butchr work is organized as **tasks** — each task is a git worktree on its own
branch, and the agent working it submits for review via the `request_review` MCP
tool. However a change is authored, the gates are the same:

1. **Make it build + test green.** A change must pass `bun build … --outfile
   /dev/null` **and** `bun test` (§7). The **CI gate** runs these in the task's
   worktree on submission and writes an advisory pass/fail badge; it does not
   hard-block, but a red badge is a signal to fix before merge.
2. **Update CONTRIBUTING.md in the same change, and write a clear task summary** —
   see [§8](#8-living-docs-update-on-every-change): reflect any new/changed public
   surface in this doc (a change that doesn't carry its docs edit gets sent back),
   and pass a good `request_review` **summary** — butchr appends the
   **CHANGELOG.md** `[Unreleased]` entry and **bumps the version** from it
   automatically at merge, so you do **not** hand-edit those two files.
3. **Review → merge.** A reviewer approves or requests changes. On submission a
   read-only **conformance reviewer** (`src/conformance.ts`) also judges whether
   the diff actually satisfies the task prompt (and the conventions in this doc)
   and writes an advisory badge — like CI, it never hard-blocks. On **approve**,
   butchr rebases the branch onto the current default tip, **records the CHANGELOG
   `[Unreleased]` entry + patch-bumps the version** from your task summary
   (committed onto the branch, after the rebase, inside the merge lock), and
   **fast-forwards** (linear history), then runs the **post-merge verify gate**
   (`BUTCHR_VERIFY_CMD`) on the new tip in the repo root — a **RED result
   auto-reverts the merge off main** (the task goes `failed` with the failing
   output; the worktree is kept for a fixup). So a change that isn't actually
   green won't stay on main. On **request changes**, the same agent session
   resumes with the reviewer's notes and reworks in context.
4. **Conflict handling.** Concurrent tasks branch from the same base and don't
   see each other until merged, so two can conflict at merge time. Merges are
   serialized through a global queue and each is rebased onto the live tip first;
   a content conflict is **kicked back to the agent** as a resolution note (not
   dumped on the reviewer) and re-submitted. If you're chaining work, merge the
   first task before queueing the dependent — or express the ordering with
   `blocked_by` so the dependent waits.

---

## 10. Gotchas

- **Don't inline big context into the agent prompt / don't pass huge prompts.**
  The rendered prompt is handed to the agent as a single shell argv via
  `"$(cat <prompt-file>)"`, so it's bounded by `MAX_ARG_STRLEN` (~128 KB). butchr
  deliberately **lists context-file paths** in the prompt rather than inlining
  their bodies, and the agent reads the files itself. Exceeding the argv limit
  surfaces as **E2BIG** — an exec failure (exit 126/127 with no output) that the
  watcher routes to dispatch-retry, not a silent hang. Keep prompts and any
  inlined content small.
- **Restart to pick up merged code.** butchr is a long-running process; a running
  instance keeps executing the code it booted with. After merging a change,
  **restart the service** to pick it up (see
  [§3 "Restart safely"](#3-operations-runbook) — resolve the PID by listening port
  and kill that one; don't `pkill -f`). Restart is safe: butchr re-adopts its
  state on boot.
- **herdr down blocks dispatch.** With the herdr server unreachable, butchr stays
  *healthy* (the `/health` verdict ignores herdr) but **no task progresses past
  `queued`** — the tick loop returns early when herdr is down. If tasks are stuck
  in `queued`, check herdr first (`herdr status server`). Dispatch resumes
  automatically once herdr is back.
- **Set test env before importing modules.** The `config`/`db` singletons read
  env at import time. In tests, set `BUTCHR_*` env **then** `await import(...)` —
  importing first locks in the wrong paths.
