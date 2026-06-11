// Task service: create / list / get / diff / approve / reject. The task.md on
// disk is authoritative for prompt+metadata; the DB row tracks runtime state.
import { config } from "./config.ts";
import { triggerConformance } from "./conformance.ts";
import { db, estimateRows, isTerminal, matchesQuery, nowIso, recordTaskEvent } from "./db.ts";
import type { TaskKind, TaskRow, TaskStatus } from "./db.ts";
import {
  classifyPathType,
  computeEstimateStats,
  estimateChain,
  estimateTask,
} from "./estimate.ts";
import type { ChainEstimate, EstimateRow, Estimate } from "./estimate.ts";
import { HttpError, directoryGateCmd, getDirectory } from "./directories.ts";
import { readRunLogSnapshot, signalAbort } from "./dispatcher.ts";
import { publish } from "./events.ts";
import { runGate } from "./gate.ts";
import * as git from "./git.ts";
import * as herdr from "./herdr.ts";
import { uniqueTaskId } from "./ids.ts";
import { readSessionUsage } from "./usage.ts";
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
export type TaskView = Omit<TaskRow, "blocked_by" | "spawned_subtasks" | "tags"> & {
  prompt: string;
  context: string[];
  review_notes: string;
  blocked_by: string[];
  // Free-form organizational labels (the DB stores them as raw JSON TEXT). Empty
  // array when none. Set at creation; the webapp + CLI filter on them. See `tags`.
  tags: string[];
  // For a PLAN task, the ids of the sub-tasks it decomposed the request into (empty
  // for ordinary tasks / a plan that hasn't proposed yet). See proposeSubtasks.
  spawned_subtasks: string[];
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
 * The critical-path estimate for a task's dependency chain: for a PLAN task, the
 * longest path across its spawned sub-tasks; for an ordinary task, the path to its
 * own merge through its blockers. Returns null when there's nothing to chain (a
 * plain task with no blockers — its single estimate already covers it) or the task
 * is gone.
 */
export function taskChainEstimate(id: string): ChainEstimate | null {
  const row = getTask(id);
  if (!row) return null;
  const rows = estimateInputRows();
  const stats = computeEstimateStats(rows);
  if (row.kind === "plan") {
    const subs = parseBlockedBy(row.spawned_subtasks);
    if (subs.length === 0) return null;
    return estimateChain(subs, rows, stats);
  }
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

/** Terminal states a blocker can be in that mean it will NEVER merge. The only
 * terminal-non-merged state is `aborted` (the former `rejected`/`failed` both fold
 * into it now — see the canonical state model in db.ts). */
const DEAD_BLOCKER_STATES = new Set<TaskStatus>(["aborted"]);

/**
 * Parse a JSON-array-of-task-ids column into a clean string[]. Named for `blocked_by`,
 * but also reused to parse the identically-shaped `spawned_subtasks` column.
 */
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
 *  - "dead"    → terminal non-merged (aborted/rejected/failed) OR no longer exists
 *                (its directory was unregistered) → it will never merge.
 *  - "pending" → still in flight (queued/blocked/running/review/finalizing) → may
 *                still merge.
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

export function listTasks(directoryId: string): TaskRow[] {
  return db
    .query<TaskRow, [string]>(
      `SELECT * FROM tasks WHERE directory_id=? ORDER BY created_at DESC`,
    )
    .all(directoryId);
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
  const dir = getDirectory(row.directory_id);
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
    spawned_subtasks: parseBlockedBy(row.spawned_subtasks),
    blockerStates: blockerStatesOf(blocked_by),
    deadBlockers: deadBlockerIds(blocked_by),
    estimate: taskEstimate(id),
  };
}

