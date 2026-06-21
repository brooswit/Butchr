// UNIFIED WORKSPACE SUPERVISOR (story st-540ba705, step 3 — gated OFF + fully INERT).
//
// A WORKSPACE is the (agent + directory) EXECUTION CONTEXT in which Work runs — the
// place and the agent, distinct from Work itself (see docs/rfc-work-workspace-unification.md
// §2.2). This module is the SINGLE supervision loop that GENERALIZES the three agent
// surfaces — the per-workspace CTO agent (src/cto-agent.ts), the per-story story leader
// (src/story-agent.ts), and the per-task build agent (src/dispatcher.ts) — into ONE
// concept distinguished by `kind` ('cto'|'leader'|'build'), supervised uniformly over the
// `workspace` table. It collapses the two near-identical cto/story supervisors (a
// deliberate mirror-not-extract until now) into one kind-agnostic state machine.
//
// IDENTITY is NAME-ONLY (story st-a77b050f, generalized across all kinds): an agent is
// addressed, torn down, and liveness-checked BY NAME — no per-agent pane/tab is stored.
// The name is derived per kind to MATCH today's names (so the unified path is a drop-in at
// the cutover): cto → `<prefix>-<directory_id>`, leader → `<prefix>-story-<work_id>`,
// build → `<work_id>` (the task id). LIVENESS is the /proc ground truth (src/liveness.ts):
// herdr's pane/agent-name survives a host reboot that KILLED claude, so a registered-but-
// dead husk is detected (claudeLiveness → "dead") and torn down before a `--resume`
// relaunch, exactly as the cto/story paths do.
//
// WORK↔WORKSPACE is 1:N with EXACTLY ONE LIVE at a time (RFC Q3): launching a work-bound
// workspace demotes its siblings (db.demoteSiblingWorkspaceAgents) so only one owns the
// agent.
//
// GATING / INERTNESS (HARD): every public entry point no-ops while
// config.unifiedWorkspaceEnabled is OFF (the default), and this module is NOT imported by
// src/index.ts — so nothing here runs in production. The EXISTING cto_agent / story_agent
// supervisors + the per-task build-agent dispatch remain the sole authoritative paths; the
// coexistence/cutover that replaces them with this loop is the separately-authorized step 6,
// out of scope here. Turning the flag on today exercises this loop (and the tests) WITHOUT
// removing the old supervisors.
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHANNEL_SERVER_NAME } from "./channel.ts";
import { config } from "./config.ts";
import {
  type WorkspaceAgentRow,
  type WorkspaceRow,
  db,
  demoteSiblingWorkspaceAgents,
  getWorkspaceAgentRow,
  listWorkspaceAgentRows,
  listWorkspaceAgentRowsForWork,
  liveWorkspaceForWork,
  nowIso,
  saveWorkspaceAgentRow,
} from "./db.ts";
// The mid-session probe reuses the build-agent safety net's pure helpers AS-IS (genuine-idle
// threshold + throttle gate). dispatcher.ts does NOT import workspace-agent.ts (directly or
// transitively — its only workspace-agent-importing dependency would be stories.ts, which the
// dispatcher never imports), so this introduces NO import cycle and no shared module is needed.
import { isGenuinelyIdle, shouldProbeTick } from "./dispatcher.ts";
import { ensureHerdrWorkspace } from "./workspaces.ts";
import { isCtoEnabled } from "./cto-agent.ts";
import { buildScriptArgv, modelFlag } from "./exec.ts";
import { harness } from "./harness.ts";
import type { SendInput } from "./harness.ts";
import { startAgentInFreshTab } from "./herdr.ts";
import { claudeLiveness } from "./liveness.ts";
import { autoConfirmStartupPrompts, classifyStartupScreen } from "./startup-confirm.ts";
import type { AutoConfirmResult, ConfirmRule } from "./startup-confirm.ts";

/** Is the unified-workspace supervisor ENABLED? OFF by default (fully inert when off). */
export function isUnifiedWorkspaceEnabled(): boolean {
  return config.unifiedWorkspaceEnabled;
}

/**
 * The herdr agent name for a workspace row — NAME-ONLY identity, derived per kind to
 * MATCH today's names so the unified path is a drop-in at the cutover. A stored `name`
 * column WINS (so a caller can pin an explicit name); otherwise it is derived:
 *   - cto    → `<prefix>-<directory_id>`        (== cto-agent.ctoAgentName)
 *   - leader → `<prefix>-story-<work_id>`       (== story-agent.storyAgentName)
 *   - build  → `<work_id>`                       (== the dispatcher's task-id agent name)
 */
export function workspaceAgentName(row: WorkspaceAgentRow): string {
  if (row.name && row.name.trim()) return row.name.trim();
  if (row.kind === "cto") return `${config.ctoAgentName}-${row.directory_id ?? ""}`;
  if (row.kind === "leader") return `${config.ctoAgentName}-story-${row.work_id ?? ""}`;
  return row.work_id ?? row.id; // build: the task id is the agent name
}

/** The directory (repo root) a workspace runs in — its directory_id → workspaces.path. */
function directoryPath(directoryId: string | null): string | null {
  if (!directoryId) return null;
  const row = db
    .query<{ path: string }, [string]>(`SELECT path FROM workspaces WHERE id=?`)
    .get(directoryId);
  return row?.path ?? null;
}

/** A workspace's directory row (for the herdr-workspace label), or null. */
function directoryRow(directoryId: string | null): WorkspaceRow | null {
  if (!directoryId) return null;
  return (
    db.query<WorkspaceRow, [string]>(`SELECT * FROM workspaces WHERE id=?`).get(directoryId) ??
    null
  );
}

