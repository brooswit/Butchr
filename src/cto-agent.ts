// MANAGED CTO AGENT (PER-WORKSPACE). butchr LAUNCHES and SUPERVISES one long-lived
// CTO agent PER REGISTERED WORKSPACE (repo). Each runs in that repo's ROOT and IS the
// principal/dev agent for that project — a first-class, channel-connected Claude Code
// session, just like the per-task workspace agents, but with NO worktree/branch/
// review/merge. It is the operator's hands FOR THAT REPO: on each
// <butchr-cto-channel> push (a brief awaiting a spec, or a spec/diff/question/failure
// for ONE of that workspace's tasks) it acts via the butchr API (127.0.0.1:47800) or
// `bin/butchr` (write-spec/approve/reject/answer/requeue); it does NOT edit that repo's
// code directly (all code changes go through tasks). On a `spec requested` event it
// writes+submits the spec ONLY when the workspace's `spec-generation` responder is `cto`
// (a `user` workspace's specs are written by a human in the webapp). There is NO
// global/top-level CTO — butchr manages one CTO agent per workspace, keyed by workspace_id.
//
// This module owns each per-workspace agent's LIFECYCLE, the same way the dispatcher
// owns a task agent's:
//   - LAUNCH through the EXISTING AgentRunner/harness seam (src/harness.ts) into a
//     dedicated herdr tab IN THAT WORKSPACE'S HERDR WORKSPACE, with cwd = the workspace's
//     repo root (workspace.path), wired to the one-way CTO notification channel
//     (src/channel.ts) SCOPED to the workspace (BUTCHR_CHANNEL_WORKSPACE) via a generated
//     MCP config + the research-preview `--dangerously-load-development-channels
//     server:butchr-cto-channel` flag — so it receives only THAT workspace's events.
//   - SINGLE INSTANCE PER WORKSPACE: at most one CTO agent is alive per workspace. A
//     start when one is already registered ADOPTS it instead of double-launching.
//   - LAUNCH SELF-COMPLETE: every (re)launch AUTO-CLEARS any blocking interactive
//     startup prompt (dev-channels consent / folder-trust / any yes-no or numbered
//     confirmation) via the harness `send` capability with bounded poll/retry, so the
//     agent comes up READY unattended on every (re)launch/reboot (src/startup-confirm.ts).
//   - SESSION CONTINUITY: every supervised relaunch — after a crash, on boot-adopt,
//     across a butchr restart — RESUMES the SAME Claude session via `--resume <id>`
//     (never `--continue`), so the CTO keeps full context and never cold-starts. The
//     FIRST launch resumes a per-workspace operator-seeded session
//     (config.ctoAgentSessionSeeds[workspaceId]) when set, else starts fresh and
//     captures the new id. A brand-new session happens ONLY via restart(fresh).
//   - SUPERVISION: a single poll loop relaunches each desired-up-but-dead agent with
//     bounded per-workspace exponential backoff, giving up after a cap until the
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
import { ensureHerdrWorkspace } from "./workspaces.ts";
import { publish } from "./events.ts";
import { buildScriptArgv, modelFlag } from "./exec.ts";
import { harness } from "./harness.ts";
import { startAgentInFreshTab } from "./herdr.ts";
import { claudeLiveness } from "./liveness.ts";
import { autoConfirmStartupPrompts } from "./startup-confirm.ts";

// butchr's own state dir for the CTO agents' generated artifacts (never the repo).
// One subdirectory per workspace so per-workspace MCP configs + logs never collide.
function ctoDir(workspaceId: string): string {
  return join(config.dataDir, "cto", workspaceId);
}
function mcpConfigFile(workspaceId: string): string {
  return join(ctoDir(workspaceId), "mcp.json");
}
function logFile(workspaceId: string): string {
  return join(ctoDir(workspaceId), "agent.log");
}

