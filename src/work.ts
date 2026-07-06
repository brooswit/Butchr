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
// WIRED LIVE as of step 6a (config.unifiedWork, DEFAULT ON): tasks.pendingResponder now
// delegates the live feedback routing to resolveWorkResponder below (the recursive
// parent-chain generalizes the old 2-level story|cto|user rule to arbitrary depth). The
// depth-1/2 instances resolve identically to before (a story member's parent_id == its
// story_id, backfilled by the step-6a boot migration), so the serialized `pending_responder`
// field, channel.ts/routeOwns, and `/api/stories` are unchanged. It still adds NO API route
// and NO new field to the serialized TaskView. BUTCHR_UNIFIED_WORK=0 falls back to the legacy
// 2-level routing in tasks.pendingResponder.
//
// Import discipline: this module imports ONLY db.ts (direct queries), `config`, and the PURE
// seams `getTask`/`isAwaitingFeedback` from tasks.ts. tasks.ts now imports back the two
// resolvers (resolveWorkResponder / unifiedWorkEnabled) — a RUNTIME-ONLY cycle: every
// cross-module reference is a hoisted `function` declaration called at runtime, never at
// module-load, so there is no load-time TDZ (confirmed by the full test suite).
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

/** The number of direct children of a Work — the cheap CHILD-RELATIONSHIP count (avoids
 *  materializing the rows just to test emptiness). NOTE (B.2): node-vs-leaf is NO LONGER derived
 *  from this — isWorkNode/isWorkLeaf key on the persisted `work_kind` discriminator. This stays
 *  as the structural child-count utility (e.g. workChildren's cheap sibling). */
