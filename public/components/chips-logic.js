// The PURE half of the chip cluster — the lookup tables and the string→string predicates that
// decide WHAT a chip says, with no opinion about how it is drawn. Split out of components/chips.js
// by the RFC Phase 2 horizontal cut (RFC §0.1 #5): the real seam in this front end is pure-logic vs
// DOM-building, and it runs THROUGH modules rather than between directories.
//
// Zero imports, zero DOM — not even at call time. `effStatus` is read by four modules
// (components/chips.js, components/panel.js, views/workspace.js, views/swimlanes.js, views/task.js),
// so this is the leaf they share; the node emitters stay in components/chips.js.

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
