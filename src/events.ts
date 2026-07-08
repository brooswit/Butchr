// In-process pub/sub for Server-Sent Events. The HTTP layer subscribes each SSE
// client; services publish whenever task/workspace state changes.
export type ButchrEvent =
  | { type: "task.created"; task: unknown }
  | { type: "task.updated"; task: unknown }
  | { type: "task.deleted"; id: string }
  | { type: "workspace.created"; workspace: unknown }
  // A workspace row changed in place (e.g. its per-workspace gate command was
  // updated) — carries the refreshed WorkspaceView so the dashboard reflects it live.
  | { type: "workspace.updated"; workspace: unknown }
  | { type: "workspace.deleted"; id: string }
  // Dispatcher pause/resume toggled — lets every connected webapp reflect the
  // PAUSED banner + control live (see server POST /api/pause|resume).
  | { type: "dispatch.paused"; paused: boolean }
  // The managed CTO agent's lifecycle state changed (started/stopped/restarted/
  // adopted/relaunched) — carries the refreshed CtoStatus so the dashboard's CTO
  // card reflects it live. See src/workspace-agent.ts.
  | { type: "cto.updated"; cto: unknown }
  // NETWORK CONNECTIVITY to the model API was RESTORED after an outage (a debounced
  // DOWN→UP transition — see src/connectivity.ts). EVENT-ONLY: butchr takes no action;
  // this fans out the SSE stream so the CTO channel + worker connectivity channels push
  // it to live sessions. `restoredAt` = ISO time of recovery; `downMs` = outage length.
  | { type: "connectivity.restored"; restoredAt: string; downMs: number }
  // A STORY-LEVEL attention event (STORIES epic — the story→main merge model, CONTRIBUTING
  // §11, plus the responder-redesign ask seam, §4b) — a story-scoped notification that is NOT
  // tied to a single task's status. `target` decides which channel feed owns it, split by who
  // can actually act on the reason:
  //   - `story` → the story LEADER's feed:
  //       · `completion-review` — all subtasks merged; verify the story's goal.
  //       · `gate-red`          — the story-level re-gate (or post-merge verify) came back RED
  //                               before/after story→main; the assembled story fails its tests,
  //                               so the LEADER fixes it with more subtasks (§11.5). The story
  //                               sits in `merge_blocked`.
  //       · `ask-answered`      — the leader's open story-level ask was answered.
  //   - `cto` → the WORKSPACE/CTO feed:
  //       · `complete`       — the leader marked the story done (it landed on main).
  //       · `merge-conflict` — the story↔main rebase conflicted; this is a CTO/human GIT action
  //                            in the story worktree (the leader is an operator with no worktree
  //                            and cannot resolve it — §11.4), so it goes to the CTO directly,
  //                            NOT the leader. `detail` carries the resolution runbook.
  //       · `ask`            — a leader raised a story-level ask to the CTO.
  //       · `leader-idle`    — the story LEADER agent has gone GENUINELY IDLE while still sitting
  //                            on ≥1 item awaiting ITS action (story st-a32c8138): the operator
  //                            generalization of the build-agent idle→responder signal, bubbled to
  //                            its higher-up (the CTO). Fired ONCE on the idle+has-actionable
  //                            transition from superviseWorkspace; `detail` = the count + a short
  //                            list of what it is sitting on. SILENT when idle with zero actionable.
  //   - `user` is the CTO ESCALATING an open ask up to the user (reason `ask`). NO channel
  //     bridge owns `target:user` — consumeStoryAttention DROPS it (the CTO + leader feeds stay
  //     silent); the dashboard's SSE consumer is what surfaces a user-owned ask.
  // `detail` is a short human hook (the story brief, the gate output / conflict runbook, or the
  // ask question/answer text). See src/channel.ts (AttentionBridge).
  //
  // `marker` is an OPTIONAL, backward-safe DE-DUP marker (channel.ts reconnect-resync — the
  // st-ad96e5c3 follow-up to st-fffc76a8): a state-derived token that lets the bridge deliver a
  // story.attention EXACTLY ONCE across a reconnect/restart gap. It MUST be computable identically
  // from this live event AND from the REST work view (so resyncAttention can re-derive it), so it
  // is built from durable, REST-exposed state (a member merged/dead count, or the pending_ask text),
  // NOT from the volatile `detail` (which is gone after the fact). It MONOTONICALLY changes on a
  // legitimate RE-FIRE (e.g. completion-review's merged-count rises as each fix-subtask lands) so a
  // genuine re-fire still emits. `null`/absent for reasons that are never resynced (ask-answered /
  // complete / merge-conflict) → the bridge does NOT de-dup them (emits as before). Existing
  // consumers (the dashboard's SSE reader) ignore the field, so this is purely additive.
  | {
      type: "story.attention";
      story_id: string;
      workspace_id: string;
      target: "story" | "cto" | "user";
      reason:
        | "completion-review"
        | "complete"
        | "gate-red"
        | "merge-conflict"
        | "ask"
        | "ask-answered"
        | "member-blocked"
        | "leader-idle";
      detail: string | null;
      marker?: string | null;
    }
  // A CROSS-REPO PROJECT INITIATIVE completed (REVAMP-4 Phase 3 / P3e): EVERY per-repo child
  // story of the initiative has landed `done`. Published up the PROJECT channel one rung above
  // story completion (the CEO sees the rolled-up doneness authoritatively via
  // GET /api/projects/:id/initiatives; this event surfaces it live to the project SSE stream).
  // Additive + EVENT-ONLY — butchr takes no action; the CEO poll is the source of truth.
  | {
      type: "initiative.completed";
      project_id: string;
      initiative_id: string;
      detail: string | null;
    }
  // The CEO ACCEPTED a completed initiative's cross-repo review (RFC Q5 — Phase C1; story
  // st-30a7dccd): the CEO signed off on what landed across the member repos and is REPORTING
  // completion up to the human. Additive + EVENT-ONLY — the human/dashboard SSE surfaces it; butchr
  // takes no action. The CEO's other review verb (a CORRECTIVE follow-up) reuses the initiative
  // path (createDirective); the CEO issues NO reject/rollback (per-diff merge stays CTO authority).
  | {
      type: "initiative.reviewed";
      project_id: string;
      initiative_id: string;
      detail: string | null;
    }
  // An operator AMENDED an in-flight instruction after the fact (the `update` verb —
  // POST /api/work/:id/update; story st-7a7b0654). A one-shot LIVE re-surface signal: a
  // PARKED-in-feedback work item (in_review/needs_info/idea/spec_review) whose brief just
  // changed will NOT re-notify off a same-status `task.updated` (the AttentionBridge only
  // emits on an ENTERED surface or a responder change), so this dedicated event forces the
  // re-surface. It carries the refreshed TaskView (routed to the current owner via the SAME
  // routeOwns + pending_responder the bridge already uses — a subtask's owner is its story
  // leader) and `detail` = the new brief. DELIBERATELY EVENT-ONLY + never reconnect-resynced
  // (see channel.ts): replaying an amendment on reconnect would be a spurious re-notify.
  | { type: "task.instruction_updated"; task: unknown; detail: string | null }
  | { type: "hello"; now: string };

type Subscriber = (e: ButchrEvent) => void;

const subscribers = new Set<Subscriber>();

export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function publish(e: ButchrEvent): void {
  for (const fn of subscribers) {
    try {
      fn(e);
    } catch {
      // a dead subscriber shouldn't break publishing
    }
  }
}
