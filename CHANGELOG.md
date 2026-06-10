# Changelog

All notable changes to **butchr** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **How history was reconstructed.** butchr's git log records one opaque
> `butchr: finalize task <id>` commit per merged task and was never version-tagged,
> so the version boundaries below are a *narrative reconstruction*: every entry is
> grounded in code that exists in the tree today (`src/`, `public/`, `bin/`,
> `deploy/`, `scripts/`, `test/`) and in the prose docs, but the grouping of
> features into milestone releases is editorial, not derived from tags. Going
> forward, history is kept honestly per the
> [living-docs convention](./CONTRIBUTING.md#6-living-docs-update-on-every-change):
> every change lands an `[Unreleased]` entry and bumps the version on release.

## [Unreleased]

### Security
- **CSRF / DNS-rebinding guard on the web API.** butchr binds to loopback, but a
  web page the operator merely visits could make their browser send forged
  cross-site requests to `http://127.0.0.1:<port>/api/...` (cross-site `POST` or a
  DNS-rebinding name) and create / approve / abort tasks. A small central guard
  now rejects state-changing (`POST`/`PUT`/`DELETE`/`PATCH`) `/api` requests whose
  `Origin` header is present but does not match butchr's own origins (or whose
  `Host` is not a loopback / configured name) with a clear `403`. The same-origin
  webapp, `GET` reads, and the SSE stream are unaffected; non-browser callers (the
  operator CLI, the per-task MCP server, `curl`) send no `Origin` and pass through
  untouched. This is localhost CSRF/rebinding hardening, **not** authentication —
  there are still no tokens, logins, or users (a separate future concern).

### Added
- **`BUTCHR_ALLOWED_ORIGINS`** — comma-separated list of extra browser origins
  permitted to make state-changing `/api` requests, on top of the derived loopback
  origins, for the CSRF / DNS-rebinding guard above.

## [0.9.2] - 2026-06-10

### Added
- **Dispatcher pause / maintenance mode (drain-only).** A global switch stops
  **new** agent dispatch so the operator can hold for a restart / recovery /
  maintenance window without disturbing work in flight: `running`, `review`, and
  `idle` tasks (and their watchers) continue untouched, while `queued` tasks simply
  wait. The auto-unblock and auto-merge passes keep running while paused — a
  freshly-unblocked task is promoted to `queued` but just isn't dispatched until you
  resume. Toggle it with **`POST /api/pause`** / **`POST /api/resume`**; `GET /health`
  now reports a **`paused`** boolean. The webapp gains a topbar **pause/resume
  control** and a clear **PAUSED banner**. The state is **persisted** (a new
  `settings` key/value table, key `dispatch_paused`), so a pause survives a restart
  and stays in effect until explicitly resumed.

## [0.9.1] - 2026-06-10

### Added
- **Agent transcript viewer.** The task-detail page gains a collapsible **Agent
  transcript** panel that shows what the task's agent actually did — its prose,
  extended thinking, tool calls (name + a brief one-line arg summary), and
  (truncated) tool results — without attaching to herdr. It's read-only and
  monospace, fetched lazily on first open and paged via a "Load more" button.
- **`GET /api/tasks/:id/transcript`** endpoint backing it: parses the Claude Code
  session JSONL (located the same way per-task token usage is) into an ordered,
  role-labelled list of turns, skipping internal frames and truncating large
  bodies. Best-effort — returns `turns: []` when the task has no session or the
  transcript can't be read — and paginated via `?offset=&limit=` (`limit` clamped
  1..500, default 200) with `total`/`hasMore`.

## [0.9.0] - 2026-06-10

This release establishes **change tracking** for butchr and catches the declared
version up to reality. The `version` in `package.json` had sat at the bootstrap
`0.1.0`/`0.2.0` while dozens of features shipped (task dependencies, a CI gate,
post-merge verify + auto-revert, one-click rollback, an operator CLI, a systemd
supervisor, auto-merge, plan/auto-decompose tasks, metrics, an audit timeline, a
dependency-graph view, and more — all reconstructed in the entries below). The
jump to **0.9.0** reflects that accumulated, near-1.0 surface area; the project
stays pre-1.0 because the HTTP/CLI/config interfaces are still allowed to change.

### Added
- **CHANGELOG.md** (this file) — a Keep a Changelog history reconstructed from the
  code and git log, plus an `[Unreleased]` section for ongoing work.
