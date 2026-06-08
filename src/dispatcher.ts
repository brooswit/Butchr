// The dispatcher loop. On each tick it finds every queued task, dispatches each
// to herdr immediately, and spawns a watcher that blocks until the agent
// finishes and then moves the task to review.
//
// Concurrency model: fully concurrent. Every queued task runs as soon as it is
// seen — there is no per-directory "one at a time" limit. Worktree isolation
// keeps tasks safe at the filesystem level (each is its own git worktree on its
// own branch). The `dispatching`/`watching` sets (both keyed by task id) guard
// against double-dispatching the same task across overlapping ticks. An optional
// global cap (config.maxConcurrent) bounds the total running count.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { db } from "./db.ts";
import type { DirectoryRow, TaskRow } from "./db.ts";
import * as git from "./git.ts";
import * as herdr from "./herdr.ts";
import { readTaskMd, renderAgentPrompt } from "./taskmd.ts";
import { backToQueued, markReview, markRunning } from "./tasks.ts";

const promptsDir = join(config.dataDir, "prompts");
const runsDir = join(config.dataDir, "runs");
mkdirSync(promptsDir, { recursive: true });
mkdirSync(runsDir, { recursive: true });

// Shell-escape a string for safe interpolation inside a single-quoted context.
function shq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

const dispatching = new Set<string>(); // task ids mid-dispatch
const watching = new Set<string>(); // task ids with an active watcher
// Task ids whose watcher has been told to bail WITHOUT moving the task to
// review — set by abortTask, consumed (and cleared) by the watcher.
const abortSignals = new Set<string>();

/**
 * Signal a running task's watcher to stop without transitioning the task to
 * review (used when aborting a running task). Returns true if a watcher was
 * actually active for this task.
 */
export function signalAbort(taskId: string): boolean {
  if (!watching.has(taskId)) return false;
  abortSignals.add(taskId);
  return true;
}

// In-flight workspace create/heal keyed by directory id, so concurrent tasks in
// the same directory share one workspace instead of racing to recreate it.
const workspaceInFlight = new Map<string, Promise<string | undefined>>();

let timer: ReturnType<typeof setInterval> | null = null;

export function startDispatcher(): void {
  if (timer) return;
  // Fire immediately, then on an interval.
  tick();
  timer = setInterval(tick, config.tickMs);
}

export function stopDispatcher(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

// A queued task joined to its directory, as returned by the dispatch query.
// `dir_id` aliases the directory's id (the unaliased `id` is the task's). The
// task's `created_at` shadows the directory's, which is fine — we never read the
// directory's created_at here.
type QueuedRow = TaskRow & {
  path: string;
  label: string | null;
  herdr_workspace: string | null;
  herdr_pane: string | null;
  dir_id: string;
};

let ticking = false;
async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    // If herdr is down, do nothing this tick (no error spam — it may come back).
    if (!(await herdr.isUp())) return;

    // Optional global cap on simultaneously running tasks. 0 = unlimited.
    // Count both running tasks and in-flight dispatches (which haven't reached
    // status='running' yet) so we never overshoot the cap across ticks.
    let budget = Infinity;
    if (config.maxConcurrent > 0) {
      const running = db
        .query<{ n: number }, []>(
          `SELECT COUNT(*) AS n FROM tasks WHERE status='running'`,
        )
        .get()!.n;
      budget = config.maxConcurrent - running - dispatching.size;
      if (budget <= 0) return;
    }

    const rows = db
      .query<QueuedRow, []>(
        `SELECT t.*, d.path, d.label, d.herdr_workspace, d.herdr_pane, d.id AS dir_id
         FROM tasks t JOIN directories d ON d.id = t.directory_id
         WHERE t.status='queued'
         ORDER BY t.created_at ASC`,
      )
      .all();

    for (const row of rows) {
      if (dispatching.has(row.id) || watching.has(row.id)) continue;
      if (budget <= 0) break;
      budget--;

      const dir: DirectoryRow = {
        id: row.dir_id,
        path: row.path,
        label: row.label,
        herdr_workspace: row.herdr_workspace,
        herdr_pane: row.herdr_pane,
        created_at: row.created_at,
      };

      dispatching.add(row.id);
      // Fire-and-forget, concurrently; the watcher is spawned inside dispatch().
      dispatch(dir, row).finally(() => dispatching.delete(row.id));
    }
  } finally {
    ticking = false;
  }
}

// Ensure the directory's herdr workspace still exists; recreate it (and update
// the DB) if herdr was restarted or the workspace was closed out from under us.
// Concurrent tasks in the same directory can call this at once, so dedupe by
// directory id: the first caller does the create/heal and the rest await its
// promise, which is cleared once it settles.
function ensureWorkspace(dir: DirectoryRow): Promise<string | undefined> {
  const existing = workspaceInFlight.get(dir.id);
  if (existing) return existing;
  const p = healWorkspace(dir).finally(() => workspaceInFlight.delete(dir.id));
  workspaceInFlight.set(dir.id, p);
  return p;
}

