// Task service: create / list / get / diff / approve / reject. The task.md on
// disk is authoritative for prompt+metadata; the DB row tracks runtime state.
import { config } from "./config.ts";
import { conformanceGateInFlight, triggerConformance } from "./conformance.ts";
import { db, estimateRows, isTerminal, matchesQuery, nowIso, recordTaskEvent } from "./db.ts";
import type { TaskRow, TaskStatus } from "./db.ts";
import {
  classifyPathType,
  computeEstimateStats,
  estimateChain,
  estimateTask,
} from "./estimate.ts";
import type { ChainEstimate, EstimateRow, Estimate } from "./estimate.ts";
import { HttpError, workspaceGateCmd, getWorkspace } from "./workspaces.ts";
import { readRunLogSnapshot, signalAbort } from "./dispatcher.ts";
import { publish } from "./events.ts";
import { runGate } from "./gate.ts";
import * as git from "./git.ts";
import * as herdr from "./herdr.ts";
import { uniqueTaskId } from "./ids.ts";
import { findTranscript, readSessionUsage } from "./usage.ts";
import { verifyDefaultBranch } from "./verify.ts";
import {
  appendAnswer,
  appendRejection,
  readTaskMd,
  taskMdPath,
  updateTaskMdPrompt,
  updateTaskMdStatus,
  writeTaskMd,
} from "./taskmd.ts";
import { existsSync, readFileSync } from "node:fs";

// The serialized task object exposes `blocked_by` as a real array of ids (the DB
// stores it as raw JSON TEXT) plus `deadBlockers`: blockers in a terminal,
// non-merged state (aborted/rejected/failed) or gone entirely, which will NEVER
// merge — a blocked task with any dead blocker is stuck until the operator edits
// its blocked_by set (see setBlockedBy). We Omit the raw column so the array shape
// wins.
export type TaskView = Omit<TaskRow, "blocked_by" | "tags"> & {
  prompt: string;
  context: string[];
  review_notes: string;
  blocked_by: string[];
  // Free-form organizational labels (the DB stores them as raw JSON TEXT). Empty
  // array when none. Set at creation; the webapp + CLI filter on them. See `tags`.
  tags: string[];
  // The current status of each blocker by id (or "gone" if its row no longer
  // exists), so the webapp can render the dependency list without extra fetches.
  blockerStates: Record<string, string>;
  deadBlockers: string[];
  // ROUGH duration estimate for this task as a p50–p90 range with its sample size
  // (see src/estimate.ts). null on a terminal task (merged/aborted/failed) — a
  // forward estimate is only meaningful for work still ahead. The webapp renders it
  // as a loose forecast (e.g. "est ~12–30m, n=8"), never a promise.
  estimate: Estimate | null;
};

// --- DURATION ESTIMATES (rough, history-derived) ---------------------------

/**
 * Assemble the estimator's input rows from the tasks table (parsing the raw
 * blocked_by JSON column into a clean id array). The pure estimate model in
 * src/estimate.ts consumes these — kept out of estimate.ts so that module stays
 * DB-free and unit-testable against synthetic rows.
 */
export function estimateInputRows(): EstimateRow[] {
  return estimateRows().map((r) => ({
    id: r.id,
    status: r.status,
    started_at: r.started_at,
    completed_at: r.completed_at,
    merged_at: r.merged_at,
    diff_lines: r.diff_lines,
    path_type: r.path_type,
    blocked_by: parseBlockedBy(r.blocked_by),
  }));
}

/**
 * The rough p50–p90 estimate for a single task (or null for a terminal task / a
 * missing row). Recomputes the bucket distributions from current history each call;
 * the dataset is small (a single-user harness) so this stays a cheap in-memory pass,
 * matching how /api/metrics aggregates on demand.
 */
export function taskEstimate(id: string): Estimate | null {
  const row = getTask(id);
  if (!row || isTerminal(row.status)) return null;
  const rows = estimateInputRows();
  const stats = computeEstimateStats(rows);
  const self = rows.find((r) => r.id === id);
  if (!self) return null;
  return estimateTask(self, stats);
}

/**
 * The critical-path estimate for a task's dependency chain: the path to its own
 * merge through its blockers. Returns null when there's nothing to chain (a task
 * with no blockers — its single estimate already covers it) or the task is gone.
 */
export function taskChainEstimate(id: string): ChainEstimate | null {
  const row = getTask(id);
  if (!row) return null;
  const rows = estimateInputRows();
  const stats = computeEstimateStats(rows);
  if (parseBlockedBy(row.blocked_by).length === 0) return null;
  return estimateChain([id], rows, stats);
}

export function getTask(id: string): TaskRow | null {
  return (
    db.query<TaskRow, [string]>(`SELECT * FROM tasks WHERE id=?`).get(id) ?? null
  );
}

/**
 * Re-read a task and report whether it has reached a terminal state, as the
 * "terminal" | "ok" result the agent-facing request_review / ask handlers return
 * when their guarded UPDATE matched no row (the task moved under them). One read
 * (vs the old double getTask) keyed off the canonical isTerminal predicate.
 */
function terminalOrOk(id: string): "terminal" | "ok" {
  const s = getTask(id)?.status;
  return s && isTerminal(s) ? "terminal" : "ok";
}

// --- task dependencies / blocking ------------------------------------------

/** Terminal states a blocker can be in that mean it will NEVER merge: the operator
 * cancelled it (`aborted`), an execution failure killed it (`failed`), or it was
 * rolled back (`rolled_back`). See the canonical state model in db.ts. */
const DEAD_BLOCKER_STATES = new Set<TaskStatus>(["aborted", "failed", "rolled_back"]);

/** Parse a JSON-array-of-task-ids column (e.g. `blocked_by`) into a clean string[]. */
export function parseBlockedBy(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Parse the `tags` JSON-array TEXT column into a clean string[]. Identically shaped
 * to blocked_by, but kept as its own name so the LABEL semantics are explicit at the
 * call sites (and so a future tag-specific normalization has one place to live).
 */
export function parseTags(raw: string | null): string[] {
  return parseBlockedBy(raw);
}

/**
 * Normalize a free-form tag list for storage: coerce each entry to a trimmed string,
 * drop blanks, and de-duplicate while preserving order. Defensive about input — a
 * non-array (or undefined) yields []. Used by createTask so a stored tag set is always
 * a clean array of non-empty strings.
 */
export function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const t = String(raw ?? "").trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * Validate the optional `tags` field from an API body, then normalize it. Tags must
 * be an array of strings (each ≤ 40 chars); anything else is a 400. Returns the
 * cleaned set (trimmed, de-duped, blanks dropped). Absent/null → [].
 */
export function validateTags(tags: unknown): string[] {
  if (tags === undefined || tags === null) return [];
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== "string")) {
    throw new HttpError(400, "tags must be an array of strings");
  }
  const normalized = normalizeTags(tags);
  if (normalized.some((t) => t.length > 40)) {
    throw new HttpError(400, "each tag must be 40 characters or fewer");
  }
  return normalized;
}

/**
 * Classify a single blocker by id:
 *  - "merged"  → satisfied; this dependency is met.
 *  - "dead"    → terminal non-merged (aborted/failed/rolled_back) OR no longer exists
 *                (its workspace was unregistered) → it will never merge.
 *  - "pending" → still in flight (blocked/inactive/in_progress/in_review/needs_info) →
 *                may still merge.
 */
function blockerState(blockerId: string): "merged" | "dead" | "pending" {
  const b = getTask(blockerId);
  if (!b) return "dead"; // gone — can never merge
  if (b.status === "merged") return "merged";
  if (DEAD_BLOCKER_STATES.has(b.status)) return "dead";
  return "pending";
}

/** Are ALL of these blockers merged? (Empty set → trivially eligible.) */
function allBlockersMerged(ids: string[]): boolean {
  return ids.every((id) => blockerState(id) === "merged");
}

/** Blockers (by id) that will never merge — terminal non-merged or gone. */
function deadBlockerIds(ids: string[]): string[] {
  return ids.filter((id) => blockerState(id) === "dead");
}

/**
 * Map each blocker id to its current status ("gone" if its row no longer exists),
 * for the webapp to render the dependency list without extra fetches. Shared by
 * taskView and taskListView so the detail and list views report the same status.
 */
function blockerStatesOf(ids: string[]): Record<string, string> {
  const states: Record<string, string> = {};
  for (const bid of ids) {
    const b = getTask(bid);
    states[bid] = b ? b.status : "gone";
  }
  return states;
}

// Remember which (task, dead-blocker) pairs we've already warned about so the
// per-tick re-evaluation doesn't spam the log every second for a stuck task.
const loggedDeadBlockers = new Set<string>();
function logDeadBlockers(taskId: string, ids: string[]): void {
  for (const bid of deadBlockerIds(ids)) {
    const key = `${taskId}:${bid}`;
    if (loggedDeadBlockers.has(key)) continue;
    loggedDeadBlockers.add(key);
    const b = getTask(bid);
    console.warn(
      `[butchr] task ${taskId} blocked on ${bid} which is ${b ? b.status : "gone"} ` +
        `and will never merge; edit blocked_by to proceed`,
    );
  }
}

/**
 * Would making `taskId` depend on `newBlockers` create a self-block or a
 * dependency cycle (A blocks B blocks A)? Walks the existing blocked_by graph
 * from each proposed blocker; only `taskId`'s OWN outgoing edges change, so if any
 * path from a proposed blocker reaches `taskId` again, the new edge closes a cycle.
 */
export function wouldCreateCycle(taskId: string, newBlockers: string[]): boolean {
  if (newBlockers.includes(taskId)) return true; // self-block
  const visited = new Set<string>();
  const stack = [...newBlockers];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === taskId) return true;
    if (visited.has(cur)) continue;
    visited.add(cur);
    const row = getTask(cur);
    if (!row) continue;
    for (const b of parseBlockedBy(row.blocked_by)) stack.push(b);
  }
  return false;
}

export function listTasks(workspaceId: string): TaskRow[] {
  return db
    .query<TaskRow, [string]>(
      `SELECT * FROM tasks WHERE workspace_id=? ORDER BY created_at DESC`,
    )
    .all(workspaceId);
}

/**
 * Best-effort read of a task's on-disk task.md, returning the prompt / context /
 * review-notes triple, or null when the file is absent or unparseable. The single
 * guarded (existsSync + try/catch) read shared by taskView and taskSearchText so a
 * missing/corrupt task.md degrades the same way in both.
 */
function readTaskMdSafe(
  dirPath: string,
  id: string,
): { prompt: string; context: string[]; reviewNotes: string } | null {
  if (!existsSync(taskMdPath(dirPath, id))) return null;
  try {
    const doc = readTaskMd(dirPath, id);
    return { prompt: doc.prompt, context: doc.meta.context, reviewNotes: doc.reviewNotes };
  } catch {
    return null; // ignore parse errors
  }
}

/** Merge the DB row with the on-disk task.md for the detail view. */
export function taskView(id: string): TaskView | null {
  const row = getTask(id);
  if (!row) return null;
  const dir = getWorkspace(row.workspace_id);
  let prompt = "";
  let context: string[] = [];
  let review_notes = "";
  if (dir) {
    const md = readTaskMdSafe(dir.path, id);
    if (md) {
      prompt = md.prompt;
      context = md.context;
      review_notes = md.reviewNotes;
    }
  }
  const blocked_by = parseBlockedBy(row.blocked_by);
  return {
    ...row,
    prompt,
    context,
    review_notes,
    blocked_by,
    tags: parseTags(row.tags),
    blockerStates: blockerStatesOf(blocked_by),
    deadBlockers: deadBlockerIds(blocked_by),
    estimate: taskEstimate(id),
  };
}

// The workspace task-list projection: the same parsed/enriched shape taskView
// returns, MINUS the task.md-derived fields (prompt / context / review_notes) and
// the per-task duration estimate. The list / board / graph views only need the
// runtime row plus parsed blocked_by and the server-computed
// blocker status, so this skips reading every task.md from disk (and the per-row
// estimate recompute) that the full taskView would do.
export type TaskListView = Omit<
  TaskView,
  "prompt" | "context" | "review_notes" | "estimate"
>;

/**
 * The full searchable text for a task, for server-side `?q=` full-text search: its
 * id, its DB-side `summary` (request_review summary) and `review_note` (the live
 * change-request note), plus the prompt + accumulated review notes read from
 * task.md on disk. task.md is read best-effort — a missing/unparseable file (or a
 * task whose workspace is gone) just contributes the DB fields — so a merged task
 * (whose worktree is cleaned up but whose task.md under .butchr/tasks/ persists)
 * still matches on its prompt. The pieces are joined with newlines for one
 * case-insensitive substring scan (see db.matchesQuery).
 */
function taskSearchText(row: TaskRow, dirPath: string | null): string {
  const parts: string[] = [row.id];
  if (row.summary) parts.push(row.summary);
  if (row.review_note) parts.push(row.review_note);
  if (dirPath) {
    const md = readTaskMdSafe(dirPath, row.id);
    if (md) parts.push(md.prompt, md.reviewNotes);
  }
  return parts.join("\n");
}

/**
 * List a workspace's tasks in the taskView shape (newest first). Per CONTRIBUTING
 * §3, endpoints return the parsed projection rather than raw rows so the webapp and
 * CLI consume one consistent shape: blocked_by comes back as a real
 * id array and each blocker's status is precomputed (blockerStates / deadBlockers).
 * A lighter sibling of taskView — it does NOT read task.md (no prompt/context
 * bodies) or compute the duration estimate, neither of which the list views use.
 *
 * Optional `q` is a case-insensitive FULL-TEXT SEARCH filter (server-side so huge
 * prompts never ship to the client): only tasks whose searchable text — id +
 * summary + review notes + the task.md prompt — contains `q` are returned (see
 * taskSearchText / db.matchesQuery). A blank/absent `q` applies no filter and reads
 * NO task.md (the light projection is preserved); a non-blank `q` reads each task's
 * task.md to scan its prompt. The filter composes with the webapp/CLI status/tag
 * filters, which narrow the returned set further.
 */
