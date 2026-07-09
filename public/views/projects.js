// The PROJECTS views — the global overview at `#/projects` and a single project's detail page
// at `#/projects/:id`. The final pair of views extracted from app.js (RFC Phase 2), leaving that
// file as router + bootstrap only.
//
// It owns both route entry points (`renderProjects`, `renderProjectDetail` — the module's whole
// public surface) plus every helper they need: the overview's CEO pill and initiative-rollup line
// (`ceoPill`, `projectInitiativesLine`, `projectInitiativeRollup`), the initiative derivations
// shared by both surfaces (`initiativeHeading`, `initiativeRollup`), the managed CEO-agent card
// (`ceoStatusPill`, `ceoNoteHtml`, `ceoTerminalBtnState`, `buildCeoCard`, `ceoPanel`), the detail
// page's panels (`reposPanel`, `unregisterRepo`, `initiativesPanel`, `initiativeMarkup`), and the
// Delete-project danger zone (`projectDangerZone`, `confirmDeleteProject`).
//
// The six PURE, DOM-free derivation helpers are also exported — not for another view, but because
// test/projects-initiatives-ui.test.ts and test/projects-ceo-ui.test.ts import and assert on them
// directly. They used to be fenced by `<test-extract:...>` sentinels and eval'd out of the classic
// public/app.js script with `new Function`, because that script could not be imported. That harness
// is gone; do not reintroduce a sentinel. Every other helper here stays module-private.
//
// It imports only LEAVES — `core/` (dom, format, api, nav, action) and `components/` (chips,
// overlay, project-modals). It NEVER imports app.js: that edge would drag app.js's `document`-
// touching boot into every view's module graph and break `bun test`. See the header of core/nav.js.
// The dependency stays inverted — app.js registers its route dispatcher with nav.js, and this view
// imports `render`/`mount` from that leaf.
//
// DOM-free at module load: `document` is touched only inside a CALLED function, exactly like
// views/metrics.js, views/workspace.js and views/swimlanes.js.
import { el, esc } from "../core/dom.js";
import { projectTitle, repoDisplay } from "../core/format.js";
import { api, terminalToast, toast } from "../core/api.js";
import { action } from "../components/button.js";
import { mount, render } from "../core/nav.js";
import { chip, kindBadge } from "../components/chips.js";
import { openModal } from "../components/overlay.js";
import { openAddWorkspaceModal, openLaunchModal, openNewProjectModal } from "../components/project-modals.js";

// ---------- projects overview (REVAMP-4 tier UI) ----------
// The global PROJECTS overview: a CEO-tier project registers repos and coordinates
// cross-repo initiatives.

// CEO status pill derived from the LIST row's `ceo_enabled` ALONE — the overview must
// not assert a resolved on/off it cannot know. Three-way + honest:
//   1    → "CEO enabled"  (.chip.enabled)  explicit override on
//   0    → "CEO disabled" (.chip.disabled) explicit override off
//   null → "CEO default"  (.chip.inactive, neutral) inherits the global gate
// The fully-resolved state (enabled/globalGate/live) belongs on the detail CEO card
// via GET /api/projects/:id/ceo — NOT here (no extra fetch on the overview).
function ceoPill(p) {
  if (p && p.ceo_enabled === 1) return { cls: "enabled", label: "CEO enabled" };
  if (p && p.ceo_enabled === 0) return { cls: "disabled", label: "CEO disabled" };
  return { cls: "inactive", label: "CEO default", title: "Inherits the global CEO gate (BUTCHR_CEO_AGENT)" };
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

export async function renderProjects() {
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

// ---------- project DETAIL view (REVAMP-4 tier UI) ----------
// A single project's page: header (brief/anchor/status), the managed CEO card, a Repos panel to
// register / unregister member repos, the cross-repo Initiatives panel, and the danger zone.
// Reached by clicking a card on the overview (#/projects/:id).
//
// Repo rows have NO path/label of their own: listProjectRepos returns work_kind='repo'
// task rows whose id === their directory id (REVAMP-4 S0a). We resolve each id to a
// human path/label against GET /api/workspaces (fetched alongside the members). The same
// workspaces list, minus the current members, is the "Add repo" picker's option set.

// The pure resolution helper (repoDisplay) lives in core/format.js — it is DOM-free and
// shared, and is unit-tested there via a real import.

// Pure, DOM-free initiative heading + rollup derivation, unit-tested in
// test/projects-initiatives-ui.test.ts, which imports the three exports below directly.
//
// A cross-repo InitiativeView (GET /api/projects/:id/initiatives) has NO top-level brief — each
// per-repo child story carries its own — so derive a compact panel heading from the FIRST child's
// brief (first line, clamped). Falls back to the initiative id when no child has a brief, so the
// row never renders blank.
export function initiativeHeading(init) {
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
export function initiativeRollup(init) {
  const kids = (init && init.children) || [];
  const total = kids.length;
  const done = kids.filter((c) => c && c.status === "done").length;
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}
// The project-level "X/Y initiatives done" rollup for the overview card — counts DONE
// initiatives using the server's authoritative `done` boolean on each InitiativeView. Only
// cross-repo initiatives appear in the list (single-repo ones are ungrouped), so this counts
// those. Returns { done, total, pct }.
export function projectInitiativeRollup(inits) {
  const list = Array.isArray(inits) ? inits : [];
  const total = list.length;
  const done = list.filter((i) => i && i.done).length;
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}

// ---------- managed CEO agent (PER-PROJECT, REVAMP-4 P3c) ----------
// The tier-above analog of ctoPanel (components/cto-panel.js): a project node's managed CEO-agent card on
// the project-detail view. Fed by GET /api/projects/:id/ceo → { enabled, overridden, globalGate,
// live }, ALL RESOLVED server-side — `enabled` already folds the per-project override vs the
// global gate, so the pill/toggle-checked state read straight off it (never ceo_enabled alone,
// which is the overview's coarser ceoPill). Mirrors ctoPanel: fetched async, mounted in place
// via a slot replace, fail-soft on a status-probe hiccup.

// Pure, DOM-free CEO status-pill + note derivation, unit-tested in test/projects-ceo-ui.test.ts
// (the honest-gate matrix that feature #4 hinges on), which imports the three exports below directly.
//
// The status pill, derived from the RESOLVED fields: live wins (green), else enabled (blue),
// else a disabled project that's merely INHERITING the default reads the neutral "CEO default"
// (not "CEO disabled" — nothing was explicitly turned off), and an explicit-off reads "CEO
// disabled". Returns { cls, label, title? }.
export function ceoStatusPill(s) {
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
export function ceoNoteHtml(s) {
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
export function ceoTerminalBtnState(s) {
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

export async function renderProjectDetail(id) {
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
