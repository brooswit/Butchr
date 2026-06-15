// Story service: create / get / list / update / delete stories + assign a task to a
// story. A STORY is a CONTAINER that GROUPS subtasks (tasks carry a nullable story_id
// FK — see the `stories` table + tasks.story_id column in db.ts).
//
// PHASE 1 — DATA MODEL + CRUD ONLY. This is the persistence foundation, fully INERT:
// nothing in the dispatch / review / lifecycle / responder / channel machinery reads a
// story or a task's story_id yet. Later phases add a story-leader agent (a mini-CTO that
// decomposes / feedbacks / merges) + a responder-escalation chain that consume it. This
// module mirrors the shape of src/workspaces.ts (a thin CRUD service over the DB).
import { ALL_STATUSES, db, isTerminal, nowIso } from "./db.ts";
import type { StoryRow, StoryStatus, TaskKind, TaskRow, TaskStatus } from "./db.ts";
import { publish } from "./events.ts";
import { generateStoryId } from "./ids.ts";
import {
  onStoryCreated,
  onStoryStatusChanged,
  storyAgentStatus,
  stopStoryAgent,
} from "./story-agent.ts";
import type { StoryAgentStatus } from "./story-agent.ts";
import { abortTask, createTask, getTask, taskView } from "./tasks.ts";
import type { TaskView } from "./tasks.ts";
import { HttpError, getWorkspace, listWorkspaces } from "./workspaces.ts";

// The three valid story statuses (mirrors the StoryStatus union in db.ts). Used to
// validate an incoming status before it touches the row.
const STORY_STATUSES: ReadonlySet<string> = new Set<StoryStatus>(["open", "done", "aborted"]);

/** Look up a story by its id, or null if none matches. */
export function getStory(id: string): StoryRow | null {
  return db.query<StoryRow, [string]>(`SELECT * FROM stories WHERE id=?`).get(id) ?? null;
}

/** A workspace's stories, newest-first (mirrors listTasks' ordering). */
export function listStories(workspaceId: string): StoryRow[] {
  return db
    .query<StoryRow, [string]>(
      `SELECT * FROM stories WHERE workspace_id=? ORDER BY created_at DESC`,
    )
    .all(workspaceId);
}

/** Mint a story id not already taken (mirrors uniqueTaskId's retry shape). */
function uniqueStoryId(): string {
  for (let i = 0; i < 100; i++) {
    const id = generateStoryId();
    if (!getStory(id)) return id;
  }
  // Astronomically unlikely; fall back to extra entropy.
  return `${generateStoryId()}-${generateStoryId().slice(3)}`;
}

/**
 * Create a story in a workspace. 404 if the workspace is gone; 400 if the brief is
 * blank. Lands `open` with the current timestamp. Returns the new row. PURELY a
 * grouping container this phase — creating a story has no side effects on any task.
 */
