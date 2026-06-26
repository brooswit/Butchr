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
// as it is seen — there is no per-workspace "one at a time" limit and no global
// cap on the number of simultaneous tasks. Worktree isolation keeps tasks safe at
// the filesystem level (each is its own git worktree on its own branch), and one
// herdr tab per task keeps them from crowding the workspace. The
// `dispatching`/`watching` sets (both keyed by task id) guard against
// double-dispatching the same task across overlapping ticks.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { db, getSetting, setSetting } from "./db.ts";
import type { WorkspaceRow, TaskRow } from "./db.ts";
import { ensureHerdrWorkspace } from "./workspaces.ts";
import { buildScriptArgv, modelFlag, sleep, stripAnsi } from "./exec.ts";
import * as git from "./git.ts";
import { harness } from "./harness.ts";
import { CHANNEL_SERVER_NAME } from "./channel.ts";
import { startAgentInFreshTab } from "./herdr.ts";
import { autoConfirmStartupPrompts, classifyStartupScreen } from "./startup-confirm.ts";
import type { AutoConfirmResult, ConfirmRule } from "./startup-confirm.ts";
import { claudeAlive } from "./liveness.ts";
import { groundingFingerprint, readTaskMd, renderAgentPrompt, renderAnswerPrompt, renderRegroundBlock, renderReworkPrompt } from "./taskmd.ts";
import { getTask, markDispatchFailure, markInReview, markRunning, maybeAutoMerge, prepareBranchForDispatch, reevaluateBlockedTask, requeueForResume, resolveBase, setIdle, setNeedsUserInput } from "./tasks.ts";

const promptsDir = join(config.dataDir, "prompts");
const runsDir = join(config.dataDir, "runs");
const mcpDir = join(config.dataDir, "mcp");
mkdirSync(promptsDir, { recursive: true });
mkdirSync(runsDir, { recursive: true });
mkdirSync(mcpDir, { recursive: true });

