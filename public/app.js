// butchr webapp — vanilla JS single-page app. Hash-routed, SSE live updates.
"use strict";

const app = document.getElementById("app");

// ---------- tiny helpers ----------
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function")
      node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}
// SVG sibling of el(): builds nodes in the SVG namespace so <svg>, <path>, <rect>,
// <text> etc. render correctly (createElement would put them in the HTML namespace
// and they'd be inert). Same attr/children contract as el().
const SVG_NS = "http://www.w3.org/2000/svg";
function svg(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.setAttribute("class", v);
    else if (k.startsWith("on") && typeof v === "function")
      node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}
function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
// CANONICAL STATUS LABELS for the 12-state model. Maps internal status keys to their
// friendly display labels. Any status not listed shows verbatim (fallback for
// unknown values from historical audit logs). The chip CSS class stays the raw status.
const STATUS_LABELS = {
  spec_review: "spec review",
  inactive: "ready",
  in_progress: "in progress",
  in_review: "in review",
  needs_info: "needs info",
  // Synthetic effStatus (a flag on a LIVE in_progress agent, like `idle`) — the agent is
  // wedged at a human-only OS/CLI prompt and needs a person to answer in its live pane.
  needs_user_input: "needs your input",
  rolling_back: "rolling back",
  rolled_back: "rolled back",
  idea: "idea",
  blocked: "blocked",
  merged: "merged",
  failed: "failed",
  aborted: "aborted",
  // STORY (node) statuses — stories share the unified work list with tasks, so their
  // statuses get friendly labels here too. `aborted` is shared with tasks (defined above).
  open: "open",
  done: "done",
  merging: "merging",
  merge_blocked: "merge blocked",
};
function statusLabel(status) {
  return STATUS_LABELS[status] || status;
}
function chip(status) {
  return `<span class="chip ${esc(status)}">${esc(statusLabel(status))}</span>`;
}
// CANONICAL STATE METADATA — owned by the SERVER, never hand-mirrored here. The
// 12-state machine's kind (idle/agent/feedback), per-state agent type, ordered status
// list, and terminal subset all live in src/db.ts (STATE_META / ALL_STATUSES /
// isTerminal) and are served at /api/state-meta. These tables are BUILT from that served
// meta once at boot (loadStateMeta / applyStateMeta, run before the first render), so a
// state-model change needs editing exactly one file. Declared `let` and start empty; the
// helpers and views read them live. If the meta is briefly unavailable the tables stay
// empty and everything degrades to safe defaults (no crash) rather than mirroring db.ts.
let STATE_KIND = {};        // status -> "idle" | "agent" | "feedback"
let AGENT_TYPE = {};        // status -> agent type (only for agent-kind states)
let ALL_STATUSES = [];      // every canonical status, server's stable order
let TERMINAL_STATUSES = []; // the terminal (Finished) subset
let ACTIVE_STATUSES = [];   // non-terminal statuses (stay in the active list)
// FILTER_STATUSES is ALL_STATUSES with the synthetic `idle` effStatus (an idle RUNNING
// task — see effStatus) spliced in after in_progress, so it filters independently.
let FILTER_STATUSES = [];
// False until a /api/state-meta fetch SUCCEEDS. While false the tables hold the built-in
// DEFAULT_STATE_META fallback (see below) and connectSSE retries the fetch on the next
// event, so a transient meta hiccup self-heals without a page reload.
let stateMetaLoaded = false;

// <test-extract:state-meta> — pure, DOM-free helpers unit-tested in
// test/state-meta-fallback.test.ts. Keep this block self-contained (no document / module
// state) so the test can eval it in isolation.
// SERVER-CANONICAL DEFAULTS — a hand-kept mirror of src/db.ts (STATE_META / ALL_STATUSES /
// isTerminal) in the exact shape /api/state-meta serves. Used ONLY as a FALLBACK when that
// fetch fails: without it the tables would be empty, and an empty ACTIVE_STATUSES makes
// boardLaneKey map every leaf to null → the board falsely reads "No active work" while the
// List view keeps everything "active". The served meta is authoritative and replaces these
// the moment the fetch succeeds (see loadStateMeta), so this drift-prone copy is only ever
// live during an outage. If db.ts's state model changes, update this mirror to match.
const DEFAULT_STATE_META = {
  stateMeta: {
    idea: { kind: "feedback" },
    spec_review: { kind: "feedback" },
    blocked: { kind: "idle" },
    needs_info: { kind: "feedback" },
    inactive: { kind: "agent", agentType: "workspace-agent" },
    in_progress: { kind: "agent", agentType: "workspace-agent" },
    in_review: { kind: "feedback" },
    merged: { kind: "idle" },
    rolling_back: { kind: "idle" },
    rolled_back: { kind: "idle" },
    failed: { kind: "idle" },
    aborted: { kind: "idle" },
  },
  allStatuses: [
    "idea", "spec_review", "blocked", "needs_info", "inactive", "in_progress",
    "in_review", "merged", "rolling_back", "rolled_back", "failed", "aborted",
  ],
  terminalStatuses: ["merged", "aborted", "failed", "rolled_back"],
};

// Build the six status tables from the served meta — or, when `meta` is missing/empty (a
// failed fetch), from DEFAULT_STATE_META so the returned sets are NEVER empty. Pure: returns
// the tables, touches no module state and no DOM (applyStateMeta assigns them in).
function statusSetsFrom(meta) {
  const ok = meta && Array.isArray(meta.allStatuses) && meta.allStatuses.length > 0;
  const src = ok ? meta : DEFAULT_STATE_META;
  const stateMeta = src.stateMeta || {};
  const all = src.allStatuses || [];
  const terminal = src.terminalStatuses || [];
  const STATE_KIND = {};
  const AGENT_TYPE = {};
  for (const s of all) {
    const m = stateMeta[s] || {};
    STATE_KIND[s] = m.kind || "idle";
    if (m.agentType) AGENT_TYPE[s] = m.agentType;
  }
  const FILTER = all.flatMap((s) => (s === "in_progress" ? [s, "needs_user_input", "idle"] : [s]));
  // Story (node) statuses live alongside task statuses in the unified work list, so the
  // filter chips must narrow stories too. Append the story-specific statuses not already
  // present (`aborted` is shared with tasks, so it's already in the set).
  for (const s of ["open", "done"]) if (!FILTER.includes(s)) FILTER.push(s);
  return {
    STATE_KIND,
    AGENT_TYPE,
    ALL_STATUSES: all.slice(),
    TERMINAL_STATUSES: terminal.slice(),
    ACTIVE_STATUSES: all.filter((s) => !terminal.includes(s)),
    FILTER_STATUSES: FILTER,
  };
}
// </test-extract:state-meta>

// Fetch the server-owned state metadata and (re)build every table above from it. Called once
// at boot BEFORE the first render, then re-tried on SSE events until it succeeds (see
// connectSSE). On failure the tables fall back to the non-empty DEFAULT_STATE_META so the
// board/list/filters keep working, and stateMetaLoaded stays false so the next event retries.
async function loadStateMeta() {
  try {
    applyStateMeta(await api("GET", "/state-meta"));
    stateMetaLoaded = true;
  } catch (e) {
    console.error("state-meta load failed; using built-in defaults, will retry on next event", e);
    applyStateMeta(DEFAULT_STATE_META);
  }
}
function applyStateMeta(meta) {
  const sets = statusSetsFrom(meta);
  STATE_KIND = sets.STATE_KIND;
  AGENT_TYPE = sets.AGENT_TYPE;
  ALL_STATUSES = sets.ALL_STATUSES;
  TERMINAL_STATUSES = sets.TERMINAL_STATUSES;
  ACTIVE_STATUSES = sets.ACTIVE_STATUSES;
  FILTER_STATUSES = sets.FILTER_STATUSES;
}

