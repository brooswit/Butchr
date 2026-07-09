// The WORKSPACE view — a single repo's page at `#/workspace/:id` (and its canonical nested
// home `#/projects/:pid/workspaces/:wid`). The last of the three big views extracted from
// app.js (RFC Phase 2).
//
// It owns the whole workspace page: the `renderWorkspace` entry point (breadcrumbs, the CTO
// panel slot, the New-story launcher, the Pipeline body, the danger zone), the launcher's
// one-line queue summary (`queueLine`), the New-story brief modal (`openNewStoryModal`), and
// the live ACTIVITY PULSE poller — the module state (`activityTimer`, `activityCache`) plus
// stopActivity / startActivity / pollActivity / applyPulse / tickPulseElapsed. The poller's
// cache is module-scope on purpose: the page re-renders wholesale on every SSE event, so the
// pulse nodes are destroyed and rebuilt while the cache survives. app.js's route dispatcher
// stops the poller on every route change, so `stopActivity` is exported alongside
// `startActivity` (which renderWorkspace itself calls after mount).
//
// It imports only LEAVES — `core/` (dom, format, api, nav, action, work-graph),
// `components/` (chips, overlay, cto-panel) — plus its sibling view `views/swimlanes.js`,
// whose renderSwimlanes paints the Pipeline body. It NEVER imports app.js: that edge would
// drag app.js's `document`-touching boot into every view's module graph and break `bun test`.
// See the header of core/nav.js. The dependency stays inverted — app.js registers its route
// dispatcher with nav.js, and this view imports `render`/`mount` from that leaf.
//
// DOM-free at module load: `document` is touched only inside a CALLED function, exactly like
// views/metrics.js, views/diff.js and views/swimlanes.js.
import { el, esc } from "../core/dom.js";
import { fmtDuration, projectTitle } from "../core/format.js";
import { api, toast } from "../core/api.js";
import { action } from "../components/button.js";
import { mount, render } from "../core/nav.js";
import { pruneWorkCaches, workLeaves, workListPath } from "../core/work-graph.js";
import { effStatus } from "../components/chips.js";
import { openModal } from "../components/overlay.js";
import { ctoPanel } from "../components/cto-panel.js";
import { SWIM_DONE_EXPANDED, renderSwimlanes } from "./swimlanes.js";

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
export function stopActivity() {
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

export function startActivity() {
  stopActivity();
  if (!document.querySelector(".pulse[data-id]")) return;
  pollActivity();
  activityTimer = setInterval(pollActivity, 2500);
}

// ---------- workspace view ----------
export async function renderWorkspace(id, projectId) {
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
export function openNewStoryModal(workspaceId) {
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
