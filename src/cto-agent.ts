// MANAGED CTO AGENT (PER-DIRECTORY). butchr LAUNCHES and SUPERVISES one long-lived
// CTO agent PER REGISTERED DIRECTORY (repo). Each runs in that repo's ROOT and IS the
// principal/dev agent for that project — a first-class, channel-connected Claude Code
// session, just like the per-task workspace agents, but with NO worktree/branch/
// review/merge. It is the operator's hands FOR THAT REPO: on each
// <butchr-cto-channel> push (a spec/diff/question/failure for ONE of that directory's
// tasks) it acts via the butchr API (127.0.0.1:47800) or `bin/butchr`
// (approve/reject/answer/requeue); it does NOT edit that repo's code directly (all
// code changes go through tasks). There is NO global/top-level CTO — butchr manages
// one CTO agent per directory, keyed by directory_id.
//
// This module owns each per-directory agent's LIFECYCLE, the same way the dispatcher
// owns a task agent's:
//   - LAUNCH through the EXISTING AgentRunner/harness seam (src/harness.ts) into a
//     dedicated herdr tab IN THAT DIRECTORY'S WORKSPACE, with cwd = the directory's
//     repo root (directory.path), wired to the one-way CTO notification channel
//     (src/channel.ts) SCOPED to the directory (BUTCHR_CHANNEL_DIR) via a generated
//     MCP config + the research-preview `--dangerously-load-development-channels
//     server:butchr-cto-channel` flag — so it receives only THAT directory's events.
//   - SINGLE INSTANCE PER DIRECTORY: at most one CTO agent is alive per directory. A
//     start when one is already registered ADOPTS it instead of double-launching.
//   - LAUNCH SELF-COMPLETE: every (re)launch AUTO-CLEARS any blocking interactive
//     startup prompt (dev-channels consent / folder-trust / any yes-no or numbered
//     confirmation) via the harness `send` capability with bounded poll/retry, so the
//     agent comes up READY unattended on every (re)launch/reboot (src/startup-confirm.ts).
//   - SESSION CONTINUITY: every supervised relaunch — after a crash, on boot-adopt,
//     across a butchr restart — RESUMES the SAME Claude session via `--resume <id>`
//     (never `--continue`), so the CTO keeps full context and never cold-starts. The
//     FIRST launch resumes a per-directory operator-seeded session
//     (config.ctoAgentSessionSeeds[directoryId]) when set, else starts fresh and
//     captures the new id. A brand-new session happens ONLY via restart(fresh).
//   - SUPERVISION: a single poll loop relaunches each desired-up-but-dead agent with
//     bounded per-directory exponential backoff, giving up after a cap until the
//     operator intervenes.
//
// Context hygiene (a CTO session is INDEFINITE): prefer sending `/compact` to the
// LIVE agent via the harness `send` capability when the session grows, with a
// forced-fresh restart as the last resort.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHANNEL_SERVER_NAME } from "./channel.ts";
import { config } from "./config.ts";
import {
  type CtoAgentRow,
  db,
  getCtoAgentRow,
  listCtoAgentRows,
  nowIso,
  saveCtoAgentRow,
} from "./db.ts";
import { ensureDirectoryWorkspace } from "./directories.ts";
import { publish } from "./events.ts";
import { buildScriptArgv, modelFlag } from "./exec.ts";
import { harness } from "./harness.ts";
import { startAgentInFreshTab } from "./herdr.ts";
import { autoConfirmStartupPrompts } from "./startup-confirm.ts";

// butchr's own state dir for the CTO agents' generated artifacts (never the repo).
// One subdirectory per directory so per-directory MCP configs + logs never collide.
function ctoDir(directoryId: string): string {
  return join(config.dataDir, "cto", directoryId);
}
function mcpConfigFile(directoryId: string): string {
  return join(ctoDir(directoryId), "mcp.json");
}
function logFile(directoryId: string): string {
  return join(ctoDir(directoryId), "agent.log");
}

/** The herdr agent name for a directory's CTO agent: `<prefix>-<directoryId>`. */
export function ctoAgentName(directoryId: string): string {
  return `${config.ctoAgentName}-${directoryId}`;
}

