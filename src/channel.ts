// ONE-WAY CTO NOTIFICATION CHANNEL (Claude Code Channels, research preview).
//
// The long-running CTO agent currently has to POLL butchr to learn that a task
// wants its attention. This module is a tiny STDIO bridge that gives that agent a
// PUSH feed instead: it speaks the Claude Code "channel" contract on top of MCP over
// stdio, subscribes to butchr's EXISTING SSE event stream (`GET /api/events`), and
// for every task that ENTERS an attention state writes a one-way channel
// notification to stdout. The CTO's Claude Code surfaces that line into the running
// session so it reacts immediately instead of waiting for its next poll.
//
// It is launched as a SEPARATE process by the CTO's Claude Code (see src/workspace-agent.ts), NOT
// hosted inside butchr — so it talks to butchr over the network (SSE), exactly like
// the dashboard does, and reconnects when that stream drops.
//
// ONE-WAY ONLY. We advertise ONLY `experimental['claude/channel']` in the
// initialize result — NO `tools` capability, NO reply tool, NO permission relay.
// The bridge can push to the CTO; the CTO cannot push back through it.
//
// ZERO new deps: this hand-rolls the MCP stdio framing (newline-delimited JSON-RPC)
// the same way src/mcp.ts hand-rolls the Streamable-HTTP framing. The only butchr
// import is `config` (for the default SSE URL); everything else is self-contained so
// the pieces stay unit-testable without a live butchr or a real claude.
import { config } from "./config.ts";
import { ATTENTION_STATES } from "./db.ts";
import { humanizeMs } from "./duration.ts";
import {
  isNotificationOrIdless,
  type JsonRpcMessage,
  jsonRpcError,
  jsonRpcResult,
  PROTOCOL_VERSION,
} from "./jsonrpc.ts";
import { clipLine } from "./text.ts";

// What the CTO's Claude Code sees as the channel source name + the human-facing
// blurb describing what these notifications mean.
export const CHANNEL_SERVER_NAME = "butchr-cto-channel";
export const CHANNEL_INSTRUCTIONS =
  "One-way notification channel. Each <" +
  CHANNEL_SERVER_NAME +
  "> event is a butchr task or story that just entered a state needing YOUR attention " +
  "(a brief awaiting a spec — `spec requested`, a generated spec awaiting approval, a " +
  "diff awaiting review, an agent question awaiting an answer, a failed task, a LIVE " +
  "build agent that went IDLE — `agent idle`, carrying a snapshot of what it was doing, " +
  "or a STORY-LEVEL notification — a story ask, a completion review, or a completed " +
  "story) — the same attention feed a human sees in the butchr dashboard. These are PUSH " +
  "notifications to ACT on (write+submit a spec, approve/reject/answer/requeue, or for an " +
  "idle agent: nudge-with-guidance/requeue/abort — via the butchr API or CLI); you cannot " +
  "reply through this channel. Routing is STRUCTURAL: butchr delivers each item to the " +
  "responder that OWNS it (a story LEADER sees only its OWN story's subtasks + its " +
  "ask-answered notifications; the CTO sees NON-STORY tasks + story-level asks + " +
  "story-completion). Everything that arrives HERE is yours to handle — act on it. One " +
  "GLOBAL event also arrives here: `connectivity_restored` — the host's network/model-API " +
  "came back after an outage (carrying how long it was down); it is informational, not a " +
  "task to act on.";

// The instructions for a CONNECTIVITY-ONLY bridge (the WORKER channel): it delivers
// nothing but the global connectivity-restored broadcast, so it must NOT describe the
// CTO attention feed (a build agent is not a CTO and never sees those events here).
export const CONNECTIVITY_ONLY_INSTRUCTIONS =
  "One-way connectivity channel. The ONLY event delivered here is " +
  "`connectivity_restored`: the host's network/model-API connectivity came back after " +
  "an outage (it carries how long it was down). If your work was interrupted by the " +
  "outage, re-orient — re-check what you have, re-commit anything lost, and continue. " +
  "You cannot reply through this channel.";

/**
 * The CTO attention transitions we push. `idea` (a brief awaiting a spec — surfaced as
 * `spec requested`) is the front of the pipeline; the rest are the feedback/failure
 * states: spec_review / in_review / needs_info, plus the two terminal failure states
 * `failed` (an execution failure) and `aborted`. Both terminal states are LIVE and
 * DISTINCT in the 12-state machine — `failed` is NOT folded into `aborted` — so each
 * fires its own notification. The membership lives ONCE in db.ts (shared with the
 * operator dashboard's REVIEW_STATES) and is re-exported here for the bridge + its tests.
 */
export { ATTENTION_STATES };
export type AttentionState = (typeof ATTENTION_STATES)[number];

function isAttentionState(s: unknown): s is AttentionState {
  return typeof s === "string" && (ATTENTION_STATES as readonly string[]).includes(s);
}

// A short human phrase per attention state for the notification's content line.
const STATE_PHRASE: Record<AttentionState, string> = {
  idea: "spec requested",
  spec_review: "generated spec awaiting approval",
  in_review: "diff awaiting review",
  needs_info: "agent question awaiting an answer",
  failed: "task failed",
  aborted: "task failed",
  // A CEO directive landed under this repo — the CTO accepts&decomposes it into stories or escalates
  // it back up the ladder (RFC Q1 directive machinery).
  directive: "CEO directive",
};

// The IDLE condition is orthogonal to status (a flag on a LIVE in_progress build agent,
// not a 13th state — see FW-4), so it has its own phrase + `meta.state="idle"` rather than
// living in STATE_PHRASE/ATTENTION_STATES. It surfaces a stalled/quiet agent to the
// `idle-handling` responder to act on gracefully (nudge-with-guidance, requeue, or abort).
const IDLE_PHRASE = "agent idle — needs idle-handling";

// The DEAD-BLOCKED condition (F3) is, like idle, ORTHOGONAL to the attention STATES: a `blocked`
// task whose precomputed `deadBlockers` set is non-empty is PERMANENTLY stuck on a never-merging
// dependency (an aborted/failed/rolled_back or deleted blocker). butchr never auto-promotes it —
// by design the escape is an operator editing blocked_by — so without a push it would sit stuck
// silently. We do NOT fold `blocked` into ATTENTION_STATES (that would push EVERY blocked task);
// instead it is a CONDITIONAL surface keyed on the deadBlockers set, with its own phrase +
// `meta.state="dead_blocked"`. It surfaces the stuck task to the CTO/operator to unblock it.
const DEAD_BLOCKED_PHRASE =
  "blocked on a DEAD (never-merging) dependency — edit blocked_by to proceed";

// STORY-LEVEL attention phrases (STORIES epic — the story→main merge model, CONTRIBUTING
// §11, plus the responder-redesign ask seam, §4b). These are NOT task status transitions but
// story-scoped notifications routed by `target` (see AttentionBridge.consumeStoryAttention),
// SPLIT by who can act:
//   - LEADER feed (target:'story'): `completion-review` (all subtasks merged → verify the
//     goal), `member-blocked` (the story settled with a failed/aborted member, so it is stuck
//     OPEN and can never all-merge on its own — the leader adds a replacement subtask or abandons
//     it, F4), `gate-red` (the assembled story failed its re-gate / post-merge verify — the
//     leader fixes it with more subtasks, §11.5), and `ask-answered` (the leader's open ask
//     was answered).
//   - WORKSPACE/CTO feed (target:'cto'): `complete` (the leader marked the story done),
//     `merge-conflict` (the story↔main rebase conflicted — a CTO/human git action in the
//     story worktree, §11.4; the leader has no worktree and cannot resolve it), `ask` (a
//     leader raised a story-level ask to the CTO; a target:user escalation is DROPPED by every
//     bridge — the dashboard surfaces it; see consumeStoryAttention), and `leader-idle` (the
//     story leader went genuinely idle while still owning ≥1 actionable item — the operator
//     generalization of the build-agent idle→responder signal, bubbled to its higher-up the CTO;
//     story st-a32c8138).
// Each carries its own `meta.state` so a recipient can branch on the surface, mirroring
// STATE_PHRASE/IDLE_PHRASE for the task surfaces.
const STORY_ATTENTION: Record<
  | "completion-review"
  | "complete"
  | "gate-red"
  | "merge-conflict"
  | "ask"
  | "ask-answered"
  | "member-blocked"
  | "leader-idle"
  | "updated",
  { phrase: string; state: string }
