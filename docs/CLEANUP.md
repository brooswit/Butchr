# butchr — code-quality / DRY cleanup plan

A prioritized, **report-only** audit of the merged tree. butchr grew through many
independent agent tasks, so the same logic was re-derived in several places. This
doc names each smell (with `file:function` and roughly where), says why it
matters, and proposes a **specific** refactor scoped as an **independent
follow-up task**. Nothing here is applied — it's the backlog.

Each finding is sized **value** (how much duplication/risk it removes) vs
**effort**, carries an id (`C1`…`C11`) for cross-referencing, and lists the
**files it touches** so overlapping tasks can be sequenced rather than run in
parallel (see [§Sequencing](#sequencing--do-not-parallelize-same-file-work) at
the end).

Method: read all of `src/*.ts`, `public/app.js`, `bin/butchr`, and `test/`, and
verified every claim against the code (call-site counts are from `grep` on the
current tree, cited inline).

---

## Ranked summary

| # | Finding | Value | Effort | Files touched |
|---|---------|-------|--------|---------------|
| **C1** | One `setStatus()` helper for task transitions | High | Med | `src/tasks.ts` (`src/db.ts`) |
| **C2** | One `herdrSoft()` envelope-parse helper | High | Low | `src/herdr.ts` |
| **C3** | One shared build+test gate runner (CI ≡ verify) | Med-High | Med | `src/exec.ts`, `src/verify.ts`, `src/tasks.ts` |
| **C4** | Extract git rebase-conflict collection helper | Med | Low | `src/git.ts` |
| **C5** | app.js: modal scaffold + async-action + chip cluster | Med | Med | `public/app.js` |
| **C6** | app.js: one collapsible-panel helper | Low-Med | Med | `public/app.js` |
| **C7** | `exec.run()` timeout option (enabler for C3) | Low-Med | Low | `src/exec.ts` (`src/verify.ts`) |
| **C8** | Directory task-list endpoint should return `taskView` shape | Med | Med | `src/tasks.ts`, `src/server.ts`, `public/app.js` |
| **C9** | config: two vars bypass the `env()` helpers | Low | Low | `src/config.ts` |
| **C10** | mcp.ts: per-tool handler boilerplate → small registry | Low | Low-Med | `src/mcp.ts` |
| **C11** | JSDoc gaps on a handful of exports | Low | Low | several (trivial) |

**Best value/effort first:** C2, C4 (both low-effort, no overlap with anything —
safe to do immediately and in parallel), then C1 (highest absolute value), then
C3/C8.

---

## C1 — Centralize task status transitions in a `setStatus()` helper

**Smell.** `src/tasks.ts` hand-writes the same four-step transition skeleton at
~16 sites:

```ts
const res = db.query(`UPDATE tasks SET status='X', …extra cols… WHERE id=? AND status='Y'`).run(…);
if (res.changes === 0) return;            // lost a race — bail
recordTaskEvent(id, "Y", "X", note);      // audit event
updateTaskMdStatus(dir.path, id, "X");    // mirror to task.md
emitUpdated(id);                          // SSE
```

Counts on the current tree (`grep -c` in `src/tasks.ts`): **16** `UPDATE tasks
SET status=`, **16** `recordTaskEvent(`, **14** `updateTaskMdStatus(`, **30**
`emitUpdated(`. The skeleton appears in `createTask`, `reevaluateBlockedTask`,
`setBlockedBy` (two branches), `proposeSubtasks`, `approveTask` (revert + merge
exits), `finalizeTask`, `requestChanges`, `abortTask`, `markRunning`,
`markReview`, `markReviewFromAgent`, `backToQueued`, `markDispatchFailure`,
`requeueTask`.

**Why it matters.** This is the spine of the state machine and the most-edited
hot spot. The four steps must stay in lockstep — a transition that updates the
row but forgets `recordTaskEvent` silently drops an audit-timeline entry; one
that forgets `updateTaskMdStatus` desyncs task.md from the DB; one that forgets
`emitUpdated` makes the webapp go stale until the next tick. Every new transition
re-copies all four by hand, so the invariant is enforced by discipline, not by
construction — exactly the kind of thing that drifts across independent tasks.

**Proposed refactor (independent task).** Add a single helper — colocated with
the other transition writers in `tasks.ts` (it needs `getDirectory` +
`updateTaskMdStatus` + `emitUpdated`, so `tasks.ts` is the right home, not
`db.ts`):

```ts
function setStatus(
  id: string,
  to: TaskStatus,
  opts: { from?: TaskStatus | TaskStatus[]; note?: string; set?: Record<string, unknown> } = {},
): boolean   // returns res.changes > 0
```

It builds the guarded `UPDATE` (`status=?` plus the `opts.set` extra columns,
`WHERE id=? AND status IN (…from)`), and on a real change records the event,
mirrors task.md, and emits. Migrate the call sites incrementally (start with the
simple ones — `setIdle`, `adoptPane`, `backToQueued`, `requeueTask` — then the
multi-column ones). Keep `markReviewFromAgent`'s "only record the event on a
genuine running→review (not a review→review duplicate)" nuance expressible via
`opts.from`. **Scope caveat:** behavior must be byte-for-byte identical — this is
a pure refactor; the test suite (`task-events.test.ts`, `pause.test.ts`, the
dispatch/merge tests) is the regression net.

**Touches:** `src/tasks.ts` (helper possibly imported from `src/db.ts`). Overlaps
C3 and C8 (also edit `tasks.ts`) — see Sequencing.

---

## C2 — Collapse the herdr envelope-parse into one `herdrSoft()` helper

**Smell.** `src/herdr.ts` has the `herdr()` wrapper (lines 12-32) that does
run → check ok → trim stdout → `JSON.parse` in try/catch → check `env.error` →
return `env.result ?? env`. Then **seven** other functions re-implement that
exact block because they want to return `undefined`/`[]`/`""` on failure instead
of throwing: `agentTabId` (111), `agentPaneId` (199), `agentTerminalId` (227),
`paneTerminalId` (249), `paneList` (274), `agentRead` (376) — plus `herdr()`
itself. Verified: `grep -c "env = JSON.parse(text)"` and
`grep -c "env.result ?? env"` in `herdr.ts` both return **7**.

**Why it matters.** Six near-identical copies of "run a herdr command, parse its
JSON envelope, soft-fail to a default" — each also re-deriving the
`env.result ?? env` unwrap and the `env.error` short-circuit. A change to herdr's
envelope shape (or a fix to the unwrap) has to land in seven places. The
field-probe tails (`r.pane?.pane_id ?? r.root_pane?.pane_id ?? r.pane_id ?? …`)
are likewise copy-pasted across `agentStart`, `agentPaneId`, `resolveAgentPane`.

**Proposed refactor (independent task).** Add a soft sibling to `herdr()`:

```ts
async function herdrSoft(args: string[]): Promise<any | null> {
  const res = await run([bin, ...args]);
  if (!res.ok) return null;
  const text = res.stdout.trim();
  if (!text) return null;
  try {
    const env: Envelope = JSON.parse(text);
    if (env.error) return null;
    return env.result ?? env;
  } catch { return null; }
}
```

The seven functions become one `herdrSoft(...)` call plus their field-probe. Also
extract the probes — `paneIdOf(r)`, `terminalIdOf(r)`, `tabIdOf(r)` — so the
"shapes vary by herdr version" knowledge lives in one place. Pure-internal
refactor (no observable behavior change → no SPEC edit needed).

**Touches:** `src/herdr.ts` only — **no overlap**, safe to run in parallel with
everything except other herdr.ts work.

---

## C3 — One shared build+test gate runner (CI gate ≡ post-merge verify)

**Smell.** butchr runs "build the bun entry, then run the suite, against a git
checkout" in **two independent implementations** that have **diverged**:

- **CI gate** — `defaultCiRunner` (`src/tasks.ts:1295`): two hardcoded
  `run([...])` argv calls (`bun build … --outfile /dev/null`, then `bun test`)
  **in the task's worktree**, with bun-summary parsing for a badge
  (`parseBunCount`, `ciTail`). **No timeout.** Wrapped by the flaky-retry loop in
  `triggerCi` (`tasks.ts:1346`, `runCiOnce` + `config.ciRetries`).
- **Post-merge verify** — `defaultRunner` (`src/verify.ts:27`): runs
  `config.verifyCmd` via `bash -lc` **in the repo root**, with a
  `config.verifyTimeoutMs` kill-timer. **No retry.** Invoked as
  `verifyDefaultBranch` from `approveTask`.

`config.verifyCmd` defaults to *exactly* the same two commands the CI runner
hardcodes (`bun build … && bun test`). So they encode the same gate twice, and
the differences are accidental, not designed: CI has **retries but no timeout**;
verify has a **timeout but no retry**; CI hardcodes the argv while verify reads it
from config. A hanging `bun test` in the CI gate has no bound (it's
fire-and-forget, so it leaks a process rather than wedging the queue — but it's
still an unbounded spawn).

**Why it matters.** Two places that must agree on "what "green" means" can drift
(e.g. someone overrides `BUTCHR_VERIFY_CMD` for a non-bun repo, and CI still
shells `bun` — the badge and the merge gate now disagree). The timeout/retry
asymmetry is a latent inconsistency a reader has to discover the hard way.

**Proposed refactor (independent task).** Introduce one low-level gate executor —
e.g. `runGate(cwd, { timeoutMs }): Promise<{ ok: boolean; output: string }>` (new
`src/gate.ts`, or fold into `exec.ts`) — that runs the configured build/test
command in a given cwd with a timeout. Then:

- `verify.ts`'s `defaultRunner` becomes a thin wrapper (skip-on-empty + the
  VerifyResult shape) over `runGate`.
