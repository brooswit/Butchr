// Task service: create / list / get / diff / approve / reject. The task.md on
// disk is authoritative for prompt+metadata; the DB row tracks runtime state.
import { db, nowIso } from "./db.ts";
import type { TaskRow, TaskStatus } from "./db.ts";
import { HttpError, getDirectory } from "./directories.ts";
import { publish } from "./events.ts";
import * as git from "./git.ts";
import * as herdr from "./herdr.ts";
import { uniqueTaskId } from "./ids.ts";
import {
  appendRejection,
  readTaskMd,
  taskMdPath,
  updateTaskMdStatus,
  writeTaskMd,
} from "./taskmd.ts";
import { existsSync, readFileSync } from "node:fs";

export type TaskView = TaskRow & {
  prompt: string;
  context: string[];
  review_notes: string;
};

export function getTask(id: string): TaskRow | null {
  return (
    db.query<TaskRow, [string]>(`SELECT * FROM tasks WHERE id=?`).get(id) ?? null
  );
}

export function listTasks(directoryId: string): TaskRow[] {
  return db
    .query<TaskRow, [string]>(
      `SELECT * FROM tasks WHERE directory_id=? ORDER BY created_at DESC`,
    )
    .all(directoryId);
}

/** Merge the DB row with the on-disk task.md for the detail view. */
export function taskView(id: string): TaskView | null {
  const row = getTask(id);
  if (!row) return null;
  const dir = getDirectory(row.directory_id);
  let prompt = "";
  let context: string[] = [];
  let review_notes = "";
  if (dir) {
    const p = taskMdPath(dir.path, id);
    if (existsSync(p)) {
      try {
        const doc = readTaskMd(dir.path, id);
        prompt = doc.prompt;
        context = doc.meta.context;
        review_notes = doc.reviewNotes;
      } catch {
        /* ignore parse errors */
      }
    }
  }
  return { ...row, prompt, context, review_notes };
}

function emitUpdated(id: string): void {
  const v = taskView(id);
  if (v) publish({ type: "task.updated", task: v });
}

export async function createTask(
  directoryId: string,
  prompt: string,
  context: string[] = [],
): Promise<TaskView> {
  const dir = getDirectory(directoryId);
  if (!dir) throw new HttpError(404, `directory not found: ${directoryId}`);
  if (!prompt || !prompt.trim()) {
    throw new HttpError(400, "prompt is required");
  }

  const id = uniqueTaskId((cand) => getTask(cand) !== null);
  const created = nowIso();

  // Filesystem artifact first: worktree + task.md. If either fails, no DB row.
  await git.createWorktree(dir.path, id);
  writeTaskMd(
    dir.path,
    { id, created, status: "queued", context },
    prompt,
  );

  db.query(
    `INSERT INTO tasks (id, directory_id, status, created_at)
     VALUES (?, ?, 'queued', ?)`,
  ).run(id, directoryId, created);

  const view = taskView(id)!;
  publish({ type: "task.created", task: view });
  return view;
}

/** Compute the diff of a task branch vs its directory's default branch. */
export async function taskDiff(id: string): Promise<string> {
  const row = getTask(id);
  if (!row) throw new HttpError(404, `task not found: ${id}`);
  const dir = getDirectory(row.directory_id);
  if (!dir) throw new HttpError(404, "directory not found");
  return git.diff(dir.path, id);
}

export async function approveTask(id: string): Promise<TaskView> {
  const row = getTask(id);
  if (!row) throw new HttpError(404, `task not found: ${id}`);
  if (row.status !== "review") {
    throw new HttpError(409, `task is not in review (status=${row.status})`);
  }
  const dir = getDirectory(row.directory_id);
  if (!dir) throw new HttpError(404, "directory not found");

  const result = await git.merge(dir.path, id);
  if (!result.ok) {
    // Hold in review, flag the conflict for manual resolution.
    db.query(
      `UPDATE tasks SET conflict=1, review_note=? WHERE id=?`,
    ).run(result.message, id);
    emitUpdated(id);
    throw new HttpError(
      409,
      result.conflict
        ? `merge conflict — resolve manually, then approve again: ${result.message}`
        : `merge failed: ${result.message}`,
    );
  }

  // Cleanup worktree + branch, mark merged.
  await git.cleanup(dir.path, id);
  db.query(
    `UPDATE tasks SET status='merged', conflict=0, merged_at=?, herdr_pane_id=NULL WHERE id=?`,
  ).run(nowIso(), id);
  updateTaskMdStatus(dir.path, id, "merged");

  emitUpdated(id);
  return taskView(id)!;
}

export async function rejectTask(id: string, note: string): Promise<TaskView> {
  const row = getTask(id);
  if (!row) throw new HttpError(404, `task not found: ${id}`);
  if (row.status !== "review") {
    throw new HttpError(409, `task is not in review (status=${row.status})`);
  }
  if (!note || !note.trim()) throw new HttpError(400, "rejection note is required");
  const dir = getDirectory(row.directory_id);
  if (!dir) throw new HttpError(404, "directory not found");

  const when = nowIso();
  appendRejection(dir.path, id, note, when);

  // Back to queued — dispatcher re-runs into the SAME worktree/branch.
  db.query(
    `UPDATE tasks SET status='queued', review_note=?, herdr_pane_id=NULL, output_snapshot=NULL, conflict=0 WHERE id=?`,
  ).run(note.trim(), id);
  updateTaskMdStatus(dir.path, id, "queued");

  emitUpdated(id);
  return taskView(id)!;
}

// --- dispatcher-facing state transitions (kept here so all writes live together) ---

export function markRunning(id: string, paneId: string): void {
  db.query(
    `UPDATE tasks SET status='running', herdr_pane_id=?, started_at=COALESCE(started_at, ?) WHERE id=?`,
  ).run(paneId, nowIso(), id);
  const row = getTask(id);
  if (row) {
    const dir = getDirectory(row.directory_id);
    if (dir) updateTaskMdStatus(dir.path, id, "running");
  }
  emitUpdated(id);
}

export function markReview(id: string, snapshot: string): void {
  db.query(
    `UPDATE tasks SET status='review', completed_at=?, output_snapshot=?, herdr_pane_id=NULL WHERE id=?`,
  ).run(nowIso(), snapshot, id);
  const row = getTask(id);
  if (row) {
    const dir = getDirectory(row.directory_id);
    if (dir) updateTaskMdStatus(dir.path, id, "review");
  }
  emitUpdated(id);
}

export function backToQueued(id: string): void {
  db.query(
    `UPDATE tasks SET status='queued', herdr_pane_id=NULL WHERE id=?`,
  ).run(id);
  emitUpdated(id);
}
