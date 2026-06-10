// Task service: create / list / get / diff / approve / reject. The task.md on
// disk is authoritative for prompt+metadata; the DB row tracks runtime state.
import { config } from "./config.ts";
import { db, nowIso } from "./db.ts";
import type { TaskRow, TaskStatus } from "./db.ts";
import { HttpError, getDirectory } from "./directories.ts";
import { readRunLogSnapshot, signalAbort } from "./dispatcher.ts";
import { publish } from "./events.ts";
import { run } from "./exec.ts";
import * as git from "./git.ts";
import * as herdr from "./herdr.ts";
import { uniqueTaskId } from "./ids.ts";
import { verifyDefaultBranch } from "./verify.ts";
import {
  appendRejection,
  readTaskMd,
  taskMdPath,
  updateTaskMdStatus,
  writeTaskMd,
} from "./taskmd.ts";
import { existsSync, readFileSync } from "node:fs";

// The serialized task object exposes `blocked_by` as a real array of ids (the DB
// stores it as raw JSON TEXT) plus `deadBlockers`: blockers in a terminal,
// non-merged state (aborted/rejected/failed) or gone entirely, which will NEVER
// merge — a blocked task with any dead blocker is stuck until the operator edits
// its blocked_by set (see setBlockedBy). We Omit the raw column so the array shape
// wins.
export type TaskView = Omit<TaskRow, "blocked_by"> & {
  prompt: string;
  context: string[];
  review_notes: string;
  blocked_by: string[];
  // The current status of each blocker by id (or "gone" if its row no longer
  // exists), so the webapp can render the dependency list without extra fetches.
  blockerStates: Record<string, string>;
  deadBlockers: string[];
};

export function getTask(id: string): TaskRow | null {
  return (
    db.query<TaskRow, [string]>(`SELECT * FROM tasks WHERE id=?`).get(id) ?? null
  );
}

// --- task dependencies / blocking ------------------------------------------

/** Terminal states a blocker can be in that mean it will NEVER merge. */
const DEAD_BLOCKER_STATES = new Set<TaskStatus>(["aborted", "rejected", "failed"]);

/** Parse the JSON-array `blocked_by` column into a clean string[] of task ids. */
export function parseBlockedBy(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Classify a single blocker by id:
 *  - "merged"  → satisfied; this dependency is met.
 *  - "dead"    → terminal non-merged (aborted/rejected/failed) OR no longer exists
 *                (its directory was unregistered) → it will never merge.
 *  - "pending" → still in flight (queued/blocked/running/review/finalizing) → may
 *                still merge.
 */
function blockerState(blockerId: string): "merged" | "dead" | "pending" {
  const b = getTask(blockerId);
  if (!b) return "dead"; // gone — can never merge
  if (b.status === "merged") return "merged";
  if (DEAD_BLOCKER_STATES.has(b.status)) return "dead";
  return "pending";
}

/** Are ALL of these blockers merged? (Empty set → trivially eligible.) */
function allBlockersMerged(ids: string[]): boolean {
  return ids.every((id) => blockerState(id) === "merged");
}

/** Blockers (by id) that will never merge — terminal non-merged or gone. */
function deadBlockerIds(ids: string[]): string[] {
  return ids.filter((id) => blockerState(id) === "dead");
}

// Remember which (task, dead-blocker) pairs we've already warned about so the
// per-tick re-evaluation doesn't spam the log every second for a stuck task.
const loggedDeadBlockers = new Set<string>();
function logDeadBlockers(taskId: string, ids: string[]): void {
  for (const bid of deadBlockerIds(ids)) {
    const key = `${taskId}:${bid}`;
    if (loggedDeadBlockers.has(key)) continue;
    loggedDeadBlockers.add(key);
    const b = getTask(bid);
    console.warn(
      `[butchr] task ${taskId} blocked on ${bid} which is ${b ? b.status : "gone"} ` +
        `and will never merge; edit blocked_by to proceed`,
    );
  }
}

/**
 * Would making `taskId` depend on `newBlockers` create a self-block or a
 * dependency cycle (A blocks B blocks A)? Walks the existing blocked_by graph
 * from each proposed blocker; only `taskId`'s OWN outgoing edges change, so if any
 * path from a proposed blocker reaches `taskId` again, the new edge closes a cycle.
 */
export function wouldCreateCycle(taskId: string, newBlockers: string[]): boolean {
  if (newBlockers.includes(taskId)) return true; // self-block
  const visited = new Set<string>();
  const stack = [...newBlockers];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === taskId) return true;
    if (visited.has(cur)) continue;
    visited.add(cur);
    const row = getTask(cur);
    if (!row) continue;
    for (const b of parseBlockedBy(row.blocked_by)) stack.push(b);
  }
  return false;
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
  const blocked_by = parseBlockedBy(row.blocked_by);
  const blockerStates: Record<string, string> = {};
  for (const bid of blocked_by) {
    const b = getTask(bid);
    blockerStates[bid] = b ? b.status : "gone";
  }
  return {
    ...row,
    prompt,
    context,
    review_notes,
    blocked_by,
    blockerStates,
    deadBlockers: deadBlockerIds(blocked_by),
  };
}