// The directory task-list projection: the same parsed/enriched shape taskView
// returns, MINUS the task.md-derived fields (prompt / context / review_notes) and
// the per-task duration estimate. The list / board / graph views only need the
// runtime row plus parsed blocked_by / spawned_subtasks and the server-computed
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
 * task whose directory is gone) just contributes the DB fields — so a merged task
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
 * List a directory's tasks in the taskView shape (newest first). Per CONTRIBUTING
 * §3, endpoints return the parsed projection rather than raw rows so the webapp and
 * CLI consume one consistent shape: blocked_by / spawned_subtasks come back as real
 * id arrays and each blocker's status is precomputed (blockerStates / deadBlockers).
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
export function taskListView(directoryId: string, q?: string): TaskListView[] {
  const needle = (q ?? "").trim();
  const dirPath = needle ? (getDirectory(directoryId)?.path ?? null) : null;
  const out: TaskListView[] = [];
  for (const row of listTasks(directoryId)) {
    if (needle && !matchesQuery(taskSearchText(row, dirPath), needle)) continue;
    const blocked_by = parseBlockedBy(row.blocked_by);
    out.push({
      ...row,
      blocked_by,
      tags: parseTags(row.tags),
      spawned_subtasks: parseBlockedBy(row.spawned_subtasks),
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
 *    returns at once — used by proposeSubtasks, which must not block the MCP response.
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
  const dir = getDirectory(row.directory_id);
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
  directoryId: string,
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
  const dir = getDirectory(directoryId);
  if (!dir) throw new HttpError(404, `directory not found: ${directoryId}`);
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
  // blockers are recorded but only gate the post-approval `in_progress` transition, not
  // the spec-writing front state. A 'New task' (already carrying a spec) starts directly
  // in `in_progress` (ready — no live agent yet) unless it has unmerged blockers, in
  // which case it waits in `blocked` and auto-unblocks to `in_progress` later.
  const status: TaskStatus = taskIdea
    ? "idea"
    : allBlockersMerged(blockers)
      ? "in_progress"
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
    `INSERT INTO tasks (id, directory_id, status, blocked_by, kind, model, tags, priority, plan_preview, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    directoryId,
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
    taskIdea
      ? "idea task created"
      : kind === "plan"
        ? "plan task created"
        : "task created",
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

// --- AUTO-DECOMPOSE: a plan task spawning its sub-tasks ----------------------
//
// A PLAN task (kind='plan') runs an agent whose job is to ANALYZE the request and
// propose a DECOMPOSITION: an ordered array of sub-task specs, each with a prompt
// and a `blocked_by` set expressed as INDICES of sibling specs (the sub-task ids do
// not exist yet). The agent submits this through the per-task MCP `propose_subtasks`
// tool, which calls proposeSubtasks below. butchr validates the proposed graph
// (cycle/self/range), creates the sub-tasks in dependency order (translating each
// sibling index to the real id it was created with), records the created ids on the
// plan task, and completes the plan task (terminal — it merges nothing of its own).

/** One proposed sub-task in a plan's decomposition (see proposeSubtasks). */
export type SubtaskSpec = {
  /** The sub-task's agent prompt (required, non-empty). */
  prompt: string;
  /** Optional repo-relative context files for the sub-task to read. */
  context?: string[];
  /** Indices (into the proposal array) of sibling sub-tasks that must merge first. */
  blocked_by?: number[];
};

/**
 * Validate the proposed dependency graph (indices only) and return a CREATION ORDER
 * — a permutation of [0..n) in which every spec appears AFTER all of its sibling
 * blockers — or null if the graph is invalid (a self-reference, an out-of-range
 * index, or a cycle). Kahn's algorithm: repeatedly emit nodes whose remaining
 * in-edges (their blockers) are all already emitted; if we can't emit all n, the
 * leftover nodes form a cycle. This is the up-front guard so a cyclic proposal is
 * rejected BEFORE any sub-task is created; createTask's wouldCreateCycle then guards
 * the real wiring as well.
 */
export function planCreationOrder(specs: SubtaskSpec[]): number[] | null {
  const n = specs.length;
  // Normalize each spec's blocker indices: integers in [0,n), no self-reference,
  // de-duplicated. Any malformed index invalidates the whole proposal.
  const deps: Set<number>[] = [];
  for (let i = 0; i < n; i++) {
    const set = new Set<number>();
    for (const raw of specs[i]!.blocked_by ?? []) {
      if (!Number.isInteger(raw) || raw < 0 || raw >= n || raw === i) return null;
      set.add(raw);
    }
    deps.push(set);
  }
  // Kahn: emit any node all of whose blockers are already emitted.
  const order: number[] = [];
  const emitted = new Set<number>();
  while (order.length < n) {
    let progressed = false;
    for (let i = 0; i < n; i++) {
      if (emitted.has(i)) continue;
      let ready = true;
      for (const d of deps[i]!) if (!emitted.has(d)) { ready = false; break; }
      if (!ready) continue;
      emitted.add(i);
      order.push(i);
      progressed = true;
    }
    if (!progressed) return null; // remaining nodes form a cycle
  }
  return order;
}

/**
 * Apply a PLAN task's proposed decomposition: validate the graph, create the
 * sub-tasks (wiring blocked_by among the siblings), record them on the plan task,
 * and COMPLETE the plan task. Returns the created sub-task ids (in proposal order).
 *
 * Non-blocking, like request_review: it transitions the plan task to a terminal
 * state (it writes no code of its own → nothing to merge) and lets the agent exit.
 * Idempotent — a duplicate call on an already-completed plan returns its previously
 * spawned ids without re-creating anything.
 *
 * Rejections (HttpError): plan task missing (404) or not a plan (409); an empty
 * proposal or a spec with a blank prompt (400); an invalid graph — out-of-range
 * index, self-reference, or cycle (400). On a graph error NOTHING is created.
 */
export async function proposeSubtasks(
  planId: string,
  specs: SubtaskSpec[],
  summary?: string,
): Promise<{ created: string[]; plan: TaskView }> {
  const plan = getTask(planId);
  if (!plan) throw new HttpError(404, `task not found: ${planId}`);
  if (plan.kind !== "plan") {
    throw new HttpError(409, `task ${planId} is not a plan task`);
  }
  // Idempotency: a plan that already completed its decomposition just reports it.
  if (plan.status === "merged") {
    return { created: parseBlockedBy(plan.spawned_subtasks), plan: taskView(planId)! };
  }
  const dir = getDirectory(plan.directory_id);
  if (!dir) throw new HttpError(404, "directory not found");

  if (!Array.isArray(specs) || specs.length === 0) {
    throw new HttpError(400, "a decomposition must contain at least one sub-task");
  }
  for (const s of specs) {
    if (!s || typeof s.prompt !== "string" || !s.prompt.trim()) {
      throw new HttpError(400, "every sub-task needs a non-empty prompt");
    }
  }

  const order = planCreationOrder(specs);
  if (!order) {
    throw new HttpError(
      400,
      "the proposed decomposition has an invalid dependency graph (a cycle, " +
        "self-reference, or out-of-range index)",
    );
  }

  // Create in dependency order so each sub-task's sibling blockers already exist as
  // real tasks by the time we wire them. idxToId maps a proposal index to its id.
  const idxToId = new Map<number, string>();
  const createdInOrder: string[] = [];
  for (const idx of order) {
    const spec = specs[idx]!;
    const blockerIds = (spec.blocked_by ?? []).map((b) => idxToId.get(b)!);
    try {
      const sub = await createTask(
        plan.directory_id,
        spec.prompt,
        spec.context ?? [],
        blockerIds,
        "task",
      );
      idxToId.set(idx, sub.id);
      createdInOrder.push(sub.id);
    } catch (e) {
      // A graph error is impossible here (planCreationOrder validated it and the
      // wiring is acyclic by construction), so this is an unexpected failure (e.g.
      // a git/worktree error). Roll back what we created so the plan doesn't leave a
      // half-built decomposition behind, then surface the error.
      for (const id of createdInOrder) await abortTask(id).catch(() => {});
      throw e;
    }
  }

  // Created ids in the ORIGINAL proposal order (not creation order) — that's the
  // order the agent listed them and the most useful for display.
  const created = specs.map((_, i) => idxToId.get(i)!);

  // Record the spawned ids + summary and COMPLETE the plan task. It writes no code,
  // so there is nothing to merge — move it straight to the terminal `merged` state
  // (with merged_at) and clear its pane, mirroring the non-blocking request_review
  // path; the agent exits after this returns. The plan's worktree/branch + herdr tab
  // are torn down best-effort (fire-and-forget so the MCP response returns at once
  // and we never block on — or race — the agent's own exit).
  const snapshot = readRunLogSnapshot(planId);
  const when = nowIso();
  const planRes = db.query(
    `UPDATE tasks SET status='merged', spawned_subtasks=?, summary=COALESCE(?, summary),
       output_snapshot=COALESCE(?, output_snapshot), herdr_pane_id=NULL, idle=0, conflict=0,
       completed_at=COALESCE(completed_at, ?), merged_at=COALESCE(merged_at, ?)
       WHERE id=? AND status IN ('in_progress','needs_info')`,
  ).run(
    JSON.stringify(created),
    summary ?? null,
    snapshot || null,
    when,
    when,
    planId,
  );
  if (planRes.changes > 0) {
    recordTaskEvent(
      planId,
      plan.status,
      "merged",
      `plan decomposed into ${created.length} sub-task${created.length === 1 ? "" : "s"}`,
    );
    // Mirror task.md ONLY when the guarded UPDATE actually transitioned the row.
    // If the plan was aborted out from under the agent at the same instant it called
    // propose_subtasks, the UPDATE matches 0 rows (the DB row stays 'aborted'); writing
    // task.md='merged' here would desync the disk artifact from the DB — exactly the
    // class setStatus exists to prevent. So it stays inside this guard, next to the
    // (already-gated) recordTaskEvent.
    updateTaskMdStatus(dir.path, planId, "merged");
  }
  // Capture the plan agent's token usage / model (before the worktree is discarded),
  // then tear down the agent's tab/pane and discard the (codeless) worktree + branch
  // in the background — best-effort, never blocking the caller.
  void teardownAndDiscard(dir, plan, { captureUsage: true, background: true });

  emitUpdated(planId);
  // A task could have been blocked on this plan task; its completion may unblock it.
  reevaluateAllBlocked();
  console.log(
    `[butchr] plan task ${planId} spawned ${created.length} sub-task(s): ${created.join(", ")}`,
  );
  return { created, plan: taskView(planId)! };
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
    // Promote to in_progress (ready — no live agent yet, herdr_pane_id stays NULL so
    // the dispatcher launches it). Clear any stale backoff so it dispatches next tick.
    if (
      !setStatus(id, "in_progress", {
        from: "blocked",
        note: "all blockers merged",
        set: { next_dispatch_at: null },
      })
    ) {
      return false; // moved under us
    }
    console.log(`[butchr] task ${id} unblocked → in_progress (all blockers merged)`);
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
 * Allowed only on a NON-terminal task (queued/blocked/running/review); rejected
 * with 409 on merged/aborted/rejected/failed (and the legacy finalizing). Every
 * new blocker id must exist (404) and the new set must not create a self-block or
 * cycle (400). After persisting:
 *  - If it should now be blocked (some blocker not yet merged) and it has a LIVE
 *    agent (running/idle), KILL-ON-BLOCK: tear the agent down (reuse teardownTask)
 *    and clear the running/herdr fields like a clean re-queue, but KEEP session_id
 *    and the worktree so it resumes with full context when it later unblocks. This
 *    is NOT a dispatch failure (dispatch_attempts/backoff untouched).
 *  - If all blockers are merged/empty and it was blocked, promote it to queued.
 */
export async function setBlockedBy(
  id: string,
  blockedBy: string[],
): Promise<TaskView> {
  const row = getTask(id);
  if (!row) throw new HttpError(404, `task not found: ${id}`);
  // Only non-terminal states may have their dependencies edited (everything except the
  // two terminal idle states, merged/aborted).
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
    // No outstanding blockers. A blocked task becomes eligible → in_progress (ready);
    // anything else (in_progress/in_review/…) is already past the block, so leave it.
    const transitioned =
      row.status === "blocked" &&
      setStatus(id, "in_progress", {
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

  // Transitioning INTO blocked from queued/running/review.
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

/** Compute the diff of a task branch vs its directory's default branch. */
export async function taskDiff(id: string): Promise<string> {
  const row = getTask(id);
  if (!row) throw new HttpError(404, `task not found: ${id}`);
  const dir = getDirectory(row.directory_id);
  if (!dir) throw new HttpError(404, "directory not found");
  return git.diff(dir.path, id);
}

/**
 * Global merge queue: run at most ONE merge at a time across ALL tasks and
 * directories. Approvals that land close together would otherwise rebase+ff into
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
  // RESUME the workspace agent: move the task back to `in_progress` (ready — pane
  // NULL) so the dispatcher re-launches the SAME Claude session via `--resume` with
  // the notes. The agent already exited after the non-blocking request_review, so
  // there is no live call to resolve; tear down any lingering tab defensively (a
  // misbehaving agent that didn't exit would otherwise strand an orphan that collides
  // on `agent_name_taken`), and clear the stored tab id since the re-dispatch spins
  // up a fresh one. Shared by the in_review request-changes path and the
  // finalize-time merge-conflict kick-back.
  await herdr.teardownTask(tabId, id, paneId);
  // This is a REWORK re-queue (a request-changes or a conflict kick-back), NOT a
  // dispatch failure — it's a fresh intent to run, so clear the dispatch retry
  // state (attempts / last error / backoff) so prior dispatch failures don't
  // count against the resume and a stale backoff can't delay it. Unconditional
  // (no `from` guard) — the callers only ever route a non-in_progress task here, so
  // setStatus records the in_review/finalizing → in_progress event as before.
  setStatus(id, "in_progress", {
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
  const dir = getDirectory(row.directory_id);
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
  const dir = getDirectory(row.directory_id);
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
 * build task. At/over the attempt cap it moves to `failed`; the operator's requeue escape
 * hatch revives it (requeueTask resets the retry state, putting it back to `queued` — for
 * a failed idea task, the operator can instead delete + recreate the idea if needed).
 */
export function markSpecGenFailure(id: string, err: string): void {
  const row = getTask(id);
  if (!row || row.status !== "idea") return;
  const attempts = (row.dispatch_attempts ?? 0) + 1;

  if (attempts >= config.maxDispatchAttempts) {
    // setStatus mirrors the new status into task.md + records the audit event. A
    // spec-generation give-up maps to the terminal idle state `aborted` (there is no
    // `failed` state in the canonical model); last_dispatch_error explains why.
    setStatus(id, "aborted", {
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
//   state        artifact   approve →            request_changes →        answer →
//   -----------  ---------  -------------------  -----------------------  -----------------
//   spec_review  spec       in_progress/blocked  idea (re-generate spec)  —
//   in_review    diff       finalizing           in_progress (resume)     —
//   needs_info   question   —                    —                        in_progress (resume)
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
 * ApproveOutcome (its `task` is the post-transition view). Note that an in_review
 * APPROVE no longer merges synchronously — it forwards to `finalizing`; the actual
 * merge happens in finalizeMerge once the finalize agent wraps up. A merge conflict /
 * post-merge revert therefore surface from finalizeMerge, not here.
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
  const dir = getDirectory(row.directory_id);
  if (!dir) throw new HttpError(404, "directory not found");

  // ---- APPROVE ----
  if (response.type === "approve") {
    if (row.status === "spec_review") {
      // FORWARD: the spec is approved → build it. The blocker check deferred at
      // creation now applies: with outstanding blockers the task waits in `blocked`
      // (auto-unblocks to in_progress later); else it's ready in `in_progress`.
      const blockers = parseBlockedBy(row.blocked_by);
      const to: TaskStatus = allBlockersMerged(blockers) ? "in_progress" : "blocked";
      setStatus(id, to, {
        from: "spec_review",
        note: to === "in_progress" ? "spec approved — ready to build" : "spec approved — waiting on blockers",
        set: { review_note: null, next_dispatch_at: null },
      });
      if (to === "blocked") logDeadBlockers(id, blockers);
      return { task: taskView(id)! };
    }
    // in_review APPROVE → FORWARD to `finalizing`. The workspace agent is resumed to
    // do 'final thoughts' (post-approval wrap-up — see dispatcher + renderFinalizePrompt),
    // after which the system finalizes the merge (finalizeMerge). Clear the pane so the
    // dispatcher's finalize pass launches the resume agent.
    setStatus(id, "finalizing", {
      from: "in_review",
      note: "approved — finalizing (final thoughts before merge)",
      set: {
        review_note: null,
        herdr_pane_id: null,
        herdr_tab_id: null,
        idle: 0,
        conflict: 0,
        dispatch_attempts: 0,
        last_dispatch_error: null,
        next_dispatch_at: null,
      },
    });
    return { task: taskView(id)! };
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
 * Approve a feedback task (spec_review → build, or in_review → finalizing). Thin
 * wrapper over the unified feedback mechanism. Returns an ApproveOutcome; for the
 * in_review case the merge happens later in finalizeMerge (see respondToFeedback).
 */
export async function approveTask(id: string): Promise<ApproveOutcome> {
  return respondToFeedback(id, { type: "approve" });
}

/**
 * FINALIZE a task in `finalizing`: rebase + merge its branch into the default branch
 * and run the post-merge verify gate, landing it as `merged`. Invoked when the
 * finalize ('final thoughts') agent signals done (request_review while finalizing),
 * when that agent ends / can't launch (best-effort — the operator already approved),
 * and by auto-merge / startup recovery. Serialized through the global merge queue.
 *  - clean merge → merged.
 *  - merge conflict → kicked back to the workspace agent (in_progress) to resolve.
 *  - post-merge verify RED → auto-reverted off main; task → aborted (revert_reason set).
 * A no-op (returns the current view) unless the task is still `finalizing`, so it is
 * safe to call from more than one path.
 */
export async function finalizeMerge(id: string): Promise<ApproveOutcome> {
  const row = getTask(id);
  if (!row) throw new HttpError(404, `task not found: ${id}`);
  if (row.status !== "finalizing") return { task: taskView(id)! };
  const dir = getDirectory(row.directory_id);
  if (!dir) throw new HttpError(404, "directory not found");

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
    // Merge stuck (ff'd into main). Gate the new tip: the directory's build/test
    // gate command must be GREEN (its own gate_cmd, or the default config.verifyCmd).
    const verify = await verifyDefaultBranch(dir.path, directoryGateCmd(dir.id));
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
      // steps, exactly like a reject. Returns 200, task flips back to running.
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
  // NOT mark merged: flag the task so a human can see the breakage and the
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
      `UPDATE tasks SET status='aborted', conflict=0, idle=0, herdr_pane_id=NULL, herdr_tab_id=NULL,
         output_snapshot=COALESCE(?, output_snapshot), revert_reason=?, last_dispatch_error=?,
         completed_at=COALESCE(completed_at, ?)
         WHERE id=? AND status='finalizing'`,
    ).run(snapshot || null, reason, reason, nowIso(), id);
    if (res.changes === 0) {
      // Raced (e.g. aborted) between the gate and here — leave whatever won.
      emitUpdated(id);
      return { task: taskView(id)! };
    }
    recordTaskEvent(
      id,
      "finalizing",
      "aborted",
      "merge auto-reverted off main (post-merge verify failed)",
    );
    updateTaskMdStatus(dir.path, id, "aborted");
    emitUpdated(id);
    return { task: taskView(id)!, revertedOnRed: true };
  }

  // Merge succeeded. The finalize ('final thoughts') agent has already wrapped up and
  // exited, so close the task to `merged` directly. The branch is already in main;
  // capture whatever the agent logged, tear down the worktree + branch, and stamp merged.
  const snapshot = readRunLogSnapshot(id);
  // Close the agent's dedicated tab (best-effort — usually already gone since the
  // agent exited after request_review, but removes any empty husk tab) and discard
  // the worktree + branch (already landed in main). Awaited so the merged write below
  // only runs after teardown — a teardown failure propagates, exactly as before.
  await teardownAndDiscard(dir, row, {});
  if (
    !setStatus(id, "merged", {
      from: "finalizing",
      note: "finalized & merged into the default branch",
      set: {
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
 * Legacy: complete a task left in the obsolete `finalizing` state by a
 * Request changes on a feedback task (in_review → resume the workspace agent, or
 * spec_review → revise the spec). Thin public wrapper over the unified feedback
 * mechanism — kept under the historical name for the existing API / CLI / test
 * surface. Returns the post-transition task view. 409 if the task isn't in a feedback
 * state that accepts request-changes; 400 on a blank note.
 */
export async function rejectTask(id: string, note: string): Promise<TaskView> {
  const outcome = await respondToFeedback(id, { type: "request_changes", note });
  return outcome.task;
}

/**
 * Abort a task without merging: discard its worktree + branch and move it to the
 * terminal idle `aborted` state. Works from any non-terminal state. For a task with a
 * LIVE agent (in_progress/finalizing with a pane) we first signal its watcher to bail
 * and close the herdr pane so the agent stops before we tear the worktree down. A
 * feedback/blocked task has no live process, so abort just discards its DB state +
 * worktree.
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
  const dir = getDirectory(row.directory_id);
  if (!dir) throw new HttpError(404, "directory not found");

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
): void {
  const row = getTask(id);
  if (!row) return;
  // The task being launched is an AGENT-state task with NO live pane yet — i.e. a
  // READY `in_progress` (build) task or a READY `finalizing` (final-thoughts) task.
  // Recording the pane is what flips it from "ready" to "running" (the status itself
  // does not change — the ready-vs-running distinction is carried by herdr_pane_id).
  // The `herdr_pane_id IS NULL` guard makes this a no-op if the task was aborted /
  // already launched / moved under us in the same tick. `session_id` is set with
  // COALESCE so it sticks to the FIRST id assigned (a resume keeps its existing id);
  // a successful launch clears the dispatch retry state and consumes any pending ASK
  // answer (it has been injected into this launch's rendered prompt).
  const res = db.query(
    `UPDATE tasks SET herdr_pane_id=?, herdr_tab_id=?, session_id=COALESCE(session_id, ?),
       started_at=COALESCE(started_at, ?), dispatch_attempts=0, last_dispatch_error=NULL,
       next_dispatch_at=NULL, answer=NULL
       WHERE id=? AND status IN ('in_progress','finalizing') AND herdr_pane_id IS NULL`,
  ).run(paneId, tabId ?? null, sessionId, nowIso(), id);
  if (res.changes === 0) return; // aborted / already running / moved under us
  // Record a launch event on the FIRST launch only (its status is unchanged, so this
  // is the one audit-trail marker that the agent started); reworks/relaunches/the
  // finalize relaunch don't spam the timeline.
  if (!row.started_at) {
    recordTaskEvent(id, row.status, row.status, "agent launched");
  }
  emitUpdated(id);
}

/**
 * Record a re-adopted agent task's current herdr pane + tab id. Used by the startup
 * reconcile (dispatcher.reconcileRunningTasks) when an agent it re-adopts now lives on
 * a different pane/tab than the one stored before butchr restarted. Guarded on the
 * agent states (in_progress/finalizing) so a concurrent transition isn't clobbered. A
 * missing tabId leaves the stored value untouched (COALESCE) rather than nulling a
 * still-valid tab.
 */
export function adoptPane(id: string, paneId: string, tabId?: string): void {
  const res = db.query(
    `UPDATE tasks SET herdr_pane_id=?, herdr_tab_id=COALESCE(?, herdr_tab_id) WHERE id=? AND status IN ('in_progress','finalizing')`,
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
 * Guarded so it only ever heals a genuine drift: the task must still hold a
 * live-agent phase (in_progress/finalizing), already have a non-null pane id, and
 * that id must actually differ — so a no-drift tick is a silent no-op and we never
 * resurrect a pane on a task whose agent has exited (its id is NULL by then).
 * Returns true when it repaired (and emits an update so dashboards refresh).
 */
export function repairPaneId(id: string, livePaneId: string): boolean {
  if (!livePaneId) return false;
  const res = db.query(
    `UPDATE tasks SET herdr_pane_id=? WHERE id=? AND status IN ('in_progress','finalizing')
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
  const dir = getDirectory(row.directory_id);
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
  const dir = getDirectory(row.directory_id);
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
function autoCommitOnReview(id: string, directoryId: string): void {
  const dir = getDirectory(directoryId);
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
  if (pre?.status === "in_progress") autoCommitOnReview(id, pre.directory_id);
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
 * The agent called the MCP `request_review` tool. STATUS-AWARE (the same tool serves
 * both workspace-agent phases):
 *  - in_progress → in_review: the build is done; surface the diff for operator review
 *    (runs the CI + conformance gates + footprint, non-blocking). The agent EXITS
 *    right after, so we clear herdr_pane_id (its pane is about to close).
 *  - finalizing → the 'final thoughts' agent finished its wrap-up → FINALIZE the merge
 *    (finalizeMerge, fire-and-forget — the call returns at once so the agent exits).
 *  - in_review (duplicate call) → no-op ok.
 *
 * Returns:
 *  - "ok"        → handled (transitioned, finalize kicked off, or a duplicate).
 *  - "terminal"  → task is merged/aborted; nothing to do.
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

  // FINALIZE PHASE: the post-approval 'final thoughts' agent signalled done. Record
  // its summary/output, then land the merge (fire-and-forget so this returns at once).
  if (row.status === "finalizing") {
    db.query(
      `UPDATE tasks SET summary=COALESCE(?, summary), output_snapshot=?, idle=0 WHERE id=? AND status='finalizing'`,
    ).run(summary ?? null, snapshot || null, id);
    emitUpdated(id);
    captureSessionUsage(id);
    void finalizeMerge(id);
    return "ok";
  }

  // COMMIT-ON-REVIEW (FIRST): the agent is told it need not commit — butchr captures
  // its worktree. On the genuine in_progress→in_review transition, commit that diff
  // onto the branch NOW so it can't be lost as worktree-only state before merge.
  if (row.status === "in_progress") autoCommitOnReview(id, row.directory_id);

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
 * Park an AGENT-state task in `needs_info` because its agent called the MCP `ask`
 * tool (the ad-hoc feedback stage ANY agent state can enter — in_progress or
 * finalizing). Mirrors markReviewFromAgent's non-blocking shape: the agent EXITS
 * right after this returns, so needs_info is pure DB state with no live process (we
 * clear herdr_pane_id — its pane is about to close). Stores the agent's `question`
 * (surfaced in /health + the webapp) and the run-log snapshot for the answerer.
 *
 * Returns:
 *  - "ok"        → parked in needs_info (or already there — a duplicate ask).
 *  - "terminal"  → task is merged/aborted; nothing to do.
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
  // continues on top of it. Only on the in_progress transition (finalizing work is
  // already committed); best-effort, never blocks the park.
  if (row.status === "in_progress") autoCommitOnReview(id, row.directory_id);

  // in_progress/finalizing → needs_info (normal), or needs_info → needs_info (a
  // duplicate ask). Clear the pane: the agent is exiting and this state holds no
  // live process. setStatus records the audit event ONLY on a genuine change (a
  // duplicate needs_info→needs_info is status-unchanged) — matching the old
  // `if (row.status !== "needs_info")` guard exactly.
  if (
    !setStatus(id, "needs_info", {
      from: ["in_progress", "finalizing", "needs_info"],
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
 * RESUME an agent with an operator answer (the needs_info → in_progress resume — the
 * answer half of the unified feedback mechanism). Logs the Q&A to task.md, stores the
 * `answer` (which dispatcher.dispatch injects into the `--resume` prompt and markRunning
 * consumes), clears the pending question, resets the dispatch retry state, and re-arms
 * the task as a READY `in_progress` (pane NULL) KEEPING session_id + worktree so the
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
  // unconditional re-arm to in_progress records the needs_info → in_progress event.
  setStatus(id, "in_progress", {
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
 * worktree. `gateCmd` is the directory's EFFECTIVE gate command (its own `gate_cmd`
 * or the default — resolved by triggerCi via directories.directoryGateCmd).
 */
export type CiRunner = (dirPath: string, taskId: string, gateCmd: string) => Promise<CiResult>;

// The active CI runner. Overridable in tests (setCiRunner) so they can exercise
// the persistence + trigger wiring without spawning a real `bun` build/test.
let ciRunner: CiRunner = defaultCiRunner;

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
 * The real CI runner: run the directory's EFFECTIVE gate command (`gateCmd` — its
 * own `gate_cmd` or the default `config.verifyCmd`, e.g. butchr's own
 * `bun build … && bun test`) as a single `bash -lc` invocation IN THE TASK'S
 * WORKTREE, through the shared gate runner (src/gate.ts) so the CI gate and the
 * post-merge verify gate share one bounded spawn — the CI gate inherits the same
 * `config.verifyTimeoutMs` kill-timer. A non-zero exit (or a timeout) is a FAIL with
 * the output tail; an empty gate command means "no gate configured" → a trivial
 * pass (the directory opted out, mirroring an empty verify gate). Running the gate
 * as one command (rather than a hardcoded build-then-test split) is what lets each
 * directory define its own arbitrary build/test command.
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
  const dir = getDirectory(row.directory_id);
  if (!dir) return;
  // Nothing to build/test — leave CI unset rather than spawning bun in a dir that
  // isn't there (also what keeps tests that seed worktree-less rows from running
  // a real build).
  if (!existsSync(git.worktreePath(dir.path, id))) return;

  db.query(`UPDATE tasks SET ci_status='running', ci_summary=NULL WHERE id=?`).run(id);
  emitUpdated(id);

  // Resolve the directory's effective gate command ONCE for this CI run (own
  // gate_cmd or the default) and thread it through every (re)run.
  const gateCmd = directoryGateCmd(dir.id);
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
  // CI ran, don't resurrect stale CI state onto it.
  const res = db
    .query(`UPDATE tasks SET ci_status=?, ci_summary=? WHERE id=? AND status='in_review'`)
    .run(result.status, summary, id);
  if (res.changes === 0) return;
  emitUpdated(id);

  // AUTO-MERGE HOOK: CI just settled to 'pass' on a still-in-review task. If
  // auto-merge is enabled and the task is low-risk, run the same approve+merge a
  // human would (post-merge verify still gates main). Fire-and-forget so CI never
  // blocks on the merge; the dispatcher tick re-checks as a backstop.
  if (result.status === "pass") void maybeAutoMerge(id);
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
 * Evaluate a `review` task for auto-merge and, if it qualifies, run the human
 * approve+merge path. Returns true iff it actually auto-merged. Safe to call
 * repeatedly / concurrently — it no-ops unless the task is still in `review` with
 * ci_status='pass', and dedupes concurrent evaluations via `autoMerging`.
 *
 * It deliberately does NOT special-case conflicts itself: approveTask already
 * sends a conflicting merge back to the agent (conflictSentBack) instead of
 * landing it, so a conflict never auto-merges. We only stamp `auto_merged` + log
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

  const dir = getDirectory(row.directory_id);
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
        `<= ${config.autoMergeMaxChangedLines}); running the approve+finalize path`,
    );
    // Approve (in_review → finalizing) then land it directly. Auto-merge skips the
    // human AND the interactive 'final thoughts' agent — finalizeMerge runs the same
    // rebase + post-merge-verify gate a human-driven finalize would.
    await approveTask(id);
    const outcome = await finalizeMerge(id);
    // Only a genuine merge counts. A conflict kicked back to the agent
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
    if (outcome.task.status === "merged") {
      // Stamp the auto-merged flag on the now-merged row (it survives — merged
      // tasks keep their row) so the webapp can distinguish auto- from human-merges.
      db.query(`UPDATE tasks SET auto_merged=1 WHERE id=?`).run(id);
      emitUpdated(id);
      console.log(`[butchr] task ${id} AUTO-MERGED (CI green + low-risk)`);
      return true;
    }
    return false;
  } catch (e) {
    // approveTask can throw on an unusual/unsafe merge failure (e.g. non-conflict).
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
  // This is a CLEAN re-queue (fresh intent) → READY `in_progress` (pane NULL), so the
  // dispatcher relaunches it. It clears the dispatch retry state so it never counts as
  // a dispatch failure. A genuine dispatch failure goes through markDispatchFailure.
  const row = getTask(id);
  await herdr.teardownTask(row?.herdr_tab_id, id, row?.herdr_pane_id);
  db.query(
    `UPDATE tasks SET status='in_progress', herdr_pane_id=NULL, herdr_tab_id=NULL,
       dispatch_attempts=0, last_dispatch_error=NULL, next_dispatch_at=NULL WHERE id=?`,
  ).run(id);
  if (row && row.status !== "in_progress") {
    recordTaskEvent(id, row.status, "in_progress", "re-queued");
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
 *  - Under the cap (`dispatch_attempts < maxDispatchAttempts`): KEEP the current
 *    agent-phase status (in_progress/finalizing) with the pane cleared (so it is
 *    READY again) and stamp `next_dispatch_at = now + backoff(attempts)`. The tick
 *    loop skips the task until that time, so it no longer hot-loops.
 *  - At/over the cap: a build (in_progress) give-up moves to the terminal idle state
 *    `aborted` (there is no `failed` state in the canonical model). A FINALIZE give-up
 *    instead lands the merge directly (the operator already approved — don't strand
 *    approved work), via finalizeMerge.
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
    if (row.status === "finalizing") {
      // FINALIZE give-up: don't strand approved work — land the merge directly.
      db.query(
        `UPDATE tasks SET dispatch_attempts=?, last_dispatch_error=?, next_dispatch_at=NULL,
           herdr_pane_id=NULL, herdr_tab_id=NULL WHERE id=?`,
      ).run(attempts, err, id);
      console.warn(
        `[butchr] finalize dispatch gave up for ${id} after ${attempts} attempts; ` +
          `finalizing the merge directly (operator already approved): ${err}`,
      );
      await finalizeMerge(id).catch((e) =>
        console.error(`[butchr] direct finalize of ${id} failed: ${(e as Error).message}`),
      );
      emitUpdated(id);
      return;
    }
    setStatus(id, "aborted", {
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

  // Under the cap: keep the current agent-phase status; clear the pane → READY again.
  const nextAt = new Date(Date.now() + dispatchBackoffMs(attempts)).toISOString();
  db.query(
    `UPDATE tasks SET dispatch_attempts=?, last_dispatch_error=?,
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
 * `in_progress` task, so the dispatcher retries it fresh. Refuses terminal tasks
 * (merged/aborted) — a dispatch give-up now lands in the terminal `aborted` state, so
 * recreate the task instead.
 */
export async function requeueTask(id: string): Promise<TaskView> {
  const row = getTask(id);
  if (!row) throw new HttpError(404, `task not found: ${id}`);
  if (isTerminal(row.status)) {
    throw new HttpError(409, `task is ${row.status}; cannot re-queue`);
  }
  // Tear down any lingering agent/tab defensively before a fresh dispatch.
  await herdr.teardownTask(row.herdr_tab_id, id, row.herdr_pane_id);
  setStatus(id, "in_progress", {
    note: "manually re-queued by operator",
    set: {
      dispatch_attempts: 0,
      last_dispatch_error: null,
      next_dispatch_at: null,
      herdr_pane_id: null,
      herdr_tab_id: null,
    },
  });
  return taskView(id)!;
}

/**
 * On startup, any task left in `finalizing` with NO live agent (its finalize-watcher
 * was lost when butchr stopped — the operator had already approved it) is LANDED
 * directly via finalizeMerge so approved work isn't stranded. A finalizing task whose
 * agent is still alive was re-adopted by reconcileRunningTasks (it has a pane) and is
 * skipped here. Returns how many were finalized.
 */
export async function recoverFinalizingTasks(): Promise<number> {
  const rows = db
    .query<TaskRow, []>(
      `SELECT * FROM tasks WHERE status='finalizing' AND herdr_pane_id IS NULL`,
    )
    .all();
  for (const r of rows) await finalizeMerge(r.id).catch(() => {});
  return rows.length;
}
