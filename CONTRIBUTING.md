# Contributing to butchr

The single living doc for butchr: what it is, how to run and operate it, the rules
the codebase holds itself to, the conventions to match, and how a change gets
proposed, gated, and merged. **This guide is the one human-facing document** —
when behavior changes, this file moves with it (see
[§8](#8-living-docs-update-on-every-change)).

The only other maintained artifact is the **[CHANGELOG.md](./CHANGELOG.md)**
(Keep a Changelog). **You — the task/agent — update it in your change**, and
butchr's changelog gate verifies you did (a code change with no changelog entry
fails the CI gate). butchr does **not** write it for you, and the version bump is
an opt-in per-repo setting — see the full living-docs convention in
[§8](#8-living-docs-update-on-every-change).

Architecture is not re-documented in prose — **the code is the reference.** The
file map in [§5](#5-code-conventions) and the module headers in `src/` describe
what lives where; each `BUTCHR_*` config var is documented inline where it's
defined in `src/config.ts`; the REST/SSE/MCP surface is the route table in
`src/server.ts`.

---

## 1. What butchr is

butchr is a lightweight service + webapp that organizes agent work around git
repositories: **workspaces are git repositories, tasks are git worktrees.** It handles
the full lifecycle from task creation through review and merge, delegating all
terminal/agent session management to **[herdr](https://github.com/)**.

- **Stack:** Bun · SQLite (`bun:sqlite`) · herdr · git — **zero npm dependencies.**
- **Webapp:** vanilla JS single-page app, no framework, no build step.

**Core concepts:**

- **Workspace** — a git repository registered with butchr. Maps 1:1 to a herdr
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
itself via the `request_review` MCP tool, and on "request changes" (or a `needs_info`
answer) the same live agent resumes in-context (`claude --resume <session-id>`)
rather than being restarted.

**The agent's MCP surface is exactly two tools** (`src/mcp.ts`): `request_review`
(submit work for review) and `raise` (escalate ANYTHING to the operator/CTO — a
question, a suggested change to the task itself, or a suggested decomposition into
sub-tasks; it parks the task in `needs_info` and resumes the session on the answer).
Agents are **workers, not task-managers**: there is no agent-side task CRUD and no
autonomous decomposition — a raised suggestion is acted on by the operator/CTO
through the REST API. (A `plan_preview` task additionally gets a one-shot
`propose_plan` tool for its pre-coding plan gate — see `src/mcp.ts`.)

**Resume re-grounding.** A resume re-enters the *same* session, so its prompt is a
**focused** message (the answer, or the review notes) — it relies on the session
still holding the original prompt + context. But a task can be **edited while it's
paused** (an operator revising the prompt/context of a task sitting in `needs_info`
or `in_review`). To keep the resumed agent grounded in the *current* `task.md`,
butchr fingerprints the prompt + context-file list it grounds an agent in
(`taskmd.groundingFingerprint` → the `grounding_fp` column, written by
`markRunning`) and, on every resume, compares it to the live `task.md`. On a
mismatch the dispatcher prepends a **re-ground block** (`taskmd.renderRegroundBlock`
— the current prompt + context, marked as superseding the session snapshot) ahead of
the focused answer/rework message. An *unedited* task resumes with the focused
message byte-for-byte as before. (Review notes are excluded from the fingerprint —
they already flow into the rework prompt.)

**The 12-state model** (`TaskStatus` / `STATE_META` / `isTerminal` in `src/db.ts`).
Each state has a *kind* — `agent` (an agent runs or is about to), `feedback` (butchr
surfaced an artifact and awaits the operator), or `idle` (terminal, or waiting on
something mechanical):

| state | kind | meaning |
|-------|------|---------|
| `idea` | feedback (brief) | a one-line brief **awaiting a spec**; butchr runs no agent — it pushes a `spec requested` channel event and waits for the task's responder (its story leader, else the CTO) to submit a spec (`POST /api/tasks/:id/spec`) → `spec_review` |
| `spec_review` | feedback | a submitted spec awaiting approval → `inactive`, or request-changes → `idea` |
| `blocked` | idle | waiting on `blocked_by` dependencies; auto-unblocks to `inactive` |
| `needs_info` | feedback | an agent asked a question; on answer it resumes (→ `inactive`) |
| `inactive` | agent (workspace) | **READY** — queued for the dispatcher, no live agent yet |
| `in_progress` | agent (workspace) | a **LIVE** workspace agent is building the code (the orthogonal `idle` flag marks one that has gone quiet → surfaced as a feedback condition handled by the task's responder; see §7) |
| `in_review` | feedback | a diff awaiting approval → mechanical merge, or request-changes → `inactive` |
| `merged` | idle (terminal) | landed on the default branch |
| `rolling_back` | idle | a rollback task's revert is being mechanically merged (a rollback happens **after** a merge) |
| `rolled_back` | idle (terminal) | a rollback task's revert landed on the default branch |
| `failed` | idle (terminal) | an **execution/dispatch failure** (give-up or post-merge revert) |
| `aborted` | idle (terminal) | a **deliberate operator cancel** |

**Ready vs. running** is carried by the *status* itself: `inactive` is READY (the
dispatcher launches its agent) and `in_progress` is a LIVE agent. `markRunning` flips
`inactive` → `in_progress` atomically with recording the herdr pane, so a running task
always has a pane and a ready task never does. A dispatch failure / resume / conflict
bounce re-arms the task as `inactive`.

**Approve merges mechanically** (no post-approval agent). Approving an `in_review` task
runs the merge directly (`finalizeMerge`): rebase onto the default branch → run the gate
→ merge → teardown → `merged`. A rebase **conflict** bounces the task back to `inactive`
so the *same* agent resumes in-context to resolve it (reusing the `request_review` resume
machinery), then re-reviews. A post-merge verify failure auto-reverts off the default
branch and lands the task in `failed`.

**`failed` vs `aborted`.** `failed` is reserved for execution/dispatch failures — a
dispatch give-up, a spec-gen give-up, or a post-merge verify revert. `aborted` is
reserved strictly for a deliberate operator cancel.

**Rollback** (the webapp "Roll back" button) creates a `kind='rollback'` task from the
built-in `rollback` template. It builds a revert like any task, but lands through its own
lifecycle tail: `rolling_back` while the revert merges, then terminal `rolled_back`
instead of `merged`.

**Concurrency — fully concurrent.** Every queued task is dispatched immediately
and runs in parallel; there is no per-workspace "one at a time" limit. Each task
gets its own git worktree on its own branch, so tasks are isolated at the
filesystem level. **The catch:** concurrent tasks in one workspace each branch
off the workspace's current HEAD and don't see each other's changes until merged,
so two editing the same lines can conflict at merge time (resolved during
approve/merge). This is accepted by design — isolation over coordination; if you
need tasks to build on each other, merge the first before queueing the second, or
express the ordering with `blocked_by`. `BUTCHR_MAX_CONCURRENT` caps the total
simultaneously running tasks across all workspaces (`0` = unlimited, default).

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
butchr ls [--workspace <id>] [--status <s>]  # compact id/status/ci table (idle shows status*)
butchr new <workspace> -m "<prompt>"   # create a task; <workspace> is a workspace id OR path
        [--blocked-by id,id]           #   start it blocked on those task ids
        [--allowlist a,b]              #   file allowlist: CI gate fails if the diff strays
butchr show <id>                       # status, ci, liveness, summary, review notes, blockers
butchr approve <id>                    # approve a task in review (merges its branch)
butchr reject <id> -m "<note>"         # send a reviewed task back for rework
butchr plan-approve <id> [-m "<text>"] # approve a plan-preview plan (-m adds steering notes)
butchr plan-reject <id> -m "<text>"    # reject a proposed plan with feedback (agent re-proposes)
butchr spec <id> -m "<spec>"           # submit the spec for an idea task (-m, or pipe stdin)
butchr requeue <id>                    # re-queue a failed/stuck task for a fresh dispatch
butchr block <id> --on id,id           # replace blocked_by (use --on '' to clear)
butchr wait <id> --until <state>       # block until the task reaches <state> (e.g. in_review)
butchr restart [--verify]              # restart the server; --verify blocks until it's healthy
butchr backups                         # list local DB snapshots (OFFLINE)
butchr restore <file|latest> [--force] # restore the DB from a snapshot (OFFLINE)
butchr --help                          # full usage
```

Each subcommand maps onto exactly one REST route (the route table in
`src/server.ts`); the CLI adds no server behavior. The lone exceptions are
`backups` / `restore`, which are **offline** filesystem operations. `wait` and
`restart --verify` are **blocking** helpers (they poll `/api/tasks/:id` and
`/health` respectively) so you no longer hand-roll curl+sleep loops; `restart`
relies on a supervisor that relaunches the process (the deployed systemd
`Restart=always`).

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
never mistaken for garbage. The **ready/running split migration** (`src/db.ts`)
re-buckets legacy rows: an old `in_progress`+no-pane row becomes `inactive` (ready),
an `in_progress`+pane row stays `in_progress` (re-adopted), and any lingering
`finalizing` row is routed to `in_review` for the operator to re-approve. Watch the
log for: re-adopted running agents; **auto-resumed** agents killed by a host/herdr
restart (see "Restart resilience" below); rescued tasks whose agent ended while butchr
was offline; rollback tasks re-driven from `rolling_back` (`recoverRollingBackTasks`);
**re-triggered CI/conformance gates** left stuck mid-flight by a restart
(`recoverStuckGates` — see "Gate recovery" below); and `reapOrphans` (`src/reaper.ts`),
a conservative once-on-boot sweep that removes **leaked git worktrees + branches** and
**herdr husks** for tasks in a terminal state (`merged` / `failed` / `rolled_back` /
`aborted`) or with no DB row — it never touches the main worktree or a worktree whose
task is still live (`inactive` / `in_progress` / `in_review` / `rolling_back` /
`blocked` / …), and skips herdr deregistration entirely when herdr is down (worktree
reaping still runs). This is the automated fix for the old

### Restart resilience (auto-resume on host/herdr restart)

The production answer to "the laptop lost power mid-work and every agent had to be
re-queued by hand." When the host loses power / is re-logged-in, **herdr restarts and
every agent's `claude` process is killed**, but herdr restores the pane as a **bare
login shell** and keeps the agent NAME registered — so `agentExists(taskId)` still
says "alive" even though claude is dead. The old behavior re-adopted such a task and
the idle-nudge then typed `continue` into the dead shell forever
("continuecontinuecontinue"). butchr now **auto-resumes** instead, with no operator
action (and idle is no longer auto-nudged at all — it is surfaced to the task's
responder; see §7):

- **Liveness is the OS process, not the pane.** `src/liveness.ts` `claudeAlive(sessionId)`
  scans `/proc` for a live process carrying the session id as a **distinct argv token**
  (claude runs with `--session-id <uuid>` / `--resume <uuid>`, so the uuid is its own
  argv element). A killed claude is gone from `/proc` → dead; a genuinely-alive (even
  quiet/idle) claude still has its process → alive, so a *working* agent is **never**
  false-resumed. This is the ground-truth signal that survives a herdr restore (which
  keeps the pane/agent-name) and the run-log mtime (which can't tell idle from dead).
- **Auto-resume = relaunch the same session.** When butchr finds a task it thinks is
  `in_progress` but whose claude isn't alive **and** it didn't exit on its own (the
  per-run `<id>.done` exit-code file is the discriminator: present ⇒ a clean exit ⇒
  rescue to review; absent ⇒ *killed* ⇒ resume), `tasks.requeueForResume` tears down the
  dead husk pane and resets the task to READY. The normal dispatch tick then relaunches
  it via `claude --resume <session_id>` (full prior context). If the session transcript
  is gone, it falls back to a **fresh** dispatch from the full prompt (never a silent
  zombie).
- **Bounded** by `BUTCHR_MAX_RESUME_ATTEMPTS` (default 5): the `resume_attempts` column
  counts consecutive auto-resumes that didn't reach review; past the cap the task is
  rescued to `in_review` for a human instead, so a session that dies the instant it
  relaunches can't re-dispatch-loop. The counter resets on progress (reaching review)
  or any operator re-queue.
- **Four triggers, same path:** (1) startup `reconcileRunningTasks` — the full-reboot
  recovery; (2) the per-task watcher's **idle guard** (`dispatcher.handleIdleAgent`
  checks `claudeAlive` when a task goes idle — a dead agent is auto-resumed, never
  surfaced as nudgeable); (3) the **`idle-handling` nudge** (`tasks.nudgeTask` re-checks
  `claudeAlive` and routes a dead pane to auto-resume rather than poking it); and (4) a
  boot-time backstop sweep `reaper.reapDeadRunningAgents`. Net behavior: power dies
  mid-work → on next boot, agents resume from their sessions with no lost work and no
  operator action.

### Gate recovery (re-trigger stuck CI/conformance gates on restart)

The **sibling of auto-resume, for the review GATES.** The CI build/test gate
(`tasks.triggerCi`) and the spec-conformance reviewer (`conformance.triggerConformance`)
run **fire-and-forget in butchr's own process**: each flips the task's badge to in-flight
(`ci_status='running'` / `conformance_status='checking'`), `await`s a subprocess, then
writes back the result. A power loss / restart kills butchr mid-run, so the **settle write
never happens** and the task is left stuck on the in-flight value **forever** — it can
never become mergeable (auto-merge needs `ci_status='pass'`) until an operator requeues it
by hand. That was a real incident.

- **Detection — in-process liveness.** Because the gate runs *in* butchr, a restart that
  kills the gate also empties the in-process in-flight sets (`ciGateInFlight` /
  `conformanceGateInFlight`). So a DB status of `running`/`checking` with **no** matching
  in-flight entry is **provably stale**. On a fresh boot the sets are empty, so *every*
  in-flight gate is stale (the restart-case rule) and gets re-triggered; while butchr is
  up the sets track genuinely-running gates, so the same sweep is safe to re-run without
  clobbering a gate that is legitimately still running (the rarer mid-run-death case).
- **Recovery — re-trigger.** `tasks.recoverStuckGates` sweeps every `in_review` task with a
  stale in-flight gate and re-runs `triggerCi` / `triggerConformance` so the status settles
  to a real result instead of hanging.
- **Bounded** by `BUTCHR_MAX_GATE_RECOVERY_ATTEMPTS` (default 5): the
  `gate_recovery_attempts` column counts consecutive recovery re-triggers that didn't
  settle; past the cap (or when the worktree the gate needs is gone, or recovery is
  disabled `<=0`) the stuck gate is **force-settled** instead of re-triggered (CI →
  `'fail'` with an explanatory summary; conformance → `NULL`, its "couldn't run" value) so
  the task is **never** left stuck and a gate that dies the instant it starts can't loop.
  The counter resets to 0 the moment any gate settles a real result.
- **Two triggers, same path:** (1) startup `recoverStuckGates` (in `index.ts`, before the
  dispatcher starts) — the primary recovery; and (2) a boot-time backstop sweep
  `reaper.reapStuckGates` (a no-op on a clean boot, since the primary already re-triggered
  them and they're now live-in-process — mirroring `reapDeadRunningAgents`). Net behavior:
  power dies mid-gate → on next boot, the gate re-runs and the task settles to a real
  pass/fail with no operator action.

### Connectivity-restored event (event-only; no auto-recovery)

The recurring failure mode is the **opposite** of the restart cases above: the host
loses internet (laptop on battery, a network blip), so the **agents'** model-API calls
die mid-work and sessions get killed/zombied — while **butchr itself survives** (it's
local; only the agents' model calls need the internet). butchr is therefore the right
place to detect the outage and signal **recovery**.

`src/connectivity.ts` runs a monitor for the life of the process (independent of any
workspace, started in `index.ts`): it periodically probes the model API endpoint and
tracks a **debounced** up/down state machine. ANY resolved HTTP response (even a
401/403/405/5xx) proves the internet works → reachable; only a network error / DNS
failure / timeout is a failed probe. It declares **DOWN only after N consecutive
failures** (so one transient probe can't false-trigger) and fires **exactly once** on
the DOWN→UP transition, capturing how long it was down — never on steady-up,
steady-down, or the down-transition.

On recovery it **broadcasts a single `connectivity.restored` SSE event** (carrying
`restoredAt` + `downMs`) which fans out to push notifications on **both** recipients:
the long-lived **CTO sessions** (the existing one-way CTO channel) and **every live
worker build agent** — the same channel is attached to the worker launch
(`{{CHANNEL_FLAG}}` in `agentCmd`/`resumeCmd` + a stdio server in the per-task MCP
config) in a **connectivity-only mode** (`BUTCHR_CHANNEL_CONNECTIVITY_ONLY=1`) so a
worker hears "network restored" mid-session but **never** sees another task's
review/idle/attention events.

It is **strictly EVENT-ONLY**: butchr takes **no** recovery action on regain (no
auto-requeue/resume/abort — the restart-resilience layers above are untouched); each
recipient decides what to do (surface, don't blind-automate). The worker-side channel
is **gated on the master switch** and **non-fatal** — if it fails to attach, the worker
still launches and works normally. Configurable via `BUTCHR_CONNECTIVITY` (master
switch, default on), `BUTCHR_CONNECTIVITY_URL`, `BUTCHR_CONNECTIVITY_INTERVAL_MS`,
`BUTCHR_CONNECTIVITY_TIMEOUT_MS`, and `BUTCHR_CONNECTIVITY_FAILURES`.

### Power-loss resilience (durable writes + loose-object self-heal)

A power loss that interrupts a git write **mid-fsync** can leave **truncated/0-byte
loose objects** in a managed repo's `.git/objects`; git then refuses to merge/prune
and the repo wedges (a real incident — an operator had to `git fsck` and hand-remove
the dangling corrupt objects). butchr hardens **every managed repo** against this on
two fronts, both best-effort (never block registration or boot):

- **Durable object writes (prevention).** On register **and** on every boot butchr
  sets, idempotently, on each repo: `core.fsyncObjectFiles=true` (honored by git
  < 2.36) and `core.fsync=all` (git ≥ 2.36; the older knob is ignored there, the new
  one is harmless on older git). So an interrupted write can't leave a truncated
  object in the first place. See `git.setGitDurability`; disable with
  **`BUTCHR_GIT_FSYNC=0`**. (Boot re-applies it, so repos registered before this
  existed get hardened with no re-registration.)
- **Loose-object self-heal (recovery).** On boot, for each managed repo, butchr
  scans for dangling/corrupt loose objects and **auto-removes only the ones it can
  PROVE are unreachable from any ref** — recovering from the power-loss corruption
  class instead of wedging. See `git.healLooseObjects`; disable the boot sweep with
  **`BUTCHR_GIT_HEAL=0`**.

  **Safety — how an object is proven safe to remove (a bug here would corrupt a
  repo, so the bar is "provably unreachable"):**
  1. **Detect (union of two detectors).** The candidate set is (a) a cheap filesystem
     scan for **0-byte** loose object files **plus** (b) the SHAs **`git fsck`** flags
     as empty/corrupt that still exist as loose objects — so a **non-empty-but-corrupt**
     object (a partial, non-zero truncation) is caught too, not only 0-byte ones. fsck
     runs unconditionally and only *widens* the set (never a delete trigger on its
     own). If **both** detectors come back empty → cheap no-op return, *without* the
     expensive ref walk (a clean boot stays cheap).
  2. **All-refs-intact.** Walk **every** resolvable ref (branches/tags + HEAD) with
     `git rev-list --objects`. rev-list inflates every commit/tree it reaches and
     exits non-zero the instant it hits a corrupt/missing one, so if **any** ref's
     walk fails there is **reachable** corruption → **bail: delete nothing**, surface
     the shas, log loud.
  3. **Belt-and-suspenders.** From the successful walks butchr has the full reachable
     object closure. If **any** candidate sha appears in it (e.g. a corrupt *blob*,
     which step 2 enumerates by name without inflating, so wouldn't have failed the
     walk) → **bail the same way**. Only candidates **provably absent** from the
     reachable closure are removed.

  Removal is **surgical and load-bearing** (`rmSync` each provably-unreachable corrupt
  object); the follow-on `git prune` is **optional hygiene** (best-effort, its failure
  never fails the heal). **Reachable corruption is never auto-deleted** — it is logged
  at error level (`git-heal … REACHABLE corruption — left UNTOUCHED …`) with the repo
  to `git fsck` by hand. Watch the boot log for `git-heal …` lines: how many
  unreachable objects were removed per repo, and any repo with reachable corruption
  surfaced for manual repair.

### herdr model

butchr delegates all PTY/session management to herdr, mapped by **task id**: one
herdr workspace per registered workspace (created on registration, torn down on
unregister); one tab + one pane per task; **the herdr agent name IS the task id**
(`agentStart(task.id, …)`, `agentExists(id)`, `agentRead(id)`,
`agentDeregister(id)` all key off it). To inspect a running task by hand:
`herdr agent attach <task-id>`. If a workspace's herdr workspace vanishes (herdr
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

**Do not add an npm dependency without explicit approval from the CTO** (raise it
via the butchr `raise` tool if you're an agent, or open it as a question first). This
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
  ids.ts          task / workspace id generation
  taskmd.ts       task.md read/write/append + prompt rendering
  exec.ts         spawn helpers (run / runOrThrow)
  git.ts          worktree / merge / diff / cleanup
  herdr.ts        herdr CLI wrapper
  events.ts       SSE pub/sub
  terminal.ts     open a GUI terminal attached to a running task
  workspaces.ts   workspace service + HttpError
  tasks.ts        task service + state transitions (taskView projection)
  dispatcher.ts   dispatcher loop + per-task fallback watcher + workspace self-heal
  conformance.ts  read-only review gate (judge diff vs prompt)
  expand.ts       brief → task-prompt expander
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

**Errors — `HttpError` for anything user-facing.** `src/workspaces.ts` defines
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

The one sanctioned exception is a **pre-1.0 conceptual rename done in place**:
`migrateDirectoriesToWorkspaces` (run once at the top of `src/db.ts`, before the
baseline `CREATE TABLE`s) renamed the `directories` table → `workspaces` and the
`directory_id` columns → `workspace_id` via guarded `ALTER … RENAME` so every
existing row — and its opaque `dir-…` id VALUE — survived untouched (no
drop/recreate). Each statement is presence-guarded, so it is a clean no-op on an
already-migrated or fresh DB. This is a rename, not the routine additive path
above; reach for it only for a deliberate model rename, never for ordinary schema
evolution.

**Serialization — `taskView`.** `taskView(id)` in `src/tasks.ts` is the
canonical task projection returned by the API and emitted over SSE: it merges the
DB row with the on-disk `task.md` (prompt, context, review notes) and computes
`blocked_by` / `blockerStates` / `deadBlockers`. Return
`taskView(id)` from new endpoints and SSE events instead of raw rows so the shape
the webapp and CLI consume stays consistent. The matching `WorkspaceView`
(`listWorkspaces`) is the workspace equivalent.

---

## 6. How to add things

Keep changes small, match the surrounding module, and update the relevant section
of **this doc** in the same change (see [§8](#8-living-docs-update-on-every-change)).

**A REST route.** Routes register with `route(method, path, handler)` in
`src/server.ts` (path params like `:id` are parsed into the handler's second
arg `p`, so `p.id`). The handler returns a `json(data, status?)` `Response` and
throws `HttpError` on failure. Keep the handler thin — validate input, call the
service function in `tasks.ts`/`workspaces.ts`, return `json(taskView(...))`.
Add the operator CLI in `bin/butchr` too if it should be drivable from the shell
(each CLI subcommand maps onto exactly one route and adds no server logic).

**A `BUTCHR_*` config var.** Add a field to the `config` object in
`src/config.ts` using the typed env helpers (`env`, `envInt`, `envBool`,
`envList`) with a sensible default and a doc comment (that comment **is** the
reference for the var). Reference it as `config.<field>` (never read
`process.env` directly outside `config.ts`). If it's operationally relevant, note
it in [§3](#3-operations-runbook).

**A DB column / migration.** Append an `ensureColumn("tasks", "<col>", "<decl>")`
(or `workspaces`) line in `src/db.ts` next to the others, nullable or with a
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
  workspace id** to keep rows from colliding.
- **`BUTCHR_HERDR_BIN=true`** — points the herdr binary at `/usr/bin/true`, so
  every herdr probe is a harmless no-op exit-0 (no herdr server needed).
- **`setCiRunner(fn)`** (`src/tasks.ts`) — inject a fake CI runner so the
  review-gate wiring is exercised without shelling out to `bun build`/`bun test`.
- **`setVerifyRunner(fn)`** (`src/verify.ts`) — inject a fake post-merge verify
  result so the revert-on-red decision is tested without a real gate run. Pass
  nothing to restore the default.
- A real **temp git repo** (`git init` + one commit) stands in for a registered
  workspace so worktree/`task.md` paths resolve.

Clean up temp dirs in `afterAll`. Add a test alongside the feature it covers, and
treat the test suite as the behavioral source of truth.

**Build / type-check gate.** There is no separate typecheck step; the bundler is
the gate. A clean exit means it builds and type-resolves:

```sh
bun build src/index.ts --target bun --outfile /dev/null
```

Run **both** `bun test` and the build before proposing a change. These are the
checks butchr's own CI / verify gate should run against **this** repo — but butchr
is a general tool that manages *other* repos, so it does **not** hardcode them: the
gate command defaults to **empty** (no gate) and is configured per managed repo via
the workspace's `gate_cmd` (or a global `BUTCHR_VERIFY_CMD`). When butchr is pointed
at its own repo (a dev/dogfood setup), set that to
`bun build src/index.ts --target bun --outfile /dev/null && bun test ./test`.

Two more **per-workspace, opt-in** settings shape how butchr treats a repo's
version/changelog conventions (both OFF by default, each `NULL`-inherits a global
default; `""` disables it for that workspace). They're set the same way as
`gate_cmd` — at register time or via `PATCH /api/workspaces/:id` — and documented
inline where their columns are declared in `src/db.ts`:

| Setting | Global default | What it does |
|---------|----------------|--------------|
| `version_file` | `BUTCHR_VERSION_FILE` (empty) | The version file butchr **patch-bumps at merge** (e.g. `package.json`). Empty/absent = no bump; a docs-only diff and a missing/parseless file are graceful no-ops. |
| `changelog_path` | `BUTCHR_CHANGELOG_PATH` (empty) | The changelog file the **CI gate requires a code change to update** (e.g. `CHANGELOG.md`). Empty = gate off; docs-only/empty diffs are exempt. |
| `release_mode` | OFF | **Versioned-releases mode** (see ["Versioned releases"](#versioned-releases-per-workspace) below). When on, EVERY merge bumps `version_file` by the task's declared level and stamps that task's changelog entry with the assigned version + date; the changelog gate goes strict. Off = today's opt-in patch-bump behavior. |
| `branch_isolation` | OFF | **3-level branch isolation** (see [§11](#11-3-level-branch-isolation-stories)). When on, stories *opened afterward* are isolated — each gets its own branch, its subtasks merge into the story branch (re-gated + merged to the default branch on completion). Off = today's behavior (every task merges straight to the default branch). Boolean (`null` = off); already-open stories keep their captured `isolated` bit (§11.8). |

### Versioned releases (per-workspace)

A workspace can opt into **versioned-releases mode** (`release_mode`, OFF by default —
set like `gate_cmd`, at register time or via `PATCH /api/workspaces/:id`). It changes how
butchr treats versions and the changelog for **that workspace only** (every surface keys
off the `release_mode` column — no workspace id is ever hardcoded):

- **Every change ships a version.** On each successful merge butchr bumps the workspace's
  `version_file` *and* relocates the changelog's `[Unreleased]` body into a fresh
  `[X.Y.Z] - YYYY-MM-DD` section — so each merge owns its heading (no more `[Unreleased]`
  merge cascades). The changelog gate is **strict**: every non-empty diff, *including
  docs-only*, must carry an entry, and the docs-only bump-skip is dropped.
- **The bump size is task-declared** (`patch` default | `minor` | `major`): set at creation
  (`butchr new … --bump <level>`, or the bump selector in the New-task modal) or any time
  before merge (`POST /api/tasks/:id/version_bump`). The assigned version lands on the
  task's `released_version` (shown as a `vX.Y.Z` chip on merged tasks in the webapp).
- **A `major` bump needs a human double-confirm.** Approve does **not** merge a major task —
  it **parks** it. Landing it takes **two consecutive** confirms (`butchr confirm-major <id>`
  twice, or the "Confirm major version" button on the task; streak `0→1→2`); **any** other
  action (approve, request-changes, re-review, re-declaring the bump) **resets the streak to
  0**. Auto-merge never auto-confirms — the major gate is always the human.
- **The version is butchr's, assigned at merge** (inside the serialized merge lock, after
  the rebase) — you never hand-edit the version file or the version heading.

### Feedback responders (structural)

Every feedback surface — a task awaiting a spec/approval/answer/review, or a live agent
gone **idle** — has a **responder**: who is expected to act. WHO that is follows the
**structure of the work**, never any per-workspace config (there is no step-responder
config — it was removed in the responder redesign, story st-def561dd):

- **A story SUBTASK** (`story_id` set) → its **story LEADER**, always. Subtask feedback is
  **terminal at the leader** — there is **no** task-level escalation. The leader answers
  questions, reviews specs/diffs, and handles idle for its own subtasks.
- **A NON-STORY task** (`story_id` null — a rollback or internal/system task) → the **CTO**,
  or the **USER** once the CTO escalates it (**`POST /api/tasks/:id/escalate`** sets
  `escalated_to_user` — the single cto→user boundary; it 409s on a story member, and resets
  on each fresh feedback state).
- **A STORY itself** → the **CTO**: a leader's story-level **ask**
  (**`POST /api/stories/:id/ask`**), story-completion sign-off, and a decomposition-plan
  sign-off. The CTO may **escalate** a story ask to the user
  (**`POST /api/stories/:id/escalate`**); either responder **`/answer`s** it.
- **CTO → USER** is the only escalation boundary above the CTO (for a non-story task or a
  story ask). There is **never** escalation at the subtask level.

**This is who's *expected* to act, never a backend gate.** butchr stays
**responder-agnostic**: every feedback surface is pushed to its responder's channel **and**
stays actionable by a human in the webapp — the action endpoints (`/spec`, `/approve`,
`/reject`, `/answer`, `/nudge`) are open regardless. The structural responder drives only
(a) **channel routing** — which agent's notification feed an item lands on (a story
leader's vs the CTO's; see `channel.ts` `routeOwns`) — and (b) the **webapp's awaiting-who
emphasis** (a `user` item shows a prominent "awaiting you" banner; a `cto`/`story` item a
muted "you can also act").

**Is a task awaiting feedback?** `tasks.isAwaitingFeedback(row)` — true when its status is
a feedback state (`idea` / `spec_review` / `in_review` / `needs_info`) **or** it is a live
build agent gone idle (`in_progress` + the `idle` flag). The resolved responder is
`tasks.pendingResponder(row)`, surfaced on the task view as the computed
**`pending_responder`** field (`story` | `cto` | `user` | `null`):

| condition | `pending_responder` |
|-----------|---------------------|
| not awaiting feedback | `null` |
| story member (`story_id` set) | `story` (the leader) — terminal, no tier |
| non-story, not `escalated_to_user` | `cto` |
| non-story, `escalated_to_user` | `user` |

so the webapp and agents read who-acts directly off the task. The `needs_info`
plan-vs-question distinction stays derivable from `status + plan_preview` (a plan-preview
task in `needs_info` awaits **plan approval**; any other is a raised **question**) at the
surfaces that need it.

> **Known simplification — `needs_info` plan-vs-question.** A `needs_info` task holds
> *either* a proposed plan (`propose_plan`, plan-preview gate) *or* a raised question
> (`raise`) in the same `question` column; nothing on the row records which, so the only
> signal is `plan_preview`. A plan-preview task that **raises a question during
> implementation** therefore reads as a plan rather than a question. This affects only the
> webapp's emphasis (the backend treats every `needs_info` identically — answerable by a
> human, pushed to the channel). A future task can add a precise marker (e.g. a
> `plan_proposed`/`plan_approved` flag) to disambiguate.

**Spec generation (the `idea` state) in detail.** When an `idea` task is created it does
**not** fork a spec generator — it parks in `idea` and butchr pushes a `spec requested`
event on the one-way channel carrying the brief + task id. The responder (a story member's
**leader**, else the **CTO** — or a human in the webapp) writes the spec and submits it via
**`POST /api/tasks/:id/spec { spec }`** (`tasks.submitSpec` → the unified feedback path),
which rewrites the prompt brief → spec and advances the task to `spec_review`.

**Idle handling (a live agent gone idle) in detail.** Idle is a **flag** on an
`in_progress` build agent (claude alive but its CLI quiet past `BUTCHR_IDLE_MS`), **not** a
13th state — so it stays orthogonal to `status` while still being a feedback surface. When
the dispatcher watcher flags a task idle (`tasks.setIdle`) it captures the ANSI-stripped
run-log tail into **`idle_context`** (`BUTCHR_IDLE_CONTEXT_LINES` lines) so the responder
can see what the agent was doing. The one-way channel then pushes an **`agent idle`** event
(`meta.state="idle"`) carrying the snapshot (`AttentionBridge` tracks the idle flag
separately from status, emitting only on the 0→1 flip). butchr **no longer auto-types
`continue`** — the responder reads `idle_context` and acts deliberately: **`POST
/api/tasks/:id/nudge { text? }`** (`tasks.nudgeTask`) to steer with guidance (or a bare
`continue`), or `/requeue` / `/abort` if it's wedged or off-track. In the webapp the **Idle
agent** panel shows `idle_context` + the same action buttons.

**Liveness guard (the power-loss incident fix).** A herdr/host restart kills claude but
leaves the pane as a bare login shell with the agent name still registered, so
`agentExists` lies "alive". butchr therefore **never pokes a pane it can't prove is alive**:
both `dispatcher.handleIdleAgent` (the watcher's idle step) and `tasks.nudgeTask` re-check
`liveness.claudeAlive` (the `/proc` session-token probe) and route a dead pane to
`tasks.requeueForResume` (auto-resume) instead of sending keystrokes. `idle_context` is
cleared in lockstep with the `idle` flag (centralized in `setStatus`, plus the raw-UPDATE
clear paths), so a stale snapshot never lingers after the agent resumes or moves on.

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

**(b) YOU update the [CHANGELOG.md](./CHANGELOG.md) in your change — butchr's gate
verifies you did.** butchr is a general tool that manages *other* repos, each with
its own changelog shape (or none), so it no longer ASSUMES one or writes a
fixed-format entry. The rule is flipped from how it used to work: **the task/agent
owns the changelog entry.** Add a clear, user-facing `[Unreleased]` bullet
describing *what changed and why it matters* (not which files you touched) in the
same change. The **changelog-update gate** then checks your task's diff at review
time — a **code (non-docs) change that didn't touch the changelog file FAILS the CI
gate** (a docs-only or empty diff is exempt). The gate is **opt-in per workspace**
and the changelog path is configurable: it's OFF unless the workspace sets a
`changelog_path` (or the global `BUTCHR_CHANGELOG_PATH` default), so repos without a
changelog aren't forced to have one. For **this** repo, the gate is configured to
require `CHANGELOG.md`. Concurrent tasks each editing `[Unreleased]` can collide at
merge — that's resolved through the normal conflict kick-back (§9.4), the same as
any other shared file.

**(c) The `version` in [package.json](./package.json) is bumped by butchr at merge
ONLY when the workspace opts in — and you never hand-edit it.** Not every repo keeps
a version file, so the merge-time patch-bump is **opt-in per workspace**: it's OFF
unless the workspace sets a `version_file` (the relative path of the file to bump,
e.g. `package.json` — or the global `BUTCHR_VERSION_FILE` default). When enabled,
butchr **patch-bumps** that file's `"version": "x.y.z"` field on a successful merge
(inside the serialized merge lock, after the rebase, so concurrent tasks never
collide on it), skipping the bump for a **docs-only** diff and gracefully no-op'ing
when the file is absent or has no semver version field. For **this** repo, the bump
is configured against `package.json`; `/health` reads it at import, so the bumped
file is enough for the API to report the new version. **Release cuts stay manual and
human-driven**: at release time someone (1) renames `[Unreleased]` to a new
`[x.y.z] - YYYY-MM-DD` heading, (2) starts a fresh empty `[Unreleased]` above it,
and (3) sets the version to the release `x.y.z` (a backwards-incompatible
interface/config/data-model change makes it a **minor** while pre-1.0, otherwise the
accumulated patch bumps stand) — the reserved `1.0.0` bump is the future "interfaces
are now stable" promise.

Keep this doc honest and the repo stays self-describing: CONTRIBUTING.md answers
*how it works now*, **you** keep CHANGELOG.md (*what changed and when*) current in
each change (the gate enforces it), and butchr keeps the opted-in version (*which
surface you're on*) current for you at merge.

---

## 9. Contribution workflow

butchr work is organized as **tasks** — each task is a git worktree on its own
branch, and the agent working it submits for review via the `request_review` MCP
tool. However a change is authored, the gates are the same:

1. **Make it build + test green.** A change must pass `bun build … --outfile
   /dev/null` **and** `bun test` (§7). The **CI gate** runs these in the task's
   worktree on submission and writes an advisory pass/fail badge; it does not
   hard-block, but a red badge is a signal to fix before merge.
2. **Update CONTRIBUTING.md AND CHANGELOG.md in the same change** — see
   [§8](#8-living-docs-update-on-every-change): reflect any new/changed public
   surface in this doc (a change that doesn't carry its docs edit gets sent back),
   and add a clear `[Unreleased]` **CHANGELOG.md** entry — the **changelog gate**
   verifies a code change touched the changelog (see §8b). A good `request_review`
   **summary** still helps the reviewer, but butchr no longer derives the changelog
   from it. The **version** is bumped by butchr at merge only when this workspace
   opted in via `version_file` (§8c), so you do **not** hand-edit `package.json`.
3. **Review → merge.** A reviewer approves or requests changes. On submission a
   read-only **conformance reviewer** (`src/conformance.ts`) also judges whether
   the diff actually satisfies the task prompt (and the conventions in this doc)
   and writes an advisory badge — like CI, it never hard-blocks. On **approve**,
   butchr rebases the branch onto the current default tip, **patch-bumps the version
   file if this workspace opted in** (committed onto the branch, after the rebase,
   inside the merge lock — your own CHANGELOG entry is already on the branch), and
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

---

## 11. 3-level branch isolation (stories)

> **Status: BUILT.** The merge model below is implemented and available
> **per-workspace** via the `branch_isolation` flag (`PATCH /api/workspaces/:id
> {"branch_isolation": true}`; see workspaces.setWorkspaceBranchIsolation). The flag
> **defaults OFF** and is **not enabled on any live workspace** by default — so with no
> workspace opted in, butchr behaves **exactly** as documented in §1 (every task merges
> straight to the default branch). Each new path stays **guarded by the per-story
> `isolated` bit** (§11.8): only stories *opened while a workspace has the flag ON*
> capture `isolated = 1` and route through the story-branch model; everything else is
> byte-for-byte today's single-level merge.

### 11.1 Goal & the core insight

`main` is the trunk. Each **story** gets its own branch off `main`; each
**subtask** merges into its **story branch**, not `main`; the completed story is
**re-gated** and merged into `main`. So `main` only ever sees whole, verified
stories. The CI/verify gate runs at **both** levels — subtask→story-branch (as
tasks are gated today) **and** the whole story before story→`main`.

The whole design rests on one mirroring insight: **a story worktree is to its
subtasks exactly what the repo root `dir` is to standalone tasks today.** The
repo root has `main` checked out; standalone tasks fast-forward into it and the
post-merge verify runs there. We reproduce that one level down — an isolated open
story gets a **story worktree** (a checkout on the story branch); subtasks
fast-forward into it and the subtask post-merge verify runs in it. Because the
ff-target is always a real checkout, every existing invariant (ff into a
checkout, verify in that checkout, reset-on-red resets that checkout) holds at
both levels with **no special cases**.

Worktree layout for an isolated story (`<repo>` = the registered repo root):

```
<repo>/                          # main checked out — standalone tasks ff here (today)
<repo>/butchr-story-<storyId>/   # NEW: story worktree, on butchr/story/<storyId>
                                 #      subtasks ff here; subtask verify runs here
<repo>/<subtaskId>/              # per-subtask worktree, branched FROM the story branch
```

### 11.2 Base resolution (git.ts stays DB-free)

`git.ts` is DB-free and its functions resolve the merge target by calling
`defaultBranch(dir)` internally. To retarget a subtask onto its story branch we
thread an explicit **`base?: string`** (merge-target ref) param into every
`git.ts` function that consumes the base, **defaulting to `defaultBranch(dir)`
when absent** — so behavior is byte-for-byte unchanged wherever the param is not
supplied. `tasks.ts` (which has story/DB access) resolves the per-task base via a
new `resolveBase(row)` helper and passes it down. We deliberately **reject** a
resolver-callback: it would punch DB access back into `git.ts` (breaking its
DB-free purity), make the data-flow implicit, and be harder to unit-test than a
plain string param.

`git.ts` functions that gain the `base` param:

| function | how it uses `base` |
|----------|--------------------|
| `createWorktree` | branch the new worktree **from** the base tip: `worktree add -b <taskId> <path> <base>` |
| `worktreeIsReusable` | its stale-base probes (`branchContainsBase` / `branchOwnCommitCount`) measure vs `base` |
| `commitsBehind` | `taskId..base` |
| `hasChanges` | `branchOwnCommitCount` `base..taskId` |
| `diff` | `base...taskId` |
| `diffStat` | `base...taskId` |
| `isBehindDefault` | `branchContainsBase(base)` |
| `rebaseOntoDefault` | rebase the branch onto `base` (pre-dispatch) |
| `merge` | rebase onto `base`; **plus** an ff-target (see §11.4), default `{dir, defaultBranch}` |

`taskDiffIsDocsOnly` and `bumpVersionFile` already take `base`. `resetHard(dir,
sha)` and `headSha(dir)` need **no** signature change — the caller passes the
**story worktree path** instead of `dir` for a subtask. `cleanup` needs no base.

### 11.3 Story branch — naming, creation, idempotency

- **Name:** `butchr/story/<storyId>` (pure `storyBranchName` helper). The
  `butchr/story/` prefix can't collide with task branches (named by task id) or
  `main`.
- **Created lazily** off the **current `main` tip** the first time an isolated
  story actually needs it — right before its first subtask worktree is branched
  (an `ensureStoryBranch(dir, storyBranch)` runs in the base-resolution path
  before `createWorktree`). Lazy beats eager-on-open: a story opened but never
  decomposed never leaves an orphan branch, and `createStory` stays
  side-effect-light.
- **Idempotent / restart-safe:** `ensureStoryBranch` mirrors `createWorktree`'s
  validate-or-rebuild — reuse a valid story branch + worktree, rebuild a
  broken/missing one; the story-worktree dir is added to `.git/info/exclude` like
  task worktrees.
- **"`main` moved since open" is a non-issue at creation** (the cut point is
  whenever the branch is lazily made). `main`'s later drift is reconciled at
  completion by the rebase-onto-`main` (§11.4).

### 11.4 The 3-level rebase strategy

1. **subtask → story branch** (today's flow, retargeted). The pre-dispatch
   `rebaseOntoDefault` uses `base = story branch`. `merge()` rebases the subtask
   onto the story-branch tip in the subtask worktree, then fast-forwards the
   **story worktree** to it (`git -C <storyWt> merge --ff-only <subtaskBranch>`)
   — identical ff mechanics to `main` today, just a different checkout. In-flight
   sibling subtasks **are kept current with the advancing story branch**: the
   pre-dispatch rebase retargets `base = story branch`, exactly as it tracks
   `main` today.
2. **story → `main`** (on completion). The story branch was cut from `main` and
   `main` has since moved, so rebase the story branch onto current `main`
   **in the story worktree**, then ff `main` at `dir`. This is exactly today's
   `merge()` flow with task = story-branch and base = `main`, so we generalize /
   reuse `merge()`.
   - **story ↔ `main` conflict:** the leader is an **operator** (no worktree of
     its own) and cannot resolve code conflicts. On conflict, abort (story branch
     **and** `main` left untouched), set the story `merge_blocked`, and fire a
     `merge-conflict` story-attention event **directly to the CTO** (`target:'cto'`,
     **not** the leader — the leader can't act on it: it is an operator with no
     worktree, and butchr (not the leader) detects the conflict, so it notifies the
     CTO directly rather than routing through the leader's story-level ask seam).
     **CTO conflict runbook** (carried verbatim in the event `detail`, and the action
     a human/CTO performs): in the **story worktree**
     (`<repo>/butchr-story-<storyId>`, on `butchr/story/<storyId>`),
     `git rebase <default-branch>`, resolve each conflicting file + `git add` it,
     `git rebase --continue` to completion, then **re-PATCH the story `done`**
     (`PATCH /api/stories/:id {"status":"done"}`) to re-attempt the land
     (`merge_blocked → merging → …`). The story does **not** complete (see §11.7).
     *(Future, not built: an auto-spawned reconcile agent in the story worktree.)*
   - **Global merge queue:** story→`main` moves `main`, so it **must** go through
     `runExclusiveMerge`. For the first cut, **all** merges (subtask→story **and**
     story→`main`) route through the **single existing global queue** — simplest,
     proven, and it guarantees a story→`main` merge never races a subtask→story
     merge of the same story. *(Per-story queues for cross-story parallelism = a
     noted future optimization.)*

### 11.5 Both-level CI/verify wiring

- **Subtask CI at review** (`triggerCi`): the build/test command runs in the
  subtask worktree — **base-agnostic, unchanged**. But `triggerCi`'s
  changelog-gate and allowlist-gate call `git.diffStat` (`base...taskId`), so
  thread `base = story branch` there, so a member's diff is measured against the
  story branch, not `main`.
- **Subtask post-merge verify** (`finalizeMerge`): today the
  `priorTip`-capture / `verifyDefaultBranch` / reset-on-red target `dir`
  (`main`). For an isolated member, retarget them to the **story** worktree /
  branch: capture the story-branch tip before the ff, ff into the story worktree,
  run `verifyDefaultBranch` in the **story** worktree, and on RED `resetHard` the
  **story** worktree to the captured story-branch `priorTip`. This is driven by a
  `resolveMergeContext(row)` → `{ ffWorktree, targetBranch, base }`: standalone =
  `{ dir, main, main }`; isolated member = `{ storyWt, storyBranch, storyBranch }`.
- **Story-level re-gate** (before story→`main`, on the completion path): re-run
  the gate on the **story-branch tip in the story worktree** (already checked out
  there at the story tip). Then the story→`main` merge; **after** the `main` ff,
  run the post-merge verify in `dir` and `resetHard` `dir` to the captured
  `main` `priorTip` on RED — exactly today's `main`-level flow.

**Story-level RED is a HARD BLOCK (refinement #1).** This is **not** merely the
`main`-level reset-on-red. If the story-level re-gate (CI on the story-branch tip
**before** story→`main`) comes back RED, then: the story→`main` merge **does not
run**, the story **does not complete** (it lands `merge_blocked`), `main` is
**never touched**, and the **leader is notified** (a `gate-red` story-attention
event, `target:'story'`) to fix it via **more subtasks** (a `merge_blocked` story
accepts new subtasks; each one landing re-fires the leader's completion-review so
it re-requests the land). A red story must **never** reach `main`. (The post-merge
verify in `dir` *after* a green re-gate + ff still follows the ordinary
reset-`main`-on-red path as a final backstop — that RED also lands `merge_blocked`
and notifies the leader the same way, since `main` was restored and the story
didn't land.)

### 11.6 Rollback / revert + sha semantics per level

- **Subtask merge:** `baseSha` / `mergedSha` (→ `merge_base_sha` / `merged_sha`
  on the task row) are **story-branch** shas (story tip before/after the ff). A
  subtask rollback reverts **within the story branch** and is itself a story
  member — symmetric with standalone tasks today.
- **Story merge:** the story→`main` merge yields `baseSha` / `mergedSha` against
  **`main`** = the whole story's commit range on `main`. Store these at **story
  level** (new `stories.merge_base_sha` / `merged_sha` columns) so a whole-story
  rollback reverts `main` to the pre-story tip.
- **Caveat to surface in the UI/docs:** the story→`main` rebase **rewrites** the
  story's commits, so a subtask's story-branch shas are meaningless against
  `main` afterward. A subtask "Roll back" is only valid **while the story is
  open** (it reverts within the story branch); once the story lands on `main`, the
  **story-level** revert is the unit.

### 11.7 Story states — "`done`" means "landed on `main`" (refinement #2)

Today a story is `open | done | aborted`, and the leader's "goal met" action
PATCHes `done` directly (which tears the leader down and reports complete up).
Under branch isolation that is unsafe: a story is only **truly** done once its
branch is merged to `main` **and** the post-merge verify in `dir` is green. The
leader's PATCH-`done` therefore becomes a **request to land**, and butchr owns
the window between that request and the merge actually succeeding. Phase E adds
two story states so a story whose work is **not on `main`** can **never** read as
`done`:

| story status | meaning | leader |
|--------------|---------|--------|
| `open` | accepting subtasks | up |
| `merging` | completion requested; story-level re-gate + story→`main` merge in flight (transient; serialized through the global merge queue) | up |
| `merge_blocked` | re-gate RED **or** story↔`main` conflict — the story did **not** land, `main` untouched, escalation fired; a **visible merge-failed surface**, **not** `done` | up |
| `done` | branch merged to `main` **and** post-merge verify in `dir` green; **only now** the leader is torn down and `story complete` reports up to the CTO | torn down |
| `aborted` | deliberate operator cancel (unchanged) | torn down |

Transitions on a completion request:
`open → merging → done` (landed) **or** `open → merging → merge_blocked`
(re-gate RED / conflict). From `merge_blocked` the leader fixes a RED gate with
**more subtasks**, or a CTO/human resolves a conflict in the story worktree;
either way it **re-attempts** (`merge_blocked → merging → …`). Only `done` and
`aborted` tear the leader down — `merging` and `merge_blocked` keep it up
(extend `onStoryStatusChanged` accordingly). `merging` is transient and
restart-recoverable, re-driven on boot exactly like a `rolling_back` task
(`finalizeMerge` recovery). **No story is ever silently `done` with work that
isn't on `main`.**

### 11.8 Feature guard & inertness (incl. the bootstrapping cut)

- **Guard:** a per-workspace `branch_isolation` column (mirrors `release_mode`;
  default `0` = OFF). While OFF, `resolveBase` / `resolveMergeContext` return
  `main` / `{ dir, main }` for **everyone** (including story members) — today's
  exact behavior — and **no** story branch is ever created.
- **The critical bootstrapping cut:** capture a per-**story** `isolated` bit **at
  `createStory` time** from the workspace flag. Base/merge-context isolation keys
  off the **story's captured bit**, *not* the live flag. So flipping the
  workspace flag **never** retroactively changes an already-open story. **This
  build story** (and all of its own subtasks) was opened with the flag OFF →
  `isolated = 0` → its subtasks keep merging to `main` via the existing path for
  the story's whole life. Only stories **opened after** the final activation
  subtask capture `isolated = 1` and get a story branch. That is exactly the
  "activate only for stories opened after the flag" guarantee, with **zero** risk
  to any not-yet-merged subtask of this story.
- **All** new paths (story-branch create/merge/cleanup, subtask retarget,
  story re-gate, the new story states) are guarded behind `isolated = 1`; the
  standalone task→`main` merge is untouched throughout the build.

### 11.9 Phased, additive, inert build plan

Each merge-spine subtask below uses the **plan-preview** gate, lands **one**
`[Unreleased]` CHANGELOG entry, and makes **no** `package.json` edits
(release_mode does the version stamp at merge). Any further architectural fork is
escalated to the CTO/operator.

1. **B-plumb (inert).** Add the `base?` params to the `git.ts` consumers in
   §11.2 (defaulting to `defaultBranch`/`dir` → byte-for-byte unchanged) + the
   `merge` ff-target params; add `storyBranchName`; add `resolveBase` /
   `resolveMergeContext` in `tasks.ts` (return `main` / `{ dir, main }` for all,
   for now); add the `branch_isolation` workspace column + per-story `isolated`
   bit (both default `0`). No behavior change.
2. **C-lifecycle (guarded / unused).** `ensureStoryBranch` (validate-or-rebuild
   create off `main` + story worktree) + `removeStoryBranch` + the generalized
   story→`main` merge; capture `isolated` at `createStory` when the flag is on;
   lazy `ensureStoryBranch` wiring. Still OFF → unused.
3. **D-subtask-merge (behind guard).** `resolveBase` returns the story branch for
   an isolated member; retarget `createWorktree` / `rebaseOntoDefault` / `diff` /
   `diffStat` / `commitsBehind` + `triggerCi`'s gate diffStats; `finalizeMerge`
   uses `resolveMergeContext` to ff into / verify in / reset the story worktree;
   subtask shas vs the story branch.
4. **E-story-merge (behind guard).** On the Phase-6 completion path for an
   isolated story: add the `merging` / `merge_blocked` states; re-gate the
   story-branch tip in the story worktree (**RED = hard block + notify**);
   story→`main` via `runExclusiveMerge` (rebase onto `main`, ff `main` at `dir`,
   post-merge verify in `dir`, reset `main` on red); store story-level shas;
   `removeStoryBranch`; story↔`main` conflict → escalation up the chain. Only a
   landed-and-green story reaches `done`.
5. **F-activate.** Flip the workspace `branch_isolation` guard on (new stories
   capture `isolated = 1`), remove scaffolding, and e2e: open a story → decompose
   → subtasks merge to the story branch + both gates → complete → re-gate +
   story→`main` + post-verify + cleanup; confirm existing (`isolated = 0`)
   stories and standalone tasks are unchanged.
