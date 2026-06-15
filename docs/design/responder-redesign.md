# Responder redesign — design (story st-def561dd)

> Status: DESIGN, pending CTO sign-off. Implemented across story st-def561dd as additive,
> gated, INERT code; activated by the final cleanup subtask. Until activation the CURRENT
> (V1) responder model stays live for every in-flight story.

### 1. Target model (structural — no config)

Feedback always goes UP one level to the PARENT, determined by STRUCTURE, never by config:

- Subtask -> its story's LEADER, TERMINAL. A task with `story_id != null` in a feedback
  surface (idea / spec_review / in_review / needs_info, or in_progress+idle) is the LEADER's
  to handle. There is NO task-level escalation to cto/user. The leader is the sole responder.
- Story -> CTO. A story's own feedback is the CTO's: (a) a leader's STORY-LEVEL ask, (b)
  story-completion sign-off, and (c) a story DECOMPOSITION-PLAN the CTO approves before the
  leader fans out (see 4c; this is the design-sign-off seam the leaders themselves use).
- CTO -> USER. The CTO may escalate STORY-level feedback AND NON-STORY-task feedback up to
  the USER. The user is the universal target above the CTO. Escalation exists ONLY at the
  story->cto and cto->user boundaries — NEVER at the subtask level.
- Non-story task (rollback / internal) -> CTO (who may escalate to the user).

Net: CTO <-> stories + leaders; leaders <-> their subtasks. The CTO never handles an
individual subtask's feedback again.

### 2. Data-model changes

REMOVE (config + task-tiering, gone — pre-1.0, no shim):
- `workspaces.step_responders` column.
- `tasks.responder_tier` column.

ADD (additive; unused until activation):
- `tasks.escalated_to_user` INTEGER NOT NULL DEFAULT 0 — set ONLY on a NON-STORY task when the
  CTO escalates it to the user. Models the single cto->user boundary for tasks (replaces the
  3-rung `responder_tier`).
- Story-level ask, on the `stories` table:
  - `pending_ask` TEXT — the leader's open question to the CTO (NULL when none).
  - `ask_responder` TEXT — `cto` or `user`: who currently owns the open ask (NULL when none).

Physical column removal: the two REMOVE columns are dropped via `ALTER TABLE ... DROP COLUMN`
in the ACTIVATION subtask (SQLite >= 3.35; Bun's bundled SQLite supports it). Open question for
sign-off (Q-D): drop physically vs. leave dormant. Recommendation: DROP — pre-1.0, no back-compat.

### 3. pendingResponder rewrite (`tasks.ts`)

`pending_responder` for a TASK collapses to a structural resolution. Let
`isAwaitingFeedback(row)` = (status in {idea, spec_review, in_review, needs_info}) OR
(status == in_progress AND idle). Then:

- not awaiting feedback -> `null`
- story member (`story_id != null`) -> `story` (the leader), ALWAYS — terminal, no tier.
- non-story + NOT `escalated_to_user` -> `cto`
- non-story + `escalated_to_user` -> `user`

Removed: `ESCALATION_CHAIN`, `EscalationRung`, the `responder_tier` index walk. The
`pending_responder` value type becomes `story | cto | user | null`.

### 4. Feedback steps + the step abstraction

`RESPONDER_STEPS`, `ResponderStep`, `feedbackStep`, and `pendingResponderStep` exist today only
to (a) decide WHO responds (now structural — gone) and (b) tell "is this a feedback surface."
Collapse them into a single predicate `isAwaitingFeedback(row): boolean` (status set + idle).
The needs_info plan-vs-question distinction stays derivable from `status + plan_preview` at the
surface that needs it (webapp/CTO), independent of any step name. So:
- REMOVE: `RESPONDER_STEPS`, `ResponderStep`, `Responder` (cto|user) type, `feedbackStep`,
  `pendingResponderStep`, `responderFor`, `resolveStepResponders`, `parseStepResponders`,
  `updateWorkspaceStepResponders`, `isResponderStep`.

#### 4a. Replacing the task `/escalate` endpoint

`POST /api/tasks/:id/escalate` is REDEFINED (same path, new semantics):
- 409 if the task is a STORY MEMBER (`story_id != null`) — subtask feedback is terminal at the
  leader; there is nothing to escalate.
- 409 if not awaiting feedback.
- Otherwise (non-story task): set `escalated_to_user = 1`. `pending_responder` then resolves to
  `user`. Single boundary — re-escalating a task already `escalated_to_user` is a 409.
`escalated_to_user` resets to 0 whenever the task ENTERS a fresh feedback state (mirrors how
`responder_tier` reset today), so a re-opened review starts back at the CTO.

#### 4b. Story-level ask (leader -> CTO), and cto -> user

New endpoints on stories:
- `POST /api/stories/:id/ask {question}` (LEADER) -> sets `pending_ask`, `ask_responder=cto`,
  publishes `story.attention { target:cto, reason:ask, detail:question }`. 409 if an ask is
  already open or the story is not `open`.
- `POST /api/stories/:id/escalate` (CTO) -> requires an open ask with `ask_responder=cto`; sets
  `ask_responder=user`, re-publishes the ask toward the user. 409 otherwise. The single
  story-level cto->user boundary.
- `POST /api/stories/:id/answer {answer}` (CTO or USER, whichever owns the ask) -> clears
  `pending_ask`/`ask_responder` and notifies the leader (`story.attention { target:story,
  reason:ask-answered, detail:answer }`). Open to both, mirroring task feedback being
  answerable by either responder today.

#### 4c. Story decomposition-plan sign-off (the leaders' own escalation spine)

A leader, before fanning out, raises its decomposition plan / design as a STORY-LEVEL ask
(4b `/ask`) to the CTO. CTO `/answer` = sign-off; CTO `/escalate` bumps it to the user for a
product/scope call. This is exactly the seam THIS story's leader uses for THIS design (during
the build it uses the CURRENT task-escalate path, since 4b is not active yet).