export function taskListView(workspaceId: string, q?: string): TaskListView[] {
  const needle = (q ?? "").trim();
  const dirPath = needle ? (getWorkspace(workspaceId)?.path ?? null) : null;
  const out: TaskListView[] = [];
  for (const row of listTasks(workspaceId)) {
    if (needle && !matchesQuery(taskSearchText(row, dirPath), needle)) continue;
    const blocked_by = parseBlockedBy(row.blocked_by);
    out.push({
      ...row,
      blocked_by,
      tags: parseTags(row.tags),
      blockerStates: blockerStatesOf(blocked_by),
      deadBlockers: deadBlockerIds(blocked_by),
    });
  }
  return out;
}

function emitUpdated(id: string): void {
  const v = taskView(id);
  if (v) publish({ type: "task.updated", task: v });
}

/**
 * TEARDOWN + DISCARD the agent's worktree, in the ONE correct order: (optionally)
 * capture the session's token usage FIRST — it reads the transcript while the
 * session id + worktree are still in hand and MUST precede the worktree discard
 * (see captureSessionUsage) — then tear down the herdr tab/pane and `git.cleanup`
 * the worktree + branch. The caller keeps any readRunLogSnapshot read (the run log
 * lives outside the worktree).
 *
 *  - `background: true` runs the teardown fire-and-forget (each step swallows its
 *    own error so a teardown failure can't strand the call OR skip the cleanup) and
 *    returns at once.
 *  - `background: false` (default) AWAITS the teardown, letting a herdr.teardownTask
 *    failure PROPAGATE to the caller (git.cleanup still swallows its own error) —
 *    used by finalizeMerge / abortTask, which gate their status write on it.
 */
async function teardownAndDiscard(
  dir: { path: string },
  row: TaskRow,
  { captureUsage = false, background = false }: { captureUsage?: boolean; background?: boolean } = {},
): Promise<void> {
  if (captureUsage) captureSessionUsage(row.id);
  if (background) {
    void (async () => {
      await herdr.teardownTask(row.herdr_tab_id, row.id, row.herdr_pane_id).catch(() => {});
      await git.cleanup(dir.path, row.id).catch(() => {});
    })();
  } else {
    await herdr.teardownTask(row.herdr_tab_id, row.id, row.herdr_pane_id);
    await git.cleanup(dir.path, row.id).catch(() => {});
  }
}

/**
 * Wrap a value passed in setStatus's `set` so the column compiles to
 * `col=COALESCE(col, ?)` (fill it ONLY if currently NULL) instead of a plain
 * `col=?`. Used for stamp-once columns (started_at / merged_at / session_id) that
 * must stick to the FIRST value assigned across re-runs.
 */
function keep(
  value: string | number | null,
): { __keep: true; value: string | number | null } {
  return { __keep: true, value };
}
function isKeep(v: unknown): v is { __keep: true; value: string | number | null } {
  return typeof v === "object" && v !== null && (v as { __keep?: unknown }).__keep === true;
}

/**
 * The ONE guarded task-status transition. Builds a `WHERE id=? [AND status IN
 * (…from)]` UPDATE that writes `status` (plus any `opts.set` columns) and, ONLY when
 * it actually changed a row, performs the other three steps that must stay in
 * lockstep with it: record the audit event, mirror the new status into task.md, and
 * emit the SSE `task.updated`. Returns whether a row changed (false = lost a race /
 * no match — the caller bails, exactly like the old `if (res.changes === 0) return`).
 *
 * Centralizing this four-step skeleton is the whole point: every hand-written
 * transition used to re-copy UPDATE → recordTaskEvent → updateTaskMdStatus →
 * emitUpdated, so one that forgot a step silently dropped an audit entry, desynced
 * task.md, or left the webapp stale until the next tick. Now a transition can't.
 *
 *  - `from` — the status(es) the row must be in for the UPDATE to apply (the race
 *    guard); omit for an unconditional `WHERE id=?`.
 *  - `note` — the audit-event note. The event is recorded only when the status
 *    actually changed (`row.status !== to`), so a same-status write (e.g. a duplicate
 *    re-queue) logs no spurious transition — matching the old per-call-site guards.
 *  - `set` — extra columns written alongside status as `col=?`; wrap a value in
 *    `keep(...)` for `col=COALESCE(col, ?)` stamp-once semantics.
 */
function setStatus(
  id: string,
  to: TaskStatus,
  opts: {
    from?: TaskStatus | TaskStatus[];
    note?: string;
    set?: Record<string, unknown>;
  } = {},
): boolean {
  const row = getTask(id);
  if (!row) return false;

  const assigns = ["status=?"];
  const params: (string | number | null)[] = [to];
  for (const [col, val] of Object.entries(opts.set ?? {})) {
    if (isKeep(val)) {
      assigns.push(`${col}=COALESCE(${col}, ?)`);
      params.push(val.value);
    } else {
      assigns.push(`${col}=?`);
      params.push(val as string | number | null);
    }
  }
  let where = "id=?";
  params.push(id);
  if (opts.from !== undefined) {
    const froms = Array.isArray(opts.from) ? opts.from : [opts.from];
    where += ` AND status IN (${froms.map(() => "?").join(", ")})`;
    params.push(...froms);
  }

  const res = db.query(`UPDATE tasks SET ${assigns.join(", ")} WHERE ${where}`).run(...params);
  if (res.changes === 0) return false;

  if (row.status !== to) recordTaskEvent(id, row.status, to, opts.note ?? null);
  const dir = getWorkspace(row.workspace_id);
  if (dir) updateTaskMdStatus(dir.path, id, to);
  emitUpdated(id);
  return true;
}

/**
 * Validate + normalize an optional per-task model. Returns null for an unset model
 * (default — no --model flag), or the trimmed model string. Rejects (400) anything
 * that isn't a plain model alias/name: the value is interpolated into the agent
 * launch command, so we constrain it to letters/digits plus `.`/`-`/`_` (covers
 * aliases like `opus`/`sonnet`/`haiku`/`fable` and full ids like `claude-opus-4-8`)
 * — never whitespace or shell metacharacters.
 */
export function validateModel(model: unknown): string | null {
  if (model === undefined || model === null) return null;
  if (typeof model !== "string") throw new HttpError(400, "model must be a string");
  const m = model.trim();
  if (!m) return null;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(m)) {
    throw new HttpError(
      400,
      `invalid model "${m}": use a model alias (e.g. opus, sonnet, haiku) or a ` +
        `full model id (e.g. claude-opus-4-8)`,
    );
  }
  return m;
}

/**
 * Validate + normalize an optional per-task dispatch priority. Returns the integer
 * priority, defaulting to 0 (the baseline FIFO order) when unset/blank. Accepts a
 * number or a numeric string (the CLI/HTTP body may carry either); rejects (400)
 * anything that isn't a finite integer. Higher = dispatched sooner; negatives are
 * allowed (later than the default). See the `priority` column in db.ts and
 * dispatcher.selectQueuedForDispatch.
 */
export function validatePriority(priority: unknown): number {
  if (priority === undefined || priority === null || priority === "") return 0;
  const n = typeof priority === "number" ? priority : Number(priority);
  if (!Number.isInteger(n)) {
    throw new HttpError(
      400,
      "priority must be an integer (higher = dispatched sooner; default 0)",
    );
  }
  return n;
}

/**
 * Validate the optional `plan_preview` flag from an API/CLI body. Returns a boolean,
 * defaulting to false when unset/null. Rejects (400) any non-boolean value. When true,
 * the task opts into the PLAN-PREVIEW gate: its first dispatch hands the agent the
 * plan-preview protocol (propose a plan via the MCP `propose_plan` tool and pause for
 * operator approval before writing code) — see taskmd.renderAgentPrompt / mcp.ts.
 */
export function validatePlanPreview(planPreview: unknown): boolean {
  if (planPreview === undefined || planPreview === null) return false;
  if (typeof planPreview !== "boolean") {
    throw new HttpError(400, "plan_preview must be a boolean");
  }
  return planPreview;
}

/**
 * Validate the optional `idea` flag from an API/CLI body. Returns a boolean, defaulting
 * to false when unset/null. Rejects (400) any non-boolean value. When true, the task is
 * created in the unified pipeline's FRONT state `idea`: the `prompt` is treated as a
 * one-line operator BRIEF, and the task's first "dispatch" runs the CTO-fork spec
 * generator (src/cto.ts) to turn the brief into a spec before it advances to `queued`
 * ('ready'). See createTask / dispatcher.
 */
export function validateIdea(idea: unknown): boolean {
  if (idea === undefined || idea === null) return false;
  if (typeof idea !== "boolean") {
    throw new HttpError(400, "idea must be a boolean");
  }
  return idea;
}

