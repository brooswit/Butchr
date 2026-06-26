// MANAGED STORY-LEADER AGENT (PER-STORY). Phase 3 of the STORIES epic. butchr LAUNCHES
// and SUPERVISES one long-lived story-leader agent PER OPEN STORY — a "mini-CTO" scoped
// to ONE story. It runs in the story's WORKSPACE repo ROOT (it is an OPERATOR, not a
// builder — NO worktree/branch/review/merge of its own), a first-class butchr-managed,
// --resume'd Claude Code session, exactly like the per-workspace CTO agent.
//
// This module MIRRORS src/cto-agent.ts as closely as possible — it is the story-leader
// equivalent of every CTO-agent lifecycle piece, swapping the workspace_id key for a
// story_id key and the cto_agent table/helpers for story_agent. It owns each leader's
// LIFECYCLE the same way cto-agent.ts owns a CTO's:
//   - LAUNCH through the SAME herdr/harness launch primitives (startAgentInFreshTab into a
//     fresh tab in the story's WORKSPACE herdr workspace, cwd = the repo root,
//     `--session-id`/`--resume`, autoConfirmStartupPrompts so it comes up READY unattended).
//   - SINGLE INSTANCE PER STORY: a start when one is already live ADOPTS it.
//   - SESSION CONTINUITY: every supervised relaunch / boot-adopt RESUMES the same session.
//   - SUPERVISION: a single poll loop relaunches each desired-up-but-dead leader with
//     bounded exponential backoff, giving up after a cap.
//
// PHASE 4 (THIS PHASE): the leader gets a one-way attention feed SCOPED to ITS story's
// subtasks. `storyAgentCmd` now mirrors `ctoAgentCmd`'s channel wiring (`--mcp-config` +
// `--dangerously-load-development-channels server:butchr-cto-channel`), and this module
// writes a per-story channel MCP config (writeStoryChannelMcpConfig) that scopes the bridge
// via BUTCHR_CHANNEL_STORY so the leader sees its members' feedback + failures (the routing
// contract lives in src/channel.ts; subtask feedback is TERMINAL at the leader — to reach the
// CTO the leader raises a STORY-LEVEL ask via POST /api/work/:id/ask).
//
// PHASE SCOPE / GUARD-RAILS (deliberately NOT wired this phase):
//   - NO DECOMPOSITION / FEEDBACK ACTIONS. The leader's decompose-the-story and
//     feedback/merge actions are PHASES 5/6 — not here. This phase is the notification
//     ROUTING only; the leader receives its feed but its ACTIONS arrive later.
//
// MAINTENANCE NOTE: the reconcile + supervisor logic here DUPLICATES cto-agent.ts (a
// deliberate mirror-not-extract per the epic plan — keep the CTO path byte-for-byte
// unchanged). Until a post-epic unification, ANY fix to the reconcile/supervise logic
// must land in BOTH files.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHANNEL_SERVER_NAME } from "./channel.ts";
import { config } from "./config.ts";
import {
  type StoryAgentRow,
  type StoryRow,
  db,
  ensureStoryWorkNode,
  getStoryAgentRow,
  getStoryRow,
  listStoryAgentRows,
  nowIso,
  saveStoryAgentRow,
  saveWorkspaceAgentRow,
} from "./db.ts";
import { ensureHerdrWorkspace } from "./workspaces.ts";
// Runtime-only use inside onStoryCreated (never at module top-level), so the
// workspaces↔workspace-agent↔story-agent ESM cycle resolves via live bindings.
import { ensureWorkspaceAgentRow, startWorkspaceAgent } from "./workspace-agent.ts";
import { buildScriptArgv, modelFlag } from "./exec.ts";
import { harness } from "./harness.ts";
import { startAgentInFreshTab } from "./herdr.ts";
import { claudeLiveness } from "./liveness.ts";
import { autoConfirmStartupPrompts } from "./startup-confirm.ts";

// butchr's own state dir for the story leaders' generated artifacts (never the repo).
// One subdirectory per story so per-story briefs + logs never collide.
function storyDir(storyId: string): string {
  return join(config.dataDir, "story", storyId);
}
function briefFile(storyId: string): string {
  return join(storyDir(storyId), "brief.md");
}
function mcpConfigFile(storyId: string): string {
  return join(storyDir(storyId), "mcp.json");
}
function logFile(storyId: string): string {
  return join(storyDir(storyId), "agent.log");
}

/** The herdr agent name for a story's leader: `<prefix>-story-<storyId>`. The `story-`
 *  infix guarantees no collision with a workspace's CTO name (`<prefix>-<workspaceId>`). */
