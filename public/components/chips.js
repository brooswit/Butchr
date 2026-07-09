// The CHIP + BADGE cluster — every small, self-contained status/kind/tag pill the dashboard
// renders. Each emitter returns a NODE (`(props) => HTMLElement`), the authoring model the RFC
// unifies on (docs/rfc-frontend-design-system.md §2.1, §"Phase 4"): nodes compose into nodes,
// and el() text children go through createTextNode, so escaping is STRUCTURAL rather than the
// author's job — this file has no esc() calls left. Keeping the markup for a given badge in
// exactly ONE place here is what stops a chip's look from drifting across the views.
//
// Every call site consumes these as NODES. The transitional `htmlOf(node)` bridge that once let an
// innerHTML template literal swallow a converted chip is DELETED, along with esc() and el()'s
// `{html:}` prop — there is no longer any way to turn a chip back into a markup string, and none
// is needed.
//
// DOM-FREE AT MODULE LOAD, like everything under core/ and components/: `document` is touched
// only INSIDE a called function (via el() / the frag+text helpers below), never at module scope.
// test/kind-badge.test.ts and test/state-meta-fallback.test.ts import this directly under bun,
// and test/cli-helpers.test.ts leans on the same property for a sibling module. A top-level
// `document` touch anywhere in this import graph breaks all three loudly.
//
// This file is now the DOM half only. The tables and predicates that decide what a chip SAYS
// (AWAITED_LABEL / feedbackStepLabel / awaitedLabel / effStatus / KIND_VISUAL / kindVisual) live in
// the DOM-free leaf components/chips-logic.js, per the RFC Phase 2 horizontal split (§0.1 #5).
// They are NOT re-exported from here: a consumer that needs only the logic must import the leaf,
// which is what keeps `el` out of its module graph.
//
// AGENT_TYPE is an `export let` in core/state-meta.js that applyStateMeta REASSIGNS once
// /api/state-meta lands. Import it as a NAMED BINDING and read it at CALL time (as taskChips
// does) — never destructure it into a local const, which would snapshot the empty pre-load
// table and silently break every status chip.
import { el } from "../core/dom.js";
import { AGENT_TYPE, stateKind, statusLabel } from "../core/state-meta.js";
import { awaitedLabel, effStatus, kindVisual } from "./chips-logic.js";

// Fragment + text-node helpers. Both touch `document` only when CALLED (see the module-load note
// above). The literal SPACES these emit are load-bearing: they are the rendered gap between
// sibling chips, and the separator layout is ASYMMETRIC (see taskChips).
const frag = () => document.createDocumentFragment();
const space = () => document.createTextNode(" ");

// `?? ""` mirrors what esc() used to absorb: a null/undefined status yielded a bare `class="chip"`
// rather than the literal string "undefined" in the class list.
export function chip(status) {
  return el("span", { class: "chip " + (status ?? "") }, statusLabel(status));
}

