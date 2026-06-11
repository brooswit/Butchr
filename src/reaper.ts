// Startup reaper: self-heal git worktrees and herdr panes/agents leaked by tasks
// that reached a TERMINAL state (merged / aborted / rejected) or that no longer
// have a DB row at all. Observed bug: an aborted task's worktree + branch (and
// occasionally a husk herdr pane) could survive a server restart and had to be
// removed by hand. This runs ONCE on boot (see index.ts) and is deliberately
// conservative — it NEVER touches the main worktree or a worktree whose task is
// still queued/running/review/finalizing.
import { dirname, join } from "node:path";
import { config } from "./config.ts";
import { db } from "./db.ts";
import type { DirectoryRow, TaskRow } from "./db.ts";
import { run } from "./exec.ts";
import { harness } from "./harness.ts";

const git = config.gitBin;

// A task in one of these terminal idle states is DONE — its worktree/branch/herdr
// pane are safe to reap. Everything else (idea/spec_review/blocked/needs_info/
// in_progress/in_review/finalizing) is still live and must be left alone. In
// particular `blocked` is a pre-dispatch WAITING state, not terminal: its worktree
// (and the session it will resume into) must survive until its blockers merge.
const TERMINAL = new Set(["merged", "aborted"]);

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
 * Reap orphaned worktrees + herdr husks across every registered directory.
 *
 * Worktrees: for each registered repo, `git worktree list --porcelain` enumerates
 * its worktrees. We only consider DIRECT children of the repo root (that's where
 * butchr puts task worktrees — `<repo>/<taskId>`), which naturally skips the main
 * worktree (whose path IS the repo root). A child worktree is reaped when its
 * task id (the directory/branch basename) is in a TERMINAL state OR has no task
 * row at all; an active task's worktree is left untouched. Each reap removes the
 * worktree (`--force`) and deletes its branch, best-effort.
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

  const dirs = db.query<DirectoryRow, []>(`SELECT * FROM directories`).all();
  for (const dir of dirs) {
    const list = await run([git, "-C", dir.path, "worktree", "list", "--porcelain"]);
    if (!list.ok) continue; // repo gone / not a git repo right now — skip
    for (const wtPath of parseWorktreePaths(list.stdout)) {
      // Only butchr-style task worktrees: a direct child of the repo root. This
      // skips the main worktree (path === repo root → dirname is the parent) and
      // any unrelated nested worktree.
      if (dirname(wtPath) !== dir.path) continue;
      const taskId = wtPath.slice(dir.path.length + 1); // basename relative to root

      const task = db
        .query<TaskRow, [string]>(`SELECT * FROM tasks WHERE id=?`)
        .get(taskId);
      if (task && !TERMINAL.has(task.status)) continue; // live task — leave alone

      const reason = task ? `task ${task.status}` : "no task row";
      // Remove the worktree, then delete its branch. Best-effort: swallow errors
      // (the worktree may be partly gone, the branch already deleted, etc.).
      const rm = await run([git, "-C", dir.path, "worktree", "remove", "--force", wtPath]);
      await run([git, "-C", dir.path, "branch", "-D", taskId]).catch(() => {});
      // `worktree remove` can fail if git's metadata is stale; prune so the entry
      // doesn't linger and we still consider the reap done.
      if (!rm.ok) {
        await run([git, "-C", dir.path, "worktree", "prune"]).catch(() => {});
      }
      worktrees++;
      console.log(
        `[butchr] reaped orphaned worktree ${wtPath} (${reason})`,
      );
    }
  }

  // herdr husks: a terminal-state task whose agent name is still registered. This is
  // keyed strictly by TASK id, so the per-directory managed CTO agents (each tracked
  // in its own `cto_agent` row under the name `<config.ctoAgentName>-<directoryId>` —
  // never a task id) are never matched here and their panes are never orphaned/reaped.
  // See src/cto-agent.ts.
  if (herdrUp) {
    const terminal = db
      .query<TaskRow, []>(
        `SELECT * FROM tasks WHERE status IN ('merged','aborted')`,
      )
      .all();
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
