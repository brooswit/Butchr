// Task service: create / list / get / diff / approve / reject. The task.md on
// disk is authoritative for prompt+metadata; the DB row tracks runtime state.
import { checkChangelogUpdated } from "./changelog.ts";
import type { VersionBumpLevel } from "./changelog.ts";
import { config, responderV2Enabled } from "./config.ts";
import { conformanceGateInFlight, triggerConformance } from "./conformance.ts";
import {
  ALL_STATUSES,
  db,
  estimateRows,
  isTerminal,
  matchesQuery,
  nowIso,
  recordTaskEvent,
} from "./db.ts";
import type { TaskRow, TaskStatus, WorkspaceRow } from "./db.ts";
import {
  classifyPathType,
  computeEstimateStats,
  estimateChain,
  estimateTask,
} from "./estimate.ts";
import type { ChainEstimate, EstimateRow, Estimate } from "./estimate.ts";
import {
  HttpError,
  getWorkspace,
  listWorkspaces,
  responderFor,
  workspaceBranchIsolation,
  workspaceChangelogPath,
  workspaceGateCmd,
  workspaceReleaseMode,
  workspaceVersionFile,
} from "./workspaces.ts";
import type { ResponderStep } from "./workspaces.ts";
import { currentPaneRepairing, readRunLogSnapshot, signalAbort } from "./dispatcher.ts";
import { harness } from "./harness.ts";
import { claudeAlive } from "./liveness.ts";
import { publish } from "./events.ts";
import { makeGateLiveness, runGate, settleGate } from "./gate.ts";
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
  updateTaskMdContext,
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
export type TaskView = Omit<TaskRow, "blocked_by" | "tags" | "allowlist"> & {
  prompt: string;
  context: string[];
  review_notes: string;
  blocked_by: string[];
  // Free-form organizational labels (the DB stores them as raw JSON TEXT). Empty
  // array when none. Set at creation; the webapp + CLI filter on them. See `tags`.
  tags: string[];
  // The task's FILE ALLOWLIST: the glob/path entries its diff is permitted to touch
  // (the DB stores them as raw JSON TEXT). Empty array when none (the CI scope gate is
  // inert). Set at creation; enforced by the CI gate. See `allowlist` / triggerCi.
  allowlist: string[];
  // The current status of each blocker by id (or "gone" if its row no longer
  // exists), so the webapp can render the dependency list without extra fetches.
  blockerStates: Record<string, string>;
  deadBlockers: string[];
  // ROUGH duration estimate for this task as a p50–p90 range with its sample size
  // (see src/estimate.ts). null on a terminal task (merged/aborted/failed) — a
  // forward estimate is only meaningful for work still ahead. The webapp renders it
  // as a loose forecast (e.g. "est ~12–30m, n=8"), never a promise.
  estimate: Estimate | null;
  // FW-3: the resolved RESPONDER (`cto` | `user`) for the task's CURRENT pending
  // feedback step — who is expected to act right now — or null when the task is not
  // in a feedback state. Computed from the state→step map (feedbackStep) + the
  // workspace's per-step responder config (responderFor). Lets the webapp + CTO show
  // "awaiting you" vs "awaiting CTO" without cross-referencing the workspace config. For a
  // STORY MEMBER it instead resolves the FIXED escalation chain (`story`/`cto`/`user` by
  // responder_tier) — see pendingResponder / ESCALATION_CHAIN (Phase 2).
  pending_responder: EscalationRung | null;
  // The task's git worktree path (`<workspace>/<taskId>` — git.worktreePath). ALWAYS
  // present whenever the workspace resolves: a DETERMINISTIC path, independent of whether
  // the worktree currently exists on disk (it's created on dispatch, removed after merge),
  // so consumers (notably the CTO agent) never have to GUESS or reconstruct it. null only
  // when the workspace row is gone.
  worktree_path: string | null;
  // STRUCTURED GATES — the CI / conformance / changelog gate state grouped into one
  // block so a reader gets "what's green" without re-deriving it from the loose
  // ci_status / conformance_status columns (which still spread above, unchanged). PURE
  // (no git I/O): ci + conformance read straight off the row; changelog reports the
  // gate's CONFIGURATION (off/on/strict) since its pass/fail needs the live diff (the
  // readiness view computes that). See gatesView. This keeps taskView synchronous (it's
  // published on every SSE task.updated), which a live git probe would break.
  gates: TaskGates;
  // AGENT-LIVENESS VERDICT — the idle/stall dispatcher step's judgement, surfaced so the
  // operator/CTO reads "working | stalled | dead" off the task view instead of probing
  // herdr panes / /proc / the spinner / the file-count by hand. null whenever the task
  // isn't a live `in_progress` agent. See livenessView for the (cheap) computation.
  liveness: Liveness | null;
};

/**
 * The AGENT-LIVENESS verdict on a live build agent (see TaskView.liveness). One of:
 *  - `working` — the agent's run log was written within the idle window → producing output.
 *  - `stalled` — alive (its claude process is in /proc) but its run log has gone quiet past
 *                the idle threshold (the `idle` flag) → parked / waiting on a transient error.
 *  - `dead`    — quiet AND no live claude process for the session → a dead shell (a herdr/host
 *                restart killed it; the dispatcher auto-resumes these on its next tick).
 * `evidence` is a short human-readable note on the signals behind the verdict.
 */
export type Liveness = {
  state: "working" | "stalled" | "dead";
  evidence: string;
};

/**
 * Compute a task's agent-liveness verdict from its stored signals — null unless the task
 * is a live `in_progress` agent. CHEAP enough for the hot taskView path: a `working`
 * agent (idle flag clear → recent output PROVES it's alive) returns WITHOUT scanning
 * /proc; the /proc liveness probe (claudeAlive) runs ONLY for an already-quiet (`idle`)
 * agent — exactly the bounded "agent has gone quiet" case liveness.ts sanctions, never
 * per-tick on a busy one. So a busy agent emitting frequent task.updated never hits /proc.
 */
export function livenessView(row: TaskRow): Liveness | null {
  if (row.status !== "in_progress") return null;
  if (!row.idle) {
    return { state: "working", evidence: "run log written within the idle window — producing output" };
  }
  if (claudeAlive(row.session_id)) {
    return {
      state: "stalled",
      evidence: "claude process is alive but its run log has been quiet past the idle threshold",
    };
  }
  return {
    state: "dead",
    evidence: "no live claude process for this session — a dead shell (the dispatcher auto-resumes it)",
  };
}

/**
 * The structured GATES block on a task view (see TaskView.gates). `ci` / `conformance`
 * mirror the row's stored gate columns (status: 'running'|'pass'|'fail' for CI,
 * 'checking'|'pass'|'concern' for conformance, or null when the gate never ran /
 * is disabled; `tip` is the branch sha the gate ran against). `changelog` reports the
 * gate's CONFIGURATION for this workspace, NOT a per-diff verdict (which needs git):
 *   - `off`    — no changelog path configured for the workspace (gate disabled).
 *   - `on`     — a code change must update the changelog (docs-only diffs exempt).
 *   - `strict` — release_mode: EVERY non-empty diff must update the changelog.
 */
export type TaskGates = {
  ci: { status: string | null; summary: string | null; tip: string | null };
  conformance: { status: string | null; summary: string | null; tip: string | null };
  changelog: { status: "off" | "on" | "strict"; detail: string };
};

/**
 * Build a task's structured GATES block from its already-stored columns + the
 * workspace's gate configuration. PURE — no git/fs I/O — so it is safe to call inside
 * the synchronous, hot taskView / taskListView path. The changelog sub-block is
 * config-derived (off/on/strict) because the actual pass/fail of a changelog gate is
 * folded into the CI gate (tasks.triggerCi) and a per-diff verdict needs the live file
 * list (computed by taskReadiness instead).
 */
export function gatesView(row: TaskRow): TaskGates {
  const clogPath = workspaceChangelogPath(row.workspace_id).trim();
  let changelog: TaskGates["changelog"];
  if (!clogPath) {
    changelog = { status: "off", detail: "changelog gate disabled (no path configured)" };
  } else if (workspaceReleaseMode(row.workspace_id)) {
    changelog = {
      status: "strict",
      detail: `release_mode: every non-empty diff must update ${clogPath} (enforced by the CI gate)`,
    };
  } else {
    changelog = {
      status: "on",
      detail: `a code change must update ${clogPath} (enforced by the CI gate; docs-only diffs exempt)`,
    };
  }
  return {
    ci: { status: row.ci_status, summary: row.ci_summary, tip: row.ci_tip },
    conformance: {
      status: row.conformance_status,
      summary: row.conformance_summary,
      tip: row.conformance_tip,
    },
    changelog,
  };
}

// --- DURATION ESTIMATES (rough, history-derived) ---------------------------

/**
 * Assemble the estimator's input rows from the tasks table (parsing the raw
 * blocked_by JSON column into a clean id array). The pure estimate model in
 * src/estimate.ts consumes these — kept out of estimate.ts so that module stays
 * DB-free and unit-testable against synthetic rows.
 */
