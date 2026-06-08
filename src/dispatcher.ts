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
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { db } from "./db.ts";
import type { DirectoryRow, TaskRow } from "./db.ts";
import * as git from "./git.ts";
import * as herdr from "./herdr.ts";
import { readTaskMd, renderAgentPrompt } from "./taskmd.ts";
import { backToQueued, getTask, markReview, markRunning, setIdle } from "./tasks.ts";

const promptsDir = join(config.dataDir, "prompts");
const runsDir = join(config.dataDir, "runs");
const mcpDir = join(config.dataDir, "mcp");
mkdirSync(promptsDir, { recursive: true });
mkdirSync(runsDir, { recursive: true });
mkdirSync(mcpDir, { recursive: true });

// The host the agent (running locally) should dial to reach butchr's MCP server.
// If butchr binds 0.0.0.0 (all interfaces), the agent still connects via loopback.
const mcpHost = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;

// Shell-escape a string for safe interpolation inside a single-quoted context.
function shq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

// The agent runs under `script`, so its log is a raw terminal typescript: ANSI
// escapes, carriage returns, and `script`'s own "Script started/done" banners.
// Clean it up before showing it to a human as a fallback snapshot.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][0-9A-Za-z]|\x1b[@-Z\\-_]/g;
function sanitizeTypescript(raw: string): string {
  return raw
    .replace(ANSI_RE, "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .filter((l) => !/^Script (started|done) on /.test(l))
    .join("\n")
    .trim();
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

    // Per-task MCP config pointing the agent at butchr's /mcp/<id> endpoint.
    const mcpConfigFile = join(mcpDir, `${task.id}.json`);
    writeFileSync(
      mcpConfigFile,
      JSON.stringify({
        mcpServers: {
          butchr: {
            type: "http",
            url: `http://${mcpHost}:${config.port}/mcp/${task.id}`,
          },
        },
      }),
      "utf8",
    );

    const agentCmd = config.agentCmd
      .replaceAll("{{PROMPT_FILE}}", promptFile)
      .replaceAll("{{MCP_CONFIG}}", mcpConfigFile);

    // The agent is interactive and long-lived: it signals completion by calling
    // the request_review MCP tool, NOT by exiting. We must keep its stdout/stdin
    // attached to a TTY so its full-screen interface actually renders in the
    // herdr pane — piping through `tee` would make stdout a pipe, so the agent
    // detects "not a terminal" and never draws its interactive UI. Instead we run
    // it under `script`, which allocates a pseudo-terminal for the agent (TTY
    // preserved → UI renders + input works) while logging everything to a file.
    //   -q quiet, -f flush after each write (live log), -e exit with the child's
    //   code, --log-out captures the typescript. SHELL=/bin/bash forces `-c` to
    //   use bash (the user's login shell may be fish, which can't parse the
    //   `$(cat ...)` in agentCmd). On exit we write the child's code to `.done`;
    // the watcher uses that (plus an herdr liveness check) only to catch an agent
    // that ended WITHOUT submitting.
    const logFile = join(runsDir, `${task.id}.log`);
    const doneFile = join(runsDir, `${task.id}.done`);
    rmSync(logFile, { force: true });
    rmSync(doneFile, { force: true });
    const wrapped =
      `SHELL=/bin/bash script -qfe --log-out ${shq(logFile)} -c ${shq(agentCmd)}; ` +
      `echo "$?" > ${shq(doneFile)}`;
    const argv = ["bash", "-lc", wrapped];

    const started = await startAgentReconciling(
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
    await backToQueued(task.id);
  }
}

// Start the agent, self-healing an `agent_name_taken` collision: if a lingering
// same-named agent (an orphan from an abandoned/aborted run) is still registered,
// close its pane and retry once. Without this a single stale agent would block
// the task from ever dispatching. A second failure propagates to dispatch()'s
// catch (→ backToQueued, retried next tick).
async function startAgentReconciling(
  name: string,
  worktree: string,
  argv: string[],
  workspaceId?: string,
): Promise<herdr.StartedAgent> {
  try {
    return await herdr.agentStart(name, worktree, argv, workspaceId);
  } catch (e) {
    if (!herdr.isAgentNameTaken(e)) throw e;
    // Reclaim the stale agent's pane (fall back to the name itself as a target).
    const stalePane = (await herdr.agentPaneId(name)) ?? name;
    await herdr.paneClose(stalePane).catch(() => {});
    console.log(`[butchr] reclaimed stale agent name ${name}; retrying agentStart`);
    return await herdr.agentStart(name, worktree, argv, workspaceId);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Toggle a running task's `idle` flag from its log file's last-write time. The
// agent runs under `script -f` (flush after every write), so the log's mtime
// tracks live CLI output: if nothing has been written for `idleMs`, claude is
// alive but quiet → idle; the moment it writes again → active. Skipped entirely
// when idle detection is disabled or the log hasn't appeared yet (treating a
// missing log as "stale" would flag a just-started agent as idle).
function refreshIdle(taskId: string, logFile: string): void {
  if (config.idleMs <= 0) return;
  let mtimeMs: number;
  try {
    mtimeMs = statSync(logFile).mtimeMs;
  } catch {
    return; // no log yet — agent is still spinning up
  }
  setIdle(taskId, Date.now() - mtimeMs > config.idleMs);
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
    let vanished = false;
    // The agent is interactive: it submits by calling request_review (which moves
    // the task to `review` while the process stays ALIVE and blocked). So we do
    // NOT treat process exit as completion. We only watch for the agent ENDING —
    // process exited (`.done`) or its herdr pane vanished — so we can rescue a
    // task that would otherwise be stuck in `running`. `seenAlive` guards against
    // a false "vanished" during the brief agent-registration lag at startup.
    let seenAlive = false;
    while (true) {
      if (abortSignals.has(taskId)) break;
      // Release our slot the moment the task leaves a state the watcher owns —
      // even if the agent is still alive. We keep watching through `running`
      // (agent working) and `review` (agent alive but blocked in request_review,
      // possibly to be sent back to running on reject). If status becomes
      // queued/merged/aborted — or the row vanishes — the agent has already been
      // reclaimed elsewhere (a re-queue that closed the pane, an approve, an
      // abort), so stop looping; otherwise we'd hold the `watching` slot forever
      // and tick() would skip the task, leaving it permanently stuck.
      const cur = getTask(taskId)?.status;
      if (cur !== "running" && cur !== "review") break;
      if (existsSync(doneFile)) break; // process exited
      if (Date.now() > deadline) {
        timedOut = true;
        break;
      }
      const alive = await herdr.agentExists(taskId);
      if (alive) seenAlive = true;
      else if (seenAlive) {
        vanished = true;
        break;
      }
      // While the agent is alive, surface whether its CLI has gone quiet. (Once
      // it submits via request_review the task leaves `running`, and setIdle's
      // status guard makes this a no-op until the pane finally closes.)
      refreshIdle(taskId, logFile);
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

    // If the agent already submitted (status is `review`) or the human acted on
    // it (merged/aborted), there is nothing to rescue — the request_review path
    // owns the transition and keeps the session alive. Only a task still sitting
    // in `running` here means the agent ended WITHOUT submitting.
    const status = getTask(taskId)?.status;
    if (status !== "running") {
      watching.delete(taskId);
      return;
    }

    let snapshot = "";
    if (existsSync(logFile)) {
      try {
        snapshot = sanitizeTypescript(readFileSync(logFile, "utf8"));
      } catch {
        /* best effort */
      }
    }
    let reason = "the agent ended without calling request_review";
    if (timedOut) {
      reason = "the agent did not finish within the timeout";
    } else if (existsSync(doneFile)) {
      const code = readFileSync(doneFile, "utf8").trim();
      if (code && code !== "0") reason = `the agent exited with code ${code}`;
    } else if (vanished) {
      reason = "the agent pane/process ended without calling request_review";
    }
    snapshot =
      `[butchr] moved to review automatically: ${reason}. ` +
      `Output captured as-is.\n\n` +
      snapshot;

    // The process is gone; close the pane defensively in case a husk remains.
    await herdr.paneClose(paneId).catch(() => {});

    // Last-moment abort (signalled while we captured output): bail without
    // moving to review so abortTask's terminal state stands.
    if (abortSignals.has(taskId)) {
      abortSignals.delete(taskId);
      watching.delete(taskId);
      console.log(`[butchr] task ${taskId} watcher aborted`);
      return;
    }

    // Rescue the orphaned task into review so a human can inspect it.
    markReview(taskId, snapshot);
    watching.delete(taskId);
    console.log(`[butchr] task ${taskId} → review (${reason})`);
  })();
}