// What an operator is AWAITING for each feedback state (chip hint). Pure UI copy — these
// strings have no source in db.ts, so they are deliberately NOT part of the served state
// metadata (unlike the kind/agent-type tables above, which the server now owns).
const AWAITED_LABEL = {
  idea: "a spec",
  spec_review: "spec approval",
  in_review: "diff review",
  needs_info: "response to raised item",
  needs_user_input: "your answer at the terminal",
};
function stateKind(status) {
  // `needs_user_input` is a synthetic effStatus (not in the server's STATE_KIND table) — it
  // is a feedback condition (a human must answer), so surface it like the feedback states.
  if (status === "needs_user_input") return "feedback";
  return STATE_KIND[status] || "idle";
}
// Who is EXPECTED to act on a feedback task, read from the server-computed STRUCTURAL
// `pending_responder` (story|cto|user — see tasks.pendingResponder). butchr is
// responder-agnostic, so the action controls are always available; this is emphasis only.
// `user` is surfaced prominently ("awaiting you") since it needs a human; `cto` / `story`
// are muted ("you can also act") since an agent (the CTO, or the story leader) handles it
// but a human may still act. Returns "" when the task isn't awaiting feedback (responder null).
function responderChip(t) {
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
function feedbackStepLabel(t) {
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
function awaitedLabel(status) {
  return AWAITED_LABEL[status] || null;
}
// `idle` and `needs_user_input` are flags on an in_progress task (the agent is alive but
// its CLI has gone quiet / is wedged at a human-only prompt), not real lifecycle statuses.
// Render each as its own synthetic chip in place of "in progress". `needs_user_input` WINS
// over `idle` — the more specific, highest-attention signal — mirroring the server's
// attentionKind precedence (tasks.attentionReason).
function effStatus(t) {
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
// <test-extract:kind-badge>
const KIND_VISUAL = {
  node:   { label: "STORY",  glyph: "◈", cls: "node"   }, // ◈ container work-item
  leaf:   { label: "TASK",   glyph: "▪", cls: "leaf"   }, // ▪ leaf work-item
  cto:    { label: "CTO",    glyph: "★", cls: "cto"    }, // ★ per-repo dev/CTO agent
  leader: { label: "LEADER", glyph: "◆", cls: "leader" }, // ◆ story-leader agent
  build:  { label: "BUILD",  glyph: "⚙", cls: "build"  }, // ⚙ leaf build agent
};
// Resolve a kind to its visual, with a safe fallback for an unmapped kind: a neutral
// badge glyphed "•" and labelled with the raw kind uppercased (never throws).
function kindVisual(k) {
  return KIND_VISUAL[k] || { label: String(k || "?").toUpperCase(), glyph: "•", cls: "unknown" };
}
// The shared kind-badge emitter — an outlined pill (label + glyph) for a work-item or
// agent kind, returned as an HTML string so it slots into any innerHTML cluster.
function kindBadge(k) {
  const v = kindVisual(k);
  return `<span class="kind-badge kind-${esc(v.cls)}" title="${esc(v.label)}">${esc(v.glyph)} ${esc(v.label)}</span>`;
}
// </test-extract:kind-badge>
// Renders a task's badge cluster — the status chip plus the optional plan-preview /
// conflict badges — as an HTML string. Each badge's markup lives here only, so how
// a chip *looks* can't drift across the views. Which badges a view shows stays the
// caller's call (History/table stay lean, the detail header shows all), passed via
// opts; taskChips renders exactly the set requested. The conflict badge is always
// included when set — every view already shows it.
// `plan` shows the plan-preview badge (if the task opted into that gate); `kind` shows
// a small state-kind chip (agent/feedback/idle) plus for feedback states the awaited
// artifact label — surfacing the canonical 3-kind model in the UI.
function taskChips(t, { plan = false, kind = false, responder = false } = {}) {
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
  // finished TASKS ('leaf') and finished STORIES ('node') via finishedList(), so a literal
  // would mislabel a finished story '▪ TASK'. kindVisual() has a safe fallback either way.
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
function tagChips(t) {
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
function livenessChip(lv) {
  const cls = lv.state === "working" ? "has-running" : lv.state === "stalled" ? "has-idle" : "has-failed";
  return `<span class="chip ${cls}">${esc(lv.state)}</span>`;
}

// The agent is live (attachable) whenever butchr owns a launched agent for it
// (has_agent): a running/idle `in_progress` build agent until butchr tears it down.
// Gating on has_agent mirrors the /terminal endpoint exactly — the button shows iff the
// attach would succeed. (Agents are addressed BY NAME; no pane id is stored.)
function isLive(t) {
  return !!t.has_agent;
}

// ---------- collapsible panel ----------
// Shared scaffold for the caret (▾ open / ▸ closed) + clickable head + toggle-body
// pattern behind the Finished, CI-output, transcript, and live-output panels —
// the one thing those four copied identically: the caret glyph, the open/closed
// CSS-class flip, and (optionally) persisting the choice to localStorage. Each
// panel keeps its own `body` node and its own body-fill / lazy-load / poll logic,
// plugged in via `onToggle(open)` (fired on every user toggle) and re-applied by
// the caller after construction.
//
// State is one CSS class on the panel. By default that class is `collapsed` and is
// present when CLOSED (the panel convention); set `stateMeansOpen` for the inverted
// Finished section, whose `open` class is present when OPEN. `meta` is the trailing
// hint/count span. Returns { panel, head, caret, setOpen }; `setOpen(next, persist?)`
// flips state programmatically.
//
// The diff-file cards deliberately do NOT use this: their caret is a static glyph
// rotated by CSS (`.diff-file.collapsed .caret`), not flipped in JS, so routing
// them through here would require a style.css change.
function collapsible({
  title = "",
  titleClass,
  meta,
  metaClass,
  body,
  open = false,
  panelClass = "",
  headClass = "",
  stateClass = "collapsed",
  stateMeansOpen = false,
  persistKey,
  onToggle,
} = {}) {
  let isOpen = open;
  const caret = el("span", { class: "caret" }, isOpen ? "▾" : "▸");
  const headKids = [caret];
  if (title) headKids.push(el("span", titleClass ? { class: titleClass } : {}, title));
  if (meta != null) headKids.push(el("span", metaClass ? { class: metaClass } : {}, meta));
  const head = el("button", { class: headClass, type: "button" }, headKids);
  const panel = el("div", { class: panelClass }, body ? [head, body] : [head]);

  const apply = () => {
    panel.classList.toggle(stateClass, stateMeansOpen ? isOpen : !isOpen);
    caret.textContent = isOpen ? "▾" : "▸";
  };
  apply();

  const setOpen = (next, persist = true) => {
    isOpen = next;
    apply();
    if (persist && persistKey) {
      try { localStorage.setItem(persistKey, next ? "1" : "0"); } catch (e) { /* ignore */ }
    }
    if (onToggle) onToggle(next);
  };
  head.addEventListener("click", () => setOpen(!isOpen));
  return { panel, head, caret, setOpen };
}

async function api(method, path, body) {
  const res = await fetch("/api" + path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error((data && data.error) || res.statusText);
  return data;
}

let toastTimer = null;
function toast(msg, isErr) {
  const old = document.querySelector(".toast");
  if (old) old.remove();
  const t = el("div", { class: "toast" + (isErr ? " err" : "") }, msg);
  document.body.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), isErr ? 6000 : 3000);
}

// The toast confirming a terminal attach, naming the emulator butchr launched.
function terminalToast(r) {
  toast("opened terminal" + (r.emulator ? " (" + r.emulator + ")" : ""));
}

// The <a class="term-link"> control that opens a task's live agent terminal —
// rendered only when the task has a live pane. Returns "" otherwise. Caller wires
// the click via wireTermLink once the markup is in the DOM.
function termLinkMarkup(t) {
  return isLive(t)
    ? `<a href="#" class="term-link" data-id="${esc(t.id)}">⌗ terminal</a>` : "";
}

// Wire the .term-link inside `container` (if present) to open the task's terminal.
function wireTermLink(container, taskId) {
  const tl = container.querySelector(".term-link");
  if (tl) tl.addEventListener("click", (ev) => { ev.preventDefault(); openTaskTerminal(taskId); });
}

// Open a GUI terminal attached to a running task's live agent pane. Routed through
// action(), which owns the disable/try/toast/re-enable dance; `btn` is optional
// (the term-link callers pass none). onDone re-enables on success (action's catch
// re-enables on failure) — opening a terminal never navigates, so no render().
async function openTaskTerminal(id, btn) {
  await action(btn, async () => {
    const r = await api("POST", "/work/" + id + "/terminal");
    terminalToast(r);
  }, { onDone: () => { if (btn) btn.disabled = false; } });
}

// Does the captured pane (needs_user_input_context) look like the dev-channels consent /
// folder-trust / numbered-proceed prompt whose SAFE answer is option "1"? Mirrors the
// '1'-response rules in src/startup-confirm.ts so the one-click Confirm button is offered
// ONLY where nudging "1" is the right move; any other prompt falls back to Open terminal.
function isOneKeyConfirmPrompt(ctx) {
  if (!ctx) return false;
  return /local development|development channel|trust the files|do you trust|(^|\n)\s*[❯>*]?\s*1\.\s*(yes|proceed|continue|i am|allow|trust)/i.test(ctx);
}

// The PROMINENT "needs your input" card for a work item whose LIVE agent is wedged at a
// human-only OS/CLI prompt (effStatus === "needs_user_input"). The highest-attention surface
// on the task detail: it states the agent is alive-but-blocked, shows the captured pane so the
// human sees exactly WHAT prompt is blocking, and offers the tools to resolve it in place —
//  • Open terminal — reuses POST /api/work/:id/terminal to attach a GUI terminal to the live
//    pane (the agent is in_progress/attachable) so the human can type the answer.
//  • Confirm — only for the dev-channels-style numbered prompt: reuses POST /api/work/:id/nudge
//    with {text:"1"} (a bare nudge of "1\n" confirms the consent dialog). The agent then moves
//    past the prompt and the safety-net watcher clears the flag on the next clean pane read, so
//    the card resolves on the next SSE update — no explicit "resolve" action needed.
function needsUserInputPanel(t) {
  const ctx = (t.needs_user_input_context || "").trim();
  const panel = el("div", { class: "panel needs-input-panel" });
  panel.innerHTML = `
    <div class="ni-head">
      <span class="ni-icon" aria-hidden="true">⌨</span>
      <h2>Needs your input</h2>
    </div>
    <p class="ni-lead">This agent is <strong>alive but blocked</strong> at a prompt only a
      human can answer — it can't proceed until you respond in its live terminal.</p>
    ${ctx
      ? `<div class="ni-ctx-label">What it's waiting on</div><pre class="block ni-ctx">${esc(ctx)}</pre>`
      : `<p class="muted ni-noctx">No captured prompt text — open the terminal to see what it's waiting on.</p>`}
    <div class="ni-actions"></div>`;
  const actions = panel.querySelector(".ni-actions");

  const term = el("button", { class: "btn" }, "⌗ Open terminal to answer");
  term.addEventListener("click", () => openTaskTerminal(t.id, term));
  actions.appendChild(term);

  if (isOneKeyConfirmPrompt(ctx)) {
    const confirmBtn = el("button", { class: "btn ghost", title: "send “1” to the live pane — the safe proceed/consent choice" }, "Confirm (send “1”)");
    confirmBtn.addEventListener("click", () => action(confirmBtn,
      () => api("POST", "/work/" + t.id + "/nudge", { text: "1" }),
      { success: "sent “1” — the agent should continue past the prompt", onDone: () => { confirmBtn.disabled = false; } }));
    actions.appendChild(confirmBtn);
  }
  return panel;
}

// ---------- managed CTO agent (PER-WORKSPACE) ----------
// The CTO agent's tri-state status, mapped from running/desired to a display label
// and the matching cto-badge CSS class. Shared by the workspace panel and the
// dashboard mini-badge so the mapping can't drift between them.
function ctoState(s) {
  return {
    state: s.running ? "running" : (s.desired ? "starting…" : "stopped"),
    cls: s.running ? "ok" : (s.desired ? "warn" : "off"),
  };
}

// Each workspace runs its OWN CTO agent (in that repo's root — its principal/dev
// agent). This panel renders that workspace's CTO agent: a status line (running/
// stopped, session, since, restarts) plus controls — Open CTO terminal (reuses the
// workspace-agent attach), Enable/Start/Stop, Restart, and Restart fresh (a brand-new
// session) — all scoped to `dirId` via /api/workspaces/:id/cto/*.
async function ctoPanel(dirId) {
  const base = "/workspaces/" + dirId + "/cto";
  let s;
  try {
    s = await api("GET", base);
  } catch {
    return el("div", { class: "panel cto-card", style: "margin-top:28px" },
      el("small", { class: "muted" }, "CTO agent status unavailable"));
  }
  const card = el("div", { class: "panel cto-card", style: "margin-top:28px" });
  const { state, cls: stateCls } = ctoState(s);
  const bits = [];
  if (s.sessionId) bits.push(`session ${esc(s.sessionId.slice(0, 8))}`);
  if (s.since) bits.push(`since ${fmtTime(s.since)}`);
  if (s.restarts) bits.push(`${s.restarts} restart${s.restarts === 1 ? "" : "s"}`);
  if (!s.enabled) bits.push("auto-start disabled");
  card.innerHTML = `
    <div class="row" style="justify-content:space-between; align-items:center; gap:10px">
      <div>
        <h2 style="margin:0">${kindBadge("cto")} CTO agent <span class="cto-badge ${stateCls}">${state}</span></h2>
        <div class="meta" style="margin-top:4px">${bits.map(esc).join(" · ") || "not started"}</div>
        ${s.lastError ? `<div class="meta err" style="margin-top:4px">last error: ${esc(s.lastError)}</div>` : ""}
      </div>
      <div class="row cto-controls" style="gap:8px"></div>
    </div>`;
  const controls = card.querySelector(".cto-controls");
  const btn = (label, cls, fn) => {
    const b = el("button", { class: "btn " + cls }, label);
    b.addEventListener("click", async () => {
      b.disabled = true;
      try { await fn(); } catch (e) { toast(e.message || "failed", true); }
      finally { b.disabled = false; render(); }
    });
    return b;
  };
  if (s.running) {
    controls.appendChild(btn("Open CTO terminal", "", async () => {
      const r = await api("POST", base + "/terminal");
      terminalToast(r);
    }));
  }
  if (s.running || s.desired) {
    controls.appendChild(btn("Restart", "ghost", async () => {
      await api("POST", base + "/restart");
      toast("CTO agent restarting (resuming session)");
    }));
    controls.appendChild(btn("Restart fresh", "ghost", async () => {
      await api("POST", base + "/restart?fresh=1");
      toast("CTO agent restarting with a fresh session");
    }));
    controls.appendChild(btn("Stop", "ghost danger-outline", async () => {
      await api("POST", base + "/stop");
      toast("CTO agent stopped");
    }));
  } else {
    controls.appendChild(btn("Start", "", async () => {
      await api("POST", base + "/start");
      toast("CTO agent starting");
    }));
    // Opt the workspace into boot auto-start + supervision, and start it now.
    if (!s.enabled) {
      controls.appendChild(btn("Enable", "ghost", async () => {
        await api("PATCH", "/workspaces/" + dirId, { cto_enabled: true });
        await api("POST", base + "/start");
        toast("CTO agent enabled + starting");
      }));
    }
  }
  return card;
}

// Shared modal scaffold. Builds the backdrop + modal, wires Escape and
// backdrop-click to close, and mounts it on document.body — the identical ~12
// lines every modal otherwise hand-rolls. Pass `title` for the standard head
// (title + ✕ close button) and `body`/`footer` nodes for static content; or omit
// them and paint into the returned `modal` element yourself (the picker rebuilds
// its own head/list/foot on each navigation). Returns { close, backdrop, modal }.
function openModal({ title, body, footer } = {}) {
  const backdrop = el("div", { class: "modal-backdrop" });
  const modal = el("div", { class: "modal" });
  backdrop.appendChild(modal);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  function close() { backdrop.remove(); document.removeEventListener("keydown", onKey); }
  function onKey(e) { if (e.key === "Escape") close(); }
  document.addEventListener("keydown", onKey);

  if (title != null) {
    const head = el("div", { class: "m-head" });
    head.appendChild(el("h3", {}, title));
    const x = el("button", { class: "btn ghost" }, "✕");
    x.addEventListener("click", close);
    head.appendChild(x);
    modal.appendChild(head);
  }
  if (body) modal.appendChild(body);
  if (footer) modal.appendChild(footer);

  document.body.appendChild(backdrop);
  return { close, backdrop, modal };
}

// Owns the disable/try/restore/toast dance every action button repeats: disable
// `btn` (when present), run `fn` (typically an api() call), and on success toast
// `success` (a string, or a fn of fn's result) then run `onDone` (defaults to
// render()). On failure, toast the error and re-enable the button so it can be
// retried. The few buttons whose success message depends on the response toast
// inside `fn` themselves and pass no `success`. `btn` is optional — a caller with
// no button to disable (e.g. a term-link) passes none. Any pre-flight confirm()
// must run before calling action(), so a cancel never disables the button.
async function action(btn, fn, { success, onDone } = {}) {
  if (btn) btn.disabled = true;
  try {
    const r = await fn();
    if (success != null) toast(typeof success === "function" ? success(r) : success);
    (onDone || render)();
  } catch (e) {
    toast(e.message, true);
    if (btn) btn.disabled = false;
  }
}

// ---------- workspace picker modal ----------
// onSelect(path, register): register=false fills the field; true registers now.
function openPicker(onSelect) {
  let cur = null;

  // No title/body/footer: the picker repaints its own head/list/foot on each
  // navigation, so it just borrows openModal's backdrop/Escape/close scaffold.
  const { close, modal } = openModal();

  async function load(path) {
    let data;
    try {
      data = await api("GET", "/fs" + (path ? "?path=" + encodeURIComponent(path) : ""));
    } catch (e) { toast(e.message, true); return; }
    cur = data;
    paint();
  }

  function paint() {
    modal.innerHTML = "";
    const head = el("div", { class: "m-head" });
    head.appendChild(el("h3", {}, "Choose a git repository"));
    const homeBtn = el("button", { class: "btn ghost" }, "Home");
    homeBtn.addEventListener("click", () => load(cur.home));
    const x = el("button", { class: "btn ghost" }, "✕");
    x.addEventListener("click", close);
    head.appendChild(homeBtn);
    head.appendChild(x);
    modal.appendChild(head);

    modal.appendChild(el("div", { class: "m-path" }, cur.path));

    const list = el("div", { class: "m-list" });
    if (cur.parent) {
      const up = el("div", { class: "fs-row up" }, [
        el("span", { class: "ic" }, "↑"),
        el("span", { class: "nm" }, ".. (up)"),
      ]);
      up.addEventListener("click", () => load(cur.parent));
      list.appendChild(up);
    }
    if (cur.entries.length === 0) {
      list.appendChild(el("div", { class: "muted", style: "padding:14px" }, "(no subfolders)"));
    }
    for (const e of cur.entries) {
      const row = el("div", { class: "fs-row" });
      row.appendChild(el("span", { class: "ic" }, e.isGitRepo ? "◆" : "▸"));
      row.appendChild(el("span", { class: "nm" }, e.name));
      if (e.isGitRepo) {
        const badge = el("span", { class: "git-badge" }, "git");
        row.appendChild(badge);
        const reg = el("button", { class: "btn" }, "Register");
        reg.addEventListener("click", (ev) => { ev.stopPropagation(); onSelect(e.path, true); close(); });
        row.appendChild(reg);
      }
      row.addEventListener("click", () => load(e.path));
      list.appendChild(row);
    }
    modal.appendChild(list);

    const foot = el("div", { class: "m-foot" });
    if (cur.isGitRepo) {
      foot.appendChild(el("span", { class: "hint" }, "This folder is a git repository."));
      const reg = el("button", { class: "btn success" }, "Register this folder");
      reg.addEventListener("click", () => { onSelect(cur.path, true); close(); });
      foot.appendChild(reg);
    } else {
      foot.appendChild(el("span", { class: "hint" }, "Open a folder, or pick its path."));
      const use = el("button", { class: "btn ghost" }, "Use this path");
      use.addEventListener("click", () => { onSelect(cur.path, false); close(); });
      foot.appendChild(use);
    }
    modal.appendChild(foot);
  }

  // Start from the current field value if set, else home.
  const seed = (document.getElementById("dpath") || {}).value || "";
  load(seed.trim() || null);
}

// ---------- router ----------
function parseHash() {
  const hash = location.hash.replace(/^#/, "") || "/";
  const parts = hash.split("/").filter(Boolean);
  if (parts.length === 0) return { name: "dashboard" };
  if (parts[0] === "metrics") return { name: "metrics" };
  // `#/projects` is the overview; `#/projects/:id` is a project's detail view.
  if (parts[0] === "projects") return parts[1] ? { name: "project", id: parts[1] } : { name: "projects" };
  if (parts[0] === "workspace") return { name: "workspace", id: parts[1] };
  if (parts[0] === "task") return { name: "task", id: parts[1] };
  return { name: "dashboard" };
}

// ---------- live output panel state ----------
// A single poll timer drives the task page's "Live output" panel. It must not
// survive a navigation/re-render (the page is rebuilt on every SSE event), so
// render() clears it up front and renderTask restarts it if appropriate.
let liveOutputTimer = null;
let liveOutputOpen = true; // panel open/closed, persisted across re-renders
let liveOutputCache = ""; // last text, so SSE rebuilds don't flash empty
let liveOutputCacheId = null; // task id the cache belongs to
function stopLiveOutput() {
  if (liveOutputTimer) { clearInterval(liveOutputTimer); liveOutputTimer = null; }
}

// ---------- live activity pulse ----------
// A read-only one-line "what is the agent doing right now" on each running task's
// card/row, polled from GET /api/work/:id/activity (which reads only the tail of
// the session transcript). The workspace view re-renders wholesale on every SSE
// event, which destroys+rebuilds the pulse nodes; this timer is module-scope and
// re-discovers the live `.pulse[data-id]` nodes each tick, and `activityCache`
// survives re-renders so a rebuild repaints the last-known action without flashing
// empty. render() stops it up front; renderWorkspace restarts it after mount.
let activityTimer = null;
const activityCache = new Map(); // task id -> { lastAction, lastAt, elapsedMs }
function stopActivity() {
  if (activityTimer) { clearInterval(activityTimer); activityTimer = null; }
}

// A task whose agent is live enough to have transcript activity worth pulsing:
// in_progress (incl. the idle sub-state, which is still status==="in_progress").
function isPulsing(t) {
  return t.status === "in_progress";
}

// The pulse markup embedded into a card/row's innerHTML. Pre-fills the last-known
// action from the cache so an SSE-driven rebuild repaints instantly; the poller
// fills in the rest. `data-started` drives the locally-ticked elapsed readout.
function pulseMarkup(t) {
  if (!isPulsing(t)) return "";
  const cached = activityCache.get(t.id);
  const action = cached && cached.lastAction
    ? esc(cached.lastAction)
    : `<span class="muted">waiting for activity…</span>`;
  return `<div class="pulse" data-id="${esc(t.id)}" data-started="${esc(t.started_at || "")}" title="latest agent activity (read-only)">
      <span class="pulse-dot" aria-hidden="true"></span>
      <span class="pulse-action">${action}</span>
      <span class="pulse-elapsed"></span>
    </div>`;
}

function applyPulse(node, a) {
  const actionEl = node.querySelector(".pulse-action");
  if (actionEl) {
    if (a && a.lastAction) actionEl.textContent = a.lastAction;
    else actionEl.innerHTML = `<span class="muted">waiting for activity…</span>`;
  }
}

// Locally-ticked "elapsed since started" (computed from data-started so it advances
// between polls without a round-trip). Falls back to the server's elapsedMs only via
// the action poll; here we just keep the displayed duration fresh and cheap.
function tickPulseElapsed(node) {
  const elapsedEl = node.querySelector(".pulse-elapsed");
  if (!elapsedEl) return;
  const started = node.getAttribute("data-started");
  const ms = started ? Date.now() - Date.parse(started) : NaN;
  elapsedEl.textContent = isFinite(ms) && ms >= 0 ? "· " + fmtDuration(ms) : "";
}

async function pollActivity() {
  const nodes = Array.from(document.querySelectorAll(".pulse[data-id]"));
  if (!nodes.length) { stopActivity(); return; }
  for (const node of nodes) {
    tickPulseElapsed(node);
    const cached = activityCache.get(node.getAttribute("data-id"));
    if (cached) applyPulse(node, cached); // repaint cache first (avoids flashing empty)
  }
  await Promise.all(nodes.map(async (node) => {
    const id = node.getAttribute("data-id");
    try {
      const a = await api("GET", "/work/" + id + "/activity");
      activityCache.set(id, a);
      applyPulse(node, a);
      tickPulseElapsed(node);
    } catch (e) { /* best-effort — leave the last-known pulse in place */ }
  }));
}

function startActivity() {
  stopActivity();
  if (!document.querySelector(".pulse[data-id]")) return;
  pollActivity();
  activityTimer = setInterval(pollActivity, 2500);
}

let current = null;
async function render() {
  const route = parseHash();
  current = route;
  stopLiveOutput();
  stopActivity();
  syncTopnav(route);
  try {
    if (route.name === "dashboard") await renderDashboard();
    else if (route.name === "metrics") await renderMetrics();
    else if (route.name === "projects") await renderProjects();
    else if (route.name === "project") await renderProjectDetail(route.id);
    else if (route.name === "workspace") await renderWorkspace(route.id);
    else if (route.name === "task") await renderTask(route.id);
  } catch (e) {
    app.innerHTML = "";
    app.appendChild(el("div", { class: "empty" }, "error: " + e.message));
  }
}

function mount(node) {
  app.innerHTML = "";
  app.appendChild(node);
}

// After acting on a task (merge / request changes), return to its workspace's
// task list — that's the next thing you want, not the now-stale task page.
function backToWorkspace(workspaceId) {
  location.hash = workspaceId ? "#/workspace/" + workspaceId : "#/";
}

// ---------- stranded-work pull-signal ----------
// <test-extract:stranded-indicator> — pure, DOM-free helpers for the STRANDED-WORK pull-signal
// (story st-a4cc6082). Unit-tested in test/stranded-indicator-ui.test.ts by extracting this block
// and eval'ing it against a tiny `esc` shim. Keep it self-contained (its ONLY dependency is `esc`).
// The dashboard API (S2) serves, per workspace, `stranded` (count) + `strandedItems`
// [{workId, kind, reason}] plus `totals.stranded`. Each item's `reason` ALREADY embeds BOTH the
// condition AND the responder verdict (e.g. "idea task pending; CTO gave up (dead)" / "...; CTO
// disabled" / "story merge_blocked; leader gave up (dead)" / "...; leader disabled"), so it is
// rendered verbatim. kind ∈ idea | dead_blocked | stuck_story | merge_blocked.
const STRANDED_KIND_LABEL = {
  idea: "idea awaiting spec",
  dead_blocked: "dead-blocked task",
  stuck_story: "stuck story",
  merge_blocked: "merge-blocked story",
  idle_responder: "idle — not acting",
};
function strandedKindLabel(kind) {
  return STRANDED_KIND_LABEL[kind] || String(kind || "");
}
// The link target for a stranded item. TASK-kind findings (idea / dead_blocked) carry a TASK id →
// the work-detail route #/task/<id>. STORY-kind findings (stuck_story / merge_blocked) carry a
// STORY id, and stories have NO detail route in this app (parseHash knows only dashboard | metrics
// | workspace/<id> | task/<id>, and the story card is inert) — so a story id must route to its
// OWNING WORKSPACE, never #/task/<storyId> (that would mis-render a node id in the task view).
function strandedHref(kind, workId, workspaceId) {
  // STORY-kind findings (stuck_story / merge_blocked) carry a STORY id and route to their owning
  // workspace. The idle_responder summary (story st-a32c8138, PART 2) is a RESPONDER-level entry
  // whose workId IS the directory/workspace id, so it likewise routes to the workspace/CTO view —
  // never #/task/<workId> (that would mis-render a directory id in the task view).
  if (kind === "stuck_story" || kind === "merge_blocked" || kind === "idle_responder") {
    return "#/workspace/" + esc(workspaceId);
  }
  return "#/task/" + esc(workId);
}
// The DISTINCT, prominent stranded-work panel as an HTML string — or "" when nothing is stranded
// (totals.stranded === 0), so the dashboard's calm empty state is preserved. Grouped by workspace
// (so each item names which workspace/story it belongs to), every item linked via strandedHref.
// A STRONGER signal than the ordinary review/needsAttention badge: a responder is DEAD or disabled
// and a human must step in.
function strandedMarkup(data) {
  const total = (data && data.totals && data.totals.stranded) || 0;
  if (!total) return "";
  const workspaces = (data && data.workspaces) || [];
  const groups = workspaces
    .filter((w) => w && Array.isArray(w.strandedItems) && w.strandedItems.length)
    .map((w) => {
      const name = esc(w.label || w.path || w.id);
      const items = w.strandedItems
        .map((it) => {
          const href = strandedHref(it.kind, it.workId, w.id);
          // Distinct badge for the LIVE-but-IDLE case (story st-a32c8138, PART 2) so an idle
          // responder reads visually apart from a dead/disabled one within the SAME list.
          const kindClass = it.kind === "idle_responder"
            ? "stranded-kind stranded-kind--idle"
            : "stranded-kind";
          return `<li class="stranded-item"><a class="stranded-link" href="${href}">`
            + `<span class="${kindClass}">${esc(strandedKindLabel(it.kind))}</span>`
            + `<span class="stranded-reason">${esc(it.reason)}</span></a></li>`;
        })
        .join("");
      return `<div class="stranded-group"><div class="stranded-ws">${name}</div>`
        + `<ul class="stranded-list">${items}</ul></div>`;
    })
    .join("");
  return `<div class="panel stranded-panel" role="alert">
      <div class="stranded-head">
        <span class="stranded-icon" aria-hidden="true">⚠</span>
        <h2>Stranded work <span class="stranded-count">${esc(String(total))}</span></h2>
      </div>
      <p class="stranded-lead">A responder is <strong>dead, disabled, or idle</strong> — this work
        is pending with no agent acting on it, so a human must intervene.</p>
      ${groups}
    </div>`;
}
// </test-extract:stranded-indicator>

// ---------- dashboard ----------
async function renderDashboard() {
  // The cross-project dashboard rollup: per-workspace active/review/needs-attention/
  // failed counts + totals + each workspace's effective gate command. `workspaces`
  // entries carry the same `counts` map dirCard expects, plus the aggregate buckets.
  const data = await api("GET", "/dashboard");
  const dirs = data.workspaces;
  const totals = data.totals;
  const wrap = el("div");
  wrap.appendChild(el("h1", {}, "Workspaces"));
  wrap.appendChild(el("div", { class: "crumbs" }, "registered workspaces · " + dirs.length));

  // Cross-project summary: the four operator-facing buckets aggregated across every
  // registered workspace, so "what needs my eyes anywhere" reads at a glance.
  if (dirs.length) {
    const sum = el("div", { class: "dash-summary" });
    const stat = (label, n, cls) =>
      el("div", { class: "dash-stat" + (cls ? " " + cls : "") + (n ? " nonzero" : "") }, [
        el("span", { class: "ds-num" }, String(n)),
        el("span", { class: "ds-label" }, label),
      ]);
    sum.appendChild(stat("active", totals.active));
    sum.appendChild(stat("in review", totals.review, "review"));
    sum.appendChild(stat("need attention", totals.needsAttention, "attn"));
    sum.appendChild(stat("failed", totals.failed, "failed"));
    // STRANDED pull-signal (story st-a4cc6082): pending work whose owning responder (CTO / story
    // leader) is dead-while-desired or disabled. Distinct, stronger class (lights up red when
    // non-zero) — a human, not an agent, must act.
    sum.appendChild(stat("stranded", totals.stranded, "stranded"));
    wrap.appendChild(sum);
  }

  // The prominent, visually-distinct stranded-work callout — listing each stranded item, its
  // condition + responder reason, and which workspace/story it belongs to (linked to the work).
  // Empty string ⇒ nothing stranded ⇒ no node added, so a healthy board stays calm.
  const strandedHtml = strandedMarkup(data);
  if (strandedHtml) wrap.appendChild(el("div", { html: strandedHtml }));

  // add-workspace form
  const form = el("div", { class: "panel" });
  form.innerHTML = `
    <h2 style="margin-top:0">Register a workspace</h2>
    <div class="row" style="align-items:flex-end; gap:10px">
      <label class="field" style="flex:2; margin:0">
        <span class="lbl">path to a git repository</span>
        <div class="row" style="gap:8px">
          <input type="text" id="dpath" placeholder="/home/you/code/project" />
          <button class="btn ghost" id="browse-dir" style="white-space:nowrap">Browse…</button>
        </div>
      </label>
      <label class="field" style="flex:1; margin:0">
        <span class="lbl">label (optional)</span>
        <input type="text" id="dlabel" placeholder="defaults to dir name" />
      </label>
      <button class="btn" id="add-dir">Register</button>
    </div>
    <label class="field" style="margin:10px 0 0">
      <span class="lbl">build/test gate command (optional) — blank uses the default; runs in CI + post-merge verify</span>
      <input type="text" id="dgate" placeholder="e.g. npm run build && npm test" />
    </label>`;
  wrap.appendChild(form);

  if (dirs.length === 0) {
    wrap.appendChild(el("div", { class: "empty" }, "No workspaces yet. Register a git repo above to begin."));
  } else {
    const grid = el("div", { class: "grid dirs" });
    for (const d of dirs) grid.appendChild(dirCard(d));
    wrap.appendChild(grid);
  }
  mount(wrap);

  document.getElementById("browse-dir").addEventListener("click", () => {
    openPicker(async (picked, register) => {
      document.getElementById("dpath").value = picked;
      if (register) {
        try {
          await api("POST", "/workspaces", { path: picked });
          toast("workspace registered");
          render();
        } catch (e) { toast(e.message, true); }
      }
    });
  });

  document.getElementById("add-dir").addEventListener("click", async () => {
    const path = document.getElementById("dpath").value.trim();
    const label = document.getElementById("dlabel").value.trim();
    // Optional per-workspace gate command — omit when blank so the backend keeps
    // the default (NULL) rather than disabling the gate with an empty string.
    const gate = document.getElementById("dgate").value.trim();
    if (!path) return toast("path is required", true);
    try {
      await api("POST", "/workspaces", {
        path, label: label || undefined, gate_cmd: gate || undefined,
      });
      toast("workspace registered");
      render();
    } catch (e) { toast(e.message, true); }
  });
}

function dirCard(d) {
  const c = d.counts || {};
  // Same status set + order as the filter chips (server's status list with the
  // synthetic `idle` effStatus spliced in — see applyStateMeta / FILTER_STATUSES).
  const pills = FILTER_STATUSES
    .map((s) => {
      const cls = s === "blocked" && c[s] ? "count-pill has-blocked"
        : s === "inactive" && c[s] ? "count-pill has-inactive"
        : s === "in_progress" && c[s] ? "count-pill has-running"
        : s === "needs_user_input" && c[s] ? "count-pill has-needs-input"
        : s === "idle" && c[s] ? "count-pill has-idle"
        : s === "in_review" && c[s] ? "count-pill has-review"
        : s === "spec_review" && c[s] ? "count-pill has-review"
        : s === "needs_info" && c[s] ? "count-pill has-awaiting"
        : s === "rolling_back" && c[s] ? "count-pill has-rolling-back"
        : s === "failed" && c[s] ? "count-pill has-failed"
        : "count-pill";
      return `<span class="${cls}">${statusLabel(s)} <b>${c[s] || 0}</b></span>`;
    }).join("");
  // Aggregate bucket badges (active / review / needs-attention / failed) when the
  // card comes from the dashboard rollup (those fields are absent on a plain
  // WorkspaceView, so the row is simply omitted there). needs-attention/failed light
  // up only when non-zero so a quiet workspace stays visually calm.
  const buckets = typeof d.active === "number"
    ? `<div class="ws-buckets">
        <span class="ws-bucket">active <b>${d.active}</b></span>
        <span class="ws-bucket${d.review ? " review" : ""}">review <b>${d.review}</b></span>
        <span class="ws-bucket${d.needsAttention ? " attn" : ""}">attention <b>${d.needsAttention}</b></span>
        <span class="ws-bucket${d.failed ? " failed" : ""}">failed <b>${d.failed}</b></span>
        <span class="ws-bucket${d.stranded ? " stranded" : ""}">stranded <b>${d.stranded || 0}</b></span>
      </div>`
    : "";
  const card = el("div", { class: "card" });
  card.innerHTML = `
    <div class="title">${esc(d.label || d.path)}</div>
    <div class="path">${esc(d.path)}</div>
    ${buckets}
    <div class="counts">${pills}</div>
    <div class="cto-mini" data-cto="${esc(d.id)}"><span class="cto-badge off">CTO …</span></div>`;
  card.style.cursor = "pointer";
  card.addEventListener("click", () => (location.hash = "#/workspace/" + d.id));
  // Lazily fill in THIS workspace's CTO-agent status badge (best-effort; a failed
  // probe just leaves the placeholder). Scoped per-workspace — one CTO per repo.
  ctoMiniBadge(d.id, card.querySelector(".cto-mini"));
  return card;
}

// Fill a dashboard card's compact CTO badge from /api/workspaces/:id/cto. Pure
// status — the card's own click navigates into the workspace view (with full controls).
async function ctoMiniBadge(dirId, slot) {
  if (!slot) return;
  try {
    const s = await api("GET", "/workspaces/" + dirId + "/cto");
    const { state, cls } = ctoState(s);
    slot.innerHTML = `${kindBadge("cto")} <span class="cto-badge ${cls}">${esc(state)}</span>`;
  } catch {
    slot.innerHTML = "";
  }
}

// ---------- workspace view ----------
async function renderWorkspace(id) {
  // Pull the workspace from the dashboard rollup (it carries the effective gate
  // command + override state the gate panel needs) alongside its task list.
  const [dash, work] = await Promise.all([
    api("GET", "/dashboard"),
    // The UNIFIED work list for this workspace (leaf tasks + node stories), carrying the
    // active full-text search so it survives SSE-driven re-renders (the server filters by
    // `?q=` — see workListPath / buildFilterBar). Best-effort: a failure leaves both surfaces
    // empty rather than blanking the page.
    api("GET", workListPath(id)).catch(() => []),
  ]);
  // Split the leaf|node union: leaves are the TASK list the GRAPH and BOARD views render
  // (those stay leaves-only — they're reworked by sibling subtasks). The LIST view instead
  // consumes the FULL union (nodes + leaves) so stories render as peer rows alongside tasks,
  // with their subtasks grouped underneath client-side.
  const tasks = workLeaves(work);
  // Bound the long-lived module caches against this render's live work-id set (nodes + leaves),
  // dropping entries for work that has left the list so neither grows unbounded over a session.
  const liveWorkIds = new Set((Array.isArray(work) ? work : []).map((w) => w && w.id).filter(Boolean));
  pruneWorkCaches(liveWorkIds, WORK_TREE_EXPANDED, activityCache);
  // Same growth-bound for the Pipeline view's expanded-done piles (keyed by story id).
  for (const id of SWIM_DONE_EXPANDED) if (!liveWorkIds.has(id)) SWIM_DONE_EXPANDED.delete(id);
  const dir = dash.workspaces.find((x) => x.id === id);
  if (!dir) return mount(el("div", { class: "empty" }, "workspace not found"));

  const wrap = el("div");
  wrap.appendChild(el("div", { class: "crumbs", html: `<a href="#/">Workspaces</a> / ${esc(dir.label || dir.path)}` }));
  wrap.appendChild(el("h1", {}, dir.label || dir.path));
  wrap.appendChild(el("div", { class: "path" }, dir.path));

  // create-work launcher (AUTHORITY FLIP, Phase 7) — the operator's entry point for new
  // work is now a STORY, not a standalone task. A single "New story" button opens the
  // brief modal (POST /api/workspaces/:id/work); a story leader then decomposes it into
  // subtasks. Standalone task + idea creation are gone (the server rejects them) — the only
  // task creatable directly is a rollback, via the per-task "Roll back" button.
  const launch = el("div", { class: "row between", style: "margin-top:18px" });
  launch.appendChild(el("small", { class: "muted" },
    `New work is a STORY — a leader decomposes it into subtasks. ${queueLine(tasks)}`));
  const newStoryBtn = el("button", { class: "btn", id: "new-story" }, "New story");
  newStoryBtn.addEventListener("click", () => openNewStoryModal(id));
  launch.appendChild(newStoryBtn);
  wrap.appendChild(launch);

  // List / Graph / Board view selector — the PRIMARY control of the main view, sitting
  // directly under the launcher row and above the body. The toggle bar persists while the
  // body is swapped; the chosen mode lives in dirView (module scope + localStorage) so it
  // survives SSE re-renders and reloads. The LIST, GRAPH and BOARD views all show ALL work —
  // stories AND tasks — as peers (the graph draws stories as first-class peer nodes with
  // their subtasks enclosed in a cluster box; the board renders stories as peer cards), so
  // all three receive the full work union.
  const body = el("div", { class: "ws-body" });
  const paintBody = () => {
    body.innerHTML = "";
    if (dirView === "graph") {
      body.appendChild(el("h2", {}, "Pipeline"));
      body.appendChild(renderSwimlanes(work));
    } else if (dirView === "board") {
      body.appendChild(el("h2", {}, "Merge train"));
      // The board is a KANBAN board of COLUMNS that folds in ALL work — stories AND
      // tasks render as peer cards — so it consumes the FULL union (not workLeaves),
      // same as the List and Graph views.
      body.appendChild(renderBoard(work));
    } else {
      // search + status filter bar. Filter state lives in module-level vars
      // (taskSearch / statusFilter) so it survives the full re-render the app does
      // on every SSE event. The full-text search runs SERVER-SIDE (?q=) — typing
      // re-fetches the list (debounced) and repaints only the results region below
      // (not the bar itself), so the search input keeps focus while you type. The list
      // gets the FULL work union (stories + tasks); the split of active vs terminal-state
      // history (and the story/subtask grouping) happens inside renderResults.
      const results = el("div", { class: "results" });
      body.appendChild(buildFilterBar(id, work, results));
      body.appendChild(results);
      renderResults(work, results);
    }
  };
  wrap.appendChild(buildViewToggle(paintBody));
  wrap.appendChild(body);
  paintBody();

  // This workspace's managed CTO agent (its principal/dev agent, running in the repo
  // root) — status + Start/Stop/Restart/Enable + Open-CTO-terminal, scoped to this
  // workspace. Best-effort: rendered async so a status-probe hiccup never blocks the
  // page. Mounted in place once it resolves.
  const ctoSlot = el("div");
  wrap.appendChild(ctoSlot);
  ctoPanel(id).then((panel) => ctoSlot.replaceWith(panel)).catch(() => {});

  // build/test gate command panel — the command both the CI gate (in-worktree) and
  // the post-merge verify gate run for this workspace. Shows the effective command +
  // whether it's a per-workspace override or the default, with an inline editor.
  wrap.appendChild(gatePanel(dir));

  // (Responder routing is now STRUCTURAL — per-task pending_responder, not per-workspace
  // config — so there is no step-responder config panel here anymore.)

  // danger zone
  const dz = el("div", { class: "row", style: "margin-top:32px" });
  const del = el("button", { class: "btn ghost" }, "Unregister workspace");
  del.addEventListener("click", async () => {
    if (!confirm("Unregister this workspace? Non-merged worktrees will be removed.")) return;
    try {
      await api("DELETE", "/workspaces/" + id);
      toast("workspace unregistered");
      location.hash = "#/";
    } catch (e) { toast(e.message, true); }
  });
  dz.appendChild(del);
  wrap.appendChild(dz);

  mount(wrap);
  // Begin polling the live activity pulse for any running task cards now in the DOM.
  startActivity();
}

// ---------- per-workspace build/test gate panel ----------
// `dir` is a dashboard workspace entry (has gate_cmd + effective_gate_cmd). Renders
// the effective command, flags whether it's a per-workspace override or the default,
// and offers an Edit button that opens the gate editor modal.
function gatePanel(dir) {
  const overridden = dir.gate_cmd !== null;
  const disabled = dir.gate_cmd === "";
  const panel = el("div", { class: "panel", style: "margin-top:28px" });
  const head = el("div", { class: "row between", style: "align-items:center" });
  head.appendChild(el("h2", { style: "margin:0" }, "Build / test gate"));
  const edit = el("button", { class: "btn ghost" }, "Edit");
  edit.addEventListener("click", () => openGateModal(dir));
  head.appendChild(edit);
  panel.appendChild(head);
  panel.appendChild(el("small", { class: "muted", style: "display:block;margin:6px 0 10px" },
    "Run in CI (the task worktree, on review) and by the post-merge verify gate (the repo root, after a merge — RED auto-reverts)."));
  const cmdText = disabled ? "(gate disabled for this workspace)" : (dir.effective_gate_cmd || "(none)");
  panel.appendChild(el("pre", { class: "gate-cmd" + (disabled ? " disabled" : "") }, cmdText));
  panel.appendChild(el("small", { class: "muted" },
    overridden
      ? (disabled ? "Per-workspace override: the gate is disabled." : "Per-workspace override.")
      : "Using the default gate (no per-workspace override)."));
  return panel;
}

// Editor for a workspace's gate command. A textarea (prefilled with the effective
// command) plus three actions: Save the typed command (an empty save DISABLES the
// gate), or "Use default" to clear the override (revert to config.verifyCmd). Maps
// to PATCH /api/workspaces/:id.
function openGateModal(dir) {
  const body = el("div", { class: "m-body" });
  body.innerHTML = `
    <label class="field" style="margin-bottom:6px">
      <span class="lbl">build/test gate command — run via <code>bash -lc</code> in the repo</span>
      <textarea id="gate-cmd" class="gate-textarea" placeholder="e.g. npm run build && npm test"></textarea>
    </label>
    <small class="hint muted">Save an empty command to DISABLE the gate for this workspace. "Use default" reverts to the global default command.</small>`;
  const ta = body.querySelector("#gate-cmd");
  ta.value = dir.gate_cmd !== null ? dir.gate_cmd : (dir.effective_gate_cmd || "");

  const foot = el("div", { class: "m-foot" });
  const useDefault = el("button", { class: "btn ghost" }, "Use default");
  const cancel = el("button", { class: "btn ghost" }, "Cancel");
  const save = el("button", { class: "btn" }, "Save command");
  foot.appendChild(useDefault);
  foot.appendChild(cancel);
  foot.appendChild(save);

  const { close } = openModal({ title: "Build / test gate", body, footer: foot });
  cancel.addEventListener("click", close);
  ta.focus();

  const patch = (btn, gate_cmd, msg) =>
    action(btn, () => api("PATCH", "/workspaces/" + dir.id, { gate_cmd }),
      { success: msg, onDone: () => { close(); render(); } });
  save.addEventListener("click", () => patch(save, ta.value, "gate command updated"));
  useDefault.addEventListener("click", () => patch(useDefault, null, "reverted to the default gate"));
}

// ---------- stories panel + new-story modal (AUTHORITY FLIP, Phase 7) ----------
// New work is a STORY, not a standalone task: the operator creates a story (a one-line
// brief) and a managed story-LEADER agent decomposes it into the subtasks. So the old
// New-task / Add-idea modals are gone — the server now REJECTS standalone task creation
// (only a rollback may be created directly, via the per-task "Roll back" button). Two
// surfaces replace them: a minimal "New story" modal, and a read-only stories list/progress
// panel built from the node members of the GET /api/work list (brief + status + per-status
// subtask counts + leader status), so the operator isn't blind to the stories they just created.

// The brief modal: jot a one-line story brief and POST it to /api/workspaces/:id/work.
// butchr lands the story `open` and launches its leader (which creates + reviews the
// subtasks); the new story surfaces via the SSE-driven re-render.
function openNewStoryModal(workspaceId) {
  const body = el("div", { class: "m-body" });
  body.innerHTML = `
    <label class="field" style="margin-bottom:6px">
      <span class="lbl">story — a one-line brief; a story leader decomposes it into the subtasks needed to deliver it</span>
      <textarea id="ns-brief" placeholder="Describe the story in a sentence or two…"></textarea>
    </label>
    <small class="hint muted">The operator creates STORIES; the leader creates + reviews the tasks. Each story's subtask progress shows below.</small>`;
  const briefEl = body.querySelector("#ns-brief");

  const foot = el("div", { class: "m-foot" });
  const errEl = el("span", { class: "m-error hint" }, "");
  const cancel = el("button", { class: "btn ghost" }, "Cancel");
  const submit = el("button", { class: "btn" }, "Create story");
  foot.appendChild(errEl);
  foot.appendChild(cancel);
  foot.appendChild(submit);

  const { close } = openModal({ title: "New story", body, footer: foot });
  cancel.addEventListener("click", close);
  briefEl.focus();

  function showErr(msg) { errEl.textContent = msg || ""; errEl.classList.toggle("on", !!msg); }

  submit.addEventListener("click", () => {
    const brief = briefEl.value.trim();
    if (!brief) { showErr("Describe the story first."); briefEl.focus(); return; }
    showErr("");
    // action(): disables the button, toasts on success/failure, re-enables on error. On
    // success close + re-render so the new story appears in the panel below.
    action(submit, () => api("POST", "/workspaces/" + workspaceId + "/work", { brief }),
      { success: "story created", onDone: () => { close(); render(); } });
  });
}

// ---------- unified work list (stories + tasks) ----------
// Expand/collapse state for story NODES in the unified list, keyed by node id. Kept at MODULE
// scope (NOT per-row closure) so it survives the full re-render the app does on every SSE
// event. A node id is present only while its DETAIL is expanded; the detail (full brief + open
// ask) defaults COLLAPSED so the list stays scannable. NOTE: a story's child subtask ROWS are
// always visible (indented) regardless of this set — only the detail block toggles.
const WORK_TREE_EXPANDED = new Set();
// Story ids whose collapsed "N done" pile is EXPANDED in the Pipeline (swimlanes) view. Module
// scope so an expanded pile survives the full re-render on every SSE event, mirroring
// WORK_TREE_EXPANDED. Pruned against the live work-id set on each workspace render (below) so it
// can't grow unbounded across a long session.
const SWIM_DONE_EXPANDED = new Set();

// <test-extract:prune-caches>
// Bound the two long-lived module caches so they don't grow unbounded across a long session:
// WORK_TREE_EXPANDED (story ids whose detail is open) and activityCache (task id -> last pulse).
// Both only ever ADD ids; work that leaves the list (merged/aborted, or you switch workspaces)
// kept its entry forever. On each workspace render we drop every id no longer in the current
// work-id set — functionally harmless (a stale id renders nothing) — purely a growth bound.
function pruneWorkCaches(liveIds, expanded, activity) {
  for (const id of expanded) if (!liveIds.has(id)) expanded.delete(id);
  for (const id of activity.keys()) if (!liveIds.has(id)) activity.delete(id);
}
// </test-extract:prune-caches>

// Group the flat /api/work list (nodes + leaves, newest-first) into a tree CLIENT-SIDE — no
// server help needed. A leaf's parent is its parent_id when populated, else its story_id
// (parent_id is inert today but PREFERRED for forward-compat). A leaf whose parent id matches
// a node in the list attaches as that node's child; an orphan leaf (no/unknown parent) renders
// at top level alongside the nodes. Top level = nodes + orphan leaves, emitted in the API's
// original newest-first order (a single pass preserves it).
function groupWork(work) {
  const list = Array.isArray(work) ? work : [];
  const nodeIds = new Set(list.filter((w) => w && w.work_kind === "node").map((w) => w.id));
  const childrenByNode = new Map();
  const topLevel = [];
  for (const w of list) {
    if (!w) continue;
    if (w.work_kind === "leaf") {
      const parent = w.parent_id || w.story_id;
      if (parent && nodeIds.has(parent)) {
        if (!childrenByNode.has(parent)) childrenByNode.set(parent, []);
        childrenByNode.get(parent).push(w);
        continue;
      }
    }
    topLevel.push(w);
  }
  return { topLevel, childrenByNode };
}

// <test-extract:complete-status>
// A work item counts as COMPLETE once it reaches a SUCCESSFUL terminal status. A LEAF task ends
// at `merged` (or `rolled_back`); a STORY NODE ends at `done`. This is the ONE source of truth
// for "is this work finished", reused by workRollup's ✓ count AND the cross-type graph/rollup
// progress bars — those bars mix nodes + leaves in one subtree, so they MUST count node `done`
// too, else any subtree containing a completed story UNDER-reports (it sits in the total but
// never in the merged numerator). Failure/abort are terminal but NOT complete (they're the ✗).
const COMPLETE_STATUSES = new Set(["merged", "rolled_back", "done"]);
function isCompleteStatus(status) { return COMPLETE_STATUSES.has(status); }
// Shared numerator behind both cross-type progress bars (graph node sub-bar + dependentRollup):
// how many of `ids` resolve (via the byId map) to a COMPLETE work item.
function countComplete(ids, byId) {
  let n = 0;
  for (const id of ids) if (isCompleteStatus((byId.get(id) || {}).status)) n++;
  return n;
}
// </test-extract:complete-status>

// A node's compact subtask ROLLUP string from its server-computed per-status `counts` map.
// total counts every status EXCEPT the `idle` pseudo-bucket (a flag peeled out of in_progress,
// not a real status); ✓ = completed (merged | rolled_back | done — see isCompleteStatus),
// ✗ = failed + aborted (dead). Degrades cleanly: a node with no subtasks (or only idle) reads
// "0" with no ✓/✗ noise.
function workRollup(counts) {
  const c = counts || {};
  const total = Object.keys(c).reduce((n, k) => (k === "idle" ? n : n + (c[k] || 0)), 0);
  const done = Object.keys(c).reduce((n, k) => (isCompleteStatus(k) ? n + (c[k] || 0) : n), 0);
  const dead = (c.failed || 0) + (c.aborted || 0);
  const parts = [];
  if (done) parts.push(done + "✓");
  if (dead) parts.push(dead + "✗");
  return parts.length ? total + " · " + parts.join(" ") : String(total);
}

// The expandable STORY DETAIL block — the "wall of text" moved OFF the story row and revealed
// only when the row's caret is toggled. It carries the node's FULL brief and, when there's an
// open story-level ask, its answer box (storyAskPanel). It deliberately does NOT contain the
// story's child subtask rows: those are ALWAYS-visible indented peer rows in the unified table
// (see workTable), so all work stays visible by default and only this detail toggles.
function renderStoryDetail(work) {
  const wrap = el("div", { class: "work-expanded" });
  wrap.appendChild(el("div", { class: "work-brief-full" }, work.brief || "(no brief)"));
  if (work.pending_ask != null) wrap.appendChild(storyAskPanel(work));
  return wrap;
}

// The open STORY-LEVEL ask on a story row (only when s.pending_ask is non-null — the caller
// guards): the question text (HTML-escaped), who currently OWNS it (ask_responder), and a
// freeform answer box that POSTs /api/work/:id/answer. `cto` is MUTED ("awaiting the CTO" —
// an agent handles it automatically, a human may still act); `user` is EMPHASIZED ("escalated
// to you" — it needs a human), mirroring the task-level awaiting-who emphasis. action() owns the
// disable/toast dance and re-renders on success (clearing the now-answered ask).
function storyAskPanel(s) {
  const toUser = s.ask_responder === "user";
  const owner = toUser
    ? `<span class="sa-owner you" title="this ask was escalated to YOU — answer it below">escalated to you</span>`
    : `<span class="sa-owner cto" title="this ask is owned by the CTO agent (handled automatically) — you can also answer">awaiting the CTO</span>`;
  const panel = el("div", { class: "story-ask-panel" + (toUser ? " awaiting-you" : "") });
  panel.innerHTML = `
    <div class="sa-head">Story ask ${owner}</div>
    <div class="sa-question">${esc(s.pending_ask)}</div>
    <label class="field" style="margin:8px 0 0">
      <span class="lbl">your answer</span>
      <textarea class="sa-answer" data-restore-key="story-answer" placeholder="Answer the story-level ask. It goes back to the story leader, which continues from your response."></textarea>
    </label>
    <div class="row" style="margin-top:8px">
      <button class="btn success sa-submit">Submit answer</button>
      <div class="spacer"></div>
    </div>`;
  const submit = panel.querySelector(".sa-submit");
  submit.addEventListener("click", () => {
    const answer = panel.querySelector(".sa-answer").value.trim();
    if (!answer) return toast("an answer is required", true);
    // POST the answer; action() disables the button, toasts, and re-renders on success
    // (the answered ask is cleared server-side, so the panel disappears on the re-render).
    action(submit, () => api("POST", "/work/" + s.id + "/answer", { answer }),
      { success: "answer sent" });
  });
  return panel;
}

function queueLine(tasks) {
  const idea = tasks.filter((t) => t.status === "idea").length;
  const specRev = tasks.filter((t) => t.status === "spec_review").length;
  const b = tasks.filter((t) => t.status === "blocked").length;
  const ni = tasks.filter((t) => t.status === "needs_info").length;
  const ready = tasks.filter((t) => t.status === "inactive").length;
  const nui = tasks.filter((t) => effStatus(t) === "needs_user_input").length;
  const r = tasks.filter((t) => t.status === "in_progress" && !t.idle && !t.needs_user_input).length;
  const i = tasks.filter((t) => t.status === "in_progress" && t.idle && !t.needs_user_input).length;
  const inRev = tasks.filter((t) => t.status === "in_review").length;
  const rb = tasks.filter((t) => t.status === "rolling_back").length;
  const parts = [];
  // Surface FIRST — a wedged agent needing a human is the most urgent line.
  if (nui) parts.push(`${nui} needs your input`);
  if (r) parts.push(`${r} in progress`);
  if (i) parts.push(`${i} idle`);
  if (ready) parts.push(`${ready} ready`);
  if (rb) parts.push(`${rb} rolling back`);
  if (inRev) parts.push(`${inRev} in review`);
  if (specRev) parts.push(`${specRev} spec review`);
  if (ni) parts.push(`${ni} needs info`);
  if (b) parts.push(`${b} blocked`);
  if (idea) parts.push(`${idea} idea`);
  return parts.length ? parts.join(", ") + "." : "Idle.";
}

// ACTIVE_STATUSES (lifecycle statuses still in flight — they stay in the main workspace
// list) and TERMINAL_STATUSES (the terminal subset that lives in the collapsible
// "Finished" section) are now BUILT from the server-owned state meta at boot — see
// applyStateMeta near the top of this file. TERMINAL_STATUSES is the server's isTerminal
// subset; ACTIVE_STATUSES is its complement, so a needs-attention feedback state can
// never be hidden under Finished.
const HISTORY_KEY = "butchr-history-open";

// Workspace page body mode: the unified work "List" (default — stories + tasks as peer rows),
// the dependency "Graph", or the pipeline "Board". Kept at module scope (and mirrored to
// localStorage) so it survives the full re-render the app does on every SSE event and across
// reloads. The old "tree" view was removed: a stored "tree" (the previous default) falls back
// to "list" so an operator with the stale value doesn't load a view that no longer exists.
const DIRVIEW_KEY = "butchr-dirview";
let dirView = (() => {
  try {
    const v = localStorage.getItem(DIRVIEW_KEY);
    return v === "graph" || v === "board" || v === "list" ? v : "list";
  } catch (e) { return "list"; }
})();
function setDirView(v) {
  dirView = v;
  try { localStorage.setItem(DIRVIEW_KEY, v); } catch (e) { /* ignore */ }
}

function historyOpen() {
  try { return localStorage.getItem(HISTORY_KEY) === "1"; } catch (e) { return false; }
}

// ---------- task search + status filtering ----------
// Filter state is kept in memory only, at module scope, so it survives the full
// re-render render() performs on every SSE event without being torn down. The filter
// chips iterate FILTER_STATUSES — the server's status list with the synthetic `idle`
// effStatus spliced in (see applyStateMeta) — so the *effective* statuses (effStatus)
// `idle` and `in_progress` filter independently, as do all terminal states.
// taskSearch is the FULL-TEXT query, applied SERVER-SIDE via `?q=` on the task-list
// endpoint — it matches a task's prompt (which lives in task.md and is NOT shipped
// to the client), summary, review notes, and id. So the search runs on the server
// and the workspace list is re-fetched as you type (debounced); the status/tag
// filters below still run client-side over whatever the server returned.
let taskSearch = "";          // full-text query (server-side ?q=)
let statusFilter = new Set(); // selected effStatus values; empty = all
let tagFilter = new Set();    // selected tags; empty = all (ANY-match when non-empty)

// The `?q=` query-string fragment for the current search (empty when not searching),
// appended to every workspace task-list fetch so the active search persists across
// SSE-driven re-renders.
function searchParam() {
  const q = taskSearch.trim();
  return q ? "?q=" + encodeURIComponent(q) : "";
}

// The unified WORK-LIST URL for one workspace: GET /api/work scoped to this workspace
// (?workspace=) carrying the active full-text search (&q=). The single replacement for the
// split /workspaces/:id/tasks + /workspaces/:id/stories fetches — the response is the WorkView
// leaf|node union, which callers split by `work_kind` (leaves → task list, nodes → stories).
function workListPath(workspaceId) {
  const q = taskSearch.trim();
  return "/work?workspace=" + encodeURIComponent(workspaceId) + (q ? "&q=" + encodeURIComponent(q) : "");
}
// The LEAF (task) members of a /api/work list — the task list the GRAPH and BOARD views render
// (those stay leaves-only). The LIST view instead consumes the full union via groupWork(), so
// there's no node-only splitter here.
function workLeaves(work) {
  return (Array.isArray(work) ? work : []).filter((w) => w && w.work_kind === "leaf");
}

function filterActive() {
  return taskSearch.trim() !== "" || statusFilter.size > 0 || tagFilter.size > 0;
}
// Client-side filter applied ON TOP of the server's full-text `?q=` result: the
// status chips and tag chips. The text search itself is NOT re-checked here — the
// server already narrowed the list by prompt/summary/notes/id, which the client
// can't reproduce (it never receives the prompt bodies). Handles BOTH work kinds: a
// node (story) filters by its status (effStatus passes node.status through, since a story
// is never in_progress/idle) and its tags (defaulting to none when a node carries none).
function taskMatchesFilter(t) {
  if (statusFilter.size && !statusFilter.has(effStatus(t))) return false;
  // Tag filter is ANY-match: keep a task if it carries at least one selected tag.
  if (tagFilter.size) {
    const tags = Array.isArray(t.tags) ? t.tags : [];
    if (!tags.some((g) => tagFilter.has(g))) return false;
  }
  return true;
}

// The distinct set of tags across the workspace's tasks, sorted, for the filter bar.
function allTags(tasks) {
  const set = new Set();
  for (const t of tasks) for (const g of (Array.isArray(t.tags) ? t.tags : [])) set.add(g);
  return [...set].sort();
}

// The filter bar: a full-text search box plus a row of toggleable status chips
// (reusing the existing .chip color styling, dimmed when inactive). The search box
// drives the SERVER-SIDE `?q=` filter — typing re-fetches the workspace's task list
// (debounced) and repaints ONLY the results region, so the bar (and the focused
// search input) stay put and live-as-you-type works. The status/tag chip handlers
// mutate the module-level filter state and re-filter the last-fetched set client-side.
function buildFilterBar(dirId, work, results) {
  const bar = el("div", { class: "filter-bar" });

  // The most recently fetched (server-filtered) WORK union (stories + tasks) the chips filter
  // over. Starts as the list `work` painted with; a search re-fetch replaces it.
  let currentTasks = work;

  const search = el("input", {
    type: "text", class: "task-search", placeholder: "Search prompt, summary, notes, id…",
    "aria-label": "Search tasks by prompt, summary, review notes, or id",
  });
  search.value = taskSearch;

  // Debounced server search: the prompt lives in task.md on the server, so matching
  // it means re-fetching the list with `?q=` rather than filtering in the browser.
  let searchTimer = null;
  function runSearch() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      try {
        // Re-fetch the unified work list and keep the FULL union (stories + tasks) — the LIST
        // renders all work as peer rows, so it must NOT be narrowed to leaves here.
        currentTasks = await api("GET", workListPath(dirId));
      } catch (e) {
        toast(e.message, true);
        return;
      }
      renderResults(currentTasks, results);
    }, 180);
  }
  search.addEventListener("input", () => {
    taskSearch = search.value;
    syncClear();
    runSearch();
  });

  const chips = el("div", { class: "filter-chips" });
  for (const s of FILTER_STATUSES) {
    const c = el("button", {
      type: "button",
      class: "filter-chip chip " + s + (statusFilter.has(s) ? " active" : ""),
      "aria-pressed": statusFilter.has(s) ? "true" : "false",
    }, statusLabel(s));
    c.addEventListener("click", () => {
      if (statusFilter.has(s)) statusFilter.delete(s); else statusFilter.add(s);
      const on = statusFilter.has(s);
      c.classList.toggle("active", on);
      c.setAttribute("aria-pressed", on ? "true" : "false");
      renderResults(currentTasks, results);
      syncClear();
    });
    chips.appendChild(c);
  }

  const clear = el("button", { type: "button", class: "filter-clear" }, "Clear filters");
  clear.addEventListener("click", () => {
    taskSearch = "";
    statusFilter.clear();
    tagFilter.clear();
    search.value = "";
    chips.querySelectorAll(".filter-chip").forEach((c) => {
      c.classList.remove("active");
      c.setAttribute("aria-pressed", "false");
    });
    if (tagRow) tagRow.querySelectorAll(".filter-chip").forEach((c) => {
      c.classList.remove("active");
      c.setAttribute("aria-pressed", "false");
    });
    // Clearing the text query changes the server filter, so re-fetch the full list.
    runSearch();
    syncClear();
  });
  function syncClear() { clear.style.display = filterActive() ? "" : "none"; }

  bar.appendChild(search);
  chips.appendChild(clear);
  bar.appendChild(chips);

  // Second chip row: one toggleable chip per distinct tag in this workspace (ANY
  // match). Only shown when the workspace has any tagged tasks. A stale selection
  // (a tag whose last task left the set) is harmlessly ignored — it just matches
  // nothing — and is dropped here so the bar reflects the live tag universe.
  const tags = allTags(work);
  for (const g of [...tagFilter]) if (!tags.includes(g)) tagFilter.delete(g);
  let tagRow = null;
  if (tags.length) {
    tagRow = el("div", { class: "filter-chips filter-tags" });
    tagRow.appendChild(el("span", { class: "filter-tags-label muted" }, "tags"));
    for (const g of tags) {
      const c = el("button", {
        type: "button",
        class: "filter-chip chip tag" + (tagFilter.has(g) ? " active" : ""),
        "aria-pressed": tagFilter.has(g) ? "true" : "false",
      }, g);
      c.addEventListener("click", () => {
        if (tagFilter.has(g)) tagFilter.delete(g); else tagFilter.add(g);
        const on = tagFilter.has(g);
        c.classList.toggle("active", on);
        c.setAttribute("aria-pressed", on ? "true" : "false");
        renderResults(currentTasks, results);
        syncClear();
      });
      tagRow.appendChild(c);
    }
    bar.appendChild(tagRow);
  }
  syncClear();
  return bar;
}