/** The herdr agent name for a workspace's CTO agent: `<prefix>-<workspaceId>`. */
export function ctoAgentName(workspaceId: string): string {
  return `${config.ctoAgentName}-${workspaceId}`;
}

/** A registered workspace's repo-root path (the CTO agent's cwd), or null if gone. */
function workspacePath(workspaceId: string): string | null {
  const row = db
    .query<{ path: string }, [string]>(`SELECT path FROM workspaces WHERE id=?`)
    .get(workspaceId);
  return row?.path ?? null;
}

/**
 * Is a workspace's CTO agent ENABLED for boot auto-start + supervision? The
 * workspace's own `cto_enabled` column WINS (1 → on, 0 → off); NULL inherits the
 * GLOBAL default config.ctoAgentEnabled (itself default OFF). An unknown workspace →
 * not enabled. Exported for testing.
 */
export function isCtoEnabled(workspaceId: string): boolean {
  const row = db
    .query<{ cto_enabled: number | null }, [string]>(
      `SELECT cto_enabled FROM workspaces WHERE id=?`,
    )
    .get(workspaceId);
  if (!row) return false;
  if (row.cto_enabled !== null) return row.cto_enabled === 1;
  return config.ctoAgentEnabled;
}

/** The dashboard/API view of a workspace's managed CTO agent state. */
export type CtoStatus = {
  /** The workspace this CTO agent belongs to. */
  workspaceId: string;
  /** Per-workspace enable (cto_enabled, or the global default) — boot auto-start +
   *  supervision are active when true. */
  enabled: boolean;
  /** The operator/boot WANTS it up (supervisor relaunches on death). */
  desired: boolean;
  /** A live herdr agent is registered under this workspace's CTO name (async-probed). */
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

// ---- supervision state (in-memory, PER WORKSPACE) -------------------------
// A start/stop/restart in flight per workspace, plus that workspace's backoff
// counters. Keyed by workspace_id so lifecycle ops on different workspaces never
// block each other, while ops on the SAME workspace serialize (the single-instance
// guard). `consecutiveFailures` drives exponential backoff; `nextRetryAt` gates it.
type WsState = {
  launchInFlight: Promise<CtoStatus> | null;
  consecutiveFailures: number;
  nextRetryAt: number;
};
const wsStates = new Map<string, WsState>();
function wsState(workspaceId: string): WsState {
  let s = wsStates.get(workspaceId);
  if (!s) {
    s = { launchInFlight: null, consecutiveFailures: 0, nextRetryAt: 0 };
    wsStates.set(workspaceId, s);
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
SCOPED to this repository. Each event is one of THIS workspace's tasks that just
ENTERED a state needing your attention:

- **spec requested** — a task is parked in \`idea\`: a one-line brief AWAITING a spec.
  The event carries the brief. See "Writing specs" below — this is yours to handle ONLY
  when the workspace's spec-generation responder is \`cto\`.
- **spec_review** — a submitted spec is awaiting approval.
- **in_review** — a diff is awaiting review.
- **needs_info** — an agent asked a question awaiting an answer.
- **agent idle** — a LIVE build agent went idle/quiet (alive but no recent output): it
  may be mid-task paused, finished-but-unsubmitted, or wedged. The event carries an
  \`idle_context\` snapshot of its recent output. See "Handling an idle agent" below.
- **aborted** — a task failed.

The channel is PUSH-ONLY: you cannot reply through it. Act through the normal butchr
surfaces instead.

## Who acts: the responder self-check (DO THIS ON EVERY EVENT)

butchr is **responder-agnostic**: every feedback event is surfaced to you AND remains
actionable by a human in the webapp. WHO is *expected* to act is per-workspace config —
the \`step_responders\` map. Your standing behavior on each event:

1. **Determine the STEP from the task's state** (the map):

   | task state | responder STEP | your \`cto\` action |
   |------------|----------------|--------------------|
   | \`idea\` (spec requested) | \`spec-generation\` | write + \`POST /api/tasks/<id>/spec\` \`{ "spec": "…" }\` |
   | \`spec_review\` | \`spec-approval\` | \`POST /api/tasks/<id>/approve\` (or \`/reject\` \`{ "note": "…" }\`) |
   | \`needs_info\` **on a plan-preview task** (a proposed plan) | \`plan-approval\` | \`POST /api/tasks/<id>/answer\` \`{ "answer": "proceed" }\` (or steering notes) |
   | \`needs_info\` (a raised question) | \`answer-question\` | \`POST /api/tasks/<id>/answer\` \`{ "answer": "…" }\` |
   | \`in_review\` (a diff) | \`diff-review\` | \`POST /api/tasks/<id>/approve\` (or \`/reject\` \`{ "note": "…" }\`) |
   | \`in_progress\` **+ idle** (\`agent idle\`) | \`idle-handling\` | read \`idle_context\`, then \`POST /api/tasks/<id>/nudge\` \`{ "text": "…" }\` (guidance; omit \`text\` for a bare \`continue\`), or \`/requeue\`, or \`/abort\` |
   | \`aborted\` | — (a failure to triage) | investigate; \`/requeue\` if appropriate |

   (A \`needs_info\` task that opted into the plan-preview gate is holding a PROPOSED PLAN
   awaiting your go/steer; any other \`needs_info\` is a clarifying QUESTION. butchr also
   exposes this on the task as \`pending_responder\` — the resolved \`cto\`/\`user\` for the
   current step — so you don't have to cross-reference.)

2. **Check the responder for that step.** \`GET /api/workspaces/<workspace_id>\` returns
   the fully-resolved \`step_responders\` map; read \`step_responders[<step>]\` (or just read
   the task's \`pending_responder\`).

3. **AUTO-ACT only when it is \`"cto"\`.** Do the action above via the butchr HTTP API at
   \`http://127.0.0.1:47800\` (or the equivalent \`bin/butchr\` command). When it is
   \`"user"\`, **do NOT act** — a human will handle it in the webapp; just observe (the
   event is informational for you). The endpoints stay open to both, so a human can
   always act even on a \`cto\` step — but YOU only auto-act on \`cto\`.

## Writing specs (the \`spec requested\` event)

A \`spec requested\` event is the \`spec-generation\` case above: an \`idea\` task waiting
for someone to turn its brief into a concrete, repo-grounded SPEC. Only when
\`step_responders["spec-generation"]\` is \`"cto"\`: read the repo (this is your repo root)
to ground the spec, write a detailed, scoped SPEC for the brief, and submit it with
\`POST /api/tasks/<id>/spec\` body \`{ "spec": "<the spec>" }\` — butchr rewrites the task's
prompt to your spec and advances it to \`spec_review\`. If it is \`"user"\`, a HUMAN writes
it in the webapp; do NOT submit — just observe.

(If a spec is later sent back for changes, the task returns to \`idea\` and you get a
fresh \`spec requested\` event with the change note recorded on the task — revise and
re-submit via the same \`/spec\` endpoint, again only when the responder is \`cto\`.)

## Handling an idle agent (the \`agent idle\` event)

An \`agent idle\` event means a LIVE build agent (\`in_progress\`) went quiet — alive but
no recent output. butchr NO LONGER blindly types "continue" at it; instead it surfaces
the idle agent with CONTEXT and routes it to the \`idle-handling\` responder. Only when
\`step_responders["idle-handling"]\` is \`"cto"\`: **read the \`idle_context\`** on the task
(\`GET /api/tasks/<id>\` — the captured tail of the agent's recent output) to judge WHY it
stopped, then act:

- **Merely slow / paused mid-task** (e.g. a transient \`529 Overloaded\`, or parked at an
  empty prompt): \`POST /api/tasks/<id>/nudge\` with \`{ "text": "<guidance>" }\` to steer it,
  or with no body for a bare \`continue\`. This is the old "continue" — now just ONE
  deliberate option, used when the context shows it just needs a push.
- **Finished but didn't submit / went off-track / wedged**: don't poke it — \`POST
  /api/tasks/<id>/requeue\` to re-launch its session fresh, or \`POST /api/tasks/<id>/abort\`
  if the work should be dropped.

LIVENESS is handled FOR you: butchr never surfaces a DEAD shell as nudgeable — a dead
agent is auto-resumed — and \`/nudge\` itself re-checks liveness and routes a dead pane to
auto-resume rather than poking it. So a nudge you send only ever reaches a genuinely live
agent. If \`step_responders["idle-handling"]\` is \`"user"\`, a human handles it in the
webapp; just observe.

## Hard rules

- **Do NOT edit this repository's code directly.** All code changes go through tasks
  (create an idea/task via the API and let a build agent do it under review). Writing a
  SPEC and POSTing it to \`/spec\` is allowed — that is task orchestration, not editing
  the repo.
- You have no worktree, branch, review, or merge of your own — you are an operator,
  not a builder.
- Keep your own context lean: when this session grows large, run \`/compact\`.
`;

/**
 * Resolve the editable CTO brief file. Uses config.ctoBriefPath when it points at a
 * readable file; otherwise writes the documented default to <dataDir>/cto-brief.md
 * (once) and returns that, so an operator can edit the brief in place. Shared across
 * workspaces (each per-repo CTO is primed by the same brief).
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
 * Write a workspace's CTO agent MCP config: a single STDIO server named
 * `butchr-cto-channel` that runs the one-way channel bridge (config.ctoChannelCmd)
 * via `bash -lc`, with the SSE URL pointed at this butchr and SCOPED to the workspace
 * via BUTCHR_CHANNEL_WORKSPACE (so it pushes only that workspace's events). The agent loads
 * it as a development channel through `server:butchr-cto-channel` in config.ctoAgentCmd.
 * Returns the config path.
 */
export function writeChannelMcpConfig(workspaceId: string): string {
  mkdirSync(ctoDir(workspaceId), { recursive: true });
  const cfg = {
    mcpServers: {
      [CHANNEL_SERVER_NAME]: {
        command: "bash",
        args: ["-lc", config.ctoChannelCmd],
        env: {
          BUTCHR_CHANNEL_SSE_URL: `http://${config.loopbackHost}:${config.port}/api/events`,
          BUTCHR_CHANNEL_WORKSPACE: workspaceId,
        },
      },
    },
  };
  const file = mcpConfigFile(workspaceId);
  writeFileSync(file, JSON.stringify(cfg), "utf8");
  return file;
}

/**
 * Decide the session id + flag for a workspace's launch. FRESH → a brand-new
 * `--session-id`. Otherwise RESUME, preferring (in order) the persisted active
 * session, then the per-workspace operator-seeded session
 * (config.ctoAgentSessionSeeds[workspaceId], first-launch continuity), else a fresh
 * id. Pure + exported for testing.
 */
export function resolveCtoSession(
  workspaceId: string,
  row: CtoAgentRow | null,
  fresh: boolean,
): { sessionId: string; isResume: boolean } {
  if (fresh) return { sessionId: crypto.randomUUID(), isResume: false };
  const persisted = row?.session_id?.trim();
  if (persisted) return { sessionId: persisted, isResume: true };
  const seed = config.ctoAgentSessionSeeds.get(workspaceId)?.trim();
  if (seed) return { sessionId: seed, isResume: true };
  return { sessionId: crypto.randomUUID(), isResume: false };
}

/** Build the fully-substituted, `script`-wrapped launch argv. Exported for testing. */
export function buildCtoArgv(sessionFlag: string, workspaceId: string): string[] {
  const agentCmd = config.ctoAgentCmd
    .replaceAll("{{MODEL_FLAG}}", modelFlag(config.ctoAgentModel))
    .replaceAll("{{SESSION_FLAG}}", sessionFlag)
    .replaceAll("{{MCP_CONFIG}}", mcpConfigFile(workspaceId))
    .replaceAll("{{PROMPT_FILE}}", resolveBriefFile());
  // Run under `script` (PTY → the interactive UI renders + input works in the herdr
  // pane) while logging to a file — exactly how the dispatcher launches task agents.
  return buildScriptArgv({ agentCmd, logFile: logFile(workspaceId) });
}

/**
 * Heal/use the workspace's herdr workspace (the CTO tab lives in the SAME herdr
 * workspace as the workspace's task agents — one herdr workspace per workspace).
 * Reuses the recorded herdr workspace when it still exists; otherwise recreates one
 * at the repo root and persists it on the workspace row. Returns the herdr workspace id.
 */
async function ensureCtoWorkspace(workspaceId: string, cwd: string): Promise<string | undefined> {
  const { workspaceId: herdrWorkspaceId } = await ensureHerdrWorkspace(
    workspaceId,
    cwd,
    `butchr-cto-${workspaceId}`,
  );
  return herdrWorkspaceId;
}

/**
 * The actual launch for a workspace: write the scoped channel MCP config + brief,
 * build the argv (resuming the right session), create a dedicated tab in the
 * workspace's herdr workspace, start the agent with cwd = the repo root, close the husk root
 * pane, re-resolve the real pane (surviving herdr's positional renumber), persist the
 * session/pane/tab, and AUTO-CONFIRM any blocking startup prompt. Throws if the agent
 * never registers a live pane, or the workspace is gone. NOT guarded — callers go
 * through startCtoAgent / superviseTick (which hold the per-workspace launchInFlight).
 */
async function performLaunch(workspaceId: string, fresh: boolean): Promise<void> {
  const cwd = workspacePath(workspaceId);
  if (!cwd) throw new Error(`workspace ${workspaceId} is no longer registered`);

  const name = ctoAgentName(workspaceId);
  const { sessionId, isResume } = resolveCtoSession(workspaceId, getCtoAgentRow(workspaceId), fresh);
  const sessionFlag = isResume ? `--resume ${sessionId}` : `--session-id ${sessionId}`;
  writeChannelMcpConfig(workspaceId);
  const argv = buildCtoArgv(sessionFlag, workspaceId);

  const herdrWorkspaceId = await ensureCtoWorkspace(workspaceId, cwd);
  rmSync(logFile(workspaceId), { force: true });

  // Create a dedicated tab, start the agent in it (self-healing a name collision),
  // close the husk root pane, and re-resolve the agent's real pane surviving herdr's
  // positional renumber — the same sequence the dispatcher runs (it wraps this in its
  // per-workspace pane lock; the single-instance CTO launch needs no such lock).
  const { paneId, tabId } = await startAgentInFreshTab(harness, {
    name,
    cwd,
    argv,
    workspaceId: herdrWorkspaceId ?? undefined,
    label: `butchr-cto-${workspaceId}`,
    paneError: "CTO agent did not register a live pane after start",
  });

  saveCtoAgentRow(workspaceId, {
    session_id: sessionId,
    herdr_pane_id: paneId,
    herdr_tab_id: tabId ?? null,
    herdr_workspace: herdrWorkspaceId ?? null,
    desired: 1,
    started_at: nowIso(),
    last_error: null,
  });
  console.log(
    `[butchr] launched CTO agent for ${workspaceId} (${isResume ? `--resume ${sessionId}` : `fresh session ${sessionId}`}, pane ${paneId})`,
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
    log: (m) => console.log(`[butchr] CTO ${workspaceId}: ${m}`),
  }).catch(() => {});
}

/** Adopt an already-live CTO agent for a workspace (re-record its pane/tab; no relaunch). */
async function adoptCtoAgent(workspaceId: string): Promise<void> {
  const name = ctoAgentName(workspaceId);
  const row = getCtoAgentRow(workspaceId);
  const paneId = (await harness.agentPaneId(name)) ?? row?.herdr_pane_id ?? null;
  const tabId = (await harness.agentTabId(name)) ?? row?.herdr_tab_id ?? null;
  saveCtoAgentRow(workspaceId, {
    herdr_pane_id: paneId,
    herdr_tab_id: tabId,
    desired: 1,
    started_at: row?.started_at ?? nowIso(),
    last_error: null,
  });
  console.log(`[butchr] adopted live CTO agent for ${workspaceId} (pane ${paneId})`);
}

/** Serialize a lifecycle op for a workspace behind its launchInFlight (single-instance). */
function guarded(workspaceId: string, fn: () => Promise<CtoStatus>): Promise<CtoStatus> {
  const st = wsState(workspaceId);
  if (st.launchInFlight) return st.launchInFlight;
  const p = fn().finally(() => {
    if (st.launchInFlight === p) st.launchInFlight = null;
  });
  st.launchInFlight = p;
  return p;
}

/** Compute a workspace's status and publish a `cto.updated` event; returns the status. */
async function publishStatus(workspaceId: string): Promise<CtoStatus> {
  const s = await ctoAgentStatus(workspaceId);
  publish({ type: "cto.updated", cto: s });
  return s;
}

/**
 * The 'live agent registered → adopt, else launch' decision, shared by startCtoAgent
 * and reconcileCtoAgent. A registered herdr agent (and not a forced-`fresh` start) is
 * normally ADOPTED rather than double-launched (single-instance per workspace).
 *
 * BUT `harness.agentExists` only checks that herdr still has the agent NAME/pane
 * registered — NOT that the `claude` PROCESS is alive. After a HOST REBOOT the pane
 * persists as a bare login shell (claude died with the reboot) while the name stays
 * registered, so adopting it would leave a BLANK shell where the CTO should be (the
 * exact divergence src/liveness.ts documents). So we additionally probe the OS process
 * (claudeLiveness on the persisted session id, mirroring the build-agent paths):
 *   - `alive`   → ADOPT (a healthy CTO is NEVER relaunched — double-launching a live
 *                 session would be worse than the bug).
 *   - `unknown` → ADOPT (no /proc / no recorded session id — indeterminate, so we must
 *                 not risk double-launching a possibly-live CTO on an ambiguous signal).
 *   - `dead`    → the reboot case: tear down the stale husk pane/tab + free the name
 *                 FIRST (no duplicate/zombie pane), then fall through to a fresh launch
 *                 that `--resume`s the persisted session (resolveCtoSession), preserving
 *                 the CTO's full context. No operator action required.
 * Returns which path it took. Callers hold the per-workspace guard.
 */
async function adoptOrLaunch(workspaceId: string, fresh: boolean): Promise<"adopted" | "launched"> {
  const name = ctoAgentName(workspaceId);
  if (!fresh && (await harness.agentExists(name))) {
    const row = getCtoAgentRow(workspaceId);
    if (claudeLiveness(row?.session_id) !== "dead") {
      // alive OR unknown → adopt the live/maybe-live agent (never double-launch).
      await adoptCtoAgent(workspaceId);
      return "adopted";
    }
    // pane exists but claude is PROVABLY dead (reboot) → tear down the stale pane/tab and
    // free the name before relaunching, so there's no duplicate/zombie pane.
    console.log(
      `[butchr] CTO agent for ${workspaceId} has a registered pane but a DEAD claude (host reboot suspected) — tearing down the stale pane and relaunching (--resume)`,
    );
    await harness.teardownTask(row?.herdr_tab_id, name, row?.herdr_pane_id).catch(() => {});
    await harness.agentDeregister(name).catch(() => {});
  }
  await performLaunch(workspaceId, fresh);
  return "launched";
}

/**
 * The guarded START core shared by the public startCtoAgent and the boot
 * reconcileCtoAgent: mark DESIRED-up (so the supervisor keeps it alive), reset that
 * workspace's backoff, then adopt-or-launch (a SINGLE liveness probe — RESUMING the
 * persisted/seeded session unless `fresh` forces a brand-new one), resetting the
 * supervised-restart counter on a fresh launch. Returns BOTH the action taken (for
 * reconcile's accounting) and the published status (startCtoAgent's return).
 */
function ensureCtoStarted(
  workspaceId: string,
  fresh: boolean,
): Promise<{ action: "adopted" | "launched"; status: CtoStatus }> {
  // Captured outside the guarded fn so we can surface the path it took alongside the
  // status (guarded() runs fn() eagerly, so this is set before `status` resolves).
  let action: "adopted" | "launched" = "launched";
  const status = guarded(workspaceId, async () => {
    saveCtoAgentRow(workspaceId, { desired: 1 });
    const st = wsState(workspaceId);
    st.consecutiveFailures = 0;
    st.nextRetryAt = 0;
    action = await adoptOrLaunch(workspaceId, fresh);
    if (action === "launched") {
      saveCtoAgentRow(workspaceId, { restarts: 0 }); // a manual (re)launch resets the counter
    }
    return publishStatus(workspaceId);
  });
  return status.then((s) => ({ action, status: s }));
}

/**
 * START (or adopt) a workspace's CTO agent. Marks it DESIRED-up (so the supervisor
 * keeps it alive), then: if a live agent is already registered (and not a fresh start)
 * it ADOPTS rather than double-launching (single-instance per workspace); otherwise it
 * launches — RESUMING the persisted/seeded session unless `fresh`, which forces a
 * brand-new one. A manual start resets that workspace's supervised-restart counter.
 */
export function startCtoAgent(workspaceId: string, opts: { fresh?: boolean } = {}): Promise<CtoStatus> {
  return ensureCtoStarted(workspaceId, !!opts.fresh).then((r) => r.status);
}

/**
 * STOP a workspace's CTO agent: mark it DESIRED-down (the supervisor leaves it down,
 * and this survives a restart) and tear down its tab/pane + free its agent name.
 * Idempotent.
 */
export function stopCtoAgent(workspaceId: string): Promise<CtoStatus> {
  return guarded(workspaceId, async () => {
    saveCtoAgentRow(workspaceId, { desired: 0 });
    const st = wsState(workspaceId);
    st.consecutiveFailures = 0;
    st.nextRetryAt = 0;
    const name = ctoAgentName(workspaceId);
    const row = getCtoAgentRow(workspaceId);
    await harness
      .teardownTask(row?.herdr_tab_id, name, row?.herdr_pane_id)
      .catch(() => {});
    await harness.agentDeregister(name).catch(() => {});
    saveCtoAgentRow(workspaceId, { herdr_pane_id: null, herdr_tab_id: null, started_at: null });
    console.log(`[butchr] stopped CTO agent for ${workspaceId}`);
    return publishStatus(workspaceId);
  });
}

/**
 * RESTART a workspace's CTO agent. By default it RESUMES the same session (a clean
 * bounce); `fresh` forces a brand-new session — the ONLY way to cold-start (e.g.
 * last-resort context hygiene when the session has grown unmanageable).
 */
export async function restartCtoAgent(
  workspaceId: string,
  opts: { fresh?: boolean } = {},
): Promise<CtoStatus> {
  await stopCtoAgent(workspaceId);
  return startCtoAgent(workspaceId, { fresh: opts.fresh });
}

/** A workspace's current managed-CTO-agent status (probes herdr for live registration). */
export async function ctoAgentStatus(workspaceId: string): Promise<CtoStatus> {
  const row = getCtoAgentRow(workspaceId);
  const running = await harness.agentExists(ctoAgentName(workspaceId)).catch(() => false);
  return {
    workspaceId,
    enabled: isCtoEnabled(workspaceId),
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

/** Reconcile ONE workspace's CTO agent toward its desired state (see reconcileCtoAgents). */
export async function reconcileCtoAgent(
  workspaceId: string,
  herdrUp: boolean,
): Promise<{ action: "disabled" | "skipped" | "stopped" | "adopted" | "launched" }> {
  if (!isCtoEnabled(workspaceId)) return { action: "disabled" };
  if (!herdrUp) return { action: "skipped" };
  const row = getCtoAgentRow(workspaceId);
  if (row && row.desired === 0 && row.updated_at) {
    // The operator stopped it before this restart — honor that.
    return { action: "stopped" };
  }
  // Single decision + single liveness probe, shared with startCtoAgent: adopt a live
  // agent, else launch (no re-entry into startCtoAgent, so no redundant double-probe).
  const { action } = await ensureCtoStarted(workspaceId, false);
  return { action };
}

/**
 * BOOT RECONCILE: bring EVERY enabled workspace's CTO agent into its desired state
 * once, before the supervisor starts (see index.ts). With herdr down we cannot probe
 * liveness, so we defer to the supervisor. Returns aggregate counts.
 */
export async function reconcileCtoAgents(
  herdrUp: boolean,
): Promise<{ adopted: number; launched: number; skipped: number }> {
  let adopted = 0;
  let launched = 0;
  let skipped = 0;
  // Every registered workspace is a candidate (enable is resolved per-workspace inside
  // reconcileCtoAgent — honoring the global default for workspaces with no override).
  const dirs = db.query<{ id: string }, []>(`SELECT id FROM workspaces`).all();
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

// One supervision tick over ALL workspaces: for each CTO agent that is DESIRED-up but
// whose herdr agent has died, relaunch it (RESUMING the same session) with bounded
// per-workspace exponential backoff, giving up after config.ctoMaxRestarts consecutive
// failures until the operator intervenes.
async function superviseTick(): Promise<void> {
  for (const row of listCtoAgentRows()) {
    await superviseWorkspace(row.workspace_id);
  }
}

async function superviseWorkspace(workspaceId: string): Promise<void> {
  if (!isCtoEnabled(workspaceId)) return;
  const st = wsState(workspaceId);
  if (st.launchInFlight) return; // a start/stop/restart is mid-flight — don't race it
  const row = getCtoAgentRow(workspaceId);
  if (!row || row.desired !== 1) return; // operator wants it down (or never started)

  const name = ctoAgentName(workspaceId);
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
    `[butchr] CTO agent for ${workspaceId} died — relaunching (attempt ${st.consecutiveFailures}/${config.ctoMaxRestarts}, resuming session)`,
  );
  await guarded(workspaceId, async () => {
    const before = getCtoAgentRow(workspaceId)?.restarts ?? 0;
    await performLaunch(workspaceId, false); // resume the SAME session — never cold-start
    saveCtoAgentRow(workspaceId, { restarts: before + 1 });
    return publishStatus(workspaceId);
  }).catch(async (e) => {
    const msg = (e as Error).message;
    saveCtoAgentRow(workspaceId, { last_error: msg });
    console.error(`[butchr] CTO agent relaunch failed for ${workspaceId}: ${msg}`);
    if (st.consecutiveFailures >= config.ctoMaxRestarts) {
      console.error(
        `[butchr] CTO agent for ${workspaceId} gave up after ${config.ctoMaxRestarts} relaunch attempts — start/restart it from the dashboard`,
      );
    }
    await publishStatus(workspaceId).catch(() => {});
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

/** Test-only: run a single supervision tick (one workspace) synchronously. */
export async function _superviseTickForTest(workspaceId: string): Promise<void> {
  await superviseWorkspace(workspaceId);
}

/** Test-only: reset the in-memory backoff state for a workspace between cases. */
export function _resetSupervisionStateForTest(workspaceId?: string): void {
  if (workspaceId) {
    wsStates.delete(workspaceId);
  } else {
    wsStates.clear();
  }
}
