// The WORKSPACE view — a single repo's page at `#/projects/:pid/workspaces/:wid` (and its legacy
// flat home `#/workspace/:id`). Breadcrumbs, the CTO panel, the New-story launcher, the Pipeline
// body, and the danger zone.
//
// >>> THE LIVE ACTIVITY PULSE IS NOT PORTED, BECAUSE IT HAS BEEN DEAD SINCE 2026-07-08. <<<
// RFC §1.1 row 14 says "`stopActivity` is the second poll timer → `useEffect` cleanup", and that
// would be right if the timer ever ran. It does not, and this is checkable rather than argued:
//
//   • `startActivity()` opens with `if (!document.querySelector(".pulse[data-id]")) return;`
//   • `pollActivity()` opens with `if (!nodes.length) { stopActivity(); return; }`
//   • NOTHING under `public/` has emitted a `.pulse` node since commit f6d2e3a, the dead-code
//     sweep of story st-ef0e7690, which deleted `pulseMarkup()` — the sole producer — from
//     `public/app.js`. Its CHANGELOG entry reads "the live pulse path is `applyPulse` off
//     `activityCache`", but `applyPulse` is reachable only from `pollActivity`, which returns
//     immediately when no `.pulse` node exists. That sweep removed the producer and kept the
//     consumer.
//
// So `activityTimer`, `activityCache`, `applyPulse`, `tickPulseElapsed`, `pollActivity`,
// `startActivity` and `stopActivity` go. Porting them would have meant writing a React effect that
// scrapes the document for elements no component renders — the exact pattern this migration exists
// to delete — to drive a cache nothing reads. `GET /api/work/:id/activity` and `src/transcript.ts`
// are UNTOUCHED (test/activity.test.ts covers them server-side); reviving the pulse means rendering
// the node again, and that is a product decision, not a port.
//
// One consequence, flagged rather than acted on: `pruneWorkCaches` (core/work-graph.ts) existed to
// bound `activityCache` and the swimlanes' module-level `SWIM_DONE_EXPANDED` set. The cache is gone
// and the expanded-pile state is now per-lane component state, which React discards when a story
// leaves the list. `pruneWorkCaches` therefore has no production caller left. It is pure, exported
// and covered by two tests in `test/graph-rollup-completion.test.ts` (which RFC §9.1 marks
// UNTOUCHED), so it stays — deleting it belongs to the dead-code story, st-ef0e7690, not here.
import { Button, Form, Label, TextArea, TextField } from "@launchpad-ui/components";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useAction } from "../components/button.tsx";
import { effStatus } from "../components/chips-logic.ts";
import { CtoPanel } from "../components/cto-panel.tsx";
import { ModalError, ModalShell } from "../components/overlay.tsx";
import { toast } from "../components/toast.ts";
import { api } from "../core/api.ts";
import { projectTitle } from "../core/format.ts";
import { bumpRefresh, useRefreshVersion } from "../core/refresh.ts";
import type { Dashboard, Project, WorkItem } from "../core/types.ts";
import { useAsync } from "../core/use-async.ts";
import { workLeaves, workListPath } from "../core/work-graph.ts";
import { useStateMetaVersion } from "../state-meta-store.ts";
import { Swimlanes } from "./swimlanes.tsx";

/** The launcher's one-line queue summary. Pure. Ordered by urgency, not by status enum: a wedged
 *  agent needing a human is the most urgent line, so it goes first. */
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
 * NOT `ActionButton`: this submit VALIDATES first and surfaces an empty brief inline, leaving the
 * button live. Same reasoning as every submit in components/project-modals.tsx.
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
    if (!brief.trim()) return setError("Describe the story first.");
    setError("");
    void run();
  };

  return (
    <ModalShell isOpen={isOpen} onOpenChange={onOpenChange} title="New story">
      <Form
        className="m-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="m-body">
          <TextField className="field tight" value={brief} onChange={setBrief} autoFocus>
            <Label className="lbl">
              story — a one-line brief; a story leader decomposes it into the subtasks needed to deliver it
            </Label>
            <TextArea className="lp-ta" placeholder="Describe the story in a sentence or two…" />
          </TextField>
          <small className="hint muted">
            The operator creates STORIES; the leader creates + reviews the tasks. Each story&rsquo;s subtask progress
            shows below.
          </small>
        </div>
        <div className="m-foot">
          <ModalError message={error} />
          <Button variant="minimal" type="button" onPress={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" isDisabled={pending}>
            Create story
          </Button>
        </div>
      </Form>
    </ModalShell>
  );
}

