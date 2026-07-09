// The CHIP + BADGE cluster — every small, self-contained status/kind/tag pill the dashboard
// renders. Each helper returns an HTML STRING (the pre-Phase-4 authoring model), so they slot
// into any innerHTML cluster; Phase 4 of the RFC converts them to `(props) => HTMLElement`
// innermost-first (docs/rfc-frontend-design-system.md §"Phase 4"). Keeping the markup for a
// given badge in exactly ONE place here is what stops a chip's look from drifting across the
// views that render it.
//
// DOM-free at module load, like everything under core/: nothing here touches `document`, so
// this module imports cleanly under a non-browser test runner (test/kind-badge.test.ts imports
// it directly and asserts on the real exports).
//
// AGENT_TYPE is an `export let` in core/state-meta.js that applyStateMeta REASSIGNS once
// /api/state-meta lands. Import it as a NAMED BINDING and read it at CALL time (as taskChips
// does) — never destructure it into a local const, which would snapshot the empty pre-load
// table and silently break every status chip.
import { esc } from "../core/dom.js";
import { AGENT_TYPE, stateKind, statusLabel } from "../core/state-meta.js";

export function chip(status) {
  return `<span class="chip ${esc(status)}">${esc(statusLabel(status))}</span>`;
}

// What an operator is AWAITING for each feedback state (chip hint). Pure UI copy — these
// strings have no source in db.ts, so they are deliberately NOT part of the served state
// metadata (unlike the kind/agent-type tables in core/state-meta.js, which the server owns).
export const AWAITED_LABEL = {
  idea: "a spec",
  spec_review: "spec approval",
  in_review: "diff review",
  needs_info: "response to raised item",
  needs_user_input: "your answer at the terminal",
};
// Who is EXPECTED to act on a feedback task, read from the server-computed STRUCTURAL
// `pending_responder` (story|cto|user — see tasks.pendingResponder). butchr is
// responder-agnostic, so the action controls are always available; this is emphasis only.
// `user` is surfaced prominently ("awaiting you") since it needs a human; `cto` / `story`
// are muted ("you can also act") since an agent (the CTO, or the story leader) handles it
// but a human may still act. Returns "" when the task isn't awaiting feedback (responder null).
export function responderChip(t) {
  const r = t && t.pending_responder;
  if (r === "user") {
    return ' <span class="chip awaiting-you" title="this is assigned to YOU — act in the controls below">awaiting you</span>';
  }
  if (r === "cto") {
    return ' <span class="chip awaiting-cto" title="this is assigned to the CTO agent (handled automatically) — you can also act">awaiting CTO</span>';
  }
  if (r === "story") {
    return ' <span class="chip awaiting-cto" title="this is assigned to the story leader (handled automatically) — you can also act">awaiting leader</span>';
  }
  return "";
}
// Human-facing label for the feedback surface a task is currently on — derived from its
// status (+ the needs_info plan-vs-question split on plan_preview). Used only for the
// awaiting-who banner copy on the task detail. null for a non-feedback state.
export function feedbackStepLabel(t) {
  // needs_user_input WINS over idle — a live agent wedged at a human-only prompt (the more
  // specific, highest-attention signal), so check it first.
  if (t.status === "in_progress" && t.needs_user_input) return "your input";
  // Idle is orthogonal to status — a flag on a LIVE in_progress agent — but it IS a
  // feedback condition (the agent went quiet and needs its responder to act).
  if (t.status === "in_progress" && t.idle) return "idle handling";
  switch (t.status) {
    case "idea": return "spec generation";
    case "spec_review": return "spec approval";
    case "in_review": return "diff review";
    case "needs_info": return t.plan_preview ? "plan approval" : "answering the question";
    default: return null;
  }
}
export function awaitedLabel(status) {
  return AWAITED_LABEL[status] || null;
}
// `idle` and `needs_user_input` are flags on an in_progress task (the agent is alive but
// its CLI has gone quiet / is wedged at a human-only prompt), not real lifecycle statuses.
// Render each as its own synthetic chip in place of "in progress". `needs_user_input` WINS
// over `idle` — the more specific, highest-attention signal — mirroring the server's
// attentionKind precedence (tasks.attentionReason).
export function effStatus(t) {
  if (t.status === "in_progress" && t.needs_user_input) return "needs_user_input";
  return t.status === "in_progress" && t.idle ? "idle" : t.status;
}
// A single GENERIC kind -> visual lookup. Every work-item and every agent surface reads
// its badge from this ONE table, so adding a future kind (REVAMP-4's container `repo`/
// `project`, or new agent perspectives) is ONE new row here — never a new code branch.
// `node`/`leaf` are the authoritative work_kind values (STORY container / TASK leaf);
// `cto`/`leader`/`build` are the structurally-known agent kinds passed in by each render
// site (there is no agent-`kind` field on the wire). Unknown kinds fall back to a generic
// neutral badge (see kindVisual) so the UI never crashes on an unmapped kind.
export const KIND_VISUAL = {
  node:   { label: "STORY",  glyph: "◈", cls: "node"   }, // ◈ container work-item
  leaf:   { label: "TASK",   glyph: "▪", cls: "leaf"   }, // ▪ leaf work-item
  cto:    { label: "CTO",    glyph: "★", cls: "cto"    }, // ★ per-repo dev/CTO agent
  ceo:    { label: "CEO",    glyph: "♛", cls: "ceo"    }, // ♛ per-project supervisor agent
  leader: { label: "LEADER", glyph: "◆", cls: "leader" }, // ◆ story-leader agent
  build:  { label: "BUILD",  glyph: "⚙", cls: "build"  }, // ⚙ leaf build agent
};
// Resolve a kind to its visual, with a safe fallback for an unmapped kind: a neutral
// badge glyphed "•" and labelled with the raw kind uppercased (never throws).
export function kindVisual(k) {
  return KIND_VISUAL[k] || { label: String(k || "?").toUpperCase(), glyph: "•", cls: "unknown" };
}
// The shared kind-badge emitter — an outlined pill (label + glyph) for a work-item or
// agent kind, returned as an HTML string so it slots into any innerHTML cluster.
export function kindBadge(k) {
  const v = kindVisual(k);
  return `<span class="kind-badge kind-${esc(v.cls)}" title="${esc(v.label)}">${esc(v.glyph)} ${esc(v.label)}</span>`;
}
// Renders a task's badge cluster — the status chip plus the optional plan-preview /
// conflict badges — as an HTML string. Each badge's markup lives here only, so how
// a chip *looks* can't drift across the views. Which badges a view shows stays the
// caller's call (History/table stay lean, the detail header shows all), passed via
// opts; taskChips renders exactly the set requested. The conflict badge is always
// included when set — every view already shows it.
// `plan` shows the plan-preview badge (if the task opted into that gate); `kind` shows
// a small state-kind chip (agent/feedback/idle) plus for feedback states the awaited
// artifact label — surfacing the canonical 3-kind model in the UI.
export function taskChips(t, { plan = false, kind = false, responder = false } = {}) {
  const st = effStatus(t);
  const kindStr = stateKind(st);
  const awaited = awaitedLabel(st);
  const kindChip = kind
    ? ` <span class="chip state-kind state-kind-${esc(kindStr)}" title="${esc(
        kindStr === "feedback"
          ? "feedback state — awaiting " + (awaited || "operator response")
          : kindStr === "agent"
          ? "agent state — " + (AGENT_TYPE[st] || "agent") + " is running"
          : "idle state"
      )}">${esc(kindStr)}${awaited ? ": " + esc(awaited) : ""}</span>`
    : "";
  // Key off the AUTHORITATIVE work_kind (not a hardcoded 'leaf') — taskChips renders both
  // TASKS ('leaf') and STORIES ('node'), so a literal would mislabel a story '▪ TASK'.
  // kindVisual() has a safe fallback either way.
  return kindBadge(t.work_kind) + " "
    + (plan && t.plan_preview ? '<span class="chip plan" title="plan-preview gate — proposes a plan and pauses for approval before writing code">plan-preview</span> ' : "")
    + chip(st)
    + kindChip
    + (responder ? responderChip(t) : "")
    + (t.conflict ? ' <span class="chip aborted">conflict</span>' : "")
    // A non-zero dispatch priority jumps the queue — flag it so its order is visible
    // (priority 0 is the silent FIFO default, shown on no card).
    + (Number(t.priority) ? ` <span class="chip priority" title="dispatch priority — higher runs sooner">prio ${esc(String(t.priority))}</span>` : "")
    // The version butchr stamped at merge in a release_mode workspace (released_version
    // on the task view; NULL otherwise). Rendered once here so the merged version shows
    // wherever the badge cluster does — detail header, table row, board card, history.
    + (t.released_version ? ` <span class="chip released" title="version butchr stamped at merge">v${esc(t.released_version)}</span>` : "");
}
// Renders a task's organizational LABELS as a row of neutral chips (distinct from
// the colored status chips), as an HTML string. Returns "" when the task has no
// tags so callers can drop it in unconditionally. Tags are free-form operator
// labels set at creation — purely for filtering/organizing the list.
export function tagChips(t) {
  const tags = Array.isArray(t.tags) ? t.tags : [];
  if (!tags.length) return "";
  return `<span class="tag-chips">${tags
    .map((g) => `<span class="chip tag">${esc(g)}</span>`)
    .join("")}</span>`;
}

// The agent-liveness verdict (working/stalled/dead) as a colored chip — the idle/stall
// dispatcher step's judgement, so the operator reads it off the task view instead of
// probing herdr panes / /proc / the spinner by hand. Reuses the status-chip color classes
// (running=green, idle=amber, failed=red). Pass the t.liveness object.
export function livenessChip(lv) {
  const cls = lv.state === "working" ? "has-running" : lv.state === "stalled" ? "has-idle" : "has-failed";
  return `<span class="chip ${cls}">${esc(lv.state)}</span>`;
}
