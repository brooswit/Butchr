// Task service: create / list / get / diff / approve / reject. The task.md on
// disk is authoritative for prompt+metadata; the DB row tracks runtime state.
import { db, nowIso } from "./db.ts";
import type { TaskRow, TaskStatus } from "./db.ts";
import { HttpError, getDirectory } from "./directories.ts";
import { readRunLogSnapshot, signalAbort, startFinalizeWatcher } from "./dispatcher.ts";
import { publish } from "./events.ts";
import { cancelReview, hasPendingReview, resolveReview } from "./review.ts";
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

  // Merge succeeded. Unlike before, we do NOT close the pane or tear down the
  // worktree yet: the agent stays alive to do its post-merge wrap-up (it prints
  // useful summary info). Return "approved" to its blocked request_review call so
  // it knows to finish up; the finalize-watcher closes it + cleans up once it goes
  // idle (or exits / hits finalizeTimeoutMs). The merge has landed, so stamp
  // merged_at now even though the task isn't `merged` until finalize.
  resolveReview(id, { decision: "approved" });
  const res = db.query(
    `UPDATE tasks SET status='finalizing', conflict=0, merged_at=COALESCE(merged_at, ?)
       WHERE id=? AND status='review'`,
  ).run(nowIso(), id);
  if (res.changes === 0) {
    // Raced (e.g. aborted) between the merge and here — the branch already landed
    // in main, but the task moved on. Nothing to finalize.
    emitUpdated(id);
    return taskView(id)!;
  }
  updateTaskMdStatus(dir.path, id, "finalizing");
  emitUpdated(id);

  // Hand the finalizing phase to the dispatcher: it watches for the agent to go
  // quiet/exit and then calls finalizeTask below.
  startFinalizeWatcher(id);
  return taskView(id)!;
}

/**
 * Finalize an approved task: `finalizing` → `merged`. Called by the dispatcher's
 * finalize-watcher once the post-merge agent goes idle, exits, or times out (and
 * by restart recovery for tasks left finalizing). The branch is already merged to
 * main at this point; here we capture the agent's wrap-up output, close its pane,
 * and remove the worktree + branch. Idempotent — guarded on status='finalizing'.
 */
export async function finalizeTask(id: string): Promise<TaskView | null> {
  const row = getTask(id);
  if (!row) return null;
  if (row.status !== "finalizing") return taskView(id); // already finalized / moved
  const dir = getDirectory(row.directory_id);
  if (!dir) throw new HttpError(404, "directory not found");

  // Capture the agent's post-merge wrap-up (the "good information") from its run
  // log before we kill it, so it survives on the merged task.
  const snapshot = readRunLogSnapshot(id);

  // Close the pane (kills the now-finished agent); drop any blocked review call
  // defensively in case the socket-abort cleanup hasn't fired.
  if (row.herdr_pane_id) {
    await herdr.paneClose(row.herdr_pane_id).catch(() => {});
  }
  cancelReview(id);

  // The agent no longer needs its worktree cwd — tear down worktree + branch.
  await git.cleanup(dir.path, id).catch(() => {});

  const res = db.query(
    `UPDATE tasks SET status='merged', conflict=0, idle=0, herdr_pane_id=NULL,
       output_snapshot=?, merged_at=COALESCE(merged_at, ?)
       WHERE id=? AND status='finalizing'`,
  ).run(snapshot || null, nowIso(), id);
  if (res.changes === 0) return taskView(id); // finalized under us
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
  // Persist the note to task.md either way (visible in the UI; survives restarts
  // for the fallback re-dispatch path).
  appendRejection(dir.path, id, note, when);

  if (hasPendingReview(id)) {
    // The agent is alive and blocked in request_review. Stream the notes back
    // into that SAME session and flip the task back to running — NO fresh
    // dispatch. The pane id stays so a later approve/abort can close it.
    db.query(
      `UPDATE tasks SET status='running', review_note=?, output_snapshot=NULL, summary=NULL, conflict=0 WHERE id=?`,
    ).run(note.trim(), id);
    updateTaskMdStatus(dir.path, id, "running");
    resolveReview(id, { decision: "changes_requested", notes: note.trim() });
    emitUpdated(id);
    return taskView(id)!;
  }

  // No live session (service restarted, agent died): fall back to the original
  // behavior — back to queued so the dispatcher re-runs a fresh agent into the
  // SAME worktree/branch, with the note now in task.md.
  db.query(
    `UPDATE tasks SET status='queued', review_note=?, herdr_pane_id=NULL, output_snapshot=NULL, summary=NULL, conflict=0 WHERE id=?`,
  ).run(note.trim(), id);
  updateTaskMdStatus(dir.path, id, "queued");

  emitUpdated(id);
  return taskView(id)!;
}

/**
 * Abort a task without merging: discard its worktree + branch and move it to the
 * terminal `aborted` state. Works from any non-terminal state EXCEPT
 * `finalizing` (queued, running, review). For a running task we first signal its
 * watcher to bail and close the herdr pane so the agent stops before we tear the
 * worktree down. A `finalizing` task has already merged to main, so there is
 * nothing to discard — it auto-completes to `merged` and abort is a 409.
 */
