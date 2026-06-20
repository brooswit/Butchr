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
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
import { ensureHerdrWorkspace } from "./workspaces.ts";
import { isCtoEnabled } from "./cto-agent.ts";
import { buildScriptArgv, modelFlag } from "./exec.ts";
import { harness } from "./harness.ts";
import { startAgentInFreshTab } from "./herdr.ts";
import { claudeLiveness } from "./liveness.ts";
import { autoConfirmStartupPrompts } from "./startup-confirm.ts";
import type { AutoConfirmResult } from "./startup-confirm.ts";

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
};

// ---- supervision state (in-memory, PER WORKSPACE ROW) ---------------------
// Mirrors cto-agent's wsStates / story-agent's storyStates, keyed by the workspace id.
type SupState = {
  launchInFlight: Promise<WorkspaceAgentStatus> | null;
  consecutiveFailures: number;
  nextRetryAt: number;
};
const supStates = new Map<string, SupState>();
function supState(id: string): SupState {
  let s = supStates.get(id);
  if (!s) {
    s = { launchInFlight: null, consecutiveFailures: 0, nextRetryAt: 0 };
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

    await autoConfirmWorkspaceStartup(name);
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
        await autoConfirmWorkspaceStartup(name).catch(() => {});
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
    saveWorkspaceAgentRow(row.id, { desired: 1 });
    const st = supState(row.id);
    st.consecutiveFailures = 0;
    st.nextRetryAt = 0;
    action = await adoptOrLaunch(row, fresh);
    if (action === "launched") saveWorkspaceAgentRow(row.id, { restarts: 0 });
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
  return guarded(id, async () => {
    const row = getWorkspaceAgentRow(id);
    if (row) saveWorkspaceAgentRow(id, { desired: 0, has_agent: 0, started_at: null });
    const st = supState(id);
    st.consecutiveFailures = 0;
    st.nextRetryAt = 0;
    if (row) await launcher.teardown(workspaceAgentName(row));
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
    return;
  }

  // Dead while DESIRED up → relaunch with backoff.
  if (st.consecutiveFailures >= config.ctoMaxRestarts) return; // gave up — await operator
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
    saveWorkspaceAgentRow(id, { restarts: before + 1 });
    return workspaceAgentStatus(id);
  }).catch((e) => {
    const msg = (e as Error).message;
    saveWorkspaceAgentRow(id, { last_error: msg });
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