export function storyAgentName(storyId: string): string {
  return `${config.ctoAgentName}-story-${storyId}`;
}

/**
 * Resilient story_agent write: persist the patch ONLY while the story still exists, else
 * no-op. saveStoryAgentRow requires the FK target (the story row) to exist; but deleteStory
 * is SYNCHRONOUS and fires the leader's launch/teardown FIRE-AND-FORGET, so a story (and its
 * cascade-linked story_agent row) can vanish WHILE a launch/supervise/reconcile write is in
 * flight. Routing every story-agent write through here keeps those best-effort paths from
 * FK-crashing on that race. (The CTO mirror needs no such guard — unregisterWorkspace AWAITS
 * stopCtoAgent before the workspace DELETE.)
 */
function saveRow(storyId: string, patch: Parameters<typeof saveStoryAgentRow>[1]): void {
  if (getStoryRow(storyId)) saveStoryAgentRow(storyId, patch);
}

/** The repo-root path the story's leader runs in (its workspace's path), or null if gone. */
function storyWorkspacePath(storyId: string): string | null {
  const row = db
    .query<{ path: string }, [string]>(
      `SELECT w.path AS path FROM stories s JOIN workspaces w ON w.id = s.workspace_id WHERE s.id=?`,
    )
    .get(storyId);
  return row?.path ?? null;
}

/**
 * Is a story's leader DESIRED up (boot auto-start + supervision)? A story's leader is
 * desired while the story is `open` OR mid-completion (`merging`/`merge_blocked`) — the
 * leader is KEPT UP across an isolated story's land attempt so it can re-attempt a blocked
 * merge (fix a RED re-gate with more subtasks) (CONTRIBUTING §11.7, Phase E). Only a
 * terminal `done`/`aborted` story (or a gone story) has no leader. This is the story-leader
 * analog of cto-agent.isCtoEnabled. Exported for testing.
 */
export function isStoryLeaderDesired(story: StoryRow | null): boolean {
  return (
    !!story &&
    (story.status === "open" ||
      story.status === "merging" ||
      story.status === "merge_blocked")
  );
}

