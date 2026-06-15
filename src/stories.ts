// Story service: create / get / list / update / delete stories + assign a task to a
// story. A STORY is a CONTAINER that GROUPS subtasks (tasks carry a nullable story_id
// FK — see the `stories` table + tasks.story_id column in db.ts).
//
// PHASE 1 — DATA MODEL + CRUD ONLY. This is the persistence foundation, fully INERT:
// nothing in the dispatch / review / lifecycle / responder / channel machinery reads a
// story or a task's story_id yet. Later phases add a story-leader agent (a mini-CTO that
// decomposes / feedbacks / merges) + a responder-escalation chain that consume it. This
// module mirrors the shape of src/workspaces.ts (a thin CRUD service over the DB).
import { db, nowIso } from "./db.ts";
import type { StoryRow, StoryStatus, TaskRow } from "./db.ts";
import { publish } from "./events.ts";
import { generateStoryId } from "./ids.ts";
import { getTask, taskView } from "./tasks.ts";
import type { TaskView } from "./tasks.ts";
import { HttpError, getWorkspace } from "./workspaces.ts";

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
  return getStory(id)!;
}

/**
 * Delete a story. 404 if it is gone. Member tasks are NOT deleted — their story_id is
 * NULLed out first (tasks are real work; only the grouping goes away), then the story
 * row is removed. (The workspace cascade still removes a workspace's stories wholesale.)
 */
export function deleteStory(id: string): void {
  if (!getStory(id)) throw new HttpError(404, `story not found: ${id}`);
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