/** The dashboard/API view of a unified workspace's managed-agent state (mirrors CtoStatus). */
export type WorkspaceAgentStatus = {
  /** The workspace row id. */
  id: string;
  /** Which agent kind runs here. */
  kind: WorkspaceAgentRow["kind"];
  /** The unit of Work this executes (tasks(id)), or null for a CTO workspace. */
  workId: string | null;
  /** The operator/boot WANTS it up (supervisor relaunches on death). */
  desired: boolean;
  /** A live herdr agent is registered under this workspace's name (async-probed). */
  running: boolean;
  /** The Claude session id butchr resumes on every relaunch. */
  sessionId: string | null;
  /** When the current run was (re)launched. */
  since: string | null;
  /** Supervised relaunches since the last fresh start. */
  restarts: number;
  /** Most recent launch/supervision failure, if any. */
  lastError: string | null;
  /** The supervisor gave up relaunching this desired-up agent at the restart cap (durable). */
  gaveUp: boolean;
};

// ---- supervision state (in-memory, PER WORKSPACE ROW) ---------------------
// Mirrors cto-agent's wsStates / story-agent's storyStates, keyed by the workspace id.
type SupState = {
  launchInFlight: Promise<WorkspaceAgentStatus> | null;
  consecutiveFailures: number;
  nextRetryAt: number;
  /** Supervise-tick counter for the throttled operator mid-session pane probe. */
  superviseTicks: number;
  /**
   * A stop was requested while a launch-claim was (or might be) in flight. guarded() swallows
   * the stop body when launchInFlight is set, so this flag (paired with a SYNCHRONOUS desired=0)
   * lets the completing launch's tail re-check (reassertStopAfterLaunch) force desired-down — so
   * STOP wins the race deterministically. Cleared ONLY on a deliberate start (ensureStarted) and
   * after stopWorkspaceAgent's own teardown body — NEVER on the supervise relaunch path.
   */
  stopRequested: boolean;
};
const supStates = new Map<string, SupState>();
function supState(id: string): SupState {
  let s = supStates.get(id);
  if (!s) {
    s = {
      launchInFlight: null,
      consecutiveFailures: 0,
      nextRetryAt: 0,
      superviseTicks: 0,
      stopRequested: false,
    };
    supStates.set(id, s);
  }
  return s;
}

let superviseTimer: ReturnType<typeof setInterval> | null = null;

// ---- LAUNCHER seam (injectable) -------------------------------------------
// The supervision LOOP (desired/liveness/adopt/relaunch/backoff) is the deliverable; the
// actual agent LAUNCH is a dependency it calls through this seam, so tests drive the loop
// against the new table with a fake launcher (no real herdr/claude) and the cutover can
// swap a richer launcher in. The DEFAULT performs the genuinely-shared herdr mechanics for
// the OPERATOR kinds (cto/leader); build-context provisioning (a git worktree + branch,
// which the dispatcher owns) is wired at the step-6 cutover, so the default launcher throws
// for kind='build' rather than pretending to provision one. Inert either way (gated off).
export interface WorkspaceLauncher {
  /** Launch (or relaunch) the agent for this workspace; RESUME unless `fresh`. */
  launch(row: WorkspaceAgentRow, fresh: boolean): Promise<void>;
  /** Tear down the agent named `name` (best-effort, never throws). */
  teardown(name: string): Promise<void>;
}

// butchr's own state dir for a unified workspace's generated artifacts (never the repo).
function workspaceDir(id: string): string {
  return join(config.dataDir, "workspace", id);
}

/**
 * Decide the session id + flag for a workspace launch. FRESH → a brand-new `--session-id`;
 * otherwise RESUME the persisted session, else a fresh id. Mirrors cto-agent.resolveCtoSession
 * (no operator-seeded map at this layer). Pure + exported for testing.
 */
export function resolveWorkspaceSession(
  row: WorkspaceAgentRow | null,
  fresh: boolean,
): { sessionId: string; isResume: boolean } {
  if (fresh) return { sessionId: crypto.randomUUID(), isResume: false };
  const persisted = row?.session_id?.trim();
  if (persisted) return { sessionId: persisted, isResume: true };
  return { sessionId: crypto.randomUUID(), isResume: false };
}

/**
 * Write the per-workspace channel MCP config — the same one-way `butchr-cto-channel`
 * bridge the CTO/leader use, SCOPED per kind (cto → the directory; leader → its story;
 * build → connectivity-only). Returns the config path. Generalizes
 * cto-agent.writeChannelMcpConfig / story-agent.writeStoryChannelMcpConfig.
 */
function writeWorkspaceMcpConfig(row: WorkspaceAgentRow): string {
  mkdirSync(workspaceDir(row.id), { recursive: true });
  const env: Record<string, string> = {
    BUTCHR_CHANNEL_SSE_URL: `http://${config.loopbackHost}:${config.port}/api/events`,
  };
  if (row.kind === "cto") {
    if (row.directory_id) env.BUTCHR_CHANNEL_WORKSPACE = row.directory_id;
  } else if (row.kind === "leader") {
    if (row.work_id) env.BUTCHR_CHANNEL_STORY = row.work_id;
    if (row.directory_id) env.BUTCHR_CHANNEL_WORKSPACE = row.directory_id;
  } else {
    env.BUTCHR_CHANNEL_CONNECTIVITY_ONLY = "1";
  }
  const cfg = {
    mcpServers: {
      [CHANNEL_SERVER_NAME]: { command: "bash", args: ["-lc", config.ctoChannelCmd], env },
    },
  };
  const file = join(workspaceDir(row.id), "mcp.json");
  writeFileSync(file, JSON.stringify(cfg), "utf8");
  return file;
}

/** Build the fully-substituted, `script`-wrapped launch argv for an operator workspace. */
function buildWorkspaceArgv(
  row: WorkspaceAgentRow,
  sessionFlag: string,
  mcpConfig: string,
  promptFile: string,
): string[] {
  const cmd = row.kind === "leader" ? config.storyAgentCmd : config.ctoAgentCmd;
  const agentCmd = cmd
    .replaceAll("{{MODEL_FLAG}}", modelFlag(config.ctoAgentModel))
    .replaceAll("{{SESSION_FLAG}}", sessionFlag)
    .replaceAll("{{MCP_CONFIG}}", mcpConfig)
    .replaceAll("{{PROMPT_FILE}}", promptFile);
  return buildScriptArgv({ agentCmd, logFile: join(workspaceDir(row.id), "agent.log") });
}