/** The view of a story's managed leader-agent state (mirrors CtoStatus). */
export type StoryAgentStatus = {
  /** The story this leader belongs to. */
  storyId: string;
  /** The leader is DESIRED up (the story is open — supervisor relaunches on death). */
  desired: boolean;
  /** A live herdr agent is registered under this story's leader name (async-probed).
   *  This — NOT a stored pane — is the honest "is it attachable" signal; the attach
   *  targets the agent BY NAME. */
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

// ---- supervision state (in-memory, PER STORY) -----------------------------
// Mirrors cto-agent's wsStates, keyed by story_id.
type StoryState = {
  launchInFlight: Promise<StoryAgentStatus> | null;
  consecutiveFailures: number;
  nextRetryAt: number;
};
const storyStates = new Map<string, StoryState>();
function storyState(storyId: string): StoryState {
  let s = storyStates.get(storyId);
  if (!s) {
    s = { launchInFlight: null, consecutiveFailures: 0, nextRetryAt: 0 };
    storyStates.set(storyId, s);
  }
  return s;
}

let superviseTimer: ReturnType<typeof setInterval> | null = null;

/**
 * The per-story leader brief — generated GENERICALLY off the story row (id + brief), not
 * hardcoded. Mirrors how the CTO brief primes the CTO agent, but per-story. Documents the
 * leader's responsibilities so the seeded session knows its role. Phase 5 wires the FIRST
 * concrete action — DECOMPOSITION (creating subtasks); the feedback/merge actions arrive in
 * Phase 6.
 */
export function buildStoryLeaderBrief(story: StoryRow): string {
  const brief = (story.brief ?? "").trim();
  return `# butchr story-leader agent

You are the **LEADER of story ${story.id}**${brief ? `: "${brief}"` : ""}.

You are a persistent, butchr-managed Claude Code session — a "mini-CTO" scoped to THIS
ONE story — running in this project's repo root. butchr launched and supervises you and
keeps your full context across relaunches (it \`--resume\`s your session).

## Your job: decompose this story into subtasks

Break this story down into the SUBTASKS needed to deliver it, and create each one as a
subtask OF THIS STORY:

- Create each subtask with **\`POST /api/work/${story.id}/work\`** (or \`bin/butchr\`).
  The body is the same as ordinary task creation (\`prompt\`, \`context\`, \`plan_preview\`,
  \`model\`, \`tags\`, \`priority\`, \`allowlist\`, \`version_bump\`, \`idea\`/\`template\`);
  butchr pins the new task to THIS story + dispatches it like any task.
- Set **\`blocked_by\`** for REAL ordering dependencies (a subtask that must land after
  another), so dependent work waits rather than racing. Leave it empty for independent work.
- Each subtask's **questions, specs, and diffs route back to YOU** (your story channel) and
  are TERMINAL at you — judge each against THIS STORY's intent: answer questions, review
  specs, and review + merge diffs. (To reach the CTO, raise a story-level ask — see "Your
  wider role".)

## Course-correct your subtasks

Your first decomposition is rarely the last word. As the story's intent sharpens you can
**refine, reorder, reprioritize, drop, and restart** subtasks IN PLACE — you do NOT have to
abort + recreate to fix one. Each acts on a single subtask by id (use \`reset\` below to redo
the whole story at once):

- **Refine** a subtask's prompt and/or context — **\`PATCH /api/work/:id\`** with
  \`{"prompt":"…","context":["…"]}\`. Send either field or both; an omitted field is left
  unchanged. The edit takes effect on the subtask's NEXT run — a paused or running agent
  re-grounds on its next resume, a not-yet-started one renders the new definition on dispatch
  — so you can tighten scope without losing work. 409 if the subtask is terminal or
  mid-rollback; 400 if \`prompt\` is given but blank.
- **Reorder** dependencies — **\`PUT /api/work/:id/blocked_by\`** (\`POST\` also accepted)
  with \`{"blocked_by":[taskId,…]}\` REPLACES the subtask's blocker set. Add a blocker to
  serialize work that raced; clear blockers to let a subtask run now. A subtask whose blockers
  are now all merged becomes ready; one newly blocked while live is torn down. 409 if
  terminal; 400 on a dependency cycle.
- **Reprioritize** — **\`POST /api/work/:id/priority\`** with \`{"priority":N}\` (integer,
  higher = dispatched sooner, default 0) bumps an urgent subtask ahead of the queue.
- **Drop** a subtask you no longer want — **\`POST /api/work/:id/abort\`** tears down its
  agent + worktree and lands it \`aborted\`; nothing merges. 409 if it is already merged/aborted.
- **Restart** a stuck subtask — **\`POST /api/work/:id/requeue\`** clears its dispatch
  retry/idle state and re-queues it for a FRESH dispatch. 409 if it is terminal (to redo a
  terminal subtask, create a new one).
- **Start the whole story over** — **\`POST /api/work/${story.id}/reset\`** aborts ALL of
  this story's IN-FLIGHT subtasks in one call so you can throw it away and re-decompose;
  already-terminal and mid-rollback members are left untouched and reported under \`skipped\`.
  The story stays \`open\`. Returns \`{ok, story, aborted, failed, skipped}\`.

## Your wider role

Your subtasks' feedback is **TERMINAL at you** — there is no task-level escalation: a
subtask's question/spec/diff/idle is yours to resolve, and \`POST /api/work/:id/escalate\`
does NOT apply to a story member (it 409s). When a call is genuinely above your scope —
architectural, a product/scope decision, your decomposition PLAN needing sign-off, or a
blocker you can't settle — raise a **STORY-LEVEL ASK** to the CTO:

- **\`POST /api/work/${story.id}/ask\`** with \`{"question":"…"}\` opens an ask to the CTO
  and notifies it. 409 if an ask is already open or the story is not \`open\`.
- The CTO **\`/answer\`s** it (its reply comes back to you on your story channel as a \`story
  ask answered\` event), or **\`/escalate\`s** it one rung to the USER for a product call.
  Either way you resume once the ask is answered. Keep ONE ask open at a time.

This story→cto→user seam is also how you get your decomposition plan / design SIGNED OFF
before fanning out, when the story warrants it.

## Completing the story

When **all your subtasks have merged**, butchr pushes you a \`story ready for completion
review\` event on your story channel. That is your cue to **verify the story's goal is
actually met** (review what landed against THIS story's intent — don't just trust the
merge count):

- **Goal MET** → mark the story done: **\`PATCH /api/work/${story.id}\`** with
  \`{"status":"done"}\`. This **tears YOU (the leader) down** and **reports \`story
  complete\` UP to the CTO**. You are finished — nothing more to do.
- **Goal NOT met** (a gap, a missed case, follow-up work) → **create more subtasks**
  (\`POST /api/work/${story.id}/work\`, as above) to close the gap. Leave the story
  \`open\`; when those merge you'll get another completion-review event and re-check.

## Hard rules

- You are an OPERATOR, not a builder: you have no worktree, branch, review, or merge of
  your own. All code changes go through your subtasks.
- Keep your own context lean: when this session grows large, run \`/compact\`.
`;
}

/**
 * Write the per-story leader brief file (generated off the story row) and return its path.
 * Mirrors cto-agent.writeChannelMcpConfig's "write the per-launch artifact" step.
 */
export function writeStoryLeaderBrief(story: StoryRow): string {
  mkdirSync(storyDir(story.id), { recursive: true });
  const file = briefFile(story.id);
  writeFileSync(file, buildStoryLeaderBrief(story), "utf8");
  return file;
}

/**
 * Write a story's leader MCP config: a single STDIO server named `butchr-cto-channel` (the
 * SAME attention-feed concept the CTO uses, reused so the agent surface stays one channel)
 * that runs the one-way channel bridge (config.ctoChannelCmd) via `bash -lc`, with the SSE
 * URL pointed at this butchr and SCOPED to the STORY via BUTCHR_CHANNEL_STORY — so the bridge
 * pushes only THIS story's subtasks' feedback + failures (subtask feedback is terminal at the
 * leader; a leader reaches the CTO via a story-level ask; the routing contract lives in
 * src/channel.ts). The
 * workspace id is passed too (BUTCHR_CHANNEL_WORKSPACE) for SSE filtering / the workspace
 * label. The agent loads it as a development channel via `server:butchr-cto-channel` in
 * config.storyAgentCmd. Mirrors cto-agent.writeChannelMcpConfig. Returns the config path.
 */
export function writeStoryChannelMcpConfig(story: StoryRow): string {
  mkdirSync(storyDir(story.id), { recursive: true });
  const cfg = {
    mcpServers: {
      [CHANNEL_SERVER_NAME]: {
        command: "bash",
        args: ["-lc", config.ctoChannelCmd],
        env: {
          BUTCHR_CHANNEL_SSE_URL: `http://${config.loopbackHost}:${config.port}/api/events`,
          BUTCHR_CHANNEL_STORY: story.id,
          BUTCHR_CHANNEL_WORKSPACE: story.workspace_id,
        },
      },
    },
  };
  const file = mcpConfigFile(story.id);
  writeFileSync(file, JSON.stringify(cfg), "utf8");
  return file;
}

/**
 * Decide the session id + flag for a story leader's launch. FRESH → a brand-new
 * `--session-id`. Otherwise RESUME the persisted active session, else a fresh id. Mirrors
 * resolveCtoSession (story leaders have no operator-seeded session map). Pure + exported
 * for testing.
 */
export function resolveStorySession(
  _storyId: string,
  row: StoryAgentRow | null,
  fresh: boolean,
): { sessionId: string; isResume: boolean } {
  if (fresh) return { sessionId: crypto.randomUUID(), isResume: false };
  const persisted = row?.session_id?.trim();
  if (persisted) return { sessionId: persisted, isResume: true };
  return { sessionId: crypto.randomUUID(), isResume: false };
}

/** Build the fully-substituted, `script`-wrapped launch argv. Exported for testing. */
export function buildStoryArgv(sessionFlag: string, storyId: string): string[] {
  const agentCmd = config.storyAgentCmd
    .replaceAll("{{MODEL_FLAG}}", modelFlag(config.ctoAgentModel))
    .replaceAll("{{SESSION_FLAG}}", sessionFlag)
    .replaceAll("{{MCP_CONFIG}}", mcpConfigFile(storyId))
    .replaceAll("{{PROMPT_FILE}}", briefFile(storyId));
  return buildScriptArgv({ agentCmd, logFile: logFile(storyId) });
}

/**
 * Heal/use the story's herdr workspace. The leader lives in the SAME herdr workspace as
 * its workspace's task agents + CTO agent (one herdr workspace per workspace), so we heal
 * it keyed by the WORKSPACE id — sharing the single per-workspace dedupe in
 * ensureHerdrWorkspace. Returns the herdr workspace id.
 */
async function ensureStoryWorkspace(
  workspaceId: string,
  cwd: string,
): Promise<string | undefined> {
  const { workspaceId: herdrWorkspaceId } = await ensureHerdrWorkspace(
    workspaceId,
    cwd,
    `butchr-story-${workspaceId}`,
  );
  return herdrWorkspaceId;
}

/**
 * The actual launch for a story: write the generated brief, build the argv (resuming the
 * right session), create a dedicated tab in the workspace's herdr workspace, start the
 * agent with cwd = the repo root, re-resolve the real pane, persist the session/pane/tab,
 * and AUTO-CONFIRM any blocking startup prompt. Throws if the story is gone or the agent
 * never registers a live pane. NOT guarded — callers hold the per-story launchInFlight.
 */
async function performLaunch(storyId: string, fresh: boolean): Promise<void> {
  const story = getStoryRow(storyId);
  if (!story) throw new Error(`story ${storyId} no longer exists`);
  const cwd = storyWorkspacePath(storyId);
  if (!cwd) throw new Error(`story ${storyId}'s workspace is no longer registered`);

  const name = storyAgentName(storyId);
  const { sessionId, isResume } = resolveStorySession(storyId, getStoryAgentRow(storyId), fresh);
  const sessionFlag = isResume ? `--resume ${sessionId}` : `--session-id ${sessionId}`;
  writeStoryLeaderBrief(story);
  writeStoryChannelMcpConfig(story);
  const argv = buildStoryArgv(sessionFlag, storyId);

  const herdrWorkspaceId = await ensureStoryWorkspace(story.workspace_id, cwd);
  rmSync(logFile(storyId), { force: true });

  const { paneId } = await startAgentInFreshTab(harness, {
    name,
    cwd,
    argv,
    workspaceId: herdrWorkspaceId ?? undefined,
    label: `butchr-story-${storyId}`,
    paneError: "story leader did not register a live pane after start",
  });

  saveRow(storyId, {
    session_id: sessionId,
    herdr_workspace: herdrWorkspaceId ?? null,
    desired: 1,
    started_at: nowIso(),
    last_error: null,
  });
  console.log(
    `[butchr] launched story leader for ${storyId} (${isResume ? `--resume ${sessionId}` : `fresh session ${sessionId}`}, pane ${paneId})`,
  );

  // LAUNCH SELF-COMPLETE: clear any blocking interactive startup prompt. Best-effort +
  // bounded — never fails the launch. Reuses the CTO prompt-poll knobs.
  void autoConfirmStartupPrompts(name, {
    read: (n) => harness.agentRead(n),
    send: (n, input) => harness.send(n, input),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    pollMs: config.ctoPromptPollMs,
    maxPolls: config.ctoPromptMaxPolls,
    quietPolls: config.ctoPromptQuietPolls,
    log: (m) => console.log(`[butchr] story ${storyId}: ${m}`),
  }).catch(() => {});
}

/** Adopt an already-live story leader (mark it desired-up; no relaunch). */
async function adoptStoryAgent(storyId: string): Promise<void> {
  const row = getStoryAgentRow(storyId);
  // Name-only addressing: there is no pane/tab to record — adoption just marks the
  // leader desired-up and clears any stale last_error. The agent is reached BY NAME at
  // action time (attach / teardown), so a herdr/host restart needs no re-recording here.
  saveRow(storyId, {
    desired: 1,
    started_at: row?.started_at ?? nowIso(),
    last_error: null,
  });
  console.log(`[butchr] adopted live story leader for ${storyId}`);
}

/** Serialize a lifecycle op for a story behind its launchInFlight (single-instance). */
function guarded(storyId: string, fn: () => Promise<StoryAgentStatus>): Promise<StoryAgentStatus> {
  const st = storyState(storyId);
  if (st.launchInFlight) return st.launchInFlight;
  const p = fn().finally(() => {
    if (st.launchInFlight === p) st.launchInFlight = null;
  });
  st.launchInFlight = p;
  return p;
}

/**
 * The 'live agent registered → adopt, else launch' decision, shared by startStoryAgent and
 * reconcileStoryAgent. Mirrors cto-agent.adoptOrLaunch EXACTLY (incl. the reboot-recovery
 * liveness gate): a registered-but-DEAD pane (host reboot left a bare husk shell) is torn
 * down + the name freed before a `--resume` relaunch; an alive/indeterminate one is adopted.
 */
async function adoptOrLaunch(storyId: string, fresh: boolean): Promise<"adopted" | "launched"> {
  const name = storyAgentName(storyId);
  if (!fresh && (await harness.agentExists(name))) {
    const row = getStoryAgentRow(storyId);
    if (claudeLiveness(row?.session_id) !== "dead") {
      // alive OR unknown → adopt the live/maybe-live agent (never double-launch).
      await adoptStoryAgent(storyId);
      return "adopted";
    }
    // pane exists but claude is PROVABLY dead (reboot) → tear down the stale pane/tab and
    // free the name before relaunching, so there's no duplicate/zombie pane.
    console.log(
      `[butchr] story leader for ${storyId} has a registered pane but a DEAD claude (host reboot suspected) — tearing down the stale pane and relaunching (--resume)`,
    );
    await harness.teardownTask(name).catch(() => {});
    await harness.agentDeregister(name).catch(() => {});
  }
  await performLaunch(storyId, fresh);
  return "launched";
}

/**
 * The guarded START core shared by startStoryAgent and reconcileStoryAgent: mark
 * DESIRED-up, reset backoff, then adopt-or-launch (a SINGLE liveness probe), resetting the
 * supervised-restart counter on a fresh launch. Returns BOTH the action and the status.
 */
function ensureStoryStarted(
  storyId: string,
  fresh: boolean,
): Promise<{ action: "adopted" | "launched"; status: StoryAgentStatus }> {
  let action: "adopted" | "launched" = "launched";
  const status = guarded(storyId, async () => {
    saveRow(storyId, { desired: 1 });
    const st = storyState(storyId);
    st.consecutiveFailures = 0;
    st.nextRetryAt = 0;
    action = await adoptOrLaunch(storyId, fresh);
    if (action === "launched") {
      saveRow(storyId, { restarts: 0 }); // a manual (re)launch resets the counter
    }
    return storyAgentStatus(storyId);
  });
  return status.then((s) => ({ action, status: s }));
}

/**
 * START (or adopt) a story's leader. Marks it DESIRED-up (so the supervisor keeps it
 * alive), then adopts a live agent (single-instance) or launches — RESUMING the persisted
 * session unless `fresh`. A manual start resets the supervised-restart counter.
 */
export function launchStoryAgent(storyId: string, opts: { fresh?: boolean } = {}): Promise<StoryAgentStatus> {
  return ensureStoryStarted(storyId, !!opts.fresh).then((r) => r.status);
}

/**
 * STOP a story's leader: mark it DESIRED-down (survives a restart) and tear down its
 * tab/pane + free its agent name. Idempotent. Best-effort teardown.
 *
 * ROBUST to the story vanishing mid-teardown: unlike the CTO path (where unregisterWorkspace
 * AWAITS stopCtoAgent before the workspace DELETE), deleteStory is SYNCHRONOUS and fires
 * this fire-and-forget, so the story (and its cascade-linked story_agent row) can disappear
 * while teardown is in flight. We therefore only write story_agent while the story still
 * exists — a save against a deleted story would violate the FK. This is the only divergence
 * from cto-agent.stopCtoAgent and is justified by deleteStory's sync signature.
 */
export function stopStoryAgent(storyId: string): Promise<StoryAgentStatus> {
  return guarded(storyId, async () => {
    if (getStoryRow(storyId)) saveRow(storyId, { desired: 0 });
    const st = storyState(storyId);
    st.consecutiveFailures = 0;
    st.nextRetryAt = 0;
    const name = storyAgentName(storyId);
    await harness.teardownTask(name).catch(() => {});
    await harness.agentDeregister(name).catch(() => {});
    if (getStoryRow(storyId)) {
      saveRow(storyId, { started_at: null });
    }
    console.log(`[butchr] stopped story leader for ${storyId}`);
    return storyAgentStatus(storyId);
  });
}

/**
 * RESTART a story's leader. By default RESUMES the same session (a clean bounce); `fresh`
 * forces a brand-new session (last-resort context hygiene).
 */
export async function restartStoryAgent(
  storyId: string,
  opts: { fresh?: boolean } = {},
): Promise<StoryAgentStatus> {
  await stopStoryAgent(storyId);
  return launchStoryAgent(storyId, { fresh: opts.fresh });
}

/** A story's current managed leader-agent status (probes herdr for live registration). */
export async function storyAgentStatus(storyId: string): Promise<StoryAgentStatus> {
  const row = getStoryAgentRow(storyId);
  const running = await harness.agentExists(storyAgentName(storyId)).catch(() => false);
  return {
    storyId,
    desired: !!(row && row.desired === 1),
    running,
    sessionId: row?.session_id ?? null,
    since: row?.started_at ?? null,
    restarts: row?.restarts ?? 0,
    lastError: row?.last_error ?? null,
  };
}

/** Reconcile ONE story's leader toward its desired state (see reconcileStoryAgents). */
export async function reconcileStoryAgent(
  storyId: string,
  herdrUp: boolean,
): Promise<{ action: "disabled" | "skipped" | "stopped" | "adopted" | "launched" }> {
  if (!isStoryLeaderDesired(getStoryRow(storyId))) return { action: "disabled" };
  if (!herdrUp) return { action: "skipped" };
  const row = getStoryAgentRow(storyId);
  if (row && row.desired === 0 && row.updated_at) {
    // The story is open but its leader was explicitly stopped before this restart — honor it.
    return { action: "stopped" };
  }
  const { action } = await ensureStoryStarted(storyId, false);
  return { action };
}

/**
 * BOOT RECONCILE: bring EVERY open story's leader into its desired state once, before the
 * supervisor starts (see index.ts). Mirrors reconcileCtoAgents. With herdr down we defer
 * to the supervisor. Returns aggregate counts.
 */
export async function reconcileStoryAgents(
  herdrUp: boolean,
): Promise<{ adopted: number; launched: number; skipped: number }> {
  // SINGLE-SUPERVISION GUARD (story st-540ba705, step 6b): when the unified-workspace
  // supervisor is ON it is the SOLE authority over the cto/leader agents (it re-adopts
  // them BY NAME from the migrated `workspace` rows). This legacy per-kind path then
  // no-ops so no leader is double-supervised — a belt-and-suspenders guard atop index.ts
  // boot already skipping it. Read directly off config to avoid a workspace-agent import.
  if (config.unifiedWorkspaceEnabled) return { adopted: 0, launched: 0, skipped: 0 };
  let adopted = 0;
  let launched = 0;
  let skipped = 0;
  const stories = db.query<{ id: string }, []>(`SELECT id FROM stories`).all();
  for (const s of stories) {
    try {
      const res = await reconcileStoryAgent(s.id, herdrUp);
      if (res.action === "adopted") adopted++;
      else if (res.action === "launched") launched++;
      else if (res.action === "skipped") skipped++;
    } catch (e) {
      saveRow(s.id, { last_error: (e as Error).message });
      console.error(`[butchr] story leader reconcile failed for ${s.id}: ${(e as Error).message}`);
    }
  }
  return { adopted, launched, skipped };
}

// One supervision tick over ALL story leaders (mirrors cto-agent.superviseTick).
async function superviseTick(): Promise<void> {
  // SINGLE-SUPERVISION GUARD (step 6b): no-op while the unified-workspace supervisor owns
  // the cto/leader agents (see reconcileStoryAgents) — so even a still-running legacy timer
  // can't double-supervise. Mirrors the cto-agent guard.
  if (config.unifiedWorkspaceEnabled) return;
  for (const row of listStoryAgentRows()) {
    await superviseStory(row.story_id);
  }
}

async function superviseStory(storyId: string): Promise<void> {
  if (!isStoryLeaderDesired(getStoryRow(storyId))) return;
  const st = storyState(storyId);
  if (st.launchInFlight) return; // a start/stop/restart is mid-flight — don't race it
  const row = getStoryAgentRow(storyId);
  if (!row || row.desired !== 1) return; // wanted down (or never started)

  const name = storyAgentName(storyId);
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
    `[butchr] story leader for ${storyId} died — relaunching (attempt ${st.consecutiveFailures}/${config.ctoMaxRestarts}, resuming session)`,
  );
  await guarded(storyId, async () => {
    const before = getStoryAgentRow(storyId)?.restarts ?? 0;
    await performLaunch(storyId, false); // resume the SAME session — never cold-start
    saveRow(storyId, { restarts: before + 1 });
    return storyAgentStatus(storyId);
  }).catch((e) => {
    const msg = (e as Error).message;
    saveRow(storyId, { last_error: msg });
    console.error(`[butchr] story leader relaunch failed for ${storyId}: ${msg}`);
    if (st.consecutiveFailures >= config.ctoMaxRestarts) {
      console.error(
        `[butchr] story leader for ${storyId} gave up after ${config.ctoMaxRestarts} relaunch attempts`,
      );
    }
  });
}