> = {
  "completion-review": { phrase: "story ready for completion review", state: "story_completion_review" },
  "member-blocked": { phrase: "story BLOCKED — a member failed/aborted; add a replacement subtask or abandon the story", state: "story_member_blocked" },
  complete: { phrase: "story complete", state: "story_complete" },
  "gate-red": { phrase: "story gate RED — fix with more subtasks", state: "story_gate_red" },
  "merge-conflict": { phrase: "story↔main MERGE CONFLICT — resolve in the story worktree", state: "story_merge_conflict" },
  ask: { phrase: "story ask awaiting an answer", state: "story_ask" },
  "ask-answered": { phrase: "story ask answered", state: "story_ask_answered" },
  "leader-idle": { phrase: "leader IDLE with work awaiting it", state: "story_leader_idle" },
  // The CTO amended a PARKED story's brief (the `update` verb, story st-7a7b0654 S2) — its leader
  // is not live to steer, so re-surface the revised instruction on the CTO feed. The node-tier
  // sibling of the leaf's INSTRUCTION_UPDATED_PHRASE (a story has a brief, not a task.md).
  updated: { phrase: "story instruction UPDATED — re-read the brief + re-review", state: "story_instruction_updated" },
};

// The phrase for an operator INSTRUCTION-UPDATE re-surface (the `update` verb — story
// st-7a7b0654). A one-shot signal, NOT a status: an operator amended a work item's brief
// while it sits PARKED in a feedback state, so its owner (a subtask's story leader, a
// non-story task's CTO, …) must re-read the revised task.md and re-review. It rides the
// task-attention routing (routeOwns + pending_responder), so it carries its own phrase +
// `meta.state="instruction_updated"` like IDLE_PHRASE/DEAD_BLOCKED_PHRASE.
const INSTRUCTION_UPDATED_PHRASE = "instruction UPDATED — re-read task.md + re-review";

// The human phrase for the GLOBAL connectivity-restored broadcast. Unlike the
// attention/idle notifications this is NOT tied to a task or workspace — the network
// the AGENTS need is back, so every connected session (CTO + each live worker) should
// re-orient (re-check its work, re-commit anything lost) and continue.
const CONNECTIVITY_RESTORED_PHRASE =
  "network connectivity RESTORED — the model API is reachable again. If your work was " +
  "interrupted by the outage, re-orient: re-check what you have, re-commit anything " +
  "lost, and continue.";

/** The channel notification payload (params of `notifications/claude/channel`). */
export type ChannelNotification = {
  content: string;
  // Identifier-keyed metadata (keys are bare identifiers: letters/digits/underscore).
  // Always carries `state`; task-scoped notifications add task_id/workspace, while the
  // GLOBAL connectivity-restored broadcast carries restored_at/down_ms instead.
  meta: { state: string } & Record<string, string | number>;
};

// --- initialize result -------------------------------------------------------

/**
 * The MCP `initialize` result for a ONE-WAY channel: it advertises the channel
 * capability under `experimental` and DELIBERATELY omits `tools` (and everything
 * else). Pure + exported so a test can assert the one-way shape.
 */
export function channelInitializeResult(
  requestedProtocol?: string,
  connectivityOnly = false,
): {
  protocolVersion: string;
  capabilities: { experimental: { "claude/channel": Record<string, never> } };
  serverInfo: { name: string; version: string };
  instructions: string;
} {
  return {
    protocolVersion:
      typeof requestedProtocol === "string" ? requestedProtocol : PROTOCOL_VERSION,
    // ONE-WAY: channel capability only. No `tools`, no `resources`, no `prompts`.
    capabilities: { experimental: { "claude/channel": {} } },
    serverInfo: { name: CHANNEL_SERVER_NAME, version: "1.0.0" },
    instructions: connectivityOnly ? CONNECTIVITY_ONLY_INSTRUCTIONS : CHANNEL_INSTRUCTIONS,
  };
}

// --- the attention bridge ----------------------------------------------------

/** Collapse whitespace + truncate a free-form field for a single-line notification. */
function tidy(text: unknown, max = 280): string {
  if (typeof text !== "string") return "";
  return clipLine(text, max);
}

/** First non-empty tidied string among the candidates ("" if none). */
function firstText(...candidates: unknown[]): string {
  for (const c of candidates) {
    const t = tidy(c);
    if (t) return t;
  }
  return "";
}

/**
 * The most relevant human text for an attention state, pulled from the serialized
 * TaskView the same way the dashboard surfaces it: the agent's question for
 * needs_info, the request_review summary for in_review, the generated spec for
 * spec_review, and the failure reason for a failed/aborted task.
 */
function attentionText(task: Record<string, unknown>, state: AttentionState): string {
  switch (state) {
    case "idea":
      // The brief (the idea task's prompt) is what the responder needs to write a spec.
      return firstText(task.prompt, task.summary);
    case "needs_info":
      return firstText(task.question, task.summary);
    case "in_review":
      return firstText(task.summary, task.review_note);
    case "spec_review":
      // The generated spec lives in the task's prompt (task.md); summary is a fallback.
      return firstText(task.summary, task.prompt);
    case "directive":
      // The directive brief (what the CTO must turn into stories) lives in the task's prompt
      // (task.md); summary is a fallback.
      return firstText(task.prompt, task.summary);
    case "failed":
    case "aborted":
      // Both terminal failure states surface the execution/dispatch error the same way.
      return firstText(
        task.last_dispatch_error,
        task.revert_reason,
        task.review_note,
        task.summary,
      );
  }
}

/**
 * Stateful translator from butchr's SSE events to channel notifications. It is the
 * pure core of the bridge (no I/O): feed it each parsed event via `consume`, and it
 * returns a ChannelNotification exactly when a task ENTERS an attention state, or
 * null otherwise. Resilient by construction — a malformed/irrelevant event simply
 * yields null and never throws.
 *
 * "Entering" is detected by remembering each task's last-seen status: we emit only
 * when the status CHANGED into an attention state, so a task.updated that merely
 * touches a task already in (say) in_review does not re-notify, and a reconnect
 * (which replays no history) cannot re-fire a transition we already saw this run.
 *
 * It ALSO emits on a RESPONDER transition while the task is already on an attention
 * surface — a non-story task's cto→user escalation (escalated_to_user) — by remembering
 * each task's last-seen resolved responder alongside its status (see lastResponder). Which
 * channel a given event flows to is decided by SCOPE: a STORY-leader bridge
 * (BUTCHR_CHANNEL_STORY) gets its OWN story's subtasks' feedback + failures (always
 * responder 'story' — terminal at the leader), while a WORKSPACE/CTO bridge
 * (BUTCHR_CHANNEL_WORKSPACE, or unscoped) gets NON-STORY tasks awaiting the CTO. See
 * routeOwns.
 */

// Insertion-ordered key set with a hard FIFO cap: on add past the cap, the OLDEST
// key is evicted. Used to bound the story de-dup set (see deliveredStory). A re-add of
// an evicted key is treated as new (it would re-emit) — acceptable because eviction only
// happens after thousands of distinct markers, far beyond any live re-fire window.
const DELIVERED_STORY_CAP = 2000;
export class BoundedKeySet {
  private set = new Set<string>();
  constructor(private readonly cap: number) {}
  has(key: string): boolean {
    return this.set.has(key);
  }
  add(key: string): void {
    if (!this.set.has(key) && this.set.size >= this.cap) {
      // evict the oldest (first-inserted) entry — Set preserves insertion order
      const oldest = this.set.keys().next().value;
      if (oldest !== undefined) this.set.delete(oldest);
    }
    this.set.add(key);
  }
  get size(): number {
    return this.set.size;
  }
}