/**
 * DEFAULT launcher: the generalized herdr launch for an OPERATOR workspace (cto/leader).
 * Resolves the directory, writes the scoped channel MCP config + a brief prompt, ensures
 * the herdr workspace, builds the argv (resuming the right session), starts the agent in a
 * fresh tab, persists session/started_at/has_agent (and enforces 1:N for work-bound rows),
 * and auto-confirms any blocking startup prompt. Throws for kind='build' (its worktree/
 * branch provisioning lands at the step-6 cutover). NOT guarded — callers hold the guard.
 */
/**
 * One-shot, best-effort startup auto-confirm for an OPERATOR workspace, shared by BOTH the
 * fresh-launch path (defaultLauncher.launch) and the adopt path (adoptOrLaunch) so the two
 * cannot drift. Mirrors dispatcher.ts `autoConfirmTaskStartup`: it polls the live pane and
 * sends the safe confirming keystroke ONLY while a blocking startup prompt is actually on
 * screen (dev-channels consent / folder-trust / numbered menu), de-bouncing the same
 * contiguous prompt and stopping after `quietPolls` clean reads — so it is a strict NO-OP
 * once the agent is past startup and NEVER injects a stray keystroke into a working leader.
 * Best-effort: it never throws, so it can never fail a launch OR an adopt. Exported so the
 * wiring is unit-testable directly. (The returned stuckScreen is intentionally ignored by
 * both callers today — surfacing an unrecognized/stuck prompt is a separate subtask.)
 */
export function autoConfirmWorkspaceStartup(name: string): Promise<AutoConfirmResult> {
  return autoConfirmStartupPrompts(name, {
    read: (n) => harness.agentRead(n),
    send: (n, input) => harness.send(n, input),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    pollMs: config.ctoPromptPollMs,
    maxPolls: config.ctoPromptMaxPolls,
    quietPolls: config.ctoPromptQuietPolls,
    log: (m) => console.log(`[butchr] workspace startup ${name}: ${m}`),
  }).catch(() => ({ answered: [] }));
}

const defaultLauncher: WorkspaceLauncher = {
  async launch(row, fresh) {
    if (row.kind === "build") {
      throw new Error(
        `unified workspace ${row.id}: build-kind launch (worktree + branch provisioning) ` +
          `is wired at the step-6 cutover; not provisioned by the inert default launcher`,
      );
    }
    const cwd = directoryPath(row.directory_id);
    if (!cwd) throw new Error(`workspace ${row.id}: directory ${row.directory_id} is gone`);

    const name = workspaceAgentName(row);
    const { sessionId, isResume } = resolveWorkspaceSession(getWorkspaceAgentRow(row.id), fresh);
    const sessionFlag = isResume ? `--resume ${sessionId}` : `--session-id ${sessionId}`;
    const mcpConfig = writeWorkspaceMcpConfig(row);
    const promptFile = join(workspaceDir(row.id), "brief.md");
    writeFileSync(
      promptFile,
      `# butchr ${row.kind} workspace agent\n\nWorkspace ${row.id} (kind ${row.kind}).\n`,
      "utf8",
    );
    const argv = buildWorkspaceArgv(row, sessionFlag, mcpConfig, promptFile);

    const dir = directoryRow(row.directory_id);
    const { workspaceId: herdrWorkspaceId } = await ensureHerdrWorkspace(
      row.directory_id ?? row.id,
      cwd,
      dir?.label ?? `butchr-ws-${row.id}`,
    );
    rmSync(join(workspaceDir(row.id), "agent.log"), { force: true });

    const { paneId } = await startAgentInFreshTab(harness, {
      name,
      cwd,
      argv,
      workspaceId: herdrWorkspaceId ?? undefined,
      label: `butchr-ws-${row.id}`,
      paneError: `workspace ${row.id} did not register a live pane after start`,
    });

    saveWorkspaceAgentRow(row.id, {
      session_id: sessionId,
      herdr_workspace: herdrWorkspaceId ?? null,
      desired: 1,
      started_at: nowIso(),
      has_agent: 1,
      last_error: null,
    });
    // 1:N — exactly one LIVE workspace per Work (RFC Q3): demote any siblings.
    if (row.work_id) demoteSiblingWorkspaceAgents(row.work_id, row.id);
    console.log(
      `[butchr] launched ${row.kind} workspace ${row.id} ` +
        `(${isResume ? `--resume ${sessionId}` : `fresh session ${sessionId}`}, pane ${paneId})`,
    );

    // FIRE-AND-FORGET (see the adopt branch in adoptOrLaunch): never await the per-pane
    // startup poll on the boot/reconcile critical path, so a slow/never-quiet pane can
    // never delay the launch caller (and thus the port bind). Best-effort + double-swallow.
    void autoConfirmWorkspaceStartup(name).catch(() => {});
  },
  async teardown(name) {
    await harness.teardownTask(name).catch(() => {});
    await harness.agentDeregister(name).catch(() => {});
  },
};

let launcher: WorkspaceLauncher = defaultLauncher;

/** Test-only: swap the launcher (a fake that records calls + drives liveness). Pass null to restore. */
export function setLauncherForTest(l: WorkspaceLauncher | null): void {
  launcher = l ?? defaultLauncher;
}

/** Serialize a lifecycle op for a workspace behind its launchInFlight (single-instance). */
function guarded(
  id: string,
  fn: () => Promise<WorkspaceAgentStatus>,
): Promise<WorkspaceAgentStatus> {
  const st = supState(id);
  if (st.launchInFlight) return st.launchInFlight;
  const p = fn().finally(() => {
    if (st.launchInFlight === p) st.launchInFlight = null;
  });
  st.launchInFlight = p;
  return p;
}