- `defaultCiRunner` calls `runGate` for the spawn, and **layers the badge
  parsing on top** (it still wants to distinguish build-fail vs test-fail and
  count tests — that part stays CI-specific).

This unifies the spawn + timeout, leaving the genuinely-different bits (badge
parsing, skip semantics, retry policy) as explicit layers. **Minimum viable
slice if the full unification is too big:** just give `defaultCiRunner` the same
timeout bound `verify` has (depends on **C7**). Update SPEC §4/§8 if the gate's
timeout/retry surface changes.

**Touches:** `src/exec.ts`, `src/verify.ts`, `src/tasks.ts`. Overlaps **C1** and
**C8** (tasks.ts) and **C7** (exec.ts) — see Sequencing. Tests: `ci-gate.test.ts`,
`post-merge-verify.test.ts`, `flaky`-retry via `dispatch-retry`/`ci-gate`.

---

## C4 — Extract the git rebase-conflict collection helper

**Smell.** `src/git.ts` has the same conflict-handling tail in two functions —
`merge()` (lines 269-291) and `rebaseOntoDefault()` (lines 445-467):

```ts
const unmerged = await run([git, "-C", X, "diff", "--name-only", "--diff-filter=U"]);
let conflictFiles = unmerged.ok ? unmerged.stdout.split("\n").map(trim).filter(Boolean) : [];
if (conflictFiles.length === 0) conflictFiles = parseConflictFiles(rb.stdout + "\n" + rb.stderr);
await run([git, "-C", X, "rebase", "--abort"]);
const conflict = /conflict/i.test(rb.stdout + "\n" + rb.stderr) || conflictFiles.length > 0;
```

