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
                      └────→ rejected → queued (re-runs with the note appended)

any non-terminal state ──→ aborted (worktree + branch discarded, nothing merged)
```

| status   | meaning |
|----------|---------|
| queued   | worktree exists, `task.md` written, waiting for the dispatcher |
| running  | agent executing inside the worktree |
| review   | agent finished, output snapshot captured, awaiting human approval |
| merged   | approved → branch merged to the default branch, worktree + branch removed |
| rejected | rejected with a note → note appended to `task.md`, re-queued |
| aborted  | abandoned from any non-terminal state → agent stopped (if running), worktree + branch discarded, **nothing merged** |

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
| `BUTCHR_AGENT_CMD` | `cat {{PROMPT_FILE}} \| claude --dangerously-skip-permissions {{CONTINUE}} -p` | command run in the worktree to execute the agent. `{{PROMPT_FILE}}` is replaced with the rendered prompt's path; `{{CONTINUE}}` is replaced with `BUTCHR_AGENT_CONTINUE_ARG` on a re-run and the empty string on the first run |
| `BUTCHR_AGENT_CONTINUE_ARG` | `--continue` | substituted for `{{CONTINUE}}` when re-running a task that has already been started once (e.g. after a rejection). Lets the agent resume its prior session instead of starting a new one. If the resume exits non-zero, butchr automatically retries the run fresh (`{{CONTINUE}}` empty). Set empty to always start fresh |
| `BUTCHR_AGENT_TIMEOUT_MS` | `3600000` | max time to wait for an agent to finish |

The agent command runs via `bash -lc` with the **worktree as cwd**. Override
`BUTCHR_AGENT_CMD` to use any agent CLI.

---

## How dispatch works

On each tick the dispatcher finds every queued task and dispatches each one
immediately and concurrently (subject to `BUTCHR_MAX_CONCURRENT`):

1. Ensure the worktree exists (`git worktree add -b <id> <repo>/<id>`).
2. Render the prompt: each `context:` file's contents + the prompt + any prior
   review notes, written to `<data>/prompts/<id>.md`.
3. Start the agent in the worktree via `herdr agent start <id> --cwd <worktree>
   --workspace <ws>`, wrapped so its output is `tee`'d to a log file (still
   visible live in the herdr pane) and a completion marker with the exit code is
   written when it finishes. If the task has run before (a rejected re-run, or a
   run recovered after a restart), `{{CONTINUE}}` expands to
   `BUTCHR_AGENT_CONTINUE_ARG` (`--continue` by default) so the agent **resumes
   its prior session** in the same worktree rather than starting fresh; first
   runs get a blank session. The resume is best-effort: if it exits non-zero
   (claude can refuse `--continue` when there's no resumable session), the
   dispatcher **falls back to a fresh run** of the same command so the task
   still makes progress instead of failing.
4. A watcher polls for the marker, captures the log as the output snapshot, and
   transitions the task to `review`.

If the directory's herdr workspace has gone away (herdr restart, manual close),
butchr **recreates it on the next dispatch** and updates its record — no manual
re-registration needed.

## Watching a running task

> **Note on herdr integration.** The spec sketches `herdr wait agent-status done`
> + `herdr pane read` for completion/output. In practice the running herdr
> destroys a pane the instant a one-shot command exits, which loses both the
> wait and the output for non-interactive agent runs. butchr therefore detects
> completion and captures output via filesystem markers (`tee` + a `.done`
> marker), which is agent-agnostic and robust. herdr still owns the PTY/workspace
> so you can watch or attach to a running task live.

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
| POST | `/api/tasks/:id/reject` | reject `{ note }`, re-queue |
| POST | `/api/tasks/:id/abort` | abort without merging — stop the agent, discard worktree + branch |
| POST | `/api/tasks/:id/terminal` | open a GUI terminal attached to a running task |
| GET | `/api/fs?path=` | list subdirectories of a path (powers the directory picker) |
| GET | `/api/events` | SSE stream of task/directory changes |

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
  directories.ts  directory service
  tasks.ts        task service + state transitions
  dispatcher.ts   dispatcher loop + per-task watcher + workspace self-heal
  server.ts       REST + SSE + static file serving
public/
  index.html / style.css / app.js   vanilla webapp
```

## Out of scope (v1)

Auth, multi-user, file upload, agent selection (uses `BUTCHR_AGENT_CMD`),
automated reviewer.
