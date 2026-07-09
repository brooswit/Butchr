// The PURE half of the Pipeline (swimlanes) view — the story-lifecycle derivation, the story
// progress rollup, the intra-lane ordering, the card-emphasis bucket, and the lane title. Split out
// of views/swimlanes.js by the RFC Phase 2 horizontal cut (RFC §0.1 #5).
//
// DOM-free OUTRIGHT, not merely at module load: nothing here touches `document` even when called.
// Its one import is core/work-graph.ts, which is itself pure. test/swimlane-order.test.ts and the
// pure half of test/story-lifecycle-ui.test.ts import this leaf directly.
//
// ALL FIVE FUNCTIONS PORTED UNCHANGED THROUGH PHASE 4, and that is the point: RFC §7.3's whole
// argument for the bespoke swimlanes rebuild is that its logic is already separated from its
// pixels, so the rewrite's risk is bounded to VISUAL regression — which no test catches, and which
// is why Phase 4 ends with a browser check rather than a green gate.
import { graphLevels, isCompleteStatus, storySubtaskTotal } from "../core/work-graph.ts";
import type { StatusCounts, WorkItem } from "../core/types.ts";

// Story lifecycle — a SECONDARY, purely front-end-DERIVED signal so a story container doesn't just
// read "OPEN". Derived from data every StoryView already carries — the per-status `counts` rollup +
// leader{running,desired} + status — with NO new backend field. Scoped to OPEN stories ONLY:
// merging / merge_blocked / done already carry a descriptive status chip, so signaling them here
// would just double up. Returns one LIFECYCLE entry, or null. Precedence, robust to empty counts:
//   ▶ working — subtasks in flight, or the leader is up driving actionable work
//   ⏸ parked  — open but nothing in flight (just-created, or all children finished-yet-open)
//   ⚠ stalled — work remains but the leader that should drive it is DESIRED yet DOWN
export type Lifecycle = { key: "working" | "parked" | "stalled"; glyph: string; cls: string };
const LIFECYCLE: Record<Lifecycle["key"], Lifecycle> = {
  working: { key: "working", glyph: "▶", cls: "working" },
  parked: { key: "parked", glyph: "⏸", cls: "parked" },
  stalled: { key: "stalled", glyph: "⚠", cls: "stalled" },
};
export function storyLifecycle(story: WorkItem | null | undefined): Lifecycle | null {
  if (!story || story.work_kind !== "node" || story.status !== "open") return null;
  const c = story.counts || {};
  const leader = story.leader || {};
  const moving = (c.in_progress || 0) + (c.in_review || 0); // work actively in flight
  // All non-finished children. `idle` is peeled OUT of in_progress into its own bucket, so it can't
  // double-count moving; even if it did, remaining is only ever tested > 0, so the tip is harmless.
  const remaining = moving + (c.blocked || 0) + (c.idle || 0);
  if (moving > 0) return LIFECYCLE.working; // work literally in flight — WORKING regardless of leader
  if (remaining > 0 && leader.desired && !leader.running) return LIFECYCLE.stalled; // ⚠ leader down
  if (remaining > 0 && leader.running) return LIFECYCLE.working; // leader up with actionable/idle work
  return LIFECYCLE.parked; // nothing in flight, or work but no leader ever desired
}

// The story's OWN-children progress from its `counts` rollup — done (COMPLETE statuses, via
// isCompleteStatus) over the TRUE total (storySubtaskTotal, which drops the idle pseudo-bucket).
// total is 0 for a childless story, so callers gate the "d/t done" render on total > 0.
export function storyProgress(counts: StatusCounts | null | undefined): { done: number; total: number } {
  const c = counts || {};
  const done = Object.keys(c).reduce((n, k) => (isCompleteStatus(k) ? n + (c[k] || 0) : n), 0);
  return { done, total: storySubtaskTotal(c) };
}

// Pure, DOM-free intra-lane ordering, unit-tested in test/swimlane-order.test.ts. Orders a story's
// own leaf ids left → right by longest blocked_by chain WITHIN the lane (reusing graphLevels over
// the intra-lane edges), ties broken by the item's original index so the layout is STABLE across
// renders. Cross-story blockers are ignored for ordering — only blocked_by edges BETWEEN the passed
// member ids count, so a foreign blocker never shifts a lane's columns.
export function orderLaneLeaves(memberIds: string[], byId: Map<string, WorkItem>): string[] {
  const idSet = new Set(memberIds);
  const edges: Array<{ from: string; to: string }> = [];
  for (const id of memberIds) {
    const w = byId.get(id);
    if (!w) continue;
    for (const b of (w.blocked_by || [])) {
      if (idSet.has(b)) edges.push({ from: b, to: id });
    }
  }
  const level = graphLevels(idSet, edges);
  const idx = new Map(memberIds.map((id, i) => [id, i]));
  return [...memberIds].sort((a, b) => level[a] - level[b] || idx.get(a)! - idx.get(b)!);
}

// Semantic EMPHASIS bucket for a subtask's CARD (not its pill colour). The pill keeps its real
// .chip.<status> colour — the one shared status vocabulary; this only decides which card is
// visually LOUD so exactly one thing pulls the eye: an ATTENTION item (needs_info / a live agent
// wedged at a human prompt) gets a bright ring, an in-flight item a gentle accent (in_progress
// also gets a pulsing dot, gated by prefers-reduced-motion in CSS), a not-yet-its-turn item is
// dimmed, and everything terminal/quiet is neutral. Pure string → string.
export type Emphasis = "attn" | "active" | "blocked" | "done";
export function swimEmphasis(st: string): Emphasis {
  if (st === "needs_info" || st === "needs_user_input") return "attn";
  if (st === "in_progress" || st === "idle") return "active";
  if (st === "blocked" || st === "inactive" || st === "merge_blocked") return "blocked";
  return "done"; // in_review / merged / done / failed / aborted / rolled_back … — quiet
}

// A COMPACT lane title from a story's brief. A butchr node has no short-title field — only `brief`,
// which is a multi-thousand-char spec whose FIRST LINE alone can run hundreds of chars. Take the
// first non-empty line and hard-clamp it (~70 chars, trailing whitespace trimmed, single ellipsis)
// so the header never becomes a wall of text; the full brief still lives in the header tooltip. The
// CSS belt on .swim-title (nowrap + ellipsis) is the second line of defence. Falls back to the id.
export function laneTitle(brief: string | null | undefined, id: string, max = 70): string {
  const first = String(brief || "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!first) return id;
  return first.length > max ? first.slice(0, max).trimEnd() + "…" : first;
}
