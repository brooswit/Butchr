// The WORKSPACE view — a single repo's page at `#/projects/:pid/workspaces/:wid` (and its legacy
// flat home `#/workspace/:id`). Breadcrumbs, the CTO panel, the New-story launcher, the Pipeline
// body, and the danger zone.
//
// >>> THERE ARE NO TABS HERE, AND THE RFC IS WRONG ABOUT THAT. <<<
// RFC §7.2 lists a `Tabs`/`TabList`/`Tab`/`TabPanel` row for "the workspace's Pipeline / list tabs",
// and this subtask's brief repeats it. The surface does not exist. views/workspace.js builds exactly
// one body — `<h2>Pipeline</h2>` over `renderSwimlanes(work)` — and says so in its own comment: "The
// workspace body is the Pipeline (swimlanes) view — the sole work view … with no view-mode state to
// persist." `grep -niE 'tab|view-mode|board' public/views/workspace.js` returns nothing but prose.
// The list/board tabs were removed with the board, before this migration began. Adding a `Tabs` here
// would INVENT a control the operator never had, which is a visual regression in the direction the
// bar for this phase explicitly forbids. `Tabs` is verified present in the installed package; it is
// simply not what this view is made of.
//
// What IS taken from LaunchPad: `Breadcrumbs`/`Breadcrumb` for the crumbs (through the shell's
// `RouterProvider`, so they navigate the hash router), `TextField`/`Label`/`TextArea` for the
// New-story brief, `Button` everywhere, and `ModalShell` (`ModalOverlay`+`Modal`+`Dialog`) for the
// modal — which brings the focus trap the hand-rolled `openModal` never had.
//
// >>> AND THE PROGRESS "ROLLUP BARS" ARE NOT `ProgressBar`/`Meter` EITHER. <<<
// The brief asks for them. This view has no rollup bar at all — the only bar on the page is the
// lane-header sparkline inside views/swimlanes.tsx, and that file's header says, at length, why
// `Meter` is the wrong component for a 96×6px inline track that already prints "3 / 7 done" beside
// it. Both names exist in the package; neither has a call site here.
//
// >>> THE LIVE ACTIVITY PULSE IS NOT PORTED, BECAUSE IT HAS BEEN DEAD SINCE THE DEAD-CODE SWEEP. <<<
// RFC §1.1 row 14 says "`stopActivity` is the second poll timer → `useEffect` cleanup", and that
// would be right if the timer ever ran. It does not, and this is checkable rather than argued:
//
//   • `startActivity()` opens with `if (!document.querySelector(".pulse[data-id]")) return;`
//   • `pollActivity()` opens with `if (!nodes.length) { stopActivity(); return; }`
//   • NOTHING under `public/` emits a `.pulse` node. The sole producer, `pulseMarkup()`, was deleted
//     by the dead-code sweep of story st-ef0e7690, which removed the producer and kept the consumer.
//     Re-verified by grep at this commit: the only `.pulse` strings left in the tree are the CSS
//     rules and workspace.js's own dead selectors.
//
// So `activityTimer`, `activityCache`, `applyPulse`, `tickPulseElapsed`, `pollActivity`,
// `startActivity` and `stopActivity` go. Porting them would mean writing a React effect that scrapes
// the document for elements no component renders — the exact pattern this migration exists to
// delete — to drive a cache nothing reads. `GET /api/work/:id/activity` and `src/transcript.ts` are
// UNTOUCHED (test/activity.test.ts covers them server-side); reviving the pulse means rendering the
// node again, and that is a product decision, not a port.
//
// One consequence, flagged rather than acted on: `pruneWorkCaches` (core/work-graph.ts) existed to
// bound `activityCache` and the swimlanes' module-level `SWIM_DONE_EXPANDED` Set. The cache is gone
// and the expanded-pile state is per-lane component state now, which React discards when a story
// leaves the list. `pruneWorkCaches` therefore has no production caller left. It is pure, exported
// and covered by two tests in test/graph-rollup-completion.test.ts, so it stays — deleting it is the
// dead-code story's call (st-ef0e7690), not this phase's.
import { Breadcrumb, Breadcrumbs, Button, Label, Link as LpLink, TextArea, TextField } from "@launchpad-ui/components";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { look, useAction } from "../components/button.tsx";
import { effStatus } from "../components/chips-logic.js";
import { CtoPanel } from "../components/cto-panel.tsx";
import { ModalError, ModalShell } from "../components/overlay.tsx";
import { toast } from "../components/toast.js";
import { api } from "../core/api.js";
import { projectTitle } from "../core/format.js";
import { bumpRefresh, useRefreshVersion } from "../core/refresh.js";
import type { Dashboard, Project, WorkItem } from "../core/types.js";
import { useAsync } from "../core/use-async.js";
import { workLeaves, workListPath } from "../core/work-graph.js";
import { useStateMetaVersion } from "../state-meta-store";
import { Swimlanes } from "./swimlanes.tsx";