/** A registered directory's repo-root path (the CTO agent's cwd), or null if gone. */
function directoryPath(directoryId: string): string | null {
  const row = db
    .query<{ path: string }, [string]>(`SELECT path FROM directories WHERE id=?`)
    .get(directoryId);
  return row?.path ?? null;
}

/**
 * Is a directory's CTO agent ENABLED for boot auto-start + supervision? The
 * directory's own `cto_enabled` column WINS (1 → on, 0 → off); NULL inherits the
 * GLOBAL default config.ctoAgentEnabled (itself default OFF). An unknown directory →
 * not enabled. Exported for testing.
 */
export function isCtoEnabled(directoryId: string): boolean {
  const row = db
    .query<{ cto_enabled: number | null }, [string]>(
      `SELECT cto_enabled FROM directories WHERE id=?`,
    )
    .get(directoryId);
  if (!row) return false;
  if (row.cto_enabled !== null) return row.cto_enabled === 1;
  return config.ctoAgentEnabled;
}

/** The dashboard/API view of a directory's managed CTO agent state. */
export type CtoStatus = {
  /** The directory this CTO agent belongs to. */
  directoryId: string;
  /** Per-directory enable (cto_enabled, or the global default) — boot auto-start +
   *  supervision are active when true. */
  enabled: boolean;
  /** The operator/boot WANTS it up (supervisor relaunches on death). */
  desired: boolean;
  /** A live herdr agent is registered under this directory's CTO name (async-probed). */
  running: boolean;
  /** The current herdr pane backing it (for the 'Open CTO terminal' attach). */
  paneId: string | null;
  tabId: string | null;
  /** The Claude session id butchr resumes on every relaunch. */
  sessionId: string | null;
  /** When the current run was (re)launched. */
  since: string | null;
  /** Supervised relaunches since the last fresh start. */
  restarts: number;
  /** Most recent launch/supervision failure, if any. */
  lastError: string | null;
};

// ---- supervision state (in-memory, PER DIRECTORY) -------------------------
// A start/stop/restart in flight per directory, plus that directory's backoff
// counters. Keyed by directory_id so lifecycle ops on different directories never
// block each other, while ops on the SAME directory serialize (the single-instance
// guard). `consecutiveFailures` drives exponential backoff; `nextRetryAt` gates it.
type DirState = {
  launchInFlight: Promise<CtoStatus> | null;
  consecutiveFailures: number;
  nextRetryAt: number;
};
const dirStates = new Map<string, DirState>();
function dirState(directoryId: string): DirState {
  let s = dirStates.get(directoryId);
  if (!s) {
    s = { launchInFlight: null, consecutiveFailures: 0, nextRetryAt: 0 };
    dirStates.set(directoryId, s);
  }
  return s;
}

let superviseTimer: ReturnType<typeof setInterval> | null = null;

// ---- default editable brief -------------------------------------------------
const DEFAULT_BRIEF = `# butchr CTO agent

You are the **butchr CTO** for THIS repository — a persistent, butchr-managed Claude
Code session that runs in this repo's root and operates the butchr task pipeline for
this project on the operator's behalf. You were launched and are supervised by butchr
itself, and you keep full context across relaunches (butchr \`--resume\`s your session).

## How you receive work

You are wired to the **one-way CTO notification channel** (\`<${CHANNEL_SERVER_NAME}>\`),
SCOPED to this repository. Each event is one of THIS directory's tasks that just
ENTERED a state needing your attention:

- **spec_review** — a generated spec is awaiting approval.
- **in_review** — a diff is awaiting review.
- **needs_info** — an agent asked a question awaiting an answer.
- **aborted** — a task failed.

The channel is PUSH-ONLY: you cannot reply through it. Act through the normal butchr
surfaces instead.

## How you act

Use the butchr HTTP API at \`http://127.0.0.1:47800\` or the \`bin/butchr\` CLI to
approve / reject / answer / requeue, e.g.:

- review the spec/diff/question for the task id in the event,
- then \`POST /api/tasks/<id>/approve\`, \`/reject\`, \`/answer\`, or \`/requeue\`
  (or the equivalent \`bin/butchr\` command).

## Hard rules

- **Do NOT edit this repository's code directly.** All code changes go through tasks
  (create an idea/task via the API and let a build agent do it under review).
- You have no worktree, branch, review, or merge of your own — you are an operator,
  not a builder.
- Keep your own context lean: when this session grows large, run \`/compact\`.
`;