// Whether a work item belongs to HISTORY (the collapsed Finished section): a NODE (story) once
// it reaches a terminal state (done/aborted), a LEAF (task) by the server's terminal status
// set. Everything else stays in the visible active list — including stories that are
// open/merging/merge_blocked and any feedback task awaiting the operator.
function isHistoryItem(w) {
  if (!w) return false;
  if (w.work_kind === "node") return w.status === "done" || w.status === "aborted";
  return TERMINAL_STATUSES.includes(w.status);
}

// Render the active unified table (stories + tasks as peer rows) + the Finished section into
// `container`, applying the current filter. Called on first paint and on every search/chip
// change, and re-invoked in place when a story's detail caret toggles (the expand Set is
// module-level, so it survives the rebuild). When a filter is active, the Finished section
// auto-expands if it has matches and its count shows "matches of total".
function renderResults(work, container) {
  container.innerHTML = "";
  const list = Array.isArray(work) ? work : [];
  const filtering = filterActive();
  // A caret toggle just re-renders this region from the same union; the expand state lives in
  // the module-level WORK_TREE_EXPANDED set, so it carries across the rebuild.
  const repaint = () => renderResults(work, container);
  // History holds terminal items (merged/aborted tasks, done/aborted stories); everything
  // else — including feedback tasks awaiting the operator and live stories — stays visible.
  const active = list.filter((w) => !isHistoryItem(w));
  const history = list.filter(isHistoryItem);
  const activeMatch = active.filter(taskMatchesFilter);
  const historyMatch = history.filter(taskMatchesFilter);

  container.appendChild(el("h2", {}, "Work"));
  if (list.length === 0) {
    container.appendChild(el("div", { class: "empty" }, "No work yet — create a story to start."));
  } else if (activeMatch.length === 0) {
    container.appendChild(el("div", { class: "empty" },
      filtering ? "No active work matches the filter." : "No active work."));
  } else {
    container.appendChild(workTable(activeMatch, repaint));
  }

  if (history.length) {
    container.appendChild(historySection(historyMatch, filtering, history.length));
  }
}

// Collapsible "Finished" section for terminal-state tasks. `tasks` is the already
// filtered set; `totalCount` is the unfiltered count for the header. Collapsed by
// default and the open/closed state persists in localStorage across reloads and
// SSE re-renders (which rebuild this node each time) — EXCEPT while a filter is
// active, when the section auto-expands if it has matches so they aren't hidden
// behind the collapse. When filtering, the count reads "<matches> of <total>" to
// make clear the view is narrowed. The body is a compact one-line-per-task
// summary (id, final status, completed time), not the full active-task table.
function historySection(tasks, filtering, totalCount) {
  const open = filtering ? tasks.length > 0 : historyOpen();
  const countLabel = filtering ? `${tasks.length} of ${totalCount}` : String(totalCount);
  const body = el("div", { class: "history-body" });
  const fill = (node) => {
    node.innerHTML = "";
    if (tasks.length) node.appendChild(finishedList(tasks));
    else node.appendChild(el("div", { class: "empty" }, "No finished tasks match the filter."));
  };

  const { panel } = collapsible({
    title: "Finished",
    titleClass: "history-title",
    meta: countLabel,
    metaClass: "history-count",
    body,
    open,
    panelClass: "history",
    headClass: "history-head",
    // The Finished section's state class is `open` (present when expanded), the
    // inverse of the panel default.
    stateClass: "open",
    stateMeansOpen: true,
    // Only persist the collapse preference when not filtering — the filter-driven
    // auto-expand is transient and shouldn't overwrite the user's saved choice.
    persistKey: filtering ? undefined : HISTORY_KEY,
    onToggle: (nowOpen) => { if (nowOpen) fill(body); else body.innerHTML = ""; },
  });
  panel.setAttribute("style", "margin-top:24px");
  if (open) fill(body);
  return panel;
}

// The time a terminal-state task wrapped up: merged tasks report merged_at,
// aborted/rejected report completed_at. Fall back across both, then created_at.
function finishedTime(t) {
  return t.merged_at || t.completed_at || t.created_at;
}

// Compact one-line-per-item list for finished (terminal) WORK: id, final status chip, and when
// it completed. Most-recent first. A finished TASK links to its detail page; a finished STORY
// has no detail route, so it renders as a non-link row with its brief in place of the id.
function finishedList(items) {
  const sorted = items.slice().sort((a, b) =>
    new Date(finishedTime(b) || 0).getTime() - new Date(finishedTime(a) || 0).getTime());
  const list = el("div", { class: "finished-list" });
  for (const t of sorted) {
    const isNode = t.work_kind === "node";
    const label = isNode ? (t.brief || t.id) : t.id;
    const row = isNode
      ? el("div", { class: "finished-row is-node" })
      : el("a", { class: "finished-row", href: "#/task/" + esc(t.id) });
    row.innerHTML = `
      <span class="fr-id" title="${esc(label)}">${esc(label)}</span>
      ${taskChips(t)}${tagChips(t)}
      <span class="fr-when" title="${esc(finishedTime(t) || "")}">${esc(fmtTime(finishedTime(t)))}</span>`;
    list.appendChild(row);
  }
  return list;
}

// The unified work table: stories and tasks as PEER rows. Items are grouped via groupWork (a
// child attaches to its parent node by parent_id||story_id); a top-level orphan task renders at
// root. A STORY is one row (caret + single-line brief, status chip, rollup/leader meta) whose
// child subtask rows ALWAYS render indented one level beneath it (visible by default). Clicking
// a story row toggles only its DETAIL block (full brief + open ask), inserted as a full-width
// row right under it; the children are never hidden by the toggle. `repaint` re-renders the
// results region in place so a caret toggle reflects the module-level expand Set with no fetch.
function workTable(items, repaint) {
  const { topLevel, childrenByNode } = groupWork(items);
  const table = el("table", { class: "tasks" });
  table.innerHTML = `<thead><tr>
    <th>id</th><th>status</th><th>created</th><th></th>
  </tr></thead>`;
  const tb = el("tbody");
  for (const w of topLevel) {
    if (w.work_kind === "node") appendStoryRows(tb, w, childrenByNode.get(w.id) || [], repaint);
    else tb.appendChild(taskRow(w, 0));
  }
  table.appendChild(tb);
  return table;
}

