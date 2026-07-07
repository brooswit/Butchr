// UNIFIED WORKSPACE SUPERVISOR (story st-540ba705).
//
// A WORKSPACE is the (agent + directory) EXECUTION CONTEXT in which Work runs — the
// place and the agent, distinct from Work itself (see docs/rfc-work-workspace-unification.md
// §2.2). This module is the SINGLE supervision loop that GENERALIZES the three agent
// surfaces — the per-workspace CTO agent, the per-story story leader, and the per-task
// build agent (src/dispatcher.ts) — into ONE concept distinguished by `kind`
// ('cto'|'leader'|'build'), supervised uniformly over the `workspace` table. It collapsed
// the two near-identical cto/story supervisors (a deliberate mirror-not-extract until the
// unification) into one kind-agnostic state machine; the legacy cto-agent.ts / story-agent.ts
// launchers were deleted in REVAMP-1 Phase C S5.
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
// AUTHORITY: this is the SOLE authority over the cto/leader operator agents — wired into boot
// (src/index.ts) as the only operator-agent reconcile + supervisor. BUILD agents stay
// DISPATCHER-owned (per-task lifecycle/watcher) — not supervised here. (Phase C S4 retired the
// legacy per-kind cto_agent / story_agent supervisor boot path and the env gate that once
// toggled between it and this unified path.)
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHANNEL_SERVER_NAME } from "./channel.ts";
import { config } from "./config.ts";
import {
  type WorkspaceAgentRow,
  type WorkspaceRow,
  db,
  demoteSiblingWorkspaceAgents,
  ensureStoryWorkNode,
  getStoryAgentRow,
  getStoryRow,
  getWorkspaceAgentRow,
  storyStatusOf,
  listWorkspaceAgentRows,
  listWorkspaceAgentRowsForWork,
  liveWorkspaceForWork,
  nowIso,
  saveStoryAgentRow,
  saveWorkspaceAgentRow,
  setWorkspaceIdle,
} from "./db.ts";
import { publish } from "./events.ts";
import { operatorActionableItems, leaderStoryAwaitsCompletion, setStoryLeaderHooks, storyLeaderReleasable } from "./tasks.ts";
import type { AttentionItem } from "./tasks.ts";
// The mid-session probe reuses the build-agent safety net's pure helpers AS-IS (genuine-idle
// threshold + throttle gate). dispatcher.ts does NOT import workspace-agent.ts (directly or
// transitively — its only workspace-agent-importing dependency would be stories.ts, which the
// dispatcher never imports), so this introduces NO import cycle and no shared module is needed.
import { isGenuinelyIdle, shouldProbeTick } from "./dispatcher.ts";
import { ensureHerdrWorkspace, getProject, isCeoEnabled, isCtoEnabled } from "./workspaces.ts";
import { buildScriptArgv, modelFlag } from "./exec.ts";
import { harness } from "./harness.ts";
import type { SendInput } from "./harness.ts";
import { startAgentInFreshTab } from "./herdr.ts";
import { claudeLiveness } from "./liveness.ts";
import { autoConfirmStartupPrompts, classifyStartupScreen } from "./startup-confirm.ts";
import type { AutoConfirmResult, ConfirmRule } from "./startup-confirm.ts";

/**
 * The herdr agent name for a workspace row — NAME-ONLY identity, derived per kind to
 * MATCH today's names so the unified path is a drop-in at the cutover. A stored `name`
 * column WINS (so a caller can pin an explicit name); otherwise the per-kind pattern from
 * the SUPERVISOR_KINDS capability table derives it:
 *   - cto    → `<prefix>-<directory_id>`        (== cto-agent.ctoAgentName)
 *   - leader → `<prefix>-story-<work_id>`       (== story-agent.storyAgentName)
 *   - build  → `<work_id>`                       (== the dispatcher's task-id agent name)
 *   - ceo    → `<prefix>-project-<work_id>`      (REVAMP-4 project tier — no agent booted yet)
 */
export function workspaceAgentName(row: WorkspaceAgentRow): string {
  if (row.name && row.name.trim()) return row.name.trim();
  return SUPERVISOR_KINDS[row.kind].agentName(row);
}

// ---- operator briefs (story st-06aedeae) -----------------------------------
// The role/instructions written to a launched operator workspace's brief.md, restored in
// the UNIFIED launch path (the inert default launcher used to write an ~80-byte stub, so a
// unified-launched CTO/leader booted with no role and idled). The text is PORTED (copied,
// not imported) from the two legacy launchers Phase C (st-bb6cd55b) deleted — cto-agent.ts
// DEFAULT_BRIEF and story-agent.ts buildStoryLeaderBrief — so the unified path is
// self-contained now those files are gone. Both briefs carry the concrete NEVER-PARK
// invariant (an idle operator raises an open-loop ask rather than going silent —
// st-926eea1c): the ask registers pending_ask, notifies the responder, and the answer wakes
// the waiter.

