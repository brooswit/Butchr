// The dispatcher loop. On each tick it finds directories that have queued tasks
// and no running task, dispatches the next queued task to herdr, and spawns a
// watcher that blocks until the agent finishes and then moves the task to review.
//
// Concurrency model: serial per directory. The `status='running'` row is the
// lock; `dispatching`/`watching` sets guard against the in-tick race window.
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

const dispatching = new Set<string>(); // directory ids mid-dispatch
const watching = new Set<string>(); // task ids with an active watcher

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

let ticking = false;
async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    // If herdr is down, do nothing this tick (no error spam — it may come back).
    if (!(await herdr.isUp())) return;

    const dirs = db.query<DirectoryRow, []>(`SELECT * FROM directories`).all();
    for (const dir of dirs) {
      if (dispatching.has(dir.id)) continue;

      const running = db
        .query<{ n: number }, [string]>(
          `SELECT COUNT(*) AS n FROM tasks WHERE directory_id=? AND status='running'`,
        )
        .get(dir.id)!.n;
      if (running > 0) continue;

      const next = db
        .query<TaskRow, [string]>(
          `SELECT * FROM tasks WHERE directory_id=? AND status='queued'
           ORDER BY created_at ASC LIMIT 1`,
        )
        .get(dir.id);
      if (!next) continue;

      dispatching.add(dir.id);
      // Fire-and-forget; the watcher is spawned inside dispatch().
      dispatch(dir, next).finally(() => dispatching.delete(dir.id));
    }
  } finally {
    ticking = false;
  }
}

async function dispatch(dir: DirectoryRow, task: TaskRow): Promise<void> {
  try {
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
      dir.herdr_workspace ?? undefined,
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
      if (Date.now() > deadline) {
        timedOut = true;
        break;
      }
      await sleep(1000);
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

    // Move to review regardless — human inspects diff + snapshot.
    markReview(taskId, snapshot);
    watching.delete(taskId);
    console.log(`[butchr] task ${taskId} → review`);
  })();
}