function emitUpdated(id: string): void {
  const v = taskView(id);
  if (v) publish({ type: "task.updated", task: v });
}

export async function createTask(
  directoryId: string,
  prompt: string,
  context: string[] = [],
  blockedBy: string[] = [],
): Promise<TaskView> {
  const dir = getDirectory(directoryId);
  if (!dir) throw new HttpError(404, `directory not found: ${directoryId}`);
  if (!prompt || !prompt.trim()) {
    throw new HttpError(400, "prompt is required");
  }

  // Normalize + validate the dependency set: every listed blocker must exist.
  const blockers = normalizeBlockedBy(blockedBy);
  for (const bid of blockers) {
    if (!getTask(bid)) throw new HttpError(404, `blocker task not found: ${bid}`);
  }

  const id = uniqueTaskId((cand) => getTask(cand) !== null);

  // Self-block / cycle guard. The id is freshly minted (nothing points at it yet),
  // so in practice only a self-reference could trip this — but run the full walk
  // so the rule is enforced uniformly with setBlockedBy.
  if (wouldCreateCycle(id, blockers)) {
    throw new HttpError(400, "blocked_by would create a dependency cycle");
  }

  const created = nowIso();
  // Start `blocked` if any blocker is not yet merged; otherwise `queued` as today
  // (an empty set or all-merged blockers are immediately eligible to dispatch).
  const status: TaskStatus = allBlockersMerged(blockers) ? "queued" : "blocked";

  // Filesystem artifact first: worktree + task.md. If either fails, no DB row.
  await git.createWorktree(dir.path, id);
  writeTaskMd(
    dir.path,
    { id, created, status, context },
    prompt,
  );

  db.query(
    `INSERT INTO tasks (id, directory_id, status, blocked_by, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, directoryId, status, JSON.stringify(blockers), created);

  if (status === "blocked") logDeadBlockers(id, blockers);

  const view = taskView(id)!;
  publish({ type: "task.created", task: view });
  return view;
}

/** De-dupe + drop blanks from a blocked_by list, preserving order. */
function normalizeBlockedBy(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids ?? []) {
    const id = String(raw ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * AUTO-UNBLOCK: if `id` is `blocked` and ALL its blockers have merged, promote it
 * to `queued` so the dispatcher picks it up. A blocked task with an empty
 * blocked_by set is trivially eligible. No-op for any non-`blocked` task. Returns
 * true iff it promoted the task. Called cheaply for every blocked task on each
 * dispatcher tick (robust to missed events) and again right after any merge for
 * promptness. If it stays blocked, dead blockers are logged (deduped) so a stuck
 * dependency is visible.
 */
export function reevaluateBlockedTask(id: string): boolean {
  const row = getTask(id);
  if (!row || row.status !== "blocked") return false;
  const ids = parseBlockedBy(row.blocked_by);
  if (allBlockersMerged(ids)) {
    // Promote to queued. Clear any stale backoff so it dispatches on the next tick.
    const res = db
      .query(
        `UPDATE tasks SET status='queued', next_dispatch_at=NULL WHERE id=? AND status='blocked'`,
      )
      .run(id);
    if (res.changes === 0) return false; // moved under us
    const dir = getDirectory(row.directory_id);
    if (dir) updateTaskMdStatus(dir.path, id, "queued");
    emitUpdated(id);
    console.log(`[butchr] task ${id} unblocked → queued (all blockers merged)`);
    return true;
  }
  // Still blocked — surface any dead (never-merging) blockers.
  logDeadBlockers(id, ids);
  return false;
}

/** Re-evaluate EVERY blocked task (used after a merge for prompt auto-unblock). */
export function reevaluateAllBlocked(): void {
  const rows = db
    .query<{ id: string }, []>(`SELECT id FROM tasks WHERE status='blocked'`)
    .all();
  for (const r of rows) reevaluateBlockedTask(r.id);
}

/**
 * Replace a task's blocked_by set (operator-driven, any time) and RE-EVALUATE.
 *
 * Allowed only on a NON-terminal task (queued/blocked/running/review); rejected
 * with 409 on merged/aborted/rejected/failed (and the legacy finalizing). Every
 * new blocker id must exist (404) and the new set must not create a self-block or
 * cycle (400). After persisting:
 *  - If it should now be blocked (some blocker not yet merged) and it has a LIVE
 *    agent (running/idle), KILL-ON-BLOCK: tear the agent down (reuse teardownTask)
 *    and clear the running/herdr fields like a clean re-queue, but KEEP session_id
 *    and the worktree so it resumes with full context when it later unblocks. This
 *    is NOT a dispatch failure (dispatch_attempts/backoff untouched).
 *  - If all blockers are merged/empty and it was blocked, promote it to queued.
 */
export async function setBlockedBy(
  id: string,
  blockedBy: string[],
): Promise<TaskView> {
  const row = getTask(id);
  if (!row) throw new HttpError(404, `task not found: ${id}`);
  // Only non-terminal, pre-merge states may have their dependencies edited.
  const editable = new Set<TaskStatus>(["queued", "blocked", "running", "review"]);
  if (!editable.has(row.status)) {
    throw new HttpError(409, `cannot edit blocked_by on a ${row.status} task`);
  }

  const blockers = normalizeBlockedBy(blockedBy);
  for (const bid of blockers) {
    if (!getTask(bid)) throw new HttpError(404, `blocker task not found: ${bid}`);
  }
  if (wouldCreateCycle(id, blockers)) {
    throw new HttpError(400, "blocked_by would create a dependency cycle");
  }

  // Persist the new dependency set first; the transition below reads it back.
  db.query(`UPDATE tasks SET blocked_by=? WHERE id=?`).run(
    JSON.stringify(blockers),
    id,
  );
  // Forget any prior dead-blocker warnings for this task — the set just changed.
  for (const key of [...loggedDeadBlockers]) {
    if (key.startsWith(`${id}:`)) loggedDeadBlockers.delete(key);
  }

  const eligible = allBlockersMerged(blockers);
  const dir = getDirectory(row.directory_id);

  if (eligible) {
    // No outstanding blockers. A blocked task becomes eligible → queued; anything
    // else (queued/running/review) is already past the block, so leave it.
    if (row.status === "blocked") {
      db.query(
        `UPDATE tasks SET status='queued', next_dispatch_at=NULL WHERE id=? AND status='blocked'`,
      ).run(id);
      if (dir) updateTaskMdStatus(dir.path, id, "queued");
    }
    emitUpdated(id);
    return taskView(id)!;
  }

  // Should be blocked. If it already is, just refresh the view + dead-blocker log.
  if (row.status === "blocked") {
    logDeadBlockers(id, blockers);
    emitUpdated(id);
    return taskView(id)!;
  }

  // Transitioning INTO blocked from queued/running/review.
  if (row.herdr_pane_id || row.herdr_tab_id) {
    // KILL-ON-BLOCK: a live agent (running/idle) — tear it down so nothing keeps
    // running, then clear the running/herdr fields (mirrors backToQueued) while
    // KEEPING session_id + worktree for a later --resume. NOT a dispatch failure.
    await herdr.teardownTask(row.herdr_tab_id, id, row.herdr_pane_id);
  }
  db.query(
    `UPDATE tasks SET status='blocked', herdr_pane_id=NULL, herdr_tab_id=NULL,
       output_snapshot=NULL, conflict=0, idle=0 WHERE id=?`,
  ).run(id);
  if (dir) updateTaskMdStatus(dir.path, id, "blocked");
  logDeadBlockers(id, blockers);
  emitUpdated(id);
  return taskView(id)!;
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

/**
 * What approveTask did:
 *  - merged the branch (default),
 *  - `conflictSentBack` — kicked a merge conflict back to the agent, or
 *  - `revertedOnRed` — the branch DID fast-forward into main but the post-merge
 *    verify gate (build + tests) failed, so the merge was auto-reverted off main
 *    and the task flagged. The default branch is back at its pre-merge tip.
 */
export type ApproveOutcome = {
  task: TaskView;
  conflictSentBack?: boolean;
  revertedOnRed?: boolean;
};

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
  // This is a REWORK re-queue (a human reject or a conflict kick-back), NOT a
  // dispatch failure — it's a fresh intent to run, so clear the dispatch retry
  // state (attempts / last error / backoff) so prior dispatch failures don't
  // count against the resume and a stale backoff can't delay it.
  db.query(
    `UPDATE tasks SET status='queued', review_note=?, herdr_pane_id=NULL, herdr_tab_id=NULL, output_snapshot=NULL, summary=NULL, conflict=0, idle=0,
       dispatch_attempts=0, last_dispatch_error=NULL, next_dispatch_at=NULL WHERE id=?`,
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
  //
  // The verify gate + its auto-revert run INSIDE this same exclusive section: a
  // merge fast-forwards the default branch, then (if it stuck) we build+test the
  // NEW tip and, on RED, reset the default branch back to the captured pre-merge
  // tip — all before the next queued merge runs, so a revert can never interleave
  // with another merge moving the same branch.
  type Gate = {
    mr: git.MergeResult;
    verify?: { ok: boolean; output: string };
    reverted?: boolean;
    priorTip?: string | null;
  };
  const gate: Gate = await runExclusiveMerge<Gate>(async () => {
    // Capture the default-branch tip BEFORE the ff so we can restore it on RED.
    const priorTip = await git.headSha(dir.path).catch(() => null);
    const mr = await git.merge(dir.path, id);
    if (!mr.ok) return { mr };
    // Merge stuck (ff'd into main). Gate the new tip: build + tests must be GREEN.
    const verify = await verifyDefaultBranch(dir.path);
    if (verify.ok) return { mr, verify };
    // RED — undo the ff so a broken commit never sits on main. We need the prior
    // tip to reset to; if we somehow failed to capture it, we can't safely revert,
    // so surface that loudly and let the merge stand (flagged) rather than guess.
    if (priorTip) {
      await git.resetHard(dir.path, priorTip).catch((e) => {
        console.error(
          `[butchr] CRITICAL: verify FAILED for ${id} but the auto-revert to ` +
            `${priorTip} ALSO failed: ${e}. The default branch may hold a broken commit.`,
        );
      });
    } else {
      console.error(
        `[butchr] CRITICAL: verify FAILED for ${id} but the pre-merge tip was not ` +
          `captured, so the merge could not be auto-reverted. Inspect main.`,
      );
    }
    return { mr, verify, reverted: true, priorTip };
  });

  const result = gate.mr;
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

  // Merge succeeded at the git level, but the post-merge verify gate came back RED
  // and the ff was auto-reverted (default branch reset to its pre-merge tip). Do
  // NOT mark merged: flag the task so a human can see the breakage and the
  // dispatcher won't silently re-launch it. We KEEP the worktree + branch (no
  // git.cleanup) so the work survives for inspection / a fixup re-run, and store
  // the failing build/test output in `revert_reason` (surfaced by the webapp).
  if (gate.reverted) {
    const snapshot = readRunLogSnapshot(id);
    await herdr.teardownTask(row.herdr_tab_id, id, row.herdr_pane_id);
    const reason = gate.verify?.output?.trim() || "(no verify output captured)";
    console.error(
      `[butchr] task ${id} merge AUTO-REVERTED: post-merge verify failed on the ` +
        `default branch; main restored to ${gate.priorTip ?? "(unknown)"}.\n${reason}`,
    );
    const res = db.query(
      `UPDATE tasks SET status='failed', conflict=0, idle=0, herdr_pane_id=NULL, herdr_tab_id=NULL,
         output_snapshot=COALESCE(?, output_snapshot), revert_reason=?, last_dispatch_error=?,
         completed_at=COALESCE(completed_at, ?)
         WHERE id=? AND status='review'`,
    ).run(snapshot || null, reason, reason, nowIso(), id);
    if (res.changes === 0) {
      // Raced (e.g. aborted) between the gate and here — leave whatever won.
      emitUpdated(id);
      return { task: taskView(id)! };
    }
    updateTaskMdStatus(dir.path, id, "failed");
    emitUpdated(id);
    return { task: taskView(id)!, revertedOnRed: true };
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
    // The branch DID land in main, so any task blocked on it may now be eligible.
    reevaluateAllBlocked();
    return { task: taskView(id)! };
  }
  updateTaskMdStatus(dir.path, id, "merged");
  emitUpdated(id);
  // This task just merged — promote any task that was blocked on it (and whose
  // other blockers are also merged) to queued right away, rather than waiting for
  // the next dispatcher tick to notice.
  reevaluateAllBlocked();
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
  // A successful launch clears the dispatch retry state: this run got off the
  // ground, so any earlier consecutive-failure count / backoff / error is stale.
  const res = db.query(
    `UPDATE tasks SET status='running', herdr_pane_id=?, herdr_tab_id=?,
       session_id=COALESCE(session_id, ?), started_at=COALESCE(started_at, ?),
       dispatch_attempts=0, last_dispatch_error=NULL, next_dispatch_at=NULL
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
  // CI GATE: this is a genuine running→review transition (guarded above), so kick
  // off the build/test job for the task's worktree. Fire-and-forget — review must
  // not block on CI.
  void triggerCi(id);
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
  // CI GATE: only run on a genuine running→review transition. A duplicate
  // request_review call (review→review) shouldn't re-run the build/test job. Fire-
  // and-forget so the (already non-blocking) request_review handshake stays instant.
  if (row.status === "running") void triggerCi(id);
  return "ok";
}

// --- CI GATE: build + test on the review transition ------------------------
//
// When a task enters `review`, butchr asynchronously builds the project and runs
// its tests IN THE TASK'S WORKTREE, then records a pass/fail badge on the task
// (ci_status / ci_summary) for the webapp's review panel. This never blocks the
// review transition and never hard-blocks approval — it's an advisory gate.

/** Outcome of a CI run: a status, a compact badge label, and an output tail. */
export type CiResult = {
  status: "pass" | "fail";
  /** Compact badge label, e.g. "build + 12 tests" / "build failed" / "3 test failures". */
  label: string;
  /** Short tail of the build/test output for the reviewer (may be empty). */
  detail: string;
};

/** Signature of the function that actually runs build+test for a task's worktree. */
export type CiRunner = (dirPath: string, taskId: string) => Promise<CiResult>;

// The active CI runner. Overridable in tests (setCiRunner) so they can exercise
// the persistence + trigger wiring without spawning a real `bun` build/test.
let ciRunner: CiRunner = defaultCiRunner;

/** Replace the CI runner (tests inject a fake to avoid spawning bun). */
export function setCiRunner(r: CiRunner): void {
  ciRunner = r;
}

/** Keep the last ~24 lines of output as a compact, human-readable tail. */
function ciTail(s: string): string {
  const trimmed = s.replace(/\r/g, "").trimEnd();
  if (!trimmed) return "";
  return trimmed.split("\n").slice(-24).join("\n");
}

/** Pull `N` out of a `bun test` summary line like ` 12 pass` / ` 3 fail`. */
function parseBunCount(output: string, word: "pass" | "fail"): number {
  const m = output.match(new RegExp(`(\\d+)\\s+${word}\\b`));
  return m ? parseInt(m[1]!, 10) : 0;
}

/**
 * The real CI runner: `bun build … --outfile /dev/null` then `bun test`, both in
 * the task's worktree. A non-zero build exit is a build failure; otherwise a
 * non-zero test exit is a test failure (with the count parsed from bun's summary).
 */
async function defaultCiRunner(dirPath: string, taskId: string): Promise<CiResult> {
  const wt = git.worktreePath(dirPath, taskId);
  const build = await run(
    ["bun", "build", "src/index.ts", "--target", "bun", "--outfile", "/dev/null"],
    { cwd: wt },
  );
  if (!build.ok) {
    return {
      status: "fail",
      label: "build failed",
      detail: ciTail(build.stderr || build.stdout),
    };
  }

  const test = await run(["bun", "test"], { cwd: wt });
  const out = test.stdout + "\n" + test.stderr;
  if (!test.ok) {
    const failed = parseBunCount(out, "fail");
    return {
      status: "fail",
      label: failed > 0 ? `${failed} test failures` : "tests failed",
      detail: ciTail(out),
    };
  }
  const passed = parseBunCount(out, "pass");
  return { status: "pass", label: `build + ${passed} tests`, detail: ciTail(out) };
}

/**
 * Run the CI gate for a task that just entered `review`: flip ci_status to
 * 'running' (emit so the webapp shows a spinner), run build+test via the active
 * ciRunner, then persist the pass/fail result + summary (emit again). Never
 * throws — a runner error is recorded as a failed CI rather than crashing the
 * caller. Skips entirely (leaving ci_status NULL) when the task has no worktree to
 * build in (e.g. a task rescued to review without one).
 */
export async function triggerCi(id: string): Promise<void> {
  const row = getTask(id);
  if (!row) return;
  const dir = getDirectory(row.directory_id);
  if (!dir) return;
  // Nothing to build/test — leave CI unset rather than spawning bun in a dir that
  // isn't there (also what keeps tests that seed worktree-less rows from running
  // a real build).
  if (!existsSync(git.worktreePath(dir.path, id))) return;

  db.query(`UPDATE tasks SET ci_status='running', ci_summary=NULL WHERE id=?`).run(id);
  emitUpdated(id);

  let result: CiResult;
  try {
    result = await ciRunner(dir.path, id);
  } catch (e) {
    result = { status: "fail", label: "CI error", detail: (e as Error).message };
  }
  // First line is the badge label; the rest (if any) is the output tail.
  const summary = result.detail ? `${result.label}\n\n${result.detail}` : result.label;
  // Only write back while the task is still in review — if it merged/aborted while
  // CI ran, don't resurrect stale CI state onto it.
  const res = db
    .query(`UPDATE tasks SET ci_status=?, ci_summary=? WHERE id=? AND status='review'`)
    .run(result.status, summary, id);
  if (res.changes === 0) return;
  emitUpdated(id);
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
  //
  // This is a CLEAN re-queue (fresh intent) — it clears the dispatch retry state
  // so it never counts as a dispatch failure. A genuine dispatch failure goes
  // through markDispatchFailure instead, which is what implements the bounded
  // retry + backoff + give-up.
  const row = getTask(id);
  await herdr.teardownTask(row?.herdr_tab_id, id, row?.herdr_pane_id);
  db.query(
    `UPDATE tasks SET status='queued', herdr_pane_id=NULL, herdr_tab_id=NULL,
       dispatch_attempts=0, last_dispatch_error=NULL, next_dispatch_at=NULL WHERE id=?`,
  ).run(id);
  emitUpdated(id);
}

/**
 * Compute the backoff delay (ms) before the Nth dispatch retry (1-based attempt
 * count): exponential growth capped at `dispatchBackoffCapMs`. Exported so the
 * state machine can be unit-tested without spawning real dispatches.
 *   attempt 1 → base, 2 → base*2, 3 → base*4, … capped at the cap.
 */
export function dispatchBackoffMs(attempts: number): number {
  const exp = config.dispatchBackoffBaseMs * 2 ** Math.max(0, attempts - 1);
  return Math.min(exp, config.dispatchBackoffCapMs);
}

/**
 * Record a DISPATCH failure (dispatch() threw before the agent ever launched) and
 * decide what happens next — the bounded-retry / backoff / give-up state machine:
 *
 *  - Always: increment `dispatch_attempts`, store `last_dispatch_error`, and tear
 *    down any half-created herdr agent/tab (mirrors the old backToQueued cleanup).
 *  - Under the cap (`dispatch_attempts < maxDispatchAttempts`): keep status
 *    `queued` but stamp `next_dispatch_at = now + backoff(attempts)`. The tick
 *    loop skips the task until that time, so it no longer hot-loops.
 *  - At/over the cap: move to `failed` and clear `next_dispatch_at`. The
 *    dispatcher stops retrying; only POST /api/tasks/:id/requeue revives it.
 *
 * This is the ONLY path that increments dispatch_attempts. Reject / conflict
 * kick-back (requestChanges) and the clean backToQueued re-queue reset it instead.
 */
export async function markDispatchFailure(id: string, err: string): Promise<void> {
  const row = getTask(id);
  if (!row) return;
  // Free any orphaned herdr agent/tab from the failed start so a retry doesn't
  // collide on `agent_name_taken`.
  await herdr.teardownTask(row.herdr_tab_id, id, row.herdr_pane_id);

  const attempts = (row.dispatch_attempts ?? 0) + 1;
  const dir = getDirectory(row.directory_id);

  if (attempts >= config.maxDispatchAttempts) {
    db.query(
      `UPDATE tasks SET status='failed', dispatch_attempts=?, last_dispatch_error=?,
         next_dispatch_at=NULL, herdr_pane_id=NULL, herdr_tab_id=NULL WHERE id=?`,
    ).run(attempts, err, id);
    if (dir) updateTaskMdStatus(dir.path, id, "failed");
    console.error(
      `[butchr] task ${id} failed to dispatch after ${attempts} attempts: ${err}`,
    );
    emitUpdated(id);
    return;
  }

  const nextAt = new Date(Date.now() + dispatchBackoffMs(attempts)).toISOString();
  db.query(
    `UPDATE tasks SET status='queued', dispatch_attempts=?, last_dispatch_error=?,
       next_dispatch_at=?, herdr_pane_id=NULL, herdr_tab_id=NULL WHERE id=?`,
  ).run(attempts, err, nextAt, id);
  console.warn(
    `[butchr] dispatch attempt ${attempts}/${config.maxDispatchAttempts} failed ` +
      `for ${id}; retrying after ${nextAt}: ${err}`,
  );
  emitUpdated(id);
}

/**
 * Operator escape hatch: revive a `failed` (or otherwise stuck non-terminal) task
 * by clearing the dispatch retry state and putting it back to `queued`, so the
 * dispatcher retries it fresh. Refuses genuinely terminal tasks (merged/aborted).
 */
export async function requeueTask(id: string): Promise<TaskView> {
  const row = getTask(id);
  if (!row) throw new HttpError(404, `task not found: ${id}`);
  if (row.status === "merged" || row.status === "aborted") {
    throw new HttpError(409, `task is ${row.status}; cannot re-queue`);
  }
  const dir = getDirectory(row.directory_id);
  // Tear down any lingering agent/tab defensively before a fresh dispatch.
  await herdr.teardownTask(row.herdr_tab_id, id, row.herdr_pane_id);
  db.query(
    `UPDATE tasks SET status='queued', dispatch_attempts=0, last_dispatch_error=NULL,
       next_dispatch_at=NULL, herdr_pane_id=NULL, herdr_tab_id=NULL WHERE id=?`,
  ).run(id);
  if (dir) updateTaskMdStatus(dir.path, id, "queued");
  emitUpdated(id);
  return taskView(id)!;
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
