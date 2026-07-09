// The SWIMLANES view — the workspace body's "Pipeline" tab. Extracted from app.js (RFC Phase 2).
//
// It owns the whole pipeline surface: the `renderSwimlanes` entry point, the swim* builders, the
// pure intra-lane ordering helpers (orderLaneLeaves / swimEmphasis / laneTitle), the front-end-
// derived story lifecycle (storyLifecycle / storyProgress / storyLifecycleChip), and the one piece
// of module state that surface needs — SWIM_DONE_EXPANDED.
//
// It imports only LEAVES — `core/` (dom, work-graph) and `components/chips.js` — never app.js. The
// `views/ -> app.js` edge must never exist: app.js's boot touches `document` at load, so that edge
// would drag a DOM into every view's module graph and break `bun test`. See the header of
// core/nav.js. This view needs no state from app.js: renderSwimlanes takes `work` as an argument
// and buildSwimlanes takes the `repaint` callback, so the dependency stays inverted.
//
// DOM-free at module load: SWIM_DONE_EXPANDED is a Set, and `document` is touched only inside a
// CALLED function (via `el`/`svg`), so test/swimlane-order.test.ts and test/story-lifecycle-ui.test.ts
// import this module directly under bun test and assert on the real exports. Those helpers used to
// be fenced by `<test-extract:...>` sentinels and eval'd out of the classic app.js script with
// `new Function`, because a classic script could not be imported. That harness is gone — do not
// reintroduce a sentinel here.
//
// This view is fully NODE-BUILT: no esc(), no el() `html:` bridge, no htmlOf(). Every text child
// goes through el()'s createTextNode, so escaping is structural rather than the author's job. The
// one remaining `innerHTML` touch is `wrap.innerHTML = ""` in renderSwimlanes — a repaint CLEAR,
// which escapes nothing. Do not reintroduce a template literal here.
//
// ⚠ The literal SPACES passed as string children below (" " between two inline elements) are REAL
// text nodes and are the rendered gap between them. They came over verbatim from the template
// literals this file used to build. Do not "tidy" them away.
import { el, svg } from "../core/dom.js";
import { effStatus, kindBadge } from "../components/chips.js";
import {
  graphChildOf,
  graphLevels,
  isCompleteStatus,
  isHistoryItem,
  storyMemberIds,
  storySubtaskTotal,
} from "../core/work-graph.js";

// Story ids whose collapsed "N done" pile is EXPANDED in the Pipeline (swimlanes) view. Kept at
// MODULE scope so an expanded pile survives the full re-render the app does on every SSE event.
// Pruned against the live work-id set on each workspace render (app.js's renderWorkspace, via
// pruneWorkCaches) so it can't grow unbounded across a long session.
export const SWIM_DONE_EXPANDED = new Set();

