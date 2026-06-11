// butchr webapp — vanilla JS single-page app. Hash-routed, SSE live updates.
"use strict";

const app = document.getElementById("app");

// ---------- tiny helpers ----------
const h = (html) => html; // marker for template strings
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
// CANONICAL STATUS LABELS for the 9-state model. Maps internal status keys to their
// friendly display labels. Any status not listed shows verbatim (fallback for
// unknown values from historical audit logs). The chip CSS class stays the raw status.
const STATUS_LABELS = {
  spec_review: "spec review",
  in_progress: "in progress",
  in_review: "in review",
  needs_info: "needs info",
  finalizing: "finalizing",
  idea: "idea",
  blocked: "blocked",
  merged: "merged",
  aborted: "aborted",
};
function statusLabel(status) {
  return STATUS_LABELS[status] || status;
}
function chip(status) {
  return `<span class="chip ${esc(status)}">${esc(statusLabel(status))}</span>`;
}
// STATE-KIND helpers — mirror STATE_META from src/db.ts so the UI can show whether
// a state is agent-driven, feedback-awaiting, or idle (terminal/blocked).
const STATE_KIND = {
  idea: "agent",
  spec_review: "feedback",
  blocked: "idle",
  needs_info: "feedback",
  in_progress: "agent",
  in_review: "feedback",
  finalizing: "agent",
  merged: "idle",
  aborted: "idle",
};
const AGENT_TYPE = {
  idea: "ceo-agent",
  in_progress: "workspace-agent",
  finalizing: "workspace-agent",
};
// What an operator is awaiting for each feedback state (shown as a chip hint).
const AWAITED_LABEL = {
  spec_review: "spec approval",
  in_review: "diff review",
  needs_info: "answer to question",
};
function stateKind(status) {
  return STATE_KIND[status] || "idle";
}
function awaitedLabel(status) {
  return AWAITED_LABEL[status] || null;
}
// `idle` is a flag on an in_progress task (agent alive but its CLI has gone quiet),
// not a real lifecycle status. Render it as its own chip in place of "in progress".
function effStatus(t) {
  return t.status === "in_progress" && t.idle ? "idle" : t.status;
}
// Renders a task's badge cluster — the status chip plus the optional plan /
// conflict badges — as an HTML string. Each badge's markup lives here only, so how
// a chip *looks* can't drift across the views. Which badges a view shows stays the
// caller's call (History/table stay lean, the detail header shows all), passed via
// opts; taskChips renders exactly the set requested. The conflict badge is always
// included when set — every view already shows it.
// `kind` shows a small state-kind chip (agent/feedback/idle) plus for feedback states
// the awaited artifact label — surfacing the canonical 3-kind model in the UI.
function taskChips(t, { plan = false, kind = false } = {}) {
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
  return (plan && t.kind === "plan" ? '<span class="chip plan">plan</span> ' : "")
    + (plan && t.plan_preview ? '<span class="chip plan" title="plan-preview gate — proposes a plan and pauses for approval before writing code">plan-preview</span> ' : "")
    + chip(st)
    + kindChip
    + (t.conflict ? ' <span class="chip aborted">conflict</span>' : "")
    // A non-zero dispatch priority jumps the queue — flag it so its order is visible
    // (priority 0 is the silent FIFO default, shown on no card).
    + (Number(t.priority) ? ` <span class="chip priority" title="dispatch priority — higher runs sooner">prio ${esc(String(t.priority))}</span>` : "");
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

// The agent is live (attachable) whenever it has a herdr pane: running/idle, while
// blocked on the request_review handshake in `review`, and during `finalizing` (its
// post-merge wrap-up) until butchr closes the pane. Gating on herdr_pane_id mirrors
// the /terminal endpoint exactly — the button shows iff the attach would succeed.
function isLive(t) {
  return !!t.herdr_pane_id;
}
// A task has a live agent pane we can read recent output from whenever its
// herdr_pane_id is set — running/idle/review (agent blocked in request_review)
// and finalizing. This is exactly what the backend /output route gates on.
function hasLivePane(t) {
  return !!t.herdr_pane_id;
}
// Compact monospace readout of a task's herdr pane/tab ids, for surfacing next to
// the Open-terminal control. Returns "" when no pane is allocated (task not yet
// dispatched or already torn down) — same gate as isLive/hasLivePane, so the ids
// appear exactly when the terminal button does.
function herdrIds(t) {
  if (!t.herdr_pane_id) return "";
  const pane = `<span class="herdr-id" title="herdr pane id">pane ${esc(t.herdr_pane_id)}</span>`;
  const tab = t.herdr_tab_id
    ? `<span class="herdr-id" title="herdr tab id">tab ${esc(t.herdr_tab_id)}</span>` : "";
  return `<span class="herdr-ids">${pane}${tab}</span>`;
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

// Open a GUI terminal attached to a running task's live agent pane.
async function openTaskTerminal(id, btn) {
  if (btn) btn.disabled = true;
  try {
    const r = await api("POST", "/tasks/" + id + "/terminal");
    toast("opened terminal" + (r.emulator ? " (" + r.emulator + ")" : ""));
  } catch (e) {
    // Fallback: show the command to run manually.
    const msg = e.message || "could not open terminal";
    toast(msg, true);
  } finally {
    if (btn) btn.disabled = false;
  }
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
// `btn`, run `fn` (typically an api() call), and on success toast `success` (a
// string, or a fn of fn's result) then run `onDone` (defaults to render()). On
// failure, toast the error and re-enable the button so it can be retried. The
// few buttons whose success message depends on the response toast inside `fn`
// themselves and pass no `success`. Any pre-flight confirm() must run before
// calling action(), so a cancel never disables the button.
async function action(btn, fn, { success, onDone } = {}) {
  btn.disabled = true;
  try {
    const r = await fn();
    if (success != null) toast(typeof success === "function" ? success(r) : success);
    (onDone || render)();
  } catch (e) {
    toast(e.message, true);
    btn.disabled = false;
  }
}

// ---------- directory picker modal ----------
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
  if (parts[0] === "dir") return { name: "directory", id: parts[1] };
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
// card/row, polled from GET /api/tasks/:id/activity (which reads only the tail of
// the session transcript). The directory view re-renders wholesale on every SSE
// event, which destroys+rebuilds the pulse nodes; this timer is module-scope and
// re-discovers the live `.pulse[data-id]` nodes each tick, and `activityCache`
// survives re-renders so a rebuild repaints the last-known action without flashing
// empty. render() stops it up front; renderDirectory restarts it after mount.
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
      const a = await api("GET", "/tasks/" + id + "/activity");
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
    else if (route.name === "directory") await renderDirectory(route.id);
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

// After acting on a task (merge / request changes), return to its directory's
// task list — that's the next thing you want, not the now-stale task page.
function backToDirectory(directoryId) {
  location.hash = directoryId ? "#/dir/" + directoryId : "#/";
}

// ---------- dashboard ----------
async function renderDashboard() {
  // The cross-project dashboard rollup: per-directory active/review/needs-attention/
  // failed counts + totals + each directory's effective gate command. `directories`
  // entries carry the same `counts` map dirCard expects, plus the aggregate buckets.
  const data = await api("GET", "/dashboard");
  const dirs = data.directories;
  const totals = data.totals;
  const wrap = el("div");
  wrap.appendChild(el("h1", {}, "Directories"));
  wrap.appendChild(el("div", { class: "crumbs" }, "registered workspaces · " + dirs.length));

  // Cross-project summary: the four operator-facing buckets aggregated across every
  // registered directory, so "what needs my eyes anywhere" reads at a glance.
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

  // add-directory form
  const form = el("div", { class: "panel" });
  form.innerHTML = `
    <h2 style="margin-top:0">Register a directory</h2>
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
    wrap.appendChild(el("div", { class: "empty" }, "No directories yet. Register a git repo above to begin."));
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
          await api("POST", "/directories", { path: picked });
          toast("directory registered");
          render();
        } catch (e) { toast(e.message, true); }
      }
    });
  });

  document.getElementById("add-dir").addEventListener("click", async () => {
    const path = document.getElementById("dpath").value.trim();
    const label = document.getElementById("dlabel").value.trim();
    // Optional per-directory gate command — omit when blank so the backend keeps
    // the default (NULL) rather than disabling the gate with an empty string.
    const gate = document.getElementById("dgate").value.trim();
    if (!path) return toast("path is required", true);
    try {
      await api("POST", "/directories", {
        path, label: label || undefined, gate_cmd: gate || undefined,
      });
      toast("directory registered");
      render();
    } catch (e) { toast(e.message, true); }
  });
}

function dirCard(d) {
  const c = d.counts || {};
  const pills = ["idea", "spec_review", "blocked", "needs_info", "in_progress", "idle", "in_review", "finalizing", "merged", "aborted"]
    .map((s) => {
      const cls = s === "blocked" && c[s] ? "count-pill has-blocked"
        : s === "in_progress" && c[s] ? "count-pill has-running"
        : s === "idle" && c[s] ? "count-pill has-idle"
        : s === "in_review" && c[s] ? "count-pill has-review"
        : s === "spec_review" && c[s] ? "count-pill has-review"
        : s === "needs_info" && c[s] ? "count-pill has-awaiting"
        : s === "finalizing" && c[s] ? "count-pill has-finalizing"
        : "count-pill";
      return `<span class="${cls}">${statusLabel(s)} <b>${c[s] || 0}</b></span>`;
    }).join("");
  // Aggregate bucket badges (active / review / needs-attention / failed) when the
  // card comes from the dashboard rollup (those fields are absent on a plain
  // DirectoryView, so the row is simply omitted there). needs-attention/failed light
  // up only when non-zero so a quiet directory stays visually calm.
  const buckets = typeof d.active === "number"
    ? `<div class="dir-buckets">
        <span class="dir-bucket">active <b>${d.active}</b></span>
        <span class="dir-bucket${d.review ? " review" : ""}">review <b>${d.review}</b></span>
        <span class="dir-bucket${d.needsAttention ? " attn" : ""}">attention <b>${d.needsAttention}</b></span>
        <span class="dir-bucket${d.failed ? " failed" : ""}">failed <b>${d.failed}</b></span>
      </div>`
    : "";
  const card = el("div", { class: "card" });
  card.innerHTML = `
    <div class="title">${esc(d.label || d.path)}</div>
    <div class="path">${esc(d.path)}</div>
    ${buckets}
    <div class="counts">${pills}</div>`;
  card.style.cursor = "pointer";
  card.addEventListener("click", () => (location.hash = "#/dir/" + d.id));
  return card;
}

// ---------- directory view ----------
async function renderDirectory(id) {
  // Pull the directory from the dashboard rollup (it carries the effective gate
  // command + override state the gate panel needs) alongside its task list.
  const [dash, tasks] = await Promise.all([
    api("GET", "/dashboard"),
    // Carry the active full-text search so it survives SSE-driven re-renders; the
    // server filters by `?q=` (see searchParam / buildFilterBar).
    api("GET", "/directories/" + id + "/tasks" + searchParam()),
  ]);
  const dir = dash.directories.find((x) => x.id === id);
  if (!dir) return mount(el("div", { class: "empty" }, "directory not found"));

  const wrap = el("div");
  wrap.appendChild(el("div", { class: "crumbs", html: `<a href="#/">Directories</a> / ${esc(dir.label || dir.path)}` }));
  wrap.appendChild(el("h1", {}, dir.label || dir.path));
  wrap.appendChild(el("div", { class: "path", html: esc(dir.path) }));

  // create-task launcher — a button that opens the New-task modal (prompt +
  // optional blocked_by). The modal POSTs to the existing create endpoint; the
  // resulting task appears via the SSE-driven re-render.
  const launch = el("div", { class: "row between", style: "margin-top:18px" });
  launch.appendChild(el("small", { class: "muted" },
    `Tasks run concurrently, each in its own worktree. ${queueLine(tasks)}`));
  const newBtn = el("button", { class: "btn", id: "new-task" }, "New task");
  newBtn.addEventListener("click", () => openNewTaskModal(id));
  launch.appendChild(newBtn);
  wrap.appendChild(launch);

  // List / Graph view toggle. The toggle bar sits outside the body region so it
  // persists while the body is swapped; the chosen mode lives in dirView (module
  // scope + localStorage) so it survives SSE re-renders and reloads.
  const body = el("div", { class: "dir-body" });
  const paintBody = () => {
    body.innerHTML = "";
    if (dirView === "graph") {
      body.appendChild(el("h2", {}, "Dependency graph"));
      body.appendChild(renderGraph(tasks));
    } else if (dirView === "board") {
      body.appendChild(el("h2", {}, "Merge train"));
      body.appendChild(renderBoard(tasks));
    } else {
      // search + status filter bar. Filter state lives in module-level vars
      // (taskSearch / statusFilter) so it survives the full re-render the app does
      // on every SSE event. The full-text search runs SERVER-SIDE (?q=) — typing
      // re-fetches the list (debounced) and repaints only the results region below
      // (not the bar itself), so the search input keeps focus while you type. The
      // split of active (everything non-terminal, incl. the feedback states
      // awaiting the operator) vs terminal-state history (merged/aborted only)
      // happens inside renderResults.
      const results = el("div", { class: "results" });
      body.appendChild(buildFilterBar(id, tasks, results));
      body.appendChild(results);
      renderResults(tasks, results);
    }
  };
  wrap.appendChild(buildViewToggle(paintBody));
  wrap.appendChild(body);
  paintBody();

  // build/test gate command panel — the command both the CI gate (in-worktree) and
  // the post-merge verify gate run for this directory. Shows the effective command +
  // whether it's a per-directory override or the default, with an inline editor.
  wrap.appendChild(gatePanel(dir));

  // danger zone
  const dz = el("div", { class: "row", style: "margin-top:32px" });
  const del = el("button", { class: "btn ghost" }, "Unregister directory");
  del.addEventListener("click", async () => {
    if (!confirm("Unregister this directory? Non-merged worktrees will be removed.")) return;
    try {
      await api("DELETE", "/directories/" + id);
      toast("directory unregistered");
      location.hash = "#/";
    } catch (e) { toast(e.message, true); }
  });
  dz.appendChild(del);
  wrap.appendChild(dz);

  mount(wrap);
  // Begin polling the live activity pulse for any running task cards now in the DOM.
  startActivity();
}

// ---------- per-directory build/test gate panel ----------
// `dir` is a dashboard directory entry (has gate_cmd + effective_gate_cmd). Renders
// the effective command, flags whether it's a per-directory override or the default,
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
  const cmdText = disabled ? "(gate disabled for this directory)" : (dir.effective_gate_cmd || "(none)");
  panel.appendChild(el("pre", { class: "gate-cmd" + (disabled ? " disabled" : "") }, cmdText));
  panel.appendChild(el("small", { class: "muted" },
    overridden
      ? (disabled ? "Per-directory override: the gate is disabled." : "Per-directory override.")
      : "Using the default gate (no per-directory override)."));
  return panel;
}

// Editor for a directory's gate command. A textarea (prefilled with the effective
// command) plus three actions: Save the typed command (an empty save DISABLES the
// gate), or "Use default" to clear the override (revert to config.verifyCmd). Maps
// to PATCH /api/directories/:id.
function openGateModal(dir) {
  const body = el("div", { class: "m-body" });
  body.innerHTML = `
    <label class="field" style="margin-bottom:6px">
      <span class="lbl">build/test gate command — run via <code>bash -lc</code> in the repo</span>
      <textarea id="gate-cmd" class="gate-textarea" placeholder="e.g. npm run build && npm test"></textarea>
    </label>
    <small class="hint muted">Save an empty command to DISABLE the gate for this directory. "Use default" reverts to the global default command.</small>`;
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

  const patch = async (btn, gate_cmd, msg) => {
    btn.disabled = true;
    try {
      await api("PATCH", "/directories/" + dir.id, { gate_cmd });
      toast(msg);
      close();
      render();
    } catch (e) { toast(e.message, true); btn.disabled = false; }
  };
  save.addEventListener("click", () => patch(save, ta.value, "gate command updated"));
  useDefault.addEventListener("click", () => patch(useDefault, null, "reverted to the default gate"));
}

// ---------- new-task modal ----------
// Inline modal for creating a task, redesigned for LOW-EFFORT creation. The default
// surface is just: a one-line IDEA (with an Expand button) or a template → the prompt
// textarea → Create. The operator gives ideas, not full specs, so "Expand" runs a
// headless read-only claude over the repo (POST /api/expand-brief) to turn the idea
// into a proper, grounded task prompt dropped into the textarea for review/edit. The
// manual "write your own prompt" path and the template dropdown both still work.
//
// The five less-common knobs (blocked_by, model, tags, priority, plan / plan-preview)
// are collapsed behind an "Advanced" disclosure (closed by default). Context is
// intentionally left empty (the agent reads files itself). Submits to the existing
// create endpoint; the new task surfaces via the SSE-driven re-render.
function openNewTaskModal(directoryId) {
  const body = el("div", { class: "m-body" });
  body.innerHTML = `
    <label class="field" style="margin-bottom:8px">
      <span class="lbl">idea — a one-line brief; Expand grounds it in the repo into a full prompt</span>
      <div class="row" style="gap:8px; align-items:stretch">
        <input type="text" id="nt-brief" placeholder="e.g. add a dark-mode toggle to the header" style="flex:1" />
        <button type="button" class="btn ghost" id="nt-expand" style="white-space:nowrap">Expand ✨</button>
      </div>
      <span class="hint" id="nt-brief-hint"></span>
    </label>
    <label class="field" style="margin-bottom:8px">
      <span class="lbl">template (optional) — fills the prompt with a recipe to complete</span>
      <select id="nt-template"><option value="">— none (write your own prompt) —</option></select>
      <span class="hint" id="nt-tpl-hint"></span>
    </label>
    <label class="field">
      <span class="lbl">prompt</span>
      <textarea id="nt-prompt" placeholder="Describe the work for the agent — or type an idea above and Expand it…"></textarea>
    </label>
    <div class="adv" id="nt-adv">
      <button type="button" class="adv-head" id="nt-adv-head"><span class="caret">▸</span><span>Advanced</span></button>
      <div class="adv-body" id="nt-adv-body">
        <label class="field" style="margin-bottom:0">
          <span class="lbl">blocked by (optional) — comma-separated task ids</span>
          <input type="text" id="nt-blocked" placeholder="e.g. snug-crag-ffae, wise-crag-b403" />
        </label>
        <label class="field" style="margin-bottom:0">
          <span class="lbl">model (optional) — blank uses the default</span>
          <input type="text" id="nt-model" placeholder="e.g. opus, sonnet, haiku, or claude-opus-4-8" />
        </label>
        <label class="field" style="margin-bottom:0">
          <span class="lbl">tags (optional) — comma-separated labels for organizing/filtering</span>
          <input type="text" id="nt-tags" placeholder="e.g. webapp, core, docs" />
        </label>
        <label class="field" style="margin-bottom:0">
          <span class="lbl">priority (optional) — higher dispatches sooner; default 0</span>
          <input type="number" step="1" id="nt-priority" placeholder="0" />
        </label>
        <label class="field check-field" style="margin-bottom:0; flex-direction:row; align-items:center; gap:8px">
          <input type="checkbox" id="nt-plan" />
          <span class="lbl" style="margin:0">Plan task — writes no code; decomposes the request into sub-tasks (wired by dependency)</span>
        </label>
        <label class="field check-field" style="margin-bottom:0; flex-direction:row; align-items:center; gap:8px">
          <input type="checkbox" id="nt-plan-preview" />
          <span class="lbl" style="margin:0">Plan-preview — the agent proposes a plan and pauses for your approval before writing code</span>
        </label>
        <label class="field check-field" style="margin-bottom:0; flex-direction:row; align-items:center; gap:8px">
          <input type="checkbox" id="nt-idea" />
          <span class="lbl" style="margin:0">New Idea — submit the one-line idea above as-is; butchr drafts the spec automatically (CTO-fork) and queues it as ready (no Expand or prompt needed)</span>
        </label>
      </div>
    </div>`;

  const foot = el("div", { class: "m-foot" });
  const errEl = el("span", { class: "m-error hint" }, "");
  const cancel = el("button", { class: "btn ghost" }, "Cancel");
  const create = el("button", { class: "btn" }, "Create task");
  foot.appendChild(errEl);
  foot.appendChild(cancel);
  foot.appendChild(create);

  const { close } = openModal({ title: "New task", body, footer: foot });
  cancel.addEventListener("click", close);

  // Advanced disclosure — collapsed by default so the default modal is just
  // idea/template → prompt → Create.
  const advEl = body.querySelector("#nt-adv");
  const advHead = body.querySelector("#nt-adv-head");
  advHead.addEventListener("click", () => {
    const open = advEl.classList.toggle("open");
    advHead.querySelector(".caret").textContent = open ? "▾" : "▸";
  });

  const briefEl = body.querySelector("#nt-brief");
  const expandBtn = body.querySelector("#nt-expand");
  const briefHintEl = body.querySelector("#nt-brief-hint");
  const promptEl = body.querySelector("#nt-prompt");
  const blockedEl = body.querySelector("#nt-blocked");
  const modelEl = body.querySelector("#nt-model");
  const tagsEl = body.querySelector("#nt-tags");
  const priorityEl = body.querySelector("#nt-priority");
  const planEl = body.querySelector("#nt-plan");
  const planPreviewEl = body.querySelector("#nt-plan-preview");
  const ideaEl = body.querySelector("#nt-idea");
  const tplEl = body.querySelector("#nt-template");
  const tplHintEl = body.querySelector("#nt-tpl-hint");
  // The idea box is the primary low-effort entry point, so start focus there.
  briefEl.focus();

  function showBriefHint(msg, isErr) {
    briefHintEl.textContent = msg || "";
    briefHintEl.classList.toggle("err", !!isErr);
  }

  // BRIEF → EXPAND. Turn the one-line idea into a proper, repo-grounded task prompt via
  // the headless read-only claude behind POST /api/expand-brief, then drop the result
  // into the prompt textarea for the operator to review/edit. A spinner runs while it
  // works; on error the brief is left intact with a message so the operator can retry
  // or just write the prompt by hand.
  async function expand() {
    const brief = briefEl.value.trim();
    if (!brief) { showBriefHint("Type a one-line idea first.", true); briefEl.focus(); return; }
    const prior = expandBtn.textContent;
    expandBtn.disabled = true; expandBtn.classList.add("loading");
    expandBtn.textContent = "Expanding…";
    showBriefHint("Reading the repo and drafting a prompt…");
    try {
      const r = await api("POST", "/expand-brief", { brief, directory: directoryId });
      promptEl.value = r.prompt || "";
      showBriefHint("Expanded — review and edit the prompt below, then Create.");
      promptEl.focus();
    } catch (e) {
      showBriefHint(e.message || "could not expand the brief", true);
    } finally {
      expandBtn.disabled = false; expandBtn.classList.remove("loading");
      expandBtn.textContent = prior;
    }
  }
  expandBtn.addEventListener("click", expand);
  // Enter in the single-line idea box expands (rather than submitting nothing).
  briefEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); expand(); }
  });

  // Load the built-in templates and populate the picker. Selecting one fills the
  // prompt textarea with its body (placeholders intact) so the operator completes
  // the {{markers}} inline — the form still submits a plain prompt to the create
  // endpoint, so no template field crosses the wire from the webapp.
  let templates = [];
  api("GET", "/templates")
    .then((list) => {
      templates = Array.isArray(list) ? list : [];
      for (const t of templates) {
        tplEl.appendChild(el("option", { value: t.name }, `${t.name} — ${t.description}`));
      }
    })
    .catch(() => { /* templates are optional — leave the picker empty on failure */ });

  tplEl.addEventListener("change", () => {
    const t = templates.find((x) => x.name === tplEl.value);
    if (!t) { tplHintEl.textContent = ""; return; }
    promptEl.value = t.body;
    tplHintEl.textContent = t.placeholders.length
      ? `Fill in: ${t.placeholders.map((p) => "{{" + p + "}}").join(", ")}`
      : "";
    promptEl.focus();
  });

  function showErr(msg) { errEl.textContent = msg || ""; errEl.classList.toggle("on", !!msg); }

  create.addEventListener("click", async () => {
    // NEW IDEA mode: the one-line idea box IS the submission (the operator gives a brief,
    // not a spec). butchr's CTO-fork drafts the spec automatically, so neither Expand nor
    // a full prompt is required — fall back to the prompt textarea only if the idea box is
    // empty. Normal mode requires the prompt textarea as before.
    const idea = ideaEl.checked;
    const brief = briefEl.value.trim();
    const prompt = idea ? (brief || promptEl.value.trim()) : promptEl.value.trim();
    if (!prompt) {
      if (idea) { showErr("Type a one-line idea above first."); briefEl.focus(); }
      else { showErr("Prompt is required."); promptEl.focus(); }
      return;
    }
    // Split the comma-separated blocker list into trimmed, non-empty ids.
    const blocked_by = blockedEl.value.split(",").map((s) => s.trim()).filter(Boolean);
    // plan / plan-preview don't apply to an idea task (its first step is spec generation,
    // not a build agent), so force them off in idea mode.
    const kind = (!idea && planEl.checked) ? "plan" : "task";
    // Optional plan-preview gate — the agent proposes a plan and pauses for approval
    // before writing code. Mutually independent of a plan task; ignored for one (a
    // plan task writes no code, so there is nothing to gate).
    const plan_preview = !idea && planPreviewEl.checked;
    // Optional model — omit when blank so the backend defaults it.
    const model = modelEl.value.trim() || null;
    // Optional tags — split the comma-separated list into trimmed, non-empty labels
    // (the backend de-dupes + validates).
    const tags = tagsEl.value.split(",").map((s) => s.trim()).filter(Boolean);
    // Optional priority — higher dispatches sooner; blank defaults to 0. Reject a
    // non-integer here so the operator gets immediate feedback (the server also
    // re-validates).
    const priorityRaw = priorityEl.value.trim();
    let priority = 0;
    if (priorityRaw) {
      priority = Number(priorityRaw);
      if (!Number.isInteger(priority)) { showErr("Priority must be an integer."); priorityEl.focus(); return; }
    }
    showErr("");
    create.disabled = true; cancel.disabled = true;
    try {
      await api("POST", "/directories/" + directoryId + "/tasks", { prompt, blocked_by, kind, model, tags, priority, plan_preview, idea });
      toast(idea ? "idea created" : kind === "plan" ? "plan task created" : plan_preview ? "plan-preview task created" : "task created");
      close();
      render();
    } catch (e) {
      showErr(e.message || "could not create task");
      create.disabled = false; cancel.disabled = false;
    }
  });
}

function queueLine(tasks) {
  const idea = tasks.filter((t) => t.status === "idea").length;
  const specRev = tasks.filter((t) => t.status === "spec_review").length;
  const b = tasks.filter((t) => t.status === "blocked").length;
  const ni = tasks.filter((t) => t.status === "needs_info").length;
  const r = tasks.filter((t) => t.status === "in_progress" && !t.idle).length;
  const i = tasks.filter((t) => t.status === "in_progress" && t.idle).length;
  const inRev = tasks.filter((t) => t.status === "in_review").length;
  const f = tasks.filter((t) => t.status === "finalizing").length;
  const parts = [];
  if (r) parts.push(`${r} in progress`);
  if (i) parts.push(`${i} idle`);
  if (f) parts.push(`${f} finalizing`);
  if (inRev) parts.push(`${inRev} in review`);
  if (specRev) parts.push(`${specRev} spec review`);
  if (ni) parts.push(`${ni} needs info`);
  if (b) parts.push(`${b} blocked`);
  if (idea) parts.push(`${idea} idea`);
  return parts.length ? parts.join(", ") + "." : "Idle.";
}

// Lifecycle statuses still in flight — these stay in the main directory list.
// Everything else (merged, aborted) is terminal and lives in History.
// `blocked` is pre-dispatch waiting work, so it groups with the active tasks.
const ACTIVE_STATUSES = ["idea", "spec_review", "blocked", "needs_info", "in_progress", "in_review", "finalizing"];
// The ONLY two terminal idle states — these are what belongs in the collapsible
// "Finished" section. Everything NOT in this allowlist is non-terminal and stays
// VISIBLE in the active list: the feedback states awaiting the operator
// (spec_review / in_review / needs_info) AND any legacy/non-canonical status a row
// may still carry (e.g. `failed` / `rejected`, which historically backed a revert
// or dispatch give-up). Defining Finished by an explicit allowlist — rather than as
// the complement of ACTIVE_STATUSES — guarantees a needs-attention task can never be
// hidden under Finished just because its status isn't in the active list.
const TERMINAL_STATUSES = ["merged", "aborted"];
const HISTORY_KEY = "butchr-history-open";

// Directory page body mode: the task "List", the pipeline "Board", or the
// dependency "Graph". Kept at module scope (and mirrored to localStorage) so it
// survives the full re-render the app does on every SSE event and across reloads.
const DIRVIEW_KEY = "butchr-dirview";
let dirView = (() => {
  try {
    const v = localStorage.getItem(DIRVIEW_KEY);
    return v === "graph" || v === "board" ? v : "list";
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
// re-render render() performs on every SSE event without being torn down. The
// statuses here are the *effective* statuses (effStatus), so `idle` and
// `running` filter independently, as do all terminal states.
const FILTER_STATUSES = ["idea", "spec_review", "blocked", "needs_info", "in_progress", "idle", "in_review", "finalizing", "merged", "aborted"];
// taskSearch is the FULL-TEXT query, applied SERVER-SIDE via `?q=` on the task-list
// endpoint — it matches a task's prompt (which lives in task.md and is NOT shipped
// to the client), summary, review notes, and id. So the search runs on the server
// and the directory list is re-fetched as you type (debounced); the status/tag
// filters below still run client-side over whatever the server returned.
let taskSearch = "";          // full-text query (server-side ?q=)
let statusFilter = new Set(); // selected effStatus values; empty = all
let tagFilter = new Set();    // selected tags; empty = all (ANY-match when non-empty)

// The `?q=` query-string fragment for the current search (empty when not searching),
// appended to every directory task-list fetch so the active search persists across
// SSE-driven re-renders.
function searchParam() {
  const q = taskSearch.trim();
  return q ? "?q=" + encodeURIComponent(q) : "";
}

function filterActive() {
  return taskSearch.trim() !== "" || statusFilter.size > 0 || tagFilter.size > 0;
}
// Client-side filter applied ON TOP of the server's full-text `?q=` result: the
// status chips and tag chips. The text search itself is NOT re-checked here — the
// server already narrowed the list by prompt/summary/notes/id, which the client
// can't reproduce (it never receives the prompt bodies).
function taskMatchesFilter(t) {
  if (statusFilter.size && !statusFilter.has(effStatus(t))) return false;
  // Tag filter is ANY-match: keep a task if it carries at least one selected tag.
  if (tagFilter.size) {
    const tags = Array.isArray(t.tags) ? t.tags : [];
    if (!tags.some((g) => tagFilter.has(g))) return false;
  }
  return true;
}

// The distinct set of tags across the directory's tasks, sorted, for the filter bar.
function allTags(tasks) {
  const set = new Set();
  for (const t of tasks) for (const g of (Array.isArray(t.tags) ? t.tags : [])) set.add(g);
  return [...set].sort();
}

// The filter bar: a full-text search box plus a row of toggleable status chips
// (reusing the existing .chip color styling, dimmed when inactive). The search box
// drives the SERVER-SIDE `?q=` filter — typing re-fetches the directory's task list
// (debounced) and repaints ONLY the results region, so the bar (and the focused
// search input) stay put and live-as-you-type works. The status/tag chip handlers
// mutate the module-level filter state and re-filter the last-fetched set client-side.
function buildFilterBar(dirId, tasks, results) {
  const bar = el("div", { class: "filter-bar" });

  // The most recently fetched (server-filtered) task set the chips filter over.
  // Starts as the list `tasks` painted with; a search re-fetch replaces it.
  let currentTasks = tasks;

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
        currentTasks = await api("GET", "/directories/" + dirId + "/tasks" + searchParam());
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

  // Second chip row: one toggleable chip per distinct tag in this directory (ANY
  // match). Only shown when the directory has any tagged tasks. A stale selection
  // (a tag whose last task left the set) is harmlessly ignored — it just matches
  // nothing — and is dropped here so the bar reflects the live tag universe.
  const tags = allTags(tasks);
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

// Render the active table + Finished section into `container`, applying the
// current filter. Called on first paint and on every search/chip change. When a
// filter is active, the Finished section auto-expands if it has matches and its
// count shows "matches of total" so it's clear the view is filtered.
function renderResults(tasks, container) {
  container.innerHTML = "";
  const filtering = filterActive();
  // Finished holds ONLY terminal idle states (merged/aborted); everything else —
  // including the feedback states awaiting the operator and any legacy `failed` /
  // `rejected` row — stays in the visible active table so it's never hidden.
  const active = tasks.filter((t) => !TERMINAL_STATUSES.includes(t.status));
  const history = tasks.filter((t) => TERMINAL_STATUSES.includes(t.status));
  const activeMatch = active.filter(taskMatchesFilter);
  const historyMatch = history.filter(taskMatchesFilter);

  container.appendChild(el("h2", {}, "Tasks"));
  if (tasks.length === 0) {
    container.appendChild(el("div", { class: "empty" }, "No tasks yet."));
  } else if (activeMatch.length === 0) {
    container.appendChild(el("div", { class: "empty" },
      filtering ? "No active tasks match the filter." : "No active tasks."));
  } else {
    container.appendChild(tasksTable(activeMatch));
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

// Compact one-line-per-task list for finished (terminal) tasks: id, final status
// chip, and when it completed. Most-recent first. Each row links to the full task
// detail; no live/terminal affordances (these tasks have no live pane).
function finishedList(tasks) {
  const sorted = tasks.slice().sort((a, b) =>
    new Date(finishedTime(b) || 0).getTime() - new Date(finishedTime(a) || 0).getTime());
  const list = el("div", { class: "finished-list" });
  for (const t of sorted) {
    const row = el("a", { class: "finished-row", href: "#/task/" + esc(t.id) });
    row.innerHTML = `
      <span class="fr-id">${esc(t.id)}</span>
      ${taskChips(t)}${tagChips(t)}
      <span class="fr-when" title="${esc(finishedTime(t) || "")}">${esc(fmtTime(finishedTime(t)))}</span>`;
    list.appendChild(row);
  }
  return list;
}

function tasksTable(tasks) {
  const table = el("table", { class: "tasks" });
  table.innerHTML = `<thead><tr>
    <th>id</th><th>status</th><th>created</th><th></th>
  </tr></thead>`;
  const tb = el("tbody");
  for (const t of tasks) {
    const tr = el("tr");
    const action = t.status === "in_review" ? "review →"
      : t.status === "spec_review" ? "review spec →"
      : t.status === "needs_info" ? "answer →" : "open →";
    const termLink = isLive(t)
      ? `<a href="#" class="term-link" data-id="${esc(t.id)}">⌗ terminal</a> · ` : "";
    // Feedback states are awaiting the operator — surface the state-kind chip
    // (e.g. "feedback: diff review") so a row that needs a human reads at a glance,
    // rather than just sitting in the list looking like in-flight work.
    const feedback = stateKind(effStatus(t)) === "feedback";
    tr.innerHTML = `
      <td class="id">${esc(t.id)}${pulseMarkup(t)}</td>
      <td>${taskChips(t, { kind: feedback })}${tagChips(t)}</td>
      <td class="when">${esc(fmtTime(t.created_at))}</td>
      <td>${termLink}<a href="#/task/${esc(t.id)}">${action}</a>${
        herdrIds(t) ? `<div class="herdr-ids-row">${herdrIds(t)}</div>` : ""}</td>`;
    const tl = tr.querySelector(".term-link");
    if (tl) tl.addEventListener("click", (ev) => { ev.preventDefault(); openTaskTerminal(t.id); });
    tb.appendChild(tr);
  }
  table.appendChild(tb);
  return table;
}

// List / Board / Graph segmented toggle for the directory body. Mutates dirView
// (module scope + localStorage) and calls repaint() to swap the body region — the
// toggle node itself is left in place so the choice sticks across clicks. The
// directory view re-renders wholesale on every SSE event and reads dirView, so the
// chosen mode also survives live updates without re-wiring anything.
function buildViewToggle(repaint) {
  const bar = el("div", { class: "view-toggle", role: "tablist", "aria-label": "Task view" });
  const defs = [["list", "List"], ["board", "Board"], ["graph", "Graph"]];
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
// that list it in their blocked_by]. Used to walk a plan's sub-task graph the
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
  const isActive = (t) => t && ACTIVE_STATUSES.includes(t.status);
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

// Draw a DAG of the directory's non-terminal tasks and their blockers: nodes are
// tasks (label = id, colored by effective status), edges are blocker→blocked
// arrows pointing left→right across topological levels. Inline SVG, no library.
// Clicking a node opens its task detail. Re-rendered wholesale on each SSE event
// by the directory view, so it live-updates for free.
//
// The active/in-flight tasks (the "tip") always render; how much of the FINISHED
// dependency history behind them shows is controlled by a generations slider (see
// finishedGenerations + buildGraphGenSlider) so deep merge trains stay readable.
function renderGraph(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const active = tasks.filter((t) => ACTIVE_STATUSES.includes(t.status));
  // Reversed edges over the WHOLE list (not just the graphed subset) so a node's
  // sub-tree progress counts dependents that have already merged off the graph.
  const dependentsOf = reverseDeps(tasks);

  if (active.length === 0) {
    return el("div", { class: "empty" }, "No active tasks to graph.");
  }

  // Finished-task generations back from the active tip, and the deepest one present.
  const gen = finishedGenerations(tasks);
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

  // edges first so nodes paint on top of them
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
    const g = svg("g", {
      class: "tg-node " + st, transform: `translate(${p.x},${p.y})`,
      tabindex: "0", role: "link", "aria-label": `${id} — ${st}${prog}`,
    });
    g.appendChild(svg("title", {}, `${id} · ${st}${t.kind === "plan" ? " · plan" : ""}${prog}`));
    g.appendChild(svg("rect", { class: "tg-rect", width: NW, height: NH, rx: 6, ry: 6 }));
    g.appendChild(svg("text", { class: "tg-id", x: NW / 2, y: idY }, id));
    g.appendChild(svg("text", { class: "tg-status", x: NW / 2, y: stY },
      st + (t.kind === "plan" ? " · plan" : "")));
    if (subTotal) {
      const bw = NW - 16;
      g.appendChild(svg("rect", { class: "tg-prog-track", x: 8, y: NH - 5, width: bw, height: 3, rx: 1.5 }));
      g.appendChild(svg("rect", {
        class: "tg-prog-fill", x: 8, y: NH - 5, height: 3, rx: 1.5,
        width: Math.round((bw * subMerged) / subTotal),
      }));
    }
    const go = () => { location.hash = "#/task/" + id; };
    g.addEventListener("click", go);
    g.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); go(); }
    });
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
// The board view: the directory's active (in-flight) tasks grouped into lanes in
// pipeline order — closest-to-landing first — so "what's happening / what's next"
// reads at a glance. Lanes: Ready to merge (review) · Merging (finalizing, only
// when present) · In progress (running/idle) · Blocked (each card shows the
// blockers it's waiting on and their current status) · Queued. Blocked (the
// planned upcoming work) reads before the ready-to-dispatch Queued lane.
// Terminal-state tasks
// (merged/aborted/rejected/failed) aren't part of the pipeline and are omitted —
// they live in the List view's Finished section. Re-rendered wholesale on every
// SSE event by the directory view, so it live-updates for free.
const BOARD_LANES = [
  { key: "spec_review", title: "Spec review", hint: "spec review", match: (t) => t.status === "spec_review" },
  { key: "in_review", title: "In review", hint: "in review", match: (t) => t.status === "in_review" },
  { key: "needs_info", title: "Needs info", hint: "needs info", match: (t) => t.status === "needs_info" },
  { key: "finalizing", title: "Finalizing", hint: "finalizing", match: (t) => t.status === "finalizing" },
  { key: "in_progress", title: "In progress", hint: "in progress", match: (t) => t.status === "in_progress" },
  { key: "blocked", title: "Blocked", hint: "blocked", match: (t) => t.status === "blocked" },
  { key: "idea", title: "Idea", hint: "idea", match: (t) => t.status === "idea" },
];

function renderBoard(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const active = tasks.filter((t) => ACTIVE_STATUSES.includes(t.status));
  if (active.length === 0) {
    return el("div", { class: "empty" }, "No active tasks in the pipeline.");
  }

  // Oldest-first within a lane: the longest-waiting (review/queued) and the
  // earliest-started (running) bubble to the top — the next thing to act on.
  const byCreated = (a, b) =>
    new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime();

  // One-line "what's happening" caption from the populated lanes.
  const counts = BOARD_LANES.map((l) => ({ l, n: active.filter(l.match).length }));
  const summary = counts.filter((x) => x.n > 0).map((x) => `${x.n} ${x.l.hint}`);

  const board = el("div", { class: "board" });
  board.appendChild(el("div", { class: "board-summary muted" },
    summary.length ? summary.join(" · ") : "Idle."));

  for (const lane of BOARD_LANES) {
    const items = active.filter(lane.match).sort(byCreated);
    // Always render the five core lanes so the pipeline skeleton stays visible;
    // the finalizing and spec_review lanes only appear when something is present.
    if ((lane.key === "finalizing" || lane.key === "spec_review") && items.length === 0) continue;
    board.appendChild(boardLane(lane, items, byId));
  }
  return board;
}

// One lane: a header (title + count) over a responsive grid of task cards, with a
// status-colored left accent. Empty core lanes render a placeholder so the
// pipeline structure reads even when a stage is clear.
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
  for (const t of items) cards.appendChild(boardCard(t, lane, byId));
  sec.appendChild(cards);
  return sec;
}

// One task card: id (links to the detail page), status chip(s), created time, and
// a live-terminal link when the agent pane is up. Blocked cards additionally list
// each blocker with its current status — read from sibling tasks in this
// directory (a blocker not in this list shows as "unknown"). Aborted/rejected
// blockers will never merge, so they're flagged as stuck.
function boardCard(t, lane, byId) {
  const card = el("div", { class: "board-card" });
  const termLink = isLive(t)
    ? `<a href="#" class="term-link" data-id="${esc(t.id)}">⌗ terminal</a>` : "";
  card.innerHTML = `
    <div class="bc-top">
      <a class="bc-id" href="#/task/${esc(t.id)}">${esc(t.id)}</a>
      <span class="bc-chips">${taskChips(t, { plan: true })}</span>
    </div>
    <div class="bc-meta">
      <span class="bc-when" title="${esc(t.created_at || "")}">created ${esc(fmtTime(t.created_at))}</span>
      ${termLink ? `<span class="bc-term">${termLink}</span>` : ""}
    </div>
    ${tagChips(t) ? `<div class="bc-tags">${tagChips(t)}</div>` : ""}
    ${pulseMarkup(t)}`;

  if (lane.key === "blocked") {
    const ids = t.blocked_by || [];
    if (ids.length) {
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
  }

  const tl = card.querySelector(".term-link");
  if (tl) tl.addEventListener("click", (ev) => { ev.preventDefault(); openTaskTerminal(t.id); });
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
// GET /api/tasks/:id/events. Returns null when there are no recorded events.
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
function fmtEstimate(est) {
  if (!est) return "—";
  if (est.insufficient) {
    return `insufficient data <span class="muted">· not enough history yet</span>`;
  }
  const r = est.toMerge || est.toReview;
  if (!r) return `insufficient data <span class="muted">· not enough history yet</span>`;
  const label = est.toMerge ? "to merge" : "to review";
  const bucket = est.basis === "overall" ? "all tasks" : `${est.bucket} ${est.basis}`;
  return `est ~${fmtDuration(r.p50Ms)}–${fmtDuration(r.p90Ms)} `
    + `<span class="muted">· ${label} · n=${est.n} · ${esc(bucket)} · rough</span>`;
}

// Critical-path estimate across a task's dependency chain (a plan's sub-tasks, or a
// blocked task's blockers). Returns null when there's nothing pending to chain.
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
        `/tasks/${id}/transcript?offset=${offset}&limit=${TRANSCRIPT_PAGE}`);
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
// blocked_by, e.g. the children a plan decomposed into), summarize how far the
// dependent sub-tree has landed. Walks the reversed edges of the directory's task
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

// Render the sub-task progress rollup panel: "N/M merged", a progress bar, and the
// direct dependents with their live statuses (so a plan's progress reads at a
// glance). Live-updates for free — the task page re-renders on every SSE event.
// Returns null when there's nothing to roll up.
function rollupPanel(rollup) {
  if (!rollup) return null;
  const { direct, total, merged } = rollup;
  const pct = total ? Math.round((merged / total) * 100) : 0;
  const panel = el("div", { class: "panel rollup-panel" });
  panel.appendChild(el("h2", { style: "margin-top:0" }, "Sub-task progress"));
  panel.appendChild(el("div", { class: "rollup-summary" }, [
    el("span", { class: "rollup-frac" }, `${merged}/${total} merged`),
    el("span", { class: "rollup-pct muted" }, `${pct}%`),
  ]));
  panel.appendChild(el("div", { class: "rollup-bar", role: "progressbar",
    "aria-valuenow": String(merged), "aria-valuemin": "0", "aria-valuemax": String(total) }, [
    el("div", { class: "rollup-bar-fill", style: `width:${pct}%` }),
  ]));
  const nested = total - direct.length;
  if (nested > 0) {
    panel.appendChild(el("div", { class: "rollup-nested muted" },
      `${direct.length} direct · +${nested} nested sub-task${nested === 1 ? "" : "s"}`));
  }
  const list = el("div", { class: "blockers" });
  for (const c of direct) {
    const row = el("div", { class: "blocker-row" });
    row.innerHTML = `<a class="bk-id" href="#/task/${esc(c.id)}">${esc(c.id)}</a>${chip(effStatus(c))}`;
    list.appendChild(row);
  }
  panel.appendChild(list);
  return panel;
}

async function renderTask(id) {
  const t = await api("GET", "/tasks/" + id);
  const dirs = await api("GET", "/directories");
  const dir = dirs.find((x) => x.id === t.directory_id);

  const wrap = el("div");
  wrap.appendChild(el("div", {
    class: "crumbs",
    html: `<a href="#/">Directories</a> / <a href="#/dir/${esc(t.directory_id)}">${esc(dir ? (dir.label || dir.path) : t.directory_id)}</a> / ${esc(t.id)}`,
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
  // Abort is available from any non-terminal state. Terminal states are merged/aborted.
  // finalizing is an agent state (still in flight) — it IS abortable.
  const canAbort = !["merged", "aborted"].includes(t.status);
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

  // metadata
  const meta = el("div", { class: "panel" });
  meta.innerHTML = `<div class="meta-grid">
    <div class="k">status</div><div class="v">${esc(effStatus(t))}</div>
    ${Array.isArray(t.tags) && t.tags.length ? `<div class="k">tags</div><div class="v">${tagChips(t)}</div>` : ""}
    <div class="k">priority</div><div class="v">${esc(String(t.priority ?? 0))}</div>
    <div class="k">created</div><div class="v">${esc(t.created_at || "—")}</div>
    <div class="k">started</div><div class="v">${esc(t.started_at || "—")}</div>
    <div class="k">completed</div><div class="v">${esc(t.completed_at || "—")}</div>
    <div class="k">merged</div><div class="v">${esc(t.merged_at || "—")}</div>
    ${t.estimate ? `<div class="k">est. duration</div><div class="v">${fmtEstimate(t.estimate)}</div>` : ""}
    <div class="k">model</div><div class="v">${esc(modelLabel(t))}</div>
    <div class="k">tokens</div><div class="v">${tokensLabel(t)}</div>
    <div class="k">cost</div><div class="v">${esc(costLabel(t))}</div>
    ${t.herdr_pane_id ? `<div class="k">herdr pane</div><div class="v">${esc(t.herdr_pane_id)}</div>` : ""}
    ${t.herdr_tab_id ? `<div class="k">herdr tab</div><div class="v">${esc(t.herdr_tab_id)}</div>` : ""}
  </div>`;
  wrap.appendChild(meta);

  // Rough critical-path estimate across this task's dependency chain (plan
  // sub-tasks, or a blocked task's blockers). Best-effort — a fetch failure or a
  // null chain just omits the line. The task's OWN estimate already rides on
  // t.estimate (shown in the meta grid above).
  const estData = await api("GET", "/tasks/" + id + "/estimate").catch(() => null);
  const chainLine = estData ? fmtChain(estData.chain) : null;

  // audit timeline — the task's status-transition history (best-effort: a fetch
  // failure just omits the panel rather than breaking the detail view).
  const events = await api("GET", "/tasks/" + id + "/events").catch(() => []);
  const timeline = renderTimeline(events);
  if (timeline) wrap.appendChild(timeline);

  // blocked-by — what this task is waiting on. Shown whenever the task has a
  // dependency set, with each blocker's current status; dead blockers (terminal,
  // never-merging) are flagged so a stuck `blocked` task is obvious. The list of
  // blocker statuses comes back on the task view (blockerStates), computed below.
  if (Array.isArray(t.blocked_by) && t.blocked_by.length) {
    const dead = new Set(t.deadBlockers || []);
    const panel = el("div", { class: "panel blocked-panel" });
    const head = t.status === "blocked"
      ? "Blocked — waiting on:"
      : "Depends on:";
    panel.appendChild(el("h2", { style: "margin-top:0" }, head));
    if (chainLine) panel.appendChild(el("div", { class: "chain-est", html: chainLine }));
    const list = el("div", { class: "blockers" });
    for (const bid of t.blocked_by) {
      const st = (t.blockerStates && t.blockerStates[bid]) || "unknown";
      const isDead = dead.has(bid);
      const row = el("div", { class: "blocker-row" + (isDead ? " dead" : "") });
      row.innerHTML = `
        <a class="bk-id" href="#/task/${esc(bid)}">${esc(bid)}</a>
        ${chip(st)}
        ${isDead ? '<span class="bk-dead">will never merge — edit blocked_by to proceed</span>' : ""}`;
      list.appendChild(row);
    }
    panel.appendChild(list);
    wrap.appendChild(panel);
  }

  // spawned sub-tasks — a PLAN task records the sub-tasks it decomposed the request
  // into (see propose_subtasks). Surface them with links so the operator can follow
  // the decomposition. Shown whenever the task spawned any.
  if (Array.isArray(t.spawned_subtasks) && t.spawned_subtasks.length) {
    const panel = el("div", { class: "panel spawned-panel" });
    panel.appendChild(el("h2", { style: "margin-top:0" },
      `Spawned ${t.spawned_subtasks.length} sub-task${t.spawned_subtasks.length === 1 ? "" : "s"}`));
    if (chainLine) panel.appendChild(el("div", { class: "chain-est", html: chainLine }));
    const list = el("div", { class: "blockers" });
    for (const sid of t.spawned_subtasks) {
      const row = el("div", { class: "blocker-row" });
      row.innerHTML = `<a class="bk-id" href="#/task/${esc(sid)}">${esc(sid)}</a>`;
      list.appendChild(row);
    }
    panel.appendChild(list);
    wrap.appendChild(panel);
  }

  // sub-task progress rollup — if this task GATES others (its id is in their
  // blocked_by), summarize how far the dependent sub-tree has merged: a fraction, a
  // progress bar, and the direct children with their statuses. Computed purely
  // client-side from the directory's task list (no extra API field); best-effort —
  // a fetch failure just omits the panel — and nothing renders for a task with no
  // dependents. Re-fetched on each render so it live-updates via the SSE re-render.
  const siblings = await api("GET", "/directories/" + t.directory_id + "/tasks").catch(() => null);
  const rollup = siblings ? dependentRollup(t.id, siblings) : null;
  if (rollup) wrap.appendChild(rollupPanel(rollup));

  // prompt
  wrap.appendChild(el("h2", {}, "Prompt"));
  wrap.appendChild(el("pre", { class: "block", html: esc(t.prompt || "—") }));

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
  if (hasLivePane(t)) {
    if (liveOutputCacheId !== t.id) { liveOutputCache = ""; liveOutputCacheId = t.id; }
    const pre = el("pre", { class: "block live-output-body" },
      liveOutputCache || "loading recent output…");

    const poll = async () => {
      try {
        const r = await api("GET", "/tasks/" + t.id + "/output");
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
  if (t.review_notes) {
    wrap.appendChild(el("h2", {}, "Review notes"));
    wrap.appendChild(el("pre", { class: "block", html: esc(t.review_notes) }));
  }

  // agent summary (from request_review)
  if (t.summary) {
    wrap.appendChild(el("h2", {}, "Agent summary"));
    wrap.appendChild(el("pre", { class: "block", html: esc(t.summary) }));
  }

  // output snapshot — on a merged task this is the agent's post-merge wrap-up
  // captured during the finalizing phase; otherwise the rescue snapshot.
  if (t.output_snapshot) {
    wrap.appendChild(el("h2", {}, t.status === "merged" ? "Agent wrap-up" : "Agent output (snapshot)"));
    wrap.appendChild(el("pre", { class: "block", html: esc(t.output_snapshot) }));
  }

  // agent transcript — a readable, lazily-fetched view of what the session's agent
  // actually did (prose, thinking, tool calls + truncated results). Collapsible and
  // read-only; only offered once the task has a session to read. The body is fetched
  // on first open (transcripts get large) and paged via a "Load more" button.
  if (t.session_id) wrap.appendChild(renderTranscriptPanel(t.id));

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

    wrap.appendChild(el("h2", {}, "Diff vs main"));
    const diffBox = el("div", { class: "diffview" }, [el("div", { class: "meta" }, "loading diff…")]);
    wrap.appendChild(diffBox);
    api("GET", "/tasks/" + id + "/diff")
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
    wrap.appendChild(controls);
  }

  // spec_review — the CEO agent generated a spec; operator approves to start the
  // workspace agent, or requests changes to revise the spec (back to idea).
  if (t.status === "spec_review") {
    const controls = el("div", { class: "panel", style: "margin-top:18px" });
    controls.innerHTML = `
      <h2 style="margin-top:0">Review spec</h2>
      <p class="muted" style="margin:0 0 10px">The CTO-fork agent has drafted a spec from the idea. Approve to dispatch the workspace agent, or request changes to revise the spec.</p>
      <label class="field" style="margin-bottom:6px">
        <span class="lbl">change request note (required if requesting changes)</span>
        <textarea id="rnote" placeholder="What needs to change in the spec?"></textarea>
      </label>
      <div class="row">
        <button class="btn success" id="approve">Approve spec</button>
        <button class="btn danger" id="reject">Request changes</button>
        <div class="spacer"></div>
      </div>`;
    wrap.appendChild(controls);
  }

  // needs_info answer box — the agent paused mid-task by calling the MCP `ask`
  // tool, so the task holds a pending question. Mirrors the review change-request
  // box: show the question, take an answer, and POST it. On answer butchr re-launches
  // the SAME agent session via `--resume` with the answer injected.
  if (t.status === "needs_info") {
    if (t.question) {
      wrap.appendChild(el("h2", {}, "Agent's question"));
      wrap.appendChild(el("pre", { class: "block", html: esc(t.question) }));
    }
    const answerPanel = el("div", { class: "panel", style: "margin-top:18px" });
    answerPanel.innerHTML = `
      <h2 style="margin-top:0">Answer</h2>
      <label class="field">
        <span class="lbl">your answer (required)</span>
        <textarea id="answer" placeholder="Answer the agent's question. It goes back to the same agent, which butchr re-launches in-context (--resume) to continue."></textarea>
      </label>
      <div class="row">
        <button class="btn success" id="sendAnswer">Send answer</button>
        <div class="spacer"></div>
      </div>`;
    wrap.appendChild(answerPanel);
  }

  mount(wrap);

  if (t.status === "aborted" && (t.revert_reason || t.last_dispatch_error)) {
    document.getElementById("requeue").addEventListener("click", (ev) => {
      action(ev.target, () => api("POST", "/tasks/" + id + "/requeue"), { success: "re-queued ✓" });
    });
  }

  if (canAbort) {
    document.getElementById("abort").addEventListener("click", (ev) => {
      const msg = t.status === "in_progress"
        ? "Abort this in-progress task? The agent is stopped and its worktree + branch are discarded without merging."
        : "Abort this task? Its worktree + branch are discarded without merging.";
      if (!confirm(msg)) return;
      action(ev.target, () => api("POST", "/tasks/" + id + "/abort"), { success: "task aborted" });
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
      // Create from the built-in `rollback` template via the normal create-task
      // flow: the server renders {{task}}/{{sha}} into the prompt (server.ts). Jump
      // to the new task so the operator can follow it through the pipeline.
      action(ev.target, async () => {
        const created = await api("POST", "/directories/" + t.directory_id + "/tasks", {
          template: "rollback",
          vars: { task: id, sha: t.merged_sha },
        });
        if (created && created.id) location.hash = "#/task/" + created.id;
      }, { success: "rollback task created ✓" });
    });
  }

  if (t.status === "in_review") {
    document.getElementById("approve").addEventListener("click", (ev) => {
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
      action(ev.target, async () => {
        const r = await api("POST", "/tasks/" + id + "/approve");
        // A merge conflict isn't an error — it's sent back to the live agent to
        // resolve in-context. The SSE refresh will show the task back in in_progress.
        if (r && r.conflictSentBack) {
          toast("Merge conflict — sent back to the agent to resolve");
        } else if (r && r.revertedOnRed) {
          toast("Merged but verify FAILED — auto-reverted off main", true);
        } else {
          toast("approved ✓ — merged, agent wrapping up");
        }
      }, { onDone: () => backToDirectory(t.directory_id) });
    });
    document.getElementById("reject").addEventListener("click", (ev) => {
      // The note sent to the agent is the freeform text plus any inline comments,
      // composed into one string (composeReviewNote). Either alone is enough to
      // request changes — so a reviewer can reject purely with per-line comments.
      const note = composeReviewNote(document.getElementById("rnote").value);
      if (!note) return toast("add a note or at least one inline comment", true);
      action(ev.target, () => api("POST", "/tasks/" + id + "/reject", { note }),
        { success: "changes requested", onDone: () => backToDirectory(t.directory_id) });
    });
  }

  if (t.status === "spec_review") {
    document.getElementById("approve").addEventListener("click", (ev) => {
      action(ev.target, async () => {
        await api("POST", "/tasks/" + id + "/approve");
        toast("spec approved ✓ — dispatching workspace agent");
      }, { onDone: () => backToDirectory(t.directory_id) });
    });
    document.getElementById("reject").addEventListener("click", (ev) => {
      const note = (document.getElementById("rnote").value || "").trim();
      if (!note) return toast("add a note describing what to change in the spec", true);
      action(ev.target, () => api("POST", "/tasks/" + id + "/reject", { note }),
        { success: "spec changes requested — revising", onDone: () => backToDirectory(t.directory_id) });
    });
  }

  if (t.status === "needs_info") {
    document.getElementById("sendAnswer").addEventListener("click", (ev) => {
      const answer = document.getElementById("answer").value.trim();
      if (!answer) return toast("an answer is required", true);
      action(ev.target, () => api("POST", "/tasks/" + id + "/answer", { answer }),
        { success: "answer sent — agent resuming", onDone: () => backToDirectory(t.directory_id) });
    });
  }
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
// Highlight the topbar nav link matching the current route. Directory/task pages
// fall under "Directories"; the Metrics page under "Metrics".
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
// directory cards highlight the review/failed counts). When permitted, a Web
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
updateAttention();
render();
connectSSE();
