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
  status          TEXT NOT NULL,            -- CANONICAL 9-state model: idea | spec_review | blocked | needs_info | in_progress | in_review | finalizing | merged | aborted (see TaskStatus / STATE_META)
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

// MANAGED CTO AGENT (PER-DIRECTORY). butchr runs ONE CTO agent per registered
// directory (repo), in that repo's ROOT — a FIRST-CLASS, butchr-launched,
// channel-connected Claude session, like a workspace agent but with NO worktree/
// branch/review/merge. Each directory's runtime handles live in their OWN row, keyed
// by directory_id with a FK cascade so a directory's CTO state dies with the
// directory. (This SUPERSEDES the old GLOBAL SINGLETON table keyed by the literal id
// 'singleton'; the migration below drops that shape — pre-1.0, destroying the old
// singleton row is fine.)
//   - session_id: the Claude Code session UUID, RESUMED (--resume) on every
//     supervised relaunch + boot-adopt so the CTO never cold-starts (see src/cto-agent.ts).
//   - herdr_pane_id / herdr_tab_id / herdr_workspace: its live herdr handles (the
//     pane backs the Open-CTO-terminal attach; positional pane ids may renumber).
//   - desired: 1 when the operator/boot wants it UP (supervisor relaunches on death),
//     0 when explicitly stopped (supervisor leaves it down -- survives a restart).
//   - restarts: count of supervised relaunches since the last fresh start.
//   - last_error: most recent launch/supervision failure, surfaced to the operator.
// The per-directory ENABLE flag is the `directories.cto_enabled` column (NULL =
// inherit the global default config.ctoAgentEnabled, 1 = on, 0 = off — see below),
// not a column here, so a directory can be enabled before its first launch.
function migrateCtoAgentPerDirectory(): void {
  const cols = db
    .query<{ name: string }, []>(`PRAGMA table_info(cto_agent)`)
    .all();
  // An existing table with no `directory_id` column is the OLD singleton shape — drop
  // it (pre-1.0: the priority is "works forward"; the old singleton row is discarded).
  if (cols.length > 0 && !cols.some((c) => c.name === "directory_id")) {
    db.exec(`DROP TABLE cto_agent`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS cto_agent (
      directory_id    TEXT PRIMARY KEY REFERENCES directories(id) ON DELETE CASCADE,
      session_id      TEXT,
      herdr_pane_id   TEXT,
      herdr_tab_id    TEXT,
      herdr_workspace TEXT,
      desired         INTEGER NOT NULL DEFAULT 0,
      started_at      TEXT,
      restarts        INTEGER NOT NULL DEFAULT 0,
      last_error      TEXT,
      updated_at      TEXT
    );
  `);
}
migrateCtoAgentPerDirectory();

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

// PER-DIRECTORY BUILD/TEST GATE COMMAND. The CI gate (pre-merge, in a task's
// worktree) and the post-merge verify gate (repo root) both need a build/test
// command to run. Historically both were hardcoded to butchr's OWN commands
// (`bun build … && bun test`). This column lets each registered directory carry its
// OWN gate command so other projects (e.g. a 'sandbox' repo) define their own
// build/test, threaded into both gates. Semantics: NULL means "use the default"
// (`config.verifyCmd`, which still defaults to butchr's own command — the
// dogfooding setup); a non-null value (including the empty string, which DISABLES
// the gate for that directory) is used verbatim. Resolved by
// directories.directoryGateCmd and run via `bash -lc` in the relevant cwd. Settable
// at register time and updatable via PATCH /api/directories/:id.
ensureColumn("directories", "gate_cmd", "TEXT");

// PER-DIRECTORY CTO-AGENT ENABLE. The managed CTO agent is now ONE PER DIRECTORY (it
// runs in the repo root and IS that project's principal/dev agent — see the cto_agent
// table). This column is that directory's master switch for boot auto-start +
// crash supervision: NULL (the default every existing row backfills to) means "inherit
// the GLOBAL default" config.ctoAgentEnabled (itself DEFAULT OFF); 1 forces it ON, 0
// forces it OFF — so a directory's own setting WINS over the global default. Resolved
// by cto-agent.isCtoEnabled; settable via PATCH /api/directories/:id. (The on-demand
// /api/directories/:id/cto/* endpoints still work regardless, so an operator can start
// one even when boot-auto-start is off.)
ensureColumn("directories", "cto_enabled", "INTEGER");

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

// Merge-range bookkeeping. When a task merges, we record the SHAs that bracket the
// commits it landed on the default branch:
//   - `merge_base_sha` is the base tip BEFORE the fast-forward (exclusive lower
//     bound); `merged_sha` is the new tip AFTER it (inclusive upper bound). The
//     task's commits are exactly `merge_base_sha..merged_sha`.
// Rollback is a deliberate TASK now (created from the `rollback` template via the
// webapp's "Roll back" button — see src/templates.ts), not a mechanical revert, so
// these SHAs let that button pre-fill the exact commit to revert. Tasks merged
// before this feature have NULL SHAs (the button is hidden for them).
ensureColumn("tasks", "merge_base_sha", "TEXT");
ensureColumn("tasks", "merged_sha", "TEXT");

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

// AWAITING-INPUT HANDSHAKE. When a running agent calls the MCP `ask` tool, butchr
// records its clarifying question and parks the task in status='awaiting_input'
// (the agent returns immediately and exits — no live process, exactly like the
// non-blocking review handshake). Whoever operates answers through ONE unified
// surface (API / CLI / webapp), and butchr re-launches the SAME Claude session via
// `--resume` with the answer injected (mirroring reject→resume):
//   - `question` is the agent's pending question, surfaced while status='awaiting_input'
//     (webapp answer box + /health needsAttention). Cleared when the question is answered.
//   - `answer` is the operator's answer, held transiently for the resume dispatch to
//     inject into the prompt, then consumed (cleared) the moment the agent re-launches
//     (markRunning). Orthogonal to `status`. See tasks.markAwaitingInputFromAgent /
//     tasks.answerTask / dispatcher.dispatch (the answer-resume prompt).
ensureColumn("tasks", "question", "TEXT");
ensureColumn("tasks", "answer", "TEXT");

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
// a rework's final footprint wins). Orthogonal to `status`. See src/estimate.ts.
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

// PER-TASK DISPATCH PRIORITY. Higher = dispatched sooner: the dispatcher's queued
// selection orders by `priority DESC, created_at ASC`, so a high-priority task
// JUMPS the queue ahead of older lower-priority ones while ties stay FIFO (see
// dispatcher.selectQueuedForDispatch). Default 0 (the baseline every existing row
// backfills to); a negative value pushes a task LATER than the default. Set at
// creation (API/CLI/webapp) and updatable any time via POST /api/tasks/:id/priority
// (tasks.setPriority). Orthogonal to `status` — it only affects the order `queued`
// tasks dispatch in; it is ignored once a task is running/terminal.
ensureColumn("tasks", "priority", "INTEGER NOT NULL DEFAULT 0");

// PLAN-PREVIEW GATE. 1 when a task opts into the plan-preview gate, else 0 (the
// default every existing row backfills to). A plan-preview task does NOT decompose
// like a `kind='plan'` task (it is an ordinary work task that writes code) — instead
// its FIRST dispatch renders a prompt that instructs the agent to submit a concise
// implementation PLAN via the MCP `propose_plan` tool and STOP, parking the task in
// `awaiting_input` (reusing the ASK handshake) holding the plan. The operator reviews
// the plan and answers 'proceed' or steering notes; butchr re-launches the SAME
// session via `--resume` with the decision and the agent then implements + calls
// request_review as normal. Orthogonal to `kind` and `status`. Set only at creation
// (API/CLI/webapp). See tasks.createTask / mcp.ts (propose_plan) /
// taskmd.renderAgentPrompt's plan-preview protocol.
ensureColumn("tasks", "plan_preview", "INTEGER NOT NULL DEFAULT 0");

// RESUME RE-GROUNDING FINGERPRINT. A sha256 over the task's PROMPT + CONTEXT-FILE LIST
// (taskmd.groundingFingerprint), recorded by markRunning every time butchr GROUNDS an
// agent — i.e. launches it carrying the full prompt+context: a fresh first launch, or a
// re-grounded resume. A resume re-enters the SAME `claude --resume` session, which still
// holds the prompt+context the agent saw when last grounded, so its focused answer/rework
// message normally restates none of it. But the broadened `raise` tool lets an operator
// EDIT a paused task's prompt/context (or it can change for any reason) while the agent
// waits in needs_info / in_review; on resume the dispatcher compares this stored
// fingerprint against the CURRENT task.md and, on a mismatch, prepends the updated
// definition (taskmd.renderRegroundBlock) so the resumed agent re-grounds in the current
// task rather than the stale snapshot in its session. Review notes are deliberately NOT
// part of the fingerprint — they already flow into the rework prompt. NULL for a task
// never grounded (or paused before this column existed) — treated as a mismatch, so the
// next resume re-grounds once, which is safe. Orthogonal to `status`.
ensureColumn("tasks", "grounding_fp", "TEXT");

// UNIFY TASK STATE — fold out the retracted idea→spec→build `stage` axis. An earlier
// design (task playful-rabbit-0405) carried a SECOND axis (`stage` = idea|spec|build)
// orthogonal to `status`; the CEO retracted it as over-complicated. The idea-vs-rest
// distinction is now carried by the SINGLE status pipeline via a new FRONT state,
// `idea` — a task that has NO spec yet, whose dispatch RUNS the CTO-fork spec generator
// (see src/cto.ts + dispatcher) and then advances to `queued` ('ready') carrying the
// generated spec as its prompt. The `stage` column is no longer written or read.
//
// MIGRATION (backward-compatible, one-time): any task still in the PRE-SPEC idea stage
// (stage='idea' and not yet dispatched — queued/blocked) becomes status='idea'; every
// other row keeps its current status untouched (a `build` task is exactly today's flow;
// a mid-flight idea/spec task in running/review just finishes through the normal
// running→review→merged transitions). Guarded on the column still existing, so a fresh
// DB (which never had a stage axis) skips it. We deliberately do NOT drop the column —
// an old DB keeps it orphaned (it defaults 'build' on inserts that omit it) rather than
// risk a destructive ALTER on the core tasks table.
export function migrateStageAxisToStatus(): void {
  const cols = db
    .query<{ name: string }, []>(`PRAGMA table_info(tasks)`)
    .all();
  if (!cols.some((c) => c.name === "stage")) return; // fresh DB — never had a stage axis
  db.exec(
    `UPDATE tasks SET status='idea' WHERE stage='idea' AND status IN ('queued','blocked')`,
  );
}
migrateStageAxisToStatus();

// CANONICAL STATE-MODEL MIGRATION (one-time, forward-only). The status set was
// replaced by the CEO's canonical 9-state model (see TaskStatus / STATE_META).
// The OLD status values fold into the new ones (pre-1.0 — migrate/destroy freely;
// priority = works forward):
//   queued        → in_progress  (ready — a build task with no live agent yet; the
//                                  ready-vs-running distinction is now carried by
//                                  herdr_pane_id being NULL vs set, not by status)
//   running       → in_progress  (a live build agent — keeps its pane)
//   review        → in_review
//   awaiting_input→ needs_info
//   rejected      → aborted       (no `rejected` state — request-changes loops back)
//   failed        → aborted       (a dispatch/finalize give-up maps to an idle state)
// idea / spec_review / blocked / needs_info / in_progress / in_review / finalizing /
// merged / aborted are already canonical and untouched. Runs every boot but is a
// no-op once converged (no old values remain). We do NOT rewrite task_events history
// (from_status/to_status are an immutable audit log of what actually happened).
export function migrateStatusModel(): void {
  const renames: [string, string][] = [
    ["queued", "in_progress"],
    ["running", "in_progress"],
    ["review", "in_review"],
    ["awaiting_input", "needs_info"],
    ["rejected", "aborted"],
    ["failed", "aborted"],
  ];
  for (const [from, to] of renames) {
    db.query(`UPDATE tasks SET status=? WHERE status=?`).run(to, from);
  }
}
migrateStatusModel();

export type DirectoryRow = {
  id: string;
  path: string;
  label: string | null;
  herdr_workspace: string | null;
  herdr_pane: string | null;
  // Per-directory build/test gate command (see the ensureColumn above). NULL = use
  // the default (config.verifyCmd); a non-null value (incl. "" to disable) is used
  // verbatim by both the CI gate and the post-merge verify gate for this directory.
  gate_cmd: string | null;
  // Per-directory CTO-agent enable (see the cto_enabled ensureColumn above). NULL =
  // inherit the global default config.ctoAgentEnabled; 1 = on; 0 = off. Resolved by
  // cto-agent.isCtoEnabled (per-directory WINS over the global default).
  cto_enabled: number | null;
  created_at: string;
};

// A task's KIND: an ordinary work task, or a PLAN task whose job is to decompose a
// request into sub-tasks (see the `kind` column comment above + tasks.proposeSubtasks).
export type TaskKind = "task" | "plan";

// ===========================================================================
// THE CANONICAL TASK STATE MACHINE (the CEO's exact model).
// ===========================================================================
// Every task is in exactly one of NINE states. Each state has a KIND — one of three
// kinds — and an AGENT state additionally has a TYPE (which agent runs it):
//
//   KIND      meaning
//   --------  ----------------------------------------------------------------
//   idle      no agent is running and butchr awaits nothing from the operator —
//             the task is either terminal or waiting on something mechanical.
//   agent     an agent is (or is about to be) running for this task.
//   feedback  butchr has surfaced an ARTIFACT and is awaiting an OPERATOR response.
//
//   AGENT TYPE     which agent
//   -------------  -------------------------------------------------------------
//   ceo-agent      the headless, read-only CTO-fork (src/cto.ts) that writes specs.
//   workspace-agent the interactive agent that builds the code in the worktree.
//
// THE 9 STATES (happy path: idea → spec_review → in_progress → in_review →
// finalizing → merged; needs_info is an ad-hoc feedback stage ANY agent state can
// enter and then resume):
//
//   idea         agent/ceo-agent     — the CEO agent writes the SPEC from the brief.
//   spec_review  feedback (spec)      — operator approves → in_progress, or requests
//                                       changes → revise the spec (back to idea).
//   blocked      idle                 — waiting on blocked_by dependencies.
//   needs_info   feedback (question)  — an agent asked the operator a question; on
//                                       /answer the agent resumes.
//   in_progress  agent/workspace-agent— the workspace agent builds the code.
//   in_review    feedback (diff)      — operator approves → finalizing, or requests
//                                       changes → resume the workspace agent.
//   finalizing   agent/workspace-agent— the workspace agent does post-approval
//                                       'final thoughts'; then the system finalizes
//                                       (rebase + post-merge-verify) → merged.
//   merged       idle (terminal)      — landed on the default branch.
//   aborted      idle (terminal)      — discarded (operator abort, or a dispatch /
//                                       finalize give-up, or a post-merge revert).
//
// NOTE on the ready-vs-running distinction: there is NO separate `queued`/`running`
// status. A task in `in_progress` (or `finalizing`) whose `herdr_pane_id` is NULL is
// READY — the dispatcher will (re-)launch its agent; one whose `herdr_pane_id` is set
// has a LIVE agent. This is restart-safe (the pane field is persisted) and is the
// single internal signal the dispatcher/reconcile/watcher key off.
export type TaskStatus =
  | "idea"
  | "spec_review"
  | "blocked"
  | "needs_info"
  | "in_progress"
  | "in_review"
  | "finalizing"
  | "merged"
  | "aborted";

/** The three kinds of state. */
export type StateKind = "idle" | "agent" | "feedback";
/** Which agent runs an `agent`-kind state. */
export type AgentType = "ceo-agent" | "workspace-agent";
/** A state's category: its kind, and (for agent states) which agent runs it. */
export type StateMeta = { kind: StateKind; agentType?: AgentType };

/**
 * The single source of truth categorizing each canonical state — its KIND, and for
 * AGENT states the agent TYPE. Logic (dispatcher/reconcile/feedback) and the UI both
 * derive their behavior from this map rather than hard-coding status lists, so the
 * 3-kind / 2-agent-type model has exactly ONE definition.
 */
export const STATE_META: Record<TaskStatus, StateMeta> = {
  idea: { kind: "agent", agentType: "ceo-agent" },
  spec_review: { kind: "feedback" },
  blocked: { kind: "idle" },
  needs_info: { kind: "feedback" },
  in_progress: { kind: "agent", agentType: "workspace-agent" },
  in_review: { kind: "feedback" },
  finalizing: { kind: "agent", agentType: "workspace-agent" },
  merged: { kind: "idle" },
  aborted: { kind: "idle" },
};

/** Every canonical status (stable order: roughly the happy-path order). */
export const ALL_STATUSES: TaskStatus[] = [
  "idea",
  "spec_review",
  "blocked",
  "needs_info",
  "in_progress",
  "in_review",
  "finalizing",
  "merged",
  "aborted",
];

/** The two terminal states. */
export function isTerminal(status: TaskStatus): boolean {
  return status === "merged" || status === "aborted";
}

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
  // ASK handshake (see the `question`/`answer` ensureColumn block above): `question`
  // is the agent's pending clarifying question while status='awaiting_input';
  // `answer` is the operator's reply, held transiently for the resume dispatch and
  // consumed at re-launch. Surfaced on TaskView via the `...row` spread.
  question: string | null;
  answer: string | null;
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
  // Merge-range bookkeeping (see the ensureColumn block above): the SHAs bracketing
  // the commits this task landed (`merge_base_sha..merged_sha`), used to pre-fill a
  // rollback task with the exact commit to revert.
  merge_base_sha: string | null;
  merged_sha: string | null;
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
  // PER-TASK DISPATCH PRIORITY (see the ensureColumn block above): higher dispatches
  // sooner; the queued selection orders by `priority DESC, created_at ASC`. Default
  // 0. Surfaced on TaskView via the `...row` spread (no extra plumbing in taskView).
  priority: number;
  // PLAN-PREVIEW GATE (see the ensureColumn block above): 1 when the task opts into
  // the plan-preview gate (the agent proposes a plan and pauses for operator approval
  // before writing code), else 0. Surfaced on TaskView via the `...row` spread.
  plan_preview: number;
  // RESUME RE-GROUNDING FINGERPRINT (see the ensureColumn block above): a sha256 of the
  // prompt + context-file list the agent was last grounded in. Compared on resume to
  // detect a prompt/context edit made while the task was paused (needs_info / in_review),
  // which triggers a re-ground (taskmd.renderRegroundBlock). NULL until first grounded.
  grounding_fp: string | null;
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

// ---- MANAGED CTO AGENT (per-directory records) ----------------------------
// One row per registered directory (keyed by directory_id), tracking that
// directory's CTO agent runtime handles. See the cto_agent table comment above and
// src/cto-agent.ts.
export type CtoAgentRow = {
  directory_id: string;
  session_id: string | null;
  herdr_pane_id: string | null;
  herdr_tab_id: string | null;
  herdr_workspace: string | null;
  desired: number; // 1 = should be running (supervised), 0 = stopped
  started_at: string | null;
  restarts: number;
  last_error: string | null;
  updated_at: string | null;
};

/** A directory's CTO-agent record, or null if it has never been written. */
export function getCtoAgentRow(directoryId: string): CtoAgentRow | null {
  return (
    db
      .query<CtoAgentRow, [string]>(`SELECT * FROM cto_agent WHERE directory_id=?`)
      .get(directoryId) ?? null
  );
}

/** Every CTO-agent record (one per directory that has ever launched/been desired). */
export function listCtoAgentRows(): CtoAgentRow[] {
  return db.query<CtoAgentRow, []>(`SELECT * FROM cto_agent`).all();
}

/** Drop a directory's CTO-agent record (the directory DELETE also cascades this). */
export function deleteCtoAgentRow(directoryId: string): void {
  db.query(`DELETE FROM cto_agent WHERE directory_id=?`).run(directoryId);
}

/**
 * Upsert a partial patch onto a directory's CTO-agent record (stamping updated_at).
 * Single-row write; the supervisor/lifecycle treat this as best-effort durable state
 * the same way settings are. Unspecified fields are left untouched on an existing row.
 * Requires the directory to exist (the FK cascade keys the row to it).
 */
export function saveCtoAgentRow(
  directoryId: string,
  patch: Partial<Omit<CtoAgentRow, "directory_id">>,
): void {
  const cur = getCtoAgentRow(directoryId);
  const next: CtoAgentRow = {
    directory_id: directoryId,
    session_id: cur?.session_id ?? null,
    herdr_pane_id: cur?.herdr_pane_id ?? null,
    herdr_tab_id: cur?.herdr_tab_id ?? null,
    herdr_workspace: cur?.herdr_workspace ?? null,
    desired: cur?.desired ?? 0,
    started_at: cur?.started_at ?? null,
    restarts: cur?.restarts ?? 0,
    last_error: cur?.last_error ?? null,
    updated_at: cur?.updated_at ?? null,
    ...patch,
  };
  db.query(
    `INSERT INTO cto_agent
       (directory_id, session_id, herdr_pane_id, herdr_tab_id, herdr_workspace,
        desired, started_at, restarts, last_error, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(directory_id) DO UPDATE SET
       session_id=excluded.session_id,
       herdr_pane_id=excluded.herdr_pane_id,
       herdr_tab_id=excluded.herdr_tab_id,
       herdr_workspace=excluded.herdr_workspace,
       desired=excluded.desired,
       started_at=excluded.started_at,
       restarts=excluded.restarts,
       last_error=excluded.last_error,
       updated_at=excluded.updated_at`,
  ).run(
    next.directory_id,
    next.session_id,
    next.herdr_pane_id,
    next.herdr_tab_id,
    next.herdr_workspace,
    next.desired,
    next.started_at,
    next.restarts,
    next.last_error,
    nowIso(),
  );
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
