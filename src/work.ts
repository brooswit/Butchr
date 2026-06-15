// WORK + WORKSPACE UNIFICATION — step 2: UNIFIED WORK MODEL + RECURSIVE FEEDBACK
// (story st-540ba705). See docs/rfc-work-workspace-unification.md §2.1.
//
// This module is the self-referential WORK abstraction over the `tasks` table's
// `parent_id` self-FK (added additively in step 1), plus the RECURSIVE parent-chain
// feedback responder that GENERALIZES today's two hardcoded routing rules into the one
// recursive rule they are each a single-level instance of:
//   - tasks.pendingResponder (subtask→leader TERMINAL / non-story→cto→user), and
//   - the stories.ts story-ask seam + channel.ts routeOwns (story→cto→user).
//
// FULLY ADDITIVE + INERT (gated OFF). NOTHING in the live dispatch / review / lifecycle /
// channel / server path imports this module, and no live code branches on the OFF flag —
// so the running system, and `/api/tasks` + `/api/stories`, behave BYTE-IDENTICALLY. The
// existing 2-level story|cto|user routing stays fully live and AUTHORITATIVE; the recursive
// path here is exercised ONLY by tests (and, at a later separately-authorized cutover, by
// flipping the flag). It adds NO API route and NO field to the serialized TaskView.
//
// Import discipline: this module imports ONLY db.ts (direct queries) and the PURE predicate
// `isAwaitingFeedback` from tasks.ts. tasks.ts NEVER imports work.ts, so the dependency is
// strictly one-way (no cycle).
import { config } from "./config.ts";
import { db } from "./db.ts";
import type { TaskRow } from "./db.ts";
import { getTask, isAwaitingFeedback } from "./tasks.ts";

/**
 * Is the unified-work routing ACTIVE? Reads the OFF gate flag (config.unifiedWork,
 * BUTCHR_UNIFIED_WORK — DEFAULT OFF). It exists so a later, separately-authorized cutover
 * can flip the recursive Work routing on; THIS step ships it OFF and NOTHING in the live
 * path branches on it (the module is simply not wired into dispatch/review/channel), so the
 * running system is byte-for-byte unchanged. The recursive resolvers below are PURE of the
 * flag — they compute the same chain regardless — so a test can exercise the routing logic
 * directly while the live system stays inert.
 */
export function unifiedWorkEnabled(): boolean {
  return config.unifiedWork;
}

// --- WORK STRUCTURE (leaf vs node over parent_id) ----------------------------
//
// A unit of WORK is a `tasks` row. The leaf-vs-node distinction is STRUCTURAL, not a type
// column: a LEAF has no children (today's task — a worktree/branch/build agent), a NODE has
// at least one child (today's story — a leader that decomposes). A leaf can grow children
// and a node can be emptied with no schema change. A Work row IS a TaskRow, so getWork is
// just getTask re-exported under the Work vocabulary.

export { getTask as getWork };

/** A Work's direct children (the rows whose `parent_id` points at it), newest-first to
 *  mirror listTasks' ordering. Empty array when the Work is a leaf / has no children. */
export function workChildren(id: string): TaskRow[] {
  return db
    .query<TaskRow, [string]>(
      `SELECT * FROM tasks WHERE parent_id=? ORDER BY created_at DESC`,
    )
    .all(id);
}

/** The number of direct children of a Work — the single cheap count both isWorkNode and
 *  isWorkLeaf derive from (avoids materializing the rows just to test emptiness). */
