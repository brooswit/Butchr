// Startup reaper: self-heal git worktrees and herdr panes/agents leaked by tasks
// that reached a TERMINAL state (merged / failed / rolled_back / aborted) or that no
// longer have a DB row at all. Observed bug: an aborted task's worktree + branch (and
// occasionally a husk herdr pane) could survive a server restart and had to be
// removed by hand. This runs ONCE on boot (see index.ts) and is deliberately
// conservative — it NEVER touches the main worktree or a worktree whose task is
// still live (inactive/in_progress/in_review/rolling_back/blocked/...).
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { config } from "./config.ts";
import { ALL_STATUSES, db, getStoryRow, isTerminal } from "./db.ts";
import type { StoryStatus, WorkspaceRow, TaskRow } from "./db.ts";
import { run } from "./exec.ts";
import { storyBranchName } from "./git.ts";
import { harness } from "./harness.ts";
import { claudeAlive } from "./liveness.ts";
import { recoverStuckGates, requeueForResume } from "./tasks.ts";

const git = config.gitBin;

// A task in a TERMINAL state (merged/failed/rolled_back/aborted — see db.isTerminal) is
// DONE: its worktree/branch/herdr pane are safe to reap. Everything else (idea/spec_review/
// blocked/needs_info/inactive/in_progress/in_review/rolling_back) is still live and must be
// left alone. In particular `blocked` and `inactive` are pre-dispatch WAITING states, not
// terminal: their worktree (and the session they will resume into) must survive until they
// run. The terminal membership is sourced ONCE from db (isTerminal / ALL_STATUSES) — no
// open-coded status list here.
const TERMINAL_STATUSES = ALL_STATUSES.filter(isTerminal);

// The dir-name prefix of a STORY's worktree (`<repo>/butchr-story-<storyId>` — see
// git.storyWorktreePath). A story worktree is a DIRECT child of the repo root, exactly like
// a task worktree, so the worktree sweep below must tell them apart and resolve a story
// worktree against the STORIES table (not the tasks table).
const STORY_WORKTREE_PREFIX = "butchr-story-";

// A STORY is TERMINAL (its worktree/branch are safe to reap) only in `done`/`aborted`. The
// live states open/merging/merge_blocked must be left ALONE — their worktree carries the
// isolated story's checkout (subtasks branch off / ff into it). `merging` is already re-driven
// by stories.recoverMergingStories before reapOrphans runs, but we still treat it as live for
// safety (the exposure this guards is the OPEN / merge_blocked story).
function isStoryTerminal(status: StoryStatus): boolean {
  return status === "done" || status === "aborted";
}

// Most recent reapOrphans outcome, retained so /health can surface self-heal
// activity at a glance (see server.healthResponse). `at` is null until the first
// run completes (reapOrphans runs once on boot — see index.ts).
export type ReapResult = { worktrees: number; husks: number; at: string | null };
let lastReap: ReapResult = { worktrees: 0, husks: 0, at: null };

/** The most recent reapOrphans outcome (zeros + null timestamp before first run). */
export function getLastReap(): ReapResult {
  return lastReap;
}

/** Parse the `worktree <path>` lines out of `git worktree list --porcelain`. */
function parseWorktreePaths(porcelain: string): string[] {
  const paths: string[] = [];
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      paths.push(line.slice("worktree ".length).trim());
    }
  }
  return paths;
}

/**
 * Remove one orphaned worktree + delete its branch, best-effort. `branch` is the branch
 * name to delete — the task id for a task worktree, but `butchr/story/<id>` for a story
 * worktree (which differs from its dir name). Errors are swallowed (the worktree may be
 * partly gone, the branch already deleted, etc.); a failed `worktree remove` is followed
 * by a `prune` so a stale admin entry doesn't linger. Logs a `[butchr]` line on every reap.
 */
async function reapWorktree(
  dir: string,
  wtPath: string,
  branch: string,
  reason: string,
): Promise<void> {
  const rm = await run([git, "-C", dir, "worktree", "remove", "--force", wtPath]);
  await run([git, "-C", dir, "branch", "-D", branch]).catch(() => {});
  if (!rm.ok) {
    await run([git, "-C", dir, "worktree", "prune"]).catch(() => {});
  }
  console.log(`[butchr] reaped orphaned worktree ${wtPath} (${reason})`);
}