export async function createTask(
  workspaceId: string,
  prompt: string,
  context: string[] = [],
  blockedBy: string[] = [],
  kind: TaskKind = "task",
  model: string | null = null,
  tags: string[] = [],
  priority: number | string | null = 0,
  planPreview: boolean = false,
  idea: boolean = false,
): Promise<TaskView> {
  const dir = getWorkspace(workspaceId);
  if (!dir) throw new HttpError(404, `workspace not found: ${workspaceId}`);
  if (!prompt || !prompt.trim()) {
    throw new HttpError(400, "prompt is required");
  }
  const taskModel = validateModel(model);
  // Validate + normalize the organizational labels (trim/dedupe/length-cap).
  const taskTags = validateTags(tags);
  const taskPriority = validatePriority(priority);
  const taskPlanPreview = validatePlanPreview(planPreview);
  const taskIdea = validateIdea(idea);

  // Normalize + validate the dependency set: every listed blocker must exist.
  const blockers = normalizeBlockedBy(blockedBy);
  for (const bid of blockers) {
    if (!getTask(bid)) throw new HttpError(404, `blocker task not found: ${bid}`);
  }

  const id = uniqueTaskId((cand) => getTask(cand) !== null);

  // Self-block / cycle guard. The id is freshly minted (nothing points at it yet),
  // so in practice only a self-reference could trip this — but run the full walk
  // so the rule is enforced uniformly with setBlockedBy.
  if (wouldCreateCycle(id, blockers)) {
    throw new HttpError(400, "blocked_by would create a dependency cycle");
  }

  const created = nowIso();
  // FRONT STATE: an `idea` task (created from a one-line brief, no spec yet) starts in
  // `idea` — its first dispatch runs the CEO/CTO-fork spec generator, then it advances
  // to `spec_review` for the operator's sign-off (see promoteIdeaToSpecReview). Any
  // blockers are recorded but only gate the post-approval `inactive` transition, not
  // the spec-writing front state. A 'New task' (already carrying a spec) starts directly
  // in `inactive` (ready — queued for the dispatcher, no live agent yet) unless it has
  // unmerged blockers, in which case it waits in `blocked` and auto-unblocks to
  // `inactive` later.
  const status: TaskStatus = taskIdea
    ? "idea"
    : allBlockersMerged(blockers)
      ? "inactive"
      : "blocked";

  // Filesystem artifact first: worktree + task.md. If either fails, no DB row.
  await git.createWorktree(dir.path, id);
  writeTaskMd(
    dir.path,
    {
      id,
      created,
      status,
      context,
      kind,
      model: taskModel,
      tags: taskTags,
      plan_preview: taskPlanPreview,
    },
    prompt,
  );

  db.query(
    `INSERT INTO tasks (id, workspace_id, status, blocked_by, kind, model, tags, priority, plan_preview, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    workspaceId,
    status,
    JSON.stringify(blockers),
    kind,
    taskModel,
    JSON.stringify(taskTags),
    taskPriority,
    taskPlanPreview ? 1 : 0,
    created,
  );
  recordTaskEvent(
    id,
    null,
    status,
    taskIdea ? "idea task created" : "task created",
  );

  if (status === "blocked") logDeadBlockers(id, blockers);

  const view = taskView(id)!;
  publish({ type: "task.created", task: view });
  return view;
}

/**
 * Update a task's dispatch PRIORITY (higher = dispatched sooner; see the `priority`
 * column in db.ts and dispatcher.selectQueuedForDispatch). The value is validated
 * the same way as at creation (integer; defaults to 0 when unset/blank). 404 if the
 * task is gone. Priority only affects the order `queued` tasks dispatch in, so a
 * bump on a running/terminal task is accepted but inert — we don't status-gate it so
 * an operator can pre-set the priority of a `blocked` task before it is unblocked.
 * Emits a `task.updated` so the webapp reflects the new value live.
 */
export function setPriority(id: string, priority: number | string | null): TaskView {
  const row = getTask(id);
  if (!row) throw new HttpError(404, `task not found: ${id}`);
  const p = validatePriority(priority);
  db.query(`UPDATE tasks SET priority=? WHERE id=?`).run(p, id);
  emitUpdated(id);
  return taskView(id)!;
}

/** De-dupe + drop blanks from a blocked_by list, preserving order. */
function normalizeBlockedBy(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids ?? []) {
    const id = String(raw ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * AUTO-UNBLOCK: if `id` is `blocked` and ALL its blockers have merged, promote it
 * to `queued` so the dispatcher picks it up. A blocked task with an empty
 * blocked_by set is trivially eligible. No-op for any non-`blocked` task. Returns
 * true iff it promoted the task. Called cheaply for every blocked task on each
 * dispatcher tick (robust to missed events) and again right after any merge for
 * promptness. If it stays blocked, dead blockers are logged (deduped) so a stuck
 * dependency is visible.
 */
export function reevaluateBlockedTask(id: string): boolean {
  const row = getTask(id);
  if (!row || row.status !== "blocked") return false;
  const ids = parseBlockedBy(row.blocked_by);
  if (allBlockersMerged(ids)) {
    // Promote to inactive (ready — no live agent yet; the dispatcher launches it and
    // flips it to in_progress). Clear any stale backoff so it dispatches next tick.
    if (
      !setStatus(id, "inactive", {
        from: "blocked",
        note: "all blockers merged",
        set: { next_dispatch_at: null },
      })
    ) {
      return false; // moved under us
    }
    console.log(`[butchr] task ${id} unblocked → inactive (all blockers merged)`);
    return true;
  }
  // Still blocked — surface any dead (never-merging) blockers.
  logDeadBlockers(id, ids);
  return false;
}

/** Re-evaluate EVERY blocked task (used after a merge for prompt auto-unblock). */
export function reevaluateAllBlocked(): void {
  const rows = db
    .query<{ id: string }, []>(`SELECT id FROM tasks WHERE status='blocked'`)
    .all();
  for (const r of rows) reevaluateBlockedTask(r.id);
}

/**
 * Replace a task's blocked_by set (operator-driven, any time) and RE-EVALUATE.
 *
 * Allowed only on a NON-terminal task (blocked/inactive/in_progress/in_review/
 * needs_info); rejected with 409 on the terminal states merged/failed/rolled_back/
 * aborted. Every new blocker id must exist (404) and the new set must not create a
 * self-block or cycle (400). After persisting:
 *  - If it should now be blocked (some blocker not yet merged) and it has a LIVE
 *    agent (running/idle), KILL-ON-BLOCK: tear the agent down (reuse teardownTask)
 *    and clear the running/herdr fields like a clean re-queue, but KEEP session_id
 *    and the worktree so it resumes with full context when it later unblocks. This
 *    is NOT a dispatch failure (dispatch_attempts/backoff untouched).
 *  - If all blockers are merged/empty and it was blocked, promote it to inactive.
 */
export async function setBlockedBy(
  id: string,
  blockedBy: string[],
): Promise<TaskView> {
  const row = getTask(id);
  if (!row) throw new HttpError(404, `task not found: ${id}`);
  // Only non-terminal states may have their dependencies edited (everything except the
  // four terminal idle states: merged/failed/rolled_back/aborted).
  if (isTerminal(row.status)) {
    throw new HttpError(409, `cannot edit blocked_by on a ${row.status} task`);
  }

  const blockers = normalizeBlockedBy(blockedBy);
  for (const bid of blockers) {
    if (!getTask(bid)) throw new HttpError(404, `blocker task not found: ${bid}`);
  }
  if (wouldCreateCycle(id, blockers)) {
    throw new HttpError(400, "blocked_by would create a dependency cycle");
  }

  // Persist the new dependency set first; the transition below reads it back.
  db.query(`UPDATE tasks SET blocked_by=? WHERE id=?`).run(
    JSON.stringify(blockers),
    id,
  );
  // Forget any prior dead-blocker warnings for this task — the set just changed.
  for (const key of [...loggedDeadBlockers]) {
    if (key.startsWith(`${id}:`)) loggedDeadBlockers.delete(key);
  }

  const eligible = allBlockersMerged(blockers);

  if (eligible) {
    // No outstanding blockers. A blocked task becomes eligible → inactive (ready);
    // anything else (inactive/in_progress/in_review/…) is already past the block, so
    // leave it.
    const transitioned =
      row.status === "blocked" &&
      setStatus(id, "inactive", {
        from: "blocked",
        note: "dependencies cleared by operator",
        set: { next_dispatch_at: null },
      });
    // setStatus emits on a successful transition; otherwise (already-past-block task,
    // or a lost race) emit here so the view still refreshes exactly once, as before.
    if (!transitioned) emitUpdated(id);
    return taskView(id)!;
  }

  // Should be blocked. If it already is, just refresh the view + dead-blocker log.
  if (row.status === "blocked") {
    logDeadBlockers(id, blockers);
    emitUpdated(id);
    return taskView(id)!;
  }

  // Transitioning INTO blocked from inactive/in_progress/in_review.
  if (row.herdr_pane_id || row.herdr_tab_id) {
    // KILL-ON-BLOCK: a live agent (running/idle) — tear it down so nothing keeps
    // running, then clear the running/herdr fields (mirrors backToQueued) while
    // KEEPING session_id + worktree for a later --resume. NOT a dispatch failure.
    await herdr.teardownTask(row.herdr_tab_id, id, row.herdr_pane_id);
  }
  setStatus(id, "blocked", {
    note: "blocked on new dependencies (operator)",
    set: {
      herdr_pane_id: null,
      herdr_tab_id: null,
      output_snapshot: null,
      conflict: 0,
      idle: 0,
    },
  });
  logDeadBlockers(id, blockers);
  return taskView(id)!;
}

/** Compute the diff of a task branch vs its workspace's default branch. */
export async function taskDiff(id: string): Promise<string> {
  const row = getTask(id);
  if (!row) throw new HttpError(404, `task not found: ${id}`);
  const dir = getWorkspace(row.workspace_id);
  if (!dir) throw new HttpError(404, "workspace not found");
  return git.diff(dir.path, id);
}

/**
 * Global merge queue: run at most ONE merge at a time across ALL tasks and
 * workspaces. Approvals that land close together would otherwise rebase+ff into
 * a moving default branch in parallel and race; serializing them means each merge
 * rebases onto the up-to-date base tip the previous merge left behind. The chain
 * is process-wide (a single butchr instance owns all merges) and never rejects —
 * each link swallows the prior result so one failed merge can't break the queue.
 */
let mergeChain: Promise<unknown> = Promise.resolve();
function runExclusiveMerge<T>(fn: () => Promise<T>): Promise<T> {
  const result = mergeChain.then(fn, fn);
  mergeChain = result.then(
    () => {},
    () => {},
  );
  return result;
}

/**
 * What approveTask did:
 *  - merged the branch (default),
 *  - `conflictSentBack` — kicked a merge conflict back to the agent, or
 *  - `revertedOnRed` — the branch DID fast-forward into main but the post-merge
 *    verify gate (build + tests) failed, so the merge was auto-reverted off main
 *    and the task flagged. The default branch is back at its pre-merge tip.
 */
export type ApproveOutcome = {
  task: TaskView;
  conflictSentBack?: boolean;
  revertedOnRed?: boolean;
};

/**
 * Send a task in `review` back for rework with a change-request note. In the
 * non-blocking model the agent has already exited, so there is no live call to
 * resolve: we simply re-queue the task (the note is already appended to task.md /
 * stored in review_note). The dispatcher then re-launches the SAME Claude session
 * via `--resume <session_id>` (see dispatcher.dispatch) so the agent re-enters
 * with full prior context and the notes. We close any lingering pane defensively
 * — normally there is none, but a misbehaving agent that didn't exit would
 * otherwise leave an orphan that collides on `agent_name_taken`. Shared by
 * rejectTask (human note) and approveTask's conflict kick-back.
 */
async function requestChanges(
  id: string,
  note: string,
  paneId: string | null,
  tabId: string | null,
  eventNote: string,
): Promise<void> {
  // RESUME the workspace agent: move the task back to `inactive` (ready — pane NULL)
  // so the dispatcher re-launches the SAME Claude session via `--resume` with the
  // notes, flipping it to in_progress on launch. The agent already exited after the
  // non-blocking request_review, so there is no live call to resolve; tear down any
  // lingering tab defensively (a misbehaving agent that didn't exit would otherwise
  // strand an orphan that collides on `agent_name_taken`), and clear the stored tab id
  // since the re-dispatch spins up a fresh one. Shared by the in_review request-changes
  // path and the approve-time merge-conflict kick-back.
  await herdr.teardownTask(tabId, id, paneId);
  // This is a REWORK re-queue (a request-changes or a conflict kick-back), NOT a
  // dispatch failure — it's a fresh intent to run, so clear the dispatch retry
  // state (attempts / last error / backoff) so prior dispatch failures don't
  // count against the resume and a stale backoff can't delay it. Unconditional
  // (no `from` guard) — the callers only ever route an in_review/rolling_back task
  // here, so setStatus records the → inactive event.
  setStatus(id, "inactive", {
    note: eventNote,
    set: {
      review_note: note,
      herdr_pane_id: null,
      herdr_tab_id: null,
      output_snapshot: null,
      summary: null,
      conflict: 0,
      idle: 0,
      dispatch_attempts: 0,
      last_dispatch_error: null,
      next_dispatch_at: null,
      // A human-driven rework is a fresh start — clear the auto-resume streak too.
      resume_attempts: 0,
    },
  });
}

/** Actionable change-request note for a merge conflict, naming the files + steps. */
function buildConflictNotes(
  id: string,
  base: string,
  files: string[],
  rawMessage: string,
): string {
  const fileList = files.length
    ? files.map((f) => `  - ${f}`).join("\n")
    : "  (see the git output below)";
  const tail = rawMessage.trim().split("\n").slice(-6).join("\n");
  return [
    `Merge conflict: your branch \`${id}\` conflicts with \`${base}\` on:`,
    fileList,
    ``,
    `IMPORTANT — butchr's merge gate REBASES your branch onto \`${base}\` (it does`,
    `not create a merge commit). So do NOT integrate with \`git merge ${base}\`: a`,
    `merge commit is DISCARDED by the rebase, your original commit is replayed, and`,
    `it RE-CONFLICTS — bouncing the task back to review on a loop. Instead, rebase`,
    `your work on top of the latest \`${base}\` so the resolution sticks. In your`,
    `worktree, do ONE of:`,
    ``,
    `  - \`git rebase ${base}\` — resolve each conflicting file, \`git add\` it, then`,
    `    \`git rebase --continue\` (repeat until the rebase finishes); or`,
    `  - \`git reset --soft ${base}\` — this re-roots your changes onto \`${base}\``,
    `    as staged changes; reconcile them against the latest \`${base}\` content,`,
    `    then \`git commit\`.`,
    ``,
    `Then call \`request_review\` again. Do NOT use \`git merge\`, and do NOT leave`,
    `conflict markers (\`<<<<<<<\` / \`=======\` / \`>>>>>>>\`) in any file.`,
    ``,
    `--- git output ---`,
    tail,
  ].join("\n");
}

/** Outcome of the pre-dispatch auto-rebase (see prepareBranchForDispatch). */
export type BranchPrep = {
  // The branch is safely based on the current default tip (clean rebase/reset, an
  // up-to-date branch, or a deliberately-untouched dirty worktree). On a conflict
  // this is false but dispatch still proceeds — see below.
  ok: boolean;
  // True iff the branch base was actually moved this call.
  rebased: boolean;
  // True iff the auto-rebase conflicted: we did NOT silently launch on a blind
  // base — an actionable conflict note was recorded so the (re-launched) agent
  // integrates the base and resolves with fresh context, rather than letting the
  // collision surface only at the final merge.
  conflict: boolean;
};

/**
 * AUTO-REBASE before an agent runs. The dispatcher calls this for EVERY task right
 * before launching its agent (fresh, freshly-unblocked, or rework), closing the
 * chained-task conflict gap: a branch cut from a STALE default HEAD (before its
 * blockers merged) would otherwise only collide at the final merge, even though
 * the chain ran the task AFTER its blockers merged. By bringing the branch up to
 * the current default tip up front, the agent works on the merged state.
 *
 * Delegates the actual git work to git.rebaseOntoDefault (up-to-date / dirty →
 * no-op; no commits → reset onto the tip; has commits → rebase onto the tip). The
 * rebase is serialized through the global merge queue so it can't race a merge
 * advancing the default ref, but only AFTER a cheap lock-free isBehindDefault
 * check so the overwhelmingly common up-to-date branch never touches the queue.
 *
 * On a rebase CONFLICT we route it through the same channel reject / merge-conflict
 * use: append an actionable conflict note to task.md + review_note so the agent
 * resolves it (the dispatch is a `--resume`, since only a task with commits can
 * conflict and such a task has already run). Dispatch then proceeds to LAUNCH the
 * agent with that note rather than aborting (which would just re-conflict on the
 * next tick and loop) — the agent integrates the base and re-submits, and the
 * merge-time rebase is then clean. Returns the outcome for logging/tests.
 */
export async function prepareBranchForDispatch(id: string): Promise<BranchPrep> {
  const row = getTask(id);
  if (!row) return { ok: true, rebased: false, conflict: false };
  const dir = getWorkspace(row.workspace_id);
  if (!dir) return { ok: true, rebased: false, conflict: false };

  // Cheap, lock-free gate: a freshly-created worktree already contains the tip, so
  // skip the merge queue entirely for it (the common case).
  if (!(await git.isBehindDefault(dir.path, id))) {
    return { ok: true, rebased: false, conflict: false };
  }

  // Behind the tip → do the move under the merge queue so it can't interleave with
  // a concurrent merge advancing the default ref (rebaseOntoDefault re-checks the
  // ancestor relationship inside, since the tip may have advanced before we ran).
  const res = await runExclusiveMerge(() => git.rebaseOntoDefault(dir.path, id));

  if (res.conflict) {
    const base = await git.defaultBranch(dir.path);
    const note = buildConflictNotes(id, base, res.conflictFiles, res.message);
    // Surface it (NOT a silent dispatch): record the note in task.md (the resumed
    // agent reads it via renderReworkPrompt) and in review_note for the UI.
    appendRejection(dir.path, id, note, nowIso());
    db.query(`UPDATE tasks SET review_note=? WHERE id=?`).run(note, id);
    emitUpdated(id);
    return { ok: false, rebased: false, conflict: true };
  }
  if (!res.ok) {
    // Hard git error (not a conflict). Leave the branch as-is and let dispatch
    // proceed — the merge-time rebase gate still protects the default branch.
    console.warn(
      `[butchr] pre-dispatch rebase of ${id} failed (non-conflict): ${res.message}`,
    );
    return { ok: false, rebased: false, conflict: false };
  }
  return { ok: true, rebased: res.rebased, conflict: false };
}

// --- IDEA → SPEC_REVIEW: the CEO/CTO-fork spec generation handshake ----------
//
// The pipeline's FRONT state is `idea`: a task created from a one-line brief with no
// spec yet (see createTask). The dispatcher runs the CEO agent — the CTO-fork spec
// generator (src/cto.ts, headless + read-only) — to turn the brief into a repo-grounded
// SPEC, then calls promoteIdeaToSpecReview to advance the task to `spec_review`, where
// the operator approves the spec (→ in_progress) or requests changes (→ revise the spec,
// back to idea). A generation FAILURE goes through markSpecGenFailure (bounded
// backoff/retry, then give-up to `aborted`). The blocker check is deferred to the
// spec_review approval (see respondToFeedback).

