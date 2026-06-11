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
   - [2.6 Plan-preview gate](#26-plan-preview-gate)
   - [2.7 The `idea` front state (CTO-fork spec generation)](#27-the-idea-front-state-cto-fork-spec-generation)
3. [Dispatch & agents](#3-dispatch--agents)
4. [Review & merge](#4-review--merge)
5. [Self-healing & ops](#5-self-healing--ops)
6. [Interfaces](#6-interfaces)
   - [6.1 REST API](#61-rest-api)
   - [6.2 SSE](#62-sse-server-sent-events)
   - [6.3 MCP tools](#63-mcp-per-task-tools)
   - [6.4 Operator CLI](#64-operator-cli-binbutchr)
   - [6.5 Webapp](#65-webapp-public)
   - [6.7 CTO notification channel (one-way)](#67-cto-notification-channel-one-way)
   - [6.8 Managed CTO agent](#68-managed-cto-agent)
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

**The agent-execution harness (`src/harness.ts`).** The session/runtime that
actually *runs* the Claude Code agent sits behind a swappable interface —
**`AgentRunner`** (a.k.a. the ExecBackend) — so butchr is decoupled from herdr
specifically ("herdr or whatever"). The interface names every operation the rest of
butchr needs from the runtime: **provision** a workspace, **launch** the agent
(both the *interactive* workspace agent via a PTY/`script` wrapper — with
session-id / resume / mcp-config / model — **and** the *headless read-only* modes:
the CTO-fork spec generator, the conformance reviewer, the brief expander, via
`runHeadless`), **confirm live**, **resolve** the agent's pane handle, **read**
output, **send** control input to a live agent's stdin (see below), and **tear
down**. `src/herdr.ts` is the concrete herdr implementation
(`herdrRunner`); the **dispatcher and reaper talk to the `harness` proxy, never to
herdr directly**, and `setRunner()` lets tests (or a future deployment) drop in a
different backend — the dispatcher path is covered by a **fake backend** in
`test/harness.test.ts`. The runtime-handle types (`Workspace`/`Tab`/`StartedAgent`/
`PaneInfo`) and the headless `HeadlessSpec`/`HeadlessResult` are defined in
`harness.ts`; `herdr.ts` re-exports the handle types for its other importers
(`server.ts`/`directories.ts`/`tasks.ts`), which still call it directly.

**Driving a live agent's stdin (`send`).** butchr harnesses the *interactive*
Claude Code CLI, so the agent's stdin is a live control channel — but the harness
otherwise only **launches** + **reads**. `AgentRunner.send(name, input)` closes the
loop: it pushes control input to a LIVE agent's stdin, wrapping herdr's
`agent send` / `pane send-text` / `pane send-keys` primitives. `input` is either
literal **text** (`{ text, enter? }`) — a slash-command like `/compact` / `/clear`,
or a steering message, with an optional trailing **Enter** to submit it — or named
control **keys** (`{ keys: [...] }`, e.g. `C-c` to interrupt, `Enter`, `Escape`).
Text is written **by name** (`agent send`, the stable handle that survives herdr's
positional pane-id renumbering); Enter and keys go through `pane send-keys` on the
agent's resolved pane. It is **best-effort**: a send to a missing/dead agent or
pane is a no-op that **never throws**. Only meaningful for a LIVE agent —
**workspace agents exit at review**, so the prime consumer is the always-live
**managed CTO agent**, which can use it for **context hygiene** (send `/compact` to
a long-lived session whose context has grown — cleaner than a fresh restart) and to
**interrupt** a stuck/runaway agent with `Ctrl+C` instead of killing its pane. A
thin butchr-level helper may sit on top, but the capability itself is the seam
method; core butchr behavior is unchanged by adding it.

**Current-pane-by-name resolution (surviving herdr renumbering).** herdr pane ids
are **positional**: when a sibling tab/pane closes, herdr **renumbers** the
survivors, so the `herdr_pane_id` butchr cached at launch silently goes stale and
can point at a **different task's** (often already-dead) shell. The agent **name**
(= the task id) is the only stable, butchr-owned handle, so **every pane-touching
path resolves the task's *current* pane by name at use-time** rather than trusting
the cached id:

- `AgentRunner.reconcilePane(name, stored?)` resolves the live pane by name (via the
  renumber-stable `resolveAgentPane`, which keys on the opaque `terminal_id`) and
  reports whether `stored` has **drifted**. `dispatcher.currentPaneRepairing(taskId)`
  wraps it: when the live pane differs from the stored id it **repairs** the row
  (`tasks.repairPaneId`) so the DB reconverges, and otherwise leaves it untouched. A
  herdr hiccup or a just-exited agent degrades to the stored id — it never erases a
  still-valid pane.
- The pane-touching sites all run this reconciliation: the **auto-nudge** (below)
  before each nudge, the **startup re-adopt** (resolves the pane by name, not the
  stored id), and the **terminal-attach** route (`POST /api/tasks/:id/terminal`). The
  **teardown** path (`teardownTask`) and the startup **reaper** never trust a stored
  positional id at all — they close/deregister strictly **by agent name**, so a
  renumber can never make them target the wrong task's tab/pane. `send` likewise
  routes text **by name** and resolves the pane for Enter/keys at call-time.

```
                          ┌──────────────────────────── butchr (one Bun process) ────────────────────────────┐
                          │                                                                                    │
  Browser (SPA) ─HTTP/SSE─┤  server.ts                                                                         │
  bin/butchr CLI ─REST────┤   ├─ REST /api/*  ──────────────► tasks.ts / directories.ts ◄─► db.ts (SQLite WAL) │
                          │   ├─ SSE  /api/events ◄─ events.ts (in-proc pub/sub)                                │
                          │   ├─ /health                                                                        │
                          │   └─ /mcp/:taskId ──► mcp.ts ── request_review / ask / propose_subtasks / propose_plan │
                          │                                                                                    │
  Claude Code agent ─MCP──┘   dispatcher.ts (tick loop + watcher) ─► taskmd.ts (prompt render)                 │
        ▲                      │  ├─ git.ts   (worktree / rebase / merge / revert / cleanup)                    │
        │ herdr CLI            │  ├─ harness.ts (AgentRunner seam) ─► herdr.ts (workspace / tab / pane / agent) │
        │ (agent start, …)     │  ├─ verify.ts (post-merge gate)  usage.ts (token accounting)                  │
        ▼                      │  └─ taskmd.ts (prompt render: agent / rework / answer)                         │
   herdr server ◄─PTY/panes────┘   reaper.ts (boot cleanup)  log.ts (rotating file log)                        │
                          └────────────────────────────────────────────────────────────────────────────────────┘
                              │
       Per repo on disk:  <repo>/.butchr/tasks/<id>/task.md   (+ CTO.md)   and   <repo>/<id>/  (git worktree)
       butchr state dir:  ~/.local/share/butchr/{butchr.db, butchr.log, prompts/, runs/, mcp/}
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

### 2.1 States — the canonical 9-state model

`TaskStatus` (`src/db.ts`) is **exactly nine states**. Every state has a **kind** —
one of three — and an **agent** state additionally has a **type** (which agent runs
it). This 3-kind / 2-agent-type categorization is the single source of truth in
**`STATE_META`** (`src/db.ts`); logic (dispatcher / reconcile / feedback) and the UI
both derive their behavior from it rather than hard-coding status lists.

**The three KINDS:**

- **`idle`** — no agent is running and butchr awaits nothing from the operator (the
  task is terminal, or waiting on something mechanical).
- **`agent`** — an agent is (or is about to be) running for the task.
- **`feedback`** — butchr has surfaced an **artifact** and awaits an **operator
  response**. The three feedback states share **one code path** (§2.1.1).

**The two AGENT TYPES:**

- **`ceo-agent`** — the headless, read-only **CTO-fork** spec writer (`src/cto.ts`).
- **`workspace-agent`** — the interactive agent that builds the code in the worktree.

| status | kind | agent type | terminal? | meaning |
|--------|------|------------|-----------|---------|
| `idea` | agent | ceo-agent | no | the **front state**: a task from a one-line operator **brief** with no spec yet. The CEO agent (CTO-fork, `src/cto.ts`) writes the SPEC, then advances to `spec_review`. See §2.7. |
| `spec_review` | **feedback** | — | no | the generated **spec** is the artifact. Operator **approves** → `in_progress`, or **requests changes** → revise the spec (back to `idea`, re-running the generator with the notes). |
| `blocked` | idle | — | no | has ≥1 not-yet-merged blocker (`blocked_by`); a pre-dispatch waiting state — no agent runs. Promoted to `in_progress` when all blockers merge. |
| `needs_info` | **feedback** | — | no | an agent called `ask` to pose a clarifying **question** (stored in `question`) and exited. The ad-hoc feedback stage **any agent state** can enter. On `/answer` the agent resumes. |
| `in_progress` | agent | workspace-agent | no | the workspace agent builds the code. **Ready vs. running** is carried by `herdr_pane_id`: NULL = ready (the dispatcher will launch it), set = a live agent. |
| `in_review` | **feedback** | — | no | the **diff** is the artifact (agent called `request_review`, or was rescued). Operator **approves** → `finalizing`, or **requests changes** → resume the workspace agent (`in_progress`). Pure DB state — no live process. |
| `finalizing` | agent | workspace-agent | no | post-approval: the workspace agent does **'final thoughts'** (a wrap-up pass), then the system **finalizes** (rebase + merge + post-merge verify) → `merged`. Same ready-vs-running pane rule as `in_progress`. |
| `merged` | idle | — | **yes** | branch fast-forwarded into the default branch; worktree + branch removed. (Also the terminal state for a completed **plan** task, which merges nothing of its own.) |
| `aborted` | idle | — | **yes** | abandoned from any non-terminal state; worktree + branch discarded, **nothing merged**. `task.md` kept. Also where a **dispatch give-up** (after `BUTCHR_MAX_DISPATCH_ATTEMPTS`) and a **post-merge-verify revert** (carries `revert_reason`) land — there is no separate `failed` state. |

> **No `queued`/`running`/`review`/`awaiting_input`/`rejected`/`failed` statuses.**
> The earlier model's `queued`+`running` collapse into **`in_progress`** (ready-vs-running
> = `herdr_pane_id` NULL-vs-set, which is restart-safe); `review`→`in_review`;
> `awaiting_input`→`needs_info`; a request-changes loops back (no `rejected` state); a
> dispatch/finalize give-up or a post-merge revert lands in the terminal idle
> `aborted`. The only dead-blocker state is now `aborted`
> (`DEAD_BLOCKER_STATES = {aborted}`).

**Happy path:** `idea → spec_review → in_progress → in_review → finalizing → merged`.
`needs_info` is the ad-hoc feedback stage any agent state can enter, then resume.

#### 2.1.1 The unified feedback mechanism

`spec_review`, `in_review`, and `needs_info` are **one concept**, not three. Each
**surfaces an artifact** (spec / diff / question), **awaits an operator response**
(`approve` / `request_changes` / `answer`), and then **forwards** the task or
**resumes** the agent. They share a single code path — **`respondToFeedback(id,
response)`** in `src/tasks.ts` — and a single descriptor, **`feedbackInfo(status)`**,
that the UI reads to show *what's awaited*. `approveTask` / `rejectTask` / `answerTask`
are thin public wrappers over it:

| state | artifact | `approve` → | `request_changes` → | `answer` → |
|-------|----------|-------------|---------------------|------------|
| `spec_review` | spec | `in_progress` (or `blocked`) | `idea` (re-generate the spec with the notes) | — |
| `in_review` | diff | `finalizing` | `in_progress` (resume the agent) | — |
| `needs_info` | question | — | — | `in_progress` (resume the agent) |

### 2.2 Transitions

All status writes live in `src/tasks.ts` (kept together) and each appends a row to
the `task_events` audit log via `recordTaskEvent`.

| from → to | trigger | code |
|-----------|---------|------|
| (none) → `idea` | task created with `idea: true` (a one-line brief, no spec yet) | `createTask` |
| (none) → `in_progress` | task created with a spec + no/already-merged blockers (ready) | `createTask` |
| (none) → `blocked` | task created with ≥1 unmerged blocker | `createTask` |
| `idea` → `spec_review` | the CEO/CTO-fork spec generator produced the spec; `task.md`'s prompt is rewritten brief → spec | `promoteIdeaToSpecReview` (via dispatcher `generateSpecForIdea`) |
| `idea` → `idea` (backoff) | spec generation failed, under the attempt cap → stamp `next_dispatch_at` | `markSpecGenFailure` |
| `idea` → `aborted` | spec generation gave up at/over the cap | `markSpecGenFailure` |
| `spec_review` → `in_progress`/`blocked` | operator **approved** the spec (the deferred blocker check applies) | `approveTask` / `respondToFeedback` |
| `spec_review` → `idea` | operator **requested spec changes** → revise (re-run the generator with the notes) | `rejectTask` / `respondToFeedback` |
| `blocked` → `in_progress` | all blockers merged (auto-unblock), or operator clears deps | `reevaluateBlockedTask` / `setBlockedBy` |
| any non-terminal → `blocked` | operator adds an unmerged blocker (kill-on-block if a live agent) | `setBlockedBy` |
| `in_progress` (pane set) | dispatcher launched the build agent — records `herdr_pane_id` (status unchanged: ready → running) | `markRunning` |
| `in_progress` → `in_review` | agent called `request_review` (live path); or watcher/reconcile rescue of a dead agent | `markReviewFromAgent` / `markInReview` |
| `in_progress`/`finalizing` → `needs_info` | agent called `ask` (non-blocking) → parks holding the question, agent exits | `markNeedsInfoFromAgent` |
| `needs_info` → `in_progress` | operator/CTO/human answered → resume the `--resume` re-launch with the answer injected | `answerTask` / `respondToFeedback` |
| `in_review` → `finalizing` | operator **approved** → the workspace agent does 'final thoughts' before the merge | `approveTask` / `respondToFeedback` |
| `in_review` → `in_progress` | operator **requested changes**, or a finalize-time merge conflict kicked back to the agent | `requestChanges` (via `rejectTask` / `finalizeMerge`) |
| `finalizing` (pane set) | dispatcher launched the finalize agent — records `herdr_pane_id` | `markRunning` |
| `finalizing` → `merged` | finalize agent done (or ended/recovered) → rebase + merge + post-merge verify GREEN | `finalizeMerge` (via `markReviewFromAgent` / watcher / `recoverFinalizingTasks`) |
| `finalizing` → `aborted` | finalized, merge ff'd, but post-merge verify RED → auto-revert (carries `revert_reason`) | `finalizeMerge` (`revertedOnRed`) |
| `in_progress`/`finalizing` → `in_progress`/`aborted` (backoff/give-up) | dispatch failed: under the cap keep the phase + stamp `next_dispatch_at`; at the cap an `in_progress` give-up → `aborted` (a `finalizing` give-up instead lands the merge) | `markDispatchFailure` |
| `in_progress`/`needs_info` → `merged` | **plan** task submitted its decomposition | `proposeSubtasks` |
| any non-terminal → `aborted` | operator aborted | `abortTask` |
| stuck non-terminal → `in_progress` | operator re-queued (resets retry state; terminal tasks refused) | `requeueTask` |

A `merged` task can be **rolled back** by creating a deliberate **rollback task**
from the built-in `rollback` template (the webapp's "Roll back" button); that task
reverts the change and repairs any fallout through the standard pipeline (see §4).

**Timestamp semantics** (used by metrics): `started_at` = first agent launch
(`markRunning` records the pane; COALESCE — never cleared on rework); `completed_at`
= `in_progress→in_review`; `merged_at` = merge into default branch.

### 2.3 Orthogonal flags

These are columns set *alongside* a status, not states themselves; each is only
meaningful within its owning status and is cleared as the task moves on:

- **`herdr_pane_id`** (on `in_progress`/`finalizing`) — **not just bookkeeping**: a
  NULL pane means the task is **ready** (the dispatcher launches it); a set pane means
  a **live agent**. This is the restart-safe ready-vs-running signal (§2.1). The id is
  **positional** and herdr *renumbers* it when a sibling tab/pane closes, so it is
  **self-healed at use-time** by re-resolving the agent's current pane **by name** —
  pane-touching paths never trust the cached id (see *Current-pane-by-name resolution*
  above).
- **`idle`** (on a live `in_progress` agent) — agent alive but its CLI produced no
  output for `BUTCHR_IDLE_MS`. Owned by the dispatcher watcher; set/cleared via
  `setIdle`, which only writes (and emits) on a genuine flip. A *prolonged* idle is a
  **stall** the watcher auto-recovers — see the stalled-agent auto-nudge below.
- **`conflict`** (on `in_review`) — a non-conflict merge failure surfaced to the human
  (set by `finalizeMerge` on an unusual merge error).
- **`ci_status` / `ci_summary`** (on `in_review`) — the advisory CI gate result
  (`running` | `pass` | `fail` | null) plus a badge label + output tail.
- **`conformance_status` / `conformance_summary`** (on `in_review`) — the advisory
  **spec-conformance** gate result (`checking` | `pass` | `concern` | null) plus the
  reviewer's short reason. Whether the diff actually *satisfies the prompt* (complete +
  on-spec), orthogonal to CI's build/test signal.
- **`revert_reason`** (on `aborted`) — failing build/test output when a merge was
  auto-reverted off main by the post-merge verify gate. Its presence is what the UI
  keys on to render a "reverted from main" panel (distinct from an operator abort).
- **`auto_merged`** (on `merged`) — 1 when butchr auto-approved + merged (CI-green +
  low-risk) rather than a human.
- **`dispatch_attempts` / `last_dispatch_error` / `next_dispatch_at`** — bounded
  dispatch retry bookkeeping (see §3).

### 2.4 Dependencies (blocked_by)

`blocked_by` is a JSON-array TEXT column of blocker task ids (parsed by
`parseBlockedBy`). Semantics:

- **Blocking.** A task with any not-yet-merged blocker starts in `blocked` and no
  agent runs for it. An empty / all-merged set is immediately `in_progress` (ready).
- **Auto-unblock.** `reevaluateBlockedTask` promotes a `blocked` task to `in_progress`
  the moment **all** blockers reach `merged`. It runs both as a per-tick backstop
  (every `blocked` task is re-checked at the top of `tick`) and immediately after
  any merge / plan completion (`reevaluateAllBlocked`) for promptness.
- **Dead-blocker hold.** A blocker in the terminal non-merged state `aborted` or gone
  entirely (`getTask` → null) will **never** merge, so
  the dependent stays `blocked` indefinitely. These are surfaced as `deadBlockers`
  on the task view and logged once each (deduped via `loggedDeadBlockers`) with
  "edit blocked_by to proceed." The operator must edit the set to make progress.
- **Cycle / self guard.** `wouldCreateCycle` walks the existing dependency graph
  from each proposed blocker; a self-reference or any path back to the task is
  rejected (HTTP 400) at both `createTask` and `setBlockedBy`.
- **Kill-on-block.** `setBlockedBy`, when it transitions a task *into* `blocked`
  from a non-terminal state and the task has a live agent, tears the agent
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

### 2.6 Plan-preview gate

A task created with **`plan_preview: true`** opts into the **plan-preview gate**. This
is *orthogonal* to `kind`: a plan-preview task is an **ordinary work task that writes
code** — it just gets the operator's sign-off on its approach *first*. It **reuses the
NEEDS-INFO handshake** (§2.1 `needs_info`), so no new lifecycle state is added.

- On its **first** dispatch the agent is handed the **`PLAN_PREVIEW_PROTOCOL`**
  (`taskmd.ts`) instead of the review protocol, plus the **`propose_plan`** MCP tool.
  It is told to analyze the request, submit a **concise implementation plan** via
  `propose_plan`, and **stop** — *before* writing any code.
- `propose_plan` calls `markNeedsInfoFromAgent` (the same core the `ask` tool
  uses), parking the task in **`needs_info`** holding the plan (stored in
  `question`); it returns immediately and the agent exits.
- The operator reviews the plan (webapp answer box / CLI `answer` / API) and answers
  **`proceed`** or steering notes. `answerTask` re-queues for a **`--resume`** re-launch
  with the decision injected (`renderAnswerPrompt`, which carries the review protocol),
  so the agent **implements** the work and calls `request_review` as normal.
- Non-plan-preview tasks behave exactly as before. `plan_preview` is set **only at
  creation** (API `plan_preview`, CLI `new --plan`, webapp checkbox) and stored on the
  task row + in `task.md` front matter (`plan_preview: true`).

### 2.7 The `idea` front state (CEO/CTO-fork spec generation)

**One state machine, one task** (§2.1): a single task flows `idea → spec_review →
in_progress → in_review → finalizing → merged`. The `idea` front state collapses what an
even-earlier design modelled as a separate `stage` axis (`idea | spec | build`) into the
status itself — there is **no second axis** and **no spawned build task**; one task
carries the work from idea to merge. (The orphaned `stage` DB column on old DBs is never
read/written.)

**How `idea` works.** An `idea` task is created from a one-line operator **brief** (the
"New Idea" path; `createTask({idea:true})`), starting in status `idea` with the brief as
its prompt. It is **not** dispatched as a build agent. Instead the dispatcher
(`generateSpecForIdea`) runs the **CTO-fork spec generator** (`src/cto.ts`):

- a forked, **headless, READ-ONLY** claude (`config.specGenCmd`) that grounds itself in
  the repo (`Read`/`Grep`/`Glob` over `SPEC.md` / code — it **reuses `src/expand.ts`**'s
  brief→prompt grounding prompt + output parser) and writes a detailed, repo-grounded
  task **prompt (the spec)**. When `config.ctoSessionId` is set, `{{CTO_SESSION}}` expands
  to `--resume <id> --fork-session` so the spec inherits the **CTO's** accumulated context
  without mutating the real session. It has **no `--mcp-config`** (can't recurse into
  butchr's own tools) and **no write tools** (can't mutate the repo). This **revives** the
  retired CTO-fork mechanism (the human-ask change had retired the old CTO auto-answer).
- On **success** (`promoteIdeaToSpecReview`): the task's `task.md` Prompt section is
  rewritten brief → **spec**, and the task advances to **`spec_review`** — the feedback
  gate where the spec is the artifact (§2.1.1). The operator **approves** (→ `in_progress`,
  where it dispatches the **workspace agent**) or **requests changes** (→ back to `idea`,
  re-running the generator with the notes via `input.notes`, then → `spec_review` again).
- On **failure** (`markSpecGenFailure`): the same bounded retry/backoff as a dispatch
  failure, except the task stays in `idea` between retries; at the attempt cap it goes to
  the terminal `aborted` (carrying `last_dispatch_error`).

**A spec'd task is just the default.** Creating a task with a full prompt (the "New task"
path, `idea` omitted/false) enters `in_progress` (ready) directly and runs exactly as a
normal build task — it skips `idea`/`spec_review` because it already carries a spec.

**Migration (backward-compatible, forward-only).** Two startup migrations run in
`src/db.ts`: `migrateStageAxisToStatus()` flips any legacy `stage='idea'` row that hadn't
been dispatched to status `idea`; then `migrateStatusModel()` renames the OLD status
values into the canonical model (`queued`/`running`→`in_progress`, `review`→`in_review`,
`awaiting_input`→`needs_info`, `rejected`/`failed`→`aborted`). Both are no-ops once
converged. A legacy `stage:` line in `task.md` front matter is ignored on parse; the
orphaned `stage` DB column is left in place (no destructive `ALTER`).

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
4. **Auto-merge backstop:** if enabled, re-checks every `in_review` task with
   `ci_status='pass'` and `auto_merged=0` (deduped + serialized downstream).
4b. **Idea pass:** runs the CEO/CTO-fork spec generator for every eligible `idea` task.
5. Selects **READY agent-phase** tasks — `status IN ('in_progress','finalizing')` with
   **`herdr_pane_id IS NULL`** (no live agent) — whose `next_dispatch_at` is null or in
   the past, ordered by **`priority DESC, created_at ASC`** — a higher-`priority` task
   jumps the queue ahead of older lower-priority ones, and ties stay FIFO (oldest first;
   every task defaults to priority `0`). This single gate covers fresh builds,
   reworks/resumes, answer-resumes, AND the post-approval finalize launch. Dispatches
   each that isn't already `dispatching`/`watching` — concurrently, no cap. The
   `dispatching`/`watching` sets (keyed by task id) prevent double-dispatch across
   overlapping ticks. This selection runs through `selectQueuedForDispatch`, which
   returns **nothing while dispatch is paused** (see below), so no new agent starts.

### Pause / maintenance mode (drain-only)

A global switch (`dispatcher.{isPaused,setPaused}`, toggled by `POST /api/pause` /
`/api/resume`) stops **new** agent dispatch so the operator can hold for a
restart / recovery / maintenance window. **Semantics when paused:**

- Step 5's `selectQueuedForDispatch` returns an empty list → **no ready task is
  launched**.
- Steps 3–4 still run: the **auto-unblock pass still promotes** a `blocked` task
  whose blockers all merged to `in_progress` (it just waits there, undispatched, until
  resume), and the **auto-merge backstop still lands** CI-green low-risk `in_review`
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
2. **Ensure worktree** (`git.createWorktree`, idempotent — **validate-or-rebuild**;
   see below). The worktree dir is locally excluded via `.git/info/exclude` so it
   never shows as untracked.
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

### Worktree validate-or-rebuild (createWorktree)

`git.createWorktree` is **idempotent** — re-dispatching a task (rework, resume,
finalize, an overlapping tick) reuses the existing `<repo>/<taskId>` checkout. But
it does **not blindly trust** a dir already sitting at that path: a leftover from a
crash, an interrupted cleanup, or a repo **move** that broke the worktree's `.git`
gitdir link must not be silently reused. Reusing one stranded agent work behind a
broken link, and once nearly **reverted merged code** by re-dispatching a task into
a leftover dir on a **stale base** (the branch missing commits that had since merged)
— a revert that would have ridden in while CI stayed green.

So before reusing an existing dir, `createWorktree` **validates** it
(`worktreeIsReusable`); it is reused only when **all** hold:

1. git recognizes it as a **live linked worktree** — `rev-parse --git-dir` succeeds
   from inside it (catches a broken/missing `.git` link) **and** the path appears in
   the repo's `git worktree list` (catches a half-pruned admin record);
2. it is checked out on **branch `<taskId>`**;
3. it is **not a never-worked leftover on a stale base** — the current default tip is
   already contained in the branch, **or** the branch carries its own commits. A
   branch that is behind the tip **with commits** is real agent work and is **reused**
   (the pre-dispatch / merge-time rebase replays it onto the tip — `createWorktree`
   must **never discard** committed work); a behind branch with **no** commits has
   nothing to preserve and is treated as stale.

If any check fails, the dir is **rebuilt**, not reused: `worktree remove --force`
(falling back to deleting the dir + `worktree prune` when git no longer recognizes
it) and `branch -D`, then a fresh `worktree add -b <taskId>` rooted at the **current
default tip**. Everything is best-effort and idempotent — a recoverable stale state
never throws — and the **normal no-leftover path is unchanged** (`worktree add -b`).
The pre-dispatch auto-rebase below still runs afterward to move a reused behind-base
branch (with commits) onto the tip.

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
agent never started. This is routed to `markDispatchFailure` (retry/backoff/give-up)
rather than masquerading as an empty review. All other end conditions are **phase-aware**:
a dead `in_progress` agent → `markInReview` (with an explanatory note prefixing the
captured output); a dead `finalizing` agent → `finalizeMerge` (the operator already
approved, so land the merge).

`refreshIdle` toggles the `idle` flag from the run log's mtime (the agent runs under
`script -f`, so the log mtime tracks live output) and returns how long the CLI has
been quiet, which drives the auto-nudge below.

#### Stalled-agent auto-nudge

A **stall** is the gap between the two recovery mechanisms above: an `in_progress`
**workspace** agent that is *alive but quiet* — wedged on a transient API error (e.g.
a **529 Overloaded**) or parked at an empty prompt. The idle detector only **flags**
it (`idle`); the runaway watchdog only catches an agent that's alive-and-**looping**
(it fires on elapsed wall-clock, not on silence). Neither *recovers* a quiet stall,
so the task halts until a human opens the pane and types `continue`.

On each poll tick the watcher runs `maybeNudgeStalledAgent`: once the agent has been
quiet past `BUTCHR_IDLE_MS` **plus** the grace period `BUTCHR_IDLE_NUDGE_MS` (a small
multiple of the idle window; `0` disables auto-nudging), it first **re-resolves the
agent's current pane by name and self-heals a drifted `herdr_pane_id`**
(`currentPaneRepairing` — herdr may have renumbered the pane while the agent sat
idle, so the cached id can point at a dead sibling shell), then best-effort `send`s
`continue` + Enter — addressed **by agent name**, so herdr routes it to the *live*
pane, never the renumbered-away one — and records the nudge on the task's event
timeline. The trip itself is the pure, unit-testable
`shouldNudgeStall`. Successive nudges are spaced by at least the grace period and are
**bounded** by `BUTCHR_IDLE_NUDGE_MAX` *consecutive* nudges; at the cap the watcher
gives up and leaves the task flagged `idle` for a human (so it can never nudge-loop
against a truly wedged agent). The consecutive count **resets** the instant output
resumes. Scope is strict: only a live `in_progress` workspace build agent is nudged —
the short-lived `finalizing` pass is skipped, and the **managed CTO agent** (which is
event-driven and idle *by design*) and any other non-workspace agent never run under a
task watcher, so they are never nudged.

### Retry, backoff, and give-up

`markDispatchFailure` is the **only** path that increments `dispatch_attempts`:

- Always: tear down any half-created herdr agent/tab, increment the count, store
  `last_dispatch_error`.
- **Under the cap** (`dispatch_attempts < BUTCHR_MAX_DISPATCH_ATTEMPTS`, default 5):
  keep the current agent phase (`in_progress`/`finalizing`) with the pane cleared (→
  ready again) and set `next_dispatch_at = now + backoff`, where
  `backoff(n) = min(base · 2^(n-1), cap)` (`dispatchBackoffMs`; base 1 s, cap 30 s).
  The tick loop skips the task until then — no more hot-looping.
- **At/over the cap:** an `in_progress` give-up → terminal `aborted` (no `failed`
  state); a `finalizing` give-up instead **lands the merge** via `finalizeMerge` (the
  operator already approved — don't strand approved work).

A clean re-queue (`backToQueued`) and a rework re-queue (`requestChanges`) **reset**
the retry state — they are fresh intent, not failures. `POST …/requeue`
(`requeueTask`) is the operator escape hatch that revives a stuck **non-terminal** task
by clearing the retry state and re-arming it as ready `in_progress` (a dispatch give-up
is now the terminal `aborted`, so it is recreated rather than requeued).

---

## 4. Review & merge

### Non-blocking review

`request_review` (MCP) is **non-blocking** and **status-aware**: `markReviewFromAgent`
from `in_progress` records the request, moves the task `in_progress → in_review`, stores
the optional summary, clears the pane (it's about to close), captures the run-log
snapshot + session token usage, and triggers the CI + conformance gates — then returns
immediately. (Called from `finalizing` — the 'final thoughts' agent signalling done — it
instead kicks off `finalizeMerge`.) The agent then **exits**; review is pure DB state
with no live process held open. This is what makes review durable across an agent or
butchr restart (an MCP server can't wake an idle Claude Code client, so butchr never
parks a call).

### Commit-on-review (the branch is the durable source of truth)

Agents are told they **need not commit** — butchr captures the worktree. That left a
durability gap: a task could enter a review state (`in_review` / `needs_info`) with the
agent's diff living **only as uncommitted worktree state**. If the worktree were then
deleted — a repo move's DELETE cascade, the reaper, a crash cleanup — the work was
**permanently lost**; and `git.rebaseOntoDefault`'s *"no commits → reset onto tip"* branch
could wipe such a branch on re-dispatch.

So whenever a **workspace-agent** task transitions **out of `in_progress`** into a
non-merged review state — `in_review` (live `markReviewFromAgent`, the dead-agent rescue
`markInReview`, and the watchdog/reconcile paths that route through it) or `needs_info`
(`markNeedsInfoFromAgent`) — butchr **auto-commits the worktree FIRST**, via
`git.commitWorktree` (`git add -A` then commit `butchr: wip <taskId> (auto-saved)`,
reusing `git.merge`'s mechanism). The agent's diff now lives **on the task branch** — the
**durable source of truth** for review-state work — independent of the transient worktree.

Properties:

- **Unconditional.** The WIP commit happens **even if unresolved conflict markers are
  present** — preserving the work matters more than purity. The base is still protected:
  `git.merge`'s `findConflictMarkers` scan **refuses to merge** a branch whose (now
  committed) content carries markers.
- **Best-effort + idempotent.** A commit failure — including *"nothing to commit"* — is a
  no-op that **never breaks the state transition**.
- **Resume keeps it.** Request-changes (`rejectTask`) and answer (`answerTask`) resume the
  workspace agent **without resetting the branch**, so the WIP commit stays and the agent
  continues **on top of it**; its further changes still merge cleanly (`git.merge` collapses
  / replays the WIP commit through its rebase).
- **Fixes the reset fragility.** A review-state branch now **always has a commit**, so
  `rebaseOntoDefault` rebases it (rather than hitting the *no-commits → hard-reset* path).

### Non-blocking ask (the needs-info handshake)

`ask` (MCP) follows the **same non-blocking shape** as `request_review`, applied to
a mid-task clarifying question — the ad-hoc feedback stage **any agent state** can enter.
`markNeedsInfoFromAgent` records the agent's `question`, moves the task
`in_progress`/`finalizing` `→ needs_info`, clears the pane, captures the
run-log snapshot + token usage — then returns immediately. The agent **exits**;
needs-info is pure DB state with no live process (no CTO Claude is consulted —
that auto-answer mechanism was retired). butchr surfaces the question through **one
unified surface** — `/health` `needsAttention`, the webapp answer box, the
`POST /api/tasks/:id/answer` endpoint, and `butchr answer <id> -m …` — so whoever
operates answers: the operator/CTO via API/CLI when running unattended, or a human
in the webapp on a project they want to be in the loop on. `answerTask` (the `answer`
arm of the unified feedback mechanism) then logs the Q&A to `task.md`, resumes the task
to `in_progress` (pane NULL), and the dispatcher **re-launches the SAME Claude session**
via `--resume <session_id>` with the answer injected (rendered by `renderAnswerPrompt`) —
the exact mirror of the request-changes→resume rework path.

### CI gate (pre-merge, in-worktree, advisory)

On a genuine `in_progress → in_review` transition, `triggerCi` runs the directory's
**build/test gate command in the task's worktree**, fire-and-forget — review never
blocks on it. The command is the directory's **per-directory `gate_cmd`** (or the
default `BUTCHR_VERIFY_CMD`), resolved via `directories.directoryGateCmd` and run as a
single `bash -lc` invocation — so each registered repo defines its own build/test
(butchr's own default is `bun build … && bun test ./test`; another repo sets
`npm test`, etc.). The default's test arg is **scoped to `./test`** because task
worktrees live at `<dir>/<taskId>` (subdirs of the repo): a bare `bun test` from
either gate's cwd would glob sibling worktrees' tests and run an unstable,
cross-task suite — see the verify gate below and `BUTCHR_VERIFY_CMD`. An empty resolved command means the directory opted out → a trivial pass. It's
spawned through the **shared gate runner** (`src/gate.ts` `runGate`) that the
post-merge verify gate also uses, so the two gates can't drift on how they
spawn/bound a run: the run is **bounded by `BUTCHR_VERIFY_TIMEOUT_MS`** (the same
kill-timer verify has — a timeout counts as a FAIL). It writes a badge: `ci_status`
(`running` → `pass`/`fail`) + `ci_summary` (first line a compact label like
`gate passed` / `gate failed` / `gate timed out`, then an output tail). A **FAIL is
retried** up to `BUTCHR_CI_RETRIES` times (default 1); a
pass on any retry wins. The runner is overridable in tests (`setCiRunner`); tasks
with no worktree skip CI (leaving `ci_status` null). The CI gate is **advisory** — it does
not hard-block approval — but it gates **auto-merge** and on a `pass` fires the
auto-merge hook.

### Spec-conformance gate (pre-merge, advisory)

CI proves a task **builds and its tests pass** — it does **not** prove the task did
**what was asked**. (We hit exactly this: a task reached review CI-green but was
half-implemented; only a manual diff-read caught it.) The **spec-conformance gate**
closes that hole with a second, orthogonal signal. On the same genuine
`in_progress → in_review` transition, `triggerConformance` (`src/conformance.ts`) runs a
**read-only reviewer** that judges whether the task's **diff actually satisfies its
prompt** (complete + on-spec), fire-and-forget — review never blocks on it.

The reviewer reuses the **same headless, read-only, non-recursing claude** mechanism
as the CTO `ask` (`BUTCHR_CONFORMANCE_CMD`, defaulting to `claude -p
--permission-mode dontAsk --allowedTools "Read Grep Glob"`), run via `bash -lc` in
the task's **worktree** so it can `Read`/`Grep`/`Glob` beyond the diff but mutate
nothing. It is fed a rendered prompt (the task prompt + the **capped** git diff —
`BUTCHR_CONFORMANCE_MAX_DIFF_BYTES`, default 60 KB — + the agent summary) via a temp
file and asked for a one-line JSON verdict `{"conforms": "yes"|"partial"|"no",
"reason": …}`. The verdict is parsed and persisted as a badge:
`conformance_status` (`checking` → `pass` when *yes*, `concern` when *partial*/*no*)
+ `conformance_summary` (the reviewer's reason naming any missing / incomplete /
off-spec parts).

It is **bounded**: a single pass (no retries), the diff capped before it's sent, and
**best-effort** — a disabled gate (empty `BUTCHR_CONFORMANCE_CMD`), a missing
worktree, a spawn/timeout failure (`BUTCHR_CONFORMANCE_TIMEOUT_MS`, default 120 s),
or an unparseable verdict all leave `conformance_status` **null**. The runner is
overridable in tests (`setConformanceRunner`). Like the CI gate it is **advisory** —
a `concern` **never hard-blocks** approval; the webapp warns on approve (mirroring
the CI-fail warning) but lets the operator proceed. A result is only written back
while the task is still in `in_review` (a task that moved on under the in-flight
review isn't resurrected).

### Approve → finalizing → global merge queue → post-merge verify

Approving an `in_review` task is the `approve` arm of the unified feedback mechanism: it
forwards the task to **`finalizing`** (it does **not** merge synchronously). The
dispatcher then launches the **workspace agent** one more time (a `--resume` with
`renderFinalizePrompt`) to do **post-approval 'final thoughts'** — a brief wrap-up pass.
When that agent calls `request_review` (or ends / can't launch / is recovered on
restart), **`finalizeMerge`** lands the merge. So the merge is **best-effort wrapped** by
the final-thoughts pass but always converges (a finalize give-up lands the merge
directly; a finalizing task with no live agent is finalized by `recoverFinalizingTasks`
on boot).

`finalizeMerge` (only valid on `finalizing`) runs inside a process-wide **global merge
queue** (`runExclusiveMerge` —
a never-rejecting promise chain) so concurrent approvals rebase + fast-forward one at a
time against an up-to-date base tip instead of racing. Inside the exclusive section:

1. Capture the default-branch tip (`priorTip`) for a possible revert.
2. `git.merge` — auto-commit any dangling worktree changes (after a **conflict-marker
   scan** that refuses to merge poisoned content), **rebase** the task branch onto
   the current base tip, **record the living docs** (see below), then **fast-forward**
   the base to it (linear history, no merge commit). Records `baseSha..mergedSha`.
3. If the ff stuck, run the **post-merge verify gate** (`verifyDefaultBranch` → the
   directory's gate command — its `gate_cmd` or the default `BUTCHR_VERIFY_CMD`,
   resolved via `directoryGateCmd` so it matches the CI gate — in the repo **root**).
   Because this runs from the repo **root**, the default's `bun test ./test` arg is
   load-bearing: a bare `bun test` here would discover + run the test files inside
   **every sibling task worktree** (`<dir>/<otherTask>/test/*.test.ts`), so an
   in-flight worktree's failing/interfering test could RED this gate and auto-revert
   an unrelated, already-green merge. Scoping to `./test` makes the gate run only the
   repo's own suite with a stable count regardless of how many sibling worktrees exist.
   On **RED**, `git.resetHard` the default
   branch back to `priorTip` — undoing the merge so a broken commit never sits on
   main. (Because merges are serialized, nothing landed after the ff, so the reset is
   clean.)

Outcomes (`ApproveOutcome`):

- **merged** — verify green → status `merged`, worktree + branch cleaned up, snapshot
  captured, `merge_base_sha`/`merged_sha`/`merged_at` recorded, blocked dependents
  re-evaluated.
- **`revertedOnRed`** — verify RED, merge auto-reverted → terminal status `aborted`
  with `revert_reason` = the failing output. The worktree + branch are **kept** for
  inspection / a fixup re-run. (HTTP 200 with a flag.)
- **`conflictSentBack`** — `git.merge` reported a content conflict (the rebase was
  aborted, tree left clean). Instead of dumping it on the human, butchr appends an
  actionable conflict note and **kicks it back to the agent** via `requestChanges`
  (→ `in_progress`, re-dispatched as a `--resume` so the agent integrates the base and
  re-submits). (HTTP 200 with a flag.) Because the merge gate **rebases** the branch
  onto the default tip (no merge commit), the note instructs the agent to integrate
  by **`git rebase <base>`** (resolve + `--continue`) or **`git reset --soft <base>`**
  then re-commit — explicitly **NOT** `git merge <base>`, whose merge commit the
  rebase would discard, replaying the original commit and re-conflicting in a loop.
  An empty `BUTCHR_VERIFY_CMD` disables the
  verify gate (every clean merge is accepted). A non-conflict merge failure sets the
  `conflict` flag + a note and surfaces 409.

### Merge-time living docs (CHANGELOG + version owned by butchr)

butchr records the **CHANGELOG `[Unreleased]` entry** and the **package.json version
bump** itself, at merge — agents **do not** edit either file. This removes a
concurrency hot spot: when every task hand-edited `CHANGELOG.md` (Unreleased) and
bumped `package.json`, every task touched the same two files and they **all** collided
at merge, each needing an auto-resolve pass. The bookkeeping now happens once, in the
right place: `git.merge` calls `finalizeLivingDocs` **after the clean rebase and before
the fast-forward**, inside the global merge lock, so the edits land on the *up-to-date*
base content (never conflicting) and two merges can't race the same lines. The pure
text transforms live in **`src/changelog.ts`** (unit-tested independently):

- **CHANGELOG.** `insertUnreleasedEntry` appends a bullet derived from the task
  **summary** (the optional `request_review` summary; a generic *"Changes from task
  &lt;id&gt;"* if absent) plus the task id, filed under `### Changed` in `[Unreleased]`
  (creating that group if missing). The id is stamped as a `(task <id>)` marker that
  is the **idempotency key**: a re-merge whose marker is already present is a no-op
  (and short-circuits the version bump too, so nothing is recorded twice).
- **Version.** `bumpPatchVersion` **patch**-bumps `package.json` (the simple per-task
  default; release-time minor/major cuts stay manual — see CONTRIBUTING §6), **skipped
  for a docs-only diff** (`isDocsOnlyDiff` over the task's `base...taskId` file list —
  `*.md`/`*.mdx`/`*.txt` or anything under `docs/`).

Both edits are committed onto the task branch as a single `butchr: changelog + version
bump (task <id>)` commit, so they fast-forward onto the base with the rest of the work
and fall inside the recorded `baseSha..mergedSha` merge range. Everything is best-effort: a
repo with no `CHANGELOG.md` / `package.json`, or an unparseable one, simply skips that
piece — never failing the merge. **SPEC.md is unchanged by this flow** — it is not
append-only, is edited surgically, and rarely collides, so it stays a manual living-doc
edit (CONTRIBUTING §6a).

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

### Rollback (as a task)

Rolling back a merged change is a **deliberate, considered** act that often must
undo the change AND repair its fallout — dependents, tests, docs, revert conflicts —
so butchr models it as an ordinary **task**, not a mechanical revert that bypasses
the gates. (Emergency *bad* merges are already handled instantly by the post-merge
verify auto-revert — see above; this is the deliberate path.)

The webapp's **"Roll back"** button on a `merged` task creates a task from the
built-in **`rollback` template** (`src/templates.ts`) via the normal create-task
flow, pre-filling its `{{task}}`/`{{sha}}` slots with the target task id and its
recorded merge/finalize commit (`merged_sha`). The button shows only when that
commit was recorded (`merge_base_sha..merged_sha`, with commits) — older merges have
nothing to pre-fill. The rendered prompt instructs the agent to *prefer a clean `git
revert`, then fix any resulting breakage so `bun build` + `bun test` pass, and update
SPEC.md if behavior changed*. From there it flows through the **same pipeline as any
task** — dispatch → auto-rebase → CI gate → review → merge → post-merge verify — so
the revert is itself **VERIFIED** before it lands. There is no `POST …/rollback`
route and no `rolled_back_at` flag; a rollback is just another task with its own
review and merge.

### Request changes (reject)

`rejectTask` (the `request_changes` arm of the unified feedback mechanism; note
required) appends the note to `task.md`'s Review Notes. On an **`in_review`** task,
`requestChanges` resumes the agent (`→ in_progress`, retry state cleared) and the
dispatcher re-launches the **same** Claude session via `--resume <session_id>` with the
focused rework prompt, so the agent re-enters with full prior context. On a
**`spec_review`** task it instead sends the task back to **`idea`** so the CEO agent
**re-generates the spec** addressing the notes (→ `spec_review` again). Any lingering
pane/tab is torn down defensively.

### Answer (the needs-info handshake)

`answerTask` (only on `needs_info`, answer required) is the **mirror of request-changes**
for a clarifying question an agent posed via the MCP `ask` tool. It logs the Q&A to
`task.md`'s Clarifications section, stores the answer in the `answer` column, clears
the pending `question`, and resumes the task (`→ in_progress`, retry state cleared,
`session_id` kept). The dispatcher re-launches the **same** Claude session via
`--resume <session_id>`; because the row carries a pending `answer`,
`dispatch` renders the **answer-resume** prompt (`renderAnswerPrompt`) instead of the
rework prompt, and `markRunning` consumes (clears) the `answer` once the agent is
(re-)running. Reachable from one **unified surface**:
`POST /api/tasks/:id/answer`, `butchr answer <id> -m …`, and the webapp answer box.

### Abort

`abortTask` (any non-terminal state; 409 if already merged/aborted): signals the
watcher to bail, tears down the herdr tab, discards the worktree + branch, and parks
the task in terminal `aborted` (clearing all live fields). `task.md` is kept.

---

## 5. Self-healing & ops

### Startup reconcile (`reconcileRunningTasks`, run once in `index.ts`)

For every task that was **running** when butchr stopped — an agent-phase task
(`in_progress` or `finalizing`) with a recorded **`herdr_pane_id`** — whose in-memory
watcher was lost:

- **herdr up + agent still alive** → **re-adopt**: record its (possibly renumbered)
  pane + tab and re-spawn a watcher. The agent keeps working; completion/idle
  detection resumes.
- **herdr up + agent gone** → **rescue, phase-aware**: a dead `in_progress` agent →
  `in_review` with an "agent ended while butchr was offline" snapshot; a dead
  `finalizing` agent → `finalizeMerge` (land the approved merge).
- **herdr down** → leave the tasks as-is (can't distinguish live from dead without
  risking orphaning/false-rescue); reconcile on a later restart with herdr up. (There
  is deliberately **no** blind re-queue, which would collide on `agent_name_taken`.)
- **`recoverFinalizingTasks`** (run after reconcile) lands any `finalizing` task with
  **no live agent** (pane NULL) via `finalizeMerge`, so approved-but-unlanded work
  isn't stranded across a restart.

### The reaper (`reapOrphans`, conservative, once on boot)

Self-heals artifacts leaked by tasks that reached a **terminal** idle state
(`merged`/`aborted`) or that no longer have a DB row:

- **Worktrees + branches** — for each registered repo, scans
  `git worktree list --porcelain` and reaps any **direct child** worktree
  `<repo>/<taskId>` whose task is terminal or missing (`worktree remove --force` +
  `branch -D`, `prune` on failure). It **never** touches the main worktree or a
  worktree whose task is still non-terminal (idea/spec_review/blocked/needs_info/
  in_progress/in_review/finalizing).
- **herdr husks** — a terminal-state task whose agent name is still registered gets
  `agentDeregister`'d. **Skipped when herdr is down** (worktree reaping still runs).

The last reap result (`{worktrees, husks, at}`) is exposed on `/health`.

### DB snapshots + restore (`src/backup.ts`)

The SQLite db is the **source of truth** for all task state + history, so butchr
keeps **SQLite-safe snapshots** of it for crash/power-loss recovery.

- **How** — snapshots use `VACUUM INTO` (SQLite's online-backup primitive), **not**
  a raw file copy. With the db in WAL mode a mid-write `cp` would capture a torn
  page set (committed state split across `butchr.db` and its `-wal` sidecar);
  `VACUUM INTO` writes a clean, consistent, defragmented **standalone** db file
  (no sidecars) safe to take while the db is live.
- **When** — a periodic loop (`startBackupLoop`, wired in `index.ts`) takes one
  every `BUTCHR_BACKUP_INTERVAL_MS` (default 15 min; first fires after one
  interval, not at boot), plus **one final snapshot on clean shutdown**
  (`snapshotOnShutdown`, awaited in the SIGINT/SIGTERM handler).
- **Where / retention** — files land in `BUTCHR_BACKUP_DIR`
  (default `<data>/backups/`) named `butchr-<timestamp>.db`. After each snapshot
  the **newest `BUTCHR_BACKUP_KEEP`** (default 24) are kept and older ones pruned
  (a `keep` ≤ 0 keeps **all** — never deletes everything). The whole feature is
  disabled with `BUTCHR_BACKUP_ENABLED=0`.
- **Restore** — **offline** (a running server holds the db open). Stop butchr, then
  `butchr restore <file|latest>` (or `bun bin/butchr restore …`): it copies the
  chosen snapshot over `BUTCHR_DB`, first saving the current db aside to
  `<db>.pre-restore-<ts>` and removing stale `-wal`/`-shm` sidecars, then you start
  butchr again. `butchr backups` lists snapshots. These two CLI commands are the
  one exception to "the CLI is a thin REST client" — restore can't go through the
  server — so they operate on the filesystem directly via `src/backup.ts` (which is
  import-side-effect-free w.r.t. opening the db; it loads `db.ts` lazily only when
  taking a snapshot). `lastSnapshotAt` + a retained-snapshot count are on `/health`.
  See [OPERATIONS.md](./OPERATIONS.md#db-snapshots--restore) for the runbook.

### Health endpoint

`GET /health` (alias `GET /api/health`) returns **200** when healthy, **503** when
degraded. `healthy = db.ok && tick.alive`. Fields: `status`, `version`, `uptimeSec`,
`db.ok` (trivial `SELECT 1`), `paused` (**dispatcher pause** — true while new agent
dispatch is halted for maintenance; running/review/idle tasks are unaffected), `tick`
(`alive`/`count`/`lastTickAt`/`ageMs`/
`staleAfterMs` — stale if it has ticked but not within `max(tickMs·5, 10s)`; a
never-ticked loop is treated as *still starting*, not stalled), `tasks` (counts by
status), `failedTasks`, `concurrency` (`active` = running+review+awaiting_input+finalizing,
`queued`), `needsAttention` (`review`+`awaiting_input`+`failed`), `reaper` (last boot reap),
`backup` (DB-snapshot resilience: `enabled`, `lastSnapshotAt` — null until the
first snapshot of this run — `count` of retained snapshots, `keep`, `intervalMs`,
`dir`), `disk` (**disk-usage accounting**, see below), and `herdr.reachable`
(**best-effort — does NOT affect the 200/503 verdict**; herdr down ⇒ tasks stall at
`queued` but butchr stays "healthy").

**`disk`** (`src/disk.ts`) sizes butchr's two unbounded-growth footprints — the
per-task git **worktrees** under each registered repo (one checkout per live task, at
`<repo>/<taskId>`) and the **DB backup directory** — so an operator can see them
before they fill the disk. Fields: `worktreesBytes`, `worktreeCount`, `backupsBytes`
(0 if the backup dir doesn't exist yet), `totalBytes` (= worktrees + backups),
`warnBytes` (the `BUTCHR_DISK_WARN_BYTES` threshold; 0 = disabled), `warn` (true when
`warnBytes > 0 && totalBytes > warnBytes` — **purely advisory**, never blocks
dispatch/merge/backups), and `truncated` (true if a directory tree hit the scan cap,
making the totals a floor). The sizing is a **bounded, best-effort** `lstat` walk
(symlinks counted as the link, never followed; per-entry errors skipped; capped entry
count) **memoized for ~30 s** so the frequent `/health` polls don't re-walk every
checkout each time. The whole `disk` object is `null` if the computation fails — it never affects
the 200/503 verdict. Worktree paths come from `git worktree list` (`git.listWorktrees`,
which drops the main checkout). The webapp's **Metrics** page renders a "Disk usage"
readout from this object, with an "over threshold" badge when `warn` is set.

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

### Self-test (smoke harness)

`butchr selftest` (→ `src/selftest.ts:runSelftest`) drives a **throwaway probe
task** through butchr's FULL lifecycle against the **running** server and reports
**pass/fail per stage** — so after a restart / recovery / deploy one command
confirms the whole pipeline (dispatch → herdr → the agent run → the CI gate →
review → optional merge) actually works end-to-end, rather than discovering
breakage on the next real task.

It is almost entirely a **REST client** (no server logic; like the rest of
`bin/butchr`) that composes existing routes — the one exception is the `--merge`
cleanup, which reverts the probe's own merge directly in the sandbox (there is no
server route to undo a merge; deliberate rollback is a normal task). The steps:

1. **Resolve** the sandbox: auto-find the registered directory labelled `sandbox`
   (or whose path basename is `sandbox`), or take `--dir <id|path>`.
2. **Create** a trivial probe task there (`POST …/tasks`, tagged `selftest`) whose
   prompt asks for the smallest self-contained change — a pure `selftestPing()`
   function returning `"pong"` plus a passing `bun:test` — with the `marker` woven
   into uniquely-named files so repeated/concurrent runs never collide.
3. **Poll** `GET …/tasks/:id` until it **dispatches** (→ `running`) and reaches
   **`review`**, recording each stage + its timing; a non-transient status before
   review (`failed`/`aborted`/`merged`) or crossing the **`--timeout`** (default
   10 min) fails the run.
4. With **`--merge`**: approve it, confirm it merges (a conflict-sent-back or a
   post-merge-verify revert is a failure), exercising the approve → merge-queue →
   post-merge-verify path.
5. **Clean up on EVERY exit path** (pass, failure, or timeout) so the sandbox stays
   clean: a not-yet-merged probe is **aborted** (worktree + branch discarded); a
   merged probe's commits are **reverted directly in the sandbox** (a local `git
   revert` of its recorded `merge_base_sha..merged_sha` range, injected so tests stub
   it). A cleanup failure is itself flagged.

Exit 0 on PASS, 1 on FAIL; `--json` prints the structured `{ ok, taskId, dir,
stages, error }` result. All time/IO is injected, so the orchestration is
unit-tested with the API mocked (`test/selftest.test.ts`) — no real claude/herdr
and no wall-clock waits.

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
| `GET` | `/api/dashboard` | — | cross-project rollup: `{ directories:[{ id, path, label, gate_cmd, effective_gate_cmd, counts, active, review, failed, needsAttention }], totals:{ directories, active, review, failed, needsAttention } }`. Per directory: `active` = queued+blocked+running+idle+finalizing; `review`; `failed`; `needsAttention` = review+failed (the operator pull-signal). `effective_gate_cmd` is the directory's own `gate_cmd` or the default. Read-only. |
| `GET` | `/api/directories` | — | `DirectoryView[]` (rows + `counts` by status, with `idle` peeled out of `running`). |
| `GET` | `/api/templates` | — | `TemplateView[]` — the built-in task **templates** (recipes): each `{ name, description, body, placeholders }`, where `body` carries `{{placeholder}}` markers and `placeholders` lists their distinct names (first-seen order). Static built-ins from `src/templates.ts` (`feature`, `refactor-extract`, `webapp-panel`, `add-endpoint`, `rollback`). |
| `POST` | `/api/expand-brief` | `{ brief, directory }` | `{ prompt }` — **BRIEF → EXPAND**: turns the operator's one-line `brief` into a proper, concrete, scoped task prompt **grounded in the target repo** by running a headless, READ-ONLY claude (`Read`/`Grep`/`Glob` over the repo — `config.expandBriefCmd`, reusing the spec-conformance reviewer's recipe; see `src/expand.ts`). `directory` is the registered directory's id (or its absolute path); the expander runs with that repo as cwd. The webapp drops `prompt` into the new-task prompt textarea for the operator to review/edit before Create. 400 on a blank brief; 404 on an unknown directory; 502 if expansion failed (spawn/timeout/empty — the operator keeps the brief and can retry or write the prompt by hand). Set `BUTCHR_EXPAND_BRIEF_CMD` empty to disable (→ 502). |
| `POST` | `/api/directories` | `{ path, label?, gate_cmd? }` | `201` `DirectoryView`. `gate_cmd` sets the per-directory build/test gate command (omit/null → default; `""` → disable). 400 if not a git repo or `gate_cmd` isn't a string; 409 if already registered; 502 if the herdr workspace can't be created. |
| `PATCH` | `/api/directories/:id` | `{ gate_cmd?, cto_enabled? }` | `DirectoryView` — update per-directory settings (handled by KEY PRESENCE so one never clobbers the other). `gate_cmd`: a string sets it, `""` disables; null/omitted **clears** the override → falls back to the default. `cto_enabled`: `true`/`false` forces the directory's CTO agent on/off, `null` clears → inherit the global default (§6.8). 404 if gone; 400 if `gate_cmd` isn't a string or `cto_enabled` isn't a boolean/null. Publishes a `directory.updated` SSE event. |
| `DELETE` | `/api/directories/:id` | — | `{ ok: true }`. Tears down each task's tab, cleans non-merged worktrees, closes the workspace, removes seeded `CTO.md`, cascade-deletes tasks. |
| `GET` | `/api/directories/:id/tasks` | `?q=` (optional) | `TaskListView[]` (newest first) — the same parsed `taskView` shape as the detail route, minus the `task.md`-derived `prompt`/`context`/`review_notes` and the `estimate` (the list views don't need them): each task is the DB row with `blocked_by`/`spawned_subtasks`/`tags` as arrays plus precomputed `blockerStates`/`deadBlockers`. `?q=` is a case-insensitive FULL-TEXT SEARCH (server-side, so huge prompts never ship to the client): only tasks whose prompt (from `task.md`), `summary`, review notes (`review_note` + the `task.md` Review Notes), or id contain `q` are returned. A blank/absent `q` returns the full list and reads no `task.md`; a non-blank `q` reads each task's `task.md` to scan its prompt. 404 if directory gone. |
| `POST` | `/api/directories/:id/tasks` | `{ prompt, context?, blocked_by?, kind?, model?, tags?, priority?, plan_preview?, idea?, template?, vars? }` | `201` `TaskView`. `kind:"plan"` → plan task. `plan_preview:true` → the agent proposes a plan and pauses for operator approval before writing code (§2.6). `idea:true` → create in the `idea` **front state** (the `prompt` is a one-line brief; the CTO-fork drafts the spec, then it advances to 'ready' — §2.7); a legacy `stage:"idea"` body is honored as `idea:true`. `tags` is an array of free-form organizational labels (trimmed/de-duped, ≤40 chars each). `priority` is an integer (higher = dispatched sooner; default 0). `template` creates **from a built-in template** (`src/templates.ts`): its body is rendered with `vars` substituted into the `{{placeholders}}` (un-supplied markers left visible) and the result becomes the prompt (any explicit `prompt` is then ignored). Validates blockers exist (404), cycle (400), model (400), tags shape (400), priority integer (400), plan_preview boolean (400), idea boolean (400), template name (404), `vars` shape (400), prompt required (400). |
| `GET` | `/api/tasks/:id` | — | `TaskView` (DB row + `task.md` prompt/context/review_notes + `blocked_by`/`blockerStates`/`deadBlockers`/`spawned_subtasks`/`tags` + `estimate`, the rough p50–p90 duration estimate — see §10). 404 if gone. |
| `GET` | `/api/tasks/:id/diff` | — | `{ diff }` — committed `base...id` plus uncommitted worktree changes. |
| `GET` | `/api/tasks/:id/estimate` | — | `{ single, chain }` — the rough duration estimate (§10): `single` is the task's own p50–p90 range (same object as `TaskView.estimate`), `chain` the critical-path total across its dependency chain (a plan's sub-tasks, or this task's blockers) or `null` when there's nothing to chain. 404 if gone. |
| `GET` | `/api/tasks/:id/events` | — | `TaskEventRow[]` — the status-transition audit timeline, oldest→newest. 404 if gone. |
| `GET` | `/api/tasks/:id/output` | — | `{ output }` — best-effort live agent terminal text (`herdr agent read`); `""` once the pane is gone. |
| `GET` | `/api/tasks/:id/transcript` | `?offset=&limit=` | `{ turns, total, offset, limit, hasMore }` — the agent's session transcript parsed into ordered, role-labelled items (prose / thinking / tool-call name+brief-args / truncated tool-result); best-effort `turns:[]` when there's no session/transcript. `limit` clamped 1..500 (default 200). 404 if the task is gone. |
| `GET` | `/api/tasks/:id/activity` | — | `{ lastAction, lastAt, elapsedMs }` — the **live activity pulse**: the latest meaningful transcript step (last tool call as `"<tool> <target>"`, else the last assistant prose / thinking) plus `elapsedMs` since the task started running. CHEAP — reads only the **tail** of the session JSONL (not the whole file), so the webapp safe-polls it on running cards. `lastAction`/`lastAt` are `null` with no transcript / no qualifying step; `elapsedMs` `null` until the task has started. Read-only. 404 if the task is gone. |
| `POST` | `/api/tasks/:id/approve` | `{}` | the merged `TaskView`, **or** `{ task, conflictSentBack:true }`, **or** `{ task, revertedOnRed:true }`. 409 if not in review / on a hard merge failure. |
| `POST` | `/api/tasks/:id/reject` | `{ note }` | `TaskView` (`→ queued` for resume). 409 if not in review; 400 if note blank. |
| `POST` | `/api/tasks/:id/answer` | `{ answer }` | `TaskView` (`→ queued` for `--resume` with the answer injected). 409 if not `awaiting_input`; 400 if answer blank. |
| `POST` | `/api/tasks/:id/abort` | — | `TaskView` (`→ aborted`). 409 if already merged/aborted. |
| `PUT` / `POST` | `/api/tasks/:id/blocked_by` | `{ blocked_by:[id,…] }` | `TaskView` — replaces + re-evaluates the dep set (auto-unblock / kill-on-block). 409 on terminal tasks; 404 unknown blocker; 400 cycle. |
| `POST` | `/api/tasks/:id/priority` | `{ priority }` | `TaskView` — sets the task's dispatch priority (integer; higher = dispatched sooner; default 0). 404 if gone; 400 if not an integer. Accepted on any status but only affects `queued` dispatch order. |
| `POST` | `/api/tasks/:id/requeue` | `{}` | `TaskView` (`→ queued`, retry state cleared). 409 if merged/aborted. |
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
id), `directory.created` / `directory.updated` (the refreshed `DirectoryView`, e.g.
after a gate-command change) / `directory.deleted`, `dispatch.paused`
(`{ paused }` — dispatcher pause toggled, so the webapp can reflect the PAUSED
banner live), and `cto.updated` (`{ cto }` — a directory's managed CTO agent
lifecycle changed; the payload carries that directory's refreshed `CtoStatus`, §6.8).
The server runs with `idleTimeout: 0` so streams aren't dropped.

### 6.3 MCP (per-task tools)

Hand-rolled Streamable-HTTP MCP (`src/mcp.ts`), stateless (identity = the
`/mcp/<taskId>` path, no `Mcp-Session-Id`). Handles `initialize`,
`notifications/initialized` (202), `ping`, `tools/list`, `tools/call`. Each tool
carries an optional **`gate`** predicate; `tools/list` offers a tool only when its
gate is absent or returns true for the task's row (so the set offered depends on
`kind` *and* `plan_preview`):

- **`request_review({ summary? })`** — *non-plan tasks* (`kind !== 'plan'`).
  Non-blocking: records the review request (`markReviewFromAgent`), returns
  immediately; the agent should exit. A terminal task (merged/aborted) reports its
  status instead.
- **`propose_subtasks({ subtasks:[{prompt,context?,blocked_by?}], summary? })`** —
  *plan tasks only* (`kind === 'plan'`). Validates + creates the decomposition and
  completes the plan task (see §2.5). A bad/cyclic graph or blank prompt comes back as
  an `isError` tool result so the agent can re-propose (it never crashes the server).
- **`propose_plan({ plan })`** — *plan-preview tasks only* (`plan_preview` set,
  `kind !== 'plan'`; see §2.6). Non-blocking: records the agent's implementation plan
  and parks the task in `awaiting_input` for operator approval by **reusing the ASK
  handshake** (`markAwaitingInputFromAgent` — the plan is stored like a question), then
  returns; the agent should exit. A blank plan is an `isError` result; a terminal task
  reports its status. On the operator's answer the SAME session resumes (`--resume`)
  and the agent implements + `request_review`.
- **`ask({ question })`** — *both kinds.* **Non-blocking**, the unified
  AWAITING-INPUT handshake (mirrors `request_review`): records the agent's question
  and parks the task in `awaiting_input` (`markAwaitingInputFromAgent`), then returns
  immediately; the agent should exit. There is **no auto-answering CTO Claude** — that
  forked read-only mechanism was retired. butchr surfaces the question through one
  surface (`/health` `needsAttention`, the webapp answer box, `POST …/answer`,
  `butchr answer`); on an answer it re-launches the SAME session via `--resume` with
  the answer injected (see §4 "Answer"). A terminal task (merged/aborted) reports its
  status instead. Agents are told (in the rendered prompt) to prefer asking over
  guessing.

### 6.4 Operator CLI (`bin/butchr`)

A dependency-free REST client (`fetch` only) targeting `http://127.0.0.1:47800`
(override `BUTCHR_URL`). Each subcommand maps onto exactly one REST route; it adds
no server logic. Exit non-zero on any API/usage/connection error; `--json` prints
the raw payload. The **two exceptions** are the offline `backups` / `restore`
commands, which operate on the filesystem via `src/backup.ts` rather than the
server (a DB restore can't go through a live server — see §5).

| Command | Maps to |
|---------|---------|
| `health` | `GET /health` (exit 1 if degraded) |
| `dashboard` | `GET /api/dashboard` — per-directory active / review / needs-attention / failed table + totals |
| `gate <dir> [--set "<cmd>"] [--clear]` | `PATCH /api/directories/:id` (set/clear the gate command) or `GET /api/dashboard` (no flag → show the effective command); accepts an id or path |
| `ls [--dir <id>] [--status <s>] [--tag a,b] [--search <text>]` | `GET /api/directories(/:id/tasks)` — compact id/status/CI/tags table; `idle` shows `status*`; `--dir` accepts an id or path; `--status` filters client-side; `--tag` keeps tasks carrying ANY of the given labels; `--search` is a server-side full-text filter (`?q=`) over each task's prompt/summary/review notes/id |
| `new <dir> -m <prompt> [--blocked-by id,id] [--tag a,b] [--priority N] [--plan]` | `POST /api/directories/:id/tasks` (`--tag` attaches organizational labels; `--priority` sets the dispatch priority, higher = sooner; `--plan` sets `plan_preview` — the agent proposes a plan and pauses for approval before writing code, §2.6) |
| `new <dir> --template <name> [--var k=v …] [--blocked-by …] [--tag …] [--priority N]` | `POST /api/directories/:id/tasks` with `{ template, vars }` instead of `-m` — create from a built-in template, filling its `{{placeholders}}` with repeatable `--var key=value` pairs (server-rendered; un-supplied markers stay visible) |
| `templates` | `GET /api/templates` — list the built-in templates as a `name`/`placeholders`/`description` table |
| `show <id>` | `GET /api/tasks/:id` — status, CI, tags, summary, review notes, the pending `awaiting_input` question, blockers, dispatch/revert errors |
| `approve <id>` | `POST …/approve` (reports merged / conflict-sent-back / reverted-on-red) |
| `reject <id> -m <note>` | `POST …/reject` |
| `answer <id> -m <text>` | `POST …/answer` (answers an `awaiting_input` task; resumes the agent) |
| `requeue <id>` | `POST …/requeue` |
| `block <id> --on id,id` | `PUT …/blocked_by` (`--on ''` clears) |
| `priority <id> <N>` | `POST …/priority` (set the dispatch priority; higher = sooner) |
| `selftest [--dir <id\|path>] [--merge] [--timeout <sec>]` | composes existing routes (`GET /api/directories`, `POST …/tasks`, `GET …/tasks/:id`, `POST …/approve`, `…/abort`) into an end-to-end **smoke test**; with `--merge` it reverts its own throwaway merge in the sandbox during cleanup — see [§5 Self-test](#self-test-smoke-harness) |
| `backups` | **offline** — lists DB snapshots in `BUTCHR_BACKUP_DIR` (newest first) via `src/backup.ts`; no server call |
| `restore <file\|latest> [--force]` | **offline** — restores `BUTCHR_DB` from a snapshot (saves the current db aside first). Refuses if a server answers on `BUTCHR_URL` unless `--force`; stop butchr first (§5) |

### 6.5 Webapp (`public/`)

A vanilla-JS SPA (`app.js`, no framework/build) over `index.html` + `style.css`,
hash-routed and SSE-driven. Views/features:

- **Directories dashboard** — the cross-project home (`/api/dashboard`): a
  totals summary (active / in-review / needs-attention / failed across **all**
  directories) over a card grid, each card showing that directory's four aggregate
  buckets plus its full status pills and linking into its task list. A filesystem
  **picker** (`/api/fs`) registers a repo, and the register form takes an optional
  per-directory **build/test gate command**.
- **Directory view** — a **build/test gate** panel (the effective gate command, an
  override/default flag, and an inline editor that `PATCH`es `gate_cmd` — save to
  set, "Use default" to clear), and its tasks with three layouts (list/table, **board** by
  lane, and a dependency **graph** via `graphLevels`), a filter bar (a **full-text
  search** box that drives the server-side `?q=` filter over prompt/summary/review
  notes/id — re-fetching the list as you type — plus client-side status chips and a
  second row of **tag chips**, ANY-match), a queue line, a
  collapsible **"Finished"** history section that holds **only the terminal idle
  states** (`merged`/`aborted`) — every non-terminal task, including the feedback
  states awaiting the operator (`spec_review`/`in_review`/`needs_info`), stays in the
  always-visible active list and is never collapsed under Finished — and a
  **new-task modal** redesigned for **low-effort
  creation**: the default surface is just a one-line **idea** box with an **Expand**
  button (or an optional **template** picker — `GET /api/templates` — that fills the
  prompt textarea with a recipe's body and hints which `{{placeholders}}` to complete)
  → the **prompt** textarea → Create. **Expand** (`POST /api/expand-brief`) runs the
  headless read-only claude over the repo to turn the idea into a proper, grounded task
  prompt, dropped into the prompt textarea for the operator to review/edit (a spinner
  runs while it works; on error the brief is kept with a message). The manual
  "write your own prompt" path stays. The less-common knobs — **blocked-by**,
  **model**, **tags**, **priority**, the **plan** / **plan-preview** toggles, and a
  **New Idea** toggle — are collapsed behind an **Advanced** disclosure (closed by
  default). **New Idea** submits the one-line idea box as-is with `idea: true` (no Expand
  or full prompt needed): the task enters the `idea` front state and butchr's **CTO-fork**
  drafts the spec automatically, then it becomes 'ready' (§2.7). The modal submits to the
  plain create endpoint. The chips show the **conceptual status labels** ('ready' for
  `queued`, 'in progress' for `running`, plus the `idea` front state). Tags render as neutral chips on the task
  rows, finished list, and board cards; a non-zero **priority** shows as a `prio N`
  chip across those same views. Graph nodes that gate dependents carry an
  inline **sub-tree merge-progress bar** (merged fraction of their transitive
  dependents). The graph always shows the **active/in-flight** tasks (the "tip");
  a **"Finished generations" range slider** (value persisted in `localStorage`,
  current value shown alongside) controls how much of the **finished dependency
  history** behind them renders — computed client-side as the generation depth back
  from the tip along `blocked_by` (gen 1 = finished tasks that directly block an
  active task, gen 2 = their finished blockers, …), defaulting to a small depth so
  deep merge trains stay readable. `0` shows the active frontier only; the maximum
  reveals the full available history. Running task cards/rows show a read-only **live activity pulse** — a
  pulsing dot, the agent's latest action (last tool call + target, clipped to one
  line), and elapsed-since-started — polled from `/api/tasks/:id/activity` on a small
  timer (the cheap transcript-tail read); the latest action is cached so the wholesale
  SSE re-render repaints it without flashing, and the elapsed readout ticks locally
  between polls. Read-only — no actions, no herdr attach.
- **Task detail** — status/CI/**conformance**/summary (the CI badge and an advisory
  **spec-conformance** badge — green *conforms* / amber *concern: <reason>* — sit
  above the diff in the review panel; a `concern` warns on approve but never blocks),
  a **tags** row and a **priority** row in the meta grid, the rendered **diff** (`/api/tasks/:id/diff`,
  parsed into per-file cards with **dependency-free syntax highlighting** — a small
  inline tokenizer colors TS/JS/JSON/CSS keywords/strings/comments/numbers — and a
  line-number gutter; in review, clicking a line's gutter attaches an **inline
  comment**, and on **Request change** all collected comments are composed with their
  `file:line` context into the single change-request note sent to `/reject`, so the
  resumed agent gets a per-line punch-list — the reject payload stays `{ note }`),
  the **timeline** (`/api/tasks/:id/events`), model/tokens/
  cost labels, a rough **duration estimate** (an *est. duration* row from
  `TaskView.estimate` plus a critical-path line on the blocked-by / spawned panels
  from `/api/tasks/:id/estimate` — see §10), live output, a collapsible **Agent
  transcript** panel (`/api/tasks/:id/transcript`, lazily fetched + paged:
  role-labelled prose, thinking, compact tool calls + truncated results, monospace +
  read-only), a **sub-task progress rollup** (for a task that gates dependents: an
  "N/M merged" fraction, a progress bar, and the direct children with their live
  statuses — computed client-side from the directory's task list, so no extra API
  field), approve/reject/abort/requeue controls plus a **"Roll back"** button on a
  merged task (which creates a rollback task from the `rollback` template — §4 — and
  jumps to it), an **answer box** for an `awaiting_input` task (shows the agent's
  question + posts the answer to `POST …/answer`, mirroring the review change-request
  box), and an **Open terminal** button (running tasks). The board adds an **Awaiting
  answer** lane.
- **Metrics view** — `/api/metrics`: status bars, throughput sparkline, medians,
  and the conflict/revert/CI-pass/auto-merge rates. Also a **Disk usage** readout
  (from `/health`'s `disk` object — see §5): cards for task-worktree bytes (+ count),
  DB-backup bytes, and the combined total, with an advisory "over threshold" badge
  when `disk.warn` is set.
- **Chrome** — light/dark theme toggle (persisted, applied pre-paint), a live
  connection LED, an **attention indicator** + tab-title badge driven by
  `needsAttention` (review + awaiting-input + failed), with optional desktop notifications, and a
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

### 6.7 CTO notification channel (one-way)

A long-running **CTO agent** (a persistent Claude Code session that operates butchr
via its API/CLI) otherwise has to **poll** to learn that a task wants its attention.
`src/channel.ts` is a tiny **one-way push channel** that closes that gap: it speaks
the Claude Code **Channels** contract (research preview) on top of MCP over **stdio**
and forwards butchr's existing attention feed into the running CTO session, so it
reacts immediately. It mirrors exactly the in-app feed a human sees in the dashboard
(`/health` `needsAttention` + the badge derived from the §2 feedback states).

**One-way only.** The channel can push to the CTO; the CTO cannot push back through
it. The `initialize` result advertises **only** `capabilities.experimental['claude/channel'] = {}`
and deliberately omits `tools` (and `resources`/`prompts`) — there is **no reply
tool, no `tools/call`, no permission relay**. The CTO acts on a notification through
the normal surfaces (`POST …/approve|reject|answer|requeue`, `butchr` CLI), not
through this channel.

**Per-directory scope.** Since butchr runs **one CTO agent per directory** (§6.8), each
bridge is launched with **`BUTCHR_CHANNEL_DIR` = the directory_id** and emits ONLY that
directory's transitions — a directory's CTO sees only its own attention events. Unset
(no scope) yields the legacy all-directories feed.

**What it pushes.** It subscribes to butchr's **existing** SSE stream
(`GET /api/events`, §6.2) — *not* a new bus — and for every task that **ENTERS** a
CTO attention state (within its scope) emits one channel notification. The attention states are the spec's
`spec_review` / `in_review` / `needs_info` / **`failed`**; since butchr folded the
former `failed` state into the canonical terminal **`aborted`** (see §2.1 / the
`["failed","aborted"]` migration in `db.ts`), `aborted` *is* "failed" here.
"Entering" is edge-triggered: the bridge remembers each task's last-seen status and
emits only when it **changed into** an attention state, so a `task.updated` that
merely touches a task already in that state does not re-notify, and a reconnect
(which replays no history) cannot re-fire a transition already seen this run.

**Notification shape.** Each is a JSON-RPC **notification** (no `id`) with
method **`notifications/claude/channel`** and params `{ content, meta }`:

- `content` — a concise, single-line, human-style string carrying the same info the
  dashboard surfaces: task id, directory label, the new state, and the relevant
  text (the generated spec for `spec_review`, the `request_review` summary for
  `in_review`, the agent's question for `needs_info`, the failure reason for a failed
  task). Whitespace-collapsed and length-bounded.
- `meta` — `{ task_id, dir, state }`, **identifier-keyed** (keys are bare
  `[A-Za-z_][A-Za-z0-9_]*`). `dir` is the stable **directory id** (machine routing);
  the human directory **label** appears in `content` (resolved from a small cache the
  bridge seeds once from `GET /api/directories` and keeps fresh off the
  `directory.*` events on the same stream, falling back to the id when unknown).

**Best-effort + resilient.** A malformed/irrelevant event, a missing task payload, or
a failed write is dropped silently — it never crashes the bridge or butchr. The SSE
subscription **auto-reconnects** (fixed backoff) whenever the stream ends or errors
(server restart, network blip). All diagnostics go to **stderr** — stdout is reserved
for the JSON-RPC protocol.

**Zero deps.** Like `src/mcp.ts` (which hand-rolls Streamable-HTTP MCP), this
hand-rolls the **stdio** MCP framing (newline-delimited JSON-RPC) and the SSE parser
itself; no `@modelcontextprotocol/sdk`, no npm dependency. The only butchr import is
`config` (for the default SSE URL).

**Feasibility.** butchr's agents run Claude Code ≥ v2.1.80 under Claude Max
(Anthropic auth — claude.ai/Console, **not** Bedrock/Vertex), which Channels require.
A custom channel is not on Anthropic's allowlist during the research preview, so the
CTO agent must be launched with **`--dangerously-load-development-channels`**.

**Launching the CTO agent with the channel.** Register the bridge as an MCP **stdio**
server and load it as a development channel. In the CTO session's `.mcp.json`:

```json
{
  "mcpServers": {
    "butchr-cto-channel": {
      "command": "bun",
      "args": ["run", "/path/to/butchr/src/channel.ts", "--role", "cto"]
    }
  }
}
```

then launch Claude Code so that server is loaded **as a channel** via the
`server:<name>` reference — `<name>` is the `.mcp.json` key (which also matches the
bridge's `serverInfo.name`, `butchr-cto-channel`):

```
claude --dangerously-load-development-channels server:butchr-cto-channel ...
```

The bridge derives the SSE URL from butchr's `config.host`/`config.port`
(`http://127.0.0.1:47800/api/events` by default); override with
**`BUTCHR_CHANNEL_SSE_URL`** if butchr runs elsewhere. Notifications then surface in
the running CTO session as `<butchr-cto-channel>` events to act on. (The companion
**workspace-agent** channel for feedback-*answered* events is a separate, later phase
— it needs a keep-alive lifecycle change — and is intentionally out of scope here.)

### 6.8 Managed CTO agents (one per directory)

The channel (§6.7) gives a CTO agent a PUSH feed, but something has to LAUNCH and keep
that agent alive. `src/cto-agent.ts` makes the CTO a **first-class, butchr-managed,
channel-connected agent — ONE PER REGISTERED DIRECTORY (repo)**. Each runs in that
repo's **root** (already trusted) and **IS that project's principal/dev agent**:
butchr launches and supervises it exactly like a workspace agent, but it has **no
worktree, branch, review, or merge** — it is an *operator*, not a *builder*. **There is
NO global/top-level CTO**; butchr manages one CTO agent per directory, keyed by
`directory_id`. Each acts on its directory's attention events through the butchr **API**
(`127.0.0.1:47800`) or **`bin/butchr`** (approve / reject / answer / requeue) and
**never edits the butchr codebase directly** — all code changes go through tasks.

**Default OFF (per directory).** A directory's CTO agent is enabled by its
**`directories.cto_enabled`** column: **NULL** inherits the global default
**`BUTCHR_CTO_AGENT`** (itself default OFF), `1` forces it on, `0` off — the
per-directory setting **wins**. With a directory not enabled, butchr never boot-starts,
reconciles, or supervises its CTO agent; the on-demand
`/api/directories/:id/cto/*` endpoints still work so an operator can start one anyway.

**Lifecycle (one per directory, butchr-managed).** At most **one** CTO agent is alive
per directory. It is launched through the **existing `AgentRunner`/harness seam**
(`src/harness.ts` — *not* bypassing it) into a **dedicated herdr tab in THAT DIRECTORY'S
workspace**, with **cwd = the directory's repo root** (`directory.path`), under the agent
name **`<config.ctoAgentName>-<directoryId>`** (default prefix `butchr-cto-agent`),
reusing the dispatcher's tab-create → agent-start → close-husk-pane → re-resolve-pane
sequence (so a positional pane-id renumber can't strand it). Its runtime handles
(session id, pane, tab, workspace) live in that directory's **`cto_agent`** row (§7).

**Launch.** The agent is started with the **channel attached and SCOPED to the
directory**: butchr writes a per-directory MCP config registering the bridge as a stdio
server named `butchr-cto-channel` (running `config.ctoChannelCmd` via `bash -lc`, with
`BUTCHR_CHANNEL_SSE_URL` pointed at this butchr **and `BUTCHR_CHANNEL_DIR` = the
directory_id**, so the bridge pushes **only that directory's** attention events) and
launches `claude` with that config plus
**`--dangerously-load-development-channels server:butchr-cto-channel`** (the
research-preview flag for the custom channel) and
**`--dangerously-skip-permissions`** (so it can call the butchr API/CLI unattended). It
runs under `script` for a PTY + log, just like task agents. It is primed by an
**editable brief** — `config.ctoBriefPath`, or a documented default written once to
`<dataDir>/cto-brief.md` — passed as the positional prompt.

**Launch self-complete (READY unattended).** Every (re)launch/reboot must come up ready
with no human present, but Claude Code can stop on a **blocking interactive startup
prompt** the first time a session touches a workspace — the dev-channels consent (`1. I
am using this for local development`), the **folder-trust** prompt, or any other yes/no
or numbered confirmation. After the pane registers, butchr polls it (`src/startup-confirm.ts`,
`config.ctoPromptPollMs` × `…MaxPolls`, stopping once prompt-free for `…QuietPolls`
reads) and, whenever it **detects** such a prompt, **sends the safe confirming response**
via the harness `send` capability. The detector is a **generic, extensible rule table**
(not two hardcoded strings) and the loop is **idempotent** — it only ever sends while a
prompt is actually on screen, so no stray keystroke leaks into the session once past it.
Best-effort: it never fails a launch.

**Supervision.** A single poll loop (`config.ctoSuperviseMs`) iterates every directory's
`cto_agent` row and keeps **one alive per directory**: when an enabled directory's agent
has died while still DESIRED-up it relaunches it with bounded **per-directory**
exponential backoff (`config.ctoRestartBackoffBaseMs`·2ⁿ capped at `…CapMs`), giving up
after `config.ctoMaxRestarts` consecutive failures until the operator intervenes. On
boot, butchr **reconciles** once over **all** directories: per directory it **adopts** an
already-live pane that survived a restart, else **(re)launches** if that directory is
enabled, honoring an explicit prior **stop** (a `cto_agent` row with `desired=0`).

**Session continuity.** Every supervised relaunch — after a crash, on boot-adopt, across
a butchr restart — **RESUMES the same Claude session** via `claude --resume <id>` (never
`--continue`, which is unreliable here), so the CTO keeps full context and **never
cold-starts**. Each directory has its **own** persisted session id (source of truth); on
a directory's **first** launch butchr resumes that directory's **operator-seeded**
session (**`BUTCHR_CTO_AGENT_SESSION_IDS`** = a `dir=session` map →
`config.ctoAgentSessionSeeds[directoryId]`) when present, else starts fresh and captures
the new id. A brand-new session happens **only** via an explicit
`POST /api/directories/:id/cto/restart?fresh=1`. (The separate read-only spec-generator
fork still uses its own `BUTCHR_CTO_SESSION_ID` — §2.7 — unrelated to this.)

**Context hygiene** (a session is indefinite, so it can't grow unbounded): PREFER
sending **`/compact`** to the live agent via the harness `send` capability when the
session grows (backed by Claude Code's own auto-compaction); a **forced-fresh restart**
(`restart?fresh=1`) is the last resort.

**API (per directory).**

| method | path | meaning |
|--------|------|---------|
| `GET`  | `/api/directories/:id/cto` | status: `{ directoryId, enabled, desired, running, paneId, tabId, sessionId, since, restarts, lastError }`. |
| `POST` | `/api/directories/:id/cto/start` | start (or **adopt** an already-live agent — single-instance per directory), resuming the session. |
| `POST` | `/api/directories/:id/cto/stop` | stop + tear down its tab/pane; marks it desired-down (survives a restart). |
| `POST` | `/api/directories/:id/cto/restart` | bounce, **resuming** the session. `?fresh=1` cold-starts a **brand-new** session. |
| `POST` | `/api/directories/:id/cto/terminal` | open a GUI terminal attached to its pane (reuses the workspace-agent attach). |

The per-directory enable is toggled via **`PATCH /api/directories/:id`** with
`{ cto_enabled: true|false|null }` (null clears → inherit the global default). Each
mutating call publishes a **`cto.updated`** SSE event (carrying the `directoryId`) so
every dashboard reflects it live. (The old global `/api/cto*` routes are removed.)

**Dashboard.** Each **directory's view** shows its **CTO-agent panel** (running/stopped,
session, since, restart count, last error) with an **'Open CTO terminal'** button — the
same pane-attach machinery as the workspace-agent terminal button (`attachAgentTerminal`
→ `herdr agent attach <name>`) — plus Start / Stop / Restart / Restart-fresh / Enable
controls, all scoped to that directory; each **dashboard card** shows a compact CTO
status badge for its directory.

**Teardown.** On butchr shutdown the supervisor stops but each agent's pane is **left
alive** (like workspace agents) so the next boot re-adopts and resumes it. Unregistering
a directory tears its CTO agent down first (so the `cto_agent` cascade-delete can't
strand a pane). The startup **reaper** keys husk cleanup strictly by task id, so it never
matches a per-directory CTO name (`<prefix>-<directoryId>`) and never orphans a pane.

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
| `gate_cmd` | TEXT | per-directory build/test gate command run by BOTH the CI gate (the task worktree) and the post-merge verify gate (the repo root). **NULL** = use the default (`BUTCHR_VERIFY_CMD`, still butchr's own command); a non-null value (incl. `""`, which **disables** the gate for this directory) is used verbatim via `bash -lc`. Set at register time, updatable via `PATCH /api/directories/:id`. Resolved by `directories.directoryGateCmd` — the single point both gates read, so they can't diverge. |
| `cto_enabled` | INTEGER | per-directory **CTO-agent enable** (boot auto-start + supervision). **NULL** = inherit the global default `BUTCHR_CTO_AGENT` (itself default OFF); `1` = on; `0` = off — the directory's own setting **wins** over the global default. Resolved by `cto-agent.isCtoEnabled`; settable via `PATCH /api/directories/:id` (`{ cto_enabled }`). The on-demand `/api/directories/:id/cto/*` endpoints work regardless (§6.8). |
| `created_at` | TEXT | ISO creation time. |

Deleting a directory **cascades** to its tasks (and their `task_events`) **and to its
`cto_agent` row** (§6.8 / below) — and butchr tears down that directory's live CTO
pane first so unregister can't strand it.

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
| `question` | TEXT | ASK handshake: the agent's pending clarifying question while `awaiting_input` (cleared on answer). |
| `answer` | TEXT | ASK handshake: the operator's answer, held transiently for the `--resume` re-launch to inject, then consumed at re-launch (`markRunning`). |
| `conflict` | INTEGER | flag: a surfaced non-conflict merge failure on `review`. |
| `idle` | INTEGER | flag: a `running` agent gone quiet. |
| `ci_status` | TEXT | CI gate: `running`/`pass`/`fail`/null. |
| `ci_summary` | TEXT | CI badge label + output tail. |
| `conformance_status` | TEXT | spec-conformance gate: `checking`/`pass`/`concern`/null (does the diff satisfy the prompt?). |
| `conformance_summary` | TEXT | the reviewer's short reason (missing/incomplete/off-spec parts; `conforms` on a pass). |
| `dispatch_attempts` | INTEGER | consecutive failed dispatch attempts (reset on success/clean re-queue). |
| `last_dispatch_error` | TEXT | most recent dispatch failure message. |
| `next_dispatch_at` | TEXT | ISO backoff gate: don't dispatch before this. |
| `revert_reason` | TEXT | failing output when a merge was auto-reverted off main (set with `failed`). |
| `blocked_by` | TEXT | JSON array of blocker task ids. |
| `tags` | TEXT | JSON array of free-form organizational LABELS set at creation (trimmed/de-duped, ≤40 chars each). Purely for filtering/organizing the list — nothing in dispatch/review/merge reads them. Surfaced as a `string[]` on `TaskView`, round-tripped in `task.md`. Null/`[]` = none. |
| `spawned_subtasks` | TEXT | JSON array of sub-task ids a plan task created. |
| `auto_merged` | INTEGER | 1 if butchr auto-merged this task. |
| `merge_base_sha` | TEXT | pre-ff base tip (exclusive lower bound of landed commits). |
| `merged_sha` | TEXT | post-ff tip (inclusive upper bound) — the merge/finalize commit a **rollback task** is pre-filled with (§4). |
| `usage_input_tokens` | INTEGER | cumulative session input tokens. |
| `usage_output_tokens` | INTEGER | cumulative session output tokens. |
| `usage_cache_read_tokens` | INTEGER | cumulative cache-read tokens. |
| `usage_cache_creation_tokens` | INTEGER | cumulative cache-creation tokens. |
| `cost_usd` | REAL | **always null** — a deliberate placeholder. The transcript carries no dollar cost and butchr ships no pricing table, so it does not fabricate one. |
| `diff_lines` | INTEGER | final changed-line count (added + deleted vs the default branch) captured on the review transition; the SIZE-bucket signal for duration estimates (§10). Null until/unless captured. |
| `path_type` | TEXT | coarse path-based type of the changed files (`docs`/`webapp`/`core`/`mixed`), captured alongside `diff_lines`; the TYPE-bucket signal for estimates (§10). Null until/unless captured. |
| `priority` | INTEGER (`0`) | dispatch priority — **higher = dispatched sooner**. The queued selection orders by `priority DESC, created_at ASC`, so an urgent task jumps the queue while ties stay FIFO (§3 *The tick loop*). Set at creation and updatable via `POST /api/tasks/:id/priority`; orthogonal to `status` (only affects `queued` dispatch order). |
| `plan_preview` | INTEGER (`0`) | 1 when the task opts into the **plan-preview gate** (§2.6): its first dispatch hands the agent the `propose_plan` tool + plan-preview protocol, parking it in `awaiting_input` for operator approval before any code is written. Orthogonal to `kind`/`status`; set only at creation. Surfaced on `TaskView`, round-tripped in `task.md` (`plan_preview: true`). |
| ~~`stage`~~ | (folded out) | the retracted idea→spec→build axis (§2.7). **No longer read or written.** New code carries the idea-vs-rest distinction in `status` (the `idea` front state). An old DB keeps the orphaned column (defaults `'build'` on inserts that omit it); a startup migration (`migrateStageAxisToStatus`) flips legacy `stage='idea'` rows to `status='idea'`. |
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

### `cto_agent` (managed CTO agents, **one row per directory**)

One row **per registered directory** (PK = `directory_id`, FK→directories **ON DELETE
CASCADE**) tracking that directory's butchr-managed **CTO agent** (§6.8) — its
principal/dev agent, run in the repo root, entirely separate from tasks (no
worktree/branch/review). Read/written via `getCtoAgentRow(directoryId)` /
`saveCtoAgentRow(directoryId, …)` / `listCtoAgentRows()` in `db.ts`. This **supersedes**
the old GLOBAL SINGLETON table (PK = the literal `'singleton'`); a one-time load-time
migration (`migrateCtoAgentPerDirectory`) **drops** the old singleton-shaped table and
recreates it keyed by `directory_id` — pre-1.0, the old singleton row is destroyed.

| column | type | meaning |
|--------|------|---------|
| `directory_id` | TEXT PK, FK→directories (cascade) | the directory this CTO agent belongs to (one per directory). |
| `session_id` | TEXT | the Claude session UUID, RESUMED (`--resume`) on every relaunch/adopt (§6.8 session continuity). |
| `herdr_pane_id` | TEXT | its live herdr pane (positional; may renumber) — backs the 'Open CTO terminal' attach. |
| `herdr_tab_id` | TEXT | its dedicated herdr tab (in the directory's workspace). |
| `herdr_workspace` | TEXT | the directory's herdr workspace (shared with its task agents). |
| `desired` | INTEGER | `1` = should be running (supervisor relaunches on death); `0` = explicitly stopped (stays down across a restart). |
| `started_at` | TEXT | when the current run was (re)launched. |
| `restarts` | INTEGER | supervised relaunches since the last fresh start. |
| `last_error` | TEXT | most recent launch/supervision failure. |
| `updated_at` | TEXT | last write. |

The per-directory **enable** flag is `directories.cto_enabled` (above), not a column
here — so a directory can be enabled before its first launch.

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
| `BUTCHR_BACKUP_ENABLED` | `true` | take periodic + on-shutdown DB snapshots (§5 "DB snapshots + restore"). Off ⇒ no snapshots taken (restore still works on existing ones). |
| `BUTCHR_BACKUP_DIR` | `<data>/backups` | where `VACUUM INTO` snapshots (`butchr-<ts>.db`) are written. |
| `BUTCHR_BACKUP_INTERVAL_MS` | `900000` (15 min) | periodic snapshot cadence; ≤0 disables the periodic loop (a shutdown snapshot is still taken). |
| `BUTCHR_BACKUP_KEEP` | `24` | newest snapshots to retain after each snapshot; ≤0 keeps **all** (no prune). |
| `BUTCHR_DISK_WARN_BYTES` | `5368709120` (5 GiB) | advisory threshold on combined worktree + backup disk usage; `/health` flags `disk.warn` when exceeded. `0` disables the warning (sizes still reported). |
| `BUTCHR_HERDR_BIN` | `herdr` | herdr binary. |
| `BUTCHR_GIT_BIN` | `git` | git binary. |
| `BUTCHR_TICK_MS` | `1500` | dispatcher poll interval. |
| `BUTCHR_CTO_CONTEXT` | _(empty)_ | optional file seeding a new directory's `.butchr/CTO.md` (else built-in default). |
| `BUTCHR_VERIFY_CMD` | `bun build src/index.ts --target bun --outfile /dev/null && bun test ./test` | **default** build/test gate command for **both** the CI gate (task worktree) and the post-merge verify gate (repo root), run via `bash -lc`. A directory's own `gate_cmd` (set at register time / via `PATCH /api/directories/:id`) overrides it per-directory; **empty disables** the gate. The test arg is **scoped to `./test`** on purpose: task worktrees live at `<dir>/<taskId>` (subdirs of the repo), so a bare `bun test` from the repo root would glob sibling worktrees' `test/*.test.ts` and run an unstable, cross-task suite (an in-flight worktree's failing test could auto-revert an unrelated green merge). `bunfig.toml` (`[test] root = "./test"`) pins bare `bun test` the same way. |
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
| `BUTCHR_IDLE_NUDGE_MS` | `120000` (2 min) | stalled-agent auto-nudge: grace period *beyond* `IDLE_MS` of silence before the watcher auto-sends `continue` to a live `in_progress` workspace agent (0 disables; never the CTO/non-workspace agents). |
| `BUTCHR_IDLE_NUDGE_MAX` | `3` | max **consecutive** auto-nudges before giving up and leaving the stall flagged for a human (resets when output resumes). |
| `BUTCHR_CI_RETRIES` | `1` | flaky-CI retries on a failing review-gate build/test (0 disables). |
| `BUTCHR_AUTO_MERGE` | `false` | auto-merge CI-green low-risk tasks (opt-in). |
| `BUTCHR_AUTO_MERGE_ALLOWLIST` | `public/,test/,docs/,*.md` | comma-separated low-risk path allowlist. |
| `BUTCHR_AUTO_MERGE_MAX_LINES` | `150` | max changed lines for low-risk. |
| `BUTCHR_CONFORMANCE_CMD` | `claude -p --permission-mode dontAsk --allowedTools "Read Grep Glob" -- "$(cat {{PROMPT_FILE}})"` | read-only, non-recursing reviewer for the **spec-conformance gate** (does the diff satisfy the prompt?), run via `bash -lc` in the task's worktree. Placeholder: `{{PROMPT_FILE}}`. **Empty disables** the gate. |
| `BUTCHR_CONFORMANCE_TIMEOUT_MS` | `120000` | max wait for the conformance reviewer before it's killed (→ null verdict). |
| `BUTCHR_CONFORMANCE_MAX_DIFF_BYTES` | `60000` | cap on the git diff fed to the conformance reviewer (larger diffs are truncated with a marker). |
| `BUTCHR_EXPAND_BRIEF_CMD` | `claude -p --permission-mode dontAsk --allowedTools "Read Grep Glob" -- "$(cat {{PROMPT_FILE}})"` | read-only, non-recursing **brief expander** for `POST /api/expand-brief` (one-line idea → repo-grounded task prompt), run via `bash -lc` in the target repo. Placeholder: `{{PROMPT_FILE}}`. **Empty disables** expansion (the endpoint 502s). |
| `BUTCHR_EXPAND_BRIEF_TIMEOUT_MS` | `120000` | max wait for the brief expander before it's killed (→ expansion failure). |
| `BUTCHR_SPEC_GEN_CMD` | `claude -p {{CTO_SESSION}} --permission-mode dontAsk --allowedTools "Read Grep Glob" -- "$(cat {{PROMPT_FILE}})"` | the **CTO-fork spec generator** (§2.7): turns an `idea` task's brief into a repo-grounded spec, run via `bash -lc` in the task's worktree. Read-only, non-recursing. Placeholders: `{{CTO_SESSION}}` (→ `--resume <id> --fork-session` when `BUTCHR_CTO_SESSION_ID` is set, else empty), `{{PROMPT_FILE}}`. **Empty disables** spec generation (an idea task then fails to advance). |
| `BUTCHR_SPEC_GEN_TIMEOUT_MS` | `300000` | max wait for the spec generator before it's killed (→ generation failure → retry/`failed`). |
| `BUTCHR_CTO_SESSION_ID` | _(empty)_ | CTO session id for the **spec generator's** `{{CTO_SESSION}}` (**resume + fork**, §2.7). Empty → spec gen uses a fresh read-only session. (No longer used by the managed CTO agent — that now seeds per-directory via `BUTCHR_CTO_AGENT_SESSION_IDS`.) |
| `BUTCHR_TERMINAL_CMD` | _(auto-detect)_ | override for "Open terminal"; `{{CMD}}` → the shell-quoted `herdr agent attach` command. Else auto-detect kitty/konsole/alacritty/xfce4-terminal/xterm/gnome-terminal/x-terminal-emulator (needs `DISPLAY`/`WAYLAND_DISPLAY`). |
| `BUTCHR_CTO_AGENT` | `false` | **global default** for the per-directory CTO-agent enable (§6.8). A directory's own `cto_enabled` column **wins** (NULL → inherit this). Off → butchr never auto-starts/supervises a directory's CTO unless that directory opts in (the `/api/directories/:id/cto/*` endpoints still work for on-demand control). |
| `BUTCHR_CTO_AGENT_NAME` | `butchr-cto-agent` | **name PREFIX** for a directory's CTO agent — the actual herdr agent name is `<prefix>-<directoryId>` (the `herdr agent attach` handle). Must not collide with a task id. |
| `BUTCHR_CTO_AGENT_MODEL` | _(empty)_ | optional `--model` for the CTO agents (else claude's default). |
| `BUTCHR_CTO_AGENT_SESSION_IDS` | _(empty)_ | per-directory CTO session SEEDS — a comma-separated `directoryId=sessionId` map. On a directory's **first** CTO launch (no persisted session) butchr **resumes** that directory's seeded session; every later relaunch resumes the persisted id (§6.8). |
| `BUTCHR_CTO_BRIEF` | _(`<dataDir>/cto-brief.md`)_ | path to the **editable** CTO system prompt/brief (shared across directories); a documented default is written once if unset. |
| `BUTCHR_CTO_CHANNEL_CMD` | `bun run src/channel.ts` | command (`bash -lc`, cwd = the directory's repo root) that runs the one-way channel bridge, registered as the `butchr-cto-channel` MCP stdio server. butchr sets `BUTCHR_CHANNEL_DIR` on it per-launch to scope it to the directory. |
| `BUTCHR_CTO_AGENT_CMD` | `claude --dangerously-skip-permissions {{MODEL_FLAG}} {{SESSION_FLAG}} --mcp-config {{MCP_CONFIG}} --dangerously-load-development-channels server:butchr-cto-channel -- "$(cat {{PROMPT_FILE}})"` | CTO agent launch template (`bash -lc`, under `script`, cwd = the directory's repo root). `{{SESSION_FLAG}}` → `--session-id <uuid>` (fresh) or `--resume <id>` (relaunch/adopt). |
| `BUTCHR_CTO_PROMPT_POLL_MS` / `BUTCHR_CTO_PROMPT_MAX_POLLS` / `BUTCHR_CTO_PROMPT_QUIET_POLLS` | `500` / `60` / `3` | **launch auto-confirm** (§6.8): poll cadence, max polls, and consecutive prompt-free reads before the agent is considered past startup. |
| `BUTCHR_CTO_SUPERVISE_MS` | `5000` | CTO-agent supervisor poll interval (sweeps all directories). |
| `BUTCHR_CTO_MAX_RESTARTS` | `5` | consecutive relaunch failures before the supervisor gives up (until an operator start/restart). |
| `BUTCHR_CTO_RESTART_BACKOFF_BASE_MS` | `2000` | base for the CTO relaunch exponential backoff. |
| `BUTCHR_CTO_RESTART_BACKOFF_CAP_MS` | `60000` | cap for the CTO relaunch backoff. |

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
`status`, `context: [paths]`, plus `kind: plan`, `model: …`, `tags: […]`, and
`plan_preview: true` only when set.
Sections: `## Prompt`, `## Review Notes` (rejection notes appended over time). The
rendered agent prompt **lists context-file paths** rather than inlining their bodies
(the prompt is passed as a single shell argv via `"$(cat …)"`, so inlining large
files would blow `MAX_ARG_STRLEN` → E2BIG); the agent reads the files itself.

**butchr state dir** (`~/.local/share/butchr/`): `butchr.db` (+ WAL), `butchr.log`
(+ rotations), `backups/butchr-<ts>.db` (DB snapshots — see §5), `prompts/<id>.md`
(rendered prompts), `runs/<id>.log` + `<id>.done` (PTY run log + exit marker), and
`mcp/<id>.json` (per-task MCP config).

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
