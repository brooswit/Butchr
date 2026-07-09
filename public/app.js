// butchr webapp — vanilla JS single-page app. Hash-routed, SSE live updates.
"use strict";

// `core/` holds dependency-free leaves — nothing there imports this file. Each is DOM-free
// at module load. THIS file is not: its boot (setupTheme / wireAttention / connectSSE, below)
// touches `document`, which is exactly why nothing under core/, components/, or views/ may
// import it — see the header of core/nav.js.
//
// stateMetaLoaded is an `export let`:
// applyStateMeta REASSIGNS it once /api/state-meta lands, and the ES live binding
// propagates that new value here. Read it at CALL time — never destructure it into a
// local const, which would snapshot the empty pre-load value and silently break every
// status chip.
//
// Only `el` survives from core/dom.js: renderRoute's catch mounts an .empty error node, and
// that is now the sole DOM construction left in this file. `esc` went with the projects views —
// every one of its call sites was inside a moved body.
import { el } from "./core/dom.js";
// core/format.js is no longer imported here at all. fmtBytes/fmtPct left with the metrics view;
// fmtDuration went with the workspace view's activity pulse and fmtTime with the CTO panel; and
// projectTitle / repoDisplay went with the projects views. All remain exported from format.js,
// where views/workspace.js and views/projects.js import them.
import { api, toast } from "./core/api.js";
// FILTER_STATUSES is no longer imported here: its only consumer was dirCard's count-pill row,
// which died with the unreachable dashboard surface. TERMINAL_STATUSES / statusLabel left with
// the task view. All remain exported from state-meta.js.
import { loadStateMeta, stateMetaLoaded } from "./core/state-meta.js";
// `components/` holds the presentational leaves — DOM-free at load, importing only from
// `core/` and from each other. chips.js owns the CHIP + BADGE cluster (status/kind/tag/
// liveness pills); panel.js the collapsible scaffold + the containers and gate badges built
// on it; overlay.js the modal scaffold + the directory picker; cto-panel.js the per-workspace
// CTO-agent card (a shared leaf, not a view's private helper); project-modals.js the three
// PROJECTS dialogs. Nothing under components/ imports THIS file — that cycle is the one thing
// the split must never close.
//
// NOTHING from components/ is imported here any more. panel.js's cluster (block/blockerRow/
// ciBadge/collapsible/conformanceBadge/listPanel/rollupPanel) went with the task view and
// effStatus with the workspace view's queueLine; chips.js's chip/kindBadge, overlay.js's
// openModal, and project-modals.js's openNewProjectModal/openLaunchModal/openAddWorkspaceModal
// all went with the projects views, which import them directly.
// nav.js owns the `#app` mount point, hash navigation, and the re-render handle. The route
// DISPATCHER still lives here (renderRoute, below); app.js registers it via setRenderer() so
// that views can import `render` from a leaf instead of from this file. That inversion is what
// keeps `views/ -> app.js` from ever existing — see core/nav.js's header for why it is fatal.
import { mount, render, setRenderer } from "./core/nav.js";
// components/button.js's `action()` is not imported here either: confirmDeleteProject was its
// last caller in this file and went with the projects views. work-graph.js holds the pure, DOM-free work-list/
// dependency-graph leaves the task, workspace, and pipeline views all share — likewise imported
// only by those views.
// `views/` holds one module per route: each owns its fetch → build → mount() entry point and
// imports only leaves. With the projects views extracted, EVERY view now lives here and this
// file is router + bootstrap alone.
// task.js is the task detail / review page: renderRoute dispatches to its renderTask, and clears
// its live-output poll timer via stopLiveOutput on every route change. workspace.js is a repo's
// page: renderRoute dispatches to its renderWorkspace and clears its activity-pulse poll timer
// via stopActivity on every route change (renderWorkspace restarts it itself after mount).
// projects.js is the projects overview + a project's detail page (the CEO card, repos and
// initiatives panels, danger zone); renderRoute dispatches to both of its entry points.
// swimlanes.js is the workspace body's Pipeline view — imported by workspace.js, not here.
// diff.js is the task page's diff reader (parse + highlight + inline review comments) — not a
// route of its own; renderTask (now in task.js) is its only caller, so only setPendingInlineRestore
// is imported here: it is the SSE path's one write into diff.js's state, and an imported `let`
// cannot be assigned, so the owning module exports a setter instead.
import { renderMetrics } from "./views/metrics.js";
import { renderProjectDetail, renderProjects } from "./views/projects.js";
import { renderTask, stopLiveOutput } from "./views/task.js";
import { renderWorkspace, stopActivity } from "./views/workspace.js";
import { setPendingInlineRestore } from "./views/diff.js";

