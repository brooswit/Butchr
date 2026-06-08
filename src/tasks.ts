// Task service: create / list / get / diff / approve / reject. The task.md on
// disk is authoritative for prompt+metadata; the DB row tracks runtime state.
import { db, nowIso } from "./db.ts";
import type { TaskRow, TaskStatus } from "./db.ts";
import { HttpError, getDirectory } from "./directories.ts";
import { readRunLogSnapshot, signalAbort } from "./dispatcher.ts";
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

/**
 * Global merge queue: run at most ONE merge at a time across ALL tasks and
 * directories. Approvals that land close together would otherwise rebase+ff into
 * a moving default branch in parallel and race; serializing them means each merge
 * rebases onto the up-to-date base tip the previous merge left behind. The chain
 * is process-wide (a single butchr instance owns all merges) and never rejects —
 * each link swallows the prior result so one failed merge can't break the queue.
 */
let mergeChain: Promise<unknown> = Promise.resolve();
function runExclusiveMerge<T>(fn: () => Promise<T>): Promise<T> {
  const result = mergeChain.then(fn, fn);
  mergeChain = result.then(
    () => {},
    () => {},
  );
  return result;
}

/** What approveTask did: merged the branch, or kicked a conflict back to the agent. */
export type ApproveOutcome = { task: TaskView; conflictSentBack?: boolean };

/**
 * Send a task in `review` back for rework with a change-request note. In the
 * non-blocking model the agent has already exited, so there is no live call to
 * resolve: we simply re-queue the task (the note is already appended to task.md /
 * stored in review_note). The dispatcher then re-launches the SAME Claude session
 * via `--resume <session_id>` (see dispatcher.dispatch) so the agent re-enters
 * with full prior context and the notes. We close any lingering pane defensively
 * — normally there is none, but a misbehaving agent that didn't exit would
 * otherwise leave an orphan that collides on `agent_name_taken`. Shared by
 * rejectTask (human note) and approveTask's conflict kick-back.
 */