export function createStory(workspaceId: string, brief: unknown): StoryRow {
  if (!getWorkspace(workspaceId)) {
    throw new HttpError(404, `workspace not found: ${workspaceId}`);
  }
  if (typeof brief !== "string" || !brief.trim()) {
    throw new HttpError(400, "brief is required");
  }
  const id = uniqueStoryId();
  const created = nowIso();
  db.query(
    `INSERT INTO stories (id, workspace_id, brief, status, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, workspaceId, brief.trim(), "open", created);
  // A new `open` story gets a managed STORY-LEADER agent (Phase 3): mark it desired +
  // launch it. Thin hook into story-agent.ts so the CRUD here stays clean; the hook marks
  // desired synchronously and fires the launch best-effort (never fails story creation).
  onStoryCreated(id);
  return getStory(id)!;
}

/**
 * Apply a PARTIAL update to a story (brief and/or status), by KEY PRESENCE so updating
 * one field never clobbers the other. `brief` must be a non-empty string; `status` must
 * be one of open|done|aborted (400 otherwise). 404 if the story is gone. Returns the
 * refreshed row. A patch with neither recognized key is a no-op refresh.
 */
export function updateStory(
  id: string,
  patch: { brief?: unknown; status?: unknown },
): StoryRow {
  const story = getStory(id);
  if (!story) throw new HttpError(404, `story not found: ${id}`);

  const assigns: string[] = [];
  const params: (string | null)[] = [];
  if (patch.brief !== undefined) {
    if (typeof patch.brief !== "string" || !patch.brief.trim()) {
      throw new HttpError(400, "brief must be a non-empty string");
    }
    assigns.push("brief=?");
    params.push(patch.brief.trim());
  }
  if (patch.status !== undefined) {
    if (typeof patch.status !== "string" || !STORY_STATUSES.has(patch.status)) {
      throw new HttpError(400, "status must be 'open', 'done', or 'aborted'");
    }
    assigns.push("status=?");
    params.push(patch.status);
  }
  if (assigns.length) {
    params.push(id);
    db.query(`UPDATE stories SET ${assigns.join(", ")} WHERE id=?`).run(...params);
  }
  // STORY COMPLETION REPORTED UP (Phase 6): when the leader marks the story `done` (the goal
  // is verified met), report completion UP to the CTO via a story-level attention event
  // targeted at the WORKSPACE/CTO feed ('story <id> complete'). Fire only on the ENTRY into
  // `done` (story.status was not already `done`) so a no-op re-PATCH doesn't re-notify. This
  // is published BEFORE the leader teardown below — the leader (the diff-review responder that
  // merged the last subtask) is provably still up, but the report is for the CTO, not it.
  if (patch.status === "done" && story.status !== "done") {
    publish({
      type: "story.attention",
      story_id: id,
      workspace_id: story.workspace_id,
      target: "cto",
      reason: "complete",
      detail: story.brief ?? null,
    });
  }
  // Drive the STORY-LEADER agent off a status change (Phase 3): `done`/`aborted` stop the
  // leader (desired-down + teardown); `open` (re)launches it. Thin hook into story-agent.ts.
  if (patch.status !== undefined && typeof patch.status === "string") {
    onStoryStatusChanged(id, patch.status);
  }
  return getStory(id)!;
}

/**
 * Delete a story. 404 if it is gone. Member tasks are NOT deleted — their story_id is
 * NULLed out first (tasks are real work; only the grouping goes away), then the story
 * row is removed. (The workspace cascade still removes a workspace's stories wholesale.)
 */
export function deleteStory(id: string): void {
  if (!getStory(id)) throw new HttpError(404, `story not found: ${id}`);
  // Tear down the story's managed STORY-LEADER agent FIRST (desired-down + close its
  // tab/pane + free its name) so the DELETE below — which cascade-removes its story_agent
  // row — can't strand an orphaned leader pane. Best-effort; never blocks delete.
  void stopStoryAgent(id).catch(() => {});
  // Detach member tasks (keep the tasks — only the grouping is removed).
  db.query(`UPDATE tasks SET story_id=NULL WHERE story_id=?`).run(id);
  db.query(`DELETE FROM stories WHERE id=?`).run(id);
}

/**
 * Assign a task to a story (or clear its membership with `storyId === null`). 404 if the
 * task is gone; when assigning, 404 if the story is gone and 400 if the story belongs to a
 * DIFFERENT workspace than the task (the same cross-workspace integrity guard used
 * elsewhere — a task may only join a story IN ITS OWN workspace). Emits `task.updated` so
 * the webapp reflects the new story_id, and returns the refreshed TaskView (on which
 * story_id round-trips via the row spread). PURELY stored this phase.
 */
export function assignTaskToStory(taskId: string, storyId: string | null): TaskView {
  const task: TaskRow | null = getTask(taskId);
  if (!task) throw new HttpError(404, `task not found: ${taskId}`);

  if (storyId !== null) {
    if (typeof storyId !== "string") {
      throw new HttpError(400, "story_id must be a string or null");
    }
    const story = getStory(storyId);
    if (!story) throw new HttpError(404, `story not found: ${storyId}`);
    if (story.workspace_id !== task.workspace_id) {
      throw new HttpError(400, "story belongs to a different workspace than the task");
    }
  }

  db.query(`UPDATE tasks SET story_id=? WHERE id=?`).run(storyId, taskId);
  const view = taskView(taskId)!;
  publish({ type: "task.updated", task: view });
  return view;
}

/**
 * Create a SUBTASK belonging to a story (Phase 5 — the surface the story LEADER uses to
 * decompose its story). 404 if the story is gone; 409 if the story is not `open` (no work
 * can be added to a done/aborted story). Otherwise delegates to tasks.createTask, pinning
 * the new task to the story's OWN workspace and passing story_id — so the subtask is
 * dispatched exactly like any task, and its feedback then routes to the leader via the
 * escalation chain (Phase 2) + story channel (Phase 4). The delegation is ONE-WAY
 * (stories.ts → tasks.ts); createTask re-validates the same-workspace integrity itself.
 */
export async function createSubtask(
  storyId: string,
  args: {
    prompt: string;
    context?: string[];
    blockedBy?: string[];
    kind?: TaskKind;
    model?: string | null;
    tags?: string[];
    priority?: number | string | null;
    planPreview?: boolean;
    idea?: boolean;
    versionBump?: unknown;
    allowlist?: string[];
  },
): Promise<TaskView> {
  const story = getStory(storyId);
  if (!story) throw new HttpError(404, `story not found: ${storyId}`);
  if (story.status !== "open") {
    throw new HttpError(409, `cannot add a subtask to a ${story.status} story`);
  }
  return createTask(
    story.workspace_id,
    args.prompt,
    args.context ?? [],
    args.blockedBy ?? [],
    args.kind ?? "task",
    args.model ?? null,
    args.tags ?? [],
    args.priority ?? 0,
    args.planPreview ?? false,
    args.idea ?? false,
    args.versionBump ?? "patch",
    args.allowlist ?? [],
    story.id,
  );
}

// --- SURFACING: member-task ROLLUP + leader status (Phase 6) -----------------

/**
 * Per-story member-task ROLLUP: one count per canonical status (ALL_STATUSES) plus the
 * orthogonal `idle` pseudo-bucket, MIRRORING workspaces.counts but scoped to a story's
 * members (story_id == storyId) instead of a workspace. `idle` is a flag on a LIVE
 * in_progress agent (not a status), so it is peeled out of the in_progress count the same
 * way the workspace rollup does — keeping the two rollups byte-for-byte comparable.
 */
export function storyCounts(storyId: string): Record<string, number> {
  const rows = db
    .query<{ status: string; n: number }, [string]>(
      `SELECT status, COUNT(*) AS n FROM tasks WHERE story_id=? GROUP BY status`,
    )
    .all(storyId);
  const out: Record<string, number> = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0]));
  out.idle = 0;
  for (const r of rows) out[r.status] = r.n;
  const idle = db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM tasks WHERE story_id=? AND status='in_progress' AND herdr_pane_id IS NOT NULL AND idle=1`,
    )
    .get(storyId)!.n;
  out.idle = idle;
  out.in_progress -= idle;
  return out;
}