/**
 * Advance an `idea` task to `spec_review` once its spec is generated. Rewrites the
 * task.md prompt from the operator's brief to the full SPEC (so the SPEC becomes the
 * task's prompt AND the artifact the operator reviews), then transitions idea →
 * spec_review. Clears any spec-gen backoff/error. Guarded on status='idea' so a
 * concurrent abort wins. Returns true iff it advanced the task.
 */
export function promoteIdeaToSpecReview(id: string, spec: string): boolean {
  const row = getTask(id);
  if (!row || row.status !== "idea") return false;
  const clean = (spec ?? "").trim();
  if (!clean) return false;
  const dir = getWorkspace(row.workspace_id);
  if (dir) updateTaskMdPrompt(dir.path, id, clean);

  if (
    !setStatus(id, "spec_review", {
      from: "idea",
      note: "spec generated — awaiting operator approval",
      set: {
        dispatch_attempts: 0,
        last_dispatch_error: null,
        next_dispatch_at: null,
        // Clear any prior change-request note now that a fresh spec exists.
        review_note: null,
      },
    })
  ) {
    return false; // moved under us (e.g. aborted)
  }
  console.log(`[butchr] idea task ${id} → spec_review (spec generated)`);
  return true;
}

/**
 * Record a CTO-fork spec-generation FAILURE for an `idea` task (generateSpec returned
 * null / threw, or the dispatcher's spec-gen step failed) and apply the SAME bounded
 * retry/backoff/give-up state machine as markDispatchFailure — except the task stays in
 * `idea` between retries (it has not produced a spec yet) rather than re-queuing as a
 * build task. At/over the attempt cap it moves to the terminal `failed` state (an
 * execution failure, NOT an operator cancel — see `aborted`); the operator can delete +
 * recreate the idea if they want to try again.
 */
export function markSpecGenFailure(id: string, err: string): void {
  const row = getTask(id);
  if (!row || row.status !== "idea") return;
  const attempts = (row.dispatch_attempts ?? 0) + 1;

  if (attempts >= config.maxDispatchAttempts) {
    // setStatus mirrors the new status into task.md + records the audit event. A
    // spec-generation give-up is an EXECUTION failure → the terminal idle state
    // `failed` (reserve `aborted` for a deliberate operator cancel); last_dispatch_error
    // explains why.
    setStatus(id, "failed", {
      from: "idea",
      note: `spec generation gave up after ${attempts} attempt${attempts === 1 ? "" : "s"}`,
      set: { dispatch_attempts: attempts, last_dispatch_error: err, next_dispatch_at: null, completed_at: keep(nowIso()) },
    });
    console.error(`[butchr] idea task ${id} spec generation failed after ${attempts} attempts: ${err}`);
    return;
  }

  const nextAt = new Date(Date.now() + dispatchBackoffMs(attempts)).toISOString();
  db.query(
    `UPDATE tasks SET dispatch_attempts=?, last_dispatch_error=?, next_dispatch_at=? WHERE id=? AND status='idea'`,
  ).run(attempts, err, nextAt, id);
  console.warn(
    `[butchr] idea task ${id} spec generation attempt ${attempts}/${config.maxDispatchAttempts} ` +
      `failed; retrying after ${nextAt}: ${err}`,
  );
  emitUpdated(id);
}

// ===========================================================================
// THE UNIFIED FEEDBACK MECHANISM (spec_review / in_review / needs_info).
// ===========================================================================
// The three FEEDBACK states share ONE shape and ONE code path: butchr surfaces an
// ARTIFACT, awaits an OPERATOR RESPONSE, then either FORWARDS the task to the next
// state or RESUMES the agent. They differ only in (artifact, which responses are
// valid, where each response routes):
//
//   state        artifact   approve →               request_changes →        answer →
//   -----------  ---------  ----------------------  -----------------------  -----------------
//   spec_review  spec       inactive/blocked        idea (re-generate spec)  —
//   in_review    diff       MECHANICAL MERGE        inactive (resume)        —
//                           (merged/rolled_back;
//                            conflict→inactive)
//   needs_info   question   —                       —                        inactive (resume)
//
// respondToFeedback is that single path; approveTask / rejectTask / answerTask are
// thin public wrappers over it (kept for the existing API / CLI / test surface).

export type FeedbackArtifact = "spec" | "diff" | "question";
export type FeedbackResponseType = "approve" | "request_changes" | "answer";

/**
 * Describe a feedback state's artifact + the responses it accepts (or null when the
 * status is not a feedback state). The single definition the UI reads to show "what's
 * awaited" and that respondToFeedback validates against.
 */
export function feedbackInfo(
  status: TaskStatus,
): { artifact: FeedbackArtifact; awaiting: string; accepts: FeedbackResponseType[] } | null {
  switch (status) {
    case "spec_review":
      return { artifact: "spec", awaiting: "operator approval of the generated spec", accepts: ["approve", "request_changes"] };
    case "in_review":
      return { artifact: "diff", awaiting: "operator review of the diff", accepts: ["approve", "request_changes"] };
    case "needs_info":
      return { artifact: "question", awaiting: "an answer to the agent's question", accepts: ["answer"] };
    default:
      return null;
  }
}

export type FeedbackResponse =
  | { type: "approve" }
  | { type: "request_changes"; note: string }
  | { type: "answer"; answer: string };

/**
 * THE unified feedback handler. Validates that `id` is in a feedback state that
 * accepts `response.type`, then forwards or resumes per the table above. Returns an
 * ApproveOutcome (its `task` is the post-transition view). An in_review APPROVE runs the
 * MECHANICAL MERGE synchronously (finalizeMerge — no finalize agent), so its outcome
 * (merged/rolled_back, a conflict bounce, or a post-merge revert) is reflected on return.
 */
export async function respondToFeedback(
  id: string,
  response: FeedbackResponse,
): Promise<ApproveOutcome> {
  const row = getTask(id);
  if (!row) throw new HttpError(404, `task not found: ${id}`);
  const info = feedbackInfo(row.status);
  if (!info) {
    throw new HttpError(409, `task is not awaiting feedback (status=${row.status})`);
  }
  if (!info.accepts.includes(response.type)) {
    throw new HttpError(
      409,
      `a ${row.status} task does not accept '${response.type}' — it awaits ${info.awaiting}`,
    );
  }
  const dir = getWorkspace(row.workspace_id);
  if (!dir) throw new HttpError(404, "workspace not found");

  // ---- APPROVE ----
  if (response.type === "approve") {
    if (row.status === "spec_review") {
      // FORWARD: the spec is approved → build it. The blocker check deferred at
      // creation now applies: with outstanding blockers the task waits in `blocked`
      // (auto-unblocks to inactive later); else it's ready in `inactive`.
      const blockers = parseBlockedBy(row.blocked_by);
      const to: TaskStatus = allBlockersMerged(blockers) ? "inactive" : "blocked";
      setStatus(id, to, {
        from: "spec_review",
        note: to === "inactive" ? "spec approved — ready to build" : "spec approved — waiting on blockers",
        set: { review_note: null, next_dispatch_at: null },
      });
      if (to === "blocked") logDeadBlockers(id, blockers);
      return { task: taskView(id)! };
    }
    // in_review APPROVE → MECHANICAL MERGE (no finalize agent). The workspace agent
    // already exited at review, so there is nothing to run: butchr rebases the branch
    // onto the default branch, runs the post-merge verify gate, merges, and tears down
    // — landing the task `merged` (or `rolled_back` for a rollback task). A rebase
    // CONFLICT bounces the task back to `inactive` so the SAME agent resumes in-context
    // (its session) to resolve it, then re-reviews. Awaited so the operator gets the
    // definitive outcome (merged / conflictSentBack / revertedOnRed). See finalizeMerge.
    return finalizeMerge(id);
  }

  // ---- REQUEST CHANGES ----
  if (response.type === "request_changes") {
    const note = (response.note ?? "").trim();
    if (!note) throw new HttpError(400, "a change-request note is required");
    appendRejection(dir.path, id, note, nowIso());
    if (row.status === "spec_review") {
      // REVISE the spec: log the note and send the task back to `idea` so the CEO
      // agent re-runs the spec generator addressing it (then → spec_review again).
      setStatus(id, "idea", {
        from: "spec_review",
        note: "spec changes requested — regenerating",
        set: {
          review_note: note,
          dispatch_attempts: 0,
          last_dispatch_error: null,
          next_dispatch_at: null,
        },
      });
      emitUpdated(id);
      return { task: taskView(id)! };
    }
    // in_review REQUEST CHANGES → RESUME the workspace agent with the notes.
    await requestChanges(
      id,
      note,
      row.herdr_pane_id,
      row.herdr_tab_id,
      "changes requested by reviewer",
    );
    emitUpdated(id);
    return { task: taskView(id)! };
  }

  // ---- ANSWER (needs_info) ----
  const answer = (response.answer ?? "").trim();
  if (!answer) throw new HttpError(400, "answer is required");
  await resumeWithAnswer(id, dir.path, row, answer);
  return { task: taskView(id)! };
}

/**
 * Approve a feedback task (spec_review → build, or in_review → MECHANICAL MERGE). Thin
 * wrapper over the unified feedback mechanism. Returns an ApproveOutcome; for the
 * in_review case the merge runs synchronously inside this call (see respondToFeedback /
 * finalizeMerge) so the outcome (merged/rolled_back, conflictSentBack, revertedOnRed) is
 * reflected on return.
 */
export async function approveTask(id: string): Promise<ApproveOutcome> {
  return respondToFeedback(id, { type: "approve" });
}

/**
 * MECHANICAL MERGE on approve: rebase the task's branch onto the default branch, run
 * the post-merge verify gate, and land it — `merged` for an ordinary task, `rolled_back`
 * for a ROLLBACK task (built from the `rollback` template, kind='rollback'). NO agent
 * runs: the workspace agent already exited at review. Invoked synchronously from the
 * in_review approve path, from auto-merge, and from boot recovery of a `rolling_back`
 * task. Serialized through the global merge queue.
 *  - clean merge → merged (ordinary) / rolled_back (rollback task).
 *  - rebase/merge CONFLICT → bounced to `inactive` (the SAME agent resumes in-context
 *    via its session to resolve it, then re-reviews).
 *  - post-merge verify RED → auto-reverted off main; task → `failed` (revert_reason set).
 * A no-op (returns the current view) unless the task is awaiting/mid merge (in_review,
 * or `rolling_back` for a rollback resume), so it is safe to call from more than one path.
 *
 * A ROLLBACK task gets its own visible lifecycle tail: it flips in_review → `rolling_back`
 * for the merge and lands `rolled_back` instead of `merged`.
 */