**Why it matters.** Both copies encode the same subtle ordering: collect the
unmerged files **before** aborting (the abort clears them), prefer
`--diff-filter=U` over scraping git's text, then decide `conflict` from either
signal. A fix to one (e.g. handling a new git message format) must be mirrored or
the two conflict paths behave differently — and these feed the conflict-note that
gets handed back to the agent, so a discrepancy is user-visible.

**Proposed refactor (independent task).** Extract
`async function collectConflictAndAbort(cwd: string, rb: ExecResult):
Promise<{ conflict: boolean; conflictFiles: string[]; message: string }>` and call
it from both `merge()` and `rebaseOntoDefault()`. Pure-internal; covered by
`auto-rebase.test.ts` + `auto-merge.test.ts`.

**Touches:** `src/git.ts` only — **no overlap**, safe in parallel.

---

## C5 — app.js: shared modal scaffold, async-action helper, and chip cluster

`public/app.js` is vanilla-by-design (no framework, per the zero-dep rule), and
it already factors the basics well (`el`, `svg`, `esc`, `chip`, `effStatus`,
`api`). Three patterns still repeat enough to extract:

**(a) Modal scaffold.** `openPicker` (line 128) and `openNewTaskModal` (line 421)
each hand-build the identical backdrop + modal + `close()` + `onKey`/Escape +
backdrop-click-to-close boilerplate (~12 lines apiece). Extract
`openModal({ title, body, footer }) -> { close }`.

