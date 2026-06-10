// The dispatcher loop. On each tick it finds every queued task and dispatches it
// to herdr immediately. A fresh task launches a new Claude session (butchr assigns
// `--session-id <uuid>`); a rejected task (which already has a session id)
// re-launches that SAME session via `--resume` so the agent reworks with full
// prior context. Each dispatch spawns a watcher whose only job is to rescue an
// agent that ENDS without submitting (the normal path is the agent calling the
// non-blocking request_review MCP tool, which moves the task to `review` in the
// DB and lets the agent exit — no live process is held waiting for a human).
//
// Concurrency model: fully concurrent, uncapped. Every queued task runs as soon
// as it is seen — there is no per-directory "one at a time" limit and no global
// cap on the number of simultaneous tasks. Worktree isolation keeps tasks safe at
// the filesystem level (each is its own git worktree on its own branch), and one
// herdr tab per task keeps them from crowding the workspace. The
// `dispatching`/`watching` sets (both keyed by task id) guard against
// double-dispatching the same task across overlapping ticks.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { db } from "./db.ts";
import type { DirectoryRow, TaskRow } from "./db.ts";
import * as git from "./git.ts";
import * as herdr from "./herdr.ts";
import { readTaskMd, renderAgentPrompt, renderReworkPrompt } from "./taskmd.ts";
import { adoptPane, getTask, markDispatchFailure, markReview, markRunning, reevaluateBlockedTask, setIdle } from "./tasks.ts";

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

/** Absolute path to a task's run log (the `script` typescript). */
function runLogPath(taskId: string): string {
  return join(runsDir, `${taskId}.log`);
}