export class AttentionBridge {
  private lastStatus = new Map<string, string>();
  // Per-task last-seen IDLE flag, tracked SEPARATELY from status because idle is a flag
  // on an in_progress agent, not a status — we emit an idle notification only on the
  // 0→1 flip (mirrors the lastStatus "entering" logic, so a re-render of an
  // already-idle task does not re-notify).
  private lastIdle = new Map<string, boolean>();
  // Per-task last-seen DEAD-BLOCKED flag (status==='blocked' with a non-empty deadBlockers set),
  // tracked like lastIdle: a CONDITIONAL attention surface, not a status, so we emit only on the
  // 0→1 flip (a re-render of an already-dead-blocked task does not re-notify). See DEAD_BLOCKED_PHRASE.
  private lastDeadBlocked = new Map<string, boolean>();
  // Per-task last-seen RESOLVED RESPONDER ('story'|'cto'|'user'|null), tracked alongside
  // status/idle so a RESPONDER TRANSITION fires even when the status itself did not change:
  // a non-story task's cto→user escalation (escalated_to_user) must (re)notify so the user
  // tier is surfaced. We emit only on an ACTUAL change (prev !== current), so a same-status
  // re-render with an unchanged responder never re-fires.
  private lastResponder = new Map<string, string | null>();
  // DELIVERED STORY-CONTAINER notifications (story.attention), keyed `storyId|target|reason|marker`
  // — the de-dup set that makes a story.attention deliver EXACTLY ONCE across a reconnect/restart
  // gap (the st-ad96e5c3 follow-up to st-fffc76a8's leaf resync). Unlike the leaf surfaces, a
  // story.attention has no per-id "last status" to diff, so a re-fed event is suppressed by membership
  // here instead. Only events carrying a `marker` participate (completion-review / gate-red /
  // member-blocked / the CTO `ask`); a markerless reason (ask-answered / complete / merge-conflict) is
  // never resynced, so it is emitted as before and never recorded. The marker MONOTONICALLY changes on
  // a legitimate re-fire (e.g. completion-review's rising merged-count), so a genuine re-fire gets a new
  // key and still emits, while a reconnect-resync re-derives the SAME key and is suppressed.
  // BOUNDED with a FIFO cap (not pruned on story terminal): there is NO story.deleted/terminal
  // event on this consume stream — `story.attention` is the only story-lifecycle signal — so there
  // is nothing to hang a prune-on-delete handler off of. An `ask` marker is the full pending_ask
  // text, so distinct asks accrete permanently; the cap evicts oldest to bound that slow leak.
  private deliveredStory = new BoundedKeySet(DELIVERED_STORY_CAP);
  // workspace_id -> human label, populated from workspace.* events on the same
  // stream (and optionally seeded once at startup). Used only for the content line;
  // meta.workspace is always the stable workspace_id.
  private dirLabels = new Map<string, string>();
  // PER-WORKSPACE SCOPE. When set (the workspace_id passed at construction — from
  // BUTCHR_CHANNEL_WORKSPACE), the bridge emits notifications ONLY for tasks in THAT
  // workspace, so each per-repo CTO agent receives only its OWN workspace's attention
  // events. Unset (empty/undefined) → unscoped: every workspace's events flow (the
  // legacy global feed).
  private readonly scopeDir: string;
  // PER-STORY SCOPE (the story-leader feed; from BUTCHR_CHANNEL_STORY). When set, the bridge
  // runs in STORY mode: it emits an attention event for a task IFF the task belongs to THIS
  // story (story_id === scopeStory) AND the item is the leader's to own — its feedback
  // (resolved responder 'story' — subtask feedback is TERMINAL at the leader) OR a failure
  // (failed/aborted). Unset → the bridge runs in WORKSPACE/CTO mode (the scopeDir feed
  // below). See routeOwns.
  private readonly scopeStory: string;
  // PER-PROJECT SCOPE (the CEO feed; from BUTCHR_CHANNEL_PROJECT). REVAMP-4 P3b (story
  // st-1a82a2e1): the project generalization of scopeStory. When set, the bridge runs in PROJECT
  // mode and emits an attention event for a task IFF the task's OWNING PROJECT (project_id ===
  // scopeProject) matches AND the item is the CEO's to own — its feedback (resolved responder
  // 'ceo' — a project-direct child's feedback is terminal at the CEO) OR a failure/dead-blocked
  // item in the project's subtree. Unset → the bridge runs in STORY or WORKSPACE/CTO mode. DORMANT:
  // no CEO agent sets this in prod yet (P3c) and no project nodes exist (P3d), so every current
  // shape leaves this empty and routing is byte-identical. See routeOwns.
  private readonly scopeProject: string;
  // CONNECTIVITY-ONLY mode. When true (the WORKER bridge), consume() emits ONLY the
  // global `connectivity.restored` broadcast and SUPPRESSES every attention/idle
  // notification — a live build agent must NEVER see another task's review/idle/
  // attention events (that would be a confusing leak). The CTO bridge leaves this OFF
  // and gets the full attention feed PLUS connectivity.
  private readonly connectivityOnly: boolean;

  constructor(
    scopeDir?: string,
    connectivityOnly = false,
    scopeStory?: string,
    scopeProject?: string,
  ) {
    this.scopeDir = (scopeDir ?? "").trim();
    this.connectivityOnly = connectivityOnly;
    this.scopeStory = (scopeStory ?? "").trim();
    this.scopeProject = (scopeProject ?? "").trim();
  }

  /** Seed the workspace-label cache (best-effort, e.g. from GET /api/workspaces). */
  seedWorkspaceLabels(dirs: Array<{ id?: unknown; label?: unknown }>): void {
    for (const d of dirs) {
      if (d && typeof d.id === "string" && typeof d.label === "string" && d.label) {
        this.dirLabels.set(d.id, d.label);
      }
    }
  }