export function workChildCount(id: string): number {
  return db
    .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM tasks WHERE parent_id=?`)
    .get(id)!.n;
}

/** Is this Work a NODE — does it have at least one child (today's "story")? */
export function isWorkNode(id: string): boolean {
  return workChildCount(id) > 0;
}

/** Is this Work a LEAF — does it have no children (today's "task")? A missing row is treated
 *  as a leaf (it has no children) — callers that need existence check getWork separately. */
export function isWorkLeaf(id: string): boolean {
  return workChildCount(id) === 0;
}

/** The id of a Work's PARENT (the node it bubbles feedback up to), or null for a top-level
 *  Work (parent_id NULL — whose parent-responder is the CTO). null when the row is gone. */
export function workParentId(id: string): string | null {
  return getTask(id)?.parent_id ?? null;
}

/**
 * Re-export of the PURE feedback predicate (tasks.isAwaitingFeedback) under the Work
 * vocabulary, so "what counts as feedback awaiting a responder" stays single-sourced (a
 * feedback status — idea/spec_review/in_review/needs_info — or a LIVE idle build agent).
 */
export { isAwaitingFeedback as isWorkAwaitingFeedback };

// --- RECURSIVE PARENT-CHAIN RESPONDER ----------------------------------------
//
// Feedback (a question, a spec to approve, a diff to review, an idle agent) bubbles to the
// PARENT, recursively: a Work's feedback routes to the workspace executing its PARENT Work;
// it is TERMINAL there unless that parent raises it to ITS parent — leaf → node → … →
// top-level Work → CTO → user. The recursion bottoms out at top-level Work (parent_id NULL),
// whose parent-responder is the CTO; the CTO's single escalation boundary above it is the
// user. EXCEPTION — needs_user_input: a feedback state only a human can answer routes
// STRAIGHT to the user, short-circuiting the whole bubble-up (the generalized form of
// today's escalated_to_user).

/**
 * A resolved Work responder (the recursive generalization of PendingResponder):
 *  - `{ kind: "work", work_id }` — the PARENT Work; the workspace EXECUTING it responds (the
 *    recursive form of today's 'story'/leader). work_id is the responding NODE's id.
 *  - `{ kind: "cto" }` — the base case: a top-level Work's parent-responder.
 *  - `{ kind: "user" }` — the CTO's single escalation boundary, and the needs_user_input
 *    short-circuit target.
 */
export type WorkResponder =
  | { kind: "work"; work_id: string }
  | { kind: "cto" }
  | { kind: "user" };

/** Options shared by the responder resolvers. */
export type WorkResponderOpts = {
  /** When true, the feedback is `needs_user_input` — only a human can answer — so routing
   *  short-circuits STRAIGHT to the user, bypassing the parent-chain bubble-up entirely.
   *  The generalized form of today's escalated_to_user. Default false. */
  needsUserInput?: boolean;
};

/**
 * The IMMEDIATE responder for a Work's pending feedback — one tier of the bubble-up:
 *  - needsUserInput → `{ user }` (short-circuit, no parent walk).
 *  - parent_id != null → `{ work, work_id: parent_id }` (the parent NODE — terminal there
 *    unless the parent itself raises it on up, which is what workResponderChain unrolls).
 *  - top-level Work (parent_id NULL) → `{ cto }` (the base case).
 * Pure read of the row. A missing row is treated as top-level (→ cto), mirroring how a gone
 * parent bottoms out the chain. This is the recursive generalization of tasks.pendingResponder
 * (where the old 'story' tier is now ANY parent node, and 'cto'/'user' stay the terminals).
 */
export function resolveWorkResponder(
  id: string,
  opts: WorkResponderOpts = {},
): WorkResponder {
  if (opts.needsUserInput) return { kind: "user" };
  const parentId = workParentId(id);
  if (parentId != null) return { kind: "work", work_id: parentId };
  return { kind: "cto" };
}

/**
 * The FULL ordered bubble-up CHAIN for a Work's feedback, from the immediate parent up to the
 * user — the recursive walk leaf → node → … → top-level → CTO → user. Each ancestor NODE is a
 * `{ work }` tier (the workspace executing it responds); the chain then always ends `{ cto }`
 * then `{ user }`. EXCEPTION: needsUserInput short-circuits the whole walk to `[{ user }]`.
 *
 * Arbitrary nesting depth (RFC Q8): the chain length grows with the parent_id depth, no cap.
 * A visited-set guards against a malformed parent CYCLE / self-parent (data that should never
 * exist, but must never hang the walk): once a row is revisited the ancestor walk stops and
 * the chain bottoms out at cto→user, so the function always terminates.
 *
 * NOTE: this returns the static escalation PATH (who COULD own it as it bubbles), not a live
 * "who owns it right now" cursor — advancing along the chain is the explicit raise action a
 * responder takes (today's escalateTask / escalateStoryAsk), which a later wiring step maps
 * onto this chain. The immediate (current) responder is element [0].
 */
export function workResponderChain(
  id: string,
  opts: WorkResponderOpts = {},
): WorkResponder[] {
  if (opts.needsUserInput) return [{ kind: "user" }];
  const chain: WorkResponder[] = [];
  const visited = new Set<string>([id]);
  let parentId = workParentId(id);
  while (parentId != null) {
    chain.push({ kind: "work", work_id: parentId });
    if (visited.has(parentId)) break; // malformed parent cycle — stop the ancestor walk
    visited.add(parentId);
    parentId = workParentId(parentId);
  }
  chain.push({ kind: "cto" });
  chain.push({ kind: "user" });
  return chain;
}
