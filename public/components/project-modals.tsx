// The PROJECTS modal cluster — the three dialogs the projects surfaces open: create a project,
// launch an initiative against its repos, and register a new member workspace.
//
// They sit together because they share one shape: a `.m-body` + `.m-foot`, mounted through the
// shared modal scaffold, surfacing the server's error INLINE in `.m-error` (never only as a
// transient toast), and on success closing and refreshing.
//
// RFC §7.2 calls this "the biggest single win of the migration: hand-rolled form state and
// validation go away." What actually went away, named:
//   • `el("textarea", …)` plus reading `.value` back off held nodes → controlled `TextField` /
//     `TextArea` / `Input`.
//   • The Add-workspace modal's hand-rolled "keydown is Enter, so submit" loop over its fields →
//     `<Form onSubmit>`, which is what an Enter key already means. (That loop was ALSO a live bug
//     once: it named a `gateEl` binding that had been deleted, and reading it threw a
//     ReferenceError before either listener was attached.)
//   • `showErr()` toggling an `.on` class on a held `<span>` → a `message` state and `<ModalError>`.
//   • The launch modal's `draw()` — a full manual repaint on every mode toggle, with three
//     module-level cells (`rows`, `singleRepoSel`, `singleBriefTa`) that it reassigned and the
//     submit handler read back at click time, guarded by a comment warning that a stale row "would
//     launch an initiative against a repo the operator had removed." That is a render.
//
// WHAT DID NOT GO AWAY, AND WHY. The submits still validate by hand and surface the message in
// `.m-error` rather than adopting `FieldError` + `isRequired`. RAC's native copy is "Please fill
// out this field"; butchr's is "Describe the project first." / "Fill in at least one target
// brief." — which name the thing you actually failed to do. And `.m-error` has to exist regardless,
// because it is where the SERVER's 400/404/409 lands verbatim: a field-level error cannot carry
// "project <id> still has 3 registered repo(s); unregister them first".
//
// THE INLINE ERROR IS SET INSIDE `onAction`, THEN RETHROWN — exactly as the vanilla submits did.
// `useAction` swallows the rejection (it toasts and re-enables), so a `.catch()` on its `run()`
// never fires. The only place that can see the server's message is the call itself.
//
// The `<select>`s stay native. LaunchPad exports `Select`, but RFC §7.2's own component list for
// these three forms does not name it, a native `<select>` is already keyboard- and
// screen-reader-complete, and swapping in a `Popover`-backed listbox buys nothing here.
import { Button, Form, IconButton, Input, Label, TextArea, TextField } from "@launchpad-ui/components";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { api } from "../core/api.js";
import { repoDisplay } from "../core/format.js";
import { bumpRefresh } from "../core/refresh.js";
import type { Project, Repo, Workspace } from "../core/types.js";
import { useAction } from "./button.tsx";
import { DirectoryPicker, ModalError, ModalShell } from "./overlay.tsx";
import { toast } from "./toast.js";

// localStorage key for the defensive fallback set of project ids this browser created. Purely a
// belt-and-braces record; the list always renders from the authoritative GET /api/projects.
const CREATED_PROJECTS_KEY = "butchr-created-projects";
function rememberCreatedProject(id: string | undefined): void {
  if (!id) return;
  try {
    const raw = localStorage.getItem(CREATED_PROJECTS_KEY);
    const ids: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(ids) && ids.indexOf(id) === -1) {
      ids.push(id);
      localStorage.setItem(CREATED_PROJECTS_KEY, JSON.stringify(ids));
    }
  } catch {
    /* ignore — the server list is authoritative regardless */
  }
}

/** The shared footer: inline error, Cancel, submit. All three modals have exactly this.
 *  The submit is `type="submit"` and carries NO `onPress` — the enclosing `<Form onSubmit>` is the
 *  single entry point, so a click and an Enter key cannot fire the action twice. */
function ModalFoot({
  error,
  onCancel,
  submitLabel,
  isDisabled,
}: {
  error: string;
  onCancel: () => void;
  submitLabel: string;
  isDisabled?: boolean;
}) {
  return (
    <div className="m-foot">
      <ModalError message={error} />
      <Button variant="minimal" type="button" onPress={onCancel}>
        Cancel
      </Button>
      <Button type="submit" variant="primary" isDisabled={isDisabled}>
        {submitLabel}
      </Button>
    </div>
  );
}

/** Every modal's body is a `<Form>` so Enter submits; the foot rides inside it for the same reason. */
function ModalForm({ onSubmit, children }: { onSubmit: () => void; children: ReactNode }) {
  return (
    <Form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="m-form"
    >
      {children}
    </Form>
  );
}

// ---------- create project ----------