/** Start the story-leader supervisor poll loop (no-op if already running). */
export function startStoryAgentSupervisor(): void {
  if (superviseTimer) return;
  superviseTimer = setInterval(() => void superviseTick(), config.ctoSuperviseMs);
}

/** Stop the supervisor loop (clean shutdown). Does NOT kill the live leaders — their panes
 *  survive so the next boot can ADOPT and resume them, like the CTO agents. */
export function stopStoryAgentSupervisor(): void {
  if (superviseTimer) clearInterval(superviseTimer);
  superviseTimer = null;
}

// ---- LIFECYCLE HOOKS (called from stories.ts / workspaces.ts) ---------------

/**
 * Hook: a story was CREATED (lands `open`). Mark its leader DESIRED synchronously (so the
 * story_agent row exists immediately) then fire the launch best-effort (fire-and-forget —
 * never fails/blocks story creation; a launch error is recorded on the row).
 */
export function onStoryCreated(storyId: string): void {
  saveRow(storyId, { desired: 1 }); // legacy story_agent MIRROR (kept; unified row is authoritative)
  if (config.unifiedWorkspaceEnabled) {
    // UNIFIED CREATE-TIME ROW (story st-93384200, Bug 3): materialize this leader's unified
    // `workspace` row NOW so the unified supervisor — the SOLE launcher when the flag is ON —
    // launches AND relaunches-on-death it immediately, without waiting for a restart to re-seed
    // it from the legacy table. We early-RETURN so the legacy DIRECT launch below does NOT also
    // fire: exactly one launcher → no double-launch / herdr-name collision (the legacy story
    // superviseTick already self-gates while unified is ON — see reconcileStoryAgents above).
    const story = getStoryRow(storyId);
    if (!story) {
      // A story ALWAYS has a workspace_id; a missing row here is a real error, NOT a
      // null-directory_id row to insert silently — such a row would be invisible to
      // unregisterWorkspace's `directory_id=? AND kind IN ('cto','leader')` enumeration (story
      // st-93384200 Bug 2), reintroducing the leak/race that fix closed. Record + bail.
      saveRow(storyId, { last_error: `onStoryCreated: story ${storyId} not found — skipped unified ws-leader row` });
      console.error(`[butchr] story leader create skipped for ${storyId}: story row not found`);
      return;
    }
    // FK ANCHOR: the leader row's work_id references the story's MATERIALIZED Work node in
    // `tasks` (workspace.work_id FK). A story member materializes it lazily (createTask /
    // assignTaskToStory), but a story can be created with NO members yet — so materialize it NOW
    // (idempotent INSERT OR IGNORE) or the ws-leader insert below FK-fails. Mirrors the boot
    // migrateUnifyStoryParent anchor write (the leader migration assumes the node already exists).
    ensureStoryWorkNode(storyId);
    const wsId = `ws-leader-${storyId}`;
    // directory_id = the story's workspace (NEVER null — guarded above), so the row is visible to
    // unregister enumeration; work_id binds it to the story node; has_agent 0 on create.
    ensureWorkspaceAgentRow(wsId, { kind: "leader", work_id: storyId, directory_id: story.workspace_id });
    saveWorkspaceAgentRow(wsId, { desired: 1 });
    // Optional low-latency kick: launch NOW instead of waiting for the next supervise tick.
    // startWorkspaceAgent serializes through the SAME per-id launchInFlight guard the supervisor
    // uses (workspace-agent.guarded), so a kick racing a concurrent supervise tick JOINS the
    // in-flight launch rather than double-launching.
    void startWorkspaceAgent(wsId).catch((e) => {
      saveRow(storyId, { last_error: (e as Error).message });
      console.error(`[butchr] story leader launch failed for ${storyId}: ${(e as Error).message}`);
    });
    return;
  }
  void launchStoryAgent(storyId).catch((e) => {
    saveRow(storyId, { last_error: (e as Error).message });
    console.error(`[butchr] story leader launch failed for ${storyId}: ${(e as Error).message}`);
  });
}