  /**
   * Consume one parsed SSE event. Returns a notification on an attention transition,
   * else null. Never throws on malformed input.
   */
  consume(event: unknown): ChannelNotification | null {
    if (!event || typeof event !== "object") return null;
    const e = event as Record<string, unknown>;

    // GLOBAL connectivity-restored broadcast — handled FIRST, BEFORE the scope/mode
    // gates and the task-event handling, because it is neither workspace-scoped nor
    // task-scoped: the network the AGENTS need is back, so EVERY connected session
    // gets it (any scopeDir, AND in connectivity-only mode). EVENT-ONLY — it just
    // surfaces the recovery; the recipient decides what to do.
    if (e.type === "connectivity.restored") {
      const restoredAt = typeof e.restoredAt === "string" ? e.restoredAt : "";
      const downMs = typeof e.downMs === "number" && e.downMs >= 0 ? e.downMs : 0;
      const dur = downMs > 0 ? `~${humanizeMs(downMs)}` : "an unknown period";
      const content = `${CONNECTIVITY_RESTORED_PHRASE} (was down ${dur})`;
      return {
        content,
        meta: { state: "connectivity_restored", restored_at: restoredAt, down_ms: downMs },
      };
    }

    // CONNECTIVITY-ONLY (the worker bridge): nothing past the connectivity broadcast
    // above is delivered — no attention, no idle, no label tracking.
    if (this.connectivityOnly) return null;

    // STORY-LEVEL attention (Phase 6) — a story-scoped notification that is NOT a task
    // status transition, so it is handled here BEFORE the task-event gates. `target`
    // decides which feed owns it: a `completion-review` event goes to the STORY LEADER's
    // feed (this bridge must be scoped to that story), a `complete` event goes to the
    // WORKSPACE/CTO feed. Stateless (no de-dup map) — the publishers fire each event once.
    if (e.type === "story.attention") {
      return this.consumeStoryAttention(e);
    }

    // PROJECT-LEVEL initiative completion (RFC Q5 — Phase C1; story st-30a7dccd) — a live push that an
    // initiative has fully landed across its member repos and is READY FOR the CEO's cross-repo review
    // (the project-tier analog of a story's `completion-review`). Owned ONLY by the PROJECT/CEO bridge
    // whose scopeProject matches the event's project; a story/CTO bridge never sees it. Like `complete`
    // it carries no marker — a live signal, never resynced — so it bypasses the reconnect-resync set.
    if (e.type === "initiative.completed") {
      return this.consumeInitiativeCompleted(e);
    }

    // OPERATOR INSTRUCTION-UPDATE re-surface (the `update` verb — story st-7a7b0654). A one-shot
    // live push that a PARKED-in-feedback work item's brief was amended, so its owner must re-read
    // + re-review. Routed to the SAME owner as the item's feedback (routeOwns + pending_responder),
    // but forced (a same-status task.updated would not re-notify). Stateless — it does NOT touch the
    // status/idle/responder diff maps and is never reconnect-resynced.
    if (e.type === "task.instruction_updated") {
      return this.consumeInstructionUpdated(e);
    }

    // Keep the workspace-label cache fresh off the same stream.
    if (e.type === "workspace.created" || e.type === "workspace.updated") {
      const dir = e.workspace as Record<string, unknown> | undefined;
      if (dir && typeof dir.id === "string" && typeof dir.label === "string") {
        this.dirLabels.set(dir.id, dir.label);
      }
      return null;
    }
    if (e.type === "workspace.deleted" && typeof e.id === "string") {
      this.dirLabels.delete(e.id);
      return null;
    }
    if (e.type === "task.deleted" && typeof e.id === "string") {
      this.lastStatus.delete(e.id);
      this.lastIdle.delete(e.id);
      this.lastDeadBlocked.delete(e.id);
      this.lastResponder.delete(e.id);
      return null;
    }
    if (e.type !== "task.updated" && e.type !== "task.created") return null;

    const task = e.task;
    if (!task || typeof task !== "object") return null;
    const t = task as Record<string, unknown>;
    const id = t.id;
    const status = t.status;
    if (typeof id !== "string" || !id || typeof status !== "string") return null;

    const prevStatus = this.lastStatus.get(id);
    this.lastStatus.set(id, status);

    const dirId = typeof t.workspace_id === "string" ? t.workspace_id : "";
    // STORY MEMBERSHIP + RESOLVED RESPONDER, read straight off the serialized TaskView the
    // SSE event carries: taskView already computes `pending_responder` STRUCTURALLY ('story'
    // for a story member — terminal at the leader; 'cto' or 'user' for a non-story task; or
    // null when not awaiting feedback). Reading these fields keeps the bridge a light, DB-free
    // process — it never imports tasks.ts / touches the db.
    const storyId = typeof t.story_id === "string" && t.story_id ? t.story_id : null;
    // The OWNING PROJECT id (REVAMP-4 P3b) — the project mirror of storyId, read off the serialized
    // TaskView's `project_id` (work.projectParentOf: non-null iff the task's immediate parent is a
    // project container, the shape whose responder resolves to 'ceo'). Drives the PROJECT scope in
    // routeOwns. null for every current shape (no project nodes) → routing byte-identical.
    const projectId = typeof t.project_id === "string" && t.project_id ? t.project_id : null;
    const responder =
      typeof t.pending_responder === "string" ? t.pending_responder : null;
    const prevResponder = this.lastResponder.get(id) ?? null;
    this.lastResponder.set(id, responder);

    // The IDLE flag is orthogonal to status (a flag on a LIVE in_progress agent, not a 13th
    // state — see FW-4), so it is tracked separately. We still set lastIdle every event so a
    // re-render of an already-idle task is not a fresh flip.
    const idleNow = status === "in_progress" && (t.idle === 1 || t.idle === true);
    const idlePrev = this.lastIdle.get(id) ?? false;
    this.lastIdle.set(id, idleNow);

    // The DEAD-BLOCKED condition (F3) is, like idle, a CONDITIONAL surface rather than a status: a
    // `blocked` task whose precomputed `deadBlockers` set is non-empty is permanently stuck on a
    // never-merging dependency. Tracked separately so we emit only on the 0→1 flip.
    const deadBlockers = Array.isArray(t.deadBlockers)
      ? (t.deadBlockers as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    const deadBlockedNow = status === "blocked" && deadBlockers.length > 0;
    const deadBlockedPrev = this.lastDeadBlocked.get(id) ?? false;
    this.lastDeadBlocked.set(id, deadBlockedNow);

    // The ATTENTION SURFACE the task is currently on: an attention STATUS, the IDLE condition on a
    // live agent, the DEAD-BLOCKED condition on a blocked task, or none. The surfaces share ONE
    // emit path (below) so a RESPONDER transition fires even when the status itself did not change.
    const surface: "status" | "idle" | "dead_blocked" | null = isAttentionState(status)
      ? "status"
      : idleNow
        ? "idle"
        : deadBlockedNow
          ? "dead_blocked"
          : null;
    if (!surface) return null;

    // EMIT TRIGGER: emit when the task newly ENTERED this surface (status changed into an
    // attention state, or idle flipped 0→1), OR when its resolved responder CHANGED while
    // already on the surface (an escalation 'story'→'cto', or a reset back to 'story' on a
    // fresh feedback event). Both maps are updated above, so a same-status/already-idle
    // re-render with an unchanged responder never re-notifies, and a real change fires once.
    const enteredSurface =
      surface === "status"
        ? prevStatus !== status
        : surface === "idle"
          ? idleNow && !idlePrev
          : deadBlockedNow && !deadBlockedPrev;
    const responderChanged = prevResponder !== responder;
    if (!enteredSurface && !responderChanged) return null;

    // OWNERSHIP: does THIS bridge's scope own the item right now (STORY-leader feed vs
    // WORKSPACE/CTO feed)? A non-owning bridge drops it — and we still updated the tracking
    // maps above, so the OTHER bridge's de-dup stays correct.
    if (
      !this.routeOwns(storyId, projectId, responder, status, dirId, surface === "dead_blocked")
    )
      return null;

    const label = this.dirLabels.get(dirId) || dirId || "(unknown workspace)";
    // ADD story_id to meta ONLY when the task has one, so a STANDALONE task's meta stays
    // byte-for-byte { task_id, workspace, state } (the CTO feed must not regress). project_id is
    // the project mirror (REVAMP-4 P3b): present ONLY on a CEO-owned (project-direct) item — and
    // story_id/project_id are mutually exclusive (a project parent nulls story_id in taskView), so
    // a story item carries story_id, a project item carries project_id, a standalone carries neither.
    // Typed as an explicit Record so the empty branch widens to "no keys" rather than to an
    // OPTIONAL `story_id?: string` — an optional key's `undefined` is not assignable to `meta`'s
    // `string | number` index signature, which is what the spread below feeds.
    const storyMeta: Record<string, string> = storyId ? { story_id: storyId } : {};
    const projectMeta: Record<string, string> = projectId ? { project_id: projectId } : {};
    if (surface === "idle") {
      const ctx = tidy(t.idle_context);
      const content = `[${id}] ${label} — ${IDLE_PHRASE}` + (ctx ? `: ${ctx}` : "");
      return {
        content,
        meta: { task_id: id, workspace: dirId, state: "idle", ...storyMeta, ...projectMeta },
      };
    }
    if (surface === "dead_blocked") {
      const content =
        `[${id}] ${label} — ${DEAD_BLOCKED_PHRASE}` +
        (deadBlockers.length ? `: ${deadBlockers.join(", ")}` : "");
      return {
        content,
        meta: {
          task_id: id,
          workspace: dirId,
          state: "dead_blocked",
          ...storyMeta,
          ...projectMeta,
        },
      };
    }
    const attentionStatus = status as AttentionState;
    const text = attentionText(t, attentionStatus);
    const content =
      `[${id}] ${label} — ${STATE_PHRASE[attentionStatus]}` + (text ? `: ${text}` : "");
    return {
      content,
      meta: { task_id: id, workspace: dirId, state: status, ...storyMeta, ...projectMeta },
    };
  }

  /**
   * Translate a STORY-LEVEL attention event into a channel notification, or null when THIS
   * bridge's scope does not own it. Routing by `target` (the story-scoped vs workspace/CTO
   * feed split — the story analog of routeOwns):
   *  - `target:'story'` (`completion-review` / `gate-red` / `ask-answered`) is owned ONLY by
   *    the STORY-leader bridge whose scopeStory === the event's story_id. A WORKSPACE/CTO
   *    bridge never sees it.
   *  - `target:'cto'` (`complete` / `merge-conflict` / `ask`) is owned by the WORKSPACE/CTO
   *    bridge: NOT a story bridge, and (when workspace-scoped) the event's workspace must match
   *    scopeDir. A story bridge never sees it.
   *  - `target:'ceo'` (a CTO→CEO ask escalation — REVAMP-4 P3f) is owned ONLY by the PROJECT/CEO
   *    bridge whose scopeProject === the event's `project_id` (the ask's owning project). The exact
   *    project mirror of the story branch; a cto/story bridge never sees it.
   *  - `target:'user'` (an ask escalated ABOVE the root container) is owned by NO bridge — `target`
   *    parses to {story, cto, ceo}, so a user-escalated ask yields null here (every bridge stays
   *    silent); the dashboard's SSE consumer surfaces it to the human.
   * Resilient: a missing/unknown field yields null rather than throwing.
   */
  private consumeStoryAttention(e: Record<string, unknown>): ChannelNotification | null {
    const storyId = typeof e.story_id === "string" && e.story_id ? e.story_id : null;
    const dirId = typeof e.workspace_id === "string" ? e.workspace_id : "";
    // The owning PROJECT node of a `ceo`-target ask (REVAMP-4 P3f) — routes to the matching project
    // bridge. null for story/cto/user targets (byte-identical for the current, project-less tree).
    const projectId = typeof e.project_id === "string" && e.project_id ? e.project_id : null;
    // `target` parses to story|cto|ceo — a `user`-escalated ask is intentionally dropped.
    const target =
      e.target === "story" || e.target === "cto" || e.target === "ceo" ? e.target : null;
    const reason =
      e.reason === "completion-review" ||
      e.reason === "complete" ||
      e.reason === "gate-red" ||
      e.reason === "merge-conflict" ||
      e.reason === "ask" ||
      e.reason === "ask-answered" ||
      e.reason === "member-blocked" ||
      e.reason === "leader-idle" ||
      e.reason === "updated"
        ? e.reason
        : null;
    if (!storyId || !target || !reason) return null;

    // OWNERSHIP — does this bridge's scope own the event?
    if (target === "story") {
      if (!this.scopeStory || this.scopeStory !== storyId) return null;
    } else if (target === "ceo") {
      // REVAMP-4 P3f: the CEO/project feed — owned ONLY by the project bridge whose scopeProject
      // matches the ask's owning project. A story-leader OR workspace/CTO bridge never sees it.
      if (!this.scopeProject || this.scopeProject !== projectId) return null;
    } else {
      // target === 'cto' → the WORKSPACE/CTO feed only (never a story-leader OR project/CEO bridge).
      if (this.scopeStory || this.scopeProject) return null;
      if (this.scopeDir && dirId !== this.scopeDir) return null;
    }

    // DE-DUP (the st-ad96e5c3 reconnect-resync seam). A `marker` is a durable, REST-derivable
    // state token the publisher stamps on the event (see events.ts); when present, we record the
    // composite key on first delivery and SUPPRESS any later re-feed of the SAME key — so a
    // story.attention re-synthesized from REST on reconnect (resyncAttention) is delivered exactly
    // once, while a genuine RE-FIRE (a marker that moved — e.g. completion-review's rising
    // merged-count) is a NEW key and still emits. A MARKERLESS reason (ask-answered / complete /
    // merge-conflict) is never resynced, so it bypasses the set and emits as before (recording it
    // would only risk wrongly suppressing a legit live re-fire the bridge can't disambiguate).
    const marker = typeof e.marker === "string" ? e.marker : null;
    if (marker !== null) {
      const key = `${storyId}|${target}|${reason}|${marker}`;
      if (this.deliveredStory.has(key)) return null;
      this.deliveredStory.add(key);
    }

    const { phrase, state } = STORY_ATTENTION[reason];
    const label = this.dirLabels.get(dirId) || dirId || "(unknown workspace)";
    const detail = tidy(e.detail);
    const content = `[${storyId}] ${label} — ${phrase}` + (detail ? `: ${detail}` : "");
    return { content, meta: { story_id: storyId, workspace: dirId, state } };
  }

  /**
   * Translate an `initiative.completed` event into a CEO 'ready for review' notification, or null when
   * THIS bridge's scope does not own it (RFC Q5 — Phase C1). Owned ONLY by the PROJECT/CEO bridge whose
   * scopeProject === the event's project_id — the exact project mirror of a story `completion-review`
   * one tier up. A story-leader OR workspace/CTO bridge never sees it. Resilient: a missing/unknown
   * field yields null rather than throwing. Stateless (no de-dup map) — the publisher fires once and it
   * carries no marker, so it is never reconnect-resynced.
   */
  private consumeInitiativeCompleted(e: Record<string, unknown>): ChannelNotification | null {
    const projectId = typeof e.project_id === "string" && e.project_id ? e.project_id : null;
    const iid = typeof e.initiative_id === "string" && e.initiative_id ? e.initiative_id : null;
    if (!projectId || !iid) return null;
    // OWNERSHIP — only the project bridge scoped to this initiative's project owns it.
    if (!this.scopeProject || this.scopeProject !== projectId) return null;
    const detail = tidy(e.detail);
    const content = `[${iid}] initiative READY FOR REVIEW — all member-repo stories landed` +
      (detail ? `: ${detail}` : "");
    return {
      content,
      meta: { initiative_id: iid, project_id: projectId, state: "initiative_review" },
    };
  }

  /**
   * Translate a `task.instruction_updated` event (the `update` verb — story st-7a7b0654) into an
   * INSTRUCTION-UPDATED re-surface notification, or null when THIS bridge's scope does not own the
   * item. An operator amended a PARKED-in-feedback work item's brief; a same-status `task.updated`
   * would not re-notify (the diff path only fires on an entered surface / responder change), so this
   * one-shot event forces the re-surface. It reads the SAME routing fields off the carried TaskView
   * as consumeTaskAttention (story_id / project_id / pending_responder / status / workspace_id) and
   * REUSES routeOwns, so a subtask routes to its story leader, a non-story task to the CTO, exactly
   * like the item's ordinary feedback. Stateless: it does NOT update the status/idle/responder diff
   * maps (so it can never desync the ordinary path) and — being markerless + never resynced — it is
   * a live push only. Resilient: a missing/unknown field yields null rather than throwing.
   */
  private consumeInstructionUpdated(e: Record<string, unknown>): ChannelNotification | null {
    const task = e.task;
    if (!task || typeof task !== "object") return null;
    const t = task as Record<string, unknown>;
    const id = t.id;
    const status = t.status;
    if (typeof id !== "string" || !id || typeof status !== "string") return null;

    const dirId = typeof t.workspace_id === "string" ? t.workspace_id : "";
    const storyId = typeof t.story_id === "string" && t.story_id ? t.story_id : null;
    const projectId = typeof t.project_id === "string" && t.project_id ? t.project_id : null;
    const responder =
      typeof t.pending_responder === "string" ? t.pending_responder : null;

    // OWNERSHIP — reuse the exact task-attention routing (NOT a fork). Not dead-blocked.
    if (!this.routeOwns(storyId, projectId, responder, status, dirId, false)) return null;

    const label = this.dirLabels.get(dirId) || dirId || "(unknown workspace)";
    const detail = tidy(e.detail);
    const content =
      `[${id}] ${label} — ${INSTRUCTION_UPDATED_PHRASE}` + (detail ? `: ${detail}` : "");
    // Typed as an explicit Record so the empty branch widens to "no keys" rather than to an
    // OPTIONAL `story_id?: string` — an optional key's `undefined` is not assignable to `meta`'s
    // `string | number` index signature, which is what the spread below feeds.
    const storyMeta: Record<string, string> = storyId ? { story_id: storyId } : {};
    const projectMeta: Record<string, string> = projectId ? { project_id: projectId } : {};
    return {
      content,
      meta: {
        task_id: id,
        workspace: dirId,
        state: "instruction_updated",
        ...storyMeta,
        ...projectMeta,
      },
    };
  }

  /**
   * Does THIS bridge's scope OWN a task's current attention item — i.e. should it emit?
   * The STRUCTURAL routing contract (design §5):
   *  - STORY scope (BUTCHR_CHANNEL_STORY): the leader owns its OWN story's subtasks'
   *    feedback (resolved responder 'story' — subtask feedback is TERMINAL at the leader)
   *    AND their failures (failed/aborted — a terminal failure has no responder, but the
   *    leader still owns its subtasks' failures).
   *  - WORKSPACE/CTO scope (BUTCHR_CHANNEL_WORKSPACE, or unscoped legacy): the CTO feed owns
   *    ONLY NON-STORY tasks — it NEVER owns a story member (those always belong to the
   *    leader). A non-story task is owned when it is awaiting the CTO (responder 'cto') OR has
   *    FAILED (failed/aborted — a failure has no responder, hence the explicit status check).
   *    A non-story task ESCALATED to the user (responder 'user' from escalated_to_user) is
   *    DROPPED here — the webapp/dashboard surfaces it to the user.
   *  - PROJECT scope (BUTCHR_CHANNEL_PROJECT — REVAMP-4 P3b): the CEO feed owns an item whose
   *    OWNING PROJECT (project_id) === this.scopeProject AND that is awaiting the CEO (responder
   *    'ceo') OR has FAILED / is dead-blocked in the project's subtree. The exact project mirror of
   *    the STORY-leader branch ('ceo'/scopeProject swapped for 'story'/scopeStory).
   * A DEAD-BLOCKED task (F3) has no responder and is not failed/aborted, so it is owned the same
   * way a failure is — by the leader for a story member, by the CEO for a project-direct item, by
   * the CTO for a non-story task — via the explicit `deadBlocked` flag.
   */
  private routeOwns(
    storyId: string | null,
    projectId: string | null,
    responder: string | null,
    status: string,
    dirId: string,
    deadBlocked: boolean,
  ): boolean {
    if (this.scopeStory) {
      return (
        storyId === this.scopeStory &&
        (responder === "story" ||
          status === "failed" ||
          status === "aborted" ||
          deadBlocked)
      );
    }
    // PROJECT scope (the CEO feed) — the project mirror of the STORY branch above (REVAMP-4 P3b).
    // DORMANT: no bridge sets scopeProject in prod yet, so this branch is never taken there.
    if (this.scopeProject) {
      return (
        projectId === this.scopeProject &&
        (responder === "ceo" ||
          status === "failed" ||
          status === "aborted" ||
          deadBlocked)
      );
    }
    if (this.scopeDir && dirId !== this.scopeDir) return false;
    // NON-STORY, NON-PROJECT tasks only — awaiting the CTO ('cto'), a non-story failure, or
    // dead-blocked. A 'user' escalation falls through to false (dropped → the webapp surfaces it).
    // The `projectId == null` guard is the PROJECT analog of the `storyId == null` story-member
    // exclusion (REVAMP-4 P3b): a project-direct item now nulls story_id (taskView), so WITHOUT this
    // guard a FAILED/dead-blocked project-child would leak into the CTO feed. Byte-identical in prod
    // (no project nodes → projectId always null → the guard is always true → CTO decision unchanged).
    // A 'ceo' responder likewise no longer matches here (responder !== 'cto'), so it is owned by the
    // project bridge above (when scoped) or dropped to the webapp.
    return (
      storyId == null &&
      projectId == null &&
      (responder === "cto" || status === "failed" || status === "aborted" || deadBlocked)
    );
  }
}

// --- SSE parsing -------------------------------------------------------------

/**
 * Build an incremental SSE parser. Feed it raw decoded chunks via the returned
 * function; it invokes `onData` with the `data:` payload of each completed event
 * (blank-line terminated), ignoring `:` keepalive comments and non-data fields.
 * Exported so the framing can be unit-tested without a socket.
 */
export function makeSseParser(onData: (payload: string) => void): (chunk: string) => void {
  let buf = "";
  let dataLines: string[] = [];
  return (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      let line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        if (dataLines.length) {
          onData(dataLines.join("\n"));
          dataLines = [];
        }
        continue;
      }
      if (line.startsWith(":")) continue; // keepalive / comment
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
      // other SSE fields (event:, id:, retry:) are irrelevant here
    }
  };
}

