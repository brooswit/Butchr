# butchr

**Agent task harness on top of [herdr](https://github.com/).**

butchr is a lightweight service + webapp that organizes agent work around git
repositories: **directories are workspaces, tasks are git worktrees.** It handles
the full lifecycle from task creation through review and merge, delegating all
terminal/agent session management to herdr.

- **Stack:** Bun · SQLite (`bun:sqlite`) · herdr · git — **zero npm dependencies.**
- **Webapp:** vanilla JS single-page app, no framework.

---

## Concepts

- **Directory** — a git repository registered with butchr. Maps 1:1 to a herdr
  workspace. Adding it provisions the workspace; removing it tears it down.
- **Task** — the atomic unit of work, and a *filesystem artifact*, not just a DB
  row:
  - a directory at `<repo>/.butchr/tasks/<task-id>/`
  - a `task.md` inside it (prompt + metadata + rejection notes)
  - a git worktree at `<repo>/<task-id>` on a branch named `<task-id>`
- **Task ID** — `adjective-noun-4hex` (e.g. `swift-falcon-3a2f`), immutable,
  doubles as branch and worktree directory name.

SQLite tracks only runtime state. `task.md` on disk is the source of truth for
the prompt and metadata.

## Status lifecycle

```
queued → running → review → merged
            ▲          └────→ (request changes) → running   (SAME live agent, in-context)

any non-terminal state ──→ aborted (worktree + branch discarded, nothing merged)
```

The agent runs **interactively** and drives the review handshake itself via an
MCP tool — see [Agent-driven review (MCP)](#agent-driven-review-mcp).

| status   | meaning |
|----------|---------|
| queued   | worktree exists, `task.md` written, waiting for the dispatcher |
| running  | interactive agent executing inside the worktree |
| idle     | a *running* task whose agent has gone quiet — alive in its CLI but no output for `BUTCHR_IDLE_MS` (waiting on input, blocked, or just thinking). Not a separate lifecycle stage: it's a flag on `running` that clears the instant output resumes |
| review   | agent called `request_review` (it stays alive, blocked on the tool), awaiting human approval |
| merged   | approved → pane closed (agent killed), branch merged to the default branch, worktree + branch removed |
| aborted  | abandoned from any non-terminal state → agent stopped (if running), worktree + branch discarded, **nothing merged** |

On **request changes**, butchr does *not* restart the agent: it returns the note
to the still-alive `request_review` call and flips the task back to `running`, so
the agent keeps working with full context. (If the agent's session is gone — e.g.
butchr was restarted — it falls back to re-queuing and dispatching a fresh agent
with the note appended to `task.md`.)

**Aborting** is the escape hatch for work you don't want: a queued task you no
longer need, a running agent gone off the rails, or a `review` whose diff you'd
rather throw away than merge or re-run. It stops the agent (if running), removes
the worktree and branch, and parks the task in the terminal `aborted` state —
the `task.md` is kept as a record. Only `merged` tasks (already terminal) can't
be aborted.

## Concurrency

**Fully concurrent.** Every queued task is dispatched immediately and runs in
parallel — there is no per-directory "one at a time" limit. Each task gets its
own git worktree on its own branch, so tasks are isolated at the filesystem
level and can't clobber each other's files.

**The catch: tasks branch from the same base.** Concurrent tasks in one
directory each branch off the directory's current HEAD and never see each
other's changes until merged. So:

- Two tasks editing the same lines will merge cleanly individually but can
  **conflict with each other** at merge time (resolved during approve/merge).
- A task does **not** observe another in-flight task's changes while running.

This is accepted by design — isolation over coordination. If you need tasks to
build on each other, merge the first before queueing the second.

Set `BUTCHR_MAX_CONCURRENT` to cap the total number of simultaneously running
tasks across all directories (`0` = unlimited, the default).

---

## Requirements

- [Bun](https://bun.sh) ≥ 1.1
- `git` on `PATH`
- `herdr` on `PATH`, **with its server running** (`herdr server`, or just launch
  the herdr TUI). butchr will start without it and resume dispatch automatically
  once herdr is reachable.

## Run

```sh
bun run start      # or: bun run dev   (watch mode)
```

Then open the webapp at **http://127.0.0.1:47800**.

> Running this in production? See [OPERATIONS.md](./OPERATIONS.md) for the
> start/restart/recovery runbook.

### Crash supervision (keep butchr up)

For an unattended/long-running setup, run butchr under the bundled supervisor so
it relaunches itself if it ever crashes:

```sh
bun run start:supervised      # = bash scripts/supervise.sh
```

The supervisor (`scripts/supervise.sh`, plain bash, no extra deps) restarts the
server whenever it exits **non-zero**, backing off between restarts and bailing
out if it detects a tight crash loop. A **clean** exit (code 0 — including the
Ctrl-C / `SIGTERM` shutdown butchr traps) stops the supervisor too, so quitting
still quits for good. Tune it with:

| var | default | description |
|-----|---------|-------------|
| `BUTCHR_RESTART_DELAY` | `2` | seconds to wait before a restart |
| `BUTCHR_MAX_RESTARTS` | `10` | give up after this many crashes within the window (`0` = never give up) |
| `BUTCHR_CRASH_WINDOW` | `60` | crash-loop detection window, in seconds |

Auto-restart is **safe** because butchr re-adopts its state on boot: it re-queues
any task left `running` and finalizes any left `finalizing` from the prior run
(see `src/index.ts`), so a restart resumes work instead of orphaning it. To make
restarts crisp, any error that escapes to the top level is logged and exits the
process non-zero (so the supervisor relaunches a fresh, healthy server rather
than letting a half-broken one limp along).

#### Run it as a systemd user service

To start butchr on login and keep it supervised by systemd instead, drop a unit
at `~/.config/systemd/user/butchr.service`:

```ini
[Unit]
Description=butchr agent task harness
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/path/to/butchr
ExecStart=%h/.bun/bin/bun run src/index.ts
Restart=on-failure
RestartSec=2
# Add any BUTCHR_* overrides here, e.g.:
# Environment=BUTCHR_PORT=47800

[Install]
WantedBy=default.target
```

Then:

```sh
systemctl --user daemon-reload
systemctl --user enable --now butchr
journalctl --user -u butchr -f      # follow logs
```

`Restart=on-failure` mirrors the script's policy (restart on crash, stay down on
a clean stop). Use either the script **or** the systemd unit — not both.

## Configuration (environment variables)

| var | default | description |
|-----|---------|-------------|
| `BUTCHR_HOST` | `127.0.0.1` | HTTP bind host |
| `BUTCHR_PORT` | `47800` | HTTP port (REST + webapp) |
| `BUTCHR_DATA_DIR` | `~/.local/share/butchr` | butchr's own state dir |
| `BUTCHR_DB` | `<data>/butchr.db` | SQLite path |
| `BUTCHR_HERDR_BIN` | `herdr` | herdr binary |
| `BUTCHR_GIT_BIN` | `git` | git binary |
| `BUTCHR_TICK_MS` | `1500` | dispatcher poll interval |
| `BUTCHR_MAX_CONCURRENT` | `0` | cap on simultaneously running tasks across all directories; `0` = unlimited |
| `BUTCHR_AGENT_CMD` | `claude --dangerously-skip-permissions --mcp-config {{MCP_CONFIG}} "$(cat {{PROMPT_FILE}})"` | command run in the worktree to execute the agent (interactive). `{{PROMPT_FILE}}` → rendered prompt path; `{{MCP_CONFIG}}` → per-task MCP config path |
| `BUTCHR_AGENT_TIMEOUT_MS` | `3600000` | fallback ceiling: if an agent never calls `request_review`, it's swept to `review` after this long |
| `BUTCHR_IDLE_MS` | `60000` | how long a running agent's CLI can go without output before the task is flagged `idle`; `0` disables idle detection |
| `BUTCHR_TERMINAL_CMD` | _(auto-detect)_ | override for "Open terminal"; `{{CMD}}` → the shell-quoted `herdr agent attach` command |

The agent command runs via `bash -lc` with the **worktree as cwd**. Override
`BUTCHR_AGENT_CMD` to use any agent CLI.

Two placeholders are substituted by the dispatcher:

- `{{PROMPT_FILE}}` — absolute path to the rendered prompt (context files + prompt
  + prior review notes + the review-handshake instructions).
- `{{MCP_CONFIG}}` — absolute path to a per-task MCP config JSON
  (`<data>/mcp/<task-id>.json`) wiring the agent to butchr's `request_review`
  tool. It points at the per-task endpoint `http://<host>:<port>/mcp/<task-id>`.

The default launches Claude Code **interactively** (no `-p`), so the pane stays
live and attachable, and the agent signals completion by calling the MCP tool
rather than by exiting. If your override is a headless one-shot agent that exits
instead, the fallback watcher still sweeps it to `review` on exit.

---

## How dispatch works

On each tick the dispatcher finds every queued task and dispatches each one
immediately and concurrently (subject to `BUTCHR_MAX_CONCURRENT`):

1. Ensure the worktree exists (`git worktree add -b <id> <repo>/<id>`).
2. Render the prompt: each `context:` file's contents + the prompt + any prior
   review notes + the review-handshake instructions, written to
   `<data>/prompts/<id>.md`.
3. Write the per-task MCP config to `<data>/mcp/<id>.json`.
4. Start the **interactive** agent in the worktree via `herdr agent start <id>
   --cwd <worktree> --workspace <ws>`, wrapped so its output is `tee`'d to a log
   file (still visible live in the herdr pane).
5. The task moves to `review` when the agent calls the `request_review` MCP tool
   — *not* on process exit. A fallback watcher only steps in if the agent ends
   without submitting (see below).

If the directory's herdr workspace has gone away (herdr restart, manual close),
butchr **recreates it on the next dispatch** and updates its record — no manual
re-registration needed.

## Agent-driven review (MCP)

butchr hosts a tiny **MCP server** on its existing HTTP port at `/mcp/:taskId`
(hand-rolled JSON-RPC over Streamable HTTP, zero dependencies). Each task's
interactive agent connects to its own per-task endpoint and gets one tool:

- **`request_review({ summary? })`** — call it when the work is done. It **blocks**
  until a human responds (blocking is free token-wise: the agent just waits on a
  tool result). Calling it moves the task to `review` while the agent stays alive.

The reviewer's action releases that blocked call:

- **Approve** → butchr merges the branch (auto-committing any uncommitted worktree
  changes), removes the worktree, and **closes the pane** — which kills the agent
  mid-call. The blocked `request_review` never returns, so there is *zero* extra
  token spend and no "approved" round-trip.
- **Request changes** → the tool returns `{ decision: "changes_requested", notes }`
  to the **same live agent**, which addresses the notes in-context and calls
  `request_review` again. The task flips back to `running`; no restart.
- **Abort** → the pending call is released and the pane closed, then the worktree
  is discarded (the normal `aborted` path).

**Fallback.** If an interactive agent ever ends *without* calling `request_review`
— it exited, crashed, or you killed its pane — the watcher notices (the process is
gone / the herdr agent vanished) and sweeps the task to `review` with the captured
output prefixed by a note explaining why, so it never gets stuck in `running`.

## Watching a running task

Panes are **long-lived and interactive**: attaching to a task's pane in herdr
(`herdr agent attach <task-id>`) shows the live Claude Code CLI — you can watch it
work, or take over. The pane stays up through `review` (the agent is blocked on
`request_review`) and is closed only on approve/abort. herdr owns the PTY/workspace;
butchr owns task state and the review handshake.

From the webapp, a running task has an **Open terminal** button (task detail) and
a **terminal** link (directory task list) that launches a GUI terminal attached to
that live pane. butchr auto-detects an emulator (kitty, konsole, alacritty, xterm,
gnome-terminal, …); override with `BUTCHR_TERMINAL_CMD`. Needs
`DISPLAY`/`WAYLAND_DISPLAY` (i.e. run the service inside your desktop session).

## task.md format

```markdown
---
id: swift-falcon-3a2f
created: 2026-06-01T14:23:00Z
status: queued
context:
  - src/api/routes.ts
  - src/types.ts
---

## Prompt

Refactor the /tasks endpoint to use the new TaskSchema type.

## Review Notes

<!-- appended by butchr on each rejection -->
### Rejection — 2026-06-01T15:10:00Z
Missing error handling on the 404 branch.
```

`.butchr/` is added to the repo's `.gitignore` on registration.

## REST API

| method | path | description |
|--------|------|-------------|
| GET | `/api/directories` | list directories (with task counts) |
| POST | `/api/directories` | register `{ path, label? }` |
| DELETE | `/api/directories/:id` | unregister (tears down herdr workspace) |
| GET | `/api/directories/:id/tasks` | list tasks |
| POST | `/api/directories/:id/tasks` | create `{ prompt, context? }` |
| GET | `/api/tasks/:id` | task detail (prompt, snapshot, notes) |
| GET | `/api/tasks/:id/diff` | git diff of the task branch vs default branch |
| POST | `/api/tasks/:id/approve` | merge + clean up |
| POST | `/api/tasks/:id/reject` | request changes `{ note }` — returns the note to the live agent (or re-queues if its session is gone) |
| POST | `/api/tasks/:id/abort` | abort without merging — stop the agent, discard worktree + branch |
| POST | `/api/tasks/:id/terminal` | open a GUI terminal attached to a running task |
| GET | `/api/fs?path=` | list subdirectories of a path (powers the directory picker) |
| GET | `/api/events` | SSE stream of task/directory changes |
| POST | `/mcp/:taskId` | MCP (JSON-RPC) endpoint the task's interactive agent connects to for the `request_review` handshake |

## Merge strategy

Fast-forward when possible, falling back to a regular merge. Any uncommitted
worktree changes are auto-committed first. On conflict the task is held in
`review` with a conflict flag for manual resolution, then approve again.

## Project layout

```
src/
  index.ts        entry: recover state, start dispatcher + server
  config.ts       env-driven config
  db.ts           SQLite schema + helpers
  ids.ts          task / directory id generation
  taskmd.ts       task.md read/write/append + prompt rendering
  exec.ts         spawn helper
  git.ts          worktree / merge / diff / cleanup
  herdr.ts        herdr CLI wrapper
  events.ts       SSE pub/sub
  terminal.ts     open a GUI terminal attached to a running task
  directories.ts  directory service
  tasks.ts        task service + state transitions
  review.ts       pending-review registry (blocks/releases request_review calls)
  mcp.ts          per-task MCP server for the request_review handshake
  dispatcher.ts   dispatcher loop + per-task fallback watcher + workspace self-heal
  server.ts       REST + SSE + MCP + static file serving
public/
  index.html / style.css / app.js   vanilla webapp
```

## Out of scope (v1)

Auth, multi-user, file upload, agent selection (uses `BUTCHR_AGENT_CMD`),
automated reviewer.