/**
 * Anchor-workspace dropdown from `GET /api/workspaces`; brief textarea. Submit →
 * `POST /api/projects { workspace, brief }`. On success the returned project's id is remembered in
 * localStorage as a fallback and a refresh lists it from the server.
 *
 * The brief no longer carries a `data-restore-key`. That attribute existed so app.js's
 * `restoreUiState()` could re-apply typed text after `mount()` destroyed the DOM on an SSE event.
 * Nothing destroys it now (RFC §1.4), and the whole harness is deleted.
 */
export function NewProjectModal({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (o: boolean) => void }) {
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [anchor, setAnchor] = useState("");
  const [brief, setBrief] = useState("");
  const [error, setError] = useState("");

  // Populate the anchor dropdown on open. On failure or an empty registry, disable submit with an
  // honest message rather than letting the create 404 later.
  useEffect(() => {
    if (!isOpen) return;
    setError("");
    setWorkspaces(null);
    api<Workspace[]>("GET", "/workspaces").then(
      (ws) => {
        setWorkspaces(ws);
        setAnchor(ws[0]?.id ?? "");
        if (!ws.length) setError("Register a workspace first — a project anchors to an existing directory.");
      },
      (e: Error) => {
        setWorkspaces([]);
        setError(e.message);
      },
    );
  }, [isOpen]);

  const { run, pending } = useAction(
    async () => {
      let created: { id?: string };
      try {
        created = await api<{ id?: string }>("POST", "/projects", { workspace: anchor, brief: brief.trim() });
      } catch (e) {
        setError((e as Error).message); // 404 missing workspace — inline, not just a toast
        throw e; // let useAction toast + re-enable the button
      }
      rememberCreatedProject(created?.id);
      return created;
    },
    {
      success: "project created",
      onDone: () => {
        onOpenChange(false);
        setBrief("");
        bumpRefresh();
      },
    },
  );

  const submit = () => {
    if (!anchor) return setError("Pick an anchor workspace first.");
    if (!brief.trim()) return setError("Describe the project first.");
    setError("");
    void run();
  };

  const noWorkspaces = !!workspaces && workspaces.length === 0;

  return (
    <ModalShell isOpen={isOpen} onOpenChange={onOpenChange} title="New project">
      <ModalForm onSubmit={submit}>
        <div className="m-body">
          <label className="field">
            <span className="lbl">
              anchor workspace — the project&rsquo;s home directory (the CEO agent&rsquo;s launch cwd)
            </span>
            <select value={anchor} onChange={(e) => setAnchor(e.target.value)} disabled={!workspaces || noWorkspaces}>
              {!workspaces ? (
                <option value="">loading workspaces…</option>
              ) : noWorkspaces ? (
                <option value="">no workspaces registered</option>
              ) : (
                workspaces.map((w) => (
                  <option value={w.id} key={w.id}>
                    {w.label || w.path}
                  </option>
                ))
              )}
            </select>
          </label>
          <TextField className="field tight" value={brief} onChange={setBrief} autoFocus>
            <Label className="lbl">brief — what this project should deliver across its repos</Label>
            <TextArea className="lp-ta" placeholder="Describe the project in a sentence or two…" />
          </TextField>
          <small className="hint muted">
            A project registers repos and coordinates cross-repo initiatives via a CEO agent.
          </small>
        </div>
        <ModalFoot
          error={error}
          onCancel={() => onOpenChange(false)}
          submitLabel="Create project"
          isDisabled={!workspaces || noWorkspaces || pending}
        />
      </ModalForm>
    </ModalShell>
  );
}

// ---------- launch initiative ----------

type Target = { repo: string; brief: string };

/**
 * A segmented toggle switches between the two backend shapes on
 * `POST /api/projects/:id/initiatives` — each lands a CEO DIRECTIVE per repo for its CTO to accept
 * and decompose (the CEO no longer forges the story itself):
 *
 *   Single repo        → `{ repo, brief }`
 *   Cross-repo fan-out → `{ targets: [{ repo, brief }] }`   (repeatable, atomic all-or-nothing)
 *
 * A 409 (non-member repo) is shown INLINE, not just toasted. Submit is disabled with an honest
 * message when the project has no member repos.
 */