### 5. Channel routing (`channel.ts`)

`AttentionBridge.routeOwns` and `consumeStoryAttention`:
- STORY-leader bridge (`scopeStory` set): owns `storyId === scopeStory && (responder === story
  || status in {failed, aborted})`. (A story member can no longer resolve to cto, so that arm
  of today's logic is simply unreachable and removed.)
- WORKSPACE/CTO bridge: owns a NON-STORY task that is `responder === cto` OR a non-story
  `failed`/`aborted`. It NO LONGER owns any story-member task. A non-story task that is
  `escalated_to_user` (responder user) is DROPPED by the CTO bridge (the webapp/dashboard,
  which shows all attention items, surfaces it to the user).
- STORY-LEVEL attention (`consumeStoryAttention`): `target:story` -> the matching story-leader
  bridge (reasons: completion-review, ask-answered); `target:cto` -> the workspace/CTO bridge
  (reasons: complete, ask). New reasons added to `STORY_ATTENTION`.

### 6. responder_tier disposition (explicit)

`responder_tier` is read/written ONLY by V1 (the story-member chain walk + `escalateTask` bump).
In V2 story members are terminal (no tier) and non-story uses the `escalated_to_user` boolean.
So `responder_tier` becomes dead at activation -> its column is DROPPED by the activation subtask
and all reads/writes removed.

### 7. Surfaces to rewrite

- `cto-agent.ts`: replace the per-step responder self-check doc with: you handle STORY-level
  asks + completion sign-off + NON-STORY tasks; you NEVER handle an individual subtask's
  feedback; you may escalate a story ask or a non-story task to the USER.
- `story-agent.ts` (leader doc): your subtasks' feedback is TERMINAL at you (no task escalate);
  to reach the CTO, raise a STORY-LEVEL ask (`/ask`); completion sign-off is story feedback.
- `channel.ts` `CHANNEL_INSTRUCTIONS`: drop the spec-generation/idle-handling per-step
  responder language; describe the structural model.
- `public/app.js` + `public/style.css`: REMOVE the step-responder config panel + the resolved
  `step_responders` map in the workspace view; `server.ts` PATCH workspace drops the
  `step_responders` branch and `GET /api/workspaces/:id` drops the resolved map.
- Tests: delete `test/step-responders.test.ts`; rewrite `test/responder-chain.test.ts` +
  `test/pending-responder.test.ts`; update `test/channel.test.ts`, `test/idle-handling.test.ts`,
  `test/observability.test.ts`.

### 8. Build sequencing — additive, gated, INERT until the end

A single gate (e.g. `RESPONDER_V2`, default OFF) selects V1 vs V2 resolution in
`pendingResponder` / `routeOwns` / `escalate` / the channel. Every spine subtask builds its
piece behind the gate; V1 stays live for st-def561dd AND the concurrent st-bbca649e throughout.
The FINAL "activation + cleanup" subtask (blocked_by all spine subtasks): flips the gate ON,
deletes V1 dead code, removes the config (step_responders) + the responder_tier column, drops
the columns, rewrites the docs/webapp, and lands the test rewrites. Mirrors how the stories epic
(Phases 1-7) landed.

OVERLAP: st-bbca649e also edits `tasks.ts` + `stories.ts` (merge spine). Expect to rebase onto
its merges; the leader coordinates ordering so neither story clobbers the other.

### 9. Open questions for CTO sign-off

- Q-A cto->user for a non-story task as a boolean `escalated_to_user` + reusing the redefined
  `POST /api/tasks/:id/escalate` (story members -> 409). OK?
- Q-B story-level ask modeled as `stories.pending_ask` + `ask_responder` columns + new
  `/ask` `/answer` `/escalate` story endpoints (vs. modeling the ask as a special task). OK?
- Q-C collapsing `RESPONDER_STEPS`/`feedbackStep`/`pendingResponderStep` into a single
  `isAwaitingFeedback` predicate (dropping the named-step granularity). OK?
- Q-D physically DROP the `step_responders` + `responder_tier` columns (vs. leave dormant).
- Q-E single `RESPONDER_V2` gate + one final activation/cleanup subtask for the flip +
  dead-code/column/doc/webapp removal. OK? Any preference on gate mechanism (env vs constant)?
- Q-F decomposition-plan sign-off (4c) as story feedback — in scope for THIS story, or
  defer? (The mechanism is the 4b ask; 4c is just the leaders USING it.)