// --- SSE reconnect loop ------------------------------------------------------

export type SseLoopOpts = {
  /** SSE endpoint to subscribe to. */
  url: string;
  /** Called with each event's raw `data:` payload (one JSON event). */
  onData: (payload: string) => void;
  /** Stop the loop when this returns true (checked between reads + reconnects). */
  shouldStop?: () => boolean;
  /** Open the stream (overridable in tests). Resolves null/throws to trigger retry. */
  open?: (url: string) => Promise<ReadableStream<Uint8Array> | null>;
  /**
   * Invoked after EVERY successful open() — the first connect AND every reconnect —
   * BEFORE draining begins. The bridge uses this to RE-SYNC scoped attention from REST
   * so a transition fired during the gap (a reconnect, or across a butchr restart that
   * relaunches the agent → a fresh bridge with empty maps) is re-detected and pushed.
   * It runs on the FIRST open too: a fresh process must surface the currently-outstanding
   * attention (the headline case is missing an escalation ACROSS a restart — the SSE
   * stream only carries FUTURE transitions, so a task already sitting in needs_info/failed
   * at (re)start would otherwise never push). Best-effort — runSseLoop catches a throw and
   * proceeds to drain regardless. Overridable in tests.
   */
  onConnect?: () => Promise<void> | void;
  /** Sleep between reconnect attempts (overridable in tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Reconnect backoff in ms (fixed; SSE on loopback rarely drops). */
  backoffMs?: number;
  /** Diagnostics sink (defaults to stderr). */
  log?: (msg: string) => void;
};