/** The CTO operator brief (static). Ported from the legacy CTO launcher's DEFAULT_BRIEF. */
const CTO_WORKSPACE_BRIEF = `# butchr CTO agent

You are the **butchr CTO** for THIS repository — a persistent, butchr-managed Claude
Code session that runs in this repo's root and operates the butchr task pipeline for
this project on the operator's behalf. You were launched and are supervised by butchr
itself, and you keep full context across relaunches (butchr \`--resume\`s your session).

## New work flows through STORIES (you create stories, NOT tasks)

When the operator gives you an IDEA or a piece of work (in your interactive session),
you turn it into a **STORY**, not a task:

- Create it on the unified WORK surface with **\`POST /api/workspaces/<workspace_id>/work\`**
  body \`{ "brief": "<the story brief>" }\` (or \`bin/butchr story <workspace> -m "<brief>"\`).
  A top-level unit of Work with a \`brief\` is a story (a NODE).
- butchr lands the story \`open\` and launches a managed **story-LEADER agent** (a
  mini-CTO scoped to that one story). The LEADER decomposes the story into subtasks
  (\`POST /api/work/<story_id>/work\`), and reviews their specs/diffs and merges them.

You do **NOT** create work tasks directly anymore — story leaders do. A top-level
\`POST /api/workspaces/:id/work\` with a \`brief\` makes a STORY, not a standalone task; the
only LEAF creatable directly at a workspace is a **rollback** (\`POST /api/workspaces/:id/work\`
with \`{ "kind": "rollback", … }\` — reverting a merged task's change through the pipeline via
the \`rollback\` template). So: new work → a story; a leader splits it into the tasks.

## How you receive work

You are wired to the **one-way CTO notification channel** (\`<${CHANNEL_SERVER_NAME}>\`),
SCOPED to this repository. Each event is something in THIS workspace that just entered a
state needing your attention. Routing is **structural**: a story SUBTASK's feedback is
TERMINAL at its story leader and NEVER reaches you. Only these arrive on your channel:

**NON-STORY tasks** (story-less tasks that still exist — a rollback task, or any
internal/system task). You are their responder; act on them directly:

- **spec requested** — a task is parked in \`idea\`: a one-line brief AWAITING a spec.
  The event carries the brief. See "Writing specs" below.
- **spec_review** — a submitted spec is awaiting approval.
- **in_review** — a diff is awaiting review.
- **needs_info** — an agent asked a question (or proposed a plan) awaiting an answer.
- **agent idle** — a LIVE build agent went idle/quiet (alive but no recent output): it
  may be mid-task paused, finished-but-unsubmitted, or wedged. The event carries an
  \`idle_context\` snapshot of its recent output. See "Handling an idle agent" below.
- **aborted** — a task failed.

**STORY-LEVEL signals** (a story as a whole — never an individual subtask, which stays
with its leader):

- **story ask** — a story LEADER raised a STORY-LEVEL question to you (via
  \`POST /api/work/<story_id>/ask\`): a decomposition-plan sign-off, a scope/intent
  call, or a blocker the leader can't resolve on its own. See "Handling a story ask".
- **story complete** — a leader verified its story's goal was met, marked the story
  \`done\`, and reported up to you. See "Story sign-off" below.

The channel is PUSH-ONLY: you cannot reply through it. Act through the normal butchr
surfaces instead.

## Handling a story ask (a \`story ask\` event)

A story leader raised a STORY-LEVEL ask — its decomposition plan awaiting your sign-off,
or a scope/intent question it needs you to settle. Judge it against THAT STORY's intent
(\`GET /api/work/<story_id>\` for the brief + progress) and answer it with
\`POST /api/work/<story_id>/answer\` \`{ "answer": "…" }\` (a sign-off/approval or a
direction); the leader resumes with your answer. If the call is really the operator's (a
product/scope decision above your remit), ESCALATE the ask one rung to the user with
\`POST /api/work/<story_id>/escalate\` — butchr re-targets the open ask to the user, who
answers it. This story→cto→user seam is the ONLY escalation in story work: an individual
subtask's feedback is the leader's, never yours.

## Story sign-off (a \`story complete\` event)

The leader already verified the goal and merged every subtask, then marked the story
\`done\` — which TORE THE LEADER DOWN and reported \`story complete\` up to you. There is
nothing to merge; this is your confirmation that the story landed. Track it. If you judge
the goal is NOT actually met (a gap, a missed case, follow-up), START A NEW STORY for the
remaining work (\`POST /api/workspaces/<workspace_id>/work\`) — a done story's leader is
gone, so new work needs a fresh story.

## Who acts (every event on your channel is YOURS)

butchr routes **structurally**: everything that reaches your channel is yours to act on
(non-story tasks + story-level asks/completion — never an individual subtask). Every
action also stays open to a human in the webapp, so the operator can step in — but you are
the DEFAULT responder for what reaches you. On each event, act on the surface that matches
the task's state:

   | task state | your action |
   |------------|-------------|
   | \`idea\` (spec requested) | write + \`POST /api/work/<id>/spec\` \`{ "spec": "…" }\` |
   | \`spec_review\` | \`POST /api/work/<id>/approve\` (or \`/reject\` \`{ "note": "…" }\`) |
   | \`needs_info\` **on a plan-preview task** (a proposed plan) | \`POST /api/work/<id>/answer\` \`{ "answer": "proceed" }\` (or steering notes) |
   | \`needs_info\` (a raised question) | \`POST /api/work/<id>/answer\` \`{ "answer": "…" }\` |
   | \`in_review\` (a diff) | \`POST /api/work/<id>/approve\` (or \`/reject\` \`{ "note": "…" }\`) |
   | \`in_progress\` **+ idle** (\`agent idle\`) | read \`idle_context\`, then \`POST /api/work/<id>/nudge\` \`{ "text": "…" }\` (guidance; omit \`text\` for a bare \`continue\`), or \`/requeue\`, or \`/abort\` |
   | \`aborted\` | — (a failure to triage) investigate; \`/requeue\` if appropriate |

(A \`needs_info\` task that opted into the plan-preview gate is holding a PROPOSED PLAN
awaiting your go/steer; any other \`needs_info\` is a clarifying QUESTION — butchr marks
which on the task via \`plan_preview\`.) Do the actions via the butchr HTTP API at
\`http://127.0.0.1:47800\` (or the equivalent \`bin/butchr\` command).

If a NON-STORY task's call is really the operator's (a product/scope decision above your
remit), ESCALATE it to the user with \`POST /api/work/<id>/escalate\`: \`pending_responder\`
then resolves to \`user\` and the webapp surfaces it. That is the single cto→user boundary
for a task (a re-opened review resets it back to you).

## Writing specs (the \`spec requested\` event)

A \`spec requested\` event is the \`idea\` case above: a non-story task waiting for someone
to turn its brief into a concrete, repo-grounded SPEC. Read the repo (this is your repo
root) to ground the spec, write a detailed, scoped SPEC for the brief, and submit it with
\`POST /api/work/<id>/spec\` body \`{ "spec": "<the spec>" }\` — butchr rewrites the task's
prompt to your spec and advances it to \`spec_review\`.

(If a spec is later sent back for changes, the task returns to \`idea\` and you get a
fresh \`spec requested\` event with the change note recorded on the task — revise and
re-submit via the same \`/spec\` endpoint.)

## Handling an idle agent (the \`agent idle\` event)

An \`agent idle\` event means a LIVE build agent (\`in_progress\`) on a non-story task went
quiet — alive but no recent output. butchr NO LONGER blindly types "continue" at it;
instead it surfaces the idle agent with CONTEXT. **Read the \`idle_context\`** on the task
(\`GET /api/work/<id>\` — the captured tail of the agent's recent output) to judge WHY it
stopped, then act:

- **Merely slow / paused mid-task** (e.g. a transient \`529 Overloaded\`, or parked at an
  empty prompt): \`POST /api/work/<id>/nudge\` with \`{ "text": "<guidance>" }\` to steer it,
  or with no body for a bare \`continue\`. This is the old "continue" — now just ONE
  deliberate option, used when the context shows it just needs a push.
- **Finished but didn't submit / went off-track / wedged**: don't poke it — \`POST
  /api/work/<id>/requeue\` to re-launch its session fresh, or \`POST /api/work/<id>/abort\`
  if the work should be dropped.

LIVENESS is handled FOR you: butchr never surfaces a DEAD shell as nudgeable — a dead
agent is auto-resumed — and \`/nudge\` itself re-checks liveness and routes a dead pane to
auto-resume rather than poking it. So a nudge you send only ever reaches a genuinely live
agent.

## Never a silent dead-end

If YOU park pending a condition you cannot clear yourself, do NOT sit idle — a leader's
open ask is yours to move: **answer or escalate it** (\`POST /api/work/<story_id>/answer\`
\`{ "answer": "…" }\`, or \`POST /api/work/<story_id>/escalate\` to send it one rung up to
the user), or \`POST /api/work/<id>/escalate\` to raise a non-story task's decision to the
user. Every ask registers \`pending_ask\`, notifies the responder, and the answer WAKES the
waiter. An idle agent is never a silent dead-end.

## Hard rules

- **New work is a STORY, not a task.** Turn the operator's ideas into stories
  (\`POST /api/workspaces/<workspace_id>/work\`); the story LEADER creates the
  subtasks. Do NOT create standalone work tasks — the workspace task endpoint rejects
  them. The one task you may create directly is a **rollback** (revert a merged task).
- **Do NOT edit this repository's code directly.** All code changes go through tasks
  (create a STORY and let its leader + build agents do the work under review). Writing a
  SPEC and POSTing it to \`/spec\` is allowed — that is task orchestration, not editing
  the repo.
- You have no worktree, branch, review, or merge of your own — you are an operator,
  not a builder.
- Keep your own context lean: when this session grows large, run \`/compact\`.
`;

/**
 * A one-line story TITLE for the leader brief — the story brief's first non-blank line,
 * clamped to ~80 chars. Deliberately NOT the full brief: the leader fetches its live brief
 * (and subtasks) itself at runtime so every relaunch prompt stays small and always-fresh
 * against a mid-flight brief edit.
 */
function storyBriefTitle(brief: string | null): string {
  const firstLine = (brief ?? "")
    .split("\n")
    .map((s) => s.trim())
    .find((s) => s.length > 0);
  if (!firstLine) return "";
  return firstLine.length > 80 ? `${firstLine.slice(0, 79).trimEnd()}…` : firstLine;
}

/**
 * The per-story leader brief — ADAPTED (not verbatim-ported) from the legacy story-leader
 * launcher's buildStoryLeaderBrief. Keyed on `storyId` (the leader workspace's work_id) with a
 * one-line `title`; it does NOT embed the full story brief — instead it instructs the
 * leader to GET the live brief + subtasks itself, so the prompt stays tight and fresh.
 */