/** The launcher's one-line queue summary. Pure, and character-for-character the vanilla's ordering:
 *  by URGENCY, not by status enum — a wedged agent needing a human is the most urgent line, so it
 *  goes first. */
export function queueLine(tasks: WorkItem[]): string {
  const count = (p: (t: WorkItem) => boolean) => tasks.filter(p).length;
  const idea = count((t) => t.status === "idea");
  const specRev = count((t) => t.status === "spec_review");
  const b = count((t) => t.status === "blocked");
  const ni = count((t) => t.status === "needs_info");
  const ready = count((t) => t.status === "inactive");
  const nui = count((t) => effStatus(t) === "needs_user_input");
  const r = count((t) => t.status === "in_progress" && !t.idle && !t.needs_user_input);
  const i = count((t) => t.status === "in_progress" && !!t.idle && !t.needs_user_input);
  const inRev = count((t) => t.status === "in_review");
  const rb = count((t) => t.status === "rolling_back");

  const parts: string[] = [];
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

/**
 * The New-story modal: jot a one-line brief and POST it to `/api/workspaces/:id/work`. butchr lands
 * the story `open` and launches its leader, which creates and reviews the subtasks; the new story
 * surfaces via the SSE-driven refresh.
 *
 * NOT an `ActionButton`: this submit VALIDATES first and surfaces an empty brief INLINE in
 * `.m-error`, leaving the button live. That is why it drives `useAction`'s `run` by hand — the same
 * reason the vanilla hand-rolled this click rather than routing it through `action()`.
 *
 * NO `<Form>` WRAPPER. `.modal` is a flex column whose `.m-body` scrolls between a fixed `.m-head`
 * and `.m-foot`; a `<form>` between them becomes the flex item and the body stops shrinking. The
 * vanilla had no form either — this is a textarea, where Enter means newline, not submit.
 *
 * `#ns-brief` is preserved: CHANGELOG names it a published contract of this modal's shape.
 */
function NewStoryModal({
  isOpen,
  onOpenChange,
  workspaceId,
}: {
  isOpen: boolean;
  onOpenChange: (o: boolean) => void;
  workspaceId: string;
}) {
  const [brief, setBrief] = useState("");
  const [error, setError] = useState("");

  // Clear a stale error when the modal is reopened. The brief itself is cleared on SUCCESS only, so
  // a failed POST does not discard what the operator typed.
  useEffect(() => {
    if (isOpen) setError("");
  }, [isOpen]);

  const { run, pending } = useAction(() => api("POST", "/workspaces/" + workspaceId + "/work", { brief: brief.trim() }), {
    success: "story created",
    onDone: () => {
      onOpenChange(false);
      setBrief("");
      bumpRefresh();
    },
  });

  const submit = () => {
    if (!brief.trim()) {
      setError("Describe the story first.");
      return;
    }
    setError("");
    void run();
  };

  return (
    <ModalShell isOpen={isOpen} onOpenChange={onOpenChange} title="New story">
      <div className="m-body">
        <TextField className="field tight" value={brief} onChange={setBrief} autoFocus>
          <Label className="lbl">
            story — a one-line brief; a story leader decomposes it into the subtasks needed to deliver it
          </Label>
          <TextArea id="ns-brief" placeholder="Describe the story in a sentence or two…" />
        </TextField>
        <small className="hint muted">
          The operator creates STORIES; the leader creates + reviews the tasks. Each story&rsquo;s subtask progress shows
          below.
        </small>
      </div>
      <div className="m-foot">
        <ModalError message={error} />
        <Button {...look({ kind: "ghost" })} onPress={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button {...look({ kind: "primary" })} isDisabled={pending} onPress={submit}>
          Create story
        </Button>
      </div>
    </ModalShell>
  );
}

export function WorkspaceView({ workspaceId, projectId }: { workspaceId: string; projectId?: string }) {
  const version = useRefreshVersion();
  const metaVersion = useStateMetaVersion();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);

  const { data, error } = useAsync(async () => {
    // Pull the workspace from the dashboard rollup alongside its unified work list (leaf tasks +
    // node stories — see workListPath). The work fetch is best-effort: a failure leaves the Pipeline
    // empty rather than blanking the page, exactly as the vanilla's `.catch(() => [])` did.
    const [dash, work] = await Promise.all([
      api<Dashboard>("GET", "/dashboard"),
      api<WorkItem[]>("GET", workListPath(workspaceId)).catch(() => [] as WorkItem[]),
    ]);
    // When reached through the nested project route, resolve the parent project's display name for
    // the breadcrumb back-link. Best-effort and DERIVED FROM THE URL's projectId (not click-set
    // state) so a cold load / pasted URL / SSE re-render all work identically; a lookup miss falls
    // back to the id so the crumb never blanks or crashes.
    let projectName = projectId;
    if (projectId) {
      try {
        projectName = projectTitle(await api<Project>("GET", "/projects/" + encodeURIComponent(projectId))) || projectId;
      } catch {
        /* keep the id fallback */
      }
    }
    return { dash, work, projectName };
  }, [workspaceId, projectId, version, metaVersion]);

  const unregister = useAction(
    async () => {
      await api("DELETE", "/workspaces/" + workspaceId);
      toast("workspace unregistered");
    },
    // Navigates instead of refreshing — the page it would refresh no longer exists. The vanilla set
    // `location.hash = "#/"`, which the router rewrote to `#/projects`; go there directly.
    { onDone: () => navigate("/projects") },
  );

  // A view that threw painted `<div class="empty">error: …</div>` and nothing else. `useAsync` keeps
  // the last good `data` through a failed re-fetch, so a transient error never blanks a live page.
  if (error && !data) return <div className="empty">error: {error.message}</div>;
  if (!data) return null;

  const { dash, work, projectName } = data;
  const dir = dash.workspaces.find((x) => x.id === workspaceId);
  if (!dir) return <div className="empty">workspace not found</div>;

  // The leaf (task) members of the leaf|node union — used only for the launcher's one-line queue
  // summary. The Pipeline consumes the full union directly.
  const tasks = workLeaves(work);

  return (
    <div>
      {/* `Breadcrumbs` renders the `<ol>`/`<li>` structure and supplies the separator that the
          vanilla spelled as literal " / " text nodes. Its `Link`s resolve through the shell's
          `RouterProvider`, so they are real anchors that navigate the hash router. The last crumb
          carries `aria-current="page"` explicitly: react-aria only sets it on a Breadcrumb that
          contains a Link, and `.crumbs [aria-current="page"]` is what styles it. */}
      <Breadcrumbs className="crumbs">
        <Breadcrumb>
          <LpLink href="/projects">Projects</LpLink>
        </Breadcrumb>
        {projectId ? (
          <Breadcrumb>
            <LpLink href={`/projects/${encodeURIComponent(projectId)}`}>{projectName}</LpLink>
          </Breadcrumb>
        ) : null}
        <Breadcrumb>
          <span aria-current="page">{dir.label || dir.path}</span>
        </Breadcrumb>
      </Breadcrumbs>
      <h1>{dir.label || dir.path}</h1>
      <div className="path">{dir.path}</div>

      {/* This workspace's managed CTO agent (its principal/dev agent, running in the repo root) —
          status + Start/Stop/Restart/Enable + Open-CTO-terminal. Rendered at the TOP of the page so
          the operator reaches the CTO controls without scrolling past the swimlanes. It fetches its
          own status and fails soft. */}
      <CtoPanel workspaceId={workspaceId} />

      {/* The create-work launcher (AUTHORITY FLIP, Phase 7). New work is a STORY, not a standalone
          task: a leader decomposes it into subtasks. Standalone task + idea creation are gone (the
          server rejects them); the only leaf creatable directly is a rollback, via the per-task "Roll
          back" button. Rendered UNDER the CTO panel so the CTO controls stay at the top. */}
      <div className="row between stacked">
        <small className="muted">New work is a STORY — a leader decomposes it into subtasks. {queueLine(tasks)}</small>
        <Button id="new-story" {...look({ kind: "primary" })} onPress={() => setCreating(true)}>
          New story
        </Button>
      </div>
      <NewStoryModal isOpen={creating} onOpenChange={setCreating} workspaceId={workspaceId} />

      {/* The workspace body IS the Pipeline — the sole work view. It shows ALL work (stories as
          lanes, their subtasks as the pipeline within each lane) and re-fetches on every SSE event,
          so it live-updates with no view-mode state to persist. */}
      <div className="ws-body">
        <h2>Pipeline</h2>
        <Swimlanes work={work} />
      </div>

      {/* (The gate is the repo's own `./scripts/ci` — butchr carries zero gate config — so there is
          no per-workspace gate-command panel here. Responder routing is STRUCTURAL — per-task
          pending_responder — so there is no step-responder panel either.) */}

      <div className="row ws-danger-zone">
        {/* GHOST, not destructive. The vanilla passed `class: "ghost"`, and `.ws-danger-zone` is what
            frames this control as dangerous; the abandoned Phase-4 branch made it a red outline,
            which is a look this button has never had. NOT an `ActionButton`: it confirm()s first (a
            cancelled confirm must not disable the button) and navigates instead of refreshing. */}
        <Button
          {...look({ kind: "ghost" })}
          isDisabled={unregister.pending}
          onPress={() => {
            if (!confirm("Unregister this workspace? Non-merged worktrees will be removed.")) return;
            void unregister.run();
          }}
        >
          Unregister workspace
        </Button>
      </div>
    </div>
  );
}
