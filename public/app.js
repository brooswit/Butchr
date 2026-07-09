// butchr webapp — vanilla JS single-page app. Hash-routed, SSE live updates.
"use strict";

// `core/` holds dependency-free leaves — nothing there imports this file. Each is DOM-free
// at module load, so `app` below remains the only top-level `document` access in the app.
//
// TERMINAL_STATUSES / FILTER_STATUSES / stateMetaLoaded are `export let`:
// applyStateMeta REASSIGNS them once /api/state-meta lands, and the ES live binding
// propagates that new value here. Read them at CALL time — never destructure them into a
// local const, which would snapshot the empty pre-load value and silently break every
// status chip.
import { el, esc, svg } from "./core/dom.js";
import { fmtBytes, fmtDuration, fmtPct, fmtTime } from "./core/format.js";
import { api, terminalToast, toast } from "./core/api.js";
import {
  FILTER_STATUSES,
  TERMINAL_STATUSES,
  loadStateMeta,
  stateMetaLoaded,
  statusLabel,
} from "./core/state-meta.js";
// `components/` holds the presentational leaves — DOM-free at load, importing only from
// `core/` and from each other. chips.js owns the CHIP + BADGE cluster (status/kind/tag/
// liveness pills); panel.js the collapsible scaffold + the containers and gate badges built
// on it; overlay.js the modal scaffold + the directory picker. Nothing under components/
// imports THIS file — that cycle is the one thing the split must never close, which is why
// action() (whose onDone defaults to render) stays below rather than moving to overlay.js.
import {
  chip,
  effStatus,
  feedbackStepLabel,
  kindBadge,
  livenessChip,
  tagChips,
  taskChips,
} from "./components/chips.js";
import {
  block,
  blockerRow,
  ciBadge,
  collapsible,
  conformanceBadge,
  listPanel,
  rollupPanel,
} from "./components/panel.js";
import { openModal, openPicker } from "./components/overlay.js";

const app = document.getElementById("app");

// The agent is live (attachable) whenever butchr owns a launched agent for it
// (has_agent): a running/idle `in_progress` build agent until butchr tears it down.
// Gating on has_agent mirrors the /terminal endpoint exactly — the button shows iff the
// attach would succeed. (Agents are addressed BY NAME; no pane id is stored.)
function isLive(t) {
  return !!t.has_agent;
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
    return el("div", { class: "panel cto-card stacked" },
      el("small", { class: "muted" }, "CTO agent status unavailable"));
  }
  const card = el("div", { class: "panel cto-card stacked" });
  const { state, cls: stateCls } = ctoState(s);
  const bits = [];
  if (s.sessionId) bits.push(`session ${esc(s.sessionId.slice(0, 8))}`);
  if (s.since) bits.push(`since ${fmtTime(s.since)}`);
  if (s.restarts) bits.push(`${s.restarts} restart${s.restarts === 1 ? "" : "s"}`);
  if (!s.enabled) bits.push("auto-start disabled");
  card.innerHTML = `
    <div class="row between">
      <div>
        <h2>${kindBadge("cto")} CTO agent <span class="cto-badge ${stateCls}">${state}</span></h2>
        <div class="meta">${bits.map(esc).join(" · ") || "not started"}</div>
        ${s.lastError ? `<div class="meta err">last error: ${esc(s.lastError)}</div>` : ""}
      </div>
      <div class="row cto-controls"></div>
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

// Owns the disable/try/restore/toast dance every action button repeats: disable
// `btn` (when present), run `fn` (typically an api() call), and on success toast
// `success` (a string, or a fn of fn's result) then run `onDone` (defaults to
// render()). On failure, toast the error and re-enable the button so it can be
// retried. The few buttons whose success message depends on the response toast
// inside `fn` themselves and pass no `success`. `btn` is optional — a caller with
// no button to disable (e.g. a term-link) passes none. Any pre-flight confirm()
// must run before calling action(), so a cancel never disables the button.
//
// This stays in app.js rather than moving to components/overlay.js with the modals:
// `onDone` DEFAULTS to render(), so the body closes over an app-level binding, and a
// components/ module that reached for it would import app.js — the one cycle the
// module split must not close. It is a BUTTON concern regardless (RFC D6: the missing
// Button component), and belongs in components/button.js once Phase 4 lands it.
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

// ---------- router ----------
function parseHash() {
  const hash = location.hash.replace(/^#/, "") || "/";
  const parts = hash.split("/").filter(Boolean);
  // LANDING = Projects (Hierarchical Projects IA S2): the default route now shows the
  // projects overview, not the workspace-card dashboard. renderDashboard() stays defined
  // (still the fallback for unknown hashes; its register form is retired in S4).
  if (parts.length === 0) return { name: "projects" };
  if (parts[0] === "metrics") return { name: "metrics" };
  // `#/projects` is the overview; `#/projects/:id` is a project's detail view; and the
  // NESTED `#/projects/:projectId/workspaces/:workspaceId` drills into a member repo's
  // workspace, reusing the SAME renderWorkspace view as the flat `#/workspace/:id` route
  // (the projectId is threaded through so the view knows its parent — S3 breadcrumbs).
  if (parts[0] === "projects") {
    if (parts[1] && parts[2] === "workspaces" && parts[3]) {
      return { name: "workspace", id: parts[3], projectId: parts[1] };
    }
    return parts[1] ? { name: "project", id: parts[1] } : { name: "projects" };
  }
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