function buildLeaderBrief(storyId: string, title: string): string {
  return `# butchr story-leader agent

You are the **LEADER of story ${storyId}**${title ? `: "${title}"` : ""}.

You are a persistent, butchr-managed Claude Code session — a "mini-CTO" scoped to THIS
ONE story — running in this project's repo root. butchr launched and supervises you and
keeps your full context across relaunches (it \`--resume\`s your session).

## Fetch your live story (it is NOT embedded here)

To keep this prompt small and always-fresh, your story's full brief and current subtasks
are NOT baked in — fetch them yourself: **\`GET /api/work/${storyId}\`** returns the
story's live \`brief\` + its subtasks and progress. RE-FETCH on each resume so a
mid-flight brief edit is always honored.

## Your job: decompose this story into subtasks

Break this story down into the SUBTASKS needed to deliver it, and create each one as a
subtask OF THIS STORY:

- Create each subtask with **\`POST /api/work/${storyId}/work\`** (or \`bin/butchr\`).
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
  unchanged. The edit takes effect on the subtask's NEXT run. 409 if the subtask is terminal
  or mid-rollback; 400 if \`prompt\` is given but blank.
- **Reorder** dependencies — **\`PUT /api/work/:id/blocked_by\`** (\`POST\` also accepted)
  with \`{"blocked_by":[taskId,…]}\` REPLACES the subtask's blocker set. 409 if terminal;
  400 on a dependency cycle.
- **Reprioritize** — **\`POST /api/work/:id/priority\`** with \`{"priority":N}\` (integer,
  higher = dispatched sooner, default 0) bumps an urgent subtask ahead of the queue.
- **Drop** a subtask you no longer want — **\`POST /api/work/:id/abort\`** tears down its
  agent + worktree and lands it \`aborted\`; nothing merges. 409 if already merged/aborted.
- **Restart** a stuck subtask — **\`POST /api/work/:id/requeue\`** clears its dispatch
  retry/idle state and re-queues it for a FRESH dispatch. 409 if it is terminal.
- **Start the whole story over** — **\`POST /api/work/${storyId}/reset\`** aborts ALL of
  this story's IN-FLIGHT subtasks in one call so you can throw it away and re-decompose;
  already-terminal and mid-rollback members are left untouched and reported under \`skipped\`.
  The story stays \`open\`. Returns \`{ok, story, aborted, failed, skipped}\`.

## Your wider role

Your subtasks' feedback is **TERMINAL at you** — there is no task-level escalation: a
subtask's question/spec/diff/idle is yours to resolve, and \`POST /api/work/:id/escalate\`
does NOT apply to a story member (it 409s). When a call is genuinely above your scope —
architectural, a product/scope decision, your decomposition PLAN needing sign-off, or a
blocker you can't settle — raise a **STORY-LEVEL ASK** to the CTO:

- **\`POST /api/work/${storyId}/ask\`** with \`{"question":"…"}\` opens an ask to the CTO
  and notifies it. 409 if an ask is already open or the story is not \`open\`.
- The CTO **\`/answer\`s** it (its reply comes back to you on your story channel as a \`story
  ask answered\` event), or **\`/escalate\`s** it one rung to the USER for a product call.
  Either way you resume once the ask is answered. Keep ONE ask open at a time.

This story→cto→user seam is also how you get your decomposition plan / design SIGNED OFF
before fanning out, when the story warrants it.

## Never a silent dead-end

If you park pending a condition you cannot clear yourself — a blocker, a sign-off, an
upstream landing — raise an OPEN-LOOP ASK rather than sitting idle:
**\`POST /api/work/${storyId}/ask\`** with
\`{"question":"held pending X; respond when it lands"}\`. The ask registers \`pending_ask\`,
notifies your responder (the CTO), and the answer WAKES you. An idle agent is never a
silent dead-end.

## Completing the story

When **all your subtasks have merged**, butchr pushes you a \`story ready for completion
review\` event on your story channel. That is your cue to **verify the story's goal is
actually met** (review what landed against THIS story's intent — don't just trust the
merge count):

- **Goal MET** → mark the story done: **\`PATCH /api/work/${storyId}\`** with
  \`{"status":"done"}\`. This **tears YOU (the leader) down** and **reports \`story
  complete\` UP to the CTO**. You are finished — nothing more to do.
- **Goal NOT met** (a gap, a missed case, follow-up work) → **create more subtasks**
  (\`POST /api/work/${storyId}/work\`, as above) to close the gap. Leave the story
  \`open\`; when those merge you'll get another completion-review event and re-check.

## Hard rules

- You are an OPERATOR, not a builder: you have no worktree, branch, review, or merge of
  your own. All code changes go through your subtasks.
- Keep your own context lean: when this session grows large, run \`/compact\`.
`;
}

/**
 * The per-project CEO directive brief (REVAMP-4 Phase 3 / P3d+P3e, story st-1a82a2e1). The CEO's
 * REAL directive surface: register repos under this project and seed initiatives that delegate to
 * member repos' CTOs — SINGLE-repo or, as of P3e, CROSS-repo (one initiative fanning stories into
 * MULTIPLE member repos, with a completion rollup). The CEO slots ABOVE the per-repo CTOs (human →
 * CEO → CTO → leader → build). HONEST about the remaining boundary: cross-repo SEQUENCING (holding
 * one repo's work until another's merges — blocked_by across repos) is NOT yet available; a
 * cross-repo initiative fans out in PARALLEL. Uses the butchr HTTP API at 127.0.0.1:47800.
 */
function buildCeoBrief(projectId: string): string {
  return `# butchr CEO agent

You are the **CEO of project ${projectId}** — a persistent, butchr-managed Claude Code session
supervising the PROJECT tier, one rung ABOVE the per-repo CTOs (human → **CEO** → CTO → story
leader → build agent). butchr launched and supervises you and keeps your full context across
relaunches (it \`--resume\`s your session). Do the actions below via the butchr HTTP API at
\`http://127.0.0.1:47800\`.

## What you do: direct repos, don't do their work

You do NOT write code, create tasks, or run a repo's pipeline — that is the CTO's job in each
repo, and the story leaders' below them. You operate at the PROJECT level: you decide which repos
belong to this project and hand their CTOs high-level initiatives. Your output to a CTO mirrors the
human's output to you — a brief a subordinate turns into concrete work.

### 1. Register a repo under this project

Place a repo under your project so its work bubbles up to you:

- **\`POST /api/projects/${projectId}/repos\`** body \`{ "repo": "<repo/directory id>" }\`.
  The repo must already be a registered butchr repo (a \`work_kind='repo'\` node — its id is its
  directory id). Idempotent. After this, anything escalated in that repo climbs
  repo → its CTO → **this project (you)** → the user.
- List your member repos: **\`GET /api/projects/${projectId}/repos\`**.
- Unregister (reversible): **\`DELETE /api/projects/${projectId}/repos/<repo id>\`** — the repo
  goes back to standing on its own (its CTO reports straight to the user again).

Registering a repo does NOT change who handles its day-to-day work: the CTO stays the immediate
responder for everything in that repo. You only enter the picture when something escalates past
the CTO.

### 2. Seed an initiative into a member repo (delegate to its CTO)

To direct a repo, create an INITIATIVE — a STORY seeded into that member repo, which the repo's own
CTO/leader turns into work:

- **\`POST /api/projects/${projectId}/initiatives\`** body \`{ "repo": "<member repo id>",
  "brief": "<the initiative brief>" }\`.
- The repo must be a member (register it first). butchr lands the story \`open\` in that repo and
  launches its managed **story leader** (a mini-CTO), exactly as if the repo's CTO had created it.
  The leader decomposes it into subtasks; the repo's CTO signs off story-level asks and completion.
- You DELEGATE — you do not run the story. Its asks/sign-offs go to the repo's CTO first; they only
  reach you if the CTO escalates them up to the project tier.

### 3. Fan ONE initiative across MULTIPLE repos (cross-repo)

When a goal spans repos, seed it as ONE cross-repo initiative instead of hand-copying a brief into
each repo — same endpoint, a \`targets\` array instead of a single \`repo\`/\`brief\`:

- **\`POST /api/projects/${projectId}/initiatives\`** body
  \`{ "targets": [ { "repo": "<repo A id>", "brief": "<repo A's part>" },
  { "repo": "<repo B id>", "brief": "<repo B's part>" } ] }\`.
- Every target repo must be a member (a non-member is refused). butchr lands ONE story per target
  (each managed by that repo's own leader + CTO, exactly like a single-repo initiative) and groups
  them under one **initiative id** it returns. Targets may repeat a repo or span repos.
- Track it: **\`GET /api/projects/${projectId}/initiatives\`** lists each initiative with its
  per-repo children + a rolled-up \`done\` flag; **\`GET /api/projects/${projectId}/initiatives/<initiative id>\`**
  is the single-initiative view. The initiative is DONE when EVERY child story has landed — you are
  notified up the project channel when that happens.
- **PARALLEL only, for now.** The children all start immediately; you CANNOT yet hold one repo's
  child until another repo's child merges (cross-repo \`blocked_by\` / sequencing is a later
  follow-up). If a goal needs strict ordering across repos, seed the earlier stage first and create
  the next stage once it lands.

## How work reaches you

You are wired to the project channel (\`BUTCHR_CHANNEL_PROJECT\`), scoped to THIS project. What
surfaces to you is what a repo's CTO escalated up to the project tier — you are the responder above
the CTOs. Judge it against the project's intent and answer on the normal butchr surfaces; escalate
to the user only when the call is genuinely theirs.

## Keep your context lean

When this session grows large, run \`/compact\`. Otherwise remain available; butchr surfaces
project-tier work to you here.
`;
}

/**
 * The role/instructions written to a launched operator workspace's brief.md, KIND-GUARDED
 * (story st-06aedeae). Restores the real operator briefs in the unified launch path (the
 * inert default launcher previously wrote an ~80-byte stub, so a unified-launched operator
 * booted with no role and idled):
 *   - `cto`    → the full CTO operator brief (create-stories-not-tasks + channel routing).
 *   - `leader` → a TIGHT per-story leader brief: a one-line title derived from the story's
 *                LIVE brief (fetched fresh via getStoryRow) + an instruction to GET the live
 *                brief/subtasks itself; a missing/gone story row falls back to a non-stub
 *                brief keyed on the work_id (still instructing the runtime fetch).
 *   - `build`  → unreachable via the default launcher (it throws for build kind), but a safe
 *                minimal brief rather than the stub, for defensiveness.
 */
export function buildWorkspaceBrief(row: WorkspaceAgentRow): string {
  return SUPERVISOR_KINDS[row.kind].buildBrief(row);
}

