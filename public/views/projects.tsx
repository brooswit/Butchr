// The PROJECTS views — the global overview at `#/projects` and a single project's detail page at
// `#/projects/:id`: header, the managed CEO card, a Repos panel, the cross-repo Initiatives panel,
// and the Delete-project danger zone.
//
// The five PURE derivations these surfaces read (`ceoPill`, `initiativeHeading`,
// `initiativeRollup`, `projectInitiativeRollup`, `ceoStatusPill`, `ceoTerminalBtnState`) live in
// the DOM-free leaf views/projects-logic.ts. `ceoNote` returns a node, so it stays here.
//
// LAUNCHPAD GIVES THIS FILE `Button`, `Switch` and `Meter`, AND NOTHING ELSE. The overview is a
// grid of CARDS and there is no `Card`; the panels are containers and there is no `Panel`. Both
// stay bespoke on butchr's CSS, re-based on `--lp-*` (RFC §7.1).
//
// WHAT THE REWRITE DELETED HERE, specifically:
//   • `buildCeoCard()` re-fetching `/ceo` and calling `card.replaceWith(buildCeoCard(...))` to swap
//     itself out of the DOM after a write. That is a re-render.
//   • The optimistic-toggle dance that hand-rolled `cb.checked = !want` on failure. `Switch` is
//     controlled; the state IS the fetched value, and a failed PATCH simply doesn't change it.
//   • `unregisterRepo`'s `row.remove()` + `finally { render() }` — an optimistic DOM removal that
//     had to be undone by a full re-render on failure. The row is derived from `repos` now.
import { Button, Switch } from "@launchpad-ui/components";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { ActionButton, useAction } from "../components/button.tsx";
import { StatusChip, KindBadge } from "../components/chips.tsx";
import { ClickableRow } from "../components/clickable.tsx";
import { ModalError, ModalShell } from "../components/overlay.tsx";
import { FractionMeter } from "../components/panel.tsx";
import { AddWorkspaceModal, LaunchInitiativeModal, NewProjectModal } from "../components/project-modals.tsx";
import { terminalToast, toast } from "../components/toast.ts";
import { api } from "../core/api.ts";
import { projectTitle, repoDisplay } from "../core/format.ts";
import { bumpRefresh, useRefreshVersion } from "../core/refresh.ts";
import type { CeoStatus, InitiativeView, Project, Repo, TerminalResult, Workspace } from "../core/types.ts";
import { useAsync } from "../core/use-async.ts";
import {
  ceoPill,
  ceoStatusPill,
  ceoTerminalBtnState,
  initiativeHeading,
  initiativeRollup,
  projectInitiativeRollup,
} from "./projects-logic.ts";

// ---------- projects overview ----------

/** The overview card's initiative rollup line. `inits` is undefined when its fetch failed, in which
 *  case we keep the honest muted placeholder rather than assert a count we don't have. */
function ProjectInitiativesLine({ inits }: { inits: InitiativeView[] | undefined }) {
  if (!inits) return <div className="pc-placeholder muted">initiatives —</div>;
  const roll = projectInitiativeRollup(inits);
  return (
    <div className="swim-prog" title="cross-repo initiatives fully done across their repos">
      <span className="swim-track">
        <i style={{ width: roll.pct + "%" }} />
      </span>
      <span className="swim-prog-txt">
        {roll.done}/{roll.total} initiatives done
      </span>
    </div>
  );
}

