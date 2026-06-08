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

let current = null;
async function render() {
  const route = parseHash();
  current = route;
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
  const pills = ["queued", "running", "review", "merged", "rejected"]
    .map((s) => {
      const cls = s === "running" && c[s] ? "count-pill has-running"
        : s === "review" && c[s] ? "count-pill has-review" : "count-pill";
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

  // create-task form
  const form = el("div", { class: "panel", style: "margin-top:18px" });
  form.innerHTML = `
    <h2 style="margin-top:0">New task</h2>
    <label class="field">
      <span class="lbl">prompt</span>
      <textarea id="tprompt" placeholder="Describe the work for the agent…"></textarea>
    </label>
    <div class="row between">
      <small class="muted">Tasks run concurrently, each in its own worktree. ${queueLine(tasks)}</small>
      <button class="btn" id="add-task">Create task</button>
    </div>`;
  wrap.appendChild(form);

  // tasks table
  wrap.appendChild(el("h2", {}, "Tasks"));
  if (tasks.length === 0) {
    wrap.appendChild(el("div", { class: "empty" }, "No tasks yet."));
  } else {
    wrap.appendChild(tasksTable(tasks));
  }

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

  document.getElementById("add-task").addEventListener("click", async () => {
    const prompt = document.getElementById("tprompt").value.trim();
    if (!prompt) return toast("prompt is required", true);
    try {
      await api("POST", "/directories/" + id + "/tasks", { prompt });
      toast("task created");
      render();
    } catch (e) { toast(e.message, true); }
  });
}

function queueLine(tasks) {
  const q = tasks.filter((t) => t.status === "queued").length;
  const r = tasks.filter((t) => t.status === "running").length;
  if (r) return `${r} running, ${q} queued.`;
  if (q) return `${q} queued.`;
  return "Idle.";
}

function tasksTable(tasks) {
  const table = el("table", { class: "tasks" });
  table.innerHTML = `<thead><tr>
    <th>id</th><th>status</th><th>prompt</th><th>created</th><th></th>
  </tr></thead>`;
  const tb = el("tbody");
  for (const t of tasks) {
    const tr = el("tr");
    const action = t.status === "review" ? "review →" : "open →";
    tr.innerHTML = `
      <td class="id">${esc(t.id)}</td>
      <td>${chip(t.status)}${t.conflict ? ' <span class="chip rejected">conflict</span>' : ""}</td>
      <td class="prompt-cell">${esc(t.prompt || t.review_note || "")}</td>
      <td class="when">${esc(fmtTime(t.created_at))}</td>
      <td><a href="#/task/${esc(t.id)}">${action}</a></td>`;
    tb.appendChild(tr);
  }
  table.appendChild(tb);
  return table;
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
  headerRight.appendChild(el("div", { html: chip(t.status) + (t.conflict ? ' <span class="chip rejected">conflict</span>' : "") }));
  wrap.appendChild(el("div", { class: "row between" }, [
    el("h1", { html: `<span style="font-family:var(--mono)">${esc(t.id)}</span>` }),
    headerRight,
  ]));

  // metadata
  const meta = el("div", { class: "panel" });
  meta.innerHTML = `<div class="meta-grid">
    <div class="k">status</div><div class="v">${esc(t.status)}</div>
    <div class="k">created</div><div class="v">${esc(t.created_at || "—")}</div>
    <div class="k">started</div><div class="v">${esc(t.started_at || "—")}</div>
    <div class="k">completed</div><div class="v">${esc(t.completed_at || "—")}</div>
    <div class="k">merged</div><div class="v">${esc(t.merged_at || "—")}</div>
  </div>`;
  wrap.appendChild(meta);

  // prompt
  wrap.appendChild(el("h2", {}, "Prompt"));
  wrap.appendChild(el("pre", { class: "block", html: esc(t.prompt || "—") }));

  // review notes
  if (t.review_notes) {
    wrap.appendChild(el("h2", {}, "Review notes"));
    wrap.appendChild(el("pre", { class: "block", html: esc(t.review_notes) }));
  }

  // output snapshot
  if (t.output_snapshot) {
    wrap.appendChild(el("h2", {}, "Agent output (snapshot)"));
    wrap.appendChild(el("pre", { class: "block", html: esc(t.output_snapshot) }));
  }

  // diff + review controls (when in review)
  if (t.status === "review") {
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
        <textarea id="rnote" placeholder="What needs to change? Appended to task.md; task re-runs."></textarea>
      </label>
      <div class="row">
        <button class="btn success" id="approve">Approve &amp; merge</button>
        <button class="btn danger" id="reject">Request change</button>
        <div class="spacer"></div>
      </div>`;
    wrap.appendChild(controls);
  }

  mount(wrap);

  if (t.status === "review") {
    document.getElementById("approve").addEventListener("click", async (ev) => {
      ev.target.disabled = true;
      try {
        await api("POST", "/tasks/" + id + "/approve");
        toast("merged ✓");
        render();
      } catch (e) { toast(e.message, true); ev.target.disabled = false; }
    });
    document.getElementById("reject").addEventListener("click", async (ev) => {
      const note = document.getElementById("rnote").value.trim();
      if (!note) return toast("change request note is required", true);
      ev.target.disabled = true;
      try {
        await api("POST", "/tasks/" + id + "/reject", { note });
        toast("changes requested — re-queued");
        render();
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
  };
}

let refreshTimer = null;
function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(render, 150);
}

// ---------- boot ----------
window.addEventListener("hashchange", render);
render();
connectSSE();
