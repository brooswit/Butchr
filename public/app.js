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

// Fetch the server-owned state metadata and (re)build every table above from it. Called
// once at boot BEFORE the first render. On failure the tables stay empty and the helpers
// degrade rather than crash (the page still loaded, so same-origin meta is rarely down).
async function loadStateMeta() {
  try {
    applyStateMeta(await api("GET", "/state-meta"));
  } catch (e) {
    console.error("state-meta load failed; UI degrades to defaults", e);
  }
}
function applyStateMeta(meta) {
  const stateMeta = (meta && meta.stateMeta) || {};
  const all = (meta && meta.allStatuses) || [];
  const terminal = (meta && meta.terminalStatuses) || [];
  STATE_KIND = {};
  AGENT_TYPE = {};
  for (const s of all) {
    const m = stateMeta[s] || {};
    STATE_KIND[s] = m.kind || "idle";
    if (m.agentType) AGENT_TYPE[s] = m.agentType;
  }
  ALL_STATUSES = all.slice();
  TERMINAL_STATUSES = terminal.slice();
  ACTIVE_STATUSES = all.filter((s) => !terminal.includes(s));
  FILTER_STATUSES = all.flatMap((s) => (s === "in_progress" ? [s, "needs_user_input", "idle"] : [s]));
  // Story (node) statuses live alongside task statuses in the unified work list, so the
  // filter chips must narrow stories too. Append the story-specific statuses not already
  // present (`aborted` is shared with tasks, so it's already in the set).
  for (const s of ["open", "done"]) if (!FILTER_STATUSES.includes(s)) FILTER_STATUSES.push(s);
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
  return (plan && t.plan_preview ? '<span class="chip plan" title="plan-preview gate — proposes a plan and pauses for approval before writing code">plan-preview</span> ' : "")
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
        <h2 style="margin:0">CTO agent <span class="cto-badge ${stateCls}">${state}</span></h2>
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
    wrap.appendChild(sum);
  }

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
    slot.innerHTML = `<span class="cto-badge ${cls}">CTO ${esc(state)}</span>`;
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
  // survives SSE re-renders and reloads. The LIST and GRAPH views both show ALL work —
  // stories AND tasks — as peers (the graph draws stories as first-class peer nodes with
  // their subtasks enclosed in a cluster box); only Board stays leaves-only (reworked by
  // sibling subtasks), so it receives workLeaves(work) while List and Graph get the union.
  const body = el("div", { class: "ws-body" });
  const paintBody = () => {
    body.innerHTML = "";
    if (dirView === "graph") {
      body.appendChild(el("h2", {}, "Dependency graph"));
      body.appendChild(renderGraph(work));
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

// A node's compact subtask ROLLUP string from its server-computed per-status `counts` map.
// total counts every status EXCEPT the `idle` pseudo-bucket (a flag peeled out of in_progress,
// not a real status); ✓ = merged + rolled_back (done), ✗ = failed + aborted (dead). Degrades
// cleanly: a node with no subtasks (or only idle) reads "0" with no ✓/✗ noise.
function workRollup(counts) {
  const c = counts || {};
  const total = Object.keys(c).reduce((n, k) => (k === "idle" ? n : n + (c[k] || 0)), 0);
  const done = (c.merged || 0) + (c.rolled_back || 0);
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
      <textarea class="sa-answer" placeholder="Answer the story-level ask. It goes back to the story leader, which continues from your response."></textarea>
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

// How many previous FINISHED generations the dependency graph reveals behind the
// active frontier (see renderGraph / finishedGenerations). Mirrored to localStorage
// so the operator's chosen depth survives SSE re-renders and reloads. Defaults to a
// small value so the graph stays readable; 0 hides all finished nodes (active only).
const GRAPH_GENS_KEY = "butchr-graph-gens";
function graphGenDepth() {
  try {
    const v = parseInt(localStorage.getItem(GRAPH_GENS_KEY), 10);
    return Number.isFinite(v) && v >= 0 ? v : 1;
  } catch (e) { return 1; }
}
function setGraphGenDepth(n) {
  try { localStorage.setItem(GRAPH_GENS_KEY, String(n)); } catch (e) { /* ignore */ }
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
    <td>${termLink ? termLink + " · " : ""}<a href="#/task/${esc(t.id)}">${action}</a></td>`;
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
  let chipsHtml = chip(effStatus(story));
  if (story.pending_ask != null) {
    chipsHtml += story.ask_responder === "user"
      ? ' <span class="chip needs_user_input" title="an open story ask was escalated to YOU — expand to answer">needs your input</span>'
      : ' <span class="chip awaiting-cto" title="an open story ask owned by the CTO agent (handled automatically) — you can also answer">awaiting CTO</span>';
  }
  const leader = story.leader || {};
  const leaderState = leader.running ? "leader up" : leader.desired ? "leader down" : "no leader";
  const meta = workRollup(story.counts) + " · " + leaderState;

  const tr = el("tr", { class: "is-node clickable" + (expanded ? " expanded" : "") });
  tr.innerHTML = `
    <td class="id"><span class="work-caret">${expanded ? "▾" : "▸"}</span><span class="story-brief" title="${esc(brief)}">${esc(brief)}</span></td>
    <td>${chipsHtml}</td>
    <td class="when" title="${esc(meta)}">${esc(meta)}</td>
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
  const defs = [["list", "List"], ["graph", "Graph"], ["board", "Board"]];
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

// Generation depth, back from the active frontier, of each FINISHED (non-active)
// task in the active tasks' dependency ancestry. The active/in-flight tasks are the
// "tip" (generation 0); a finished task that directly blocks an active task is
// generation 1; its finished blockers are generation 2; and so on. Computed purely
// client-side by a breadth-first walk BACKWARD along blocked_by, counting only the
// finished hops, so the shortest distance to the tip wins. Finished tasks with no
// dependency path to an active task aren't "previous generations" of anything
// in flight and get no entry (they're omitted from the graph). Returns a Map of
// finished-task-id → generation (>= 1); active tasks are intentionally absent.
function finishedGenerations(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  // Active = part of the tip, for BOTH kinds. isHistoryItem encodes the split: a NODE
  // (story) is finished once done/aborted (open/merging/merge_blocked stay tip); a LEAF by
  // the server's terminal set. Story statuses aren't in ACTIVE_STATUSES, so keying off
  // !isHistoryItem (rather than ACTIVE_STATUSES) is what folds finished stories into the
  // finished generations and keeps open stories on the active frontier.
  const isActive = (t) => t && !isHistoryItem(t);
  const gen = new Map();
  // Frontier starts at the active tip (generation 0); these are not recorded in
  // `gen` (they always render) but seed the walk into their blockers.
  let frontier = tasks.filter(isActive).map((t) => t.id);
  const visited = new Set(frontier);
  let g = 0;
  while (frontier.length) {
    const next = [];
    for (const id of frontier) {
      for (const b of (byId.get(id).blocked_by || [])) {
        if (visited.has(b)) continue;
        const bt = byId.get(b);
        if (!bt || isActive(bt)) continue; // active blockers seed from their own gen-0 slot
        visited.add(b);
        gen.set(b, g + 1);
        next.push(b);
      }
    }
    frontier = next;
    g++;
  }
  return gen;
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

// Draw a DAG of the workspace's non-terminal WORK (stories + tasks) and their blockers:
// nodes are work items (label = id, colored by effective status), edges are blocker→blocked
// arrows pointing left→right across topological levels. Inline SVG, no library. A STORY is a
// first-class PEER node — it participates in blocked_by edges both ways — and its subtasks are
// enclosed in a subtle cluster box (drawGraphSvg) rather than connected by parent/child edges.
// Clicking a TASK node opens its detail; STORY nodes are inert (no detail route). Re-rendered
// wholesale on each SSE event by the workspace view, so it live-updates for free.
//
// The active/in-flight work (the "tip") always renders; how much of the FINISHED dependency
// history behind it shows is controlled by a generations slider (see finishedGenerations +
// buildGraphGenSlider) so deep merge trains stay readable. `work` is the full leaf|node union.
function renderGraph(work) {
  const byId = new Map(work.map((t) => [t.id, t]));
  // Active tip for BOTH kinds via !isHistoryItem (story statuses aren't in ACTIVE_STATUSES):
  // an OPEN story joins the tip, a done/aborted story folds into finished history like a task.
  const active = work.filter((t) => !isHistoryItem(t));
  // Reversed edges over the WHOLE list (not just the graphed subset) so a node's
  // sub-tree progress counts dependents that have already merged off the graph.
  const dependentsOf = reverseDeps(work);

  if (active.length === 0) {
    return el("div", { class: "empty" }, "No active work to graph.");
  }

  // Finished-work generations back from the active tip, and the deepest one present.
  const gen = finishedGenerations(work);
  let maxGen = 0;
  for (const g of gen.values()) if (g > maxGen) maxGen = g;

  // The graph repaints into `holder` whenever the slider moves, reading the (clamped)
  // depth fresh each time so the persisted value drives both the control and the draw.
  const holder = el("div", { class: "task-graph-holder" });
  const draw = () => {
    holder.innerHTML = "";
    holder.appendChild(drawGraphSvg(byId, active, dependentsOf, gen, Math.min(graphGenDepth(), maxGen)));
  };
  draw();

  const parts = [];
  // Only worth a slider when there's finished history to reveal; otherwise the graph
  // is just the active frontier and the control would do nothing.
  if (maxGen >= 1) parts.push(buildGraphGenSlider(maxGen, draw));
  parts.push(holder);
  return el("div", {}, parts);
}

// Build the SVG graph for the active tip plus every finished node within `depth`
// generations of it (finishedGenerations). Pulled out of renderGraph so the slider
// can repaint just this subtree without rebuilding the control around it.
function drawGraphSvg(byId, active, dependentsOf, gen, depth) {
  // Node set: the active tip (always shown), plus finished tasks whose generation
  // back from the tip is within the chosen depth. A merged blocker that passes shows
  // up as a green node, making the dependency's provenance visible; one beyond the
  // depth is dropped along with its now-dangling edges.
  const nodeIds = new Set(active.map((t) => t.id));
  for (const [id, g] of gen) if (g <= depth && byId.has(id)) nodeIds.add(id);

  const edges = [];
  for (const id of nodeIds) {
    for (const b of (byId.get(id).blocked_by || [])) {
      if (nodeIds.has(b)) edges.push({ from: b, to: id });
    }
  }

  // layout geometry
  const NW = 158, NH = 38, COL_GAP = 64, ROW_GAP = 16, PAD = 14;
  const level = graphLevels(nodeIds, edges);
  const byLevel = new Map();
  for (const id of nodeIds) {
    const lv = level[id];
    if (!byLevel.has(lv)) byLevel.set(lv, []);
    byLevel.get(lv).push(id);
  }
  const maxLevel = Math.max(0, ...[...nodeIds].map((id) => level[id]));
  const pos = new Map();
  let maxRows = 0;
  for (let lv = 0; lv <= maxLevel; lv++) {
    const col = byLevel.get(lv) || [];
    maxRows = Math.max(maxRows, col.length);
    col.forEach((id, i) => {
      pos.set(id, { x: PAD + lv * (NW + COL_GAP), y: PAD + i * (NH + ROW_GAP) });
    });
  }
  const width = PAD * 2 + (maxLevel + 1) * NW + maxLevel * COL_GAP;
  const height = PAD * 2 + maxRows * NH + Math.max(0, maxRows - 1) * ROW_GAP;

  const root = svg("svg", {
    class: "task-graph", width, height, viewBox: `0 0 ${width} ${height}`,
    role: "img", "aria-label": "Task dependency graph",
  });

  // arrowhead marker, reused by every edge
  const defs = svg("defs", {}, [
    svg("marker", {
      id: "tg-arrow", viewBox: "0 0 10 10", refX: "9", refY: "5",
      markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse",
    }, [svg("path", { class: "tg-arrow-head", d: "M0,0 L10,5 L0,10 z" })]),
  ]);
  root.appendChild(defs);

  // Cluster bounding-box layer, drawn FIRST so it sits BEHIND the edges + nodes: for each
  // STORY (node-kind) present, a subtle translucent rounded-rect enclosing the story node +
  // its VISIBLE child subtasks (children = leaves in the node set whose parent_id||story_id
  // matches the story), with a small story-id label. Parent/child ownership is shown by this
  // ENCLOSURE, not by edges. The layered topological layout is left UNTOUCHED, so a story's
  // children may be scattered and its box may grow or overlap neighbours — an accepted
  // tradeoff (translucent, behind everything); we do NOT re-layout to force child adjacency.
  // A story with no visible child draws no box (the bare node suffices). CPAD ≤ PAD keeps the
  // box (and its label band) inside the svg's PAD margin, so nothing clips.
  const CPAD = 12;
  const clusterLayer = svg("g", { class: "tg-clusters" });
  for (const id of nodeIds) {
    const story = byId.get(id);
    if (!story || story.work_kind !== "node") continue;
    const members = [id];
    for (const cid of nodeIds) {
      const c = byId.get(cid);
      if (c && c.work_kind === "leaf" && (c.parent_id || c.story_id) === id) members.push(cid);
    }
    if (members.length < 2) continue; // no visible children → just the node, no box
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const m of members) {
      const p = pos.get(m);
      if (!p) continue;
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + NW); maxY = Math.max(maxY, p.y + NH);
    }
    const bx = minX - CPAD, by = minY - CPAD;
    const bw = (maxX - minX) + CPAD * 2, bh = (maxY - minY) + CPAD * 2;
    const cg = svg("g", { class: "tg-cluster" });
    cg.appendChild(svg("title", {}, `story ${id}`));
    cg.appendChild(svg("rect", { class: "tg-cluster-rect", x: bx, y: by, width: bw, height: bh, rx: 10, ry: 10 }));
    cg.appendChild(svg("text", { class: "tg-cluster-label", x: bx + 8, y: by + 2 }, id));
    clusterLayer.appendChild(cg);
  }
  root.appendChild(clusterLayer);

  // edges next so nodes paint on top of them
  const edgeLayer = svg("g", { class: "tg-edges" });
  for (const e of edges) {
    const a = pos.get(e.from), b = pos.get(e.to);
    if (!a || !b) continue;
    const x1 = a.x + NW, y1 = a.y + NH / 2;
    const x2 = b.x, y2 = b.y + NH / 2;
    const dx = Math.max(18, (x2 - x1) / 2);
    edgeLayer.appendChild(svg("path", {
      class: "tg-edge",
      d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
      "marker-end": "url(#tg-arrow)",
    }));
  }
  root.appendChild(edgeLayer);

  // nodes
  for (const id of nodeIds) {
    const t = byId.get(id);
    const p = pos.get(id);
    const st = effStatus(t);
    const isStory = t.work_kind === "node";
    // Sub-tree this node gates: how many of its transitive dependents have merged.
    // Nodes that gate nothing get no bar and keep the plain two-line layout.
    const subIds = gatedSubtree(id, dependentsOf);
    const subTotal = subIds.size;
    let subMerged = 0;
    for (const sid of subIds) if ((byId.get(sid) || {}).status === "merged") subMerged++;
    const prog = subTotal ? ` · ${subMerged}/${subTotal} merged` : "";
    // When a bar is present the two text lines shift up to make room for it.
    const idY = NH / 2 - (subTotal ? 5 : 3);
    const stY = NH / 2 + (subTotal ? 8 : 11);
    // A STORY is a first-class PEER node drawn distinct (tg-story: heavier/accent border) but
    // INERT — stories have no detail route, so it does not navigate (role=group, no tabindex,
    // default cursor). A TASK node still links to its detail page (role=link, keyboard-focusable).
    const g = svg("g", {
      class: "tg-node " + st + (isStory ? " tg-story" : ""),
      transform: `translate(${p.x},${p.y})`,
      tabindex: isStory ? null : "0",
      role: isStory ? "group" : "link",
      "aria-label": `${isStory ? "story " : ""}${id} — ${st}${prog}`,
    });
    g.appendChild(svg("title", {}, `${isStory ? "story " : ""}${id} · ${st}${prog}`));
    g.appendChild(svg("rect", { class: "tg-rect", width: NW, height: NH, rx: 6, ry: 6 }));
    g.appendChild(svg("text", { class: "tg-id", x: NW / 2, y: idY }, id));
    g.appendChild(svg("text", { class: "tg-status", x: NW / 2, y: stY }, st));
    if (subTotal) {
      const bw = NW - 16;
      g.appendChild(svg("rect", { class: "tg-prog-track", x: 8, y: NH - 5, width: bw, height: 3, rx: 1.5 }));
      g.appendChild(svg("rect", {
        class: "tg-prog-fill", x: 8, y: NH - 5, height: 3, rx: 1.5,
        width: Math.round((bw * subMerged) / subTotal),
      }));
    }
    if (!isStory) {
      const go = () => { location.hash = "#/task/" + id; };
      g.addEventListener("click", go);
      g.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); go(); }
      });
    }
    root.appendChild(g);
  }

  // legend of the statuses actually present, reusing the .chip color styling
  const present = [...new Set([...nodeIds].map((id) => effStatus(byId.get(id))))];
  const legend = el("div", { class: "tg-legend" },
    present.map((s) => el("span", { class: "chip " + s }, s)));

  const scroll = el("div", { class: "task-graph-scroll" }, [root]);
  return el("div", {}, [legend, scroll]);
}

