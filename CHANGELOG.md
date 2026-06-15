# Changelog

All notable changes to **butchr** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **How history was reconstructed.** butchr's git log records one opaque
> `butchr: finalize task <id>` commit per merged task and was never version-tagged,
> so the version boundaries below are a *narrative reconstruction*: every entry is
> grounded in code that exists in the tree today (`src/`, `public/`, `bin/`,
> `deploy/`, `scripts/`, `test/`) and in the prose docs, but the grouping of
> features into milestone releases is editorial, not derived from tags. Going
> forward, history is kept honestly per the
> [living-docs convention](./CONTRIBUTING.md#6-living-docs-update-on-every-change):
> every change lands an `[Unreleased]` entry and bumps the version on release.

## [Unreleased]

- **AGENT IDENTITY = NAME ONLY — the ephemeral `herdr_pane_id`/`herdr_tab_id` columns are DROPPED (story st-a77b050f, subtask 3/3: the clean cutover).** With addressing (subtask 1) and liveness (subtask 2) already moved off the stored pane, these per-agent positional handles were dead persistence — and persisting them was an active bug: a pane id SURVIVES a herdr/host restart that killed `claude`, so the boot reconcile could RE-RECORD a pane for an agent that is gone (for the CTO and every story leader too), making the column lie. Pre-1.0, no back-compat: `herdr_pane_id` + `herdr_tab_id` are physically dropped from `tasks`, `cto_agent`, and `story_agent` via PRAGMA-guarded `dropColumnIfExists` (the stable per-workspace `herdr_workspace` grouping handle is a DIFFERENT column and is untouched; the honest `has_agent` liveness marker from subtask 2 is the REPLACEMENT and stays). Removed every WRITE: `markRunning` no longer persists a launch-time pane/tab (`has_agent=1` is the only ownership record); the dead pane-drift machinery `tasks.adoptPane` + `tasks.repairPaneId` + `dispatcher.currentPaneRepairing` (and the now-orphaned `herdr.reconcilePane` resolver) are DELETED along with their call sites — re-resolution BY NAME at action time replaces them; `harness.teardownTask` is simplified to `teardownTask(agentName)` (its tab/pane params were already dead) and every call site updated; the boot-reconcile re-adopt path attaches the watcher to the name-resolved live pane without re-recording anything; and every terminal-state clear across `tasks.ts` (abort, requeue-for-answer, reject/request-changes, merge/revert, needs_info, backToQueued, dispatch-failure, requeue, auto-resume) plus the `cto-agent`/`story-agent` launch/adopt/stop paths drop the two keys (adopt is now a no-op liveness-refresh that records no pane). Types pruned (`TaskRow`, `CtoAgentRow`, `StoryAgentRow`, `CtoStatus`, `StoryAgentStatus` lose the fields) and the cto/story upserts drop the columns. The `POST /api/tasks/:id/terminal` + `POST /api/workspaces/:id/cto/terminal` gates and the webapp (`public/app.js`) now gate the attach on `has_agent` / `running` (the agent is reached BY NAME), not a stored pane. **Boot-reconcile pane-mis-recording bug FIXED:** with no column there is no phantom pane to record for the CTO or any story leader. **Migration safety (load-bearing ORDER):** the `has_agent` backfill from the legacy pane signal was relocated into `ensureForwardColumns` to run immediately BEFORE the pane column is dropped (and, since that step precedes the `running`→`in_progress` status fold, it matches BOTH the pre-fold `running` and an already-folded `in_progress` live shape) — so a genuinely-live agent on an older DB seeds `has_agent=1` and is NOT demoted to `inactive`/orphaned; the redundant backfill line was removed from `migrateReadyRunningSplit`. Tests: deleted `test/pane-renumber.test.ts` (it exercised only the now-removed stored-id self-heal; name-based re-adoption-on-renumber stays covered by `test/auto-resume.test.ts`); `test/db-migrations.test.ts` gained an end-to-end backfill-then-drop safety test (a pre-`has_agent` legacy DB with a live `running`+pane row ends `in_progress`/`has_agent=1`, a ready row ends `inactive`, and both columns are physically gone); `test/ready-running-split.test.ts` re-buckets off `has_agent`; and the ~20 seed/assert test files moved to the `has_agent` marker.

## [0.9.106] - 2026-06-15

- **Liveness is read from an HONEST signal — `herdr_pane_id IS NOT NULL`-as-"agent is live" is replaced by an explicit `has_agent` marker (story st-a77b050f, subtask 2/3: liveness cleanup).** "Has a non-null pane" never truthfully meant "the agent is live": a pane id (like the agent name) SURVIVES a herdr/host restart that killed `claude`, and the boot reconcile could mis-record it — so every gate that read it was lying. Added the smallest honest column, `tasks.has_agent` (`INTEGER NOT NULL DEFAULT 0`, a standalone additive `ensureColumn`): `1` ⇔ butchr LAUNCHED an agent for this `in_progress` task and hasn't torn it down. It is an OWNED-agent record, NOT a liveness claim — true liveness stays the `/proc` process probe (`claudeAlive`/`agentExists`, `src/liveness.ts`), which the recovery paths keep pairing with it. Maintained in three places only: `markRunning` sets it `=1` atomically with status+pane; `setStatus` clears it `=0` centrally on EVERY transition off `in_progress`; `requeueForResume` clears it `=0` explicitly (the one `in_progress`→`in_progress` case — a killed agent awaiting `--resume`). Every liveness READ moved off the doomed pane column to `has_agent`: the `dispatcher.reconcileRunningTasks` + `reaper.reapDeadRunningAgents` boot SELECTs (now a cheap pre-filter ahead of the `claudeAlive` decision), the `spawnWatcher` auto-resume hand-off, `tasks.setIdle` (guard + UPDATE), `tasks.nudgeTask`'s pre-filter (its existing `claudeAlive` probe is unchanged), the `GET /output` + `POST /terminal` gates (`server.ts`), `tasks.attentionList`, and the `stories.storyCounts` / `workspaces.counts` idle COUNTs. The `migrateReadyRunningSplit` boot migration now BACKFILLS `has_agent` from the legacy pane signal and re-buckets off it, so it no longer depends on a column the next subtask deletes (only the one backfill line still reads the pane, flagged for the cutover). The `herdr_pane_id`/`herdr_tab_id` columns + all pane WRITES/handle-uses are intentionally LEFT in place — the column drop is subtask 3/3. Tests extended (`ready-running-split`, `auto-resume`, `state-sync-dry`, plus the live-agent seed helpers across `idle-handling`/`pane-renumber`/`responder-chain`/`observability`/`stories`) to seed + assert `has_agent`: markRunning sets it, every exit + auto-resume clears it, and the reconcile/reaper/idle/nudge/attention/count gates key off it.

## [0.9.105] - 2026-06-15

- **Webapp surface to DISPLAY + ANSWER an open story-level ask (story st-def561dd follow-up — completes the user-as-escalation-target surface).** The story rollup already carries `pending_ask` + `ask_responder` and `POST /api/stories/:id/answer` already clears+answers an open ask; this adds the missing UI. Each story row now renders a `.story-ask-panel` whenever `pending_ask` is non-null: the HTML-escaped question, who currently owns it (`ask_responder` — `cto` reads as a muted "awaiting the CTO" since an agent handles it automatically, `user` as an emphasized "escalated to you" since it needs a human, mirroring the task-level awaiting-who emphasis), and a freeform answer box whose Submit POSTs the answer via the shared `api()`/`action()` helper and re-renders on success (the answered ask clears server-side, so the panel disappears). Renders nothing when `pending_ask` is null (inert). Webapp-only (`public/app.js` + `public/style.css`); no backend/DB/test changes.

## [0.9.104] - 2026-06-15

- **Agent addressing is resolved STRICTLY BY NAME — the stored pane/tab columns stop being the source of truth (story st-a77b050f, subtask 1/3: addressing cleanup).** Every place that re-acquires a live agent's pane/tab now trusts the renumber-stable NAME resolver and no longer falls back to the cached `herdr_pane_id`/`herdr_tab_id` column (the value that goes stale after a herdr/host restart and was the bug). `dispatcher.reconcileRunningTasks` re-adopts a live agent purely at its name-resolved pane (dropping the `?? row.herdr_pane_id ?? row.id` and `?? row.herdr_tab_id` fallbacks); if the name resolves NO live pane the agent is treated as not-attachable and falls through to the existing auto-resume / rescue branch instead of inventing a pane named the task id. `cto-agent.adoptCtoAgent` and `story-agent.adoptStoryAgent` likewise resolve pane/tab by name only (falling to `null`, not the stored column). The columns, their WRITES, and the `herdr_pane_id`-based liveness gates are intentionally LEFT in place — they're removed in later subtasks (liveness, then column drop); this change only stops them being read for ADDRESSING. (`harness.teardownTask` already re-resolved the live tab by name; confirmed.) Tests extended: `test/auto-resume.test.ts` proves re-adoption lands on the current name-resolved pane despite a stale stored column and that an unresolvable name auto-resumes instead of adopting a bogus pane; `test/herdr-dry.test.ts` proves `teardownTask` closes the name-resolved tab and never the stale stored args.

## [0.9.103] - 2026-06-15

- **Responder-redesign ACTIVATION + CLEANUP (story st-def561dd, spine subtask 5 — the atomic V1→V2 cutover; design §2/§3/§4/§6/§7).** Flipped the responder model to the STRUCTURAL design and deleted V1 in one change. Removed the `responderV2Enabled()` gate (`BUTCHR_RESPONDER_V2` env) entirely so V2 is the only path. `tasks.pendingResponder(row)` now resolves purely structurally — not awaiting feedback → `null`, story member (`story_id != null`) → `story` (terminal at the leader), non-story → `cto`, non-story + `escalated_to_user` → `user`; its value type is `story | cto | user | null`. `tasks.escalateTask` is the single cto→user boundary for a NON-story task (409s on a story member / not-awaiting / already-escalated). Deleted the V1 task machinery (`ESCALATION_CHAIN`, `EscalationRung`, `feedbackStep`, `pendingResponderStep`, the `responder_tier` index walk) and the per-step responder config (`workspaces` `RESPONDER_STEPS`/`ResponderStep`/`Responder`/`responderFor`/`resolveStepResponders`/`updateWorkspaceStepResponders`/`isResponderStep`; the `step_responders` branch in `PATCH /api/workspaces/:id` and the resolved map in `GET /api/workspaces/:id`). **DROPPED COLUMNS** (pre-1.0, no back-compat): `tasks.responder_tier` and `workspaces.step_responders`, via a new PRAGMA-guarded `dropColumnIfExists` migration (no-op when absent, so a fresh DB and an existing DB both succeed). `channel.ts` `routeOwns` is now structural-only (a story member always belongs to its leader; the CTO feed owns only non-story tasks awaiting the CTO or failed), and `CHANNEL_INSTRUCTIONS` describes the structural model. Rewrote the agent docs — `cto-agent.ts` (CTO handles story-level asks + completion sign-off + non-story tasks, NEVER an individual subtask, may escalate a story ask or a non-story task to the user), `story-agent.ts` (subtask feedback is TERMINAL at the leader; to reach the CTO raise a story-level ask via `POST /api/stories/:id/ask`) — and `CONTRIBUTING.md` (§7 "Feedback responders (structural)"). Webapp: removed the per-workspace step-responder config panel + the spec-gen config framing (`public/app.js`, `public/style.css`); the awaiting-who chip/banner now renders `pending_responder: 'story'` as "awaiting leader". Tests: deleted `test/step-responders.test.ts`; rewrote `test/responder-chain.test.ts` + `test/pending-responder.test.ts` for the structural model (folding in the former gated `responder-v2-resolution`/`responder-v2-gate` tests, both removed); updated `test/channel.test.ts` + `test/idle-handling.test.ts`.

## [0.9.102] - 2026-06-15

- **3-level branch isolation is now activatable per workspace.** A new
  `branch_isolation` workspace flag (set via `PATCH /api/workspaces/:id
  {"branch_isolation": true}`, mirroring `release_mode`) turns on the story-branch merge
  model: stories opened afterward are isolated — each gets its own branch, its subtasks
  merge into the story branch with both gates (subtask CI + post-merge verify in the story
  worktree), and the completed story is re-gated and merged into the default branch (a RED
  re-gate hard-blocks, leaving the default branch untouched). The flag defaults OFF and is
  not enabled on any live workspace; workspaces without it — and standalone tasks — merge
  straight to the default branch exactly as before. See CONTRIBUTING.md §11.

## [0.9.101] - 2026-06-15

- Branch isolation (stories) phase E-story-merge, behind the `isolated=1` guard (CONTRIBUTING §11.4/§11.5/§11.6/§11.7 — inert until activation, so non-isolated stories + standalone tasks are byte-for-byte unchanged). An isolated story's completion is now a story→main LAND: two butchr-owned transient story states (`merging`, `merge_blocked`) join the `StoryStatus` union, plus story-level `stories.merge_base_sha`/`merged_sha`. A leader's PATCH `done` on an isolated story becomes a **request to land** (`open|merge_blocked → merging`), driven by `stories.landStory` over the new `tasks.mergeStoryBranch` mechanics — the whole sequence inside ONE global-merge-queue slot: re-gate the story-branch tip in the story worktree (**RED ⇒ HARD BLOCK**, no merge, main untouched), rebase the story branch onto main + ff main at the repo root, post-merge verify on main (RED ⇒ reset main), then `removeStoryBranch` + story-level shas. **Only a landed-and-green story reaches `done`** (leader torn down + `complete` reported to the CTO). A RED re-gate/post-verify lands `merge_blocked` + a `gate-red` attention event to the LEADER (it fixes with more subtasks — `createSubtask` now accepts a `merge_blocked` story); a story↔main conflict lands `merge_blocked` + a `merge-conflict` attention event to the **CTO** (the leader has no worktree; the event carries a resolve-in-the-story-worktree runbook). The leader is kept up through `merging`/`merge_blocked` to re-attempt; `merging` is restart-recoverable (boot `recoverMergingStories`, mirroring rollback recovery).

## [0.9.100] - 2026-06-15

- **Responder-redesign V2 channel routing (story st-def561dd, spine subtask 4 — additive + INERT behind the `responderV2Enabled()` gate; design §5).** Gated the WORKSPACE/CTO arm of `channel.ts` `AttentionBridge.routeOwns`: when `BUTCHR_RESPONDER_V2` is ON, the CTO feed owns ONLY NON-STORY tasks — a story member ALWAYS belongs to its leader (the CTO bridge never owns one), and a non-story task is owned when it is awaiting the CTO (`responder==='cto'`) OR has FAILED (failed/aborted — a terminal failure carries no responder, hence the explicit status check); a non-story task escalated to the user (`responder==='user'` from `escalated_to_user`) is DROPPED here (the webapp/dashboard surfaces it). The STORY-leader arm is identical under V1 and V2, so it is unchanged. The gate stays OFF by default, so the live V1 routing (`storyId == null || responder === 'cto'`, which keeps the now-unreachable-under-V2 story-member→'cto' arm) is byte-for-byte intact for this story and the concurrent st-bbca649e — gated, not deleted. Added gate-forced-ON channel tests (story member in_review → leader not CTO; non-story 'cto' → CTO; non-story 'user' → dropped; story-member failure → leader not CTO); existing channel tests stay gate-OFF and green.

## [0.9.99] - 2026-06-15

- **Story-level ASK endpoints + channel reasons (story st-def561dd, spine subtask 3 — additive + INERT).** The leader↔CTO↔user escalation seam (design §4b/§4c), unused until activation. Added three guarded `stories.ts` helpers over the existing `pending_ask`/`ask_responder` columns: `openStoryAsk` (leader→CTO; 400 blank question, 409 non-`open` story or ask-already-open; sets `pending_ask`+`ask_responder='cto'`, publishes `story.attention {target:cto, reason:ask}`), `escalateStoryAsk` (CTO→user single boundary; 409 unless an open CTO-owned ask exists; sets `ask_responder='user'`, re-publishes `story.attention {target:user, reason:ask}`), and `answerStoryAsk` (CTO or user; 400 blank answer, 409 no open ask; clears the pair, publishes `story.attention {target:story, reason:ask-answered}`). Exposed as `POST /api/stories/:id/{ask,escalate,answer}`. Widened `events.ts` `story.attention` to `target: story|cto|user` and `reason: completion-review|complete|ask|ask-answered`. Extended `channel.ts` `STORY_ATTENTION` with `ask` (CTO feed, state `story_ask`) and `ask-answered` (leader feed, state `story_ask_answered`); `consumeStoryAttention` parses the two new reasons but `target` still only resolves to {story, cto}, so a `target:user` escalation is dropped by every channel bridge (the dashboard SSE consumer surfaces it). No gate, no agent-doc wiring — nothing calls these yet; the live V1 responder model is unchanged for this story and the concurrent st-bbca649e.

## [0.9.98] - 2026-06-15

- **Responder-redesign V2 task resolution (story st-def561dd, spine subtask 2 — additive + INERT behind the `responderV2Enabled()` gate; design §3/§4/§4a).** Added the structural feedback predicate `tasks.isAwaitingFeedback(row)` (status in {idea, spec_review, in_review, needs_info} OR in_progress+idle — the idle arm kept identical to V1 `pendingResponderStep`). Gated `tasks.pendingResponder`: when `BUTCHR_RESPONDER_V2` is ON it resolves STRUCTURALLY — not awaiting feedback → null, story member (`story_id != null`) → `story` ALWAYS (no tier), non-story → `cto`, non-story + `escalated_to_user` → `user`. Gated `tasks.escalateTask`: under V2 it is the single cto→user boundary for a NON-story awaiting task (sets `escalated_to_user=1`), with 409s for a story member (terminal at the leader), an already-escalated task, or a task not awaiting feedback. Every fresh-feedback entry that resets `responder_tier` now also clears `escalated_to_user` (no-op under V1). The gate stays OFF by default, so the live V1 model (responder_tier chain + step_responders) is byte-for-byte unchanged; V1's `feedbackStep`/`pendingResponderStep` remain in place until the activation subtask.

## [0.9.97] - 2026-06-15

- **Responder-redesign V2 schema + gate scaffold (story st-def561dd, spine subtask 1 — additive + INERT).** Added the V2 data-model columns (design §2), all unused this phase: `tasks.escalated_to_user` (INTEGER NOT NULL DEFAULT 0 — the single cto→user boundary for a non-story task) and `stories.pending_ask` / `stories.ask_responder` (TEXT, nullable — a story leader's open story-level ask + its owner), surfaced on `TaskRow`/`StoryRow` (and thus `TaskView`/`StoryView` via the existing spreads). Added the SINGLE V2 gate `config.responderV2Enabled()`, reading `BUTCHR_RESPONDER_V2` at call time (default OFF) via the shared `envBool` parsing. Nothing reads the columns or calls the gate yet — the live V1 responder model (responder_tier chain + step_responders) stays in force; later spine subtasks wire the gated V2 paths and the final activation subtask flips the default and removes the gate.

## [0.9.96] - 2026-06-15

- Branch isolation (stories) phase D-subtask-merge, behind the `isolated=1` guard (CONTRIBUTING §11.4/§11.5/§11.6 — inert until activation, so standalone tasks + non-isolated story members are byte-for-byte unchanged): for an ISOLATED story member `tasks.resolveBase` now returns the story branch and `resolveMergeContext` returns `{ storyWt, storyBranch, storyBranch }`. Every subtask-facing git call is threaded through the resolved base — `createWorktree` (branch off the story branch, dispatch + create paths), pre-dispatch `rebaseOntoDefault`/`isBehindDefault`, `diff`, the readiness `commitsBehind`/`diffStat`, `triggerCi`'s changelog + allowlist gate diffStats, and the auto-merge + estimate footprint diffStats — so a member branches off and is measured against the story branch, not main. `finalizeMerge` uses `resolveMergeContext` so an isolated member fast-forwards into the STORY worktree, runs the post-merge verify there, and on RED resets the STORY worktree to the captured story-branch tip (main never touched); its `merge_base_sha`/`merged_sha` are story-branch shas. The story→main path is unchanged (phase E).

## [0.9.95] - 2026-06-15

- docs: add responder-redesign design RFC (story st-def561dd)

## [0.9.94] - 2026-06-15

- Branch isolation (stories) phase C-lifecycle, additive + guarded/unused (CONTRIBUTING §11): `git.ensureStoryBranch` / `removeStoryBranch` lazily create + tear down an isolated story's branch and its story worktree (`<repo>/butchr-story-<id>`) with createWorktree-style validate-or-rebuild idempotency that never discards merged subtask work; `git.merge` gains an optional `sourceWorktree` (defaults to the task worktree → byte-for-byte unchanged) and a thin `mergeStoryToMain` wrapper for the generalized story→main merge; `createStory` captures the per-story `isolated` bit from the workspace `branch_isolation` flag; `resolveBase` gains a guarded (unreachable while the flag is off) `ensureStoryBranch` hook. No behavior change — every story still captures `isolated=0`.

## [0.9.93] - 2026-06-15

### Added
- **Branch-isolation plumbing (inert, phase B-PLUMB).** Threaded an optional `base` merge-target ref through the `git.ts` base-consuming functions (`createWorktree`, `worktreeIsReusable`, `commitsBehind`, `hasChanges`, `diff`, `diffStat`, `isBehindDefault`, `rebaseOntoDefault`) plus an ff-target (`base`/`ffWorktree`/`ffTargetBranch`) on `merge()`, each defaulting to today's single-level values so behavior is byte-for-byte unchanged; added the pure `storyBranchName` helper, the inert `tasks.resolveBase`/`resolveMergeContext` resolvers, and the `workspaces.branch_isolation` + `stories.isolated` columns (default 0). No runtime behavior change — groundwork for the 3-level story branch-isolation merge model (CONTRIBUTING §11).

## [0.9.92] - 2026-06-15

### Changed
- **Story-leader brief documents the course-correction mutation tools.** The generated
  per-story leader brief (`buildStoryLeaderBrief`, `src/story-agent.ts`) gained a
  "Course-correct your subtasks" section so leaders know they can REFINE
  (`PATCH /api/tasks/:id`), REORDER dependencies (`PUT|POST /api/tasks/:id/blocked_by`),
  REPRIORITIZE (`POST /api/tasks/:id/priority`), DROP (`POST /api/tasks/:id/abort`), and
  RESTART (`POST /api/tasks/:id/requeue`) a subtask in place — plus START THE STORY OVER
  (`POST /api/stories/:id/reset`) — instead of only creating subtasks. Each verb is
  documented with its real endpoint shape and error codes. Docs-only change to the brief.

## [0.9.91] - 2026-06-15

### Added
- **3-level branch isolation (stories) — approved DESIGN.** New `CONTRIBUTING.md` §11
  specifies the merge model for the next epic: `main` = trunk, each STORY gets a branch off
  `main`, each SUBTASK merges into its STORY branch, and the completed story is re-gated and
  merged into `main` so `main` only ever sees whole, verified stories. Documents the explicit
  `base?` param threaded into the `git.ts` merge spine (keeping `git.ts` DB-free), the
  story-worktree-mirrors-`dir` model (every merge/verify/reset invariant holds at both levels
  with no special cases), lazy `butchr/story/<id>` branch creation, both-level CI/verify wiring
  with story-level RED as a **hard block** (a red story never reaches `main`), per-level
  rollback/sha semantics, the new `merging`/`merge_blocked` story states so `done` always means
  "landed on `main`", and the per-story `isolated`-bit-captured-at-create guard (default OFF) so
  the build never disturbs in-flight stories or standalone task→`main` merges. Design only — no
  code; the merge-spine subtasks build against it phase by phase, additive and inert.

## [0.9.90] - 2026-06-15

### Added
- **In-place task prompt/context edit.** New `PATCH /api/tasks/:id` (body `{ prompt?, context? }`,
  key-presence based) lets an operator REFINE a paused subtask's prompt and/or context-file list
  instead of abort+recreate (`tasks.editTask`). It is purely additive — no status transition,
  dependency/priority change, or agent teardown — and rewrites task.md in place (preserving the
  Review Notes/Clarifications sections via the new `taskmd.updateTaskMdContext`, alongside the
  existing `updateTaskMdPrompt`). `grounding_fp` is left untouched, so the edit is picked up on the
  agent's next `--resume` through the existing grounding-fingerprint reground (a paused
  needs_info/in_review task) or the fresh task.md render (a ready `inactive` task). Editing a live
  `in_progress` task is allowed (takes effect on its next resume); a terminal or `rolling_back`
  task is rejected (409).

## [0.9.89] - 2026-06-15

### Added
- **Reset a story.** New `POST /api/stories/:id/reset` convenience endpoint aborts ALL of a
  story's IN-FLIGHT subtasks in one call, so a story leader can "throw it all away and start
  over" and then re-decompose. Additive: it reuses `tasks.abortTask` per member and leaves the
  story `open`. Members that are already terminal (merged/aborted/failed/rolled_back) OR mid-
  rollback (`rolling_back`) are left untouched and reported under `skipped`; aborting is
  best-effort per member (`{ok, story, aborted, failed, skipped}`). See `stories.resetStory`.

## [0.9.88] - 2026-06-15

### Changed
- **Stories epic, Phase 7 — AUTHORITY FLIP.** The operator/CTO now creates only STORIES;
  work TASKS are created exclusively by story leaders. `POST /api/workspaces/:id/tasks`
  rejects ordinary/idea standalone creation (409, pointing at `POST /api/workspaces/:id/stories`)
  and admits only the `rollback` flow — the gate lives at the HTTP entry point
  (`tasks.assertWorkspaceTaskCreationAllowed`), so leader decomposition (`POST /api/stories/:id/tasks`),
  the 'Roll back' flow, and all in-process/internal task creation are unaffected. The CLI gains
  `butchr story <ws> -m <brief>` and `new` now errors for non-rollback creation; the webapp
  replaces its New-task/Add-idea launchers with a "New story" modal plus a stories progress
  panel; the CTO brief flips to creating stories + handling escalations and story sign-off
  (keeping responder handling for the non-story tasks that still exist); and `butchr selftest`
  drives its probe through the real operator→story→subtask path.

## [0.9.87] - 2026-06-15

### Added
- **Stories epic, Phase 6 — completion detection + surfacing.** When the last subtask of a
  story lands (every member `merged`/`rolled_back`, ≥1 subtask), `finalizeMerge` now fires a
  story-level attention event to the LEADER's channel (`story <id> ready for completion
  review`) so the leader verifies the goal — then PATCHes the story `done` (which tears the
  leader down AND reports `story <id> complete` UP to the CTO channel) or creates more
  subtasks. A new `story.attention` event (`target: story|cto`) is routed by the channel
  bridge to the matching feed. Story views are enriched: `GET /api/stories/:id` and `GET
  /api/workspaces/:id/stories` now return a member-task `counts` rollup plus the leader-agent
  status, a new `GET /api/stories` lists every workspace's stories, and the dashboard reports
  per-workspace open-story counts. Completion fires only for stories with ≥1 subtask;
  standalone (story-less) task merges are unaffected.

## [0.9.86] - 2026-06-15

### Added
- **Stories epic, Phase 5 — leader decomposition (subtask creation).** A story leader can
  now break its story into subtasks: a new `POST /api/stories/:id/tasks` endpoint creates a
  task pinned to the story (`story_id` + the story's workspace) and dispatches it like any
  task — its body mirrors workspace task creation. `createTask` gained an optional `story_id`
  param, validated (404 if gone, 400 cross-workspace) before the worktree is created. The
  story-leader brief now instructs decomposition (create each subtask via the endpoint, set
  `blocked_by` for ordering deps, expect each subtask's feedback to route back to the leader).

## [0.9.85] - 2026-06-15

### Added
- **Stories epic, Phase 4 — story-scoped attention channel + bubble-up routing.** Each
  story-leader agent now gets its own one-way attention feed, scoped to ITS story's subtasks
  via a new `BUTCHR_CHANNEL_STORY` env on the `butchr-cto-channel` bridge (`storyAgentCmd`
  re-enables the `--mcp-config` + dev-channels wiring it omitted in Phase 3, and
  `src/story-agent.ts` writes a per-story channel MCP config). The bridge reads
  `pending_responder`/`story_id` straight off the serialized TaskView SSE event (staying
  DB-free) and routes the escalation chain: a story member's tier-0 feedback + failures go to
  its LEADER, while only items ESCALATED up (`pending_responder` `cto`) reach the CTO; a
  STANDALONE task's CTO feed is unchanged. The bridge also emits on a responder TRANSITION
  while already in a feedback state (an escalation `story`→`cto`, or a reset back to `story`),
  not just on a status change.

## [0.9.84] - 2026-06-15

### Added
- **Stories epic, Phase 3 — story-leader agent lifecycle.** Each `open` story now gets a
  managed, supervised, `--resume`'d story-leader agent (a "mini-CTO" scoped to one story),
  mirroring the per-workspace CTO-agent subsystem. New `story_agent` table (keyed by
  `story_id`, FK-cascading with the story/workspace) + a `src/story-agent.ts` module that
  launches/stops/restarts, boot-reconciles (adopt-live / auto-resume-after-reboot /
  relaunch-dead), and supervises leaders with bounded backoff — running in the story's
  workspace repo root off a generated per-story brief, via a new `BUTCHR_STORY_AGENT_CMD`
  template. Lifecycle is wired into the story CRUD: creating/reopening a story launches its
  leader, while marking it `done`/`aborted`, deleting it, or unregistering its workspace
  tears the leader down. The leader's subtask attention feed (Phase 4) and decompose/
  feedback actions (Phases 5/6) are deliberately NOT wired yet — this phase brings the
  leader up and supervises it but it receives no work feed.

## [0.9.83] - 2026-06-15

### Added
- **Stories epic, Phase 2 — responder escalation chain.** A story-member task's feedback
  now resolves up a fixed chain `story → cto → user`: a new `tasks.responder_tier` column
  tracks the current rung, `pending_responder` walks `['story','cto','user']` for story
  members (independent of the workspace step-responder config) while non-story tasks are
  unchanged, and a new `POST /api/tasks/:id/escalate` bumps a task up one rung. The tier
  resets to 0 whenever a task enters a new feedback state (spec/review/question/idle), so
  each fresh item starts back at the story leader. Inert until the story-leader agent
  (Phase 3) and story channel (Phase 4) land — the CTO agent already defers on the `story`
  rung.

## [0.9.82] - 2026-06-15

### Added
- **Stories data model + CRUD foundation (Phase 1 — inert).** Added a `stories` table (a
  container that groups subtasks) with `createStory` / `getStory` / `listStories` /
  `updateStory` / `deleteStory` / `assignTaskToStory` in the new `src/stories.ts`, plus a
  nullable `tasks.story_id` FK and matching REST routes (`POST`/`GET
  /api/workspaces/:id/stories`, `GET`/`PATCH`/`DELETE /api/stories/:id`, `POST
  /api/tasks/:id/story`). A story belongs to one workspace and cascade-deletes with it;
  deleting a story keeps its member tasks (only their `story_id` is cleared); a task may
  only join a story in its own workspace. Purely persistence this phase — nothing in the
  dispatch/review/lifecycle machinery reads it yet (a later phase adds the story-leader
  agent + escalation chain).

## [0.9.81] - 2026-06-15

### Added
- **Stale temp-dir workspace registrations are pruned automatically at startup.** Every
  selftest / integration run registers a throwaway repo under the OS temp dir, and those
  rows used to linger in the config DB long after the tmp dir was gone — cluttering the
  dashboard and CTO channel with dead `test` workspaces and orphaned tasks. On boot,
  butchr now unregisters any workspace whose path resolves under the OS temp dir
  (`os.tmpdir()`, plus a literal `/tmp` prefix for Linux CI), reusing the existing
  `unregisterWorkspace` so the removal cascades to the workspace's tasks and tears down
  its panes/worktrees/CTO agent. The prune runs EARLY — before the running-task and
  CTO-agent reconcile steps — so butchr doesn't waste work re-adopting agents it is about
  to delete, and it is best-effort per workspace (one failure never aborts boot). Only
  temp-dir paths are touched: real (`/home/...`) workspaces are never pruned and survive a
  restart untouched.

## [0.9.80] - 2026-06-13

### Fixed
- **An EMPTY review submission is now bounced back instead of entering review on a
  falsely-green CI.** When a build agent called `request_review` but its branch carried
  no work — zero commits ahead of the default branch AND a clean worktree (e.g. a
  `git reset` wiped its uncommitted changes) — butchr routed it into `in_review`, where
  the CI gate built the empty tree green and presented a clean, reviewable diff that was
  actually nothing (an incident that only manual git/reflog forensics caught).
  `markReviewFromAgent` (the `request_review` path) now checks FIRST, on the genuine
  `in_progress` submission, whether the branch actually has changes — reusing the
  existing `git.hasChanges` probe (commits-ahead OR a dirty worktree via
  `git status --porcelain`, so brand-new UNTRACKED files still count as real work). An
  empty submission is bounced like a changes-request (→ `inactive` with an actionable
  `review_note`, re-launched in the same session) and the `request_review` tool reports
  `empty` so the agent knows it submitted nothing; a non-empty submission (committed or
  merely uncommitted — including docs/changelog-only changes) is unaffected and enters
  review as before. The guard runs only on the live agent-submission path and FAILS OPEN
  when there is no task branch to measure against, so a real submission is never
  false-bounced; the dead-agent rescue paths (which deliberately hand a stuck agent to a
  human) are untouched.

## [0.9.79] - 2026-06-13

### Fixed
- **Worker dispatch no longer hangs on the dev-channels consent prompt.** Since the
  connectivity-restored feature attaches `--dangerously-load-development-channels` to
  WORKER (build-agent) launches, every freshly dispatched worker stopped at Claude
  Code's blocking interactive dev-channels consent prompt ("1. I am using this for
  local development") and never reached its task — butchr's launch auto-confirm
  (`autoConfirmStartupPrompts`, src/startup-confirm.ts) was only wired into the CTO
  launch, not the worker dispatch path. The dispatcher now runs the same best-effort,
  bounded, idempotent auto-confirm (new `autoConfirmTaskStartup`) on a freshly launched
  worker — gated on `connectivityEnabled` (only then does the worker carry the flag) —
  so it clears the consent (plus the folder-trust / generic prompts the rule table
  covers) and proceeds unattended. The confirm is prompt-gated, so once past startup no
  stray keystroke leaks into the worker's real session.

## [0.9.78] - 2026-06-13

### Fixed
- **CTO agent now AUTO-RECOVERS after a host reboot (no manual "restart" needed).** The
  managed CTO adopt path (`adoptOrLaunch` in `src/cto-agent.ts`) decided adopt-vs-launch
  using ONLY `harness.agentExists(name)`, which stays TRUE after a reboot — herdr restores
  the pane as a bare login shell while the `claude` process is dead — so butchr ADOPTED the
  dead husk pane and the operator saw a BLANK shell where the CTO should be, fixable only by
  hitting "restart" by hand. The adopt path now also requires the OS PROCESS to be alive,
  mirroring the build-agent paths (`reaper`/`dispatcher` already probe `claudeAlive`). A new
  tri-state probe `claudeLiveness(sessionId)` in `src/liveness.ts` (reusing the same
  injectable `/proc` lister) returns `alive` / `dead` / `unknown`, where `dead` is the
  unambiguous reboot signal (the lister RAN — processes present — but none carry the session
  token) and `unknown` covers "can't probe" (no `/proc` / no recorded session id). adopt
  behavior: `alive` → ADOPT (a healthy CTO is never relaunched — double-launching a live
  session would be worse than the bug); `unknown` → ADOPT (indeterminate, never risk a
  double-launch); `dead` → tear down the stale pane/tab + free the name FIRST, then relaunch
  with `--resume <persisted session_id>` so the CTO keeps full context. This runs inside the
  existing boot `reconcileCtoAgent` and the periodic supervisor, so a butchr restart after a
  host reboot relaunches the CTO automatically with no operator action. Build agents already
  auto-recover on reboot via the reaper's `claudeAlive` requeue — confirmed, no gap there.

## [0.9.77] - 2026-06-13

### Added
- **Connectivity-restored event (event-only).** butchr now runs a network
  connectivity monitor (`src/connectivity.ts`) that periodically probes the model API
  endpoint, tracks a debounced up/down state machine (declares DOWN only after N
  consecutive failed probes, so one transient probe can't false-trigger), and fires
  EXACTLY ONCE on a DOWN→UP transition — capturing how long the network was down. On
  recovery it BROADCASTS a single `connectivity.restored` event to BOTH the long-lived
  CTO sessions (the existing one-way CTO channel) AND every live worker build agent
  (the same channel attached to the worker launch in a new CONNECTIVITY-ONLY mode, so a
  worker hears "network restored" mid-session but never sees another task's
  review/idle/attention events). This surfaces the recurring failure mode where a host
  network blip kills agents' model calls mid-work. It is strictly EVENT-ONLY: butchr
  takes NO recovery action on regain (no auto-requeue/resume/abort — the existing
  liveness/auto-resume/gate-recovery layers are untouched); each recipient decides what
  to do. Configurable via `BUTCHR_CONNECTIVITY` (master switch, default on),
  `BUTCHR_CONNECTIVITY_URL`, `BUTCHR_CONNECTIVITY_INTERVAL_MS`,
  `BUTCHR_CONNECTIVITY_TIMEOUT_MS`, and `BUTCHR_CONNECTIVITY_FAILURES`. The worker-side
  channel is gated on the master switch and is non-fatal — if it fails to attach, the
  worker still launches and works normally.

## [0.9.76] - 2026-06-12

### Added
- **CTO ergonomics: allowlist gate, structured plan approve/reject, agent-liveness verdict, and blocking CLI helpers.** Four refinements that close gaps where the CTO reached around butchr into raw git/shell/curl. **(1) Per-task file ALLOWLIST gate.** A task can declare an `allowlist` (glob/path entries — the same membership rule `fileAllowed` applies for auto-merge: a `dir/` prefix, a top-level `*.ext` glob, or an exact path); when non-empty, the CI gate (`tasks.triggerCi`) FAILS the task if its diff touches any file outside the set, catching scope creep mechanically instead of by hand-diffing. Stored in a new JSON `tasks.allowlist` column (NULL/`[]` = inert, so existing rows and non-allowlist tasks are unchanged), validated/normalized in `createTask` (`validateAllowlist`), surfaced as a real `string[]` on the task view, round-tripped in task.md front matter, and settable via `POST /api/workspaces/:id/tasks { allowlist }` and `butchr new --allowlist a,b`. **(2) Structured plan approve/reject.** New `POST /api/tasks/:id/plan/approve` (optional steering `note`) and `POST /api/tasks/:id/plan/reject { note }` (`tasks.approvePlan` / `tasks.rejectPlan`) give the plan-approval responder step its own surface — distinct from the freeform `/answer` used for in-implementation questions — each 409ing unless the task is actually at the plan-approval step (`needs_info` + `plan_preview`). Approve resumes the same agent session to IMPLEMENT; reject sends the plan back for revision (the agent re-proposes via `propose_plan`). Exposed as `butchr plan-approve` / `butchr plan-reject` and a structured "Review plan" panel (Approve / Request changes) on the webapp plan-preview task. **(3) Agent-liveness verdict on the task view.** The task view gains a `liveness: { state: 'working' | 'stalled' | 'dead', evidence }` block (`tasks.livenessView`) folding the idle/stall dispatcher signals into one judgement, so the operator reads it off the view instead of probing herdr panes / `/proc` / the spinner / file-count by hand. Cheap on the hot SSE path: a non-idle agent is `working` WITHOUT a `/proc` scan (recent output proves it alive); the `/proc` liveness probe (`claudeAlive`) runs only for an already-quiet (`idle`) agent — `stalled` if its process is live, `dead` if gone — exactly the bounded "agent has gone quiet" case liveness probing is sanctioned for. Surfaced as a colored chip in the webapp meta grid and a `liveness:` line in `butchr show`. **(4) Blocking CLI ergonomics.** `butchr wait <id> --until <state>` blocks until a task reaches a state (status, or the synthetic `idle`), exiting non-zero on a timeout or if the task lands in a DIFFERENT terminal state first — replacing hand-rolled curl+sleep poll loops. `butchr restart [--verify]` hits the new `POST /api/restart` (the server SIGTERMs itself; its supervisor relaunches via the deployed systemd `Restart=always`); `--verify` blocks until `/health` answers healthy from a FRESH process (a different `pid`, now included in the health body) and reports the db/tick/herdr self-check, failing honestly if it doesn't come back. Non-`release_mode` and all existing flows are unchanged; covered in `test/cto-ergonomics.test.ts` (+ CLI plumbing in `test/cli-helpers.test.ts`).

## [0.9.75] - 2026-06-12

### Added
- **Read-only CTO observability endpoints (pull view of pipeline state).** New read-only HTTP surfaces let the operator/CTO pull pipeline state in one reliable call instead of reconstructing it from logs, the sqlite file, or raw git. **`GET /api/tasks`** lists every task across ALL workspaces in the light task-list shape (newest-first), with optional `?workspace=`, `?status=`, and `?q=` full-text filters (`tasks.allTasksView`) — replacing per-workspace walks and `bun -e` DB counts. **`GET /api/stats`** is a global rollup of status counts across workspaces (+ the `idle` pseudo-bucket peeled out of `in_progress`), a total task count, and a per-workspace breakdown (`tasks.statsRollup`). **`GET /api/attention`** is the pull side of the push-only CTO channel: a structured, categorized list of every task awaiting the operator right now — `spec-approval` / `plan-approval` / `answer-question` / `diff-review` / `major-confirm` / `idle-handling` / `failed` — each with its resolved responder, a short hook, and a "waiting since" timestamp (`tasks.attentionList` + the pure `attentionReason` categorizer, reusing the feedback-step model + the major-confirm gate so it can't drift). **`GET /api/tasks/:id/readiness`** returns a merge-readiness snapshot `{ onTip, behindBy, changedFiles, gatesGreen, outsideAutoMergeAllowlist }` (`tasks.taskReadiness` + new `git.commitsBehind`), replacing manual merge-base / rev-list / diff. The task view gains a structured **`gates: { ci, conformance, changelog: { status, detail } }`** block (`tasks.gatesView`) grouping the loose gate columns (changelog is config-derived — off/on/strict — to keep the view synchronous on the SSE path). **`GET /api/health`** now surfaces the **last-boot migration outcome** (`db.getLastMigrationOutcome` — when the pass ran, how many steps, clean vs. the failing step) so a clean boot migration is one pull instead of a `journalctl | grep`. All additions are read-only with no behavior change to existing flows; pure helpers (`gatesGreen`, `attentionReason`, `fileAllowed`) plus the rollups and a git-backed readiness path are covered in `test/observability.test.ts`.

## [0.9.74] - 2026-06-12

### Added
- **Operator surfaces for versioned-releases mode (`release_mode`).** The dashboard, CLI, and docs surfaces for the per-workspace release mode whose backend shipped above — all driven off the data the backend exposes (the workspace view's `release_mode` and the task view's `version_bump` / `major_confirm_count` / `released_version`), so they appear for ANY `release_mode` workspace and stay invisible/no-op when it's off. **Webapp (`public/app.js`):** the New-task modal grows a **version-bump selector** (patch default / minor / major), revealed only when the target workspace is in `release_mode` and sent as `version_bump` only then (a non-release_mode create is byte-identical to before); the in-review task detail shows a prominent **"Awaiting major-version confirmation (n/2)"** banner with a **Confirm major version** button on a `release_mode` major task — making clear it's the human's deliberate double-confirm (two consecutive confirms land it; any other action resets) and re-rendering in place so the streak is visible across the two clicks, while the existing Approve handler now surfaces the **parked/awaiting** state instead of a false "merged" toast; and the stamped **`released_version`** renders as a small `vX.Y.Z` chip via the shared `taskChips()` (so it shows wherever merged state renders — detail, table, board, history). **CLI (`bin/butchr`):** `new --bump patch|minor|major` (validated, omitted unless given) and a `confirm-major <id>` subcommand surfacing the resulting streak / awaiting state / merged version. **Docs (`CONTRIBUTING.md`):** a "Versioned releases (per-workspace)" write-up + a `release_mode` row in the per-workspace settings table. Non-release_mode workspaces are unaffected. Focused CLI plumbing covered in `test/cli-helpers.test.ts`.
- **Merge step is robust to additive changelog conflicts (the CTO no longer hand-resolves them).** The merge-lock rebase (`git.merge` and the pre-dispatch `git.rebaseOntoDefault`) now mechanically AUTO-UNIONs a purely-additive changelog conflict in place — the common case where two tasks each ADDED a bullet under `## [Unreleased]` — instead of bouncing it to an agent that garbles it. A new pure, heavily-tested resolver `changelog.unionAdditiveChangelogConflict(diff3Text)` unions a hunk IFF, relative to the common ancestor, BOTH sides only added bullet (or blank) lines and neither edited or removed an ancestor line; it returns `null` (→ bounce) for ANYTHING else. The git wiring (`git.tryUnionChangelogConflict`) is gated by HARD guard-rails so the safety case is narrow: it fires ONLY when the unmerged set is EXACTLY the workspace's configured changelog file (any other conflicted file → the WHOLE rebase bounces untouched, never a partial resolve), NEVER unions across a `## ` heading boundary, treats any malformed/2-way (non-diff3) markers or a failed `rebase --continue` as a bounce, and emits a `[butchr]` log line on every auto-resolve (never a silent rewrite). It re-materializes diff3 markers via `git checkout --conflict=diff3` to see the ancestor, and `finalizeMerge` now passes the changelog path into `git.merge` unconditionally (not just in `release_mode`), so this is the general additive-list safety net for any workspace.
- **Gate results are bound to the branch tip they ran against (no stale-green merges).** The CI and conformance gates now stamp the task-branch HEAD they gated into new `tasks.ci_tip` / `tasks.conformance_tip` columns on settle, so a stored `pass` can never be trusted for a DIFFERENT tip. `maybeAutoMerge` refuses to auto-merge a green whose `ci_tip` ≠ the live worktree HEAD (it re-runs CI instead), and `tasks.invalidateStaleGates(id)` clears any settled gate whose stored tip no longer matches — called after a pre-dispatch rebase moves the tip — so a tip change always invalidates a stale-green result.
- **`worktree_path` is always present on the task view.** `TaskView` / `TaskListView` now expose a deterministic `worktree_path` (`<workspace>/<taskId>`, from `git.worktreePath`) whenever the workspace resolves — independent of whether the worktree currently exists on disk — so consumers (notably the CTO agent) never have to guess or reconstruct the path. `null` only when the workspace row is gone.
- **Per-workspace VERSIONED-RELEASES mode (`release_mode`).** A workspace can opt into a mode where EVERY merged change bumps the version file by the task's declared level AND stamps that task's changelog entry with the assigned version + date — driven entirely off the new `workspaces.release_mode` column (no workspace id is hardcoded). Every other workspace keeps today's opt-in patch-bump behavior unchanged. **Version assignment is butchr's, at merge:** inside the serialized merge lock (`git.merge` → `git.bumpVersionFile`), after the rebase, butchr bumps the version file by `tasks.version_bump` ('patch' default | 'minor' | 'major') and, in the SAME commit, relocates the changelog's `## [Unreleased]` body into a fresh `## [X.Y.Z] - DATE` section via the new pure `changelog.promoteUnreleased`, leaving a clean empty `[Unreleased]` above — so each merge OWNS its own heading and the `[Unreleased]` cascade conflicts end. The assigned version is recorded on `tasks.released_version`. **Bump size is task-declared** (`version_bump`, default `patch`, settable at creation via `POST /api/workspaces/:id/tasks` and any time via `POST /api/tasks/:id/version_bump`); **a `major` bump is gated behind a HUMAN double-confirm ritual** — Approve PARKS a major task (it does NOT merge or increment; returns `awaitingMajorConfirm`), and only two CONSECUTIVE `POST /api/tasks/:id/confirm-major` calls (`tasks.confirmMajor`, streak in `tasks.major_confirm_count` 0→1→2) land it; ANY other action (reject, conflict kick-back, re-review, `setBlockedBy`, requeue, re-declaring the bump) resets the streak to 0. The major gate is always the human: `maybeAutoMerge` bails on a release_mode major task, so an auto-merge never auto-confirms. In `release_mode` the changelog gate is STRICT (`checkChangelogUpdated(..., { strict })`): every non-empty diff — including docs-only — must carry an entry, and the docs-only bump-skip is dropped (every change bumps). `changelog.bumpPatchVersion` is generalized to `bumpVersion(text, level)` (minor zeroes patch; major zeroes minor+patch). `PATCH /api/workspaces/:id` accepts `release_mode`. Pure helpers unit-tested in `test/changelog.test.ts` (incl. two sequential stamps proving the cascade ends); the merge bump+stamp, the major interlock + reset, and the rollback-still-bumps path covered in `test/release-mode.test.ts`. Operator surfaces (the new-task bump selector, the major-confirm banner/button, the released-version display, the CLI flags, and the CONTRIBUTING write-up) land in a dependent follow-up.
- **Spec generation routes through the `spec-generation` responder (no more CTO-fork).** An `idea` task no longer auto-dispatches a headless throwaway spec generator. It is now a feedback/waiting state: butchr runs no agent for it, pushes a `spec requested` event on the one-way CTO notification channel (carrying the brief + task id), and WAITS for the workspace's `spec-generation` responder to submit the spec. New endpoint **`POST /api/tasks/:id/spec { spec }`** (`tasks.submitSpec`, routed through the unified feedback mechanism) rewrites the task's prompt brief → spec and advances `idea` → `spec_review`. Both responders use the same endpoint and differ only in surface: `cto` → the persistent CTO agent reacts to the channel push (its brief now instructs it to check `responderFor(workspace, 'spec-generation')` and write+submit the spec only when it is `cto`); `user` → the webapp renders a "write the spec" form on the idea task. The endpoint stays open to both, so a human can always submit even on a `cto` workspace. `idea` reclassified in `STATE_META` from `agent (ceo-agent)` to `feedback (brief)`, and added to the unified feedback table (`feedbackInfo` artifact `brief`, response `submit_spec`) and to the channel's attention states.
- **Per-workspace "step responders" config (feedback-workflow foundation).** Every pipeline step that needs a response now has a configurable responder — `cto` (the persistent CTO agent handles it automatically) or `user` (butchr waits for a human in the webapp) — across six steps: `spec-generation`, `spec-approval`, `plan-approval`, `diff-review`, `answer-question`, and `idle-handling`. The config is per-workspace and defaults every step to `cto` (today's full-auto behavior). Stored as a single JSON column (`workspaces.step_responders`, NULL = all `cto`, added in-place so live rows are preserved), read through `responderFor` / `resolveStepResponders`, exposed via `GET /api/workspaces/:id` (returns the fully-resolved map) and `PATCH /api/workspaces/:id` (validated partial update), and set from a new **Step responders** panel on the workspace page. This is configuration plumbing only — nothing routes off it yet; the routing that consumes it lands in follow-up work.
- **The remaining feedback steps route through the step-responder config (responder-agnostic).** Following the same pattern as `spec-generation`, the four remaining steps — `spec-approval` (`spec_review`), `plan-approval` (a plan-preview task's proposed plan in `needs_info`), `diff-review` (`in_review`), and `answer-question` (a raised question in `needs_info`) — now drive the CTO agent's self-check and the webapp's emphasis. The backend stays **responder-agnostic**: every step is still surfaced on the CTO channel AND actionable by a human in the webapp (the `/spec`, `/approve`, `/reject`, `/answer` endpoints are never gated by responder), so a human can always act. New pure helpers `tasks.feedbackStep(status, planPreview)` (the state→step map) and `tasks.pendingResponder(row)` (composes it with `responderFor`), surfaced as a computed **`pending_responder`** field (`cto` | `user` | `null`) on the task view and list view. The CTO agent's brief now carries an explicit responder self-check (state→step map + which API each `cto` action calls; auto-act only when the step is `cto`, observe when `user`). The webapp shows an "awaiting you" (user) vs "awaiting CTO — you can also act" (cto) badge on the board + task list and a prominent banner on the task detail, with the action controls always available. Known simplification: a `needs_info` task's plan-vs-question split keys off `plan_preview` (no separate marker exists), so a plan-preview task that raises a question during implementation maps to `plan-approval` — documented in CONTRIBUTING §7 for a future precise marker.
- **Agent IDLE is a graceful, responder-routed feedback step (no more blind "continue" poke).** When butchr detects a live build agent has gone idle (the `idle` flag on an `in_progress` task) it no longer auto-types `continue` into the pane — which, during the recent power-loss incident, typed `continuecontinuecontinue` into dead login shells. Idle is now a feedback SURFACE: (1) the dispatcher captures the ANSI-stripped run-log tail into a new **`idle_context`** column (`config.idleContextLines`, default 40) at the instant idle flips on, so the responder can see WHAT the agent was doing and WHERE it stopped; (2) the one-way CTO channel pushes an **`agent idle`** event (`meta.state="idle"`) carrying that context (`AttentionBridge` tracks the idle flag separately from status and emits only on the 0→1 flip, respecting per-workspace scope); (3) the webapp shows an **Idle agent** panel with the context + action buttons (nudge-with-guidance, re-queue; abort is in the header). Idle stays a FLAG, not a 13th state — `tasks.pendingResponderStep` resolves an `in_progress`+idle task to the **`idle-handling`** responder step, so it gets a real `pending_responder` (cto|user) like the other feedback states. New **`POST /api/tasks/:id/nudge { text? }`** (`tasks.nudgeTask`): a bare nudge sends `continue`, `text` sends operator/CTO guidance — the "continue" nudge is now just ONE deliberate responder choice. The CTO agent's brief gains an idle-handling self-check (read `idle_context`, then nudge / requeue / abort per `responderFor(workspace, 'idle-handling')`). **Liveness guard (the incident fix):** a dead-shell pane is NEVER poked — both the dispatcher's `handleIdleAgent` and `nudgeTask` re-check `claudeAlive` and route a dead pane to `requeueForResume` (auto-resume) instead. `idle_context` is cleared in lockstep with the `idle` flag wherever it clears (centralized in `setStatus`), so a stale snapshot never lingers.

### Fixed
- **A `failed` task now fires a CTO channel notification.** The one-way CTO notification channel's attention set listed `aborted` but NOT `failed`, so a task ENTERING the (live, distinct) terminal `failed` state never pushed a notification — even though the channel's own instructions advertise "a failed task". The stale code comment wrongly claimed `failed` had been folded into `aborted`; both are real, distinct terminal states. `failed` is now an attention state with its own `STATE_PHRASE` (`"task failed"`) and `attentionText` case (surfacing the execution/dispatch error, mirroring `aborted`). `aborted`'s phrasing/text is unchanged — the only behavior change is that entering `failed` now notifies.
- **Consolidated task-status membership into single sources.** The "needs attention" status sets were open-coded inconsistently across modules (the server's operator pull-signal summed `+failed`; the CTO channel listed `aborted`; the reaper re-derived the terminal-state list twice). They now live ONCE in `src/db.ts`, next to `TaskStatus`: `REVIEW_STATES` (the operator pull-signal) and `ATTENTION_STATES` (the CTO channel push-feed), each `as const satisfies readonly TaskStatus[]` so every member is compile-checked against the 12-state machine, plus a `sumStatuses(counts, states)` helper. `server.ts` sums its needs-attention total over `REVIEW_STATES`; `channel.ts` re-exports `ATTENTION_STATES` from db; and `reaper.ts` derives both its terminal Set (now `isTerminal`) and its terminal SQL `IN (...)` list from `ALL_STATUSES.filter(isTerminal)` — giving `ALL_STATUSES` its first production consumer. Numerically identical to the sums/sets they replace.

### Removed
- **The blind stalled-agent auto-nudge.** Deleted `dispatcher.shouldNudgeStall` / `maybeNudgeStalledAgent` / `NudgeState` and the `BUTCHR_IDLE_NUDGE_MS` (`config.idleNudgeMs`) / `BUTCHR_IDLE_NUDGE_MAX` (`config.idleNudgeMaxNudges`) knobs. butchr no longer auto-types `continue` at a quiet agent; idle is surfaced to the `idle-handling` responder instead (see Added). The dispatcher's per-poll idle step is now `handleIdleAgent` (liveness guard + pane self-heal only).
- **The CTO-fork headless spec generator.** Deleted `src/cto.ts` (`generateSpec` / `setSpecWriter` / the spec-writer seam) and its config: `BUTCHR_SPEC_GEN_CMD` (`config.specGenCmd` / `specGenTimeoutMs`) and `BUTCHR_CTO_SESSION_ID` (`config.ctoSessionId`). Spec generation is now responder-driven (see Added). Pre-1.0, no shim — the `idea` concept and state are kept; the task just WAITS for a submitted spec instead of forking a context-less throwaway process. (The persistent CTO agent's own session management — `BUTCHR_CTO_AGENT_SESSION_IDS` — is unaffected.) Removed the dispatcher's idea pass (`selectIdeaForDispatch` / `generateSpecForIdea`) and `tasks.markSpecGenFailure`; the dispatcher never dispatches an `idea` task.

### Changed
- **DRY cleanup in `src/workspaces.ts` (pure refactor, behavior identical).** Extracted `updateWorkspaceColumn` (the shared 404→UPDATE→view→`workspace.updated` persist tail behind the five per-field updaters) and `effectiveOverride` (the gate_cmd/version_file/changelog_path resolution behind the three `workspace*` getters, now also called by `dashboard`'s `effective_gate_cmd` so it can't diverge); widened `responderFor`'s `step` param to `string` (the `isResponderStep` guard is the real check); and derived `counts`' zero-bucket map from `ALL_STATUSES` and the dashboard's `needsAttention` sum from `REVIEW_STATES`/`sumStatuses` instead of open-coding them.
- **DRY: pure duration helpers + one ordered DB migration runner.** Extracted `spanMs` / `percentile` / `median` into a new pure `src/duration.ts` (shared by `db.ts` metrics + `estimate.ts`, deleting the duplicated `spanMs` and quantile math; metrics' averaging-median behavior preserved), collapsed `EstimateRowRaw` into `Omit<EstimateRow,'blocked_by'> & …`, and folded the five boot migrations into one ordered `MIGRATIONS` array run by a single loop (the column-existence checks now reuse `columnExists`) so the load-bearing order is executable, not just commented — order + idempotency identical (covered by `test/db-migrations.test.ts`).
- **DRY: `JsonRpcMessage` now lives once in `src/jsonrpc.ts`** — `channel.ts` and `mcp.ts` import the shared type instead of each keeping a byte-identical local copy.
- **The webapp no longer hand-mirrors the server's state metadata.** New read-only **`GET /api/state-meta`** serves `STATE_META` + `ALL_STATUSES` (+ the `isTerminal` subset) from `src/db.ts`; `public/app.js` fetches it at boot and BUILDS its `STATE_KIND` / `AGENT_TYPE` / active / terminal / filter status tables from it (deleting the byte-for-byte literals that duplicated the 12-state machine), and the task-detail control panels (`in_review` / `idea` / `spec_review` / `needs_info` / idle) now build AND wire their own buttons before mount via a shared `submitTo` wrapper. UI-identical; degrades safely if the meta is briefly unavailable.
- **DRY + a desync fix on the task state-machine spine (`src/tasks.ts`, `src/conformance.ts`, `src/gate.ts`).** Routed every remaining hand-written status write through the single guarded `setStatus` transition, and de-duplicated the gate + merge-conflict plumbing. (T1, desync fix) `markRunning` (→ `in_progress`), `backToQueued` (→ `inactive`), and `markDispatchFailure`'s under-cap re-arm (→ `inactive`) each used a raw `UPDATE tasks SET status=…` that **skipped the task.md `status:` mirror** (and, for `markDispatchFailure`, the audit event too); they now go through `setStatus`, so the on-disk task.md follows the DB and `markDispatchFailure`'s genuine transition is now audited. `revertedOnRed` (→ `failed`) already mirrored task.md, so its migration is a pure collapse of the UPDATE→event→mirror→emit tail. Added a `setStatus` value-wrapper `setIfPresent(v)` → `col=COALESCE(?, col)` (overwrite-if-supplied, the mirror-image of `keep`'s stamp-once) for `grounding_fp` + `output_snapshot`. (T2) Extracted `parkExitingAgent` — the shared "agent is exiting → park its task" preamble (terminal/notfound early-out, run-log snapshot, conditional commit-on-review, the `setStatus` flip clearing pane/idle, capture-usage, and the gated footprint/CI/conformance trio); `markInReview`, `markReviewFromAgent`, and `markNeedsInfoFromAgent` now delegate to it. (G2) Extracted `recordMergeConflictNote` (resolve base → build note → append rejection → return note), shared by `prepareBranchForDispatch` and `finalizeMerge`; `finalizeMerge` now hands the note to `requestChanges` (which persists `review_note` + emits via `setStatus`) and no longer writes/emits it a second time. (G3/G4) New `src/gate.ts` helpers `makeGateLiveness()` (the in-process gate-liveness Set as a mark/clear/isLive primitive) and `settleGate(id, columns, {require?})` (the `in_review`-guarded settle write that resets `gate_recovery_attempts`, with an optional "still stuck on the same value" guard); the CI gate, the conformance gate, and `recoverStuckGates` all reuse them. Behavior-preserving apart from the two intentional additions (the restored task.md mirror and the new `markDispatchFailure` retry event); covered by a new `test/state-sync-dry.test.ts`.
- **DRY cleanup in `src/git.ts` (pure refactor, behavior identical).** Collapsed two duplicated code paths. (G1) `merge()` built the same "scan for conflict markers → return a refuse `MergeResult`" block twice (once after staging dirty worktree changes, once for an already-clean tree with committed markers); it now stages-if-dirty, calls `findConflictMarkers` **once** behind a single guard (`if (poisoned.length) return poisonedResult(...)`, a new shared helper that builds the `refusing to merge …` result), then commits-if-dirty. (G6) The stale-base probes (`merge-base --is-ancestor` and `rev-list --count`) were re-derived across `worktreeIsReusable`, `hasChanges`, `isBehindDefault`, and `rebaseOntoDefault`; extracted `branchContainsBase(dir, base, taskId)` and `branchOwnCommitCount(dir, base, taskId)` so each call site composes the two — `isBehindDefault` is now `!branchContainsBase(...)`. Added a regression test (`commit-on-review.test.ts` 4b) covering the uncommitted-marker merge-refusal path the collapsed guard now also handles.
- **DRY: collapsed the CTO agent's duplicated 'adopt-or-launch' decision into one shared helper (no more double liveness probe).** `startCtoAgent` and `reconcileCtoAgent` each independently decided "a live agent is registered → adopt, else launch", and `reconcileCtoAgent`'s launch branch re-entered `startCtoAgent`, which probed `harness.agentExists` a SECOND time for the same workspace. Factored the decision into a single private `adoptOrLaunch(workspaceId, fresh)` (probes liveness EXACTLY ONCE; returns `"adopted"` | `"launched"`) plus a guarded `ensureCtoStarted(workspaceId, fresh)` start core (mark desired-up, reset backoff, adopt-or-launch, reset the restart counter on a fresh launch) shared by both. `startCtoAgent` now delegates to it, and `reconcileCtoAgent` calls it directly instead of probing again and re-entering `startCtoAgent` — eliminating the redundant probe. Pure refactor: the `adopted`/`launched`/`stopped`/`disabled`/`skipped` action strings and observable behavior are unchanged (full CTO-agent test suite green). (task joyful-dawn-b3ef)
- **DRY cleanup in the `bin/butchr` operator CLI (pure refactor, no behavior change).** Collapsed two patterns that were copy-pasted across the subcommands into shared helpers: `requireId(positionals, cmd)` (resolves the leading `<id>` positional or fails with the standardized `butchr: <cmd>: missing <id>` message) now backs all nine id-taking commands (`show`/`approve`/`reject`/`answer`/`spec`/`nudge`/`requeue`/`block`/`priority`), and `emit(flags, data, text)` (the json-or-stdout output tail — `--json` prints the raw payload, otherwise the pre-formatted text) replaces the ~14 hand-rolled `if (flags.json) { printJson; return }` tails across every command. Also renamed the CLI's one-line `ciBadge` helper to `ciCell` to end a cross-surface grep collision with the unrelated 36-line DOM `ciBadge` in `public/app.js` (left untouched). New `test/cli-helpers.test.ts` invokes the CLI as a subprocess to prove all nine id-missing messages are identical and guards the rename.
- **DRY cleanup of the herdr CLI wrapper + shared `sleep` (no behavior change beyond two small deltas).** Three duplications collapsed: (1) `herdr.agentTabId` / `agentPaneId` / `agentTerminalId` each ran their own `agent get <name>` round-trip and probed a different slice of the SAME response, and `agentDeregister` issued TWO back-to-back `agent get`s for one payload; a new private `agentInfo(name)` does ONE `agent get` plus shared field-probes (`pickTabId` / `pickPaneId` / `pickTerminalId`), the three readers + `agentDeregister` now derive from it — **fewer herdr invocations**, identical output. (2) `herdr.agentExists` and `herdr.workspaceExists` duplicated `run([herdrBin, <noun>, 'get', id])` + `res.ok && !res.stdout.includes('"error"')`, but `workspaceExists` had DROPPED the `res.ok &&` guard so a non-zero exit with empty stdout wrongly read as present; a new private `existsByGet(args)` both callers delegate to **fixes that missing guard**. (3) the identical private `sleep(ms)` defined in both `herdr.ts` and `dispatcher.ts` is now exported once from `src/exec.ts` and imported by both (the injected-default sleeps in channel/cto-agent/selftest are test seams and left alone). Tests: new `test/herdr-dry.test.ts` (one `agent get` per reader, single `agent get` in `agentDeregister`, and the `existsByGet` guard regression) plus a `sleep` assertion in `test/exec-argv.test.ts`.
- **Reordered the canonical task lifecycle so the rollback states sit after `merged`.** The presentation order of the 12 states is now `idea, spec_review, blocked, needs_info, inactive, in_progress, in_review, merged, rolling_back, rolled_back, failed, aborted` — `rolling_back`/`rolled_back` moved from before `in_review`/`merged` to immediately after `merged`, reflecting that a rollback happens *after* something has merged. This is an ordering/presentation change only (the state-model `ALL_STATUSES` / `STATE_META` key order + comments in `src/db.ts`, the webapp's status-filter chips and dashboard count-pills in `public/app.js`, the status color/chip/timeline/graph/metrics blocks in `public/style.css`, and the state table in `CONTRIBUTING.md`); no behavior changed — membership-based logic (`isTerminal`, `STATE_META` kinds, transitions) is unaffected, and `isTerminal` still classifies `merged | aborted | failed | rolled_back` as terminal (`rolling_back` is not).
- Final pass complete — nothing to change. Reviewed the full diff vs main: no stray debugging (only operational `[butchr]` logging), no TODO/FIXME, no conflict markers; no stale post-rename/redesign terminology in my added lines (no finalizing/finalizeLivingDocs/directory_id/getDirectory/insertUnreleasedEntry/summaryLine/taskMarker). Comments + docs are accurate to the renamed + mechanical-merge code (test header, finalize-changelog merge() helper, CONTRIBUTING §7/§8/§9); no unused helpers left behind. Working tree clean, single commit on the current main tip. Gate green: bun build clean + bun test ./test = 481 pass / 0 fail. Ready to merge. (task vibrant-slope-9070)
- Final pass complete — no changes needed. Reviewed the full diff vs main: no stray debugging, no live leftover references to the removed forms (only the intentional retired-column comments in db.ts + the regression assertion in plan-preview.test.ts), comment honesty verified. Build green, no conflict markers. Ready to finalize/merge. The change shrinks the agent MCP surface to request_review + raise (plus propose_plan for plan-preview tasks): removed propose_subtasks and the kind='plan' decompose path (service, spawned_subtasks column orphaned in-place, rollup UI, PLAN_PROTOCOL, plan-decompose.test.ts); renamed/broadened ask→raise everywhere including the agent-facing CTO context seed (src/workspaces.ts). Preserved main's workspace rename, kind='rollback', plan_preview, the "keep going" block, and grounding_fp machinery. bun build + bun test ./test green (475 pass, 0 fail). (task peppy-kestrel-1d39)
- Final pass complete — nothing to wrap up. Reviewed the full diff: no stray debugging, no TODO/FIXME, no conflict markers (the only `<<<<<<<` hits are the pre-existing conflict-marker DETECTION regex in findConflictMarkers, not mine). Comments + the CONTRIBUTING.md "Power-loss resilience" runbook are accurate to the final code (union detector, all-refs-intact safety proof, reachable-corruption-surfaced-never-deleted, the two toggles). Branch is on the current main tip (git log HEAD..main empty). Re-ran the gate: bun build green; bun test ./test green (488 pass, 0 fail). No CHANGELOG.md/package.json edits. Ready to merge. (task fresh-galaxy-49a2)
- Final pass done. Two things: 1. FIXED a latent live-data bug found in self-review: `db.migrateStatusModel` runs on EVERY boot and folded legacy `failed`→`aborted`. Since the 12-state model now has a REAL terminal `failed` state, that fold would have corrupted every genuine `failed` task into `aborted` on the next restart — silently defeating requirement #4. Removed the `["failed","aborted"]` rename (a legacy `failed` row is already correct in the new model) and updated the migration comment. Full suite still 483 pass / 0 fail; build clean. 2. Tidied the migrateStatusModel doc comment (dropped the stale "finalizing is canonical" line; documented why `failed` is deliberately not folded). No stray debugging, no conflict markers; branch sits on top of current main. Ready to merge. (task sublime-badger-f685)
- Final pass complete — nothing to wrap up. Reviewed the diff one last time: it's minimal and clean (the "Add idea" ghost button next to "New task", plus the openAddIdeaModal function), comments are accurate and match surrounding style, no stray debugging, no CSS/HTML changes (reused existing classes). Ready to merge. (task swift-gale-acf0)
- Final pass complete — no new work. Tidied one doc comment (GateRecoveryResult now accurately describes the three counts and that they're surfaced in startup/backstop logs, removing a mention of a non-existent health surface). No stray debugging; all console output is operational logging consistent with the auto-resume/reaper paths. Re-verified: build clean, gate-recovery + ci-gate + conformance-gate tests pass (39/39). Ready to merge. (task tranquil-deer-3a9a)
- Final pass done — nothing to wrap up. Self-reviewed the full diff: no stray debugging/console noise, no .only/debugger, no TODO/FIXME introduced (the one TODO match is pre-existing cost_usd in captureSessionUsage, untouched). Confirmed no stale pre-rename identifiers in my added regions (no directory_id/getDirectory/DirectoryRow/directories.ts). Comments + the CONTRIBUTING.md "Restart resilience" section are accurate to the renamed code. Gate green: build OK + bun test ./test = 464 pass / 0 fail. Ready to merge. (task rosy-owl-f165)
- Final pre-merge pass complete — no changes needed. Self-reviewed the rebased diff: no awkward double-"workspace" phrasings, no stray debugging (console.log/TODO/FIXME), no half-renames (no `dir-` minting, no leftover DirState/dirStates). Branch is a single commit on main's tip (merge-base == main tip, so the gate's rebase is a no-op), working tree clean, 69 files / +1238 -1002. Gate green: bun build exit 0; bun test ./test → 454 pass / 0 fail. Ready to merge. (task glacial-pyrite-5474)
- Final pre-merge pass: reviewed the full diff against main, tidied the rewrapped comment block in directories.ts (directoryGateCmd doc), no stray debugging, no behavior changes since approval. Build green and 439 tests pass. Change set (unchanged from approval): removed butchr's self-hosting-only machinery — verifyCmd default now empty (gate configured per-repo via gate_cmd/BUTCHR_VERIFY_CMD), ctoChannelCmd now an absolute path to butchr's own channel.ts (cwd-independent), butchr-architecture templates (webapp-panel/add-endpoint) dropped and the rest generalized, CTO brief/comments de-self-referenced, and the three stale "defaults to butchr's own command" comments corrected. (task trusty-cobra-cc59)
- Final pass complete — nothing to change. Reviewed the committed diff: no stray debugging/TODOs/console logs; comments and docs (db.ts grounding_fp column, taskmd.ts function docs, dispatcher inline rationale, CONTRIBUTING.md §1 "Resume re-grounding") are accurate and tidy; worktree clean. Gate remains green (bun build clean, bun test ./test = 444 pass / 0 fail). No further changes. Ready to finalize and merge. (task stellar-yak-fa45)
- Final pass complete — nothing to tidy. The diff is minimal and clean: the new "# Keep going until the task is done" section in REVIEW_PROTOCOL (src/taskmd.ts) plus the corresponding assertions in test/idea-pipeline.test.ts. No stray debugging, comments are coherent with surrounding style. Ready to finalize and merge. (task scarlet-moth-6aea)
- Final pass complete — no changes needed. Reviewed the diff against main: exactly the 5 intended files (src/terminal.ts, test/terminal.test.ts, scripts/install-service.sh, deploy/butchr.service, CONTRIBUTING.md), no CHANGELOG.md/package.json touched, no stray debugging/TODOs, comments and docs tidy. Gate still green (bun build + 440 tests pass). Ready to merge. (task ivory-delta-5a7a)
- Final pass complete — no changes needed. Reviewed the full diff: comments/docs accurately describe the dedupe now living in `ensureDirectoryWorkspace` (the exported `WorkspaceHeal` type, initiator-owns-the-create semantics, awaiters get created=false), no stray debugging, dispatcher's redundant map cleanly removed with its wrapper collapsed. Build + `bun test ./test` green. Ready to finalize and merge. (task loyal-jackal-6465)
- Final pass complete — nothing to wrap up. Reviewed the committed diff (src/text.ts clipLine guard + 3 new test files): comments/docs are accurate (guard semantics for max<=0 and the surrogate-pair caveat documented), no stray debugging, working tree clean. Gate stays green: build OK, bun test ./test → 434 pass / 0 fail. Ready to merge. (task glacial-ridge-f526)
- Final pass complete — nothing to change. Reviewed the auto-saved diff (commit 0ac66cb): the fix moves updateTaskMdStatus inside the `if (planRes.changes > 0)` guard with a clear explanatory comment; the two added tests are well-documented; no stray debugging. Build + full test suite green (409 pass). Ready to merge. (task warm-hill-96b8)
- Final pass done. Self-reviewed the diff — minimal and on-target. One tidy: updated a stale comment in test/state-machine.test.ts (file header line 4) that still referenced "the helpers" (the deleted stateKind/agentTypeOf/isAgentState/isFeedbackState); it now reads "via db.STATE_META, plus db.isTerminal", matching the actual remaining coverage. No code/behavior changes. Gate re-run green: build OK, bun test ./test → 407 pass / 0 fail. Ready to merge. (task plucky-basalt-2062)
- Final pass done — nothing to change. Verified: no stray debugging/TODO/console.log in the diff; no orphaned `dir` (removed it from the 4 migrated fns — setBlockedBy/markReviewFromAgent/markNeedsInfoFromAgent/markDispatchFailure — confirmed clean; the remaining `const dir` declarations are all unrelated functions like taskDiff); new-helper and migrated-site comments are accurate. No code changes in this pass. Gate remains green (build exit 0, 407 tests pass / 0 fail). Ready to finalize + merge. (task calm-lemur-6692)
- Final pass complete — no changes needed. Reviewed the full diff vs main: comments accurately describe each extracted shared helper (shellQuote/modelFlag/buildScriptArgv/stripAnsi in exec.ts; startAgentReconciling/startAgentInFreshTab in herdr.ts; ensureDirectoryWorkspace in directories.ts; loopbackHost/readonlyClaude in config.ts; dirOf/consumeAbort in dispatcher.ts), no stray debugging, no dead code, no unused imports (removed the now-orphaned `import type { StartedAgent }` from both dispatcher.ts and cto-agent.ts). Re-confirmed the gate is GREEN: `bun build` OK and `bun test ./test` → 407 pass / 0 fail. Ready to finalize and merge. (task humble-stoat-c21f)
- Final pass complete — ready to merge. Reviewed the full diff vs main (confined to public/app.js, +122/−122): no stray debugging, comments accurate. One tidy-up: moved the extracted ctoState() above the detailed ctoPanel doc-comment so the section header → ctoState → ctoPanel reads cleanly (the helper was wedged between the comment and the function it describes). Gate re-run green: app.js bundles clean, `bun build src/index.ts` clean, `bun test ./test` → 407 pass / 0 fail. No functional changes since approval. (task cyan-storm-dd26)
- Final pass complete — reviewed the full diff against the base: minimal, comments accurate (e.g. tidy's "Collapse whitespace + truncate" still holds), no stray debugging, behavior byte-for-byte preserved. Build green, 407/407 tests pass unchanged. Ready to merge. (task tender-boar-250b)
- Final pass complete — no changes needed. Reviewed the committed diff: comments/docstrings are accurate (the transcript route's "limit clamped to 1..500, default 200" still matches the new intParam call), no stray debugging, no leftover dead code. Ready to merge. (task sleek-fjord-c33d)
- Final pass complete — nothing to change. Reviewed the full diff against main: the three runners (defaultConformanceRunner, defaultBriefExpander, defaultSpecWriter) cleanly delegate to runHeadlessWithPrompt in the new src/headless.ts and keep only their own parsers. Removed constants/imports are all gone; no stray debugging; doc comments on each runner ("rendered prompt via a temp file (no shell-escaping)") remain accurate since the extracted scaffold preserves that behavior. Ready to merge. (task placid-quasar-5cfe)
- Final pass complete — nothing to tidy. The change is a single clean deletion: removed the unused exported `ensureParent` (C18c) and its now-orphaned `dirname` import. No comments/docs/debugging touched. Working tree clean, deletion confirmed present. Signaling butchr to finalize and merge. (task playful-cloud-82ed)
- Final pass complete — nothing to wrap up. The C28 refactor stands: `const known` hoisted above the if(dir)/else in resolveSandbox, referenced in both error messages. No comments referenced the old structure, no stray debugging, diff is minimal. Gate green (build clean, 407 tests pass). Ready to merge. (task fuzzy-tiger-ac70)
- Final pass complete — nothing to wrap up. Reviewed the committed diff: all changes are SPEC.md/OPERATIONS.md reference repointing in comments, prompt strings, task templates, and service files, plus the two test-fixture updates (expand-brief, estimate) and the new single-doc CONTRIBUTING.md. No stray debugging, no unintended edits. Verified CONTRIBUTING.md internal anchors resolve to their section headers and the expand.ts grounding line reads correctly. Gate still green (bun build clean; bun test 407 pass / 0 fail). Ready to merge. (task keen-cosmos-2c52)
- Final pass complete. Working tree clean and rebased on latest main; no conflict markers or stray debugging in any changed file (the only `debugger` hit is a pre-existing keyword list in public/app.js's syntax highlighter). The conflict-resolution `reconcilePane` added to the test fake is well-commented (mirrors agentPaneId). Last full verify was green: build + `bun test ./test` (407 pass, 0 fail), unchanged since. Ready to finalize/merge. (task maroon-gypsum-3060)
- Final pass complete — ready to merge. Only cleanup needed: fixed comment placement where `currentPaneRepairing` had been inserted between `maybeNudgeStalledAgent`'s doc comment and its body, detaching that doc block. Reordered so `NudgeState` → `currentPaneRepairing` (own doc) → `maybeNudgeStalledAgent` (own doc + body). Pure structural/comment fix, no behavior change. No stray debugging (the one console.log is an intentional `[butchr] …` operational log matching house style). `bun build` + full `bun test` green (386 pass). (task cozy-zephyr-d142)
- Final pass complete — no changes needed. Reviewed the committed diff: comments/docs are tidy, no stray debugging (the one console.log mirrors the existing watchdog audit-logging style), and implementation + SPEC + tests are coherent. bun build + bun test green (380 pass). Ready to merge. (task modest-stork-3257)
- Final pass complete — no changes needed. Reviewed the full diff: no stray debugging/TODOs, operational console logs match the dispatcher's style, test-only exports are used only by the test, comments/docs (SPEC §6.8 + config table + data model) are tidy. Build + full test suite still green (371/0). Ready to merge. (task pearly-loon-b048)
- Final pass complete — no changes needed. Reviewed the committed diff (auto-saved in d8c2583): comments/docs are tidy, no stray debugging in the repo (the /tmp recorder scratch files are outside the worktree and uncommitted), and the implementation is minimal and self-contained across SPEC.md, src/harness.ts, src/herdr.ts, test/harness.test.ts, and test/send.test.ts. Build and full test suite remain green. Ready to merge. (task zappy-seal-ee69)
- Final pass complete — no changes needed. Reviewed the captured diff: comments/docs are accurate, no stray debugging, change is minimal (143 insertions across public/app.js, public/style.css, SPEC.md). Ready to merge. (task dulcet-crag-1a20)
- Final pass complete — nothing to change. Self-reviewed the full diff: comments/docs are tidy, no stray debugging, fix intact (src/config.ts verifyCmd → `bun test ./test`, new bunfig.toml `[test] root`, SPEC.md docs, new regression test). Build + full ./test suite green. Ready to finalize and merge. (task chipper-quail-2384)
- Implemented FRESHEN-ON-REVIEW: on the in_progress→in_review transition the task branch is now rebased onto the current default tip BEFORE the CI/conformance gates run, so the review diff + CI badge reflect the real to-be-merged state on top of current main. Changes: - src/tasks.ts: new exported `freshenAndGate(id)` — guarded by git.branchExists + git.isBehindDefault, rebases via git.rebaseOntoDefault serialized through the existing runExclusiveMerge queue. Clean/already-current → runs captureDiffFootprint + triggerCi + triggerConformance on the freshened worktree. CONFLICT → routes back to the agent through the SAME conflict channel (buildConflictNotes + appendRejection + requestChanges resume to in_progress), never settling a green review. Hard git error → falls through to gating the unrebased tree. Wired into markInReview and markReviewFromAgent (replacing the direct gate-trigger calls), so the dispatcher reconcile→review rescue path (which calls markInReview) is covered too. - src/git.ts: small `branchExists` helper to guard the freshen against placeholder/worktree-only tasks. - src/dispatcher.ts: clarifying comment at the reconcile→review markInReview call. - SPEC.md: documented freshen-on-review (review reflects current-main state; a freshen conflict bounces back to the agent) and noted CI runs on the freshened tree. Tests: - New test/freshen-on-review.test.ts (real git): stale base rebased + CI sees freshened tree; already-current is not rebased; freshen CONFLICT routes to conflict/resume (not merged, agent notified, note recorded, no green review, CI never ran); post-green-review merge rebase is a no-op; stale-base-revert scenario (main's newer code preserved, never silently reverted). - Updated ci-gate + conformance-gate transition tests to await the now-async freshen-then-gate step. `bun build src/index.ts --target bun --outfile /dev/null` passes; `bun test` is 338 pass / 0 fail. No CHANGELOG.md/package.json edits. (task warm-camel-b399)
- Added a one-way CTO notification channel (Claude Code Channels research preview). NEW FILE src/channel.ts — a zero-dep STDIO MCP "channel" bridge, hand-rolling the newline-delimited JSON-RPC framing + SSE parser the same way src/mcp.ts hand-rolls Streamable-HTTP (only butchr import is `config` for the default URL): - initialize advertises ONLY capabilities.experimental['claude/channel']={} — NO tools/resources/prompts capability, no reply tool, no permission relay (ONE-WAY). - Subscribes to butchr's EXISTING SSE stream (GET /api/events) and edge-triggers a notifications/claude/channel notification {content, meta} for each task ENTERING an attention state. Attention states = spec_review/in_review/needs_info/aborted (the spec's "failed" folded into canonical "aborted" per db.ts). AttentionBridge remembers last-seen status so re-emits and reconnect replays don't re-fire. - content = concise human line (id, dir label, state, spec/summary/question/failure reason); meta = {task_id, dir, state} identifier-keyed (dir = stable directory_id; human label resolved into content via a cache seeded from /api/directories and kept fresh off directory.* events). - Best-effort + resilient: malformed/irrelevant events and write failures dropped silently; SSE auto-reconnects on drop; all logs to stderr (stdout reserved for protocol). Runnable via `bun run src/channel.ts --role cto`; URL overridable with BUTCHR_CHANNEL_SSE_URL. test/channel.test.ts (13 tests): correct notification shape per attention transition; advertises claude/channel but NO tools (+ handleRpc has no tools/call); SSE reconnect after stream-end and after open() throws; malformed/absent-payload events dropped silently; plus transition dedup, label cache, and SSE framing. SPEC.md: new §6.7 "CTO notification channel (one-way)" + TOC entry documenting the contract, notification shape, resilience, feasibility (Claude Code ≥v2.1.80 + Anthropic auth), and launching the CTO agent (--dangerously-load-development-channels server:butchr-cto-channel + .mcp.json registration). No CHANGELOG.md/package.json edits (auto at merge); zero new runtime deps. Canonical gate green: `bun build src/index.ts --target bun --outfile /dev/null && bun test` → 337 pass / 0 fail; channel.ts builds clean. Out of scope (deferred): the workspace-agent channel for feedback-answered events. (task balmy-sleet-d0f4)
- Fixed the dashboard so tasks awaiting the operator are never hidden under "Finished". Root cause (public/app.js): the directory List view defined its "Finished" collapsible as the COMPLEMENT of ACTIVE_STATUSES (`!ACTIVE_STATUSES.includes(status)`). For the canonical 9 states this happened to be just merged/aborted — and the feedback states (spec_review/in_review/needs_info) were already in ACTIVE_STATUSES, so they were already excluded from Finished. The latent bug: ANY non-canonical/legacy status a row can still carry (notably `failed`/`rejected`, which historically backed a post-merge revert or dispatch give-up — see SPEC §3) fell through the complement into Finished and got hidden behind the collapse. Fix — defined Finished by an explicit terminal allowlist instead of a complement: - Added `const TERMINAL_STATUSES = ["merged", "aborted"]`. - renderResults now splits: history = TERMINAL_STATUSES only; active = everything else. This guarantees no needs-attention state can ever be hidden under Finished, regardless of whether its status is in the active list. - tasksTable now surfaces the existing state-kind chip ("feedback: diff review/spec approval/answer to question") on feedback rows so a row awaiting a human reads at a glance in the always-visible active list. - Updated the stale inline comment that claimed history = merged/aborted/rejected. Cross-project rollup verified correct (server-side, unchanged): src/directories.ts computes review = spec_review + in_review + needs_info and needsAttention = review (failed bucket is always 0 since the canonical model has no failed state). Counts feedback states correctly. public/style.css: no change needed — reused existing .chip.state-kind-feedback / .chip.failed / .chip.rejected styles. SPEC.md: documented that the collapsible "Finished" section holds ONLY terminal idle states (merged/aborted), and non-terminal/feedback tasks stay in the always-visible active list. test/: no UI-logic harness exists for the browser-only app.js partition; the server projection (task-list-view, dashboard rollup) is already covered and unchanged. Build gate (`bun build src/index.ts --target bun --outfile /dev/null`) and full `bun test` (329 pass / 0 fail) are green. No CHANGELOG/package.json edits; zero deps. (task hazy-knoll-6e12)
- Implemented commit-on-review durability so agent work survives worktree deletion and the branch is the source of truth for review-state work. - src/git.ts: added `commitWorktree(dir, taskId, message)` — synchronous (Bun.spawnSync), best-effort + idempotent, UNCONDITIONAL (commits even with conflict markers; the merge-time findConflictMarkers guard still refuses to land poisoned content). Reuses git.merge's `git add -A` + commit mechanism. - src/tasks.ts: factored `autoCommitOnReview` helper and call it FIRST (before the DB transition) in markInReview (dead-agent rescue + watchdog/reconcile route through it), markReviewFromAgent (live in_progress→in_review), and markNeedsInfoFromAgent (in_progress→needs_info). Gated on the genuine in_progress transition. WIP message: `butchr: wip <taskId> (auto-saved)`. - Resume preserves it: rejectTask/answerTask don't reset the branch, and since the branch now always has a commit, rebaseOntoDefault rebases (no more "no commits → reset" wipe). No dispatcher changes needed — both rescue call sites go through markInReview. - SPEC.md: documented commit-on-review + that the branch is the durable source of truth for review-state work. - test/commit-on-review.test.ts: 4 new tests — (1) in_review commits uncommitted changes onto the branch, (2) needs_info round-trip preserves work, (3) request-changes→resume keeps the WIP commit and further changes merge cleanly to merged, (4) conflict-marker worktree is WIP-committed but still REFUSED at merge. No CHANGELOG.md/package.json edits. `bun build src/index.ts --target bun --outfile /dev/null` passes; `bun test` 328 pass / 0 fail. (task cosmic-tapir-9dc8)
- Hardened git.createWorktree against reusing stale/broken worktree dirs (validate-or-rebuild). src/git.ts: createWorktree no longer trusts an existing dir at <dir>/<taskId> via a bare existsSync. New worktreeIsReusable() validates before reuse: (1) git recognizes it as a live linked worktree (rev-parse --git-dir succeeds inside AND path is in `worktree list`); (2) HEAD is on branch <taskId>; (3) not a never-worked leftover on a stale base — current tip is contained in the branch, OR the branch carries its own commits (real agent work the pre-dispatch/merge-time rebase replays — never discarded). If invalid, removeStaleWorktree() does best-effort `worktree remove --force` → rm+`worktree prune` fallback → `branch -D`, then createWorktree recreates fresh via `worktree add -b <taskId>` on the current default tip. Best-effort, never throws on recoverable stale state; the normal no-leftover path is byte-for-byte unchanged. Key safety point: a behind-base branch WITH commits is REUSED, not rebuilt — rebuilding would silently destroy committed rework. Auto-rebase (rebaseOntoDefault) still moves it onto the tip afterward. test/worktree-validate.test.ts: real-git tests — (1) valid worktree reused unchanged (sentinel survives); (2) broken .git link rebuilt to valid; (3) stale-base leftover (behind, no commits) rebuilt onto current tip (sentinel wiped); (4) normal no-leftover path creates fresh; plus (5) behind-base-WITH-commits is reused, guarding the rework path. SPEC.md: documented validate-or-rebuild in §3 (dispatch step 2 + a dedicated subsection). No deps. `bun build src/index.ts --target bun --outfile /dev/null` and full `bun test` (327 tests) pass. No CHANGELOG.md/package.json edits. (task upbeat-fern-375b)
- Built a swappable agent-execution harness abstracting the herdr session/runtime ("herdr or whatever") behind an interface, on top of current main's 9-state machine (no state-machine code reverted). Pure refactor, no behavior change. NEW src/harness.ts: the AgentRunner/ExecBackend interface naming every runtime op butchr needs — provision workspace, launch interactive agent (PTY/script: session-id/resume/mcp-config/model), the headless read-only modes via runHeadless (CTO-fork spec-gen, conformance, expand), confirm-live, resolve pane handle, read output, teardown. Owns the handle types (Workspace/Tab/StartedAgent/PaneInfo) + HeadlessSpec/HeadlessResult. Exposes a `harness` proxy (binds to the active backend at call time), setRunner/getRunner. Default backend = herdr; type-only import back to harness avoids any runtime import cycle. src/herdr.ts: now the herdr IMPLEMENTATION behind the interface. Keeps every existing exported function (so server/directories/tasks/index importers are untouched), re-exports the handle types, adds a generic runHeadless (the byte-for-byte Bun.spawn the headless callers shared), and exports herdrRunner: AgentRunner. src/dispatcher.ts + src/reaper.ts: refactored to call the `harness` proxy, NOT herdr directly (verified: no ./herdr.ts import remains in either). dispatch() exported for testing. src/cto.ts / conformance.ts / expand.ts: their default runners now route through harness.runHeadless so the interface's headless methods are live rather than dead — identical behavior (read-only, stdin ignored, SIGKILL on timeout), and their setSpecWriter/setConformanceRunner/setBriefExpander test seams are preserved. (These 3 files are beyond the 4-file scope list but are required to make the headless part of the interface real per the spec; trivial to trim if you'd prefer the interactive-only seam.) test/harness.test.ts (NEW): drives the full dispatch() path against a FAKE backend (real git, no herdr/claude) — asserts the launch sequence (workspaceCreate→tabCreate→agentStart→paneClose→resolveAgentPane), markRunning against the RESOLVED pane (phantom-pane guard), the can't-resolve-pane failure routing to the bounded-retry path with no phantom pane recorded, and runHeadless flowing through the proxy. SPEC.md: documents the harness seam in §1 + the architecture diagram. Verification: `bun build` green; `bun test` green (324 pass / 0 fail, +3 new); zero new dependencies. No CHANGELOG/package.json edits. (task sleek-zebra-02ee)
- Changes from task sleek-salmon-b099 (task sleek-salmon-b099)
- Unified butchr task state into ONE status pipeline (idea → ready → in_progress → review → merged; lateral: blocked/awaiting_input/failed/aborted/rejected), retiring the retracted two-axis `stage` design via the minimal-churn Option B. WHAT CHANGED - db.ts: added `idea` front state to TaskStatus; folded out the `stage` axis (removed TaskStage type + TaskRow.stage + the ensureColumn). Added a backward-compatible startup migration `migrateStageAxisToStatus()` — flips legacy `stage='idea'` rows that hadn't dispatched (queued/blocked) to status `idea`, leaves everything else untouched, guarded on the column still existing (fresh DBs skip it; old DBs keep the orphaned column rather than risk a destructive ALTER). Kept internal `queued`/`running` values (no mass-rename). - cto.ts (NEW): revived the CTO-fork mechanism as the spec generator — a forked, headless, READ-ONLY claude (`--resume <ctoSessionId> --fork-session` when set) that turns an idea's brief into a repo-grounded spec. Reuses src/expand.ts's buildExpandPrompt + parseExpansion. Mockable via setSpecWriter. - config.ts: revived `specGenCmd` (`{{CTO_SESSION}}`/`{{PROMPT_FILE}}`), `specGenTimeoutMs`, `ctoSessionId`. - tasks.ts: createTask takes `idea: boolean` (replaces `stage`); idea → status `idea`. Added promoteIdeaToReady (rewrites task.md prompt brief→spec, idea→queued/blocked) and markSpecGenFailure (bounded retry/backoff → failed). Removed approveSpecStage + the spec-gate branch in approveTask + flipIdeaToSpec. validateIdea replaces validateStage. - dispatcher.ts: tick now runs an IDEA pass (selectIdeaForDispatch → generateSpecForIdea) before the queued pass; idea tasks run the CTO-fork (not a build agent), then advance to ready and dispatch normally. Honors pause + backoff like queued. - taskmd.ts: removed IDEA_SPEC_PROTOCOL/updateTaskMdStage/stage (parse/serialize/render); legacy `stage:` lines are ignored. Added updateTaskMdPrompt. - server.ts: create endpoint accepts `idea` (and honors legacy `stage:"idea"`). - directories.ts: dashboard counts include `idea` as active. - public/app.js + style.css: New-task modal gains a "New Idea" mode (one-liner → idea); conceptual status labels surfaced (queued→'ready', running→'in progress'); idea added to filter/board/pill status lists + an `idea` chip color; removed the stage badge. - SPEC.md: replaced the two-axis docs with the unified pipeline (§2.1/§2.2/§2.7 rewritten, retraction note, DB schema/API/env tables updated). TESTS: replaced stage-lifecycle.test.ts with idea-pipeline.test.ts (8 tests) covering idea→(spec via CTO-fork, mocked)→ready, new task enters ready directly, spec-gen failure backoff→failed, the full idea→ready→in_progress→review→merged pipeline, and the stage axis folded out (DB migration + legacy task.md parse). `bun build` + full `bun test` pass (311 pass / 0 fail). Did not touch CHANGELOG.md/package.json per convention. (task deft-walrus-fdab)
- Implemented the IDEA → SPEC → BUILD task-stage lifecycle (1:1 foundation), exactly per the CTO design. MODEL: added a `stage` column ('idea'|'spec'|'build', DEFAULT 'build') on tasks — additive ensureColumn migration, fully backward-compatible (every existing row backfills to 'build', which is today's behavior unchanged). Linked records on the existing dependency graph, not a mega state machine. STAGE BEHAVIOR: - A stage='idea' task is a spec-writing record: on its first dispatch renderAgentPrompt hands it the new IDEA_SPEC_PROTOCOL (taskmd.ts) instead of the review protocol — it writes NO code, grounds itself in the repo (mirroring src/expand.ts's guidance), writes a detailed repo-grounded task prompt (the SPEC), and submits it as the request_review `summary`. So reviewing an idea/spec task = reviewing the spec. - idea→spec is AUTOMATIC: flipIdeaToSpec advances stage 'idea'→'spec' the moment the agent submits for review (wired into markReviewFromAgent + markReview, only on genuine running→review transitions; keeps task.md's stage line in sync via updateTaskMdStage). THE SPEC GATE (the key gate): approveTask branches on `stage !== "build"` into approveSpecStage, which AUTO-CREATES a stage='build' task in the same directory whose prompt IS the approved spec (the summary; falls back to the idea task's own brief if no summary captured), inherits the model, then completes the spec task terminally to 'merged' recording the build id in spawned_subtasks (reusing the plan→sub-tasks linkage) and tearing down its codeless worktree — mirroring proposeSubtasks. The spawned build task runs the normal dispatch → CI → review → merge flow. So: idea→spec auto; spec→build GATED; build→merge = existing review. OPTIONAL ENTRY: creating a stage='build' task with a full prompt directly is 100% unchanged (the default). WEBAPP: new-task modal gets an "Idea stage" checkbox (sends stage:'idea'); cards/detail show an idea/spec stage chip (taskChips + .chip.stage CSS); toast updated. server.ts threads body.stage into createTask; validateStage rejects unknown values (400). DOCS: SPEC.md updated thoroughly — new §2.7 (stage lifecycle + gates), TOC entries (2.6/2.7), the `stage` row in the tasks data-model table, and the approve section now documents the spec-gate branch. Did NOT touch CHANGELOG.md/package.json (butchr auto-records at merge). TESTS: added test/stage-lifecycle.test.ts (6 tests) covering: stage defaults to 'build' + normal protocol (backward compat); createTask(stage='idea') stamps row + task.md + idea/spec protocol; validateStage rejects bad values; idea→spec auto-advance on review; the SPEC GATE spawns a build task carrying the approved spec (and the summary-absent fallback to the brief); and a stage='build' task running the normal approve→merge flow unchanged (no spawn). Zero new deps. `bun build src/index.ts --target bun --outfile /dev/null` clean; full `bun test` green (309 pass, including the 6 new tests). (task playful-rabbit-0405)
- Redesigned the webapp new-task modal for low-effort creation, plus a brief→expand backend. WHAT: 1. BRIEF→EXPAND. New `src/expand.ts` (modeled on `src/conformance.ts`) reuses the headless read-only claude recipe (`claude -p --permission-mode dontAsk --allowedTools "Read Grep Glob"`). New `POST /api/expand-brief {brief, directory}` route in server.ts resolves the directory (by id or path), runs the expander with that repo as cwd, and returns `{ prompt }` — a concrete, repo-grounded task prompt. Config: `expandBriefCmd` / `expandBriefTimeoutMs` (BUTCHR_EXPAND_BRIEF_CMD/_TIMEOUT_MS), empty disables. Not best-effort for the operator: blank brief → 400, unknown dir → 404, failure → 502 (brief kept). 2. MODAL REDESIGN (public/app.js + style.css). Default surface is now just: one-line **idea** box + **Expand ✨** button (spinner while expanding; drops result into the prompt textarea for review/edit; on error keeps the brief + shows a message) / template dropdown → prompt → Create. The five less-common knobs (blocked_by, model, tags, priority, plan + plan-preview) are collapsed behind an **Advanced** disclosure (closed by default). Manual prompt path and template dropdown both still work. CONVENTIONS: Did NOT touch CHANGELOG.md/package.json. Updated SPEC.md (the expand-brief endpoint row, the redesigned-modal §6.5 description, and the two env-var rows). TESTS: `test/expand-brief.test.ts` exercises /api/expand-brief logic with the headless call MOCKED (setBriefExpander) — happy path (brief in → expanded prompt out), brief trimming, blank-brief rejection, NULL/throw → clean error, plus the pure helpers (buildExpandPrompt, parseExpansion). `bun build … --outfile /dev/null` green; full `bun test` green (303 pass, 0 fail). (task dapper-diamond-5349)
- Added an opt-in PLAN-PREVIEW gate that reuses the awaiting_input (ASK) handshake. A task created with plan_preview=true is an ordinary work task that, on its FIRST dispatch, is handed a new PLAN_PREVIEW_PROTOCOL + a new `propose_plan` MCP tool instead of the review protocol. The agent submits a concise implementation plan via `propose_plan`, which calls the existing markAwaitingInputFromAgent to park the task in `awaiting_input` holding the plan (returns immediately, agent exits). The operator answers 'proceed'/steering notes via the existing answer surface; answerTask re-queues for a `--resume` re-launch (renderAnswerPrompt carries the review protocol) and the agent implements + request_review as normal. Non-plan-preview tasks are unchanged. Changes: - src/db.ts: new `plan_preview` INTEGER column + TaskRow field. - src/taskmd.ts: plan_preview in TaskMeta, front-matter round-trip, PLAN_PREVIEW_PROTOCOL, renderAgentPrompt branch. - src/mcp.ts: PROPOSE_PLAN_TOOL + runProposePlan (reuses markAwaitingInputFromAgent); refactored tool gating from a `plan` bool to a general `gate(task)` predicate so propose_plan is offered only to plan-preview tasks (and propose_subtasks/request_review keep their kind gating). - src/tasks.ts: createTask gains a planPreview param + validatePlanPreview (400 on non-boolean); stored on the row + task.md. - src/server.ts: passes body.plan_preview through. - bin/butchr: `new --plan` boolean flag. - public/app.js: create-form checkbox + plan_preview in the POST body + a plan-preview chip. - SPEC.md: §2.6 plan-preview gate, MCP tools (§6.3), API/CLI/DB tables, front-matter + diagram updates. Did NOT touch CHANGELOG.md/package.json (auto-recorded at merge). Zero deps. Added test/plan-preview.test.ts covering create→plan-preview prompt, tools/list gating, propose_plan→awaiting_input (via the real handleMcp transport, agent mocked), blank-plan rejection, and answer→resume of the same session. Full suite: 292 pass / 0 fail; new file: 6 pass. (task humble-marten-7a53)
- Resolved the merge conflict by rebasing onto the latest main (no longer behind). Conflicts were in SPEC.md (3 hunks) and public/app.js (1 hunk), all from main's parallel features landing in the same regions; resolved by KEEPING both sides: - SPEC routes table: kept main's `gate_cmd` POST + new PATCH /api/directories rows, and added `rollback` to the templates list. - SPEC CLI table: kept main's new `priority` row alongside my updated `selftest` line (dropped `…/rollback`, added the `--merge` self-revert note). - SPEC webapp section: kept main's `awaiting_input` answer box + "Awaiting answer" board lane, and applied my rollback-control repoint ("Roll back" button creates a rollback task). - app.js taskChips: kept main's new `priority` chip + the `conflict` chip; dropped the now-removed `rolled-back` chip. All my rollback-redesign changes survived intact (rollback template, repointed button, removed /rollback route + rollbackTask + revertCommits + rolled_back_at column, selftest local-revert cleanup, SPEC/test updates). Re-verified after rebasing onto the current main tip: `bun build` clean, `bun test` green (288 pass / 0 fail across 33 files). Branch is now linear atop main with no remaining conflicts. (task stately-coral-3648)
- Reordered webapp task-status display so `blocked` appears immediately before `queued` across all ordered views (webapp-only, no API/behavior change): - queueLine summary: blocked now pushed before queued - dirCard count pills: ["blocked","queued",...] - FILTER_STATUSES filter chips: blocked before queued - ACTIVE_STATUSES: reordered for consistency (membership set; display-neutral) - BOARD_LANES (pipeline/merge-train board): Blocked lane now precedes Queued lane; updated the lane-order comment with the rationale No CSS change needed (status styling is class-based, not order-dependent). SPEC.md doesn't enumerate this status ordering, so left unchanged per convention. bun build + bun test green (293 pass). (task emerald-basin-c809)
- Added a read-only LIVE ACTIVITY PULSE on running task cards/rows in the webapp. Backend (src/transcript.ts): new readSessionActivity/parseTranscriptActivity/extractActivity reusing the existing parseTranscript, but reading only the TAIL (128KB) of the session JSONL via a new readFileTail helper. Scans from the end for the latest meaningful agent step — last tool call as "<tool> <target>", else last assistant prose, else "thinking…"; skips tool_results + user prose. New cheap endpoint GET /api/tasks/:id/activity -> {lastAction, lastAt, elapsedMs} (elapsedMs from started_at), read-only, 404 only if task gone. Frontend (public/app.js + style.css): running cards (board) + rows (list) show a .pulse line — pulsing dot, latest action (clipped one line), elapsed-since-started. A module-scope poller (2.5s) re-discovers .pulse nodes each tick (surviving wholesale SSE re-renders), fetches /activity, caches last action so re-renders repaint without flashing; elapsed ticks locally. Honors prefers-reduced-motion. Docs/tests: SPEC.md updated (endpoint + webapp pulse); did NOT touch CHANGELOG.md/package.json per convention. New test/activity.test.ts covers extraction (name+target, skip results/prose, thinking fallback, all-noise→nulls) and a disk-backed tail read on a >700KB transcript. Verification: bun build clean; full suite green (266 pass / 0 fail across 31 files, incl. new activity test); node --check on app.js OK. (task mild-marsh-72f1)
- Rebased onto latest main and resolved all merge conflicts (SPEC.md, public/app.js, src/config.ts). Main concurrently added a spec-conformance review gate (src/conformance.ts) plus tags/templates/search/backups/disk features; my branch retires the CTO auto-answer mechanism and deletes src/cto.ts. Reconciled cleanly: kept main's conformanceCmd/conformanceTimeoutMs/conformanceMaxDiffBytes config and the conformance gate (it's self-contained — only referenced cto.ts in a comment, never imported it), dropped the retired ctoCmd/ctoSessionId/askTimeoutMs config, and updated the now-dangling cto.ts comment references in conformance.ts and config.ts. Folded my awaiting_input additions into main's expanded health snapshot (concurrency/needsAttention), CLI table (show row), task-detail webapp description (alongside the sub-task rollup), and kept awaiting_input in FILTER_STATUSES while taking main's server-side full-text search. Verified no status-enumeration gaps in main's new modules (reaper TERMINAL, selftest TRANSIENT, search are all correct for awaiting_input). bun build + full suite (269 tests) green; no conflict markers remain. (task modest-moose-e991)
- Rebased onto the latest main again to clear a fresh conflict (no functional change to the priority feature). The only conflict this round was bin/butchr's VALUE_FLAGS line: main's modest-granite-2bce task added the `--set` flag (per-directory gate command) while my branch added `--priority`. Resolved by keeping BOTH — VALUE_FLAGS now contains `--tag, --priority, --template, --timeout, --search, --set`. Everything else (HELP text, BOOLEAN_FLAGS, the command switch) auto-merged cleanly; the `priority` command + cmdPriority are intact. Verified: no conflict markers anywhere; `git merge-base --is-ancestor main HEAD` is true (clean linear rebase — the gate's re-rebase is a no-op); diff vs main is exactly my 9 priority files (SPEC.md, bin/butchr, public/app.js, public/style.css, src/db.ts, src/dispatcher.ts, src/server.ts, src/tasks.ts, test/priority.test.ts) with no CHANGELOG.md/package.json edits (per the auto-changelog convention); `bun build` green; full `bun test` 276 pass / 0 fail. Feature recap (unchanged): per-task dispatch `priority` (INTEGER, default 0, higher = sooner) — additive column; dispatcher selects queued tasks ordered by `priority DESC, created_at ASC`; settable at creation (API/CLI `--priority`/webapp modal) and updatable via POST /api/tasks/:id/priority + CLI `priority <id> N`; shown as a `prio N` chip and a task-detail row; test covers higher-priority-selected-before-older-lower-priority. (task scarlet-zircon-9ae8)
- Resolved the merge conflict with main by rebasing onto the current tip (main had since added templates, full-text task search, and backups/disk/selftest). Reconciled the three conflicting files to keep BOTH sides: bin/butchr (merged VALUE_FLAGS + the --merge/--clear BOOLEAN_FLAGS set, kept the --var branch alongside my dashboard/gate commands), public/app.js (renderDirectory now fetches /dashboard for the gate panel AND threads main's searchParam() into the task list fetch), and SPEC.md (kept main's /api/templates, ls --search, and template-picker docs while keeping my /api/dashboard + PATCH /api/directories/:id rows, gate-panel and dashboard webapp bullets). No conflict markers remain. The original feature is intact: multi-project dashboard + per-directory gate_cmd threaded into both the CI and post-merge verify gates. Build green; full suite 270 pass / 0 fail (incl. the 11 new gate-command + dashboard tests). (task modest-granite-2bce)
- Add worktree + backup disk-usage reporting. New src/disk.ts: a bounded, best-effort `dirSizeBytes` lstat walk (skips symlinks, caps entries) + `computeDiskUsage()` that sums per-task worktree sizes (across registered repos) and the DB backup dir, with an advisory over-threshold flag; memoized ~30s since /health is polled frequently. src/git.ts gains `listWorktrees()` (git worktree list, drops the main checkout). src/config.ts adds `diskWarnBytes` (BUTCHR_DISK_WARN_BYTES, default 5 GiB; 0 disables). /health now includes a `disk` object {worktreesBytes, worktreeCount, backupsBytes, totalBytes, warnBytes, warn, truncated}, null on failure — never affects 200/503. Metrics webapp page shows a Disk usage readout (cards + "over threshold" badge) via a new fmtBytes helper + CSS. SPEC.md updated (health, config table, webapp sections); CHANGELOG.md/package.json left untouched per convention. Zero deps. Build green; added test/disk.test.ts for the sizing helper; full suite 243 pass. (task agile-zircon-32db)
- Rebased onto latest main and resolved the merge conflicts (no functional changes to the search feature). Conflicts were in SPEC.md and bin/butchr, both from main's concurrently-merged task-templates / selftest / backups work overlapping my edits: - bin/butchr: combined main's VALUE_FLAGS (`--template`, `--timeout`) + BOOLEAN_FLAGS (`--merge`) with my `--search`. The HELP text and cmdLs `?q=` logic auto-merged cleanly. - SPEC.md: kept my `GET …/tasks ?q=` row alongside main's `POST …/tasks` template/vars row; merged the webapp-view paragraph to carry BOTH my full-text-search filter-bar description AND main's template-picker new-task-modal description. Verified after rebase: my changes in src/db.ts, src/tasks.ts, src/server.ts (`?q=`), public/app.js (searchParam/buildFilterBar), and public/style.css (.task-search) all survived the auto-merge intact. Full suite green (254 tests, 0 fail); app.js parses; `bin/butchr ls --search` runs. No conflict markers remain. CHANGELOG.md / package.json untouched. (task wintry-pelican-9617)
- Resolved the merge conflict by rebasing my branch onto the latest main and integrating both sides (no clobbering). CONFLICT CAUSE: two tasks (spry-hill-0073, crimson-magpie-563b) landed on main after my base, adding the `templates` and `backups`/`restore` (DB-snapshot) features — which textually overlap my `selftest` additions in SPEC.md and bin/butchr. main also added new files (src/backup.ts, src/templates.ts), so a `reset --soft main` would have wrongly dropped them; I used `git rebase main` and merged each hunk by hand. RESOLUTION (kept BOTH feature sets): - bin/butchr — HELP now lists selftest + backups + restore; VALUE_FLAGS carries both `--template` and `--timeout`; parseArgs keeps both the repeatable `--var` and the `--merge` boolean handling; cmdSelftest and cmdBackups/cmdRestore each have their own closing brace; the switch dispatches all of selftest/backups/restore/templates. - SPEC.md — the §6.4 CLI table lists selftest alongside backups/restore; my §5 "Self-test (smoke harness)" section and main's §5 "DB snapshots + restore" section coexist. VERIFICATION: no conflict markers remain; branch now rebased cleanly onto main's tip (merge-base == main, so the gate's re-rebase is a clean no-op); `bun build src/index.ts --target bun --outfile /dev/null` green; full `bun test` 250 pass / 0 fail (my 12 selftest tests + main's new suites); CLI help shows all commands and `selftest` runs (fails cleanly with no server, as expected). No CHANGELOG.md / package.json edits. (task plush-zebra-6caf)
- Added DB SNAPSHOT + RESTORE resilience for the source-of-truth SQLite DB. New src/backup.ts: SQLite-safe snapshots via VACUUM INTO (not raw mid-WAL copy) to ~/.local/share/butchr/backups/butchr-<ts>.db, a periodic loop (default 15min) + one on clean shutdown, retention pruning (keep newest N, default 24), and an offline restore path. Wired startBackupLoop into src/index.ts with an async SIGINT/SIGTERM handler that takes a final shutdown snapshot. /health now reports a `backup` block (lastSnapshotAt, count, keep, intervalMs, dir). Config: BUTCHR_BACKUP_ENABLED/DIR/INTERVAL_MS/KEEP (env-overridable). bin/butchr gains two OFFLINE commands — `butchr backups` (list) and `butchr restore <file|latest> [--force]` (restores BUTCHR_DB, saves current aside to <db>.pre-restore-<ts>, clears stale -wal/-shm, refuses while a server is up unless --force) — implemented via src/backup.ts (import-side-effect-free w.r.t. opening the DB; db.ts loaded lazily only when snapshotting). Zero new deps. Docs updated per CONTRIBUTING: SPEC.md (§5 new subsection, §6.4 CLI, §8 config, §9 layout, health fields), OPERATIONS.md (runbook + CLI + health field), CHANGELOG [Unreleased]. New test/backup.test.ts (14 tests: snapshot consistency/uniqueness, retention pruning, resolve, restore). bun build + full bun test green (201 pass); verified end-to-end snapshot→restore through the actual CLI binary. Left package.json version alone since butchr auto-bumps it at merge. (task crimson-magpie-563b)
- Add named, parameterized TASK TEMPLATES (recipes) so common task shapes are created from a template instead of hand-writing the same prompt skeleton. New dependency-free src/templates.ts holds four built-in recipes (feature, refactor-extract, webapp-panel, add-endpoint), each a name/description/body with {{placeholders}}; helpers listTemplates, renderTemplate (vars substitution; unsupplied markers left visible), extractPlaceholders, and validateVars. Surfaced via GET /api/templates (list) and a template/vars branch on the create route (server-rendered prompt). CLI gains a `templates` command and `new --template <name> --var key=val …` (repeatable --var). Webapp new-task modal gains a template picker that fills the prompt textarea and hints which placeholders to complete, then submits the plain prompt. SPEC.md updated (REST §6.1, CLI §6.4, webapp §6.5). New test/templates.test.ts covers listing, placeholder extraction, substitution, validation, and template→created-task prompt round-trip; full suite (224 tests) + bun build green. (task spry-hill-0073)
- Resolved the merge conflict by rebasing onto the latest main (git rebase main — not a merge commit), so the resolution sticks under the gate's rebase. Conflicts were in package.json and SPEC.md, with CHANGELOG.md auto-merged. Resolution: - main has since changed the living-docs convention: butchr now records the CHANGELOG entry + version bump automatically at merge, and agents no longer hand-edit CHANGELOG.md / package.json (only SPEC.md stays a manual edit). So I DROPPED my hand-edits to both — package.json now keeps main's version (0.9.18), and CHANGELOG.md was restored to main's content (my hand-added entry removed; butchr will add the entry from this summary at merge). - SPEC.md §6.5: merged both sides — kept main's Directory-view additions (tag filter chips, tags in new-task modal, sub-tree merge-progress bar) and the Task-detail conformance badge + tags-row text, and integrated my richer diff description (dependency-free syntax highlighting + line-number gutter + inline per-line comments composed into the reject note) into the diff phrase. - public/app.js + public/style.css auto-merged cleanly with main's newer conformance/tags/rollup work; my feature code is intact (highlightCode/highlightJs/highlightCss, parseDiff line numbers, inline-comment state + composeReviewNote, wireDiff, the --tok-* vars and .dl-comment styles), and the review panel correctly stacks ciBadge → conformanceBadge → diff → inline-comment summary → controls. The diff vs main is now exactly 3 files (SPEC.md, public/app.js, public/style.css), no conflict markers anywhere. bun build clean; bun test green — 218 pass / 0 fail (includes main's newer conformance/tags/rollup tests); public/app.js parses clean. The feature itself is unchanged from the prior submission — this is purely the conflict resolution + dropping the now-obsolete CHANGELOG/version hand-edits. (task playful-moor-45a0)
- Resolved the merge conflict by rebasing onto the current main (e4b53e6). The only conflict was in SPEC.md §6.5 (Webapp): main had added a "tags" feature to the Directory-view and Task-detail bullets while my branch added the spec-conformance badge. I merged both — kept main's tags additions (tag filter chips, tags in the new-task modal, sub-tree merge-progress bar, tags row in the meta grid) and integrated my conformance-badge description into the Task-detail bullet. All other files auto-merged cleanly; every conformance change (src/conformance.ts, db/config/tasks hooks, app.js + style.css badge, SPEC §4/§7/§8 sections, the test) is intact. `bun build` green; `bun test` green — 218 pass / 0 fail (includes the 12 conformance-gate tests). No functional changes from the previous submission; this is purely the conflict resolution. (task merry-snow-6e87)
- Resolved the SPEC.md merge conflict by rebasing onto the latest main (git rebase main, not a merge commit). The only conflict was in SPEC.md §6.5 (Webapp): main had added a graph "sub-tree merge-progress bar" note and a task-detail "sub-task progress rollup"; my branch added the tag-chip filter row, the new-task-modal tags field, and the tags meta-grid row. I merged both — the Directory-view bullet now describes the tag filter + tags modal/chips AND keeps main's graph progress-bar sentence; the Task-detail bullet keeps my "tags row in the meta grid" addition on top of main's text. All other files auto-merged cleanly. No conflict markers remain anywhere. Rebased tree verified: `bun build` clean + full `bun test` green (206 pass — includes main's newer tests plus my test/tags.test.ts). The tags feature itself is unchanged from the prior submission. (task balmy-gale-499b)
- Add a sub-task / dependency PROGRESS ROLLUP to the webapp, surfacing how far an auto-decomposed plan's child graph has landed. What's new (purely client-side — no new API field): - Task detail: a "Sub-task progress" panel for any task that GATES dependents (its id appears in others' blocked_by). Shows "N/M merged" over the transitive sub-tree, a progress bar, an optional "X direct · +Y nested" line, and the direct children with their live status chips. Renders nothing for a task with no dependents. - Dependency graph: nodes that gate dependents now carry an inline merge-progress bar (merged fraction of their transitive sub-tree) plus an "N/M merged" annotation in the tooltip/aria-label; text lines nudge up to make room. How it works: new reverseDeps()/gatedSubtree() helpers reverse the blocked_by edges of the already-fetched directory task list and BFS the transitive dependents (cycle-guarded). The task page fetches the directory's task list (best-effort) and computes the rollup with dependentRollup(); everything live-updates for free via the existing SSE re-render. Files: public/app.js (helpers + rollup panel + graph annotation + renderTask wiring), public/style.css (.rollup-* panel styles + .tg-prog-* node bar), SPEC.md §6.5 (webapp view notes). Zero deps. `bun build … --outfile /dev/null` clean; `bun test` 187 pass / 0 fail. (task fleet-egret-4f3e)
- **butchr now records the CHANGELOG entry + version bump at merge — agents no
  longer hand-edit `CHANGELOG.md` / `package.json`.** Under the old living-docs
  convention every task appended its own `[Unreleased]` bullet and bumped the
  version, so under concurrency every task touched those same two files and they
  **all** collided at merge (each needing an auto-resolve pass). The bookkeeping
  now happens once, in `git.merge` (`finalizeLivingDocs`), **inside the serialized
  merge lock and after the rebase** — so the edits land on the up-to-date base and
  two merges can't race the same lines. butchr appends an `[Unreleased]` → `###
  Changed` entry derived from the task's **`request_review` summary** + id (stamped
  with a `(task <id>)` idempotency marker so a re-merge never double-adds) and
  **patch-bumps** `package.json`, skipping the bump for a **docs-only** diff. The
  pure transforms live in the new dependency-free `src/changelog.ts` (unit-tested).
  **SPEC.md stays a manual living-doc edit** (it is not append-only and rarely
  collides). Contributors now just **write a clear task summary**; see
  [CONTRIBUTING §6](./CONTRIBUTING.md#6-living-docs-update-on-every-change) and
  [SPEC.md §4](./SPEC.md#4-review--merge).

### Added
- **DB snapshots + restore (resilience).** The SQLite database is butchr's source of
  truth for all task state and history, so it now takes **SQLite-safe snapshots** of
  it for crash/power-loss recovery. A background loop snapshots the DB every
  `BUTCHR_BACKUP_INTERVAL_MS` (default 15 min) **and on every clean shutdown**, using
  `VACUUM INTO` (a consistent online backup — never a torn mid-WAL file copy) to write
  `backups/butchr-<timestamp>.db` under `BUTCHR_BACKUP_DIR` (default `<data>/backups/`).
  The newest `BUTCHR_BACKUP_KEEP` (default 24) are retained and older ones pruned; the
  whole feature is toggled by `BUTCHR_BACKUP_ENABLED` (default on). Recover with two new
  **offline** CLI commands — `butchr backups` (list snapshots) and
  `butchr restore <file|latest>` (restore the DB, saving the current one aside to
  `<db>.pre-restore-<ts>` first; refuses while a server is running unless `--force`).
  `/health` now reports a `backup` block (`lastSnapshotAt`, retained `count`, `keep`,
  `intervalMs`, `dir`). Zero new dependencies. See
  [SPEC.md §5](./SPEC.md#db-snapshots--restore-srcbackupts) and the
  [OPERATIONS runbook](./OPERATIONS.md#db-snapshots--restore).
- **Rough task-duration estimates (ETA).** butchr now forecasts how long a task is
  likely to take, built from its **own tracked history** — a small, dependency-free
  heuristic (no ML). Every estimate is a **loose p50–p90 range with its sample size**
  (e.g. *"est ~12–30m, n=8"*), explicitly hedged and **never a hard promise**; when
  history is too thin it says **"insufficient data"** rather than guess. Completed
  tasks are bucketed by a cheap signal captured on the review transition — a **size**
  bucket from the final diff line-count (small/medium/large) and a path-based **type**
  (docs/webapp/core/mixed) — and per-bucket **P50/P90** of the started→review and
  started→merge durations drive the forecast (a queued task with only a prompt falls
  back to the overall median). For a dependency **chain**, butchr estimates the
  **critical path** (longest `blocked_by` path, `max()` across parallel branches) so a
  plan shows an approximate total. Surfaced on the **task-detail** page (an *est.
  duration* row plus a critical-path line on the blocked-by / spawned-sub-tasks
  panels), on **`TaskView.estimate`**, and via a new **`GET /api/tasks/:id/estimate`**
  endpoint (`{ single, chain }`). Two new nullable task columns (`diff_lines`,
  `path_type`) record the captured footprint. See [SPEC.md §10](./SPEC.md#10-duration-estimates-rough).
- **`BUTCHR_ALLOWED_ORIGINS`** — comma-separated list of extra browser origins
  permitted to make state-changing `/api` requests, on top of the derived loopback
  origins, for the CSRF / DNS-rebinding guard above.
- **`docs/CLEANUP.md`** — a prioritized code-quality / DRY audit of the merged
  tree: each finding names the smell (with `file:function`), why it matters, and a
  specific refactor scoped as an independent follow-up task, ranked by value/effort
  and flagged for same-file sequencing. Report only — no code changes.

### Changed
- **Internal: filled JSDoc gaps on a handful of exports.** `nowIso` / `metricRows`
  (`src/db.ts`), `startDispatcher` / `stopDispatcher` (`src/dispatcher.ts`),
  `startServer` (`src/server.ts`), and `getDirectory` / `getDirectoryByPath`
  (`src/directories.ts`) each gained the one-line `/** … */` the rest of the file
  uses, and `parseBlockedBy` (`src/tasks.ts`) now notes it's also reused to parse the
  identically-shaped `spawned_subtasks` column. Comment-only — no behavior change
  (CLEANUP C11).
- **The directory task-list endpoint now returns the parsed `taskView` shape.**
  `GET /api/directories/:id/tasks` previously returned raw DB rows, where
  `blocked_by` / `spawned_subtasks` were JSON-**string** columns and the
  server-computed blocker status (`blockerStates` / `deadBlockers`) was missing —
  so it disagreed with the single-task detail route, which returns the parsed
  shape, and the webapp had to defensively parse *either* form. The list now
  returns a `TaskListView` per task: the same enriched shape as the detail route,
  minus the `task.md`-derived `prompt` / `context` / `review_notes` and the
  duration `estimate` (the list / board / graph views don't need those, so it
  skips reading every `task.md` from disk). `blocked_by` / `spawned_subtasks` come
  back as real id arrays and each blocker's status is precomputed. The webapp's
  dual-shape parsing helper is gone. Pure refactor — every other row field is
  unchanged and the views render exactly as before (CLEANUP C8). See
  [SPEC.md §6.1](./SPEC.md#61-rest-api).
- **Internal: collapsible webapp panels now share one `collapsible()` helper**
  (`public/app.js`). The caret (▾ open / ▸ closed) + clickable head + toggle-body
  pattern was copied across the Finished section, the CI-output detail, the agent
  transcript, and the live-output panel — each re-wiring its own caret-glyph flip,
  open/closed class toggle, and localStorage persistence. That mechanic now lives
  once in `collapsible({ title, meta, body, open, persistKey, onToggle, … })`; each
  panel keeps its own body-fill / lazy-load / poll logic and just plugs in. No
  behavior change — the same panels open, close, persist, and lazy-load exactly as
  before (the diff-file cards keep their CSS-rotated caret and are intentionally
  left out). (CLEANUP C6).
- **The CI gate and the post-merge verify gate now share one build+test gate
  runner** (`src/gate.ts` `runGate`). The two gates had each re-implemented "spawn a
  build/test command in a cwd, bound it, collect combined output" and **drifted**: the
  in-worktree CI gate had flaky-retries but **no timeout** (an unbounded spawn), while
  the post-merge verify gate had a timeout but no retry. Both now spawn through the
  shared `runGate`, so the **CI gate inherits the same `BUTCHR_VERIFY_TIMEOUT_MS`
  kill-timer** verify already had — a hung `bun build`/`bun test` in the review gate is
  now bounded (a timed-out command counts as a FAIL) instead of leaking a process. The
  genuinely-different layers stay where they belong: CI keeps its build-vs-test badge
  parsing + flaky retry, verify keeps its skip-on-empty + revert-on-RED decision. Pure
  refactor otherwise — the pass/fail gate decision, retry policy, and revert behavior
  are unchanged (CLEANUP C3). See [SPEC.md §4](./SPEC.md#4-review--merge) /
  [§8](./SPEC.md#8-configuration).
- **Internal: task status transitions now flow through one `setStatus()` helper**
  (`src/tasks.ts`). The four-step transition skeleton — guarded `UPDATE` →
  `recordTaskEvent` (audit) → `updateTaskMdStatus` (mirror to task.md) → `emitUpdated`
  (SSE) — was hand-copied at ~a dozen sites, so a new transition that forgot a step
  could silently drop an audit entry, desync task.md, or leave the webapp stale. That
  spine now lives once in `setStatus(id, to, { from, note, set })`, and the core
  lifecycle transitions (queued→running, →review, →blocked, →aborted, →merged, the
  legacy finalize, auto-unblock, and re-queue) call it. No behavior change — the audit
  timeline, task.md mirror, and SSE events are identical (CLEANUP C1).
- **`exec.run()` gained an optional `timeoutMs` bound** (internal). The shared
  "shell out, never throw" helper can now kill a subprocess that exceeds a
  wall-clock deadline, resolving with a non-zero code, a `timedOut` flag, and a
  marker in `stderr`. The bound is opt-in and off by default, so existing callers
  are unaffected — this is groundwork that lets the CI gate share the same bounded
  runner the post-merge verify gate already uses (no user-facing behavior change).
- **Internal: collapsed herdr JSON-envelope parsing into one `herdrSoft()`
  helper** (`src/herdr.ts`). The six soft-failing herdr probes (`agentTabId`,
  `agentPaneId`, `agentTerminalId`, `paneTerminalId`, `paneList`, `agentRead`)
  each re-implemented the same run → check-ok → trim → `JSON.parse` →
  check-`error` → unwrap `result` block; that block now lives once in
  `herdrSoft()`, which returns `null` on any failure so each caller keeps just
  its own field-probe and default. No behavior change — purely removes the
  duplication so a future change to herdr's envelope shape lands in one place.
- **Config reads every `BUTCHR_*` var through the typed `env()` helpers.** The two
  remaining vars that read `process.env` directly (`BUTCHR_CTO_CONTEXT`,
  `BUTCHR_TERMINAL_CMD`) now go through `env(name, "")` like the rest of
  `config.ts`. Pure-internal refactor — behavior is identical (an empty/unset var
  still falls back to `""`).
- **Auto-rebase and auto-merge now share one conflict-collection helper.** The
  identical tail that both paths ran after a failed `git rebase` — gather the
  conflicting files (via `--diff-filter=U`, falling back to scraping git's text),
  abort the rebase, and decide whether the failure was a conflict — lived in two
  copies that had to be kept in sync by hand. It's now a single internal helper, so
  the conflict note handed back to the agent can't drift between the two paths.
  Pure-internal refactor; no behavior change.
- **Internal: per-task MCP tools now dispatch through a small registry.** The MCP
  server's `tools/call` if-ladder and per-tool extract-validate-wrap boilerplate
  (`src/mcp.ts`) were replaced with a single table of `{ def, plan?, run }` entries
  driving both a shared dispatcher and `tools/list` filtering. No behavior change —
  the same `request_review` / `propose_subtasks` / `ask` tools are exposed to the
  same tasks; this just makes adding a tool a one-line registry entry (CLEANUP C10).
- **Internal: the webapp's repeated UI scaffolds are now three shared helpers**
  (`public/app.js`). The directory picker and the new-task modal each hand-rolled
  the identical backdrop + Escape/backdrop-click-to-close boilerplate — that now
  lives once in `openModal()`. The five task-detail action buttons (re-queue,
  abort, roll back, approve, request-change) each repeated the same
  disable-button → call API → toast → restore-on-error dance, now owned by
  `action()`. And the per-view task badge cluster (status + conflict/plan/
  rolled-back chips) is built by one `taskChips()` so a chip's markup can't drift
  between the list, table, board, and detail views. Pure-internal refactor — each
  view renders exactly the same badges and each button behaves exactly as before
  (CLEANUP C5).

### Fixed
- **Merge-conflict kick-backs no longer thrash review → conflict → review.** When an
  approve (or a pre-dispatch rebase) hit a merge conflict, the note butchr sent the
  agent suggested resolving with `git merge <base>`. But butchr's merge gate
  **rebases** the branch onto the default tip, which discards that merge commit and
  replays the original conflicting commit — so the task re-conflicted on the next
  merge and bounced back to review repeatedly. The conflict note now instructs the
  agent to integrate by **`git rebase <base>`** (resolve + `--continue`) or
  **`git reset --soft <base>`** then re-commit, and explicitly warns against
  `git merge`, so the resolution survives the rebasing gate.

### Security
- **CSRF / DNS-rebinding guard on the web API.** butchr binds to loopback, but a
  web page the operator merely visits could make their browser send forged
  cross-site requests to `http://127.0.0.1:<port>/api/...` (cross-site `POST` or a
  DNS-rebinding name) and create / approve / abort tasks. A small central guard
  now rejects state-changing (`POST`/`PUT`/`DELETE`/`PATCH`) `/api` requests whose
  `Origin` header is present but does not match butchr's own origins (or whose
  `Host` is not a loopback / configured name) with a clear `403`. The same-origin
  webapp, `GET` reads, and the SSE stream are unaffected; non-browser callers (the
  operator CLI, the per-task MCP server, `curl`) send no `Origin` and pass through
  untouched. This is localhost CSRF/rebinding hardening, **not** authentication —
  there are still no tokens, logins, or users (a separate future concern).

## [0.9.2] - 2026-06-10

### Added
- **Dispatcher pause / maintenance mode (drain-only).** A global switch stops
  **new** agent dispatch so the operator can hold for a restart / recovery /
  maintenance window without disturbing work in flight: `running`, `review`, and
  `idle` tasks (and their watchers) continue untouched, while `queued` tasks simply
  wait. The auto-unblock and auto-merge passes keep running while paused — a
  freshly-unblocked task is promoted to `queued` but just isn't dispatched until you
  resume. Toggle it with **`POST /api/pause`** / **`POST /api/resume`**; `GET /health`
  now reports a **`paused`** boolean. The webapp gains a topbar **pause/resume
  control** and a clear **PAUSED banner**. The state is **persisted** (a new
  `settings` key/value table, key `dispatch_paused`), so a pause survives a restart
  and stays in effect until explicitly resumed.

## [0.9.1] - 2026-06-10

### Added
- **Agent transcript viewer.** The task-detail page gains a collapsible **Agent
  transcript** panel that shows what the task's agent actually did — its prose,
  extended thinking, tool calls (name + a brief one-line arg summary), and
  (truncated) tool results — without attaching to herdr. It's read-only and
  monospace, fetched lazily on first open and paged via a "Load more" button.
- **`GET /api/tasks/:id/transcript`** endpoint backing it: parses the Claude Code
  session JSONL (located the same way per-task token usage is) into an ordered,
  role-labelled list of turns, skipping internal frames and truncating large
  bodies. Best-effort — returns `turns: []` when the task has no session or the
  transcript can't be read — and paginated via `?offset=&limit=` (`limit` clamped
  1..500, default 200) with `total`/`hasMore`.

## [0.9.0] - 2026-06-10

This release establishes **change tracking** for butchr and catches the declared
version up to reality. The `version` in `package.json` had sat at the bootstrap
`0.1.0`/`0.2.0` while dozens of features shipped (task dependencies, a CI gate,
post-merge verify + auto-revert, one-click rollback, an operator CLI, a systemd
supervisor, auto-merge, plan/auto-decompose tasks, metrics, an audit timeline, a
dependency-graph view, and more — all reconstructed in the entries below). The
jump to **0.9.0** reflects that accumulated, near-1.0 surface area; the project
stays pre-1.0 because the HTTP/CLI/config interfaces are still allowed to change.

### Added
- **CHANGELOG.md** (this file) — a Keep a Changelog history reconstructed from the
  code and git log, plus an `[Unreleased]` section for ongoing work.
- **Living-docs convention** in [CONTRIBUTING.md](./CONTRIBUTING.md): every change
  must update SPEC.md, add an `[Unreleased]` CHANGELOG entry, and bump the version
  per semver on release. Documented as a first-class step of the contribution
  workflow.

### Changed
- `package.json` `version` bumped to `0.9.0` to reflect the accumulated feature
  set. `/health` already reports this value (it reads `package.json` at import),
  so the version surfaced by the API tracks the bump automatically — no hardcoded
  string to keep in sync.

## [0.8.0] - 2026-06-10

Observability and richer planning.

### Added
- **Plan / auto-decompose tasks.** A PLAN task runs an agent that calls the
  per-task MCP `propose_subtasks` tool to break a request into ordered sub-tasks;
  butchr creates them (wired with `blocked_by` dependencies) and marks the plan
  `decomposed`. `taskView` surfaces `spawned_subtasks`.
- **Metrics view.** `GET /api/metrics` exposes read-only aggregates and the webapp
  renders a Metrics page (cards over task/throughput counts).
- **Audit timeline.** Every status transition is recorded in a `task_events` table
  (`recordTaskEvent`); `GET /api/tasks/:id/events` returns the oldest→newest
  timeline and the task-detail view renders it.
- **Per-task model selection + token-usage accounting.** Task creation accepts an
  optional `model` (alias `opus`/`sonnet`/`haiku`/`fable` or a full id) threaded
  into the agent launch. `src/usage.ts` parses the agent transcript to surface
  cumulative token usage and the model the run used. (Dollar cost is deliberately
  **not** fabricated — the transcript carries no `costUSD` field.)
- **Dependency-graph view.** The webapp renders an SVG DAG of active tasks with
  blocker edges and topological levels, alongside the list and board views.

## [0.7.0] - 2026-06-10

Operations, deploy, and supervision.

### Added
- **OPERATIONS.md** runbook — running, restarting (resolve PID by port, never
  `pkill -f`), recovering, and self-heal for a live instance.
- **systemd units + supervisor.** `deploy/butchr.service`, `deploy/herdr.service`,
  and a health service/timer (`butchr-health.{service,timer}`), plus
  `scripts/supervise.sh`, `scripts/health-watchdog.sh`, and
  `scripts/install-service.sh`. butchr exits non-zero on uncaught errors so a
  supervisor relaunches a fresh process; state is re-adopted on boot.
- **Operator CLI** (`bin/butchr`) — each subcommand maps onto exactly one REST
  route and adds no server logic, so a running instance is drivable from the shell.

## [0.6.0] - 2026-06-10

Task dependencies.

### Added
- **`blocked_by` dependencies.** A task can declare blockers; `taskView` computes
  `blocked_by`, `blockerStates`, and `deadBlockers`. Blocked tasks don't dispatch.
- **Auto-unblock + auto-rebase-on-unblock.** When the last blocker merges, the
  dependent unblocks and is rebased onto the live default tip before dispatch, so
  it starts from current code.
- **Cycle guard.** Dependency edges that would form a cycle are rejected at the
  API so the graph stays a DAG.
- **Kill-on-block.** Editing a running task to depend on an unmet blocker stops its
  in-flight agent and returns it to a blocked state.

## [0.5.0] - 2026-06-10

Review, merge, and verification hardening.

### Added
- **CI gate.** On submission, build + test (`bun build … && bun test`) run in the
  task's worktree and write an advisory pass/fail badge (injectable in tests via
  `setCiRunner`). Advisory — a red badge signals "fix before merge" but does not
  hard-block.
- **Post-merge verify gate + auto-revert.** After an approved merge fast-forwards
  onto the default branch, `BUTCHR_VERIFY_CMD` runs on the new tip; a **RED**
  result **auto-reverts the merge off main** and moves the task to `failed` with
  the failing output (worktree kept for a fixup). Injectable via `setVerifyRunner`.
- **One-click rollback.** An endpoint reverts a merged task's commit off the
  default branch, serialized through the same global merge queue as approve, with
  a 409 + clean tree on a revert conflict.

### Changed
- **Merges are serialized through a global queue** and each is rebased onto the
  live tip first, so a verify+revert can never interleave with another merge and
  content conflicts are deterministic. A conflict is kicked back to the agent as a
  resolution note rather than dumped on the reviewer.

## [0.4.0] - 2026-06-10

Dispatch resilience and operability.

### Added
- **Dispatch retry + backoff + `failed` state.** A failed agent launch increments
  an attempt count and schedules a backoff in `next_dispatch_at`
  (`BUTCHR_DISPATCH_BACKOFF_CAP_MS`); at the cap the task gives up to `failed`
  instead of retrying forever.
- **`POST /api/tasks/:id/requeue`** + **failed-task UI** — clears retry/backoff
  state to re-dispatch a `failed` (or otherwise stuck) task, surfaced in the
  webapp.
- **Runaway / stuck-agent watchdog** (`BUTCHR_MAX_RUN_MS`) — a task that sits in
  `running` past the max wall-clock without reaching review is flagged for
  attention (and its agent killed), keeping a human in control. `0` disables it.
- **`/health` operational fields** — tick-loop liveness, the startup reaper's
  last-reap snapshot, an active/queued **concurrency** snapshot, a `failedTasks`
  count, and a **needsAttention** pull-signal (review + failed counts) that the
  webapp turns into a tab-title badge.

### Changed
- **Concurrency cap removed.** A per-run simultaneous-task cap was briefly
  introduced and then **removed**: dispatch is now fully **uncapped** — every
  queued task launches as soon as the tick sees it. The `concurrency` block in
  `/health` remains as an active/queued activity snapshot (no longer a limit).

## [0.3.0] - 2026-06-10

Webapp and per-task isolation.

### Added
- **One herdr tab per task.** Each agent gets its own dedicated herdr tab/pane
  (the herdr agent name is the task id), replacing shared-tab usage.
- **Webapp upgrades** — search + status filter bar (filter state survives
  re-renders and keeps input focus), collapsible completed history
  (merged/aborted/rejected), inline **herdr pane/tab id** readouts next to live
  tasks, and a **New task** modal/form.
- **"Open terminal" for running tasks** + **workspace self-heal** (re-create a
  missing workspace on demand).

### Fixed
- **Pane-id race on tab close.** Closing a herdr tab renumbered the remaining
  panes, so a stale cached pane id could target the wrong agent; pane lookups now
  resolve against the live herdr state instead of a captured index (verified live).

## [0.2.0] - 2026-06-10

Boot-time self-healing.

### Added
- **Reaper.** On startup butchr reaps orphaned git worktrees and leftover herdr
  "husks" (deregistered/dead agents), and records a last-reap snapshot surfaced in
  `/health`.
- **Reconcile + finalize on boot.** Live agents are re-adopted, dead ones rescued,
  and any legacy `finalizing` tasks flushed, so a restart never orphans state.

### Changed
- Task worktrees are excluded from the registered repo locally via
  `.git/info/exclude` so the `<repo>/<task-id>/` dirs never show up as untracked.

## [0.1.0] - 2026-06-10

Initial butchr — the agent task harness on top of herdr.

### Added
- **Core harness.** A single Bun process (HTTP server + dispatcher tick loop +
  per-task MCP server) that owns the task lifecycle — creation → dispatch → agent
  run → review → merge — over git repositories, where **directories are
  workspaces and tasks are git worktrees**.
- **State model.** SQLite (`bun:sqlite`, WAL) for runtime state; an on-disk
  `task.md` under each repo's `.butchr/tasks/<id>/` as the re-syncable source of
  truth for a task's prompt + metadata. One git worktree per task at
  `<repo>/<task-id>/` on a `<task-id>` branch.
- **Interfaces.** REST API (`/api/*`), an SSE stream (`/api/events`) over an
  in-process pub/sub, and a hand-rolled dependency-free per-task MCP server
  (`/mcp/:taskId`) exposing `request_review` and `ask`.
- **Dispatcher.** A tick loop that launches an agent per queued task via herdr,
  plus a watcher that rescues agents that end without submitting.
- **CTO `ask`.** The MCP `ask` tool forks a read-only Claude to answer an agent's
  clarifying question.
- **Webapp.** A vanilla-JS, hash-routed, SSE-driven single-page app served from
  `public/` (no framework, no build step), with a server-side directory picker for
  registering repositories.
- **Zero-dependency rule.** Everything is built on the Bun standard library plus
  the external `git` and `herdr` binaries — no npm/runtime dependencies.

[Unreleased]: https://github.com/
[0.9.2]: https://github.com/
[0.9.1]: https://github.com/
[0.9.0]: https://github.com/
[0.8.0]: https://github.com/
[0.7.0]: https://github.com/
[0.6.0]: https://github.com/
[0.5.0]: https://github.com/
[0.4.0]: https://github.com/
[0.3.0]: https://github.com/
[0.2.0]: https://github.com/
[0.1.0]: https://github.com/