// Story lifecycle — a SECONDARY, purely front-end-DERIVED signal (story st-f4858e23 ask #4) so a
// story container doesn't just read "OPEN". Derived from data every StoryView already carries —
// the per-status `counts` rollup + leader{running,desired} + status — with NO new backend field.
// Scoped to OPEN stories ONLY: merging / merge_blocked / done already carry a descriptive status
// chip, so signaling them here would just double up. Returns one LIFECYCLE entry, or null when
// there's nothing to add (non-open story / not a node). Precedence, robust to empty counts:
//   ▶ working — subtasks in flight, or the leader is up driving actionable work
//   ⏸ parked  — open but nothing in flight (just-created, or all children finished-yet-open)
//   ⚠ stalled — work remains but the leader that should drive it is DESIRED yet DOWN (nothing moving)
const LIFECYCLE = {
  working: { key: "working", glyph: "▶", cls: "working" },
  parked:  { key: "parked",  glyph: "⏸", cls: "parked"  },
  stalled: { key: "stalled", glyph: "⚠", cls: "stalled" },
};
export function storyLifecycle(story) {
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
// isCompleteStatus) over the TRUE total (storySubtaskTotal, which drops the idle
// pseudo-bucket). Distinct from the graph's dependency-subtree bar (gatedSubtree). total is 0 for a
// childless story, so callers gate the "d/t done" render on total > 0.
export function storyProgress(counts) {
  const c = counts || {};
  const done = Object.keys(c).reduce((n, k) => (isCompleteStatus(k) ? n + (c[k] || 0) : n), 0);
  return { done, total: storySubtaskTotal(c) };
}
// The lifecycle CHIP (a NODE) for a story's lane header — null when there's no lifecycle to show;
// the one call site guards, and el() skips a null child anyway. Subtle by design (see .chip.lc-*):
// it must not compete with the colored status chip or the S1 kind badge.
//
// It used to return an HTML string that began with a literal " " — the gap between it and the
// status chip before it. That space is now the caller's, emitted as its own text child.
export function storyLifecycleChip(story) {
  const lc = storyLifecycle(story);
  if (!lc) return null;
  return el("span", { class: "chip lc-" + lc.cls, title: "story lifecycle — " + lc.key },
    lc.glyph + " " + lc.key);
}

// ---------- pipeline swimlanes (workspace "Pipeline" view) ----------
// Per-story horizontal LANES that replace the old force-directed dependency DAG. Each ACTIVE
// story is a lane; its subtask leaves run left → right in blocked_by order as a pipeline of
// status pills joined by a single arrow (the blocked_by flow). Membership is shown by the lane
// itself — there are NO child-of edges and no double-drawn story node. Finished subtasks collapse
// behind a per-lane toggle. Cross-story blockers surface as a small labeled badge on the affected
// step. Front-end only, plain HTML/flex (no SVG layout engine); re-rendered wholesale on every SSE
// event by the workspace view, so it live-updates for free. Status colors are the SHARED
// .chip.<status> palette (identical vocabulary to List + Board) — this view adds only a small
// EMPHASIS layer on the card (attention lit, in-flight pulsing) via swimEmphasis; it does NOT fork
// a divergent palette.

// Pure, DOM-free intra-lane ordering, unit-tested in test/swimlane-order.test.ts. Orders a story's
// own leaf ids left → right by longest blocked_by chain WITHIN the lane (reusing graphLevels over
// the intra-lane edges), ties broken by the item's original index so the layout is STABLE across
// renders. Cross-story blockers are ignored for ordering — only blocked_by edges BETWEEN the passed
// member ids count, so a foreign blocker never shifts a lane's columns. Pure: no DOM, no globals
// beyond graphLevels.
export function orderLaneLeaves(memberIds, byId) {
  const idSet = new Set(memberIds);
  const edges = [];
  for (const id of memberIds) {
    const w = byId.get(id);
    if (!w) continue;
    for (const b of (w.blocked_by || [])) {
      if (idSet.has(b)) edges.push({ from: b, to: id });
    }
  }
  const level = graphLevels(idSet, edges);
  const idx = new Map(memberIds.map((id, i) => [id, i]));
  return [...memberIds].sort((a, b) => (level[a] - level[b]) || (idx.get(a) - idx.get(b)));
}
// Semantic EMPHASIS bucket for a subtask's CARD (not its pill color). The pill keeps its real
// .chip.<status> color — the one shared status vocabulary; this only decides which card is visually
// LOUD so exactly one thing pulls the eye: an ATTENTION item (needs_info / a live agent wedged at a
// human prompt) gets a bright ring, an in-flight item a gentle accent (in_progress also gets a
// pulsing dot, gated by prefers-reduced-motion in CSS), a not-yet-its-turn item is dimmed, and
// everything terminal/quiet is neutral. Pure string → string.
export function swimEmphasis(st) {
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
// Pure string → string.
export function laneTitle(brief, id, max = 70) {
  const first = String(brief || "").split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  if (!first) return id;
  return first.length > max ? first.slice(0, max).trimEnd() + "…" : first;
}

// A single arrow connector between two pipeline steps — the ONE edge vocabulary (blocked_by flow).
function swimConn() {
  return el("div", { class: "swim-conn", "aria-hidden": "true" }, [
    svg("svg", { class: "swim-conn-svg", viewBox: "0 0 26 14" }, [
      svg("path", { d: "M0 7h20m0 0l-5-4m5 4l-5 4", fill: "none", stroke: "currentColor", "stroke-width": "1.5" }),
    ]),
  ]);
}

// One pipeline STEP: a status-colored, clickable card for a subtask leaf. Links to the task detail
// (an <a>, so it's keyboard-focusable with a visible focus ring from CSS). The status pill reuses
// .chip.<status>; a live in_progress agent gets the lone pulsing dot. A blocker that lives in
// ANOTHER lane (not among this story's members) surfaces as a small "⤴ blocked by …" badge so the
// rare cross-story dependency isn't silently dropped.
function swimStep(leaf, memberSet, byId) {
  const st = effStatus(leaf);
  const emph = swimEmphasis(st);
  const dot = st === "in_progress" ? el("span", { class: "swim-dot", "aria-hidden": "true" }) : null;
  const foreign = (leaf.blocked_by || []).filter((b) => !memberSet.has(b) && byId.has(b));
  // The parts run together with NO separator — the template literal this replaced joined them on "".
  const parts = [
    el("div", { class: "swim-step-top" }, [
      el("span", { class: "chip " + st }, [dot, st]),
      emph === "attn" ? el("span", { class: "swim-needs" }, "needs you") : null,
    ]),
    el("span", { class: "swim-sid" }, leaf.id),
  ];
  // A LEAF's description lives in `summary` (its `brief` is always null); it's null until the
  // agent writes one, so a not-yet-run subtask is honestly id-only.
  if (leaf.summary && leaf.summary !== leaf.id) parts.push(el("span", { class: "swim-sum" }, leaf.summary));
  if (foreign.length) {
    parts.push(el("span", { class: "swim-xdep", title: "blocked by work in another lane" },
      "⤴ blocked by " + foreign.join(", ")));
  }
  return el("a", {
    class: "swim-step is-" + emph,
    href: "#/task/" + leaf.id,
    "aria-label": `subtask ${leaf.id} — ${st}`,
  }, parts);
}

// One story LANE: header (kind badge · title · id · status + lifecycle chips · progress) over a
// horizontally-scrollable pipeline of its ACTIVE subtasks. A childless / all-finished story shows a
// compact parked empty-row INSIDE the lane (never a bare box). Finished subtasks collapse behind a
// per-lane "N done" toggle whose expanded state lives in SWIM_DONE_EXPANDED (survives SSE renders).
function swimLane(story, byId, allIds, repaint) {
  const st = effStatus(story);
  const p = storyProgress(story.counts);
  const prog = p.total
    ? [
        el("span", { class: "swim-track" }, [el("i", { style: `width:${Math.round((100 * p.done) / p.total)}%` })]),
        el("span", { class: "swim-prog-txt" }, `${p.done} / ${p.total} done`),
      ]
    : [el("span", { class: "swim-prog-txt" }, "not started")];
  // Compact one-line title (clamped) for display; the FULL brief goes in the tooltip.
  const title = laneTitle(story.brief, story.id);
  const fullTitle = story.brief || story.id;
  // The lifecycle chip's leading SPACE is a real text node — the gap after the status chip. It
  // belongs to this call site now that storyLifecycleChip returns a bare node (or null).
  const lc = storyLifecycleChip(story);
  const hd = el("div", { class: "swim-hd" }, [
    el("span", { class: "swim-kind" }, [kindBadge("node")]),
    el("span", { class: "swim-title", title: fullTitle }, title),
    el("span", { class: "swim-laneid" }, story.id),
    el("div", { class: "swim-meta" }, [
      el("span", { class: "chip " + st }, st),
      ...(lc ? [" ", lc] : []),
      el("div", { class: "swim-prog" }, prog),
    ]),
  ]);

  const members = storyMemberIds(story.id, allIds, byId);
  const memberSet = new Set(members);
  const active = members.filter((id) => !isHistoryItem(byId.get(id)));
  const done = members.filter((id) => isHistoryItem(byId.get(id)));

  const lane = el("div", { class: "swim-lane" }, [hd]);

  if (active.length === 0) {
    // HONEST empty state: genuinely childless → "no subtasks yet"; decomposed-but-all-finished
    // (or only-waiting) → a softer note. Reuses the shared parked lifecycle chip, no new palette.
    const childless = storySubtaskTotal(story.counts) === 0;
    const msg = childless
      ? "No subtasks yet — parked until the leader decomposes it."
      : "No active subtasks — all work is finished or waiting.";
    lane.appendChild(el("div", { class: "swim-empty" }, [
      el("span", { class: "chip lc-parked" }, "⏸ parked"),
      el("span", { class: "swim-empty-txt" }, msg),
    ]));
  } else {
    const ordered = orderLaneLeaves(active, byId);
    const pipe = el("div", { class: "swim-pipe" });
    ordered.forEach((id, i) => {
      if (i > 0) pipe.appendChild(swimConn());
      pipe.appendChild(swimStep(byId.get(id), memberSet, byId));
    });
    lane.appendChild(pipe);
  }

  if (done.length) lane.appendChild(swimDoneRow(story.id, done, byId, memberSet, repaint));
  return lane;
}

// Collapsed "N done" footer row for a lane; expands in place to reveal the finished subtasks as a
// second, dimmed pipeline. Keyboard-operable (role=button + Enter/Space). Expanded state keyed by
// story id in the module-level SWIM_DONE_EXPANDED set, so it persists across SSE re-renders.
function swimDoneRow(storyId, done, byId, memberSet, repaint) {
  const open = SWIM_DONE_EXPANDED.has(storyId);
  const wrap = el("div", { class: "swim-done" });
  const toggle = () => {
    if (SWIM_DONE_EXPANDED.has(storyId)) SWIM_DONE_EXPANDED.delete(storyId);
    else SWIM_DONE_EXPANDED.add(storyId);
    repaint();
  };
  // NOT a `Button`: this is a `div[role=button]` styled by .swim-done-row (a quiet inline caret
  // row), not a `.btn`. Adopting the shared Button would swap the tag and the whole class contract.
  // `onclick`/`onkeydown` stay FUNCTION props — el() attaches a function prop as a listener.
  const row = el("div", {
    class: "swim-done-row", role: "button", tabindex: "0", "aria-expanded": open ? "true" : "false",
    onclick: toggle,
    onkeydown: (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle(); } },
  }, [
    el("span", { class: "swim-done-caret" }, open ? "▾" : "▸"),
    ` ${done.length} done`, // the leading space is the gap after the caret
  ]);
  wrap.appendChild(row);
  if (open) {
    const pipe = el("div", { class: "swim-pipe swim-done-pipe" });
    orderLaneLeaves(done, byId).forEach((id, i) => {
      if (i > 0) pipe.appendChild(swimConn());
      pipe.appendChild(swimStep(byId.get(id), memberSet, byId));
    });
    wrap.appendChild(pipe);
  }
  return wrap;
}

// A catch-all lane for ACTIVE leaves whose owning story isn't a node present in this list (an
// orphan, or a subtask of an already-finished story). Ensures NO active work is ever silently
// dropped from the view. No progress/lifecycle header — it isn't a real story.
function swimUngroupedLane(leaves, byId) {
  const ids = leaves.map((w) => w.id);
  const memberSet = new Set(ids);
  // The badge is now the SHARED kindBadge(), not hand-rolled markup: kindVisual("ungrouped") hits
  // its unmapped-kind fallback and yields exactly the classes this lane already used
  // (`kind-badge kind-unknown`) and the same "• UNGROUPED" glyph+label. Only the tooltip changes —
  // `title="ungrouped"` becomes the emitter's own `title="UNGROUPED"` — which is the hand-rolled
  // copy's drift from every other badge in the app, not a property worth preserving.
  const hd = el("div", { class: "swim-hd" }, [
    el("span", { class: "swim-kind" }, [kindBadge("ungrouped")]),
    el("span", { class: "swim-title" }, "Ungrouped work"),
    el("span", { class: "swim-laneid" }, "no owning story"),
  ]);
  const lane = el("div", { class: "swim-lane swim-lane-ungrouped" }, [hd]);
  const pipe = el("div", { class: "swim-pipe" });
  orderLaneLeaves(ids, byId).forEach((id, i) => {
    if (i > 0) pipe.appendChild(swimConn());
    pipe.appendChild(swimStep(byId.get(id), memberSet, byId));
  });
  lane.appendChild(pipe);
  return lane;
}

// A quiet legend of the semantic emphasis vocabulary, reusing the SHARED status color vars (so the
// swatches can't drift from the .chip palette). Purely explanatory; not interactive.
function swimLegend() {
  const items = [
    ["in_progress", "in progress"],
    ["needs_info", "needs you"],
    ["blocked", "blocked (waiting its turn)"],
    ["merged", "done"],
    ["lc-parked", "parked"],
  ];
  // No separator BETWEEN the items (the template joined on ""), but each carries the literal space
  // between its swatch and its label.
  return el("div", { class: "swim-legend" }, items.map(([cls, txt]) =>
    el("span", {}, [el("i", { class: "swim-ldot " + cls }), " ", txt])));
}

// The Pipeline view entry point (the sole workspace-body work view). Builds into a wrapper it can
// repaint in place, so a lane's done-toggle re-renders instantly without waiting for the next SSE tick.
export function renderSwimlanes(work) {
  const wrap = el("div", { class: "swim-wrap" });
  const paint = () => { wrap.innerHTML = ""; buildSwimlanes(work, wrap, paint); };
  paint();
  return wrap;
}

function buildSwimlanes(work, wrap, repaint) {
  const list = Array.isArray(work) ? work : [];
  const byId = new Map(list.map((w) => [w.id, w]));
  const allIds = new Set(byId.keys());
  // A leaf is "grouped" when its owning id resolves to a STORY node present in this list.
  const ownedByPresentStory = (w) => {
    const parent = byId.get(graphChildOf(w));
    return !!parent && parent.work_kind === "node";
  };
  const stories = list.filter((w) => w.work_kind === "node" && !isHistoryItem(w));
  const ungrouped = list.filter((w) =>
    w.work_kind === "leaf" && !isHistoryItem(w) && !ownedByPresentStory(w));

  wrap.appendChild(el("div", { class: "swim-caption" }, [
    el("b", {}, "Work pipeline."),
    " Each story is a lane; its subtasks run left → right in the order they " +
    "unblock. The item that needs you is the only thing lit; finished work collapses away.",
  ]));
  wrap.appendChild(swimLegend());

  if (stories.length === 0 && ungrouped.length === 0) {
    wrap.appendChild(el("div", { class: "empty" }, "No active work to show."));
    return;
  }

  const lanes = el("div", { class: "swim-lanes" });
  for (const s of stories) lanes.appendChild(swimLane(s, byId, allIds, repaint));
  if (ungrouped.length) lanes.appendChild(swimUngroupedLane(ungrouped, byId));
  wrap.appendChild(lanes);
}