async function defaultOpen(url: string): Promise<ReadableStream<Uint8Array> | null> {
  const res = await fetch(url, { headers: { accept: "text/event-stream" } });
  if (!res.ok || !res.body) {
    throw new Error(`SSE connect failed: HTTP ${res.status}`);
  }
  return res.body;
}

function drainStream(
  stream: ReadableStream<Uint8Array>,
  onData: (payload: string) => void,
  shouldStop?: () => boolean,
): Promise<void> {
  return (async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const feed = makeSseParser(onData);
    try {
      while (true) {
        if (shouldStop?.()) break;
        const { done, value } = await reader.read();
        if (done) break;
        if (value) feed(decoder.decode(value, { stream: true }));
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* already closed */
      }
    }
  })();
}

/**
 * Subscribe to the SSE stream and RECONNECT whenever it ends or errors, until
 * `shouldStop` says to stop. A dropped connection (server restart, network blip) is
 * caught, logged, and retried after `backoffMs` — it never crashes the bridge.
 * Exported + fully injectable (open/sleep/shouldStop) so reconnect is testable.
 */
export async function runSseLoop(opts: SseLoopOpts): Promise<void> {
  const open = opts.open ?? defaultOpen;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const backoff = opts.backoffMs ?? 2000;
  const log = opts.log ?? (() => {});
  while (!opts.shouldStop?.()) {
    try {
      const stream = await open(opts.url);
      if (stream) {
        // RE-SYNC scoped attention from REST on every (re)connect BEFORE draining, so a
        // transition missed during the gap is re-detected. Best-effort: a throw here must
        // not skip the drain (we still want the live stream). Ordering open→re-sync→drain
        // means any transition between the REST read and drain start is still buffered in
        // the SSE stream and de-dups through the same bridge maps.
        if (opts.onConnect) {
          try {
            await opts.onConnect();
          } catch (e) {
            log(`re-sync on connect failed (continuing): ${(e as Error).message}`);
          }
        }
        await drainStream(stream, opts.onData, opts.shouldStop);
      }
    } catch (e) {
      log(`sse error (will reconnect): ${(e as Error).message}`);
    }
    if (opts.shouldStop?.()) break;
    await sleep(backoff); // stream ended/dropped → back off, then reconnect
  }
}

// --- reconnect re-sync (recover pushes missed during the gap) ----------------

/** Is a list item currently on a TASK attention surface? Mirrors ALL THREE surface gates in
 * AttentionBridge.consume — an attention STATUS, the IDLE condition on a live agent, or the
 * DEAD-BLOCKED condition (a `blocked` task with a non-empty deadBlockers set) — so the re-sync
 * fetches a full view for every task that could actually push. The /api/work leaf list rows
 * carry both `idle` and `deadBlockers`, so the pre-filter evaluates them without the per-:id fetch. */
function isOnAttentionSurface(item: Record<string, unknown>): boolean {
  const status = item.status;
  if (isAttentionState(status)) return true;
  if (status === "in_progress" && (item.idle === 1 || item.idle === true)) return true;
  return (
    status === "blocked" &&
    Array.isArray(item.deadBlockers) &&
    item.deadBlockers.length > 0
  );
}

// The TERMINAL leaf states among ATTENTION_STATES. db.ts (db.isTerminal / ATTENTION_STATES) is the
// SOURCE OF TRUTH: `failed` and `aborted` are the only two TERMINAL members of the CTO push-feed set.
// Duplicated as a small LOCAL literal (NOT imported from db.ts) on purpose — this out-of-process
// bridge is deliberately DB-FREE, and importing db.ts runs its top-level `new Database(...)` at
// module load. Keep in sync with db.isTerminal should a new terminal attention state ever be added.
const RESYNC_TERMINAL = new Set(["failed", "aborted"]);

/**
 * Is a list item a RESYNCABLE attention surface — one the reconnect re-derivation should re-feed
 * through consume? This is the resync-ONLY narrowing of isOnAttentionSurface: it additionally drops
 * TERMINAL leaf states (failed/aborted), so a reconnect NEVER replays the terminal task backlog.
 *
 * WHY resync must diverge from the LIVE consume path: on a FRESH bridge (a butchr reboot / MCP
 * re-attach relaunches the agent → a NEW channel.ts process with EMPTY de-dup maps) resyncAttention
 * runs on the first connect and re-feeds the REST snapshot through consume — where an empty lastStatus
 * makes `prevStatus === undefined !== 'failed'` read as a fresh transition. WITHOUT this narrowing
 * every historical failed/aborted leaf re-emits a "task failed" push — a flood of stale terminal
 * records. A terminal task is a permanent record, not an open loop: it is recoverable via the
 * dashboard's REVIEW_STATES pull-signal and need not be re-pushed on every reconnect. The LIVE path is
 * UNTOUCHED — consume() still fires EXACTLY ONCE when a task genuinely transitions into failed/aborted
 * via a real SSE task.updated event, so a fresh failure is still surfaced. The non-terminal actionable
 * surfaces (idea, spec_review, in_review, needs_info, idle, dead_blocked) resync exactly as before.
 */
function isResyncableAttention(item: Record<string, unknown>): boolean {
  if (!isOnAttentionSurface(item)) return false;
  return !(typeof item.status === "string" && RESYNC_TERMINAL.has(item.status));
}

/** A story's member-count totals, derived from the REST work view's `counts` rollup (the
 * per-status member counts). `idle` (and `needs_user_input`) are PEELED OUT of `in_progress`,
 * NOT separate members, so they are EXCLUDED from the total to avoid double-counting (mirrors the
 * member-count logic in tasks.ts). `merged` = merged+rolled_back; `dead` = failed+aborted; these
 * mirror the publishers' markers so a re-derived event de-dups against an already-delivered one. */
function storyMemberTotals(counts: Record<string, unknown>): {
  total: number;
  merged: number;
  dead: number;
  inFlight: number;
} {
  const num = (v: unknown) => (typeof v === "number" && v >= 0 ? v : 0);
  const PEELED = new Set(["idle", "needs_user_input"]);
  let total = 0;
  for (const [s, v] of Object.entries(counts)) if (!PEELED.has(s)) total += num(v);
  const merged = num(counts.merged) + num(counts.rolled_back);
  const dead = num(counts.failed) + num(counts.aborted);
  return { total, merged, dead, inFlight: total - merged - dead };
}

/**
 * Re-derive a LEADER bridge's outstanding target:'story' story.attention events from a node's REST
 * work view (StoryView). Pure + DB-free; each marker mirrors the matching publisher (tasks.ts /
 * stories.ts) so a synthesized event de-dups against an already-delivered live one. `ask-answered`
 * is OUT OF SCOPE (its answer text is unrecoverable from REST). Returns 0..2+ synthesized events.
 */
export function leaderStorySurfaces(node: Record<string, unknown>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const storyId = typeof node.id === "string" ? node.id : "";
  if (!storyId) return out;
  const dir = typeof node.workspace_id === "string" ? node.workspace_id : "";
  const status = typeof node.status === "string" ? node.status : "";
  const brief = typeof node.brief === "string" ? node.brief : null;
  const counts =
    node.counts && typeof node.counts === "object"
      ? (node.counts as Record<string, unknown>)
      : {};
  const { total, merged, dead, inFlight } = storyMemberTotals(counts);
  const liveLeader = status === "open" || status === "merge_blocked";
  const mk = (reason: string, detail: string | null, marker: string) => ({
    type: "story.attention",
    story_id: storyId,
    workspace_id: dir,
    target: "story",
    reason,
    detail,
    marker,
  });
  // completion-review: every member merged/rolled_back (mirrors isStoryComplete +
  // notifyStoryCompletionIfReady). marker = merged count (rises as each fix-subtask lands).
  if (liveLeader && total > 0 && merged === total) {
    out.push(mk("completion-review", brief, String(merged)));
  }
  // member-blocked: all members terminal AND ≥1 dead (mirrors notifyStoryBlockedIfStuck).
  if (liveLeader && total > 0 && inFlight === 0 && dead >= 1) {
    out.push(mk("member-blocked", brief, String(dead)));
  }
  // gate-red: the story is merge_blocked (mirrors landStory's gate-red). detail is degraded — the
  // gate output is unrecoverable from REST. BENIGN OVERLAP: a merge_blocked story is essentially
  // always all-merged (members merge into the story branch BEFORE the story→main attempt), so this
  // co-derives with completion-review; the two carry distinct `reason`s (distinct de-dup keys) so
  // both may push once on a recovering reconnect, and the set quiets repeats thereafter. Over-
  // delivering on a recovery path is the correct bias (steering note).
  if (status === "merge_blocked" && total > 0) {
    out.push(mk("gate-red", null, String(merged)));
  }
  return out;
}

