// Task service: create / list / get / diff / approve / reject. The task.md on
// disk is authoritative for prompt+metadata; the DB row tracks runtime state.
import { db, nowIso } from "./db.ts";
import type { TaskRow, TaskStatus } from "./db.ts";
import { HttpError, getDirectory } from "./directories.ts";
import { signalAbort } from "./dispatcher.ts";
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

/** What approveTask did: merged the branch, or kicked a conflict back to the agent. */
export type ApproveOutcome = { task: TaskView; conflictSentBack?: boolean };

/**
 * Stream a `changes_requested` verdict back into a task that's in review: if its
 * agent is alive and blocked in request_review, resolve that SAME session and
 * flip back to running (no fresh dispatch); otherwise fall back to re-queuing so
 * the dispatcher runs a fresh agent into the same worktree/branch (the note is
 * already in task.md / review_note). Shared by rejectTask (human note) and
 * approveTask's conflict kick-back.
 */
function requestChanges(id: string, dirPath: string, note: string): void {
  if (hasPendingReview(id)) {
    db.query(
      `UPDATE tasks SET status='running', review_note=?, output_snapshot=NULL, summary=NULL, conflict=0 WHERE id=?`,
    ).run(note, id);
    updateTaskMdStatus(dirPath, id, "running");
    resolveReview(id, { decision: "changes_requested", notes: note });
    return;
  }
  db.query(
    `UPDATE tasks SET status='queued', review_note=?, herdr_pane_id=NULL, output_snapshot=NULL, summary=NULL, conflict=0 WHERE id=?`,
  ).run(note, id);
  updateTaskMdStatus(dirPath, id, "queued");
}

/** Actionable change-request note for a merge conflict, naming the files + steps. */
function buildConflictNotes(
  id: string,
  base: string,
  files: string[],
  rawMessage: string,
): string {
  const fileList = files.length
    ? files.map((f) => `  - ${f}`).join("\n")
    : "  (see the git output below)";
  const tail = rawMessage.trim().split("\n").slice(-6).join("\n");
  return [
    `Merge conflict: your branch \`${id}\` conflicts with \`${base}\` on:`,
    fileList,
    ``,
    `In your worktree, integrate the latest default branch and resolve these`,
    `conflicts (e.g. \`git merge ${base}\` — or rebase — then fix the files and`,
    `commit), then call \`request_review\` again. Do NOT leave conflict markers.`,
    ``,
    `--- git output ---`,
    tail,
  ].join("\n");
}

export async function approveTask(id: string): Promise<ApproveOutcome> {
  const row = getTask(id);
  if (!row) throw new HttpError(404, `task not found: ${id}`);
  if (row.status !== "review") {
    throw new HttpError(409, `task is not in review (status=${row.status})`);
  }
  const dir = getDirectory(row.directory_id);
  if (!dir) throw new HttpError(404, "directory not found");

  const result = await git.merge(dir.path, id);
  if (!result.ok) {
    if (result.conflict) {
      // Content conflict — git.merge already aborted, so the tree is CLEAN.
      // Don't dump the conflict on the human: send it back to the agent (the
      // author of the code) as a changes_requested verdict with resolution
      // steps, exactly like a reject. Returns 200, task flips back to running.
      const base = await git.defaultBranch(dir.path);
      const notes = buildConflictNotes(id, base, result.conflictFiles, result.message);
      appendRejection(dir.path, id, notes, nowIso());
      // No live agent but a pane may linger (service was restarted): close it
      // before re-queue so a fresh agent owns the worktree.
      if (!hasPendingReview(id) && row.herdr_pane_id) {
        await herdr.paneClose(row.herdr_pane_id).catch(() => {});
      }
      requestChanges(id, dir.path, notes);
      emitUpdated(id);
      return { task: taskView(id)!, conflictSentBack: true };
    }
    // Non-conflict merge failure — genuinely unusual/unsafe; surface to the human.
    db.query(
      `UPDATE tasks SET conflict=1, review_note=? WHERE id=?`,
    ).run(result.message, id);
    emitUpdated(id);
    throw new HttpError(409, `merge failed: ${result.message}`);
  }

  // Merge succeeded. Close the pane — this kills the live agent mid-request_review
  // (its blocked call never returns, so it generates nothing more). Then drop the
  // pending review entry defensively in case the socket-abort cleanup hasn't fired.
  if (row.herdr_pane_id) {
    await herdr.paneClose(row.herdr_pane_id).catch(() => {});
  }
  cancelReview(id);

  // Cleanup worktree + branch, mark merged.
  await git.cleanup(dir.path, id);
  db.query(
    `UPDATE tasks SET status='merged', conflict=0, merged_at=?, herdr_pane_id=NULL WHERE id=?`,
  ).run(nowIso(), id);
  updateTaskMdStatus(dir.path, id, "merged");

  emitUpdated(id);
  return { task: taskView(id)! };
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

  // Stream the note back into the live agent if one is blocked, else re-queue.
  // The pane id stays in the live case so a later approve/abort can close it.
  requestChanges(id, dir.path, note.trim());

  emitUpdated(id);
  return taskView(id)!;
}

/**
 * Abort a task without merging: discard its worktree + branch and move it to the
 * terminal `aborted` state. Works from any non-terminal state (queued, running,
 * review). For a running task we first signal its watcher to bail and close the
 * herdr pane so the agent stops before we tear the worktree down.
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
