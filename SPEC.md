# butchr — Specification (living design doc)

> **Status: current.** This document describes butchr **as it actually exists in
> this repository**, derived from the source under `src/`, `public/`, `bin/`,
> `deploy/`, `scripts/`, and the `test/` suite (tests are treated as ground truth
> for behavior). Where the older prose docs (`README.md`, `OPERATIONS.md`) lag the
> code, the code wins and this document reflects it. If you change behavior, update
> this file in the same change.

butchr is an **agent task harness** built on top of [herdr](https://github.com/).
It organizes autonomous coding-agent work around git repositories: **directories
are workspaces, tasks are git worktrees.** It owns the full task lifecycle —
creation → dispatch → agent run → review → merge — and delegates all
terminal/PTY/agent-session management to herdr.

- **Stack:** Bun · `bun:sqlite` · herdr · git — **zero npm/runtime dependencies.**
- **Webapp:** vanilla-JS single-page app, no framework.

---

## Table of contents

1. [Overview & architecture](#1-overview--architecture)
2. [Task lifecycle (state machine)](#2-task-lifecycle-state-machine)
   - [2.1 States](#21-states)
   - [2.2 Transitions](#22-transitions)
   - [2.3 Orthogonal flags](#23-orthogonal-flags)
   - [2.4 Dependencies (blocked_by)](#24-dependencies-blocked_by)
   - [2.5 Plan / auto-decompose tasks](#25-plan--auto-decompose-tasks)
3. [Dispatch & agents](#3-dispatch--agents)
4. [Review & merge](#4-review--merge)
5. [Self-healing & ops](#5-self-healing--ops)
6. [Interfaces](#6-interfaces)
   - [6.1 REST API](#61-rest-api)
   - [6.2 SSE](#62-sse-server-sent-events)
   - [6.3 MCP tools](#63-mcp-per-task-tools)
   - [6.4 Operator CLI](#64-operator-cli-binbutchr)
   - [6.5 Webapp](#65-webapp-public)
7. [Data model](#7-data-model)
8. [Configuration](#8-configuration)
9. [On-disk layout](#9-on-disk-layout)
10. [Duration estimates (rough)](#10-duration-estimates-rough)

---

## 1. Overview & architecture

butchr is a **single Bun process** with three logical components sharing one
event loop:

1. **HTTP server** (`src/server.ts`) — one `Bun.serve` listener that multiplexes:
   the REST API (`/api/*`), the Server-Sent-Events stream (`/api/events`), the
   per-task MCP endpoint (`/mcp/:taskId`), a `/health` alias, and static serving
   of the SPA from `public/`.
2. **Dispatcher loop** (`src/dispatcher.ts`) — a `setInterval` tick (every
   `BUTCHR_TICK_MS`, default 1500 ms) that finds queued tasks and launches an agent
   for each, plus a per-task watcher that rescues agents that end without
   submitting.
3. **Per-task MCP server** (`src/mcp.ts`) — a hand-rolled, dependency-free
   JSON-RPC-over-HTTP MCP transport mounted on the same listener. Each task's agent
   connects to its own `/mcp/<task-id>` URL; identity is the path (stateless, no
   session id issued).

**State** lives in **SQLite** (`bun:sqlite`, WAL mode) at
`~/.local/share/butchr/butchr.db`. Per the design, SQLite tracks only *runtime*
state; the on-disk **`task.md`** (under each repo's `.butchr/tasks/<id>/`) is the
source of truth for a task's prompt + metadata and is re-syncable from the
filesystem.

**herdr** is the terminal/agent layer. butchr shells out to the `herdr` CLI
(`src/herdr.ts`), which talks to the running herdr server. butchr owns task
*state*; herdr owns *PTYs/panes/tabs*. The herdr **agent name is the task id**, so
all lookups (`agentExists`, `agentRead`, `agentDeregister`, …) key off the task id.

```
                          ┌──────────────────────────── butchr (one Bun process) ────────────────────────────┐
                          │                                                                                    │
  Browser (SPA) ─HTTP/SSE─┤  server.ts                                                                         │
  bin/butchr CLI ─REST────┤   ├─ REST /api/*  ──────────────► tasks.ts / directories.ts ◄─► db.ts (SQLite WAL) │
                          │   ├─ SSE  /api/events ◄─ events.ts (in-proc pub/sub)                                │
                          │   ├─ /health                                                                        │
                          │   └─ /mcp/:taskId ─────────────► mcp.ts ── request_review / ask / propose_subtasks  │
                          │                                                                                    │
  Claude Code agent ─MCP──┘   dispatcher.ts (tick loop + watcher) ─► taskmd.ts (prompt render)                 │
        ▲                      │  ├─ git.ts   (worktree / rebase / merge / revert / cleanup)                    │
        │ herdr CLI            │  ├─ herdr.ts (workspace / tab / pane / agent)                                  │
        │ (agent start, …)     │  ├─ verify.ts (post-merge gate)  usage.ts (token accounting)                  │
        ▼                      │  └─ cto.ts   (ask → forked read-only Claude)                                   │
   herdr server ◄─PTY/panes────┘   reaper.ts (boot cleanup)  log.ts (rotating file log)                        │
                          └────────────────────────────────────────────────────────────────────────────────────┘
                              │
       Per repo on disk:  <repo>/.butchr/tasks/<id>/task.md   (+ CTO.md)   and   <repo>/<id>/  (git worktree)
       butchr state dir:  ~/.local/share/butchr/{butchr.db, butchr.log, prompts/, runs/, mcp/, ask/}
```

**Process model.** `src/index.ts` is the entry point. On start it: installs file
logging; warns (non-fatal) if herdr is unreachable; runs startup **reconcile**
(re-adopt live agents / rescue dead ones), **finalize** (flush legacy
`finalizing`), and **reap** (orphaned worktrees + herdr husks); then starts the
dispatcher and HTTP server. `SIGINT`/`SIGTERM` → clean exit (code 0).
`uncaughtException`/`unhandledRejection` → log + exit **non-zero** so a supervisor
relaunches a fresh process (state is re-adopted on boot, so nothing is orphaned).

**Concurrency model.** Fully concurrent and **uncapped** — every queued task is
launched as soon as the tick sees it. There is no per-directory or global
simultaneous-task cap. Isolation is at the filesystem level (one git worktree per
task on its own branch) and the UI level (one herdr tab per task).

---

## 2. Task lifecycle (state machine)

A task is a filesystem artifact *and* a DB row:

- a directory `<repo>/.butchr/tasks/<task-id>/` containing `task.md`
- a git worktree at `<repo>/<task-id>` on a branch named `<task-id>`
- a `tasks` row tracking runtime state

Task ids are `adjective-noun-4hex` (e.g. `swift-falcon-3a2f`), generated in
`src/ids.ts`, immutable, and double as the branch + worktree directory name (so the
wordlists are lowercase-`a-z` only). Directory ids are `dir-<8hex>`.

### 2.1 States

`TaskStatus` (`src/db.ts`):

| status | terminal? | active? | meaning |
|--------|-----------|---------|---------|
| `queued` | no | pending | worktree + `task.md` exist; waiting for the dispatcher to launch an agent. |
| `blocked` | no | pending | has ≥1 not-yet-merged blocker (`blocked_by`); a **pre-dispatch waiting** state — no agent runs. Promoted to `queued` when all blockers merge. |
| `running` | no | yes | an interactive agent is executing in the worktree. |
| `review` | no | yes | work submitted for human review (agent called `request_review`, or was rescued). Pure DB state — **no live process**. |
| `merged` | **yes** | — | branch fast-forwarded into the default branch; worktree + branch removed. (Also the terminal state for a completed **plan** task, which merges nothing of its own.) |
| `aborted` | **yes** | — | abandoned from any non-terminal state; worktree + branch discarded, **nothing merged**. `task.md` kept. |
| `failed` | terminal-ish | no | dispatch gave up after `BUTCHR_MAX_DISPATCH_ATTEMPTS` consecutive failures, **or** a merge was auto-reverted off main by the post-merge verify gate (carries `revert_reason`). Leaves only via `requeue`. |
| `rejected` | (legacy) | — | retained in the type union and treated as a dead/terminal blocker state; the live reject path re-queues instead (see below). Counted as a "dead blocker." |
| `finalizing` | (legacy) | — | obsolete transient state from the old blocking-agent model; **no longer produced**. Startup recovery flushes any leftover `finalizing` rows to `merged`. |

> **Note on `rejected`:** the current `rejectTask` path does **not** park a task in
> `rejected` — it re-queues to `queued` for a `--resume` rework. `rejected` survives
> only in the status union and the dead-blocker set (`DEAD_BLOCKER_STATES =
> {aborted, rejected, failed}`), so a dependency on such a task is flagged as
> never-merging.

### 2.2 Transitions

All status writes live in `src/tasks.ts` (kept together) and each appends a row to
the `task_events` audit log via `recordTaskEvent`.

| from → to | trigger | code |
|-----------|---------|------|
| (none) → `queued` | task created with no/already-merged blockers | `createTask` |
| (none) → `blocked` | task created with ≥1 unmerged blocker | `createTask` |
| `blocked` → `queued` | all blockers merged (auto-unblock), or operator clears deps | `reevaluateBlockedTask` / `setBlockedBy` |
| `queued`/`running`/`review` → `blocked` | operator adds an unmerged blocker (kill-on-block if a live agent) | `setBlockedBy` |
| `queued` → `running` | dispatcher launched the agent | `markRunning` |
| `running` → `review` | agent called `request_review` (live path) | `markReviewFromAgent` |
| `running` → `review` | watcher rescue (agent ended without submitting / runaway / timeout / vanished / never-started; or reconcile of a dead agent) | `markReview` |
| `running`/`review` → `queued` | reviewer rejected, or merge conflict kicked back to agent (clears retry state) | `requestChanges` (via `rejectTask` / `approveTask`) |
| `queued` → `queued` (backoff) | dispatch failed, under the attempt cap → stamp `next_dispatch_at` | `markDispatchFailure` |
| any non-terminal → `failed` | dispatch failed at/over the cap | `markDispatchFailure` |
| `review` → `merged` | reviewer approved + merge fast-forwarded + post-merge verify green | `approveTask` |
| `review` → `failed` | approved, merge ff'd, but post-merge verify RED → auto-revert | `approveTask` (`revertedOnRed`) |
| `review` → `queued` | approve hit a merge conflict → kicked back to agent | `approveTask` (`conflictSentBack`) |
| `running`/`review`/`queued`/`blocked` → `merged` | **plan** task submitted its decomposition | `proposeSubtasks` |
| any non-terminal → `aborted` | operator aborted | `abortTask` |
| `failed`/stuck non-terminal → `queued` | operator re-queued (resets retry state) | `requeueTask` |
| `finalizing` → `merged` | startup recovery of legacy state | `finalizeTask` / `recoverFinalizingTasks` |

`merged` tasks additionally support **one-click rollback** (revert commits off
main); the task stays `merged` but is stamped `rolled_back_at` (see §4).

**Timestamp semantics** (used by metrics): `started_at` = first `running`
transition (COALESCE — never cleared on rework); `completed_at` = `running→review`;
`merged_at` = merge into default branch.

### 2.3 Orthogonal flags

These are columns set *alongside* a status, not states themselves; each is only
meaningful within its owning status and is cleared as the task moves on:

- **`idle`** (on `running`) — agent alive but its CLI produced no output for
  `BUTCHR_IDLE_MS`. Owned by the dispatcher watcher; set/cleared via `setIdle`,
  which only writes (and emits) on a genuine flip.
- **`conflict`** (on `review`) — a non-conflict merge failure surfaced to the human
  (set by `approveTask` on an unusual merge error).
- **`ci_status` / `ci_summary`** (on `review`) — the advisory CI gate result
  (`running` | `pass` | `fail` | null) plus a badge label + output tail.
- **`revert_reason`** (on `failed`) — failing build/test output when a merge was
  auto-reverted off main. Its presence is what the UI keys on to render a "reverted
  from main" panel (distinct from a dispatch failure).
- **`auto_merged`** (on `merged`) — 1 when butchr auto-approved + merged (CI-green +
  low-risk) rather than a human.
- **`dispatch_attempts` / `last_dispatch_error` / `next_dispatch_at`** — bounded
  dispatch retry bookkeeping (see §3).

### 2.4 Dependencies (blocked_by)

`blocked_by` is a JSON-array TEXT column of blocker task ids (parsed by
`parseBlockedBy`). Semantics:

- **Blocking.** A task with any not-yet-merged blocker starts in `blocked` and no
  agent runs for it. An empty / all-merged set is immediately `queued`.
- **Auto-unblock.** `reevaluateBlockedTask` promotes a `blocked` task to `queued`
  the moment **all** blockers reach `merged`. It runs both as a per-tick backstop
  (every `blocked` task is re-checked at the top of `tick`) and immediately after
  any merge / plan completion (`reevaluateAllBlocked`) for promptness.
- **Dead-blocker hold.** A blocker in a terminal non-merged state (`aborted`,
  `rejected`, `failed`) or gone entirely (`getTask` → null) will **never** merge, so
  the dependent stays `blocked` indefinitely. These are surfaced as `deadBlockers`
  on the task view and logged once each (deduped via `loggedDeadBlockers`) with
  "edit blocked_by to proceed." The operator must edit the set to make progress.
- **Cycle / self guard.** `wouldCreateCycle` walks the existing dependency graph
  from each proposed blocker; a self-reference or any path back to the task is
  rejected (HTTP 400) at both `createTask` and `setBlockedBy`.
- **Kill-on-block.** `setBlockedBy`, when it transitions a task *into* `blocked`
  from `running`/`review`/`queued` and the task has a live agent, tears the agent
  down (`teardownTask`) and clears the running/herdr fields — but **keeps**
  `session_id` and the worktree, so the task resumes with full context when it later
  unblocks. This is *not* a dispatch failure (retry state untouched). Editing deps
  is allowed only on non-terminal tasks (409 otherwise).

### 2.5 Plan / auto-decompose tasks

A task's `kind` is `task` (default) or `plan`. A **plan task** runs an agent like
any other but writes **no code**: its job is to analyze the request and propose a
decomposition. It is created via `POST …/tasks` with `kind: "plan"`.

- The plan agent is handed the **`propose_subtasks`** MCP tool (instead of
  `request_review`) and a "how to submit your decomposition" protocol
  (`PLAN_PROTOCOL` in `taskmd.ts`).
- It submits an ordered array of `{ prompt, context?, blocked_by? }` specs, where
  each `blocked_by` references **sibling indices** (the ids don't exist yet).
- `proposeSubtasks` validates the graph with **Kahn's algorithm** (`planCreationOrder`
  rejects cycles / self-refs / out-of-range indices — nothing is created on a graph
  error), then creates the sub-tasks **in dependency order**, translating sibling
  indices to the real ids, and records them in `spawned_subtasks` (JSON array).
- The plan task is then **completed to terminal `merged`** (it merges nothing of its
  own), its worktree + tab are torn down best-effort, its token usage is captured,
  and any task blocked on the plan is re-evaluated. The call is non-blocking and
  **idempotent** (a re-call on a completed plan returns its prior ids).

---

## 3. Dispatch & agents

### One tab per task

Each registered directory maps 1:1 to a herdr **workspace**. Each task gets its own
herdr **tab** (`tab create`) and its agent runs in that tab's pane
(`agent start <task-id> --tab …`), so tasks land as separate tabs rather than a
wall of split panes in one tab. `tabCreate` is best-effort — on failure it returns
`{}` and `agentStart` falls back to the legacy workspace-scoped split.

### The tick loop

`tick()` (guarded by a `ticking` reentrancy flag) on each interval:

1. Stamps `lastTickAt` / `tickCount` (liveness, before any early-out).
2. If herdr is **down**, returns silently (no error spam — it may come back).
3. **Auto-unblock pass:** re-evaluates every `blocked` task.
4. **Auto-merge backstop:** if enabled, re-checks every `review` task with
   `ci_status='pass'` and `auto_merged=0` (deduped + serialized downstream).
5. Selects `queued` tasks whose `next_dispatch_at` is null or in the past (ISO
   strings compare correctly), oldest-first, and dispatches each that isn't already
   `dispatching`/`watching` — concurrently, no cap. The `dispatching`/`watching`
   sets (keyed by task id) prevent double-dispatch across overlapping ticks. This
   selection runs through `selectQueuedForDispatch`, which returns **nothing while
   dispatch is paused** (see below), so no new agent starts.

### Pause / maintenance mode (drain-only)

A global switch (`dispatcher.{isPaused,setPaused}`, toggled by `POST /api/pause` /
`/api/resume`) stops **new** agent dispatch so the operator can hold for a
restart / recovery / maintenance window. **Semantics when paused:**

- Step 5's `selectQueuedForDispatch` returns an empty list → **no `queued` task is
  launched**.
- Steps 3–4 still run: the **auto-unblock pass still promotes** a `blocked` task
  whose blockers all merged to `queued` (it just waits there, undispatched, until
  resume), and the **auto-merge backstop still lands** CI-green low-risk `review`
  tasks.
- Everything in flight is **untouched** — `running`/`review`/`idle` tasks and their
  watchers continue, so existing work drains to completion.

The flag is **persisted** in the `settings` table (`dispatch_paused`), mirrored by
an in-memory cache loaded at module init, so a pause **survives a restart** and
stays in effect until explicitly resumed. `GET /health` reports it as `paused`.

### dispatch() — launching an agent

For each task (`src/dispatcher.ts` → `dispatch`):

1. **Heal workspace** (`ensureWorkspace`, deduped per-directory) — recreate the
   herdr workspace if herdr restarted / it was closed.
2. **Ensure worktree** (`git.createWorktree`, idempotent). The worktree dir is
   locally excluded via `.git/info/exclude` so it never shows as untracked.
3. **Auto-rebase before run** (`prepareBranchForDispatch`) — bring the branch up to
   the current default tip *before* the agent works, closing the chained-task
   conflict gap (a branch cut from a stale HEAD before its blockers merged). A cheap
   lock-free `isBehindDefault` check gates the (serialized) rebase so up-to-date
   branches never touch the merge queue. On a rebase **conflict** the agent is still
   launched, but with an actionable conflict-resolution note recorded (it is *not*
   silently launched on a stale base; aborting would just re-conflict every tick).
4. **Resolve launch plan** (`resolveLaunchCommand`):
   - A fresh, never-run task (`started_at` null) → **new session**: butchr mints a
     `--session-id <uuid>` and renders the **full** prompt (`renderAgentPrompt`).
   - A rework (`started_at` set — never cleared on reject/conflict) with a
     `session_id` → **`--resume <session_id>`**: re-enters the SAME Claude session
     with full prior context, rendering only a focused rework prompt
     (`renderReworkPrompt`: the accumulated review notes).
   - **Inconsistent state** — a rework with no usable `session_id` → falls back to a
     **fresh** session (`lostContext` flagged + logged loudly), re-rendering the full
     prompt + review notes rather than failing forever.
   - A requested per-task `model` becomes `--model <model>`; unset → empty
     (`{{MODEL_FLAG}}`), so claude uses its default.
5. **Write prompt + MCP config** to butchr's data dir (never the worktree):
   `<data>/prompts/<id>.md` and `<data>/mcp/<id>.json` (the per-task config points
   the agent at `http://<host>:<port>/mcp/<id>`; host `0.0.0.0` is rewritten to
   loopback for the agent).
6. **PTY launch.** The agent is interactive and must keep a real TTY (so its
   full-screen UI renders and input works) — piping through `tee` would make stdout
   a pipe and the UI would never draw. So it runs under **`script`**:
   `SHELL=/bin/bash script -qfe --log-out <log> -c <agentCmd>; echo "$?" > <done>`,
   wrapped as `bash -lc …`. `script` allocates a PTY and tees output to the run log;
   the child's exit code is written to a `.done` marker.
7. **herdr pane setup** under a **per-workspace lock** (`withHerdrPaneLock`):
   `tab create` → `agent start --tab` → capture & close the empty root pane → wait
   out herdr's positional pane-id renumber and re-resolve the agent's real pane by
   its **stable `terminal_id`** (`resolveAgentPane`). If no real pane resolves, the
   dispatch is treated as **failed** (rather than recording a phantom pane). The
   lock is required because herdr pane/tab ids are *positional* and renumber
   workspace-globally on any close — concurrent dispatches in the same workspace
   would otherwise clobber each other's panes. Different workspaces still run
   concurrently.
8. **`markRunning`** (records pane + tab + session id, stamps `started_at`, clears
   retry state) and **`spawnWatcher`**.

`startAgentReconciling` self-heals an `agent_name_taken` collision: a lingering
same-named orphan agent is `agentDeregister`'d (clears the name via
`agent rename --clear`, closes pane/tab) and `agentStart` is retried once.

### The watcher

`spawnWatcher` polls (~1 s) while the task is `running`. Its only job is to rescue
an agent that **ends without submitting** (the normal path is the agent calling the
non-blocking `request_review`, which moves the task to `review` and lets the agent
exit). It breaks and acts on:

- **abort signal** (`signalAbort` set by `abortTask`) → bail without touching state.
- **task left `running`** (status changed elsewhere, e.g. a reject re-queue) → release.
- **`.done` marker present** → process exited.
- **runaway** — `running` longer than `BUTCHR_MAX_RUN_MS` without submitting
  (`runawayExceeded`); the agent is alive but looping/stuck (fires even if it's
  still emitting output, so the idle detector never trips). Captures a snapshot,
  closes the tab, → `review` with a "stuck/runaway" note.
- **timeout** — past `BUTCHR_AGENT_TIMEOUT_MS` (the longer backstop).
- **vanished** — the herdr agent disappeared after being seen alive.
- **never-started** — never registered with herdr within `BUTCHR_AGENT_START_GRACE_MS`.

On the `.done` path it also checks **exec failure** (`isExecFailure`): exit code
`126`/`127` with **no captured output** means the launch command itself failed to
`exec` (most notably **E2BIG** — argv exceeding ~128 KB `MAX_ARG_STRLEN`), so the
agent never started. This is routed to `markDispatchFailure` (retry/backoff/`failed`)
rather than masquerading as an empty review. All other end conditions → `markReview`
with an explanatory note prefixing the captured output.

`refreshIdle` toggles the `idle` flag from the run log's mtime (the agent runs under
`script -f`, so the log mtime tracks live output).

### Retry, backoff, and `failed`

`markDispatchFailure` is the **only** path that increments `dispatch_attempts`:

- Always: tear down any half-created herdr agent/tab, increment the count, store
  `last_dispatch_error`.
- **Under the cap** (`dispatch_attempts < BUTCHR_MAX_DISPATCH_ATTEMPTS`, default 5):
  stay `queued` but set `next_dispatch_at = now + backoff`, where
  `backoff(n) = min(base · 2^(n-1), cap)` (`dispatchBackoffMs`; base 1 s, cap 30 s).
  The tick loop skips the task until then — no more hot-looping.
- **At/over the cap:** move to `failed`, clear `next_dispatch_at`. The dispatcher
  stops retrying.

A clean re-queue (`backToQueued`) and a rework re-queue (`requestChanges`) **reset**
the retry state — they are fresh intent, not failures. `POST …/requeue`
(`requeueTask`) is the operator escape hatch that revives a `failed` (or otherwise
stuck non-terminal) task by clearing the retry state and re-queuing.

---

## 4. Review & merge

### Non-blocking review

`request_review` (MCP) is **non-blocking**: `markReviewFromAgent` records the
request, moves the task `running → review`, stores the optional summary, clears the
pane (it's about to close), captures the run-log snapshot, captures session token
usage, and triggers the CI gate — then returns immediately. The agent then **exits**;
review is pure DB state with no live process held open. This is what makes review
durable across an agent or butchr restart (an MCP server can't wake an idle Claude
Code client, so butchr never parks a call).

### CI gate (pre-merge, in-worktree, advisory)

On a genuine `running → review` transition, `triggerCi` runs **build + test in the
task's worktree** (`defaultCiRunner`: `bun build … --outfile /dev/null` then
`bun test`), fire-and-forget — review never blocks on it. Both commands are spawned
through the **shared gate runner** (`src/gate.ts` `runGate`) that the post-merge
verify gate also uses, so the two gates can't drift on how they spawn/bound a run:
each CI command is now **bounded by `BUTCHR_VERIFY_TIMEOUT_MS`** (the same kill-timer
verify has — a timed-out build/test counts as a FAIL) rather than running unbounded.
It writes a badge: `ci_status` (`running` → `pass`/`fail`) + `ci_summary` (first line
a compact label like `build + 12 tests` / `build failed` / `3 test failures`, then an
output tail). A **FAIL is retried** up to `BUTCHR_CI_RETRIES` times (default 1); a
pass on any retry wins. The runner is overridable in tests (`setCiRunner`); tasks
with no worktree skip CI (leaving `ci_status` null). The CI gate is **advisory** — it does
not hard-block approval — but it gates **auto-merge** and on a `pass` fires the
auto-merge hook.

### Approve → global merge queue → post-merge verify

`approveTask` (only valid on `review`) runs inside a process-wide **global merge
queue** (`runExclusiveMerge` — a never-rejecting promise chain) so concurrent
approvals rebase + fast-forward one at a time against an up-to-date base tip instead
of racing. Inside the exclusive section:

1. Capture the default-branch tip (`priorTip`) for a possible revert.
2. `git.merge` — auto-commit any dangling worktree changes (after a **conflict-marker
   scan** that refuses to merge poisoned content), **rebase** the task branch onto
   the current base tip, then **fast-forward** the base to it (linear history, no
   merge commit). Records `baseSha..mergedSha`.
3. If the ff stuck, run the **post-merge verify gate** (`verifyDefaultBranch` →
   `BUTCHR_VERIFY_CMD` in the repo **root**). On **RED**, `git.resetHard` the default
   branch back to `priorTip` — undoing the merge so a broken commit never sits on
   main. (Because merges are serialized, nothing landed after the ff, so the reset is
   clean.)

Outcomes (`ApproveOutcome`):

- **merged** — verify green → status `merged`, worktree + branch cleaned up, snapshot
  captured, `merge_base_sha`/`merged_sha`/`merged_at` recorded, blocked dependents
  re-evaluated.
- **`revertedOnRed`** — verify RED, merge auto-reverted → status `failed` with
  `revert_reason` = the failing output. The worktree + branch are **kept** for
  inspection / a fixup re-run. (HTTP 200 with a flag.)
- **`conflictSentBack`** — `git.merge` reported a content conflict (the rebase was
  aborted, tree left clean). Instead of dumping it on the human, butchr appends an
  actionable conflict note and **kicks it back to the agent** via `requestChanges`
  (→ `queued`, re-dispatched as a `--resume` so the agent integrates the base and
  re-submits). (HTTP 200 with a flag.) Because the merge gate **rebases** the branch
  onto the default tip (no merge commit), the note instructs the agent to integrate
  by **`git rebase <base>`** (resolve + `--continue`) or **`git reset --soft <base>`**
  then re-commit — explicitly **NOT** `git merge <base>`, whose merge commit the
  rebase would discard, replaying the original commit and re-conflicting in a loop.
  An empty `BUTCHR_VERIFY_CMD` disables the
  verify gate (every clean merge is accepted). A non-conflict merge failure sets the
  `conflict` flag + a note and surfaces 409.

### Auto-rebase on unblock / dispatch

Every dispatch first brings the branch up to the current default tip
(`prepareBranchForDispatch` → `git.rebaseOntoDefault`), serialized through the same
merge queue (after a cheap lock-free behind-check). A branch with no commits is
hard-reset onto the tip; a branch with commits is rebased; a dirty worktree is left
untouched (the merge-time rebase, which commits first, handles it). A conflict is
routed to the agent as a resolution note rather than silently dispatched (see §3).

### Auto-merge (opt-in, default off)

When `BUTCHR_AUTO_MERGE` is on, a `review` task whose CI settled to `pass` and that
is **low-risk** is approved + merged automatically via the **same** `approveTask`
path a human uses (so the post-merge verify gate still guards main, and races still
go through the merge queue). Triggered by the CI-completion hook and re-checked by
the tick-loop backstop; concurrent evaluations are deduped (`autoMerging`).

**Low-risk** (`isLowRiskChange`, pure/testable) = all of:
(a) every changed file is under `BUTCHR_AUTO_MERGE_ALLOWLIST` (prefix entries ending
`/` like `public/`/`test/`/`docs/`; a `*.md` glob matching **top-level** markdown
only; or an exact path), **and**
(b) total changed lines (added+deleted, via `git.diffStat`) ≤
`BUTCHR_AUTO_MERGE_MAX_LINES` (default 150), **and**
(c) at least one changed file.
A merge conflict (kicked back to the agent) or a post-merge-verify revert never
counts as an auto-merge; only a real merge stamps `auto_merged=1`.

### One-click rollback

`rollbackTask` (`POST …/rollback`) reverts an already-merged task's commits off the
default branch. Valid only for a `merged` task that hasn't been rolled back and
whose `merge_base_sha..merged_sha` range was recorded (tasks merged before this
feature, or that landed no commits, are refused with 409). The `git revert
--no-edit <base>..<merged>` runs inside the **same global merge queue**; on a clean
revert the task **stays `merged`** but is stamped `rolled_back_at` (its branch did
land — revert commits were appended). A revert **conflict** (or any failure) leaves
the tree clean and surfaces a 409 with a clear message.

### Reject

`rejectTask` (only on `review`, note required) appends the note to `task.md`'s
Review Notes, then `requestChanges` re-queues the task (`→ queued`, retry state
cleared). The dispatcher re-launches the **same** Claude session via
`--resume <session_id>` with the focused rework prompt, so the agent re-enters with
full prior context. Any lingering pane/tab is torn down defensively.

### Abort

`abortTask` (any non-terminal state; 409 if already merged/aborted): signals the
watcher to bail, tears down the herdr tab, discards the worktree + branch, and parks
the task in terminal `aborted` (clearing all live fields). `task.md` is kept.

---

## 5. Self-healing & ops

### Startup reconcile (`reconcileRunningTasks`, run once in `index.ts`)

For every task still marked `running` after a restart (its in-memory watcher was
lost):

- **herdr up + agent still alive** → **re-adopt**: record its (possibly renumbered)
  pane + tab and re-spawn a watcher. The agent keeps working; completion/idle
  detection resumes.
- **herdr up + agent gone** → **rescue** to `review` with an "agent ended while
  butchr was offline" snapshot.
- **herdr down** → leave the tasks `running` as-is (can't distinguish live from
  dead without risking orphaning/false-rescue); reconcile on a later restart with
  herdr up. (There is deliberately **no** blind `running → queued` re-queue, which
  would collide on `agent_name_taken`.)

### Finalize recovery (`recoverFinalizingTasks`)

Flushes any task stranded in the legacy `finalizing` state (branch already merged)
to `merged` — closes the tab, cleans up, stamps merged. Idempotent.

### The reaper (`reapOrphans`, conservative, once on boot)

Self-heals artifacts leaked by tasks that reached a **terminal** state
(`merged`/`aborted`/`rejected`) or that no longer have a DB row:

- **Worktrees + branches** — for each registered repo, scans
  `git worktree list --porcelain` and reaps any **direct child** worktree
  `<repo>/<taskId>` whose task is terminal or missing (`worktree remove --force` +
  `branch -D`, `prune` on failure). It **never** touches the main worktree or a
  worktree whose task is still queued/blocked/running/review/finalizing.
- **herdr husks** — a terminal-state task whose agent name is still registered gets
  `agentDeregister`'d. **Skipped when herdr is down** (worktree reaping still runs).

The last reap result (`{worktrees, husks, at}`) is exposed on `/health`.

### Health endpoint

`GET /health` (alias `GET /api/health`) returns **200** when healthy, **503** when
degraded. `healthy = db.ok && tick.alive`. Fields: `status`, `version`, `uptimeSec`,
`db.ok` (trivial `SELECT 1`), `paused` (**dispatcher pause** — true while new agent
dispatch is halted for maintenance; running/review/idle tasks are unaffected), `tick`
(`alive`/`count`/`lastTickAt`/`ageMs`/
`staleAfterMs` — stale if it has ticked but not within `max(tickMs·5, 10s)`; a
never-ticked loop is treated as *still starting*, not stalled), `tasks` (counts by
status), `failedTasks`, `concurrency` (`active` = running+review+finalizing,
`queued`), `needsAttention` (`review`+`failed`), `reaper` (last boot reap), and
`herdr.reachable` (**best-effort — does NOT affect the 200/503 verdict**; herdr down
⇒ tasks stall at `queued` but butchr stays "healthy").

### Supervision (systemd + watchdog)

butchr is designed to run unattended under the systemd **user** manager (or the
bundled `scripts/supervise.sh`). Auto-restart is safe because state is re-adopted on
boot.

- `deploy/butchr.service` — `bun run src/index.ts`, `Restart=always`, soft
  `Wants/After herdr.service`, crash-loop backstop (`StartLimitBurst=10` /
  `StartLimitIntervalSec=60`), optional `EnvironmentFile=-~/.config/butchr/butchr.env`,
  journald via `SyslogIdentifier=butchr`.
- `deploy/herdr.service` — `herdr server`, `Restart=always`.
- `deploy/butchr-health.service` + `.timer` — a one-shot **health watchdog**
  (`scripts/health-watchdog.sh`, dependency-free curl+bash) run ~every 30 s
  (`OnBootSec=60`, `OnUnitActiveSec=30`); curls `/health` and
  `systemctl --user restart butchr.service` if it's unreachable, non-2xx, or the
  dispatcher tick is stale (it also re-checks `ageMs > staleAfterMs` from the body).
  A restart clears any crash-loop StartLimit.
- `scripts/install-service.sh` — renders the `@REPO_DIR@`/`@BUN@`/`@HERDR@` template
  tokens to absolute paths, installs the units to `~/.config/systemd/user/`,
  `daemon-reload`s, validates with `systemd-analyze --user verify`, and **prints**
  the enable commands (it never enables/starts anything itself).
- `scripts/supervise.sh` — alternative plain-bash supervisor: relaunches on
  non-zero exit with backoff + crash-loop give-up; a clean (code 0) exit stops it
  too. Knobs: `BUTCHR_RESTART_DELAY` (2), `BUTCHR_MAX_RESTARTS` (10),
  `BUTCHR_CRASH_WINDOW` (60). Use the systemd units **or** the script, not both.

### Logging

`src/log.ts` tees `console.{log,info,warn,error,debug}` to a **rotating** file
(`BUTCHR_LOG_FILE`, default `<data>/butchr.log`) in addition to stdout. Size-based
rotation: at `BUTCHR_LOG_MAX_BYTES` (10 MB) it shifts `.log → .log.1 → … → .log.N`,
keeping `BUTCHR_LOG_KEEP` (3) rotated files. Best-effort — logging never throws.

---

## 6. Interfaces

### 6.1 REST API

All under `Bun.serve` (`src/server.ts`); JSON in/out. Errors are
`{ "error": "<message>" }` with an HTTP status (`HttpError` carries the status;
anything else → 500). A trailing slash is tolerated; unknown `/api/*` → 404; all
other paths fall through to static serving (SPA fallback to `index.html`). Every
`/api/*` request first passes the **CSRF / DNS-rebinding guard** (§6.6): a forged
cross-origin state-changing browser request is rejected `403` before it reaches a
handler, while no-Origin callers (CLI / MCP / curl) and `GET` reads pass through.

| Method | Path | Body | Response |
|--------|------|------|----------|
| `GET` | `/api/fs?path=&files=1` | — | `{ path, parent, home, isGitRepo, entries:[{name,path,isDir,isGitRepo}] }`. Dirs first, alpha; dotfiles hidden. `files=1` also lists regular files (context-file picker). 404/400/403 on bad path. |
| `GET` | `/api/health` (and bare `/health`) | — | health snapshot (see §5). 200 / 503. |
| `POST` | `/api/pause` | `{}` | `{ paused: true }` — pause **new** agent dispatch (drain-only maintenance mode; running/review/idle untouched). Persisted; idempotent. Publishes a `dispatch.paused` SSE event. |
| `POST` | `/api/resume` | `{}` | `{ paused: false }` — resume normal dispatch. Persisted; idempotent. Publishes a `dispatch.paused` SSE event. |
| `GET` | `/api/metrics?days=N` | — | `Metrics` aggregate (see below). `days` 1–90, default 14. |
| `GET` | `/api/directories` | — | `DirectoryView[]` (rows + `counts` by status, with `idle` peeled out of `running`). |
| `POST` | `/api/directories` | `{ path, label? }` | `201` `DirectoryView`. 400 if not a git repo; 409 if already registered; 502 if the herdr workspace can't be created. |
| `DELETE` | `/api/directories/:id` | — | `{ ok: true }`. Tears down each task's tab, cleans non-merged worktrees, closes the workspace, removes seeded `CTO.md`, cascade-deletes tasks. |
| `GET` | `/api/directories/:id/tasks` | — | `TaskListView[]` (newest first) — the same parsed `taskView` shape as the detail route, minus the `task.md`-derived `prompt`/`context`/`review_notes` and the `estimate` (the list views don't need them): each task is the DB row with `blocked_by`/`spawned_subtasks` as id arrays plus precomputed `blockerStates`/`deadBlockers`. 404 if directory gone. |
| `POST` | `/api/directories/:id/tasks` | `{ prompt, context?, blocked_by?, kind?, model? }` | `201` `TaskView`. `kind:"plan"` → plan task. Validates blockers exist (404), cycle (400), model (400), prompt required (400). |
| `GET` | `/api/tasks/:id` | — | `TaskView` (DB row + `task.md` prompt/context/review_notes + `blocked_by`/`blockerStates`/`deadBlockers`/`spawned_subtasks` + `estimate`, the rough p50–p90 duration estimate — see §10). 404 if gone. |
| `GET` | `/api/tasks/:id/diff` | — | `{ diff }` — committed `base...id` plus uncommitted worktree changes. |
| `GET` | `/api/tasks/:id/estimate` | — | `{ single, chain }` — the rough duration estimate (§10): `single` is the task's own p50–p90 range (same object as `TaskView.estimate`), `chain` the critical-path total across its dependency chain (a plan's sub-tasks, or this task's blockers) or `null` when there's nothing to chain. 404 if gone. |
| `GET` | `/api/tasks/:id/events` | — | `TaskEventRow[]` — the status-transition audit timeline, oldest→newest. 404 if gone. |
| `GET` | `/api/tasks/:id/output` | — | `{ output }` — best-effort live agent terminal text (`herdr agent read`); `""` once the pane is gone. |
| `GET` | `/api/tasks/:id/transcript` | `?offset=&limit=` | `{ turns, total, offset, limit, hasMore }` — the agent's session transcript parsed into ordered, role-labelled items (prose / thinking / tool-call name+brief-args / truncated tool-result); best-effort `turns:[]` when there's no session/transcript. `limit` clamped 1..500 (default 200). 404 if the task is gone. |
| `POST` | `/api/tasks/:id/approve` | `{}` | the merged `TaskView`, **or** `{ task, conflictSentBack:true }`, **or** `{ task, revertedOnRed:true }`. 409 if not in review / on a hard merge failure. |
| `POST` | `/api/tasks/:id/reject` | `{ note }` | `TaskView` (`→ queued` for resume). 409 if not in review; 400 if note blank. |
| `POST` | `/api/tasks/:id/abort` | — | `TaskView` (`→ aborted`). 409 if already merged/aborted. |
| `PUT` / `POST` | `/api/tasks/:id/blocked_by` | `{ blocked_by:[id,…] }` | `TaskView` — replaces + re-evaluates the dep set (auto-unblock / kill-on-block). 409 on terminal tasks; 404 unknown blocker; 400 cycle. |
| `POST` | `/api/tasks/:id/requeue` | `{}` | `TaskView` (`→ queued`, retry state cleared). 409 if merged/aborted. |
| `POST` | `/api/tasks/:id/rollback` | `{}` | `TaskView` (stays `merged`, stamped `rolled_back_at`). 409 if not merged / no recorded range / revert conflict. |
| `POST` | `/api/tasks/:id/terminal` | — | `{ ok, emulator?, command }` — opens a GUI terminal attached to the live pane. 409 if no live pane; 503 (with the manual command) if no emulator. |
| `GET` | `/api/events` | — | SSE stream (see §6.2). |
| `POST`/`GET`/`DELETE` | `/mcp/:taskId` | JSON-RPC | per-task MCP transport (see §6.3). `GET`→405, `DELETE`→204, 404 if task gone. |

`Metrics` (`computeMetrics`, pure over `metricRows()` + `now`): `total`,
`byStatus`, `throughput` (`days`, `perDay[]` oldest→newest UTC-day buckets,
`windowMerged`, `totalMerged`), `timeToReview`/`timeToMerge` medians
(`started→completed` / `started→merged`), and `Rate {rate,num,of}` for
`conflictRate`, `revertRate`, `ciPassRate`, `autoMergeRate` (rate is `null` when the
denominator is 0, distinguishing real-0% from no-data).

### 6.2 SSE (Server-Sent Events)

`GET /api/events` is an `text/event-stream`. On connect it emits
`{type:"hello", now}`, sends a `: keepalive` comment every 25 s, and forwards every
`ButchrEvent` published by the in-process pub/sub (`src/events.ts`):
`task.created` / `task.updated` / `task.deleted` (each carrying the `TaskView` or
id), `directory.created` / `directory.deleted`, and `dispatch.paused`
(`{ paused }` — dispatcher pause toggled, so the webapp can reflect the PAUSED
banner live). The server runs with `idleTimeout: 0` so streams aren't dropped.

### 6.3 MCP (per-task tools)

Hand-rolled Streamable-HTTP MCP (`src/mcp.ts`), stateless (identity = the
`/mcp/<taskId>` path, no `Mcp-Session-Id`). Handles `initialize`,
`notifications/initialized` (202), `ping`, `tools/list`, `tools/call`. Tools offered
depend on `kind`:

- **`request_review({ summary? })`** — *ordinary tasks.* Non-blocking: records the
  review request (`markReviewFromAgent`), returns immediately; the agent should
  exit. A terminal task (merged/aborted) reports its status instead.
- **`propose_subtasks({ subtasks:[{prompt,context?,blocked_by?}], summary? })`** —
  *plan tasks only.* Validates + creates the decomposition and completes the plan
  task (see §2.5). A bad/cyclic graph or blank prompt comes back as an `isError`
  tool result so the agent can re-propose (it never crashes the server).
- **`ask({ question })`** — *both kinds.* Routes the question to the **CTO**: a
  forked, headless, **read-only** Claude session (`src/cto.ts` →
  `BUTCHR_CTO_CMD`) run in the asking task's worktree so it can read the code under
  discussion. The CTO has **no `--mcp-config`** (can't recurse into ask/request_review)
  and only `Read/Grep/Glob` tools (can't edit). Timeouts/failures come back as a
  non-authoritative `isError` result. Agents are told (in the rendered prompt) to
  prefer asking over guessing.

### 6.4 Operator CLI (`bin/butchr`)

A dependency-free REST client (`fetch` only) targeting `http://127.0.0.1:47800`
(override `BUTCHR_URL`). Each subcommand maps onto exactly one REST route; it adds
no server logic. Exit non-zero on any API/usage/connection error; `--json` prints
the raw payload.

| Command | Maps to |
|---------|---------|
| `health` | `GET /health` (exit 1 if degraded) |
| `ls [--dir <id>] [--status <s>]` | `GET /api/directories(/:id/tasks)` — compact id/status/CI table; `idle` shows `status*`; `--dir` accepts an id or path; `--status` filters client-side |
| `new <dir> -m <prompt> [--blocked-by id,id]` | `POST /api/directories/:id/tasks` |
| `show <id>` | `GET /api/tasks/:id` — status, CI, summary, review notes, blockers, dispatch/revert errors |
| `approve <id>` | `POST …/approve` (reports merged / conflict-sent-back / reverted-on-red) |
| `reject <id> -m <note>` | `POST …/reject` |
| `requeue <id>` | `POST …/requeue` |
| `block <id> --on id,id` | `PUT …/blocked_by` (`--on ''` clears) |

### 6.5 Webapp (`public/`)

A vanilla-JS SPA (`app.js`, no framework/build) over `index.html` + `style.css`,
hash-routed and SSE-driven. Views/features:

- **Directories dashboard** — registered directories with live status counts; a
  filesystem **picker** (`/api/fs`) to register a repo.
- **Directory view** — its tasks with three layouts (list/table, **board** by
  lane, and a dependency **graph** via `graphLevels`), a filter bar, a queue line,
  a collapsible history section, and a **new-task modal** (prompt, context-file
  selector, blocked-by, model).
- **Task detail** — status/CI/summary, the rendered **diff** (`/api/tasks/:id/diff`,
  parsed + highlighted), the **timeline** (`/api/tasks/:id/events`), model/tokens/
  cost labels, a rough **duration estimate** (an *est. duration* row from
  `TaskView.estimate` plus a critical-path line on the blocked-by / spawned panels
  from `/api/tasks/:id/estimate` — see §10), live output, a collapsible **Agent
  transcript** panel (`/api/tasks/:id/transcript`, lazily fetched + paged:
  role-labelled prose, thinking, compact tool calls + truncated results, monospace +
  read-only), approve/reject/abort/requeue/rollback controls, and an **Open
  terminal** button (running tasks).
- **Metrics view** — `/api/metrics`: status bars, throughput sparkline, medians,
  and the conflict/revert/CI-pass/auto-merge rates.
- **Chrome** — light/dark theme toggle (persisted, applied pre-paint), a live
  connection LED, an **attention indicator** + tab-title badge driven by
  `needsAttention` (review + failed), with optional desktop notifications, and a
  **pause/resume control** + **PAUSED banner** driven by `health.paused`
  (`POST /api/pause` / `/api/resume`) so the operator can enter drain-only
  maintenance mode and see it at a glance.

### 6.6 CSRF / DNS-rebinding guard

butchr binds to **loopback** (`127.0.0.1`), but loopback is **not** a trust
boundary against the operator's own browser: any web page the operator merely
visits can make their browser send forged requests to
`http://127.0.0.1:<port>/api/...` — a cross-site `POST`, or a DNS-rebinding name
that resolves to loopback — which without a guard would let a malicious page
create / approve / abort tasks. A small **central guard** in `src/server.ts`
(`csrfGuard`, applied to every `/api/*` request before routing) blocks those
browser-driven forgeries while leaving non-browser callers untouched:

- **Origin check (state-changing methods only — `POST`/`PUT`/`DELETE`/`PATCH`).**
  Browsers always attach an `Origin` header to cross-site state-changing fetches.
  If an `Origin` is **present** and is **not** one of butchr's own origins, the
  request is rejected **`403`** with a clear `{ "error": … }` message. The webapp
  is same-origin, so its `Origin` matches and passes.
- **No-Origin requests are allowed.** A request with **no** `Origin` header — the
  operator CLI (`bin/butchr`), the per-task MCP server, `curl`, server-to-server —
  is not a browser cross-site request and passes through.
- **DNS-rebinding (Host) check.** For state-changing methods the request's `Host`
  must be a loopback / configured name; a rebound attacker domain pointed at
  `127.0.0.1` carries a foreign `Host` (even same-origin, so no cross-site
  `Origin`) and is rejected `403`.
- **Reads and the SSE stream are never gated** — `GET` requests (`/api/...` and
  `GET /api/events`) pass regardless of `Origin`/`Host`, so the webapp's reads and
  the live stream are unaffected.

**Allowlist** = the derived loopback origins `http://127.0.0.1:<port>`,
`http://localhost:<port>`, `http://[::1]:<port>`, `http://<BUTCHR_HOST>:<port>`,
plus any entries in **`BUTCHR_ALLOWED_ORIGINS`** (§8) — each allowlisted entry's
hostname is also accepted by the Host check.

> **Scope / limits.** This is **CSRF / DNS-rebinding hardening for a localhost
> tool, NOT authentication.** It assumes the single-operator, trusted-host model
> the rest of butchr assumes: there are **no tokens, no login, no sessions or
> users**, and a non-browser client that omits the `Origin` header still has full
> API access (by design — that is how the CLI and MCP server call in). It defends
> only against the operator's browser being turned into a confused deputy by a
> third-party web page; it is **not** a defense against a hostile local process or
> a multi-tenant host. Real authn/authz is a separate, future concern.

---

## 7. Data model

SQLite (`bun:sqlite`, WAL, `foreign_keys=ON`). Columns added after the initial
schema are applied as guarded in-place `ALTER TABLE` migrations (`ensureColumn`).

### `directories`

| column | type | meaning |
|--------|------|---------|
| `id` | TEXT PK | directory id (`dir-<8hex>`). |
| `path` | TEXT UNIQUE | absolute repo root. |
| `label` | TEXT | display label (defaults to the basename). |
| `herdr_workspace` | TEXT | the herdr workspace id for this directory. |
| `herdr_pane` | TEXT | the workspace's root pane id at creation. |
| `created_at` | TEXT | ISO creation time. |

Deleting a directory **cascades** to its tasks (and their `task_events`).

### `tasks`

| column | type | meaning |
|--------|------|---------|
| `id` | TEXT PK | task id (`adjective-noun-4hex`); also branch + worktree name. |
| `directory_id` | TEXT FK→directories | owning directory (cascade delete). |
| `status` | TEXT | the `TaskStatus` (see §2.1). |
| `kind` | TEXT (`'task'`) | `task` or `plan`. |
| `herdr_pane_id` | TEXT | the agent's current herdr pane (positional; may renumber). |
| `herdr_tab_id` | TEXT | the agent's dedicated herdr tab (one tab per task). |
| `session_id` | TEXT | the Claude Code session UUID butchr assigned (`--session-id`); enables durable `--resume` on rework. |
| `model` | TEXT | requested model alias/id (null = default → no `--model`). |
| `model_used` | TEXT | model the agent actually ran under (read from the session transcript). |
| `output_snapshot` | TEXT | sanitized run-log snapshot captured at review/merge. |
| `summary` | TEXT | the agent's optional `request_review` summary. |
| `review_note` | TEXT | the latest reviewer/conflict note (mirrored into `task.md`). |
| `conflict` | INTEGER | flag: a surfaced non-conflict merge failure on `review`. |
| `idle` | INTEGER | flag: a `running` agent gone quiet. |
| `ci_status` | TEXT | CI gate: `running`/`pass`/`fail`/null. |
| `ci_summary` | TEXT | CI badge label + output tail. |
| `dispatch_attempts` | INTEGER | consecutive failed dispatch attempts (reset on success/clean re-queue). |
| `last_dispatch_error` | TEXT | most recent dispatch failure message. |
| `next_dispatch_at` | TEXT | ISO backoff gate: don't dispatch before this. |
| `revert_reason` | TEXT | failing output when a merge was auto-reverted off main (set with `failed`). |
| `blocked_by` | TEXT | JSON array of blocker task ids. |
| `spawned_subtasks` | TEXT | JSON array of sub-task ids a plan task created. |
| `auto_merged` | INTEGER | 1 if butchr auto-merged this task. |
| `merge_base_sha` | TEXT | pre-ff base tip (exclusive lower bound of landed commits). |
| `merged_sha` | TEXT | post-ff tip (inclusive upper bound) — together the rollback range. |
| `rolled_back_at` | TEXT | ISO time the merge was rolled back (task stays `merged`). |
| `usage_input_tokens` | INTEGER | cumulative session input tokens. |
| `usage_output_tokens` | INTEGER | cumulative session output tokens. |
| `usage_cache_read_tokens` | INTEGER | cumulative cache-read tokens. |
| `usage_cache_creation_tokens` | INTEGER | cumulative cache-creation tokens. |
| `cost_usd` | REAL | **always null** — a deliberate placeholder. The transcript carries no dollar cost and butchr ships no pricing table, so it does not fabricate one. |
| `diff_lines` | INTEGER | final changed-line count (added + deleted vs the default branch) captured on the review transition; the SIZE-bucket signal for duration estimates (§10). Null until/unless captured. |
| `path_type` | TEXT | coarse path-based type of the changed files (`docs`/`webapp`/`core`/`mixed`), captured alongside `diff_lines`; the TYPE-bucket signal for estimates (§10). Null until/unless captured. |
| `created_at` | TEXT | ISO creation time. |
| `started_at` | TEXT | first `running` transition (never cleared). |
| `completed_at` | TEXT | `running→review` transition. |
| `merged_at` | TEXT | merge into the default branch. |

Token usage + `model_used` are read from the Claude Code session transcript
(`src/usage.ts`: `~/.claude/projects/<munged-cwd>/<session-id>.jsonl`, summing
`message.usage` across deduped assistant turns) and captured on the review/merge
transition and plan completion (`captureSessionUsage`, best-effort).

### `task_events` (audit timeline)

Append-only log of status transitions, one row per change:
`id` (autoinc), `task_id` (FK, cascade), `at` (ISO), `from_status` (null for
creation), `to_status`, `note`. Purely additive — nothing reads it to drive
behavior; it powers the task-detail timeline (`GET /api/tasks/:id/events`).

### `settings` (global key/value runtime state)

A tiny `key`/`value` store (`getSetting` / `setSetting` in `db.ts`) for server-wide
runtime state that must survive a restart but isn't per-task and isn't a static env
knob. Currently holds `dispatch_paused` (`'1'`/`'0'`) — the **dispatcher pause**
flag (see §3 *Pause / maintenance mode*), which is what keeps a pause in effect
across a restart.

---

## 8. Configuration

All settings live in `src/config.ts`, each overridable by an env var. Defaults:

| Env var | Default | Meaning |
|---------|---------|---------|
| `BUTCHR_HOST` | `127.0.0.1` | HTTP bind host (`0.0.0.0` → agents still dial loopback for MCP). |
| `BUTCHR_PORT` | `47800` | HTTP port (REST + webapp + SSE + MCP). |
| `BUTCHR_ALLOWED_ORIGINS` | _(empty)_ | comma-separated EXTRA browser origins allowed to make state-changing `/api` requests, on top of the derived loopback origins. Feeds the CSRF / DNS-rebinding guard (§6.6). |
| `BUTCHR_DATA_DIR` | `~/.local/share/butchr` | butchr's own state directory. |
| `BUTCHR_DB` | `<data>/butchr.db` | SQLite path. |
| `BUTCHR_LOG_FILE` | `<data>/butchr.log` | persistent log sink (empty disables file logging). |
| `BUTCHR_LOG_MAX_BYTES` | `10485760` (10 MB) | rotate the log past this size (0 disables). |
| `BUTCHR_LOG_KEEP` | `3` | rotated log files to keep. |
| `BUTCHR_HERDR_BIN` | `herdr` | herdr binary. |
| `BUTCHR_GIT_BIN` | `git` | git binary. |
| `BUTCHR_TICK_MS` | `1500` | dispatcher poll interval. |
| `BUTCHR_CTO_CONTEXT` | _(empty)_ | optional file seeding a new directory's `.butchr/CTO.md` (else built-in default). |
| `BUTCHR_VERIFY_CMD` | `bun build src/index.ts --target bun --outfile /dev/null && bun test` | post-merge verify gate, run via `bash -lc` in the repo root. **Empty disables** the gate. |
| `BUTCHR_VERIFY_TIMEOUT_MS` | `600000` (10 min) | timeout (treated as RED/FAIL) for **both** gates that share the gate runner: the post-merge verify gate and each in-worktree CI build/test command. |
| `BUTCHR_MAX_DISPATCH_ATTEMPTS` | `5` | consecutive dispatch failures before giving up to `failed`. |
| `BUTCHR_DISPATCH_BACKOFF_BASE_MS` | `1000` | base for `min(base·2^(n-1), cap)` retry backoff. |
| `BUTCHR_DISPATCH_BACKOFF_CAP_MS` | `30000` | backoff cap. |
| `BUTCHR_AGENT_CMD` | `claude --dangerously-skip-permissions {{MODEL_FLAG}} --session-id {{SESSION_ID}} --mcp-config {{MCP_CONFIG}} -- "$(cat {{PROMPT_FILE}})"` | first-launch agent command (run via `bash -lc` under `script`, worktree as cwd). Placeholders: `{{PROMPT_FILE}}`, `{{MCP_CONFIG}}`, `{{SESSION_ID}}`, `{{MODEL_FLAG}}`. |
| `BUTCHR_RESUME_CMD` | `claude --dangerously-skip-permissions {{MODEL_FLAG}} --resume {{SESSION_ID}} --mcp-config {{MCP_CONFIG}} -- "$(cat {{PROMPT_FILE}})"` | rework re-launch command (resumes the existing session). |
| `BUTCHR_AGENT_TIMEOUT_MS` | `3600000` (60 min) | watcher backstop: max time a watcher waits for the agent. |
| `BUTCHR_MAX_RUN_MS` | `2700000` (45 min) | runaway/stuck guard: max time in `running` without submitting before force-rescue to `review` (0 disables; trips before `AGENT_TIMEOUT_MS` by default). |
| `BUTCHR_AGENT_START_GRACE_MS` | `60000` | grace for a freshly-dispatched agent to register with herdr before it's rescued. |
| `BUTCHR_IDLE_MS` | `60000` | no-output window before a `running` task is flagged `idle` (0 disables). |
| `BUTCHR_CI_RETRIES` | `1` | flaky-CI retries on a failing review-gate build/test (0 disables). |
| `BUTCHR_AUTO_MERGE` | `false` | auto-merge CI-green low-risk tasks (opt-in). |
| `BUTCHR_AUTO_MERGE_ALLOWLIST` | `public/,test/,docs/,*.md` | comma-separated low-risk path allowlist. |
| `BUTCHR_AUTO_MERGE_MAX_LINES` | `150` | max changed lines for low-risk. |
| `BUTCHR_CTO_CMD` | `claude -p {{CTO_SESSION}} --permission-mode dontAsk --allowedTools "Read Grep Glob" -- "$(cat {{QUESTION_FILE}})"` | read-only, non-recursing CTO command for `ask`. Placeholders: `{{QUESTION_FILE}}`, `{{CTO_SESSION}}`. |
| `BUTCHR_CTO_SESSION_ID` | _(empty)_ | optional CTO session to `--resume … --fork-session` so the CTO inherits prior context. |
| `BUTCHR_ASK_TIMEOUT_MS` | `120000` | max wait for a CTO `ask` answer before it's killed. |
| `BUTCHR_TERMINAL_CMD` | _(auto-detect)_ | override for "Open terminal"; `{{CMD}}` → the shell-quoted `herdr agent attach` command. Else auto-detect kitty/konsole/alacritty/xfce4-terminal/xterm/gnome-terminal/x-terminal-emulator (needs `DISPLAY`/`WAYLAND_DISPLAY`). |

---

## 9. On-disk layout

**Per registered repo** (`.butchr/` is auto-added to the repo's `.gitignore` on
registration):

```
<repo>/
  .butchr/
    CTO.md                          # seeded CTO context (surfaced atop every agent prompt)
    tasks/<task-id>/task.md         # source of truth: front matter + Prompt + Review Notes
  <task-id>/                        # git worktree on branch <task-id> (git-excluded locally)
```

`task.md` front matter (`src/taskmd.ts`, hand-rolled YAML): `id`, `created`,
`status`, `context: [paths]`, plus `kind: plan` and `model: …` only when set.
Sections: `## Prompt`, `## Review Notes` (rejection notes appended over time). The
rendered agent prompt **lists context-file paths** rather than inlining their bodies
(the prompt is passed as a single shell argv via `"$(cat …)"`, so inlining large
files would blow `MAX_ARG_STRLEN` → E2BIG); the agent reads the files itself.

**butchr state dir** (`~/.local/share/butchr/`): `butchr.db` (+ WAL), `butchr.log`
(+ rotations), `prompts/<id>.md` (rendered prompts), `runs/<id>.log` + `<id>.done`
(PTY run log + exit marker), `mcp/<id>.json` (per-task MCP config), `ask/<id>.q.md`
(transient CTO question files).

---

## 10. Duration estimates (rough)

butchr derives a **rough, history-based forecast** of how long a task will take and
surfaces it as a **loose p50–p90 range with its sample size** — never a hard
promise. The model is a small, dependency-free **heuristic (no ML)** in
`src/estimate.ts`, kept **pure** (no DB / git / clock) like `db.computeMetrics`, so
it is unit-tested against synthetic rows (`test/estimate.test.ts`). The service
layer (`tasks.ts`) assembles its input rows from the tasks table and exposes the
result on `TaskView.estimate` and `GET /api/tasks/:id/estimate`.

**Signals (captured once, on the review transition).** When a task enters `review`,
`tasks.captureDiffFootprint` records two cheap signals **while the worktree still
exists** (it's discarded at merge): the final changed-line count (`diff_lines`, from
`git.diffStat`) and a coarse path-based type (`path_type` ∈
`docs`/`webapp`/`core`/`mixed`, from `estimate.classifyPathType`). It's
best-effort, fire-and-forget (review never blocks on it) and re-captured on each
review transition, so a rework's final footprint wins. Tasks that never reached
review — or that predate this feature — leave both NULL and only feed the overall
pool.

**Buckets + distributions (`computeEstimateStats`).** From the timestamps of
historical tasks it measures two running durations — **started→review**
(`started_at`→`completed_at`) and **started→merge** (`started_at`→`merged_at`),
mirroring the metrics module — and computes **P50 + P90** (nearest-rank) and a
sample count for each bucket. Tasks are bucketed by **size** (small ≤ 30 changed
lines, medium ≤ 150, else large) and by **type** (the `path_type`), plus an
**overall** pool. A row feeds a size/type bucket only if it recorded that footprint.

**A single task's estimate (`estimateTask`).** Picks the most specific bucket that
clears `MIN_SAMPLES` (3) — its **size** bucket, then its **type** bucket — and
otherwise falls back to the **overall** pool. A queued task that has only a prompt
(no footprint yet) goes straight to overall. The headline range is the
**started→merge** distribution (falling back to started→review); the result carries
`{ basis, bucket, toReview, toMerge, n, insufficient }`. When even the overall pool
has fewer than `MIN_SAMPLES` samples it is flagged **`insufficient`** so the UI shows
"insufficient data" rather than a fabricated number.

**A dependency chain's estimate (`estimateChain`).** For a plan task (over its
spawned sub-tasks) or a blocked task (over its blockers) it estimates the **critical
path**: each task's finish = its own started→merge duration **plus the max finish
across its blockers**, so parallel branches take the `max()` and the total is the
longest chain. Already-merged tasks contribute 0 (and aren't counted); a pending
task with no usable estimate contributes 0 but flips `insufficient`, so a chain total
is a floor, not a promise. It is cycle-guarded and memoized. p50 and p90 are summed
along their own longest paths.

**Surfaced** on the task-detail page (an *est. duration* row in the metadata grid,
plus a critical-path line atop the blocked-by / spawned-sub-tasks panel) and over the
API as above. Estimates ride on the same SSE `task.updated` events as the rest of
`TaskView`, so they track live.

**Caveats (deliberate).** The size/type buckets only have samples from tasks that
recorded a footprint; durations are wall-clock and include any queue / idle / rework
time; and the whole thing is a *rough forecast off a small history*, not an SLA —
which is why every surface hedges ("~", "rough") and shows the sample size.