**(b) Async action button.** The pattern
`btn.disabled = true; try { await api(...); toast(ok); render()/backToDirectory } catch (e) { toast(e.message, true); btn.disabled = false }`
appears ~8×: add-dir (311), requeue (1487), abort (1498), rollback (1513),
approve (1529), reject (1551), plus the picker's register path. Extract
`async function action(btn, fn, { success })` to own the disable/try/restore/toast
dance.

**(c) Task chip cluster.** `chip(effStatus(t)) + (conflict?…) + (plan?…) +
(rolledBack?…)` is hand-assembled with slightly different combinations in
`finishedList` (702), `tasksTable` (722), `boardCard` (995), and `renderTask`'s
header (1261). Extract `taskChips(t)` returning the full cluster so the views
can't drift on which badges they show.

**Why it matters.** These are the spots an agent touches when adding a view, and
each copy is a chance to forget the `finally`-restore (a stuck disabled button) or
drop the conflict chip. Helpers make new views correct by default and shrink the
file.

**Proposed refactor (independent task).** Add the three helpers near the top
("tiny helpers" block) and migrate the call sites. No backend/contract change
(note in SPEC §6.5 only if you want).

**Touches:** `public/app.js` only. Overlaps **C6** and **C8**'s client part —
sequence the app.js work (see Sequencing).

---

## C6 — app.js: one collapsible-panel helper

**Smell.** The caret(▾/▸) + clickable head + toggle-body + (sometimes) persist
pattern is re-implemented in `historySection` (653), `ciBadge`'s detail (1058),
`renderTranscriptPanel` (1170), the live-output panel (1394), and each
`diff-file` card (`wireDiff`, 1630). Each re-wires its own caret-flip + class
toggle.

**Why it matters.** Lower-value than C5 (the panels genuinely differ in
lazy-load/persist behavior), but the caret/toggle mechanics are identical and
copied five times.

**Proposed refactor (independent task).** A
`collapsible({ title, hint, open, persistKey?, onOpen? }) -> { panel, setOpen }`
that owns the caret glyph + class toggle + optional localStorage persistence.
Panels keep their own body-fill / lazy-load logic and just plug into it.

**Touches:** `public/app.js` only — **same file as C5/C8 client**, so do it
after C5 (or fold into the same task), never concurrently.

---

## C7 — `exec.run()` timeout option (enabler for C3)

**Smell.** `src/exec.ts`'s `run()` (the canonical "shell out, never throw"
helper CONTRIBUTING §3 tells everyone to use) has **no timeout**. Because of
that, `verify.ts` bypasses it and hand-rolls `Bun.spawn` + a `setTimeout` kill
(`verify.ts:31-53`) purely to get a bounded run. The CI runner, using `run()`,
gets no bound at all (C3).