/**
 * Reap orphaned worktrees + herdr husks across every registered workspace.
 *
 * Worktrees: for each registered repo, `git worktree list --porcelain` enumerates
 * its worktrees. We only consider DIRECT children of the repo root (that's where
 * butchr puts task AND story worktrees), which naturally skips the main worktree
 * (whose path IS the repo root). Two kinds of child worktree, told apart by dir name:
 *   - STORY worktrees (`<repo>/butchr-story-<storyId>`) resolve against the STORIES
 *     table — reaped only when no LIVE story owns them (gone, or terminal done/aborted).
 *     A live open/merge_blocked story's checkout is left untouched (the bug this fixes:
 *     they used to be force-removed on every boot). Their branch is `butchr/story/<id>`.
 *   - TASK worktrees (`<repo>/<taskId>`) resolve against the tasks table — reaped when
 *     the task id is in a TERMINAL state OR has no task row at all; an active task's
 *     worktree is left untouched. Their branch IS the task id.
 * Each reap removes the worktree (`--force`) and deletes its branch, best-effort.
 *
 * herdr husks: any TERMINAL-state task whose agent name is still registered with
 * herdr gets deregistered (clears the name + closes its pane/tab) so dead tasks
 * don't leave husk panes/tabs accumulating. Skipped entirely when herdr is down
 * (we can't talk to it) — worktree reaping still proceeds, since git works
 * regardless.
 */
export async function reapOrphans(
  herdrUp: boolean,
): Promise<{ worktrees: number; husks: number }> {
  let worktrees = 0;
  let husks = 0;

  const dirs = db.query<WorkspaceRow, []>(`SELECT * FROM workspaces`).all();
  for (const dir of dirs) {
    const list = await run([git, "-C", dir.path, "worktree", "list", "--porcelain"]);
    if (!list.ok) continue; // repo gone / not a git repo right now — skip
    for (const wtPath of parseWorktreePaths(list.stdout)) {
      // Only butchr-style worktrees: a direct child of the repo root. This skips the
      // main worktree (path === repo root → dirname is the parent) and any unrelated
      // nested worktree.
      if (dirname(wtPath) !== dir.path) continue;
      const name = basename(wtPath); // dir name relative to the repo root

      // STORY worktree (`<repo>/butchr-story-<storyId>`): a direct child of the repo root
      // like a task worktree, so it must NOT be treated as a task id (no tasks row → it
      // would be force-removed on every boot, destroying a LIVE open/merge_blocked story's
      // checkout). Resolve it against the STORIES table instead and reap only when no LIVE
      // story owns it. Its branch is `butchr/story/<id>` (storyBranchName), NOT the dir name.
      if (name.startsWith(STORY_WORKTREE_PREFIX)) {
        const storyId = name.slice(STORY_WORKTREE_PREFIX.length);
        const story = getStoryRow(storyId);
        if (story && !isStoryTerminal(story.status)) continue; // live story — leave alone
        const reason = story ? `story ${story.status}` : "no story row";
        await reapWorktree(dir.path, wtPath, storyBranchName(storyId), reason);
        worktrees++;
        continue;
      }

      const taskId = name; // task worktree: the dir name IS the task id / branch
      const task = db
        .query<TaskRow, [string]>(`SELECT * FROM tasks WHERE id=?`)
        .get(taskId);
      // A story Work NODE is never a bare-id worktree (story checkouts use STORY_WORKTREE_PREFIX,
      // handled above), but exclude it STRUCTURALLY so a node is never force-reaped here even if
      // its status becomes non-terminal in B.3 (B.2: node-exclusion via work_kind, not 'merged').
      if (task && task.work_kind === "node") continue;
      if (task && !isTerminal(task.status)) continue; // live task — leave alone

      const reason = task ? `task ${task.status}` : "no task row";
      await reapWorktree(dir.path, wtPath, taskId, reason);
      worktrees++;
    }
  }

  // herdr husks: a terminal-state task whose agent name is still registered. This is
  // keyed strictly by TASK id, so the per-workspace managed CTO agents (each tracked
  // in its own `cto_agent` row under the name `<config.ctoAgentName>-<workspaceId>` —
  // never a task id) are never matched here and their panes are never orphaned/reaped.
  // See src/workspace-agent.ts.
  if (herdrUp) {
    // Same terminal membership as the worktree sweep above — derived from db, bound as
    // placeholders so the SQL IN-list can never drift from isTerminal/ALL_STATUSES. The
    // `work_kind='leaf'` guard excludes story Work NODES: a node carries a TERMINAL status
    // ('merged') so it MATCHES this set today and is saved only because no agent is registered
    // under its bare id — exclude it STRUCTURALLY (B.2) so it stays out once B.3 makes node
    // status real, never via the accidental terminal-'merged' anchor.
    const placeholders = TERMINAL_STATUSES.map(() => "?").join(",");
    const terminal = db
      .query<TaskRow, string[]>(
        `SELECT * FROM tasks WHERE status IN (${placeholders}) AND work_kind='leaf'`,
      )
      .all(...TERMINAL_STATUSES);
    for (const t of terminal) {
      if (!(await harness.agentExists(t.id))) continue;
      // Clears the name via `agent rename --clear` and closes the orphaned
      // pane + its tab (best-effort inside agentDeregister).
      await harness.agentDeregister(t.id).catch(() => {});
      husks++;
      console.log(`[butchr] reaped herdr husk for terminal task ${t.id} (${t.status})`);
    }
  }

  lastReap = { worktrees, husks, at: new Date().toISOString() };
  return { worktrees, husks };
}

