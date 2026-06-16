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
  allTasksView,
  answerTask,
  approveTask,
  editTask,
  escalateTask,
  getTask,
  rejectTask,
  setBlockedBy,
  setPriority,
  taskView,
} from "./tasks.ts";
import type { ApproveOutcome, TaskListView, TaskView } from "./tasks.ts";
import {
  allStoryViews,
  answerStoryAsk,
  createStory,
  createSubtask,
  escalateStoryAsk,
  getStory,
  openStoryAsk,
  storyView,
  updateStory,
} from "./stories.ts";
import type { StoryView } from "./stories.ts";
import { resolveWorkResponder, workResponderChain } from "./work.ts";
import type { WorkResponder } from "./work.ts";
import type { StoryRow, TaskRow } from "./db.ts";

// --- WORK RESOLUTION (id → leaf task | node story) ---------------------------

/** A resolved unit of Work: a LEAF (task row) or a NODE (story row). */
export type ResolvedWork =
  | { kind: "leaf"; task: TaskRow }
  | { kind: "node"; story: StoryRow };

/**
 * Resolve a work id to its underlying resource — a TASK (leaf) or a STORY (node) — or
 * throw 404 if neither exists. STORIES are tried FIRST: as of the step-6a cutover each story
 * is ALSO materialized as a `tasks` row (the parent_id FK anchor — see db.ensureStoryWorkNode),
 * so a story id now matches BOTH tables; the stories table is authoritative for "is this a
 * NODE," so it wins. A leaf task id never collides (story ids are `st-`-prefixed, a disjoint
 * id space), so it falls through to the task lookup.
 */
export function resolveWork(id: string): ResolvedWork {
  const story = getStory(id);
  if (story) return { kind: "node", story };
  const task = getTask(id);
  if (task) return { kind: "leaf", task };
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
 * Replace a unit of Work's dependency set (`PUT|POST /api/work/:id/blocked_by`). LEAF-only
 * this step — `blocked_by` lives on the task row; a node has no dependency set in today's
 * storage (node-on-node blocking activates at the step-6 cutover when nodes become Work
 * rows). Maps to `setBlockedBy`. 409 on a node; 404 if gone.
 */
export async function setWorkBlockedBy(id: string, blockedBy: string[]): Promise<TaskView> {
  requireLeaf(id, "blocked_by");
  return setBlockedBy(id, blockedBy);
}

/** Resolve a work id and assert it is a LEAF for a leaf-only verb, else 409 (or 404 if gone). */
function requireLeaf(id: string, verb: string): TaskRow {
  const resolved = resolveWork(id);
  if (resolved.kind !== "leaf") {
    throw new HttpError(409, `cannot ${verb} a node work item (it applies to a leaf/task only)`);
  }
  return resolved.task;
}