async function requestChanges(
  id: string,
  dirPath: string,
  note: string,
  paneId: string | null,
  tabId: string | null,
): Promise<void> {
  // Non-blocking model: the agent already exited after request_review, so there
  // is no live call to resolve — just re-queue for a `--resume` re-launch. Tear
  // down any lingering tab defensively (a misbehaving agent that didn't exit would
  // otherwise strand an orphan that collides on `agent_name_taken`), and clear the
  // stored tab id since that tab is now gone; the re-dispatch spins up a fresh one.
  await herdr.teardownTask(tabId, id, paneId);
  db.query(
    `UPDATE tasks SET status='queued', review_note=?, herdr_pane_id=NULL, herdr_tab_id=NULL, output_snapshot=NULL, summary=NULL, conflict=0, idle=0 WHERE id=?`,
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

  // Serialize through the global merge queue so concurrent approvals rebase+ff
  // one-at-a-time against an up-to-date base tip instead of racing in parallel.
  const result = await runExclusiveMerge(() => git.merge(dir.path, id));
  if (!result.ok) {
    if (result.conflict) {
      // Content conflict — git.merge already aborted, so the tree is CLEAN.
      // Don't dump the conflict on the human: send it back to the agent (the
      // author of the code) as a changes_requested verdict with resolution
      // steps, exactly like a reject. Returns 200, task flips back to running.
      const base = await git.defaultBranch(dir.path);
      const notes = buildConflictNotes(id, base, result.conflictFiles, result.message);
      appendRejection(dir.path, id, notes, nowIso());
      // Same channel as reject: into the live agent if blocked, else re-queue
      // (requestChanges tears down any lingering tab in the fallback).
      await requestChanges(id, dir.path, notes, row.herdr_pane_id, row.herdr_tab_id);
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

  // Merge succeeded. There is no live agent to wait on (the non-blocking
  // request_review path means the agent already exited), so close the task to
  // `merged` directly — no "finalizing" phase, no idle/timeout wait, no hang. The
  // branch is already in main; capture whatever the agent logged, tear down the
  // worktree + branch, and stamp merged.
  const snapshot = readRunLogSnapshot(id);
  // Close the agent's dedicated tab (best-effort — usually already gone since the
  // agent exited after request_review, but removes any empty husk tab).
  await herdr.teardownTask(row.herdr_tab_id, id, row.herdr_pane_id);
  await git.cleanup(dir.path, id).catch(() => {});
  const res = db.query(
    `UPDATE tasks SET status='merged', conflict=0, idle=0, herdr_pane_id=NULL, herdr_tab_id=NULL,
       output_snapshot=?, merged_at=COALESCE(merged_at, ?)
       WHERE id=? AND status='review'`,
  ).run(snapshot || null, nowIso(), id);
  if (res.changes === 0) {
    // Raced (e.g. aborted) between the merge and here — the branch already landed
    // in main, but the task moved on. Nothing more to do.
    emitUpdated(id);
    return { task: taskView(id)! };
  }
  updateTaskMdStatus(dir.path, id, "merged");
  emitUpdated(id);
  return { task: taskView(id)! };
}

/**
 * Legacy: complete a task left in the obsolete `finalizing` state by a
 * pre-redesign butchr (the branch already merged to main). The current approve
 * path never produces `finalizing`; this exists only so startup recovery can
 * flush such stragglers to `merged` after an upgrade. Idempotent — guarded on
 * status='finalizing'.
 */
export async function finalizeTask(id: string): Promise<TaskView | null> {
  const row = getTask(id);
  if (!row) return null;
  if (row.status !== "finalizing") return taskView(id); // already finalized / moved
  const dir = getDirectory(row.directory_id);
  if (!dir) throw new HttpError(404, "directory not found");

  const snapshot = readRunLogSnapshot(id);
  // Close the agent's tab (kills the now-finished agent and removes the tab so it
  // doesn't linger).
  await herdr.teardownTask(row.herdr_tab_id, id, row.herdr_pane_id);
  // The agent no longer needs its worktree cwd — tear down worktree + branch.
  await git.cleanup(dir.path, id).catch(() => {});

  const res = db.query(
    `UPDATE tasks SET status='merged', conflict=0, idle=0, herdr_pane_id=NULL, herdr_tab_id=NULL,
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
  // Persist the note to task.md (visible in the UI; survives restarts and is what
  // the resumed agent reads as its rework prompt — see renderReworkPrompt).
  appendRejection(dir.path, id, note, when);

  // Re-queue for rework. The dispatcher re-launches the agent's existing Claude
  // session via `--resume <session_id>` with the notes — full prior context, no
  // context loss. The agent already exited after the non-blocking request_review;
  // requestChanges tears down any lingering tab defensively.
  await requestChanges(id, dir.path, note.trim(), row.herdr_pane_id, row.herdr_tab_id);

  emitUpdated(id);
  return taskView(id)!;
}

/**
 * Abort a task without merging: discard its worktree + branch and move it to the
 * terminal `aborted` state. Works from any non-terminal state (queued, running,
 * review). For a running task we first signal its watcher to bail and close the
 * herdr pane so the agent stops before we tear the worktree down. A task in
 * `review` has no live process (the agent exited after request_review), so abort
 * just discards its DB state + worktree.
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

  // Tell the watcher (if any) to stop before we kill the tab / remove the tree,
  // so it never transitions the task to review behind us.
  signalAbort(id);
  // Close the agent's whole tab (kills the agent + removes the dedicated tab).
  await herdr.teardownTask(row.herdr_tab_id, id, row.herdr_pane_id);

  // Throw away the worktree + branch — nothing gets merged.
  await git.cleanup(dir.path, id).catch(() => {});

  db.query(
    `UPDATE tasks SET status='aborted', conflict=0, idle=0, review_note=NULL,
       output_snapshot=NULL, herdr_pane_id=NULL, herdr_tab_id=NULL, completed_at=? WHERE id=?`,
  ).run(nowIso(), id);
  updateTaskMdStatus(dir.path, id, "aborted");

  emitUpdated(id);
  return taskView(id)!;
}

// --- dispatcher-facing state transitions (kept here so all writes live together) ---

export function markRunning(
  id: string,
  paneId: string,
  sessionId: string,
  tabId?: string,
): void {
  // Guard on status='queued' so a task aborted in the same tick it was dispatched
  // isn't dragged back to 'running' behind abortTask. `session_id` is set with
  // COALESCE so it sticks to the FIRST id assigned: a fresh task records the new
  // uuid; a re-launched (rejected) task keeps its existing id, which is exactly
  // the one the dispatcher just `--resume`d. The tab id is the dedicated herdr tab
  // the agent runs in (one tab per task).
  const res = db.query(
    `UPDATE tasks SET status='running', herdr_pane_id=?, herdr_tab_id=?,
       session_id=COALESCE(session_id, ?), started_at=COALESCE(started_at, ?)
       WHERE id=? AND status='queued'`,
  ).run(paneId, tabId ?? null, sessionId, nowIso(), id);
  if (res.changes === 0) return; // aborted (or otherwise moved) under us
  const row = getTask(id);
  if (row) {
    const dir = getDirectory(row.directory_id);
    if (dir) updateTaskMdStatus(dir.path, id, "running");
  }
  emitUpdated(id);
}

/**
 * Record a re-adopted running task's current herdr pane + tab id. Used by the
 * startup reconcile (dispatcher.reconcileRunningTasks) when an agent it re-adopts
 * now lives on a different pane/tab than the one stored before butchr restarted.
 * Guarded on status='running' so a concurrent transition isn't clobbered. A
 * missing tabId leaves the stored value untouched (COALESCE) rather than nulling
 * a still-valid tab.
 */
export function adoptPane(id: string, paneId: string, tabId?: string): void {
  const res = db.query(
    `UPDATE tasks SET herdr_pane_id=?, herdr_tab_id=COALESCE(?, herdr_tab_id) WHERE id=? AND status='running'`,
  ).run(paneId, tabId ?? null, id);
  if (res.changes === 0) return;
  emitUpdated(id);
}

export function markReview(id: string, snapshot: string): void {
  // Guard on status='running' so a task aborted while its agent was finishing
  // isn't resurrected into 'review' after abortTask parked it as terminal. This is
  // the dead-agent fallback (the live request_review path is markReviewFromAgent),
  // so the agent's tab is already being torn down by the caller — clear its id.
  const res = db.query(
    `UPDATE tasks SET status='review', completed_at=?, output_snapshot=?, herdr_pane_id=NULL, herdr_tab_id=NULL, idle=0
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
 * Move a task to `review` because its agent called the MCP `request_review` tool.
 * In the non-blocking model the agent EXITS right after this returns, so review is
 * pure DB state with no live process — we clear herdr_pane_id (its pane is about
 * to close; herdr destroys a pane the instant its command exits). Stores the
 * agent's optional summary.
 *
 * Returns:
 *  - "ok"        → transitioned to review (or already in review).
 *  - "terminal"  → task is merged/aborted; nothing to do.
 *  - "notfound"  → no such task.
 */
export function markReviewFromAgent(
  id: string,
  summary?: string,
): "ok" | "terminal" | "notfound" {
  const row = getTask(id);
  if (!row) return "notfound";
  if (row.status === "merged" || row.status === "aborted") return "terminal";

  // Capture the agent's terminal output now: once it exits there is no live pane
  // for the reviewer to inspect, so the snapshot (plus the git diff) is what
  // review is conducted against.
  const snapshot = readRunLogSnapshot(id);

  // running → review (normal), or review → review (a duplicate call). Clear the
  // pane: the agent is exiting and review holds no live process.
  db.query(
    `UPDATE tasks SET status='review', completed_at=COALESCE(completed_at, ?), summary=?, idle=0,
       herdr_pane_id=NULL, output_snapshot=?
       WHERE id=? AND status IN ('running','review')`,
  ).run(nowIso(), summary ?? null, snapshot || null, id);
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

export async function backToQueued(id: string): Promise<void> {
  // Close any lingering herdr agent/tab for this task before re-queuing, so a
  // failed dispatch never strands an orphan agent (or its tab) that would later
  // collide on `agent_name_taken`. Re-dispatch creates a fresh tab.
  const row = getTask(id);
  await herdr.teardownTask(row?.herdr_tab_id, id, row?.herdr_pane_id);
  db.query(
    `UPDATE tasks SET status='queued', herdr_pane_id=NULL, herdr_tab_id=NULL WHERE id=?`,
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