- **Living-docs convention** in [CONTRIBUTING.md](./CONTRIBUTING.md): every change
  must update SPEC.md, add an `[Unreleased]` CHANGELOG entry, and bump the version
  per semver on release. Documented as a first-class step of the contribution
  workflow.

### Changed
- `package.json` `version` bumped to `0.9.0` to reflect the accumulated feature
  set. `/health` already reports this value (it reads `package.json` at import),
  so the version surfaced by the API tracks the bump automatically — no hardcoded
  string to keep in sync.

## [0.8.0] - 2026-06-10

Observability and richer planning.

### Added
- **Plan / auto-decompose tasks.** A PLAN task runs an agent that calls the
  per-task MCP `propose_subtasks` tool to break a request into ordered sub-tasks;
  butchr creates them (wired with `blocked_by` dependencies) and marks the plan
  `decomposed`. `taskView` surfaces `spawned_subtasks`.
- **Metrics view.** `GET /api/metrics` exposes read-only aggregates and the webapp
  renders a Metrics page (cards over task/throughput counts).
- **Audit timeline.** Every status transition is recorded in a `task_events` table
  (`recordTaskEvent`); `GET /api/tasks/:id/events` returns the oldest→newest
  timeline and the task-detail view renders it.
- **Per-task model selection + token-usage accounting.** Task creation accepts an
  optional `model` (alias `opus`/`sonnet`/`haiku`/`fable` or a full id) threaded
  into the agent launch. `src/usage.ts` parses the agent transcript to surface
  cumulative token usage and the model the run used. (Dollar cost is deliberately
  **not** fabricated — the transcript carries no `costUSD` field.)
- **Dependency-graph view.** The webapp renders an SVG DAG of active tasks with
  blocker edges and topological levels, alongside the list and board views.

## [0.7.0] - 2026-06-10

Operations, deploy, and supervision.

### Added
- **OPERATIONS.md** runbook — running, restarting (resolve PID by port, never
  `pkill -f`), recovering, and self-heal for a live instance.
- **systemd units + supervisor.** `deploy/butchr.service`, `deploy/herdr.service`,
  and a health service/timer (`butchr-health.{service,timer}`), plus
  `scripts/supervise.sh`, `scripts/health-watchdog.sh`, and
  `scripts/install-service.sh`. butchr exits non-zero on uncaught errors so a
  supervisor relaunches a fresh process; state is re-adopted on boot.
- **Operator CLI** (`bin/butchr`) — each subcommand maps onto exactly one REST
  route and adds no server logic, so a running instance is drivable from the shell.

## [0.6.0] - 2026-06-10

Task dependencies.

### Added
- **`blocked_by` dependencies.** A task can declare blockers; `taskView` computes
  `blocked_by`, `blockerStates`, and `deadBlockers`. Blocked tasks don't dispatch.
- **Auto-unblock + auto-rebase-on-unblock.** When the last blocker merges, the
  dependent unblocks and is rebased onto the live default tip before dispatch, so
  it starts from current code.
- **Cycle guard.** Dependency edges that would form a cycle are rejected at the
  API so the graph stays a DAG.
- **Kill-on-block.** Editing a running task to depend on an unmet blocker stops its
  in-flight agent and returns it to a blocked state.

## [0.5.0] - 2026-06-10

Review, merge, and verification hardening.

### Added
- **CI gate.** On submission, build + test (`bun build … && bun test`) run in the
  task's worktree and write an advisory pass/fail badge (injectable in tests via
  `setCiRunner`). Advisory — a red badge signals "fix before merge" but does not
  hard-block.
- **Post-merge verify gate + auto-revert.** After an approved merge fast-forwards
  onto the default branch, `BUTCHR_VERIFY_CMD` runs on the new tip; a **RED**
  result **auto-reverts the merge off main** and moves the task to `failed` with
  the failing output (worktree kept for a fixup). Injectable via `setVerifyRunner`.
- **One-click rollback.** An endpoint reverts a merged task's commit off the
  default branch, serialized through the same global merge queue as approve, with
  a 409 + clean tree on a revert conflict.

### Changed
- **Merges are serialized through a global queue** and each is rebased onto the
  live tip first, so a verify+revert can never interleave with another merge and
  content conflicts are deterministic. A conflict is kicked back to the agent as a
  resolution note rather than dumped on the reviewer.

## [0.4.0] - 2026-06-10

Dispatch resilience and operability.

### Added
- **Dispatch retry + backoff + `failed` state.** A failed agent launch increments
  an attempt count and schedules a backoff in `next_dispatch_at`
  (`BUTCHR_DISPATCH_BACKOFF_CAP_MS`); at the cap the task gives up to `failed`
  instead of retrying forever.