async function healWorkspace(dir: DirectoryRow): Promise<string | undefined> {
  if (dir.herdr_workspace && (await herdr.workspaceExists(dir.herdr_workspace))) {
    return dir.herdr_workspace;
  }
  const label = dir.label ?? dir.path.split("/").pop() ?? dir.path;
  const ws = await herdr.workspaceCreate(dir.path, label);
  db.query(
    `UPDATE directories SET herdr_workspace=?, herdr_pane=? WHERE id=?`,
  ).run(ws.workspaceId ?? null, ws.rootPaneId ?? null, dir.id);
  dir.herdr_workspace = ws.workspaceId ?? null;
  console.log(`[butchr] recreated herdr workspace for ${label} (${ws.workspaceId})`);
  return ws.workspaceId;
}

async function dispatch(dir: DirectoryRow, task: TaskRow): Promise<void> {
  try {
    // Heal a missing workspace (herdr restart / manual close).
    const workspaceId = await ensureWorkspace(dir);

    // Ensure the worktree exists (idempotent — handles rejected re-runs).
    const worktree = await git.createWorktree(dir.path, task.id);

    // Render the full prompt (context files + prompt + prior review notes) to a
    // file in butchr's own data dir, so we never pollute the repo worktree.
    const doc = readTaskMd(dir.path, task.id);
    const rendered = renderAgentPrompt(dir.path, doc);
    const promptFile = join(promptsDir, `${task.id}.md`);
    writeFileSync(promptFile, rendered, "utf8");

    const agentCmd = config.agentCmd.replaceAll("{{PROMPT_FILE}}", promptFile);

    // Wrap the agent command so that:
    //  - its output is teed to a log file (still visible live in the herdr pane)
    //  - a completion marker (with the agent's exit code) is written when done
    // This is how the watcher detects completion + captures output, independent
    // of herdr's pane/agent-status lifecycle (panes vanish on command exit).
    const logFile = join(runsDir, `${task.id}.log`);
    const doneFile = join(runsDir, `${task.id}.done`);
    rmSync(logFile, { force: true });
    rmSync(doneFile, { force: true });
    const wrapped =
      `set -o pipefail; { ${agentCmd} ; } 2>&1 | tee ${shq(logFile)}; ` +
      `echo "\${PIPESTATUS[0]}" > ${shq(doneFile)}`;
    const argv = ["bash", "-lc", wrapped];

    const started = await herdr.agentStart(
      task.id,
      worktree,
      argv,
      workspaceId ?? undefined,
    );

    markRunning(task.id, started.paneId);
    spawnWatcher(dir, task.id, started.paneId, logFile, doneFile);
  } catch (e) {
    // Dispatch failed — leave it queued so the next tick retries.
    console.error(`[butchr] dispatch failed for ${task.id}:`, (e as Error).message);
    backToQueued(task.id);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function spawnWatcher(
  _dir: DirectoryRow,
  taskId: string,
  paneId: string,
  logFile: string,
  doneFile: string,
): void {
  if (watching.has(taskId)) return;
  watching.add(taskId);
  (async () => {
    const deadline = Date.now() + config.agentTimeoutMs;
    let timedOut = false;
    // Poll for the completion marker written by the wrapped command.
    while (!existsSync(doneFile)) {
      if (abortSignals.has(taskId)) break;
      if (Date.now() > deadline) {
        timedOut = true;
        break;
      }
      await sleep(1000);
    }

    // Aborted out from under us: drop the task without capturing output or
    // moving it to review. abortTask owns the pane close + worktree cleanup.
    if (abortSignals.has(taskId)) {
      abortSignals.delete(taskId);
      watching.delete(taskId);
      console.log(`[butchr] task ${taskId} watcher aborted`);
      return;
    }

    let snapshot = "";
    if (existsSync(logFile)) {
      try {
        snapshot = readFileSync(logFile, "utf8");
      } catch {
        /* best effort */
      }
    }
    if (timedOut) {
      snapshot =
        `[butchr] agent did not finish within the timeout; output captured as-is.\n\n` +
        snapshot;
    } else if (existsSync(doneFile)) {
      const code = readFileSync(doneFile, "utf8").trim();
      if (code && code !== "0") {
        snapshot = `[butchr] agent exited with code ${code}.\n\n` + snapshot;
      }
    }

    // Pane usually self-closes when the command exits; close defensively.
    await herdr.paneClose(paneId).catch(() => {});

    // Last-moment abort (signalled while we captured output): bail without
    // moving to review so abortTask's terminal state stands.
    if (abortSignals.has(taskId)) {
      abortSignals.delete(taskId);
      watching.delete(taskId);
      console.log(`[butchr] task ${taskId} watcher aborted`);
      return;
    }

    // Move to review regardless — human inspects diff + snapshot.
    markReview(taskId, snapshot);
    watching.delete(taskId);
    console.log(`[butchr] task ${taskId} → review`);
  })();
}