export async function abortTask(id: string): Promise<TaskView> {
  const row = getTask(id);
  if (!row) throw new HttpError(404, `task not found: ${id}`);
  if (row.status === "merged") {
    throw new HttpError(409, "task is already merged");
  }
  if (row.status === "aborted") {
    throw new HttpError(409, "task is already aborted");
  }
  if (row.status === "finalizing") {
    throw new HttpError(409, "task is finalizing (already merged) — cannot abort");
  }
  const dir = getDirectory(row.directory_id);
  if (!dir) throw new HttpError(404, "directory not found");

  // Tell the watcher (if any) to stop before we kill the pane / remove the tree,
  // so it never transitions the task to review behind us.
  signalAbort(id);
  // Release any blocked request_review call (the pane close below kills the agent
  // anyway, so we drop the call without returning a value).
  cancelReview(id);
  if (row.herdr_pane_id) {
    await herdr.paneClose(row.herdr_pane_id).catch(() => {});
  }

  // Throw away the worktree + branch — nothing gets merged.
  await git.cleanup(dir.path, id).catch(() => {});

  db.query(
    `UPDATE tasks SET status='aborted', conflict=0, idle=0, review_note=NULL,
       output_snapshot=NULL, herdr_pane_id=NULL, completed_at=? WHERE id=?`,
  ).run(nowIso(), id);
  updateTaskMdStatus(dir.path, id, "aborted");

  emitUpdated(id);
  return taskView(id)!;
}

// --- dispatcher-facing state transitions (kept here so all writes live together) ---

export function markRunning(id: string, paneId: string): void {
  // Guard on status='queued' so a task aborted in the same tick it was dispatched
  // isn't dragged back to 'running' behind abortTask.
  const res = db.query(
    `UPDATE tasks SET status='running', herdr_pane_id=?, started_at=COALESCE(started_at, ?)
       WHERE id=? AND status='queued'`,
  ).run(paneId, nowIso(), id);
  if (res.changes === 0) return; // aborted (or otherwise moved) under us
  const row = getTask(id);
  if (row) {
    const dir = getDirectory(row.directory_id);
    if (dir) updateTaskMdStatus(dir.path, id, "running");
  }
  emitUpdated(id);
}

export function markReview(id: string, snapshot: string): void {
  // Guard on status='running' so a task aborted while its agent was finishing
  // isn't resurrected into 'review' after abortTask parked it as terminal.
  const res = db.query(
    `UPDATE tasks SET status='review', completed_at=?, output_snapshot=?, herdr_pane_id=NULL, idle=0
       WHERE id=? AND status='running'`,
  ).run(nowIso(), snapshot, id);
  if (res.changes === 0) return; // aborted (or otherwise moved) under us
  const row = getTask(id);
  if (row) {
    const dir = getDirectory(row.directory_id);
    if (dir) updateTaskMdStatus(dir.path, id, "review");
  }
  emitUpdated(id);
}

/**
 * Move a task to `review` because its live agent called the MCP `request_review`
 * tool. Unlike markReview (the process-exit fallback), this KEEPS herdr_pane_id —
 * the agent is still alive and blocked on the tool result, so approve/abort must
 * be able to close its pane. Stores the agent's optional summary.
 *
 * Returns:
 *  - "ok"        → transitioned to review (or already in review), block the call.
 *  - "terminal"  → task is merged/aborted; the caller should not block.
 *  - "notfound"  → no such task.
 */
export function markReviewFromAgent(
  id: string,
  summary?: string,
): "ok" | "terminal" | "notfound" {
  const row = getTask(id);
  if (!row) return "notfound";
  if (row.status === "merged" || row.status === "aborted") return "terminal";

  // running → review (normal), or review → review (a duplicate call); keep pane.
  db.query(
    `UPDATE tasks SET status='review', completed_at=COALESCE(completed_at, ?), summary=?, idle=0
       WHERE id=? AND status IN ('running','review')`,
  ).run(nowIso(), summary ?? null, id);
  const dir = getDirectory(row.directory_id);
  if (dir) updateTaskMdStatus(dir.path, id, "review");
  emitUpdated(id);
  return "ok";
}

/**
 * Flag/unflag a running task as `idle` (agent alive but no recent CLI output).
 * Owned by the dispatcher watcher. Guarded on status='running' so a lagging
 * watcher can't stamp the flag onto a task that has already moved to
 * review/merged/aborted, and on a value change so we only emit when it actually
 * flips (no per-second event spam).
 */
export function setIdle(id: string, idle: boolean): void {
  const want = idle ? 1 : 0;
  const res = db.query(
    `UPDATE tasks SET idle=? WHERE id=? AND status='running' AND idle<>?`,
  ).run(want, id, want);
  if (res.changes === 0) return;
  emitUpdated(id);
}

export function backToQueued(id: string): void {
  db.query(
    `UPDATE tasks SET status='queued', herdr_pane_id=NULL WHERE id=?`,
  ).run(id);
  emitUpdated(id);
}

/**
 * On startup, any task left in `finalizing` (service killed mid-wrap-up) has lost
 * its finalize-watcher. The branch already merged to main, so just complete the
 * finalize: capture whatever wrap-up was logged, close the pane, clean up, and
 * mark merged. Returns how many were recovered.
 */
export async function recoverFinalizingTasks(): Promise<number> {
  const rows = db
    .query<TaskRow, []>(`SELECT * FROM tasks WHERE status='finalizing'`)
    .all();
  for (const r of rows) await finalizeTask(r.id).catch(() => {});
  return rows.length;
}