setRenderer(renderRoute); // hoisted function declaration — safe to register before its body appears

// ---------- router ----------
// Returns the parsed route, or NULL for a hash this app does not recognize. A null route is not
// an error: renderRoute REPLACE-redirects it to the Projects overview, the same way it handles a
// bare hash. There is deliberately no catch-all route object — the legacy workspace-card dashboard
// that once served that role is gone, and inventing a route name for "unknown" would only re-create
// a surface with no view behind it.
function parseHash() {
  const hash = location.hash.replace(/^#/, "") || "/";
  const parts = hash.split("/").filter(Boolean);
  // LANDING = Projects (Hierarchical Projects IA S2): the default route shows the projects
  // overview. The workspace-card dashboard it replaced has since been deleted outright.
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
  return null; // unknown hash → renderRoute redirects to the Projects overview
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

// The route DISPATCHER, registered with nav.js's setRenderer() above. Everything else calls the
// imported `render()` (nav.js's delegator), so this is the only name that changed in the split.
async function renderRoute() {
  const route = parseHash();
  // CANONICALIZING REDIRECTS (Hierarchical Projects IA S3) — retire the flat top level by rewriting
  // legacy hashes to their hierarchical equivalents. REPLACE semantics (location.replace, not a
  // `location.hash =` push) so Back walks UP the hierarchy instead of landing on the old hash and
  // bouncing forward into the redirect again (a history trap). This makes the URL bar honest +
  // deep-linkable. A BARE hash and an UNKNOWN hash (parseHash → null) share the arm: everything is
  // reached project→workspace→work now, so both land on the Projects overview with the URL rewritten
  // to match what is actually rendered.
  const rawHash = location.hash.replace(/^#/, "");
  if (!route || rawHash === "" || rawHash === "/") {
    location.replace("#/projects"); // fires hashchange → render() re-runs on the canonical hash
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
  stopLiveOutput();
  stopActivity();
  syncTopnav(route);
  try {
    if (route.name === "metrics") await renderMetrics();
    else if (route.name === "projects") await renderProjects();
    else if (route.name === "project") await renderProjectDetail(route.id);
    else if (route.name === "workspace") await renderWorkspace(route.id, route.projectId);
    else if (route.name === "task") await renderTask(route.id);
  } catch (e) {
    mount(el("div", { class: "empty" }, "error: " + e.message));
  }
}

// ---------- topnav active state ----------
// Highlight the topbar nav link matching the current route. With the flat "Workspaces" top level
// retired (Hierarchical Projects IA S3), only two nav items remain: Metrics → #/metrics and
// everything else (projects overview / project detail / nested + flat workspace / task)
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

// ---------- needs-attention signal ----------
// A live pull-signal so the operator gets drawn in instead of polling: GET /health
// reports needsAttention { review, failed, total } and we reflect it as a tab-title
// badge ("(2) butchr") plus a header indicator that links to `#/` (which canonicalizes
// to the Projects overview). When permitted, a Web
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
// needs a user gesture) on its way to the Projects overview. The href handles navigation.
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
  // so its line rows don't exist yet at this point). The cell lives in views/diff.js, which
  // consumes it; an imported binding is read-only, so we write it through its setter.
  setPendingInlineRestore(snap.inline || null);
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