/**
 * AUTO-RESUME BACKSTOP for host/herdr restarts. A boot-time sweep (runs after
 * reconcileRunningTasks — see index.ts) that catches any task butchr THINKS is
 * `in_progress` with a live pane but whose `claude` process is NOT actually alive: a
 * power loss / herdr restart killed claude and left herdr's pane as a bare login shell
 * (so `agentExists` lies). The ground truth is the OS process — claudeAlive checks
 * /proc for a live claude carrying the session id (see src/liveness.ts).
 *
 * For each such task that did NOT exit on its own (no `.done` exit-code file = it was
 * KILLED, not a clean finish), it routes through tasks.requeueForResume — the same
 * bounded auto-resume the dispatcher uses — which tears down the husk pane and resets
 * the task so the dispatch tick relaunches the SAME session via `claude --resume`.
 *
 * This is a SAFETY NET: reconcileRunningTasks already handles every running-with-pane
 * task at boot (re-adopting the live ones, auto-resuming the dead ones), so a clean
 * boot leaves nothing here. It exists so a dead agent is NEVER left zombied if the
 * primary reconcile missed it. Skipped when herdr is down (we can't probe the agent
 * name; reconcile already left those as-is). Returns how many it auto-resumed.
 */
export async function reapDeadRunningAgents(herdrUp: boolean): Promise<number> {
  if (!herdrUp) return 0;
  const runsDir = join(config.dataDir, "runs");
  const rows = db
    .query<TaskRow, []>(
      `SELECT * FROM tasks WHERE status='in_progress' AND has_agent=1 AND work_kind='leaf'`,
    )
    .all();
  let resumed = 0;
  for (const t of rows) {
    // Genuinely alive? (process is ground truth — pane/agent-name survive a restart.)
    if (claudeAlive(t.session_id)) continue;
    // Exited on its own (`.done` present) → leave it for the normal review rescue, not
    // an auto-resume (resume is only for an agent KILLED mid-work).
    if (existsSync(join(runsDir, `${t.id}.done`))) continue;
    const r = await requeueForResume(
      t.id,
      "agent process not alive (reaper backstop; host/herdr restart suspected)",
    );
    if (r === "resumed" || r === "fresh") resumed++;
  }
  if (resumed > 0) {
    console.log(`[butchr] reaper backstop auto-resumed ${resumed} dead running agent(s)`);
  }
  return resumed;
}

/**
 * GATE-RECOVERY BACKSTOP for host/herdr restarts — the sibling of reapDeadRunningAgents
 * for CI/conformance GATES. The CI build/test gate and the conformance reviewer both run
 * FIRE-AND-FORGET in butchr's OWN process, so a power loss / restart kills a gate mid-run
 * and leaves the task stuck `ci_status='running'` / `conformance_status='checking'` forever
 * (it can never become mergeable until requeued by hand — the real incident this fixes).
 *
 * This boot-time sweep delegates to tasks.recoverStuckGates, which re-triggers every
 * in-flight gate that is NOT actually live in this process (on a fresh boot the in-process
 * liveness sets are empty, so every in-flight status is provably stale and re-triggered;
 * a gate that can't be re-run / keeps dying is force-settled, bounded by
 * config.maxGateRecoveryAttempts). It is a SAFETY NET: the primary startup recovery
 * (index.ts calls recoverStuckGates directly, before the dispatcher starts) already
 * re-triggered them, so on a clean boot the re-triggered gates are now live-in-process and
 * this finds nothing — exactly mirroring how reapDeadRunningAgents is a no-op after
 * reconcileRunningTasks. Returns how many gates it re-triggered.
 */
export async function reapStuckGates(): Promise<number> {
  const { ci, conformance, settled } = await recoverStuckGates();
  const retriggered = ci + conformance;
  if (retriggered > 0 || settled > 0) {
    console.log(
      `[butchr] reaper backstop recovered stuck gates: re-triggered ${ci} CI + ` +
        `${conformance} conformance, force-settled ${settled}`,
    );
  }
  return retriggered;
}