/**
 * Resolve the editable CTO brief file. Uses config.ctoBriefPath when it points at a
 * readable file; otherwise writes the documented default to <dataDir>/cto-brief.md
 * (once) and returns that, so an operator can edit the brief in place. Shared across
 * directories (each per-repo CTO is primed by the same brief).
 */
export function resolveBriefFile(): string {
  const configured = config.ctoBriefPath.trim();
  if (configured && existsSync(configured)) return configured;
  const fallback = join(config.dataDir, "cto-brief.md");
  if (!existsSync(fallback)) {
    mkdirSync(config.dataDir, { recursive: true });
    writeFileSync(fallback, DEFAULT_BRIEF, "utf8");
  }
  return fallback;
}

/**
 * Write a directory's CTO agent MCP config: a single STDIO server named
 * `butchr-cto-channel` that runs the one-way channel bridge (config.ctoChannelCmd)
 * via `bash -lc`, with the SSE URL pointed at this butchr and SCOPED to the directory
 * via BUTCHR_CHANNEL_DIR (so it pushes only that directory's events). The agent loads
 * it as a development channel through `server:butchr-cto-channel` in config.ctoAgentCmd.
 * Returns the config path.
 */
export function writeChannelMcpConfig(directoryId: string): string {
  mkdirSync(ctoDir(directoryId), { recursive: true });
  const cfg = {
    mcpServers: {
      [CHANNEL_SERVER_NAME]: {
        command: "bash",
        args: ["-lc", config.ctoChannelCmd],
        env: {
          BUTCHR_CHANNEL_SSE_URL: `http://${config.loopbackHost}:${config.port}/api/events`,
          BUTCHR_CHANNEL_DIR: directoryId,
        },
      },
    },
  };
  const file = mcpConfigFile(directoryId);
  writeFileSync(file, JSON.stringify(cfg), "utf8");
  return file;
}

/**
 * Decide the session id + flag for a directory's launch. FRESH → a brand-new
 * `--session-id`. Otherwise RESUME, preferring (in order) the persisted active
 * session, then the per-directory operator-seeded session
 * (config.ctoAgentSessionSeeds[directoryId], first-launch continuity), else a fresh
 * id. Pure + exported for testing.
 */
export function resolveCtoSession(
  directoryId: string,
  row: CtoAgentRow | null,
  fresh: boolean,
): { sessionId: string; isResume: boolean } {
  if (fresh) return { sessionId: crypto.randomUUID(), isResume: false };
  const persisted = row?.session_id?.trim();
  if (persisted) return { sessionId: persisted, isResume: true };
  const seed = config.ctoAgentSessionSeeds.get(directoryId)?.trim();
  if (seed) return { sessionId: seed, isResume: true };
  return { sessionId: crypto.randomUUID(), isResume: false };
}

/** Build the fully-substituted, `script`-wrapped launch argv. Exported for testing. */
export function buildCtoArgv(sessionFlag: string, directoryId: string): string[] {
  const agentCmd = config.ctoAgentCmd
    .replaceAll("{{MODEL_FLAG}}", modelFlag(config.ctoAgentModel))
    .replaceAll("{{SESSION_FLAG}}", sessionFlag)
    .replaceAll("{{MCP_CONFIG}}", mcpConfigFile(directoryId))
    .replaceAll("{{PROMPT_FILE}}", resolveBriefFile());
  // Run under `script` (PTY → the interactive UI renders + input works in the herdr
  // pane) while logging to a file — exactly how the dispatcher launches task agents.
  return buildScriptArgv({ agentCmd, logFile: logFile(directoryId) });
}

/**
 * Heal/use the directory's herdr workspace (the CTO tab lives in the SAME workspace
 * as the directory's task agents — one workspace per directory). Reuses the
 * directory's recorded workspace when it still exists; otherwise recreates one at the
 * repo root and persists it on the directory row. Returns the workspace id.
 */
async function ensureCtoWorkspace(directoryId: string, cwd: string): Promise<string | undefined> {
  const { workspaceId } = await ensureDirectoryWorkspace(
    directoryId,
    cwd,
    `butchr-cto-${directoryId}`,
  );
  return workspaceId;
}

