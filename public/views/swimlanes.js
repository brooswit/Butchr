// The SWIMLANES view — the workspace body's "Pipeline" tab. Extracted from app.js (RFC Phase 2).
//
// It owns the DOM half of the pipeline surface: the `renderSwimlanes` entry point, the swim*
// builders, the lifecycle chip, and the one piece of module state that surface needs —
// SWIM_DONE_EXPANDED. The pure helpers it renders (storyLifecycle / storyProgress /
// orderLaneLeaves / swimEmphasis / laneTitle) live in the DOM-free leaf views/swimlanes-logic.js,
// split out by the RFC Phase 2 horizontal cut (§0.1 #5). They are NOT re-exported from here.
//
// It imports only LEAVES — `core/` (dom, work-graph, api), `components/chips.js`, and (for the lane
// header's "Open Leader terminal" control) `components/button.js` + `components/toast.js` — never
// app.js. The `views/ -> app.js` edge must never exist: app.js's boot touches `document` at load, so
// that edge would drag a DOM into every view's module graph and break `bun test`. See the header of
// core/nav.js. The widened set stays leaf-only and DOM-free AT LOAD: core/api.js imports nothing,
// and button.js -> toast.js -> core/nav.js touches `document`/`location` only inside CALLED
// functions. This view needs no state from app.js: renderSwimlanes takes `work` as an argument
// and buildSwimlanes takes the `repaint` callback, so the dependency stays inverted.
//
// DOM-free at module load: SWIM_DONE_EXPANDED is a Set, and `document` is touched only inside a
// CALLED function (via `el`/`svg`), so test/story-lifecycle-ui.test.ts imports this module directly
// under bun test and asserts on the real storyLifecycleChip. Those helpers used to be fenced by
// `<test-extract:...>` sentinels and eval'd out of the classic app.js script with `new Function`,
// because a classic script could not be imported. That harness is gone — do not reintroduce a
// sentinel here.
//
// This view is fully NODE-BUILT. Every text child goes through el()'s createTextNode, so escaping
// is structural rather than the author's job — the esc()/`{html:}`/htmlOf() escape hatches no longer
// exist. The one remaining `innerHTML` touch is `wrap.innerHTML = ""` in renderSwimlanes — a repaint
// CLEAR, which escapes nothing and is the one form test/no-opt-in-escaping.test.ts still allows. Do
// not reintroduce a template literal here.
//
// ⚠ The literal SPACES passed as string children below (" " between two inline elements) are REAL
// text nodes and are the rendered gap between them. They came over verbatim from the template
// literals this file used to build. Do not "tidy" them away.
import { el, svg } from "../core/dom.js";
import { kindBadge } from "../components/chips.js";
import { effStatus } from "../components/chips-logic.js";
import {
  graphChildOf,
  isHistoryItem,
  storyMemberIds,
  storySubtaskTotal,
} from "../core/work-graph.js";
import { Button } from "../components/button.js";
import { terminalToast } from "../components/toast.js";
import { api } from "../core/api.js";
import {
  laneTitle,
  leaderTerminalBtnState,
  orderLaneLeaves,
  storyLifecycle,
  storyProgress,
  swimEmphasis,
} from "./swimlanes-logic.js";

// Story ids whose collapsed "N done" pile is EXPANDED in the Pipeline (swimlanes) view. Kept at
// MODULE scope so an expanded pile survives the full re-render the app does on every SSE event.
// Pruned against the live work-id set on each workspace render (app.js's renderWorkspace, via
// pruneWorkCaches) so it can't grow unbounded across a long session.
export const SWIM_DONE_EXPANDED = new Set();

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

// "Open Leader terminal" → POST /api/work/:id/leader/terminal (the story-leader analog of the
// CTO/CEO terminal routes, same attach payload). Gated by the PURE leaderTerminalBtnState, which
// reads `story.leader` — the StoryAgentStatus the NodeWorkView already carries off GET /api/work,
// so no extra fetch. Enabled only when the leader is live; otherwise it stays VISIBLE but disabled
// with an honest title (see that helper for why we disable rather than hide). The listener is
// attached ONLY when enabled.
//
// Routed through Button's `onAction` (= action()): disable → await → toast the error and re-enable
// on failure. The two non-default flags are load-bearing, exactly as on the CEO button:
//   restoreOnSuccess — re-enable on BOTH paths.
//   onDone: no-op    — action()'s DEFAULT onDone is render(). Attaching a terminal does not
//                      navigate; a bare Button() would re-render the view out from under it.
// terminalToast(r) fires inside the fn, so no `success` string is passed.
function leaderTerminalBtn(story) {
  const term = leaderTerminalBtnState(story.leader);
  return Button({
    label: "⌗ Open Leader terminal",
    class: "ghost xs",
    title: term.title,
    disabled: !term.enabled,
    onAction: term.enabled
      ? async () => {
        const r = await api("POST", "/work/" + encodeURIComponent(story.id) + "/leader/terminal");
        terminalToast(r);
      }
      : undefined,
    restoreOnSuccess: true,
    onDone: () => {},
  });
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
      " ",
      leaderTerminalBtn(story),
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
