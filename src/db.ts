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
  // CI GATE: build/test outcome captured on the review transition (see tasks.ts).
  // `ci_status` is 'running' | 'pass' | 'fail' | null; `ci_summary` carries a short
  // badge label on its first line plus an output tail. Surfaced on TaskView via the
  // `...row` spread (no extra plumbing in taskView).
  ci_status: string | null;
  ci_summary: string | null;
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
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  merged_at: string | null;
};

export function nowIso(): string {
  return new Date().toISOString();
}

// NOTE: there is deliberately no blind "running → queued" recovery here. A task
// left `running` after a restart still has a live herdr agent whose name is taken;
// re-queuing it just makes the dispatcher collide on `agent_name_taken`. Startup
// reconciliation (dispatcher.reconcileRunningTasks, wired in index.ts) instead
// re-adopts the live agent or rescues a dead one.
