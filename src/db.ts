// SQLite state. Per the spec, SQLite tracks only runtime state — task.md on
// disk is the source of truth for prompt/metadata. Everything here is derivable
// or re-syncable from the filesystem.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.ts";

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath, { create: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS directories (
  id              TEXT PRIMARY KEY,
  path            TEXT UNIQUE NOT NULL,
  label           TEXT,
  herdr_workspace TEXT,
  herdr_pane      TEXT,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  directory_id    TEXT NOT NULL REFERENCES directories(id) ON DELETE CASCADE,
  status          TEXT NOT NULL,            -- queued | running | review | merged | aborted
  herdr_pane_id   TEXT,
  output_snapshot TEXT,
  conflict        INTEGER NOT NULL DEFAULT 0,
  review_note     TEXT,
  created_at      TEXT NOT NULL,
  started_at      TEXT,
  completed_at    TEXT,
  merged_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_dir    ON tasks(directory_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

-- PER-TASK AUDIT TIMELINE: an append-only log of a task's status transitions. One
-- row per change (from_status -> to_status) with the wall-clock time and a short
-- human note explaining WHY it moved. Purely additive — nothing reads it to drive
-- behavior; it powers the task-detail timeline (see recordTaskEvent /
-- listTaskEvents below + server GET /api/tasks/:id/events). from_status is NULL for
-- the creation event. Cascade-deletes with its task (which only happens when a
-- directory is unregistered — merged tasks keep their rows + history).
CREATE TABLE IF NOT EXISTS task_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  at          TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  note        TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, at);

-- GLOBAL SETTINGS: a tiny key/value store for server-wide runtime state that must
-- survive a restart but isn't per-task and isn't a static env knob (which lives in
-- config.ts). Currently holds the DISPATCHER PAUSE flag ('dispatch_paused' =
-- '1'/'0') — see dispatcher.{isPaused,setPaused}. Read/written through
-- getSetting/setSetting below; persistence here is what keeps a pause in effect
-- across a butchr restart (it stays paused until explicitly resumed).
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// Lightweight forward migrations: add columns introduced after the initial
// schema. Guarded so existing databases upgrade in place without data loss.
function ensureColumn(table: string, column: string, decl: string): void {
  const cols = db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

// `summary` holds the agent's optional request_review summary (shown in review).
ensureColumn("tasks", "summary", "TEXT");

// `idle` flags a running task whose agent has gone quiet (no recent CLI output).
// It is orthogonal to `status` — only ever set while status='running' — much
// like `conflict` is orthogonal to status='review'. The dispatcher watcher owns
// it and clears it as soon as output resumes or the task leaves `running`.
ensureColumn("tasks", "idle", "INTEGER NOT NULL DEFAULT 0");

// `session_id` is the Claude Code session UUID butchr assigns to the agent at
// launch (`--session-id <uuid>`). It is what makes the review handshake durable:
// once set, butchr can re-launch the SAME session with full prior context via
// `claude --resume <session_id>` — used to hand a rejected task's notes back to
// the agent without holding a live, blocking process open. Persisted so it
// survives a butchr restart while a task waits in `review`.
ensureColumn("tasks", "session_id", "TEXT");

// `herdr_tab_id` is the dedicated herdr tab the task's agent runs in (one tab per
// task — see herdr.ts/dispatcher.ts). Unlike herdr_pane_id (positional, renumbers
// when sibling panes close), the tab id is a stable handle: teardown closes the
// whole tab so the agent dies and the tab disappears regardless of pane churn.
ensureColumn("tasks", "herdr_tab_id", "TEXT");

// Dispatch retry/backoff bookkeeping. A task whose dispatch() keeps throwing used
// to re-queue and hot-loop every tick forever, silently. These columns make the
// retry bounded and visible (see dispatcher.markDispatchFailure + tick gating):
//   - `dispatch_attempts` counts consecutive FAILED dispatch attempts; reset to 0
//     on a successful launch (markRunning) and on a fresh re-queue (reject /
//     reconcile / requeue), so it only ever reflects an unbroken run of failures.
//   - `last_dispatch_error` is the most recent dispatch failure message, surfaced
//     for the operator and carried onto a `failed` task.
//   - `next_dispatch_at` is an ISO timestamp: while set in the FUTURE the task is
//     waiting out a backoff and the tick loop must NOT dispatch it yet.
ensureColumn("tasks", "dispatch_attempts", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("tasks", "last_dispatch_error", "TEXT");
ensureColumn("tasks", "next_dispatch_at", "TEXT");

// `blocked_by` is a JSON-array TEXT column holding the ids of the tasks this task
// is BLOCKED ON (its dependency set). A task with any not-yet-merged blocker sits
// in status='blocked' (a pre-dispatch waiting state — no agent runs) until every
// blocker has merged, at which point it is promoted to 'queued' and dispatches
// normally. NULL / "[]" means no dependencies. We use a JSON column (not a join
// table) to stay consistent with the additive single-column migration pattern
// above. See tasks.ts (parseBlockedBy / reevaluateBlockedTask / setBlockedBy) and
// the dispatcher tick's auto-unblock pass.
ensureColumn("tasks", "blocked_by", "TEXT");

// CI GATE bookkeeping. When a task transitions to `review`, butchr asynchronously
// runs build + tests in that task's worktree and records the outcome here so the
// webapp can show a pass/fail badge in the review panel (before the diff):
//   - `ci_status` is 'running' while the build/test job is in flight, then 'pass'
//     or 'fail' once it settles; NULL means CI never ran for this task (e.g. it was
//     rescued to review with no worktree). It is orthogonal to `status` — only ever
//     meaningful while status='review' — much like `conflict`/`idle`.
//   - `ci_summary` is a short human-readable summary: the first line is a compact
//     badge label ("build + N tests" / "build failed" / "K test failures") and the
//     rest (if any) is a tail of the build/test output for the reviewer.
// See tasks.ts (triggerCi / runCi, fired from markReview / markReviewFromAgent).
ensureColumn("tasks", "ci_status", "TEXT");
ensureColumn("tasks", "ci_summary", "TEXT");

// SPEC-CONFORMANCE GATE bookkeeping. When a task enters `review`, butchr also runs
// an advisory read-only reviewer (a headless Claude — see src/conformance.ts) that
// judges whether the task's DIFF actually SATISFIES its PROMPT (complete + on-spec),
// so half-implemented / off-spec work is flagged before a human reads the diff. CI
// proves the task BUILDS + tests pass; this proves it did WHAT WAS ASKED — a
// complementary, orthogonal signal recorded here:
//   - `conformance_status` is 'checking' while the reviewer is in flight, then 'pass'
//     (conforms) or 'concern' (partial/off-spec/incomplete) once it settles; NULL
//     means it never ran or couldn't (no worktree, the gate disabled, a spawn error,
//     or an unparseable verdict — best-effort). Orthogonal to `status` — only ever
//     meaningful while status='review', like `ci_status`/`conflict`.
//   - `conformance_summary` is the reviewer's short reason naming any missing /
//     incomplete / off-spec parts (empty/"conforms" on a pass).
// ADVISORY ONLY — it never hard-blocks approval (mirrors the CI-fail warning). See
// tasks.ts (the triggerConformance hook in markReview / markReviewFromAgent).
ensureColumn("tasks", "conformance_status", "TEXT");
ensureColumn("tasks", "conformance_summary", "TEXT");

// `revert_reason` records WHY a task's merge was auto-reverted off the default
// branch: the post-merge verify gate (build + tests) came back RED, so the merge
// was undone (git reset to the pre-merge tip) and the task flagged. It holds the
// failing build/test output. Orthogonal to `status` — set alongside status='failed'
// so the dispatcher won't re-launch it and the reaper leaves its worktree/branch
// intact for inspection; its presence is what the webapp keys on to render a
// "reverted from main" panel (distinct from a dispatch failure). See
// tasks.approveTask's post-merge verify path. This is the POST-MERGE gate (repo
// root, blocking + auto-revert) — distinct from the CI gate above, which is the
// pre-merge, in-worktree, advisory review badge.
ensureColumn("tasks", "revert_reason", "TEXT");

// AUTO-DECOMPOSE / PLAN tasks. `kind` distinguishes an ordinary work task ('task',
// the default) from a PLAN task ('plan'). A plan task runs an agent like any other,
// but writes NO code: its job is to ANALYZE the request and propose a decomposition
// into sub-tasks, which it submits through the per-task MCP `propose_subtasks` tool.
// butchr validates the proposed dependency graph (reusing wouldCreateCycle), creates
// the sub-tasks (wiring their blocked_by among themselves), records their ids on the
// plan task in `spawned_subtasks` (a JSON-array TEXT column), and completes the plan
// task (terminal `merged`, since nothing is merged to a branch). The webapp keys on
// `kind`/`spawned_subtasks` to badge a plan task and link the sub-tasks it spawned.
// See tasks.proposeSubtasks / mcp.ts (propose_subtasks) / taskmd.renderAgentPrompt.
ensureColumn("tasks", "kind", "TEXT NOT NULL DEFAULT 'task'");
ensureColumn("tasks", "spawned_subtasks", "TEXT");

// AUTO-MERGE bookkeeping. Set to 1 when butchr auto-approved + merged this task
// (CI-green + low-risk) instead of a human approving it — see config.autoMergeEnabled
// and tasks.maybeAutoMerge. Orthogonal to `status`: it records HOW a merged task
// landed (auto vs human), and the webapp can badge auto-merged tasks. Only ever set
// once a merge actually succeeds (a conflict/revert never sets it).
ensureColumn("tasks", "auto_merged", "INTEGER NOT NULL DEFAULT 0");

// One-click rollback bookkeeping. When a task merges, we record the SHAs that
// bracket the commits it landed on the default branch so the merge can later be
// reverted precisely:
//   - `merge_base_sha` is the base tip BEFORE the fast-forward (exclusive lower
//     bound); `merged_sha` is the new tip AFTER it (inclusive upper bound). The
//     task's commits are exactly `merge_base_sha..merged_sha`.
//   - `rolled_back_at` is an ISO timestamp set when the operator rolls the task
//     back (POST /api/tasks/:id/rollback): the task stays `merged` (its branch
//     did land) but is flagged as undone via revert commits on the default branch.
// Tasks merged before this feature have NULL SHAs and cannot be rolled back
// automatically (see tasks.rollbackTask).
ensureColumn("tasks", "merge_base_sha", "TEXT");
ensureColumn("tasks", "merged_sha", "TEXT");
ensureColumn("tasks", "rolled_back_at", "TEXT");

// PER-TASK MODEL + TOKEN/COST accounting.
//   - `model` is the model alias/name the task REQUESTED at creation (e.g. 'opus',
//     'sonnet', 'haiku', or a full 'claude-*' id). NULL means "unset" → the launch
//     command threads no --model flag and claude uses its current default. Validated
//     at creation (tasks.validateModel) and threaded into the agent launch via the
//     `{{MODEL_FLAG}}` placeholder (config.agentCmd/resumeCmd, dispatcher.resolveLaunchCommand).
//   - `model_used` is the model the agent ACTUALLY ran under, read back from the
//     Claude Code session transcript (usage.ts). Useful when `model` is unset (shows
//     what the default resolved to) or to confirm the requested model took effect.
//   - The `usage_*_tokens` columns hold cumulative token counts for the session,
//     summed across every assistant turn in the transcript (input, output, and the
//     two cache buckets). Captured on the review/merge transition (tasks.captureSessionUsage).
//   - `cost_usd` is a placeholder: Claude Code's session transcript records token
//     usage but NOT a dollar cost, and butchr ships no per-model pricing table, so
//     we do NOT fabricate a number. The column exists for when a cost source is
//     wired up (TODO: derive from usage_* tokens × a model pricing table, or read it
//     if a future claude exposes costUSD in the transcript). It stays NULL for now.
ensureColumn("tasks", "model", "TEXT");
ensureColumn("tasks", "model_used", "TEXT");
ensureColumn("tasks", "usage_input_tokens", "INTEGER");
ensureColumn("tasks", "usage_output_tokens", "INTEGER");
ensureColumn("tasks", "usage_cache_read_tokens", "INTEGER");
ensureColumn("tasks", "usage_cache_creation_tokens", "INTEGER");
ensureColumn("tasks", "cost_usd", "REAL");

// DURATION-ESTIMATE FOOTPRINT. Two cheap signals captured WHEN A TASK ENTERS REVIEW
// (while its worktree still exists), used to bucket the task for the rough
// duration-estimate model (see src/estimate.ts):
//   - `diff_lines` is the task's final changed-line count (added + deleted vs the
//     default branch, from git.diffStat) → its SIZE bucket (small/medium/large).
//   - `path_type` is a coarse path-based TYPE ('docs'/'webapp'/'core'/'mixed')
//     derived from the changed file set (estimate.classifyPathType).
// Both are NULL for tasks that never reached review / predate this feature; such
// tasks only feed the overall-pool estimate, never a size/type bucket. Captured by
// tasks.captureDiffFootprint (best-effort, re-captured on each review transition so
// a rework's final footprint wins). Orthogonal to `status`. See SPEC.md §10.
ensureColumn("tasks", "diff_lines", "INTEGER");
ensureColumn("tasks", "path_type", "TEXT");

// `tags` is a JSON-array TEXT column holding a task's free-form LABELS — short
// strings the operator attaches at creation to organize a growing task list
// (e.g. "webapp", "core", "docs", "spike"). Purely organizational: nothing in the
// dispatch/review/merge machinery reads them; they exist to be filtered on (the
// webapp filter bar + the CLI `ls --tag`) and shown as chips. Settable only at
// creation for now. NULL / "[]" means no tags. A JSON column (not a join table)
// keeps it consistent with the additive single-column pattern used by `blocked_by`
// / `spawned_subtasks` above. See tasks.ts (parseTags / normalizeTags) — surfaced
// as a real string[] on the serialized TaskView, and round-tripped in task.md's
// front matter (taskmd.ts).
ensureColumn("tasks", "tags", "TEXT");

export type DirectoryRow = {
  id: string;
  path: string;
  label: string | null;
  herdr_workspace: string | null;
  herdr_pane: string | null;
  created_at: string;
};

// `finalizing` is a legacy transient state from the old blocking-agent model. It
// is no longer produced; the union keeps it only so startup migration can flush
// any leftover `finalizing` rows from a pre-redesign database (see
// recoverFinalizingTasks in tasks.ts).
//
// `failed` is the dispatch give-up state: a task whose dispatch() failed
// MAX_DISPATCH_ATTEMPTS times in a row. It is NOT active (the dispatcher stops
// retrying it) and is terminal-ish — it only leaves via the operator's
// POST /api/tasks/:id/requeue escape hatch (see tasks.requeueTask), which resets
// the retry state and puts it back to `queued`.
//
// `blocked` is a pre-dispatch WAITING state: the task has one or more blocker
// tasks (see `blocked_by`) that have not all merged yet. It behaves like `queued`
// EXCEPT the dispatcher never launches an agent for it; it is promoted to `queued`
// the moment every blocker has merged (auto-unblock — see the dispatcher tick and
// tasks.reevaluateBlockedTask). It is non-terminal and groups with active/pending
// work in the webapp; the reaper must NOT treat it as terminal.
// A task's KIND: an ordinary work task, or a PLAN task whose job is to decompose a
// request into sub-tasks (see the `kind` column comment above + tasks.proposeSubtasks).
export type TaskKind = "task" | "plan";

export type TaskStatus =
  | "queued"
  | "blocked"
  | "running"
  | "review"
  | "finalizing"
  | "merged"
  | "rejected"
  | "aborted"
  | "failed";

export type TaskRow = {
  id: string;
  directory_id: string;
  status: TaskStatus;
  herdr_pane_id: string | null;
  session_id: string | null;
  herdr_tab_id: string | null;
  output_snapshot: string | null;
  conflict: number;
  idle: number;
  review_note: string | null;
  summary: string | null;
  dispatch_attempts: number;
  last_dispatch_error: string | null;
  next_dispatch_at: string | null;
  // Build/test failure output when this task's merge was auto-reverted off the
  // default branch by the post-merge verify gate (null otherwise). See approveTask.
  revert_reason: string | null;
  // Raw JSON-array TEXT of blocker task ids (or null). Parsed via
  // tasks.parseBlockedBy; surfaced as a real string[] on the serialized TaskView.
  blocked_by: string | null;
  // Raw JSON-array TEXT of free-form organizational LABELS (or null). Parsed via
  // tasks.parseTags; surfaced as a real string[] on the serialized TaskView. Set
  // at creation; filtered on in the webapp + CLI. See the `tags` column comment.
  tags: string | null;
  // CI GATE: build/test outcome captured on the review transition (see tasks.ts).
  // `ci_status` is 'running' | 'pass' | 'fail' | null; `ci_summary` carries a short
  // badge label on its first line plus an output tail. Surfaced on TaskView via the
  // `...row` spread (no extra plumbing in taskView).
  ci_status: string | null;
  ci_summary: string | null;
  // SPEC-CONFORMANCE GATE: advisory verdict on whether the diff satisfies the prompt,
  // captured on the review transition (see the ensureColumn block above +
  // src/conformance.ts). `conformance_status` is 'checking' | 'pass' | 'concern' | null;
  // `conformance_summary` carries the reviewer's short reason. Surfaced on TaskView via
  // the `...row` spread (no extra plumbing in taskView), like ci_status/ci_summary.
  conformance_status: string | null;
  conformance_summary: string | null;
  // Rollback bookkeeping (see the ensureColumn block above): the SHAs bracketing
  // the commits this task landed (`merge_base_sha..merged_sha`) and the time the
  // task was rolled back, if ever.
  merge_base_sha: string | null;
  merged_sha: string | null;
  rolled_back_at: string | null;
  // AUTO-MERGE: 1 when butchr auto-merged this task (CI-green + low-risk), else 0.
  // Surfaced on TaskView via the `...row` spread. See tasks.maybeAutoMerge.
  auto_merged: number;
  // AUTO-DECOMPOSE: 'task' (default) or 'plan'. A plan task decomposes a request
  // into sub-tasks. `spawned_subtasks` is the raw JSON-array TEXT of the sub-task
  // ids a plan task created (null for ordinary tasks / before it ran). Parsed via
  // tasks.parseBlockedBy and surfaced as a string[] on TaskView. See above.
  kind: TaskKind;
  spawned_subtasks: string | null;
  // PER-TASK MODEL + TOKEN/COST (see the ensureColumn block above). `model` is the
  // requested model (null = default); `model_used` is what the transcript shows ran;
  // the `usage_*_tokens` are cumulative session token counts; `cost_usd` is a
  // deliberately-unfabricated placeholder (null — no cost source yet). Surfaced on
  // TaskView via the `...row` spread (no extra plumbing in taskView).
  model: string | null;
  model_used: string | null;
  usage_input_tokens: number | null;
  usage_output_tokens: number | null;
  usage_cache_read_tokens: number | null;
  usage_cache_creation_tokens: number | null;
  cost_usd: number | null;
  // DURATION-ESTIMATE FOOTPRINT (see the ensureColumn block above + src/estimate.ts):
  // `diff_lines` is the final changed-line count and `path_type` the coarse
  // path-based type, both captured on the review transition and used to bucket the
  // task for its rough duration estimate. NULL until/unless a footprint was captured.
  diff_lines: number | null;
  path_type: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  merged_at: string | null;
};

/** Current wall-clock time as an ISO-8601 string — the canonical timestamp format for all task/db columns. */
export function nowIso(): string {
  return new Date().toISOString();
}

// ---- FULL-TEXT TASK SEARCH (predicate) ------------------------------------
// The matching primitive behind server-side `?q=` task search (the directory
// task-list endpoint + CLI `ls --search`). A task's searchable text — its prompt
// and review notes (from task.md on disk) plus its DB summary / review_note and id
// — is assembled in tasks.ts (taskSearchText) and tested here against this
// predicate. Case-insensitive substring match; a blank/whitespace query matches
// everything (no filter), so callers can pass an unset `q` through unconditionally.
export function matchesQuery(haystack: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return haystack.toLowerCase().includes(needle);
}

// ---- GLOBAL SETTINGS (key/value runtime state) ----------------------------
// Read a server-wide setting, or null if it was never set. Used for runtime state
// that must persist across restarts but isn't per-task or a static env knob (e.g.
// the dispatcher pause flag — see dispatcher.isPaused).
export function getSetting(key: string): string | null {
  const row = db
    .query<{ value: string }, [string]>(`SELECT value FROM settings WHERE key=?`)
    .get(key);
  return row ? row.value : null;
}

// Upsert a server-wide setting. Single-row write, never throws by design — the
// caller treats settings as best-effort durable state.
export function setSetting(key: string, value: string): void {
  db.query(
    `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
  ).run(key, value);
}

// ---- PER-TASK AUDIT TIMELINE ----------------------------------------------
// A row in the task_events log: one status transition for one task.
export type TaskEventRow = {
  id: number;
  task_id: string;
  at: string;
  from_status: string | null;
  to_status: string;
  note: string | null;
};

/**
 * Append a status-transition event for a task. Called from the status-setting
 * functions in tasks.ts AFTER the row's status actually changed (so the log only
 * ever reflects real transitions). `from` is null for the creation event. Cheap,
 * non-throwing-by-design single INSERT — never gate a status change on it.
 */
export function recordTaskEvent(
  taskId: string,
  from: string | null,
  to: string,
  note?: string | null,
): void {
  db.query(
    `INSERT INTO task_events (task_id, at, from_status, to_status, note)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(taskId, nowIso(), from, to, note ?? null);
}

/** The full transition timeline for a task, oldest → newest. */
export function listTaskEvents(taskId: string): TaskEventRow[] {
  return db
    .query<TaskEventRow, [string]>(
      `SELECT id, task_id, at, from_status, to_status, note
         FROM task_events WHERE task_id=? ORDER BY at ASC, id ASC`,
    )
    .all(taskId);
}

// ---- METRICS (read-only aggregation) --------------------------------------
// Powers the webapp's Metrics view. A single SELECT pulls just the columns the
// aggregation needs (metricRows), and computeMetrics() turns the raw rows into
// dashboard aggregates with NO DB access — so the aggregation is unit-testable
// against synthetic rows and `now`. Timestamp semantics (see tasks.ts):
//   started_at   — running transition (agent launched)
//   completed_at — running→review transition (work submitted for review)
//   merged_at    — merged into the default branch
// so started→review uses (started_at, completed_at) and started→merge uses
// (started_at, merged_at). The orthogonal flags (conflict/ci_status) reflect a
// task's CURRENT row state, not its full history — they can be cleared as a task
// moves on — so the derived rates are best-effort snapshots (surfaced as such).

// Columns the metrics aggregation reads; nothing else is fetched.
export type MetricRow = {
  status: string;
  started_at: string | null;
  completed_at: string | null;
  merged_at: string | null;
  conflict: number;
  auto_merged: number;
  revert_reason: string | null;
  ci_status: string | null;
};

/** Fetch the raw per-task rows the metrics aggregation needs; computeMetrics() turns them into dashboard aggregates with no further DB access. */
export function metricRows(): MetricRow[] {
  return db
    .query<MetricRow, []>(
      `SELECT status, started_at, completed_at, merged_at,
              conflict, auto_merged, revert_reason, ci_status
         FROM tasks`,
    )
    .all();
}

// ---- DURATION ESTIMATES (raw rows for the estimator) ----------------------
// The columns the estimate model reads (see src/estimate.ts). `blocked_by` comes
// back as the raw JSON-array TEXT; the caller (tasks.estimateInputRows) parses it
// into a string[] before handing rows to the pure estimator.
export type EstimateRowRaw = {
  id: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  merged_at: string | null;
  diff_lines: number | null;
  path_type: string | null;
  blocked_by: string | null;
};

export function estimateRows(): EstimateRowRaw[] {
  return db
    .query<EstimateRowRaw, []>(
      `SELECT id, status, started_at, completed_at, merged_at,
              diff_lines, path_type, blocked_by
         FROM tasks`,
    )
    .all();
}

// A rate plus its raw numerator/denominator, so the UI can show "12% (3/25)" and
// distinguish a real 0% from "no data yet" (rate=null when the denominator is 0).
export type Rate = { rate: number | null; num: number; of: number };
export type Median = { medianMs: number | null; count: number };

export type Metrics = {
  total: number;
  byStatus: Record<string, number>;
  throughput: {
    days: number;
    perDay: { date: string; count: number }[]; // oldest → newest, length === days
    windowMerged: number; // merged within the window
    totalMerged: number; // merged all-time (status='merged')
  };
  timeToReview: Median; // started_at → completed_at
  timeToMerge: Median; // started_at → merged_at
  conflictRate: Rate; // conflict=1 over dispatched (started_at set)
  revertRate: Rate; // revert_reason set over (merged + reverted) merge attempts
  ciPassRate: Rate; // ci_status='pass' over (pass + fail) settled CI runs
  autoMergeRate: Rate; // auto_merged=1 over merged tasks
};

const DAY_MS = 86_400_000;

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

// Positive ms span between two ISO timestamps; null if either is missing or the
// span is non-positive (same instant / clock skew — not a meaningful duration).
function spanMs(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

function rate(num: number, of: number): Rate {
  return { rate: of > 0 ? num / of : null, num, of };
}

// Pure: derive dashboard aggregates from raw rows + the current time. `days` is
// the throughput window length (UTC-day buckets, oldest → newest).
export function computeMetrics(rows: MetricRow[], nowMs: number, days = 14): Metrics {
  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;

  // Throughput: merged tasks bucketed by UTC day across the last `days` days.
  // ISO timestamps are UTC ('…Z'), so the first 10 chars are the UTC date.
  const perDay: { date: string; count: number }[] = [];
  const dayIdx = new Map<string, number>();
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(nowMs - i * DAY_MS).toISOString().slice(0, 10);
    dayIdx.set(date, perDay.length);
    perDay.push({ date, count: 0 });
  }
  let windowMerged = 0;
  for (const r of rows) {
    if (!r.merged_at) continue;
    const at = dayIdx.get(r.merged_at.slice(0, 10));
    if (at !== undefined) {
      perDay[at]!.count++;
      windowMerged++;
    }
  }

  const toReview: number[] = [];
  const toMerge: number[] = [];
  let started = 0;
  let conflicts = 0;
  let reverted = 0;
  let ciPass = 0;
  let ciFail = 0;
  let autoMerged = 0;
  for (const r of rows) {
    if (r.started_at) started++;
    if (r.conflict) conflicts++;
    if (r.revert_reason) reverted++;
    if (r.ci_status === "pass") ciPass++;
    else if (r.ci_status === "fail") ciFail++;
    if (r.auto_merged) autoMerged++;
    const tr = spanMs(r.started_at, r.completed_at);
    if (tr !== null) toReview.push(tr);
    const tm = spanMs(r.started_at, r.merged_at);
    if (tm !== null) toMerge.push(tm);
  }
  const merged = byStatus.merged ?? 0;

  return {
    total: rows.length,
    byStatus,
    throughput: { days, perDay, windowMerged, totalMerged: merged },
    timeToReview: { medianMs: median(toReview), count: toReview.length },
    timeToMerge: { medianMs: median(toMerge), count: toMerge.length },
    conflictRate: rate(conflicts, started),
    // A revertedOnRed task ends `failed` (carrying revert_reason), so it is NOT in
    // the merged count — merge attempts that landed (if only briefly) are
    // merged + reverted.
    revertRate: rate(reverted, merged + reverted),
    ciPassRate: rate(ciPass, ciPass + ciFail),
    autoMergeRate: rate(autoMerged, merged),
  };
}

// NOTE: there is deliberately no blind "running → queued" recovery here. A task
// left `running` after a restart still has a live herdr agent whose name is taken;
// re-queuing it just makes the dispatcher collide on `agent_name_taken`. Startup
// reconciliation (dispatcher.reconcileRunningTasks, wired in index.ts) instead
// re-adopts the live agent or rescues a dead one.
