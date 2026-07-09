// The FRONT END's view of the `/api/*` payloads. New in RFC Phase 4.
//
// WHY IT EXISTS. The RFC's single worst piece of news (§0) is that `bun build` performs zero type
// checking, so adopting a typed component library buys the `.d.ts` files and none of their
// protection unless `tsc` runs. Phase 1a made it run. But a typecheck over `any` is a typecheck
// over nothing, and until Phase 4 every view read its data off an untyped `await api(...)`.
//
// WHY IT IS NOT IMPORTED FROM `src/`. `tsconfig.public.json` sets `"types": []` precisely so that
// `Bun.file(...)` in a browser module is a compile error (§13.2). Importing `src/tasks.ts`'s
// `TaskView` would drag bun's globals — and `bun:sqlite` — into the browser type universe and
// undo that. So these are STRUCTURAL restatements of the wire shape, and they are deliberately
// PARTIAL: a field appears here iff the front end reads it. The server stays authoritative; this
// is a reader's contract, not a mirror.
//
// Every optional field is optional because the server genuinely omits it (a leaf has no `counts`,
// a story has no `plan_preview`), not to paper over uncertainty.

/** Discriminates the unified work list: a STORY container vs a TASK leaf. */
export type WorkKind = "node" | "leaf";

/** The server-computed structural responder for a feedback state (tasks.pendingResponder). */
export type PendingResponder = "story" | "cto" | "ceo" | "user";

/** The agent-liveness verdict the idle/stall dispatcher step records. */
export type Liveness = {
  state: "working" | "stalled" | "dead";
  evidence?: string;
};

/** Per-status subtask rollup on a STORY node. `idle` is a pseudo-bucket, not a real subtask. */
export type StatusCounts = Record<string, number | undefined>;

/** A story's managed leader agent. `lastError` can be STALE from an earlier restart while the
 *  leader is genuinely starting now — `leaderTerminalBtnState` shows it as evidence, never as a
 *  verdict of "crashed". */
export type LeaderStatus = { running?: boolean; desired?: boolean; lastError?: string | null };

/**
 * One row of `GET /api/work` — the leaf|node union. Callers split on `work_kind`.
 *
 * The `idle` / `needs_user_input` flags ride on a LIVE `in_progress` task and are NOT statuses;
 * `effStatus()` folds them into the synthetic chip the views render.
 */
export type WorkItem = {
  id: string;
  work_kind?: WorkKind;
  status: string;
  workspace_id: string;
  brief?: string | null;
  summary?: string | null;
  blocked_by?: string[];
  tags?: string[];
  parent_id?: string | null;
  story_id?: string | null;
  priority?: number | null;
  conflict?: boolean | number | null;
  plan_preview?: boolean | number | null;
  released_version?: string | null;
  idle?: boolean | null;
  needs_user_input?: boolean | null;
  pending_responder?: PendingResponder | null;
  counts?: StatusCounts;
  leader?: LeaderStatus;
  liveness?: Liveness | null;
};

/** `GET /api/work/:id` — the task detail view. A superset of the list row. */
export type TaskView = WorkItem & {
  prompt?: string | null;
  question?: string | null;
  review_note?: string | null;
  review_notes?: string | null;
  allowlist?: string[];
  created_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  merged_at?: string | null;
  model?: string | null;
  model_used?: string | null;
  cost_usd?: number | null;
  usage_input_tokens?: number | null;
  usage_output_tokens?: number | null;
  usage_cache_read_tokens?: number | null;
  usage_cache_creation_tokens?: number | null;
  session_id?: string | null;
  has_agent?: boolean | null;
  ci_status?: "running" | "pass" | "fail" | null;
  ci_summary?: string | null;
  conformance_status?: "checking" | "pass" | "concern" | null;
  conformance_summary?: string | null;
  revert_reason?: string | null;
  last_dispatch_error?: string | null;
  dispatch_attempts?: number | null;
  idle_context?: string | null;
  needs_user_input_context?: string | null;
  merge_base_sha?: string | null;
  merged_sha?: string | null;
  version_bump?: "major" | "minor" | "patch" | null;
  major_confirm_count?: number | null;
  blockerStates?: Record<string, string>;
  deadBlockers?: string[];
  estimate?: Estimate | null;
};

/** A rough p50–p90 duration range, deliberately hedged. */
export type EstimateRange = { p50Ms: number; p90Ms: number };
export type Estimate = {
  insufficient?: boolean;
  toMerge?: EstimateRange | null;
  toReview?: EstimateRange | null;
  basis?: string;
  bucket?: string;
  n?: number;
};
/** The critical-path estimate across a blocked task's blocker chain. */
export type ChainEstimate = {
  taskCount: number;
  p50Ms: number | null;
  p90Ms: number | null;
  insufficient?: boolean;
};