/**
 * ONE-SHOT REST re-sync run on every (re)connect (see SseLoopOpts.onConnect): re-detect any
 * TASK attention transition that fired while the bridge was mid-reconnect — or that was
 * already outstanding when a fresh bridge started (e.g. across a butchr restart) — and push
 * the ones still outstanding, WITHOUT double-emitting a transition already delivered.
 *
 * The de-dup comes for FREE by re-feeding the current REST state back through the SAME
 * `bridge.consume()` and its SAME in-memory maps: consume emits only when a task's status
 * actually CHANGED into an attention surface (or its responder changed), so a transition the
 * maps already reflect (delivered before the gap, or already re-synced on a prior connect)
 * yields null, while a transition the maps DON'T yet reflect (missed during the gap, or never
 * seen by a fresh process) emits exactly once. Ownership routing (routeOwns) is likewise
 * inherited unchanged from consume.
 *
 * SCOPE: this recovers the NON-TERMINAL LEAF (task) attention surfaces — attention status (idea /
 * spec_review / in_review / needs_info), idle, AND dead_blocked — including a story-leader bridge's
 * OWN subtasks' feedback, via the scopeStory routing inside consume. It DELIBERATELY EXCLUDES the
 * TERMINAL leaf states (failed / aborted): the candidate pre-filter is isResyncableAttention, NOT the
 * raw isOnAttentionSurface, so a reconnect NEVER replays the terminal task backlog (a fresh bridge's
 * empty maps would otherwise re-emit every historical failure). A GENUINE live failure is still
 * surfaced exactly once by the untouched consume() path off the SSE stream.
 *
 * STORY-CONTAINER notifications (story.attention) ARE now re-synced too (the st-ad96e5c3 follow-up
 * to st-fffc76a8): we re-DERIVE the outstanding story-level surfaces from the durable REST work view
 * and feed synthesized story.attention objects through the SAME bridge.consume(), so ownership
 * routing (consumeStoryAttention) + the marker de-dup set are inherited unchanged — a missed
 * story.attention is delivered exactly once, an already-delivered one is suppressed by its marker key.
 * Re-derivable from REST (via leaderStorySurfaces + the CTO ask scan below):
 *   - LEADER bridge (scopeStory): `completion-review` (status open|merge_blocked AND all members
 *     merged/rolled_back), `member-blocked` (open|merge_blocked AND all members terminal AND ≥1
 *     failed/aborted), `gate-red` (status merge_blocked; detail degraded — gate output is gone).
 *     `ask-answered` is OUT OF SCOPE — its answer text is unrecoverable from REST.
 *   - WORKSPACE/CTO bridge (scopeDir): the outstanding `ask` (a node with pending_ask != null AND
 *     ask_responder == 'cto'). `complete` / `merge-conflict` are transient → OUT OF SCOPE.
 *   - PROJECT/CEO bridge (scopeProject — REVAMP-4 P3f): the outstanding `ask` escalated to THIS
 *     project's CEO (a node with pending_ask != null AND ask_responder == 'ceo' AND its
 *     `ask_project_id` == scopeProject). The project mirror of the CTO ask scan one rung up.
 *
 * DB-free: it reads the SAME REST surface the dashboard does (GET /api/work + GET /api/work/:id),
 * scoped to this bridge's workspace/story (the story-container derivation reuses the already-fetched
 * GET /api/work list — its node rows carry status / counts / pending_ask / ask_responder). Fully
 * best-effort — per-item, the story-container block, and the whole fn each catch+log, never throw,
 * so a still-restarting butchr just means the next connect retries.
 */
export async function resyncAttention(args: {
  baseUrl: string;
  bridge: AttentionBridge;
  emit: (n: ChannelNotification) => void;
  scopeDir?: string;
  scopeStory?: string;
  scopeProject?: string;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}): Promise<void> {
  const { baseUrl, bridge, emit } = args;
  const f = args.fetchImpl ?? fetch;
  const log = args.log ?? (() => {});
  const scopeDir = (args.scopeDir ?? "").trim();
  const scopeStory = (args.scopeStory ?? "").trim();
  const scopeProject = (args.scopeProject ?? "").trim();
  try {
    // Scope the list to this bridge's workspace when set (mirrors the SSE scoping); a
    // story-leader bridge also has its workspace set, then narrows to its story below.
    const listUrl =
      `${baseUrl}/api/work` + (scopeDir ? `?workspace=${encodeURIComponent(scopeDir)}` : "");
    const res = await f(listUrl, { headers: { accept: "application/json" } });
    if (!res.ok) {
      log(`re-sync list fetch failed: HTTP ${res.status}`);
      return;
    }
    const items = await res.json();
    if (!Array.isArray(items)) return;

    // Bound the per-item fetches to LEAF tasks currently on a RESYNCABLE attention surface (and, for
    // a story bridge, this story's subtasks) — routeOwns drops the rest, but pre-filtering keeps the
    // full-view fetches to only outstanding-attention tasks. isResyncableAttention (NOT the raw
    // isOnAttentionSurface) EXCLUDES terminal leaf states (failed/aborted) so a reconnect never
    // replays the terminal task backlog — the live consume path still surfaces a fresh failure.
    const candidates = (items as Array<Record<string, unknown>>).filter((it) => {
      if (it.work_kind !== "leaf") return false;
      if (scopeStory && it.story_id !== scopeStory) return false;
      return isResyncableAttention(it);
    });

    for (const item of candidates) {
      const id = item.id;
      if (typeof id !== "string" || !id) continue;
      try {
        // The light list view omits prompt/question/etc. that attentionText needs, so fetch
        // the full TaskView per candidate and feed it through consume exactly like an SSE event.
        const r = await f(`${baseUrl}/api/work/${encodeURIComponent(id)}`, {
          headers: { accept: "application/json" },
        });
        if (!r.ok) continue;
        const view = await r.json();
        const note = bridge.consume({ type: "task.updated", task: view });
        if (note) emit(note);
      } catch (e) {
        log(`re-sync item ${id} failed: ${(e as Error).message}`);
      }
    }

    // STORY-CONTAINER (story.attention) re-derivation — recover story-level notifications missed
    // during the gap, mirroring the leaf re-feed. We synthesize story.attention objects from the
    // already-fetched node rows (work_kind:'node' = the StoryView, carrying status / counts /
    // pending_ask / ask_responder) and feed them through the SAME bridge.consume(), so ownership
    // routing + the marker de-dup are inherited unchanged. Its OWN try/catch (and a per-event one)
    // so a malformed node never aborts the already-completed leaf resync above.
    try {
      const nodes = (items as Array<Record<string, unknown>>).filter(
        (it) => it.work_kind === "node",
      );
      const feed = (ev: Record<string, unknown>) => {
        try {
          const note = bridge.consume(ev);
          if (note) emit(note);
        } catch (e) {
          log(`re-sync story ${String(ev.story_id)} failed: ${(e as Error).message}`);
        }
      };
      if (scopeStory) {
        // LEADER bridge: re-derive THIS story's outstanding target:'story' surfaces from its node.
        const node = nodes.find((n) => n.id === scopeStory);
        if (node) for (const ev of leaderStorySurfaces(node)) feed(ev);
      } else if (scopeProject) {
        // PROJECT/CEO bridge (REVAMP-4 P3f): re-derive each outstanding CEO-owned `ask` (a node
        // still holding a pending_ask escalated to the CEO of THIS project). The ask's owning
        // project is the node's `ask_project_id` (the {ceo} rung of its container ladder — the
        // SAME derivation escalateStoryAsk publishes with) — NOT the node's own `project_id`
        // (a story node's immediate parent is a REPO, so that is null). detail/marker = pending_ask.
        for (const node of nodes) {
          const sid = typeof node.id === "string" ? node.id : "";
          const pendingAsk = typeof node.pending_ask === "string" ? node.pending_ask : null;
          const askResponder =
            typeof node.ask_responder === "string" ? node.ask_responder : null;
          const askProject =
            typeof node.ask_project_id === "string" ? node.ask_project_id : null;
          if (!sid || !pendingAsk || askResponder !== "ceo" || askProject !== scopeProject) {
            continue;
          }
          feed({
            type: "story.attention",
            story_id: sid,
            workspace_id: typeof node.workspace_id === "string" ? node.workspace_id : "",
            target: "ceo",
            project_id: askProject,
            reason: "ask",
            detail: pendingAsk,
            marker: pendingAsk,
          });
        }
      } else {
        // WORKSPACE/CTO bridge: re-derive each outstanding CTO-owned `ask` (a node still holding a
        // pending_ask owned by the CTO). detail/marker = the durable pending_ask text.
        for (const node of nodes) {
          const sid = typeof node.id === "string" ? node.id : "";
          const pendingAsk = typeof node.pending_ask === "string" ? node.pending_ask : null;
          const askResponder =
            typeof node.ask_responder === "string" ? node.ask_responder : null;
          if (!sid || !pendingAsk || askResponder !== "cto") continue;
          feed({
            type: "story.attention",
            story_id: sid,
            workspace_id: typeof node.workspace_id === "string" ? node.workspace_id : "",
            target: "cto",
            reason: "ask",
            detail: pendingAsk,
            marker: pendingAsk,
          });
        }
      }
    } catch (e) {
      log(`re-sync story-container failed: ${(e as Error).message}`);
    }
  } catch (e) {
    log(`re-sync failed: ${(e as Error).message}`);
  }
}