**Why it matters.** The one place that needs a bounded subprocess can't use the
shared helper, so it duplicates the spawn/collect/await logic — and the next
caller that needs a timeout will copy `verify.ts` rather than `exec.ts`.

**Proposed refactor (independent task).** Add `timeoutMs?` to `run()`'s opts:
on expiry, `proc.kill()` and resolve with a non-zero `code` + a marker in
`stderr` (so callers can detect the timeout). Then `verify.ts` and the CI runner
both go through `run()`. Small, self-contained, and it unblocks C3's
"give CI the same timeout" slice.

**Touches:** `src/exec.ts` (and `src/verify.ts` when rewired). Overlaps **C3**
on exec.ts/verify.ts — do **C7 before C3**.

---

## C8 — Directory task-list endpoint returns raw rows, not the `taskView` shape

**Smell.** `GET /api/directories/:id/tasks` returns `json(listTasks(p.id!))`
(`src/server.ts:422-425`) — raw `TaskRow[]`, where `blocked_by` /
`spawned_subtasks` are JSON-**string** columns and there is no `prompt`,
`blockerStates`, or `deadBlockers`. The detail route `GET /api/tasks/:id` returns
`taskView` (`server.ts:448`), the parsed/enriched shape. CONTRIBUTING §3
explicitly says *"Return `taskView(id)` from new endpoints and SSE events…so the
shape the webapp and CLI consume stays consistent."* The list endpoint predates
or ignores that rule.