/**
 * Hook: a story's STATUS changed. `open` → (re)desire + launch the leader; `done`/`aborted`
 * → stop it (desired-down + teardown). `merging`/`merge_blocked` KEEP the leader up (no-op:
 * the leader is mid-completion and must stay alive to re-attempt — CONTRIBUTING §11.7, Phase
 * E; isStoryLeaderDesired keeps it desired so the supervisor relaunches it if it dies).
 * Best-effort; never throws into the CRUD caller.
 */
export function onStoryStatusChanged(storyId: string, status: string): void {
  if (status === "open") {
    onStoryCreated(storyId);
  } else if (status === "done" || status === "aborted") {
    void stopStoryAgent(storyId).catch((e) => {
      console.error(`[butchr] story leader stop failed for ${storyId}: ${(e as Error).message}`);
    });
  }
  // merging / merge_blocked: leave the leader up (no teardown, no relaunch) — it is already
  // running and stays desired so it can re-attempt the land / fix a RED re-gate.
}

/**
 * Stop EVERY story leader belonging to a workspace (best-effort), called from
 * unregisterWorkspace BEFORE the workspace DELETE so no leader pane is orphaned. The
 * story_agent rows themselves cascade away with the stories/workspace DELETE. Mirrors how
 * unregisterWorkspace calls stopCtoAgent. Awaitable so the caller can sequence teardown.
 */
export async function stopWorkspaceStoryAgents(workspaceId: string): Promise<void> {
  const stories = db
    .query<{ id: string }, [string]>(`SELECT id FROM stories WHERE workspace_id=?`)
    .all(workspaceId);
  for (const s of stories) {
    await stopStoryAgent(s.id).catch(() => {});
  }
}

/** Test-only: run a single supervision tick (one story) synchronously. */
export async function _superviseTickForTest(storyId: string): Promise<void> {
  await superviseStory(storyId);
}

/** Test-only: reset the in-memory backoff state for a story between cases. */
export function _resetSupervisionStateForTest(storyId?: string): void {
  if (storyId) {
    storyStates.delete(storyId);
  } else {
    storyStates.clear();
  }
}