// One TASK row in the unified table. `depth` > 0 marks it as a story's child (indented via the
// is-child class). A task links to its detail/review page; the action label reflects the state.
function taskRow(t, depth) {
  const tr = el("tr", { class: depth ? "is-child" : "" });
  const action = t.status === "in_review" ? "review →"
    : t.status === "spec_review" ? "review spec →"
    : t.status === "needs_info" ? "answer →" : "open →";
  const termLink = termLinkMarkup(t);
  // Feedback states are awaiting the operator — surface the state-kind chip
  // (e.g. "feedback: diff review") so a row that needs a human reads at a glance,
  // rather than just sitting in the list looking like in-flight work.
  const feedback = stateKind(effStatus(t)) === "feedback";
  tr.innerHTML = `
    <td class="id">${esc(t.id)}${pulseMarkup(t)}</td>
    <td>${taskChips(t, { kind: feedback, responder: true })}${tagChips(t)}</td>
    <td class="when">${esc(fmtTime(t.created_at))}</td>
    <td>${isLive(t) ? kindBadge("build") + " " : ""}${termLink ? termLink + " · " : ""}<a href="#/task/${esc(t.id)}">${action}</a></td>`;
  wireTermLink(tr, t.id);
  return tr;
}

// Append a STORY row (+ its expanded detail row when toggled + its always-visible child rows)
// to a table body. The story row carries the caret + single-line brief in the id column, the
// status chip (+ an ask-attention chip when there's an open story ask) in the status column,
// and the subtask rollup + leader state in the meta column. A story has NO detail route, so the
// whole row is clickable to toggle WORK_TREE_EXPANDED (revealing the brief/ask detail row);
// the child subtask rows render indented regardless of that toggle.
function appendStoryRows(tb, story, children, repaint) {
  const expanded = WORK_TREE_EXPANDED.has(story.id);
  const brief = story.brief || "(no brief)";
  // status chip (+ open-ask attention): user-owned ask = the red needs_user_input pill;
  // cto-owned = the muted awaiting-cto note — mirroring the task-level awaiting-who emphasis.
  let chipsHtml = kindBadge("node") + " " + chip(effStatus(story));
  if (story.pending_ask != null) {
    chipsHtml += story.ask_responder === "user"
      ? ' <span class="chip needs_user_input" title="an open story ask was escalated to YOU — expand to answer">needs your input</span>'
      : ' <span class="chip awaiting-cto" title="an open story ask owned by the CTO agent (handled automatically) — you can also answer">awaiting CTO</span>';
  }
  // Secondary lifecycle chip (working/parked/stalled), quiet, AUGMENTING the status chip — see storyLifecycleChip.
  chipsHtml += storyLifecycleChip(story);
  const leader = story.leader || {};
  const leaderState = leader.running ? "leader up" : leader.desired ? "leader down" : "no leader";
  const meta = workRollup(story.counts) + " · " + leaderState;

  const tr = el("tr", { class: "is-node clickable" + (expanded ? " expanded" : "") });
  tr.innerHTML = `
    <td class="id"><span class="work-caret">${expanded ? "▾" : "▸"}</span><span class="story-brief" title="${esc(brief)}">${esc(brief)}</span></td>
    <td>${chipsHtml}</td>
    <td class="when" title="${esc(meta)}">${esc(workRollup(story.counts))} · ${kindBadge("leader")} ${esc(leaderState)}</td>
    <td></td>`;
  tr.addEventListener("click", () => {
    if (WORK_TREE_EXPANDED.has(story.id)) WORK_TREE_EXPANDED.delete(story.id);
    else WORK_TREE_EXPANDED.add(story.id);
    repaint();
  });
  tb.appendChild(tr);

  // Expanded: the detail block (full brief + open ask) as a full-width row directly under the
  // story, ABOVE its children so it reads as the story's own content then its subtasks.
  if (expanded) {
    const dr = el("tr", { class: "story-detail-row" });
    const td = el("td", { colspan: "4" });
    td.appendChild(renderStoryDetail(story));
    dr.appendChild(td);
    tb.appendChild(dr);
  }

  // Child subtask rows ALWAYS render (indented one level), regardless of expand state — so all
  // work stays visible by default; expanding only adds the story's brief/ask detail row above.
  for (const c of children) tb.appendChild(taskRow(c, 1));
}

// List / Graph / Board segmented toggle for the workspace body — the PRIMARY view control.
// Mutates dirView (module scope + localStorage) and calls repaint() to swap the body region —
// the toggle node itself is left in place so the choice sticks across clicks. The workspace
// view re-renders wholesale on every SSE event and reads dirView, so the chosen mode also
// survives live updates without re-wiring anything.
function buildViewToggle(repaint) {
  const bar = el("div", { class: "view-toggle", role: "tablist", "aria-label": "Work view" });
  // The persisted dirView key stays "graph" (internal, in localStorage) but the tab now
  // reads "Pipeline" — the Graph tab is the pipeline-swimlanes view.
  const defs = [["list", "List"], ["graph", "Pipeline"], ["board", "Board"]];
  const btns = {};
  for (const [v, label] of defs) {
    const b = el("button", {
      type: "button",
      class: "vt-btn" + (dirView === v ? " active" : ""),
      role: "tab",
      "aria-selected": dirView === v ? "true" : "false",
    }, label);
    b.addEventListener("click", () => {
      if (dirView === v) return;
      setDirView(v);
      for (const [k, node] of Object.entries(btns)) {
        const on = k === v;
        node.classList.toggle("active", on);
        node.setAttribute("aria-selected", on ? "true" : "false");
      }
      repaint();
    });
    btns[v] = b;
    bar.appendChild(b);
  }
  return bar;
}

// Reverse the blocked_by edges into a dependents map: blocker id → [ids of tasks
// that list it in their blocked_by]. Used to walk the dependency graph the
// other way (from a gating task down to what it gates) for the progress rollup and
// the graph-node annotations. Purely client-side from the already-fetched list.
function reverseDeps(tasks) {
  const m = new Map();
  for (const t of tasks) {
    for (const b of (t.blocked_by || [])) {
      if (!m.has(b)) m.set(b, []);
      m.get(b).push(t.id);
    }
  }
  return m;
}

