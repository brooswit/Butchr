// The PROJECTS modal cluster — the three dialogs the projects surfaces open: create a
// project, launch an initiative against its repos, and register a new member workspace.
// They sit together because they share one shape: build a `.m-body` + `.m-foot`, mount it
// through openModal's scaffold, surface the server's error INLINE in `.m-error` (never only
// as a transient toast), and on success close + render().
//
// DOM-free at module load, like everything under components/: nothing here touches `document`
// until a function is CALLED. Nothing here imports app.js — the projects views call IN.
import { el, esc } from "../core/dom.js";
import { api, toast } from "../core/api.js";
import { repoDisplay } from "../core/format.js";
import { action } from "../core/action.js";
import { render } from "../core/nav.js";
import { openModal, openPicker } from "./overlay.js";

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

// CREATE-PROJECT modal — reuses the openModal/action/api pattern of openNewStoryModal.
// Anchor-workspace dropdown populated from GET /api/workspaces; brief textarea carries a
// data-restore-key so an SSE-driven re-render never wipes in-flight text. Submit →
// POST /api/projects { workspace, brief }; on success add the returned project (server
// returns the full row) via a re-render, remember its id in localStorage as a fallback,
// and surface any error (e.g. 404 missing workspace) inline in .m-error (not only a toast).
export async function openNewProjectModal() {
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

// LAUNCH-INITIATIVE modal — reuses openModal/action/api. A segmented toggle switches between the
// two backend shapes on POST /api/projects/:id/initiatives (each lands a CEO DIRECTIVE per repo for
// its CTO to accept & decompose — the CEO no longer forges the story itself):
//   Single repo      → { repo, brief }         (one member repo + a brief; grouped under an initiative)
//   Cross-repo fan-out → { targets:[{repo,brief}] } (repeatable rows, atomic all-or-nothing)
// Member repos (the select options) come from the project's repos list, resolved to friendly
// names via repoDisplay. A 409 (non-member repo) is shown INLINE in .m-error, not just a toast.
// Submit is disabled with an honest message when the project has no member repos. On a 201 the
// modal closes and the view re-renders (refreshing the list); both shapes now appear in that panel's
// rollup (a pending directive until its CTO decomposes it, then the stories).
export function openLaunchModal(project, repos, wsById) {
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

// ADD-WORKSPACE modal (Hierarchical Projects IA S4) — the CONTEXTUAL create. Register an EXISTING
// git directory AND nest its repo node under THIS project atomically via
// POST /api/projects/:id/workspaces { path, label } (server.ts → registerWorkspaceUnderProject).
// This is now the ONLY way to add a workspace (the loose/top-level register form was removed), so it
// owns the path/label fields the retired global form used, plus a "Browse…" that reuses
// openPicker as a FILL-ONLY directory browser — it drops the chosen path into the field; the actual
// registration always goes through THIS project endpoint, never the loose POST /workspaces. The
// server's errors surface INLINE in .m-error verbatim (400 "not a git repository: <path>", 404 project
// gone), not just a transient toast. On success we close + render() so the new workspace appears as a
// drill-in repo row.
export function openAddWorkspaceModal(project) {
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
  // The list is exactly the fields this modal renders — a third `gateEl` used to be named here
  // after its gate_cmd input was retired, and reading that undeclared binding threw a
  // ReferenceError before either listener (or the focus below) was ever wired.
  for (const inp of [pathEl, labelEl]) {
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doSubmit(); } });
  }
  pathEl.focus();
}