export function workChildCount(id: string): number {
  return db
    .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM tasks WHERE parent_id=?`)
    .get(id)!.n;
}

/** Is this Work a NODE (today's "story")? As of REVAMP Phase B.2 this is the SINGLE authoritative
 *  node-definition: it keys on the persisted `work_kind` discriminator (db.ts), unified with
 *  resolveWork (work-api.ts) so one column decides node-vs-leaf everywhere — no longer the
 *  structural child-count test (for a materialized story, work_kind='node' AND children AND a
 *  stories row all agree).
 *
 *  LATENT TRAP (B.3 closes it): the tasks NODE row is materialized LAZILY — createStory inserts
 *  ONLY the stories row, and ensureStoryWorkNode stamps work_kind='node' later (at the first
 *  member / leader). So a freshly-created CHILDLESS story has a stories row but NO tasks node row
 *  yet → getTask is undefined → this returns false (reports it a LEAF), even though resolveWork
 *  (which retains a getStory fallback for exactly this case) correctly calls it a NODE. INERT
 *  today — isWorkNode/isWorkLeaf have NO production callers (only tests); B.3 will eagerly
 *  materialize the node at createStory so work_kind becomes universally authoritative here too. */
export function isWorkNode(id: string): boolean {
  return getTask(id)?.work_kind === "node";
}

/** Is this Work a LEAF (today's "task")? A missing row is treated as a leaf (callers needing an
 *  existence check use getWork separately). See the lazy-materialization trap noted on isWorkNode.
 *
 *  REVAMP-4 S0a: this is NO LONGER the plain `!== "node"` complement of isWorkNode — the CONTAINER
 *  node kinds ('repo'/'project') are neither a leaf NOR a story node, so both predicates return
 *  false for them and a container is invisible to leaf/node logic alike. Existing behavior is
 *  preserved exactly: a 'leaf' row and a missing row are still leaves; a 'node' row is still not. */
export function isWorkLeaf(id: string): boolean {
  const k = getTask(id)?.work_kind;
  return k === undefined || k === "leaf";
}

/** The id of a Work's PARENT (the node it bubbles feedback up to), or null for a top-level
 *  Work (parent_id NULL — whose parent-responder is the CTO). null when the row is gone. */
export function workParentId(id: string): string | null {
  return getTask(id)?.parent_id ?? null;
}

/**
 * The id of the REPO node that OWNS this Work — the NEAREST node (self or ancestor, walking
 * `parent_id` upward) whose `work_kind==='repo'`; null if the chain reaches a top-level Work
 * without one. "Nearest" is deliberate: in a leaf→repo→project chain this returns the REPO (the
 * immediate owning repo), NOT the project above it; a project node itself (sitting ABOVE repos)
 * returns null. Reads only getTask rows — the SAME lookup at each level yields BOTH the work_kind
 * check and the parent hop, one row read per level. A visited-set guards a malformed parent CYCLE
 * / self-parent (mirrors workResponderChain's guard) so the walk always terminates.
 *
 * ADDITIVE (REVAMP-4 Phase 0 / S0b): no caller is rewired to this yet — the call sites arrive in
 * Phase 1/2 when leaf/story parent_id is repointed under the repo nodes materialized in S0a. Today
 * repo nodes have parent_id NULL, so a repo returns itself and a story-node/leaf chain returns null;
 * the accessor is already correct for both the current and the future (reparented) tree.
 */
export function owningRepoOf(id: string): string | null {
  const visited = new Set<string>();
  let cur: string | null = id;
  while (cur != null && !visited.has(cur)) {
    visited.add(cur);
    const row = getTask(cur);
    if (row?.work_kind === "repo") return cur;
    cur = row?.parent_id ?? null;
  }
  return null;
}

/**
 * The id of the PROJECT node that is this Work's IMMEDIATE parent — `parent_id` iff that parent is
 * a `work_kind==='project'` container, else null. Deliberately IMMEDIATE (not nearest-ancestor like
 * owningRepoOf): a `project` parent is exactly the shape whose feedback resolves to the `ceo`
 * responder (the head of containerLadderChain when the first parent hop lands on a project), so this
 * is the project analog of the story-NODE parent that `story_id` encodes on a TaskView. Reads one
 * getTask row. null when the row / its parent is gone.
 *
 * ADDITIVE (REVAMP-4 P3b, story st-1a82a2e1): the serialized `project_id` wire field on TaskView is
 * derived from this so the CEO channel bridge can route a ceo item to its owning project — the
 * project mirror of `story_id`. DORMANT: no project nodes materialize in prod, so this returns null
 * for every current shape (reachable only via a test-synthesized project node).
 */
export function projectParentOf(id: string): string | null {
  const parentId = workParentId(id);
  if (parentId == null) return null;
  return getTask(parentId)?.work_kind === "project" ? parentId : null;
}

/**
 * Is this Work TOP-LEVEL — i.e. does its feedback bottom out at the CTO rather than a parent
 * NODE? (REVAMP-4 Phase 1 / S1, story st-1a82a2e1.) THE ONE INVARIANT after the repoint: a
 * top-level Work is one whose parent_id is NULL **or** points at a `work_kind='repo'` node (a
 * repo node is the CTO's own container — its supervisor IS the CTO). This is the SINGLE predicate
 * threaded through every "is this a standalone task vs a story member" site (the resolver, the
 * pendingResponder map, escalateTask, the strand/attention re-projection, the story-readiness
 * guards) so no caller open-codes `parent_id == null` and silently misclassifies a repo-parented
 * task as a story member. A missing row is treated as top-level (parent chain bottoms out → cto),
 * mirroring resolveWorkResponder.
 */
export function isTopLevelWork(id: string): boolean {
  const parentId = workParentId(id);
  if (parentId == null) return true;
  return getTask(parentId)?.work_kind === "repo";
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
// PARENT, recursively: a Work's feedback routes to the SUPERVISOR of its nearest ancestor
// CONTAINER, walking up — leaf → story-node (leader) → … → repo (CTO) → project (CEO) → user.
// The walk derives EVERY tier — including the terminals — from the actual container ancestors
// (the "container ladder"), so there is no hardcoded cto→user base: a repo's supervisor is the
// CTO, a project's is the CEO, and above the last/root container (parent_id NULL) is the user.
// EXCEPTION — needs_user_input: a feedback state only a human can answer routes STRAIGHT to the
// user, short-circuiting the whole bubble-up (the generalized form of today's escalated_to_user).
//
// REVAMP-4 P3a (story st-1a82a2e1): widened to the CEO rung. BYTE-IDENTICAL today — no project
// nodes exist, so a repo's parent_id is NULL and the ladder is exactly {cto} then {user} for
// every current shape. A project node inserted above a repo simply slots {ceo} between them.

/**
 * A resolved Work responder (the recursive generalization of PendingResponder):
 *  - `{ kind: "work", work_id }` — a story NODE; the workspace EXECUTING it responds (the leader,
 *    the recursive form of today's 'story'). work_id is the responding NODE's id.
 *  - `{ kind: "cto" }` — the supervisor of a REPO container (work_kind='repo').
 *  - `{ kind: "ceo"; project_id }` — the supervisor of a PROJECT container (work_kind='project').
 *    project_id is the responding PROJECT node's id. REVAMP-4 P3a — dormant until a CEO feed
 *    exists (no project nodes materialize in prod yet; reachable only via a test project node).
 *  - `{ kind: "user" }` — above the root container (parent_id NULL), and the needs_user_input
 *    short-circuit target.
 */
export type WorkResponder =
  | { kind: "work"; work_id: string }
  | { kind: "cto" }
  | { kind: "ceo"; project_id: string }
  | { kind: "user" };

/** Options shared by the responder resolvers. */
export type WorkResponderOpts = {
  /** When true, the feedback is `needs_user_input` — only a human can answer — so routing
   *  short-circuits STRAIGHT to the user, bypassing the parent-chain bubble-up entirely.
   *  The generalized form of today's escalated_to_user. Default false. */
  needsUserInput?: boolean;
};

/**
 * Push the CONTAINER LADDER tiers, from container `start` upward: `repo → { cto }`, `project →
 * { ceo, project_id }` (REVAMP-4 P3a), stopping at `parent_id` NULL or a non-container row. The
 * shared `visited` set guards a malformed container cycle so the walk always terminates. This is
 * the generalized replacement for the OLD code's hardcoded trailing `{ cto }` — a repo's supervisor
 * is the CTO, a project's is the CEO, and the ladder can climb repo → project → … above it.
 */
function walkContainerLadder(
  start: string,
  chain: WorkResponder[],
  visited: Set<string>,
): void {
  let cur: string | null = start;
  while (cur != null && !visited.has(cur)) {
    visited.add(cur);
    const k = getTask(cur)?.work_kind;
    if (k === "repo") chain.push({ kind: "cto" });
    else if (k === "project") chain.push({ kind: "ceo", project_id: cur });
    else break; // a non-container reached the ladder — malformed; stop defensively
    cur = workParentId(cur);
  }
}

/**
 * The CONTAINER-LADDER walk — the SINGLE source of truth both public resolvers derive from, so
 * `resolveWorkResponder` (the head) and `workResponderChain` (the whole thing) can NEVER diverge.
 *
 * It mirrors the OLD resolver's structure exactly, generalizing ONLY the terminal:
 *  (a) The origin IS a container (a repo/project `id` — a repo-level or project-level ask): its OWN
 *      supervisor tier heads the chain, then the ladder continues ABOVE it (repo → cto, then a
 *      project parent → ceo, …).
 *  (b) The origin is a leaf / story node / missing row: walk its STRICT ancestors, pushing a
 *      `{ work }` tier for EVERY non-container ancestor (leaf OR node — byte-identical to the old
 *      resolver, which distinguished only repo-vs-not, NOT node-vs-leaf), stopping at the first
 *      CONTAINER or `parent_id` NULL. Then the container ladder from that first container upward.
 *      If there is NO container ancestor (a legacy parent-NULL top-level Work, or a missing row),
 *      the default base is `{ cto }` — byte-identical to the old unconditional trailing `{ cto }`.
 *
 * A trailing `{ user }` is always the final terminal. The visited-set is seeded with `id` (case b)
 * so a malformed self-parent / parent CYCLE pushes each ancestor at most once and terminates.
 *
 * BYTE-IDENTICAL today (no project nodes): parent-NULL leaf/node → [{cto},{user}]; standalone leaf
 * under a repo → [{cto},{user}]; story member → [{work,N},{cto},{user}]; a deep leaf → [{work,…}…,
 * {cto},{user}]; repo (parent NULL) → [{cto},{user}]. NEW (test-only, a project above a repo): a
 * repo → [{cto},{ceo},{user}]; a leaf under it → [{cto},{ceo},{user}]; the project itself →
 * [{ceo},{user}].
 */
function containerLadderChain(id: string): WorkResponder[] {
  const chain: WorkResponder[] = [];
  const originKind = getTask(id)?.work_kind;

  // (a) The origin IS a container: its own supervisor tier heads the chain, then the ladder above.
  if (originKind === "repo" || originKind === "project") {
    walkContainerLadder(id, chain, new Set<string>());
    chain.push({ kind: "user" });
    return chain;
  }

  // (b) A leaf / story node / missing row: STRICT-ancestor `{ work }` tiers up to the first
  //     container (or NULL). Seed visited with `id` so a self-parent pushes exactly once (old rule).
  const visited = new Set<string>([id]);
  let cur: string | null = workParentId(id);
  let container: string | null = null;
  while (cur != null) {
    const k = getTask(cur)?.work_kind;
    if (k === "repo" || k === "project") {
      container = cur; // reached the container ladder — stop pushing `{ work }` tiers
      break;
    }
    chain.push({ kind: "work", work_id: cur }); // every non-container ancestor is a `{ work }` tier
    if (visited.has(cur)) break; // malformed parent cycle/self-parent — pushed once, now stop
    visited.add(cur);
    cur = workParentId(cur);
  }
  if (container == null) {
    chain.push({ kind: "cto" }); // default CTO base (byte-identical old trailing `{ cto }`)
  } else {
    walkContainerLadder(container, chain, visited);
  }
  chain.push({ kind: "user" });
  return chain;
}

/**
 * The IMMEDIATE responder for a Work's pending feedback — the head of the container-ladder walk:
 *  - needsUserInput → `{ user }` (short-circuit, no parent walk).
 *  - otherwise → the head of the container-ladder chain: a non-container parent (a story node, or
 *    any leaf/node ancestor) → `{ work }`; a repo container → `{ cto }`; a project container →
 *    `{ ceo }`; a legacy parent-NULL top-level Work → the default `{ cto }` base.
 * Pure read of the rows. A missing row is treated as a top-level Work → `{ cto }` (mirroring the old
 * resolver's isTopLevelWork base). This is the recursive generalization of tasks.pendingResponder.
 */
export function resolveWorkResponder(
  id: string,
  opts: WorkResponderOpts = {},
): WorkResponder {
  if (opts.needsUserInput) return { kind: "user" };
  // The immediate responder is the chain head; the ladder always appends `{ user }`, so [0] exists.
  return containerLadderChain(id)[0]!;
}

/**
 * The FULL ordered bubble-up CHAIN for a Work's feedback, from the immediate responder up to the
 * user — the container-ladder walk leaf → story-node(s) (leader) → repo (CTO) → project (CEO) →
 * user. Each ancestor story NODE is a `{ work }` tier; the container ancestors contribute `{ cto }`
 * / `{ ceo }`; the chain always ends `{ user }`. EXCEPTION: needsUserInput short-circuits the whole
 * walk to `[{ user }]`.
 *
 * Arbitrary nesting depth (RFC Q8): the chain length grows with the parent_id depth, no cap. A
 * visited-set guards against a malformed parent CYCLE / self-parent (data that should never exist,
 * but must never hang the walk): once a row is revisited the walk stops and the chain bottoms out
 * at `{ user }`, so the function always terminates.
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
  return containerLadderChain(id);
}