/**
 * The 'live agent registered → adopt, else launch' decision, shared by start + reconcile.
 * Mirrors cto-agent.adoptOrLaunch EXACTLY (incl. the reboot-recovery /proc gate): a
 * registered-but-DEAD pane (host reboot left a husk shell) is torn down + the name freed
 * before a `--resume` relaunch; an alive/indeterminate one is adopted (never double-launch).
 */
async function adoptOrLaunch(row: WorkspaceAgentRow, fresh: boolean): Promise<"adopted" | "launched"> {
  const name = workspaceAgentName(row);
  if (!fresh && (await harness.agentExists(name))) {
    const cur = getWorkspaceAgentRow(row.id);
    if (claudeLiveness(cur?.session_id) !== "dead") {
      // alive OR unknown → adopt (mark desired-up, owning the agent, and enforce 1:N).
      saveWorkspaceAgentRow(row.id, {
        desired: 1,
        has_agent: 1,
        started_at: cur?.started_at ?? nowIso(),
        last_error: null,
      });
      if (row.work_id) demoteSiblingWorkspaceAgents(row.work_id, row.id);
      console.log(`[butchr] adopted live ${row.kind} workspace ${row.id}`);
      // The agent may have been ADOPTED while still parked at a blocking startup prompt
      // (e.g. butchr restarted during the launch auto-confirm window, leaving an operator
      // frozen at the dev-channels consent / folder-trust dialog). Run the SAME one-shot,
      // de-bounced auto-confirm the launch path uses so it gets confirmed instead of hanging
      // forever. Operator kinds only (the adopt branch is operator-only today, but be
      // explicit). Best-effort: it can NEVER fail an adopt, and is a strict no-op (sends
      // nothing) once the agent is past startup, so a working leader is never disturbed.
      if (row.kind === "cto" || row.kind === "leader") {
        // FIRE-AND-FORGET: never await the per-pane startup poll on the boot/reconcile
        // critical path. A pane that misclassifies as non-quiet would otherwise burn the
        // full maxPolls×pollMs budget here and gate the port bind (the 0.9.136 crash-loop).
        // The probe still runs + still confirms a real dev-channels dialog — it just no
        // longer blocks adoptOrLaunch. The inner .catch (and autoConfirmWorkspaceStartup's
        // own swallow) guarantees a detached rejection can never crash the process.
        void autoConfirmWorkspaceStartup(name).catch(() => {});
      }
      return "adopted";
    }
    console.log(
      `[butchr] ${row.kind} workspace ${row.id} has a registered pane but a DEAD claude ` +
        `(host reboot suspected) — tearing down the stale pane and relaunching (--resume)`,
    );
    await launcher.teardown(name);
  }
  await launcher.launch(row, fresh);
  return "launched";
}

/**
 * The guarded START core shared by startWorkspaceAgent + reconcileWorkspaceAgent: mark
 * DESIRED-up, reset backoff, adopt-or-launch (a SINGLE liveness probe), resetting the
 * supervised-restart counter on a fresh launch. Returns BOTH the action and the status.
 */
function ensureStarted(
  row: WorkspaceAgentRow,
  fresh: boolean,
): Promise<{ action: "adopted" | "launched"; status: WorkspaceAgentStatus }> {
  let action: "adopted" | "launched" = "launched";
  const status = guarded(row.id, async () => {
    // A DELIBERATE operator start/enable resets supervision → drop any durable give-up marker
    // so a re-enabled/restarted agent is no longer reported as dead-and-abandoned (st-a4cc6082).
    const gaveUp = getWorkspaceAgentRow(row.id)?.gave_up === 1;
    saveWorkspaceAgentRow(row.id, gaveUp ? { desired: 1, gave_up: 0 } : { desired: 1 });
    const st = supState(row.id);
    st.consecutiveFailures = 0;
    st.nextRetryAt = 0;
    st.stopRequested = false; // a DELIBERATE start supersedes any prior stop intent
    action = await adoptOrLaunch(row, fresh);
    // STOP-WINS / terminal re-check: a stop (or a terminal transition) that raced this slow
    // launch must not be clobbered by the desired=1 write above. If it intervened, do NOT
    // restamp restarts (the launch was just undone).
    if (!(await reassertStopAfterLaunch(row.id)) && action === "launched") {
      saveWorkspaceAgentRow(row.id, { restarts: 0 });
    }
    return workspaceAgentStatus(row.id);
  });
  return status.then((s) => ({ action, status: s }));
}

/**
 * ENSURE a unified-workspace row EXISTS (without launching anything). If no row is registered
 * under `id`, INSERT one with the create-time shape a fresh row needs (kind + directory_id/
 * work_id, has_agent=0, desired untouched) — mirroring the migrateWorkspaceAgentRows row shape
 * (db.ts) so a row created here is indistinguishable from a migrated one. Returns the row.
 *
 * A thin wrapper over saveWorkspaceAgentRow (which is ALREADY an upsert that requires `kind` on
 * create); it does NOT set `desired` — the caller does, so this stays a pure create primitive.
 * NOT gated on the unified flag (a plain DB helper). EXPORTED for reuse: story subtask S2 calls
 * it to create create-time rows, and setWorkspaceCtoEnabled uses it to materialize a ws-cto row.
 */
export function ensureWorkspaceAgentRow(
  id: string,
  fields: { kind: WorkspaceAgentRow["kind"]; directory_id?: string | null; work_id?: string | null },
): WorkspaceAgentRow {
  if (!getWorkspaceAgentRow(id)) {
    saveWorkspaceAgentRow(id, {
      kind: fields.kind,
      directory_id: fields.directory_id ?? null,
      work_id: fields.work_id ?? null,
      has_agent: 0,
    });
  }
  return getWorkspaceAgentRow(id)!;
}

/**
 * START (or adopt) a workspace's agent. No-op (returns the current status) when the unified
 * supervisor is gated OFF, so this is inert in production. Marks it DESIRED-up; adopts a
 * live agent (single-instance) or launches — RESUMING the persisted session unless `fresh`.
 */