// --- MCP stdio request handling ----------------------------------------------

/**
 * Handle one inbound JSON-RPC message from the client. Returns a JSON-RPC response
 * object to write back, or null for notifications (which get no reply). This bridge
 * exposes NO tools — only the channel lifecycle methods (initialize / ping).
 */
export function handleRpc(
  msg: JsonRpcMessage,
  connectivityOnly = false,
): Record<string, unknown> | null {
  if (!msg || typeof msg.method !== "string") return null;
  switch (msg.method) {
    case "initialize":
      return jsonRpcResult(
        msg.id,
        channelInitializeResult(msg.params?.protocolVersion, connectivityOnly),
      );
    case "ping":
      return jsonRpcResult(msg.id, {});
    default:
      // Notifications (notifications/initialized, etc.) carry no id → no reply.
      if (isNotificationOrIdless(msg)) return null;
      return jsonRpcError(msg.id, -32601, `method not found: ${msg.method}`);
  }
}

/** Serialize a channel notification as a JSON-RPC notification line (no trailing \n). */
export function channelNotificationMessage(n: ChannelNotification): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/claude/channel",
    params: { content: n.content, meta: n.meta },
  });
}

// --- runtime wiring (only runs when invoked as a script) ---------------------

function defaultSseUrl(): string {
  const env = process.env.BUTCHR_CHANNEL_SSE_URL;
  if (env && env.trim()) return env.trim();
  return `http://${config.host}:${config.port}/api/events`;
}

/** Write a server→client message (response or notification) on stdout, one per line. */
function writeMessage(obj: Record<string, unknown> | string): void {
  const line = typeof obj === "string" ? obj : JSON.stringify(obj);
  process.stdout.write(line + "\n");
}

// All diagnostics go to STDERR — stdout is reserved for the JSON-RPC protocol.
function elog(msg: string): void {
  process.stderr.write(`[butchr-channel] ${msg}\n`);
}

/**
 * Run the bridge: read newline-delimited JSON-RPC from stdin (answering
 * initialize/ping), and once initialized, subscribe to butchr's SSE stream and push
 * a channel notification for every CTO attention transition. Best-effort throughout:
 * a single bad event/notification is dropped, never fatal.
 */
export async function main(): Promise<void> {
  const url = defaultSseUrl();
  // PER-WORKSPACE SCOPE: butchr launches one bridge per registered workspace's CTO
  // agent and passes that workspace_id via BUTCHR_CHANNEL_WORKSPACE, so the bridge pushes
  // only that workspace's attention events. Unset → an unscoped (all-workspaces) feed.
  const scopeDir = (process.env.BUTCHR_CHANNEL_WORKSPACE ?? "").trim();
  // PER-STORY SCOPE (the story-leader bridge): butchr launches one bridge per OPEN story's
  // leader and passes that story_id via BUTCHR_CHANNEL_STORY, so the bridge pushes only that
  // story's subtasks' feedback + failures (the WORKSPACE scope above is also set, for SSE
  // filtering / the workspace label, but STORY scope drives the routing). Unset → the bridge
  // runs in WORKSPACE/CTO mode.
  const scopeStory = (process.env.BUTCHR_CHANNEL_STORY ?? "").trim();
  // PER-PROJECT SCOPE (the CEO bridge; REVAMP-4 P3b): butchr would launch one bridge per PROJECT
  // node's CEO and pass that project_id via BUTCHR_CHANNEL_PROJECT, so the bridge pushes only that
  // project's direct items' feedback + failures (the STORY scope's project analog). DORMANT: no CEO
  // agent sets this yet (P3c) and no project nodes exist (P3d), so this is empty in prod. Unset → the
  // bridge runs in STORY (if scopeStory set) or WORKSPACE/CTO mode.
  const scopeProject = (process.env.BUTCHR_CHANNEL_PROJECT ?? "").trim();
  // CONNECTIVITY-ONLY (the WORKER bridge): deliver ONLY the global connectivity-restored
  // broadcast, suppressing every attention/idle event. Set by the dispatcher on the
  // per-task channel server (BUTCHR_CHANNEL_CONNECTIVITY_ONLY=1) so a build agent hears
  // "network restored" mid-session but never another task's review/idle events.
  const connectivityOnly = /^(1|true|yes|on)$/i.test(
    (process.env.BUTCHR_CHANNEL_CONNECTIVITY_ONLY ?? "").trim(),
  );
  const bridge = new AttentionBridge(scopeDir, connectivityOnly, scopeStory, scopeProject);
  if (scopeStory) elog(`scoped to story ${scopeStory}`);
  else if (scopeProject) elog(`scoped to project ${scopeProject}`);
  else if (scopeDir) elog(`scoped to workspace ${scopeDir}`);
  if (connectivityOnly) elog("connectivity-only mode (worker channel)");
  let stopped = false;

  // Best-effort seed of workspace labels so the very first notifications carry a
  // human label rather than a bare workspace id (the cache then self-updates off the
  // workspace.* events on the stream). Skipped in connectivity-only mode — that bridge
  // emits no workspace-labelled notifications, so there is nothing to seed.
  if (!connectivityOnly) {
    try {
      const base = url.replace(/\/api\/events.*$/, "");
      const res = await fetch(`${base}/api/workspaces`);
      if (res.ok) {
        const dirs = await res.json();
        if (Array.isArray(dirs)) bridge.seedWorkspaceLabels(dirs);
      }
    } catch {
      /* seeding is optional */
    }
  }

  // Translate each SSE event into a channel notification (if it is a transition).
  const onData = (payload: string) => {
    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      return; // malformed frame — drop silently
    }
    let note: ChannelNotification | null = null;
    try {
      note = bridge.consume(event);
    } catch {
      return; // never let a bad event crash the bridge
    }
    if (!note) return;
    try {
      writeMessage(channelNotificationMessage(note));
    } catch (e) {
      elog(`failed to write notification: ${(e as Error).message}`);
    }
  };

  // SSE subscription with auto-reconnect (runs for the life of the process). On every
  // (re)connect we RE-SYNC scoped attention from REST so a transition fired during the gap
  // — or already outstanding when this fresh bridge started, e.g. across a butchr restart —
  // is recovered (see resyncAttention). Skipped for a connectivity-only worker bridge: it
  // delivers no attention, so there is nothing to re-sync.
  const base = url.replace(/\/api\/events.*$/, "");
  elog(`subscribing to ${url}`);
  const sse = runSseLoop({
    url,
    onData,
    shouldStop: () => stopped,
    log: elog,
    onConnect: connectivityOnly
      ? undefined
      : () =>
          resyncAttention({
            baseUrl: base,
            bridge,
            scopeDir,
            scopeStory,
            scopeProject,
            emit: (n) => writeMessage(channelNotificationMessage(n)),
            log: elog,
          }),
  });

  // Read stdin: newline-delimited JSON-RPC. Answer initialize/ping; ignore the rest.
  const decoder = new TextDecoder();
  let buf = "";
  const onLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return; // not JSON — ignore
    }
    let res: Record<string, unknown> | null = null;
    try {
      res = handleRpc(msg, connectivityOnly);
    } catch (e) {
      elog(`rpc error: ${(e as Error).message}`);
      return;
    }
    if (res) writeMessage(res);
  };

  try {
    for await (const chunk of Bun.stdin.stream()) {
      buf += decoder.decode(chunk as Uint8Array, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        onLine(line);
      }
    }
    if (buf) onLine(buf); // trailing line without newline
  } finally {
    // stdin closed → the client is gone; stop the SSE loop and exit.
    stopped = true;
    await sse;
  }
}

// Run only when executed directly (not when imported by tests).
if (import.meta.main) {
  main().catch((e) => {
    process.stderr.write(`[butchr-channel] fatal: ${(e as Error).stack ?? e}\n`);
    process.exit(1);
  });
}
