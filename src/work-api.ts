// WORK + WORKSPACE UNIFICATION — step 5: API UNIFICATION (the `/api/work/*` facade).
// See docs/rfc-work-workspace-unification.md §5 (step 5: "Stand up /api/work/*").
//
// This is the UNIFIED WORK API surface — one vocabulary ("Work") over today's two
// physically-separate resources. A unit of Work is EITHER a TASK (a LEAF — a worktree /
// branch / build agent) or a STORY (a NODE — a container with a leader that decomposes).
// `/api/work/*` resolves a work id to a leaf or a node and DISPATCHES to the EXISTING
// `tasks.ts` / `stories.ts` operations — so every read and mutation is backed by an
// UNCHANGED service operation.
//
// WHY A FACADE (not one physical table) THIS STEP: the unification's data migration —
// folding `stories` rows into `tasks` with `story_id`→`parent_id` — is the GATED step-6
// cutover, NOT this step. Here `tasks`, `stories`, and `workspaces` stay physically
// separate and authoritative; `tasks.parent_id` stays INERT (no writes — storage stays
// `story_id` + the `stories` table). So step 5 stands up the unified SURFACE over today's
// storage; step 6 canonicalizes it (make `/api/work` the sole surface, route/delete the
// old ones) and activates the recursive routing (`config.unifiedWork`).
//
// STRICTLY ADDITIVE: this module is a THIRD adapter over the same operations the existing
// `/api/tasks/*` + `/api/stories/*` handlers already adapt. Those handlers + their service
// ops are UNTOUCHED, so `/api/tasks` + `/api/stories` stay BYTE-IDENTICAL (the HARD
// INVARIANT). work.ts's one-way import discipline is preserved — this module (like
// server.ts) imports both tasks.ts and stories.ts; work.ts imports neither.
import { HttpError, getWorkspace } from "./workspaces.ts";
import {
  abortTask,
  allTasksView,
  answerTask,
  approvePlan,
  approveTask,
  assertWorkspaceTaskCreationAllowed,
  confirmMajor,
  createTask,
  editTask,
  escalateTask,
  getTask,
  nudgeTask,
  rejectPlan,
  rejectTask,
  requeueTask,
  setBlockedBy,
  setPriority,
  setStoryBlockedBy,
  setVersionBump,
  submitSpec,
  taskChainEstimate,
  taskDiff,
  taskEstimate,
  taskReadiness,
  taskView,
  updateTask,
} from "./tasks.ts";
import type { ApproveOutcome, TaskListView, TaskReadiness, TaskView } from "./tasks.ts";
import {
  acceptDirective,
  allStoryViews,
  answerStoryAsk,
  assignTaskToStory,
  createStory,
  createSubtask,
  deleteStory,
  escalateStoryAsk,
  getStory,
  openStoryAsk,
  resetStory,
  storyView,
  updateStory,
} from "./stories.ts";
import type { AcceptedDirective, StoryResetResult, StoryView } from "./stories.ts";
import { resolveWorkResponder, workResponderChain } from "./work.ts";
import type { WorkResponder } from "./work.ts";
import { listTaskEvents } from "./db.ts";
import type { StoryRow, TaskEventRow, TaskRow } from "./db.ts";

// --- WORK RESOLUTION (id → leaf task | node story) ---------------------------

/** A resolved unit of Work: a LEAF (task row) or a NODE (story row). */
export type ResolvedWork =
  | { kind: "leaf"; task: TaskRow }
  | { kind: "node"; story: StoryRow };

/**
 * Resolve a work id to its underlying resource — a TASK (leaf) or a STORY (node) — or throw 404
 * if neither exists. STORIES are tried FIRST: each story is also materialized as a `tasks` row
 * (the parent_id FK anchor — see db.ensureStoryWorkNode), so a story id matches BOTH tables; the
 * stories table is authoritative for "is this a NODE," so it wins. A leaf task id never collides
 * (story ids are `st-`-prefixed, a disjoint id space), so it falls through to the task lookup.
 *
 * NODE-IDENTITY for this FACADE stays getStory-DISPATCHED — deliberately NOT switched onto a direct
 * `work_kind` test. It resolves node-vs-leaf by "does getStory(id) return a row"; as of Phase B.4
 * that getStory → getStoryRow read is itself TASKS-BACKED (it reads the node's own tasks row guarded
 * on work_kind='node' — B.3 eagerly materializes that row at createStory, so even a childless story
 * has it), so the returned StoryRow PAYLOAD now comes from the node's tasks row, not the `stories`
 * mirror. What has NOT moved is the facade's DISPATCH shape (getStory-first, story ids a disjoint
 * `st-` space) and the ResolvedWork identity contract — those unify onto work_kind in B.5 with the
 * stories-table drop. Byte-identical to before — this step does not touch resolveWork's own logic.
 */