export function startWorkspaceAgent(
  id: string,
  opts: { fresh?: boolean } = {},
): Promise<WorkspaceAgentStatus> {
  const row = getWorkspaceAgentRow(id);
  if (!row || !isUnifiedWorkspaceEnabled()) return workspaceAgentStatus(id);
  return ensureStarted(row, !!opts.fresh).then((r) => r.status);
}

/**
 * STOP a workspace's agent: mark it DESIRED-down (survives a restart), clear its owned-agent
 * marker, and tear it down + free its name. Idempotent. No-op when gated OFF.
 */
export function stopWorkspaceAgent(id: string): Promise<WorkspaceAgentStatus> {
  if (!isUnifiedWorkspaceEnabled()) return workspaceAgentStatus(id);
  // STOP MUST WIN over an in-flight launch. guarded() early-returns the in-flight launch promise
  // when launchInFlight is set, which would SWALLOW the stop body below — so the desired=0 write
  // must NOT live only inside guarded(). Mark stop-requested + write desired-down SYNCHRONOUSLY
  // here, OUTSIDE the launch-claim, so a stop issued mid-launch always lands; the completing
  // launch's tail re-check (reassertStopAfterLaunch) then forces desired-down deterministically.
  const st = supState(id);
  st.stopRequested = true;
  if (getWorkspaceAgentRow(id)) {
    saveWorkspaceAgentRow(id, { desired: 0, has_agent: 0, started_at: null });
  }
  return guarded(id, async () => {
    const row = getWorkspaceAgentRow(id);
    st.consecutiveFailures = 0;
    st.nextRetryAt = 0;
    if (row) await launcher.teardown(workspaceAgentName(row));
    st.stopRequested = false; // teardown ran to completion → future starts are unblocked
    console.log(`[butchr] stopped workspace ${id}`);
    return workspaceAgentStatus(id);
  });
}

/** RESTART a workspace's agent (RESUME by default; `fresh` cold-starts a new session). */
export async function restartWorkspaceAgent(
  id: string,
  opts: { fresh?: boolean } = {},
): Promise<WorkspaceAgentStatus> {
  await stopWorkspaceAgent(id);
  return startWorkspaceAgent(id, { fresh: opts.fresh });
}

/** A workspace's current managed-agent status (probes herdr for live registration). */
export async function workspaceAgentStatus(id: string): Promise<WorkspaceAgentStatus> {
  const row = getWorkspaceAgentRow(id);
  const running = row
    ? await harness.agentExists(workspaceAgentName(row)).catch(() => false)
    : false;
  return {
    id,
    kind: row?.kind ?? "build",
    workId: row?.work_id ?? null,
    desired: !!(row && row.desired === 1),
    running,
    sessionId: row?.session_id ?? null,
    since: row?.started_at ?? null,
    restarts: row?.restarts ?? 0,
    lastError: row?.last_error ?? null,
    gaveUp: row?.gave_up === 1,
  };
}

/**
 * The single LIVE workspace for a unit of Work (db.liveWorkspaceForWork), exposed here as
 * the unified module's reader for the RFC-Q3 1:N "one live per Work" relationship.
 */
export function liveWorkspaceFor(workId: string): WorkspaceAgentRow | null {
  return liveWorkspaceForWork(workId);
}

/**
 * Is a node-Work GENUINELY terminal? Read ONLY from the AUTHORITATIVE `stories.status` (==
 * getStory().status — the same value /api/work/:id + storyView report). Terminal == `done`
 * or `aborted`; `open`/`merging`/`merge_blocked` are NOT terminal (the leader is KEPT up).
 *
 * NEVER decide this from the node's `tasks` row: a materialized story node ALWAYS reads
 * tasks.status='merged' regardless of its real story status, so a raw-status check would
 * tear down leaders for ACTIVE stories. (Read the stories table directly to avoid a
 * stories.ts import cycle — workspace-agent.ts owns no story import.)
 */
function nodeWorkIsTerminal(workId: string | null): boolean {
  if (!workId) return false;
  const status = db
    .query<{ status: string }, [string]>(`SELECT status FROM stories WHERE id=?`)
    .get(workId)?.status;
  return status === "done" || status === "aborted";
}

/**
 * STOP-WINS / terminal re-check — run at the TAIL of every launch-claim (ensureStarted + the
 * supervise relaunch). A launch can take a while; meanwhile a stop may have been requested (its
 * guarded body swallowed by guarded()'s in-flight early-return) OR the node-Work may have gone
 * terminal. In either case the just-completed launch must NOT stand. Force desired-down FIRST
 * (so even a failing teardown can never leave desired=1), THEN best-effort tear the freshly
 * launched pane back down, and clear the stop flag. Returns true if it intervened. This is what
 * makes STOP authoritative over a concurrent in-flight launch deterministically.
 */
async function reassertStopAfterLaunch(id: string): Promise<boolean> {
  const st = supState(id);
  const row = getWorkspaceAgentRow(id);
  if (!row) return false;
  if (!st.stopRequested && !(row.kind === "leader" && nodeWorkIsTerminal(row.work_id))) {
    return false;
  }
  saveWorkspaceAgentRow(id, { desired: 0, has_agent: 0, started_at: null });
  await launcher.teardown(workspaceAgentName(row)).catch(() => {});
  st.stopRequested = false;
  return true;
}

/**
 * COMPLETION TEARDOWN (unified path): a node-Work reached a terminal state (done/aborted), so
 * tear down its LEADER workspace(s) — desired-down + close the pane + free the name — so the
 * supervisor stops relaunching them. The unified counterpart of onStoryStatusChanged's
 * stopStoryAgent (an unconditional desired-down, robust whether or not currently live). No-op
 * when the gate is OFF (the legacy story-agent path owns teardown then) or the node has no
 * leader workspace row. Best-effort per row; never throws to the caller. Only LEADER rows are
 * touched — a node's cto/build workspaces are left alone.
 */
