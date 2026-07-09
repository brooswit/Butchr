// The PURE, DOM-free leaves of the unified work list (stories + tasks): the completion
// predicate, the /api/work path + list splitters, the blocked_by dependency-graph walkers,
// and the story→subtask membership rules. Shared by the task, workspace, and pipeline views,
// so it belongs here rather than in any one of them.
//
// Ported to `.ts` by RFC Phase 4 with zero logic change (§1.1 row 6: "every export is pure and
// DOM-free"). Its tests (test/graph-hierarchy.test.ts, test/graph-rollup-completion.test.ts,
// test/swimlane-order.test.ts) import it directly and needed no edit. These helpers used to be
// fenced by `<test-extract:...>` sentinels and eval'd out of app.js with `new Function`, because a
// classic script could not be imported. That harness is gone — do not reintroduce a sentinel here.
//
// TERMINAL_STATUSES is an `export let`: applyStateMeta REASSIGNS it once /api/state-meta lands,
// and the ES live binding propagates that new value here. isHistoryItem reads it at CALL time —
// never destructure it into a module-scope const, which would snapshot the empty pre-load value.
import { TERMINAL_STATUSES } from "./state-meta.ts";
import type { StatusCounts, WorkItem } from "./types.ts";

// Bound the two long-lived caches so they don't grow unbounded across a long session:
// the Pipeline's expanded done-piles (story ids) and the activity pulse cache (task id -> pulse).
// Both only ever ADD ids; work that leaves the list (merged/aborted, or you switch workspaces)
// kept its entry forever. On each workspace render we drop every id no longer in the current
// work-id set — functionally harmless (a stale id renders nothing) — purely a growth bound.
export function pruneWorkCaches(
  liveIds: Set<string>,
  expanded: Set<string>,
  activity: Map<string, unknown>,
): void {
  for (const id of expanded) if (!liveIds.has(id)) expanded.delete(id);
  for (const id of activity.keys()) if (!liveIds.has(id)) activity.delete(id);
}

// A work item counts as COMPLETE once it reaches a SUCCESSFUL terminal status. A LEAF task ends
// at `merged` (or `rolled_back`); a STORY NODE ends at `done`. This is the ONE source of truth
// for "is this work finished", reused by storyProgress's done count AND the cross-type rollup
// progress bars — those bars mix nodes + leaves in one subtree, so they MUST count node `done`
// too, else any subtree containing a completed story UNDER-reports (it sits in the total but
// never in the merged numerator). Failure/abort are terminal but NOT complete (they're the ✗).
export const COMPLETE_STATUSES: ReadonlySet<string> = new Set(["merged", "rolled_back", "done"]);
export function isCompleteStatus(status: string | null | undefined): boolean {
  return !!status && COMPLETE_STATUSES.has(status);
}

// The unified WORK-LIST URL for one workspace: GET /api/work scoped to this workspace
// (?workspace=). The single replacement for the split /workspaces/:id/tasks +
// /workspaces/:id/stories fetches — the response is the WorkView leaf|node union, which
// callers split by `work_kind` (leaves → task list, nodes → stories).
export function workListPath(workspaceId: string): string {
  return "/work?workspace=" + encodeURIComponent(workspaceId);
}
// The LEAF (task) members of a /api/work list — used for the launcher's one-line queue summary.
// The Pipeline view consumes the full leaf|node union directly, so there's no node-only splitter.
export function workLeaves(work: WorkItem[] | null | undefined): WorkItem[] {
  return (Array.isArray(work) ? work : []).filter((w) => w && w.work_kind === "leaf");
}

// Whether a work item is FINISHED (terminal): a NODE (story) once it reaches done/aborted, a
// LEAF (task) by the server's terminal status set. In the Pipeline view a finished story is
// dropped from the lanes and a finished subtask collapses into its lane's "N done" pile;
// everything else stays active — including stories that are open/merging/merge_blocked and any
// feedback task awaiting the operator.
export function isHistoryItem(w: WorkItem | null | undefined): boolean {
  if (!w) return false;
  if (w.work_kind === "node") return w.status === "done" || w.status === "aborted";
  return TERMINAL_STATUSES.includes(w.status);
}