// The agent runs under `script`, so its log is a raw terminal typescript: ANSI
// escapes, carriage returns, and `script`'s own "Script started/done" banners.
// Clean it up before showing it to a human as a fallback snapshot.
function sanitizeTypescript(raw: string): string {
  return stripAnsi(raw)
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

// Consume a pending abort signal for a watched task: if one is set, clear it,
// release the watcher slot, log, and report true so the caller bails WITHOUT moving
// the task to review (abortTask owns its terminal state + pane/worktree cleanup).
// false when there is nothing to consume (the watcher proceeds normally).
function consumeAbort(taskId: string): boolean {
  if (!abortSignals.has(taskId)) return false;
  abortSignals.delete(taskId);
  watching.delete(taskId);
  console.log(`[butchr] task ${taskId} watcher aborted`);
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

/**
 * The last `lines` of a task's run log, ANSI-stripped — the IDLE CONTEXT snapshot.
 * Captured when an agent flips `idle` so the idle-handling responder can see what it
 * was doing and where it stopped (a mid-task pause, a finished-but-unsubmitted turn, a
 * wedged prompt) and act gracefully instead of poking blind. Returns "" if the log is
 * missing/unreadable or `lines <= 0` (capture disabled). Re-reads the whole file (this
 * only runs on the rare idle-flip, never the hot path) then keeps the tail.
 */
export function readRunLogTail(taskId: string, lines: number): string {
  if (lines <= 0) return "";
  const snapshot = readRunLogSnapshot(taskId);
  if (!snapshot) return "";
  return snapshot.split("\n").slice(-lines).join("\n");
}

// Per-workspace lock serializing the herdr "create a task's tab + start its agent
// + close the leftover root pane" critical section. herdr pane ids are POSITIONAL
// and renumber workspace-globally whenever ANY pane closes, so two concurrent
// dispatches in the same workspace would clobber each other: task B's
// `pane close <captured rootId>` can land on task A's agent pane after A's own
// close renumbered everything down (verified live — it killed A's agent and left
// B's real root pane orphaned). Serializing per workspace makes each task's pane
// setup atomic with respect to renumbering. Keyed by workspace id (panes only
// renumber within their own workspace), so tasks in DIFFERENT workspaces still
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

// ---- DISPATCHER PAUSE / MAINTENANCE MODE ----------------------------------
// A global switch that stops NEW agent dispatch (drain-only) so the operator can
// pause for a restart / recovery / maintenance window WITHOUT disturbing in-flight
// work. When paused:
//   - the tick's NEW-DISPATCH gate (selectQueuedForDispatch) returns nothing, so
//     no `queued` task is launched into an agent;
//   - everything ELSE in the tick still runs — the blocked→queued auto-unblock
//     promotion (a freshly-unblocked task simply waits in `queued` until resume),
//     the auto-merge backstop, and every running/review/idle task's watcher are
//     untouched, so existing work drains to completion normally.
// The flag is persisted in the `settings` table (key 'dispatch_paused'), so a
// pause SURVIVES a butchr restart and stays in effect until explicitly resumed.
// An in-memory cache mirrors the persisted value (loaded once at module init) so
// the per-tick check is a plain boolean read, not a DB hit.
const PAUSE_KEY = "dispatch_paused";
let paused = getSetting(PAUSE_KEY) === "1";

/** Whether NEW agent dispatch is currently paused (maintenance / drain-only). */
export function isPaused(): boolean {
  return paused;
}

/**
 * Pause or resume NEW agent dispatch. Updates the in-memory cache AND persists the
 * flag so the state survives a restart (stays paused until resumed). Idempotent.
 */
export function setPaused(value: boolean): void {
  paused = value;
  setSetting(PAUSE_KEY, value ? "1" : "0");
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the dispatch loop: fire one tick immediately, then every `config.tickMs`. Idempotent — a no-op if already running. */
export function startDispatcher(): void {
  if (timer) return;
  // Fire immediately, then on an interval.
  tick();
  timer = setInterval(tick, config.tickMs);
}

/** Stop the dispatch loop, clearing the interval timer. Idempotent. */
export function stopDispatcher(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

// A queued task joined to its workspace, as returned by the dispatch query.
// `dir_id` aliases the workspace's id (the unaliased `id` is the task's). The
// task's `created_at` shadows the workspace's, which is fine — we never read the
// workspace's created_at here.
type QueuedRow = TaskRow & {
  path: string;
  label: string | null;
  herdr_workspace: string | null;
  herdr_pane: string | null;
  dir_id: string;
};

// Project the workspace columns the dispatch query joins in (aliased `dir_id`) back
// into a WorkspaceRow — the shape the dispatch/heal/watch paths take. Used wherever a
// QueuedRow needs its workspace peeled out.
function dirOf(row: QueuedRow): WorkspaceRow {
  return {
    id: row.dir_id,
    path: row.path,
    label: row.label,
    herdr_workspace: row.herdr_workspace,
    herdr_pane: row.herdr_pane,
    created_at: row.created_at,
  };
}

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
): Promise<{ adopted: number; rescued: number; resumed: number; skipped: number }> {
  // A task butchr LAUNCHED an agent for is `in_progress` with has_agent=1 (the honest
  // ownership marker — markRunning sets it atomically; requeueForResume clears it). This
  // is only the CHEAP PRE-FILTER for which tasks to consider: the real adopt-vs-resume
  // decision below is the /proc + name probe (agentExists && claudeAlive), because the
  // marker — like the old pane id — survives a herdr/host restart that killed claude.
  // Ready `inactive` tasks are never-launched/rework and are handled by the normal tick.
  const rows = db
    .query<QueuedRow, []>(
      `SELECT t.*, d.path, d.label, d.herdr_workspace, d.herdr_pane, d.id AS dir_id
         FROM tasks t JOIN workspaces d ON d.id = t.workspace_id
         WHERE t.status='in_progress' AND t.has_agent=1 AND t.work_kind='leaf'`,
    )
    .all();
  if (rows.length === 0) return { adopted: 0, rescued: 0, resumed: 0, skipped: 0 };

  if (!herdrUp) {
    console.warn(
      `[butchr] herdr down at startup — leaving ${rows.length} running task(s) ` +
        `as-is (cannot distinguish live agents from dead ones); will reconcile ` +
        `on a later restart with herdr up`,
    );
    return { adopted: 0, rescued: 0, resumed: 0, skipped: rows.length };
  }

  let adopted = 0;
  let rescued = 0;
  let resumed = 0;
  for (const row of rows) {
    if (watching.has(row.id)) continue; // already adopted (defensive)

    const dir = dirOf(row);
    const logFile = runLogPath(row.id);
    const doneFile = join(runsDir, `${row.id}.done`);

    // LIVENESS — herdr's pane/agent NAME survives a herdr/host restart even though the
    // restart KILLED claude (the pane falls back to a bare login shell), so
    // `agentExists` alone is NOT "the agent is running". The ground truth is the
    // process: claudeAlive checks /proc for a live claude carrying this session id.
    // Re-adopt only when BOTH agree the agent is genuinely live.
    const nameAlive = await harness.agentExists(row.id);
    const procAlive = claudeAlive(row.session_id);

    // Resolve the agent's CURRENT pane + tab STRICTLY BY NAME (herdr renumbers
    // positional ids when sibling tabs close, so the stored id can be stale). Only
    // probe for a genuinely-live agent. If the name resolves NO live pane the agent
    // isn't actually attachable — treat it as not-live and fall through to the
    // auto-resume / rescue branch rather than inventing a bogus pane (the stored id,
    // or a pane literally named the task id, both of which can point at a dead shell).
    const livePane =
      nameAlive && procAlive ? await harness.resolveAgentPane(row.id) : undefined;

    if (livePane) {
      // Live agent — re-adopt by attaching the watcher to its CURRENT name-resolved pane
      // (it may have moved while butchr was down). Nothing is persisted: agents are
      // addressed BY NAME, so there is no stored pane/tab to re-record.
      spawnWatcher(dir, row.id, livePane, logFile, doneFile);
      adopted++;
      console.log(`[butchr] re-adopted running task ${row.id} (pane ${livePane})`);
    } else if (row.status === "in_progress" && !existsSync(doneFile)) {
      // The build agent's claude is NOT actually alive AND it did not exit on its own
      // (no `.done` exit-code file) — i.e. it was KILLED mid-work by a power loss /
      // herdr restart. AUTO-RESUME it: requeueForResume tears down the dead husk pane
      // and resets the task to READY so the dispatch tick relaunches the SAME session
      // via `claude --resume` (or a fresh run if the transcript is gone). Bounded so a
      // session that keeps dying can't loop. This is the no-operator-action recovery.
      const r = await requeueForResume(
        row.id,
        "agent process was not alive at startup (host/herdr restart suspected)",
      );
      if (r === "rescued") rescued++;
      else if (r === "resumed" || r === "fresh") resumed++;
    } else {
      // Agent gone — the build (in_progress) agent ended on its own (`.done` present)
      // while butchr was offline. Rescue it to in_review for a human. Close its (now
      // husk) tab defensively BY NAME.
      await harness.teardownTask(row.id);
      const snapshot = readRunLogSnapshot(row.id);
      markInReview(
        row.id,
        `[butchr] moved to review automatically: the agent ended while butchr ` +
          `was offline. Output captured as-is.\n\n${snapshot}`,
      );
      rescued++;
      console.log(`[butchr] rescued task ${row.id} → in_review (agent gone while offline)`);
    }
  }
  return { adopted, rescued, resumed, skipped: 0 };
}

/**
 * The tick's NEW-DISPATCH gate: the `inactive` (ready) tasks eligible to launch an
 * agent right now, highest-PRIORITY first then oldest-first. Returns an EMPTY list when
 * dispatch is PAUSED, which is how maintenance mode stops new work without touching
 * anything in flight.
 *
 * Selection (when not paused): status='inactive' AND the dispatch backoff has
 * elapsed (next_dispatch_at IS NULL or <= now — ISO-8601 strings compare
 * correctly), so a repeatedly-failing task can't hot-loop. ORDERED BY
 * `priority DESC, created_at ASC`: a higher-priority task JUMPS the queue ahead of
 * older lower-priority ones, and tasks at the same priority stay FIFO (oldest
 * first) — so per-task priority lets an urgent task dispatch sooner without
 * disturbing the FIFO default (priority 0 for every task that never set one).
 * Exported so the pause + ordering gates are exercised directly in tests (the same
 * function the tick calls).
 */
export function selectQueuedForDispatch(nowStr: string): QueuedRow[] {
  if (paused) return [];
  // READY tasks: a task in `inactive` is queued for the dispatcher to launch its
  // workspace agent (markRunning then flips it to `in_progress`). This single gate
  // covers fresh builds, reworks/resumes, answer-resumes, and conflict-bounce resumes.
  // Backoff (next_dispatch_at) and priority ordering apply uniformly.
  return db
    .query<QueuedRow, [string]>(
      `SELECT t.*, d.path, d.label, d.herdr_workspace, d.herdr_pane, d.id AS dir_id
         FROM tasks t JOIN workspaces d ON d.id = t.workspace_id
         WHERE t.status='inactive' AND t.work_kind='leaf'
           AND (t.next_dispatch_at IS NULL OR t.next_dispatch_at <= ?)
         ORDER BY t.priority DESC, t.created_at ASC`,
    )
    .all(nowStr);
}

let ticking = false;
async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  lastTickAt = Date.now();
  tickCount++;
  try {
    // If herdr is down, do nothing this tick (no error spam — it may come back).
    if (!(await harness.isUp())) return;

    // AUTO-UNBLOCK pass: promote any `blocked` task whose blockers have all merged
    // to `queued` BEFORE the queued selection below, so a freshly-unblocked task
    // dispatches in this same tick. This is the robust-to-missed-events backstop
    // (approveTask also re-evaluates immediately for promptness). Cheap: one query
    // plus a per-task blocker check; blocked tasks are few.
    for (const b of db
      .query<{ id: string }, []>(`SELECT id FROM tasks WHERE status='blocked' AND work_kind='leaf'`)
      .all()) {
      reevaluateBlockedTask(b.id);
    }

    // AUTO-MERGE backstop: re-check every `review` task whose CI settled to 'pass'.
    // The primary trigger is the CI-completion hook (tasks.triggerCi), but this
    // catches missed events / a restart that lost the in-process hook. No-op unless
    // auto-merge is enabled and the task qualifies as low-risk; concurrent runs are
    // deduped inside maybeAutoMerge and serialized through the global merge queue.
    if (config.autoMergeEnabled) {
      for (const r of db
        .query<{ id: string }, []>(
          `SELECT id FROM tasks WHERE status='in_review' AND ci_status='pass' AND auto_merged=0 AND work_kind='leaf'`,
        )
        .all()) {
        // Fire-and-forget — the tick must not block on a merge.
        void maybeAutoMerge(r.id);
      }
    }

    // The queued tasks eligible to launch this tick — empty while dispatch is
    // PAUSED (drain-only maintenance mode), so no new agent starts even though the
    // auto-unblock + auto-merge passes above keep running. See
    // selectQueuedForDispatch.
    const nowStr = new Date().toISOString();

    // NOTE: `idea`-state tasks are NOT dispatched. An idea is a WAITING/feedback state —
    // it holds a brief and waits for the spec-generation responder (the CTO agent or a
    // human) to submit a spec via POST /api/work/:id/spec, which advances it to
    // spec_review. The dispatcher only launches build agents for `inactive` tasks below.

    // The queued tasks eligible to launch this tick — empty while dispatch is
    // PAUSED (drain-only maintenance mode), so no new agent starts even though the
    // auto-unblock + auto-merge passes above keep running. See
    // selectQueuedForDispatch.
    const rows = selectQueuedForDispatch(nowStr);

    // Dispatch every queued task that isn't already being dispatched/watched —
    // fully concurrent, no cap. The `dispatching`/`watching` sets only guard
    // against double-dispatching the same task across overlapping ticks.
    for (const row of rows) {
      if (dispatching.has(row.id) || watching.has(row.id)) continue;

      const dir = dirOf(row);

      dispatching.add(row.id);
      // Fire-and-forget, concurrently; the watcher is spawned inside dispatch().
      dispatch(dir, row).finally(() => dispatching.delete(row.id));
    }
  } finally {
    ticking = false;
  }
}

// Heal the workspace's herdr workspace (recreate it after an herdr restart / manual
// close) and surface the id for this dispatch. The create/heal DEDUPE now lives inside
// ensureHerdrWorkspace itself (a module-level in-flight map keyed by workspace id),
// so concurrent task dispatches AND the managed CTO agent funnel through ONE create per
// workspace — this wrapper just adds the dispatcher's create-only bookkeeping: on a
// recreate, mirror the new id onto the in-memory WorkspaceRow and log it. The reuse
// path — and any concurrent awaiter that didn't own the create (created=false) — leave
// both untouched, as before.
async function ensureWorkspace(dir: WorkspaceRow): Promise<string | undefined> {
  const label = dir.label ?? dir.path.split("/").pop() ?? dir.path;
  const { workspaceId, created } = await ensureHerdrWorkspace(dir.id, dir.path, label);
  if (created) {
    dir.herdr_workspace = workspaceId ?? null;
    console.log(`[butchr] recreated herdr workspace for ${label} (${workspaceId})`);
  }
  return workspaceId;
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
 * The `--dangerously-load-development-channels` flag that attaches the one-way
 * CONNECTIVITY channel to a WORKER agent, or "" when connectivity monitoring is OFF.
 * Gated on config.connectivityEnabled — guard-rail: don't attach a channel that would
 * have nothing to deliver. Kept in lockstep with `taskMcpServers` (which registers the
 * matching stdio server only in the same case). NON-FATAL: a dev-channel that fails to
 * spawn is logged + skipped by claude — the agent still launches and does its work.
 */
export function connectivityChannelFlag(): string {
  return config.connectivityEnabled
    ? `--dangerously-load-development-channels server:${CHANNEL_SERVER_NAME}`
    : "";
}

/**
 * LAUNCH AUTO-CONFIRM for a freshly-dispatched WORKER — the symmetric counterpart to
 * the CTO's launch auto-confirm (cto-agent.ts performLaunch). When connectivity is ON,
 * a worker carries `--dangerously-load-development-channels` (connectivityChannelFlag),
 * and Claude Code stops on the BLOCKING dev-channels consent prompt the first time the
 * session loads it ("1. I am using this for local development"); left unanswered the
 * worker never reaches its task. This polls the live pane and sends the safe confirming
 * response (also covering the folder-trust / generic prompts the rule table handles).
 *
 * Reuses src/startup-confirm.ts as-is with the SAME launch-auto-confirm config the CTO
 * uses. Best-effort + bounded + idempotent: a confirming keystroke is sent ONLY while a
 * prompt is actually on screen (de-bounced), so once the worker is past startup nothing
 * leaks into its real session; it never throws (so it can never fail a dispatch).
 * Exported so the dispatcher startup path is unit-testable directly.
 *
 * Returns `{ answered, stuckScreen? }`: `stuckScreen` is set when auto-confirm GAVE UP on an
 * unrecognized but prompt-like pane — the build-launch caller turns that into a
 * `setNeedsUserInput` flag so the hung agent becomes visible + user-routed.
 */
export function autoConfirmTaskStartup(name: string): Promise<AutoConfirmResult> {
  return autoConfirmStartupPrompts(name, {
    read: (n) => harness.agentRead(n),
    send: (n, input) => harness.send(n, input),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    pollMs: config.ctoPromptPollMs,
    maxPolls: config.ctoPromptMaxPolls,
    quietPolls: config.ctoPromptQuietPolls,
    log: (m) => console.log(`[butchr] task ${name}: ${m}`),
  }).catch(() => ({ answered: [] }));
}

/**
 * The build-launch startup step: auto-confirm known prompts, and if auto-confirm GAVE UP on
 * an unrecognized but prompt-like pane, flag the task with `setNeedsUserInput` so the hung
 * agent becomes visible + user-routed (it stays in_progress/attachable so a human can answer
 * the prompt in the live pane). Best-effort: `autoConfirmTaskStartup` never throws, and
 * `setNeedsUserInput` is a guarded no-op when the task is not a live in_progress build agent.
 * Exported so the wiring (stuck → flag) is unit-testable without the full dispatch path.
 */
export async function autoConfirmAndFlagTaskStartup(taskId: string): Promise<void> {
  const r = await autoConfirmTaskStartup(taskId);
  if (r.stuckScreen) setNeedsUserInput(taskId, true, () => r.stuckScreen!);
}

/**
 * THROTTLE gate for the mid-session pane probe: true only on every `every`-th watcher
 * tick (and never when the probe is disabled, `every <= 0`). The watcher loops ~1s but
 * `agentRead` shells out to herdr, so we must NOT read the pane every tick — this spaces
 * the reads to roughly `every` seconds. Pure so the throttle is unit-testable without
 * driving the whole watcher loop. `tick` is the 1-based loop counter.
 */
export function shouldProbeTick(tick: number, every: number): boolean {
  if (every <= 0) return false;
  return tick % every === 0;
}

/** Injectable seams for the mid-session probe (the harness/DB in production; fakes in tests). */
export type MidProbeDeps = {
  /** Read the agent's live pane (ANSI-stripped). */
  read: (name: string) => Promise<string>;
  /** Push a confirming input to the agent's pane. */
  send: (name: string, input: SendInput) => Promise<void>;
  /** Flip/clear the task's needs_user_input flag (idempotent; capture thunk on 0→1). */
  setFlag: (id: string, on: boolean, capture?: () => string) => void;
  /** Is the task's needs_user_input flag currently set? */
  flagged: (id: string) => boolean;
  /**
   * Is the agent GENUINELY IDLE (run-log quiet past `idleMs`)? The probe takes NO action
   * (no read, no flag, no keystroke) unless this is true — an actively-working agent
   * (still producing output) must be left completely alone, so benign active-turn text can
   * never be mistaken for a blocking dialog.
   */
  idle: () => boolean;
  /** Extra/overriding rule table (defaults to STARTUP_CONFIRM_RULES). */
  rules?: ConfirmRule[];
  /** Optional diagnostics sink. */
  log?: (msg: string) => void;
};

/**
 * MID-SESSION SAFETY NET — one pane-CONTENT probe for a single live build agent, the
 * counterpart to launch auto-confirm for prompts that appear AFTER startup (a mid-run
 * tool-permission / trust dialog). Reads the live pane once and classifies it via the
 * SAME three-way classifier as the launch path:
 *   - `rule`  → a known prompt we can auto-confirm: send the safe response (mirroring
 *               launch auto-confirm) and CLEAR any stale needs_user_input flag — we are
 *               handling it, so the user no longer needs to;
 *   - `stuck` → an unrecognized but prompt-like pane → flip `needs_user_input` on (with
 *               the screen as context) so a human is routed to the still-attachable pane;
 *   - `quiet` → genuinely past any prompt: CLEAR the flag if it was set (same
 *               self-clearing lifecycle as idle — the agent moved past the prompt).
 *
 * GENUINE-IDLE GATE: the WHOLE probe is a no-op unless the agent is genuinely idle
 * (`deps.idle()`). An actively-working agent (run-log still fresh, mid-turn) is left
 * completely untouched — no pane read, no flag, no keystroke injection — so the `raise`
 * tool description or normal active-turn output can never be mis-flagged as needing input,
 * and we never inject a stray "1\n" into a working agent. A genuinely-stuck mid-session
 * dialog still surfaces once the agent goes quiet past `idleMs` (Path A's bounded startup
 * poll covers the immediate post-spawn window).
 *
 * BEST-EFFORT: a read failure does nothing (we cannot classify a pane we could not read),
 * and a send failure is swallowed — this must NEVER throw or disrupt the watcher / fail
 * the task. Idempotent against the launch-time flag: `setFlag(true)` re-setting an
 * already-set flag and `setFlag(false)` clearing an unset one are both no-ops (setIdle
 * shape), so it interoperates cleanly with the detection subtask's launch flag. Exported
 * so the probe is unit-testable without the live watcher loop.
 */
export async function probeAgentForPrompt(taskId: string, deps: MidProbeDeps): Promise<void> {
  // GENUINE-IDLE GATE: leave an active agent completely alone (no read/flag/keystroke).
  if (!deps.idle()) return;
  let screen = "";
  try {
    screen = await deps.read(taskId);
  } catch {
    return; // best-effort: a pane we cannot read tells us nothing — leave state as-is
  }
  const cls = classifyStartupScreen(screen, deps.rules);

  if (cls.kind === "rule") {
    try {
      await deps.send(taskId, cls.rule.response);
      deps.log?.(`auto-confirmed mid-session prompt '${cls.rule.name}'`);
    } catch {
      /* best-effort — a send to a dead pane is a no-op */
    }
    // We can handle this prompt ourselves → clear any flag a prior unrecognized prompt set.
    if (deps.flagged(taskId)) deps.setFlag(taskId, false);
    return;
  }

  if (cls.kind === "stuck") {
    // An unhandled blocking prompt appeared mid-run: surface it (idempotent if already set).
    deps.setFlag(taskId, true, () => screen);
    deps.log?.("mid-session prompt not auto-confirmable — flagging for user input");
    return;
  }

  // cls.kind === "quiet" | "active": past any prompt (blank/initializing, or a live working
  // session). Clear the flag iff it was set (no-op otherwise).
  if (deps.flagged(taskId)) deps.setFlag(taskId, false);
}

/**
 * Is an agent GENUINELY IDLE — run-log quiet past `idleMs`? `quietMs` is `refreshIdle`'s
 * return (now - log mtime), or null when idle detection is off / the log is missing / the
 * agent is mid-active-turn. Only a quiet duration strictly past the threshold counts as idle;
 * a null or sub-threshold value means the agent is actively producing output. Pure +
 * unit-testable. The mid-session probe and clear-on-resume both gate on this.
 */
export function isGenuinelyIdle(quietMs: number | null): boolean {
  return quietMs !== null && quietMs > config.idleMs;
}

/**
 * The watcher-tick wiring for `probeAgentForPrompt`: build the production deps (live pane
 * read/send via the harness, flag get/set via the task store) and run one probe. Kept thin
 * + best-effort so the watcher can fire-and-forget it without awaiting (it never throws).
 * `quietMs` (from refreshIdle) gates the whole probe on genuine idle so an active agent is
 * never inspected/flagged.
 */
export function probeTaskMidSession(taskId: string, quietMs: number | null): Promise<void> {
  return probeAgentForPrompt(taskId, {
    read: (n) => harness.agentRead(n),
    send: (n, input) => harness.send(n, input),
    setFlag: (id, on, capture) => setNeedsUserInput(id, on, capture),
    flagged: (id) => !!getTask(id)?.needs_user_input,
    idle: () => isGenuinelyIdle(quietMs),
    log: (m) => console.log(`[butchr] task ${taskId}: ${m}`),
  }).catch(() => {});
}

/**
 * CLEAR-ON-RESUME — mirror of how idle self-clears. When a flagged agent starts producing
 * output again (it is NO LONGER genuinely idle — quietMs known and at/under `idleMs`), a
 * needs_user_input flag set by an earlier mid-session dialog is stale: the agent has moved
 * past the prompt (or a human answered it in the pane). Clear it PROMPTLY, every watcher tick
 * (~1s), instead of waiting on the throttled ~10s mid-session probe, so a resuming agent's
 * "Awaiting you" banner doesn't linger. A no-op when idle detection is off / log missing
 * (quietMs null), when the agent is still genuinely idle, or when the flag is already clear.
 * setNeedsUserInput's own guards (live in_progress build agent, value-change) still apply.
 */
export function clearNeedsUserInputOnResume(taskId: string, quietMs: number | null): void {
  if (quietMs === null || isGenuinelyIdle(quietMs)) return; // unknown or still idle → leave as-is
  if (getTask(taskId)?.needs_user_input) setNeedsUserInput(taskId, false);
}

/**
 * The per-task MCP servers config. ALWAYS includes `butchr` (the HTTP review/raise
 * surface at /mcp/<id>). When connectivity monitoring is ON, ALSO registers the one-way
 * connectivity channel as a STDIO server in CONNECTIVITY-ONLY mode
 * (BUTCHR_CHANNEL_CONNECTIVITY_ONLY=1), so a LIVE worker receives the broadcast
 * `connectivity.restored` push mid-session and NEVER another task's review/idle/
 * attention events. Off → a lean config with just `butchr`. Exported for testing.
 */
export function taskMcpServers(taskId: string): Record<string, unknown> {
  const servers: Record<string, unknown> = {
    butchr: {
      type: "http",
      url: `http://${config.loopbackHost}:${config.port}/mcp/${taskId}`,
    },
  };
  if (config.connectivityEnabled) {
    servers[CHANNEL_SERVER_NAME] = {
      command: "bash",
      args: ["-lc", config.ctoChannelCmd],
      env: {
        BUTCHR_CHANNEL_SSE_URL: `http://${config.loopbackHost}:${config.port}/api/events`,
        BUTCHR_CHANNEL_CONNECTIVITY_ONLY: "1",
      },
    };
  }
  return servers;
}

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
  task: Pick<TaskRow, "started_at" | "session_id" | "model">,
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

  // Thread the per-task model: a requested model becomes `--model <model>`; an
  // unset one yields an empty flag so claude keeps its current default. The value
  // was validated at creation (tasks.validateModel) and ends up single-quote
  // escaped when the whole agentCmd is wrapped for `script -c`, so it's injection-safe.
  const agentCmd = (isResume ? config.resumeCmd : config.agentCmd)
    .replaceAll("{{PROMPT_FILE}}", promptFile)
    .replaceAll("{{MCP_CONFIG}}", mcpConfigFile)
    .replaceAll("{{SESSION_ID}}", sessionId)
    .replaceAll("{{MODEL_FLAG}}", modelFlag(task.model))
    .replaceAll("{{CHANNEL_FLAG}}", connectivityChannelFlag());

  return { isResume, sessionId, agentCmd, lostContext };
}

export async function dispatch(dir: WorkspaceRow, task: TaskRow): Promise<void> {
  // Hoisted out of the try so the catch (below) can report whether a RESUME
  // (rework re-launch) failed, not just a fresh dispatch — see fix #2.
  let isResume = false;
  let sessionId = "";
  try {
    // Heal a missing workspace (herdr restart / manual close).
    const workspaceId = await ensureWorkspace(dir);

    // Ensure the worktree exists (idempotent — handles rejected re-runs). Branch it from
    // the resolved base: the STORY branch for an isolated member (resolveBase also lazily
    // ensures the story branch + worktree exist first), else the default branch
    // (resolveBase → defaultBranch, so non-isolated dispatch is unchanged).
    const worktree = await git.createWorktree(dir.path, task.id, await resolveBase(task));

    // AUTO-REBASE onto the current default tip BEFORE the agent runs, so a branch
    // cut from a stale default HEAD (a chained/blocked task created before its
    // blockers merged) never works on a stale base and only collides at final
    // merge. Clean rebase/reset → proceed on the fresh base. A CONFLICT is NOT
    // silently launched on a blind base: prepareBranchForDispatch records a
    // conflict-resolution note (read by the resumed agent), and we proceed to
    // launch so the agent integrates the base with fresh context (aborting here
    // would just re-conflict next tick and loop).
    const prep = await prepareBranchForDispatch(task.id);
    if (prep.conflict) {
      console.warn(
        `[butchr] task ${task.id}: branch was behind the default tip and the ` +
          `auto-rebase CONFLICTS — launching the agent with a conflict-resolution ` +
          `note so it integrates the base (not silently dispatched on a stale base)`,
      );
    } else if (prep.rebased) {
      console.log(
        `[butchr] task ${task.id}: auto-rebased branch onto the current default ` +
          `tip before dispatch`,
      );
    }

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
    // a focused prompt: the resumed session already holds the original prompt and
    // prior work in its context, so we inject only what's new. A resume with a
    // pending `raise` `answer` is an ANSWER-resume (the agent paused on a question) →
    // hand it the answer; otherwise it's a reject/conflict rework → hand it the
    // review notes.
    const doc = readTaskMd(dir.path, task.id);
    // Fingerprint the CURRENT prompt+context. markRunning records it as what THIS launch
    // grounds the agent in; on a resume we also compare it to the stored fingerprint to
    // detect a prompt/context edit made while the task was paused (see below).
    const groundingFp = groundingFingerprint(doc);
    let rendered: string;
    if (isResume) {
      // A resume re-enters the SAME `--resume` session, which still holds the prompt +
      // context the agent saw when it was last grounded. If the task's prompt/context was
      // EDITED while it waited (needs_info / in_review) — e.g. an operator revised it via
      // the broadened `raise` tool — that session is now STALE. Detect it by comparing the
      // stored grounding fingerprint and, on a mismatch, prepend the CURRENT definition so
      // the resumed agent works from the up-to-date task, not the snapshot in its context.
      // (A NULL stored fingerprint — a task paused before this existed — counts as a
      // mismatch and re-grounds once, which is safe.) An UNCHANGED task resumes with the
      // focused answer/rework message exactly as before.
      const reground =
        (task.grounding_fp ?? "") !== groundingFp ? renderRegroundBlock(doc) : "";
      rendered =
        task.answer && task.answer.trim()
          ? renderAnswerPrompt(task.answer, reground)
          : renderReworkPrompt(dir.path, doc, reground);
    } else {
      rendered = renderAgentPrompt(dir.path, doc);
    }
    writeFileSync(promptFile, rendered, "utf8");

    // Per-task MCP config: the agent's butchr HTTP surface (/mcp/<id>) plus — when
    // connectivity monitoring is on — the one-way connectivity channel (stdio,
    // connectivity-only) so a live worker hears "network restored" mid-session.
    writeFileSync(
      mcpConfigFile,
      JSON.stringify({ mcpServers: taskMcpServers(task.id) }),
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
    const argv = buildScriptArgv({ agentCmd, logFile, doneFile });

    // One TAB PER TASK: create a dedicated herdr tab (labeled with the task id)
    // and start the agent in it, so tasks land as separate tabs instead of a wall
    // of split panes in one shared tab.
    //
    // This whole tab-create → agent-start → close-leftover-pane sequence (in
    // startAgentInFreshTab) runs under the per-workspace herdr pane lock: pane ids
    // are positional and renumber workspace-globally on any close, so a concurrent
    // dispatch's close could otherwise land on THIS task's just-started agent pane
    // (the phantom-task bug). Serializing per workspace keeps each task's pane ids
    // stable across the sequence; tasks in other workspaces still run concurrently.
    const { paneId, tabId } = await withHerdrPaneLock(
      workspaceId ?? "default",
      () =>
        startAgentInFreshTab(harness, {
          name: task.id,
          cwd: worktree,
          argv,
          workspaceId: workspaceId ?? undefined,
          label: task.id,
          paneError: `agent ${task.id} did not register a live pane after start`,
        }),
    );

    markRunning(task.id, paneId, sessionId, tabId, groundingFp);
    spawnWatcher(dir, task.id, paneId, logFile, doneFile);

    // LAUNCH AUTO-CONFIRM: clear any BLOCKING interactive startup prompt so the worker
    // reaches its task unattended (dev-channels consent under the dev-channel flag, but
    // ALSO the folder-trust dialog, which appears INDEPENDENT of that flag). Run
    // UNCONDITIONALLY — a connectivity-OFF build can still hit folder-trust — best-effort
    // + idempotent, so it can never wedge or fail an already-running dispatch. Fired AFTER
    // markRunning/spawnWatcher (task tracked first) and NOT awaited so it never delays the
    // dispatch — it polls the pane in the background. If auto-confirm GIVES UP on an
    // unrecognized but prompt-like pane (`stuckScreen`), flag the task for user input so the
    // hung agent becomes visible + user-routed instead of silently frozen; it stays
    // in_progress/attachable so a human can answer the prompt in the live pane.
    void autoConfirmAndFlagTaskStartup(task.id);
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
    await harness.agentDeregister(task.id).catch(() => {});
    await markDispatchFailure(task.id, msg);
  }
}

// Toggle a running task's `idle` flag from its log file's last-write time. The
// agent runs under `script -f` (flush after every write), so the log's mtime
// tracks live CLI output: if nothing has been written for `idleMs`, claude is
// alive but quiet → idle; the moment it writes again → active. Skipped entirely
// when idle detection is disabled or the log hasn't appeared yet (treating a
// missing log as "stale" would flag a just-started agent as idle).
//
// Returns how long (ms) the agent has been QUIET (now - log mtime) so the caller
// can drive the stall auto-nudge off the same single stat() — or null when idle
// detection is disabled or the log hasn't appeared yet (nothing to nudge against).
// Exported for the clock-skew regression test (a future log mtime → null).
export function refreshIdle(taskId: string, logFile: string): number | null {
  if (config.idleMs <= 0) return null;
  let mtimeMs: number;
  try {
    mtimeMs = statSync(logFile).mtimeMs;
  } catch {
    return null; // no log yet — agent is still spinning up
  }
  const quietMs = Date.now() - mtimeMs;
  // CLOCK-SKEW GUARD: a backward system-clock jump or a log mtime in the FUTURE yields a
  // NEGATIVE quietMs. That value is neither null nor > idleMs, so left unclamped it would
  // fall through clearNeedsUserInputOnResume (wrongly CLEARING a set needs_user_input flag)
  // and make isGenuinelyIdle/handleIdleAgent read the agent as active. Treat it as "unknown"
  // (null) at the SOURCE — exactly like a missing log — so EVERY downstream consumer is
  // protected at once. Returns before setIdle, so the idle flag is left untouched.
  if (quietMs < 0) return null;
  // On the 0→1 flip, capture the run-log tail as idle_context so the idle-handling
  // responder sees what the agent was doing. The capture thunk is invoked by setIdle
  // ONLY when the flag actually flips to idle (never on the per-second no-op poll), so
  // we don't re-read the log every tick while the stall persists.
  setIdle(taskId, quietMs > config.idleMs, () =>
    readRunLogTail(taskId, config.idleContextLines),
  );
  return quietMs;
}

/**
 * IDLE-HANDLING — one poll-tick step for a single watched task. A WORKSPACE build
 * agent can sit idle-but-alive on a transient API error (e.g. a 529 Overloaded),
 * parked at an empty prompt, or finished-but-unsubmitted. butchr NO LONGER blindly
 * types "continue" at it: an idle agent is surfaced as a graceful FEEDBACK condition
 * (refreshIdle flags it + captures `idle_context`; the channel pushes an `idle` event;
 * the webapp shows action buttons) routed to the workspace's `idle-handling` responder,
 * who acts deliberately — nudge-with-guidance (tasks.nudgeTask), requeue, or abort. The
 * plain "continue" nudge is now just ONE of those responder choices, never automatic.
 *
 * This step's ONLY job is the one thing that must happen WITHOUT a responder:
 *  - LIVENESS GUARD (the "continuecontinuecontinue into a dead shell" incident fix):
 *    a herdr/host restart kills claude but leaves the pane as a bare login shell with
 *    the agent NAME still registered, so `agentExists` lies "alive". The process is the
 *    ground truth: if claude is NOT in /proc for this session, the pane is DEAD — do
 *    NOT surface it as a nudgeable idle agent; AUTO-RESUME instead (requeueForResume
 *    tears down the husk pane and re-dispatches the same session via `--resume`).
 *    requeueForResume clears has_agent, so the watcher's loop-top hands off next tick.
 *    (No stored pane to self-heal: nudge/attach/teardown all resolve the live pane BY
 *    NAME at action time.)
 *
 * SCOPE — fires ONLY for a live `in_progress` workspace build agent (the managed CTO
 * agent is event-driven/idle-by-design and never runs under a task watcher). A
 * non-`in_progress` phase or a missing log (`quietMs === null`) is a NO-OP, as is a
 * quiet duration still under `idleMs` (not idle — refreshIdle already cleared the flag).
 */
export async function handleIdleAgent(
  taskId: string,
  phase: string | undefined,
  quietMs: number | null,
): Promise<void> {
  // Not a live build agent, or the log hasn't appeared yet → nothing to handle.
  if (quietMs === null || phase !== "in_progress") return;
  // Not idle (output is recent) → refreshIdle already cleared the flag; nothing to do.
  if (quietMs <= config.idleMs) return;
  // LIVENESS GUARD: a quiet agent whose claude is GONE is a dead shell, not an idle
  // agent — auto-resume it rather than surfacing it as nudgeable. (requeueForResume
  // clears the pane → the watcher hands off to a fresh dispatch next tick.)
  if (!claudeAlive(getTask(taskId)?.session_id ?? null)) {
    await requeueForResume(
      taskId,
      "agent process is no longer alive while idle (herdr/host restart suspected); auto-resuming instead of surfacing as idle",
    );
    return;
  }
  // Alive but quiet — a genuine idle agent. Nothing to do here: nudge/attach resolve the
  // live pane BY NAME at action time, so we just leave it flagged `idle` (with context)
  // for the idle-handling responder to act on.
  //
  // HUNG-BUT-ALIVE backstop: a deadlocked/syscall-stuck claude reads as `alive` forever via
  // the /proc UUID-token probe (claudeAlive — correct, /proc presence is the only ground
  // truth), so it is never auto-resumed here and a responder nudge can't unstick it. The
  // recovery path is the now-CONTINUOUS runaway timer (runningElapsedMs from DB started_at):
  // it trips on maxRunMs regardless of restarts and force-rescues the task to review. No
  // separate long-idle-alive surface is added here by design — that backstop covers it.
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
 * RUNNING-SINCE elapsed for the runaway watchdog, measured from the DB's
 * `tasks.started_at` (the TRUE running-since: stamped once via keep() and preserved
 * across resumes/restarts) rather than a watcher-local Date.now(). This keeps the
 * maxRunMs budget CONTINUOUS across a butchr restart / re-adoption — a stuck agent
 * that has been running past maxRunMs still trips after a restart instead of being
 * handed a FRESH budget every time a new watcher spawns for it.
 *
 *  - `startedAt` is the ISO string from `tasks.started_at` (or null/missing if the
 *    task somehow never stamped one). `now` is injected so the boundary is pure +
 *    unit-testable.
 *  - Returns `null` when started_at is absent or unparseable — an UNKNOWN running-since
 *    that callers must NOT treat as a trip (never force-rescue on a missing timestamp).
 */
export function runningElapsedMs(
  startedAt: string | null | undefined,
  now: number,
): number | null {
  if (!startedAt) return null; // never stamped → unknown, don't trip the guard
  const since = Date.parse(startedAt);
  if (Number.isNaN(since)) return null; // unparseable → unknown
  return now - since;
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
  _dir: WorkspaceRow,
  taskId: string,
  _paneId: string,
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
    // AUTO-RESUME HAND-OFF: set when the task's pane is cleared out from under us
    // (its claude died and was auto-resumed, or an operator re-queued) — a fresh
    // dispatch+watcher now owns it, so we release our slot WITHOUT rescuing to review.
    let handedOff = false;
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
    // 1-based watcher-tick counter, driving the THROTTLED mid-session pane-content probe
    // (shouldProbeTick): the loop runs ~1s but we only read the pane every
    // config.midProbeEveryTicks ticks (agentRead shells out to herdr).
    let tick = 0;
    while (true) {
      tick++;
      if (abortSignals.has(taskId)) break;
      // Release our slot the moment the task leaves its live agent phase. Once it
      // reaches in_review/needs_info/inactive/merged/failed/aborted the agent has
      // submitted/exited — there is nothing left to rescue. The only live agent phase
      // that holds a pane is `in_progress` (the build). Any other state means the task
      // was reclaimed elsewhere, so we stop looping; otherwise we'd hold the `watching`
      // slot forever and tick() would skip the task.
      const curTask = getTask(taskId);
      const cur = curTask?.status;
      if (cur !== "in_progress") break;
      // AUTO-RESUME HAND-OFF: the agent ownership was dropped (has_agent=0) out from
      // under us — the nudge guard auto-resumed a dead-claude agent (requeueForResume), a
      // reaper backstop did, or an operator re-queued. A fresh dispatch+watcher will own
      // it; stop here so we don't rescue a task that's already being relaunched. Keyed on
      // the honest marker (not the doomed pane column) — requeueForResume clears both.
      if (curTask!.has_agent === 0) {
        handedOff = true;
        break;
      }
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
        // Measure runaway elapsed from the DB's `started_at` (running-since), NOT the
        // watcher-local `startedAt` — so the maxRunMs budget is CONTINUOUS across a
        // butchr restart / re-adoption (a fresh watcher recomputing from its own
        // Date.now() would hand a stuck agent a brand-new budget on every restart). A
        // null/unknown running-since (missing/unparseable started_at) never trips.
        const elapsed = runningElapsedMs(curTask!.started_at, Date.now());
        if (elapsed !== null && runawayExceeded(elapsed, config.maxRunMs)) {
          runaway = true;
          runawayMs = elapsed;
          break;
        }
      }
      const alive = await harness.agentExists(taskId);
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
      // quiet (no recent log output) for the UI's idle indicator and capture the
      // idle context on the flip. The returned quiet-duration drives the idle-handling
      // step below (liveness guard + pane self-heal; the nudge is now responder-driven).
      const quietMs = refreshIdle(taskId, logFile);
      await handleIdleAgent(taskId, cur, quietMs);
      // CLEAR-ON-RESUME: every tick (~1s), clear a stale needs_user_input flag the moment the
      // agent resumes producing output (mirrors how idle self-clears) — don't make a resuming
      // agent wait on the throttled mid-session probe below.
      clearNeedsUserInputOnResume(taskId, quietMs);
      // MID-SESSION SAFETY NET: on a coarse cadence (NOT every 1s tick — agentRead
      // shells out to herdr), read the pane content and auto-confirm / flag / clear a
      // human-only prompt that appeared AFTER launch. GATED on genuine idle (quietMs passed
      // through): an actively-working agent is left completely untouched, so benign
      // active-turn text is never mis-flagged. Fire-and-forget + best-effort so it never
      // perturbs the hot watcher loop or fails the task (probeTaskMidSession swallows all
      // errors and never throws).
      if (shouldProbeTick(tick, config.midProbeEveryTicks)) {
        void probeTaskMidSession(taskId, quietMs);
      }
      await sleep(1000);
    }

    // Aborted out from under us: drop the task without capturing output or
    // moving it to review. abortTask owns the pane close + worktree cleanup.
    if (consumeAbort(taskId)) return;

    // Auto-resumed / re-queued out from under us (pane cleared): a fresh dispatch owns
    // this task now — release our slot WITHOUT rescuing it to review.
    if (handedOff) {
      watching.delete(taskId);
      return;
    }

    // If the agent already submitted (in_review / needs_info) or the task moved on
    // (inactive/merged/failed/aborted), there is nothing to rescue. Only a task still
    // sitting in the live build phase (`in_progress`) here means the agent ended
    // WITHOUT submitting.
    const phase = getTask(taskId)?.status;
    if (phase !== "in_progress") {
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
        if (consumeAbort(taskId)) return;
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

    // The process is gone; close the whole tab defensively BY NAME in case a husk pane
    // remains, so the dead task's tab doesn't linger.
    await harness.teardownTask(taskId);

    // Last-moment abort (signalled while we captured output): bail without
    // moving to review so abortTask's terminal state stands.
    if (consumeAbort(taskId)) return;

    // RESCUE: the build (in_progress) agent ended without submitting → move the task
    // to in_review for a human to inspect (approval then merges mechanically).
    markInReview(taskId, snapshot);
    watching.delete(taskId);
    console.log(`[butchr] task ${taskId} → in_review (${reason})`);
  })();
}
