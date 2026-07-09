// The PROJECTS modal cluster — the three dialogs the projects surfaces open: create a
// project, launch an initiative against its repos, and register a new member workspace.
// They sit together because they share one shape: build a `.m-body` + `.m-foot`, mount it
// through openModal's scaffold, surface the server's error INLINE in `.m-error` (never only
// as a transient toast), and on success close + render().
//
// DOM-free at module load, like everything under components/: nothing here touches `document`
// until a function is CALLED. Nothing here imports app.js — the projects views call IN.
import { el } from "../core/dom.js";
import { api, toast } from "../core/api.js";
import { repoDisplay } from "../core/format.js";
import { Button, action } from "./button.js";
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
  // Both fields are held from creation. `#np-brief`'s id AND its data-restore-key are a contract
  // with app.js's restore-uistate pass (and the shape test/app-restore-uistate.test.ts mirrors).
  const anchorEl = el("select", { id: "np-anchor" }, el("option", { value: "" }, "loading workspaces…"));
  const briefEl = el("textarea", {
    id: "np-brief",
    "data-restore-key": "new-project-brief",
    placeholder: "Describe the project in a sentence or two…",
  });
  const body = el("div", { class: "m-body" }, [
    el("label", { class: "field" }, [
      el("span", { class: "lbl" }, "anchor workspace — the project's home directory (the CEO agent's launch cwd)"),
      anchorEl,
    ]),
    el("label", { class: "field tight" }, [
      el("span", { class: "lbl" }, "brief — what this project should deliver across its repos"),
      briefEl,
    ]),
    el("small", { class: "hint muted" },
      "A project registers repos and coordinates cross-repo initiatives via a CEO agent."),
  ]);

  const foot = el("div", { class: "m-foot" });
  const errEl = el("span", { class: "m-error hint" }, "");
  const submit = Button({ label: "Create project" });
  const { close } = openModal({ title: "New project", body, footer: foot });
  const cancel = Button({ label: "Cancel", class: "ghost", onClick: close });
  foot.appendChild(errEl);
  foot.appendChild(cancel);
  foot.appendChild(submit);

  function showErr(msg) { errEl.textContent = msg || ""; errEl.classList.toggle("on", !!msg); }

  // Populate the anchor dropdown. On failure or an empty registry, disable submit with an
  // honest message rather than letting the create 404 later.
  submit.disabled = true;
  try {
    const workspaces = await api("GET", "/workspaces");
    if (!workspaces.length) {
      anchorEl.replaceChildren(el("option", { value: "" }, "no workspaces registered"));
      showErr("Register a workspace first — a project anchors to an existing directory.");
    } else {
      anchorEl.replaceChildren(...workspaces.map((w) => el("option", { value: w.id }, w.label || w.path)));
      submit.disabled = false;
      briefEl.focus();
    }
  } catch (e) {
    anchorEl.replaceChildren(el("option", { value: "" }, "could not load workspaces"));
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
  const submit = Button({ label: "Launch" });
  const { close } = openModal({ title: "Launch initiative", body, footer: foot });
  const cancel = Button({ label: "Cancel", class: "ghost", onClick: close });
  foot.appendChild(errEl);
  foot.appendChild(cancel);
  foot.appendChild(submit);

  function showErr(msg) { errEl.textContent = msg || ""; errEl.classList.toggle("on", !!msg); }

  // THE LIVE FIELDS OF THE CURRENT DRAW. draw() re-runs on every mode toggle and REASSIGNS these;
  // the submit handler below reads them at CLICK time, so it always sees the nodes the current
  // draw painted. `rows` is reset by draw() — a stale target row from a previous draw surviving
  // into submit would launch an initiative against a repo the operator had removed.
  let rows = [];              // fanout: [{ row, repoSel, briefTa }]
  let singleRepoSel = null;   // single: the #li-repo <select>
  let singleBriefTa = null;   // single: the .tgt-brief <textarea>

  // Returns a <select> NODE (it used to return markup). Setting `.value` after the options are
  // appended selects the matching one — no `selected` attribute needed.
  function repoSelect(id, selected) {
    const sel = el("select", { id: id || null, class: "tgt-repo" },
      repoOpts.map((o) => el("option", { value: o.id }, o.name)));
    if (selected != null) sel.value = selected;
    return sel;
  }

  function draw() {
    rows = [];
    singleRepoSel = null;
    singleBriefTa = null;
    if (!repoOpts.length) {
      body.replaceChildren(el("div", { class: "empty" }, "Register at least one repo before launching an initiative."));
      submit.disabled = true;
      return;
    }
    submit.disabled = false;

    // The seg tabs are hand-built, NOT Button(): Button force-prefixes `btn ` onto its class, and
    // `.seg > button` is styled standalone. They also carry role/aria-selected/data-mode.
    const segBtn = (m, label) => {
      const b = el("button", {
        type: "button",
        "data-mode": m,
        class: mode === m ? "on" : "",
        role: "tab",
        "aria-selected": String(mode === m),
      }, label);
      b.addEventListener("click", () => { mode = m; showErr(""); draw(); });
      return b;
    };
    const seg = el("div", { class: "seg", role: "tablist", "aria-label": "Initiative scope" }, [
      segBtn("single", "Single repo"),
      segBtn("fanout", "Cross-repo fan-out"),
    ]);

    if (mode === "single") {
      singleRepoSel = repoSelect("li-repo");
      singleBriefTa = el("textarea", { class: "tgt-brief", placeholder: "Describe the initiative for this repo…" });
      body.replaceChildren(
        seg,
        el("label", { class: "field" }, [el("span", { class: "lbl" }, "repo"), singleRepoSel]),
        el("label", { class: "field tight" }, [
          el("span", { class: "lbl" }, "brief — what to build in this repo"),
          singleBriefTa,
        ]),
        el("small", { class: "hint muted" },
          "A single-repo initiative sends a directive to that repo’s CTO, who " +
          "decomposes it into stories — it’s tracked here (and on that repo’s board). " +
          "Use fan-out to coordinate several repos under one rolled-up initiative."),
      );
      singleBriefTa.focus();
    } else {
      const wrap = el("div", { id: "targets" });
      const addRow = (sel) => {
        const repoSel = repoSelect(null, sel);
        const briefTa = el("textarea", { class: "tgt-brief", placeholder: "Brief for this repo…" });
        // `.icon-btn` is a STANDALONE class (style.css), not a `.btn` modifier — Button would
        // emit `btn icon-btn` and visibly restyle it. Hand-built on purpose.
        const rm = el("button", {
          type: "button", class: "icon-btn", title: "Remove target", "aria-label": "Remove target",
        }, "×");
        const row = el("div", { class: "target-row" }, [repoSel, briefTa, rm]);
        const entry = { row, repoSel, briefTa };
        rm.addEventListener("click", () => {
          if (rows.length > 1) {
            wrap.removeChild(row);
            rows.splice(rows.indexOf(entry), 1);
          } else toast("keep at least one target");
        });
        rows.push(entry);
        wrap.appendChild(row);
      };
      const addTgt = Button({
        label: "+ Add target",
        class: "ghost xs add-target",
        type: "button",
        onClick: () => addRow(repoOpts[0].id),
      });
      addTgt.id = "addTgt";
      body.replaceChildren(
        seg,
        el("span", { class: "lbl" }, "targets — one {repo, brief} per repo; add as many as you need"),
        wrap,
        addTgt,
      );
      addRow(repoOpts[0].id);
      addRow((repoOpts[1] || repoOpts[0]).id);
    }
  }
  draw();

  // Not `Button({onAction})` — see the note on openNewStoryModal's submit in views/workspace.js:
  // action() disables + toasts unconditionally, but these submits validate first and surface the
  // error INLINE in .m-error with the button left live.
  submit.addEventListener("click", () => {
    if (!repoOpts.length) return;
    showErr("");
    if (mode === "single") {
      const repo = singleRepoSel.value;
      const brief = singleBriefTa.value.trim();
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
      const targets = [];
      for (const { repoSel, briefTa } of rows) {
        const repo = repoSel.value;
        const brief = briefTa.value.trim();
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
  // `#aw-path`'s id is a CROSS-MODULE contract: overlay.js's openPicker seeds itself from
  // document.getElementById("aw-path"). Do not rename it.
  const pathEl = el("input", { type: "text", id: "aw-path", placeholder: "/home/you/code/project" });
  const labelEl = el("input", { type: "text", id: "aw-label", placeholder: "defaults to dir name" });

  // Browse the filesystem for a git repo — reuse the shared picker FILL-ONLY: whichever way the user
  // picks (a git-row "Register" button or "Use this path"), we just drop the path into the field and
  // let them confirm via the modal's submit. Registration goes through THIS project's endpoint.
  const browse = Button({
    label: "Browse…",
    class: "ghost",
    type: "button",
    onClick: () => openPicker((picked) => { pathEl.value = picked; pathEl.focus(); }),
  });
  browse.id = "aw-browse";

  const body = el("div", { class: "m-body" }, [
    el("label", { class: "field tight" }, [
      el("span", { class: "lbl" }, "path to a git repository"),
      el("div", { class: "field-row" }, [pathEl, browse]),
    ]),
    el("label", { class: "field tight" }, [
      el("span", { class: "lbl" }, "label (optional)"),
      labelEl,
    ]),
    el("small", { class: "hint muted" }, [
      "Registers an existing git repository and nests it under this project. The gate is the repo's own ",
      el("code", {}, "./scripts/ci"),
      ".",
    ]),
  ]);

  const foot = el("div", { class: "m-foot" });
  const errEl = el("span", { class: "m-error hint" }, "");
  const submit = Button({ label: "Add workspace" });
  const { close } = openModal({ title: "Add workspace", body, footer: foot });
  const cancel = Button({ label: "Cancel", class: "ghost", onClick: close });
  foot.appendChild(errEl);
  foot.appendChild(cancel);
  foot.appendChild(submit);

  function showErr(msg) { errEl.textContent = msg || ""; errEl.classList.toggle("on", !!msg); }

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