// The transitive set of task ids a given task GATES — every task that lists it
// (directly or through a chain) in blocked_by. BFS over the reversed edges; the
// `seen` set both collects the result and guards against a stray cycle. The root
// itself is excluded.
function gatedSubtree(rootId, dependentsOf) {
  const seen = new Set();
  const queue = [...(dependentsOf.get(rootId) || [])];
  while (queue.length) {
    const id = queue.shift();
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
function graphLevels(nodeIds, edges) {
  const level = {};
  for (const id of nodeIds) level[id] = 0;
  const incoming = {};
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

// <test-extract:graph-membership> — pure, DOM-free story→subtask membership, unit-tested in
// test/graph-hierarchy.test.ts. The graph's containment (and S3's future grouping) derives from
// this ONE set of rules, so app.js and the tests can't drift.
// A leaf's owning story id: parent_id wins over story_id (the canonical membership rule). A story
// NODE carries neither, so this is only meaningful for leaves.
function graphChildOf(w) { return w && (w.parent_id || w.story_id); }
// The VISIBLE member leaves of a story: every id in `ids` (the rendered node set) whose work item
// is a LEAF owned by `storyId`. Returns leaf ids only — NOT the story itself; callers add the
// story node. Because it filters to `ids`, a member hidden by the generations/depth slider is
// excluded here, so no dangling child-of edge is ever synthesized for a hidden child.
function storyMemberIds(storyId, ids, byId) {
  const out = [];
  for (const cid of ids) {
    const c = byId.get(cid);
    if (c && c.work_kind === "leaf" && graphChildOf(c) === storyId) out.push(cid);
  }
  return out;
}
// A story's TRUE subtask total from its server-computed per-status `counts` rollup (idle is a
// pseudo-bucket, not a real subtask — excluded, mirroring workRollup). Drives the HONEST empty
// state: only a story with ZERO subtasks total is "no subtasks yet"; a story whose children are
// all finished or slider-hidden has counts>0 and is NOT childless.
function storySubtaskTotal(counts) {
  const c = counts || {};
  return Object.keys(c).reduce((n, k) => (k === "idle" ? n : n + (c[k] || 0)), 0);
}
// </test-extract:graph-membership>

// <test-extract:story-lifecycle-ui>
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
function storyLifecycle(story) {
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
// The story's OWN-children progress from its `counts` rollup — done (COMPLETE statuses, mirroring
// workRollup's ✓ via isCompleteStatus) over the TRUE total (storySubtaskTotal, which drops the idle
// pseudo-bucket). Distinct from the graph's dependency-subtree bar (gatedSubtree). total is 0 for a
// childless story, so callers gate the "d/t done" render on total > 0.
function storyProgress(counts) {
  const c = counts || {};
  const done = Object.keys(c).reduce((n, k) => (isCompleteStatus(k) ? n + (c[k] || 0) : n), 0);
  return { done, total: storySubtaskTotal(c) };
}
// Shared lifecycle CHIP (HTML string) for the list row + board card — '' when there's no lifecycle
// to show. Subtle by design (see .chip.lc-*): it must not compete with the colored status chip or
// the S1 kind badge.
function storyLifecycleChip(story) {
  const lc = storyLifecycle(story);
  if (!lc) return "";
  return ` <span class="chip lc-${esc(lc.cls)}" title="story lifecycle — ${esc(lc.key)}">${esc(lc.glyph)} ${esc(lc.key)}</span>`;
}
// </test-extract:story-lifecycle-ui>

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

// <test-extract:swimlane-order> — pure, DOM-free intra-lane ordering, unit-tested in
// test/swimlane-order.test.ts. Orders a story's own leaf ids left → right by longest blocked_by
// chain WITHIN the lane (reusing graphLevels over the intra-lane edges), ties broken by the item's
// original index so the layout is STABLE across renders. Cross-story blockers are ignored for
// ordering — only blocked_by edges BETWEEN the passed member ids count, so a foreign blocker never
// shifts a lane's columns. Pure: no DOM, no globals beyond graphLevels.
function orderLaneLeaves(memberIds, byId) {
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
function swimEmphasis(st) {
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
function laneTitle(brief, id, max = 70) {
  const first = String(brief || "").split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  if (!first) return id;
  return first.length > max ? first.slice(0, max).trimEnd() + "…" : first;
}
// </test-extract:swimlane-order>

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
  const dot = st === "in_progress" ? '<span class="swim-dot" aria-hidden="true"></span>' : "";
  const foreign = (leaf.blocked_by || []).filter((b) => !memberSet.has(b) && byId.has(b));
  const parts = [
    `<div class="swim-step-top"><span class="chip ${esc(st)}">${dot}${esc(st)}</span>` +
      (emph === "attn" ? '<span class="swim-needs">needs you</span>' : "") + `</div>`,
    `<span class="swim-sid">${esc(leaf.id)}</span>`,
  ];
  // A LEAF's description lives in `summary` (its `brief` is always null); it's null until the
  // agent writes one, so a not-yet-run subtask is honestly id-only.
  if (leaf.summary && leaf.summary !== leaf.id) parts.push(`<span class="swim-sum">${esc(leaf.summary)}</span>`);
  if (foreign.length) {
    parts.push(`<span class="swim-xdep" title="blocked by work in another lane">⤴ blocked by ${esc(foreign.join(", "))}</span>`);
  }
  return el("a", {
    class: "swim-step is-" + emph,
    href: "#/task/" + esc(leaf.id),
    "aria-label": `subtask ${leaf.id} — ${st}`,
    html: parts.join(""),
  });
}

// One story LANE: header (kind badge · title · id · status + lifecycle chips · progress) over a
// horizontally-scrollable pipeline of its ACTIVE subtasks. A childless / all-finished story shows a
// compact parked empty-row INSIDE the lane (never a bare box). Finished subtasks collapse behind a
// per-lane "N done" toggle whose expanded state lives in SWIM_DONE_EXPANDED (survives SSE renders).
function swimLane(story, byId, allIds, repaint) {
  const st = effStatus(story);
  const p = storyProgress(story.counts);
  const progHtml = p.total
    ? `<span class="swim-track"><i style="width:${Math.round((100 * p.done) / p.total)}%"></i></span>` +
      `<span class="swim-prog-txt">${p.done} / ${p.total} done</span>`
    : `<span class="swim-prog-txt">not started</span>`;
  // Compact one-line title (clamped) for display; the FULL brief goes in the tooltip.
  const title = laneTitle(story.brief, story.id);
  const fullTitle = story.brief || story.id;
  const hd = el("div", { class: "swim-hd", html:
    `<span class="swim-kind">${kindBadge("node")}</span>` +
    `<span class="swim-title" title="${esc(fullTitle)}">${esc(title)}</span>` +
    `<span class="swim-laneid">${esc(story.id)}</span>` +
    `<div class="swim-meta"><span class="chip ${esc(st)}">${esc(st)}</span>${storyLifecycleChip(story)}` +
    `<div class="swim-prog">${progHtml}</div></div>` });

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
    lane.appendChild(el("div", { class: "swim-empty", html:
      `<span class="chip lc-parked">⏸ parked</span><span class="swim-empty-txt">${esc(msg)}</span>` }));
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
  const row = el("div", {
    class: "swim-done-row", role: "button", tabindex: "0", "aria-expanded": open ? "true" : "false",
    html: `<span class="swim-done-caret">${open ? "▾" : "▸"}</span> ${done.length} done`,
    onclick: toggle,
    onkeydown: (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle(); } },
  });
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
  const hd = el("div", { class: "swim-hd", html:
    `<span class="swim-kind"><span class="kind-badge kind-unknown" title="ungrouped">• UNGROUPED</span></span>` +
    `<span class="swim-title">Ungrouped work</span>` +
    `<span class="swim-laneid">no owning story</span>` });
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
  return el("div", { class: "swim-legend", html: items.map(([cls, txt]) =>
    `<span><i class="swim-ldot ${esc(cls)}"></i> ${esc(txt)}</span>`).join("") });
}

// The Pipeline view entry point (called from the workspace view where dirView === "graph"). Builds
// into a wrapper it can repaint in place, so a lane's done-toggle re-renders instantly without
// waiting for the next SSE tick.
function renderSwimlanes(work) {
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

  wrap.appendChild(el("div", { class: "swim-caption", html:
    "<b>Work pipeline.</b> Each story is a lane; its subtasks run left → right in the order they " +
    "unblock. The item that needs you is the only thing lit; finished work collapses away." }));
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

// ---------- pipeline / merge-train board ----------
// The board view: a KANBAN board of COLUMNS holding the workspace's active (in-flight)
// WORK — both tasks AND stories render as peer cards. Columns are pipeline stages in
// pipeline order, LEFT-TO-RIGHT closest-to-landing first, so "what's happening / what's
// next" reads at a glance. Columns: Spec review · In review (ready to merge) · Needs info ·
// Rolling back (a mechanical revert merge in flight, only when present) · In progress
// (running/idle) · Ready (inactive — queued to dispatch) · Blocked (each card shows the
// blockers it's waiting on and their current status) · Idea.
// A TASK (leaf) maps to the column matching its status; a STORY (node) maps by story
// status — open with unmet blockers → Blocked, open → In progress, merging/merge_blocked
// → In review, done/aborted → omitted (terminal). Terminal-state tasks
// (merged/failed/rolled_back/aborted) aren't part of the pipeline and are likewise omitted —
// they live in the List view's Finished section. Re-rendered wholesale on every
// SSE event by the workspace view, so it live-updates for free.
// <test-extract:board> — pure, DOM-free board-lane classification (unit-tested in
// test/state-meta-fallback.test.ts). boardLaneKeyFor takes activeStatuses explicitly so it
// can be exercised without the module-level ACTIVE_STATUSES table or a DOM.
const BOARD_LANES = [
  { key: "spec_review", title: "Spec review", hint: "spec review" },
  { key: "in_review", title: "In review", hint: "in review" },
  { key: "needs_info", title: "Needs info", hint: "needs info" },
  { key: "rolling_back", title: "Rolling back", hint: "rolling back" },
  { key: "in_progress", title: "In progress", hint: "in progress" },
  { key: "inactive", title: "Ready", hint: "ready" },
  { key: "blocked", title: "Blocked", hint: "blocked" },
  { key: "idea", title: "Idea", hint: "idea" },
];
const BOARD_LANE_KEYS = new Set(BOARD_LANES.map((l) => l.key));

// A blocker is SATISFIED only once the blocking work has LANDED — a leaf task that
// merged, or a story (node) that's done. Anything else (in flight, queued, failed,
// aborted, or an unknown/unresolved id) is still UNMET, so a story waiting on it
// belongs in the Blocked column.
function boardBlockerLanded(w) {
  if (!w) return false;
  return w.work_kind === "node" ? w.status === "done" : w.status === "merged";
}
function boardHasUnmetBlockers(w, byId) {
  return (w.blocked_by || []).some((bid) => !boardBlockerLanded(byId.get(bid)));
}

// Which board COLUMN a work item belongs in, or null to OMIT it (terminal / not in the
// pipeline). A leaf maps to the column matching its status (the lane keys mirror the task
// statuses); a node (story) maps by story status — open-with-unmet-blockers → Blocked,
// open → In progress, merging/merge_blocked → In review, done/aborted → omitted.
function boardLaneKeyFor(w, byId, activeStatuses) {
  if (w.work_kind === "node") {
    if (w.status === "open") return boardHasUnmetBlockers(w, byId) ? "blocked" : "in_progress";
    if (w.status === "merging" || w.status === "merge_blocked") return "in_review";
    return null; // done / aborted / anything terminal → omitted
  }
  // leaf task: only active (non-terminal) statuses appear, in their own-named column.
  if (!activeStatuses.includes(w.status)) return null;
  return BOARD_LANE_KEYS.has(w.status) ? w.status : null;
}
function boardLaneKey(w, byId) {
  return boardLaneKeyFor(w, byId, ACTIVE_STATUSES);
}
// </test-extract:board>

function renderBoard(work) {
  const items = (Array.isArray(work) ? work : []).filter(Boolean);
  // byId spans BOTH leaves and nodes so cross-type blocked_by resolves — a task blocked
  // by a story, or a story blocked by a task, both look up correctly.
  const byId = new Map(items.map((w) => [w.id, w]));

  // Bucket every work item into its column; null-key items (terminal / unmatched) drop out.
  const buckets = new Map(BOARD_LANES.map((l) => [l.key, []]));
  for (const w of items) {
    const key = boardLaneKey(w, byId);
    if (key && buckets.has(key)) buckets.get(key).push(w);
  }
  const total = BOARD_LANES.reduce((n, l) => n + buckets.get(l.key).length, 0);
  if (total === 0) {
    return el("div", { class: "empty" }, "No active work in the pipeline.");
  }

  // Oldest-first within a column: the longest-waiting (review/queued) and the
  // earliest-started (running) bubble to the top — the next thing to act on.
  const byCreated = (a, b) =>
    new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime();

  // One-line "what's happening" caption from the populated columns.
  const summary = BOARD_LANES
    .filter((l) => buckets.get(l.key).length)
    .map((l) => `${buckets.get(l.key).length} ${l.hint}`);

  const board = el("div", { class: "board" });
  board.appendChild(el("div", { class: "board-summary muted" },
    summary.length ? summary.join(" · ") : "Idle."));

  // The horizontal COLUMN track (left-to-right = pipeline order; scrolls if it overflows).
  const cols = el("div", { class: "board-cols" });
  for (const lane of BOARD_LANES) {
    const laneItems = buckets.get(lane.key).sort(byCreated);
    // Always render the core columns so the pipeline skeleton stays visible;
    // the rolling_back and spec_review columns only appear when something is present.
    if ((lane.key === "rolling_back" || lane.key === "spec_review") && laneItems.length === 0) continue;
    cols.appendChild(boardLane(lane, laneItems, byId));
  }
  board.appendChild(cols);
  return board;
}

// One COLUMN: a header (title + count) over a vertical stack of work cards, with a
// status-colored left accent. Empty core columns render a placeholder so the
// pipeline structure reads even when a stage is clear. Cards are tasks OR stories
// (peers): a node renders a story card, a leaf a task card.
function boardLane(lane, items, byId) {
  const sec = el("div", { class: "board-lane lane-" + lane.key });
  sec.appendChild(el("div", { class: "board-lane-head" }, [
    el("span", { class: "bl-title" }, lane.title),
    el("span", { class: "bl-count" }, String(items.length)),
  ]));
  if (items.length === 0) {
    sec.appendChild(el("div", { class: "board-empty muted" }, "—"));
    return sec;
  }
  const cards = el("div", { class: "board-cards" });
  for (const w of items) {
    cards.appendChild(w.work_kind === "node" ? boardStoryCard(w, lane, byId) : boardCard(w, lane, byId));
  }
  sec.appendChild(cards);
  return sec;
}

// The blocker list shared by task and story cards: in the Blocked column, each blocker id
// with its current status — resolved from sibling WORK in this workspace (leaf or node) via
// byId, "unknown" if absent. Aborted blockers will never merge, so they're flagged as stuck.
function boardAppendBlockers(card, w, byId) {
  const ids = w.blocked_by || [];
  if (!ids.length) return;
  const blk = el("div", { class: "bc-blockers" });
  blk.appendChild(el("span", { class: "bc-blk-label muted" }, "blocked by"));
  for (const bid of ids) {
    const b = byId.get(bid);
    const st = b ? effStatus(b) : "unknown";
    const stuck = st === "aborted";
    const isStory = b && b.work_kind === "node";
    const title = stuck ? "will never merge — edit blocked_by to proceed" : bid;
    // A story blocker has NO detail route, so it renders as a non-navigating span (with the
    // story badge, mirroring boardStoryCard); leaf/unknown blockers keep the #/task link.
    const row = isStory
      ? el("span", { class: "bc-blocker is-story" + (stuck ? " stuck" : ""), title })
      : el("a", {
          class: "bc-blocker" + (stuck ? " stuck" : ""),
          href: "#/task/" + esc(bid),
          title,
        });
    row.innerHTML = isStory
      ? `${kindBadge("node")}<span class="bk-id">${esc(bid)}</span>${chip(st)}`
      : `<span class="bk-id">${esc(bid)}</span>${chip(st)}`;
    blk.appendChild(row);
  }
  card.appendChild(blk);
}

// One task card: id (links to the detail page), status chip(s), created time, and
// a live-terminal link when the agent pane is up. Blocked cards additionally list
// each blocker with its current status (boardAppendBlockers).
function boardCard(t, lane, byId) {
  const card = el("div", { class: "board-card" });
  const termLink = termLinkMarkup(t);
  card.innerHTML = `
    <div class="bc-top">
      <a class="bc-id" href="#/task/${esc(t.id)}">${esc(t.id)}</a>
      <span class="bc-chips">${taskChips(t, { plan: true, responder: true })}</span>
    </div>
    <div class="bc-meta">
      <span class="bc-when" title="${esc(t.created_at || "")}">created ${esc(fmtTime(t.created_at))}</span>
      ${isLive(t) ? kindBadge("build") : ""}
      ${termLink ? `<span class="bc-term">${termLink}</span>` : ""}
    </div>
    ${tagChips(t) ? `<div class="bc-tags">${tagChips(t)}</div>` : ""}
    ${pulseMarkup(t)}`;

  if (lane.key === "blocked") boardAppendBlockers(card, t, byId);

  wireTermLink(card, t.id);
  return card;
}

// One STORY card — a PEER of the task card, same visual language, distinguished only by a
// subtle "story" badge. A story has NO detail route, so the id is plain text (not a link)
// and the card does not navigate. Shows: badge + id, status chip, and a meta line of the
// subtask rollup (workRollup) + leader state. Blocked stories list their blockers exactly
// like a task card does (boardAppendBlockers).
function boardStoryCard(s, lane, byId) {
  const card = el("div", { class: "board-card story-card" });
  const leader = s.leader || {};
  const leaderState = leader.running ? "leader up" : leader.desired ? "leader down" : "no leader";
  const meta = workRollup(s.counts) + " · " + leaderState;
  card.innerHTML = `
    <div class="bc-top">
      <span class="bc-id">${kindBadge("node")}<span class="bc-story-id">${esc(s.id)}</span></span>
      <span class="bc-chips">${chip(effStatus(s))}${storyLifecycleChip(s)}</span>
    </div>
    <div class="bc-meta">
      <span class="bc-when" title="${esc(meta)}">${esc(workRollup(s.counts))} · ${kindBadge("leader")} ${esc(leaderState)}</span>
    </div>`;

  if (lane.key === "blocked") boardAppendBlockers(card, s, byId);

  return card;
}

// CI GATE badge for the review panel. ci_status: 'running' shows a spinner;
// 'pass'/'fail' show a green/red badge whose label is the first line of ci_summary
// ("build + N tests" / "build failed" / "K test failures"); anything else (null)
// is a neutral "not run". The rest of ci_summary (the output tail) is offered as a
// collapsible detail under the badge so a reviewer can see why CI failed.
function ciBadge(t) {
  const status = t.ci_status || null;
  const summary = t.ci_summary || "";
  const nl = summary.indexOf("\n");
  const label = (nl === -1 ? summary : summary.slice(0, nl)).trim();
  const detail = nl === -1 ? "" : summary.slice(nl).trim();

  const wrap = el("div", { class: "ci-gate" });
  let badge;
  if (status === "running") {
    badge = el("span", { class: "ci-badge running" }, [
      el("span", { class: "ci-spinner" }),
      el("span", {}, "CI running…"),
    ]);
  } else if (status === "pass") {
    badge = el("span", { class: "ci-badge pass" }, "✓ " + (label || "build + tests"));
  } else if (status === "fail") {
    badge = el("span", { class: "ci-badge fail" }, "✗ " + (label || "build failed"));
  } else {
    badge = el("span", { class: "ci-badge none" }, "CI not run");
  }
  wrap.appendChild(badge);

  // Collapsible output tail (only when CI has settled with detail to show).
  if (detail && status !== "running") {
    const pre = el("pre", { class: "block ci-detail-body" }, detail);
    const { panel } = collapsible({
      title: "output",
      body: pre,
      open: false,
      panelClass: "ci-detail",
      headClass: "ci-detail-toggle",
    });
    wrap.appendChild(panel);
  }
  return wrap;
}

// SPEC-CONFORMANCE badge for the review panel, shown next to the CI badge.
// conformance_status: 'checking' shows a spinner; 'pass' shows a green "conforms";
// 'concern' shows an amber "concern: <reason>" (the reviewer's reason in
// conformance_summary); null/absent renders nothing (best-effort — it may not run).
// Whereas CI proves the change builds + tests pass, this judges whether the diff
// actually did what the task asked — an orthogonal, advisory signal.
function conformanceBadge(t) {
  const status = t.conformance_status || null;
  if (!status) return null; // not run / couldn't run — show nothing
  const reason = (t.conformance_summary || "").trim();
  let badge;
  if (status === "checking") {
    badge = el("span", { class: "conf-badge checking" }, [
      el("span", { class: "ci-spinner" }),
      el("span", {}, "conformance…"),
    ]);
  } else if (status === "pass") {
    badge = el("span", { class: "conf-badge pass", title: reason || "conforms" }, "✓ conforms");
  } else {
    // 'concern' — amber, with the reviewer's reason inline (truncated) + full on hover.
    const short = reason.length > 140 ? reason.slice(0, 140) + "…" : reason;
    badge = el(
      "span",
      { class: "conf-badge concern", title: reason || "concern" },
      "⚠ concern" + (short ? ": " + short : ""),
    );
  }
  return el("span", { class: "conf-gate" }, [badge]);
}

// ---------- task detail / review ----------
// Compact vertical AUDIT TIMELINE of a task's status transitions (oldest → newest):
// one row per change with the transition (from → to chips) and the short note that
// explains why it moved, plus a relative timestamp (full ISO on hover). Driven by
// GET /api/work/:id/events. Returns null when there are no recorded events.
function renderTimeline(events) {
  if (!Array.isArray(events) || events.length === 0) return null;
  const panel = el("div", { class: "panel timeline-panel" });
  panel.appendChild(el("h2", { style: "margin-top:0" }, "Timeline"));
  const list = el("div", { class: "timeline" });
  for (const ev of events) {
    const transition = ev.from_status && ev.from_status !== ev.to_status
      ? `${chip(ev.from_status)}<span class="tl-arrow">→</span>${chip(ev.to_status)}`
      : chip(ev.to_status);
    const row = el("div", { class: "tl-event" });
    row.innerHTML = `
      <span class="tl-dot ${esc(ev.to_status)}"></span>
      <div class="tl-body">
        <div class="tl-head">
          <span class="tl-transition">${transition}</span>
          <span class="tl-time" title="${esc(ev.at)}">${esc(fmtTime(ev.at))}</span>
        </div>
        ${ev.note ? `<div class="tl-note">${esc(ev.note)}</div>` : ""}
      </div>`;
    list.appendChild(row);
  }
  panel.appendChild(list);
  return panel;
}

// Human label for a task's model: the requested model, and (when known and
// different) the model it actually ran under per the session transcript. An unset
// request shows "default", annotated with what the default resolved to if captured.
function modelLabel(t) {
  const want = (t.model || "").trim();
  const used = (t.model_used || "").trim();
  if (want && used && want !== used) return `${want} (ran as ${used})`;
  if (want) return want;
  if (used) return `default (${used})`;
  return "default";
}

// Compact token-usage summary built from the captured session totals. Returns "—"
// until any usage has been recorded. Numbers only → safe to inject as HTML.
function tokensLabel(t) {
  const inT = t.usage_input_tokens, outT = t.usage_output_tokens;
  const cr = t.usage_cache_read_tokens, cw = t.usage_cache_creation_tokens;
  const has = [inT, outT, cr, cw].some((n) => typeof n === "number" && n > 0);
  if (!has) return "—";
  const n = (v) => (typeof v === "number" ? v : 0).toLocaleString();
  const total = (inT || 0) + (outT || 0) + (cr || 0) + (cw || 0);
  return `${n(total)} total <span class="muted">· in ${n(inT)} · out ${n(outT)} `
    + `· cache r ${n(cr)} / w ${n(cw)}</span>`;
}

// Cost label. The session transcript records tokens but no dollar cost and butchr
// has no pricing table, so we show "—" (not tracked) rather than fabricate a number.
function costLabel(t) {
  return typeof t.cost_usd === "number" ? `$${t.cost_usd.toFixed(4)}` : "— (not tracked)";
}

// ROUGH duration estimate, rendered as a loose p50–p90 RANGE with its sample size —
// deliberately hedged ("~", "rough"), never a promise. Prefers the to-merge range,
// falling back to to-review; says "insufficient data" when history is too thin.
// Numbers are formatted via fmtDuration; the bucket/basis annotation is escaped.
const INSUFFICIENT = `insufficient data <span class="muted">· not enough history yet</span>`;
function fmtEstimate(est) {
  if (!est) return "—";
  if (est.insufficient) return INSUFFICIENT;
  const r = est.toMerge || est.toReview;
  if (!r) return INSUFFICIENT;
  const label = est.toMerge ? "to merge" : "to review";
  const bucket = est.basis === "overall" ? "all tasks" : `${est.bucket} ${est.basis}`;
  return `est ~${fmtDuration(r.p50Ms)}–${fmtDuration(r.p90Ms)} `
    + `<span class="muted">· ${label} · n=${est.n} · ${esc(bucket)} · rough</span>`;
}

// Critical-path estimate across a task's dependency chain (a blocked task's
// blockers). Returns null when there's nothing pending to chain.
function fmtChain(chain) {
  if (!chain || chain.taskCount === 0 || chain.p50Ms == null) return null;
  const n = chain.taskCount;
  const partial = chain.insufficient
    ? ' <span class="muted">· partial — some tasks lack history</span>'
    : "";
  return `est ~${fmtDuration(chain.p50Ms)}–${fmtDuration(chain.p90Ms)} `
    + `<span class="muted">· critical path across ${n} task${n === 1 ? "" : "s"} · rough</span>${partial}`;
}

// ---------- agent transcript panel state ----------
// The transcript is large and read straight off disk, so we fetch it lazily (only
// on first open) and page it. `transcriptOpen` persists the open/closed choice
// across SSE re-renders; `transcriptState` caches the loaded turns for ONE task at
// a time (reset when a different task's panel is built).
let transcriptOpen = false;
const transcriptState = { id: null, turns: [], total: 0, loaded: false, loading: false };
const TRANSCRIPT_PAGE = 200;

// Render one transcript item (one content block) as a labelled, monospace row.
function renderTranscriptItem(it) {
  const row = el("div", { class: `ts-item ts-${esc(it.kind)} role-${esc(it.role)}` });
  const time = it.ts
    ? `<span class="ts-time" title="${esc(it.ts)}">${esc(fmtTime(it.ts))}</span>` : "";
  const trunc = it.truncated ? '<span class="ts-trunc"> … (truncated)</span>' : "";
  let label, bodyHtml;
  if (it.kind === "tool_use") {
    label = `<span class="ts-label tool">⚙ ${esc(it.tool)}</span>`;
    bodyHtml = it.args ? `<code class="ts-args">${esc(it.args)}</code>` : "";
  } else if (it.kind === "tool_result") {
    label = `<span class="ts-label result">↳ result</span>`;
    bodyHtml = `<pre class="ts-pre">${esc(it.text || "")}${trunc}</pre>`;
  } else if (it.kind === "thinking") {
    label = `<span class="ts-label thinking">${esc(it.role)} · thinking</span>`;
    bodyHtml = `<pre class="ts-pre">${esc(it.text || "")}${trunc}</pre>`;
  } else {
    label = `<span class="ts-label ${esc(it.role)}">${esc(it.role)}</span>`;
    bodyHtml = `<pre class="ts-pre">${esc(it.text || "")}${trunc}</pre>`;
  }
  row.innerHTML = `<div class="ts-head">${label}${time}</div>${bodyHtml}`;
  return row;
}

// Build the collapsible "Agent transcript" panel for a task. Lazy: nothing is
// fetched until the panel is opened; subsequent pages append via "Load more".
function renderTranscriptPanel(id) {
  // New task → drop any cached turns from a previously-viewed one.
  if (transcriptState.id !== id) {
    transcriptState.id = id;
    transcriptState.turns = [];
    transcriptState.total = 0;
    transcriptState.loaded = false;
    transcriptState.loading = false;
  }

  const body = el("div", { class: "transcript-body" });

  const renderBody = () => {
    body.innerHTML = "";
    if (transcriptState.loading && !transcriptState.turns.length) {
      body.appendChild(el("div", { class: "ts-empty" }, "loading transcript…"));
      return;
    }
    if (transcriptState.loaded && !transcriptState.turns.length) {
      body.appendChild(el("div", { class: "ts-empty" }, "No transcript available for this task yet."));
      return;
    }
    for (const it of transcriptState.turns) body.appendChild(renderTranscriptItem(it));
    if (transcriptState.turns.length < transcriptState.total) {
      const more = el("button", { class: "btn ghost ts-more" },
        `Load more (${transcriptState.turns.length} of ${transcriptState.total})`);
      more.addEventListener("click", () => load(more));
      body.appendChild(more);
    }
  };

  const load = async (moreBtn) => {
    if (transcriptState.loading) return;
    transcriptState.loading = true;
    if (moreBtn) moreBtn.disabled = true; else renderBody();
    try {
      const offset = transcriptState.turns.length;
      const r = await api("GET",
        `/work/${id}/transcript?offset=${offset}&limit=${TRANSCRIPT_PAGE}`);
      transcriptState.turns = transcriptState.turns.concat(r.turns || []);
      transcriptState.total = r.total || 0;
      transcriptState.loaded = true;
    } catch (e) {
      transcriptState.loaded = true;
      toast(e.message, true);
    } finally {
      transcriptState.loading = false;
      renderBody();
    }
  };

  const { panel } = collapsible({
    title: "Agent transcript",
    titleClass: "ts-title",
    meta: "what the agent did · read-only",
    metaClass: "ts-hint",
    body,
    open: transcriptOpen,
    panelClass: "panel transcript",
    headClass: "transcript-head",
    onToggle: (open) => {
      transcriptOpen = open;
      if (open && !transcriptState.loaded && !transcriptState.loading) load();
      else renderBody();
    },
  });

  if (transcriptOpen) {
    if (!transcriptState.loaded && !transcriptState.loading) load();
    else renderBody();
  }
  return panel;
}

// Sub-task PROGRESS ROLLUP — for a task that GATES others (its id appears in their
// blocked_by), summarize how far the
// dependent sub-tree has landed. Walks the reversed edges of the workspace's task
// list (no extra API field needed) to find the transitive sub-tree, then counts the
// merged ones. Returns null when the task gates nothing, so a leaf task shows no
// rollup. `direct` is the immediate dependents (for the per-child status list);
// `total`/`merged` cover the whole transitive sub-tree.
function dependentRollup(rootId, tasks) {
  const dependentsOf = reverseDeps(tasks);
  const directIds = dependentsOf.get(rootId) || [];
  if (directIds.length === 0) return null;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const subtree = [...gatedSubtree(rootId, dependentsOf)].map((sid) => byId.get(sid)).filter(Boolean);
  const direct = directIds.map((did) => byId.get(did)).filter(Boolean);
  // COMPLETE, not just `merged` — a dependent STORY completes at status `done`, so the merged-only
  // count under-reported any subtree containing one (mirrors the graph sub-bar; see isCompleteStatus).
  const merged = subtree.filter((t) => isCompleteStatus(t.status)).length;
  return { direct, total: subtree.length, merged };
}

// Append a heading + monospace block pair to `parent`. el() escapes a text child,
// so callers pass the RAW string (no esc()/innerHTML) — the recurring "<h2> + <pre
// class=block>" pair in the task detail (prompt, review notes, summary, output, …).
function block(heading, text, parent) {
  parent.appendChild(el("h2", {}, heading));
  parent.appendChild(el("pre", { class: "block" }, text));
}

// One ".blocker-row": the id (linked to its task) plus an optional status chip, with
// a "dead" flag (terminal blocker that will never merge) adding the class + warning.
// Pass a falsy `status` to omit the chip (an id-only row).
function blockerRow(id, status, { dead = false } = {}) {
  const row = el("div", { class: "blocker-row" + (dead ? " dead" : "") });
  row.innerHTML = `<a class="bk-id" href="#/task/${esc(id)}">${esc(id)}</a>`
    + (status ? chip(status) : "")
    + (dead ? '<span class="bk-dead">will never merge — edit blocked_by to proceed</span>' : "");
  return row;
}

// The shared scaffold behind the task-detail dependency panels (blocked-by,
// rollup): a ".panel" (distinguished by `cls`) with a margin-collapsed h2 heading, an
// optional chain-estimate line, optional `lead` nodes (the rollup's summary/bar), and
// a ".blockers" list of `rows`.
function listPanel(heading, rows, { chainLine, cls = "", lead } = {}) {
  const panel = el("div", { class: "panel" + (cls ? " " + cls : "") });
  panel.appendChild(el("h2", { style: "margin-top:0" }, heading));
  if (chainLine) panel.appendChild(el("div", { class: "chain-est", html: chainLine }));
  for (const node of [].concat(lead || [])) panel.appendChild(node);
  panel.appendChild(el("div", { class: "blockers" }, rows));
  return panel;
}

// Render the sub-task progress rollup panel: "N/M merged", a progress bar, and the
// direct dependents with their live statuses (so the gated sub-tree's progress reads
// at a glance). Live-updates for free — the task page re-renders on every SSE event.
// Returns null when there's nothing to roll up.
function rollupPanel(rollup) {
  if (!rollup) return null;
  const { direct, total, merged } = rollup;
  const pct = total ? Math.round((merged / total) * 100) : 0;
  const lead = [
    el("div", { class: "rollup-summary" }, [
      el("span", { class: "rollup-frac" }, `${merged}/${total} merged`),
      el("span", { class: "rollup-pct muted" }, `${pct}%`),
    ]),
    el("div", { class: "rollup-bar", role: "progressbar",
      "aria-valuenow": String(merged), "aria-valuemin": "0", "aria-valuemax": String(total) }, [
      el("div", { class: "rollup-bar-fill", style: `width:${pct}%` }),
    ]),
  ];
  const nested = total - direct.length;
  if (nested > 0) {
    lead.push(el("div", { class: "rollup-nested muted" },
      `${direct.length} direct · +${nested} nested sub-task${nested === 1 ? "" : "s"}`));
  }
  const rows = direct.map((c) => blockerRow(c.id, effStatus(c)));
  return listPanel("Sub-task progress", rows, { cls: "rollup-panel", lead });
}

async function renderTask(id) {
  const t = await api("GET", "/work/" + id);
  const dirs = await api("GET", "/workspaces");
  const dir = dirs.find((x) => x.id === t.workspace_id);

  const wrap = el("div");
  wrap.appendChild(el("div", {
    class: "crumbs",
    html: `<a href="#/">Workspaces</a> / <a href="#/workspace/${esc(t.workspace_id)}">${esc(dir ? (dir.label || dir.path) : t.workspace_id)}</a> / ${esc(t.id)}`,
  }));
  const headerRight = el("div", { class: "row", style: "gap:10px" });
  if (isLive(t)) {
    const term = el("button", { class: "btn ghost" }, "⌗ Open terminal");
    term.addEventListener("click", () => openTaskTerminal(t.id, term));
    headerRight.appendChild(term);
  }
  headerRight.appendChild(el("div", {
    html: taskChips(t, { plan: true, kind: true }),
  }));
  // Abort is available from any non-terminal state (TERMINAL_STATUSES comes from the
  // server meta), EXCEPT `rolling_back` — a mechanical merge in flight with no live
  // agent to stop.
  const canAbort = !TERMINAL_STATUSES.includes(t.status) && t.status !== "rolling_back";
  if (canAbort) {
    const abortBtn = el("button", { class: "btn ghost danger-outline", id: "abort" }, "Abort task");
    headerRight.appendChild(abortBtn);
  }
  // Roll back: create a deliberate ROLLBACK TASK (from the built-in `rollback`
  // template) that reverts this merged task's change AND repairs any fallout, then
  // flows through the normal dispatch → CI gate → review → merge → post-merge-verify
  // pipeline like any task — NOT a mechanical bypass. Offered only for a merged task
  // whose merge range was recorded (older merges have no commit to pre-fill).
  const canRollback = t.status === "merged"
    && !!t.merge_base_sha && !!t.merged_sha && t.merge_base_sha !== t.merged_sha;
  if (canRollback) {
    headerRight.appendChild(el("button", { class: "btn ghost danger-outline", id: "rollback" }, "Roll back"));
  }
  wrap.appendChild(el("div", { class: "row between" }, [
    el("h1", { html: `<span style="font-family:var(--mono)">${esc(t.id)}</span>` }),
    headerRight,
  ]));

  // NEEDS-YOUR-INPUT card — surfaced FIRST (above the metadata) when the live agent is wedged
  // at a human-only prompt, so the highest-attention state and its resolve controls (open
  // terminal / one-click confirm) read immediately. Resolves on the next SSE update once the
  // agent moves past the prompt and the safety-net watcher clears the flag.
  if (effStatus(t) === "needs_user_input") wrap.appendChild(needsUserInputPanel(t));

  // metadata
  const meta = el("div", { class: "panel" });
  meta.innerHTML = `<div class="meta-grid">
    <div class="k">status</div><div class="v">${esc(statusLabel(effStatus(t)))}</div>
    ${t.liveness ? `<div class="k">liveness</div><div class="v" title="${esc(t.liveness.evidence)}">${livenessChip(t.liveness)}</div>` : ""}
    ${Array.isArray(t.tags) && t.tags.length ? `<div class="k">tags</div><div class="v">${tagChips(t)}</div>` : ""}
    ${Array.isArray(t.allowlist) && t.allowlist.length ? `<div class="k">allowlist</div><div class="v">${t.allowlist.map((a) => `<code>${esc(a)}</code>`).join(" ")}</div>` : ""}
    <div class="k">priority</div><div class="v">${esc(String(t.priority ?? 0))}</div>
    <div class="k">created</div><div class="v">${esc(t.created_at || "—")}</div>
    <div class="k">started</div><div class="v">${esc(t.started_at || "—")}</div>
    <div class="k">completed</div><div class="v">${esc(t.completed_at || "—")}</div>
    <div class="k">merged</div><div class="v">${esc(t.merged_at || "—")}</div>
    ${t.estimate ? `<div class="k">est. duration</div><div class="v">${fmtEstimate(t.estimate)}</div>` : ""}
    <div class="k">model</div><div class="v">${esc(modelLabel(t))}</div>
    <div class="k">tokens</div><div class="v">${tokensLabel(t)}</div>
    <div class="k">cost</div><div class="v">${esc(costLabel(t))}</div>
  </div>`;
  wrap.appendChild(meta);

  // Rough critical-path estimate across this task's dependency chain (a blocked
  // task's blockers). Best-effort — a fetch failure or a
  // null chain just omits the line. The task's OWN estimate already rides on
  // t.estimate (shown in the meta grid above).
  const estData = await api("GET", "/work/" + id + "/estimate").catch(() => null);
  const chainLine = estData ? fmtChain(estData.chain) : null;

  // audit timeline — the task's status-transition history (best-effort: a fetch
  // failure just omits the panel rather than breaking the detail view).
  const events = await api("GET", "/work/" + id + "/events").catch(() => []);
  const timeline = renderTimeline(events);
  if (timeline) wrap.appendChild(timeline);

  // blocked-by — what this task is waiting on. Shown whenever the task has a
  // dependency set, with each blocker's current status; dead blockers (terminal,
  // never-merging) are flagged so a stuck `blocked` task is obvious. The list of
  // blocker statuses comes back on the task view (blockerStates), computed below.
  if (Array.isArray(t.blocked_by) && t.blocked_by.length) {
    const dead = new Set(t.deadBlockers || []);
    const head = t.status === "blocked" ? "Blocked — waiting on:" : "Depends on:";
    const rows = t.blocked_by.map((bid) => blockerRow(
      bid,
      (t.blockerStates && t.blockerStates[bid]) || "unknown",
      { dead: dead.has(bid) },
    ));
    wrap.appendChild(listPanel(head, rows, { chainLine, cls: "blocked-panel" }));
  }

  // sub-task progress rollup — if this task GATES others (its id is in their
  // blocked_by), summarize how far the dependent sub-tree has merged: a fraction, a
  // progress bar, and the direct children with their statuses. Computed purely
  // client-side from the workspace's task list (no extra API field); best-effort —
  // a fetch failure just omits the panel — and nothing renders for a task with no
  // dependents. Re-fetched on each render so it live-updates via the SSE re-render.
  // The sibling LEAF tasks in this workspace (for the dependent-subtree rollup) — the leaf
  // members of the unified work list. null (not []) on failure so the rollup is skipped.
  const siblingWork = await api("GET", "/work?workspace=" + encodeURIComponent(t.workspace_id)).catch(() => null);
  const siblings = siblingWork ? workLeaves(siblingWork) : null;
  const rollup = siblings ? dependentRollup(t.id, siblings) : null;
  if (rollup) wrap.appendChild(rollupPanel(rollup));

  // prompt
  block("Prompt", t.prompt || "—", wrap);

  // aborted with revert_reason — the task's merge was fast-forwarded into main but the
  // post-merge verify gate (build + tests) came back RED, so the merge was auto-reverted
  // off main and the task flagged as aborted. Surface that distinctly with the failing
  // build/test output. Re-queue re-launches the agent (worktree + branch were kept).
  // An aborted task WITHOUT revert_reason was a dispatch give-up or operator abort.
  if (t.status === "aborted" && t.revert_reason) {
    const panel = el("div", { class: "panel failed-panel" });
    panel.innerHTML = `
      <h2 style="margin-top:0">Merge auto-reverted off main</h2>
      <p class="muted" style="margin:0 0 10px">This branch merged, but the post-merge verify (build + tests) failed on the default branch, so the merge was reverted to keep main green. The branch + worktree were kept.</p>
      <pre class="block">${esc(t.revert_reason)}</pre>
      <div class="row" style="margin-top:12px">
        <button class="btn" id="requeue">Re-queue</button>
        <small class="muted">Re-launches the agent (in-context) to fix the breakage, then it can be re-reviewed.</small>
      </div>`;
    wrap.appendChild(panel);
  } else if (t.status === "aborted" && t.last_dispatch_error) {
    const n = t.dispatch_attempts || 0;
    const panel = el("div", { class: "panel failed-panel" });
    panel.innerHTML = `
      <h2 style="margin-top:0">Dispatch failed</h2>
      <p class="muted" style="margin:0 0 10px">Failed after ${n} dispatch attempt${n === 1 ? "" : "s"}. The agent never started.</p>
      <pre class="block">${esc(t.last_dispatch_error || "(no error recorded)")}</pre>
      <div class="row" style="margin-top:12px">
        <button class="btn" id="requeue">Re-queue</button>
        <small class="muted">Clears the retry state and dispatches again from scratch.</small>
      </div>`;
    wrap.appendChild(panel);
  }

  // live output — best-effort snapshot of the agent's recent terminal output,
  // polled while the panel is open and the task still has a live pane. This is a
  // convenience view; the git diff below stays the source of truth for review.
  if (isLive(t)) {
    if (liveOutputCacheId !== t.id) { liveOutputCache = ""; liveOutputCacheId = t.id; }
    const pre = el("pre", { class: "block live-output-body" },
      liveOutputCache || "loading recent output…");

    const poll = async () => {
      try {
        const r = await api("GET", "/work/" + t.id + "/output");
        const text = (r.output || "").trimEnd();
        liveOutputCache = text;
        // Keep the view pinned to the newest output if already scrolled to bottom.
        const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 24;
        pre.textContent = text || "(no recent output)";
        if (atBottom) pre.scrollTop = pre.scrollHeight;
      } catch { /* transient — keep whatever was there */ }
    };
    const startPolling = () => { stopLiveOutput(); poll(); liveOutputTimer = setInterval(poll, 2500); };

    const { panel } = collapsible({
      title: "Live output",
      titleClass: "lo-title",
      meta: "best-effort · updates every few seconds",
      metaClass: "lo-hint",
      body: pre,
      open: liveOutputOpen,
      panelClass: "panel live-output",
      headClass: "live-output-head",
      onToggle: (open) => {
        liveOutputOpen = open;
        if (open) startPolling(); else stopLiveOutput();
      },
    });
    if (liveOutputOpen) startPolling();
    wrap.appendChild(panel);
  }

  // review notes
  if (t.review_notes) block("Review notes", t.review_notes, wrap);

  // agent summary (from request_review)
  if (t.summary) block("Agent summary", t.summary, wrap);

  // output snapshot — the agent's last captured output (its final build output on a
  // merged task, or the rescue snapshot otherwise).
  if (t.output_snapshot) {
    block(t.status === "merged" ? "Agent output" : "Agent output (snapshot)", t.output_snapshot, wrap);
  }

  // agent transcript — a readable, lazily-fetched view of what the session's agent
  // actually did (prose, thinking, tool calls + truncated results). Collapsible and
  // read-only; only offered once the task has a session to read. The body is fetched
  // on first open (transcripts get large) and paged via a "Load more" button.
  if (t.session_id) wrap.appendChild(renderTranscriptPanel(t.id));

  // AWAITING-WHO BANNER. For a task awaiting feedback, surface WHO is expected to act — the
  // server-computed STRUCTURAL `pending_responder` (story|cto|ceo|user). `user` is emphasized
  // ("awaiting you"); `cto` / `story` are muted (an agent — the CTO, or the story leader —
  // handles it, but you can also act). butchr is responder-agnostic: the action controls
  // below render regardless. Null pending_responder (non-feedback state) shows no banner.
  // REVAMP-4 P3a: `ceo` (a project container's supervisor) is DORMANT — the server never emits
  // it (no project nodes in prod), so a defensive `ceo` value would fall to the muted `else`
  // (awaiting-cto styling); the dedicated CEO banner is P3c, when the CEO surface lands.
  if (t.pending_responder) {
    const stepLbl = feedbackStepLabel(t);
    const stepStr = stepLbl ? ` (${esc(stepLbl)})` : "";
    let html;
    if (t.pending_responder === "user") {
      html = `<strong>Awaiting you</strong> — this${stepStr} is assigned to <strong>you</strong>. Act in the controls below.`;
    } else if (t.pending_responder === "story") {
      html = `<strong>Awaiting the story leader</strong> — this${stepStr} is handled automatically by the story leader agent. You can also act in the controls below.`;
    } else {
      html = `<strong>Awaiting the CTO agent</strong> — this${stepStr} is handled automatically by this workspace's CTO agent. You can also act in the controls below.`;
    }
    wrap.appendChild(el("div", {
      class: "responder-banner " + (t.pending_responder === "user" ? "awaiting-you" : "awaiting-cto"),
      html,
    }));
  }

  // Shared submit wrapper for the feedback control panels below: POST `path` (relative
  // to this task) with `body`, toast `successMsg`, then return to the workspace list
  // (the next thing you want after acting). Each panel builder closes over this and
  // wires its OWN buttons before it's appended, so a control's build + wire live in one
  // place instead of split across a panel block here and a getElementById block far below.
  const submitTo = (btn, path, body, successMsg) =>
    action(btn, () => api("POST", "/work/" + id + path, body), {
      success: successMsg,
      onDone: () => backToWorkspace(t.workspace_id),
    });

  // diff + review controls (when in_review)
  if (t.status === "in_review") {
    // CI GATE badge — shown BEFORE the diff. Reflects the build/test job butchr
    // runs in the task's worktree on the in_review transition; updates live via the
    // SSE-driven re-render when CI flips running→pass/fail.
    wrap.appendChild(ciBadge(t));
    // SPEC-CONFORMANCE badge — next to the CI badge. Reflects the read-only reviewer
    // that judges whether the diff satisfies the prompt; null when it didn't run.
    const confBadge = conformanceBadge(t);
    if (confBadge) wrap.appendChild(confBadge);

    // MAJOR-VERSION DOUBLE-CONFIRM banner. In a release_mode workspace a major-bump task
    // does NOT merge on Approve — Approve PARKS it. Landing it is the HUMAN's deliberate
    // double-confirm: two CONSECUTIVE Confirm clicks (streak 0→1→2); ANY other action
    // (Approve, Request change, re-review, …) resets the streak to 0. Shown only off the
    // workspace view's release_mode (no hardcoded id) + the task's declared major bump, so
    // it's invisible everywhere else. The streak count comes straight off the task view.
    if (dir && dir.release_mode && t.version_bump === "major") {
      const n = t.major_confirm_count || 0;
      const banner = el("div", { class: "panel major-confirm-panel" });
      banner.innerHTML = `
        <h2 style="margin-top:0">Awaiting major-version confirmation (${esc(String(n))}/2)</h2>
        <p class="muted" style="margin:0 0 10px">This task declares a <strong>major</strong> version bump, so merging it is a deliberate human double-confirm — <strong>Approve does not merge it</strong>. Click <strong>Confirm major version</strong> <strong>twice in a row</strong> (streak ${esc(String(n))}/2); the second consecutive confirm lands the merge. <strong>Any other action</strong> (Approve, Request change, re-review, re-declaring the bump) <strong>resets the streak to 0</strong>.</p>
        <div class="row">
          <button class="btn danger" id="confirm-major">Confirm major version (${esc(String(n))}/2)</button>
          <small class="muted">Two consecutive confirms required — this is the human gate on a breaking release.</small>
        </div>`;
      banner.querySelector("#confirm-major").addEventListener("click", (ev) => {
        let merged = false;
        action(ev.target, async () => {
          const r = await api("POST", "/work/" + id + "/confirm-major");
          if (r && r.conflictSentBack) {
            toast("Merge conflict — sent back to the agent to resolve");
            merged = true;
          } else if (r && r.revertedOnRed) {
            toast("Merged but verify FAILED — auto-reverted off main", true);
            merged = true;
          } else if (r && r.awaitingMajorConfirm) {
            const c = (r.task && r.task.major_confirm_count) || 0;
            toast(`Major-version confirmation ${c}/2 — one more consecutive confirm to merge`);
          } else {
            // Streak reached 2 → merged. The returned task view carries released_version.
            merged = true;
            const v = r && r.released_version;
            toast(`Confirmed ✓ — merged${v ? ` (v${v})` : ""}`);
          }
          // On a still-awaiting confirm, re-render IN PLACE so the operator sees the
          // streak tick up and can click the second confirm; otherwise leave for the list.
        }, { onDone: () => (merged ? backToWorkspace(t.workspace_id) : render()) });
      });
      wrap.appendChild(banner);
    }

    wrap.appendChild(el("h2", {}, "Diff vs main"));
    const diffBox = el("div", { class: "diffview" }, [el("div", { class: "meta" }, "loading diff…")]);
    wrap.appendChild(diffBox);
    api("GET", "/work/" + id + "/diff")
      .then((d) => { diffBox.innerHTML = renderDiff(d.diff); wireDiff(diffBox, id); })
      .catch((e) => { diffBox.innerHTML = `<div class="meta">diff error: ${esc(e.message)}</div>`; });

    const controls = el("div", { class: "panel", style: "margin-top:18px" });
    controls.innerHTML = `
      <h2 style="margin-top:0">Review</h2>
      <label class="field" style="margin-bottom:6px">
        <span class="lbl">change request note</span>
        <textarea id="rnote" data-restore-key="reject" placeholder="What needs to change? The note (plus any inline comments above) goes back to the same live agent, which keeps working in-context (no restart)."></textarea>
      </label>
      <div id="inline-comment-summary" class="inline-comment-summary hint"></div>
      <div class="row">
        <button class="btn success" id="approve">Approve &amp; merge</button>
        <button class="btn danger" id="reject">Request change</button>
        <div class="spacer"></div>
      </div>`;
    // Approve carries bespoke advisory-gate confirms (CI / conformance) and
    // conflict/revert toasts, so it calls action() directly rather than submitTo.
    controls.querySelector("#approve").addEventListener("click", (ev) => {
      // CI gate is advisory, not a hard block: warn on a failed build/tests but let
      // the operator proceed if they confirm.
      if (t.ci_status === "fail") {
        const label = (t.ci_summary || "CI failed").split("\n")[0].trim();
        if (!confirm(`CI failed (${label}). Approve and merge anyway?`)) return;
      }
      // SPEC-CONFORMANCE gate is likewise advisory: warn on a flagged concern (the
      // diff may not fully implement the prompt) but let the operator proceed.
      if (t.conformance_status === "concern") {
        const why = (t.conformance_summary || "").trim();
        if (!confirm(`Conformance concern${why ? `: ${why}` : ""}. Approve and merge anyway?`)) return;
      }
      let parked = false;
      action(ev.target, async () => {
        const r = await api("POST", "/work/" + id + "/approve");
        // A merge conflict isn't an error — it's sent back to the live agent to
        // resolve in-context. The SSE refresh will show the task back in in_progress.
        if (r && r.conflictSentBack) {
          toast("Merge conflict — sent back to the agent to resolve");
        } else if (r && r.revertedOnRed) {
          toast("Merged but verify FAILED — auto-reverted off main", true);
        } else if (r && r.awaitingMajorConfirm) {
          // release_mode major bump: Approve PARKS (it does NOT merge). Surface the streak
          // and stay on the task so the operator runs the deliberate double-confirm above.
          const n = (r.task && r.task.major_confirm_count) || 0;
          parked = true;
          toast(`Parked — awaiting major-version confirmation (${n}/2). Use “Confirm major version” above.`);
        } else {
          toast("approved ✓ — merged, agent wrapping up");
        }
        // Parked: re-render IN PLACE (the major-confirm banner is here). Otherwise leave.
      }, { onDone: () => (parked ? render() : backToWorkspace(t.workspace_id)) });
    });
    controls.querySelector("#reject").addEventListener("click", (ev) => {
      // The note sent to the agent is the freeform text plus any inline comments,
      // composed into one string (composeReviewNote). Either alone is enough to
      // request changes — so a reviewer can reject purely with per-line comments.
      const note = composeReviewNote(controls.querySelector("#rnote").value);
      if (!note) return toast("add a note or at least one inline comment", true);
      submitTo(ev.target, "/reject", { note }, "changes requested");
    });
    wrap.appendChild(controls);
  }

  // idea — a brief AWAITING a spec. butchr runs NO agent for it: it pushes a `spec
  // requested` event on the channel and waits for the task's STRUCTURAL responder to submit
  // a spec (POST /work/:id/spec), which advances it to spec_review. The responder
  // (story|cto|user) only frames this UI — the editor is ALWAYS available so a human can
  // submit, but for a cto/story task the responsible agent normally handles it.
  if (t.status === "idea") {
    // The responder for this idea, read straight from the task's server-computed structural
    // pending_responder (story|cto|user). Falls back to "cto" defensively.
    const specResponder = t.pending_responder || "cto";
    if (t.review_note) block("Spec changes requested", t.review_note, wrap);
    const specPanel = el("div", { class: "panel", style: "margin-top:18px" });
    const specResponderCopy = specResponder === "user"
      ? "You are the responder for this spec. Turn the brief above into a concrete, repo-grounded spec and submit it to advance the task to spec review."
      : specResponder === "story"
      ? "The <strong>story leader</strong> agent will write the spec from the brief (it was notified on its story channel). You can also write and submit one yourself below."
      : "The <strong>CTO agent</strong> will write the spec from the brief (it was notified on the CTO channel). You can also write and submit one yourself below.";
    specPanel.innerHTML = `
      <h2 style="margin-top:0">${specResponder === "user" ? "Write the spec" : "Spec requested"}</h2>
      <p class="muted" style="margin:0 0 10px">${specResponderCopy}</p>
      <label class="field" style="margin-bottom:6px">
        <span class="lbl">spec (required)</span>
        <textarea id="spec" data-restore-key="spec" placeholder="Write the full spec for this brief — what to build, where, and how it should be verified."></textarea>
      </label>
      <div class="row">
        <button class="btn success" id="submitSpec">Submit spec</button>
        <div class="spacer"></div>
      </div>`;
    specPanel.querySelector("#submitSpec").addEventListener("click", (ev) => {
      const spec = (specPanel.querySelector("#spec").value || "").trim();
      if (!spec) return toast("a spec is required", true);
      submitTo(ev.target, "/spec", { spec }, "spec submitted ✓ — awaiting approval");
    });
    wrap.appendChild(specPanel);
  }

  // spec_review — a spec was submitted (by the CTO agent or a human); operator approves
  // to start the workspace agent, or requests changes to revise the spec (back to idea).
  if (t.status === "spec_review") {
    const controls = el("div", { class: "panel", style: "margin-top:18px" });
    controls.innerHTML = `
      <h2 style="margin-top:0">Review spec</h2>
      <p class="muted" style="margin:0 0 10px">A spec was submitted for this idea. Approve to dispatch the workspace agent, or request changes to revise the spec.</p>
      <label class="field" style="margin-bottom:6px">
        <span class="lbl">change request note (required if requesting changes)</span>
        <textarea id="rnote" data-restore-key="spec-reject" placeholder="What needs to change in the spec?"></textarea>
      </label>
      <div class="row">
        <button class="btn success" id="approve">Approve spec</button>
        <button class="btn danger" id="reject">Request changes</button>
        <div class="spacer"></div>
      </div>`;
    // Approve toasts its own dispatching message, so it calls action() directly; reject
    // is the common submit-and-leave path.
    controls.querySelector("#approve").addEventListener("click", (ev) => {
      action(ev.target, async () => {
        await api("POST", "/work/" + id + "/approve");
        toast("spec approved ✓ — dispatching workspace agent");
      }, { onDone: () => backToWorkspace(t.workspace_id) });
    });
    controls.querySelector("#reject").addEventListener("click", (ev) => {
      const note = (controls.querySelector("#rnote").value || "").trim();
      if (!note) return toast("add a note describing what to change in the spec", true);
      submitTo(ev.target, "/reject", { note }, "spec changes requested — revising");
    });
    wrap.appendChild(controls);
  }

  // needs_info — the agent paused by calling an MCP tool. Two distinct surfaces, keyed off
  // whether this is a PLAN-PREVIEW task at the plan-approval step (t.plan_preview):
  //   - plan-approval → a STRUCTURED plan review: Approve (resume to implement, with optional
  //     steering) or Reject (send the plan back for revision with required feedback). These
  //     POST /plan/{approve,reject}, distinct from the freeform /answer.
  //   - any other needs_info → the freeform answer box (the agent raised a question / a
  //     suggested task change / a decomposition). On answer butchr re-launches the SAME
  //     agent session via `--resume` with the response injected.
  if (t.status === "needs_info" && t.plan_preview) {
    if (t.question) block("Proposed plan", t.question, wrap);
    const planPanel = el("div", { class: "panel", style: "margin-top:18px" });
    planPanel.innerHTML = `
      <h2 style="margin-top:0">Review plan</h2>
      <p class="muted" style="margin:0 0 10px">Approve to let the agent implement this plan, or request changes with feedback — the agent revises and re-proposes. Both resume the same session in-context.</p>
      <label class="field">
        <span class="lbl">feedback (optional for approve · required to request changes)</span>
        <textarea id="planNote" data-restore-key="plan-note" placeholder="On approve: optional steering notes folded into the implementation. On request-changes: what the plan must change before implementing."></textarea>
      </label>
      <div class="row">
        <button class="btn success" id="planApprove">Approve plan</button>
        <button class="btn danger-outline" id="planReject">Request changes</button>
        <div class="spacer"></div>
      </div>`;
    planPanel.querySelector("#planApprove").addEventListener("click", (ev) => {
      const note = (planPanel.querySelector("#planNote").value || "").trim();
      submitTo(ev.target, "/plan/approve", note ? { note } : {}, "plan approved — agent implementing");
    });
    planPanel.querySelector("#planReject").addEventListener("click", (ev) => {
      const note = (planPanel.querySelector("#planNote").value || "").trim();
      if (!note) return toast("add feedback describing what the plan must change", true);
      submitTo(ev.target, "/plan/reject", { note }, "plan changes requested — agent revising");
    });
    wrap.appendChild(planPanel);
  } else if (t.status === "needs_info") {
    if (t.question) block("Agent raised", t.question, wrap);
    const answerPanel = el("div", { class: "panel", style: "margin-top:18px" });
    answerPanel.innerHTML = `
      <h2 style="margin-top:0">Respond</h2>
      <label class="field">
        <span class="lbl">your response (required)</span>
        <textarea id="answer" data-restore-key="answer" placeholder="Respond to what the agent raised. It goes back to the same agent, which butchr re-launches in-context (--resume) to continue."></textarea>
      </label>
      <div class="row">
        <button class="btn success" id="sendAnswer">Send answer</button>
        <div class="spacer"></div>
      </div>`;
    answerPanel.querySelector("#sendAnswer").addEventListener("click", (ev) => {
      const answer = answerPanel.querySelector("#answer").value.trim();
      if (!answer) return toast("an answer is required", true);
      submitTo(ev.target, "/answer", { answer }, "answer sent — agent resuming");
    });
    wrap.appendChild(answerPanel);
  }

  // Idle agent panel — a LIVE in_progress agent that went quiet (the `idle` flag).
  // GRACEFUL idle-handling (FW-4): show the captured context, then let the operator
  // STEER it (nudge-with-guidance, or a bare "continue") or re-queue it — replacing the
  // old blind auto-"continue". Abort lives in the header. A dead-shell pane is never shown
  // here as nudgeable: the backend auto-resumes it instead, so an idle agent surfaced here
  // is genuinely alive (and /nudge re-checks liveness regardless).
  if (t.status === "in_progress" && t.idle) {
    if (t.idle_context) block("Idle context (recent output)", t.idle_context, wrap);
    const idlePanel = el("div", { class: "panel", style: "margin-top:18px" });
    idlePanel.innerHTML = `
      <h2 style="margin-top:0">Idle agent</h2>
      <p class="muted" style="margin:0 0 10px">This agent is alive but has gone quiet. Read the context above to judge why it stopped, then steer it with guidance (or a bare “continue”), re-queue it to relaunch its session, or abort it from the header.</p>
      <label class="field">
        <span class="lbl">guidance (optional — blank sends a bare “continue”)</span>
        <textarea id="nudgeText" data-restore-key="nudge" placeholder="Optional steering note, sent to the agent as if typed by a human. Leave blank to just nudge it to continue."></textarea>
      </label>
      <div class="row">
        <button class="btn success" id="nudge">Nudge</button>
        <button class="btn" id="requeue">Re-queue</button>
        <div class="spacer"></div>
      </div>`;
    // Idle actions stay on this page (no backToWorkspace), so they call action()
    // directly rather than submitTo.
    idlePanel.querySelector("#nudge").addEventListener("click", (ev) => {
      const text = (idlePanel.querySelector("#nudgeText").value || "").trim();
      // A bare nudge sends "continue"; with text it sends guidance. The backend re-checks
      // liveness and auto-resumes a dead pane instead of poking it.
      action(ev.target, () => api("POST", "/work/" + id + "/nudge", text ? { text } : {}),
        { success: text ? "guidance sent ✓" : "nudged — sent “continue” ✓" });
    });
    idlePanel.querySelector("#requeue").addEventListener("click", (ev) => {
      if (!confirm("Re-queue this idle agent? Its current run is torn down and re-launched (resuming its session) from scratch.")) return;
      action(ev.target, () => api("POST", "/work/" + id + "/requeue"), { success: "re-queued ✓" });
    });
    wrap.appendChild(idlePanel);
  }

  mount(wrap);

  if (t.status === "aborted" && (t.revert_reason || t.last_dispatch_error)) {
    document.getElementById("requeue").addEventListener("click", (ev) => {
      action(ev.target, () => api("POST", "/work/" + id + "/requeue"), { success: "re-queued ✓" });
    });
  }

  if (canAbort) {
    document.getElementById("abort").addEventListener("click", (ev) => {
      const msg = t.status === "in_progress"
        ? "Abort this in-progress task? The agent is stopped and its worktree + branch are discarded without merging."
        : "Abort this task? Its worktree + branch are discarded without merging.";
      if (!confirm(msg)) return;
      action(ev.target, () => api("POST", "/work/" + id + "/abort"), { success: "task aborted" });
    });
  }

  if (canRollback) {
    document.getElementById("rollback").addEventListener("click", (ev) => {
      if (!confirm(
        "Create a rollback task for this merged task? An agent reverts its change "
        + "(commit " + t.merged_sha.slice(0, 12) + ") and repairs any fallout — "
        + "dependents, tests, docs, revert conflicts — then it flows through the "
        + "normal CI gate → review → merge pipeline like any task.",
      )) return;
      // Create from the built-in `rollback` template via the unified work surface: a
      // rollback is the one workspace-level LEAF still created directly (kind:'rollback'),
      // and the server renders {{task}}/{{sha}} into the prompt (server.ts). Jump to the new
      // task so the operator can follow it through the pipeline.
      action(ev.target, async () => {
        const created = await api("POST", "/workspaces/" + t.workspace_id + "/work", {
          kind: "rollback",
          template: "rollback",
          vars: { task: id, sha: t.merged_sha },
        });
        if (created && created.id) location.hash = "#/task/" + created.id;
      }, { success: "rollback task created ✓" });
    });
  }

  // The feedback control panels (in_review / idea / spec_review / needs_info / idle)
  // build AND wire their own buttons before mount — see their builders above (each
  // closes over submitTo / action). Only the header/failed-panel controls (abort,
  // rollback, aborted-requeue) are wired here, since their nodes live outside those panels.
}

// Parse a unified diff into per-file groups for a readable, GitHub-style view.
// Each non-meta line also carries the source line numbers it maps to (oldNo on the
// pre-image side, newNo on the post-image side), tracked from the hunk `@@` headers
// — these drive the line-number gutter and the file:line context attached to inline
// review comments. The "\ No newline at end of file" marker is a `meta` line with no
// numbers (not commentable).
function parseDiff(diff) {
  const files = [];
  let cur = null;
  let oldNo = 0, newNo = 0;
  const start = (header) => {
    cur = { header, path: "", oldPath: "", add: 0, del: 0, binary: false, lines: [] };
    files.push(cur);
    oldNo = 0; newNo = 0;
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git")) {
      const m = line.match(/ b\/(.+)$/);
      start(line);
      if (m) cur.path = m[1];
      continue;
    }
    if (!cur) start(line); // diff without a "diff --git" preamble
    if (line.startsWith("--- ")) { cur.oldPath = line.slice(4).replace(/^a\//, ""); continue; }
    if (line.startsWith("+++ ")) { cur.path = line.slice(4).replace(/^b\//, "") || cur.path; continue; }
    if (line.startsWith("index ") || line.startsWith("new file") ||
        line.startsWith("deleted file") || line.startsWith("old mode") ||
        line.startsWith("new mode") || line.startsWith("similarity") ||
        line.startsWith("rename ")) continue;
    if (line.startsWith("Binary files")) { cur.binary = true; continue; }
    if (line.startsWith("@@")) {
      // @@ -<oldStart>[,<oldLen>] +<newStart>[,<newLen>] @@ — reset both counters.
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) { oldNo = +m[1]; newNo = +m[2]; }
      cur.lines.push({ t: "hunk", text: line });
      continue;
    }
    if (line.startsWith("+")) { cur.add++; cur.lines.push({ t: "add", text: line, newNo }); newNo++; continue; }
    if (line.startsWith("-")) { cur.del++; cur.lines.push({ t: "del", text: line, oldNo }); oldNo++; continue; }
    if (line.startsWith("\\")) { cur.lines.push({ t: "meta", text: line }); continue; } // "No newline…"
    if (line.length) { cur.lines.push({ t: "ctx", text: line, oldNo, newNo }); oldNo++; newNo++; }
  }
  return files;
}

// ---------- dependency-free syntax highlighting ----------
// A tiny per-line tokenizer for the diff view. No external lib: we scan the line
// char-by-char and wrap keywords/strings/comments/numbers in <span class="tok-*">.
// It is intentionally line-local — a /* */ block comment that spans diff lines only
// colors the portion on each line — which is good enough for review-time reading and
// keeps the scanner stateless across the interleaved add/del/ctx lines of a hunk.

// Pick a highlight language from the file path. JSON rides the JS scanner (its
// strings/numbers/true/false/null all tokenize correctly there). Returns null for
// types we don't tokenize, so the text falls back to plain (escaped) rendering.
function langForPath(path) {
  const p = (path || "").toLowerCase();
  if (/\.(tsx?|jsx?|mjs|cjs|json)$/.test(p)) return "js";
  if (/\.css$/.test(p)) return "css";
  return null;
}

const JS_KEYWORDS = new Set(
  ("abstract,as,async,await,break,case,catch,class,const,continue,debugger,declare," +
   "default,delete,do,else,enum,export,extends,false,finally,for,from,function,get," +
   "if,implements,import,in,instanceof,interface,is,keyof,let,namespace,new,null,of," +
   "override,private,protected,public,readonly,return,satisfies,set,static,super," +
   "switch,this,throw,true,try,type,typeof,undefined,var,void,while,with,yield").split(","),
);

function tok(cls, raw) { return `<span class="tok-${cls}">${esc(raw)}</span>`; }

// Scan a quoted string starting at i (text[i] is the quote). Returns the end index
// (one past the closing quote, or end-of-line if unterminated). Honors backslash
// escapes so an escaped quote doesn't close the string early.
function scanString(text, i) {
  const q = text[i], n = text.length;
  let j = i + 1;
  while (j < n && text[j] !== q) { if (text[j] === "\\") j++; j++; }
  return Math.min(j + 1, n);
}

function highlightJs(text) {
  let out = "", i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") { out += tok("c", text.slice(i)); break; }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      out += tok("c", text.slice(i, stop)); i = stop; continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const stop = scanString(text, i);
      out += tok("s", text.slice(i, stop)); i = stop; continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(text[i + 1] || ""))) {
      let j = i + 1;
      while (j < n && /[0-9a-fA-Fx._]/.test(text[j])) j++;
      out += tok("n", text.slice(i, j)); i = j; continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(text[j])) j++;
      const word = text.slice(i, j);
      out += JS_KEYWORDS.has(word) ? tok("k", word) : esc(word);
      i = j; continue;
    }
    out += esc(c); i++;
  }
  return out;
}

function highlightCss(text) {
  let out = "", i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      out += tok("c", text.slice(i, stop)); i = stop; continue;
    }
    if (c === '"' || c === "'") {
      const stop = scanString(text, i);
      out += tok("s", text.slice(i, stop)); i = stop; continue;
    }
    if (c === "@") { // at-rule (@media, @keyframes, …)
      let j = i + 1;
      while (j < n && /[A-Za-z-]/.test(text[j])) j++;
      out += tok("k", text.slice(i, j)); i = j; continue;
    }
    if (c === "#") { // hex color (#fff / #ffffff / #ffffffff)
      let j = i + 1;
      while (j < n && /[0-9A-Fa-f]/.test(text[j])) j++;
      const span = text.slice(i, j);
      if (/^#([0-9A-Fa-f]{3,4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/.test(span)) {
        out += tok("n", span); i = j; continue;
      }
      out += esc(c); i++; continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(text[i + 1] || ""))) {
      let j = i + 1;
      while (j < n && /[0-9a-zA-Z%._-]/.test(text[j])) j++; // number + unit (px, em, %, …)
      out += tok("n", text.slice(i, j)); i = j; continue;
    }
    out += esc(c); i++;
  }
  return out;
}