export async function finalizeMerge(id: string): Promise<ApproveOutcome> {
  const row = getTask(id);
  if (!row) throw new HttpError(404, `task not found: ${id}`);
  if (row.status !== "in_review" && row.status !== "rolling_back") {
    return { task: taskView(id)! };
  }
  const dir = getWorkspace(row.workspace_id);
  if (!dir) throw new HttpError(404, "workspace not found");

  // ROLLBACK tasks land as `rolled_back` (not `merged`) and show `rolling_back` while
  // the revert merges; ordinary tasks stay `in_review` until they land as `merged`.
  // `inflight` is the status the merge guards transition FROM; `landed` is the terminal.
  const isRollback = row.kind === "rollback";
  const inflight: TaskStatus = isRollback ? "rolling_back" : "in_review";
  const landed: TaskStatus = isRollback ? "rolled_back" : "merged";
  // Enter the rollback lifecycle tail before the mechanical merge (idempotent on a
  // recovery re-entry where the task is already `rolling_back`). The agent has exited,
  // so clear its pane/note.
  if (isRollback && row.status === "in_review") {
    setStatus(id, "rolling_back", {
      from: "in_review",
      note: "approved — rolling back (mechanical revert merge)",
      set: { review_note: null, herdr_pane_id: null, herdr_tab_id: null, idle: 0, conflict: 0 },
    });
  }

  // Serialize through the global merge queue so concurrent approvals rebase+ff
  // one-at-a-time against an up-to-date base tip instead of racing in parallel.
  //
  // The verify gate + its auto-revert run INSIDE this same exclusive section: a
  // merge fast-forwards the default branch, then (if it stuck) we build+test the
  // NEW tip and, on RED, reset the default branch back to the captured pre-merge
  // tip — all before the next queued merge runs, so a revert can never interleave
  // with another merge moving the same branch.
  type Gate = {
    mr: git.MergeResult;
    verify?: { ok: boolean; output: string };
    reverted?: boolean;
    priorTip?: string | null;
  };
  const gate: Gate = await runExclusiveMerge<Gate>(async () => {
    // Capture the default-branch tip BEFORE the ff so we can restore it on RED.
    const priorTip = await git.headSha(dir.path).catch(() => null);
    // Pass the task summary so git.merge can record the CHANGELOG entry + version
    // bump itself (inside this merge lock, after the rebase) — agents no longer
    // edit CHANGELOG.md / package.json. See git.finalizeLivingDocs.
    const mr = await git.merge(dir.path, id, row.summary ?? null);
    if (!mr.ok) return { mr };
    // Merge stuck (ff'd into main). Gate the new tip: the workspace's build/test
    // gate command must be GREEN (its own gate_cmd, or the default config.verifyCmd).
    const verify = await verifyDefaultBranch(dir.path, workspaceGateCmd(dir.id));
    if (verify.ok) return { mr, verify };
    // RED — undo the ff so a broken commit never sits on main. We need the prior
    // tip to reset to; if we somehow failed to capture it, we can't safely revert,
    // so surface that loudly and let the merge stand (flagged) rather than guess.
    if (priorTip) {
      await git.resetHard(dir.path, priorTip).catch((e) => {
        console.error(
          `[butchr] CRITICAL: verify FAILED for ${id} but the auto-revert to ` +
            `${priorTip} ALSO failed: ${e}. The default branch may hold a broken commit.`,
        );
      });
    } else {
      console.error(
        `[butchr] CRITICAL: verify FAILED for ${id} but the pre-merge tip was not ` +
          `captured, so the merge could not be auto-reverted. Inspect main.`,
      );
    }
    return { mr, verify, reverted: true, priorTip };
  });

  const result = gate.mr;
  if (!result.ok) {
    if (result.conflict) {
      // Content conflict — git.merge already aborted, so the tree is CLEAN.
      // Don't dump the conflict on the human: send it back to the agent (the
      // author of the code) as a changes_requested verdict with resolution
      // steps, exactly like a reject. Returns 200, task bounces to `inactive` so
      // the dispatcher resumes the SAME session in-context to resolve it.
      const base = await git.defaultBranch(dir.path);
      const notes = buildConflictNotes(id, base, result.conflictFiles, result.message);
      appendRejection(dir.path, id, notes, nowIso());
      // Same channel as reject: into the live agent if blocked, else re-queue
      // (requestChanges tears down any lingering tab in the fallback).
      await requestChanges(
        id,
        notes,
        row.herdr_pane_id,
        row.herdr_tab_id,
        "merge conflict — sent back to agent",
      );
      emitUpdated(id);
      return { task: taskView(id)!, conflictSentBack: true };
    }
    // Non-conflict merge failure — genuinely unusual/unsafe; surface to the human.
    db.query(
      `UPDATE tasks SET conflict=1, review_note=? WHERE id=?`,
    ).run(result.message, id);
    emitUpdated(id);
    throw new HttpError(409, `merge failed: ${result.message}`);
  }

  // Merge succeeded at the git level, but the post-merge verify gate came back RED
  // and the ff was auto-reverted (default branch reset to its pre-merge tip). Do
  // NOT mark landed: move the task to the terminal `failed` state (an EXECUTION
  // failure, not an operator cancel) so a human can see the breakage and the
  // dispatcher won't silently re-launch it. We KEEP the worktree + branch (no
  // git.cleanup) so the work survives for inspection / a fixup re-run, and store
  // the failing build/test output in `revert_reason` (surfaced by the webapp).
  if (gate.reverted) {
    const snapshot = readRunLogSnapshot(id);
    await herdr.teardownTask(row.herdr_tab_id, id, row.herdr_pane_id);
    const reason = gate.verify?.output?.trim() || "(no verify output captured)";
    console.error(
      `[butchr] task ${id} merge AUTO-REVERTED: post-merge verify failed on the ` +
        `default branch; main restored to ${gate.priorTip ?? "(unknown)"}.\n${reason}`,
    );
    const res = db.query(
      `UPDATE tasks SET status='failed', conflict=0, idle=0, herdr_pane_id=NULL, herdr_tab_id=NULL,
         output_snapshot=COALESCE(?, output_snapshot), revert_reason=?, last_dispatch_error=?,
         completed_at=COALESCE(completed_at, ?)
         WHERE id=? AND status=?`,
    ).run(snapshot || null, reason, reason, nowIso(), id, inflight);
    if (res.changes === 0) {
      // Raced (e.g. aborted) between the gate and here — leave whatever won.
      emitUpdated(id);
      return { task: taskView(id)! };
    }
    recordTaskEvent(
      id,
      inflight,
      "failed",
      "merge auto-reverted off main (post-merge verify failed)",
    );
    updateTaskMdStatus(dir.path, id, "failed");
    emitUpdated(id);
    return { task: taskView(id)!, revertedOnRed: true };
  }

  // Merge succeeded. No agent runs at this point (the workspace agent exited at review),
  // so close the task to its terminal landed state directly. The branch is already in
  // main; capture whatever the agent last logged, tear down the worktree + branch, and
  // stamp the landed state (`merged`, or `rolled_back` for a rollback task).
  const snapshot = readRunLogSnapshot(id);
  // Close the agent's dedicated tab (best-effort — usually already gone since the
  // agent exited after request_review, but removes any empty husk tab) and discard
  // the worktree + branch (already landed in main). Awaited so the landed write below
  // only runs after teardown — a teardown failure propagates, exactly as before.
  await teardownAndDiscard(dir, row, {});
  if (
    !setStatus(id, landed, {
      from: inflight,
      note:
        landed === "rolled_back"
          ? "rolled back & merged into the default branch"
          : "merged into the default branch",
      set: {
        review_note: null,
        conflict: 0,
        idle: 0,
        herdr_pane_id: null,
        herdr_tab_id: null,
        output_snapshot: snapshot || null,
        merge_base_sha: result.baseSha ?? null,
        merged_sha: result.mergedSha ?? null,
        merged_at: keep(nowIso()),
      },
    })
  ) {
    // Raced (e.g. aborted) between the merge and here — the branch already landed
    // in main, but the task moved on. Nothing more to do.
    emitUpdated(id);
    // The branch DID land in main, so any task blocked on it may now be eligible.
    reevaluateAllBlocked();
    return { task: taskView(id)! };
  }
  // This task just merged — promote any task that was blocked on it (and whose
  // other blockers are also merged) to queued right away, rather than waiting for
  // the next dispatcher tick to notice.
  reevaluateAllBlocked();
  return { task: taskView(id)! };
}

/**
 * Request changes on a feedback task (in_review → resume the workspace agent via
 * `inactive`, or spec_review → revise the spec). Thin public wrapper over the unified
 * feedback mechanism — kept under the historical name for the existing API / CLI / test
 * surface. Returns the post-transition task view. 409 if the task isn't in a feedback
 * state that accepts request-changes; 400 on a blank note.
 */
export async function rejectTask(id: string, note: string): Promise<TaskView> {
  const outcome = await respondToFeedback(id, { type: "request_changes", note });
  return outcome.task;
}

/**
 * Abort a task without merging: discard its worktree + branch and move it to the
 * terminal idle `aborted` state (a DELIBERATE operator cancel — an execution failure
 * instead lands in `failed`). Works from any non-terminal state. For a task with a LIVE
 * agent (in_progress with a pane) we first signal its watcher to bail and close the
 * herdr pane so the agent stops before we tear the worktree down. A feedback/blocked/
 * inactive task has no live process, so abort just discards its DB state + worktree.
 */
export async function abortTask(id: string): Promise<TaskView> {
  const row = getTask(id);
  if (!row) throw new HttpError(404, `task not found: ${id}`);
  if (row.status === "merged") {
    throw new HttpError(409, "task is already merged");
  }
  if (row.status === "aborted") {
    throw new HttpError(409, "task is already aborted");
  }
  const dir = getWorkspace(row.workspace_id);
  if (!dir) throw new HttpError(404, "workspace not found");

  // Tell the watcher (if any) to stop before we kill the tab / remove the tree,
  // so it never transitions the task to review behind us.
  signalAbort(id);
  // Close the agent's whole tab (kills the agent + removes the dedicated tab) and
  // throw away the worktree + branch — nothing gets merged. Awaited (a teardown
  // failure propagates, as before).
  await teardownAndDiscard(dir, row, {});

  setStatus(id, "aborted", {
    note: "aborted by operator",
    set: {
      conflict: 0,
      idle: 0,
      review_note: null,
      output_snapshot: null,
      herdr_pane_id: null,
      herdr_tab_id: null,
      completed_at: nowIso(),
    },
  });
  return taskView(id)!;
}

// --- dispatcher-facing state transitions (kept here so all writes live together) ---

export function markRunning(
  id: string,
  paneId: string,
  sessionId: string,
  tabId?: string,
  groundingFp?: string,
): void {
  const row = getTask(id);
  if (!row) return;
  // The task being launched is a READY `inactive` build task. This FLIPS it to
  // `in_progress` (running) and records its pane in one atomic write — the ready-vs-
  // running distinction is now the STATUS itself, so a running `in_progress` always has
  // a pane. The `status='inactive'` guard makes this a no-op if the task was aborted /
  // already launched / moved under us in the same tick. `session_id` is set with
  // COALESCE so it sticks to the FIRST id assigned (a resume keeps its existing id);
  // a successful launch clears the dispatch retry state and consumes any pending ASK
  // answer (it has been injected into this launch's rendered prompt). `grounding_fp`
  // records the prompt+context fingerprint this launch grounds the agent in (the
  // dispatcher computes it from the CURRENT task.md and passes it here) — the resume
  // path compares it to detect a prompt/context edit made while the task was paused
  // (see dispatcher.dispatch + taskmd.renderRegroundBlock). COALESCE(?, grounding_fp)
  // overwrites it when a fingerprint is supplied and leaves it untouched otherwise.
  const res = db.query(
    `UPDATE tasks SET status='in_progress', herdr_pane_id=?, herdr_tab_id=?,
       session_id=COALESCE(session_id, ?), started_at=COALESCE(started_at, ?),
       dispatch_attempts=0, last_dispatch_error=NULL, next_dispatch_at=NULL, answer=NULL,
       grounding_fp=COALESCE(?, grounding_fp)
       WHERE id=? AND status='inactive'`,
  ).run(paneId, tabId ?? null, sessionId, nowIso(), groundingFp ?? null, id);
  if (res.changes === 0) return; // aborted / already running / moved under us
  // Record the inactive→in_progress launch transition (the agent (re)started). The
  // first launch (no started_at yet) is a fresh build; later launches are resumes
  // (rework / answer / conflict-bounce) — both are genuine state transitions.
  recordTaskEvent(id, "inactive", "in_progress", row.started_at ? "agent resumed" : "agent launched");
  emitUpdated(id);
}

/**
 * Record a re-adopted agent task's current herdr pane + tab id. Used by the startup
 * reconcile (dispatcher.reconcileRunningTasks) when an agent it re-adopts now lives on
 * a different pane/tab than the one stored before butchr restarted. Guarded on the live
 * agent state (`in_progress`) so a concurrent transition isn't clobbered. A missing
 * tabId leaves the stored value untouched (COALESCE) rather than nulling a still-valid tab.
 */
export function adoptPane(id: string, paneId: string, tabId?: string): void {
  const res = db.query(
    `UPDATE tasks SET herdr_pane_id=?, herdr_tab_id=COALESCE(?, herdr_tab_id) WHERE id=? AND status='in_progress'`,
  ).run(paneId, tabId ?? null, id);
  if (res.changes === 0) return;
  emitUpdated(id);
}

/**
 * Repair a live task's STORED herdr_pane_id after herdr RENUMBERED it (a sibling
 * tab/pane closed shifted the positional ids). `livePaneId` is the CURRENT pane
 * resolved by agent name; we re-point the row to it so every reader of the stored
 * id (the UI's has-a-pane gate, teardown's husk defense, the live-output panel)
 * stops pointing at a now-dead sibling shell.
 *
 * Guarded so it only ever heals a genuine drift: the task must still be a LIVE build
 * agent (`in_progress`), already have a non-null pane id, and that id must actually
 * differ — so a no-drift tick is a silent no-op and we never resurrect a pane on a task
 * whose agent has exited (its id is NULL by then).
 * Returns true when it repaired (and emits an update so dashboards refresh).
 */
export function repairPaneId(id: string, livePaneId: string): boolean {
  if (!livePaneId) return false;
  const res = db.query(
    `UPDATE tasks SET herdr_pane_id=? WHERE id=? AND status='in_progress'
       AND herdr_pane_id IS NOT NULL AND herdr_pane_id<>?`,
  ).run(livePaneId, id, livePaneId);
  if (res.changes === 0) return false;
  emitUpdated(id);
  return true;
}

/**
 * Capture the task's cumulative token usage (and the model it actually ran under)
 * from the Claude Code session transcript and persist it onto the row. Called at
 * the points where the agent has finished a turn — entering review (live or
 * rescued) and on a plan task's completion — re-reading the full transcript each
 * time, so the stored totals reflect all turns including reworks.
 *
 * Best-effort and side-effect-free on failure: with no session id, no transcript,
 * or no usable turns we leave the existing columns untouched (rather than zeroing
 * them). `model_used` is COALESCE-updated so a momentarily-unreadable transcript
 * never clobbers a previously-captured model. Cost is intentionally NOT computed —
 * the transcript carries no dollar figure and we don't fabricate one (see the
 * `cost_usd` column TODO in db.ts).
 */
export function captureSessionUsage(id: string): void {
  const row = getTask(id);
  if (!row || !row.session_id) return;
  const dir = getWorkspace(row.workspace_id);
  if (!dir) return;
  const usage = readSessionUsage(git.worktreePath(dir.path, id), row.session_id);
  if (!usage) return;
  db.query(
    `UPDATE tasks SET usage_input_tokens=?, usage_output_tokens=?,
       usage_cache_read_tokens=?, usage_cache_creation_tokens=?,
       model_used=COALESCE(?, model_used) WHERE id=?`,
  ).run(
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheCreationTokens,
    usage.model,
    id,
  );
  emitUpdated(id);
}

/**
 * Capture the task's change FOOTPRINT (final changed-line count + a coarse
 * path-based type) for the duration-estimate buckets — see src/estimate.ts. Called
 * on a genuine running→review transition, WHILE the worktree still exists (it is
 * discarded at merge). Best-effort and side-effect-free on failure: no worktree, no
 * dir, or a git error leaves the columns untouched. Re-captured on each review
 * transition so a rework's final footprint overwrites an earlier one. Only writes
 * while the task is still in `review` so a task that merged/aborted under us isn't
 * resurrected. Fire-and-forget (the estimate is advisory; review never blocks on it).
 */
export async function captureDiffFootprint(id: string): Promise<void> {
  const row = getTask(id);
  if (!row) return;
  const dir = getWorkspace(row.workspace_id);
  if (!dir) return;
  if (!existsSync(git.worktreePath(dir.path, id))) return;
  let stat: git.DiffStat;
  try {
    stat = await git.diffStat(dir.path, id);
  } catch {
    return; // best-effort — leave the columns as they were
  }
  const pathType = classifyPathType(stat.files);
  db.query(
    `UPDATE tasks SET diff_lines=?, path_type=? WHERE id=? AND status='in_review'`,
  ).run(stat.changedLines, pathType, id);
  emitUpdated(id);
}

/**
 * COMMIT-ON-REVIEW: persist a WORKSPACE-agent task's uncommitted worktree diff onto
 * its task branch as a WIP commit, so the work survives the worktree being deleted
 * (a repo move, the reaper, a crash cleanup) and the branch — not the transient
 * worktree — is the durable source of truth for review-state work. Called when a task
 * transitions OUT of `in_progress` into `in_review` / `needs_info`. Best-effort +
 * idempotent (see git.commitWorktree): a failure here must never break the transition.
 */