export function LaunchInitiativeModal({
  isOpen,
  onOpenChange,
  project,
  repos,
  wsById,
}: {
  isOpen: boolean;
  onOpenChange: (o: boolean) => void;
  project: Project;
  repos: Repo[];
  wsById: Map<string, Workspace>;
}) {
  const repoOpts = (repos || []).map((r) => ({ id: r.id, name: repoDisplay(r, wsById).name }));
  const [mode, setMode] = useState<"single" | "fanout">("single");
  const [single, setSingle] = useState<Target>({ repo: "", brief: "" });
  const [targets, setTargets] = useState<Target[]>([]);
  const [error, setError] = useState("");

  // Re-seed the rows from the CURRENT repo list every time the modal opens. The vanilla `draw()`
  // reset `rows = []` for exactly this reason: a target row left over from a previous open could
  // name a repo the operator has since unregistered.
  useEffect(() => {
    if (!isOpen) return;
    const ids = (repos || []).map((r) => r.id);
    setError("");
    setMode("single");
    setSingle({ repo: ids[0] ?? "", brief: "" });
    setTargets([
      { repo: ids[0] ?? "", brief: "" },
      { repo: ids[1] ?? ids[0] ?? "", brief: "" },
    ]);
  }, [isOpen, repos]);

  const post = (body: unknown) =>
    api("POST", "/projects/" + encodeURIComponent(project.id) + "/initiatives", body).catch((e: Error) => {
      setError(e.message); // 409 non-member repo — surfaced inline
      throw e;
    });

  const done = () => {
    onOpenChange(false);
    bumpRefresh();
  };

  const singleAction = useAction(() => post({ repo: single.repo, brief: single.brief.trim() }), {
    success: () => {
      const name = repoOpts.find((o) => o.id === single.repo)?.name || single.repo;
      return "directive sent to " + name + "’s CTO — track it here once decomposed";
    },
    onDone: done,
  });

  // Blank-brief rows are SKIPPED, not rejected — the two seeded rows mean "up to two", not "two".
  const filled = targets.filter((t) => t.brief.trim());
  const fanoutAction = useAction(() => post({ targets: filled.map((t) => ({ repo: t.repo, brief: t.brief.trim() })) }), {
    success: () =>
      `${filled.length} directive${filled.length === 1 ? "" : "s"} fanned out to ` +
      `${filled.length} repo CTO${filled.length === 1 ? "" : "s"}`,
    onDone: done,
  });

  const submit = () => {
    if (!repoOpts.length) return;
    setError("");
    if (mode === "single") {
      if (!single.brief.trim()) return setError("Write a brief first.");
      void singleAction.run();
    } else {
      if (!filled.length) return setError("Fill in at least one target brief.");
      void fanoutAction.run();
    }
  };

  const repoSelect = (value: string, onChange: (v: string) => void, id?: string) => (
    <select id={id} className="tgt-repo" value={value} onChange={(e) => onChange(e.target.value)}>
      {repoOpts.map((o) => (
        <option value={o.id} key={o.id}>
          {o.name}
        </option>
      ))}
    </select>
  );

  const pending = singleAction.pending || fanoutAction.pending;

  return (
    <ModalShell isOpen={isOpen} onOpenChange={onOpenChange} title="Launch initiative">
      <ModalForm onSubmit={submit}>
        <div className="m-body">
          {!repoOpts.length ? (
            <div className="empty">Register at least one repo before launching an initiative.</div>
          ) : (
            <>
              {/* The seg tabs stay hand-built: `.seg > button` is styled standalone and they carry
                  role/aria-selected. LaunchPad's `ToggleButtonGroup` would swap the whole class
                  contract for a control that already works. */}
              <div className="seg" role="tablist" aria-label="Initiative scope">
                {(["single", "fanout"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="tab"
                    aria-selected={mode === m}
                    className={mode === m ? "on" : ""}
                    onClick={() => {
                      setMode(m);
                      setError("");
                    }}
                  >
                    {m === "single" ? "Single repo" : "Cross-repo fan-out"}
                  </button>
                ))}
              </div>

              {mode === "single" ? (
                <>
                  <label className="field">
                    <span className="lbl">repo</span>
                    {repoSelect(single.repo, (repo) => setSingle((s) => ({ ...s, repo })), "li-repo")}
                  </label>
                  <TextField
                    className="field tight"
                    value={single.brief}
                    onChange={(brief) => setSingle((s) => ({ ...s, brief }))}
                    autoFocus
                  >
                    <Label className="lbl">brief — what to build in this repo</Label>
                    <TextArea className="lp-ta tgt-brief" placeholder="Describe the initiative for this repo…" />
                  </TextField>
                  <small className="hint muted">
                    A single-repo initiative sends a directive to that repo&rsquo;s CTO, who decomposes it into
                    stories — it&rsquo;s tracked here (and on that repo&rsquo;s board). Use fan-out to coordinate
                    several repos under one rolled-up initiative.
                  </small>
                </>
              ) : (
                <>
                  <span className="lbl">targets — one {"{repo, brief}"} per repo; add as many as you need</span>
                  <div id="targets">
                    {targets.map((t, i) => (
                      // eslint-disable-next-line react/no-array-index-key -- rows have no stable id
                      <div className="target-row" key={i}>
                        {repoSelect(t.repo, (repo) =>
                          setTargets((rows) => rows.map((r, j) => (i === j ? { ...r, repo } : r))),
                        )}
                        <TextField
                          value={t.brief}
                          onChange={(brief) => setTargets((rows) => rows.map((r, j) => (i === j ? { ...r, brief } : r)))}
                          aria-label={`Brief for target ${i + 1}`}
                        >
                          <TextArea className="lp-ta tgt-brief" placeholder="Brief for this repo…" />
                        </TextField>
                        <IconButton
                          icon="cancel"
                          aria-label="Remove target"
                          variant="minimal"
                          size="small"
                          className="icon-btn"
                          onPress={() => {
                            if (targets.length > 1) setTargets((rows) => rows.filter((_, j) => j !== i));
                            else toast("keep at least one target");
                          }}
                        />
                      </div>
                    ))}
                  </div>
                  <Button
                    variant="minimal"
                    size="small"
                    type="button"
                    className="add-target"
                    onPress={() => setTargets((rows) => [...rows, { repo: repoOpts[0].id, brief: "" }])}
                  >
                    + Add target
                  </Button>
                </>
              )}
            </>
          )}
        </div>
        <ModalFoot
          error={error}
          onCancel={() => onOpenChange(false)}
          submitLabel="Launch"
          isDisabled={!repoOpts.length || pending}
        />
      </ModalForm>
    </ModalShell>
  );
}

