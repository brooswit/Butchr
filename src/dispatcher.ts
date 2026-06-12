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
import { db, getSetting, recordTaskEvent, setSetting } from "./db.ts";
import type { WorkspaceRow, TaskRow } from "./db.ts";
import { ensureHerdrWorkspace } from "./workspaces.ts";
import { buildScriptArgv, modelFlag, stripAnsi } from "./exec.ts";
import * as git from "./git.ts";
import { harness } from "./harness.ts";
import { startAgentInFreshTab } from "./herdr.ts";
import { claudeAlive } from "./liveness.ts";
import { groundingFingerprint, readTaskMd, renderAgentPrompt, renderAnswerPrompt, renderRegroundBlock, renderReworkPrompt } from "./taskmd.ts";
import { adoptPane, getTask, markDispatchFailure, markInReview, markRunning, markSpecGenFailure, maybeAutoMerge, prepareBranchForDispatch, promoteIdeaToSpecReview, reevaluateBlockedTask, repairPaneId, requeueForResume, setIdle } from "./tasks.ts";
import { generateSpec } from "./cto.ts";

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
const ideating = new Set<string>(); // idea task ids mid spec-generation
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
  // A LIVE agent task is one that is `in_progress` (a running build agent) — by the
  // 12-state model a running task always recorded a pane. Ready `inactive` tasks are
  // never-launched/rework and are handled by the normal tick, not here.
  const rows = db
    .query<QueuedRow, []>(
      `SELECT t.*, d.path, d.label, d.herdr_workspace, d.herdr_pane, d.id AS dir_id
         FROM tasks t JOIN workspaces d ON d.id = t.workspace_id
         WHERE t.status='in_progress' AND t.herdr_pane_id IS NOT NULL`,
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

    if (nameAlive && procAlive) {
      // Live agent — re-adopt. Record its current pane + tab (both may have moved
      // while butchr was down — herdr renumbers positional ids when sibling tabs
      // close). Resolve the pane BY NAME via the renumber-stable resolver, not the
      // stored id, so we re-attach against the agent's CURRENT pane.
      const paneId =
        (await harness.resolveAgentPane(row.id)) ?? row.herdr_pane_id ?? row.id;
      const tabId = (await harness.agentTabId(row.id)) ?? row.herdr_tab_id ?? undefined;
      if (paneId !== row.herdr_pane_id || tabId !== row.herdr_tab_id) {
        adoptPane(row.id, paneId, tabId);
      }
      spawnWatcher(dir, row.id, paneId, logFile, doneFile);
      adopted++;
      console.log(`[butchr] re-adopted running task ${row.id} (pane ${paneId}, tab ${tabId})`);
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
      // husk) tab defensively.
      await harness.teardownTask(row.herdr_tab_id, row.id, row.herdr_pane_id);
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
         WHERE t.status='inactive'
           AND (t.next_dispatch_at IS NULL OR t.next_dispatch_at <= ?)
         ORDER BY t.priority DESC, t.created_at ASC`,
    )
    .all(nowStr);
}

/**
 * The tick's IDEA gate: `idea`-state tasks eligible to run the CTO-fork spec generator
 * right now (highest-PRIORITY first, then oldest-first), honoring the same backoff
 * (next_dispatch_at) and PAUSE rules as the queued gate — generating a spec is "new
 * work", so maintenance mode (drain-only) suppresses it too. An idea task whose spec
 * generation keeps failing waits out markSpecGenFailure's backoff before retrying.
 */
export function selectIdeaForDispatch(nowStr: string): QueuedRow[] {
  if (paused) return [];
  return db
    .query<QueuedRow, [string]>(
      `SELECT t.*, d.path, d.label, d.herdr_workspace, d.herdr_pane, d.id AS dir_id
         FROM tasks t JOIN workspaces d ON d.id = t.workspace_id
         WHERE t.status='idea'
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
      .query<{ id: string }, []>(`SELECT id FROM tasks WHERE status='blocked'`)
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
          `SELECT id FROM tasks WHERE status='in_review' AND ci_status='pass' AND auto_merged=0`,
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

    // IDEA pass: run the CTO-fork spec generator for any eligible `idea`-state task
    // (front of the unified pipeline). This is NOT a build agent — it turns the brief
    // into a spec headlessly and advances the task to `queued` ('ready'), where the
    // queued pass below dispatches it normally. Suppressed while paused (see
    // selectIdeaForDispatch). The `ideating` set guards against double-running the same
    // idea across overlapping ticks (mirrors `dispatching` for build tasks).
    for (const row of selectIdeaForDispatch(nowStr)) {
      if (ideating.has(row.id)) continue;
      const dir = dirOf(row);
      ideating.add(row.id);
      // Fire-and-forget, concurrently.
      generateSpecForIdea(dir, row).finally(() => ideating.delete(row.id));
    }

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

/**
 * Run the CTO-fork spec generator for one `idea`-state task and advance it. Reads the
 * task's brief (its initial prompt) from task.md, ensures the worktree exists so the spec
 * writer has the repo to ground against, then calls generateSpec (src/cto.ts):
 *  - SUCCESS → promoteIdeaToReady rewrites the task.md prompt to the spec and advances the
 *    task to `queued` ('ready') / `blocked` (if it has unmerged blockers).
 *  - FAILURE (null spec, or a thrown error) → markSpecGenFailure applies the bounded
 *    retry/backoff and gives up to `failed` at the cap.
 * Best-effort: never throws (the tick must not break on one idea's failure).
 */
export async function generateSpecForIdea(dir: WorkspaceRow, task: TaskRow): Promise<void> {
  try {
    // Ensure the worktree exists (idempotent) so the read-only spec writer can ground
    // itself against the repo's CONTRIBUTING.md / code.
    const worktree = await git.createWorktree(dir.path, task.id);
    const doc = readTaskMd(dir.path, task.id);
    const brief = doc.prompt;
    // On a REVISE round (the operator requested spec changes via spec_review →
    // request_changes), the accumulated review notes carry what to change; thread them
    // into the generator so the regenerated spec addresses the feedback.
    const notes = doc.reviewNotes?.trim() || undefined;
    const spec = await generateSpec({ brief, cwd: worktree, taskId: task.id, notes });
    if (spec && spec.trim()) {
      promoteIdeaToSpecReview(task.id, spec);
    } else {
      markSpecGenFailure(
        task.id,
        "the CTO-fork spec generator produced no spec (disabled, timed out, " +
          "errored, or returned empty output)",
      );
    }
  } catch (e) {
    markSpecGenFailure(task.id, (e as Error).message);
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
    .replaceAll("{{MODEL_FLAG}}", modelFlag(task.model));

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

    // Ensure the worktree exists (idempotent — handles rejected re-runs).
    const worktree = await git.createWorktree(dir.path, task.id);

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

    // Per-task MCP config pointing the agent at butchr's /mcp/<id> endpoint.
    writeFileSync(
      mcpConfigFile,
      JSON.stringify({
        mcpServers: {
          butchr: {
            type: "http",
            url: `http://${config.loopbackHost}:${config.port}/mcp/${task.id}`,
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
function refreshIdle(taskId: string, logFile: string): number | null {
  if (config.idleMs <= 0) return null;
  let mtimeMs: number;
  try {
    mtimeMs = statSync(logFile).mtimeMs;
  } catch {
    return null; // no log yet — agent is still spinning up
  }
  const quietMs = Date.now() - mtimeMs;
  setIdle(taskId, quietMs > config.idleMs);
  return quietMs;
}

/**
 * STALLED-AGENT AUTO-NUDGE decision: should the watcher send a `continue` nudge to
 * a live workspace agent right now? Pure (clock/IO-free) so the boundary is
 * unit-testable without spawning an agent. A stall is an agent that is ALIVE but
 * has produced NO output for long enough that it's almost certainly wedged on a
 * transient API error or parked at an empty prompt — the gap neither the idle flag
 * (which only marks it) nor the runaway watchdog (which only catches alive+looping)
 * recovers on its own.
 *
 *  - `quietMs`    — how long the agent's CLI has been silent (now - log mtime).
 *  - `sinceLastNudgeMs` — ms since we last nudged THIS stall, or null if we never
 *    have (the first nudge of a fresh stall).
 *  - `nudgesSent` — consecutive nudges already sent for this uninterrupted stall.
 *  - `idleMs` / `idleNudgeMs` / `maxNudges` — the config knobs.
 *
 * Nudge only when ALL hold: auto-nudging is enabled (`idleNudgeMs > 0` and
 * `maxNudges > 0`), we're under the consecutive-nudge cap, the agent has been quiet
 * past the idle threshold PLUS the grace period (`idleMs + idleNudgeMs`), and at
 * least a full grace period has elapsed since the previous nudge (so repeated
 * nudges are spaced, never fired every poll tick). The caller RESETS `nudgesSent`
 * the instant output resumes, so the cap counts only truly-unanswered nudges.
 */
export function shouldNudgeStall(opts: {
  quietMs: number;
  sinceLastNudgeMs: number | null;
  nudgesSent: number;
  idleMs: number;
  idleNudgeMs: number;
  maxNudges: number;
}): boolean {
  if (opts.idleNudgeMs <= 0 || opts.maxNudges <= 0) return false; // disabled
  if (opts.nudgesSent >= opts.maxNudges) return false; // cap reached — leave for a human
  if (opts.quietMs <= opts.idleMs + opts.idleNudgeMs) return false; // not stalled long enough
  // Space successive nudges by at least the grace period (first nudge: no prior).
  if (opts.sinceLastNudgeMs !== null && opts.sinceLastNudgeMs <= opts.idleNudgeMs) {
    return false;
  }
  return true;
}

/** The per-task auto-nudge state the watcher threads across its poll ticks. */
export type NudgeState = { nudgesSent: number; lastNudgeAt: number };

/**
 * Resolve a live task's CURRENT herdr pane BY AGENT NAME and SELF-HEAL the stored
 * `herdr_pane_id` when herdr has renumbered it out from under us (a sibling tab/pane
 * closed). This is the single use-time reconciliation every pane-touching path runs
 * so they all act on the LIVE pane — never the launch-time id that can now point at a
 * dead sibling shell (the bug that mis-aimed the auto-nudge and terminal-attach).
 *
 * Returns the current pane id, or — if herdr can't resolve a live pane this instant
 * (a transient read, or the agent just exited) — falls back to the stored id so a
 * momentary hiccup never erases a still-valid pane. Best-effort: a thrown herdr
 * error degrades to the stored id rather than propagating into the watcher loop.
 */
export async function currentPaneRepairing(taskId: string): Promise<string | undefined> {
  const stored = getTask(taskId)?.herdr_pane_id ?? null;
  let resolved: { paneId: string | undefined; drifted: boolean } | undefined;
  try {
    resolved = await harness.reconcilePane(taskId, stored);
  } catch {
    return stored ?? undefined; // herdr hiccup — keep what we had
  }
  const paneId = resolved?.paneId;
  if (paneId && resolved?.drifted && repairPaneId(taskId, paneId)) {
    console.log(
      `[butchr] task ${taskId} herdr pane drifted (${stored} → ${paneId}, renumbered); repaired stored id`,
    );
  }
  return paneId ?? stored ?? undefined;
}

/**
 * STALLED-AGENT AUTO-NUDGE — one poll-tick step for a single watched task. A
 * WORKSPACE build agent can sit idle-but-alive on a transient API error (e.g. a 529
 * Overloaded) or parked at an empty prompt — a quiet stall that NEITHER the idle
 * flag (it only marks it) NOR the runaway watchdog (it only catches alive+looping)
 * recovers, so the task halts until a human opens the pane and types "continue".
 * This auto-types that `continue` for them.
 *
 * SCOPE — this fires ONLY for a live `in_progress` workspace build agent:
 *  - The managed CTO agent is event-driven and idle-BY-DESIGN (idle = waiting for a
 *    channel push); it also never runs under a task watcher, so it can't reach here.
 *  - `in_progress` is the only interactive build phase where `continue` means resume
 *    the work (there is no post-approval agent — approval merges mechanically).
 * Any non-`in_progress` phase (or no log yet, `quietMs === null`) is a NO-OP that
 * leaves the state untouched.
 *
 * `quietMs` is how long the agent's CLI has been silent (now - log mtime). When it
 * drops back to/under `idleMs` the stall cleared (output resumed), so the
 * consecutive-nudge streak RESETS — the cap counts only truly-unanswered nudges.
 * Otherwise, when shouldNudgeStall says it's time, we best-effort send `continue` +
 * Enter to the agent's pane (a dead/missing pane is a harmless no-op), record the
 * nudge on the task's event timeline, and advance the state. Bounded by
 * `idleNudgeMaxNudges` consecutive nudges before we give up and leave the task
 * flagged `idle` for a human (shouldNudgeStall enforces the cap). `now` is injected
 * so the step is testable without mocking the clock.
 */
export async function maybeNudgeStalledAgent(
  taskId: string,
  phase: string | undefined,
  quietMs: number | null,
  state: NudgeState,
  now: number,
): Promise<NudgeState> {
  // Not a live build agent, or the log hasn't appeared yet → nothing to nudge.
  if (quietMs === null || phase !== "in_progress") return state;
  // Output resumed (or never stalled) → clear any in-flight nudge streak.
  if (quietMs <= config.idleMs) return { nudgesSent: 0, lastNudgeAt: 0 };
  // LIVENESS GUARD (the "continuecontinuecontinue into a dead shell" fix): the agent
  // is quiet — but is its `claude` STILL ALIVE? A herdr/host restart kills claude and
  // leaves the pane as a bare login shell while herdr keeps the agent name registered,
  // so `agentExists` would still say "alive" and we'd type `continue` into a dead
  // shell forever. The process is the ground truth: if claude is NOT in /proc for this
  // session, do NOT nudge — trigger AUTO-RESUME instead (tear down the husk pane and
  // re-dispatch the same session via `--resume`). requeueForResume clears the pane, so
  // the watcher's loop-top sees pane=NULL next tick and hands off to the fresh dispatch.
  if (!claudeAlive(getTask(taskId)?.session_id ?? null)) {
    await requeueForResume(
      taskId,
      "agent process is no longer alive while quiet (herdr/host restart suspected); nudge suppressed",
    );
    return state;
  }
  // The agent is idle/quiet but ALIVE — exactly the window where its stored pane id may
  // be stale (a sibling tab closed → herdr renumbered) AND where we're about to act on
  // the pane (the nudge below; a human may also attach right now). Re-resolve the
  // CURRENT pane by name and self-heal the stored id so the nudge — and any attach —
  // target the live pane, not a renumbered-away shell. `send` itself routes by name,
  // so this also keeps the recorded id truthful for the UI/teardown.
  await currentPaneRepairing(taskId);
  if (
    !shouldNudgeStall({
      quietMs,
      sinceLastNudgeMs: state.lastNudgeAt === 0 ? null : now - state.lastNudgeAt,
      nudgesSent: state.nudgesSent,
      idleMs: config.idleMs,
      idleNudgeMs: config.idleNudgeMs,
      maxNudges: config.idleNudgeMaxNudges,
    })
  ) {
    return state;
  }
  const nudgesSent = state.nudgesSent + 1;
  // Type the steering line and submit it, exactly as a human would.
  await harness.send(taskId, { text: "continue", enter: true });
  const note =
    `[butchr] stalled workspace agent auto-nudged (quiet ~${Math.round(quietMs / 1000)}s): ` +
    `sent 'continue' (nudge ${nudgesSent}/${config.idleNudgeMaxNudges}).`;
  // Logged as an in_progress→in_progress timeline entry (a within-state event, like
  // the agent-launched marker) so the nudge is auditable without a status change.
  recordTaskEvent(taskId, "in_progress", "in_progress", note);
  console.log(`[butchr] task ${taskId} ${note}`);
  return { nudgesSent, lastNudgeAt: now };
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
  _dir: WorkspaceRow,
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
    // STALLED-AGENT AUTO-NUDGE state. `nudgesSent` counts the consecutive nudges
    // sent to the CURRENT uninterrupted stall (reset to 0 the instant output
    // resumes); `lastNudgeAt` is when the most recent nudge went out (0 = none yet),
    // so successive nudges stay spaced by the grace period. See shouldNudgeStall.
    let nudgesSent = 0;
    let lastNudgeAt = 0;
    while (true) {
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
      // AUTO-RESUME HAND-OFF: the pane was cleared (NULL) out from under us — the
      // nudge guard auto-resumed a dead-claude agent (requeueForResume), a reaper
      // backstop did, or an operator re-queued. A fresh dispatch+watcher will own it;
      // stop here so we don't rescue a task that's already being relaunched.
      if (curTask!.herdr_pane_id == null) {
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
        const elapsed = Date.now() - startedAt;
        if (runawayExceeded(elapsed, config.maxRunMs)) {
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
      // quiet (no recent log output) for the UI's idle indicator. The returned
      // quiet-duration also drives the stall auto-nudge step below.
      const quietMs = refreshIdle(taskId, logFile);
      ({ nudgesSent, lastNudgeAt } = await maybeNudgeStalledAgent(
        taskId,
        cur,
        quietMs,
        { nudgesSent, lastNudgeAt },
        Date.now(),
      ));
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

    // The process is gone; close the whole tab defensively in case a husk pane
    // remains, so the dead task's tab doesn't linger. (markReview clears the
    // stored tab id, so close it now while we still have it.)
    await harness.teardownTask(getTask(taskId)?.herdr_tab_id, taskId, paneId);

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
