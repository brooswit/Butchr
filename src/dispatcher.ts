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
import { adoptPane, backToQueued, finalizeTask, getTask, markReview, markRunning, setIdle } from "./tasks.ts";

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
const finalizing = new Set<string>(); // task ids with an active finalize-watcher
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

/** Absolute path to a task's run log (the `script` typescript). */
function runLogPath(taskId: string): string {
  return join(runsDir, `${taskId}.log`);
}

/**
 * Read and sanitize a task's run log into a human-readable snapshot. Used by the
 * task service to capture the agent's post-merge wrap-up when finalizing. Returns
 * "" if the log is missing or unreadable.
 */
export function readRunLogSnapshot(taskId: string): string {
  const logFile = runLogPath(taskId);
  if (!existsSync(logFile)) return "";
  try {
    return sanitizeTypescript(readFileSync(logFile, "utf8"));
  } catch {
    return "";
  }
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

/**
 * Startup reconcile: re-adopt the herdr agents butchr launched before it was
 * restarted, instead of orphaning them. Meant to run ONCE, before the tick loop
 * begins (see index.ts).
 *
 * For every task still marked `running` in the DB (its in-memory watcher was lost
 * when butchr stopped):
 *   - If a live herdr agent with the task's name still exists, RE-ADOPT it:
 *     record its (possibly new) pane id back onto the task and re-spawn the
 *     watcher against it. No fresh agentStart — the agent keeps working and its
 *     completion/idle detection resumes. (If it already ended, spawnWatcher's
 *     normal "ended without request_review" path rescues it to review.)
 *   - If no live agent exists, the agent died while butchr was down: rescue the
 *     task into `review` with an "ended while butchr was offline" snapshot,
 *     mirroring the watcher's vanished-path.
 *
 * Genuinely-queued tasks (never dispatched) are untouched here — the normal tick
 * loop gives them their fresh agentStart.
 *
 * `herdrUp` says whether we can probe agent liveness. If herdr is down we cannot
 * tell adopt from rescue without risking either orphaning a live agent or falsely
 * rescuing one, so we leave the tasks `running` (they can still submit via the
 * request_review MCP path) and reconcile on a later restart with herdr up.
 */
export async function reconcileRunningTasks(
  herdrUp: boolean,
): Promise<{ adopted: number; rescued: number; skipped: number }> {
  const rows = db
    .query<QueuedRow, []>(
      `SELECT t.*, d.path, d.label, d.herdr_workspace, d.herdr_pane, d.id AS dir_id
         FROM tasks t JOIN directories d ON d.id = t.directory_id
         WHERE t.status='running'`,
    )
    .all();
  if (rows.length === 0) return { adopted: 0, rescued: 0, skipped: 0 };

  if (!herdrUp) {
    console.warn(
      `[butchr] herdr down at startup — leaving ${rows.length} running task(s) ` +
        `as-is (cannot distinguish live agents from dead ones); will reconcile ` +
        `on a later restart with herdr up`,
    );
    return { adopted: 0, rescued: 0, skipped: rows.length };
  }

  let adopted = 0;
  let rescued = 0;
  for (const row of rows) {
    if (watching.has(row.id)) continue; // already adopted (defensive)

    const dir: DirectoryRow = {
      id: row.dir_id,
      path: row.path,
      label: row.label,
      herdr_workspace: row.herdr_workspace,
      herdr_pane: row.herdr_pane,
      created_at: row.created_at,
    };
    const logFile = runLogPath(row.id);
    const doneFile = join(runsDir, `${row.id}.done`);

    if (await herdr.agentExists(row.id)) {
      // Live agent — re-adopt. Record its current pane (it may have moved while
      // butchr was down) and re-attach a watcher so completion/idle resume.
      const paneId =
        (await herdr.agentPaneId(row.id)) ?? row.herdr_pane_id ?? row.id;
      if (paneId !== row.herdr_pane_id) adoptPane(row.id, paneId);
      spawnWatcher(dir, row.id, paneId, logFile, doneFile);
      adopted++;
      console.log(`[butchr] re-adopted running task ${row.id} (pane ${paneId})`);
    } else {
      // Agent gone — it ended while butchr was offline. Rescue into review with
      // whatever output was logged, closing any husk pane defensively.
      if (row.herdr_pane_id) {
        await herdr.paneClose(row.herdr_pane_id).catch(() => {});
      }
      const snapshot = readRunLogSnapshot(row.id);
      markReview(
        row.id,
        `[butchr] moved to review automatically: the agent ended while butchr ` +
          `was offline. Output captured as-is.\n\n${snapshot}`,
      );
      rescued++;
      console.log(`[butchr] rescued task ${row.id} → review (agent gone while offline)`);
    }
  }
  return { adopted, rescued, skipped: 0 };
}

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
// deregister it and retry once. Without this a single stale agent would block the
// task from ever dispatching. A second failure propagates to dispatch()'s catch
// (→ backToQueued, retried next tick).
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
    // Reclaim the stale agent. Closing its pane is NOT enough — herdr keeps the
    // NAME registered (and respawns the agent), so the retry would fail again.
    // agentDeregister clears the name via `agent rename --clear` and then closes
    // the orphaned pane, truly freeing the name for reuse.
    await herdr.agentDeregister(name);
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
    let reason = "the agent exited unexpectedly without calling request_review";
    if (timedOut) {
      reason = "the agent did not finish within the timeout";
    } else if (existsSync(doneFile)) {
      const code = readFileSync(doneFile, "utf8").trim();
      reason =
        code && code !== "0"
          ? `the agent exited unexpectedly with code ${code} without calling request_review`
          : "the agent process exited unexpectedly without calling request_review";
    } else if (vanished) {
      reason =
        "the agent exited unexpectedly (its herdr pane/process is gone) without calling request_review";
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

/**
 * Watch a `finalizing` task and complete it (→ merged) once the post-merge agent
 * is done wrapping up. Spawned by approveTask after a successful merge. The branch
 * is already in main; we just wait for the agent to go quiet and then hand off to
 * finalizeTask (which closes the pane, captures the wrap-up, and cleans up).
 *
 * Triggers finalize on ANY of:
 *   - the agent's run log goes quiet for `idleMs`. The idle clock starts at the
 *     agent's last log write, or at the moment we began watching if that write
 *     predates the approve (so a log left stale while the agent was blocked in
 *     request_review still gets a full idleMs grace window before finalizing,
 *     yet an agent that was already idle and never writes a wrap-up still
 *     finalizes instead of hanging until the pane vanishes / timeout);
 *   - the agent's pane/process ends (doneFile written or herdr pane vanished);
 *   - `finalizeTimeoutMs` elapses (hard cap on a chatty agent).
 */
export function startFinalizeWatcher(taskId: string): void {
  if (finalizing.has(taskId)) return;
  finalizing.add(taskId);
  const logFile = runLogPath(taskId);
  const doneFile = join(runsDir, `${taskId}.done`);
  (async () => {
    const startedAt = Date.now();
    const deadline = startedAt + config.finalizeTimeoutMs;
    let seenAlive = false;
    let reason = "the agent went idle";
    while (true) {
      // If the task left `finalizing` under us (e.g. recovery already merged it),
      // there is nothing to do.
      if (getTask(taskId)?.status !== "finalizing") {
        finalizing.delete(taskId);
        return;
      }
      if (existsSync(doneFile)) {
        reason = "the agent finished and exited";
        break;
      }
      if (Date.now() > deadline) {
        reason = "the finalize timeout elapsed";
        break;
      }
      const alive = await herdr.agentExists(taskId);
      if (alive) seenAlive = true;
      else if (seenAlive) {
        reason = "the agent pane/process ended";
        break;
      }
      // Idle trigger. The agent is "quiet since" its last log write — but if that
      // write predates the approve (the log was left stale while the agent was
      // blocked in request_review), we start the idle clock at startedAt instead.
      // That gives an agent that's about to write its wrap-up a full idleMs grace
      // window to wake up, while still finalizing an agent that was already idle
      // and never writes anything post-approval (it would otherwise hang here
      // until the pane vanished or the finalize timeout elapsed).
      if (config.idleMs > 0) {
        try {
          const mtimeMs = statSync(logFile).mtimeMs;
          const quietSince = Math.max(mtimeMs, startedAt);
          if (Date.now() - quietSince > config.idleMs) {
            reason = mtimeMs > startedAt ? "the agent went idle" : "the agent was already idle";
            break;
          }
        } catch {
          /* no log yet — keep waiting */
        }
      }
      await sleep(1000);
    }
    finalizing.delete(taskId);
    await finalizeTask(taskId).catch((e) => {
      console.error(`[butchr] finalize failed for ${taskId}:`, (e as Error).message);
    });
    console.log(`[butchr] task ${taskId} → merged (${reason})`);
  })();
}
