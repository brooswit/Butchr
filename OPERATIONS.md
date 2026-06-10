# OPERATIONS.md — butchr production runbook

Operator runbook for running and recovering butchr on this machine. For concepts
and the full feature reference, see [README.md](./README.md); this doc is the
practical "how do I run/restart/debug it" companion.

butchr is a single Bun process: HTTP server (REST + webapp + SSE + per-task MCP)
plus a dispatcher loop. State lives in SQLite. Terminal/agent sessions are owned
by **herdr**, which must be running for dispatch to make progress.

---

## Start

```sh
bun run src/index.ts
```

Detached (survives the shell), with output to the log:

```sh
nohup bun run src/index.ts >> ~/.local/share/butchr/butchr.log 2>&1 &
disown
```

(butchr also tees its own console output to the log file via `initFileLogging()`,
so the `nohup` redirect is belt-and-suspenders.)

Defaults (all overridable via `BUTCHR_*` env — see README config table):

| What | Default | Override |
|------|---------|----------|
| HTTP host:port | `127.0.0.1:47800` | `BUTCHR_HOST` / `BUTCHR_PORT` |
| Data dir | `~/.local/share/butchr` | `BUTCHR_DATA_DIR` |
| SQLite db | `~/.local/share/butchr/butchr.db` | `BUTCHR_DB` |
| Log file | `~/.local/share/butchr/butchr.log` | `BUTCHR_LOG_FILE` |

Webapp: **http://127.0.0.1:47800**.

For an unattended setup, prefer the supervisor or the systemd user unit described
in README ("Crash supervision"). butchr exits **non-zero** on any unhandled error
so a supervisor relaunches a fresh process, and exits **0** on Ctrl-C / SIGTERM so
a clean stop stays stopped.

---

## Auto-recovery (systemd user services) — recommended

This is the production answer to "butchr died on power loss and had to be
hand-restarted." It runs butchr **and** herdr under the systemd **user** manager
with `Restart=always`, so they relaunch on any crash and start on boot — no
operator action after the one-time enable. A small health-watchdog timer is also
installed: it probes `/health` every ~30s and restarts butchr if the endpoint is
unreachable or the dispatcher tick has gone stale.

Everything lives in `deploy/` (unit templates) and `scripts/` (installer +
watchdog) — plain shell + systemd, **no extra dependencies, no `src/` changes.**

| File | Role |
|------|------|
| `deploy/butchr.service` | butchr server (`bun run src/index.ts`), `Restart=always`, journald logging |
| `deploy/herdr.service` | `herdr server` (PTY/session manager butchr dispatches into), `Restart=always` |
| `deploy/butchr-health.service` + `.timer` | watchdog: curls `/health`, restarts butchr if down/stale |
| `scripts/install-service.sh` | renders the templates with real paths, installs them, `daemon-reload`, prints the enable commands |
| `scripts/health-watchdog.sh` | the probe the timer runs (dependency-free curl + bash) |

The `deploy/*` files are **templates** — `@REPO_DIR@`/`@BUN@`/`@HERDR@` are
substituted with absolute paths at install time so the units don't depend on the
user manager's minimal PATH. Don't point systemd at `deploy/` directly; install
them first.

### 1. Install the units

From the repo root:

```sh
bash scripts/install-service.sh
```

Idempotent — safe to re-run after pulling changes (it re-renders and overwrites
the installed units, then reloads). It writes to `~/.config/systemd/user/`, runs
`systemctl --user daemon-reload`, validates with `systemd-analyze --user verify`,
and then **prints** the enable commands. It does **not** enable or start anything
— that privileged step is left to you (below).

### 2. Enable + start (operator runs these)

```sh
systemctl --user enable --now herdr.service
systemctl --user enable --now butchr.service
systemctl --user enable --now butchr-health.timer
```

Both **butchr and herdr must run** — with herdr down, no task progresses past
`queued` (butchr stays "healthy" but idle; see Health). `butchr.service` softly
`Wants` herdr, so starting butchr also pulls herdr in.

### 3. Survive logout / start on boot

By default user services stop when you log out. Enable lingering so the user
manager (and thus butchr + herdr) keeps running across logout and starts at boot:

```sh
loginctl enable-linger "$USER"
```

### Status, logs, health

```sh
systemctl --user status butchr.service herdr.service
systemctl --user list-timers butchr-health.timer

journalctl --user -u butchr.service -f          # follow butchr logs
journalctl --user -u herdr.service -f           # follow herdr logs
journalctl --user -u butchr-health.service      # watchdog probe results / restarts
journalctl --user -t butchr --since "10 min ago"

curl -s http://127.0.0.1:47800/health | jq      # see Health section below
```

(butchr also tees to `~/.local/share/butchr/butchr.log` independently of journald.)

### Disable / stop

```sh
systemctl --user disable --now butchr-health.timer
systemctl --user disable --now butchr.service
systemctl --user disable --now herdr.service
# optional: stop the user manager from lingering after logout
loginctl disable-linger "$USER"
```

A `systemctl --user stop` is a **manual** stop — `Restart=always` does not
override it, so a deliberately stopped service stays down until you start it
again (same semantics as Ctrl-C on the bundled supervisor).

### Notes & tuning

- **Crash-loop backstop.** The service units cap restarts at 10 within 60s
  (`StartLimitIntervalSec`/`StartLimitBurst`). If butchr is genuinely wedged it
  stops trying — but the health timer's `systemctl --user restart` clears that
  limit and revives it, and a manual restart does too.
- **Non-default port / env.** Drop `BUTCHR_*` overrides in
  `~/.config/butchr/butchr.env` (read via `EnvironmentFile=-`, optional). If you
  change `BUTCHR_PORT`, also set `BUTCHR_HEALTH_URL` for the watchdog —
  `Environment=BUTCHR_HEALTH_URL=http://127.0.0.1:<port>/health` in
  `deploy/butchr-health.service` (then re-run the installer).
- **Watchdog cadence.** Edit `OnUnitActiveSec` in `deploy/butchr-health.timer`
  and re-run the installer.
- **One supervisor only.** Use the systemd units **or** `scripts/supervise.sh` —
  not both at once.

---

## Restart safely

**Find the process by the PORT it's listening on, and kill that PID:**

```sh
ss -ltnp | grep :47800
# ... users:(("bun",pid=12345,fd=...))
kill 12345
```

