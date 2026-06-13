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