export function resolveWork(id: string): ResolvedWork {
  const story = getStory(id);
  if (story) return { kind: "node", story };
  const task = getTask(id);
  // REVAMP-4 S0a: a CONTAINER node ('repo'/'project') is a real `tasks` row, so getTask finds it —
  // but it is neither a story node (getStory, guarded on work_kind='node', returned null above) nor
  // a servable leaf. Exclude the container kinds so it falls through to a clean 404 rather than
  // being mis-served as a leaf via taskView. Byte-identical for leaf/node (the only rows that
  // reach here today): a 'leaf' resolves as leaf; a stray 'node' still resolves as leaf as before.
  if (task && task.work_kind !== "repo" && task.work_kind !== "project") {
    return { kind: "leaf", task };
  }
  throw new HttpError(404, `work not found: ${id}`);
}

// --- WORK VIEWS (unified get / list) -----------------------------------------

/**
 * A LEAF Work view: the full TaskView plus the unified responder surface — the IMMEDIATE
 * Work responder and the full ordered bubble-up chain (work.ts). These are INFORMATIONAL
 * this step: they reflect `parent_id`, which is inert pre-migration, so a leaf with no
 * parent resolves to the base-case `cto → user` chain. (After the step-6 cutover, when
 * stories become parent nodes, the chain reflects the real `leaf → node → … → cto → user`
 * bubble-up.) They never alter the embedded TaskView.
 */
export type LeafWorkView = TaskView & {
  work_kind: "leaf";
  work_responder: WorkResponder;
  work_responder_chain: WorkResponder[];
};

/** A NODE Work view: the full StoryView (member-task counts + leader status). */
export type NodeWorkView = StoryView & { work_kind: "node" };

export type WorkView = LeafWorkView | NodeWorkView;

/**
 * The unified WORK DETAIL view for `GET /api/work/:id`. Delegates to the existing
 * `taskView` (leaf) or `storyView` (node) and tags the result with its `work_kind`; a leaf
 * additionally carries the informational Work responder + chain. Async because the node
 * branch probes the leader's live registration (storyView). Throws 404 if the work is gone.
 */
export async function workView(id: string): Promise<WorkView> {
  const resolved = resolveWork(id);
  if (resolved.kind === "leaf") {
    const view = taskView(id)!; // resolveWork proved the row exists
    return {
      ...view,
      work_kind: "leaf",
      work_responder: resolveWorkResponder(id),
      work_responder_chain: workResponderChain(id),
    };
  }
  const view = (await storyView(id))!; // ditto
  return { ...view, work_kind: "node" };
}

/** A row in the unified WORK LIST: a leaf (light task projection) or a node (story view).
 *  The `work_kind` discriminator is named distinctly from a task row's own `kind`
 *  ('task'/'rollback') column so the spread preserves both. */
export type WorkListItem =
  | (TaskListView & { work_kind: "leaf" })
  | (StoryView & { work_kind: "node" });

/**
 * The unified cross-resource WORK LIST for `GET /api/work` — every leaf (task) and node
 * (story) across all workspaces, newest-first, each tagged with its `kind`. Leaves reuse
 * `allTasksView` (so its `status` / `workspace` / `q` filtering is byte-identical to the
 * task list); nodes reuse `allStoryViews`, filtered here by the same optional `workspace` /
 * `status` / `q` (a story's searchable text is its brief + id). The two already-sorted
 * lists are merged into one newest-first set, mirroring the merge sort the cross-workspace
 * views use elsewhere.
 */
export async function listWork(
  opts: { status?: string; workspace?: string; q?: string } = {},
): Promise<WorkListItem[]> {
  const leaves: WorkListItem[] = allTasksView(opts).map((t) => ({ ...t, work_kind: "leaf" as const }));

  const needle = (opts.q ?? "").trim().toLowerCase();
  const nodes: WorkListItem[] = (await allStoryViews())
    .filter((s) => !opts.workspace || s.workspace_id === opts.workspace)
    .filter((s) => !opts.status || s.status === opts.status)
    .filter(
      (s) =>
        !needle ||
        `${s.id}\n${s.brief ?? ""}`.toLowerCase().includes(needle),
    )
    .map((s) => ({ ...s, work_kind: "node" as const }));

  const out = [...leaves, ...nodes];
  out.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  return out;
}