// Highlight one line of code → escaped HTML with <span class="tok-*"> wrappers.
// Unknown languages (lang null) and any scanner failure fall back to plain esc().
function highlightCode(text, lang) {
  if (!text) return "";
  try {
    if (lang === "js") return highlightJs(text);
    if (lang === "css") return highlightCss(text);
  } catch (e) { /* fall through to plain text */ }
  return esc(text);
}

function renderDiff(diff) {
  if (!diff || !diff.trim()) return '<div class="meta">(no changes)</div>';
  const files = parseDiff(diff);
  const totAdd = files.reduce((a, f) => a + f.add, 0);
  const totDel = files.reduce((a, f) => a + f.del, 0);

  const summary = `<div class="diff-summary">
    <span>${files.length} file${files.length === 1 ? "" : "s"} changed</span>
    <span class="add">+${totAdd}</span><span class="del">−${totDel}</span>
  </div>`;

  const cards = files.map((f) => {
    const name = f.path || f.oldPath || "(unknown)";
    const lang = langForPath(name);
    const body = f.binary
      ? `<div class="diff-binary">Binary file not shown</div>`
      : f.lines.map((l) => {
          if (l.t === "hunk" || l.t === "meta") {
            const cls = l.t === "hunk" ? "hunk" : "ctx meta";
            return `<div class="dl ${cls}"><span class="dl-num"></span>` +
              `<span class="dl-sign">${l.t === "hunk" ? "" : " "}</span>` +
              `<span class="dl-text">${esc(l.text)}</span></div>`;
          }
          const sign = l.t === "add" ? "+" : l.t === "del" ? "−" : " ";
          const text = l.t === "add" || l.t === "del" ? l.text.slice(1) : l.text;
          // Comment anchor: deletions reference the pre-image line, everything else
          // the post-image line. The key (path + side + line) is stable across diff
          // re-fetches, so stored inline comments re-attach after an SSE re-render.
          const lineNo = l.t === "del" ? l.oldNo : l.newNo;
          const side = l.t === "del" ? "o" : "n";
          const key = `${name}␟${side}${lineNo}`;
          const ctx = `${name}:${lineNo}`;
          return `<div class="dl ${l.t}" data-key="${esc(key)}" data-ctx="${esc(ctx)}">` +
            `<span class="dl-num" title="comment on ${esc(ctx)}">${lineNo}</span>` +
            `<span class="dl-sign">${sign}</span>` +
            `<span class="dl-text">${highlightCode(text, lang)}</span></div>`;
        }).join("");
    return `<div class="diff-file" data-file-key="${esc(name)}">
      <button class="diff-file-head" type="button">
        <span class="caret">▾</span>
        <span class="fname">${esc(name)}</span>
        <span class="fstat"><span class="add">+${f.add}</span> <span class="del">−${f.del}</span></span>
      </button>
      <div class="diff-file-body">${body}</div>
    </div>`;
  }).join("");

  return summary + cards;
}

// ---------- inline review comments ----------
// Per-line review comments the reviewer attaches by clicking a diff line's gutter.
// Kept at module scope (keyed by a stable path+side+line key) so they survive the
// full re-render the app does on every SSE event AND the async diff re-fetch — the
// diff is re-rendered with the same keys, and wireDiff re-paints the stored comments
// onto it. Reset when a different task's diff is opened. On "Request change" they are
// composed (with their file:line context) into the single change-request note sent
// to /reject, so the resumed agent gets specific per-line feedback in its rework
// prompt — no change to the reject payload shape (see composeReviewNote).
let inlineComments = new Map(); // key -> { path, line, side, ctx, text }
let inlineCommentsTaskId = null;
// Diff-file collapse state — module-persisted (keyed by file path) so a collapsed
// file stays collapsed across the full re-render the app does on every SSE event,
// mirroring inlineComments above. Reset alongside inlineComments when a different
// task's diff is opened, so a new task doesn't inherit the prior task's collapse set.
let collapsedDiffFiles = new Set();
// An open (uncommitted) inline-comment editor lives inside the async-fetched diff, so
// it isn't in the DOM right after render(); captureUiState() stashes it here and
// wireDiff() re-opens + refills it once the diff is painted. Null when none is open.
let pendingInlineRestore = null;
function resetInlineComments(taskId) {
  if (inlineCommentsTaskId !== taskId) {
    inlineComments = new Map();
    collapsedDiffFiles = new Set();
    inlineCommentsTaskId = taskId;
  }
}