function autoCommitOnReview(id: string, workspaceId: string): void {
  const dir = getWorkspace(workspaceId);
  if (dir) git.commitWorktree(dir.path, id, `butchr: wip ${id} (auto-saved)`);
}

/**
 * DEAD-AGENT FALLBACK: move an `in_progress` task to `in_review` because its agent
 * ended WITHOUT calling request_review (the watcher / startup reconcile rescue path;
 * the live path is markReviewFromAgent). Guarded on the build phase being live
 * (in_progress + a pane) so a task aborted while its agent was finishing isn't
 * resurrected. The caller is already tearing down the tab — we clear the ids.
 */
export function markInReview(id: string, snapshot: string): void {
  // COMMIT-ON-REVIEW (FIRST): the agent ended with uncommitted work in its worktree;
  // commit it onto the branch BEFORE the transition so this rescue path can't leave
  // the diff as worktree-only state a later deletion would lose. Only when genuinely
  // in_progress (the state this rescues from) — best-effort, never blocks the move.
  const pre = getTask(id);
  if (pre?.status === "in_progress") autoCommitOnReview(id, pre.workspace_id);
  if (
    !setStatus(id, "in_review", {
      from: "in_progress",
      note: "agent finished — submitted for review",
      set: {
        completed_at: nowIso(),
        output_snapshot: snapshot,
        herdr_pane_id: null,
        herdr_tab_id: null,
        idle: 0,
        // Reaching review IS progress — clear the auto-resume streak.
        resume_attempts: 0,
      },
    })
  ) {
    return; // aborted (or otherwise moved) under us
  }
  // Capture the session's token usage / model now that the agent has finished.
  captureSessionUsage(id);
  // Capture the change footprint (size + path type) for duration estimates while the
  // worktree still exists. Fire-and-forget — advisory, never blocks the transition.
  void captureDiffFootprint(id);
  // CI GATE: this is a genuine running→review transition (guarded above), so kick
  // off the build/test job for the task's worktree. Fire-and-forget — review must
  // not block on CI.
  void triggerCi(id);
  // SPEC-CONFORMANCE GATE: judge whether the diff satisfies the prompt. Orthogonal to
  // CI (which only proves it builds/tests). Fire-and-forget — review never blocks on it.
  void triggerConformance(id);
}

/**
 * The agent called the MCP `request_review` tool. The build (in_progress) agent is the
 * only workspace-agent phase that runs now (there is no post-approval 'final thoughts'
 * agent — approval merges MECHANICALLY, see finalizeMerge):
 *  - in_progress → in_review: the build is done; surface the diff for operator review
 *    (runs the CI + conformance gates + footprint, non-blocking). The agent EXITS
 *    right after, so we clear herdr_pane_id (its pane is about to close).
 *  - in_review (duplicate call) → no-op ok.
 *
 * Returns:
 *  - "ok"        → handled (transitioned, or a duplicate).
 *  - "terminal"  → task is in a terminal state; nothing to do.
 *  - "notfound"  → no such task.
 */
export function markReviewFromAgent(
  id: string,
  summary?: string,
): "ok" | "terminal" | "notfound" {
  const row = getTask(id);
  if (!row) return "notfound";
  if (isTerminal(row.status)) return "terminal";

  // Capture the agent's terminal output now: once it exits there is no live pane
  // for the reviewer to inspect, so the snapshot (plus the git diff) is what
  // review is conducted against.
  const snapshot = readRunLogSnapshot(id);

  // COMMIT-ON-REVIEW (FIRST): the agent is told it need not commit — butchr captures
  // its worktree. On the genuine in_progress→in_review transition, commit that diff
  // onto the branch NOW so it can't be lost as worktree-only state before merge.
  if (row.status === "in_progress") autoCommitOnReview(id, row.workspace_id);

  // BUILD PHASE: in_progress → in_review (normal), or in_review → in_review (a
  // duplicate call). Clear the pane: the agent is exiting and review holds no live
  // process. setStatus records the audit event ONLY on the genuine in_progress→
  // in_review change (a duplicate in_review→in_review is status-unchanged, so no
  // event) — matching the old `if (row.status === "in_progress")` guard exactly.
  if (
    !setStatus(id, "in_review", {
      from: ["in_progress", "in_review"],
      note: "agent requested review",
      set: {
        completed_at: keep(nowIso()),
        summary: summary ?? null,
        idle: 0,
        herdr_pane_id: null,
        output_snapshot: snapshot || null,
        // Reaching review IS progress — clear the auto-resume streak.
        resume_attempts: 0,
      },
    })
  ) {
    // Not in a phase we can submit (e.g. needs_info/blocked/aborted under us).
    return terminalOrOk(id);
  }
  // Capture the session's token usage / model now that the agent has finished this
  // turn (re-read each call so a rework's added turns are reflected too).
  captureSessionUsage(id);
  // The gates + footprint run only on a genuine in_progress→in_review transition (not
  // a duplicate request_review). Fire-and-forget — review never blocks on them.
  if (row.status === "in_progress") {
    void captureDiffFootprint(id);
    void triggerCi(id);
    void triggerConformance(id);
  }
  return "ok";
}

/**
 * Park the live build agent's task in `needs_info` because the agent called the MCP
 * `raise` tool (the ad-hoc feedback stage the `in_progress` agent can enter). Mirrors
 * markReviewFromAgent's non-blocking shape: the agent EXITS right after this returns,
 * so needs_info is pure DB state with no live process (we clear herdr_pane_id — its
 * pane is about to close). Stores what the agent raised in `question` (surfaced in
 * /health + the webapp) and the run-log snapshot for the answerer.
 *
 * Returns:
 *  - "ok"        → parked in needs_info (or already there — a duplicate ask).
 *  - "terminal"  → task is in a terminal state; nothing to do.
 *  - "notfound"  → no such task.
 */
export function markNeedsInfoFromAgent(
  id: string,
  question: string,
): "ok" | "terminal" | "notfound" {
  const row = getTask(id);
  if (!row) return "notfound";
  if (isTerminal(row.status)) return "terminal";

  // Capture the agent's terminal output now: once it exits there is no live pane,
  // so the snapshot is what the answerer sees of where the agent got stuck.
  const snapshot = readRunLogSnapshot(id);

  // COMMIT-ON-REVIEW (FIRST): when a BUILD agent (in_progress) asks, it may have
  // uncommitted work in its worktree; commit it onto the branch BEFORE parking in
  // needs_info so the diff survives a worktree deletion and the resume-on-answer
  // continues on top of it. Only on the in_progress transition; best-effort, never
  // blocks the park.
  if (row.status === "in_progress") autoCommitOnReview(id, row.workspace_id);

  // in_progress → needs_info (normal), or needs_info → needs_info (a duplicate ask).
  // Clear the pane: the agent is exiting and this state holds no live process.
  // setStatus records the audit event ONLY on a genuine change (a duplicate
  // needs_info→needs_info is status-unchanged) — matching the old
  // `if (row.status !== "needs_info")` guard exactly.
  if (
    !setStatus(id, "needs_info", {
      from: ["in_progress", "needs_info"],
      note: "agent asked a clarifying question",
      set: {
        question,
        idle: 0,
        herdr_pane_id: null,
        output_snapshot: snapshot || null,
      },
    })
  ) {
    // Not in a state we can park (e.g. it was aborted out from under the agent) —
    // report the current status so the tool surfaces it.
    return terminalOrOk(id);
  }
  // Capture the session's token usage / model now that the agent has paused this turn.
  captureSessionUsage(id);
  return "ok";
}

/**
 * RESUME an agent with an operator answer (the needs_info → inactive resume — the
 * answer half of the unified feedback mechanism). Logs the Q&A to task.md, stores the
 * `answer` (which dispatcher.dispatch injects into the `--resume` prompt and markRunning
 * consumes), clears the pending question, resets the dispatch retry state, and re-arms
 * the task as a READY `inactive` (pane NULL) KEEPING session_id + worktree so the
 * dispatcher resumes the SAME Claude session with full prior context.
 */
async function resumeWithAnswer(
  id: string,
  dirPath: string,
  row: TaskRow,
  answer: string,
): Promise<void> {
  appendAnswer(dirPath, id, row.question ?? "", answer, nowIso());
  await herdr.teardownTask(row.herdr_tab_id, id, row.herdr_pane_id);
  // The caller (respondToFeedback) only routes a needs_info task here, so the
  // unconditional re-arm to inactive records the needs_info → inactive event.
  setStatus(id, "inactive", {
    note: "question answered by operator",
    set: {
      answer,
      question: null,
      herdr_pane_id: null,
      herdr_tab_id: null,
      output_snapshot: null,
      idle: 0,
      dispatch_attempts: 0,
      last_dispatch_error: null,
      next_dispatch_at: null,
    },
  });
}

/**
 * Answer a task parked in `needs_info` (operator/CTO via API/CLI, or a human via the
 * webapp). Thin public wrapper over the unified feedback mechanism (the `answer`
 * response). 409 if the task isn't awaiting info; 400 on a blank answer.
 */
export async function answerTask(id: string, answer: string): Promise<TaskView> {
  const outcome = await respondToFeedback(id, { type: "answer", answer });
  return outcome.task;
}

// --- CI GATE: build + test on the review transition ------------------------
//
// When a task enters `review`, butchr asynchronously builds the project and runs
// its tests IN THE TASK'S WORKTREE, then records a pass/fail badge on the task
// (ci_status / ci_summary) for the webapp's review panel. This never blocks the
// review transition and never hard-blocks approval — it's an advisory gate.

/** Outcome of a CI run: a status, a compact badge label, and an output tail. */
export type CiResult = {
  status: "pass" | "fail";
  /** Compact badge label, e.g. "build + 12 tests" / "build failed" / "3 test failures". */
  label: string;
  /** Short tail of the build/test output for the reviewer (may be empty). */
  detail: string;
};

/**
 * Signature of the function that actually runs the build/test gate for a task's
 * worktree. `gateCmd` is the workspace's EFFECTIVE gate command (its own `gate_cmd`
 * or the default — resolved by triggerCi via workspaces.workspaceGateCmd).
 */
export type CiRunner = (dirPath: string, taskId: string, gateCmd: string) => Promise<CiResult>;

// The active CI runner. Overridable in tests (setCiRunner) so they can exercise
// the persistence + trigger wiring without spawning a real `bun` build/test.
let ciRunner: CiRunner = defaultCiRunner;

// Task ids whose CI gate is RUNNING in THIS butchr process right now. The gate runs
// in-process (triggerCi awaits runGate), so a butchr restart kills it AND empties this
// set — which is exactly what makes a DB ci_status='running' with no entry here PROVABLY
// stale (its build/test subprocess died with the process). recoverStuckGates keys off
// this to re-trigger only genuinely-dead gates, never one still legitimately running.
// Added synchronously before the 'running' write; cleared in a finally.
const ciInFlight = new Set<string>();

/** Is this task's CI gate running in THIS process right now? */
export function ciGateInFlight(id: string): boolean {
  return ciInFlight.has(id);
}

/** Replace the CI runner (tests inject a fake to avoid spawning bun). */
export function setCiRunner(r: CiRunner): void {
  ciRunner = r;
}

/** Keep the last ~24 lines of output as a compact, human-readable tail. */
function ciTail(s: string): string {
  const trimmed = s.replace(/\r/g, "").trimEnd();
  if (!trimmed) return "";
  return trimmed.split("\n").slice(-24).join("\n");
}

/**
 * The real CI runner: run the workspace's EFFECTIVE gate command (`gateCmd` — its
 * own `gate_cmd` or the global default `config.verifyCmd`, which is EMPTY unless set
 * via BUTCHR_VERIFY_CMD) as a single `bash -lc` invocation IN THE TASK'S
 * WORKTREE, through the shared gate runner (src/gate.ts) so the CI gate and the
 * post-merge verify gate share one bounded spawn — the CI gate inherits the same
 * `config.verifyTimeoutMs` kill-timer. A non-zero exit (or a timeout) is a FAIL with
 * the output tail; an empty gate command means "no gate configured" → a trivial
 * pass (the workspace opted out, mirroring an empty verify gate). Running the gate
 * as one command (rather than a hardcoded build-then-test split) is what lets each
 * workspace define its own arbitrary build/test command.
 */
async function defaultCiRunner(dirPath: string, taskId: string, gateCmd: string): Promise<CiResult> {
  const cmd = gateCmd.trim();
  if (!cmd) return { status: "pass", label: "no gate configured", detail: "" };
  const wt = git.worktreePath(dirPath, taskId);
  const gate = await runGate(["bash", "-lc", cmd], { cwd: wt });
  if (!gate.ok) {
    return {
      status: "fail",
      label: gate.timedOut ? "gate timed out" : "gate failed",
      detail: ciTail(gate.output),
    };
  }
  return { status: "pass", label: "gate passed", detail: ciTail(gate.output) };
}

/** Run the active CI runner once, converting a runner throw into a fail result. */
async function runCiOnce(dirPath: string, id: string, gateCmd: string): Promise<CiResult> {
  try {
    return await ciRunner(dirPath, id, gateCmd);
  } catch (e) {
    return { status: "fail", label: "CI error", detail: (e as Error).message };
  }
}

/**
 * Run the CI gate for a task that just entered `review`: flip ci_status to
 * 'running' (emit so the webapp shows a spinner), run build+test via the active
 * ciRunner, then persist the pass/fail result + summary (emit again). Never
 * throws — a runner error is recorded as a failed CI rather than crashing the
 * caller. Skips entirely (leaving ci_status NULL) when the task has no worktree to
 * build in (e.g. a task rescued to review without one).
 *
 * FLAKY-CI RETRY: a FAIL is automatically re-run up to `config.ciRetries` times
 * (default 1) before it's settled as the task's ci_status — a pass on any retry
 * wins and settles 'pass'. This absorbs flaky/transient build+test failures.
 * Retries (and the final settle-on-fail) are logged. ci_status stays 'running'
 * for the whole retry sequence, so the webapp shows a single spinner throughout.
 */