/**
 * A STORY DETAIL VIEW (Phase 6): the StoryRow plus a member-task `counts` rollup
 * (storyCounts — the same per-status shape the workspace views use) and the managed
 * LEADER-agent status (storyAgentStatus). Async because the leader status probes herdr
 * for live registration (mirrors workspaces' status reads). Powers GET /api/stories/:id
 * + the operator's story-progress surface so a reader sees each story's progress + its
 * leader in one call. Returns null if the story is gone.
 */
export type StoryView = StoryRow & {
  counts: Record<string, number>;
  leader: StoryAgentStatus;
};

export async function storyView(storyId: string): Promise<StoryView | null> {
  const story = getStory(storyId);
  if (!story) return null;
  return {
    ...story,
    counts: storyCounts(storyId),
    leader: await storyAgentStatus(storyId),
  };
}

/** A workspace's stories as enriched StoryViews (newest-first; mirrors listStories' order).
 *  Leader probes run concurrently (Promise.all). */
export async function listStoryViews(workspaceId: string): Promise<StoryView[]> {
  const views = await Promise.all(
    listStories(workspaceId).map((s) => storyView(s.id)),
  );
  return views.filter((v): v is StoryView => v !== null);
}

/** EVERY workspace's stories as enriched StoryViews — the cross-workspace operator surface
 *  behind GET /api/stories (newest-first across all workspaces). */
export async function allStoryViews(): Promise<StoryView[]> {
  const lists = await Promise.all(listWorkspaces().map((w) => listStoryViews(w.id)));
  const out = lists.flat();
  out.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  return out;
}

// --- RESET A STORY: abort all in-flight subtasks (additive convenience) ------

/** The result of resetStory: the refreshed StoryView plus the per-member outcome — which
 *  subtasks were aborted, which failed to abort (best-effort), and which were left untouched
 *  (already terminal, or mid-rollback) with their status. */
export type StoryResetResult = {
  ok: true;
  story: StoryView | null;
  aborted: string[];
  failed: string[];
  skipped: Array<{ id: string; status: TaskStatus }>;
};

/**
 * RESET A STORY: abort ALL of a story's IN-FLIGHT subtasks in one call, so a story leader can
 * 'throw it all away and start over' and then re-decompose. ADDITIVE — it reuses tasks.abortTask
 * verbatim (signalAbort + worktree teardown + the `aborted` transition + task.updated SSE) and
 * does NOT touch the story row: the story stays `open` for the leader to re-decompose.
 *
 * A member is RESETTABLE iff it is neither terminal (isTerminal — merged/aborted/failed/
 * rolled_back) nor `rolling_back` (mid-rollback-pipeline work that reset must NOT yank). Those
 * non-resettable members are left exactly as they are and reported in `skipped` (with status).
 * Aborting is best-effort PER member — a teardown failure on one is collected in `failed` and
 * never strands the rest. 404 if the story is gone. Returns the per-member outcome + a fresh
 * StoryView. (Aborting members can never trip isStoryComplete — aborted ≠ merged/rolled_back —
 * so no spurious story-completion event fires.)
 */
export async function resetStory(storyId: string): Promise<StoryResetResult> {
  if (!getStory(storyId)) throw new HttpError(404, `story not found: ${storyId}`);

  const members = db
    .query<{ id: string; status: TaskStatus }, [string]>(
      `SELECT id, status FROM tasks WHERE story_id=?`,
    )
    .all(storyId);

  const aborted: string[] = [];
  const failed: string[] = [];
  const skipped: Array<{ id: string; status: TaskStatus }> = [];
  for (const m of members) {
    // Leave terminal AND mid-rollback members untouched — reset only yanks in-flight work.
    if (isTerminal(m.status) || m.status === "rolling_back") {
      skipped.push({ id: m.id, status: m.status });
      continue;
    }
    try {
      await abortTask(m.id);
      aborted.push(m.id);
    } catch {
      // Best-effort: one teardown failure must not strand the rest of the reset.
      failed.push(m.id);
    }
  }

  return { ok: true, story: await storyView(storyId), aborted, failed, skipped };
}