// ---------- add workspace ----------

/**
 * The CONTEXTUAL create: register an EXISTING git directory AND nest its repo node under THIS
 * project atomically via `POST /api/projects/:id/workspaces { path, label }`. This is the only way
 * to add a workspace (the loose/top-level register form was removed), so it owns the path/label
 * fields the retired global form used, plus a Browse… that reuses the picker as a FILL-ONLY
 * directory browser — registration always goes through THIS project's endpoint.
 *
 * `#aw-path` IS GONE. The picker used to seed itself by reaching for that id with
 * `document.getElementById` — a cross-module contract annotated "Do not rename it" in one file and
 * relied upon in another. It is `seed={path}` now.
 */
export function AddWorkspaceModal({
  isOpen,
  onOpenChange,
  project,
}: {
  isOpen: boolean;
  onOpenChange: (o: boolean) => void;
  project: Project;
}) {
  const [path, setPath] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState("");
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    if (isOpen) setError("");
  }, [isOpen]);

  const { run, pending } = useAction(
    // Omit a blank label so the server keeps its default (dir-name label).
    async () => {
      try {
        return await api("POST", "/projects/" + encodeURIComponent(project.id) + "/workspaces", {
          path: path.trim(),
          label: label.trim() || undefined,
        });
      } catch (e) {
        setError((e as Error).message); // 400 non-git-repo / 404 project gone — inline, verbatim
        throw e;
      }
    },
    {
      success: "workspace registered",
      onDone: () => {
        onOpenChange(false);
        setPath("");
        setLabel("");
        bumpRefresh();
      },
    },
  );

  const submit = () => {
    if (!path.trim()) return setError("Enter (or browse to) a git repository path.");
    setError("");
    void run();
  };

  return (
    <>
      <ModalShell isOpen={isOpen} onOpenChange={onOpenChange} title="Add workspace">
        <ModalForm onSubmit={submit}>
          <div className="m-body">
            <TextField className="field tight" value={path} onChange={setPath} autoFocus>
              <Label className="lbl">path to a git repository</Label>
              <div className="field-row">
                <Input placeholder="/home/you/code/project" />
                <Button variant="minimal" type="button" onPress={() => setPicking(true)}>
                  Browse…
                </Button>
              </div>
            </TextField>
            <TextField className="field tight" value={label} onChange={setLabel}>
              <Label className="lbl">label (optional)</Label>
              <Input placeholder="defaults to dir name" />
            </TextField>
            <small className="hint muted">
              Registers an existing git repository and nests it under this project. The gate is the repo&rsquo;s own{" "}
              <code>./scripts/ci</code>.
            </small>
          </div>
          <ModalFoot error={error} onCancel={() => onOpenChange(false)} submitLabel="Add workspace" isDisabled={pending} />
        </ModalForm>
      </ModalShell>
      {/* FILL-ONLY: whichever way the operator picks (a git row's Register, or "Use this path"), we
          only drop the path into the field. Registration goes through this project's endpoint. */}
      <DirectoryPicker isOpen={picking} onOpenChange={setPicking} seed={path} onSelect={(picked) => setPath(picked)} />
    </>
  );
}