// --- WORK CREATION -----------------------------------------------------------

/**
 * Create a TOP-LEVEL unit of Work in a workspace (`POST /api/workspaces/:id/work`). A
 * top-level Work is a NODE (a story/container) — leaves are always created as CHILDREN of a
 * node (see createWorkChild), which mirrors today's authority model (standalone work tasks
 * are not created at a workspace; a story leader decomposes a story into subtasks). Maps to
 * `createStory`. 404 if the workspace is gone; 400 if the brief is blank.
 */
export function createWork(workspaceId: string, brief: unknown): StoryRow {
  if (!getWorkspace(workspaceId)) {
    throw new HttpError(404, `workspace not found: ${workspaceId}`);
  }
  return createStory(workspaceId, brief);
}

/**
 * Create a workspace-level ROLLBACK LEAF (`POST /api/workspaces/:id/work` with `kind=rollback`)
 * — the unified-surface home of the webapp's "Roll back" flow, which the split `/api/tasks` route
 * served via `POST /api/workspaces/:id/tasks` (kind=rollback). Top-level NON-rollback Work is a
 * NODE (createWork → createStory); the ONE workspace-level LEAF butchr still creates directly is a
 * rollback (authority flip — see tasks.assertWorkspaceTaskCreationAllowed, which we re-run so the
 * rollback-only contract holds identically over this surface). The `args` mirror the
 * `/api/work/:id/work` (createSubtask) body. 404 if the workspace is gone.
 */
export async function createWorkspaceRollback(
  workspaceId: string,
  args: Parameters<typeof createSubtask>[1],
): Promise<TaskView> {
  if (!getWorkspace(workspaceId)) {
    throw new HttpError(404, `workspace not found: ${workspaceId}`);
  }
  assertWorkspaceTaskCreationAllowed("rollback");
  return createTask(
    workspaceId,
    args.prompt,
    args.context ?? [],
    args.blockedBy ?? [],
    "rollback",
    args.model ?? null,
    args.tags ?? [],
    args.priority ?? 0,
    args.planPreview ?? false,
    args.idea ?? false,
    args.versionBump ?? "patch",
    args.allowlist ?? [],
  );
}

/**
 * Create a CHILD unit of Work under a node (`POST /api/work/:id/work`) — a LEAF (subtask)
 * belonging to the node. Only a NODE can hold children (a leaf has no decomposition), so a
 * leaf parent is a 409. Maps to `createSubtask` (which pins the child to the node's own
 * workspace + sets story_id and dispatches it like any task). The `args` mirror the
 * `/api/stories/:id/tasks` body exactly. 404 if the parent is gone; 409 if it is a leaf.
 */
export async function createWorkChild(
  parentId: string,
  args: Parameters<typeof createSubtask>[1],
): Promise<TaskView> {
  const parent = resolveWork(parentId);
  if (parent.kind !== "node") {
    throw new HttpError(409, "cannot add a child to a leaf work item (only a node can decompose)");
  }
  return createSubtask(parentId, args);
}

/**
 * ACCEPT & DECOMPOSE a CEO directive into stories (`POST /api/work/:directiveId/stories`) — a repo
 * CTO's response to a directive (RFC Q1 directive machinery). Creates 1+ stories under the directive's
 * repo, each stamped the directive's `initiative_id`, and transitions the directive `directive →
 * accepted`. DIRECTIVE-only: `acceptDirective` 409s a work item that is not an open directive-status
 * leaf. The `targets` body is a non-empty array of `{ brief }`. 404 if the directive is gone. The
 * OTHER CTO verb — push-back — is the existing `POST /api/work/:id/escalate` (escalateWork).
 */
export function acceptWorkDirective(id: string, targets: unknown): AcceptedDirective {
  return acceptDirective(id, targets);
}

// --- WORK MUTATIONS (dispatch by kind) ---------------------------------------

/**
 * PATCH a unit of Work (`PATCH /api/work/:id`). A LEAF edits its prompt/context in place
 * (`editTask`); a NODE updates its brief/status (`updateStory`). The body keys are routed
 * per kind. Throws 404 if the work is gone.
 */