/**
 * The actual launch for a directory: write the scoped channel MCP config + brief,
 * build the argv (resuming the right session), create a dedicated tab in the
 * directory's workspace, start the agent with cwd = the repo root, close the husk root
 * pane, re-resolve the real pane (surviving herdr's positional renumber), persist the
 * session/pane/tab, and AUTO-CONFIRM any blocking startup prompt. Throws if the agent
 * never registers a live pane, or the directory is gone. NOT guarded — callers go
 * through startCtoAgent / superviseTick (which hold the per-directory launchInFlight).
 */
async function performLaunch(directoryId: string, fresh: boolean): Promise<void> {
  const cwd = directoryPath(directoryId);
  if (!cwd) throw new Error(`directory ${directoryId} is no longer registered`);

  const name = ctoAgentName(directoryId);
  const { sessionId, isResume } = resolveCtoSession(directoryId, getCtoAgentRow(directoryId), fresh);
  const sessionFlag = isResume ? `--resume ${sessionId}` : `--session-id ${sessionId}`;
  writeChannelMcpConfig(directoryId);
  const argv = buildCtoArgv(sessionFlag, directoryId);

  const workspaceId = await ensureCtoWorkspace(directoryId, cwd);
  rmSync(logFile(directoryId), { force: true });

  // Create a dedicated tab, start the agent in it (self-healing a name collision),
  // close the husk root pane, and re-resolve the agent's real pane surviving herdr's
  // positional renumber — the same sequence the dispatcher runs (it wraps this in its
  // per-workspace pane lock; the single-instance CTO launch needs no such lock).
  const { paneId, tabId } = await startAgentInFreshTab(harness, {
    name,
    cwd,
    argv,
    workspaceId: workspaceId ?? undefined,
    label: `butchr-cto-${directoryId}`,
    paneError: "CTO agent did not register a live pane after start",
  });

  saveCtoAgentRow(directoryId, {
    session_id: sessionId,
    herdr_pane_id: paneId,
    herdr_tab_id: tabId ?? null,
    herdr_workspace: workspaceId ?? null,
    desired: 1,
    started_at: nowIso(),
    last_error: null,
  });
  console.log(
    `[butchr] launched CTO agent for ${directoryId} (${isResume ? `--resume ${sessionId}` : `fresh session ${sessionId}`}, pane ${paneId})`,
  );

  // LAUNCH SELF-COMPLETE: clear any blocking interactive startup prompt so the agent
  // comes up READY unattended. Best-effort + bounded — never fails the launch.
  await autoConfirmStartupPrompts(name, {
    read: (n) => harness.agentRead(n),
    send: (n, input) => harness.send(n, input),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    pollMs: config.ctoPromptPollMs,
    maxPolls: config.ctoPromptMaxPolls,
    quietPolls: config.ctoPromptQuietPolls,
    log: (m) => console.log(`[butchr] CTO ${directoryId}: ${m}`),
  }).catch(() => {});
}

/** Adopt an already-live CTO agent for a directory (re-record its pane/tab; no relaunch). */
async function adoptCtoAgent(directoryId: string): Promise<void> {
  const name = ctoAgentName(directoryId);
  const row = getCtoAgentRow(directoryId);
  const paneId = (await harness.agentPaneId(name)) ?? row?.herdr_pane_id ?? null;
  const tabId = (await harness.agentTabId(name)) ?? row?.herdr_tab_id ?? null;
  saveCtoAgentRow(directoryId, {
    herdr_pane_id: paneId,
    herdr_tab_id: tabId,
    desired: 1,
    started_at: row?.started_at ?? nowIso(),
    last_error: null,
  });
  console.log(`[butchr] adopted live CTO agent for ${directoryId} (pane ${paneId})`);
}

/** Serialize a lifecycle op for a directory behind its launchInFlight (single-instance). */
function guarded(directoryId: string, fn: () => Promise<CtoStatus>): Promise<CtoStatus> {
  const st = dirState(directoryId);
  if (st.launchInFlight) return st.launchInFlight;
  const p = fn().finally(() => {
    if (st.launchInFlight === p) st.launchInFlight = null;
  });
  st.launchInFlight = p;
  return p;
}