export function ProjectsView() {
  const version = useRefreshVersion();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);

  const { data, error } = useAsync(
    async () => {
      const projects = await api<Project[]>("GET", "/projects");
      // `GET /api/projects` carries no rollup counts, so fetch each project's initiatives in
      // parallel. FAIL-SOFT PER CARD: a project whose fetch rejects is left OUT of the map, so its
      // card keeps the muted placeholder instead of breaking the grid.
      const initsByProject = new Map<string, InitiativeView[]>();
      await Promise.all(
        projects.map(async (p) => {
          try {
            initsByProject.set(p.id, await api<InitiativeView[]>("GET", "/projects/" + encodeURIComponent(p.id) + "/initiatives"));
          } catch {
            /* leave unset → placeholder */
          }
        }),
      );
      return { projects, initsByProject };
    },
    [version],
  );

  if (error && !data) return <div className="empty">error: {error.message}</div>;
  if (!data) return null;
  const { projects, initsByProject } = data;

  return (
    <div>
      <div className="page-head">
        <div className="ph-text">
          <h1>Projects</h1>
          <div className="sub">
            Cross-repo initiatives coordinated by a project CEO agent.
            {projects.length ? ` ${projects.length} project${projects.length === 1 ? "" : "s"}.` : ""}
          </div>
        </div>
        <Button variant="primary" onPress={() => setCreating(true)}>
          + New project
        </Button>
      </div>
      <NewProjectModal isOpen={creating} onOpenChange={setCreating} />

      {!projects.length ? (
        <div className="empty">No projects yet — create one to register repos and launch initiatives.</div>
      ) : (
        <div className="grid dirs">
          {projects.map((p) => {
            const pill = ceoPill(p);
            return (
              <ClickableRow
                key={p.id}
                className="card clickable"
                ariaLabel={`Open project ${projectTitle(p)}`}
                onActivate={() => navigate(`/projects/${p.id}`)}
              >
                <div className="pc-head">
                  <div className="title">{projectTitle(p)}</div>
                </div>
                <div className="path">{p.workspace_id}</div>
                {/* the repos rollup is a later subtask's concern; the initiative rollup is filled */}
                <div className="pc-placeholder muted">repos —</div>
                <ProjectInitiativesLine inits={initsByProject.get(p.id)} />
                <div className="pc-foot">
                  <span className={"chip " + pill.cls} title={pill.title}>
                    {pill.label}
                  </span>
                </div>
              </ClickableRow>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------- managed CEO agent (PER-PROJECT) ----------

/**
 * The honest context note under the CEO card, CONDITIONAL on override-vs-inherit so it never
 * contradicts the runtime (`isCeoEnabled`: an explicit override WINS over the global gate, so an
 * explicit-ON CEO runs regardless of the gate). Null for the unambiguous case.
 *
 *   • INHERITING (overridden=false): always note it's inheriting the default; when the global gate
 *     is ALSO off, this is exactly where the gate bites → say so and point at the override.
 *   • OVERRIDDEN-ON while the gate is off: NEVER "inert" — it runs via the override.
 *   • OVERRIDDEN-OFF: explicitly disabled for this project.
 */
export function ceoNote(s: CeoStatus) {
  const env = <code>BUTCHR_CEO_AGENT</code>;
  if (!s.overridden) {
    if (!s.globalGate) {
      return (
        <div className="ceo-note">
          The global CEO gate ({env}) is off, so projects that inherit the default stay disabled. Toggle this project on
          to override and run its CEO regardless.
        </div>
      );
    }
    return (
      <div className="ceo-note inherit">
        Inheriting the global default ({env} is on) — toggle to set an explicit per-project override.
      </div>
    );
  }
  // overridden === true — the per-project value wins; never imply it's inert.
  if (s.enabled && !s.globalGate) {
    return (
      <div className="ceo-note inherit">
        Running via a per-project override; the global CEO gate ({env}) is off, but this project&rsquo;s CEO runs
        regardless.
      </div>
    );
  }
  if (!s.enabled) return <div className="ceo-note inherit">Explicitly disabled for this project.</div>;
  return null;
}

/**
 * The tier-above analog of `CtoPanel`. Fed by `GET /api/projects/:id/ceo` → `{enabled, overridden,
 * globalGate, live}`, ALL RESOLVED SERVER-SIDE — `enabled` already folds the per-project override
 * against the global gate, so the pill and the toggle read straight off it (never `ceo_enabled`
 * alone, which is the overview's coarser `ceoPill`).
 */
function CeoPanel({ projectId }: { projectId: string }) {
  const version = useRefreshVersion();
  const path = "/projects/" + encodeURIComponent(projectId) + "/ceo";
  const { data: s, error } = useAsync<CeoStatus>(() => api<CeoStatus>("GET", path), [path, version]);
  const [toggling, setToggling] = useState(false);

  // Fail-soft (mirrors CtoPanel's catch): a probe hiccup yields a muted card, never a blocked page.
  if (error && !s) {
    return (
      <div className="panel ceo-card">
        <small className="muted">CEO agent status unavailable</small>
      </div>
    );
  }
  if (!s) return <div className="panel ceo-card" />;

  const pill = ceoStatusPill(s);
  const term = ceoTerminalBtnState(s);

  // `Switch` is CONTROLLED off the fetched `enabled`. The vanilla card flipped the checkbox
  // optimistically and hand-restored it on failure (`cb.checked = !want; lbl.textContent = …`);
  // here a failed PATCH simply never changes `s`, so there is nothing to restore.
  const setEnabled = async (want: boolean) => {
    setToggling(true);
    try {
      await api("PATCH", "/projects/" + encodeURIComponent(projectId), { ceo_enabled: want });
      toast(want ? "CEO enabled" : "CEO disabled");
      bumpRefresh();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setToggling(false);
    }
  };

  return (
    <div className="panel ceo-card">
      <div className="panel-head">
        <h2>
          <KindBadge kind="ceo" /> CEO agent
        </h2>
        <span className="spacer" />
        <span className={"chip " + pill.cls} title={pill.title}>
          {pill.label}
        </span>
      </div>
      <div className="ceo-row">
        <Switch isSelected={!!s.enabled} isDisabled={toggling} onChange={(v) => void setEnabled(v)} className="ceo-toggle">
          <span className="ceo-toggle-lbl">{s.enabled ? "Enabled" : "Disabled"}</span>
        </Switch>
        <span className="ceo-life">
          <span className={"ceo-dot " + (s.live ? "alive" : "down")} />
          {s.live ? "CEO agent live" : s.enabled ? "CEO agent starting…" : "CEO agent inactive"}
        </span>
        <span className="spacer" />
        {/* Unlike the CTO button (which HIDES when not running), this stays visible and disables
            with an honest title explaining WHY — the same wording ceoNote uses, so the two cannot
            contradict each other. `onDone` is a no-op: attaching a terminal does not navigate and
            must not refetch the page. */}
        <ActionButton
          label="⌗ Open CEO terminal"
          className="ceo-term"
          title={term.title}
          isDisabled={!term.enabled}
          onAction={async () => terminalToast(await api<TerminalResult>("POST", path + "/terminal"))}
          onDone={() => {}}
        />
        {/* Only present while an explicit override is set. */}
        {s.overridden ? (
          <ActionButton
            label="Reset to default"
            kind="ghost"
            size="small"
            className="ceo-reset"
            title="Clear the per-project override and inherit the global default"
            onAction={async () => {
              await api("PATCH", "/projects/" + encodeURIComponent(projectId), { ceo_enabled: null });
            }}
            success="CEO reset to the global default"
          />
        ) : null}
      </div>
      {ceoNote(s)}
    </div>
  );
}

// ---------- project detail ----------

/** One initiative: a derived heading + short id, its per-repo child rows (resolved repo name +
 *  the shared status chip + the child brief), and a rolled-up doneness bar whose fraction is LOCKED
 *  to the server's `status === 'done'` predicate — so it reads 100% exactly when `init.done`. */
function InitiativeNode({ init, wsById }: { init: InitiativeView; wsById: Map<string, Workspace> }) {
  const roll = initiativeRollup(init);
  return (
    <div className="init">
      <div className="init-head">
        <span className="ib">{initiativeHeading(init)}</span>
        <span className="init-id" title="initiative grouping id">
          {init.initiative_id}
        </span>
      </div>
      <div className="init-targets">
        {(init.children || []).map((c) => {
          const d = repoDisplay({ id: c.workspace_id }, wsById);
          const brief = c.brief && String(c.brief).trim();
          return (
            <div className="init-target" key={c.workspace_id}>
              <span className="tr">{d.name}</span>
              <StatusChip status={c.status} />
              {brief ? <span className="ibr">{brief}</span> : null}
            </div>
          );
        })}
      </div>
      <FractionMeter
        done={roll.done}
        total={roll.total}
        ariaLabel={`${roll.done} of ${roll.total} stories done`}
        label={
          <span className="rollup-frac">
            {roll.done}/{roll.total} <span className="muted">{init.done ? "done — all stories landed" : "stories done"}</span>
          </span>
        }
      />
    </div>
  );
}

function InitiativesPanel({
  project,
  initiatives,
  repos,
  wsById,
}: {
  project: Project;
  initiatives: InitiativeView[];
  repos: Repo[];
  wsById: Map<string, Workspace>;
}) {
  const [launching, setLaunching] = useState(false);
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Initiatives</h2>
        <span className="spacer" />
        <Button variant="primary" onPress={() => setLaunching(true)}>
          Launch initiative
        </Button>
      </div>
      <LaunchInitiativeModal
        isOpen={launching}
        onOpenChange={setLaunching}
        project={project}
        repos={repos}
        wsById={wsById}
      />
      {!initiatives.length ? (
        <div className="empty">No initiatives yet — launch one against a single repo or fan out across several.</div>
      ) : (
        initiatives.map((init) => <InitiativeNode key={init.initiative_id} init={init} wsById={wsById} />)
      )}
    </div>
  );
}

/** The Repos panel: a header with a right-aligned "+ Add workspace", then one row per member repo
 *  (name + mono dir + an unregister ×). The repo IS a workspace/directory node (repo.id === the
 *  workspace id), so the row DRILLS IN to that workspace's work views. */
function ReposPanel({ project, repos, wsById }: { project: Project; repos: Repo[]; wsById: Map<string, Workspace> }) {
  const [adding, setAdding] = useState(false);
  const navigate = useNavigate();

  // Idempotent DELETE. The vanilla version removed the row optimistically and re-rendered in a
  // `finally` so a failure would restore it; the row is derived from `repos` here, so a refresh on
  // BOTH outcomes is all it takes.
  const unregister = async (repo: Repo) => {
    try {
      await api("DELETE", "/projects/" + encodeURIComponent(project.id) + "/repos/" + encodeURIComponent(repo.id));
      toast("repo unregistered");
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      bumpRefresh();
    }
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Repos</h2>
        <span className="spacer" />
        {/* Contextual create: registers an EXISTING git directory and nests it under THIS project
            atomically — the only add path now that loose workspaces are gone. */}
        <Button variant="minimal" size="small" onPress={() => setAdding(true)}>
          + Add workspace
        </Button>
      </div>
      <AddWorkspaceModal isOpen={adding} onOpenChange={setAdding} project={project} />

      {!repos.length ? (
        <div className="empty">No repos registered — add one to target it with an initiative.</div>
      ) : (
        repos.map((repo) => {
          const d = repoDisplay(repo, wsById);
          return (
            <ClickableRow
              key={repo.id}
              className="repo-row clickable"
              ariaLabel={`Open workspace ${d.name}`}
              onActivate={() =>
                navigate(`/projects/${encodeURIComponent(project.id)}/workspaces/${encodeURIComponent(repo.id)}`)
              }
            >
              <span className="ic" aria-hidden="true">
                ◆
              </span>
              <span className="nm">{d.name}</span>
              <span className="rp">{d.dir}</span>
              <span className="spacer" />
              {/* ClickableRow swallows the row activation for any click that originates inside a
                  button, so this needs no stopPropagation of its own. */}
              <button className="icon-btn" title="Unregister repo" aria-label={"Unregister " + d.name} onClick={() => void unregister(repo)}>
                ×
              </button>
            </ClickableRow>
          );
        })
      )}
    </div>
  );
}

/**
 * The Delete-project confirm. Branches on status:
 *   200 → close, navigate back to the overview, success toast.
 *   409 → the server's guard message ("project <id> still has N registered repo(s)…") is shown
 *         VERBATIM inline; the modal STAYS open and nothing navigates.
 *   other non-2xx → thrown, so `useAction` takes the generic error-toast path.
 *
 * `api()` collapses the response to a message string, so this reads `res.status` off a small raw
 * `fetch` to tell the guarded 409 apart. (`api()` is itself only a fetch wrapper.)
 */
function DeleteProjectModal({
  isOpen,
  onOpenChange,
  project,
}: {
  isOpen: boolean;
  onOpenChange: (o: boolean) => void;
  project: Project;
}) {
  const [error, setError] = useState("");
  const navigate = useNavigate();

  const { run, pending } = useAction(
    async () => {
      setError("");
      const res = await fetch("/api/projects/" + encodeURIComponent(project.id), { method: "DELETE" });
      if (res.ok) return;
      const text = await res.text();
      let data: unknown = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        /* non-JSON body */
      }
      const msg =
        (data && typeof data === "object" && "error" in data && typeof data.error === "string" && data.error) ||
        res.statusText;
      if (res.status === 409) setError(msg); // guarded — keep the modal open, show the reason
      throw new Error(msg);
    },
    {
      success: "project deleted",
      onDone: () => {
        onOpenChange(false);
        navigate("/projects");
      },
    },
  );

  return (
    <ModalShell isOpen={isOpen} onOpenChange={onOpenChange} title="Delete project">
      <div className="m-body">
        <p>
          Delete <strong>{projectTitle(project)}</strong>? This removes the project node and its CEO agent. Its
          registered repos and their work are not deleted.
        </p>
      </div>
      <div className="m-foot">
        <ModalError message={error} />
        <Button variant="minimal" onPress={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="destructive" isDisabled={pending} onPress={() => void run()}>
          Delete project
        </Button>
      </div>
    </ModalShell>
  );
}

/** The danger zone at the foot of the detail view. Deliberately the ONLY delete surface: the
 *  overview cards are whole-card click-to-open with no kebab/overflow-menu pattern to reuse. */
function ProjectDangerZone({ project }: { project: Project }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="pd-danger-zone">
      <div className="pd-danger-lbl muted">Danger zone</div>
      <Button variant="destructive" className="btn-outline" onPress={() => setConfirming(true)}>
        Delete project
      </Button>
      <DeleteProjectModal isOpen={confirming} onOpenChange={setConfirming} project={project} />
    </div>
  );
}

export function ProjectDetailView({ projectId }: { projectId: string }) {
  const version = useRefreshVersion();

  const { data, error } = useAsync(
    async () => {
      const id = encodeURIComponent(projectId);
      const [project, repos, workspaces, initiatives] = await Promise.all([
        api<Project>("GET", "/projects/" + id),
        api<Repo[]>("GET", "/projects/" + id + "/repos"),
        api<Workspace[]>("GET", "/workspaces"),
        api<InitiativeView[]>("GET", "/projects/" + id + "/initiatives"),
      ]);
      return { project, repos, wsById: new Map(workspaces.map((w) => [w.id, w])), initiatives };
    },
    [projectId, version],
  );

  // A failure (e.g. a 404 on a stale hash) paints the same `.empty` error every other view does.
  if (error && !data) return <div className="empty">error: {error.message}</div>;
  if (!data) return null;
  const { project, repos, wsById, initiatives } = data;

  return (
    <div>
      <div className="crumbs">
        <Link to="/projects">Projects</Link>
        {" / "}
        <span aria-current="page">{projectTitle(project)}</span>
      </div>

      <div className="page-head">
        <div className="ph-text">
          <h1>{projectTitle(project)}</h1>
          {project.workspace_id ? <div className="path">{project.workspace_id}</div> : null}
          {project.brief ? <div className="sub">{project.brief}</div> : null}
        </div>
        {project.status ? (
          <span className="chip subtle" title="node status (cosmetic)">
            {project.status}
          </span>
        ) : null}
      </div>

      <CeoPanel projectId={projectId} />
      <ReposPanel project={project} repos={repos} wsById={wsById} />
      <InitiativesPanel project={project} initiatives={initiatives} repos={repos} wsById={wsById} />
      <ProjectDangerZone project={project} />
    </div>
  );
}