export function patchWork(
  id: string,
  body: { prompt?: unknown; context?: unknown; brief?: unknown; status?: unknown },
): TaskView | StoryRow {
  const resolved = resolveWork(id);
  if (resolved.kind === "leaf") {
    const edits: { prompt?: string; context?: string[] } = {};
    if ("prompt" in body) edits.prompt = body.prompt as string;
    if ("context" in body) edits.context = body.context as string[];
    return editTask(id, edits);
  }
  return updateStory(id, { brief: body.brief, status: body.status });
}

/**
 * UPDATE a unit of Work's in-flight instruction and NOTIFY its worker (`POST /api/work/:id/update`,
 * body `{brief}`) — the uniform UPDATE-instruction+NOTIFY verb (story st-7a7b0654). AMENDS the
 * persisted brief + rewrites the instruction, then delivers the change to wherever the worker is
 * (steer a live pane / re-surface a parked item / amend-only when not live). Routed by kind: the
 * LEAF path (`updateTask`) covers subtasks AND a CEO DIRECTIVE — a directive IS a repo-parented leaf
 * (`status='directive'`), so it flows through here, always taking the amend + re-surface path (it
 * never runs an agent) and additionally mirroring its brief into the `summary` column so the CTO
 * re-surface carries the new text (updateTask; story st-7a7b0654 S3). The story-NODE tier lands in
 * S2 (a clean 409 seam here until then). 404 if gone; 409 on a terminal/rolling_back item — an
 * `accepted` directive is terminal, so a correction is a fresh directive, not an amendment.
 */
export async function updateWork(id: string, brief: unknown): Promise<TaskView> {
  const resolved = resolveWork(id);
  if (resolved.kind !== "leaf") {
    // The story-NODE tier is not wired yet (S2). A directive is a LEAF, so it never reaches here —
    // it flows through updateTask below like any other leaf.
    throw new HttpError(
      409,
      "updating a story-node instruction is not yet supported (lands in S2)",
    );
  }
  return updateTask(id, brief);
}

/**
 * APPROVE a unit of Work (`POST /api/work/:id/approve`). LEAF-only — a node (story) has no
 * diff to approve; its completion is requested via PATCH status `done`. Maps to
 * `approveTask` (returning the same ApproveOutcome the task approve route surfaces). 409 on
 * a node; 404 if gone.
 */
export async function approveWork(id: string): Promise<ApproveOutcome> {
  requireLeaf(id, "approve");
  return approveTask(id);
}

/**
 * REJECT a unit of Work (`POST /api/work/:id/reject`) — send a leaf back for rework with a
 * change-request note. LEAF-only (maps to `rejectTask`). 409 on a node; 404 if gone.
 */
export async function rejectWork(id: string, note: string): Promise<TaskView> {
  requireLeaf(id, "reject");
  return rejectTask(id, note);
}

/**
 * ANSWER a unit of Work's open feedback (`POST /api/work/:id/answer`) — the UNIFIED answer
 * verb. A LEAF answers its `needs_info` question (`answerTask`); a NODE answers its open
 * story-level ask (`answerStoryAsk`). Routed by kind. 404 if gone.
 */
export async function answerWork(id: string, answer: string): Promise<TaskView | StoryRow> {
  const resolved = resolveWork(id);
  if (resolved.kind === "leaf") return answerTask(id, answer);
  return answerStoryAsk(id, answer);
}

/**
 * ESCALATE a unit of Work's pending feedback to the next responder (`POST
 * /api/work/:id/escalate`) — the UNIFIED escalate verb (the single cto→user boundary today).
 * A LEAF escalates its task feedback (`escalateTask`); a NODE escalates its open ask
 * (`escalateStoryAsk`). Routed by kind. 404 if gone.
 */
export function escalateWork(id: string): TaskView | StoryRow {
  const resolved = resolveWork(id);
  if (resolved.kind === "leaf") return escalateTask(id);
  return escalateStoryAsk(id);
}

/**
 * OPEN an ASK on a unit of Work (`POST /api/work/:id/ask`) — a NODE's leader raising a
 * story-level question up the chain. NODE-only (a leaf raises in-implementation questions
 * via its agent's MCP `raise`, surfaced as `needs_info`, not an ask). Maps to
 * `openStoryAsk`. 409 on a leaf; 404 if gone.
 */