export function estimateInputRows(): EstimateRow[] {
  // EstimateRowRaw is the canonical EstimateRow with a raw `blocked_by` TEXT column;
  // spread the shared fields and parse that one JSON column into the id array — the
  // single JSON-parse seam between the DB row and the pure estimator.
  return estimateRows().map((r) => ({
    ...r,
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
 * Parse the `allowlist` JSON-array TEXT column into a clean string[]. Same shape as
 * `tags`/`blocked_by` but named for the FILE-ALLOWLIST semantics — each entry is a
 * glob/path the task is permitted to change (matched by fileAllowed). Empty when none.
 */
export function parseAllowlist(raw: string | null): string[] {
  return parseBlockedBy(raw);
}

/**
 * Validate + normalize the optional per-task `allowlist` field from an API/CLI body: an
 * array of non-empty glob/path strings (each ≤ 200 chars), trimmed/de-duped, blanks
 * dropped (reusing normalizeTags — identical cleaning, different semantics). Anything
 * non-array-of-strings is a 400. Absent/null → [] (no allowlist → the gate is inert).
 */
export function validateAllowlist(allowlist: unknown): string[] {
  if (allowlist === undefined || allowlist === null) return [];
  if (!Array.isArray(allowlist) || allowlist.some((a) => typeof a !== "string")) {
    throw new HttpError(400, "allowlist must be an array of strings");
  }
  const normalized = normalizeTags(allowlist);
  if (normalized.some((a) => a.length > 200)) {
    throw new HttpError(400, "each allowlist entry must be 200 characters or fewer");
  }
  return normalized;
}

/**
 * Validate + normalize the `context` field for the in-place task EDIT (editTask): an
 * array of context-file path strings, each trimmed, with blanks dropped. Order is
 * preserved and duplicates are kept as-is (unlike tags/allowlist — a context list is an
 * ordered reading list the operator curates). Anything that isn't an array of strings is
 * a 400. An empty/absent array clears the context list.
 */
export function validateContext(context: unknown): string[] {
  if (context === undefined || context === null) return [];
  if (!Array.isArray(context) || context.some((c) => typeof c !== "string")) {
    throw new HttpError(400, "context must be an array of strings");
  }
  return context.map((c) => c.trim()).filter(Boolean);
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

/**
 * FW-3 STATE→STEP MAP. The per-workspace feedback STEP a task in a given state is
 * awaiting a response on (one of workspaces.RESPONDER_STEPS), or null when the status
 * is not a feedback state. This is the single mapping the CTO self-check and the webapp
 * route on (combined with responderFor):
 *
 *   idea         → spec-generation   (a brief awaiting a spec)
 *   spec_review  → spec-approval     (a generated spec awaiting approval)
 *   in_review    → diff-review       (a finished diff awaiting review)
 *   needs_info   → plan-approval | answer-question  (see the discriminator below)
 *
 * NEEDS_INFO DISCRIMINATOR — a known simplification. A `needs_info` task holds EITHER a
 * proposed plan (from the plan-preview gate's `propose_plan`) OR a raised question (from
 * `raise`) in the SAME `question` column; nothing on the row records which. The only
 * available signal is `plan_preview`, so a plan-preview task parked in needs_info is
 * treated as awaiting PLAN approval, and any other needs_info as awaiting a question
 * answer. LIMITATION: a plan-preview task that RAISES a question DURING implementation
 * also has plan_preview=1, so it maps to `plan-approval` rather than `answer-question`.
 * This only affects which responder-step's config + UI emphasis applies (the backend is
 * responder-agnostic — every needs_info is answerable by a human and pushed to the
 * channel regardless), and is accepted for now; a future task can add a precise marker
 * (e.g. a `plan_proposed`/`plan_approved` flag) to disambiguate. See CONTRIBUTING §7.
 */
export function feedbackStep(status: TaskStatus, planPreview: boolean): ResponderStep | null {
  switch (status) {
    case "idea":
      return "spec-generation";
    case "spec_review":
      return "spec-approval";
    case "in_review":
      return "diff-review";
    case "needs_info":
      return planPreview ? "plan-approval" : "answer-question";
    default:
      return null;
  }
}

/**
 * THE RESPONDER ESCALATION CHAIN (Phase 2 of the STORIES epic). A STORY-MEMBER task's
 * feedback bubbles up this FIXED ordered chain: rung 0 = the story leader, rung 1 = the
 * CTO, rung 2 = the user. It is DELIBERATELY independent of the workspace step_responders
 * config — story membership defines the bubble-up path; the cto/user workspace config
 * governs NON-story tasks only. The current rung is the task's `responder_tier` (clamped to
 * the last rung), bumped by escalateTask and reset to 0 on each new feedback event.
 */
export const ESCALATION_CHAIN = ["story", "cto", "user"] as const;
/** A resolved responder rung — the workspace responders (`cto`/`user`) PLUS `story` (the
 * story-leader rung), i.e. the possible values of a story-member task's pending_responder. */
export type EscalationRung = (typeof ESCALATION_CHAIN)[number];

/**
 * RESPONDER-REDESIGN V2 (story st-def561dd, design §3/§4): is a task currently AWAITING
 * FEEDBACK? True iff its status is a feedback state (idea / spec_review / in_review /
 * needs_info) OR it is a LIVE build agent gone idle (in_progress + idle flag). This is the
 * single predicate V2 collapses RESPONDER_STEPS / feedbackStep / pendingResponderStep into;
 * the idle arm is kept IDENTICAL to V1 pendingResponderStep (status==in_progress && idle) so
 * the two agree until the activation subtask deletes V1. ADDITIVE — V1's feedbackStep /
 * pendingResponderStep are NOT removed here.
 */
export function isAwaitingFeedback(row: TaskRow): boolean {
  if (row.status === "in_progress" && row.idle) return true;
  return (
    row.status === "idea" ||
    row.status === "spec_review" ||
    row.status === "in_review" ||
    row.status === "needs_info"
  );
}

/**
 * The resolved RESPONDER for a task's CURRENT pending feedback step, or null when the task
 * is not in a feedback state.
 *
 * V2 (responderV2Enabled() — design §3): STRUCTURAL resolution, no tier, no config:
 *  - not awaiting feedback → null
 *  - story member (story_id != null) → `story` (the leader), ALWAYS — terminal, no tier.
 *  - non-story + NOT escalated_to_user → `cto`
 *  - non-story + escalated_to_user → `user`
 *
 * V1 (gate OFF — UNCHANGED): two distinct paths:
 *  - STORY MEMBER (story_id != null): walk the FIXED escalation chain ['story','cto','user']
 *    indexed by the task's `responder_tier` (clamped to the last rung) — INDEPENDENT of the
 *    workspace step_responders config. So a brand-new feedback item (tier 0) resolves to
 *    `story`, and POST /escalate bubbles it up to `cto` then `user`.
 *  - NON-MEMBER (story_id == null): EXACTLY as before — the state→step map (feedbackStep,
 *    via pendingResponderStep) combined with the workspace's per-step responder config
 *    (workspaces.responderFor). responder_tier is ignored; zero behavior change.
 * Pure read of the row + the workspace config; surfaced as `pending_responder` on TaskView /
 * TaskListView so the webapp + CTO never have to cross-reference. Note pendingResponderStep
 * also covers the in_progress+idle surface, so "in a feedback state" includes idle here.
 */
export function pendingResponder(row: TaskRow): EscalationRung | null {
  if (responderV2Enabled()) {
    if (!isAwaitingFeedback(row)) return null;
    if (row.story_id != null) return "story";
    return row.escalated_to_user ? "user" : "cto";
  }
  const step = pendingResponderStep(row);
  if (!step) return null;
  if (row.story_id != null) {
    return ESCALATION_CHAIN[Math.min(row.responder_tier, ESCALATION_CHAIN.length - 1)]!;
  }
  return responderFor(row.workspace_id, step);
}

/**
 * The responder STEP a task is currently awaiting a response on — the feedback-state map
 * (feedbackStep), PLUS the orthogonal IDLE condition: a LIVE build agent that has gone
 * `idle` (in_progress + idle flag) is awaiting `idle-handling`, surfaced as a feedback
 * surface even though `in_progress` is not itself a feedback STATE (idle stays a flag, not
 * a 13th state — see FW-4). null when the task is neither in a feedback state nor idle.
 * The single place the idle-as-feedback mapping lives so pendingResponder + the CTO
 * self-check + the webapp all agree.
 */
export function pendingResponderStep(row: TaskRow): ResponderStep | null {
  if (row.status === "in_progress" && row.idle) return "idle-handling";
  return feedbackStep(row.status, !!row.plan_preview);
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
    allowlist: parseAllowlist(row.allowlist),
    blockerStates: blockerStatesOf(blocked_by),
    deadBlockers: deadBlockerIds(blocked_by),
    estimate: taskEstimate(id),
    pending_responder: pendingResponder(row),
    worktree_path: dir ? git.worktreePath(dir.path, id) : null,
    gates: gatesView(row),
    liveness: livenessView(row),
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
  // Resolve the workspace path once (cheap): used both for the optional full-text search
  // and to emit the deterministic worktree_path on every row.
  const dirPath = getWorkspace(workspaceId)?.path ?? null;
  const out: TaskListView[] = [];
  for (const row of listTasks(workspaceId)) {
    if (needle && !matchesQuery(taskSearchText(row, dirPath), needle)) continue;
    const blocked_by = parseBlockedBy(row.blocked_by);
    out.push({
      ...row,
      blocked_by,
      tags: parseTags(row.tags),
      allowlist: parseAllowlist(row.allowlist),
      blockerStates: blockerStatesOf(blocked_by),
      deadBlockers: deadBlockerIds(blocked_by),
      pending_responder: pendingResponder(row),
      worktree_path: dirPath ? git.worktreePath(dirPath, row.id) : null,
      gates: gatesView(row),
      liveness: livenessView(row),
    });
  }
  return out;
}

// --- CROSS-WORKSPACE READ-ONLY SURFACES (CTO observability) ----------------
//
// The PULL side of the operator/CTO channel: list/stats/attention/readiness reads
// that reconstruct pipeline state in ONE call instead of walking per-workspace task
// lists, the sqlite file, or git by hand. All read-only — no transitions, no I/O
// beyond the cheap git probes readiness needs.

/**
 * Cross-workspace TASK LIST in the light TaskListView shape (newest-first across ALL
 * workspaces), with optional filters:
 *  - `workspace` — restrict to one workspace id (unknown id → empty list).
 *  - `status`    — restrict to one task status.
 *  - `q`         — case-insensitive full-text filter over the same searchable text the
 *                  per-workspace list uses (id + summary + review notes + task.md prompt).
 * Reuses the per-row projection of taskListView so a row's shape never diverges between
 * the per-workspace and cross-workspace lists. The cross-workspace sort is by created_at
 * DESC (the per-workspace query is already newest-first; this re-orders the merged set).
 */
export function allTasksView(
  opts: { status?: string; workspace?: string; q?: string } = {},
): TaskListView[] {
  const needle = (opts.q ?? "").trim();
  const workspaces = opts.workspace
    ? (getWorkspace(opts.workspace) ? [getWorkspace(opts.workspace)!] : [])
    : db
        .query<WorkspaceRow, []>(`SELECT * FROM workspaces ORDER BY created_at ASC`)
        .all();
  const out: TaskListView[] = [];
  for (const ws of workspaces) {
    for (const row of listTasks(ws.id)) {
      if (opts.status && row.status !== opts.status) continue;
      if (needle && !matchesQuery(taskSearchText(row, ws.path), needle)) continue;
      const blocked_by = parseBlockedBy(row.blocked_by);
      out.push({
        ...row,
        blocked_by,
        tags: parseTags(row.tags),
        blockerStates: blockerStatesOf(blocked_by),
        deadBlockers: deadBlockerIds(blocked_by),
        pending_responder: pendingResponder(row),
        worktree_path: git.worktreePath(ws.path, row.id),
        gates: gatesView(row),
      });
    }
  }
  // Merge-sort the per-workspace (already newest-first) lists into one newest-first set.
  out.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  return out;
}

/** Global pipeline rollup: status counts across ALL workspaces + a per-workspace breakdown. */
export type StatsRollup = {
  /** Total task count across all workspaces (the `idle` pseudo-bucket is NOT counted —
   * it is peeled out of in_progress, not a distinct status). */
  totalTasks: number;
  /** Number of registered workspaces. */
  workspaces: number;
  /** Status → summed count across every workspace, plus the `idle` pseudo-bucket (a flag
   * on a LIVE in_progress agent, peeled out of in_progress — mirrors workspaces.counts). */
  totals: Record<string, number>;
  /** Per-workspace status counts (the same per-status map the dashboard/workspace views use). */
  byWorkspace: Array<{
    id: string;
    label: string | null;
    path: string;
    counts: Record<string, number>;
  }>;
};

/**
 * The /api/stats rollup: counts by status across every workspace, replacing a drop to
 * `bun -e` against the DB. Built from listWorkspaces() (which already folds each
 * workspace's per-status `counts`, including the `idle` peel-out), so the idle pseudo-
 * bucket logic lives in exactly one place. `totalTasks` sums every real status bucket
 * (NOT idle — it would double-count, being peeled from in_progress).
 */
export function statsRollup(): StatsRollup {
  const wss = listWorkspaces();
  const totals: Record<string, number> = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0]));
  totals.idle = 0;
  let totalTasks = 0;
  const byWorkspace = wss.map((ws) => {
    for (const [status, n] of Object.entries(ws.counts)) {
      totals[status] = (totals[status] ?? 0) + n;
      if (status !== "idle") totalTasks += n;
    }
    return { id: ws.id, label: ws.label, path: ws.path, counts: ws.counts };
  });
  return { totalTasks, workspaces: wss.length, totals, byWorkspace };
}

/**
 * Why a task is on the attention feed — the categorized reason GET /api/attention
 * carries so "is anything waiting on me" is one reliable call. Mirrors the feedback
 * STEP model (workspaces.RESPONDER_STEPS) plus the two non-step attention conditions
 * (`major-confirm` and the terminal `failed`):
 *   spec-approval   — a generated spec awaiting approval (spec_review).
 *   plan-approval   — a plan-preview plan awaiting approval (needs_info + plan_preview).
 *   answer-question — an agent raised a question (needs_info, no plan_preview).
 *   diff-review     — a finished diff awaiting review (in_review).
 *   major-confirm   — an in_review release_mode MAJOR task awaiting the human double-confirm.
 *   idle-handling   — a live build agent went idle (in_progress + idle).
 *   failed          — a terminal execution failure to inspect.
 */
export type AttentionReason =
  | "spec-approval"
  | "plan-approval"
  | "answer-question"
  | "diff-review"
  | "major-confirm"
  | "idle-handling"
  | "failed";

export type AttentionItem = {
  id: string;
  workspace_id: string;
  workspace_label: string | null;
  status: TaskStatus;
  kind: TaskKind;
  reason: AttentionReason;
  /** The resolved responder for the pending feedback step (`cto`/`user`, or `story` for a
   * story member's escalation chain), or null (a `failed` task is not a feedback state —
   * no responder is awaited). See pendingResponder / ESCALATION_CHAIN. */
  pending_responder: EscalationRung | null;
  /** A short human hook: the request_review summary, the raised question, or the
   * failure / review note — whichever fits the reason. */
  detail: string | null;
  /** The most relevant "waiting since" timestamp (review-entry time, else created). */
  since: string | null;
};

/**
 * Categorize a single attention row. Pure (row + workspace release_mode) so the mapping
 * can't drift from the state machine — it reuses the same discriminators as the feedback
 * step map (plan_preview for needs_info) and the major-confirm gate (release_mode +
 * version_bump='major'). An in_review release_mode major task reads `major-confirm`
 * rather than `diff-review`, since approval alone parks it pending the human confirm.
 */
export function attentionReason(row: TaskRow, releaseMode: boolean): AttentionReason | null {
  switch (row.status) {
    case "failed":
      return "failed";
    case "spec_review":
      return "spec-approval";
    case "needs_info":
      return row.plan_preview ? "plan-approval" : "answer-question";
    case "in_review":
      return releaseMode && row.version_bump === "major" ? "major-confirm" : "diff-review";
    case "in_progress":
      return row.idle ? "idle-handling" : null;
    default:
      return null;
  }
}

/** The short hook text for an attention item, picked to match its reason. */
function attentionDetail(row: TaskRow, reason: AttentionReason): string | null {
  switch (reason) {
    case "answer-question":
    case "plan-approval":
      return row.question ?? null;
    case "failed":
      return row.last_dispatch_error ?? row.review_note ?? row.summary ?? null;
    case "idle-handling":
      return row.idle_context ?? row.summary ?? null;
    default:
      return row.summary ?? row.review_note ?? null;
  }
}

/**
 * The /api/attention feed: a structured list of every task awaiting the operator right
 * now — the PULL side of the push-only CTO channel, so a missing list can never give a
 * false "idle" read. Selects the feedback/failed states plus a live IDLE build agent in
 * ONE query and categorizes each (attentionReason). Oldest-first (longest-waiting at the
 * top — what to look at first).
 */
export function attentionList(): AttentionItem[] {
  const rows = db
    .query<TaskRow, []>(
      `SELECT * FROM tasks
        WHERE status IN ('spec_review','in_review','needs_info','failed')
           OR (status='in_progress' AND herdr_pane_id IS NOT NULL AND idle=1)
        ORDER BY created_at ASC`,
    )
    .all();
  const items: AttentionItem[] = [];
  for (const row of rows) {
    const reason = attentionReason(row, workspaceReleaseMode(row.workspace_id));
    if (!reason) continue;
    items.push({
      id: row.id,
      workspace_id: row.workspace_id,
      workspace_label: getWorkspace(row.workspace_id)?.label ?? null,
      status: row.status,
      kind: row.kind,
      reason,
      pending_responder: pendingResponder(row),
      detail: attentionDetail(row, reason),
      since: row.completed_at ?? row.created_at ?? null,
    });
  }
  return items;
}

/**
 * Pure ALL-GATES-GREEN predicate for the readiness view. A gate is GREEN when it is
 * passing OR not blocking, and RED when it failed, raised a concern, or is still in
 * flight:
 *   - CI:          'pass' or null (disabled / never ran) → green; 'fail' / 'running' → red.
 *   - conformance: 'pass' or null (disabled / never ran) → green; 'concern' / 'checking' → red.
 *   - changelog:   the caller's precomputed checkChangelogUpdated().ok (true when the gate
 *                  is disabled, the diff is exempt, or the changelog was updated).
 * Pure (no I/O) so it is unit-testable against a synthetic row + boolean. The conformance
 * 'concern' verdict is deliberately NOT green — only a clean pass counts.
 */
export function gatesGreen(row: TaskRow, changelogOk: boolean): boolean {
  const ciGreen = row.ci_status === null || row.ci_status === "pass";
  const confGreen = row.conformance_status === null || row.conformance_status === "pass";
  return ciGreen && confGreen && changelogOk;
}

/** The mergeability snapshot GET /api/tasks/:id/readiness returns. */
export type TaskReadiness = {
  /** The branch already contains the current default tip (behindBy === 0). */
  onTip: boolean;
  /** How many commits behind the default tip the branch is (0 when on tip). */
  behindBy: number;
  /** The branch's changed files vs the default branch (committed + uncommitted union). */
  changedFiles: string[];
  /** Whether ALL applicable gates are green (see gatesGreen). */
  gatesGreen: boolean;
  /** Changed files NOT covered by the GLOBAL auto-merge allowlist (config.autoMergeAllowlist)
   * — i.e. what keeps the task out of low-risk auto-merge. Named for the auto-merge set
   * specifically so a future PER-TASK allowlist can report its own violations alongside. */
  outsideAutoMergeAllowlist: string[];
};

/**
 * GET /api/tasks/:id/readiness — the merge-readiness snapshot, replacing manual
 * merge-base / rev-list / diff. Computes the branch's position vs the default tip
 * (onTip / behindBy), its changed files, whether every gate is green (running the PURE
 * changelog check against the live diff), and which changed files fall outside the
 * auto-merge allowlist. 404 if the task or its workspace is gone.
 */
export async function taskReadiness(id: string): Promise<TaskReadiness> {
  const row = getTask(id);
  if (!row) throw new HttpError(404, `task not found: ${id}`);
  const dir = getWorkspace(row.workspace_id);
  if (!dir) throw new HttpError(404, "workspace not found");

  // Measure the branch against its resolved base: the STORY branch for an isolated member,
  // else the default branch (resolveBase → defaultBranch, so non-isolated is unchanged).
  const base = await resolveBase(row);
  const behindBy = await git.commitsBehind(dir.path, id, base);
  const { files: changedFiles } = await git.diffStat(dir.path, id, base);

  const changelogPath = workspaceChangelogPath(row.workspace_id).trim();
  const changelogOk = changelogPath
    ? checkChangelogUpdated(changedFiles, changelogPath, {
        strict: workspaceReleaseMode(row.workspace_id),
      }).ok
    : true;

  return {
    onTip: behindBy === 0,
    behindBy,
    changedFiles,
    gatesGreen: gatesGreen(row, changelogOk),
    outsideAutoMergeAllowlist: changedFiles.filter(
      (f) => !fileAllowed(f, config.autoMergeAllowlist),
    ),
  };
}

function emitUpdated(id: string): void {
  const v = taskView(id);
  if (v) publish({ type: "task.updated", task: v });
}

// ---- BRANCH-ISOLATION BASE RESOLUTION (Phase D-SUBTASK-MERGE) --------------
//
// git.ts is DB-free: its functions take an explicit `base?` (merge-target ref) and an
// ff-target, defaulting to the repo default branch / root. tasks.ts has story + DB
// access, so it owns RESOLVING the per-task base + merge-context and threading them
// down (CONTRIBUTING §11.2/§11.8). For an ISOLATED story member both resolvers now return
// the STORY branch / story worktree; for every other task they return today's single-level
// values (default branch / { dir, default branch }). The whole isolated path is GATED by
// isolatedStoryBranch (workspace branch_isolation ON AND the story's captured `isolated`
// bit = 1) — OFF everywhere this phase, so non-isolated members + standalone tasks are
// byte-for-byte unchanged. The live subtask merge path (finalizeMerge) is wired to
// resolveMergeContext below; the story→main path stays single-level until Phase E.

/**
 * GUARDED (CONTRIBUTING §11.8) — the story branch an isolated story member retargets onto,
 * or null. Returns git.storyBranchName(story_id) iff the task is a story member AND its
 * workspace has branch_isolation ON AND the story's CAPTURED `isolated` bit is 1; else null.
 * Reads the story's isolated bit via a DIRECT db query (not stories.ts) to avoid a
 * tasks↔stories import cycle. GATES the whole isolated subtask path (resolveBase /
 * resolveMergeContext / every threaded base): it returns null whenever the flag is OFF or
 * the story captured isolated=0, so the path is inert until activation (Phase F flips the
 * flag) — non-isolated members + standalone tasks always resolve to null here.
 */
function isolatedStoryBranch(row: TaskRow): string | null {
  if (!row.story_id) return null;
  if (!workspaceBranchIsolation(row.workspace_id)) return null;
  const story = db
    .query<{ isolated: number }, [string]>(`SELECT isolated FROM stories WHERE id=?`)
    .get(row.story_id);
  if (!story || story.isolated !== 1) return null;
  return git.storyBranchName(row.story_id);
}

/**
 * Resolve a task's REBASE/MERGE BASE — the ref its branch is measured/rebased against.
 * For an ISOLATED story member (isolatedStoryBranch != null) this is the STORY BRANCH; for
 * every other task it is the workspace default branch (today's value). The guard keeps it
 * INERT until activation: isolatedStoryBranch returns null whenever the workspace flag is
 * OFF or the story's captured isolated bit is 0, so non-isolated members + standalone tasks
 * resolve to defaultBranch — byte-for-byte today's behavior (CONTRIBUTING §11.2/§11.8).
 *
 * The Phase-C side effect (now also load-bearing): for an isolated member it lazily ensures
 * the story branch + its worktree exist BEFORE the subtask worktree is branched off it
 * (§11.3) — so the returned story branch is always a real ref. Throws 404 if the task's
 * workspace is gone (same contract as the other git-probe reads here).
 */
export async function resolveBase(row: TaskRow): Promise<string> {
  const dir = getWorkspace(row.workspace_id);
  if (!dir) throw new HttpError(404, "workspace not found");
  const storyBranch = isolatedStoryBranch(row);
  if (storyBranch) {
    await git.ensureStoryBranch(dir.path, storyBranch);
    return storyBranch;
  }
  return git.defaultBranch(dir.path);
}

/** The resolved MERGE CONTEXT for a task: where its branch fast-forwards in (ffWorktree),
 * the branch that advances (targetBranch), and the rebase base. See resolveMergeContext. */
export type MergeContext = {
  /** The worktree the merge fast-forwards in (and the post-merge verify runs in). */
  ffWorktree: string;
  /** The branch the fast-forward advances. */
  targetBranch: string;
  /** The ref the task branch is rebased onto. */
  base: string;
};

/**
 * Resolve a task's MERGE CONTEXT — the ff-target + base finalizeMerge uses. For an ISOLATED
 * story member it returns `{ ffWorktree: storyWt, targetBranch: storyBranch, base:
 * storyBranch }` so the subtask fast-forwards INTO the story worktree, the post-merge verify
 * runs THERE, and reset-on-red resets THAT checkout (CONTRIBUTING §11.4/§11.5). For every
 * other task it returns `{ ffWorktree: dir.path, targetBranch: <default>, base: <default> }`
 * — exactly today's single-level main flow. The guard (isolatedStoryBranch) keeps it INERT
 * until activation, so standalone tasks + non-isolated members are byte-for-byte unchanged.
 *
 * For an isolated member it ensures the story branch + worktree exist FIRST (idempotent), so
 * the ff-target checkout provably exists even on a restart-recovery merge. Throws 404 if the
 * task's workspace is gone.
 */
export async function resolveMergeContext(row: TaskRow): Promise<MergeContext> {
  const dir = getWorkspace(row.workspace_id);
  if (!dir) throw new HttpError(404, "workspace not found");
  const storyBranch = isolatedStoryBranch(row);
  if (storyBranch) {
    const storyWt = await git.ensureStoryBranch(dir.path, storyBranch);
    return { ffWorktree: storyWt, targetBranch: storyBranch, base: storyBranch };
  }
  const def = await git.defaultBranch(dir.path);
  return { ffWorktree: dir.path, targetBranch: def, base: def };
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
 * Wrap a value passed in setStatus's `set` so the column compiles to
 * `col=COALESCE(?, col)` (OVERWRITE the column ONLY when the supplied value is non-NULL,
 * else leave it untouched) — the MIRROR-IMAGE of keep()'s `col=COALESCE(col, ?)`
 * stick-to-first. Used for "overwrite-if-supplied" columns: grounding_fp (re-stamped on
 * each launch that passes a fingerprint, kept across a launch that doesn't) and
 * output_snapshot (replaced when a fresh snapshot was captured, kept otherwise).
 */
function setIfPresent(
  value: string | number | null,
): { __setIfPresent: true; value: string | number | null } {
  return { __setIfPresent: true, value };
}
function isSetIfPresent(
  v: unknown,
): v is { __setIfPresent: true; value: string | number | null } {
  return (
    typeof v === "object" && v !== null && (v as { __setIfPresent?: unknown }).__setIfPresent === true
  );
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
 *    `keep(...)` for `col=COALESCE(col, ?)` stamp-once semantics, or `setIfPresent(...)`
 *    for `col=COALESCE(?, col)` overwrite-if-supplied semantics.
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
    } else if (isSetIfPresent(val)) {
      assigns.push(`${col}=COALESCE(?, ${col})`);
      params.push(val.value);
    } else {
      assigns.push(`${col}=?`);
      params.push(val as string | number | null);
    }
  }
  // The idle CONTEXT is bound to the idle FLAG: any transition that clears `idle`
  // (every setStatus that sets it does so to 0 — only setIdle ever sets 1) also wipes
  // the captured `idle_context`, so a stale idle snapshot can never linger on a task
  // that has left the idle condition. Skipped if a caller set idle_context explicitly.
  if (opts.set && "idle" in opts.set && !("idle_context" in opts.set)) {
    assigns.push("idle_context=NULL");
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
 * Validate + normalize the optional `version_bump` level from an API/CLI body. Returns
 * one of 'patch' (the default when unset/null/blank) | 'minor' | 'major'; rejects (400)
 * anything else. Only meaningful when the task's workspace has release_mode on, where it
 * sets the semver bump applied at merge; 'major' additionally requires the human
 * double-confirm ritual (see confirmMajor). See the `version_bump` column in db.ts.
 */
export function validateVersionBump(bump: unknown): VersionBumpLevel {
  if (bump === undefined || bump === null || bump === "") return "patch";
  if (bump === "patch" || bump === "minor" || bump === "major") return bump;
  throw new HttpError(400, "version_bump must be 'patch', 'minor', or 'major'");
}

/**
 * Validate the optional `idea` flag from an API/CLI body. Returns a boolean, defaulting
 * to false when unset/null. Rejects (400) any non-boolean value. When true, the task is
 * created in the unified pipeline's FRONT state `idea`: the `prompt` is treated as a
 * one-line operator BRIEF, and the task WAITS (no agent runs) for the spec-generation
 * responder to submit a spec via POST /api/tasks/:id/spec (submitSpec), which advances it
 * to `spec_review`. See createTask / submitSpec.
 */
export function validateIdea(idea: unknown): boolean {
  if (idea === undefined || idea === null) return false;
  if (typeof idea !== "boolean") {
    throw new HttpError(400, "idea must be a boolean");
  }
  return idea;
}

/**
 * THE OPERATOR STANDALONE-TASK-CREATION GATE (Phase 7 — AUTHORITY FLIP). The operator/CTO
 * may no longer create story-less work tasks directly: new work flows through STORIES
 * (POST /api/workspaces/:id/stories) and the tasks themselves are created EXCLUSIVELY by
 * story LEADERS (POST /api/stories/:id/tasks → createSubtask). The ONE task kind still
 * creatable straight from a workspace is a ROLLBACK — the 'Roll back' flow, which reverts a
 * merged task's commit through the normal pipeline (src/templates.ts). So the workspace task
 * route admits ONLY kind==='rollback' and rejects every ordinary/idea standalone create with
 * 409, pointing the caller at story creation.
 *
 * This gates the HTTP ENTRY POINT only — it is called by the POST /api/workspaces/:id/tasks
 * route, NOT by createTask itself. In-process createTask/createSubtask (leader decomposition
 * + any internal/system task creation) are deliberately UNAFFECTED, since they never pass
 * through this gate. Pure + exported so the rule is unit-testable without the HTTP server
 * (mirrors csrfGuard). Throws HttpError(409) to reject; returns for an allowed (rollback) kind.
 */
export function assertWorkspaceTaskCreationAllowed(kind: TaskKind): void {
  if (kind === "rollback") return;
  throw new HttpError(
    409,
    "standalone task creation is disabled — the operator creates STORIES " +
      "(POST /api/workspaces/:id/stories) and story leaders create the tasks " +
      "(POST /api/stories/:id/tasks). Only the 'Roll back' flow may create a task directly here.",
  );
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
  versionBump: unknown = "patch",
  allowlist: string[] = [],
  storyId: string | null = null,
): Promise<TaskView> {
  const dir = getWorkspace(workspaceId);
  if (!dir) throw new HttpError(404, `workspace not found: ${workspaceId}`);
  if (!prompt || !prompt.trim()) {
    throw new HttpError(400, "prompt is required");
  }
  // STORY MEMBERSHIP (Phase 5): an optional story_id grouping this task as a SUBTASK of a
  // story. Validated by a DIRECT db read of the stories table (NOT importing stories.ts —
  // that would close an import cycle, the same reason story-agent.ts reads story rows
  // directly): the story must exist (404) and live in THIS task's workspace (400). Checked
  // here, BEFORE the worktree is created, so a bad story never strands an orphaned worktree.
  if (storyId != null) {
    const storyWs = db
      .query<{ workspace_id: string }, [string]>(`SELECT workspace_id FROM stories WHERE id=?`)
      .get(storyId)?.workspace_id;
    if (storyWs == null) throw new HttpError(404, `story not found: ${storyId}`);
    if (storyWs !== workspaceId) {
      throw new HttpError(400, "story belongs to a different workspace than the task");
    }
  }
  const taskModel = validateModel(model);
  // Validate + normalize the organizational labels (trim/dedupe/length-cap).
  const taskTags = validateTags(tags);
  // Validate + normalize the per-task file allowlist (the CI scope gate; [] = inert).
  const taskAllowlist = validateAllowlist(allowlist);
  const taskPriority = validatePriority(priority);
  const taskPlanPreview = validatePlanPreview(planPreview);
  const taskIdea = validateIdea(idea);
  // Declared semver bump level applied at merge in release_mode (patch default).
  const taskVersionBump = validateVersionBump(versionBump);

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
  // `idea` — a WAITING/feedback state. butchr runs NO agent for it: it pushes a `spec
  // requested` event on the CTO channel and waits for the spec-generation responder (the
  // CTO agent or a human) to submit the spec via submitSpec, which advances it to
  // `spec_review` for sign-off. Any blockers are recorded but only gate the post-approval
  // `inactive` transition, not the spec-writing front state. A 'New task' (already
  // carrying a spec) starts directly in `inactive` (ready — queued for the dispatcher, no
  // live agent yet) unless it has unmerged blockers, in which case it waits in `blocked`
  // and auto-unblocks to `inactive` later.
  const status: TaskStatus = taskIdea
    ? "idea"
    : allBlockersMerged(blockers)
      ? "inactive"
      : "blocked";

  // Filesystem artifact first: worktree + task.md. If either fails, no DB row. Branch the
  // worktree from the resolved base — the STORY branch for an isolated member (resolveBase
  // lazily ensures the story branch + worktree exist FIRST, the §11.3 "ensureStoryBranch
  // runs right before the first subtask worktree is branched" cut), else the default branch
  // (resolveBase → defaultBranch, so a standalone/non-isolated task is unchanged). The DB
  // row does not exist yet, so resolveBase is fed a minimal row carrying only the two fields
  // isolatedStoryBranch reads (story_id + workspace_id).
  const base = await resolveBase({ story_id: storyId, workspace_id: workspaceId } as TaskRow);
  await git.createWorktree(dir.path, id, base);
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
      allowlist: taskAllowlist,
    },
    prompt,
  );

  db.query(
    `INSERT INTO tasks (id, workspace_id, status, blocked_by, kind, model, tags, allowlist, priority, plan_preview, version_bump, story_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    workspaceId,
    status,
    JSON.stringify(blockers),
    kind,
    taskModel,
    JSON.stringify(taskTags),
    JSON.stringify(taskAllowlist),
    taskPriority,
    taskPlanPreview ? 1 : 0,
    taskVersionBump,
    storyId,
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

/**
 * Update a task's declared semver `version_bump` level ('patch'|'minor'|'major'),
 * applied at merge when its workspace is in release_mode. Validated the same way as at
 * creation. 404 if the task is gone; 409 if it is already terminal (a merged task's
 * version is fixed). Changing the bump is an EDIT, so it RESETS the major-confirm streak
 * to 0 (a parked major task must be re-confirmed twice from scratch). Emits a
 * `task.updated`.
 */
export function setVersionBump(id: string, bump: unknown): TaskView {
  const row = getTask(id);
  if (!row) throw new HttpError(404, `task not found: ${id}`);
  if (isTerminal(row.status)) {
    throw new HttpError(409, `cannot change version_bump on a ${row.status} task`);
  }
  const level = validateVersionBump(bump);
  db.query(`UPDATE tasks SET version_bump=?, major_confirm_count=0 WHERE id=?`).run(level, id);
  emitUpdated(id);
  return taskView(id)!;
}

/**
 * EDIT a task's prompt and/or context-file list IN PLACE — the operator surface for
 * REFINING a paused subtask instead of abort+recreate (PATCH /api/tasks/:id). ADDITIVE:
 * it touches NOTHING else — no status transition, no blocked_by/priority/version_bump, no
 * agent teardown. The prompt + context live in task.md (the on-disk source of truth; the
 * DB stores neither), so this rewrites task.md in place via updateTaskMdPrompt /
 * updateTaskMdContext, preserving the Review Notes and Clarifications sections.
 *
 * `grounding_fp` is DELIBERATELY left untouched: the dispatcher's resume path compares the
 * task's LIVE grounding fingerprint (prompt+context) against the stored one and, on a
 * mismatch, re-grounds the resumed agent with the CURRENT definition (renderRegroundBlock).
 * So a paused task (needs_info / in_review) picks the edit up on its next `--resume`, and a
 * ready `inactive` task renders the fresh task.md on first dispatch — no extra wiring here.
 *
 * Gating mirrors setBlockedBy/setVersionBump plus rolling_back: 404 if the task is gone;
 * 409 if it is terminal (merged/failed/rolled_back/aborted) OR `rolling_back` (mid-rollback
 * pipeline — its prompt/context is the revert machinery's, not an operator's to refine).
 * Editing a live `in_progress` task is ALLOWED — the edit simply takes effect on the
 * agent's next resume (the intended reground behavior). 400 if neither field is supplied,
 * or if `prompt` is given but blank. Key-presence based: a field absent from `edits` is
 * left unchanged. Emits a `task.updated`.
 */
export function editTask(
  id: string,
  edits: { prompt?: string; context?: string[] },
): TaskView {
  const row = getTask(id);
  if (!row) throw new HttpError(404, `task not found: ${id}`);
  if (isTerminal(row.status) || row.status === "rolling_back") {
    throw new HttpError(409, `cannot edit prompt/context on a ${row.status} task`);
  }
  const hasPrompt = edits.prompt !== undefined;
  const hasContext = edits.context !== undefined;
  if (!hasPrompt && !hasContext) {
    throw new HttpError(400, "provide a prompt and/or context to edit");
  }

  const dir = getWorkspace(row.workspace_id);
  if (!dir) throw new HttpError(404, "workspace not found");

  if (hasPrompt) {
    if (typeof edits.prompt !== "string" || !edits.prompt.trim()) {
      throw new HttpError(400, "prompt must be a non-empty string");
    }
    updateTaskMdPrompt(dir.path, id, edits.prompt);
  }
  if (hasContext) {
    updateTaskMdContext(dir.path, id, validateContext(edits.context));
  }

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
      // Editing dependencies breaks the major double-confirm streak (must be consecutive).
      major_confirm_count: 0,
    },
  });
  logDeadBlockers(id, blockers);
  return taskView(id)!;
}

/** Compute the diff of a task branch vs its resolved base — the STORY branch for an isolated
 * member, else the workspace default branch (resolveBase → defaultBranch, so non-isolated is
 * unchanged). */
export async function taskDiff(id: string): Promise<string> {
  const row = getTask(id);
  if (!row) throw new HttpError(404, `task not found: ${id}`);
  const dir = getWorkspace(row.workspace_id);
  if (!dir) throw new HttpError(404, "workspace not found");
  return git.diff(dir.path, id, await resolveBase(row));
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
  // release_mode + version_bump='major': the task is PARKED awaiting the human
  // double-confirm ritual and did NOT merge. `major_confirm_count` on the task view
  // carries the streak (0/1/2); the merge only runs once two consecutive `confirm-major`
  // calls land it. Approve alone parks (it just says "the diff is good"). See confirmMajor.
  awaitingMajorConfirm?: boolean;
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
      // Any rework / conflict kick-back BREAKS the major double-confirm streak: the two
      // confirm-major calls must be consecutive, so a re-review starts again from 0.
      major_confirm_count: 0,
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

/**
 * Build the actionable merge-conflict note (resolving the default branch name), append it
 * to task.md's Review Notes as a Rejection entry, and return it for the caller to persist
 * onto review_note. Shared by the two places a rebase conflict surfaces: the pre-dispatch
 * rebase (prepareBranchForDispatch — persists review_note directly) and the merge-time
 * rebase (finalizeMerge — hands the note to requestChanges, which persists review_note as
 * part of the kick-back, so finalizeMerge no longer writes it a second time).
 */
async function recordMergeConflictNote(
  dir: WorkspaceRow,
  id: string,
  conflictFiles: string[],
  message: string,
): Promise<string> {
  const base = await git.defaultBranch(dir.path);
  const note = buildConflictNotes(id, base, conflictFiles, message);
  appendRejection(dir.path, id, note, nowIso());
  return note;
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

  // Resolve the branch's base: the STORY branch for an isolated member (keeping it current
  // with the advancing story branch), else the default branch (resolveBase → defaultBranch,
  // so non-isolated is unchanged).
  const base = await resolveBase(row);

  // Cheap, lock-free gate: a freshly-created worktree already contains the tip, so
  // skip the merge queue entirely for it (the common case).
  if (!(await git.isBehindDefault(dir.path, id, base))) {
    return { ok: true, rebased: false, conflict: false };
  }

  // Behind the tip → do the move under the merge queue so it can't interleave with
  // a concurrent merge advancing the default ref (rebaseOntoDefault re-checks the
  // ancestor relationship inside, since the tip may have advanced before we ran).
  const res = await runExclusiveMerge(() =>
    git.rebaseOntoDefault(dir.path, id, workspaceChangelogPath(dir.id), base),
  );

  if (res.conflict) {
    // Surface it (NOT a silent dispatch): record the note in task.md (the resumed
    // agent reads it via renderReworkPrompt) and in review_note for the UI.
    const note = await recordMergeConflictNote(dir, id, res.conflictFiles, res.message);
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
  // The branch tip just moved (a rebase/reset) → any gate result bound to the OLD tip is
  // now stale-green for a different tip; clear it so it re-runs fresh on the next review.
  if (res.rebased) await invalidateStaleGates(id);
  return { ok: true, rebased: res.rebased, conflict: false };
}

// ===========================================================================
// THE UNIFIED FEEDBACK MECHANISM (idea / spec_review / in_review / needs_info).
// ===========================================================================
// The four FEEDBACK states share ONE shape and ONE code path: butchr surfaces an
// ARTIFACT, awaits a RESPONSE (from the step's responder — the CTO agent or a human),
// then either FORWARDS the task to the next state or RESUMES the agent. They differ only
// in (artifact, which responses are valid, where each response routes):
//
//   state        artifact   response          routes to
//   -----------  ---------  ----------------  -------------------------------------------
//   idea         brief      submit_spec       spec_review (the spec becomes the prompt)
//   spec_review  spec       approve           inactive/blocked (build)
//                           request_changes   idea (revise → await a new spec)
//   in_review    diff       approve           MECHANICAL MERGE (merged/rolled_back;
//                                             conflict→inactive)
//                           request_changes   inactive (resume the agent)
//   needs_info   question   answer            inactive (resume the agent)
//
// respondToFeedback is that single path; submitSpec / approveTask / rejectTask /
// answerTask are thin public wrappers over it (kept for the API / CLI / test surface).
//
// SPEC GENERATION (idea → spec_review): the FRONT state `idea` holds a one-line brief and
// NO spec. butchr does NOT run an agent for it — it pushes a `spec requested` event on the
// CTO notification channel (src/channel.ts) and WAITS. Whoever is the workspace's
// `spec-generation` responder (the persistent CTO agent for `cto`, a human in the webapp
// for `user` — see workspaces.responderFor) writes the spec and submits it via
// submitSpec / POST /api/tasks/:id/spec, which rewrites the prompt brief → spec and
// advances the task to spec_review. The blocker check is deferred to the spec_review
// approval (see respondToFeedback's approve branch).

export type FeedbackArtifact = "brief" | "spec" | "diff" | "question";
export type FeedbackResponseType = "submit_spec" | "approve" | "request_changes" | "answer";

/**
 * Describe a feedback state's artifact + the responses it accepts (or null when the
 * status is not a feedback state). The single definition the UI reads to show "what's
 * awaited" and that respondToFeedback validates against.
 */
export function feedbackInfo(
  status: TaskStatus,
): { artifact: FeedbackArtifact; awaiting: string; accepts: FeedbackResponseType[] } | null {
  switch (status) {
    case "idea":
      return { artifact: "brief", awaiting: "a spec for the brief", accepts: ["submit_spec"] };
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
  | { type: "submit_spec"; spec: string }
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

  // ---- SUBMIT SPEC (idea → spec_review) ----
  // The spec-generation responder (the CTO agent or a human) wrote the spec for this
  // idea's brief. Rewrite the task.md prompt brief → spec (so the SPEC becomes the task's
  // prompt AND the artifact reviewed at spec_review), then advance idea → spec_review.
  if (response.type === "submit_spec") {
    const spec = (response.spec ?? "").trim();
    if (!spec) throw new HttpError(400, "a spec is required");
    updateTaskMdPrompt(dir.path, id, spec);
    if (
      !setStatus(id, "spec_review", {
        from: "idea",
        note: "spec submitted — awaiting approval",
        set: {
          // Clear any prior change-request note now that a fresh spec exists, and any
          // stale dispatch/backoff bookkeeping a re-revised idea might carry.
          review_note: null,
          dispatch_attempts: 0,
          last_dispatch_error: null,
          next_dispatch_at: null,
          // Entering a NEW feedback state (spec awaiting approval) → escalation back to rung 0.
          // V2 (design §4a): a fresh feedback entry also clears escalated_to_user so a re-opened
          // item starts back at the CTO. No-op under V1 (the column is never set there).
          responder_tier: 0,
          escalated_to_user: 0,
        },
      })
    ) {
      // Moved under us (e.g. aborted) — return whatever it is now.
      emitUpdated(id);
      return { task: taskView(id)! };
    }
    console.log(`[butchr] idea task ${id} → spec_review (spec submitted)`);
    return { task: taskView(id)! };
  }

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
      // REVISE the spec: log the note and send the task back to `idea`, which re-pushes a
      // `spec requested` event and WAITS for the responder to submit a revised spec
      // (addressing the note, which is preserved in review_note) → spec_review again.
      setStatus(id, "idea", {
        from: "spec_review",
        note: "spec changes requested — awaiting revised spec",
        set: {
          review_note: note,
          dispatch_attempts: 0,
          last_dispatch_error: null,
          next_dispatch_at: null,
          // Re-entering the `idea` feedback state = a brand-new spec request → rung 0.
          // V2 (design §4a): also clear escalated_to_user. No-op under V1.
          responder_tier: 0,
          escalated_to_user: 0,
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
 * Submit the SPEC for an `idea` task (the spec-generation responder — the CTO agent or a
 * human in the webapp — wrote it). Rewrites the task's prompt brief → spec and advances
 * idea → spec_review. Thin wrapper over the unified feedback mechanism; returns the
 * post-transition task view. 409 if the task isn't in `idea`; 400 on a blank spec.
 */
export async function submitSpec(id: string, spec: string): Promise<TaskView> {
  const outcome = await respondToFeedback(id, { type: "submit_spec", spec });
  return outcome.task;
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

  // MAJOR DOUBLE-CONFIRM INTERLOCK (release_mode + version_bump='major'). A major-bump
  // task does NOT merge until the HUMAN has issued two CONSECUTIVE `confirm-major` calls
  // (major_confirm_count reaches 2). Approve alone parks it here ("the diff is good"); it
  // does not merge and does not increment — only confirmMajor advances the streak, and
  // any other action resets it to 0. This is the SINGLE merge entry (approve, auto-merge,
  // boot recovery all route through finalizeMerge), so the gate can never be bypassed.
  // The major gate is ALWAYS the human — maybeAutoMerge bails on a major task, so an
  // auto-merge never auto-confirms. (Rollback tasks default to patch, so they don't park.)
  const releaseMode = workspaceReleaseMode(dir.id);
  if (releaseMode && row.version_bump === "major" && row.major_confirm_count < 2) {
    return { task: taskView(id)!, awaitingMajorConfirm: true };
  }

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

  // Resolve the MERGE CONTEXT — the ff-target (worktree to fast-forward in + the branch it
  // advances) and the rebase base. For an ISOLATED story member this is the STORY worktree /
  // story branch (the subtask ff's into the story worktree, the post-merge verify runs THERE,
  // and reset-on-red resets THAT checkout — CONTRIBUTING §11.4/§11.5); for every other task
  // it is today's `{ dir.path, default, default }`, so the standalone/non-isolated flow below
  // is byte-for-byte unchanged. (The subtask still rebases in ITS OWN worktree — git.merge's
  // sourceWorktree stays defaulted; only the ff-target + base come from the context.)
  const mctx = await resolveMergeContext(row);

  // Serialize through the global merge queue so concurrent approvals rebase+ff
  // one-at-a-time against an up-to-date base tip instead of racing in parallel.
  //
  // The verify gate + its auto-revert run INSIDE this same exclusive section: a
  // merge fast-forwards the ff-target branch, then (if it stuck) we build+test the
  // NEW tip and, on RED, reset that branch back to the captured pre-merge tip — all
  // before the next queued merge runs, so a revert can never interleave with another
  // merge moving the same branch.
  type Gate = {
    mr: git.MergeResult;
    verify?: { ok: boolean; output: string };
    reverted?: boolean;
    priorTip?: string | null;
  };
  const gate: Gate = await runExclusiveMerge<Gate>(async () => {
    // Capture the ff-target tip (story branch for an isolated member, else main) in the
    // ff-target worktree BEFORE the ff so we can restore it on RED.
    const priorTip = await git.headSha(mctx.ffWorktree).catch(() => null);
    // Pass the workspace's resolved version file so git.merge bumps it itself (inside
    // this merge lock, after the rebase) when the workspace opted in — EMPTY disables the
    // bump (the default). In release_mode, also pass the declared bump level + changelog
    // path so git.merge bumps by that level AND stamps the changelog with a versioned
    // heading in the SAME commit (promoteUnreleased); outside release_mode the task owns
    // its `[Unreleased]` entry and the CI gate enforces it. See git.bumpVersionFile. The
    // base / ff-target come from mctx so an isolated member rebases onto + ff's into the
    // story branch (its baseSha/mergedSha — and thus merge_base_sha/merged_sha — are
    // story-branch shas); for everyone else mctx = today's main flow.
    const mr = await git.merge(dir.path, id, {
      versionFile: workspaceVersionFile(dir.id),
      releaseMode,
      bumpLevel: row.version_bump,
      changelogPath: workspaceChangelogPath(dir.id),
      dateISO: nowIso().slice(0, 10),
      base: mctx.base,
      ffWorktree: mctx.ffWorktree,
      ffTargetBranch: mctx.targetBranch,
    });
    if (!mr.ok) return { mr };
    // Merge stuck (ff'd into the ff-target branch). Gate the new tip in the ff-target
    // worktree (the story worktree for an isolated member, else the repo root): the
    // workspace's build/test gate command must be GREEN (its own gate_cmd, or the default
    // config.verifyCmd).
    const verify = await verifyDefaultBranch(mctx.ffWorktree, workspaceGateCmd(dir.id));
    if (verify.ok) return { mr, verify };
    // RED — undo the ff so a broken commit never sits on the ff-target branch. Reset the
    // ff-target worktree (story worktree for an isolated member, else the repo root) to the
    // captured pre-merge tip. We need that tip; if we somehow failed to capture it, we can't
    // safely revert, so surface that loudly and let the merge stand (flagged) rather than guess.
    if (priorTip) {
      await git.resetHard(mctx.ffWorktree, priorTip).catch((e) => {
        console.error(
          `[butchr] CRITICAL: verify FAILED for ${id} but the auto-revert to ` +
            `${priorTip} ALSO failed: ${e}. The ${mctx.targetBranch} branch may hold a broken commit.`,
        );
      });
    } else {
      console.error(
        `[butchr] CRITICAL: verify FAILED for ${id} but the pre-merge tip was not ` +
          `captured, so the merge could not be auto-reverted. Inspect ${mctx.targetBranch}.`,
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
      const notes = await recordMergeConflictNote(dir, id, result.conflictFiles, result.message);
      // Same channel as reject: into the live agent if blocked, else re-queue
      // (requestChanges tears down any lingering tab in the fallback). requestChanges
      // persists review_note + emits via setStatus, so we DON'T write/emit it again here.
      await requestChanges(
        id,
        notes,
        row.herdr_pane_id,
        row.herdr_tab_id,
        "merge conflict — sent back to agent",
      );
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
        `${mctx.targetBranch} branch; ${mctx.targetBranch} restored to ${gate.priorTip ?? "(unknown)"}.\n${reason}`,
    );
    // Pure DRY collapse of the UPDATE→event→task.md mirror→emit tail into setStatus
    // (this transition already mirrored task.md, so it's not a desync fix). output_snapshot
    // is overwrite-if-supplied (COALESCE(?, col) → setIfPresent), distinct from
    // completed_at's stamp-once (COALESCE(col, ?) → keep). The idle=0 clear auto-wipes
    // idle_context inside setStatus, matching the explicit clear.
    if (
      !setStatus(id, "failed", {
        from: inflight,
        note: "merge auto-reverted off main (post-merge verify failed)",
        set: {
          conflict: 0,
          idle: 0,
          herdr_pane_id: null,
          herdr_tab_id: null,
          output_snapshot: setIfPresent(snapshot || null),
          revert_reason: reason,
          last_dispatch_error: reason,
          completed_at: keep(nowIso()),
        },
      })
    ) {
      // Raced (e.g. aborted) between the gate and here — leave whatever won.
      emitUpdated(id);
      return { task: taskView(id)! };
    }
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
        // In release_mode, the version butchr assigned + stamped at this merge (NULL
        // otherwise). Surfaced on the merged task so the UI can show the released version.
        released_version: result.version ?? null,
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
  // STORY COMPLETION (Phase 6): if this was a STORY member, the story may now be fully
  // delivered (every member merged/rolled_back) — fire the leader's completion-review
  // attention event. story_id-guarded so STANDALONE tasks never trigger it (no regression).
  if (row.story_id) notifyStoryCompletionIfReady(row.story_id);
  return { task: taskView(id)! };
}

/**
 * MAJOR DOUBLE-CONFIRM (release_mode + version_bump='major'). The ONLY thing that
 * advances the major-confirm streak: a HUMAN confirming a major version bump. It must be
 * called TWICE CONSECUTIVELY (major_confirm_count 0→1→2) with nothing else in between —
 * any other action (reject, conflict kick-back, re-review, setBlockedBy, requeue,
 * changing version_bump) resets the streak to 0. On the SECOND confirm (reaching 2),
 * finalizeMerge lands the task; below 2 it stays parked in `in_review`.
 *
 * Guards (409 / no-op otherwise): the task must be `in_review`, its workspace in
 * release_mode, and its declared bump 'major'. Approve does NOT route here — approve just
 * parks a major task; this is the deliberate, separate ritual. Always the human: nothing
 * auto-issues this (maybeAutoMerge bails on major, and the CTO diff-review responder only
 * parks a major). Returns the post-action outcome (the merge result once it lands).
 */
export async function confirmMajor(id: string): Promise<ApproveOutcome> {
  const row = getTask(id);
  if (!row) throw new HttpError(404, `task not found: ${id}`);
  const dir = getWorkspace(row.workspace_id);
  if (!dir) throw new HttpError(404, "workspace not found");
  if (row.status !== "in_review") {
    throw new HttpError(409, `confirm-major requires an in_review task (status=${row.status})`);
  }
  if (!workspaceReleaseMode(dir.id)) {
    throw new HttpError(409, "confirm-major requires the workspace to be in release_mode");
  }
  if (row.version_bump !== "major") {
    throw new HttpError(409, "confirm-major requires the task's version_bump to be 'major'");
  }

  // Advance the streak by one (guarded on the row still being in_review so a race can't
  // double-count). A no-op match means it moved under us — return the current view.
  const next = row.major_confirm_count + 1;
  const res = db
    .query(
      `UPDATE tasks SET major_confirm_count=? WHERE id=? AND status='in_review' AND major_confirm_count=?`,
    )
    .run(next, id, row.major_confirm_count);
  if (res.changes === 0) {
    emitUpdated(id);
    return { task: taskView(id)! };
  }
  recordTaskEvent(id, row.status, row.status, `major-version confirmation ${next}/2`);
  emitUpdated(id);
  console.log(`[butchr] task ${id} major-version confirmation ${next}/2`);

  // Two consecutive confirmations reached → land it (finalizeMerge re-checks the gate
  // and, now that the streak is 2, proceeds through the mechanical merge).
  if (next >= 2) return finalizeMerge(id);
  return { task: taskView(id)!, awaitingMajorConfirm: true };
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

/**
 * ESCALATE a task's CURRENT pending feedback item up to the next responder. Two models,
 * selected by the V2 gate; the gate-OFF path is unchanged.
 *
 * V2 (responderV2Enabled() — design §4a): the SINGLE cto→user boundary for a NON-STORY task.
 * Escalation is valid ONLY for a non-story task that is awaiting feedback — it sets
 * `escalated_to_user = 1` so pendingResponder resolves to `user`. GUARDS (each a 409):
 *  - the task must be awaiting feedback (isAwaitingFeedback) — nothing to escalate otherwise;
 *  - it must NOT be a STORY MEMBER (story_id != null) — subtask feedback is TERMINAL at the
 *    leader, there is nothing to escalate;
 *  - it must NOT already be `escalated_to_user` — re-escalating crosses no new boundary.
 *
 * V1 (gate OFF — UNCHANGED): bump a STORY-MEMBER task's feedback UP one rung of the fixed
 * escalation chain ['story','cto','user'] (Phase 2 of the STORIES epic). Bumps
 * `responder_tier` by one so pendingResponder resolves to the next rung, persists it, and
 * publishes `task.updated` so the next tier's notification fires.
 *  - the task must be in a feedback state (have a pending responder);
 *  - the task must be a STORY MEMBER (story_id != null) — only members have the chain;
 *  - it must NOT already be at the LAST rung ('user') — there is nowhere higher to bubble.
 * 404 if the task is gone.
 */
export function escalateTask(id: string): TaskView {
  const row = getTask(id);
  if (!row) throw new HttpError(404, `task not found: ${id}`);
  if (responderV2Enabled()) {
    if (!isAwaitingFeedback(row)) {
      throw new HttpError(409, `task is not awaiting feedback (status=${row.status})`);
    }
    if (row.story_id != null) {
      throw new HttpError(409, "task is a story member — its feedback is terminal at the leader, nothing to escalate");
    }
    if (row.escalated_to_user) {
      throw new HttpError(409, "task is already escalated to the user");
    }
    db.query(`UPDATE tasks SET escalated_to_user=1 WHERE id=?`).run(id);
    // Publish the fresh view so the user-tier notification fires (emitUpdated → task.updated).
    emitUpdated(id);
    return taskView(id)!;
  }
  if (!pendingResponderStep(row)) {
    throw new HttpError(409, `task is not awaiting feedback (status=${row.status})`);
  }
  if (row.story_id == null) {
    throw new HttpError(409, "task is not a story member — it has no escalation chain");
  }
  const lastRung = ESCALATION_CHAIN.length - 1;
  const cur = Math.min(row.responder_tier, lastRung);
  if (cur >= lastRung) {
    throw new HttpError(409, `task is already at the last escalation rung ('${ESCALATION_CHAIN[lastRung]}')`);
  }
  db.query(`UPDATE tasks SET responder_tier=? WHERE id=?`).run(cur + 1, id);
  // Publish the fresh view so the next tier's notification fires (emitUpdated → task.updated).
  emitUpdated(id);
  return taskView(id)!;
}

// --- STORY COMPLETION DETECTION (Phase 6 of the STORIES epic) ----------------

/**
 * Is a STORY COMPLETE — does it have >=1 subtask AND is every member task in a terminal
 * MERGED state (merged or rolled_back)? Pure direct db read of the tasks table (NOT
 * importing stories.ts — that would close the tasks↔stories import cycle, the same reason
 * createTask reads the stories table directly). A story with no members, or with ANY member
 * not yet merged/rolled_back (still in flight, or terminal-but-not-merged like
 * aborted/failed), is NOT complete.
 */
export function isStoryComplete(storyId: string): boolean {
  const members = db
    .query<{ status: TaskStatus }, [string]>(`SELECT status FROM tasks WHERE story_id=?`)
    .all(storyId);
  if (members.length === 0) return false;
  return members.every((m) => m.status === "merged" || m.status === "rolled_back");
}

/**
 * STORY COMPLETION DETECTION. When a story member lands in a terminal MERGED state, check
 * whether the WHOLE story is now complete (isStoryComplete) and, if so, publish a STORY-LEVEL
 * attention event targeted at the LEADER feed ('story <id> ready for completion review') so
 * the leader verifies the story's goal is met — then it PATCHes the story `done` (which tears
 * the leader down + reports completion UP to the CTO) or, if the goal is NOT met, creates more
 * subtasks. Fires for an `open` story OR a `merge_blocked` one (CONTRIBUTING §11.7, Phase E):
 * while a story sits in `merge_blocked` (a RED re-gate the leader is fixing), each fix-subtask
 * landing re-fires the completion-review so the leader re-verifies + re-requests the land. A
 * `merging`/`done`/`aborted` story does NOT re-notify (mid-merge, or no live leader). Returns
 * whether the completion event fired. The single completion-detection seam, called from
 * finalizeMerge's success path (story_id-guarded so STANDALONE tasks never reach here — no
 * merge-behavior regression for story-less tasks). Best-effort: events.publish swallows a
 * dead-subscriber throw, so this never breaks the merge that triggered it.
 */
export function notifyStoryCompletionIfReady(storyId: string): boolean {
  const story = db
    .query<{ workspace_id: string; brief: string | null; status: string }, [string]>(
      `SELECT workspace_id, brief, status FROM stories WHERE id=?`,
    )
    .get(storyId);
  if (!story || (story.status !== "open" && story.status !== "merge_blocked")) return false;
  if (!isStoryComplete(storyId)) return false;
  publish({
    type: "story.attention",
    story_id: storyId,
    workspace_id: story.workspace_id,
    target: "story",
    reason: "completion-review",
    detail: story.brief ?? null,
  });
  return true;
}

// --- STORY → MAIN MERGE MECHANICS (CONTRIBUTING §11.4/§11.5/§11.6 — Phase E) -------
// The git side of an ISOLATED story's completion: re-gate the assembled story branch, merge
// it into the default branch through the SAME global merge queue (runExclusiveMerge) that
// serializes subtask merges, run the post-merge verify on the default branch, and clean up.
// PURE MECHANICS — this writes NO story state and fires NO story events; stories.landStory
// owns the merging/merge_blocked/done transitions + the attention events + leader teardown
// (keeping story-state ownership in stories.ts and off the tasks↔stories import cycle). Gated
// upstream: stories.landStory only calls this for an isolated story (isolated=1), so it is
// inert for non-isolated stories + standalone tasks.

/** The outcome of mergeStoryBranch (the story→main attempt). Exactly one kind:
 *  - `landed`        — re-gate GREEN, story→main ff'd, post-merge verify GREEN, story branch
 *                      + worktree removed; `baseSha`/`mergedSha` bracket the story's range on main.
 *  - `gateRed`       — the story-level re-gate (on the story-branch tip) came back RED: a HARD
 *                      BLOCK, no merge ran, main untouched (§11.5 refinement #1). `output` = gate log.
 *  - `postVerifyRed` — re-gate was GREEN and the ff stuck, but the post-merge verify ON MAIN went
 *                      RED, so main was reset to its pre-merge tip (§11.5 backstop). `output` = log.
 *  - `conflict`      — the story↔main rebase conflicted; it was aborted, story branch + main
 *                      untouched (§11.4). `files`/`message` describe the conflict.
 *  - `mergeError`    — a non-conflict git failure in the merge; main untouched. `message` = error. */
export type StoryMergeOutcome =
  | { kind: "landed"; baseSha: string | null; mergedSha: string | null }
  | { kind: "gateRed"; output: string }
  | { kind: "postVerifyRed"; output: string }
  | { kind: "conflict"; files: string[]; message: string }
  | { kind: "mergeError"; message: string };

/**
 * Run an ISOLATED story's story→main merge attempt — the §11.4/§11.5 completion mechanics,
 * the whole sequence inside ONE runExclusiveMerge so a story→main merge can never interleave
 * with a subtask→story merge of the same story (or any other merge moving main). Steps:
 *   1. ensure the story branch + its worktree exist (idempotent; restart-safe);
 *   2. RE-GATE the story-branch tip in the story worktree — RED ⇒ HARD BLOCK (`gateRed`), no
 *      merge, main untouched;
 *   3. capture main's pre-merge tip, then rebase the story branch onto main + ff main at the
 *      repo root (git.mergeStoryToMain) — a conflict ⇒ `conflict` (rebase already aborted), a
 *      non-conflict failure ⇒ `mergeError` (both leave main + the story branch untouched);
 *   4. POST-MERGE VERIFY on main at the repo root — RED ⇒ resetHard main to the captured tip
 *      (`postVerifyRed`), so a broken commit never stays on main;
 *   5. GREEN ⇒ removeStoryBranch (delete the story branch + worktree) ⇒ `landed`.
 * NO release/version-bump opts are passed to the merge: each subtask already bumped the
 * version + stamped the changelog when it merged INTO the story branch (release_mode runs the
 * bump on every isolated subtask merge — see finalizeMerge/git.merge), so the story→main ff
 * carries those commits; a fresh story-level bump would double-stamp (CONTRIBUTING §11.6,
 * approved steer). Throws HttpError(404) if the story / its workspace is gone.
 */
export async function mergeStoryBranch(storyId: string): Promise<StoryMergeOutcome> {
  const story = db
    .query<{ workspace_id: string }, [string]>(`SELECT workspace_id FROM stories WHERE id=?`)
    .get(storyId);
  if (!story) throw new HttpError(404, `story not found: ${storyId}`);
  const dir = getWorkspace(story.workspace_id);
  if (!dir) throw new HttpError(404, "workspace not found");

  const storyBranch = git.storyBranchName(storyId);
  const gateCmd = workspaceGateCmd(dir.id);

  return runExclusiveMerge<StoryMergeOutcome>(async () => {
    // 1. Ensure the story branch + worktree (checked out at the story tip). Idempotent +
    //    restart-safe — a recovery merge after a crash still finds/rebuilds the checkout.
    const storyWt = await git.ensureStoryBranch(dir.path, storyBranch);

    // 2. RE-GATE the assembled story branch IN the story worktree (its tip). RED is a HARD
    //    BLOCK: the merge does not run and main is never touched (§11.5 refinement #1).
    const regate = await verifyDefaultBranch(storyWt, gateCmd);
    if (!regate.ok) {
      return { kind: "gateRed", output: regate.output?.trim() || "(no gate output captured)" };
    }

    // 3. Capture main's pre-merge tip (to reset on a post-verify RED), then rebase the story
    //    branch onto main + ff main at the repo root. A conflict / non-conflict failure both
    //    leave the story branch AND main untouched (git.merge aborts the rebase on conflict).
    const mainPriorTip = await git.headSha(dir.path).catch(() => null);
    const mr = await git.mergeStoryToMain(dir.path, storyId);
    if (!mr.ok) {
      if (mr.conflict) {
        return { kind: "conflict", files: mr.conflictFiles, message: mr.message };
      }
      return { kind: "mergeError", message: mr.message };
    }

    // 4. POST-MERGE VERIFY on main at the repo root (the final backstop). RED ⇒ reset main to
    //    its captured pre-merge tip so a broken commit never sits on main (§11.5).
    const postVerify = await verifyDefaultBranch(dir.path, gateCmd);
    if (!postVerify.ok) {
      if (mainPriorTip) {
        await git.resetHard(dir.path, mainPriorTip).catch((e) => {
          console.error(
            `[butchr] CRITICAL: story ${storyId} post-merge verify FAILED but the reset of ` +
              `main to ${mainPriorTip} ALSO failed: ${e}. The default branch may hold a broken story.`,
          );
        });
      } else {
        console.error(
          `[butchr] CRITICAL: story ${storyId} post-merge verify FAILED but main's pre-merge ` +
            `tip was not captured, so the story merge could not be reverted. Inspect the default branch.`,
        );
      }
      return { kind: "postVerifyRed", output: postVerify.output?.trim() || "(no verify output captured)" };
    }

    // 5. LANDED + green → the story branch is on main. Delete the story branch + worktree and
    //    return the story-level merge range (main tips before/after the ff — §11.6).
    await git.removeStoryBranch(dir.path, storyBranch);
    return { kind: "landed", baseSha: mr.baseSha ?? null, mergedSha: mr.mergedSha ?? null };
  });
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
  //
  // Routed through setStatus so this launch transition keeps the task.md mirror in
  // lockstep — the raw write it replaced skipped the mirror (a desync this fixes). The
  // event note distinguishes the first launch (no started_at — a fresh build) from a
  // resume (rework / answer / conflict-bounce); both are genuine transitions.
  if (
    !setStatus(id, "in_progress", {
      from: "inactive",
      note: row.started_at ? "agent resumed" : "agent launched",
      set: {
        herdr_pane_id: paneId,
        herdr_tab_id: tabId ?? null,
        session_id: keep(sessionId),
        started_at: keep(nowIso()),
        dispatch_attempts: 0,
        last_dispatch_error: null,
        next_dispatch_at: null,
        answer: null,
        grounding_fp: setIfPresent(groundingFp ?? null),
      },
    })
  ) {
    return; // aborted / already running / moved under us
  }
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
    // Measure the footprint vs the resolved base — the STORY branch for an isolated member
    // (so a member's own change isn't inflated by sibling work already on the story branch),
    // else the default branch (resolveBase → defaultBranch, so non-isolated is unchanged).
    stat = await git.diffStat(dir.path, id, await resolveBase(row));
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
 * Shared preamble for the three "the agent is EXITING — park its task" transitions
 * (markInReview's dead-agent rescue, markReviewFromAgent's request_review, and
 * markNeedsInfoFromAgent's raise). They all: bail on a missing/terminal task; capture
 * the run-log snapshot (the diagnostic the reviewer/answerer reads once the live pane is
 * gone); COMMIT-ON-REVIEW the worktree iff still genuinely `in_progress` (so the diff
 * survives the worktree being torn down); flip the status via setStatus from
 * `['in_progress', to]` (the genuine transition OR a status-unchanged duplicate call),
 * clearing the pane + idle; then capture session usage. When `opts.gates` is set AND the
 * task was genuinely `in_progress` (not a duplicate already-parked call), it ALSO fires
 * the footprint + CI + conformance trio — fire-and-forget, review never blocks on them.
 *
 * Per-caller differences are carried in `extraSet` (e.g. completed_at stamp-once vs
 * plain, the `summary`/`question` column, resume_attempts reset) and `opts`
 * (note, gates, a caller-supplied snapshot, a narrower `from`). Returns the same
 * "ok"/"terminal"/"notfound" the agent-tool callers surface; markInReview ignores it.
 */
function parkExitingAgent(
  id: string,
  to: TaskStatus,
  extraSet: Record<string, unknown>,
  opts: {
    note: string;
    gates?: boolean;
    snapshot?: string;
    from?: TaskStatus | TaskStatus[];
  },
): "ok" | "terminal" | "notfound" {
  const row = getTask(id);
  if (!row) return "notfound";
  if (isTerminal(row.status)) return "terminal";

  // Capture the agent's terminal output (unless the caller already has one): once the
  // agent exits there is no live pane, so this snapshot + the git diff is what review /
  // the answerer is conducted against.
  const snapshot = opts.snapshot ?? readRunLogSnapshot(id);

  // COMMIT-ON-REVIEW (FIRST): the agent is told it need not commit — butchr captures its
  // worktree. On the genuine in_progress transition, commit that diff onto the branch NOW
  // so it can't be lost as worktree-only state before merge. Best-effort, never blocks.
  if (row.status === "in_progress") autoCommitOnReview(id, row.workspace_id);

  // Flip status. setStatus records the audit event ONLY on a genuine change (a duplicate
  // already-parked call is status-unchanged, so no event) — matching the old per-call
  // guards. Clears the pane (the agent is exiting; the state holds no live process).
  if (
    !setStatus(id, to, {
      from: opts.from ?? ["in_progress", to],
      note: opts.note,
      set: {
        idle: 0,
        herdr_pane_id: null,
        output_snapshot: snapshot || null,
        ...extraSet,
      },
    })
  ) {
    // Not in a phase we can park (e.g. needs_info/blocked/aborted under us) — surface
    // the current status to the agent-tool caller.
    return terminalOrOk(id);
  }
  // Capture the session's token usage / model now that the agent has finished this turn
  // (re-read each call so a rework's added turns are reflected too).
  captureSessionUsage(id);
  // The gates + footprint run only on a genuine in_progress transition (not a duplicate
  // park). Fire-and-forget — review never blocks on them.
  if (opts.gates && row.status === "in_progress") {
    void captureDiffFootprint(id);
    void triggerCi(id);
    void triggerConformance(id);
  }
  return "ok";
}

/**
 * DEAD-AGENT FALLBACK: move an `in_progress` task to `in_review` because its agent
 * ended WITHOUT calling request_review (the watcher / startup reconcile rescue path;
 * the live path is markReviewFromAgent). Guarded on the build phase being live
 * (in_progress + a pane) so a task aborted while its agent was finishing isn't
 * resurrected. The caller is already tearing down the tab — we clear the ids.
 */
export function markInReview(id: string, snapshot: string): void {
  // Rescue from in_progress ONLY (narrower than the request_review path's array `from`),
  // using the caller-supplied snapshot. completed_at is stamped plain (not keep) and
  // output_snapshot written raw, preserving this path's exact columns. Unlike the two
  // agent-tool paths (which clear only herdr_pane_id), this rescue ALSO clears
  // herdr_tab_id — the caller is tearing the tab down — so it's carried in extraSet to
  // reproduce this path's original column set exactly. Return ignored.
  parkExitingAgent(
    id,
    "in_review",
    {
      completed_at: nowIso(),
      output_snapshot: snapshot,
      herdr_tab_id: null,
      // Reaching review IS progress — clear the auto-resume streak.
      resume_attempts: 0,
      // A fresh review cycle starts the major double-confirm streak at 0 (re-review reset).
      major_confirm_count: 0,
      // Entering the in_review feedback state → escalation back to rung 0 (story leader).
      // V2 (design §4a): also clear escalated_to_user so a re-opened review starts at the CTO.
      // No-op under V1 (the column is never set there).
      responder_tier: 0,
      escalated_to_user: 0,
    },
    { note: "agent finished — submitted for review", gates: true, snapshot, from: "in_progress" },
  );
}

/**
 * The actionable note the agent is re-launched with when it submits an EMPTY review
 * (see markReviewFromAgent's guard). Tells it exactly what was wrong (zero changes vs
 * `base`) and what to do — butchr captures the worktree, so it need not commit.
 */
function emptySubmissionNote(id: string, base: string): string {
  return [
    `Your \`request_review\` submission was EMPTY: branch \`${id}\` has zero commits`,
    `ahead of \`${base}\` AND a clean worktree, so there are no changes to review.`,
    `butchr did NOT enter review — an empty diff is never a real submission (and the`,
    `CI gate would build the empty tree green, hiding that nothing was done).`,
    ``,
    `This usually means the work was lost (e.g. a \`git reset\` wiped uncommitted`,
    `changes) or never started. Do the actual work now, then call \`request_review\``,
    `again. You do NOT need to commit — butchr captures your worktree changes`,
    `automatically; just make sure the work is actually present in the worktree.`,
  ].join("\n");
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
 * EMPTY-SUBMISSION GUARD (FIRST): an in_progress submission carrying NO work — zero
 * commits ahead of the default branch AND a clean worktree — is bounced back like a
 * changes-request (→ inactive, re-launched in the same session with an actionable note)
 * instead of entering review on a falsely-green empty diff. Only the genuine in_progress
 * transition is checked (a duplicate in_review call stays a no-op `ok`); it reuses the
 * existing git.hasChanges probe (commits-ahead OR a dirty worktree, untracked files
 * included), run BEFORE parkExitingAgent's auto-commit so real-but-uncommitted work still
 * counts as non-empty; and it FAILS OPEN (proceeds to review) when there is no task branch
 * to measure against, so a real submission is never false-bounced.
 *
 * Returns:
 *  - "ok"        → handled (transitioned, or a duplicate).
 *  - "empty"     → submission had no changes vs base; bounced back for rework.
 *  - "terminal"  → task is in a terminal state; nothing to do.
 *  - "notfound"  → no such task.
 */
export async function markReviewFromAgent(
  id: string,
  summary?: string,
): Promise<"ok" | "terminal" | "notfound" | "empty"> {
  // EMPTY-SUBMISSION GUARD — see the doc-comment above. Only on a genuine in_progress
  // submission; measured before the auto-commit; fails open whenever we cannot measure.
  const row = getTask(id);
  if (row && row.status === "in_progress") {
    const dir = getWorkspace(row.workspace_id);
    // Measurable ONLY with a real workspace AND an existing task branch to diff against.
    // No branch → nothing to compare → unmeasurable → FAIL OPEN (proceed to review) so a
    // real submission is never false-bounced (and a probe error mid-measure does the same).
    if (dir && (await git.branchExists(dir.path, id))) {
      // hasChanges is the existing probe: commits-ahead > 0 OR a dirty worktree
      // (`git status --porcelain`, which counts UNTRACKED new files too — so a real
      // submission the agent left as new uncommitted files is correctly non-empty).
      let empty = false;
      try {
        empty = !(await git.hasChanges(dir.path, id));
      } catch {
        empty = false; // unmeasurable mid-probe → fail open (treat as a real submission)
      }
      if (empty) {
        const base = await git.defaultBranch(dir.path);
        await requestChanges(
          id,
          emptySubmissionNote(id, base),
          row.herdr_pane_id,
          row.herdr_tab_id,
          "empty review submission bounced — no changes vs base",
        );
        return "empty";
      }
    }
  }

  // BUILD PHASE: in_progress → in_review (normal), or in_review → in_review (a duplicate
  // call — status-unchanged, so no event + no gates, matching the old guard). completed_at
  // is stamped once (keep). Runs the gates on the genuine transition.
  return parkExitingAgent(
    id,
    "in_review",
    {
      completed_at: keep(nowIso()),
      summary: summary ?? null,
      // Reaching review IS progress — clear the auto-resume streak.
      resume_attempts: 0,
      // A fresh review cycle starts the major double-confirm streak at 0 (re-review reset).
      major_confirm_count: 0,
      // Entering the in_review feedback state → escalation back to rung 0 (story leader).
      // V2 (design §4a): also clear escalated_to_user so a re-opened review starts at the CTO.
      // No-op under V1 (the column is never set there).
      responder_tier: 0,
      escalated_to_user: 0,
    },
    { note: "agent requested review", gates: true },
  );
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
  // in_progress → needs_info (normal), or needs_info → needs_info (a duplicate ask —
  // status-unchanged, so no event, matching the old `if (row.status !== "needs_info")`
  // guard). No gates: needs_info is a pause, not a review submission.
  return parkExitingAgent(
    id,
    "needs_info",
    // Entering the needs_info feedback state → escalation back to rung 0 (story leader).
    // Covers BOTH `raise` (answer-question) and `propose_plan` (plan-approval), which both
    // route through here. V2 (design §4a): also clear escalated_to_user; no-op under V1.
    { question, responder_tier: 0, escalated_to_user: 0 },
    { note: "agent asked a clarifying question" },
  );
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

/**
 * STRUCTURED PLAN APPROVE/REJECT — the plan-approval responder step's distinct surface,
 * separate from the freeform /answer used for in-implementation questions. Both resume the
 * SAME agent session (the needs_info → inactive resume, via resumeWithAnswer); they differ
 * only in the DECISION injected on resume:
 *   - approvePlan → "your plan is APPROVED — implement it" (+ optional steering notes).
 *   - rejectPlan  → "your plan is NOT approved — revise + re-submit via propose_plan" (with
 *                   the required change-request feedback).
 * Guarded on the task actually being at the plan-approval step (needs_info + plan_preview —
 * pendingResponderStep === "plan-approval"); a 409 otherwise so the structured endpoints
 * stay distinct from /answer (which accepts any needs_info). See the plan-preview protocol
 * in taskmd.ts / the propose_plan MCP tool. Returns the post-transition task view.
 */
function requirePlanApproval(id: string): { row: TaskRow; dirPath: string } {
  const row = getTask(id);
  if (!row) throw new HttpError(404, `task not found: ${id}`);
  if (pendingResponderStep(row) !== "plan-approval") {
    throw new HttpError(
      409,
      `task is not awaiting plan approval (status=${row.status}` +
        `${row.plan_preview ? "" : ", not a plan-preview task"}) — use /answer for an in-implementation question`,
    );
  }
  const dir = getWorkspace(row.workspace_id);
  if (!dir) throw new HttpError(404, "workspace not found");
  return { row, dirPath: dir.path };
}

export async function approvePlan(id: string, note?: string): Promise<TaskView> {
  const { row, dirPath } = requirePlanApproval(id);
  const steering = (note ?? "").trim();
  const decision = steering
    ? `Your implementation plan is APPROVED with the following steering notes:\n\n${steering}\n\n` +
      `Proceed to IMPLEMENT the plan now (incorporating these notes), then call request_review when done.`
    : `Your implementation plan is APPROVED. Proceed to IMPLEMENT it now, then call request_review when done.`;
  await resumeWithAnswer(id, dirPath, row, decision);
  return taskView(id)!;
}

export async function rejectPlan(id: string, note: string): Promise<TaskView> {
  const { row, dirPath } = requirePlanApproval(id);
  const feedback = (note ?? "").trim();
  if (!feedback) throw new HttpError(400, "a plan change-request note is required");
  const decision =
    `Your implementation plan was NOT approved — changes are requested BEFORE you implement. ` +
    `Revise the plan to address the following, then submit the REVISED plan again via the ` +
    `propose_plan tool (do NOT start implementing yet):\n\n${feedback}`;
  await resumeWithAnswer(id, dirPath, row, decision);
  return taskView(id)!;
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

// Liveness for the CI gate: which task ids have a CI gate RUNNING in THIS butchr process
// right now. The gate runs in-process (triggerCi awaits runGate), so a butchr restart
// kills it AND empties this set — which is exactly what makes a DB ci_status='running'
// with no entry here PROVABLY stale (its build/test subprocess died with the process).
// recoverStuckGates keys off this to re-trigger only genuinely-dead gates, never one still
// legitimately running. Marked synchronously before the 'running' write; cleared in a
// finally. The Set + its three operations are the shared makeGateLiveness primitive.
const ciLiveness = makeGateLiveness();

/** Is this task's CI gate running in THIS process right now? */
export function ciGateInFlight(id: string): boolean {
  return ciLiveness.isLive(id);
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
  ciLiveness.mark(id);
  try {
    db.query(`UPDATE tasks SET ci_status='running', ci_summary=NULL WHERE id=?`).run(id);
    emitUpdated(id);

    // Resolve the workspace's effective gate command ONCE for this CI run (own
    // gate_cmd or the default) and thread it through every (re)run.
    const gateCmd = workspaceGateCmd(dir.id);
    // The base the changelog/allowlist GATE diffs measure against (`base...taskId`): the
    // STORY branch for an isolated member, else the default branch (resolveBase →
    // defaultBranch, so non-isolated is unchanged). Resolved LAZILY + memoized only when a
    // gate that needs it runs — NEVER before runCiOnce, which must stay the FIRST await so an
    // injected (test) runner is invoked synchronously. The build/test command itself runs in
    // the subtask worktree and is base-AGNOSTIC, so runCiOnce is untouched.
    let gateBase: string | null = null;
    const baseForGate = async (): Promise<string> => (gateBase ??= await resolveBase(row));
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

    // CHANGELOG-UPDATE GATE: an additional, opt-in gate concern layered ON TOP of the
    // build/test command (NOT part of it). When the workspace configures a changelog
    // path, a code (non-docs) change whose diff didn't touch that file FAILS the gate —
    // enforcing that the task owns its changelog entry now that butchr stops writing
    // one. Only checked once the build/test gate is green (a build failure is the
    // priority signal); a fail here downgrades the badge to red, which also blocks
    // auto-merge below.
    if (result.status === "pass") {
      const changelogPath = workspaceChangelogPath(dir.id);
      if (changelogPath.trim()) {
        const { files } = await git.diffStat(dir.path, id, await baseForGate());
        // In release_mode the gate is STRICT: every non-empty diff (incl. docs-only)
        // must carry a changelog entry, since every change bumps + stamps a versioned
        // heading. Outside release_mode the docs-only exemption stands.
        const check = checkChangelogUpdated(files, changelogPath, {
          strict: workspaceReleaseMode(dir.id),
        });
        if (!check.ok) {
          result = { status: "fail", label: "changelog not updated", detail: check.reason };
        }
      }
    }

    // PER-TASK ALLOWLIST GATE: another opt-in gate concern layered ON TOP of the
    // build/test command. When the task declares a file `allowlist`, every changed file
    // must fall under it (the same fileAllowed membership rule the auto-merge allowlist
    // uses); any STRAY file FAILS the gate — catching scope creep mechanically instead of
    // by hand-diffing. Only checked once the prior gates are still green (a build/changelog
    // failure is the priority signal); a fail here downgrades the badge to red, which also
    // blocks auto-merge below. An empty allowlist is inert (every file allowed).
    if (result.status === "pass") {
      const allowlist = parseAllowlist(row.allowlist);
      if (allowlist.length) {
        const { files } = await git.diffStat(dir.path, id, await baseForGate());
        const stray = files.filter((f) => !fileAllowed(f, allowlist));
        if (stray.length) {
          result = {
            status: "fail",
            label: `${stray.length} file(s) outside allowlist`,
            detail:
              `changed files outside this task's allowlist [${allowlist.join(", ")}]:\n` +
              stray.join("\n"),
          };
        }
      }
    }

    // First line is the badge label; the rest (if any) is the output tail.
    const summary = result.detail ? `${result.label}\n\n${result.detail}` : result.label;
    // BIND the result to the tip it ran against: stamp the worktree HEAD so a stored green
    // can never be trusted for a DIFFERENT tip (maybeAutoMerge re-checks ci_tip; a tip move
    // invalidates it — see invalidateStaleGates). null tip → treated as un-bound (re-runs).
    const ci_tip = await git.headSha(git.worktreePath(dir.path, id)).catch(() => null);
    // Settle via the shared gate write: persist ci_status/ci_summary/ci_tip + reset
    // gate_recovery_attempts, guarded on the task still being in_review — if it
    // merged/aborted while CI ran, don't resurrect stale CI state onto it.
    if (!settleGate(id, { ci_status: result.status, ci_summary: summary, ci_tip })) return;
    emitUpdated(id);

    // AUTO-MERGE HOOK: CI just settled to 'pass' on a still-in-review task. If
    // auto-merge is enabled and the task is low-risk, run the same approve+merge a
    // human would (post-merge verify still gates main). Fire-and-forget so CI never
    // blocks on the merge; the dispatcher tick re-checks as a backstop.
    if (result.status === "pass") void maybeAutoMerge(id);
  } finally {
    ciLiveness.clear(id);
  }
}

/**
 * STALE-GREEN INVALIDATION. A stored gate result (ci/conformance) is only meaningful for
 * the EXACT branch tip it ran against (ci_tip / conformance_tip). When the task branch tip
 * moves — e.g. a pre-dispatch rebase replays the work onto a new base — any settled gate
 * whose stored tip no longer matches the live worktree HEAD is now STALE and is cleared
 * (status + summary + tip → NULL) so it can never be trusted as green for a different tip;
 * it re-runs fresh on the next review entry. A gate still 'running'/'checking', or one
 * already bound to the current tip, is left untouched. Best-effort: a missing worktree /
 * git error is a no-op (nothing safely comparable). Returns true iff it cleared anything.
 */
export async function invalidateStaleGates(id: string): Promise<boolean> {
  const row = getTask(id);
  if (!row) return false;
  const dir = getWorkspace(row.workspace_id);
  if (!dir) return false;
  const wt = git.worktreePath(dir.path, id);
  if (!existsSync(wt)) return false;
  const head = await git.headSha(wt).catch(() => null);
  if (!head) return false; // can't compare → leave gates as-is

  const sets: string[] = [];
  // Only SETTLED results (pass/fail/concern) carry a tip; 'running'/'checking' have none.
  if ((row.ci_status === "pass" || row.ci_status === "fail") && row.ci_tip && row.ci_tip !== head) {
    sets.push("ci_status=NULL", "ci_summary=NULL", "ci_tip=NULL");
  }
  if (
    (row.conformance_status === "pass" || row.conformance_status === "concern") &&
    row.conformance_tip && row.conformance_tip !== head
  ) {
    sets.push("conformance_status=NULL", "conformance_summary=NULL", "conformance_tip=NULL");
  }
  if (sets.length === 0) return false;
  db.query(`UPDATE tasks SET ${sets.join(", ")} WHERE id=?`).run(id);
  console.log(
    `[butchr] invalidated stale gate result(s) for task ${id} (branch tip moved to ${head.slice(0, 8)})`,
  );
  emitUpdated(id);
  return true;
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
 *
 * Exported so the read-only readiness view (taskReadiness) can report which changed
 * files fall OUTSIDE the auto-merge allowlist, reusing the exact membership rule the
 * auto-merge gate applies.
 */
export function fileAllowed(file: string, allowlist: string[]): boolean {
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

  // STALE-GREEN GUARD: trust ci_status='pass' ONLY when it was gated on the CURRENT branch
  // tip. If the tip moved since CI settled (ci_tip ≠ live HEAD), the green is bound to a
  // DIFFERENT tip — never auto-merge on it. Re-run CI (its settle re-evaluates auto-merge)
  // and bail this pass. A missing worktree / git error is treated as "can't confirm" → bail.
  const head = await git.headSha(git.worktreePath(dir.path, id)).catch(() => null);
  if (!head || row.ci_tip !== head) {
    console.log(
      `[butchr] auto-merge: CI green for ${id} is stale (gated tip ${row.ci_tip ?? "?"} ≠ ` +
        `current ${head ? head.slice(0, 8) : "?"}); re-running CI before any merge`,
    );
    void triggerCi(id);
    return false;
  }

  // The MAJOR version gate is ALWAYS the human: a release_mode major-bump task needs two
  // consecutive `confirm-major` calls (see confirmMajor) and must NEVER be auto-confirmed.
  // Bail before doing any merge work. (patch/minor in release_mode still auto-merge — the
  // version is assigned/stamped inside finalizeMerge.)
  if (row.version_bump === "major" && workspaceReleaseMode(dir.id)) return false;

  // Footprint check (a + b). Measured vs the resolved base — the STORY branch for an
  // isolated member (so sibling work already on the story branch can't over-count a
  // genuinely small member change and wrongly block its auto-merge), else the default
  // branch (resolveBase → defaultBranch, so non-isolated is unchanged). On any git error,
  // bail safely (leave for a human).
  let stat: git.DiffStat;
  try {
    stat = await git.diffStat(dir.path, id, await resolveBase(row));
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
 * Flag/unflag a running build task as `idle` (agent alive but no recent CLI output),
 * capturing/clearing the `idle_context` snapshot in lockstep. Owned by the dispatcher
 * watcher. Guarded on a LIVE build agent (status='in_progress' with a pane) so a lagging
 * watcher can't stamp the flag onto a task that has already moved on, and on a value
 * CHANGE so we only emit when it actually flips (no per-second event spam).
 *
 * On the 0→1 flip we record `idle_context` — the run-log tail the responder uses to act
 * gracefully — from the optional `captureContext` thunk. The thunk is invoked ONLY on a
 * genuine flip (we peek the current value first), so the watcher's per-second poll never
 * re-reads the log while a stall persists. Clearing idle (→0) wipes the context to NULL.
 */
export function setIdle(id: string, idle: boolean, captureContext?: () => string): void {
  const want = idle ? 1 : 0;
  // Peek first: only a genuine flip of a LIVE build agent does anything — and only then
  // do we run the (log-reading) capture thunk.
  const cur = db
    .query<{ idle: number; status: string; herdr_pane_id: string | null }, [string]>(
      `SELECT idle, status, herdr_pane_id FROM tasks WHERE id=?`,
    )
    .get(id);
  if (!cur || cur.status !== "in_progress" || cur.herdr_pane_id == null || cur.idle === want) {
    return;
  }
  // Going idle → snapshot the run-log tail as context (empty → NULL); clearing → NULL.
  const context = want === 1 ? captureContext?.() || null : null;
  // The 0→1 flip ENTERS the idle feedback surface (idle-handling) — a new feedback event —
  // so reset the escalation back to rung 0 (story leader). Clearing idle does not touch it.
  // V2 (design §4a): the same fresh-feedback entry clears escalated_to_user; no-op under V1.
  const tierReset = want === 1 ? ", responder_tier=0, escalated_to_user=0" : "";
  const res = db.query(
    `UPDATE tasks SET idle=?, idle_context=?${tierReset} WHERE id=? AND status='in_progress' AND herdr_pane_id IS NOT NULL AND idle<>?`,
  ).run(want, context, id, want);
  if (res.changes === 0) return;
  emitUpdated(id);
}

/**
 * NUDGE a live build agent — the graceful idle-handling ACTION, the responder's
 * deliberate replacement for the old blind auto-"continue". Sends `text` (or a bare
 * "continue") to the agent's pane exactly as a human would, so the idle-handling
 * responder (the CTO agent or a webapp user) can STEER the agent with guidance instead of
 * a context-free poke. Shared by the webapp idle panel, the CTO self-check, and POST
 * /api/tasks/:id/nudge.
 *
 * GUARDS:
 *  - 404 if the task is gone; 409 if it has no live build agent (not in_progress, or no
 *    pane) — there is nothing to nudge.
 *  - LIVENESS (the incident fix): if the agent's claude is NOT actually alive (a dead
 *    login shell after a herdr/host restart, with the agent name still registered), do
 *    NOT poke it — route to requeueForResume (tear down the husk + re-dispatch the same
 *    session via `--resume`) and return that task view. A dead pane is always RECOVERED,
 *    never poked — the same guard the dispatcher's handleIdleAgent applies.
 * On the live path: self-heal the stored pane id (currentPaneRepairing) so the send lands
 * on the agent's CURRENT pane (herdr may have renumbered it), send text+Enter, and record
 * an audit event.
 */
export async function nudgeTask(id: string, text?: string): Promise<TaskView> {
  const row = getTask(id);
  if (!row) throw new HttpError(404, `task not found: ${id}`);
  if (row.status !== "in_progress" || !row.herdr_pane_id) {
    throw new HttpError(409, `task has no live agent to nudge (status=${row.status})`);
  }
  const line = (text ?? "").trim() || "continue";
  // LIVENESS GUARD: never poke a dead shell — auto-resume instead.
  if (!claudeAlive(row.session_id)) {
    await requeueForResume(
      id,
      "nudge requested but the agent process is not alive (dead shell, herdr/host restart suspected); auto-resuming instead of poking",
    );
    return taskView(id)!;
  }
  // Alive — self-heal the pane id so the send targets the agent's current pane, then send
  // the steering line + Enter exactly as a human would (via the swappable harness seam).
  await currentPaneRepairing(id);
  await harness.send(id, { text: line, enter: true });
  const note =
    line === "continue"
      ? `[butchr] idle agent nudged: sent 'continue'`
      : `[butchr] idle agent nudged with guidance: ${line}`;
  // Within-state audit marker (in_progress→in_progress), like the old auto-nudge entry.
  recordTaskEvent(id, "in_progress", "in_progress", note);
  console.log(`[butchr] task ${id} ${note}`);
  emitUpdated(id);
  return taskView(id)!;
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
  // Routed through setStatus so the re-queue keeps the task.md mirror in lockstep — the
  // raw write it replaced skipped it. No `from` guard (unconditional, as before); the
  // → inactive event fires only on a genuine change (setStatus skips it when already
  // inactive), matching the old `if (row.status !== "inactive")` guard. setStatus also
  // wipes idle_context when it clears `idle`, matching the explicit clear here.
  setStatus(id, "inactive", {
    note: "re-queued",
    set: {
      herdr_pane_id: null,
      herdr_tab_id: null,
      idle: 0,
      dispatch_attempts: 0,
      last_dispatch_error: null,
      next_dispatch_at: null,
    },
  });
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
  // markRunning can't leave an orphaned `in_progress`+null-pane row. Routed through
  // setStatus so this re-arm keeps the task.md mirror in lockstep — the raw write it
  // replaced skipped BOTH the mirror AND the audit event; via setStatus the genuine
  // transition (e.g. in_progress→inactive after a post-launch failure) now records the
  // retry in the event log too (intentional — visible retry history).
  const nextAt = new Date(Date.now() + dispatchBackoffMs(attempts)).toISOString();
  setStatus(id, "inactive", {
    note: `dispatch attempt ${attempts}/${config.maxDispatchAttempts} failed; retrying`,
    set: {
      dispatch_attempts: attempts,
      last_dispatch_error: err,
      next_dispatch_at: nextAt,
      herdr_pane_id: null,
      herdr_tab_id: null,
    },
  });
  console.warn(
    `[butchr] dispatch attempt ${attempts}/${config.maxDispatchAttempts} failed ` +
      `for ${id}; retrying after ${nextAt}: ${err}`,
  );
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
      // Re-queuing an IDLE agent is a valid idle-handling action — clear the idle flag
      // (and, via setStatus, the captured idle_context) so nothing stale lingers.
      idle: 0,
      // Operator re-queue is a fresh start — clear the auto-resume streak too.
      resume_attempts: 0,
      // A re-queue breaks the major double-confirm streak (must be consecutive).
      major_confirm_count: 0,
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
        // Shared settle write with the "still stuck on the same value" guard.
        const changed = settleGate(
          id,
          {
            ci_status: "fail",
            ci_summary:
              `gate did not complete after a butchr restart — ${reason}; ` +
              `settled 'fail' so the task isn't stuck. Re-queue or re-run the gate to retry.`,
          },
          { require: { ci_status: "running" } },
        );
        if (changed) {
          settled++;
          emitUpdated(id);
          console.warn(
            `[butchr] task ${id} CI gate force-settled 'fail' (stuck 'running' after restart; ${reason})`,
          );
        }
      }
      if (confStale) {
        const changed = settleGate(
          id,
          { conformance_status: null, conformance_summary: null },
          { require: { conformance_status: "checking" } },
        );
        if (changed) {
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