// Reverse the blocked_by edges into a dependents map: blocker id → [ids of tasks
// that list it in their blocked_by]. Used to walk the dependency graph the
// other way (from a gating task down to what it gates) for the progress rollup.
// Purely client-side from the already-fetched list.
export function reverseDeps(tasks: WorkItem[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const t of tasks) {
    for (const b of (t.blocked_by || [])) {
      if (!m.has(b)) m.set(b, []);
      m.get(b)!.push(t.id);
    }
  }
  return m;
}

// The transitive set of task ids a given task GATES — every task that lists it
// (directly or through a chain) in blocked_by. BFS over the reversed edges; the
// `seen` set both collects the result and guards against a stray cycle. The root
// itself is excluded.
export function gatedSubtree(rootId: string, dependentsOf: Map<string, string[]>): Set<string> {
  const seen = new Set<string>();
  const queue = [...(dependentsOf.get(rootId) || [])];
  while (queue.length) {
    const id = queue.shift()!;
    if (id === rootId || seen.has(id)) continue;
    seen.add(id);
    for (const d of (dependentsOf.get(id) || [])) if (!seen.has(d)) queue.push(d);
  }
  return seen;
}

// Assign each node a column (level) = longest blocker-chain depth, so blockers sit
// strictly left of the tasks they block (a layered topological layout). Roots
// (no in-graph blockers) land at level 0. The backend forbids dependency cycles,
// but a guard bounds the relaxation passes so a stray cycle can't loop forever.
export function graphLevels(
  nodeIds: Set<string>,
  edges: Array<{ from: string; to: string }>,
): Record<string, number> {
  const level: Record<string, number> = {};
  for (const id of nodeIds) level[id] = 0;
  const incoming: Record<string, string[]> = {};
  for (const id of nodeIds) incoming[id] = [];
  for (const e of edges) incoming[e.to].push(e.from);
  let changed = true;
  let guard = 0;
  const cap = nodeIds.size + 1;
  while (changed && guard <= cap) {
    changed = false;
    for (const id of nodeIds) {
      for (const from of incoming[id]) {
        if (level[from] + 1 > level[id]) { level[id] = level[from] + 1; changed = true; }
      }
    }
    guard++;
  }
  return level;
}

// The graph's containment derives from this ONE set of rules, so the views and the tests can't
// drift. A leaf's owning story id: parent_id wins over story_id (the canonical membership rule).
// A story NODE carries neither, so this is only meaningful for leaves.
export function graphChildOf(w: WorkItem | null | undefined): string | null | undefined {
  return w && (w.parent_id || w.story_id);
}
// The VISIBLE member leaves of a story: every id in `ids` (the rendered node set) whose work item
// is a LEAF owned by `storyId`. Returns leaf ids only — NOT the story itself; callers add the
// story node. Because it filters to `ids`, a member hidden by a depth slider is excluded here, so
// no dangling child-of edge is ever synthesized for a hidden child.
export function storyMemberIds(storyId: string, ids: Iterable<string>, byId: Map<string, WorkItem>): string[] {
  const out: string[] = [];
  for (const cid of ids) {
    const c = byId.get(cid);
    if (c && c.work_kind === "leaf" && graphChildOf(c) === storyId) out.push(cid);
  }
  return out;
}
// A story's TRUE subtask total from its server-computed per-status `counts` rollup (idle is a
// pseudo-bucket, not a real subtask — excluded, mirroring storyProgress). Drives the HONEST empty
// state: only a story with ZERO subtasks total is "no subtasks yet"; a story whose children are
// all finished or hidden has counts>0 and is NOT childless.
export function storySubtaskTotal(counts: StatusCounts | null | undefined): number {
  const c = counts || {};
  return Object.keys(c).reduce((n, k) => (k === "idle" ? n : n + (c[k] || 0)), 0);
}