export function askWork(id: string, question: unknown): StoryRow {
  const resolved = resolveWork(id);
  if (resolved.kind !== "node") {
    throw new HttpError(409, "cannot open an ask on a leaf work item (a leaf raises via its agent)");
  }
  return openStoryAsk(id, question);
}

/**
 * Set a unit of Work's dispatch PRIORITY (`POST /api/work/:id/priority`). LEAF-only — a node
 * has no dispatch priority of its own (its members are dispatched). Maps to `setPriority`.
 * 409 on a node; 404 if gone.
 */
export function prioritizeWork(id: string, priority: number | string | null): TaskView {
  requireLeaf(id, "priority");
  return setPriority(id, priority);
}

/**
 * Replace a unit of Work's dependency set (`PUT|POST /api/work/:id/blocked_by`). Accepts a
 * LEAF (task) OR a STORY NODE as the dependent — both carry their dependency set on the SAME
 * global, unscoped `tasks.blocked_by` column. A leaf routes to `setBlockedBy` (status-based
 * block, byte-identical); a story node routes to `setStoryBlockedBy` (leader-gated sequencing —
 * the node stays `open`, its leader is held until the blockers clear). A repo/project CONTAINER
 * has no dependency set of its own (its members do) → 409. 404 if gone.
 */
export async function setWorkBlockedBy(id: string, blockedBy: string[]): Promise<TaskView> {
  // A repo/project container is a real `tasks` row (getTask finds it) but is neither a leaf nor a
  // story node — reject it explicitly with a 409 (resolveWork would otherwise 404 the id).
  const row = getTask(id);
  if (row && (row.work_kind === "repo" || row.work_kind === "project")) {
    throw new HttpError(409, "cannot set blocked_by on a repo/project container work item");
  }
  const resolved = resolveWork(id);
  if (resolved.kind === "node") return setStoryBlockedBy(id, blockedBy);
  return setBlockedBy(id, blockedBy);
}

// --- LEAF READ OPS (diff / readiness / estimate / events) --------------------
// These mirror the read-only `/api/tasks/:id/*` surfaces over the unified vocabulary. Each is
// LEAF-only — a node (story) has no diff/branch/estimate of its own (its members do) — so it
// 409s on a node via requireLeaf. The session-backed reads (output/transcript/activity) stay in
// server.ts where the task-session helpers live; they guard with the exported assertWorkLeaf.

/** A LEAF's working-tree diff (`GET /api/work/:id/diff`) — maps to `taskDiff`. 409 on a node. */
export async function diffWork(id: string): Promise<string> {
  requireLeaf(id, "diff");
  return taskDiff(id);
}

/** A LEAF's merge-readiness snapshot (`GET /api/work/:id/readiness`) — maps to `taskReadiness`. 409 on a node. */
export async function readinessWork(id: string): Promise<TaskReadiness> {
  requireLeaf(id, "readiness");
  return taskReadiness(id);
}

/** A LEAF's duration estimate + dependency-chain estimate (`GET /api/work/:id/estimate`). 409 on a node. */
export function estimateWork(id: string): { single: ReturnType<typeof taskEstimate>; chain: ReturnType<typeof taskChainEstimate> } {
  requireLeaf(id, "estimate");
  return { single: taskEstimate(id), chain: taskChainEstimate(id) };
}

/** A LEAF's status-transition audit timeline (`GET /api/work/:id/events`) — maps to `listTaskEvents`. 409 on a node. */
export function eventsWork(id: string): TaskEventRow[] {
  requireLeaf(id, "events");
  return listTaskEvents(id);
}

// --- LEAF ACTIONS (spec / plan / version_bump / confirm-major / abort / nudge / requeue / reparent)

/** Submit a LEAF's SPEC for a task parked in `idea` (`POST /api/work/:id/spec`) — maps to `submitSpec`. 409 on a node. */
export async function specWork(id: string, spec: string): Promise<TaskView> {
  requireLeaf(id, "submit a spec for");
  return submitSpec(id, spec);
}

/** APPROVE a LEAF's proposed plan (`POST /api/work/:id/plan/approve`) — resume to implement. 409 on a node. */
export async function planApproveWork(id: string, note?: string): Promise<TaskView> {
  requireLeaf(id, "approve a plan for");
  return approvePlan(id, note);
}