/** Compute a directory's status and publish a `cto.updated` event; returns the status. */
async function publishStatus(directoryId: string): Promise<CtoStatus> {
  const s = await ctoAgentStatus(directoryId);
  publish({ type: "cto.updated", cto: s });
  return s;
}

/**
 * START (or adopt) a directory's CTO agent. Marks it DESIRED-up (so the supervisor
 * keeps it alive), then: if a live agent is already registered (and not a fresh start)
 * it ADOPTS rather than double-launching (single-instance per directory); otherwise it
 * launches — RESUMING the persisted/seeded session unless `fresh`, which forces a
 * brand-new one. A manual start resets that directory's supervised-restart counter.
 */
export function startCtoAgent(directoryId: string, opts: { fresh?: boolean } = {}): Promise<CtoStatus> {
  return guarded(directoryId, async () => {
    saveCtoAgentRow(directoryId, { desired: 1 });
    const st = dirState(directoryId);
    st.consecutiveFailures = 0;
    st.nextRetryAt = 0;
    if (!opts.fresh && (await harness.agentExists(ctoAgentName(directoryId)))) {
      await adoptCtoAgent(directoryId);
    } else {
      await performLaunch(directoryId, !!opts.fresh);
      saveCtoAgentRow(directoryId, { restarts: 0 }); // a manual (re)launch resets the counter
    }
    return publishStatus(directoryId);
  });
}

/**
 * STOP a directory's CTO agent: mark it DESIRED-down (the supervisor leaves it down,
 * and this survives a restart) and tear down its tab/pane + free its agent name.
 * Idempotent.
 */
export function stopCtoAgent(directoryId: string): Promise<CtoStatus> {
  return guarded(directoryId, async () => {
    saveCtoAgentRow(directoryId, { desired: 0 });
    const st = dirState(directoryId);
    st.consecutiveFailures = 0;
    st.nextRetryAt = 0;
    const name = ctoAgentName(directoryId);
    const row = getCtoAgentRow(directoryId);
    await harness
      .teardownTask(row?.herdr_tab_id, name, row?.herdr_pane_id)
      .catch(() => {});
    await harness.agentDeregister(name).catch(() => {});
    saveCtoAgentRow(directoryId, { herdr_pane_id: null, herdr_tab_id: null, started_at: null });
    console.log(`[butchr] stopped CTO agent for ${directoryId}`);
    return publishStatus(directoryId);
  });
}

/**
 * RESTART a directory's CTO agent. By default it RESUMES the same session (a clean
 * bounce); `fresh` forces a brand-new session — the ONLY way to cold-start (e.g.
 * last-resort context hygiene when the session has grown unmanageable).
 */
export async function restartCtoAgent(
  directoryId: string,
  opts: { fresh?: boolean } = {},
): Promise<CtoStatus> {
  await stopCtoAgent(directoryId);
  return startCtoAgent(directoryId, { fresh: opts.fresh });
}

/** A directory's current managed-CTO-agent status (probes herdr for live registration). */
export async function ctoAgentStatus(directoryId: string): Promise<CtoStatus> {
  const row = getCtoAgentRow(directoryId);
  const running = await harness.agentExists(ctoAgentName(directoryId)).catch(() => false);
  return {
    directoryId,
    enabled: isCtoEnabled(directoryId),
    desired: !!(row && row.desired === 1),
    running,
    paneId: row?.herdr_pane_id ?? null,
    tabId: row?.herdr_tab_id ?? null,
    sessionId: row?.session_id ?? null,
    since: row?.started_at ?? null,
    restarts: row?.restarts ?? 0,
    lastError: row?.last_error ?? null,
  };
}

/** Reconcile ONE directory's CTO agent toward its desired state (see reconcileCtoAgents). */
export async function reconcileCtoAgent(
  directoryId: string,
  herdrUp: boolean,
): Promise<{ action: "disabled" | "skipped" | "stopped" | "adopted" | "launched" }> {
  if (!isCtoEnabled(directoryId)) return { action: "disabled" };
  if (!herdrUp) return { action: "skipped" };
  const name = ctoAgentName(directoryId);
  const row = getCtoAgentRow(directoryId);
  if (row && row.desired === 0 && row.updated_at) {
    // The operator stopped it before this restart — honor that.
    return { action: "stopped" };
  }
  if (await harness.agentExists(name)) {
    await adoptCtoAgent(directoryId);
    await publishStatus(directoryId);
    return { action: "adopted" };
  }
  await startCtoAgent(directoryId);
  return { action: "launched" };
}