// Map a flat workspace/repo id to the PROJECT that owns it, for the legacy `#/workspace/:wid`
// → `#/projects/:pid/workspaces/:wid` redirect (Hierarchical Projects IA S3). The repo IS a work
// node whose id === the workspace id, registered under a project via parent_id; there is no single
// "which project owns this repo" endpoint, so we scan the SAME REST surface the Projects overview
// uses: GET /api/projects, then each project's /repos in parallel. Returns the owning project id,
// or null when no project claims it (an un-adopted repo → caller renders it FLAT) or on any error
// (best-effort; never throws, so a hiccup just leaves the flat route in place).
async function projectIdForWorkspace(wid) {
  try {
    const projects = await api("GET", "/projects");
    const matches = await Promise.all((projects || []).map(async (p) => {
      try {
        const repos = await api("GET", "/projects/" + encodeURIComponent(p.id) + "/repos");
        return Array.isArray(repos) && repos.some((r) => r && r.id === wid) ? p.id : null;
      } catch (e) { return null; }
    }));
    return matches.find(Boolean) || null;
  } catch (e) {
    return null;
  }
}

let current = null;
async function render() {
  const route = parseHash();
  // CANONICALIZING REDIRECTS (Hierarchical Projects IA S3) — retire the flat top level by rewriting
  // legacy hashes to their hierarchical equivalents. REPLACE semantics (location.replace, not a
  // `location.hash =` push) so Back walks UP the hierarchy instead of landing on the old hash and
  // bouncing forward into the redirect again (a history trap). parseHash keeps a bare→projects arm
  // as a harmless belt; this makes the URL bar honest + deep-linkable.
  const rawHash = location.hash.replace(/^#/, "");
  if (rawHash === "" || rawHash === "/") {
    location.replace("#/projects"); // fires hashchange → render() re-runs on the canonical hash
    return;
  }
  // Any UNKNOWN hash falls to the legacy flat workspace-card dashboard (parseHash's fallback arm).
  // Retire that surface too (Hierarchical Projects IA S4): everything is reached project→workspace→
  // work now, so REPLACE-redirect it to the Projects overview (same semantics as the bare-hash arm).
  // renderDashboard/dirCard stay defined but are now unreachable — their loose-workspace register
  // form (the only front-end path that created a top-level workspace) was removed in this increment.
  if (route.name === "dashboard") {
    location.replace("#/projects");
    return;
  }
  // A FLAT `#/workspace/:wid` (no projectId) → the nested route, deriving the owning project from
  // the API. A repo not yet adopted by any project has no nested home → fall through and render it
  // flat (graceful; old bookmark still resolves).
  if (route.name === "workspace" && !route.projectId) {
    const pid = await projectIdForWorkspace(route.id);
    if (pid) {
      location.replace("#/projects/" + encodeURIComponent(pid) + "/workspaces/" + encodeURIComponent(route.id));
      return;
    }
  }
  current = route;
  stopLiveOutput();
  stopActivity();
  syncTopnav(route);
  try {
    if (route.name === "dashboard") await renderDashboard();
    else if (route.name === "metrics") await renderMetrics();
    else if (route.name === "projects") await renderProjects();
    else if (route.name === "project") await renderProjectDetail(route.id);
    else if (route.name === "workspace") await renderWorkspace(route.id, route.projectId);
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

  // NOTE (Hierarchical Projects IA S4): the global "Register a workspace" form was REMOVED here.
  // Loose/top-level workspaces no longer exist — a workspace is created only from inside a project
  // (renderProjectDetail → "+ Add workspace" → POST /api/projects/:id/workspaces). This view is now a
  // read-only rollup and, after S4's unknown-hash redirect, is unreachable dead code left in place.
  if (dirs.length === 0) {
    wrap.appendChild(el("div", { class: "empty" }, "No workspaces registered yet — add one from inside a project (Projects)."));
  } else {
    const grid = el("div", { class: "grid dirs" });
    for (const d of dirs) grid.appendChild(dirCard(d));
    wrap.appendChild(grid);
  }
  mount(wrap);
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
async function renderWorkspace(id, projectId) {
  // Pull the workspace from the dashboard rollup (it carries the effective gate
  // command + override state the gate panel needs) alongside its task list.
  const [dash, work] = await Promise.all([
    api("GET", "/dashboard"),
    // The UNIFIED work list for this workspace (leaf tasks + node stories — see workListPath).
    // Best-effort: a failure leaves both surfaces empty rather than blanking the page.
    api("GET", workListPath(id)).catch(() => []),
  ]);
  // The leaf (task) members of the leaf|node union — used only for the launcher's one-line
  // queue summary below (queueLine). The Pipeline view consumes the full union directly.
  const tasks = workLeaves(work);
  // Bound the long-lived module caches against this render's live work-id set (nodes + leaves),
  // dropping entries for work that has left the list so neither grows unbounded over a session:
  // the Pipeline view's expanded-done piles (keyed by story id) and the activity pulse cache.
  const liveWorkIds = new Set((Array.isArray(work) ? work : []).map((w) => w && w.id).filter(Boolean));
  pruneWorkCaches(liveWorkIds, SWIM_DONE_EXPANDED, activityCache);
  const dir = dash.workspaces.find((x) => x.id === id);
  if (!dir) return mount(el("div", { class: "empty" }, "workspace not found"));

  // When reached through the nested project route (`#/projects/:pid/workspaces/:wid`), resolve
  // the parent project's display name for the breadcrumb back-link. Best-effort and DERIVED FROM
  // THE URL's projectId (not click-set state) so a cold load / paste-the-URL / SSE re-render works
  // identically; a lookup miss falls back to the id so the crumb never blanks or crashes.
  let projectName = projectId;
  if (projectId) {
    try {
      const p = await api("GET", "/projects/" + encodeURIComponent(projectId));
      projectName = projectTitle(p) || projectId;
    } catch (e) { /* keep the id fallback */ }
  }

  const wrap = el("div");
  const crumbsHtml = projectId
    ? `<a href="#/projects">Projects</a> / <a href="#/projects/${esc(projectId)}">${esc(projectName)}</a> / <span aria-current="page">${esc(dir.label || dir.path)}</span>`
    : `<a href="#/projects">Projects</a> / <span aria-current="page">${esc(dir.label || dir.path)}</span>`;
  wrap.appendChild(el("div", { class: "crumbs", html: crumbsHtml }));
  wrap.appendChild(el("h1", {}, dir.label || dir.path));
  wrap.appendChild(el("div", { class: "path" }, dir.path));

  // This workspace's managed CTO agent (its principal/dev agent, running in the repo
  // root) — status + Start/Stop/Restart/Enable + Open-CTO-terminal, scoped to this
  // workspace. Rendered at the TOP of the workspace view (above the Pipeline) so the
  // operator reaches the CTO controls without scrolling past the swimlanes. Best-effort:
  // rendered async so a status-probe hiccup never blocks the page — the placeholder slot
  // appends synchronously and the panel swaps in once it resolves.
  const ctoSlot = el("div");
  wrap.appendChild(ctoSlot);
  ctoPanel(id).then((panel) => ctoSlot.replaceWith(panel)).catch(() => {});

  // create-work launcher (AUTHORITY FLIP, Phase 7) — the operator's entry point for new
  // work is now a STORY, not a standalone task. A single "New story" button opens the
  // brief modal (POST /api/workspaces/:id/work); a story leader then decomposes it into
  // subtasks. Standalone task + idea creation are gone (the server rejects them) — the only
  // task creatable directly is a rollback, via the per-task "Roll back" button.
  // Rendered UNDER the CTO panel (above the Pipeline) so the CTO controls stay at the top.
  const launch = el("div", { class: "row between stacked" });
  launch.appendChild(el("small", { class: "muted" },
    `New work is a STORY — a leader decomposes it into subtasks. ${queueLine(tasks)}`));
  const newStoryBtn = el("button", { class: "btn", id: "new-story" }, "New story");
  newStoryBtn.addEventListener("click", () => openNewStoryModal(id));
  launch.appendChild(newStoryBtn);
  wrap.appendChild(launch);

  // The workspace body is the Pipeline (swimlanes) view — the sole work view. It shows ALL
  // work (stories as lanes, their subtasks as the pipeline within each lane) and re-renders
  // wholesale on every SSE event, so it live-updates with no view-mode state to persist.
  const body = el("div", { class: "ws-body" });
  body.appendChild(el("h2", {}, "Pipeline"));
  body.appendChild(renderSwimlanes(work));
  wrap.appendChild(body);

  // (The gate is now the repo's own `./scripts/ci` — butchr carries zero gate config — so
  // there is no per-workspace gate-command panel here anymore.)
  // (Responder routing is now STRUCTURAL — per-task pending_responder, not per-workspace
  // config — so there is no step-responder config panel here anymore.)

  // danger zone
  const dz = el("div", { class: "row ws-danger-zone" });
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
    <label class="field tight">
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
// Story ids whose collapsed "N done" pile is EXPANDED in the Pipeline (swimlanes) view. Kept at
// MODULE scope so an expanded pile survives the full re-render the app does on every SSE event.
// Pruned against the live work-id set on each workspace render (below) so it can't grow unbounded
// across a long session.
const SWIM_DONE_EXPANDED = new Set();

// <test-extract:prune-caches>
// Bound the two long-lived module caches so they don't grow unbounded across a long session:
// SWIM_DONE_EXPANDED (story ids whose done pile is open) and activityCache (task id -> last pulse).
// Both only ever ADD ids; work that leaves the list (merged/aborted, or you switch workspaces)
// kept its entry forever. On each workspace render we drop every id no longer in the current
// work-id set — functionally harmless (a stale id renders nothing) — purely a growth bound.
function pruneWorkCaches(liveIds, expanded, activity) {
  for (const id of expanded) if (!liveIds.has(id)) expanded.delete(id);
  for (const id of activity.keys()) if (!liveIds.has(id)) activity.delete(id);
}
// </test-extract:prune-caches>

// <test-extract:complete-status>
// A work item counts as COMPLETE once it reaches a SUCCESSFUL terminal status. A LEAF task ends
// at `merged` (or `rolled_back`); a STORY NODE ends at `done`. This is the ONE source of truth
// for "is this work finished", reused by storyProgress's done count AND the cross-type graph/rollup
// progress bars — those bars mix nodes + leaves in one subtree, so they MUST count node `done`
// too, else any subtree containing a completed story UNDER-reports (it sits in the total but
// never in the merged numerator). Failure/abort are terminal but NOT complete (they're the ✗).
const COMPLETE_STATUSES = new Set(["merged", "rolled_back", "done"]);
function isCompleteStatus(status) { return COMPLETE_STATUSES.has(status); }
// </test-extract:complete-status>

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

// The unified WORK-LIST URL for one workspace: GET /api/work scoped to this workspace
// (?workspace=). The single replacement for the split /workspaces/:id/tasks +
// /workspaces/:id/stories fetches — the response is the WorkView leaf|node union, which
// callers split by `work_kind` (leaves → task list, nodes → stories).
function workListPath(workspaceId) {
  return "/work?workspace=" + encodeURIComponent(workspaceId);
}
// The LEAF (task) members of a /api/work list — used for the launcher's one-line queue summary.
// The Pipeline view consumes the full leaf|node union directly, so there's no node-only splitter.
function workLeaves(work) {
  return (Array.isArray(work) ? work : []).filter((w) => w && w.work_kind === "leaf");
}

// Whether a work item is FINISHED (terminal): a NODE (story) once it reaches done/aborted, a
// LEAF (task) by the server's terminal status set. In the Pipeline view a finished story is
// dropped from the lanes and a finished subtask collapses into its lane's "N done" pile;
// everything else stays active — including stories that are open/merging/merge_blocked and any
// feedback task awaiting the operator.
function isHistoryItem(w) {
  if (!w) return false;
  if (w.work_kind === "node") return w.status === "done" || w.status === "aborted";
  return TERMINAL_STATUSES.includes(w.status);
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
// pseudo-bucket, not a real subtask — excluded, mirroring storyProgress). Drives the HONEST empty
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
// The story's OWN-children progress from its `counts` rollup — done (COMPLETE statuses, via
// isCompleteStatus) over the TRUE total (storySubtaskTotal, which drops the idle
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

// The Pipeline view entry point (the sole workspace-body work view). Builds into a wrapper it can
// repaint in place, so a lane's done-toggle re-renders instantly without waiting for the next SSE tick.
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

// ---------- task detail / review ----------
// Compact vertical AUDIT TIMELINE of a task's status transitions (oldest → newest):
// one row per change with the transition (from → to chips) and the short note that
// explains why it moved, plus a relative timestamp (full ISO on hover). Driven by
// GET /api/work/:id/events. Returns null when there are no recorded events.
function renderTimeline(events) {
  if (!Array.isArray(events) || events.length === 0) return null;
  const panel = el("div", { class: "panel timeline-panel" });
  panel.appendChild(el("h2", { class: "panel-title" }, "Timeline"));
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

// The RESCUE NOTE for a task butchr force-moved to review, or null. butchr stamps its
// reason ("[butchr] moved to review automatically: ...") as the note of the transition
// INTO `in_review` (tasks.markInReview); an agent that submitted normally leaves a
// different note, so the prefix is what distinguishes a rescue. Only meaningful while the
// task still sits in review — once it merges or is re-worked, the Timeline keeps the
// history and the dedicated panel would be stale. Returns the LATEST such note (a task can
// be rescued, re-dispatched, and rescued again).
function rescueNote(events, status) {
  if (status !== "in_review" || !Array.isArray(events)) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.to_status === "in_review" && typeof ev.note === "string") {
      return ev.note.startsWith("[butchr] moved to review automatically") ? ev.note : null;
    }
  }
  return null;
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

async function renderTask(id) {
  const t = await api("GET", "/work/" + id);
  const dirs = await api("GET", "/workspaces");
  const dir = dirs.find((x) => x.id === t.workspace_id);

  const wrap = el("div");
  wrap.appendChild(el("div", {
    class: "crumbs",
    html: `<a href="#/projects">Projects</a> / <a href="#/workspace/${esc(t.workspace_id)}">${esc(dir ? (dir.label || dir.path) : t.workspace_id)}</a> / <span aria-current="page">${esc(t.id)}</span>`,
  }));
  const headerRight = el("div", { class: "row" });
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
    el("h1", { html: `<span class="mono">${esc(t.id)}</span>` }),
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
      <h2 class="panel-title">Merge auto-reverted off main</h2>
      <p class="muted lede">This branch merged, but the post-merge verify (build + tests) failed on the default branch, so the merge was reverted to keep main green. The branch + worktree were kept.</p>
      <pre class="block">${esc(t.revert_reason)}</pre>
      <div class="row panel-actions">
        <button class="btn" id="requeue">Re-queue</button>
        <small class="muted">Re-launches the agent (in-context) to fix the breakage, then it can be re-reviewed.</small>
      </div>`;
    wrap.appendChild(panel);
  } else if (t.status === "aborted" && t.last_dispatch_error) {
    const n = t.dispatch_attempts || 0;
    const panel = el("div", { class: "panel failed-panel" });
    panel.innerHTML = `
      <h2 class="panel-title">Dispatch failed</h2>
      <p class="muted lede">Failed after ${n} dispatch attempt${n === 1 ? "" : "s"}. The agent never started.</p>
      <pre class="block">${esc(t.last_dispatch_error || "(no error recorded)")}</pre>
      <div class="row panel-actions">
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

  // WHY BUTCHR INTERVENED — for a task butchr FORCE-moved to review (the agent died, ran
  // away, or blew the resume cap), surface its own account of why. This is butchr's text,
  // not the agent's, so the session transcript below cannot carry it; it is persisted as the
  // transition's `task_events.note` and also appears on the Timeline. Rendered from the
  // already-fetched `events` — no extra route, no extra column. Omitted entirely for a task
  // that reached review normally (no rescue note ⇒ no panel).
  const rescue = rescueNote(events, t.status);
  if (rescue) block("Why butchr moved this to review", rescue, wrap);

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
        <h2 class="panel-title">Awaiting major-version confirmation (${esc(String(n))}/2)</h2>
        <p class="muted lede">This task declares a <strong>major</strong> version bump, so merging it is a deliberate human double-confirm — <strong>Approve does not merge it</strong>. Click <strong>Confirm major version</strong> <strong>twice in a row</strong> (streak ${esc(String(n))}/2); the second consecutive confirm lands the merge. <strong>Any other action</strong> (Approve, Request change, re-review, re-declaring the bump) <strong>resets the streak to 0</strong>.</p>
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

    const controls = el("div", { class: "panel stacked" });
    controls.innerHTML = `
      <h2 class="panel-title">Review</h2>
      <label class="field tight">
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
    const specPanel = el("div", { class: "panel stacked" });
    const specResponderCopy = specResponder === "user"
      ? "You are the responder for this spec. Turn the brief above into a concrete, repo-grounded spec and submit it to advance the task to spec review."
      : specResponder === "story"
      ? "The <strong>story leader</strong> agent will write the spec from the brief (it was notified on its story channel). You can also write and submit one yourself below."
      : "The <strong>CTO agent</strong> will write the spec from the brief (it was notified on the CTO channel). You can also write and submit one yourself below.";
    specPanel.innerHTML = `
      <h2 class="panel-title">${specResponder === "user" ? "Write the spec" : "Spec requested"}</h2>
      <p class="muted lede">${specResponderCopy}</p>
      <label class="field tight">
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
    const controls = el("div", { class: "panel stacked" });
    controls.innerHTML = `
      <h2 class="panel-title">Review spec</h2>
      <p class="muted lede">A spec was submitted for this idea. Approve to dispatch the workspace agent, or request changes to revise the spec.</p>
      <label class="field tight">
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
    const planPanel = el("div", { class: "panel stacked" });
    planPanel.innerHTML = `
      <h2 class="panel-title">Review plan</h2>
      <p class="muted lede">Approve to let the agent implement this plan, or request changes with feedback — the agent revises and re-proposes. Both resume the same session in-context.</p>
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
    const answerPanel = el("div", { class: "panel stacked" });
    answerPanel.innerHTML = `
      <h2 class="panel-title">Respond</h2>
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
    const idlePanel = el("div", { class: "panel stacked" });
    idlePanel.innerHTML = `
      <h2 class="panel-title">Idle agent</h2>
      <p class="muted lede">This agent is alive but has gone quiet. Read the context above to judge why it stopped, then steer it with guidance (or a bare “continue”), re-queue it to relaunch its session, or abort it from the header.</p>
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
// Highlight the topbar nav link matching the current route. With the flat "Workspaces" top level
// retired (Hierarchical Projects IA S3), only two nav items remain: Metrics → #/metrics and
// everything else (projects overview / project detail / nested + flat workspace / task / dashboard)
// → #/projects. A flat `#/workspace/:wid` is transient — it redirects to its nested home — so
// lighting Projects during that hop keeps the nav stable.
function syncTopnav(route) {
  const links = document.querySelectorAll(".topnav-link");
  if (!links.length) return;
  const name = route && route.name;
  const owningHref = name === "metrics" ? "#/metrics" : "#/projects";
  links.forEach((a) => {
    const active = a.getAttribute("href") === owningHref;
    a.classList.toggle("active", active);
    if (active) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
}

// ---------- metrics view ----------

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
    <label class="field tight">
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

// ---------- managed CEO agent (PER-PROJECT, REVAMP-4 P3c) ----------
// The tier-above analog of ctoPanel (app.js:530): a project node's managed CEO-agent card on
// the project-detail view. Fed by GET /api/projects/:id/ceo → { enabled, overridden, globalGate,
// live }, ALL RESOLVED server-side — `enabled` already folds the per-project override vs the
// global gate, so the pill/toggle-checked state read straight off it (never ceo_enabled alone,
// which is the overview's coarser ceoPill). Mirrors ctoPanel: fetched async, mounted in place
// via a slot replace, fail-soft on a status-probe hiccup.

// <test-extract:projects-ceo-status> — pure, DOM-free CEO status-pill + note derivation,
// unit-tested in test/projects-ceo-ui.test.ts (the honest-gate matrix that feature #4 hinges on).
// The status pill, derived from the RESOLVED fields: live wins (green), else enabled (blue),
// else a disabled project that's merely INHERITING the default reads the neutral "CEO default"
// (not "CEO disabled" — nothing was explicitly turned off), and an explicit-off reads "CEO
// disabled". Returns { cls, label, title? }.
function ceoStatusPill(s) {
  if (s.live) return { cls: "live", label: "CEO live" };
  if (s.enabled) return { cls: "enabled", label: "CEO enabled" };
  if (!s.overridden) {
    return {
      cls: "inactive",
      label: "CEO default",
      title: "Inherits the global CEO gate (BUTCHR_CEO_AGENT) — currently off",
    };
  }
  return { cls: "disabled", label: "CEO disabled" };
}

// The honest context note under the CEO card, CONDITIONAL on override-vs-inherit so it never
// contradicts the runtime (isCeoEnabled: an explicit override WINS over the global gate, so an
// explicit-ON CEO runs regardless of the gate). Returns an HTML string ("" for the no-note case).
//   • INHERITING (overridden=false): always note it's inheriting the default; when the global
//     gate is ALSO off, this is exactly where the gate bites → say so and point at the override.
//   • OVERRIDDEN-ON while the gate is off: NEVER "inert" — it runs via the override; a neutral note.
//   • OVERRIDDEN-OFF: explicitly disabled for this project.
function ceoNoteHtml(s) {
  if (!s.overridden) {
    if (!s.globalGate) {
      return '<div class="ceo-note">The global CEO gate (<code>BUTCHR_CEO_AGENT</code>) is off, ' +
        "so projects that inherit the default stay disabled. Toggle this project on to override " +
        "and run its CEO regardless.</div>";
    }
    return '<div class="ceo-note inherit">Inheriting the global default (<code>BUTCHR_CEO_AGENT</code> ' +
      "is on) — toggle to set an explicit per-project override.</div>";
  }
  // overridden === true — the per-project value wins; never imply it's inert.
  if (s.enabled && !s.globalGate) {
    return '<div class="ceo-note inherit">Running via a per-project override; the global CEO gate ' +
      "(<code>BUTCHR_CEO_AGENT</code>) is off, but this project's CEO runs regardless.</div>";
  }
  if (!s.enabled) {
    return '<div class="ceo-note inherit">Explicitly disabled for this project.</div>';
  }
  return "";
}

// The "Open CEO terminal" button's enabled state + honest hint, derived only from the RESOLVED
// {enabled, overridden, globalGate, live} fields. Unlike the CTO button (which HIDES when not
// running), this stays visible but disables when there's no live pane and explains WHY — using
// the same honest wording as ceoNoteHtml so the two never contradict. Returns { enabled, title }.
function ceoTerminalBtnState(s) {
  if (s.live) return { enabled: true, title: "Attach a terminal to the live CEO agent" };
  if (s.enabled) return { enabled: false, title: "CEO agent is starting… — no live pane to attach yet" };
  if (s.overridden) return { enabled: false, title: "CEO is disabled for this project — enable it to attach a terminal" };
  if (!s.globalGate) {
    return {
      enabled: false,
      title: "The global CEO gate (BUTCHR_CEO_AGENT) is off — enable this project's CEO to attach a terminal",
    };
  }
  return { enabled: false, title: "CEO agent isn't live — no terminal to attach" };
}
// </test-extract:projects-ceo-status>

// Build the CEO card DOM from a fetched CeoStatus. Standalone (no closure over the fetch) so the
// toggle handler can rebuild + replace the card in place after a PATCH + refetch.
function buildCeoCard(projectId, s) {
  const pill = ceoStatusPill(s);
  const term = ceoTerminalBtnState(s);
  const lifeCls = s.live ? "alive" : "down";
  const lifeTxt = s.live ? "CEO agent live" : (s.enabled ? "CEO agent starting…" : "CEO agent inactive");
  const card = el("div", { class: "panel ceo-card" });
  card.innerHTML = `
    <div class="panel-head">
      <h2>${kindBadge("ceo")} CEO agent</h2>
      <span class="spacer"></span>
      <span class="chip ${pill.cls}"${pill.title ? ` title="${esc(pill.title)}"` : ""}>${esc(pill.label)}</span>
    </div>
    <div class="ceo-row">
      <label class="switch">
        <input type="checkbox" class="ceo-toggle"${s.enabled ? " checked" : ""} />
        <span class="track"></span>
        <span class="ceo-toggle-lbl">${s.enabled ? "Enabled" : "Disabled"}</span>
      </label>
      <span class="ceo-life"><span class="ceo-dot ${lifeCls}"></span>${esc(lifeTxt)}</span>
      <span class="spacer"></span>
      <button class="btn ceo-term"${term.enabled ? "" : " disabled"} title="${esc(term.title)}">⌗ Open CEO terminal</button>
      ${s.overridden ? '<button class="btn ghost xs ceo-reset" title="Clear the per-project override and inherit the global default">Reset to default</button>' : ""}
    </div>
    ${ceoNoteHtml(s)}`;

  // Rebuild + replace this card from a fresh /ceo read after a write — keeps the pill, life
  // line and note honest without re-fetching the whole page.
  const refresh = async () => {
    const next = await api("GET", "/projects/" + encodeURIComponent(projectId) + "/ceo");
    card.replaceWith(buildCeoCard(projectId, next));
  };

  // Optimistic enable/disable toggle → PATCH { ceo_enabled }. Disable the input during the
  // round-trip; on failure revert the checkbox + label and surface the error inline (toast).
  const cb = card.querySelector(".ceo-toggle");
  cb.addEventListener("change", async () => {
    const want = cb.checked;
    cb.disabled = true;
    card.querySelector(".ceo-toggle-lbl").textContent = want ? "Enabled" : "Disabled";
    try {
      await api("PATCH", "/projects/" + encodeURIComponent(projectId), { ceo_enabled: want });
      toast(want ? "CEO enabled" : "CEO disabled");
      await refresh();
    } catch (e) {
      cb.checked = !want;
      card.querySelector(".ceo-toggle-lbl").textContent = !want ? "Enabled" : "Disabled";
      cb.disabled = false;
      toast(e.message, true);
    }
  });

  // Open CEO terminal → POST /api/projects/:id/ceo/terminal (the CEO analog of the CTO terminal
  // route, same attach payload). Enabled only when the CEO is live (ceoTerminalBtnState gates +
  // titles it honestly). Mirrors the CTO button's disable/try/toast pattern; no render() since
  // attaching a terminal never navigates.
  const termBtn = card.querySelector(".ceo-term");
  if (term.enabled) {
    termBtn.addEventListener("click", async () => {
      termBtn.disabled = true;
      try {
        const r = await api("POST", "/projects/" + encodeURIComponent(projectId) + "/ceo/terminal");
        terminalToast(r);
      } catch (e) {
        toast(e.message, true);
      } finally {
        termBtn.disabled = false;
      }
    });
  }

  // Reset-to-inherit → PATCH { ceo_enabled: null } — only present while an explicit override is set.
  const reset = card.querySelector(".ceo-reset");
  if (reset) {
    reset.addEventListener("click", async () => {
      reset.disabled = true;
      try {
        await api("PATCH", "/projects/" + encodeURIComponent(projectId), { ceo_enabled: null });
        toast("CEO reset to the global default");
        await refresh();
      } catch (e) {
        reset.disabled = false;
        toast(e.message, true);
      }
    });
  }
  return card;
}

// Fetch this project's CEO status and resolve to the card node. Fail-soft (mirrors ctoPanel's
// catch): a probe hiccup yields a muted "status unavailable" card rather than blocking the page.
async function ceoPanel(projectId) {
  let s;
  try {
    s = await api("GET", "/projects/" + encodeURIComponent(projectId) + "/ceo");
  } catch {
    return el("div", { class: "panel ceo-card" },
      el("small", { class: "muted" }, "CEO agent status unavailable"));
  }
  return buildCeoCard(projectId, s);
}

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

  // header: breadcrumb trail + title/anchor/brief + a subtle (cosmetic) node-status chip. The
  // Projects crumb links back to the overview; the trailing project name is the current page
  // (aria-current), mirroring the workspace view's .crumbs (Hierarchical Projects IA S3).
  wrap.appendChild(el("div", {
    class: "crumbs",
    html: `<a href="#/projects">Projects</a> / <span aria-current="page">${esc(projectTitle(project))}</span>`,
  }));

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

  // CEO-agent card (REVAMP-4 P3c) — the project's managed supervisor agent: resolved
  // enable/disable + honest global-gate status + a toggle. Rendered async and mounted in
  // place (mirrors ctoPanel's slot-replace) so a /ceo probe hiccup never blocks the page.
  const ceoSlot = el("div");
  wrap.appendChild(ceoSlot);
  ceoPanel(id).then((panel) => ceoSlot.replaceWith(panel)).catch(() => {});

  // repos panel
  wrap.appendChild(reposPanel(project, repos, wsById));

  // initiatives panel — the cross-repo rollup + launch surface (REVAMP-4 S4)
  wrap.appendChild(initiativesPanel(project, initiatives, repos, wsById));

  // danger zone — the destructive Delete-project action (mirrors the workspace
  // danger zone). Deliberately the ONLY delete surface: the overview cards are
  // whole-card click-to-open with no existing kebab/overflow-menu pattern to
  // reuse, so a card-corner delete is skipped rather than inventing a menu system.
  wrap.appendChild(projectDangerZone(project));

  mount(wrap);
}

// The Delete-project danger zone at the foot of the detail view: a subtle separated
// region whose destructive button opens a confirm modal before deleting.
function projectDangerZone(project) {
  const zone = el("div", { class: "pd-danger-zone" });
  zone.appendChild(el("div", { class: "pd-danger-lbl muted" }, "Danger zone"));
  const del = el("button", { class: "btn ghost danger-outline" }, "Delete project");
  del.addEventListener("click", () => confirmDeleteProject(project));
  zone.appendChild(del);
  return zone;
}

// CONFIRM-DELETE modal for a project — reuses openModal (the shared confirm scaffold, so
// Escape/backdrop-close + focus behavior match every other modal) and the openAddWorkspaceModal
// inline-error dance. Delete → DELETE /api/projects/:id, branching on status:
//   200 → close, navigate back to the overview (#/projects), success toast.
//   409 → the guard message (server serializes guard errors as { error } — e.g.
//         "project <id> still has N registered repo(s); unregister them first …") is shown
//         VERBATIM inline in .m-error next to the button; the modal STAYS open, nothing
//         navigates, and action() re-enables the button.
//   other non-2xx → thrown so action() takes the generic error-toast path the other
//         /api/projects calls use.
// api() collapses the response to a message string, so this reads res.status directly via a
// small fetch (api() is itself only a fetch wrapper) to tell the guarded 409 apart.
function confirmDeleteProject(project) {
  const body = el("div", { class: "m-body" });
  body.innerHTML =
    '<p>Delete <strong>' + esc(projectTitle(project)) + '</strong>? This removes the project ' +
    'node and its CEO agent. Its registered repos and their work are not deleted.</p>';

  const foot = el("div", { class: "m-foot" });
  const errEl = el("span", { class: "m-error hint" }, "");
  const cancel = el("button", { class: "btn ghost" }, "Cancel");
  const del = el("button", { class: "btn danger" }, "Delete project");
  foot.appendChild(errEl);
  foot.appendChild(cancel);
  foot.appendChild(del);

  const { close } = openModal({ title: "Delete project", body, footer: foot });
  cancel.addEventListener("click", close);
  function showErr(msg) { errEl.textContent = msg || ""; errEl.classList.toggle("on", !!msg); }

  del.addEventListener("click", () => {
    showErr("");
    action(del, async () => {
      const res = await fetch("/api/projects/" + encodeURIComponent(project.id), { method: "DELETE" });
      if (res.ok) return;
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
      const msg = (data && data.error) || res.statusText;
      if (res.status === 409) {
        // guarded — show the server's actionable message inline, keep the modal open, and
        // re-throw so action() re-enables the button (its onDone never runs on a throw).
        showErr(msg);
      }
      throw new Error(msg);
    }, { success: "project deleted", onDone: () => { close(); location.hash = "#/projects"; } });
  });
}

// The Initiatives panel: header with a right-aligned "Launch initiative" action, then one
// .init block per initiative (GET /api/projects/:id/initiatives). Each block shows a derived
// heading, its per-repo child rows (resolved repo name + shared-palette status chip + the child's
// brief), and a rolled-up doneness bar. Empty-state when there are none. Both single-repo and
// cross-repo initiatives appear here — a child is a pending directive until its CTO decomposes it,
// then the resulting stories.
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
// two backend shapes on POST /api/projects/:id/initiatives (each lands a CEO DIRECTIVE per repo for
// its CTO to accept & decompose — the CEO no longer forges the story itself):
//   Single repo      → { repo, brief }         (one member repo + a brief; grouped under an initiative)
//   Cross-repo fan-out → { targets:[{repo,brief}] } (repeatable rows, atomic all-or-nothing)
// Member repos (the select options) come from the project's repos list, resolved to friendly
// names via repoDisplay. A 409 (non-member repo) is shown INLINE in .m-error, not just a toast.
// Submit is disabled with an honest message when the project has no member repos. On a 201 the
// modal closes and the view re-renders (refreshing the list); both shapes now appear in this panel's
// rollup (a pending directive until its CTO decomposes it, then the stories).
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
        '<label class="field tight"><span class="lbl">brief — what to build in this repo</span>' +
          '<textarea class="tgt-brief" placeholder="Describe the initiative for this repo…"></textarea></label>' +
        '<small class="hint muted">A single-repo initiative sends a directive to that repo’s CTO, who ' +
          'decomposes it into stories — it’s tracked here (and on that repo’s board). ' +
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
        success: "directive sent to " + repoName + "’s CTO — track it here once decomposed",
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
        success: targets.length + " directive" + (targets.length === 1 ? "" : "s") +
          " fanned out to " + targets.length + " repo CTO" + (targets.length === 1 ? "" : "s"),
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
  // Contextual create (Hierarchical Projects IA S4): "+ Add workspace" registers an EXISTING git
  // directory and nests it under THIS project atomically — the primary (and only) add path now that
  // loose workspaces are gone. It replaces the old "+ Add repo" (add-an-already-materialized-repo)
  // flow, which is meaningless once every repo lives under a project.
  const addBtn = el("button", { class: "btn ghost xs" }, "+ Add workspace");
  addBtn.addEventListener("click", () => openAddWorkspaceModal(project));
  phead.appendChild(addBtn);
  panel.appendChild(phead);

  if (!repos.length) {
    panel.appendChild(el("div", { class: "empty" },
      "No repos registered — add one to target it with an initiative."));
    return panel;
  }

  for (const repo of repos) {
    const d = repoDisplay(repo, wsById);
    // The repo IS a workspace/directory node (repo.id === workspace id), so the row DRILLS IN
    // to that workspace's work views via the nested route `#/projects/:pid/workspaces/:wid`
    // (Hierarchical Projects IA S2). A11y: a real focusable button-row (Enter/Space activate).
    const row = el("div", { class: "repo-row clickable", role: "button", tabindex: "0" });
    row.innerHTML =
      '<span class="ic" aria-hidden="true">◆</span>' +
      '<span class="nm">' + esc(d.name) + '</span>' +
      '<span class="rp">' + esc(d.dir) + '</span>' +
      '<span class="spacer"></span>' +
      '<button class="icon-btn" title="Unregister repo" aria-label="Unregister ' + esc(d.name) + '">×</button>';
    const drillIn = () => {
      location.hash = "#/projects/" + encodeURIComponent(project.id) +
        "/workspaces/" + encodeURIComponent(repo.id);
    };
    // Row click drills in — but NOT when the click landed on the unregister button.
    row.addEventListener("click", (e) => {
      if (e.target.closest(".icon-btn")) return;
      drillIn();
    });
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); drillIn(); }
    });
    const del = row.querySelector(".icon-btn");
    del.addEventListener("click", (e) => {
      e.stopPropagation(); // don't let the unregister click bubble to the row's drill-in
      unregisterRepo(project, repo, row);
    });
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

// ADD-WORKSPACE modal (Hierarchical Projects IA S4) — the CONTEXTUAL create. Register an EXISTING
// git directory AND nest its repo node under THIS project atomically via
// POST /api/projects/:id/workspaces { path, label, gate_cmd } (server.ts → registerWorkspaceUnderProject).
// This is now the ONLY way to add a workspace (the loose/top-level register form was removed), so it
// owns the path/label/gate fields the retired global form used, plus a "Browse…" that reuses
// openPicker as a FILL-ONLY directory browser — it drops the chosen path into the field; the actual
// registration always goes through THIS project endpoint, never the loose POST /workspaces. The
// server's errors surface INLINE in .m-error verbatim (400 "not a git repository: <path>", 404 project
// gone), not just a transient toast. On success we close + render() so the new workspace appears as a
// drill-in repo row.
function openAddWorkspaceModal(project) {
  const body = el("div", { class: "m-body" });
  body.innerHTML =
    '<label class="field tight">' +
      '<span class="lbl">path to a git repository</span>' +
      '<div class="field-row">' +
        '<input type="text" id="aw-path" placeholder="/home/you/code/project" />' +
        '<button type="button" class="btn ghost" id="aw-browse">Browse…</button>' +
      '</div>' +
    '</label>' +
    '<label class="field tight">' +
      '<span class="lbl">label (optional)</span>' +
      '<input type="text" id="aw-label" placeholder="defaults to dir name" />' +
    '</label>' +
    '<small class="hint muted">Registers an existing git repository and nests it under this project. The gate is the repo\'s own <code>./scripts/ci</code>.</small>';

  const foot = el("div", { class: "m-foot" });
  const errEl = el("span", { class: "m-error hint" }, "");
  const cancel = el("button", { class: "btn ghost" }, "Cancel");
  const submit = el("button", { class: "btn" }, "Add workspace");
  foot.appendChild(errEl);
  foot.appendChild(cancel);
  foot.appendChild(submit);

  const { close } = openModal({ title: "Add workspace", body, footer: foot });
  cancel.addEventListener("click", close);
  function showErr(msg) { errEl.textContent = msg || ""; errEl.classList.toggle("on", !!msg); }

  const pathEl = body.querySelector("#aw-path");
  const labelEl = body.querySelector("#aw-label");

  // Browse the filesystem for a git repo — reuse the shared picker FILL-ONLY: whichever way the user
  // picks (a git-row "Register" button or "Use this path"), we just drop the path into the field and
  // let them confirm via the modal's submit. Registration goes through THIS project's endpoint.
  body.querySelector("#aw-browse").addEventListener("click", () => {
    openPicker((picked) => { pathEl.value = picked; pathEl.focus(); });
  });

  function doSubmit() {
    const path = pathEl.value.trim();
    if (!path) { showErr("Enter (or browse to) a git repository path."); pathEl.focus(); return; }
    const label = labelEl.value.trim();
    showErr("");
    action(submit, async () => {
      try {
        // Omit a blank label so the server keeps its default (dir-name label).
        return await api("POST",
          "/projects/" + encodeURIComponent(project.id) + "/workspaces",
          { path, label: label || undefined });
      } catch (e) {
        showErr(e.message); // 400 non-git-repo / 404 project gone — surfaced inline verbatim
        throw e; // let action() toast + re-enable the button
      }
    }, { success: "workspace registered", onDone: () => { close(); render(); } });
  }

  submit.addEventListener("click", doSubmit);
  // Keyboard-submit: Enter in any text field submits (matches the create-project/story modals).
  for (const inp of [pathEl, labelEl, gateEl]) {
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doSubmit(); } });
  }
  pathEl.focus();
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