export async function teardownLeaderWorkspaceForWork(workId: string): Promise<void> {
  if (!isUnifiedWorkspaceEnabled()) return;
  for (const row of listWorkspaceAgentRowsForWork(workId)) {
    if (row.kind !== "leader") continue;
    await stopWorkspaceAgent(row.id).catch(() => {});
  }
}

/** Reconcile ONE workspace toward its desired state (mirrors cto-agent.reconcileCtoAgent). */
export async function reconcileWorkspaceAgent(
  id: string,
  herdrUp: boolean,
): Promise<{ action: "disabled" | "skipped" | "stopped" | "adopted" | "launched" }> {
  if (!isUnifiedWorkspaceEnabled()) return { action: "disabled" };
  const row = getWorkspaceAgentRow(id);
  if (!row) return { action: "disabled" };
  // A LEADER for a TERMINAL node-Work must NEVER be adopted/relaunched (mirror legacy
  // isStoryLeaderDesired: a non-open story has no leader). Tear it down — desired-down +
  // free the name — so neither this reconcile NOR the supervisor revives it, then skip.
  // Terminal-ness reads the AUTHORITATIVE story status, never the node's tasks row. Done
  // even with herdr down so a leaked desired=1 row is corrected. Only leader rows.
  if (row.kind === "leader" && nodeWorkIsTerminal(row.work_id)) {
    await stopWorkspaceAgent(id);
    return { action: "stopped" };
  }
  // A CTO whose directory has it DISABLED must NEVER be adopted/relaunched (mirror legacy
  // reconcileCtoAgent's `if (!isCtoEnabled) return disabled`). Resolved via the directory's
  // cto_enabled tri-state vs the global default (default OFF), so the global default-off and
  // a per-directory disable are AUTHORITATIVE even against a stray desired=1 row: tear it down
  // — desired-down + free the name — so neither this reconcile NOR the supervisor revives it.
  // ADDED ALONGSIDE the leader gate (does not touch any other kind's path).
  if (row.kind === "cto" && !isCtoEnabled(row.directory_id ?? "")) {
    await stopWorkspaceAgent(id);
    return { action: "stopped" };
  }
  if (!herdrUp) return { action: "skipped" };
  if (row.desired === 0 && row.updated_at) {
    // Explicitly stopped before this restart — honor it.
    return { action: "stopped" };
  }
  const { action } = await ensureStarted(row, false);
  return { action };
}

/**
 * BOOT RECONCILE: bring every DESIRED-up workspace into its desired state once. INERT — a
 * no-op (returns zeroes) while gated OFF, and NOT wired into src/index.ts. Mirrors
 * reconcileCtoAgents / reconcileStoryAgents.
 */
export async function reconcileWorkspaceAgents(
  herdrUp: boolean,
): Promise<{ adopted: number; launched: number; skipped: number }> {
  if (!isUnifiedWorkspaceEnabled()) return { adopted: 0, launched: 0, skipped: 0 };
  let adopted = 0;
  let launched = 0;
  let skipped = 0;
  for (const row of listWorkspaceAgentRows()) {
    if (row.desired !== 1) continue;
    try {
      const res = await reconcileWorkspaceAgent(row.id, herdrUp);
      if (res.action === "adopted") adopted++;
      else if (res.action === "launched") launched++;
      else if (res.action === "skipped") skipped++;
    } catch (e) {
      saveWorkspaceAgentRow(row.id, { last_error: (e as Error).message });
      console.error(`[butchr] workspace reconcile failed for ${row.id}: ${(e as Error).message}`);
    }
  }
  return { adopted, launched, skipped };
}

// ---- MID-SESSION PANE PROBE (operator workspaces: kind 'cto'/'leader') ----------------
// The supervisor above is /proc-liveness-ONLY: it relaunches a DEAD agent but never reads a
// LIVE one's pane. So an operator parked at a blocking startup/permission dialog AFTER launch
// (or once the launch/adopt auto-confirm window has closed) is "running" by liveness yet hangs
// silently with 0 progress. This is the ongoing MID-SESSION safety net — the operator-workspace
// analogue of the build-agent watcher's mid-session probe (dispatcher.probeAgentForPrompt): a
// single throttled, genuine-idle-gated read+classify+act on the live pane.

/**
 * Sentinel prefix marking a `last_error` value the MID-SESSION probe wrote to SURFACE an
 * unrecognized blocking prompt (operator workspaces have no needs_user_input flag, so the row's
 * last_error is the lightweight attention signal). It scopes the probe's self-clear (on a `rule`
 * or `quiet` read) to ITS OWN signals so a genuine launch/relaunch error written by
 * superviseWorkspace / reconcile is never clobbered (and a successful (re)start, which writes
 * last_error:null, naturally clears a stale stuck signal).
 */
export const WORKSPACE_STUCK_PREFIX = "[needs-input] ";

/** Truncate a captured stuck-screen snapshot to a short, last-lines window for last_error. */
function stuckSnapshot(screen: string): string {
  const tail = screen.split("\n").slice(-12).join("\n").trim();
  return tail.length > 800 ? tail.slice(-800) : tail;
}

/**
 * GENUINE-IDLE quiet duration for an operator workspace: now - agent.log mtime, mirroring
 * dispatcher.refreshIdle EXACTLY (minus the setIdle side-effect). The log is the launcher's
 * logFile (workspaceDir/agent.log). Returns null when idle detection is off (idleMs<=0) OR the
 * log is missing — a missing log means the agent is still spinning up, which the caller treats
 * as NOT idle so a just-launched agent is never probed/keystroked.
 */
function workspaceQuietMs(id: string): number | null {
  if (config.idleMs <= 0) return null;
  try {
    return Date.now() - statSync(join(workspaceDir(id), "agent.log")).mtimeMs;
  } catch {
    return null; // no log yet — agent is still spinning up
  }
}