// Who is EXPECTED to act on a feedback task, read from the server-computed STRUCTURAL
// `pending_responder` (story|cto|user — see tasks.pendingResponder). butchr is
// responder-agnostic, so the action controls are always available; this is emphasis only.
// `user` is surfaced prominently ("awaiting you") since it needs a human; `cto` / `story`
// are muted ("you can also act") since an agent (the CTO, or the story leader) handles it
// but a human may still act. Returns null when the task isn't awaiting feedback (responder null);
// every call site guards, and el() skips a null child anyway.
//
// Returns a FRAGMENT carrying its own LEADING SPACE text node — the string version began with a
// literal " ", and that space is the gap between this chip and the one before it in taskChips.
//
// Nothing currently passes `responder: true`, so this is prod-dead but exported. Deleting it is a
// separate cleanup story's call, not this subtask's.
export function responderChip(t) {
  const r = t && t.pending_responder;
  const badge = r === "user"
    ? el("span", { class: "chip awaiting-you", title: "this is assigned to YOU — act in the controls below" }, "awaiting you")
    : r === "cto"
    ? el("span", { class: "chip awaiting-cto", title: "this is assigned to the CTO agent (handled automatically) — you can also act" }, "awaiting CTO")
    : r === "story"
    ? el("span", { class: "chip awaiting-cto", title: "this is assigned to the story leader (handled automatically) — you can also act" }, "awaiting leader")
    : null;
  if (!badge) return null;
  const f = frag();
  f.appendChild(space());
  f.appendChild(badge);
  return f;
}
// The shared kind-badge emitter — an outlined pill (label + glyph) for a work-item or
// agent kind, returned as a NODE.
export function kindBadge(k) {
  const v = kindVisual(k);
  return el("span", { class: "kind-badge kind-" + v.cls, title: v.label }, v.glyph + " " + v.label);
}
// Renders a task's badge cluster — the status chip plus the optional plan-preview /
// conflict badges — as a DocumentFragment. Each badge's markup lives here only, so how
// a chip *looks* can't drift across the views. Which badges a view shows stays the
// caller's call (History/table stay lean, the detail header shows all), passed via
// opts; taskChips renders exactly the set requested. The conflict badge is always
// included when set — every view already shows it.
// `plan` shows the plan-preview badge (if the task opted into that gate); `kind` shows
// a small state-kind chip (agent/feedback/idle) plus for feedback states the awaited
// artifact label — surfacing the canonical 3-kind model in the UI.
//
// ⚠ THE SEPARATOR LAYOUT IS ASYMMETRIC — do not "tidy" it into a uniform join. Reproduced
// from the string version exactly: the kind badge and the plan-preview chip each carry a
// TRAILING space, while the state-kind, responder, conflict, priority and released chips
// each carry a LEADING space. The status chip has neither. Every space below is a real text
// node in the fragment, and it is the rendered gap between two chips.
export function taskChips(t, { plan = false, kind = false, responder = false } = {}) {
  const st = effStatus(t);
  const kindStr = stateKind(st);
  const awaited = awaitedLabel(st);
  const f = frag();

  // Key off the AUTHORITATIVE work_kind (not a hardcoded 'leaf') — taskChips renders both
  // TASKS ('leaf') and STORIES ('node'), so a literal would mislabel a story '▪ TASK'.
  // kindVisual() has a safe fallback either way.
  f.appendChild(kindBadge(t.work_kind));
  f.appendChild(space()); // trailing

  if (plan && t.plan_preview) {
    f.appendChild(el("span", {
      class: "chip plan",
      title: "plan-preview gate — proposes a plan and pauses for approval before writing code",
    }, "plan-preview"));
    f.appendChild(space()); // trailing
  }

  f.appendChild(chip(st));

  if (kind) {
    f.appendChild(space()); // leading
    f.appendChild(el("span", {
      class: "chip state-kind state-kind-" + kindStr,
      title:
        kindStr === "feedback"
          ? "feedback state — awaiting " + (awaited || "operator response")
          : kindStr === "agent"
          ? "agent state — " + (AGENT_TYPE[st] || "agent") + " is running"
          : "idle state",
    }, kindStr + (awaited ? ": " + awaited : "")));
  }

  // responderChip carries its OWN leading space (it returns a fragment), or null.
  if (responder) {
    const rc = responderChip(t);
    if (rc) f.appendChild(rc);
  }

  if (t.conflict) {
    f.appendChild(space()); // leading
    f.appendChild(el("span", { class: "chip aborted" }, "conflict"));
  }

  // A non-zero dispatch priority jumps the queue — flag it so its order is visible
  // (priority 0 is the silent FIFO default, shown on no card).
  if (Number(t.priority)) {
    f.appendChild(space()); // leading
    f.appendChild(el("span", {
      class: "chip priority",
      title: "dispatch priority — higher runs sooner",
    }, "prio " + String(t.priority)));
  }

  // The version butchr stamped at merge in a release_mode workspace (released_version
  // on the task view; NULL otherwise). Rendered once here so the merged version shows
  // wherever the badge cluster does — detail header, table row, board card, history.
  if (t.released_version) {
    f.appendChild(space()); // leading
    f.appendChild(el("span", {
      class: "chip released",
      title: "version butchr stamped at merge",
    }, "v" + t.released_version));
  }

  return f;
}
// Renders a task's organizational LABELS as a row of neutral chips (distinct from
// the colored status chips), as a NODE. Returns null when the task has no tags
// (el() skips a null child, and the one call site already guards). Tags are free-form
// operator labels set at creation — purely for filtering/organizing the list.
//
// A tag is the one FREE-FORM string in this file, so it is where escaping matters most. It used to
// run through esc(); as an el() text child it goes through createTextNode instead, which cannot be
// forgotten. An apostrophe now stays a literal `'` rather than becoming `&#39;` — a difference in
// bytes only, never in the rendered DOM.
export function tagChips(t) {
  const tags = Array.isArray(t.tags) ? t.tags : [];
  if (!tags.length) return null;
  return el("span", { class: "tag-chips" }, tags.map((g) => el("span", { class: "chip tag" }, g)));
}

// The agent-liveness verdict (working/stalled/dead) as a colored chip — the idle/stall
// dispatcher step's judgement, so the operator reads it off the task view instead of
// probing herdr panes / /proc / the spinner by hand. Reuses the status-chip color classes
// (running=green, idle=amber, failed=red). Pass the t.liveness object. Returns a NODE.
export function livenessChip(lv) {
  const cls = lv.state === "working" ? "has-running" : lv.state === "stalled" ? "has-idle" : "has-failed";
  return el("span", { class: "chip " + cls }, lv.state);
}