export async function triggerCi(id: string): Promise<void> {
  const row = getTask(id);
  if (!row) return;
  const dir = getWorkspace(row.workspace_id);
  if (!dir) return;
  // Nothing to build/test — leave CI unset rather than spawning bun in a dir that
  // isn't there (also what keeps tests that seed worktree-less rows from running
  // a real build).
  if (!existsSync(git.worktreePath(dir.path, id))) return;

  // Mark the gate IN FLIGHT in this process (synchronously, before the 'running' write)
  // so a concurrent recovery sweep sees it's genuinely running here and won't re-trigger
  // it; cleared in the finally below once this process is done with it.
  ciInFlight.add(id);
  try {
    db.query(`UPDATE tasks SET ci_status='running', ci_summary=NULL WHERE id=?`).run(id);
    emitUpdated(id);

    // Resolve the workspace's effective gate command ONCE for this CI run (own
    // gate_cmd or the default) and thread it through every (re)run.
    const gateCmd = workspaceGateCmd(dir.id);
    let result = await runCiOnce(dir.path, id, gateCmd);
    // Retry a FAIL up to `ciRetries` times; a pass on any retry settles 'pass'.
    const retries = Math.max(0, config.ciRetries);
    for (let attempt = 1; attempt <= retries && result.status === "fail"; attempt++) {
      console.log(
        `[butchr] CI gate FAILED for ${id} (${result.label}); ` +
          `retrying (attempt ${attempt}/${retries})`,
      );
      result = await runCiOnce(dir.path, id, gateCmd);
      if (result.status === "pass") {
        console.log(`[butchr] CI gate PASSED for ${id} on retry ${attempt}/${retries}`);
      }
    }
    if (result.status === "fail" && retries > 0) {
      console.log(
        `[butchr] CI gate settled FAIL for ${id} after ${retries} ` +
          `retr${retries === 1 ? "y" : "ies"} (${result.label})`,
      );
    }
    // First line is the badge label; the rest (if any) is the output tail.
    const summary = result.detail ? `${result.label}\n\n${result.detail}` : result.label;
    // Only write back while the task is still in review — if it merged/aborted while
    // CI ran, don't resurrect stale CI state onto it. A real settle also resets
    // gate_recovery_attempts (the restart-recovery streak) to 0 — see recoverStuckGates.
    const res = db
      .query(`UPDATE tasks SET ci_status=?, ci_summary=?, gate_recovery_attempts=0 WHERE id=? AND status='in_review'`)
      .run(result.status, summary, id);
    if (res.changes === 0) return;
    emitUpdated(id);

    // AUTO-MERGE HOOK: CI just settled to 'pass' on a still-in-review task. If
    // auto-merge is enabled and the task is low-risk, run the same approve+merge a
    // human would (post-merge verify still gates main). Fire-and-forget so CI never
    // blocks on the merge; the dispatcher tick re-checks as a backstop.
    if (result.status === "pass") void maybeAutoMerge(id);
  } finally {
    ciInFlight.delete(id);
  }
}

// --- AUTO-MERGE: land green, low-risk tasks without a human -----------------
//
// When enabled (config.autoMergeEnabled, DEFAULT OFF), a task sitting in `review`
// whose CI gate settled to 'pass' and which qualifies as LOW-RISK is approved +
// merged AUTOMATICALLY via the SAME approveTask path a human uses — so the
// post-merge verify gate still guards main and races still go through the global
// merge queue. Non-qualifying tasks wait for human review exactly as before.

/** In-flight auto-merge evaluations, keyed by task id, so the CI hook and the
 * dispatcher-tick backstop can't both drive approveTask for the same task at once
 * (belt-and-suspenders on top of approveTask's status guards + the merge queue). */
const autoMerging = new Set<string>();

/**
 * Does a changed file qualify under the allowlist? An allowlist entry is either:
 *  - a PREFIX ending in `/` (e.g. `public/`, `test/`) → matches any file under it;
 *  - a `*.ext` glob (e.g. `*.md`) → matches TOP-LEVEL files with that extension
 *    only (no slash in the path), per the spec's "top-level *.md"; or
 *  - a plain path → matches that exact file or anything beneath it as a dir.
 */
