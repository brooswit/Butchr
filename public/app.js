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
function chip(status) {
  return `<span class="chip ${esc(status)}">${esc(status)}</span>`;
}
// `idle` is a flag on a running task (agent alive but its CLI has gone quiet),
// not a real lifecycle status. Render it as its own chip in place of "running".
function effStatus(t) {
  return t.status === "running" && t.idle ? "idle" : t.status;
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

// ---------- directory picker modal ----------
// onSelect(path, register): register=false fills the field; true registers now.
function openPicker(onSelect) {
  let cur = null;

  const backdrop = el("div", { class: "modal-backdrop" });
  const modal = el("div", { class: "modal" });
  backdrop.appendChild(modal);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  function close() { backdrop.remove(); document.removeEventListener("keydown", onKey); }
  function onKey(e) { if (e.key === "Escape") close(); }
  document.addEventListener("keydown", onKey);

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

  document.body.appendChild(backdrop);
  // Start from the current field value if set, else home.
  const seed = (document.getElementById("dpath") || {}).value || "";
  load(seed.trim() || null);
}

// ---------- router ----------
function parseHash() {
  const hash = location.hash.replace(/^#/, "") || "/";
  const parts = hash.split("/").filter(Boolean);
  if (parts.length === 0) return { name: "dashboard" };
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

let current = null;
async function render() {
  const route = parseHash();
  current = route;
  stopLiveOutput();
  try {
    if (route.name === "dashboard") await renderDashboard();
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
  const dirs = await api("GET", "/directories");
  const wrap = el("div");
  wrap.appendChild(el("h1", {}, "Directories"));
  wrap.appendChild(el("div", { class: "crumbs" }, "registered workspaces · " + dirs.length));

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
    </div>`;
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
    if (!path) return toast("path is required", true);
    try {
      await api("POST", "/directories", { path, label: label || undefined });
      toast("directory registered");
      render();
    } catch (e) { toast(e.message, true); }
  });
}

function dirCard(d) {
  const c = d.counts || {};
  const pills = ["queued", "blocked", "running", "idle", "review", "finalizing", "failed", "merged", "aborted"]
    .map((s) => {
      const cls = s === "blocked" && c[s] ? "count-pill has-blocked"
        : s === "running" && c[s] ? "count-pill has-running"
        : s === "idle" && c[s] ? "count-pill has-idle"
        : s === "review" && c[s] ? "count-pill has-review"
        : s === "finalizing" && c[s] ? "count-pill has-finalizing"
        : s === "failed" && c[s] ? "count-pill has-failed" : "count-pill";
      return `<span class="${cls}">${s} <b>${c[s] || 0}</b></span>`;
    }).join("");
  const card = el("div", { class: "card" });
  card.innerHTML = `
    <div class="title">${esc(d.label || d.path)}</div>
    <div class="path">${esc(d.path)}</div>
    <div class="counts">${pills}</div>`;
  card.style.cursor = "pointer";
  card.addEventListener("click", () => (location.hash = "#/dir/" + d.id));
  return card;
}

// ---------- directory view ----------
async function renderDirectory(id) {
  const [dirs, tasks] = await Promise.all([
    api("GET", "/directories"),
    api("GET", "/directories/" + id + "/tasks"),
  ]);
  const dir = dirs.find((x) => x.id === id);
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

  // search + status filter bar. Filter state lives in module-level vars
  // (taskSearch / statusFilter) so it survives the full re-render the app does
  // on every SSE event. Typing/toggling rebuilds only the results region below
  // (not the bar itself), so the search input keeps focus while you type. The
  // split of active (queued/running/idle/review/finalizing) vs terminal-state
  // history (merged/aborted/rejected) happens inside renderResults.
  const results = el("div", { class: "results" });
  wrap.appendChild(buildFilterBar(tasks, results));
  wrap.appendChild(results);
  renderResults(tasks, results);

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
}

// ---------- new-task modal ----------
// Inline modal for creating a task: a required prompt plus an optional
// comma-separated blocked_by list (task ids this task waits on). Submits to the
// existing create endpoint; the new task surfaces via the SSE-driven re-render.
// Context is intentionally left empty (the agent reads files itself).
function openNewTaskModal(directoryId) {
  const backdrop = el("div", { class: "modal-backdrop" });
  const modal = el("div", { class: "modal" });
  backdrop.appendChild(modal);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  function close() { backdrop.remove(); document.removeEventListener("keydown", onKey); }
  function onKey(e) { if (e.key === "Escape") close(); }
  document.addEventListener("keydown", onKey);

  const head = el("div", { class: "m-head" });
  head.appendChild(el("h3", {}, "New task"));
  const x = el("button", { class: "btn ghost" }, "✕");
  x.addEventListener("click", close);
  head.appendChild(x);

  const body = el("div", { class: "m-body" });
  body.innerHTML = `
    <label class="field">
      <span class="lbl">prompt</span>
      <textarea id="nt-prompt" placeholder="Describe the work for the agent…"></textarea>
    </label>
    <label class="field" style="margin-bottom:0">
      <span class="lbl">blocked by (optional) — comma-separated task ids</span>
      <input type="text" id="nt-blocked" placeholder="e.g. snug-crag-ffae, wise-crag-b403" />
    </label>`;

  const foot = el("div", { class: "m-foot" });
  const errEl = el("span", { class: "m-error hint" }, "");
  const cancel = el("button", { class: "btn ghost" }, "Cancel");
  cancel.addEventListener("click", close);
  const create = el("button", { class: "btn" }, "Create task");
  foot.appendChild(errEl);
  foot.appendChild(cancel);
  foot.appendChild(create);

  modal.appendChild(head);
  modal.appendChild(body);
  modal.appendChild(foot);
  document.body.appendChild(backdrop);

  const promptEl = body.querySelector("#nt-prompt");
  const blockedEl = body.querySelector("#nt-blocked");
  promptEl.focus();

  function showErr(msg) { errEl.textContent = msg || ""; errEl.classList.toggle("on", !!msg); }

  create.addEventListener("click", async () => {
    const prompt = promptEl.value.trim();
    if (!prompt) { showErr("Prompt is required."); promptEl.focus(); return; }
    // Split the comma-separated blocker list into trimmed, non-empty ids.
    const blocked_by = blockedEl.value.split(",").map((s) => s.trim()).filter(Boolean);
    showErr("");
    create.disabled = true; cancel.disabled = true;
    try {
      await api("POST", "/directories/" + directoryId + "/tasks", { prompt, blocked_by });
      toast("task created");
      close();
      render();
    } catch (e) {
      showErr(e.message || "could not create task");
      create.disabled = false; cancel.disabled = false;
    }
  });
}

function queueLine(tasks) {
  const q = tasks.filter((t) => t.status === "queued").length;
  const b = tasks.filter((t) => t.status === "blocked").length;
  const r = tasks.filter((t) => t.status === "running" && !t.idle).length;
  const i = tasks.filter((t) => t.status === "running" && t.idle).length;
  const f = tasks.filter((t) => t.status === "finalizing").length;
  const parts = [];
  if (r) parts.push(`${r} running`);
  if (i) parts.push(`${i} idle`);
  if (f) parts.push(`${f} finalizing`);
  if (q) parts.push(`${q} queued`);
  if (b) parts.push(`${b} blocked`);
  return parts.length ? parts.join(", ") + "." : "Idle.";
}

// Lifecycle statuses still in flight — these stay in the main directory list.
// Everything else (merged, aborted, rejected) is terminal and lives in History.
// `blocked` is pre-dispatch waiting work, so it groups with the active tasks.
const ACTIVE_STATUSES = ["queued", "blocked", "running", "review", "finalizing"];
const HISTORY_KEY = "butchr-history-open";

function historyOpen() {
  try { return localStorage.getItem(HISTORY_KEY) === "1"; } catch (e) { return false; }
}
function setHistoryOpen(open) {
  try { localStorage.setItem(HISTORY_KEY, open ? "1" : "0"); } catch (e) { /* ignore */ }
}

// ---------- task search + status filtering ----------
// Filter state is kept in memory only, at module scope, so it survives the full
// re-render render() performs on every SSE event without being torn down. The
// statuses here are the *effective* statuses (effStatus), so `idle` and
// `running` filter independently, as do all terminal states.
const FILTER_STATUSES = ["queued", "blocked", "running", "idle", "review", "finalizing", "failed", "merged", "aborted", "rejected"];
let taskSearch = "";          // id substring filter (case-insensitive)
let statusFilter = new Set(); // selected effStatus values; empty = all

function filterActive() {
  return taskSearch.trim() !== "" || statusFilter.size > 0;
}
function taskMatchesFilter(t) {
  const q = taskSearch.trim().toLowerCase();
  if (q && !String(t.id).toLowerCase().includes(q)) return false;
  if (statusFilter.size && !statusFilter.has(effStatus(t))) return false;
  return true;
}

// The filter bar: an id search box plus a row of toggleable status chips (reusing
// the existing .chip color styling, dimmed when inactive). Handlers mutate the
// module-level filter state and rebuild ONLY the results region — leaving the bar
// (and the focused search input) untouched, so live-as-you-type works.
function buildFilterBar(tasks, results) {
  const bar = el("div", { class: "filter-bar" });

  const search = el("input", {
    type: "text", class: "task-search", placeholder: "Filter by task id…",
    "aria-label": "Filter tasks by id",
  });
  search.value = taskSearch;
  search.addEventListener("input", () => {
    taskSearch = search.value;
    renderResults(tasks, results);
    syncClear();
  });

  const chips = el("div", { class: "filter-chips" });
  for (const s of FILTER_STATUSES) {
    const c = el("button", {
      type: "button",
      class: "filter-chip chip " + s + (statusFilter.has(s) ? " active" : ""),
      "aria-pressed": statusFilter.has(s) ? "true" : "false",
    }, s);
    c.addEventListener("click", () => {
      if (statusFilter.has(s)) statusFilter.delete(s); else statusFilter.add(s);
      const on = statusFilter.has(s);
      c.classList.toggle("active", on);
      c.setAttribute("aria-pressed", on ? "true" : "false");
      renderResults(tasks, results);
      syncClear();
    });
    chips.appendChild(c);
  }

  const clear = el("button", { type: "button", class: "filter-clear" }, "Clear filters");
  clear.addEventListener("click", () => {
    taskSearch = "";
    statusFilter.clear();
    search.value = "";
    chips.querySelectorAll(".filter-chip").forEach((c) => {
      c.classList.remove("active");
      c.setAttribute("aria-pressed", "false");
    });
    renderResults(tasks, results);
    syncClear();
  });
  function syncClear() { clear.style.display = filterActive() ? "" : "none"; }
  syncClear();

  bar.appendChild(search);
  chips.appendChild(clear);
  bar.appendChild(chips);
  return bar;
}

// Render the active table + Finished section into `container`, applying the
// current filter. Called on first paint and on every search/chip change. When a
// filter is active, the Finished section auto-expands if it has matches and its
// count shows "matches of total" so it's clear the view is filtered.
function renderResults(tasks, container) {
  container.innerHTML = "";
  const filtering = filterActive();
  const active = tasks.filter((t) => ACTIVE_STATUSES.includes(t.status));
  const history = tasks.filter((t) => !ACTIVE_STATUSES.includes(t.status));
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
  const sec = el("div", { class: "history" + (open ? " open" : "") , style: "margin-top:24px" });
  const countLabel = filtering ? `${tasks.length} of ${totalCount}` : String(totalCount);
  const head = el("button", { class: "history-head", type: "button" }, [
    el("span", { class: "caret" }, open ? "▾" : "▸"),
    el("span", { class: "history-title" }, "Finished"),
    el("span", { class: "history-count" }, countLabel),
  ]);
  const body = el("div", { class: "history-body" });
  const fill = (node) => {
    node.innerHTML = "";
    if (tasks.length) node.appendChild(finishedList(tasks));
    else node.appendChild(el("div", { class: "empty" }, "No finished tasks match the filter."));
  };
  if (open) fill(body);

  head.addEventListener("click", () => {
    const nowOpen = !sec.classList.contains("open");
    sec.classList.toggle("open", nowOpen);
    // Only persist the collapse preference when not filtering — the filter-driven
    // auto-expand is transient and shouldn't overwrite the user's saved choice.
    if (!filtering) setHistoryOpen(nowOpen);
    head.querySelector(".caret").textContent = nowOpen ? "▾" : "▸";
    if (nowOpen) fill(body); else body.innerHTML = "";
  });

  sec.appendChild(head);
  sec.appendChild(body);
  return sec;
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
      ${chip(effStatus(t))}${t.conflict ? ' <span class="chip rejected">conflict</span>' : ""}
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
    const action = t.status === "review" ? "review →" : "open →";
    const termLink = isLive(t)
      ? `<a href="#" class="term-link" data-id="${esc(t.id)}">⌗ terminal</a> · ` : "";
    tr.innerHTML = `
      <td class="id">${esc(t.id)}</td>
      <td>${chip(effStatus(t))}${t.conflict ? ' <span class="chip rejected">conflict</span>' : ""}</td>
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
    const caret = el("span", { class: "caret" }, "▸");
    const toggle = el("button", { class: "ci-detail-toggle", type: "button" }, [
      caret, el("span", {}, "output"),
    ]);
    const det = el("div", { class: "ci-detail collapsed" }, [toggle, pre]);
    toggle.addEventListener("click", () => {
      const open = det.classList.toggle("collapsed");
      caret.textContent = open ? "▸" : "▾";
    });
    wrap.appendChild(det);
  }
  return wrap;
}

// ---------- task detail / review ----------
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
    html: chip(effStatus(t))
      + (t.conflict ? ' <span class="chip rejected">conflict</span>' : "")
      + (t.rolled_back_at ? ' <span class="chip rolled-back">rolled back</span>' : ""),
  }));
  // Abort is available from any non-terminal state EXCEPT finalizing, whose merge
  // already landed in main (it auto-completes to merged).
  const canAbort = !["merged", "aborted", "finalizing"].includes(t.status);
  if (canAbort) {
    const abortBtn = el("button", { class: "btn ghost danger-outline", id: "abort" }, "Abort task");
    headerRight.appendChild(abortBtn);
  }
  // Roll back: revert an already-merged task's commits off the default branch.
  // Offered only for a merged task that hasn't already been rolled back and whose
  // merge range was recorded (older merges have no range and can't be reverted
  // automatically — the backend 409s, but we also hide the button for them).
  const canRollback = t.status === "merged" && !t.rolled_back_at
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
    <div class="k">created</div><div class="v">${esc(t.created_at || "—")}</div>
    <div class="k">started</div><div class="v">${esc(t.started_at || "—")}</div>
    <div class="k">completed</div><div class="v">${esc(t.completed_at || "—")}</div>
    <div class="k">merged</div><div class="v">${esc(t.merged_at || "—")}</div>
    ${t.rolled_back_at ? `<div class="k">rolled back</div><div class="v">${esc(t.rolled_back_at)}</div>` : ""}
    ${t.herdr_pane_id ? `<div class="k">herdr pane</div><div class="v">${esc(t.herdr_pane_id)}</div>` : ""}
    ${t.herdr_tab_id ? `<div class="k">herdr tab</div><div class="v">${esc(t.herdr_tab_id)}</div>` : ""}
  </div>`;
  wrap.appendChild(meta);

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

  // prompt
  wrap.appendChild(el("h2", {}, "Prompt"));
  wrap.appendChild(el("pre", { class: "block", html: esc(t.prompt || "—") }));

  // failed dispatch — the agent never got off the ground after the dispatcher
  // exhausted its retries. Surface why (last_dispatch_error) and how many tries
  // it took, plus a Re-queue action that clears the retry state and dispatches
  // again. On success the task flips back to `queued` and this panel disappears.
  // A `failed` task carrying a revert_reason isn't a dispatch failure — its merge
  // fast-forwarded into main but the post-merge verify gate (build + tests) came
  // back RED, so the merge was auto-reverted off main. Surface that distinctly,
  // with the failing build/test output. Re-queue re-launches the agent (worktree
  // + branch were kept) to fix it.
  if (t.status === "failed" && t.revert_reason) {
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
  } else if (t.status === "failed") {
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
    const caret = el("span", { class: "caret" }, liveOutputOpen ? "▾" : "▸");
    const head = el("button", { class: "live-output-head", type: "button" }, [
      caret,
      el("span", { class: "lo-title" }, "Live output"),
      el("span", { class: "lo-hint" }, "best-effort · updates every few seconds"),
    ]);
    const panel = el("div", { class: "panel live-output" + (liveOutputOpen ? "" : " collapsed") },
      [head, pre]);

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

    head.addEventListener("click", () => {
      liveOutputOpen = !liveOutputOpen;
      panel.classList.toggle("collapsed", !liveOutputOpen);
      caret.textContent = liveOutputOpen ? "▾" : "▸";
      if (liveOutputOpen) startPolling(); else stopLiveOutput();
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

  // diff + review controls (when in review)
  if (t.status === "review") {
    // CI GATE badge — shown BEFORE the diff. Reflects the build/test job butchr
    // runs in the task's worktree on the review transition; updates live via the
    // SSE-driven re-render when CI flips running→pass/fail.
    wrap.appendChild(ciBadge(t));

    wrap.appendChild(el("h2", {}, "Diff vs main"));
    const diffBox = el("div", { class: "diffview" }, [el("div", { class: "meta" }, "loading diff…")]);
    wrap.appendChild(diffBox);
    api("GET", "/tasks/" + id + "/diff")
      .then((d) => { diffBox.innerHTML = renderDiff(d.diff); wireDiff(diffBox); })
      .catch((e) => { diffBox.innerHTML = `<div class="meta">diff error: ${esc(e.message)}</div>`; });

    const controls = el("div", { class: "panel", style: "margin-top:18px" });
    controls.innerHTML = `
      <h2 style="margin-top:0">Review</h2>
      <label class="field">
        <span class="lbl">change request note (required to request changes)</span>
        <textarea id="rnote" placeholder="What needs to change? The notes go back to the same live agent, which keeps working in-context (no restart)."></textarea>
      </label>
      <div class="row">
        <button class="btn success" id="approve">Approve &amp; merge</button>
        <button class="btn danger" id="reject">Request change</button>
        <div class="spacer"></div>
      </div>`;
    wrap.appendChild(controls);
  }

  mount(wrap);

  if (t.status === "failed") {
    document.getElementById("requeue").addEventListener("click", async (ev) => {
      ev.target.disabled = true;
      try {
        await api("POST", "/tasks/" + id + "/requeue");
        toast("re-queued ✓");
        render();
      } catch (e) { toast(e.message, true); ev.target.disabled = false; }
    });
  }

  if (canAbort) {
    document.getElementById("abort").addEventListener("click", async (ev) => {
      const msg = t.status === "running"
        ? "Abort this running task? The agent is stopped and its worktree + branch are discarded without merging."
        : "Abort this task? Its worktree + branch are discarded without merging.";
      if (!confirm(msg)) return;
      ev.target.disabled = true;
      try {
        await api("POST", "/tasks/" + id + "/abort");
        toast("task aborted");
        render();
      } catch (e) { toast(e.message, true); ev.target.disabled = false; }
    });
  }

  if (canRollback) {
    document.getElementById("rollback").addEventListener("click", async (ev) => {
      if (!confirm(
        "Roll back this merged task? Its commits are reverted off the default branch "
        + "with new revert commits. If the revert conflicts with later changes it is "
        + "aborted cleanly and you'll need to revert manually.",
      )) return;
      ev.target.disabled = true;
      try {
        await api("POST", "/tasks/" + id + "/rollback");
        toast("rolled back ✓ — commits reverted on the default branch");
        render();
      } catch (e) { toast(e.message, true); ev.target.disabled = false; }
    });
  }

  if (t.status === "review") {
    document.getElementById("approve").addEventListener("click", async (ev) => {
      // CI gate is advisory, not a hard block: warn on a failed build/tests but let
      // the operator proceed if they confirm.
      if (t.ci_status === "fail") {
        const label = (t.ci_summary || "CI failed").split("\n")[0].trim();
        if (!confirm(`CI failed (${label}). Approve and merge anyway?`)) return;
      }
      ev.target.disabled = true;
      try {
        const r = await api("POST", "/tasks/" + id + "/approve");
        // A merge conflict isn't an error — it's sent back to the live agent to
        // resolve in-context. The SSE refresh will show the task back in running.
        if (r && r.conflictSentBack) {
          toast("Merge conflict — sent back to the agent to resolve");
        } else if (r && r.revertedOnRed) {
          toast("Merged but verify FAILED — auto-reverted off main", true);
        } else {
          toast("approved ✓ — merged, agent wrapping up");
        }
        backToDirectory(t.directory_id);
      } catch (e) { toast(e.message, true); ev.target.disabled = false; }
    });
    document.getElementById("reject").addEventListener("click", async (ev) => {
      const note = document.getElementById("rnote").value.trim();
      if (!note) return toast("change request note is required", true);
      ev.target.disabled = true;
      try {
        await api("POST", "/tasks/" + id + "/reject", { note });
        toast("changes requested");
        backToDirectory(t.directory_id);
      } catch (e) { toast(e.message, true); ev.target.disabled = false; }
    });
  }
}

// Parse a unified diff into per-file groups for a readable, GitHub-style view.
function parseDiff(diff) {
  const files = [];
  let cur = null;
  const start = (header) => {
    cur = { header, path: "", oldPath: "", add: 0, del: 0, binary: false, lines: [] };
    files.push(cur);
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
    if (line.startsWith("@@")) { cur.lines.push({ t: "hunk", text: line }); continue; }
    if (line.startsWith("+")) { cur.add++; cur.lines.push({ t: "add", text: line }); continue; }
    if (line.startsWith("-")) { cur.del++; cur.lines.push({ t: "del", text: line }); continue; }
    if (line.startsWith("\\")) { cur.lines.push({ t: "ctx", text: line }); continue; } // "No newline…"
    if (line.length) cur.lines.push({ t: "ctx", text: line });
  }
  return files;
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
    const body = f.binary
      ? `<div class="diff-binary">Binary file not shown</div>`
      : f.lines.map((l) => {
          const sign = l.t === "add" ? "+" : l.t === "del" ? "−" : l.t === "hunk" ? "" : " ";
          const text = l.t === "add" || l.t === "del" ? l.text.slice(1) : l.text;
          return `<div class="dl ${l.t}"><span class="dl-sign">${sign}</span><span class="dl-text">${esc(text)}</span></div>`;
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

// Collapse/expand individual file cards.
function wireDiff(box) {
  box.querySelectorAll(".diff-file-head").forEach((head) => {
    head.addEventListener("click", () => head.parentElement.classList.toggle("collapsed"));
  });
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
  if (na.review) parts.push(`${na.review} review`);
  if (na.failed) parts.push(`${na.failed} failed`);
  node.textContent = String(na.total);
  node.title = "Needs attention: " + parts.join(", ");
  node.hidden = false;
}

// Fire a desktop notification when a task NEWLY enters review/failed (count went
// up since the last poll). Fully gated on granted permission, so it's silent until
// the operator opts in by clicking the header indicator (see wireAttention).
function maybeNotify(na) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  if (!lastAttention) return; // first poll — establish a baseline, don't alert
  const newReview = na.review - lastAttention.review;
  const newFailed = na.failed - lastAttention.failed;
  if (newReview <= 0 && newFailed <= 0) return;
  const bits = [];
  if (newReview > 0) bits.push(`${newReview} ready for review`);
  if (newFailed > 0) bits.push(`${newFailed} failed to dispatch`);
  try {
    new Notification("butchr — needs attention", { body: bits.join(", "), tag: "butchr-attention" });
  } catch (e) { /* notifications unavailable — ignore */ }
}

async function updateAttention() {
  let na;
  try {
    const health = await api("GET", "/health");
    na = health && health.needsAttention;
  } catch (e) {
    return; // transient (e.g. degraded /health 503) — keep the last badge
  }
  if (!na) return;
  applyTitleBadge(na.total);
  applyAttentionIndicator(na);
  maybeNotify(na);
  lastAttention = { review: na.review, failed: na.failed, total: na.total };
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
updateAttention();
render();
connectSSE();