export function WorkspaceView({ workspaceId, projectId }: { workspaceId: string; projectId?: string }) {
  const version = useRefreshVersion();
  const metaVersion = useStateMetaVersion();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);

  const { data, error } = useAsync(
    async () => {
      // Pull the workspace from the dashboard rollup alongside its unified work list. The work
      // fetch is best-effort: a failure leaves the Pipeline empty rather than blanking the page.
      const [dash, work] = await Promise.all([
        api<Dashboard>("GET", "/dashboard"),
        api<WorkItem[]>("GET", workListPath(workspaceId)).catch(() => [] as WorkItem[]),
      ]);
      // When reached through the nested project route, resolve the parent project's display name
      // for the breadcrumb. Best-effort and DERIVED FROM THE URL's projectId (not click-set state)
      // so a cold load / pasted URL / refresh all work; a lookup miss falls back to the id.
      let projectName = projectId;
      if (projectId) {
        try {
          projectName = projectTitle(await api<Project>("GET", "/projects/" + encodeURIComponent(projectId))) || projectId;
        } catch {
          /* keep the id fallback */
        }
      }
      return { dash, work, projectName };
    },
    [workspaceId, projectId, version, metaVersion],
  );

  const unregister = useAction(
    async () => {
      await api("DELETE", "/workspaces/" + workspaceId);
      toast("workspace unregistered");
    },
    // Navigates instead of refreshing — the page it would refresh no longer exists.
    { onDone: () => navigate("/projects") },
  );

  if (error && !data) return <div className="empty">error: {error.message}</div>;
  if (!data) return null;

  const { dash, work, projectName } = data;
  const dir = dash.workspaces.find((x) => x.id === workspaceId);
  if (!dir) return <div className="empty">workspace not found</div>;

  const tasks = workLeaves(work);

  return (
    <div>
      {/* Each " / " separator is a REAL text node — a rendered gap between the inline crumbs. */}
      <div className="crumbs">
        <Link to="/projects">Projects</Link>
        {projectId ? (
          <>
            {" / "}
            <Link to={`/projects/${encodeURIComponent(projectId)}`}>{projectName}</Link>
          </>
        ) : null}
        {" / "}
        <span aria-current="page">{dir.label || dir.path}</span>
      </div>
      <h1>{dir.label || dir.path}</h1>
      <div className="path">{dir.path}</div>

      {/* This workspace's managed CTO agent, at the TOP of the page so the operator reaches its
          controls without scrolling past the swimlanes. It fetches its own status and fails soft. */}
      <CtoPanel workspaceId={workspaceId} />

      {/* The create-work launcher. New work is a STORY, not a standalone task: a leader decomposes
          it into subtasks. Standalone task + idea creation are gone (the server rejects them); the
          only leaf creatable directly is a rollback, via the per-task "Roll back" button. Rendered
          UNDER the CTO panel so the CTO controls stay at the top. */}
      <div className="row between stacked">
        <small className="muted">New work is a STORY — a leader decomposes it into subtasks. {queueLine(tasks)}</small>
        <Button variant="primary" onPress={() => setCreating(true)}>
          New story
        </Button>
      </div>
      <NewStoryModal isOpen={creating} onOpenChange={setCreating} workspaceId={workspaceId} />

      {/* The workspace body IS the Pipeline — the sole work view. It shows ALL work (stories as
          lanes, their subtasks as the pipeline within each lane) and re-fetches on every SSE event,
          so it live-updates with no view-mode state to persist. There are no tabs here; RFC §7.2's
          "Tabs (Pipeline / list)" row describes a surface that was removed with the board. */}
      <div className="ws-body">
        <h2>Pipeline</h2>
        <Swimlanes work={work} />
      </div>

      <div className="row ws-danger-zone">
        {/* NOT `ActionButton`'s default dance: this confirm()s first (a cancel must not disable the
            button) and navigates instead of refreshing. */}
        <Button
          variant="destructive"
          className="btn-outline"
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