// Human-readable readout shown next to the generations slider. The endpoints get
// descriptive labels (0 = active only, max = the full available history) so the
// operator knows what the extremes mean.
function graphGenValueText(n, maxGen) {
  if (n <= 0) return "0 (active only)";
  if (n >= maxGen) return maxGen + " (all)";
  return String(n);
}

// The "Finished generations" range slider for the dependency graph. Lets the
// operator choose how many previous finished generations (0 … maxGen) render behind
// the active tip; the chosen value persists in localStorage (graphGenDepth) and the
// current value is shown alongside. `onChange` repaints the graph in place.
function buildGraphGenSlider(maxGen, onChange) {
  // Reflect the persisted depth, clamped to what's currently available.
  const value = Math.min(graphGenDepth(), maxGen);
  const input = el("input", {
    type: "range", id: "graph-gens", class: "graph-gens-slider",
    min: "0", max: String(maxGen), step: "1", value: String(value),
    "aria-label": "Previous finished generations to show",
  });
  const out = el("span", { class: "graph-gens-value" }, graphGenValueText(value, maxGen));
  input.addEventListener("input", () => {
    const n = Math.max(0, Math.min(maxGen, parseInt(input.value, 10) || 0));
    setGraphGenDepth(n);
    out.textContent = graphGenValueText(n, maxGen);
    onChange();
  });
  return el("div", { class: "graph-gens" }, [
    el("label", { class: "graph-gens-label", for: "graph-gens" }, "Finished generations"),
    input,
    out,
  ]);
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
function boardLaneKey(w, byId) {
  if (w.work_kind === "node") {
    if (w.status === "open") return boardHasUnmetBlockers(w, byId) ? "blocked" : "in_progress";
    if (w.status === "merging" || w.status === "merge_blocked") return "in_review";
    return null; // done / aborted / anything terminal → omitted
  }
  // leaf task: only active (non-terminal) statuses appear, in their own-named column.
  if (!ACTIVE_STATUSES.includes(w.status)) return null;
  return BOARD_LANE_KEYS.has(w.status) ? w.status : null;
}

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
    const row = el("a", {
      class: "bc-blocker" + (stuck ? " stuck" : ""),
      href: "#/task/" + esc(bid),
      title: stuck ? "will never merge — edit blocked_by to proceed" : bid,
    });
    row.innerHTML = `<span class="bk-id">${esc(bid)}</span>${chip(st)}`;
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
      <span class="bc-id"><span class="story-badge">story</span><span class="bc-story-id">${esc(s.id)}</span></span>
      <span class="bc-chips">${chip(effStatus(s))}</span>
    </div>
    <div class="bc-meta">
      <span class="bc-when" title="${esc(meta)}">${esc(meta)}</span>
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
  const merged = subtree.filter((t) => t.status === "merged").length;
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
  // server-computed STRUCTURAL `pending_responder` (story|cto|user). `user` is emphasized
  // ("awaiting you"); `cto` / `story` are muted (an agent — the CTO, or the story leader —
  // handles it, but you can also act). butchr is responder-agnostic: the action controls
  // below render regardless. Null pending_responder (non-feedback state) shows no banner.
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
        <textarea id="rnote" placeholder="What needs to change? The note (plus any inline comments above) goes back to the same live agent, which keeps working in-context (no restart)."></textarea>
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
        <textarea id="spec" placeholder="Write the full spec for this brief — what to build, where, and how it should be verified."></textarea>
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
        <textarea id="rnote" placeholder="What needs to change in the spec?"></textarea>
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
        <textarea id="planNote" placeholder="On approve: optional steering notes folded into the implementation. On request-changes: what the plan must change before implementing."></textarea>
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
        <textarea id="answer" placeholder="Respond to what the agent raised. It goes back to the same agent, which butchr re-launches in-context (--resume) to continue."></textarea>
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
        <textarea id="nudgeText" placeholder="Optional steering note, sent to the agent as if typed by a human. Leave blank to just nudge it to continue."></textarea>
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
    return `<div class="diff-file">
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
function resetInlineComments(taskId) {
  if (inlineCommentsTaskId !== taskId) { inlineComments = new Map(); inlineCommentsTaskId = taskId; }
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
  const ta = el("textarea", { class: "dlc-input", placeholder: "Comment on this line — sent to the agent on Request change…" });
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
    head.addEventListener("click", () => head.parentElement.classList.toggle("collapsed"));
  });
  box.querySelectorAll(".dl[data-key] .dl-num").forEach((num) => {
    num.addEventListener("click", () => openCommentEditor(box, num.closest(".dl")));
  });
  for (const key of inlineComments.keys()) renderCommentRow(box, key);
  updateCommentSummary();
}

// ---------- topnav active state ----------
// Highlight the topbar nav link matching the current route. Workspace/task pages
// fall under "Workspaces"; the Metrics page under "Metrics".
function syncTopnav(route) {
  const links = document.querySelectorAll(".topnav-link");
  if (!links.length) return;
  const onMetrics = route && route.name === "metrics";
  links.forEach((a) => {
    const isMetrics = a.getAttribute("href") === "#/metrics";
    const active = isMetrics ? onMetrics : !onMetrics;
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
    // Re-render the current view on any relevant change. Cheap enough for a
    // single-operator local tool.
    refreshSoon();
    // Refresh the needs-attention signal (tab badge + header indicator) too, so it
    // tracks review/failed transitions live regardless of which page is open.
    updateAttention();
  };
}

let refreshTimer = null;
function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(render, 150);
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