- **`POST /api/tasks/:id/requeue`** + **failed-task UI** — clears retry/backoff
  state to re-dispatch a `failed` (or otherwise stuck) task, surfaced in the
  webapp.
- **Runaway / stuck-agent watchdog** (`BUTCHR_MAX_RUN_MS`) — a task that sits in
  `running` past the max wall-clock without reaching review is flagged for
  attention (and its agent killed), keeping a human in control. `0` disables it.
- **`/health` operational fields** — tick-loop liveness, the startup reaper's
  last-reap snapshot, an active/queued **concurrency** snapshot, a `failedTasks`
  count, and a **needsAttention** pull-signal (review + failed counts) that the
  webapp turns into a tab-title badge.

### Changed
- **Concurrency cap removed.** A per-run simultaneous-task cap was briefly
  introduced and then **removed**: dispatch is now fully **uncapped** — every
  queued task launches as soon as the tick sees it. The `concurrency` block in
  `/health` remains as an active/queued activity snapshot (no longer a limit).

## [0.3.0] - 2026-06-10

Webapp and per-task isolation.

### Added
- **One herdr tab per task.** Each agent gets its own dedicated herdr tab/pane
  (the herdr agent name is the task id), replacing shared-tab usage.
- **Webapp upgrades** — search + status filter bar (filter state survives
  re-renders and keeps input focus), collapsible completed history
  (merged/aborted/rejected), inline **herdr pane/tab id** readouts next to live
  tasks, and a **New task** modal/form.
- **"Open terminal" for running tasks** + **workspace self-heal** (re-create a
  missing workspace on demand).

### Fixed
- **Pane-id race on tab close.** Closing a herdr tab renumbered the remaining
  panes, so a stale cached pane id could target the wrong agent; pane lookups now
  resolve against the live herdr state instead of a captured index (verified live).

## [0.2.0] - 2026-06-10

Boot-time self-healing.

### Added
- **Reaper.** On startup butchr reaps orphaned git worktrees and leftover herdr
  "husks" (deregistered/dead agents), and records a last-reap snapshot surfaced in
  `/health`.
- **Reconcile + finalize on boot.** Live agents are re-adopted, dead ones rescued,
  and any legacy `finalizing` tasks flushed, so a restart never orphans state.

### Changed
- Task worktrees are excluded from the registered repo locally via
  `.git/info/exclude` so the `<repo>/<task-id>/` dirs never show up as untracked.

## [0.1.0] - 2026-06-10

Initial butchr — the agent task harness on top of herdr.

### Added
- **Core harness.** A single Bun process (HTTP server + dispatcher tick loop +
  per-task MCP server) that owns the task lifecycle — creation → dispatch → agent
  run → review → merge — over git repositories, where **directories are
  workspaces and tasks are git worktrees**.
- **State model.** SQLite (`bun:sqlite`, WAL) for runtime state; an on-disk
  `task.md` under each repo's `.butchr/tasks/<id>/` as the re-syncable source of
  truth for a task's prompt + metadata. One git worktree per task at
  `<repo>/<task-id>/` on a `<task-id>` branch.
- **Interfaces.** REST API (`/api/*`), an SSE stream (`/api/events`) over an
  in-process pub/sub, and a hand-rolled dependency-free per-task MCP server
  (`/mcp/:taskId`) exposing `request_review` and `ask`.
- **Dispatcher.** A tick loop that launches an agent per queued task via herdr,
  plus a watcher that rescues agents that end without submitting.
- **CTO `ask`.** The MCP `ask` tool forks a read-only Claude to answer an agent's
  clarifying question.
- **Webapp.** A vanilla-JS, hash-routed, SSE-driven single-page app served from
  `public/` (no framework, no build step), with a server-side directory picker for
  registering repositories.
- **Zero-dependency rule.** Everything is built on the Bun standard library plus
  the external `git` and `herdr` binaries — no npm/runtime dependencies.

[Unreleased]: https://github.com/
[0.9.2]: https://github.com/
[0.9.1]: https://github.com/
[0.9.0]: https://github.com/
[0.8.0]: https://github.com/
[0.7.0]: https://github.com/
[0.6.0]: https://github.com/
[0.5.0]: https://github.com/
[0.4.0]: https://github.com/
[0.3.0]: https://github.com/
[0.2.0]: https://github.com/
[0.1.0]: https://github.com/