/** Injectable seams for the operator mid-session probe (the harness/DB in production; fakes in tests). */
export type WorkspaceProbeDeps = {
  /** Read the agent's live pane (ANSI-stripped). */
  read: (name: string) => Promise<string>;
  /** Push a confirming input to the agent's pane. */
  send: (name: string, input: SendInput) => Promise<void>;
  /**
   * Is the agent GENUINELY IDLE (agent.log quiet past idleMs)? The probe takes NO action — no
   * read, no signal, no keystroke — unless this is true, so an actively-working operator (still
   * producing output) is left completely alone and benign active-turn text can never be
   * mis-detected as a blocking dialog.
   */
  idle: () => boolean;
  /** The workspace row's current last_error (the attention-signal store). */
  getError: (id: string) => string | null;
  /** Persist (or clear, with null) the workspace row's last_error. */
  setError: (id: string, msg: string | null) => void;
  /** Extra/overriding rule table (defaults to STARTUP_CONFIRM_RULES). */
  rules?: ConfirmRule[];
  /** Optional diagnostics sink. */
  log?: (msg: string) => void;
};

/**
 * MID-SESSION SAFETY NET — one pane-CONTENT probe for a single LIVE operator workspace, the
 * counterpart to launch/adopt auto-confirm for prompts that appear AFTER startup. Mirrors
 * dispatcher.probeAgentForPrompt: reads the live pane once and classifies it via the SAME
 * three-way classifier as the launch path:
 *   - `rule`  → a known prompt we can auto-confirm: send the safe response and CLEAR any prior
 *               (probe-set) attention signal — we are handling it, so the user no longer needs to;
 *   - `stuck` → an unrecognized but prompt-like pane → SURFACE it: persist a truncated snapshot
 *               to the row's last_error (sentinel-prefixed) + console.warn, send nothing;
 *   - `quiet` → past any prompt → CLEAR any prior (probe-set) attention signal (self-clearing).
 *
 * GENUINE-IDLE GATE: the WHOLE probe is a no-op unless `deps.idle()`. An actively-working agent
 * (log fresh, mid-turn) is left completely untouched — no pane read, no signal, no keystroke.
 * SELF-CLEAR SCOPE: clears last_error ONLY when it currently holds a probe-written signal
 * (WORKSPACE_STUCK_PREFIX), so a genuine launch/relaunch error is never clobbered.
 * BEST-EFFORT: a read failure does nothing; a send failure is swallowed — this must NEVER throw
 * or disrupt supervision. Exported so the probe is unit-testable without the supervise loop.
 */
export async function probeWorkspaceForPrompt(
  id: string,
  name: string,
  deps: WorkspaceProbeDeps,
): Promise<void> {
  // GENUINE-IDLE GATE: leave an active agent completely alone (no read/signal/keystroke).
  if (!deps.idle()) return;
  let screen = "";
  try {
    screen = await deps.read(name);
  } catch {
    return; // best-effort: a pane we cannot read tells us nothing — leave state as-is
  }
  const cls = classifyStartupScreen(screen, deps.rules);

  // Clear ONLY a signal THIS probe set (sentinel-prefixed) — never a genuine launch error.
  const clearOwnSignal = () => {
    const cur = deps.getError(id);
    if (cur && cur.startsWith(WORKSPACE_STUCK_PREFIX)) deps.setError(id, null);
  };

  if (cls.kind === "rule") {
    try {
      await deps.send(name, cls.rule.response);
      deps.log?.(`auto-confirmed mid-session prompt '${cls.rule.name}'`);
    } catch {
      /* best-effort — a send to a dead pane is a no-op */
    }
    // We can handle this prompt ourselves → clear any prior unrecognized-prompt signal.
    clearOwnSignal();
    return;
  }

  if (cls.kind === "stuck") {
    // An unhandled blocking prompt appeared mid-session: SURFACE it (operator workspaces have no
    // needs_user_input flag — the row's last_error is the attention signal). Idempotent re-set.
    deps.setError(id, WORKSPACE_STUCK_PREFIX + stuckSnapshot(screen));
    deps.log?.("mid-session prompt not auto-confirmable — surfaced via last_error");
    return;
  }

  // cls.kind === "quiet" | "active": past any prompt (blank/initializing, or a live working
  // session) → clear any prior (probe-set) signal.
  clearOwnSignal();
}

/**
 * The supervise-tick wiring for `probeWorkspaceForPrompt`: build the production deps (live pane
 * read/send via the harness, last_error get/set via the workspace row) and run one probe. Kept
 * thin + best-effort so superviseWorkspace can call it without risk (it never throws). The
 * genuine-idle gate reads the agent.log mtime (workspaceQuietMs) through dispatcher.isGenuinelyIdle.
 */
export function probeWorkspaceMidSession(id: string, name: string): Promise<void> {
  return probeWorkspaceForPrompt(id, name, {
    read: (n) => harness.agentRead(n),
    send: (n, input) => harness.send(n, input),
    idle: () => isGenuinelyIdle(workspaceQuietMs(id)),
    getError: (wid) => getWorkspaceAgentRow(wid)?.last_error ?? null,
    setError: (wid, msg) => saveWorkspaceAgentRow(wid, { last_error: msg }),
    log: (m) => console.warn(`[butchr] workspace ${id}: ${m}`),
  }).catch(() => {});
}

// One supervision tick over ALL workspaces (mirrors cto-agent.superviseTick). Gated OFF →
// a no-op (nothing is supervised). Each desired-up-but-dead workspace is relaunched
// (RESUMING the same session) with bounded per-workspace exponential backoff.
async function superviseTick(): Promise<void> {
  if (!isUnifiedWorkspaceEnabled()) return;
  for (const row of listWorkspaceAgentRows()) {
    await superviseWorkspace(row.id);
  }
}

