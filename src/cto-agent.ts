// MANAGED CTO AGENT. butchr LAUNCHES and SUPERVISES a single, long-lived CTO agent —
// a first-class, channel-connected Claude Code session, just like the per-task
// workspace agents — but with NO worktree/branch/review/merge. It is the operator's
// hands: on each <butchr-cto-channel> push (a spec/diff/question/failure needing
// attention) it acts via the butchr API (127.0.0.1:47800) or `bin/butchr`
// (approve/reject/answer/requeue); it does NOT edit the butchr codebase directly
// (all code changes go through tasks).
//
// This module owns its LIFECYCLE, the same way the dispatcher owns a task agent's:
//   - LAUNCH through the EXISTING AgentRunner/harness seam (src/harness.ts) into a
//     dedicated herdr workspace+tab, wired to the one-way CTO notification channel
//     (src/channel.ts) via a generated MCP config + the research-preview
//     `--dangerously-load-development-channels server:butchr-cto-channel` flag.
//   - SINGLE INSTANCE: exactly one CTO agent is ever alive. A start when one is
//     already registered ADOPTS it instead of double-launching.
//   - SESSION CONTINUITY: every supervised relaunch — after a crash, on boot-adopt,
//     across a butchr restart — RESUMES the SAME Claude session via `--resume <id>`
//     (never `--continue`, which is unreliable here), so the CTO keeps full context
//     and never cold-starts. The FIRST launch resumes an operator-provided session
//     (config.ctoSessionId / BUTCHR_CTO_SESSION_ID) when set, else starts fresh and
//     captures the new id. A brand-new session happens ONLY via restart(fresh).
//   - SUPERVISION: a poll loop relaunches the agent on death with bounded
//     exponential backoff (mirrors the dispatcher's dispatch-retry), giving up after
//     a cap until the operator intervenes.
//
// Context hygiene (the CTO session is INDEFINITE): prefer sending `/compact` to the
// LIVE agent via the harness `send` capability when the session grows (backed by
// Claude Code's own auto-compaction), with a forced-fresh restart as the last resort
// — so the resumed session can't grow unbounded. See SPEC §6.8.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHANNEL_SERVER_NAME } from "./channel.ts";
import { config } from "./config.ts";
import {
  type CtoAgentRow,
  getCtoAgentRow,
  nowIso,
  saveCtoAgentRow,
} from "./db.ts";
import { publish } from "./events.ts";
import type { StartedAgent } from "./harness.ts";
import { harness } from "./harness.ts";

// butchr's own state dir for the CTO agent's generated artifacts (never the repo).
const ctoDir = join(config.dataDir, "cto");
const mcpConfigFile = join(ctoDir, "mcp.json");
const logFile = join(ctoDir, "agent.log");

// Single-quote a string for `bash -lc` (identical to the dispatcher's `shq`).
function shq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

// loopback host for URLs the agent's child processes dial (0.0.0.0 isn't dialable).
const sseHost = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;