/**
 * Read and sanitize a task's run log into a human-readable snapshot. Used by the
 * task service to capture the agent's terminal output when it submits for review
 * and again when its branch merges. Returns "" if the log is missing/unreadable.
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

// Per-workspace lock serializing the herdr "create a task's tab + start its agent
// + close the leftover root pane" critical section. herdr pane ids are POSITIONAL
// and renumber workspace-globally whenever ANY pane closes, so two concurrent
// dispatches in the same workspace would clobber each other: task B's
// `pane close <captured rootId>` can land on task A's agent pane after A's own
// close renumbered everything down (verified live — it killed A's agent and left
// B's real root pane orphaned). Serializing per workspace makes each task's pane
// setup atomic with respect to renumbering. Keyed by workspace id (panes only
// renumber within their own workspace), so tasks in DIFFERENT directories still
// run their herdr setup concurrently.
const herdrPaneLocks = new Map<string, Promise<unknown>>();
function withHerdrPaneLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = herdrPaneLocks.get(key) ?? Promise.resolve();
  const result = prev.then(fn, fn);
  // Keep the chain alive regardless of outcome so one failure doesn't break the
  // lock for later tasks in the same workspace.
  herdrPaneLocks.set(key, result.then(() => {}, () => {}));
  return result;
}

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

// Liveness markers for the /health endpoint: when the loop last ran and how many
// times. Stamped at the START of every tick (before any early-out) so the health
// check reflects that the loop itself is alive even while herdr is down.
let lastTickAt = 0; // ms epoch of the most recent tick; 0 = not yet ticked
let tickCount = 0;

/** Snapshot of dispatcher liveness for the health endpoint. */
export function dispatcherHealth(): { lastTickAt: number; tickCount: number; tickMs: number } {
  return { lastTickAt, tickCount, tickMs: config.tickMs };
}

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
      // Live agent — re-adopt. Record its current pane + tab (both may have moved
      // while butchr was down) and re-attach a watcher so completion/idle resume.
      const paneId =
        (await herdr.agentPaneId(row.id)) ?? row.herdr_pane_id ?? row.id;
      const tabId = (await herdr.agentTabId(row.id)) ?? row.herdr_tab_id ?? undefined;
      if (paneId !== row.herdr_pane_id || tabId !== row.herdr_tab_id) {
        adoptPane(row.id, paneId, tabId);
      }
      spawnWatcher(dir, row.id, paneId, logFile, doneFile);
      adopted++;
      console.log(`[butchr] re-adopted running task ${row.id} (pane ${paneId}, tab ${tabId})`);
    } else {
      // Agent gone — it ended while butchr was offline. Rescue into review with
      // whatever output was logged, closing its (now husk) tab defensively.
      await herdr.teardownTask(row.herdr_tab_id, row.id, row.herdr_pane_id);
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
  lastTickAt = Date.now();
  tickCount++;
  try {
    // If herdr is down, do nothing this tick (no error spam — it may come back).
    if (!(await herdr.isUp())) return;

    // AUTO-UNBLOCK pass: promote any `blocked` task whose blockers have all merged
    // to `queued` BEFORE the queued selection below, so a freshly-unblocked task
    // dispatches in this same tick. This is the robust-to-missed-events backstop
    // (approveTask also re-evaluates immediately for promptness). Cheap: one query
    // plus a per-task blocker check; blocked tasks are few.
    for (const b of db
      .query<{ id: string }, []>(`SELECT id FROM tasks WHERE status='blocked'`)
      .all()) {
      reevaluateBlockedTask(b.id);
    }

    // Skip tasks waiting out a dispatch backoff: next_dispatch_at set and still in
    // the future. ISO-8601 timestamps compare correctly as strings, so a simple
    // `<=` against now selects only tasks whose backoff has elapsed (or that never
    // failed, next_dispatch_at IS NULL). This is the gate that stops a repeatedly
    // failing task from hot-looping every tick.
    const nowStr = new Date().toISOString();
    const rows = db
      .query<QueuedRow, [string]>(
        `SELECT t.*, d.path, d.label, d.herdr_workspace, d.herdr_pane, d.id AS dir_id
         FROM tasks t JOIN directories d ON d.id = t.directory_id
         WHERE t.status='queued'
           AND (t.next_dispatch_at IS NULL OR t.next_dispatch_at <= ?)
         ORDER BY t.created_at ASC`,
      )
      .all(nowStr);

    // Dispatch every queued task that isn't already being dispatched/watched —
    // fully concurrent, no cap. The `dispatching`/`watching` sets only guard
    // against double-dispatching the same task across overlapping ticks.
    for (const row of rows) {
      if (dispatching.has(row.id) || watching.has(row.id)) continue;

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

/** The launch decision for a task: how to invoke its agent this dispatch. */
export type LaunchPlan = {
  /** True → re-launch the existing Claude session via `--resume` (rework). */
  isResume: boolean;
  /** The session id passed to claude: the existing one (resume) or a fresh uuid. */
  sessionId: string;
  /** `config.resumeCmd`/`agentCmd` with all placeholders substituted. */
  agentCmd: string;
  /**
   * True when a REWORK task (started_at set) had no usable session_id, so we
   * fell back to a fresh session and the prior in-session context is LOST. The
   * caller logs this; the decision itself lives here so it stays testable.
   */
  lostContext: boolean;
};

/**
 * Decide how to (re-)launch a task's agent and build the fully-substituted agent
 * command — the single source of truth for the fresh-vs-resume rules that
 * dispatch() used to inline. Exported so it can be unit-tested directly.
 *
 * Rules (mirrors the old inline logic exactly):
 *  - `started_at` set means the task ran an agent at least once (markRunning
 *    stamps it via COALESCE and it is NEVER cleared on a reject/conflict
 *    re-queue), so it is a REWORK that must `--resume` its existing session.
 *  - A fresh, never-dispatched task has both fields null → fresh `--session-id`.
 *  - INCONSISTENT STATE: a rework (`started_at` set) with no usable session_id
 *    has nothing to resume into; fall back to a FRESH session (and the caller
 *    re-renders the full prompt) rather than `--resume ""`. Flagged via
 *    `lostContext` so dispatch() can log the lost in-session history.
 *
 * Pure except for `crypto.randomUUID()` when a fresh id is needed; all console
 * side-effects stay in dispatch(), keyed off the returned flags.
 */
export function resolveLaunchCommand(
  task: Pick<TaskRow, "started_at" | "session_id">,
  promptFile: string,
  mcpConfigFile: string,
): LaunchPlan {
  const ranBefore = !!task.started_at;
  const sid = task.session_id?.trim();
  const hasSession = !!sid;

  let isResume: boolean;
  let sessionId: string;
  let lostContext = false;
  if (ranBefore && !hasSession) {
    isResume = false;
    sessionId = crypto.randomUUID();
    lostContext = true;
  } else {
    isResume = hasSession;
    sessionId = sid ?? crypto.randomUUID();
  }

  const agentCmd = (isResume ? config.resumeCmd : config.agentCmd)
    .replaceAll("{{PROMPT_FILE}}", promptFile)
    .replaceAll("{{MCP_CONFIG}}", mcpConfigFile)
    .replaceAll("{{SESSION_ID}}", sessionId);

  return { isResume, sessionId, agentCmd, lostContext };
}

async function dispatch(dir: DirectoryRow, task: TaskRow): Promise<void> {
  // Hoisted out of the try so the catch (below) can report whether a RESUME
  // (rework re-launch) failed, not just a fresh dispatch — see fix #2.
  let isResume = false;
  let sessionId = "";
  try {
    // Heal a missing workspace (herdr restart / manual close).
    const workspaceId = await ensureWorkspace(dir);

    // Ensure the worktree exists (idempotent — handles rejected re-runs).
    const worktree = await git.createWorktree(dir.path, task.id);

    // First launch vs. rework re-launch, plus the fully-substituted agent
    // command — all decided by resolveLaunchCommand (the single source of truth
    // for the fresh-vs-resume rules). The promptFile/mcpConfigFile paths are
    // deterministic from the task id, so we compute them up front (their contents
    // are written just below) and hand them in for substitution.
    const promptFile = join(promptsDir, `${task.id}.md`);
    const mcpConfigFile = join(mcpDir, `${task.id}.json`);
    const plan = resolveLaunchCommand(task, promptFile, mcpConfigFile);
    isResume = plan.isResume;
    sessionId = plan.sessionId;
    const agentCmd = plan.agentCmd;

    if (plan.lostContext) {
      // INCONSISTENT STATE: the task ran before (a reject/conflict re-queued it
      // for a `--resume`) but its session_id is missing/empty, so there is nothing
      // to resume into. resolveLaunchCommand fell back to a FRESH session; we
      // render the FULL agent prompt below (renderAgentPrompt re-includes the
      // original prompt, the context files, AND the accumulated review notes — see
      // taskmd.ts), so the new agent has everything except the lost in-session
      // history. We log loudly rather than failing the dispatch outright: a hard
      // failure would just re-queue the task to hit the SAME broken state every
      // tick forever (a stuck-task loop that never makes progress); a fresh run
      // lets the work proceed.
      console.warn(
        `[butchr] task ${task.id} is a rework (started_at=${task.started_at}) but ` +
          `has no session_id to --resume — prior agent context is LOST; falling ` +
          `back to a FRESH session, re-running from the full prompt + review notes`,
      );
    }
    if (isResume) {
      // fix #3: surface every rework relaunch so an operator can see resumes happen.
      console.log(
        `[butchr] resuming task ${task.id} via --resume ${sessionId} (rework)`,
      );
    }

    // Render the prompt to a file in butchr's own data dir (never pollute the repo
    // worktree). First launch → the full prompt (context files + prompt). Resume →
    // a focused rework prompt (just the review notes): the resumed session already
    // holds the original prompt and prior work in its context.
    const doc = readTaskMd(dir.path, task.id);
    const rendered = isResume
      ? renderReworkPrompt(dir.path, doc)
      : renderAgentPrompt(dir.path, doc);
    writeFileSync(promptFile, rendered, "utf8");

    // Per-task MCP config pointing the agent at butchr's /mcp/<id> endpoint.
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

    // The agent is interactive: it signals completion by calling the
    // request_review MCP tool (which returns immediately) and then EXITS. We must
    // keep its stdout/stdin attached to a TTY so its full-screen interface
    // actually renders in the herdr pane — piping through `tee` would make stdout
    // a pipe, so the agent detects "not a terminal" and never draws its
    // interactive UI. Instead we run it under `script`, which allocates a
    // pseudo-terminal for the agent (TTY preserved → UI renders + input works)
    // while logging everything to a file.
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

    // One TAB PER TASK: create a dedicated herdr tab (labeled with the task id)
    // and start the agent in it, so tasks land as separate tabs instead of a wall
    // of split panes in one shared tab. tabCreate is best-effort — on failure it
    // returns {} and agentStart falls back to the legacy workspace-scoped split.
    //
    // This whole tab-create → agent-start → close-leftover-pane sequence runs
    // under the per-workspace herdr pane lock: pane ids are positional and
    // renumber workspace-globally on any close, so a concurrent dispatch's close
    // could otherwise land on THIS task's just-started agent pane (the phantom-task
    // bug). Serializing per workspace keeps each task's pane ids stable across the
    // sequence; tasks in other workspaces still run concurrently.
    const { paneId, tabId } = await withHerdrPaneLock(
      workspaceId ?? "default",
      async () => {
        const tab = await herdr.tabCreate(workspaceId ?? undefined, worktree, task.id);
        try {
          await startAgentReconciling(
            task.id,
            worktree,
            argv,
            workspaceId ?? undefined,
            tab.tabId,
          );

          // `tab create` spawns an empty root shell pane; `agent start --tab` then
          // adds the agent as a SECOND pane. Close that empty pane so the tab holds
          // only the agent. Capture the husk's STABLE terminal id FIRST: closing it
          // renumbers the positional pane ids, and `pane close` returns BEFORE that
          // renumber propagates, so resolveAgentPane waits for this terminal to
          // vanish before trusting a re-resolved pane id.
          let closedTerminalId: string | undefined;
          if (tab.tabId && tab.rootPaneId) {
            closedTerminalId = await herdr.paneTerminalId(tab.rootPaneId);
            await herdr.paneClose(tab.rootPaneId).catch(() => {});
          }

          // Re-resolve the agent's CURRENT pane by its STABLE terminal id, waiting
          // out herdr's positional-id renumber. Returns undefined if the agent
          // never registered a live pane (a failed/clobbered start) — treat the
          // whole dispatch as FAILED rather than recording a stale/phantom pane id
          // (the phantom-task bug).
          const realPane = await herdr.resolveAgentPane(task.id, closedTerminalId);
          if (!realPane) {
            throw new Error(
              `agent ${task.id} did not register a live pane after start`,
            );
          }
          return { paneId: realPane, tabId: tab.tabId };
        } catch (e) {
          // Clean up INSIDE the lock so the just-created tab id can't be renumbered
          // by a concurrent dispatch before we close it: deregister the name (frees
          // it + closes its pane/tab if it partly registered) and close the
          // dedicated tab in case the agent never registered (an empty husk tab).
          await herdr.agentDeregister(task.id).catch(() => {});
          if (tab.tabId) await herdr.tabClose(tab.tabId).catch(() => {});
          throw e;
        }
      },
    );

    markRunning(task.id, paneId, sessionId, tabId);
    spawnWatcher(dir, task.id, paneId, logFile, doneFile);
  } catch (e) {
    // Dispatch failed — re-queue so the next tick retries. Any herdr tab/agent we
    // created was already torn down inside the locked section above (where its id
    // was still fresh); a failure BEFORE that section (workspace heal / worktree)
    // created nothing to clean up. A defensive name-based deregister covers the
    // unlikely middle ground without touching stale positional ids.
    //
    // fix #2: tag the log with the resume case so a FAILED rework relaunch (e.g.
    // resolveAgentPane returned undefined / the agent never registered a pane,
    // which throws above) is visible as a resume failure rather than blending in
    // with fresh-dispatch failures.
    //
    // Bounded retry: instead of an unconditional re-queue (the old hot-loop),
    // route through markDispatchFailure, which increments the attempt count, stamps
    // a backoff in next_dispatch_at (so the tick loop waits before retrying), and
    // gives up to `failed` after maxDispatchAttempts. last_dispatch_error records
    // this message for the operator.
    const msg = (e as Error).message;
    console.error(
      `[butchr] dispatch failed for ${task.id}` +
        (isResume ? ` (resume of session ${sessionId})` : "") +
        `:`,
      msg,
    );
    await herdr.agentDeregister(task.id).catch(() => {});
    await markDispatchFailure(task.id, msg);
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
  tabId?: string,
): Promise<herdr.StartedAgent> {
  try {
    return await herdr.agentStart(name, worktree, argv, workspaceId, tabId);
  } catch (e) {
    if (!herdr.isAgentNameTaken(e)) throw e;
    // Reclaim the stale agent. Closing its pane is NOT enough — herdr keeps the
    // NAME registered (and respawns the agent), so the retry would fail again.
    // agentDeregister clears the name via `agent rename --clear` and then closes
    // the orphaned pane + its (old) tab, truly freeing the name for reuse. We
    // retry into the fresh tab created for this dispatch.
    await herdr.agentDeregister(name);
    console.log(`[butchr] reclaimed stale agent name ${name}; retrying agentStart`);
    return await herdr.agentStart(name, worktree, argv, workspaceId, tabId);
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

/**
 * RUNAWAY/STUCK-AGENT decision: has a task been `running` for longer than the
 * watchdog's max wall-clock without reaching review? Pure so the boundary is
 * unit-testable without spawning an agent or mocking the clock globally.
 *
 *  - `elapsedMs` is how long the task has been in `running` (now - running-since).
 *  - Returns false when the guard is disabled (`maxRunMs <= 0`).
 *
 * The watcher applies this only while the task is STILL `running` (the agent
 * never called request_review), so a trip means a live-but-stuck agent — caught
 * even when it keeps emitting output and the idle detector never fires.
 */
export function runawayExceeded(elapsedMs: number, maxRunMs: number): boolean {
  if (maxRunMs <= 0) return false; // guard disabled
  return elapsedMs > maxRunMs;
}

/**
 * EXEC-FAILURE decision: did the agent process FAIL TO LAUNCH rather than run and
 * exit? A shell reports exit 126 (found but not executable) or 127 (command not
 * found) when `exec` itself fails — most notably E2BIG, when the launch command's
 * argv exceeds the kernel's MAX_ARG_STRLEN (~128KB) because too much was inlined
 * into it, so `claude` never started. Paired with NO captured output (the agent
 * produced nothing), that is a DISPATCH failure to route through the
 * retry/backoff/`failed` path — NOT a finished run to masquerade as an empty
 * review. Pure so the boundary is unit-testable.
 *
 *  - `exitCode` is the raw string read from the run's `.done` file (the child's
 *    exit code). Trimmed here; a missing/blank code is never an exec failure.
 *  - `hasOutput` is whether the run log captured any agent output; if the agent
 *    wrote anything it DID start, so this is a normal end (review), not a launch
 *    failure.
 */
export function isExecFailure(exitCode: string, hasOutput: boolean): boolean {
  if (hasOutput) return false;
  const code = exitCode.trim();
  return code === "126" || code === "127";
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
    const startedAt = Date.now();
    const deadline = startedAt + config.agentTimeoutMs;
    let timedOut = false;
    let vanished = false;
    let neverStarted = false;
    // RUNAWAY/STUCK guard: set when the task has been `running` past
    // config.maxRunMs without the agent submitting (it's alive but looping/stuck).
    // `runawayMs` records the elapsed time at the trip for the rescue note.
    let runaway = false;
    let runawayMs = 0;
    // The agent submits by calling request_review (which moves the task to
    // `review`) and then EXITS. The watcher's job is only to catch an agent that
    // ENDS while still `running` — i.e. it exited/crashed WITHOUT submitting — so
    // we can rescue the task instead of leaving it stuck. `seenAlive` guards
    // against a false "vanished" during the brief agent-registration lag at
    // startup.
    let seenAlive = false;
    while (true) {
      if (abortSignals.has(taskId)) break;
      // Release our slot the moment the task leaves `running`. Once it reaches
      // `review` the agent has submitted (and is exiting) — there is nothing left
      // to rescue. Any other state (queued after a reject, merged, aborted, or a
      // vanished row) likewise means the task has been reclaimed elsewhere, so we
      // stop looping; otherwise we'd hold the `watching` slot forever and tick()
      // would skip the task, including blocking a reject's resume re-dispatch.
      const cur = getTask(taskId)?.status;
      if (cur !== "running") break;
      if (existsSync(doneFile)) break; // process exited
      if (Date.now() > deadline) {
        timedOut = true;
        break;
      }
      // RUNAWAY/STUCK watchdog: the task is still `running` (the agent never
      // submitted) but has been so past config.maxRunMs. Unlike the `vanished`/
      // doneFile paths the agent is still ALIVE — and unlike the idle flag this
      // fires even while it keeps emitting output. Force-rescue it to review
      // (below) rather than letting it hold its tab forever. Trips before the
      // longer agentTimeoutMs by default; disabled when maxRunMs <= 0.
      {
        const elapsed = Date.now() - startedAt;
        if (runawayExceeded(elapsed, config.maxRunMs)) {
          runaway = true;
          runawayMs = elapsed;
          break;
        }
      }
      const alive = await herdr.agentExists(taskId);
      if (alive) seenAlive = true;
      else if (seenAlive) {
        vanished = true;
        break;
      } else if (Date.now() - startedAt > config.agentStartGraceMs) {
        // Never came alive within the grace window: the agent failed to register
        // with herdr (a failed/clobbered start the dispatch-time check missed).
        // Rescue it now rather than holding `running` until agentTimeoutMs.
        neverStarted = true;
        break;
      }
      // While the agent is alive and working, surface whether its CLI has gone
      // quiet (no recent log output) for the UI's idle indicator.
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

    // If the agent already submitted (status is `review`) or the task moved on
    // (queued/merged/aborted), there is nothing to rescue. Only a task still
    // sitting in `running` here means the agent ended WITHOUT submitting.
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

    // DISPATCH-FAILURE short-circuit: the process exited via the `.done` path
    // (none of the runaway/timeout/vanished/never-started branches) with an
    // exec-failure code (126/127) and produced NO output. That means the agent
    // never actually launched — typically the launch command's argv exceeded
    // MAX_ARG_STRLEN (E2BIG) so `claude` failed to exec. Routing it through
    // markDispatchFailure applies the bounded retry/backoff/`failed` state
    // machine instead of masquerading a failed launch as an empty `review`.
    if (!runaway && !timedOut && !vanished && !neverStarted && existsSync(doneFile)) {
      let code = "";
      try {
        code = readFileSync(doneFile, "utf8").trim();
      } catch {
        /* best effort */
      }
      if (isExecFailure(code, snapshot.length > 0)) {
        // Last-moment abort wins (mirrors the markReview path below).
        if (abortSignals.has(taskId)) {
          abortSignals.delete(taskId);
          watching.delete(taskId);
          console.log(`[butchr] task ${taskId} watcher aborted`);
          return;
        }
        // markDispatchFailure tears down the herdr tab/pane and increments the
        // attempt count → backoff (re-queue) or give up to `failed` at the cap.
        await markDispatchFailure(
          taskId,
          `agent failed to launch (exit code ${code}, no output) — the launch ` +
            `command likely exceeded the argv size limit (E2BIG); routed to ` +
            `dispatch retry rather than review`,
        );
        watching.delete(taskId);
        console.error(
          `[butchr] task ${taskId} dispatch failure: agent exited ${code} with no ` +
            `output (exec failure) — not moved to review`,
        );
        return;
      }
    }

    let reason = "the agent exited unexpectedly without calling request_review";
    if (runaway) {
      const mins = (ms: number) => Math.round(ms / 60000);
      reason =
        `the agent exceeded the maximum run time (stuck/runaway): it ran for ` +
        `~${mins(runawayMs)} min (${Math.round(runawayMs / 1000)}s) in 'running' ` +
        `without calling request_review, past the ${mins(config.maxRunMs)} min ` +
        `(BUTCHR_MAX_RUN_MS=${config.maxRunMs}ms) limit — force-reviewed so the ` +
        `work can be inspected and the tab freed`;
    } else if (timedOut) {
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
    } else if (neverStarted) {
      reason =
        "the agent never registered with herdr (it failed to start)";
    }
    snapshot =
      `[butchr] moved to review automatically: ${reason}. ` +
      `Output captured as-is.\n\n` +
      snapshot;

    // The process is gone; close the whole tab defensively in case a husk pane
    // remains, so the dead task's tab doesn't linger. (markReview clears the
    // stored tab id, so close it now while we still have it.)
    await herdr.teardownTask(getTask(taskId)?.herdr_tab_id, taskId, paneId);

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