/** REJECT a LEAF's proposed plan (`POST /api/work/:id/plan/reject`) — send it back to re-propose. 409 on a node. */
export async function planRejectWork(id: string, note: string): Promise<TaskView> {
  requireLeaf(id, "reject a plan for");
  return rejectPlan(id, note);
}

/** Update a LEAF's declared semver `version_bump` level (`POST /api/work/:id/version_bump`) — maps to `setVersionBump`. 409 on a node. */
export function versionBumpWork(id: string, bump: unknown): TaskView {
  requireLeaf(id, "set the version bump for");
  return setVersionBump(id, bump);
}

/** MAJOR DOUBLE-CONFIRM on a LEAF (`POST /api/work/:id/confirm-major`) — maps to `confirmMajor` (same ApproveOutcome). 409 on a node. */
export async function confirmMajorWork(id: string): Promise<ApproveOutcome> {
  requireLeaf(id, "confirm a major bump for");
  return confirmMajor(id);
}

/** ABORT a LEAF (`POST /api/work/:id/abort`) — maps to `abortTask`. 409 on a node (a node is reset/deleted, not aborted). */
export async function abortWork(id: string): Promise<TaskView> {
  requireLeaf(id, "abort");
  return abortTask(id);
}

/** NUDGE a LEAF's idle build agent (`POST /api/work/:id/nudge`) — maps to `nudgeTask`. 409 on a node. */
export async function nudgeWork(id: string, text?: string): Promise<TaskView> {
  requireLeaf(id, "nudge");
  return nudgeTask(id, text);
}

/** REQUEUE a LEAF that gave up dispatching (`POST /api/work/:id/requeue`) — maps to `requeueTask`. 409 on a node. */
export async function requeueWork(id: string): Promise<TaskView> {
  requireLeaf(id, "requeue");
  return requeueTask(id);
}

/**
 * REPARENT a LEAF under a node, or clear its parent (`POST /api/work/:id/parent`, body
 * `{parent_id: string|null}`) — the unified-surface form of `POST /api/tasks/:id/story`
 * (assign-to-story). Maps to `assignTaskToStory`, which keeps story_id and parent_id in
 * lock-step. LEAF-only — node-on-node reparenting is not in today's storage. 409 on a node.
 */
export function reparentWork(id: string, parentId: string | null): TaskView {
  requireLeaf(id, "reparent");
  return assignTaskToStory(id, parentId);
}

// --- NODE ACTIONS (delete / reset) -------------------------------------------

/**
 * DELETE a NODE (`DELETE /api/work/:id`) — maps to `deleteStory` (member leaves are NOT deleted;
 * their parent pointer is cleared). NODE-only — a leaf is ABORTED, not deleted (there is no
 * task-delete on the split surface either), so a leaf is a 409 directing the caller to abort.
 */
export function deleteWork(id: string): void {
  const resolved = resolveWork(id);
  if (resolved.kind !== "node") {
    throw new HttpError(409, "cannot delete a leaf work item (abort it instead)");
  }
  deleteStory(id);
}

/**
 * RESET a NODE (`POST /api/work/:id/reset`) — abort all of its in-flight children so the leader
 * can re-decompose. NODE-only (maps to `resetStory`). 409 on a leaf; 404 if gone.
 */
export async function resetWork(id: string): Promise<StoryResetResult> {
  const resolved = resolveWork(id);
  if (resolved.kind !== "node") {
    throw new HttpError(409, "cannot reset a leaf work item (reset applies to a node/story)");
  }
  return resetStory(id);
}

/** Resolve a work id and assert it is a LEAF for a leaf-only verb, else 409 (or 404 if gone). */
function requireLeaf(id: string, verb: string): TaskRow {
  const resolved = resolveWork(id);
  if (resolved.kind !== "leaf") {
    throw new HttpError(409, `cannot ${verb} a node work item (it applies to a leaf/task only)`);
  }
  return resolved.task;
}

/**
 * Public LEAF guard for the session-backed `/api/work/:id/*` routes (output / transcript /
 * activity / terminal) that stay in server.ts because they reuse the task-session helpers there.
 * Resolves the work id, asserts it is a LEAF (409 on a node), and returns the task row. Throws 404
 * if the work is gone — same contract as requireLeaf, exported so server.ts shares the one rule.
 */
export function assertWorkLeaf(id: string, verb: string): TaskRow {
  return requireLeaf(id, verb);
}