The divergence is paid for on the client: `blockedByIds` (`app.js:769`) exists
**only** to accept *both* shapes ("the directory task list returns raw DB
rows… the single-task view already parses it to an array. Accept either shape"),
and the board/graph views recompute each blocker's status from sibling rows
instead of using the server's `blockerStates`/`deadBlockers`.

**Why it matters.** Two response shapes for "a task" is a recurring foot-gun —
every consumer must branch on which endpoint it came from. It also means the
list/board/graph can show a *different* blocker-status story than the detail page
(the server computes "gone"/dead handling that the client re-derives approximately).

**Proposed refactor (independent task).** Add a list projection — either reuse
`taskView` per row, or a lighter `taskListView(directoryId)` that parses
`blocked_by`/`spawned_subtasks` and computes `blockerStates`/`deadBlockers`
without reading every `task.md` (the list view doesn't need prompt/context bodies,
which is presumably why it stayed raw — so a lighter projection is the pragmatic
call). Return it from the route; then delete `blockedByIds`'s dual-shape branch
and let the board/graph read `blockerStates`. Update SPEC §6.1.

**Touches:** `src/tasks.ts` (new projection), `src/server.ts` (route),
`public/app.js` (consume). Overlaps **C1/C3** (tasks.ts) and **C5/C6** (app.js).

---

## C9 — config: two vars bypass the typed `env()` helpers

**Smell.** `src/config.ts` defines `env`/`envInt`/`envBool`/`envList` and uses
them everywhere — except `ctoContextPath` (line 80) and `terminalCmd` (line 291),
which read `process.env.BUTCHR_… || ""` directly. `env(name, "")` is behaviorally
identical (it already falls back when the var is empty/unset).

**Why it matters.** Tiny, but CONTRIBUTING §4 makes a point of "Reference it as
`config.<field>` (never read `process.env` directly…)" and uniformity here means a
future reader doesn't wonder whether these two are special.

**Proposed refactor (independent task).** Replace both with
`env("BUTCHR_CTO_CONTEXT", "")` / `env("BUTCHR_TERMINAL_CMD", "")`. One-line each,
no behavior change.

**Touches:** `src/config.ts` only — **no overlap**.

---

## C10 — mcp.ts: per-tool handler boilerplate → a small dispatch registry

**Smell.** `src/mcp.ts` routes `tools/call` through `handleToolCall` (225), which
is an if-ladder by tool name, and each of `handleAsk` / `handleProposeSubtasks` /
the inline `request_review` branch repeats: pull `msg.params?.arguments`, validate
a field, run the service call, and wrap failures as `textResult(..., true)`.

**Why it matters.** Low — there are only three tools and the code is readable. But
adding a fourth tool means re-copying the extract-validate-try/catch shell, and
the per-tool `tools/list` gating (`isPlan ? [...] : [...]`, line 207) is a second
place that has to know the tool set.

**Proposed refactor (independent task).** A small registry:
`{ name, schema, plan?: boolean, run(taskId, args): Promise<result> }[]`, with one
shared dispatcher that does arg-extraction + the `try/catch → textResult` wrap, and
`tools/list` filtering off `plan`. Optional / nice-to-have; only worth doing if
more tools are coming.

**Touches:** `src/mcp.ts` only — **no overlap**. Covered by the MCP path in the
existing tests (csrf/server) plus `plan-decompose.test.ts`.

---

## C11 — JSDoc gaps on a handful of exports

**Smell.** Module-level header comments are **universally present and good**
(every `src/*.ts` opens with a "why this module exists" block — this is a
strength, not a gap). A few *exports* lack the one-line JSDoc the rest of the file
uses: `db.nowIso` / `db.metricRows` (`src/db.ts`), `startDispatcher` /
`stopDispatcher` (`src/dispatcher.ts`), `startServer` (`src/server.ts`),
`getDirectory` / `getDirectoryByPath` (`src/directories.ts`). Separately,
`parseBlockedBy` (`tasks.ts:56`) is reused to parse the differently-named
`spawned_subtasks` column (`taskView`, line 171) — correct (same JSON-array
shape) but mildly surprising.

**Why it matters.** Lowest-value item; these are mostly self-evident. Listed for
completeness so the codebase stays uniformly self-describing.

**Proposed refactor (independent task).** Add a one-line `/** … */` to each
listed export to match the surrounding density, and either rename `parseBlockedBy`
→ `parseJsonIdArray` or add a one-line note at its `spawned_subtasks` reuse. Pure
docs.

**Touches:** several files, but each edit is a single comment line — low conflict
risk, though it brushes `tasks.ts`/`db.ts`/`server.ts` (do last, after the
structural tasks, to avoid churn).

---

## Sequencing — do NOT parallelize same-file work

Independent agent tasks branch from the same base and only see each other at
merge, so two tasks editing the same file collide at merge time. Group by file:

| File | Findings that touch it | Order |
|------|------------------------|-------|
| `src/tasks.ts` | **C1**, C3, C8, (C11) | C1 → C3 → C8 → C11. **Sequence — never parallel.** |
| `public/app.js` | **C5**, C6, C8(client) | C5 → C6 → C8-client. **Sequence.** |
| `src/exec.ts` | **C7**, C3 | C7 → C3. |
| `src/verify.ts` | C7, C3 | follows exec.ts order. |
| `src/server.ts` | C8, (C11) | C8 → C11. |
| `src/git.ts` | **C4** | alone. |
| `src/herdr.ts` | **C2** | alone. |
| `src/config.ts` | **C9** | alone. |
| `src/mcp.ts` | **C10** | alone. |

**Safe to run fully in parallel right now (no file overlap):** **C2** (herdr),
**C4** (git), **C9** (config), **C10** (mcp). Start the `tasks.ts` chain (C1) and
the `app.js` chain (C5) each as their own serialized lane. Do **C7 before C3**
(exec timeout is C3's enabler). Save **C11** for last so its comment-only edits
don't conflict with the structural tasks ahead of it.

**Every follow-up here is a pure refactor (no behavior change).** The gate for
each is the standard one: `bun build src/index.ts --target bun --outfile /dev/null`
+ `bun test` green, with the existing suite as the regression net — plus the
living-docs rule (CONTRIBUTING §6) for the few that change an observable surface
(C3 timeout/retry → SPEC §4/§8; C8 list shape → SPEC §6.1).
