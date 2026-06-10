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

### Changed
- Added DB SNAPSHOT + RESTORE resilience for the source-of-truth SQLite DB. New src/backup.ts: SQLite-safe snapshots via VACUUM INTO (not raw mid-WAL copy) to ~/.local/share/butchr/backups/butchr-<ts>.db, a periodic loop (default 15min) + one on clean shutdown, retention pruning (keep newest N, default 24), and an offline restore path. Wired startBackupLoop into src/index.ts with an async SIGINT/SIGTERM handler that takes a final shutdown snapshot. /health now reports a `backup` block (lastSnapshotAt, count, keep, intervalMs, dir). Config: BUTCHR_BACKUP_ENABLED/DIR/INTERVAL_MS/KEEP (env-overridable). bin/butchr gains two OFFLINE commands — `butchr backups` (list) and `butchr restore <file|latest> [--force]` (restores BUTCHR_DB, saves current aside to <db>.pre-restore-<ts>, clears stale -wal/-shm, refuses while a server is up unless --force) — implemented via src/backup.ts (import-side-effect-free w.r.t. opening the DB; db.ts loaded lazily only when snapshotting). Zero new deps. Docs updated per CONTRIBUTING: SPEC.md (§5 new subsection, §6.4 CLI, §8 config, §9 layout, health fields), OPERATIONS.md (runbook + CLI + health field), CHANGELOG [Unreleased]. New test/backup.test.ts (14 tests: snapshot consistency/uniqueness, retention pruning, resolve, restore). bun build + full bun test green (201 pass); verified end-to-end snapshot→restore through the actual CLI binary. Left package.json version alone since butchr auto-bumps it at merge. (task crimson-magpie-563b)
- Add named, parameterized TASK TEMPLATES (recipes) so common task shapes are created from a template instead of hand-writing the same prompt skeleton. New dependency-free src/templates.ts holds four built-in recipes (feature, refactor-extract, webapp-panel, add-endpoint), each a name/description/body with {{placeholders}}; helpers listTemplates, renderTemplate (vars substitution; unsupplied markers left visible), extractPlaceholders, and validateVars. Surfaced via GET /api/templates (list) and a template/vars branch on the create route (server-rendered prompt). CLI gains a `templates` command and `new --template <name> --var key=val …` (repeatable --var). Webapp new-task modal gains a template picker that fills the prompt textarea and hints which placeholders to complete, then submits the plain prompt. SPEC.md updated (REST §6.1, CLI §6.4, webapp §6.5). New test/templates.test.ts covers listing, placeholder extraction, substitution, validation, and template→created-task prompt round-trip; full suite (224 tests) + bun build green. (task spry-hill-0073)
- Resolved the merge conflict by rebasing onto the latest main (git rebase main — not a merge commit), so the resolution sticks under the gate's rebase. Conflicts were in package.json and SPEC.md, with CHANGELOG.md auto-merged. Resolution: - main has since changed the living-docs convention: butchr now records the CHANGELOG entry + version bump automatically at merge, and agents no longer hand-edit CHANGELOG.md / package.json (only SPEC.md stays a manual edit). So I DROPPED my hand-edits to both — package.json now keeps main's version (0.9.18), and CHANGELOG.md was restored to main's content (my hand-added entry removed; butchr will add the entry from this summary at merge). - SPEC.md §6.5: merged both sides — kept main's Directory-view additions (tag filter chips, tags in new-task modal, sub-tree merge-progress bar) and the Task-detail conformance badge + tags-row text, and integrated my richer diff description (dependency-free syntax highlighting + line-number gutter + inline per-line comments composed into the reject note) into the diff phrase. - public/app.js + public/style.css auto-merged cleanly with main's newer conformance/tags/rollup work; my feature code is intact (highlightCode/highlightJs/highlightCss, parseDiff line numbers, inline-comment state + composeReviewNote, wireDiff, the --tok-* vars and .dl-comment styles), and the review panel correctly stacks ciBadge → conformanceBadge → diff → inline-comment summary → controls. The diff vs main is now exactly 3 files (SPEC.md, public/app.js, public/style.css), no conflict markers anywhere. bun build clean; bun test green — 218 pass / 0 fail (includes main's newer conformance/tags/rollup tests); public/app.js parses clean. The feature itself is unchanged from the prior submission — this is purely the conflict resolution + dropping the now-obsolete CHANGELOG/version hand-edits. (task playful-moor-45a0)
- Resolved the merge conflict by rebasing onto the current main (e4b53e6). The only conflict was in SPEC.md §6.5 (Webapp): main had added a "tags" feature to the Directory-view and Task-detail bullets while my branch added the spec-conformance badge. I merged both — kept main's tags additions (tag filter chips, tags in the new-task modal, sub-tree merge-progress bar, tags row in the meta grid) and integrated my conformance-badge description into the Task-detail bullet. All other files auto-merged cleanly; every conformance change (src/conformance.ts, db/config/tasks hooks, app.js + style.css badge, SPEC §4/§7/§8 sections, the test) is intact. `bun build` green; `bun test` green — 218 pass / 0 fail (includes the 12 conformance-gate tests). No functional changes from the previous submission; this is purely the conflict resolution. (task merry-snow-6e87)
- Resolved the SPEC.md merge conflict by rebasing onto the latest main (git rebase main, not a merge commit). The only conflict was in SPEC.md §6.5 (Webapp): main had added a graph "sub-tree merge-progress bar" note and a task-detail "sub-task progress rollup"; my branch added the tag-chip filter row, the new-task-modal tags field, and the tags meta-grid row. I merged both — the Directory-view bullet now describes the tag filter + tags modal/chips AND keeps main's graph progress-bar sentence; the Task-detail bullet keeps my "tags row in the meta grid" addition on top of main's text. All other files auto-merged cleanly. No conflict markers remain anywhere. Rebased tree verified: `bun build` clean + full `bun test` green (206 pass — includes main's newer tests plus my test/tags.test.ts). The tags feature itself is unchanged from the prior submission. (task balmy-gale-499b)
- Add a sub-task / dependency PROGRESS ROLLUP to the webapp, surfacing how far an auto-decomposed plan's child graph has landed. What's new (purely client-side — no new API field): - Task detail: a "Sub-task progress" panel for any task that GATES dependents (its id appears in others' blocked_by). Shows "N/M merged" over the transitive sub-tree, a progress bar, an optional "X direct · +Y nested" line, and the direct children with their live status chips. Renders nothing for a task with no dependents. - Dependency graph: nodes that gate dependents now carry an inline merge-progress bar (merged fraction of their transitive sub-tree) plus an "N/M merged" annotation in the tooltip/aria-label; text lines nudge up to make room. How it works: new reverseDeps()/gatedSubtree() helpers reverse the blocked_by edges of the already-fetched directory task list and BFS the transitive dependents (cycle-guarded). The task page fetches the directory's task list (best-effort) and computes the rollup with dependentRollup(); everything live-updates for free via the existing SSE re-render. Files: public/app.js (helpers + rollup panel + graph annotation + renderTask wiring), public/style.css (.rollup-* panel styles + .tg-prog-* node bar), SPEC.md §6.5 (webapp view notes). Zero deps. `bun build … --outfile /dev/null` clean; `bun test` 187 pass / 0 fail. (task fleet-egret-4f3e)
- **butchr now records the CHANGELOG entry + version bump at merge — agents no
  longer hand-edit `CHANGELOG.md` / `package.json`.** Under the old living-docs
  convention every task appended its own `[Unreleased]` bullet and bumped the
  version, so under concurrency every task touched those same two files and they
  **all** collided at merge (each needing an auto-resolve pass). The bookkeeping
  now happens once, in `git.merge` (`finalizeLivingDocs`), **inside the serialized
  merge lock and after the rebase** — so the edits land on the up-to-date base and
  two merges can't race the same lines. butchr appends an `[Unreleased]` → `###
  Changed` entry derived from the task's **`request_review` summary** + id (stamped
  with a `(task <id>)` idempotency marker so a re-merge never double-adds) and
  **patch-bumps** `package.json`, skipping the bump for a **docs-only** diff. The
  pure transforms live in the new dependency-free `src/changelog.ts` (unit-tested).
  **SPEC.md stays a manual living-doc edit** (it is not append-only and rarely
  collides). Contributors now just **write a clear task summary**; see
  [CONTRIBUTING §6](./CONTRIBUTING.md#6-living-docs-update-on-every-change) and
  [SPEC.md §4](./SPEC.md#4-review--merge).

### Added
- **DB snapshots + restore (resilience).** The SQLite database is butchr's source of
  truth for all task state and history, so it now takes **SQLite-safe snapshots** of
  it for crash/power-loss recovery. A background loop snapshots the DB every
  `BUTCHR_BACKUP_INTERVAL_MS` (default 15 min) **and on every clean shutdown**, using
  `VACUUM INTO` (a consistent online backup — never a torn mid-WAL file copy) to write
  `backups/butchr-<timestamp>.db` under `BUTCHR_BACKUP_DIR` (default `<data>/backups/`).
  The newest `BUTCHR_BACKUP_KEEP` (default 24) are retained and older ones pruned; the
  whole feature is toggled by `BUTCHR_BACKUP_ENABLED` (default on). Recover with two new
  **offline** CLI commands — `butchr backups` (list snapshots) and
  `butchr restore <file|latest>` (restore the DB, saving the current one aside to
  `<db>.pre-restore-<ts>` first; refuses while a server is running unless `--force`).
  `/health` now reports a `backup` block (`lastSnapshotAt`, retained `count`, `keep`,
  `intervalMs`, `dir`). Zero new dependencies. See
  [SPEC.md §5](./SPEC.md#db-snapshots--restore-srcbackupts) and the
  [OPERATIONS runbook](./OPERATIONS.md#db-snapshots--restore).
- **Rough task-duration estimates (ETA).** butchr now forecasts how long a task is
  likely to take, built from its **own tracked history** — a small, dependency-free
  heuristic (no ML). Every estimate is a **loose p50–p90 range with its sample size**
  (e.g. *"est ~12–30m, n=8"*), explicitly hedged and **never a hard promise**; when
  history is too thin it says **"insufficient data"** rather than guess. Completed
  tasks are bucketed by a cheap signal captured on the review transition — a **size**
  bucket from the final diff line-count (small/medium/large) and a path-based **type**
  (docs/webapp/core/mixed) — and per-bucket **P50/P90** of the started→review and
  started→merge durations drive the forecast (a queued task with only a prompt falls
  back to the overall median). For a dependency **chain**, butchr estimates the
  **critical path** (longest `blocked_by` path, `max()` across parallel branches) so a
  plan shows an approximate total. Surfaced on the **task-detail** page (an *est.
  duration* row plus a critical-path line on the blocked-by / spawned-sub-tasks
  panels), on **`TaskView.estimate`**, and via a new **`GET /api/tasks/:id/estimate`**
  endpoint (`{ single, chain }`). Two new nullable task columns (`diff_lines`,
  `path_type`) record the captured footprint. See [SPEC.md §10](./SPEC.md#10-duration-estimates-rough).
- **`BUTCHR_ALLOWED_ORIGINS`** — comma-separated list of extra browser origins
  permitted to make state-changing `/api` requests, on top of the derived loopback
  origins, for the CSRF / DNS-rebinding guard above.
- **`docs/CLEANUP.md`** — a prioritized code-quality / DRY audit of the merged
  tree: each finding names the smell (with `file:function`), why it matters, and a
  specific refactor scoped as an independent follow-up task, ranked by value/effort
  and flagged for same-file sequencing. Report only — no code changes.

### Changed
- **Internal: filled JSDoc gaps on a handful of exports.** `nowIso` / `metricRows`
  (`src/db.ts`), `startDispatcher` / `stopDispatcher` (`src/dispatcher.ts`),
  `startServer` (`src/server.ts`), and `getDirectory` / `getDirectoryByPath`
  (`src/directories.ts`) each gained the one-line `/** … */` the rest of the file
  uses, and `parseBlockedBy` (`src/tasks.ts`) now notes it's also reused to parse the
  identically-shaped `spawned_subtasks` column. Comment-only — no behavior change
  (CLEANUP C11).
- **The directory task-list endpoint now returns the parsed `taskView` shape.**
  `GET /api/directories/:id/tasks` previously returned raw DB rows, where
  `blocked_by` / `spawned_subtasks` were JSON-**string** columns and the
  server-computed blocker status (`blockerStates` / `deadBlockers`) was missing —
  so it disagreed with the single-task detail route, which returns the parsed
  shape, and the webapp had to defensively parse *either* form. The list now
  returns a `TaskListView` per task: the same enriched shape as the detail route,
  minus the `task.md`-derived `prompt` / `context` / `review_notes` and the
  duration `estimate` (the list / board / graph views don't need those, so it
  skips reading every `task.md` from disk). `blocked_by` / `spawned_subtasks` come
  back as real id arrays and each blocker's status is precomputed. The webapp's
  dual-shape parsing helper is gone. Pure refactor — every other row field is
  unchanged and the views render exactly as before (CLEANUP C8). See
  [SPEC.md §6.1](./SPEC.md#61-rest-api).
- **Internal: collapsible webapp panels now share one `collapsible()` helper**
  (`public/app.js`). The caret (▾ open / ▸ closed) + clickable head + toggle-body
  pattern was copied across the Finished section, the CI-output detail, the agent
  transcript, and the live-output panel — each re-wiring its own caret-glyph flip,
  open/closed class toggle, and localStorage persistence. That mechanic now lives
  once in `collapsible({ title, meta, body, open, persistKey, onToggle, … })`; each
  panel keeps its own body-fill / lazy-load / poll logic and just plugs in. No
  behavior change — the same panels open, close, persist, and lazy-load exactly as
  before (the diff-file cards keep their CSS-rotated caret and are intentionally
  left out). (CLEANUP C6).
- **The CI gate and the post-merge verify gate now share one build+test gate
  runner** (`src/gate.ts` `runGate`). The two gates had each re-implemented "spawn a
  build/test command in a cwd, bound it, collect combined output" and **drifted**: the
  in-worktree CI gate had flaky-retries but **no timeout** (an unbounded spawn), while
  the post-merge verify gate had a timeout but no retry. Both now spawn through the
  shared `runGate`, so the **CI gate inherits the same `BUTCHR_VERIFY_TIMEOUT_MS`
  kill-timer** verify already had — a hung `bun build`/`bun test` in the review gate is
  now bounded (a timed-out command counts as a FAIL) instead of leaking a process. The
  genuinely-different layers stay where they belong: CI keeps its build-vs-test badge
  parsing + flaky retry, verify keeps its skip-on-empty + revert-on-RED decision. Pure
  refactor otherwise — the pass/fail gate decision, retry policy, and revert behavior
  are unchanged (CLEANUP C3). See [SPEC.md §4](./SPEC.md#4-review--merge) /
  [§8](./SPEC.md#8-configuration).
- **Internal: task status transitions now flow through one `setStatus()` helper**
  (`src/tasks.ts`). The four-step transition skeleton — guarded `UPDATE` →
  `recordTaskEvent` (audit) → `updateTaskMdStatus` (mirror to task.md) → `emitUpdated`
  (SSE) — was hand-copied at ~a dozen sites, so a new transition that forgot a step
  could silently drop an audit entry, desync task.md, or leave the webapp stale. That
  spine now lives once in `setStatus(id, to, { from, note, set })`, and the core
  lifecycle transitions (queued→running, →review, →blocked, →aborted, →merged, the
  legacy finalize, auto-unblock, and re-queue) call it. No behavior change — the audit
  timeline, task.md mirror, and SSE events are identical (CLEANUP C1).
- **`exec.run()` gained an optional `timeoutMs` bound** (internal). The shared
  "shell out, never throw" helper can now kill a subprocess that exceeds a
  wall-clock deadline, resolving with a non-zero code, a `timedOut` flag, and a
  marker in `stderr`. The bound is opt-in and off by default, so existing callers
  are unaffected — this is groundwork that lets the CI gate share the same bounded
  runner the post-merge verify gate already uses (no user-facing behavior change).
- **Internal: collapsed herdr JSON-envelope parsing into one `herdrSoft()`
  helper** (`src/herdr.ts`). The six soft-failing herdr probes (`agentTabId`,
  `agentPaneId`, `agentTerminalId`, `paneTerminalId`, `paneList`, `agentRead`)
  each re-implemented the same run → check-ok → trim → `JSON.parse` →
  check-`error` → unwrap `result` block; that block now lives once in
  `herdrSoft()`, which returns `null` on any failure so each caller keeps just
  its own field-probe and default. No behavior change — purely removes the
  duplication so a future change to herdr's envelope shape lands in one place.
- **Config reads every `BUTCHR_*` var through the typed `env()` helpers.** The two
  remaining vars that read `process.env` directly (`BUTCHR_CTO_CONTEXT`,
  `BUTCHR_TERMINAL_CMD`) now go through `env(name, "")` like the rest of
  `config.ts`. Pure-internal refactor — behavior is identical (an empty/unset var
  still falls back to `""`).
- **Auto-rebase and auto-merge now share one conflict-collection helper.** The
  identical tail that both paths ran after a failed `git rebase` — gather the
  conflicting files (via `--diff-filter=U`, falling back to scraping git's text),
  abort the rebase, and decide whether the failure was a conflict — lived in two
  copies that had to be kept in sync by hand. It's now a single internal helper, so
  the conflict note handed back to the agent can't drift between the two paths.
  Pure-internal refactor; no behavior change.
- **Internal: per-task MCP tools now dispatch through a small registry.** The MCP
  server's `tools/call` if-ladder and per-tool extract-validate-wrap boilerplate
  (`src/mcp.ts`) were replaced with a single table of `{ def, plan?, run }` entries
  driving both a shared dispatcher and `tools/list` filtering. No behavior change —
  the same `request_review` / `propose_subtasks` / `ask` tools are exposed to the
  same tasks; this just makes adding a tool a one-line registry entry (CLEANUP C10).
- **Internal: the webapp's repeated UI scaffolds are now three shared helpers**
  (`public/app.js`). The directory picker and the new-task modal each hand-rolled
  the identical backdrop + Escape/backdrop-click-to-close boilerplate — that now
  lives once in `openModal()`. The five task-detail action buttons (re-queue,
  abort, roll back, approve, request-change) each repeated the same
  disable-button → call API → toast → restore-on-error dance, now owned by
  `action()`. And the per-view task badge cluster (status + conflict/plan/
  rolled-back chips) is built by one `taskChips()` so a chip's markup can't drift
  between the list, table, board, and detail views. Pure-internal refactor — each
  view renders exactly the same badges and each button behaves exactly as before
  (CLEANUP C5).

### Fixed
- **Merge-conflict kick-backs no longer thrash review → conflict → review.** When an
  approve (or a pre-dispatch rebase) hit a merge conflict, the note butchr sent the
  agent suggested resolving with `git merge <base>`. But butchr's merge gate
  **rebases** the branch onto the default tip, which discards that merge commit and
  replays the original conflicting commit — so the task re-conflicted on the next
  merge and bounced back to review repeatedly. The conflict note now instructs the
  agent to integrate by **`git rebase <base>`** (resolve + `--continue`) or
  **`git reset --soft <base>`** then re-commit, and explicitly warns against
  `git merge`, so the resolution survives the rebasing gate.

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