/** The dashboard/API view of the managed CTO agent's current state. */
export type CtoStatus = {
  /** config.ctoAgentEnabled — whether boot auto-start + supervision are active. */
  enabled: boolean;
  /** The operator/boot WANTS it up (supervisor relaunches on death). */
  desired: boolean;
  /** A live herdr agent is registered under the CTO name right now (async-probed). */
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

// ---- supervision state (in-memory) ----------------------------------------
// A start/stop/restart in flight; serializes lifecycle ops so the supervisor and an
// API call can't launch/tear down concurrently (the single-instance guard).
let launchInFlight: Promise<CtoStatus> | null = null;
let superviseTimer: ReturnType<typeof setInterval> | null = null;
// Consecutive FAILED relaunch attempts → exponential backoff; reset when the agent
// is observed healthy or on a manual start/restart. `nextRetryAt` gates the backoff.
let consecutiveFailures = 0;
let nextRetryAt = 0;

// ---- default editable brief -------------------------------------------------
const DEFAULT_BRIEF = `# butchr CTO agent

You are the **butchr CTO** — a persistent, butchr-managed Claude Code session that
operates the butchr task pipeline on the operator's behalf. You were launched and are
supervised by butchr itself, and you keep full context across relaunches (butchr
\`--resume\`s your session).

## How you receive work

You are wired to the **one-way CTO notification channel** (\`<${CHANNEL_SERVER_NAME}>\`).
Each event is a butchr task that just ENTERED a state needing your attention:

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

- **Do NOT edit the butchr codebase directly.** All code changes go through tasks
  (create an idea/task via the API and let a build agent do it under review).
- You have no worktree, branch, review, or merge of your own — you are an operator,
  not a builder.
- Keep your own context lean: when this session grows large, run \`/compact\`.
`;

/**
 * Resolve the editable CTO brief file. Uses config.ctoBriefPath when it points at a
 * readable file; otherwise writes the documented default to <dataDir>/cto-brief.md
 * (once) and returns that, so an operator can edit the brief in place.
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
 * Write the CTO agent's MCP config: a single STDIO server named
 * `butchr-cto-channel` that runs the one-way channel bridge (config.ctoChannelCmd)
 * via `bash -lc`, with the SSE URL pointed at this butchr. The agent loads it as a
 * development channel through the `server:butchr-cto-channel` reference in
 * config.ctoAgentCmd. Returns the config path.
 */
export function writeChannelMcpConfig(): string {
  mkdirSync(ctoDir, { recursive: true });
  const cfg = {
    mcpServers: {
      [CHANNEL_SERVER_NAME]: {
        command: "bash",
        args: ["-lc", config.ctoChannelCmd],
        env: {
          BUTCHR_CHANNEL_SSE_URL: `http://${sseHost}:${config.port}/api/events`,
        },
      },
    },
  };
  writeFileSync(mcpConfigFile, JSON.stringify(cfg), "utf8");
  return mcpConfigFile;
}

/**
 * Decide the session id + flag for a launch. FRESH → a brand-new `--session-id`.
 * Otherwise RESUME, preferring (in order) the persisted active session, then the
 * operator-seeded config.ctoSessionId (first-launch continuity), else a fresh id.
 * Pure + exported for testing.
 */
export function resolveCtoSession(
  row: CtoAgentRow | null,
  fresh: boolean,
): { sessionId: string; isResume: boolean } {
  if (fresh) return { sessionId: crypto.randomUUID(), isResume: false };
  const persisted = row?.session_id?.trim();
  if (persisted) return { sessionId: persisted, isResume: true };
  const seed = config.ctoSessionId.trim();
  if (seed) return { sessionId: seed, isResume: true };
  return { sessionId: crypto.randomUUID(), isResume: false };
}

/** Build the fully-substituted, `script`-wrapped launch argv. Exported for testing. */
export function buildCtoArgv(sessionFlag: string): string[] {
  const model = config.ctoAgentModel.trim();
  const modelFlag = model ? `--model ${model}` : "";
  const agentCmd = config.ctoAgentCmd
    .replaceAll("{{MODEL_FLAG}}", modelFlag)
    .replaceAll("{{SESSION_FLAG}}", sessionFlag)
    .replaceAll("{{MCP_CONFIG}}", mcpConfigFile)
    .replaceAll("{{PROMPT_FILE}}", resolveBriefFile());
  // Run under `script` (PTY → the interactive UI renders + input works in the herdr
  // pane) while logging to a file — exactly how the dispatcher launches task agents.
  const wrapped = `SHELL=/bin/bash script -qfe --log-out ${shq(logFile)} -c ${shq(agentCmd)}`;
  return ["bash", "-lc", wrapped];
}

/** Heal/create the CTO agent's dedicated herdr workspace; persist its id. */
async function ensureCtoWorkspace(): Promise<string | undefined> {
  const row = getCtoAgentRow();
  const existing = row?.herdr_workspace ?? undefined;
  if (existing && (await harness.workspaceExists(existing))) return existing;
  const ws = await harness.workspaceCreate(config.ctoCwd, "butchr-cto");
  saveCtoAgentRow({ herdr_workspace: ws.workspaceId ?? null });
  return ws.workspaceId;
}

// Start the agent, self-healing an `agent_name_taken` collision — the dispatcher's
// startAgentReconciling pattern, scoped to the singleton CTO name.
async function startAgentReconciling(argv: string[], workspaceId?: string, tabId?: string): Promise<StartedAgent> {
  try {
    return await harness.agentStart(config.ctoAgentName, config.ctoCwd, argv, workspaceId, tabId);
  } catch (e) {
    if (!harness.isAgentNameTaken(e)) throw e;
    await harness.agentDeregister(config.ctoAgentName);
    return await harness.agentStart(config.ctoAgentName, config.ctoCwd, argv, workspaceId, tabId);
  }
}

/**
 * The actual launch: write the channel MCP config + brief, build the argv (resuming
 * the right session), create a dedicated tab, start the agent, close the husk root
 * pane, re-resolve the real pane (surviving herdr's positional renumber), and persist
 * the session/pane/tab. Throws if the agent never registers a live pane. NOT guarded
 * — callers go through startCtoAgent / superviseRelaunch (which hold launchInFlight).
 */
async function performLaunch(fresh: boolean): Promise<void> {
  const { sessionId, isResume } = resolveCtoSession(getCtoAgentRow(), fresh);
  const sessionFlag = isResume ? `--resume ${sessionId}` : `--session-id ${sessionId}`;
  writeChannelMcpConfig();
  const argv = buildCtoArgv(sessionFlag);

  const workspaceId = await ensureCtoWorkspace();
  rmSync(logFile, { force: true });

  const tab = await harness.tabCreate(workspaceId ?? undefined, config.ctoCwd, "butchr-cto");
  let paneId: string;
  let tabId: string | undefined;
  try {
    await startAgentReconciling(argv, workspaceId ?? undefined, tab.tabId);
    // The tab's empty root pane is a husk; close it so the tab holds only the agent.
    // Capture its stable terminal id first so resolveAgentPane can wait out the
    // positional-id renumber (the phantom-pane guard — see dispatcher.ts).
    let closedTerminalId: string | undefined;
    if (tab.tabId && tab.rootPaneId) {
      closedTerminalId = await harness.paneTerminalId(tab.rootPaneId);
      await harness.paneClose(tab.rootPaneId).catch(() => {});
    }
    const realPane = await harness.resolveAgentPane(config.ctoAgentName, closedTerminalId);
    if (!realPane) {
      throw new Error("CTO agent did not register a live pane after start");
    }
    paneId = realPane;
    tabId = tab.tabId;
  } catch (e) {
    await harness.agentDeregister(config.ctoAgentName).catch(() => {});
    if (tab.tabId) await harness.tabClose(tab.tabId).catch(() => {});
    throw e;
  }

  saveCtoAgentRow({
    session_id: sessionId,
    herdr_pane_id: paneId,
    herdr_tab_id: tabId ?? null,
    herdr_workspace: workspaceId ?? null,
    desired: 1,
    started_at: nowIso(),
    last_error: null,
  });
  console.log(
    `[butchr] launched CTO agent (${isResume ? `--resume ${sessionId}` : `fresh session ${sessionId}`}, pane ${paneId})`,
  );
}

/** Adopt an already-live CTO agent (re-record its current pane/tab; no relaunch). */
async function adoptCtoAgent(): Promise<void> {
  const row = getCtoAgentRow();
  const paneId = (await harness.agentPaneId(config.ctoAgentName)) ?? row?.herdr_pane_id ?? null;
  const tabId = (await harness.agentTabId(config.ctoAgentName)) ?? row?.herdr_tab_id ?? null;
  saveCtoAgentRow({
    herdr_pane_id: paneId,
    herdr_tab_id: tabId,
    desired: 1,
    started_at: row?.started_at ?? nowIso(),
    last_error: null,
  });
  console.log(`[butchr] adopted live CTO agent (pane ${paneId})`);
}

/** Serialize a lifecycle op behind launchInFlight (the single-instance guard). */
function guarded(fn: () => Promise<CtoStatus>): Promise<CtoStatus> {
  if (launchInFlight) return launchInFlight;
  const p = fn().finally(() => {
    if (launchInFlight === p) launchInFlight = null;
  });
  launchInFlight = p;
  return p;
}

/** Compute the current status and publish a `cto.updated` event; returns the status. */
async function publishStatus(): Promise<CtoStatus> {
  const s = await ctoAgentStatus();
  publish({ type: "cto.updated", cto: s });
  return s;
}

/**
 * START (or adopt) the single CTO agent. Marks it DESIRED-up (so the supervisor keeps
 * it alive), then: if a live agent is already registered (and not a fresh start) it
 * ADOPTS rather than double-launching (single-instance); otherwise it launches —
 * RESUMING the persisted/seeded session unless `fresh`, which forces a brand-new one.
 * A manual start resets the supervised-restart counter.
 */
export function startCtoAgent(opts: { fresh?: boolean } = {}): Promise<CtoStatus> {
  return guarded(async () => {
    saveCtoAgentRow({ desired: 1 });
    consecutiveFailures = 0;
    nextRetryAt = 0;
    if (!opts.fresh && (await harness.agentExists(config.ctoAgentName))) {
      await adoptCtoAgent();
    } else {
      await performLaunch(!!opts.fresh);
      saveCtoAgentRow({ restarts: 0 }); // a manual (re)launch resets the counter
    }
    return publishStatus();
  });
}

/**
 * STOP the CTO agent: mark it DESIRED-down (the supervisor leaves it down, and this
 * survives a restart) and tear down its tab/pane + free its agent name. Idempotent.
 */
export function stopCtoAgent(): Promise<CtoStatus> {
  return guarded(async () => {
    saveCtoAgentRow({ desired: 0 });
    consecutiveFailures = 0;
    nextRetryAt = 0;
    const row = getCtoAgentRow();
    await harness
      .teardownTask(row?.herdr_tab_id, config.ctoAgentName, row?.herdr_pane_id)
      .catch(() => {});
    await harness.agentDeregister(config.ctoAgentName).catch(() => {});
    saveCtoAgentRow({ herdr_pane_id: null, herdr_tab_id: null, started_at: null });
    console.log("[butchr] stopped CTO agent");
    return publishStatus();
  });
}

/**
 * RESTART the CTO agent. By default it RESUMES the same session (a clean bounce);
 * `fresh` forces a brand-new session — the ONLY way to cold-start (e.g. last-resort
 * context hygiene when the session has grown unmanageable). See SPEC §6.8.
 */
export async function restartCtoAgent(opts: { fresh?: boolean } = {}): Promise<CtoStatus> {
  await stopCtoAgent();
  return startCtoAgent({ fresh: opts.fresh });
}

/** The current managed-CTO-agent status (probes herdr for live registration). */
export async function ctoAgentStatus(): Promise<CtoStatus> {
  const row = getCtoAgentRow();
  const running = await harness.agentExists(config.ctoAgentName).catch(() => false);
  return {
    enabled: config.ctoAgentEnabled,
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

/**
 * BOOT RECONCILE: bring the managed CTO agent into its desired state once, before the
 * supervisor starts (see index.ts). No-op unless enabled. With herdr down we cannot
 * probe liveness, so we defer to the supervisor (which retries once herdr is up). When
 * the operator explicitly STOPPED it before the restart (a prior row with desired=0),
 * we respect that and stay down. Otherwise: ADOPT an already-live agent (its pane
 * survived a butchr restart — session continuity) or (re)LAUNCH it, resuming the same
 * (or operator-seeded) session.
 */
export async function reconcileCtoAgent(
  herdrUp: boolean,
): Promise<{ action: "disabled" | "skipped" | "stopped" | "adopted" | "launched" }> {
  if (!config.ctoAgentEnabled) return { action: "disabled" };
  if (!herdrUp) return { action: "skipped" };
  const row = getCtoAgentRow();
  if (row && row.desired === 0 && row.updated_at) {
    // The operator stopped it before this restart — honor that.
    return { action: "stopped" };
  }
  if (await harness.agentExists(config.ctoAgentName)) {
    await adoptCtoAgent();
    await publishStatus();
    return { action: "adopted" };
  }
  await startCtoAgent();
  return { action: "launched" };
}

// One supervision tick: if the agent is DESIRED-up but its herdr agent has died,
// relaunch it (RESUMING the same session) with bounded exponential backoff, giving up
// after config.ctoMaxRestarts consecutive failures until the operator intervenes.
async function superviseTick(): Promise<void> {
  if (!config.ctoAgentEnabled) return;
  if (launchInFlight) return; // a start/stop/restart is mid-flight — don't race it
  const row = getCtoAgentRow();
  if (!row || row.desired !== 1) return; // operator wants it down (or never started)

  if (await harness.agentExists(config.ctoAgentName).catch(() => false)) {
    if (consecutiveFailures !== 0) {
      consecutiveFailures = 0; // healthy → reset backoff
      nextRetryAt = 0;
    }
    return;
  }

  // Dead while DESIRED up → relaunch with backoff.
  if (consecutiveFailures >= config.ctoMaxRestarts) return; // gave up — await operator
  const now = Date.now();
  if (now < nextRetryAt) return; // still backing off
  consecutiveFailures++;
  const delay = Math.min(
    config.ctoRestartBackoffBaseMs * 2 ** (consecutiveFailures - 1),
    config.ctoRestartBackoffCapMs,
  );
  nextRetryAt = now + delay;
  console.warn(
    `[butchr] CTO agent died — relaunching (attempt ${consecutiveFailures}/${config.ctoMaxRestarts}, resuming session)`,
  );
  await guarded(async () => {
    const before = getCtoAgentRow()?.restarts ?? 0;
    await performLaunch(false); // resume the SAME session — never cold-start
    saveCtoAgentRow({ restarts: before + 1 });
    return publishStatus();
  }).catch(async (e) => {
    const msg = (e as Error).message;
    saveCtoAgentRow({ last_error: msg });
    console.error(`[butchr] CTO agent relaunch failed: ${msg}`);
    if (consecutiveFailures >= config.ctoMaxRestarts) {
      console.error(
        `[butchr] CTO agent gave up after ${config.ctoMaxRestarts} relaunch attempts — start/restart it from the dashboard`,
      );
    }
    await publishStatus().catch(() => {});
  });
}

/** Start the CTO-agent supervisor poll loop (no-op if already running). */
export function startCtoSupervisor(): void {
  if (superviseTimer) return;
  superviseTimer = setInterval(() => void superviseTick(), config.ctoSuperviseMs);
}

/** Stop the supervisor loop (clean shutdown). Does NOT kill the live agent — its pane
 *  survives so the next boot can ADOPT and resume it, exactly like workspace agents. */
export function stopCtoSupervisor(): void {
  if (superviseTimer) clearInterval(superviseTimer);
  superviseTimer = null;
}

/** Test-only: run a single supervision tick synchronously (the loop body). */
export async function _superviseTickForTest(): Promise<void> {
  await superviseTick();
}

/** Test-only: reset the in-memory backoff state between cases. */
export function _resetSupervisionStateForTest(): void {
  consecutiveFailures = 0;
  nextRetryAt = 0;
  launchInFlight = null;
}
