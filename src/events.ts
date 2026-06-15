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
  // card reflects it live. See src/cto-agent.ts.
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
  //   - `user` is the CTO ESCALATING an open ask up to the user (reason `ask`). NO channel
  //     bridge owns `target:user` — consumeStoryAttention DROPS it (the CTO + leader feeds stay
  //     silent); the dashboard's SSE consumer is what surfaces a user-owned ask.
  // `detail` is a short human hook (the story brief, the gate output / conflict runbook, or the
  // ask question/answer text). See src/channel.ts (AttentionBridge).
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
        | "ask-answered";
      detail: string | null;
    }
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
