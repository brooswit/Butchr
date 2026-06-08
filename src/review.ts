// Pending-review registry. When an interactive agent calls the MCP
// `request_review` tool, the MCP handler parks a promise here and blocks on it
// (the agent waits on a tool result and burns no tokens while it does). The task
// service resolves/cancels that promise when the human approves, rejects, or
// aborts — releasing the blocked call in the SAME live agent session.
//
// This module deliberately imports nothing from the rest of butchr so it can sit
// between the MCP layer (mcp.ts) and the task service (tasks.ts) without creating
// an import cycle.

export type ReviewVerdict = {
  decision: "changes_requested" | "approved" | "aborted" | "superseded";
  notes?: string;
};

type Pending = {
  resolve: (v: ReviewVerdict) => void;
  reject: (e: unknown) => void;
};

const pending = new Map<string, Pending>();

/**
 * Register a blocking review for <taskId> and return the promise the MCP handler
 * awaits, plus a `cancelThis` that removes ONLY this registration (used as the
 * connection-abort cleanup so a later registration isn't clobbered).
 *
 * If a stale registration already exists for the task it is superseded — its
 * promise resolves with `{decision:"superseded"}` so the old blocked call (a
 * retried/duplicate connection) unwinds.
 */
export function registerReview(taskId: string): {
  promise: Promise<ReviewVerdict>;
  cancelThis: () => void;
} {
  const stale = pending.get(taskId);
  if (stale) {
    pending.delete(taskId);
    stale.resolve({ decision: "superseded" });
  }
  let entry!: Pending;
  const promise = new Promise<ReviewVerdict>((resolve, reject) => {
    entry = { resolve, reject };
  });
  pending.set(taskId, entry);
  const cancelThis = () => {
    if (pending.get(taskId) === entry) {
      pending.delete(taskId);
      entry.reject(new Error("review connection closed"));
    }
  };
  return { promise, cancelThis };
}

/** Is an agent currently blocked in request_review for this task? */
export function hasPendingReview(taskId: string): boolean {
  return pending.has(taskId);
}

/**
 * Resolve a blocked review with a verdict — the agent's request_review call
 * returns this. Used by rejectTask to stream change-request notes back into the
 * live session. Returns true if a call was actually waiting.
 */
export function resolveReview(taskId: string, verdict: ReviewVerdict): boolean {
  const p = pending.get(taskId);
  if (!p) return false;
  pending.delete(taskId);
  p.resolve(verdict);
  return true;
}

/**
 * Drop a blocked review WITHOUT returning a value — the awaiting handler's
 * promise rejects and it sends nothing. Used by approve/abort, where the pane is
 * closed (agent killed mid-call) so no response is wanted. Returns true if a call
 * was waiting.
 */
export function cancelReview(taskId: string): boolean {
  const p = pending.get(taskId);
  if (!p) return false;
  pending.delete(taskId);
  p.reject(new Error("review cancelled"));
  return true;
}