**Do NOT** `pkill -f 'bun run src/index.ts'`. `bun run` launches the server under
a wrapping shell, so that pattern matches **multiple** processes — including the
subshell — and, if you run it from a session that itself matches, it can kill the
killer (the `pkill` invocation's own shell) before the real server dies, leaving
a half-killed, orphaned server. Always resolve the listening PID via the port and
kill exactly that one.

After the kill, start again with the Start command above. Restart is safe because
butchr re-adopts its state on boot (see Startup self-heal): it re-attaches live
agents, rescues dead ones to `review`, finalizes anything left finalizing, and
reaps leaked artifacts.

---

## Build / type check

No separate test step; verify the build compiles and type-checks with:

```sh
bun build src/index.ts --target bun --outfile /dev/null
```

A clean exit means it builds. Run this before deploying a change.

---

## Health

```sh
curl -s http://127.0.0.1:47800/health | jq
```

(Also at `/api/health`.) Returns **200** when healthy, **503** when degraded.
Key fields:

- **`status`** — `"ok"` (200) or `"degraded"` (503).
- **`db.ok`** — SQLite reachable (a trivial `SELECT 1` succeeded). `false` ⇒ 503.
- **`tick.alive`** — dispatcher loop liveness. `true` while ticking normally (or
  still starting up, before the first tick). Goes `false` ⇒ 503 if the loop has
  ticked at least once but not within ~5 tick intervals (min 10s) — i.e. the
  dispatcher wedged. `tick.count` / `tick.lastTickAt` / `tick.ageMs` give detail.
- **`herdr.reachable`** — whether the herdr server answers. **Best-effort and does
  NOT affect the 200/503 verdict** — butchr stays "healthy" with herdr down, but
  no task will progress past `queued` until herdr is back. If tasks are stuck in
  `queued`, check this first.
- **`tasks`** — counts grouped by status (`queued`, `running`, `review`, `merged`,
  `aborted`, `rejected`, …). A quick at-a-glance of the work pipeline.
- `version`, `uptimeSec` — build/version and process uptime.

`healthy = db.ok && tick.alive`. herdr being down alone will **not** trip 503.

---

## Startup self-heal

On boot (`src/index.ts`), butchr repairs state left by a prior run, in order,
**after** re-adopting running agents (`reconcileRunningTasks`) so live/just-merged
work is never mistaken for garbage. Watch the log for these lines:

- `[butchr] re-adopted N running agent(s) from a prior run`
- `[butchr] rescued N task(s) whose agent died while butchr was offline`

**`recoverFinalizingTasks()`** — completes any task stranded in the legacy
`finalizing` state (service killed mid-wrap-up). The branch was already merged to
main, so it just finishes the job: closes the pane, cleans up, marks `merged`.
Emits:

- `[butchr] finalized N task(s) left finalizing from a prior run`

**`reapOrphans()`** (`src/reaper.ts`) — conservative, runs once on boot. Cleans up
artifacts leaked by tasks that reached a **terminal** state (`merged` / `aborted`
/ `rejected`) or that no longer have a DB row:

- **Leaked git worktrees + branches** — for each registered repo it scans
  `git worktree list --porcelain` and, for any direct child worktree
  `<repo>/<taskId>` whose task is terminal (or missing), runs
  `git worktree remove --force` + `git branch -D` (prunes if removal fails). It
  **never** touches the main worktree or a worktree whose task is still
  queued/running/review/finalizing.
- **herdr husks** — a terminal-state task whose agent name is still registered
  with herdr gets deregistered (clears the name, closes its pane/tab). **Skipped
  entirely when herdr is down**; worktree reaping still runs (git works
  regardless).

Emits per item, then a summary:

- `[butchr] reaped orphaned worktree <path> (task aborted | no task row)`
- `[butchr] reaped herdr husk for terminal task <id> (<status>)`
- `[butchr] reaped N orphaned worktree(s), M herdr husk(s) on startup`

This is the automated fix for the old "an aborted task's worktree/branch survived
a restart and had to be removed by hand" bug — you should rarely need to clean up
worktrees manually.

---

## herdr model

butchr delegates all PTY/session management to herdr, mapped by **task id**:

- **One herdr workspace per registered directory** — created on registration,
  torn down on unregister.
- **One tab per task, one pane per task.** Each task gets a dedicated herdr tab
  (`tab create`) and its agent runs in that tab's pane (`agent start <task-id>
  --tab …`). The dedicated tab keeps tasks from splitting into a wall of panes.
- **The herdr agent name IS the task id.** `agentStart(task.id, …)`,
  `agentExists(id)`, `agentRead(id)`, `agentDeregister(id)` all key off the task
  id. To inspect a running task by hand: `herdr agent attach <task-id>`.

If a directory's workspace has vanished (herdr restart/manual close), butchr
recreates it on the next dispatch — no manual re-registration needed.

---

## Task lifecycle

```
queued → running (may flag idle) → review → merged
                                      │
            (request changes) → rejected → resume same session → running
any non-terminal state ───────────────────────────────────────→ aborted
```

- **queued** — worktree + `task.md` exist; waiting for the dispatcher.
- **running** — interactive claude agent executing in the worktree. **idle** is
  not a separate state: it's a flag on `running` set after `BUTCHR_IDLE_MS`
  (default 60s) with no new agent output, cleared the instant output resumes.
- **review** — the agent called the `request_review` MCP tool (non-blocking: it
  records the request and the agent exits). Awaiting human approve / reject /
  abort.
- **merged** — approved → branch merged to the default branch (auto-committing any
  uncommitted worktree changes; fast-forward, else a merge commit), worktree +
  branch removed, pane closed. Terminal.
- **rejected → resume** — "request changes" re-launches the **same** claude
  session via `BUTCHR_RESUME_CMD` (`claude --resume <session-id>`) with the
  reviewer's notes, so the agent re-enters with full prior context and works back
  to `running`.
- **aborted** — escape hatch from any non-terminal state: stop the agent, discard
  worktree + branch, **nothing merged**. `task.md` kept as a record. Terminal.

On a merge conflict during approve, the task is held in `review` with a conflict
flag for manual resolution — resolve, then approve again.