function fileAllowed(file: string, allowlist: string[]): boolean {
  const f = file.replace(/^\.\//, "");
  for (const raw of allowlist) {
    const entry = raw.trim();
    if (!entry) continue;
    if (entry.endsWith("/")) {
      if (f.startsWith(entry)) return true;
    } else if (entry.startsWith("*.")) {
      const ext = entry.slice(1); // ".md"
      if (!f.includes("/") && f.endsWith(ext)) return true;
    } else if (f === entry || f.startsWith(entry + "/")) {
      return true;
    }
  }
  return false;
}

/**
 * Pure LOW-RISK decision (no I/O) so the boundary is unit-testable. A change is
 * low-risk iff ALL of:
 *  (a) every changed file is under the allowlist, AND
 *  (b) the total changed-line count is within the threshold, AND
 *  (c) there is at least one changed file (an empty diff isn't something to
 *      auto-land).
 * Conflict (c-in-spec) is enforced separately by maybeAutoMerge / approveTask: a
 * merge conflict routes back to the agent and never lands on main.
 */
export function isLowRiskChange(
  files: string[],
  changedLines: number,
  opts: { allowlist: string[]; maxChangedLines: number },
): boolean {
  if (files.length === 0) return false;
  if (changedLines > opts.maxChangedLines) return false;
  return files.every((f) => fileAllowed(f, opts.allowlist));
}

/**
 * Evaluate an `in_review` task for auto-merge and, if it qualifies, run the same
 * mechanical merge a human approve runs. Returns true iff it actually auto-merged. Safe
 * to call repeatedly / concurrently — it no-ops unless the task is still in `in_review`
 * with ci_status='pass', and dedupes concurrent evaluations via `autoMerging`.
 *
 * It deliberately does NOT special-case conflicts itself: finalizeMerge already
 * bounces a conflicting merge back to the agent (conflictSentBack → inactive) instead
 * of landing it, so a conflict never auto-merges. We only stamp `auto_merged` + log
 * when a merge actually succeeded.
 */
export async function maybeAutoMerge(id: string): Promise<boolean> {
  if (!config.autoMergeEnabled) return false;
  if (autoMerging.has(id)) return false;

  const row = getTask(id);
  if (!row) return false;
  if (row.status !== "in_review") return false;
  if (row.ci_status !== "pass") return false;
  if (row.conflict) return false; // already-known conflict → human handles it
  if (row.auto_merged) return false; // already auto-merged (defensive)

  const dir = getWorkspace(row.workspace_id);
  if (!dir) return false;

  // Footprint check (a + b). On any git error, bail safely (leave for a human).
  let stat: git.DiffStat;
  try {
    stat = await git.diffStat(dir.path, id);
  } catch (e) {
    console.warn(`[butchr] auto-merge: diffStat failed for ${id}: ${(e as Error).message}`);
    return false;
  }
  if (
    !isLowRiskChange(stat.files, stat.changedLines, {
      allowlist: config.autoMergeAllowlist,
      maxChangedLines: config.autoMergeMaxChangedLines,
    })
  ) {
    return false;
  }

  autoMerging.add(id);
  try {
    console.log(
      `[butchr] auto-merging task ${id}: CI green + low-risk ` +
        `(${stat.files.length} file(s), ${stat.changedLines} changed line(s) ` +
        `<= ${config.autoMergeMaxChangedLines}); running the mechanical merge`,
    );
    // Land it directly via the SAME mechanical merge a human approve runs (rebase +
    // post-merge-verify gate), skipping the human. The task is in_review, so
    // finalizeMerge does the full sequence.
    const outcome = await finalizeMerge(id);
    // Only a genuine merge counts. A conflict bounced back to inactive
    // (conflictSentBack) or a post-merge-verify revert (revertedOnRed) did NOT land.
    if (outcome.conflictSentBack || outcome.revertedOnRed) {
      console.log(
        `[butchr] auto-merge of ${id} did NOT land ` +
          (outcome.conflictSentBack
            ? "(merge conflict — sent back to the agent)"
            : "(post-merge verify failed — reverted off main)"),
      );
      return false;
    }
    if (outcome.task.status === "merged" || outcome.task.status === "rolled_back") {
      // Stamp the auto-merged flag on the now-landed row (it survives — landed tasks
      // keep their row) so the webapp can distinguish auto- from human-merges.
      db.query(`UPDATE tasks SET auto_merged=1 WHERE id=?`).run(id);
      emitUpdated(id);
      console.log(`[butchr] task ${id} AUTO-MERGED (CI green + low-risk)`);
      return true;
    }
    return false;
  } catch (e) {
    // finalizeMerge can throw on an unusual/unsafe merge failure (e.g. non-conflict).
    // Don't crash the caller — leave the task in review for a human.
    console.warn(`[butchr] auto-merge of ${id} failed: ${(e as Error).message}`);
    return false;
  } finally {
    autoMerging.delete(id);
  }
}

/**
 * Flag/unflag a running build task as `idle` (agent alive but no recent CLI output).
 * Owned by the dispatcher watcher. Guarded on a LIVE build agent (status='in_progress'
 * with a pane) so a lagging watcher can't stamp the flag onto a task that has already
 * moved on, and on a value change so we only emit when it actually flips (no
 * per-second event spam).
 */
export function setIdle(id: string, idle: boolean): void {
  const want = idle ? 1 : 0;
  const res = db.query(
    `UPDATE tasks SET idle=? WHERE id=? AND status='in_progress' AND herdr_pane_id IS NOT NULL AND idle<>?`,
  ).run(want, id, want);
  if (res.changes === 0) return;
  emitUpdated(id);
}

export async function backToQueued(id: string): Promise<void> {
  // Close any lingering herdr agent/tab for this task before re-queuing, so a
  // failed dispatch never strands an orphan agent (or its tab) that would later
  // collide on `agent_name_taken`. Re-dispatch creates a fresh tab.
  //
  // This is a CLEAN re-queue (fresh intent) → READY `inactive` (pane NULL), so the
  // dispatcher relaunches it. It clears the dispatch retry state so it never counts as
  // a dispatch failure. A genuine dispatch failure goes through markDispatchFailure.
  const row = getTask(id);
  await herdr.teardownTask(row?.herdr_tab_id, id, row?.herdr_pane_id);
  db.query(
    `UPDATE tasks SET status='inactive', herdr_pane_id=NULL, herdr_tab_id=NULL,
       dispatch_attempts=0, last_dispatch_error=NULL, next_dispatch_at=NULL WHERE id=?`,
  ).run(id);
  if (row && row.status !== "inactive") {
    recordTaskEvent(id, row.status, "inactive", "re-queued");
  }
  emitUpdated(id);
}

/**
 * Compute the backoff delay (ms) before the Nth dispatch retry (1-based attempt
 * count): exponential growth capped at `dispatchBackoffCapMs`. Exported so the
 * state machine can be unit-tested without spawning real dispatches.
 *   attempt 1 → base, 2 → base*2, 3 → base*4, … capped at the cap.
 */
export function dispatchBackoffMs(attempts: number): number {
  const exp = config.dispatchBackoffBaseMs * 2 ** Math.max(0, attempts - 1);
  return Math.min(exp, config.dispatchBackoffCapMs);
}

/**
 * Record a DISPATCH failure (dispatch() threw before the agent ever launched) and
 * decide what happens next — the bounded-retry / backoff / give-up state machine:
 *
 *  - Always: increment `dispatch_attempts`, store `last_dispatch_error`, and tear
 *    down any half-created herdr agent/tab (mirrors the old backToQueued cleanup).
 *  - Under the cap (`dispatch_attempts < maxDispatchAttempts`): re-arm the task as a
 *    READY `inactive` task (pane cleared) and stamp `next_dispatch_at = now +
 *    backoff(attempts)`. The tick loop skips the task until that time, so it no longer
 *    hot-loops. Forcing `inactive` here is what keeps a dispatch that failed AFTER
 *    markRunning flipped it to `in_progress` from stranding as `in_progress`+null-pane
 *    (a state the dispatcher no longer selects).
 *  - At/over the cap: the give-up is an EXECUTION failure → the terminal idle state
 *    `failed` (reserve `aborted` for a deliberate operator cancel).
 *
 * This is the ONLY path that increments dispatch_attempts. Request-changes / conflict
 * kick-back (requestChanges) and the clean backToQueued re-queue reset it instead.
 */
export async function markDispatchFailure(id: string, err: string): Promise<void> {
  const row = getTask(id);
  if (!row) return;
  // Free any orphaned herdr agent/tab from the failed start so a retry doesn't
  // collide on `agent_name_taken`.
  await herdr.teardownTask(row.herdr_tab_id, id, row.herdr_pane_id);

  const attempts = (row.dispatch_attempts ?? 0) + 1;

  if (attempts >= config.maxDispatchAttempts) {
    setStatus(id, "failed", {
      note: `dispatch gave up after ${attempts} attempt${attempts === 1 ? "" : "s"}`,
      set: {
        dispatch_attempts: attempts,
        last_dispatch_error: err,
        next_dispatch_at: null,
        herdr_pane_id: null,
        herdr_tab_id: null,
        completed_at: keep(nowIso()),
      },
    });
    console.error(
      `[butchr] task ${id} failed to dispatch after ${attempts} attempts: ${err}`,
    );
    return;
  }

  // Under the cap: re-arm as READY `inactive` (pane cleared) with a backoff. Setting
  // the status explicitly (not just clearing the pane) guarantees a failure after
  // markRunning can't leave an orphaned `in_progress`+null-pane row.
  const nextAt = new Date(Date.now() + dispatchBackoffMs(attempts)).toISOString();
  db.query(
    `UPDATE tasks SET status='inactive', dispatch_attempts=?, last_dispatch_error=?,
       next_dispatch_at=?, herdr_pane_id=NULL, herdr_tab_id=NULL WHERE id=?`,
  ).run(attempts, err, nextAt, id);
  console.warn(
    `[butchr] dispatch attempt ${attempts}/${config.maxDispatchAttempts} failed ` +
      `for ${id}; retrying after ${nextAt}: ${err}`,
  );
  emitUpdated(id);
}

/**
 * Operator escape hatch: revive a stuck NON-terminal task (e.g. one waiting out a
 * dispatch backoff) by clearing its dispatch retry state and re-arming it as a READY
 * `inactive` task, so the dispatcher retries it fresh. Refuses terminal tasks
 * (merged/failed/rolled_back/aborted) — a dispatch give-up now lands in the terminal
 * `failed` state, so recreate the task instead.
 */
export async function requeueTask(id: string): Promise<TaskView> {
  const row = getTask(id);
  if (!row) throw new HttpError(404, `task not found: ${id}`);
  if (isTerminal(row.status)) {
    throw new HttpError(409, `task is ${row.status}; cannot re-queue`);
  }
  // Tear down any lingering agent/tab defensively before a fresh dispatch.
  await herdr.teardownTask(row.herdr_tab_id, id, row.herdr_pane_id);
  setStatus(id, "inactive", {
    note: "manually re-queued by operator",
    set: {
      dispatch_attempts: 0,
      last_dispatch_error: null,
      next_dispatch_at: null,
      herdr_pane_id: null,
      herdr_tab_id: null,
      // Operator re-queue is a fresh start — clear the auto-resume streak too.
      resume_attempts: 0,
    },
  });
  return taskView(id)!;
}

/**
 * HOST/HERDR-RESTART AUTO-RESUME. A power loss / herdr restart kills a task's
 * `claude` process while herdr restores its pane as a bare login shell and keeps the
 * agent NAME registered (so `agentExists` lies — see src/liveness.ts). When the
 * caller has confirmed the process is NOT actually alive AND it wasn't a clean exit
 * (the `.done` exit-code file is the caller's separate discriminator), this resets the
 * task so the dispatcher re-launches it EXACTLY where it left off:
 *
 *  - Tears down the dead husk tab/pane so the re-dispatch starts a fresh tab and
 *    nothing collides on `agent_name_taken`.
 *  - Clears `herdr_pane_id` → the task is READY again; the normal dispatch tick relaunches
 *    it. Because `started_at` is set and (usually) `session_id` is kept, the dispatcher's
 *    resolveLaunchCommand picks `claude --resume <session_id>` — full prior context.
 *  - If the session TRANSCRIPT is gone (nothing to resume into), clears `session_id` so
 *    the relaunch is a FRESH run from the full prompt (resolveLaunchCommand's lostContext
 *    path) rather than `--resume ""` — never a silent zombie.
 *  - BOUNDED by config.maxResumeAttempts: past the cap (or when auto-resume is disabled,
 *    `<=0`) it rescues the task to `in_review` for a human instead, so a session that
 *    dies the instant it relaunches can't re-dispatch-loop forever.
 *
 * Only acts on an `in_progress` (build) task — there is no post-approval agent to resume
 * (approval merges mechanically). Returns what it did. Never throws (best-effort teardown).
 */
export async function requeueForResume(
  id: string,
  reason: string,
): Promise<"resumed" | "fresh" | "rescued" | "noop"> {
  const row = getTask(id);
  if (!row || row.status !== "in_progress") return "noop";

  // Tear down the dead husk tab/pane (a fallen-to-shell pane, or a gone agent) so the
  // re-dispatch spins up a fresh tab and the agent name is free. Best-effort.
  await herdr.teardownTask(row.herdr_tab_id, id, row.herdr_pane_id);

  const attempts = (row.resume_attempts ?? 0) + 1;

  // BOUNDED / disabled: stop the resume loop and hand the task to a human in review.
  if (config.maxResumeAttempts <= 0 || attempts > config.maxResumeAttempts) {
    const prior = row.resume_attempts ?? 0;
    const note =
      `[butchr] moved to review automatically: ${reason}. ` +
      (config.maxResumeAttempts <= 0
        ? `Auto-resume is disabled (BUTCHR_MAX_RESUME_ATTEMPTS<=0).`
        : `butchr already auto-resumed it ${prior} time(s) without the agent reaching ` +
          `review (cap ${config.maxResumeAttempts}); stopping the resume loop so a ` +
          `human can inspect it.`) +
      `\n\n` +
      readRunLogSnapshot(id);
    // markInReview resets resume_attempts to 0 (a human now owns it).
    markInReview(id, note);
    console.warn(
      `[butchr] task ${id} not auto-resumed (${reason}); rescued → in_review ` +
        `(resume cap ${config.maxResumeAttempts})`,
    );
    return "rescued";
  }

  // Resume vs. fresh: does the session transcript still exist to --resume into?
  const dir = getWorkspace(row.workspace_id);
  const worktree = dir ? git.worktreePath(dir.path, id) : "";
  const hasTranscript = !!row.session_id && !!findTranscript(worktree, row.session_id);
  const fresh = !hasTranscript;

  if (
    !setStatus(id, "in_progress", {
      from: "in_progress",
      set: {
        herdr_pane_id: null,
        herdr_tab_id: null,
        output_snapshot: null,
        idle: 0,
        conflict: 0,
        resume_attempts: attempts,
        // NOT a dispatch failure — clear any backoff so the relaunch is prompt.
        dispatch_attempts: 0,
        last_dispatch_error: null,
        next_dispatch_at: null,
        // No transcript to resume into → drop the session so the relaunch is a FRESH run
        // from the full prompt (resolveLaunchCommand handles the lostContext fallback).
        ...(fresh ? { session_id: null } : {}),
      },
    })
  ) {
    return "noop"; // moved out of in_progress under us (e.g. aborted) — don't claim a resume
  }
  // Within-state audit marker (status is unchanged in_progress, so setStatus records no
  // event — mirror the auto-nudge's explicit timeline entry).
  recordTaskEvent(
    id,
    "in_progress",
    "in_progress",
    fresh
      ? `auto re-dispatch (${reason}); session transcript missing — FRESH run, prior in-session context lost ` +
          `(attempt ${attempts}/${config.maxResumeAttempts})`
      : `auto-resume via --resume (${reason}); attempt ${attempts}/${config.maxResumeAttempts}`,
  );
  console.log(
    `[butchr] task ${id} ${fresh ? "auto re-dispatched FRESH" : "auto-resumed (--resume)"} ` +
      `(${reason}); attempt ${attempts}/${config.maxResumeAttempts}`,
  );
  return fresh ? "fresh" : "resumed";
}

/**
 * On startup, any ROLLBACK task left mid-merge in `rolling_back` (butchr stopped while
 * its mechanical revert merge was in flight) is re-driven through finalizeMerge so it
 * lands (`rolled_back`) or bounces (conflict → `inactive`) rather than stranding. There
 * is no equivalent recovery for ordinary `in_review` tasks: an approve that crashed
 * mid-merge simply leaves the task in `in_review` for the operator to re-approve (the
 * branch/worktree are intact). Returns how many rollbacks were re-driven.
 */
export async function recoverRollingBackTasks(): Promise<number> {
  const rows = db
    .query<TaskRow, []>(`SELECT * FROM tasks WHERE status='rolling_back'`)
    .all();
  for (const r of rows) await finalizeMerge(r.id).catch(() => {});
  return rows.length;
}

/** What recoverStuckGates did across all tasks: CI re-triggers, conformance re-triggers,
 * and force-settles (gates capped/un-runnable). Surfaced in the startup + backstop logs. */
export type GateRecoveryResult = { ci: number; conformance: number; settled: number };

/**
 * GATE RECOVERY — the sibling of requeueForResume for CI/conformance GATES. Both gates
 * run FIRE-AND-FORGET in butchr's OWN process: triggerCi awaits the build/test subprocess
 * and triggerConformance awaits the headless reviewer. A power loss / restart kills butchr
 * mid-run, so the gate's settle write never happens and the task is left stuck
 * `ci_status='running'` / `conformance_status='checking'` FOREVER — it can never become
 * mergeable (auto-merge needs ci_status='pass') until an operator manually requeues it.
 * This is the EXACT incident this function fixes.
 *
 * It sweeps every `in_review` task with a mid-flight gate and re-triggers the gate that
 * is NOT actually live in THIS process:
 *  - `ci_status='running'` with no `ciGateInFlight(id)` → the CI subprocess is gone → re-run
 *    triggerCi.
 *  - `conformance_status='checking'` with no `conformanceGateInFlight(id)` → the reviewer is
 *    gone → re-run triggerConformance.
 *
 * The in-process liveness sets are the cheap reuse of rosy-owl's liveness idea: on a fresh
 * boot they're EMPTY, so every in-flight gate status is provably stale (the restart-case
 * rule "any in-flight gate is stale") and gets re-triggered; while butchr is up they track
 * genuinely-running gates, so this is also safe to call as a periodic/backstop sweep without
 * clobbering a gate that is legitimately still running (the mid-run-death-without-restart
 * case degrades to "leave the live one alone").
 *
 * BOUNDED by config.maxGateRecoveryAttempts via the `gate_recovery_attempts` column (reset
 * to 0 whenever a gate settles a real result — see triggerCi / triggerConformance): past the
 * cap (or when recovery is disabled, `<=0`), or when the worktree the gate needs is gone, the
 * stuck gate is FORCE-SETTLED instead of re-triggered (ci_status → 'fail' with an explanatory
 * summary; conformance_status → NULL, its "couldn't run" value) so the task is NEVER left
 * stuck — a gate that dies the instant it starts can't loop forever across crash-restarts.
 *
 * Re-triggers are fire-and-forget (the in-flight marker is set synchronously inside each
 * trigger, so liveness is correct immediately and startup never blocks on a full CI run).
 * Never throws. Returns counts of CI re-triggers, conformance re-triggers, and force-settles.
 */
export async function recoverStuckGates(): Promise<GateRecoveryResult> {
  const rows = db
    .query<TaskRow, []>(
      `SELECT * FROM tasks
         WHERE status='in_review'
           AND (ci_status='running' OR conformance_status='checking')`,
    )
    .all();
  let ci = 0;
  let conformance = 0;
  let settled = 0;
  for (const row of rows) {
    const id = row.id;
    // Which gates are STALE: mid-flight in the DB but not actually running in this process.
    const ciStale = row.ci_status === "running" && !ciGateInFlight(id);
    const confStale = row.conformance_status === "checking" && !conformanceGateInFlight(id);
    if (!ciStale && !confStale) continue; // every in-flight gate is genuinely live — leave it

    // The gate needs the task's worktree to run in. If it's gone (or the workspace is),
    // re-triggering would just no-op (triggerCi/triggerConformance bail on a missing
    // worktree, leaving the status stuck), so force-settle instead.
    const dir = getWorkspace(row.workspace_id);
    const worktreeMissing = !dir || !existsSync(git.worktreePath(dir.path, id));

    const attempts = (row.gate_recovery_attempts ?? 0) + 1;
    const capped = config.maxGateRecoveryAttempts <= 0 || attempts > config.maxGateRecoveryAttempts;

    if (capped || worktreeMissing) {
      // FORCE-SETTLE the stuck gate(s) so the task is never left stuck. Guarded on the
      // task STILL being in_review with the SAME stuck value (it may have moved/settled
      // under us). CI → 'fail' (visible, keeps it out of auto-merge); conformance → NULL
      // (its best-effort "couldn't run" value). gate_recovery_attempts reset to 0.
      const reason = worktreeMissing
        ? "its worktree is gone, so the gate cannot be re-run"
        : `butchr re-triggered it ${row.gate_recovery_attempts ?? 0} time(s) without it ` +
          `settling (cap ${config.maxGateRecoveryAttempts})`;
      if (ciStale) {
        const r = db
          .query(
            `UPDATE tasks SET ci_status='fail', ci_summary=?, gate_recovery_attempts=0
               WHERE id=? AND status='in_review' AND ci_status='running'`,
          )
          .run(
            `gate did not complete after a butchr restart — ${reason}; ` +
              `settled 'fail' so the task isn't stuck. Re-queue or re-run the gate to retry.`,
            id,
          );
        if (r.changes > 0) {
          settled++;
          emitUpdated(id);
          console.warn(
            `[butchr] task ${id} CI gate force-settled 'fail' (stuck 'running' after restart; ${reason})`,
          );
        }
      }
      if (confStale) {
        const r = db
          .query(
            `UPDATE tasks SET conformance_status=NULL, conformance_summary=NULL, gate_recovery_attempts=0
               WHERE id=? AND status='in_review' AND conformance_status='checking'`,
          )
          .run(id);
        if (r.changes > 0) {
          settled++;
          emitUpdated(id);
          console.warn(
            `[butchr] task ${id} conformance gate force-cleared (stuck 'checking' after restart; ${reason})`,
          );
        }
      }
      continue;
    }

    // Under the cap and the worktree exists → RE-TRIGGER. Record the bumped streak first
    // (triggerCi/triggerConformance reset it to 0 when they settle a real result), then
    // fire-and-forget the stale gate(s). The in-flight marker is set synchronously inside
    // each trigger, so a later backstop sweep this same boot sees them live and skips them.
    db.query(`UPDATE tasks SET gate_recovery_attempts=? WHERE id=?`).run(attempts, id);
    if (ciStale) {
      recordTaskEvent(
        id,
        "in_review",
        "in_review",
        `CI gate re-triggered after a butchr restart (was stuck 'running'); ` +
          `attempt ${attempts}/${config.maxGateRecoveryAttempts}`,
      );
      void triggerCi(id);
      ci++;
      console.log(
        `[butchr] task ${id} CI gate re-triggered (stuck 'running' after restart; ` +
          `attempt ${attempts}/${config.maxGateRecoveryAttempts})`,
      );
    }
    if (confStale) {
      recordTaskEvent(
        id,
        "in_review",
        "in_review",
        `conformance gate re-triggered after a butchr restart (was stuck 'checking'); ` +
          `attempt ${attempts}/${config.maxGateRecoveryAttempts}`,
      );
      void triggerConformance(id);
      conformance++;
      console.log(
        `[butchr] task ${id} conformance gate re-triggered (stuck 'checking' after restart; ` +
          `attempt ${attempts}/${config.maxGateRecoveryAttempts})`,
      );
    }
  }
  return { ci, conformance, settled };
}