// Compose the freeform note + any inline comments into one change-request note.
// Inline comments are listed in file/line order under a header so the agent reads
// them as a structured punch-list. Returns "" when there's nothing to send.
function composeReviewNote(freeform) {
  const parts = [];
  const ff = (freeform || "").trim();
  if (ff) parts.push(ff);
  if (inlineComments.size) {
    const sorted = [...inlineComments.values()].sort((a, b) =>
      a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1);
    const lines = ["Inline comments:"];
    for (const c of sorted) {
      const body = c.text.trim().split("\n").join("\n  "); // indent continuation lines
      lines.push(`- ${c.ctx} — ${body}`);
    }
    parts.push(lines.join("\n"));
  }
  return parts.join("\n\n");
}

// Refresh the "N inline comment(s)" hint shown next to the review controls, if the
// review panel is present. Safe to call when it isn't (other task states).
function updateCommentSummary() {
  const el2 = document.getElementById("inline-comment-summary");
  if (!el2) return;
  const n = inlineComments.size;
  el2.textContent = n
    ? `${n} inline comment${n === 1 ? "" : "s"} will be included in the change request`
    : "";
  el2.classList.toggle("on", n > 0);
}

// Find a diff line row by its stable data-key (path may contain characters that are
// awkward in an attribute selector, so scan rather than querySelector).
function dlByKey(box, key) {
  return [...box.querySelectorAll(".dl[data-key]")].find((d) => d.dataset.key === key) || null;
}

// Remove the comment-display / editor row(s) immediately following a diff line.
function clearCommentRow(dl) {
  let next = dl.nextElementSibling;
  while (next && (next.classList.contains("dl-comment") || next.classList.contains("dl-comment-edit"))) {
    const after = next.nextElementSibling;
    next.remove();
    next = after;
  }
}

// Paint the saved comment for a key (if any) as a read-only row under its line, with
// edit/delete affordances. No-op when the line isn't currently in the DOM.
function renderCommentRow(box, key) {
  const dl = dlByKey(box, key);
  if (!dl) return;
  clearCommentRow(dl);
  const c = inlineComments.get(key);
  if (!c) return;
  const row = el("div", { class: "dl-comment" });
  row.appendChild(el("div", { class: "dlc-ctx" }, c.ctx));
  row.appendChild(el("div", { class: "dlc-text" }, c.text));
  const actions = el("div", { class: "dlc-actions" });
  const edit = el("button", { type: "button", class: "btn ghost xs" }, "Edit");
  edit.addEventListener("click", () => openCommentEditor(box, dl));
  const del = el("button", { type: "button", class: "btn ghost xs" }, "Delete");
  del.addEventListener("click", () => {
    inlineComments.delete(key);
    clearCommentRow(dl);
    updateCommentSummary();
  });
  actions.appendChild(edit);
  actions.appendChild(del);
  row.appendChild(actions);
  dl.after(row);
}

// Open (or focus) the inline comment editor under a diff line, prefilled with any
// existing comment. Save stores/updates it; saving empty deletes it; Cancel reverts
// to the saved display row.
function openCommentEditor(box, dl) {
  const key = dl.dataset.key;
  if (!key) return;
  clearCommentRow(dl);
  const existing = inlineComments.get(key);
  const wrap = el("div", { class: "dl-comment-edit" });
  wrap.appendChild(el("div", { class: "dlc-ctx" }, dl.dataset.ctx || ""));
  const ta = el("textarea", { class: "dlc-input", "data-restore-key": "inline-comment", placeholder: "Comment on this line — sent to the agent on Request change…" });
  ta.value = existing ? existing.text : "";
  wrap.appendChild(ta);
  const actions = el("div", { class: "dlc-actions" });
  const save = el("button", { type: "button", class: "btn xs" }, "Save");
  const cancel = el("button", { type: "button", class: "btn ghost xs" }, "Cancel");
  save.addEventListener("click", () => {
    const text = ta.value.trim();
    if (!text) { inlineComments.delete(key); clearCommentRow(dl); updateCommentSummary(); return; }
    // ctx like "path:line"; split off the path/line for stable ordering in the note.
    const ctx = dl.dataset.ctx || key;
    const ci = ctx.lastIndexOf(":");
    const path = ci === -1 ? ctx : ctx.slice(0, ci);
    const line = ci === -1 ? 0 : Number(ctx.slice(ci + 1)) || 0;
    inlineComments.set(key, { path, line, ctx, text, side: key.includes("␟o") ? "o" : "n" });
    renderCommentRow(box, key);
    updateCommentSummary();
  });
  cancel.addEventListener("click", () => { clearCommentRow(dl); if (existing) renderCommentRow(box, key); });
  actions.appendChild(save);
  actions.appendChild(cancel);
  wrap.appendChild(actions);
  dl.after(wrap);
  ta.focus();
}

// Wire a freshly-rendered diff: collapse/expand file cards, re-paint any stored
// inline comments, and make each commentable line's gutter open the editor.
function wireDiff(box, taskId) {
  resetInlineComments(taskId);
  box.querySelectorAll(".diff-file-head").forEach((head) => {
    head.addEventListener("click", () => {
      const card = head.parentElement;
      const collapsed = card.classList.toggle("collapsed");
      // Persist the toggle so the file stays (un)collapsed across the next SSE re-render.
      const fkey = card.dataset.fileKey;
      if (fkey) { if (collapsed) collapsedDiffFiles.add(fkey); else collapsedDiffFiles.delete(fkey); }
    });
  });
  // Re-apply any persisted collapse state to this freshly-rendered diff.
  box.querySelectorAll(".diff-file[data-file-key]").forEach((card) => {
    if (collapsedDiffFiles.has(card.dataset.fileKey)) card.classList.add("collapsed");
  });
  box.querySelectorAll(".dl[data-key] .dl-num").forEach((num) => {
    num.addEventListener("click", () => openCommentEditor(box, num.closest(".dl")));
  });
  for (const key of inlineComments.keys()) renderCommentRow(box, key);
  updateCommentSummary();
  // Re-open an inline-comment editor that was mid-edit when an SSE re-render fired
  // (captured by captureUiState before render; the diff is fetched async so this is
  // the first point its line rows exist). No-op if the line is gone from this diff.
  if (pendingInlineRestore) {
    const { key, value, selStart, selEnd } = pendingInlineRestore;
    pendingInlineRestore = null;
    const dl = dlByKey(box, key);
    if (dl) {
      openCommentEditor(box, dl); // creates+focuses the .dlc-input editor row after dl
      const ta = dl.nextElementSibling && dl.nextElementSibling.querySelector
        ? dl.nextElementSibling.querySelector(".dlc-input") : null;
      if (ta) {
        ta.value = value || "";
        try { if (typeof selStart === "number") ta.setSelectionRange(selStart, selEnd); } catch (e) { /* ignore */ }
        ta.focus();
      }
    }
  }
}