// ---- SUPERVISOR CAPABILITY TABLE (REVAMP-4 Phase 0 / S0c) ------------------
// A single per-kind CAPABILITY TABLE encoding what each workspace `kind` IS and DOES, so a future
// supervisor tier is ONE TABLE ROW instead of scattered `kind === "…"` conditionals (CTO ruling).
// It is the single source consulted by the seven per-kind decisions across this module — agent
// NAME, launch COMMAND, channel SCOPE, brief, the operator-vs-build gate (launcher + startup/
// mid-session probes), and the enable gate. The cto/leader/build rows reproduce today's behavior
// BYTE-FOR-BYTE (proven by the existing name assertions + the capability-table test); the 'ceo'
// row is now LIVE-CAPABLE behind the per-project CEO enable (REVAMP-4 Phase 3 / P3c): its `enabled`
// resolves isCeoEnabled(row.work_id) — the project node's ceo_enabled tri-state vs config.ceoAgentEnabled
// (DEFAULT OFF), so with no project nodes + the default off no ceo ever boots (prod byte-identical),
// and enabling a project's CEO (setWorkspaceCeoEnabled) makes the supervisor launch/relaunch it via
// the SAME table-driven boot/reconcile/gave_up/teardown paths — no ceo-specific branch. NOTHING here
// touches resolveWorkResponder / routeOwns.
type SupervisorKind = {
  // The work_kind of the NODE this kind supervises in the recursive Work tree: 'node' (a story)
  // for a leader, 'repo' for a cto, 'project' for a ceo; null for a build (a leaf EXECUTOR — it
  // supervises nothing). Declarative tier metadata referencing the S0a work_kind values; no branch
  // consumes it yet (it documents the recursive PROJECT/CEO tier the table is being shaped for).
  supervisedNodeKind: "node" | "repo" | "project" | null;
  // Is this a long-lived butchr-launched OPERATOR agent (vs a dispatcher-owned build executor)?
  // Gates BOTH the shared herdr launcher (a build is never launched here — its worktree/branch
  // provisioning stays DISPATCHER-owned) AND the startup/mid-session pane probes.
  isOperator: boolean;
  // Is this workspace ENABLED for boot auto-start + supervision? A DISABLED kind is torn down and
  // never (re)launched. cto → the directory's cto_enabled tri-state; leader/build → always on (no
  // enable gate today); ceo → const false (INERT until Phase 3 wires a real project-enable).
  enabled: (row: WorkspaceAgentRow) => boolean;
  // The herdr agent NAME (NAME-ONLY identity), derived per kind to MATCH today's names.
  agentName: (row: WorkspaceAgentRow) => string;
  // The configured launch COMMAND template for an operator launch (a build never launches here).
  agentCmd: () => string;
  // The kind-scoped channel MCP env fields, merged OVER the base connectivity env.
  channelEnv: (row: WorkspaceAgentRow) => Record<string, string>;
  // The role/instructions written to the launched workspace's brief.md.
  buildBrief: (row: WorkspaceAgentRow) => string;
};

export const SUPERVISOR_KINDS: Record<WorkspaceAgentRow["kind"], SupervisorKind> = {
  cto: {
    supervisedNodeKind: "repo",
    isOperator: true,
    enabled: (row) => isCtoEnabled(row.directory_id ?? ""),
    agentName: (row) => `${config.ctoAgentName}-${row.directory_id ?? ""}`,
    agentCmd: () => config.ctoAgentCmd,
    channelEnv: (row) => (row.directory_id ? { BUTCHR_CHANNEL_WORKSPACE: row.directory_id } : {}),
    buildBrief: () => CTO_WORKSPACE_BRIEF,
  },
  leader: {
    supervisedNodeKind: "node",
    isOperator: true,
    enabled: () => true,
    agentName: (row) => `${config.ctoAgentName}-story-${row.work_id ?? ""}`,
    agentCmd: () => config.storyAgentCmd,
    channelEnv: (row) => ({
      ...(row.work_id ? { BUTCHR_CHANNEL_STORY: row.work_id } : {}),
      ...(row.directory_id ? { BUTCHR_CHANNEL_WORKSPACE: row.directory_id } : {}),
    }),
    buildBrief: (row) => {
      const storyId = row.work_id ?? row.id;
      const story = getStoryRow(storyId);
      return buildLeaderBrief(storyId, storyBriefTitle(story?.brief ?? null));
    },
  },
  build: {
    supervisedNodeKind: null,
    isOperator: false,
    enabled: () => true,
    agentName: (row) => row.work_id ?? row.id, // the task id is the agent name
    agentCmd: () => config.ctoAgentCmd, // unused — a build is never launched by this module
    channelEnv: () => ({ BUTCHR_CHANNEL_CONNECTIVITY_ONLY: "1" }),
    // build kind is not launched by the default launcher; keep a valid (non-stub) brief.
    buildBrief: (row) => `# butchr build agent

You are a butchr-managed build agent for work ${row.work_id ?? row.id}. Fetch your task
with \`GET /api/work/${row.work_id ?? row.id}\` and carry it out under review.
`,
  },
  ceo: {
    supervisedNodeKind: "project",
    isOperator: true,
    // LIVE behind the per-project CEO enable (REVAMP-4 Phase 3 / P3c): a ceo row is enabled iff its
    // project NODE (row.work_id) has ceo_enabled effectively true (its own tri-state, else the
    // global config.ceoAgentEnabled — DEFAULT OFF). The CEO analog of cto's isCtoEnabled(directory).
    // DEFAULT OFF ⇒ with no config.ceoAgentEnabled + no project nodes, no ceo ever boots and a
    // stray desired=1 ceo row is torn down by the enabled-gate (prod byte-identical).
    enabled: (row) => isCeoEnabled(row.work_id ?? ""),
    // herdr name `<prefix>-project-<projectNodeId>` (its work_id IS the project NODE, mirroring a
    // leader's story work_id); the row-id convention is `ws-ceo-<projectNodeId>` (setWorkspaceCeoEnabled).
    agentName: (row) => `${config.ctoAgentName}-project-${row.work_id ?? ""}`,
    agentCmd: () => config.ctoAgentCmd,
    // The kind-scoped channel MCP env: BUTCHR_CHANNEL_PROJECT (the project NODE) puts the channel
    // bridge in PROJECT mode (channel.ts, REVAMP-4 P3b — already wired), plus BUTCHR_CHANNEL_WORKSPACE
    // for the anchor directory. When a ceo launches (P3c) writeWorkspaceMcpConfig now writes these.
    channelEnv: (row) => ({
      ...(row.work_id ? { BUTCHR_CHANNEL_PROJECT: row.work_id } : {}),
      ...(row.directory_id ? { BUTCHR_CHANNEL_WORKSPACE: row.directory_id } : {}),
    }),
    // The CEO operator brief (REVAMP-4 P3c). A booted CEO has a real ROLE so it does not idle-crash,
    // but is HONEST that its directive surface (registering repos under the project, creating
    // initiatives) is NOT yet enabled (P3d) — so it STANDS BY. It owns no actionable work until
    // P3d, so it stays fully SILENT: reconcileOperatorIdle PUSHES only for kind==='leader', and
    // setWorkspaceIdle projects only cto/leader — so a ceo neither escalates nor records a durable
    // idle projection. Deliberately does NOT tell it to GET /api/work/<project> — resolveWork 404s a
    // 'project' node (P3a); the directive/read surface lands in P3d.
    buildBrief: (row) => buildCeoBrief(row.work_id ?? row.id),
  },
};

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
// The unified successor to the legacy cto/story per-agent state maps, keyed by the workspace id.
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
// the OPERATOR kinds (cto/leader); build-context provisioning (a git worktree + branch) stays
// DISPATCHER-owned and is never provisioned here, so the default launcher throws for
// kind='build' rather than pretending to provision one.
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
 * otherwise RESUME the persisted session, else a fresh id (no operator-seeded map at this
 * layer). Pure + exported for testing.
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
 * build → connectivity-only). Returns the config path. Generalizes the legacy per-cto and
 * per-story channel MCP-config writers.
 */