/** One row of `GET /api/work/:id/events` — the audit timeline. */
export type TaskEvent = { from_status?: string | null; to_status: string; note?: string | null; at: string };

/** One content block of `GET /api/work/:id/transcript`. */
export type TranscriptItem = {
  kind?: "tool_use" | "tool_result" | "thinking" | "text" | string;
  role?: string;
  tool?: string;
  args?: string;
  text?: string;
  ts?: string;
  truncated?: boolean;
};
export type TranscriptPage = { turns?: TranscriptItem[]; total?: number };

/** `GET /api/workspaces` — a registered git directory. */
export type Workspace = {
  id: string;
  path: string;
  label?: string | null;
  release_mode?: boolean | null;
};

/** `GET /api/dashboard` — the workspace rollup the workspace view reads its gate state from. */
export type Dashboard = { workspaces: Workspace[] };

/** `GET /api/workspaces/:id/cto` — the per-repo managed CTO agent. */
export type CtoStatus = {
  running?: boolean;
  desired?: boolean;
  enabled?: boolean;
  sessionId?: string | null;
  since?: string | null;
  restarts?: number | null;
  lastError?: string | null;
};

/** `GET /api/projects/:id/ceo` — ALL FOUR FIELDS ARE RESOLVED SERVER-SIDE (`enabled` already
 *  folds the per-project override against the global gate). Never re-derive from `ceo_enabled`. */
export type CeoStatus = { enabled: boolean; overridden: boolean; globalGate: boolean; live: boolean };

/** `GET /api/projects` / `GET /api/projects/:id`. `ceo_enabled` is a THREE-way column:
 *  1 = explicit on, 0 = explicit off, null = inherit the global gate. */
export type Project = {
  id: string;
  brief?: string | null;
  workspace_id?: string | null;
  status?: string | null;
  ceo_enabled?: 0 | 1 | null;
};

/** A member repo of a project: a `work_kind:'repo'` row whose id IS its directory id. */
export type Repo = { id: string; brief?: string | null };

/** `GET /api/projects/:id/initiatives`. `done` is the SERVER's authoritative boolean; the
 *  progress bar's fraction is locked to the same `status === 'done'` predicate. */
export type InitiativeChild = { workspace_id: string; status: string; brief?: string | null };
export type InitiativeView = { initiative_id: string; done?: boolean; children?: InitiativeChild[] };

/** A directory entry from `GET /api/fs` — the repo picker's payload. */
export type FsEntry = { name: string; path: string; isGitRepo: boolean };
export type FsListing = { path: string; home: string; parent?: string | null; isGitRepo: boolean; entries: FsEntry[] };

/** `GET /api/work/:id/activity` — the live "what is the agent doing" pulse. */
export type Activity = { lastAction?: string | null; lastAt?: string | null; elapsedMs?: number | null };

/** `GET /api/health` — carries BOTH the dispatcher pause state and the needs-attention counts. */
export type Attention = { total: number; in_review?: number; spec_review?: number; needs_info?: number };
export type Disk = {
  worktreesBytes: number;
  worktreeCount: number;
  backupsBytes: number;
  totalBytes: number;
  warnBytes: number;
  warn?: boolean;
  truncated?: boolean;
};
export type Health = { paused?: boolean; needsAttention?: Attention; disk?: Disk | null };

/** `GET /api/metrics`. */
export type Rate = { rate: number | null; num: number; of: number };
export type Metrics = {
  total: number;
  byStatus: Record<string, number>;
  throughput: { days: number; totalMerged: number; windowMerged: number; perDay: Array<{ date: string; count: number }> };
  timeToReview: { medianMs: number | null; count: number };
  timeToMerge: { medianMs: number | null; count: number };
  conflictRate: Rate;
  revertRate: Rate;
  ciPassRate: Rate;
  autoMergeRate: Rate;
};

/** The dependent-subtree rollup the task view computes CLIENT-SIDE from the workspace's leaves. */
export type DependentRollup = { direct: WorkItem[]; total: number; merged: number };

/** `POST /api/work/:id/approve` and `/confirm-major` — the branch the caller toasts off. */
export type ApproveResult = {
  conflictSentBack?: boolean;
  revertedOnRed?: boolean;
  awaitingMajorConfirm?: boolean;
  released_version?: string | null;
  task?: { major_confirm_count?: number | null } | null;
};

/** `POST /api/**\/terminal` — names the emulator butchr launched. */
export type TerminalResult = { emulator?: string | null };