// ---------- topnav active state ----------
// Highlight the topbar nav link matching the current route. Each route maps to the
// nav href it lives under: Metrics → #/metrics, Projects → #/projects, and everything
// else (dashboard/workspace/task) → #/ (Workspaces).
function syncTopnav(route) {
  const links = document.querySelectorAll(".topnav-link");
  if (!links.length) return;
  const name = route && route.name;
  const owningHref =
    name === "metrics" ? "#/metrics" :
    // both the projects overview and a project's detail view live under Projects
    (name === "projects" || name === "project") ? "#/projects" :
    "#/";
  links.forEach((a) => {
    const active = a.getAttribute("href") === owningHref;
    a.classList.toggle("active", active);
    if (active) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
}

// ---------- metrics view ----------
// Format a millisecond duration as a compact human string (e.g. "2h 5m", "3m",
// "45s"). Returns "—" for null/zero so empty medians read cleanly.
function fmtDuration(ms) {
  if (ms == null || !isFinite(ms) || ms <= 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.round(s / 60);
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return rem ? `${h}h ${rem}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const hr = h % 24;
  return hr ? `${d}d ${hr}h` : `${d}d`;
}
// Format a byte count as a human-readable size (KB/MB/GB, binary units). "—" for
// null/non-finite; "0 B" for zero.
function fmtBytes(bytes) {
  if (bytes == null || !isFinite(bytes)) return "—";
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  const v = n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1);
  return `${v} ${units[i]}`;
}
// Format a rate (0..1 or null) as a percentage string; "—" when there's no data.
function fmtPct(rate) {
  if (rate == null || !isFinite(rate)) return "—";
  const pct = rate * 100;
  return (pct < 10 && pct > 0 ? pct.toFixed(1) : Math.round(pct)) + "%";
}

// A single number card: big value, label, and an optional sub-line (e.g. raw
// numerator/denominator behind a rate).
function metricCard(label, value, sub) {
  return el("div", { class: "metric-card" }, [
    el("div", { class: "metric-value" }, String(value)),
    el("div", { class: "metric-label" }, label),
    sub != null ? el("div", { class: "metric-sub" }, sub) : null,
  ]);
}
// "num/of" sub-line for a rate card (or "no data" when nothing has happened yet).
function rateSub(r) {
  if (!r || r.of === 0) return "no data yet";
  return `${r.num} / ${r.of}`;
}

// Tiny inline bar sparkline for merged-per-day throughput. No chart lib: a row of
// CSS-height bars, each titled with its date + count. Heights are scaled to the
// busiest day in the window (a flat zero series renders as a baseline).
function throughputSpark(perDay) {
  const max = Math.max(1, ...perDay.map((d) => d.count));
  const bars = perDay.map((d) => {
    const h = d.count > 0 ? Math.max(8, Math.round((d.count / max) * 100)) : 2;
    const bar = el("div", {
      class: "spark-bar" + (d.count > 0 ? "" : " zero"),
      style: `height:${h}%`,
      title: `${d.date}: ${d.count} merged`,
    });
    return el("div", { class: "spark-col" }, [bar]);
  });
  return el("div", { class: "spark" }, bars);
}

// Horizontal status breakdown bars: one row per present status, reusing the
// existing .chip color via a class, width proportional to the largest count.
function statusBars(byStatus) {
  const entries = Object.entries(byStatus).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return el("div", { class: "empty" }, "No tasks yet.");
  const max = Math.max(1, ...entries.map(([, n]) => n));
  const rows = entries.map(([status, n]) => {
    const fill = el("div", {
      class: "sb-fill " + status,
      style: `width:${Math.max(2, Math.round((n / max) * 100))}%`,
    });
    return el("div", { class: "status-bar-row" }, [
      el("span", { class: "sb-label", html: chip(status) }),
      el("div", { class: "sb-track" }, [fill]),
      el("span", { class: "sb-count" }, String(n)),
    ]);
  });
  return el("div", { class: "status-bars" }, rows);
}

async function renderMetrics() {
  const m = await api("GET", "/metrics");
  const wrap = el("div");
  wrap.appendChild(el("h1", {}, "Metrics"));
  wrap.appendChild(el("div", { class: "crumbs" },
    `aggregate across all tasks · ${m.total} total`));

  // number cards
  const cards = el("div", { class: "metrics-cards" });
  cards.appendChild(metricCard("Total tasks", m.total));
  cards.appendChild(metricCard("Merged (all-time)", m.throughput.totalMerged));
  cards.appendChild(metricCard("Merged / last " + m.throughput.days + "d", m.throughput.windowMerged));
  cards.appendChild(metricCard("Median time to review",
    fmtDuration(m.timeToReview.medianMs), `${m.timeToReview.count} sample${m.timeToReview.count === 1 ? "" : "s"}`));
  cards.appendChild(metricCard("Median time to merge",
    fmtDuration(m.timeToMerge.medianMs), `${m.timeToMerge.count} sample${m.timeToMerge.count === 1 ? "" : "s"}`));
  cards.appendChild(metricCard("Conflict rate", fmtPct(m.conflictRate.rate), rateSub(m.conflictRate)));
  cards.appendChild(metricCard("Revert rate", fmtPct(m.revertRate.rate), rateSub(m.revertRate)));
  cards.appendChild(metricCard("CI pass rate", fmtPct(m.ciPassRate.rate), rateSub(m.ciPassRate)));
  cards.appendChild(metricCard("Auto-merge rate", fmtPct(m.autoMergeRate.rate), rateSub(m.autoMergeRate)));
  wrap.appendChild(cards);

  // throughput sparkline
  wrap.appendChild(el("h2", {}, "Throughput — merged / day"));
  const tp = el("div", { class: "panel" });
  tp.appendChild(throughputSpark(m.throughput.perDay));
  tp.appendChild(el("div", { class: "spark-axis" }, [
    el("span", {}, m.throughput.perDay[0] ? m.throughput.perDay[0].date : ""),
    el("span", {}, m.throughput.perDay.length
      ? m.throughput.perDay[m.throughput.perDay.length - 1].date : ""),
  ]));
  wrap.appendChild(tp);

  // status breakdown
  wrap.appendChild(el("h2", {}, "Tasks by status"));
  const sb = el("div", { class: "panel" });
  sb.appendChild(statusBars(m.byStatus));
  wrap.appendChild(sb);

  wrap.appendChild(el("small", { class: "muted" },
    "Rates reflect each task's current state — conflict/CI flags can be cleared as a task moves on, so treat them as best-effort snapshots."));

  // Disk usage readout — sourced from /health's `disk` object (best-effort; absent
  // if sizing failed). Surfaces butchr's two growth footprints (task worktrees + DB
  // backups) and an advisory badge when the total crosses the configured threshold.
  let health = null;
  try { health = await api("GET", "/health"); } catch (e) { /* degraded — skip readout */ }
  const disk = health && health.disk;
  if (disk) {
    const head = el("h2", {}, "Disk usage");
    if (disk.warn) {
      head.appendChild(el("span", {
        class: "disk-warn-badge",
        title: `Total ${fmtBytes(disk.totalBytes)} exceeds the ${fmtBytes(disk.warnBytes)} advisory threshold (BUTCHR_DISK_WARN_BYTES)`,
      }, "over threshold"));
    }
    wrap.appendChild(head);
    const dcards = el("div", { class: "metrics-cards" });
    dcards.appendChild(metricCard("Task worktrees", fmtBytes(disk.worktreesBytes),
      `${disk.worktreeCount} worktree${disk.worktreeCount === 1 ? "" : "s"}`));
    dcards.appendChild(metricCard("DB backups", fmtBytes(disk.backupsBytes)));
    dcards.appendChild(metricCard("Total", fmtBytes(disk.totalBytes),
      disk.warnBytes > 0 ? `threshold ${fmtBytes(disk.warnBytes)}` : "no threshold"));
    wrap.appendChild(dcards);
    wrap.appendChild(el("small", { class: "muted" },
      "Worktrees are the per-task git checkouts under each repo; backups are the DB snapshots. "
      + (disk.truncated ? "Some trees hit the scan cap, so totals are a floor. " : "")
      + "Set BUTCHR_DISK_WARN_BYTES to tune the advisory threshold (0 disables it)."));
  }

  mount(wrap);
}

// ---------- projects view (REVAMP-4 tier UI) ----------
// The global PROJECTS overview: a CEO-tier project registers repos and coordinates
// cross-repo initiatives. This subtask (S2) ships the OVERVIEW + CREATE only; the
// project-detail view, repos list, initiative rollup, and the full CEO card land in
// later subtasks (S3–S5) — so cards are STATIC (no detail-click yet) and show honest
// muted PLACEHOLDERS ("repos —" / "initiatives —") rather than fake counts.

// A compact title derived from the project's brief (a project node has no short-title
// field). Splits on the first sentence/clause boundary and clamps length. Mirrors the
// mockup's projectTitle so the real UI reads identically.
function projectTitle(p) {
  const t = String((p && p.brief) || "").split(/[—\-:.]/)[0].trim();
  if (!t) return "Untitled project";
  return t.length > 60 ? t.slice(0, 57) + "…" : t;
}

// CEO status pill derived from the LIST row's `ceo_enabled` ALONE — the overview must
// not assert a resolved on/off it cannot know. Three-way + honest:
//   1    → "CEO enabled"  (.chip.enabled)  explicit override on
//   0    → "CEO disabled" (.chip.disabled) explicit override off
//   null → "CEO default"  (.chip.inactive, neutral) inherits the global gate
// The fully-resolved state (enabled/globalGate/live) belongs on the S5 detail CEO card
// via GET /api/projects/:id/ceo — NOT here (no extra fetch on the overview).
function ceoPill(p) {
  if (p && p.ceo_enabled === 1) return { cls: "enabled", label: "CEO enabled" };
  if (p && p.ceo_enabled === 0) return { cls: "disabled", label: "CEO disabled" };
  return { cls: "inactive", label: "CEO default", title: "Inherits the global CEO gate (BUTCHR_CEO_AGENT)" };
}

// localStorage key for the defensive fallback set of project ids this browser created
// (see openNewProjectModal). Purely a belt-and-braces record; the list always renders
// from the authoritative GET /api/projects.
const CREATED_PROJECTS_KEY = "butchr-created-projects";
function rememberCreatedProject(id) {
  if (!id) return;
  try {
    const raw = localStorage.getItem(CREATED_PROJECTS_KEY);
    const ids = raw ? JSON.parse(raw) : [];
    if (Array.isArray(ids) && ids.indexOf(id) === -1) {
      ids.push(id);
      localStorage.setItem(CREATED_PROJECTS_KEY, JSON.stringify(ids));
    }
  } catch (e) { /* ignore — the server list is authoritative regardless */ }
}

// The overview card's initiative rollup line. `inits` is the project's InitiativeView[] — or
// undefined when its fetch failed, in which case we keep the honest muted placeholder rather than
// assert a count we don't have. Otherwise a compact .swim-prog mini-bar reads "X/Y initiatives
// done" (done via the server's `done` boolean on each initiative — see projectInitiativeRollup).
function projectInitiativesLine(inits) {
  if (!inits) return '<div class="pc-placeholder muted">initiatives —</div>';
  const roll = projectInitiativeRollup(inits);
  return '<div class="swim-prog" title="cross-repo initiatives fully done across their repos">' +
      '<span class="swim-track"><i style="width:' + roll.pct + '%"></i></span>' +
      '<span class="swim-prog-txt">' + roll.done + '/' + roll.total + ' initiatives done</span>' +
    '</div>';
}

async function renderProjects() {
  const projects = await api("GET", "/projects");
  // Per-project initiative rollup for each card's "X/Y done" line. GET /api/projects carries no
  // rollup counts, so fetch each project's initiatives in parallel. FAIL-SOFT per card: a project
  // whose fetch rejects is left OUT of the map, so its card keeps the muted "initiatives —"
  // placeholder instead of breaking the grid. (Only cross-repo initiatives appear — single-repo
  // ones are ungrouped — so this counts those, matching the detail panel.)
  const initsByProject = new Map();
  await Promise.all(projects.map(async (p) => {
    try {
      initsByProject.set(p.id,
        await api("GET", "/projects/" + encodeURIComponent(p.id) + "/initiatives"));
    } catch (e) { /* leave unset → placeholder */ }
  }));
  const wrap = el("div");

  // page head: title + subtitle + "New project" action
  const head = el("div", { class: "page-head" });
  const text = el("div", { class: "ph-text" });
  text.appendChild(el("h1", {}, "Projects"));
  text.appendChild(el("div", { class: "sub" },
    "Cross-repo initiatives coordinated by a project CEO agent." +
    (projects.length ? ` ${projects.length} project${projects.length === 1 ? "" : "s"}.` : "")));
  head.appendChild(text);
  const newBtn = el("button", { class: "btn" }, "+ New project");
  newBtn.addEventListener("click", () => openNewProjectModal());
  head.appendChild(newBtn);
  wrap.appendChild(head);

  if (!projects.length) {
    wrap.appendChild(el("div", { class: "empty" },
      "No projects yet — create one to register repos and launch initiatives."));
    mount(wrap);
    return;
  }

  const grid = el("div", { class: "grid dirs" });
  for (const p of projects) {
    const pill = ceoPill(p);
    // Each card OPENS the project detail view (#/projects/:id). It's a real button for
    // a11y: role=button + tabindex so it's tab-reachable and Enter/Space activate it.
    const card = el("div", { class: "card clickable", role: "button", tabindex: "0" });
    card.innerHTML =
      '<div class="pc-head">' +
        '<div class="title">' + esc(projectTitle(p)) + '</div>' +
      '</div>' +
      '<div class="path">' + esc(p.workspace_id) + '</div>' +
      // repos rollup is still a later subtask's concern; the initiative rollup is filled here (S4).
      '<div class="pc-placeholder muted">repos —</div>' +
      projectInitiativesLine(initsByProject.get(p.id)) +
      '<div class="pc-foot">' +
        '<span class="chip ' + pill.cls + '"' +
          (pill.title ? ' title="' + esc(pill.title) + '"' : "") + '>' +
          esc(pill.label) + '</span>' +
      '</div>';
    const open = () => { location.hash = "#/projects/" + p.id; };
    card.addEventListener("click", open);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    });
    grid.appendChild(card);
  }
  wrap.appendChild(grid);
  mount(wrap);
}

// CREATE-PROJECT modal — reuses the openModal/action/api pattern of openNewStoryModal.
// Anchor-workspace dropdown populated from GET /api/workspaces; brief textarea carries a
// data-restore-key so an SSE-driven re-render never wipes in-flight text. Submit →
// POST /api/projects { workspace, brief }; on success add the returned project (server
// returns the full row) via a re-render, remember its id in localStorage as a fallback,
// and surface any error (e.g. 404 missing workspace) inline in .m-error (not only a toast).
async function openNewProjectModal() {
  const body = el("div", { class: "m-body" });
  body.innerHTML = `
    <label class="field">
      <span class="lbl">anchor workspace — the project's home directory (the CEO agent's launch cwd)</span>
      <select id="np-anchor"><option value="">loading workspaces…</option></select>
    </label>
    <label class="field" style="margin-bottom:6px">
      <span class="lbl">brief — what this project should deliver across its repos</span>
      <textarea id="np-brief" data-restore-key="new-project-brief" placeholder="Describe the project in a sentence or two…"></textarea>
    </label>
    <small class="hint muted">A project registers repos and coordinates cross-repo initiatives via a CEO agent.</small>`;
  const anchorEl = body.querySelector("#np-anchor");
  const briefEl = body.querySelector("#np-brief");

  const foot = el("div", { class: "m-foot" });
  const errEl = el("span", { class: "m-error hint" }, "");
  const cancel = el("button", { class: "btn ghost" }, "Cancel");
  const submit = el("button", { class: "btn" }, "Create project");
  foot.appendChild(errEl);
  foot.appendChild(cancel);
  foot.appendChild(submit);

  const { close } = openModal({ title: "New project", body, footer: foot });
  cancel.addEventListener("click", close);

  function showErr(msg) { errEl.textContent = msg || ""; errEl.classList.toggle("on", !!msg); }

  // Populate the anchor dropdown. On failure or an empty registry, disable submit with an
  // honest message rather than letting the create 404 later.
  submit.disabled = true;
  try {
    const workspaces = await api("GET", "/workspaces");
    if (!workspaces.length) {
      anchorEl.innerHTML = '<option value="">no workspaces registered</option>';
      showErr("Register a workspace first — a project anchors to an existing directory.");
    } else {
      anchorEl.innerHTML = workspaces.map((w) =>
        '<option value="' + esc(w.id) + '">' + esc(w.label || w.path) + '</option>').join("");
      submit.disabled = false;
      briefEl.focus();
    }
  } catch (e) {
    anchorEl.innerHTML = '<option value="">could not load workspaces</option>';
    showErr(e.message);
  }

  submit.addEventListener("click", () => {
    const workspace = anchorEl.value;
    const brief = briefEl.value.trim();
    if (!workspace) { showErr("Pick an anchor workspace first."); return; }
    if (!brief) { showErr("Describe the project first."); briefEl.focus(); return; }
    showErr("");
    // action() disables the button + toasts on success/failure; we ALSO surface the error
    // inline so a 404 (missing workspace) isn't lost to a transient toast. On success the
    // returned row's id is remembered and a re-render lists it from the server.
    action(submit, async () => {
      let created;
      try {
        created = await api("POST", "/projects", { workspace, brief });
      } catch (e) {
        showErr(e.message);
        throw e; // let action() toast + re-enable the button
      }
      if (created && created.id) rememberCreatedProject(created.id);
      return created;
    }, { success: "project created", onDone: () => { close(); render(); } });
  });
}

// ---------- project DETAIL view (REVAMP-4 tier UI) ----------
// A single project's page: header (brief/anchor/status) + a Repos panel to register /
// unregister member repos. Reached by clicking a card on the overview (#/projects/:id).
// The CEO card + initiative rollups are a LATER subtask (S5) — deliberately NOT here, so
// this ships the repo-membership surface alone.
//
// Repo rows have NO path/label of their own: listProjectRepos returns work_kind='repo'
// task rows whose id === their directory id (REVAMP-4 S0a). We resolve each id to a
// human path/label against GET /api/workspaces (fetched alongside the members). The same
// workspaces list, minus the current members, is the "Add repo" picker's option set.

// <test-extract:projects-repo-display> — pure, DOM-free repo-display resolution,
// unit-tested in test/projects-detail-ui.test.ts.
// A member repo's display fields, resolved against the workspaces map. Defensive: a repo
// whose id isn't in /api/workspaces (stale/filtered directory) still renders honestly
// from its id/brief rather than blanking the panel or throwing on basename(undefined).
function repoDisplay(repo, wsById) {
  const ws = wsById.get(repo.id);
  if (ws) {
    return { name: ws.label || basenameOf(ws.path) || repo.id, dir: ws.path || repo.id };
  }
  return { name: (repo.brief && String(repo.brief).trim()) || repo.id, dir: repo.id };
}

// Basename of a path (last non-empty segment), tolerating trailing slashes. "" for a
// null/empty input so callers can fall back.
function basenameOf(path) {
  const parts = String(path || "").split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}
// </test-extract:projects-repo-display>

// <test-extract:initiative-rollup> — pure, DOM-free initiative heading + rollup derivation,
// unit-tested in test/projects-initiatives-ui.test.ts.
// A cross-repo InitiativeView (GET /api/projects/:id/initiatives) has NO top-level brief — each
// per-repo child story carries its own — so derive a compact panel heading from the FIRST child's
// brief (first line, clamped). Falls back to the initiative id when no child has a brief, so the
// row never renders blank.
function initiativeHeading(init) {
  const kids = (init && init.children) || [];
  const withBrief = kids.find((c) => c && c.brief && String(c.brief).trim());
  const raw = withBrief ? String(withBrief.brief).trim() : "";
  if (!raw) return "Initiative " + (String((init && init.initiative_id) || "").trim() || "—");
  const oneLine = raw.split("\n")[0].trim();
  return oneLine.length > 80 ? oneLine.slice(0, 77) + "…" : oneLine;
}
// The rollup fraction for an initiative's progress bar. LOCKED to the SERVER's done predicate
// (rollupInitiatives in src/stories.ts): a child counts as done ONLY when status==='done'
// (strictly — NOT merged/landed), so the bar reaches 100% EXACTLY when the server's
// initiative.done is true, with no bar/boolean disagreement. Returns { done, total, pct }.
function initiativeRollup(init) {
  const kids = (init && init.children) || [];
  const total = kids.length;
  const done = kids.filter((c) => c && c.status === "done").length;
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}
// The project-level "X/Y initiatives done" rollup for the overview card — counts DONE
// initiatives using the server's authoritative `done` boolean on each InitiativeView. Only
// cross-repo initiatives appear in the list (single-repo ones are ungrouped), so this counts
// those. Returns { done, total, pct }.
function projectInitiativeRollup(inits) {
  const list = Array.isArray(inits) ? inits : [];
  const total = list.length;
  const done = list.filter((i) => i && i.done).length;
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}
// </test-extract:initiative-rollup>

async function renderProjectDetail(id) {
  // Load the project row, its member repos, and the workspaces (to resolve repo id→path)
  // together. A failure (e.g. 404 on a stale hash) falls through to render()'s catch,
  // which paints an .empty error — matching every other view.
  const [project, repos, workspaces, initiatives] = await Promise.all([
    api("GET", "/projects/" + encodeURIComponent(id)),
    api("GET", "/projects/" + encodeURIComponent(id) + "/repos"),
    api("GET", "/workspaces"),
    api("GET", "/projects/" + encodeURIComponent(id) + "/initiatives"),
  ]);
  const wsById = new Map(workspaces.map((w) => [w.id, w]));

  const wrap = el("div");

  // header: back-link + title/anchor/brief + a subtle (cosmetic) node-status chip.
  const back = el("button", { class: "back-link" }, "← All projects");
  back.addEventListener("click", () => { location.hash = "#/projects"; });
  wrap.appendChild(back);

  const head = el("div", { class: "page-head" });
  const text = el("div", { class: "ph-text" });
  text.appendChild(el("h1", {}, projectTitle(project)));
  if (project.workspace_id) text.appendChild(el("div", { class: "path" }, project.workspace_id));
  if (project.brief) text.appendChild(el("div", { class: "sub" }, project.brief));
  head.appendChild(text);
  if (project.status) {
    head.appendChild(el("span", {
      class: "chip subtle",
      title: "node status (cosmetic)",
    }, project.status));
  }
  wrap.appendChild(head);

  // repos panel
  wrap.appendChild(reposPanel(project, repos, wsById));

  // initiatives panel — the cross-repo rollup + launch surface (REVAMP-4 S4)
  wrap.appendChild(initiativesPanel(project, initiatives, repos, wsById));

  mount(wrap);
}

// The Initiatives panel: header with a right-aligned "Launch initiative" action, then one
// .init block per CROSS-repo initiative (GET /api/projects/:id/initiatives). Each block shows a
// derived heading, its per-repo child rows (resolved repo name + shared-palette status chip + the
// child's brief), and a rolled-up doneness bar. Empty-state when there are none. NOTE: single-repo
// initiatives are seeded ungrouped and don't appear here (only cross-repo do) — the launch modal
// says so, and a single-repo launch toast names the repo it was seeded into.
function initiativesPanel(project, initiatives, repos, wsById) {
  const panel = el("div", { class: "panel" });

  const phead = el("div", { class: "panel-head" });
  phead.appendChild(el("h2", {}, "Initiatives"));
  phead.appendChild(el("span", { class: "spacer" }));
  const launchBtn = el("button", { class: "btn" }, "Launch initiative");
  launchBtn.addEventListener("click", () => openLaunchModal(project, repos, wsById));
  phead.appendChild(launchBtn);
  panel.appendChild(phead);

  if (!initiatives.length) {
    panel.appendChild(el("div", { class: "empty" },
      "No initiatives yet — launch one against a single repo or fan out across several."));
    return panel;
  }

  for (const init of initiatives) {
    panel.appendChild(el("div", { class: "init", html: initiativeMarkup(init, wsById) }));
  }
  return panel;
}

// One initiative's markup: a heading + short id, its per-repo child rows (each = resolved repo
// name + the shared status .chip + the child brief), and a rolled-up doneness bar. The bar's
// fraction (initiativeRollup) is LOCKED to the server's status==='done' predicate so it reads
// 100% exactly when the server's `done` boolean is true. Each child.workspace_id is a repo/
// directory id, resolved to a friendly name via repoDisplay (id-only, so its fallback is the id —
// never the story brief).
function initiativeMarkup(init, wsById) {
  const roll = initiativeRollup(init);
  const targets = (init.children || []).map((c) => {
    const d = repoDisplay({ id: c.workspace_id }, wsById);
    const brief = c.brief && String(c.brief).trim();
    return '<div class="init-target">' +
        '<span class="tr">' + esc(d.name) + '</span>' +
        chip(c.status) +
        (brief ? '<span class="ibr">' + esc(brief) + '</span>' : "") +
      '</div>';
  }).join("");
  return (
    '<div class="init-head">' +
      '<span class="ib">' + esc(initiativeHeading(init)) + '</span>' +
      '<span class="init-id" title="initiative grouping id">' + esc(init.initiative_id) + '</span>' +
    '</div>' +
    '<div class="init-targets">' + targets + '</div>' +
    '<div class="rollup-summary">' +
      '<span class="rollup-frac">' + roll.done + '/' + roll.total + '</span>' +
      '<span class="muted">' + (init.done ? "done — all stories landed" : "stories done") + '</span>' +
    '</div>' +
    '<div class="rollup-bar"><div class="rollup-bar-fill" style="width:' + roll.pct + '%"></div></div>'
  );
}

// LAUNCH-INITIATIVE modal — reuses openModal/action/api. A segmented toggle switches between the
// two backend shapes on POST /api/projects/:id/initiatives:
//   Single repo      → { repo, brief }         (one member repo + a brief; seeded UNGROUPED)
//   Cross-repo fan-out → { targets:[{repo,brief}] } (repeatable rows, atomic all-or-nothing)
// Member repos (the select options) come from the project's repos list, resolved to friendly
// names via repoDisplay. A 409 (non-member repo) is shown INLINE in .m-error, not just a toast.
// Submit is disabled with an honest message when the project has no member repos. On a 201 the
// modal closes and the view re-renders (refreshing the list); a single-repo success toast names
// the repo it was seeded into, since that story is tracked on the repo's board, not this panel.
function openLaunchModal(project, repos, wsById) {
  let mode = "single"; // 'single' | 'fanout'
  const repoOpts = (repos || []).map((r) => ({ id: r.id, name: repoDisplay(r, wsById).name }));

  const body = el("div", { class: "m-body" });
  const foot = el("div", { class: "m-foot" });
  const errEl = el("span", { class: "m-error hint" }, "");
  const cancel = el("button", { class: "btn ghost" }, "Cancel");
  const submit = el("button", { class: "btn" }, "Launch");
  foot.appendChild(errEl);
  foot.appendChild(cancel);
  foot.appendChild(submit);

  const { close } = openModal({ title: "Launch initiative", body, footer: foot });
  cancel.addEventListener("click", close);
  function showErr(msg) { errEl.textContent = msg || ""; errEl.classList.toggle("on", !!msg); }

  function repoSelectHtml(id, selected) {
    return '<select ' + (id ? 'id="' + esc(id) + '" ' : "") + 'class="tgt-repo">' +
      repoOpts.map((o) =>
        '<option value="' + esc(o.id) + '"' + (o.id === selected ? " selected" : "") + '>' +
          esc(o.name) + '</option>').join("") +
      '</select>';
  }

  function draw() {
    if (!repoOpts.length) {
      body.innerHTML = '<div class="empty">Register at least one repo before launching an initiative.</div>';
      submit.disabled = true;
      return;
    }
    submit.disabled = false;
    let inner =
      '<div class="seg" role="tablist" aria-label="Initiative scope">' +
        '<button type="button" data-mode="single" class="' + (mode === "single" ? "on" : "") +
          '" role="tab" aria-selected="' + (mode === "single") + '">Single repo</button>' +
        '<button type="button" data-mode="fanout" class="' + (mode === "fanout" ? "on" : "") +
          '" role="tab" aria-selected="' + (mode === "fanout") + '">Cross-repo fan-out</button>' +
      '</div>';
    if (mode === "single") {
      inner +=
        '<label class="field"><span class="lbl">repo</span>' + repoSelectHtml("li-repo") + '</label>' +
        '<label class="field" style="margin-bottom:6px"><span class="lbl">brief — what to build in this repo</span>' +
          '<textarea class="tgt-brief" placeholder="Describe the initiative for this repo…"></textarea></label>' +
        '<small class="hint muted">A single-repo initiative seeds one story into that repo (managed by its CTO) — ' +
          'it’s tracked on that repo’s board and won’t appear in this cross-repo list. ' +
          'Use fan-out to coordinate several repos under one rolled-up initiative.</small>';
    } else {
      inner +=
        '<span class="lbl">targets — one {repo, brief} per repo; add as many as you need</span>' +
        '<div id="targets"></div>' +
        '<button type="button" class="btn ghost xs add-target" id="addTgt">+ Add target</button>';
    }
    body.innerHTML = inner;

    Array.prototype.forEach.call(body.querySelectorAll("[data-mode]"), (b) => {
      b.addEventListener("click", () => { mode = b.getAttribute("data-mode"); showErr(""); draw(); });
    });
    if (mode === "single") {
      const t = body.querySelector(".tgt-brief"); if (t) t.focus();
    } else {
      const wrap = body.querySelector("#targets");
      const addRow = (sel) => {
        const row = el("div", { class: "target-row" });
        row.innerHTML =
          repoSelectHtml(null, sel) +
          '<textarea class="tgt-brief" placeholder="Brief for this repo…"></textarea>' +
          '<button type="button" class="icon-btn" title="Remove target" aria-label="Remove target">×</button>';
        row.querySelector(".icon-btn").addEventListener("click", () => {
          if (wrap.children.length > 1) wrap.removeChild(row);
          else toast("keep at least one target");
        });
        wrap.appendChild(row);
      };
      addRow(repoOpts[0].id);
      addRow((repoOpts[1] || repoOpts[0]).id);
      body.querySelector("#addTgt").addEventListener("click", () => addRow(repoOpts[0].id));
    }
  }
  draw();

  submit.addEventListener("click", () => {
    if (!repoOpts.length) return;
    showErr("");
    if (mode === "single") {
      const repo = body.querySelector(".tgt-repo").value;
      const brief = body.querySelector(".tgt-brief").value.trim();
      if (!brief) { showErr("Write a brief first."); return; }
      const repoName = (repoOpts.find((o) => o.id === repo) || {}).name || repo;
      action(submit, async () => {
        try {
          return await api("POST",
            "/projects/" + encodeURIComponent(project.id) + "/initiatives", { repo, brief });
        } catch (e) {
          showErr(e.message); // 409 (non-member repo) shown inline
          throw e; // let action() toast + re-enable the button
        }
      }, {
        success: "initiative seeded into " + repoName + " — track it on that repo’s board",
        onDone: () => { close(); render(); },
      });
    } else {
      const rows = Array.prototype.slice.call(body.querySelectorAll(".target-row"));
      const targets = [];
      for (const row of rows) {
        const repo = row.querySelector(".tgt-repo").value;
        const brief = row.querySelector(".tgt-brief").value.trim();
        if (brief) targets.push({ repo, brief }); // skip blank-brief rows
      }
      if (!targets.length) { showErr("Fill in at least one target brief."); return; }
      action(submit, async () => {
        try {
          return await api("POST",
            "/projects/" + encodeURIComponent(project.id) + "/initiatives", { targets });
        } catch (e) {
          showErr(e.message); // 409 (non-member repo) shown inline
          throw e;
        }
      }, {
        success: targets.length + " stories fanned out across " + targets.length + " target" +
          (targets.length === 1 ? "" : "s"),
        onDone: () => { close(); render(); },
      });
    }
  });
}

// The Repos panel: a header with a right-aligned "+ Add repo" action, then one row per
// member repo (name + mono dir + an unregister ×). Empty-state when there are none.
function reposPanel(project, repos, wsById) {
  const panel = el("div", { class: "panel" });

  const phead = el("div", { class: "panel-head" });
  phead.appendChild(el("h2", {}, "Repos"));
  phead.appendChild(el("span", { class: "spacer" }));
  const addBtn = el("button", { class: "btn ghost xs" }, "+ Add repo");
  addBtn.addEventListener("click", () => openAddRepoModal(project, repos, wsById));
  phead.appendChild(addBtn);
  panel.appendChild(phead);

  if (!repos.length) {
    panel.appendChild(el("div", { class: "empty" },
      "No repos registered — add one to target it with an initiative."));
    return panel;
  }

  for (const repo of repos) {
    const d = repoDisplay(repo, wsById);
    const row = el("div", { class: "repo-row" });
    row.innerHTML =
      '<span class="ic" aria-hidden="true">◆</span>' +
      '<span class="nm">' + esc(d.name) + '</span>' +
      '<span class="rp">' + esc(d.dir) + '</span>' +
      '<span class="spacer"></span>' +
      '<button class="icon-btn" title="Unregister repo" aria-label="Unregister ' + esc(d.name) + '">×</button>';
    const del = row.querySelector(".icon-btn");
    del.addEventListener("click", () => unregisterRepo(project, repo, row));
    panel.appendChild(row);
  }
  return panel;
}

// Optimistic unregister: drop the row immediately, then DELETE (idempotent). We can't use
// action() here — its onDone only runs on SUCCESS (its catch just toasts), so a failed
// DELETE would leave the already-removed row gone and falsely show the repo as
// unregistered. Own the async and re-render in a `finally` so the panel re-derives from
// the server on BOTH outcomes: restores the row on failure, confirms removal on success.
async function unregisterRepo(project, repo, row) {
  row.remove();
  try {
    await api("DELETE",
      "/projects/" + encodeURIComponent(project.id) +
      "/repos/" + encodeURIComponent(repo.id));
    toast("repo unregistered");
  } catch (e) {
    toast(e.message, true);
  } finally {
    render();
  }
}

// ADD-REPO modal — pick a directory from GET /api/workspaces that is NOT already a member,
// then POST /api/projects/:id/repos { repo }. The server 409s if the directory is already
// registered under a DIFFERENT project and 404s if it isn't a repo node (or is gone); both
// surface INLINE in .m-error (not just a transient toast). Disable submit with an honest
// message when every workspace is already a member.
function openAddRepoModal(project, repos, wsById) {
  const memberIds = new Set(repos.map((r) => r.id));
  const avail = Array.from(wsById.values()).filter((w) => !memberIds.has(w.id));

  const body = el("div", { class: "m-body" });
  if (!avail.length) {
    body.innerHTML = '<div class="empty">Every registered workspace is already a member of this project.</div>';
  } else {
    body.innerHTML =
      '<label class="field" style="margin-bottom:6px">' +
        '<span class="lbl">directory — register a repo the project can target</span>' +
        '<select id="ar-dir">' + avail.map((w) =>
          '<option value="' + esc(w.id) + '">' + esc(w.label || w.path) + '</option>').join("") +
        '</select>' +
      '</label>' +
      '<small class="hint muted">The directory must be a registered repo. Registering it here lets the project coordinate initiatives against it.</small>';
  }

  const foot = el("div", { class: "m-foot" });
  const errEl = el("span", { class: "m-error hint" }, "");
  const cancel = el("button", { class: "btn ghost" }, avail.length ? "Cancel" : "Close");
  const submit = el("button", { class: "btn" }, "Add repo");
  if (!avail.length) submit.disabled = true;
  foot.appendChild(errEl);
  foot.appendChild(cancel);
  foot.appendChild(submit);

  const { close } = openModal({ title: "Add repo", body, footer: foot });
  cancel.addEventListener("click", close);
  function showErr(msg) { errEl.textContent = msg || ""; errEl.classList.toggle("on", !!msg); }

  const sel = body.querySelector("#ar-dir");
  submit.addEventListener("click", () => {
    if (!avail.length) return;
    const repo = sel.value;
    if (!repo) { showErr("Pick a directory first."); return; }
    showErr("");
    action(submit, async () => {
      try {
        return await api("POST",
          "/projects/" + encodeURIComponent(project.id) + "/repos", { repo });
      } catch (e) {
        showErr(e.message); // 409 (member elsewhere) / 404 (not a repo node) shown inline
        throw e; // let action() toast + re-enable the button
      }
    }, { success: "repo registered", onDone: () => { close(); render(); } });
  });
}

// ---------- needs-attention signal ----------
// A live pull-signal so the operator gets drawn in instead of polling: GET /health
// reports needsAttention { review, failed, total } and we reflect it as a tab-title
// badge ("(2) butchr") plus a header indicator that links to the dashboard (whose
// workspace cards highlight the review/failed counts). When permitted, a Web
// Notification fires as a task NEWLY enters review/failed. Refreshed on boot and on
// every SSE event, so it tracks without a reload.
const BASE_TITLE = "butchr";
let lastAttention = null; // { review, failed, total } from the previous poll

function applyTitleBadge(total) {
  const badge = total > 0 ? `(${total}) ` : "";
  const wanted = badge + BASE_TITLE;
  if (document.title !== wanted) document.title = wanted;
}

function applyAttentionIndicator(na) {
  const node = document.getElementById("attention");
  if (!node) return;
  if (!na || na.total <= 0) {
    node.hidden = true;
    node.textContent = "";
    return;
  }
  const parts = [];
  if (na.in_review) parts.push(`${na.in_review} in review`);
  if (na.spec_review) parts.push(`${na.spec_review} spec review`);
  if (na.needs_info) parts.push(`${na.needs_info} needs info`);
  // `na.total` is the authoritative sum; use it for the badge
  node.textContent = String(na.total);
  node.title = "Needs attention: " + (parts.length ? parts.join(", ") : na.total + " tasks");
  node.hidden = false;
}

// Fire a desktop notification when a task NEWLY enters a feedback state (count went
// up since the last poll). Fully gated on granted permission, so it's silent until
// the operator opts in by clicking the header indicator (see wireAttention).
function maybeNotify(na) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  if (!lastAttention) return; // first poll — establish a baseline, don't alert
  const newInReview = (na.in_review || 0) - (lastAttention.in_review || 0);
  const newSpecReview = (na.spec_review || 0) - (lastAttention.spec_review || 0);
  const newNeedsInfo = (na.needs_info || 0) - (lastAttention.needs_info || 0);
  if (newInReview <= 0 && newSpecReview <= 0 && newNeedsInfo <= 0) return;
  const bits = [];
  if (newInReview > 0) bits.push(`${newInReview} ready for review`);
  if (newSpecReview > 0) bits.push(`${newSpecReview} spec ready for review`);
  if (newNeedsInfo > 0) bits.push(`${newNeedsInfo} awaiting an answer`);
  try {
    new Notification("butchr — needs attention", { body: bits.join(", "), tag: "butchr-attention" });
  } catch (e) { /* notifications unavailable — ignore */ }
}

async function updateAttention() {
  let health;
  try {
    health = await api("GET", "/health");
  } catch (e) {
    return; // transient (e.g. degraded /health 503) — keep the last badge/banner
  }
  // Reflect the dispatcher PAUSE state (banner + topbar control) from the same
  // /health payload, so it tracks pause/resume live regardless of which page is open.
  if (health && typeof health.paused === "boolean") applyPauseState(health.paused);
  const na = health && health.needsAttention;
  if (!na) return;
  applyTitleBadge(na.total);
  applyAttentionIndicator(na);
  maybeNotify(na);
  lastAttention = {
    in_review: na.in_review || 0,
    spec_review: na.spec_review || 0,
    needs_info: na.needs_info || 0,
    total: na.total,
  };
}

// ---------- dispatcher pause / maintenance mode ----------
// A global switch that stops NEW agent dispatch (drain-only) for restarts /
// recovery / maintenance, without disturbing running/review/idle tasks. The state
// comes from GET /health (`paused`) and is reflected as a topbar toggle + a clear
// PAUSED banner; clicking either control POSTs /api/pause|resume. The pause is
// persisted server-side, so it survives a butchr restart until resumed.
let pausedState = false;
function applyPauseState(paused) {
  pausedState = !!paused;
  const banner = document.getElementById("pause-banner");
  if (banner) banner.hidden = !pausedState;
  const btn = document.getElementById("pause-toggle");
  if (btn) {
    btn.textContent = pausedState ? "▶ Resume" : "⏸ Pause";
    btn.classList.toggle("paused", pausedState);
    btn.title = pausedState
      ? "Resume new task dispatch"
      : "Pause new task dispatch (maintenance mode)";
  }
}

async function togglePause() {
  // Resume when currently paused, otherwise pause. The button + banner reflect the
  // authoritative `paused` returned by the endpoint.
  const path = pausedState ? "/resume" : "/pause";
  try {
    const r = await api("POST", path);
    applyPauseState(r && r.paused);
    toast(pausedState ? "dispatch paused — new tasks won't start" : "dispatch resumed");
  } catch (e) {
    toast(e.message, true);
  }
}

function wirePause() {
  const btn = document.getElementById("pause-toggle");
  if (btn) btn.addEventListener("click", togglePause);
  const resume = document.getElementById("pause-banner-resume");
  if (resume) resume.addEventListener("click", togglePause);
}

// Clicking the header indicator opts into desktop notifications (requestPermission
// needs a user gesture) on its way to the dashboard. The href handles navigation.
function wireAttention() {
  const node = document.getElementById("attention");
  if (!node) return;
  node.addEventListener("click", () => {
    if ("Notification" in window && Notification.permission === "default") {
      try { Notification.requestPermission(); } catch (e) { /* ignore */ }
    }
  });
}

// ---------- SSE live updates ----------
function connectSSE() {
  const conn = document.getElementById("conn");
  const setState = (cls, label) => {
    conn.className = "conn " + cls;
    conn.querySelector(".conn-label").textContent = label;
  };
  const es = new EventSource("/api/events");
  es.onopen = () => setState("up", "live");
  es.onerror = () => setState("down", "reconnecting…");
  es.onmessage = (ev) => {
    let e;
    try { e = JSON.parse(ev.data); } catch { return; }
    if (e.type === "hello") return;
    // Self-heal a failed state-meta load: while we're still on the built-in DEFAULT_STATE_META
    // fallback, retry the fetch on this event; once it succeeds the real server values land and
    // we re-render so board/list/filters switch from defaults to the authoritative set.
    if (!stateMetaLoaded) loadStateMeta().then(() => { refreshSoon(); updateAttention(); });
    // Re-render the current view on any relevant change. Cheap enough for a
    // single-operator local tool.
    refreshSoon();
    // Refresh the needs-attention signal (tab badge + header indicator) too, so it
    // tracks review/failed transitions live regardless of which page is open.
    updateAttention();
  };
}

// ---------- in-flight UI state preservation across SSE re-renders ----------
// The SSE path does a FULL re-render (mount() clears app.innerHTML), which would
// otherwise discard the operator's scroll position, focus, and any text typed into a
// not-yet-submitted input (answer / spec / reject / nudge / plan note / story answer /
// inline comment). captureUiState() snapshots that before render(); restoreUiState()
// re-applies it after, keyed by a stable data-restore-key on each input — so a
// state-change event arriving mid-typing doesn't lose the text, caret, focus, or
// scroll. Targeted (only these inputs), and used ONLY on the SSE path — plain
// navigation (hashchange / boot) intentionally starts fresh.
// <test-extract:capture-ui-state> (fenced for test/app-restore-uistate.test.ts)
function captureUiState() {
  const values = new Map();
  document.querySelectorAll("[data-restore-key]").forEach((node) => {
    const key = node.dataset.restoreKey;
    // The inline-comment editor lives inside the async-fetched diff; it's captured
    // separately below and restored via wireDiff, so skip it in the generic pass.
    if (key === "inline-comment") return;
    values.set(key, { value: node.value || "", selStart: node.selectionStart, selEnd: node.selectionEnd });
  });
  // An open (uncommitted) inline-comment editor: record the diff line it's attached to
  // (by the line's stable data-key) plus its text + caret, for wireDiff to re-open.
  let inline = null;
  const ie = document.querySelector(".dl-comment-edit .dlc-input");
  if (ie) {
    const dl = ie.closest(".dl-comment-edit") && ie.closest(".dl-comment-edit").previousElementSibling;
    const lineKey = dl && dl.dataset ? dl.dataset.key : null;
    if (lineKey) inline = { key: lineKey, value: ie.value || "", selStart: ie.selectionStart, selEnd: ie.selectionEnd };
  }
  const ae = document.activeElement;
  const activeKey = ae && ae.dataset ? (ae.dataset.restoreKey || null) : null;
  return { scrollY: window.scrollY, activeKey, values, inline };
}
// </test-extract:capture-ui-state>

// Re-apply a captured snapshot. Resilient by design: any element/key may have vanished
// between renders (the new view may not contain that input at all), so every lookup is
// guarded and nothing here may throw — render() must stay green.
// <test-extract:restore-ui-state> (fenced for test/app-restore-uistate.test.ts)
function restoreUiState(snap) {
  if (!snap) return;
  try { window.scrollTo(0, snap.scrollY || 0); } catch (e) { /* ignore */ }
  for (const [key, st] of snap.values) {
    if (key === snap.activeKey) continue; // restore the focused one last so focus sticks
    applyInputRestore(key, st, false);
  }
  if (snap.activeKey && snap.values.has(snap.activeKey)) {
    applyInputRestore(snap.activeKey, snap.values.get(snap.activeKey), true);
  }
  // Hand any open inline-comment editor to wireDiff (the diff is fetched asynchronously,
  // so its line rows don't exist yet at this point).
  pendingInlineRestore = snap.inline || null;
}
// </test-extract:restore-ui-state>

// <test-extract:apply-input-restore> (fenced for test/app-restore-uistate.test.ts)
function applyInputRestore(key, st, focus) {
  // data-restore-key values are controlled constant slugs, safe in an attribute selector.
  const node = document.querySelector('[data-restore-key="' + key + '"]');
  if (!node) return;
  // These are uncommitted fields — a fresh render produces them empty — so only restore
  // when we captured text AND the rendered field is still empty (never clobber content).
  if (st.value && !node.value) {
    node.value = st.value;
    try {
      if (typeof st.selStart === "number" && node.setSelectionRange) node.setSelectionRange(st.selStart, st.selEnd);
    } catch (e) { /* ignore */ }
  }
  if (focus) { try { node.focus(); } catch (e) { /* ignore */ } }
}
// </test-extract:apply-input-restore>

let refreshTimer = null;
function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    // Preserve in-flight UI state across the full re-render (see captureUiState).
    const snap = captureUiState();
    await render(); // render() swallows its own errors, so this never rejects
    restoreUiState(snap);
  }, 150);
}

// ---------- theme toggle ----------
// The initial data-theme is set by an inline <head> script (no-flash); here we
// keep the toggle button's icon in sync and persist the user's choice.
const THEME_KEY = "butchr-theme";
function currentTheme() {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = document.getElementById("theme-toggle");
  if (btn) {
    // Show the icon for the theme you'd switch TO.
    btn.textContent = theme === "dark" ? "☀" : "☾";
    btn.title = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
  }
}
function setupTheme() {
  applyTheme(currentTheme());
  const btn = document.getElementById("theme-toggle");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* ignore */ }
    applyTheme(next);
  });
}

// ---------- boot ----------
window.addEventListener("hashchange", render);
setupTheme();
wireAttention();
wirePause();
// Load the server-owned state metadata BEFORE the first render so STATE_KIND /
// AGENT_TYPE / the status-membership lists are populated (see applyStateMeta). On
// failure the tables stay empty and the UI degrades rather than crashing.
(async () => {
  await loadStateMeta();
  updateAttention();
  render();
  connectSSE();
})();