function writeWorkspaceMcpConfig(row: WorkspaceAgentRow): string {
  mkdirSync(workspaceDir(row.id), { recursive: true });
  const env: Record<string, string> = {
    BUTCHR_CHANNEL_SSE_URL: `http://${config.loopbackHost}:${config.port}/api/events`,
    // Per-kind channel SCOPE from the capability table (cto → workspace; leader → story +
    // workspace; build → connectivity-only) — byte-identical to the former per-kind branch.
    ...SUPERVISOR_KINDS[row.kind].channelEnv(row),
  };
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
  const cmd = SUPERVISOR_KINDS[row.kind].agentCmd();
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
    if (!SUPERVISOR_KINDS[row.kind].isOperator) {
      throw new Error(
        `unified workspace ${row.id}: ${row.kind}-kind launch (worktree + branch provisioning) ` +
          `stays DISPATCHER-owned; not provisioned by this launcher`,
      );
    }
    const cwd = directoryPath(row.directory_id);
    if (!cwd) throw new Error(`workspace ${row.id}: directory ${row.directory_id} is gone`);

    const name = workspaceAgentName(row);
    const { sessionId, isResume } = resolveWorkspaceSession(getWorkspaceAgentRow(row.id), fresh);
    const sessionFlag = isResume ? `--resume ${sessionId}` : `--session-id ${sessionId}`;
    const mcpConfig = writeWorkspaceMcpConfig(row);
    const promptFile = join(workspaceDir(row.id), "brief.md");
    writeFileSync(promptFile, buildWorkspaceBrief(row), "utf8");
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
 * Mirrors the legacy adopt-or-launch decision EXACTLY (incl. the reboot-recovery /proc gate): a
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
      if (SUPERVISOR_KINDS[row.kind].isOperator) {
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
 * START (or adopt) a workspace's agent. No-op (returns the current status) when the workspace
 * row is gone. Marks it DESIRED-up; adopts a live agent (single-instance) or launches —
 * RESUMING the persisted session unless `fresh`.
 */
export function startWorkspaceAgent(
  id: string,
  opts: { fresh?: boolean } = {},
): Promise<WorkspaceAgentStatus> {
  const row = getWorkspaceAgentRow(id);
  if (!row) return workspaceAgentStatus(id);
  return ensureStarted(row, !!opts.fresh).then((r) => r.status);
}

/**
 * STOP a workspace's agent: mark it DESIRED-down (survives a restart), clear its owned-agent
 * marker, and tear it down + free its name. Idempotent.
 */
export function stopWorkspaceAgent(id: string): Promise<WorkspaceAgentStatus> {
  // STOP MUST WIN over an in-flight launch. guarded() early-returns the in-flight launch promise
  // when launchInFlight is set, which would SWALLOW the stop body below — so the desired=0 write
  // must NOT live only inside guarded(). Mark stop-requested + write desired-down SYNCHRONOUSLY
  // here, OUTSIDE the launch-claim, so a stop issued mid-launch always lands; the completing
  // launch's tail re-check (reassertStopAfterLaunch) then forces desired-down deterministically.
  const st = supState(id);
  st.stopRequested = true;
  if (getWorkspaceAgentRow(id)) {
    // Clear the durable idle projection alongside has_agent so a stopped operator never reads
    // stale idle=1 (st-a32c8138 — keep workspace.idle honest for PART 2's dashboard projection).
    // idle_escalated_at → NULL re-arms the repeating idle escalation for a future session
    // (story st-926eea1c — the desired→0 counterpart of setWorkspaceIdle's atomic idle→0 clear).
    saveWorkspaceAgentRow(id, {
      desired: 0,
      has_agent: 0,
      started_at: null,
      idle: 0,
      idle_context: null,
      idle_escalated_at: null,
    });
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
 * RE-ANCHOR a project CEO's workspace-agent row to a NEW directory — its dedicated CEO HOME
 * (story st-307edc78). A managed CEO used to be anchored to its project's member repo directory
 * (setWorkspaceCeoEnabled → directory_id = project.workspace_id), which made ensureHerdrWorkspace
 * key the CEO to the SAME herdr workspace as that repo's CTO (both keyed by directory_id). With one
 * shared herdr workspace, `herdr agent attach <name>` hit the workspace's ACTIVE pane rather than
 * the named agent, so the CTO/CEO terminal buttons crossed. Giving the CEO its OWN directory_id
 * gives it its OWN herdr workspace and disambiguates both buttons.
 *
 * This MOVES an already-anchored row: it frees ONLY the CEO's own pane by its (stable,
 * directory-INDEPENDENT) name — `<prefix>-project-<projectNodeId>` — so the shared herdr workspace
 * and the CTO pane are left fully INTACT (teardown is agentDeregister + teardownTask BY NAME, never
 * a workspace destroy). It then repoints directory_id at `ceoDirId` and CLEARS herdr_workspace +
 * has_agent + started_at so the supervisor relaunches the CEO in the new cwd and ensureHerdrWorkspace
 * mints a FRESH herdr workspace keyed by the new directory. PRESERVES session_id (so the relaunch
 * --resumes the same Claude session — no lost context) and desired (an enabled CEO stays enabled).
 * Idempotent: a no-op when the row is gone, is not a `ceo`, or is already anchored to ceoDirId.
 * Serialized behind the workspace's launchInFlight guard so a racing supervise tick can't relaunch
 * into the OLD workspace mid-move.
 */
export async function reanchorCeoHome(wsId: string, ceoDirId: string): Promise<void> {
  const existing = getWorkspaceAgentRow(wsId);
  if (!existing || existing.kind !== "ceo" || existing.directory_id === ceoDirId) return;
  await guarded(wsId, async () => {
    const row = getWorkspaceAgentRow(wsId);
    if (row && row.kind === "ceo" && row.directory_id !== ceoDirId) {
      await launcher.teardown(workspaceAgentName(row)); // free ONLY the CEO pane by name
      saveWorkspaceAgentRow(wsId, {
        directory_id: ceoDirId,
        herdr_workspace: null,
        has_agent: 0,
        started_at: null,
      });
      console.log(
        `[butchr] re-anchored CEO ${wsId} → directory ${ceoDirId} ` +
          `(session ${row.session_id ?? "—"} preserved; supervisor relaunches in new home)`,
      );
    }
    return workspaceAgentStatus(wsId);
  });
}

/**
 * The single LIVE workspace for a unit of Work (db.liveWorkspaceForWork), exposed here as
 * the unified module's reader for the RFC-Q3 1:N "one live per Work" relationship.
 */
export function liveWorkspaceFor(workId: string): WorkspaceAgentRow | null {
  return liveWorkspaceForWork(workId);
}

// ---- CTO-COMPAT SURFACE (REVAMP-1 Phase C, S3) --------------------------------------------
// The /api/workspaces/:id/cto/* routes (server.ts) + the unregisterWorkspace teardown
// (workspaces.ts) historically called the legacy per-workspace launcher (cto-agent.ts). Those
// callers address a DIRECTORY by its id; the unified `workspace` row backing that directory's
// CTO agent is `ws-cto-<id>`. These thin wrappers map that id and adapt the unified
// WorkspaceAgentStatus back to the legacy CtoStatus shape the dashboard consumes, so the route
// response JSON is byte-identical. The legacy cto-agent.ts launcher was deleted in Phase C S5.
//
// The LIFECYCLE ops (start/stop/restart) re-publish `cto.updated` with the CtoStatus payload
// EXACTLY as the legacy publishStatus did — the unified start/stop path
// publishes `story.attention`, NOT `cto.updated`, so without this the dashboard CTO card (and
// server.ts's live update) would stop refreshing on start/stop/restart. The plain STATUS read
// does NOT publish (matching the legacy ctoAgentStatus, which never did).

/** The dashboard/API view of a directory's managed CTO agent state (the legacy CtoStatus shape;
 *  relocated here from cto-agent.ts, which was deleted in Phase C S5). */
export type CtoStatus = {
  /** The workspace (directory) this CTO agent belongs to. */
  workspaceId: string;
  /** Per-directory enable (cto_enabled, or the global default). */
  enabled: boolean;
  /** The operator/boot WANTS it up (supervisor relaunches on death). */
  desired: boolean;
  /** A live herdr agent is registered under this directory's CTO name (async-probed). */
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

/** The unified `workspace` row id backing a directory's CTO agent. */
function ctoWsId(directoryId: string): string {
  return `ws-cto-${directoryId}`;
}

/** The herdr agent name for a directory's CTO agent (== the legacy cto-agent.ctoAgentName and
 *  the unified workspaceAgentName of the `ws-cto-<id>` row). Used by the CTO terminal-attach route. */
export function ctoAgentName(directoryId: string): string {
  return `${config.ctoAgentName}-${directoryId}`;
}

/** Adapt the unified WorkspaceAgentStatus for `ws-cto-<id>` to the legacy CtoStatus shape. */
async function toCtoStatus(directoryId: string): Promise<CtoStatus> {
  const s = await workspaceAgentStatus(ctoWsId(directoryId));
  return {
    workspaceId: directoryId,
    enabled: isCtoEnabled(directoryId),
    desired: s.desired,
    running: s.running,
    sessionId: s.sessionId,
    since: s.since,
    restarts: s.restarts,
    lastError: s.lastError,
  };
}

/** Compute a directory's CtoStatus and publish a `cto.updated` event (mirrors legacy publishStatus). */
async function publishCtoStatus(directoryId: string): Promise<CtoStatus> {
  const s = await toCtoStatus(directoryId);
  publish({ type: "cto.updated", cto: s });
  return s;
}

/** A directory's current managed-CTO-agent status. A READ — does NOT publish (like legacy ctoAgentStatus). */
export function ctoAgentStatus(directoryId: string): Promise<CtoStatus> {
  return toCtoStatus(directoryId);
}

// ---- MANAGED CEO AGENT STATUS (PER-PROJECT) ---------------------------------
// The CEO analog of the CTO status read (REVAMP-4 P3c). A project node's managed CEO agent is a
// unified `workspace` runtime row keyed `ws-ceo-<projectNodeId>` (kind='ceo'), materialized by
// setWorkspaceCeoEnabled. This is a pure READ for the dashboard's project CEO card — the four
// fields are the S5 CEO-card contract, so do NOT rename them.

/** The unified `workspace` row id backing a project node's CEO agent (== setWorkspaceCeoEnabled). */
function ceoWsId(projectNodeId: string): string {
  return `ws-ceo-${projectNodeId}`;
}

/** The herdr agent name for a project node's CEO agent (== the unified workspaceAgentName of the
 *  `ws-ceo-<id>` row per SUPERVISOR_KINDS.ceo.agentName). Mirrors ctoAgentName; used by the CEO
 *  terminal-attach route. This is the EXACT name workspaceAgentStatus probes for liveness. */
export function ceoAgentName(projectNodeId: string): string {
  return `${config.ctoAgentName}-project-${projectNodeId}`;
}

/** The dashboard/API view of a project node's managed CEO agent state (REVAMP-4 P3c CEO card). */
export type CeoStatus = {
  /** Per-project enable (project.ceo_enabled tri-state, or the global default). */
  enabled: boolean;
  /** The project row carries an EXPLICIT ceo_enabled override (vs inheriting the global gate). */
  overridden: boolean;
  /** The GLOBAL default gate (config.ceoAgentEnabled / BUTCHR_CEO_AGENT). */
  globalGate: boolean;
  /** The managed CEO runtime row is wanted up AND a live herdr agent is registered under it. */
  live: boolean;
};

/** A project node's current managed-CEO-agent status. A READ — does NOT publish (mirrors
 *  ctoAgentStatus). Returns null if the id is not a project node. */
export async function ceoAgentStatus(projectNodeId: string): Promise<CeoStatus | null> {
  const project = getProject(projectNodeId);
  if (!project) return null;
  const s = await workspaceAgentStatus(ceoWsId(projectNodeId));
  return {
    enabled: isCeoEnabled(projectNodeId),
    overridden: project.ceo_enabled !== null,
    globalGate: config.ceoAgentEnabled,
    live: s.desired && s.running,
  };
}

/** START (or adopt) a directory's CTO agent via the unified path, then publish `cto.updated`. */
export async function startCtoAgent(
  directoryId: string,
  opts: { fresh?: boolean } = {},
): Promise<CtoStatus> {
  ensureWorkspaceAgentRow(ctoWsId(directoryId), { kind: "cto", directory_id: directoryId });
  await startWorkspaceAgent(ctoWsId(directoryId), opts);
  return publishCtoStatus(directoryId);
}

/** STOP a directory's CTO agent via the unified path, then publish `cto.updated`. */
export async function stopCtoAgent(directoryId: string): Promise<CtoStatus> {
  await stopWorkspaceAgent(ctoWsId(directoryId));
  return publishCtoStatus(directoryId);
}

/** RESTART a directory's CTO agent (stop + start), mirroring legacy restartCtoAgent — each of the
 *  stop/start publishes `cto.updated`, so the emission matches the legacy path exactly. */
export async function restartCtoAgent(
  directoryId: string,
  opts: { fresh?: boolean } = {},
): Promise<CtoStatus> {
  await stopCtoAgent(directoryId);
  return startCtoAgent(directoryId, { fresh: opts.fresh });
}

/**
 * Is a node-Work GENUINELY terminal? Reads the AUTHORITATIVE node status via storyStatusOf
 * (== getStory().status — the same value /api/work/:id + storyView report). Terminal ==
 * `done` or `aborted`; `open`/`merging`/`merge_blocked` are NOT terminal (the leader is KEPT up).
 *
 * As of REVAMP Phase B.4 (story st-6372812d) storyStatusOf reads the node's OWN `tasks` row
 * (guarded work_kind='node'), which now carries the node's REAL lifecycle status — no longer
 * the old frozen `merged` anchor a raw-status check used to trip over. The read still routes
 * through storyStatusOf (db.ts) rather than an inline query so workspace-agent.ts keeps no
 * story import and the source stays swappable in one place.
 */
function nodeWorkIsTerminal(workId: string | null): boolean {
  if (!workId) return false;
  const status = storyStatusOf(workId);
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
  saveWorkspaceAgentRow(id, {
    desired: 0,
    has_agent: 0,
    started_at: null,
    idle: 0,
    idle_context: null,
    idle_escalated_at: null, // re-arm the repeating idle escalation for a future session (st-926eea1c)
  });
  await launcher.teardown(workspaceAgentName(row)).catch(() => {});
  st.stopRequested = false;
  return true;
}

/**
 * COMPLETION TEARDOWN (unified path): a node-Work reached a terminal state (done/aborted), so
 * tear down its LEADER workspace(s) — desired-down + close the pane + free the name — so the
 * supervisor stops relaunching them. The unified counterpart of onStoryStatusChanged's
 * stopStoryAgent (an unconditional desired-down, robust whether or not currently live). No-op
 * when the node has no leader workspace row. Best-effort per row; never throws to the caller.
 * Only LEADER rows are touched — a node's cto/build workspaces are left alone.
 */
export async function teardownLeaderWorkspaceForWork(workId: string): Promise<void> {
  for (const row of listWorkspaceAgentRowsForWork(workId)) {
    if (row.kind !== "leader") continue;
    await stopWorkspaceAgent(row.id).catch(() => {});
  }
}

/** Reconcile ONE workspace toward its desired state (the unified successor to the legacy
 *  per-cto/per-story reconcile). */
export async function reconcileWorkspaceAgent(
  id: string,
  herdrUp: boolean,
): Promise<{ action: "disabled" | "skipped" | "stopped" | "adopted" | "launched" }> {
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
  // ADDED ALONGSIDE the leader gate (does not touch any other kind's path). Now table-driven:
  // SUPERVISOR_KINDS[kind].enabled — cto → isCtoEnabled(dir), leader/build → always true (no gate,
  // unchanged), ceo → const false (a stray desired=1 ceo row is torn down — inert in Phase 0).
  if (!SUPERVISOR_KINDS[row.kind].enabled(row)) {
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
 * BOOT RECONCILE: bring every DESIRED-up workspace into its desired state once. Wired into
 * src/index.ts as the sole operator-agent boot reconcile.
 */
export async function reconcileWorkspaceAgents(
  herdrUp: boolean,
): Promise<{ adopted: number; launched: number; skipped: number }> {
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

/**
 * The tail of an OPERATOR workspace's agent.log — the `idle_context` snapshot captured on the
 * genuine-idle flip (setWorkspaceIdle), the operator analog of dispatcher.readRunLogTail. Returns
 * "" if the log is missing/unreadable or `lines <= 0`; only runs on the rare idle-flip, so the
 * whole-file read is fine.
 */
function readWorkspaceLogTail(id: string, lines: number): string {
  if (lines <= 0) return "";
  try {
    const text = readFileSync(join(workspaceDir(id), "agent.log"), "utf8");
    return text.split("\n").slice(-lines).join("\n");
  } catch {
    return "";
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
  // strictStuck: a paused-but-active operator whose pane incidentally shows ordinary numbered
  // output must NOT be surfaced as a stuck dialog (scope 5, st-a32c8138) — require a REAL
  // blocking-dialog anchor. A genuine y/n / dev-channels / trust prompt is STILL surfaced.
  const cls = classifyStartupScreen(screen, deps.rules, { strictStuck: true });

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

/** The Q2 HOLD LABEL for an idle leader (story st-926eea1c, CTO refinement 3): NAMES what the
 * leader is sitting on AND whether an OPEN ask exists, so the responder knows ANSWER-vs-WIND-DOWN.
 *   - an OPEN story-level pending_ask → "held pending <ask> (open ask)" ⇒ the responder ANSWERS.
 *   - else a genuinely-complete story (leaderStoryAwaitsCompletion / isStoryComplete) →
 *     "done, awaiting retire (no open ask)" ⇒ the responder WINDS DOWN (desired=0).
 *   - else generic "idle".
 * Pure read (getStoryRow + attention predicates). S1 only READS pending_ask to surface the label;
 * S2 adds the leader BEHAVIOR that raises the ask. A non-leader / no-story row → generic idle. */
type IdleHold = { label: string; hasOpenAsk: boolean; awaitsCompletion: boolean };
function idleHoldLabel(row: WorkspaceAgentRow): IdleHold {
  const story = row.kind === "leader" && row.work_id ? getStoryRow(row.work_id) : null;
  const ask = story?.pending_ask?.trim() || null;
  if (ask) return { label: `held pending ${ask} (open ask)`, hasOpenAsk: true, awaitsCompletion: false };
  if (leaderStoryAwaitsCompletion(row)) {
    return { label: "done, awaiting retire (no open ask)", hasOpenAsk: false, awaitsCompletion: true };
  }
  return { label: "idle", hasOpenAsk: false, awaitsCompletion: false };
}

/**
 * OPERATOR-IDLE → HIGHER-UP reconciliation for ONE live operator workspace (stories st-a32c8138 +
 * st-926eea1c) — the operator generalization of the build-agent idle→responder signal. Two effects,
 * both driven off the SAME genuine-idle gate the mid-session probe uses (isGenuinelyIdle(
 * workspaceQuietMs)) — the genuine-idle gate is AUTHORITATIVE and UNCHANGED, so an ACTIVE agent is
 * NEVER flagged:
 *
 *  1. DURABLE IDLE PROJECTION (both cto|leader): setWorkspaceIdle records PURE genuine-idle (a
 *     gave_up-shaped durable input) + the agent.log tail as idle_context on the flip. For a LEADER
 *     the idle_context is PREFIXED with the Q2 hold label (held-pending-ask vs done-awaiting-retire),
 *     so the durable snapshot NAMES the hold + whether an open ask exists (CTO refinement 3). PART 2
 *     (warm-slate-c7b8) reads this as a sync DB projection for the CTO dashboard case.
 *
 *  2. LEADER → CTO REPEATING PUSH (leader only): a genuinely-idle, desired-up leader re-fires a
 *     `story.attention {target:cto, reason:'leader-idle'}` on a FLAT cadence (config.idleEscalateEveryMs
 *     = 15 min) until it goes active OR is retired (desired=0) — an idle leader is NEVER a silent
 *     dead-end (story st-926eea1c). The old zero-actionable SUPPRESSION is DROPPED: genuine-idle
 *     ALONE escalates, so a leader parked on an unmet cross-story gate (zero owned items) still
 *     nags. operatorActionableItems is now payload CONTEXT (how many/which owned items) only.
 *
 *     The cadence is deduped by the DURABLE workspace.idle_escalated_at timestamp — NOT an
 *     in-process flag. This is the fix: the retired st.lastIdleSignaled reset on every butchr
 *     restart, so after a restart the push re-fired once then went silent forever. The durable
 *     stamp SURVIVES a restart, so a still-idle leader keeps re-firing on cadence. It is cleared to
 *     NULL ATOMICALLY with the idle→0 flip (setWorkspaceIdle) and the desired→0 teardown, re-arming
 *     a fresh future episode. The CTO's own idle case is NOT pushed: PART 2 surfaces it on the
 *     dashboard from the durable idle + operatorActionableItems.
 *
 * The `leader-idle` event carries NO `marker`: it is a LIVE transition signal (never resynced), so
 * — like `ask-answered`/`complete` — it must bypass the bridge's reconnect-resync de-dup set; a
 * count-based marker would WRONGLY suppress a genuine later episode with the same count.
 *
 * Best-effort + synchronous (a cheap peek+guard); never throws so a supervise tick is unaffected.
 * `deps.idle` / `deps.now` are injectable for tests (default to the production genuine-idle gate +
 * Date.now, so the cadence is drivable deterministically).
 */
export function reconcileOperatorIdle(
  row: WorkspaceAgentRow,
  deps: { idle?: () => boolean; now?: () => number } = {},
): void {
  const idleNow = (deps.idle ?? (() => isGenuinelyIdle(workspaceQuietMs(row.id))))();
  const now = (deps.now ?? Date.now)();

  // 1) Durable projection (both cto|leader): PURE genuine-idle (not the compound). For a leader the
  //    idle_context tail is PREFIXED with the Q2 hold label; captured only on the 0→1 flip.
  setWorkspaceIdle(row.id, idleNow, () => {
    const tail = readWorkspaceLogTail(row.id, config.idleContextLines);
    if (row.kind !== "leader") return tail;
    const label = idleHoldLabel(row).label;
    return tail ? `[${label}]\n${tail}` : `[${label}]`;
  });

  // 2) Leader → CTO repeating push only. The CTO's own idle case is surfaced by PART 2 on the
  //    dashboard (from the durable idle + operatorActionableItems), so it is NOT pushed here.
  if (row.kind !== "leader") return;
  // Active OR retired → nothing to escalate. Both are the "resolved" condition; idle_escalated_at
  // has already been re-armed (NULL) by setWorkspaceIdle's idle→0 clear / the desired→0 teardown.
  if (!idleNow || row.desired !== 1) return;

  // 3) Durable repeating cadence: re-fire only when the flat interval has elapsed since the last
  //    escalation (idle_escalated_at). NULL (a fresh/re-armed episode) fires immediately. NO
  //    zero-actionable suppression — genuine-idle alone escalates. `row` is fetched fresh each
  //    supervise tick, and in this branch idleNow is true (so setWorkspaceIdle did not clear the
  //    stamp), making row.idle_escalated_at authoritative.
  const last = row.idle_escalated_at;
  if (last != null && now - last < config.idleEscalateEveryMs) return; // still within the cadence
  publishLeaderIdle(row, operatorActionableItems(row), idleHoldLabel(row));
  saveWorkspaceAgentRow(row.id, { idle_escalated_at: now });
}

/** Build + publish the `leader-idle` story.attention to the CTO: the Q2 hold label (what the leader
 * is held on + whether an open ask exists) plus the count and ids of the owned items it is sitting
 * on (payload CONTEXT — no longer a gate). */
function publishLeaderIdle(
  row: WorkspaceAgentRow,
  items: AttentionItem[],
  hold: IdleHold,
): void {
  const count = items.length + (hold.awaitsCompletion ? 1 : 0);
  const parts = items.slice(0, 4).map((i) => `${i.id} (${i.reason})`);
  if (hold.awaitsCompletion) parts.push("story ready for completion review");
  if (items.length > 4) parts.push(`+${items.length - 4} more`);
  const owned = parts.length ? `: ${parts.join(", ")}` : "";
  publish({
    type: "story.attention",
    story_id: row.work_id ?? "",
    workspace_id: row.directory_id ?? "",
    target: "cto",
    reason: "leader-idle",
    detail: `leader idle — ${hold.label}; ${count} item(s) awaiting${owned}`,
    // No marker — a live transition signal, deduped by the DURABLE idle_escalated_at, never resynced.
  });
}

// One supervision tick over ALL workspaces (the unified successor to the legacy cto/story
// supervise tick). Each
// desired-up-but-dead workspace is relaunched (RESUMING the same session) with bounded
// per-workspace exponential backoff.
async function superviseTick(): Promise<void> {
  for (const row of listWorkspaceAgentRows()) {
    await superviseWorkspace(row.id);
  }
}

async function superviseWorkspace(id: string): Promise<void> {
  const row = getWorkspaceAgentRow(id);
  if (!row || row.desired !== 1) return; // wanted down (or gone)
  // A DISABLED CTO is never relaunched — short-circuit BEFORE the dead-while-desired relaunch/
  // backoff branch below (the legacy per-cto supervisor had the same top `if (!isCtoEnabled) return`).
  // A stray desired=1 ws-cto row whose directory has cto_enabled effectively false thus never
  // triggers a launch attempt. Table-driven (SUPERVISOR_KINDS[kind].enabled): cto → isCtoEnabled;
  // leader/build → always true (no gate, unchanged); ceo → const false (never relaunched — inert).
  if (!SUPERVISOR_KINDS[row.kind].enabled(row)) return;
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
    if (SUPERVISOR_KINDS[row.kind].isOperator) {
      // Durable operator-idle projection + the idle→higher-up push (story st-a32c8138). Runs every
      // tick (a cheap peek+guard); shares the probe's genuine-idle gate. Best-effort — never throws.
      reconcileOperatorIdle(row);
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

/** Start the unified-workspace supervisor poll loop. No-op when already running. */
export function startWorkspaceAgentSupervisor(): void {
  if (superviseTimer) return;
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

// ============================================================================
// STORY-LEADER LIFECYCLE HOOKS (moved here from the legacy story-agent.ts launcher —
// REVAMP-1 Phase C S2; that launcher was deleted in S5). These are the LIVE story
// create/status/teardown hooks the CRUD layer (stories.ts) and unregisterWorkspace
// (workspaces.ts) call. They materialize + tear down the unified `workspace` leader row;
// the legacy `story_agent` table is still mirror-written here because storyAgentStatus —
// the story view's `leader` field — reads it. This is now the SOLE story-leader path: the
// old story-agent.ts supervisor (which used to share the helpers below) is gone.
// ============================================================================

/** The view of a story's managed leader-agent state (mirrors CtoStatus / WorkspaceAgentStatus). */
export type StoryAgentStatus = {
  /** The story this leader belongs to. */
  storyId: string;
  /** The leader is DESIRED up (the story is open — supervisor relaunches on death). */
  desired: boolean;
  /** A live herdr agent is registered under this story's leader name (async-probed). */
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

/** The herdr agent name for a story's leader: `<prefix>-story-<storyId>`. The `story-`
 *  infix guarantees no collision with a workspace's CTO name (`<prefix>-<workspaceId>`).
 *  Matches workspaceAgentName(row) for a kind='leader' row, by design. */
export function storyAgentName(storyId: string): string {
  return `${config.ctoAgentName}-story-${storyId}`;
}

/**
 * Resilient story_agent write: persist the patch ONLY while the story still exists, else
 * no-op. saveStoryAgentRow requires the FK target (the story row) to exist; but deleteStory
 * is SYNCHRONOUS and fires the leader's launch/teardown FIRE-AND-FORGET, so a story (and its
 * cascade-linked story_agent row) can vanish WHILE a launch/supervise/reconcile write is in
 * flight. Routing every story-leader write through here keeps those best-effort paths from
 * FK-crashing on that race.
 */
export function saveRow(storyId: string, patch: Parameters<typeof saveStoryAgentRow>[1]): void {
  if (getStoryRow(storyId)) saveStoryAgentRow(storyId, patch);
}

// ---- legacy story-leader supervision state ----
// A SINGLE map, hosted here so the moved teardown hooks serialize against the SAME per-story
// launchInFlight (exact single-instance semantics). Kept
// separate from the unified supStates above so a legacy stopStoryAgent never entangles with the
// unified ws-leader launch guard.
type StoryLeaderState = {
  launchInFlight: Promise<StoryAgentStatus> | null;
  consecutiveFailures: number;
  nextRetryAt: number;
};
const storyStates = new Map<string, StoryLeaderState>();
export function storyState(storyId: string): StoryLeaderState {
  let s = storyStates.get(storyId);
  if (!s) {
    s = { launchInFlight: null, consecutiveFailures: 0, nextRetryAt: 0 };
    storyStates.set(storyId, s);
  }
  return s;
}

/** Serialize a lifecycle op for a story behind its launchInFlight (single-instance). */
export function guardedStory(
  storyId: string,
  fn: () => Promise<StoryAgentStatus>,
): Promise<StoryAgentStatus> {
  const st = storyState(storyId);
  if (st.launchInFlight) return st.launchInFlight;
  const p = fn().finally(() => {
    if (st.launchInFlight === p) st.launchInFlight = null;
  });
  st.launchInFlight = p;
  return p;
}

/**
 * Hook: a story was CREATED (lands `open`). Mark its leader DESIRED synchronously (so the
 * story_agent row exists immediately) then materialize the unified leader `workspace` row and
 * kick its launch best-effort (fire-and-forget — never fails/blocks story creation; a launch
 * error is recorded on the row).
 *
 * NOTE (REVAMP-1 Phase C S2): the legacy flag-OFF `launchStoryAgent` branch was intentionally
 * DROPPED here per the CEO-approved unified flip — the unified `workspace` path is now the SOLE
 * launcher (Phase C S4 removed the flag that once toggled it).
 */
export function onStoryCreated(storyId: string): void {
  // NODE-ON-NODE SEQUENCING GATE (story st-30a7dccd, RFC Q3): a story that carries an unmerged
  // blocker on its own `tasks.blocked_by` is NOT launched yet — its leader is released by the
  // unblock sweep (reevaluateBlockedStoryNodes) once every blocker has merged/died. A story with
  // an EMPTY blocked_by (the overwhelming default) is trivially releasable → this returns true and
  // the launch below is BYTE-IDENTICAL to before. Inert until a node is actually given a blocker.
  if (!storyLeaderReleasable(storyId)) return;
  saveRow(storyId, { desired: 1 }); // legacy story_agent MIRROR (kept; storyAgentStatus reads it)
  // UNIFIED CREATE-TIME ROW (story st-93384200, Bug 3): materialize this leader's unified
  // `workspace` row NOW so the unified supervisor — the SOLE launcher — launches AND
  // relaunches-on-death it immediately, without waiting for a restart to re-seed it.
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
  // `tasks` (workspace.work_id FK). A story can be created with NO members yet — so materialize
  // it NOW (idempotent INSERT OR IGNORE) or the ws-leader insert below FK-fails.
  ensureStoryWorkNode(storyId);
  const wsId = `ws-leader-${storyId}`;
  // directory_id = the story's workspace (NEVER null — guarded above), so the row is visible to
  // unregister enumeration; work_id binds it to the story node; has_agent 0 on create.
  ensureWorkspaceAgentRow(wsId, { kind: "leader", work_id: storyId, directory_id: story.workspace_id });
  saveWorkspaceAgentRow(wsId, { desired: 1 });
  // Optional low-latency kick: launch NOW instead of waiting for the next supervise tick.
  // startWorkspaceAgent serializes through the SAME per-id launchInFlight guard the supervisor
  // uses (guarded), so a kick racing a concurrent supervise tick JOINS the in-flight launch.
  void startWorkspaceAgent(wsId).catch((e) => {
    saveRow(storyId, { last_error: (e as Error).message });
    console.error(`[butchr] story leader launch failed for ${storyId}: ${(e as Error).message}`);
  });
}

// Register the story-leader launch/stop hooks with the blocked_by engine in tasks.ts. tasks.ts
// holds the dependency-set helpers but must NOT import workspace-agent (cycle: workspace-agent
// already imports tasks). So the leader lifecycle is injected here: the node-on-node sequencing
// engine (setStoryBlockedBy + reevaluateBlockedStoryNodes) calls `launch` to release a node whose
// blockers cleared and `stop` to hold one that just gained a pending blocker (kill-on-block).
//   launch = onStoryCreated — idempotent, re-checks the gate, raises BOTH leader rows desired=1.
//   stop   = down BOTH leader rows onStoryCreated raised: the UNIFIED ws-leader row (the SOLE
//            launcher/supervisor reads it — stopWorkspaceAgent writes desired=0 synchronously so
//            the hold wins over an in-flight launch) AND the legacy story_agent mirror.
setStoryLeaderHooks({
  launch: (nodeId) => onStoryCreated(nodeId),
  stop: (nodeId) => {
    void stopWorkspaceAgent(`ws-leader-${nodeId}`);
    void stopStoryAgent(nodeId);
  },
});

/**
 * Hook: a story's STATUS changed. `open` → (re)desire + launch the leader; `done`/`aborted`
 * → stop it (desired-down + teardown). `merging`/`merge_blocked` KEEP the leader up (no-op:
 * the leader is mid-completion and must stay alive to re-attempt — CONTRIBUTING §11.7, Phase
 * E). Best-effort; never throws into the CRUD caller.
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
 * STOP a story's leader: mark it DESIRED-down (survives a restart) and tear down its
 * tab/pane + free its agent name. Idempotent. Best-effort teardown.
 *
 * ROBUST to the story vanishing mid-teardown: deleteStory is SYNCHRONOUS and fires this
 * fire-and-forget, so the story (and its cascade-linked story_agent row) can disappear while
 * teardown is in flight. We therefore only write story_agent while the story still exists — a
 * save against a deleted story would violate the FK.
 */
export function stopStoryAgent(storyId: string): Promise<StoryAgentStatus> {
  return guardedStory(storyId, async () => {
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

/** A story's current managed leader-agent status (probes herdr for live registration). Reads
 *  the LEGACY story_agent row — the story view's `leader` field is projected from this. */
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

/**
 * Stop EVERY story leader belonging to a workspace (best-effort), called from
 * unregisterWorkspace BEFORE the workspace DELETE so no leader pane is orphaned. The
 * story_agent rows themselves cascade away with the stories/workspace DELETE. Awaitable so
 * the caller can sequence teardown.
 */
export async function stopWorkspaceStoryAgents(workspaceId: string): Promise<void> {
  const stories = db
    .query<{ id: string }, [string]>(`SELECT id FROM tasks WHERE workspace_id=? AND work_kind='node'`)
    .all(workspaceId);
  for (const s of stories) {
    await stopStoryAgent(s.id).catch(() => {});
  }
}

/** Test-only: reset the in-memory legacy story-leader backoff state (one story, or all). */
export function _resetStoryLeaderStateForTest(storyId?: string): void {
  if (storyId) storyStates.delete(storyId);
  else storyStates.clear();
}