async function superviseWorkspace(id: string): Promise<void> {
  if (!isUnifiedWorkspaceEnabled()) return;
  const row = getWorkspaceAgentRow(id);
  if (!row || row.desired !== 1) return; // wanted down (or gone)
  // A DISABLED CTO is never relaunched — short-circuit BEFORE the dead-while-desired relaunch/
  // backoff branch below (mirrors cto-agent.superviseWorkspace's top `if (!isCtoEnabled) return`).
  // A stray desired=1 ws-cto row whose directory has cto_enabled effectively false thus never
  // triggers a launch attempt. ADDED ALONGSIDE existing gates; touches no other kind.
  if (row.kind === "cto" && !isCtoEnabled(row.directory_id ?? "")) return;
  const st = supState(id);
  if (st.launchInFlight) return; // a start/stop/restart is mid-flight — don't race it

  const name = workspaceAgentName(row);
  if (await harness.agentExists(name).catch(() => false)) {
    if (st.consecutiveFailures !== 0) {
      st.consecutiveFailures = 0; // healthy → reset backoff
      st.nextRetryAt = 0;
    }
    // Healthy again → drop any durable give-up marker (st-a4cc6082). Guarded on the current
    // row so a normally-live agent does NOT write every supervise tick.
    if (row.gave_up === 1) saveWorkspaceAgentRow(id, { gave_up: 0 });
    // MID-SESSION SAFETY NET: the agent is registered/live (a parked-at-dialog agent IS live),
    // so additionally read its pane on a THROTTLED cadence to auto-confirm / surface a blocking
    // prompt it hit after startup. Operator kinds only; genuine-idle gated inside the probe so an
    // actively-working agent is never read/keystroked. Awaited (best-effort, never throws) so a
    // single supervise tick drives one probe deterministically.
    if (row.kind === "cto" || row.kind === "leader") {
      st.superviseTicks++;
      if (shouldProbeTick(st.superviseTicks, config.ctoMidProbeEverySupervisions)) {
        await probeWorkspaceMidSession(id, name);
      }
    }
    return;
  }

  // A LEADER whose node-Work is already TERMINAL must NEVER be relaunched (mirror
  // reconcileWorkspaceAgent's terminal-leader gate + the legacy superviseStory). The
  // completion-teardown may have raced or been missed, leaving a stray desired=1; correct it
  // authoritatively. Placed ABOVE the backoff/restart-budget lines so a terminal leader never
  // burns restart-budget nor logs a false "died — relaunching". launchInFlight is null here
  // (checked above), so stopWorkspaceAgent runs its full desired-down + teardown body.
  if (row.kind === "leader" && nodeWorkIsTerminal(row.work_id)) {
    await stopWorkspaceAgent(id);
    return;
  }

  // Dead while DESIRED up → relaunch with backoff.
  if (st.consecutiveFailures >= config.ctoMaxRestarts) {
    // Gave up — await operator. Persist the durable marker so the dashboard can pull-surface
    // this stranded work (st-a4cc6082); idempotent so we don't write every parked tick.
    if (row.gave_up !== 1) saveWorkspaceAgentRow(id, { gave_up: 1 });
    return;
  }
  const now = Date.now();
  if (now < st.nextRetryAt) return; // still backing off
  st.consecutiveFailures++;
  const delay = Math.min(
    config.ctoRestartBackoffBaseMs * 2 ** (st.consecutiveFailures - 1),
    config.ctoRestartBackoffCapMs,
  );
  st.nextRetryAt = now + delay;
  console.warn(
    `[butchr] ${row.kind} workspace ${id} died — relaunching ` +
      `(attempt ${st.consecutiveFailures}/${config.ctoMaxRestarts}, resuming session)`,
  );
  await guarded(id, async () => {
    const before = getWorkspaceAgentRow(id)?.restarts ?? 0;
    await launcher.launch(getWorkspaceAgentRow(id)!, false); // resume — never cold-start
    // STOP-WINS / terminal re-check: a stop (or a done/aborted transition) that raced this slow
    // relaunch must win — do NOT let launcher.launch's desired=1 resurrect a terminal/stopped
    // leader. The relaunch path itself never clears stopRequested (an in-flight stop must win).
    if (await reassertStopAfterLaunch(id)) return workspaceAgentStatus(id);
    // Successful supervised relaunch → clear any durable give-up marker (st-a4cc6082).
    const cleared = getWorkspaceAgentRow(id)?.gave_up === 1 ? { gave_up: 0 } : {};
    saveWorkspaceAgentRow(id, { restarts: before + 1, ...cleared });
    return workspaceAgentStatus(id);
  }).catch((e) => {
    const msg = (e as Error).message;
    // A relaunch attempt that fails AT/OVER the cap is the give-up point (the top-of-loop
    // short-circuit only fires on the NEXT tick): persist the durable marker in the SAME
    // write as last_error (st-a4cc6082).
    const giveUp = st.consecutiveFailures >= config.ctoMaxRestarts;
    saveWorkspaceAgentRow(id, giveUp ? { last_error: msg, gave_up: 1 } : { last_error: msg });
    console.error(`[butchr] workspace relaunch failed for ${id}: ${msg}`);
  });
}

/** Start the unified-workspace supervisor poll loop. No-op when gated OFF or already running. */
export function startWorkspaceAgentSupervisor(): void {
  if (superviseTimer || !isUnifiedWorkspaceEnabled()) return;
  superviseTimer = setInterval(() => void superviseTick(), config.ctoSuperviseMs);
}

/** Stop the supervisor loop (clean shutdown). Does NOT kill live agents — their panes survive. */
export function stopWorkspaceAgentSupervisor(): void {
  if (superviseTimer) clearInterval(superviseTimer);
  superviseTimer = null;
}

/** Test-only: run a single supervision tick for ONE workspace synchronously. */
export async function _superviseTickForTest(id: string): Promise<void> {
  await superviseWorkspace(id);
}

/** Test-only: reset the in-memory backoff state (one workspace, or all). */
export function _resetSupervisionStateForTest(id?: string): void {
  if (id) supStates.delete(id);
  else supStates.clear();
}