/**
 * BOOT RECONCILE: bring EVERY enabled directory's CTO agent into its desired state
 * once, before the supervisor starts (see index.ts). With herdr down we cannot probe
 * liveness, so we defer to the supervisor. Returns aggregate counts.
 */
export async function reconcileCtoAgents(
  herdrUp: boolean,
): Promise<{ adopted: number; launched: number; skipped: number }> {
  let adopted = 0;
  let launched = 0;
  let skipped = 0;
  // Every registered directory is a candidate (enable is resolved per-directory inside
  // reconcileCtoAgent — honoring the global default for directories with no override).
  const dirs = db.query<{ id: string }, []>(`SELECT id FROM directories`).all();
  for (const d of dirs) {
    try {
      const res = await reconcileCtoAgent(d.id, herdrUp);
      if (res.action === "adopted") adopted++;
      else if (res.action === "launched") launched++;
      else if (res.action === "skipped") skipped++;
    } catch (e) {
      saveCtoAgentRow(d.id, { last_error: (e as Error).message });
      console.error(`[butchr] CTO agent reconcile failed for ${d.id}: ${(e as Error).message}`);
    }
  }
  return { adopted, launched, skipped };
}

// One supervision tick over ALL directories: for each CTO agent that is DESIRED-up but
// whose herdr agent has died, relaunch it (RESUMING the same session) with bounded
// per-directory exponential backoff, giving up after config.ctoMaxRestarts consecutive
// failures until the operator intervenes.
async function superviseTick(): Promise<void> {
  for (const row of listCtoAgentRows()) {
    await superviseDirectory(row.directory_id);
  }
}

async function superviseDirectory(directoryId: string): Promise<void> {
  if (!isCtoEnabled(directoryId)) return;
  const st = dirState(directoryId);
  if (st.launchInFlight) return; // a start/stop/restart is mid-flight — don't race it
  const row = getCtoAgentRow(directoryId);
  if (!row || row.desired !== 1) return; // operator wants it down (or never started)

  const name = ctoAgentName(directoryId);
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
    `[butchr] CTO agent for ${directoryId} died — relaunching (attempt ${st.consecutiveFailures}/${config.ctoMaxRestarts}, resuming session)`,
  );
  await guarded(directoryId, async () => {
    const before = getCtoAgentRow(directoryId)?.restarts ?? 0;
    await performLaunch(directoryId, false); // resume the SAME session — never cold-start
    saveCtoAgentRow(directoryId, { restarts: before + 1 });
    return publishStatus(directoryId);
  }).catch(async (e) => {
    const msg = (e as Error).message;
    saveCtoAgentRow(directoryId, { last_error: msg });
    console.error(`[butchr] CTO agent relaunch failed for ${directoryId}: ${msg}`);
    if (st.consecutiveFailures >= config.ctoMaxRestarts) {
      console.error(
        `[butchr] CTO agent for ${directoryId} gave up after ${config.ctoMaxRestarts} relaunch attempts — start/restart it from the dashboard`,
      );
    }
    await publishStatus(directoryId).catch(() => {});
  });
}

/** Start the CTO-agent supervisor poll loop (no-op if already running). */
export function startCtoSupervisor(): void {
  if (superviseTimer) return;
  superviseTimer = setInterval(() => void superviseTick(), config.ctoSuperviseMs);
}

/** Stop the supervisor loop (clean shutdown). Does NOT kill the live agents — their
 *  panes survive so the next boot can ADOPT and resume them, like workspace agents. */
export function stopCtoSupervisor(): void {
  if (superviseTimer) clearInterval(superviseTimer);
  superviseTimer = null;
}

/** Test-only: run a single supervision tick (one directory) synchronously. */
export async function _superviseTickForTest(directoryId: string): Promise<void> {
  await superviseDirectory(directoryId);
}

/** Test-only: reset the in-memory backoff state for a directory between cases. */
export function _resetSupervisionStateForTest(directoryId?: string): void {
  if (directoryId) {
    dirStates.delete(directoryId);
  } else {
    dirStates.clear();
  }
}
