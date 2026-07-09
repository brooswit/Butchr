// The client's view of the SERVER-OWNED state machine: status labels, the six status
// tables, and the fallback used when /api/state-meta is briefly unavailable.
//
// This module is DOM-FREE (nothing here touches `document`), so test/state-meta-fallback.test.ts
// imports it directly and asserts on the real exports. It used to be fenced by a
// `<test-extract:state-meta>` sentinel and eval'd out of app.js with `new Function`, because a
// classic script could not be imported. That harness is gone — do not reintroduce a sentinel here.
//
// THE `export let` TABLES SURVIVE PHASE 4, AND SO DOES THE REASON. RFC §1.1 row 5 calls them "an
// imperative module-global store read through ES live bindings — React components will not
// re-render when they change", and prescribes "a context + useSyncExternalStore". The second half
// landed in Phase 3 as `public/state-meta-store.ts`: a version counter that ticks on every rebuild
// and wakes every subscriber. The tables themselves stay exactly where they are, because MIRRORING
// them into React state would create a second copy — the bug the store's own header exists to
// avoid — and because test/state-meta-fallback.test.ts asserts the live-binding propagation
// directly, on a real importer.
import { api } from "./api.ts";
import type { StatusCounts } from "./types.ts";

/** What the server serves at `/api/state-meta`. */
export type StateKind = "idle" | "agent" | "feedback";
export type ServedStateMeta = {
  stateMeta: Record<string, { kind?: StateKind; agentType?: string }>;
  allStatuses: string[];
  terminalStatuses: string[];
};
/** The six tables `statusSetsFrom` derives. Pure — see below. */
export type StatusSets = {
  STATE_KIND: Record<string, StateKind>;
  AGENT_TYPE: Record<string, string>;
  ALL_STATUSES: string[];
  TERMINAL_STATUSES: string[];
  ACTIVE_STATUSES: string[];
  FILTER_STATUSES: string[];
};

// CANONICAL STATUS LABELS for the 12-state model. Maps internal status keys to their
// friendly display labels. Any status not listed shows verbatim (fallback for
// unknown values from historical audit logs). The chip CSS class stays the raw status.
export const STATUS_LABELS: Record<string, string> = {
  spec_review: "spec review",
  inactive: "ready",
  in_progress: "in progress",
  in_review: "in review",
  needs_info: "needs info",
  // Synthetic effStatus (a flag on a LIVE in_progress agent, like `idle`) — the agent is
  // wedged at a human-only OS/CLI prompt and needs a person to answer in its live pane.
  needs_user_input: "needs your input",
  rolling_back: "rolling back",
  rolled_back: "rolled back",
  idea: "idea",
  blocked: "blocked",
  // CEO directive (RFC Q1) — a directive awaiting a repo's CTO, and its terminal accepted state.
  directive: "CEO directive",
  accepted: "accepted",
  merged: "merged",
  failed: "failed",
  aborted: "aborted",
  // STORY (node) statuses — stories share the unified work list with tasks, so their
  // statuses get friendly labels here too. `aborted` is shared with tasks (defined above).
  open: "open",
  done: "done",
  merging: "merging",
  merge_blocked: "merge blocked",
};
export function statusLabel(status: string | null | undefined): string {
  return (status && STATUS_LABELS[status]) || String(status ?? "");
}

// CANONICAL STATE METADATA — owned by the SERVER, never hand-mirrored here. The
// 12-state machine's kind (idle/agent/feedback), per-state agent type, ordered status
// list, and terminal subset all live in src/db.ts (STATE_META / ALL_STATUSES /
// isTerminal) and are served at /api/state-meta. These tables are BUILT from that served
// meta once at boot (loadStateMeta / applyStateMeta, run before the first render), so a
// state-model change needs editing exactly one file. Declared `let` and start empty; the
// helpers and views read them live. If the meta is briefly unavailable the tables fall back to
// DEFAULT_STATE_META (no crash) rather than mirroring db.ts.
//
// EXPORTED AS `let`: applyStateMeta REASSIGNS these, and ES live bindings propagate the
// new value to every importer. Importers must therefore read them at CALL time and must
// NOT destructure them into local consts (`const {STATE_KIND} = ...`), which would
// snapshot the empty pre-load value.
export let STATE_KIND: Record<string, StateKind> = {};
export let AGENT_TYPE: Record<string, string> = {};
export let ALL_STATUSES: string[] = [];
export let TERMINAL_STATUSES: string[] = [];
export let ACTIVE_STATUSES: string[] = [];
// FILTER_STATUSES is ALL_STATUSES with the synthetic `idle` effStatus (an idle RUNNING
// task — see effStatus) spliced in after in_progress, so it filters independently.
export let FILTER_STATUSES: string[] = [];
// False until a /api/state-meta fetch SUCCEEDS. While false the tables hold the built-in
// DEFAULT_STATE_META fallback (see below) and the SSE handler retries the fetch on the next
// event, so a transient meta hiccup self-heals without a page reload.
export let stateMetaLoaded = false;

// SERVER-CANONICAL DEFAULTS — a hand-kept mirror of src/db.ts (STATE_META / ALL_STATUSES /
// isTerminal) in the exact shape /api/state-meta serves. Used ONLY as a FALLBACK when that
// fetch fails: without it the status tables (ACTIVE_STATUSES / TERMINAL_STATUSES) would be
// empty, and the Pipeline view can't tell active work from finished — a finished subtask
// wouldn't collapse into its lane's done pile. The served meta is authoritative and replaces
// these the moment the fetch succeeds (see loadStateMeta), so this drift-prone copy is only
// ever live during an outage. If db.ts's state model changes, update this mirror to match.
// test/state-meta-fallback.test.ts asserts it against src/db.ts on every run.
export const DEFAULT_STATE_META: ServedStateMeta = {
  stateMeta: {
    idea: { kind: "feedback" },
    spec_review: { kind: "feedback" },
    blocked: { kind: "idle" },
    needs_info: { kind: "feedback" },
    directive: { kind: "feedback" },
    inactive: { kind: "agent", agentType: "workspace-agent" },
    in_progress: { kind: "agent", agentType: "workspace-agent" },
    in_review: { kind: "feedback" },
    merged: { kind: "idle" },
    rolling_back: { kind: "idle" },
    rolled_back: { kind: "idle" },
    failed: { kind: "idle" },
    aborted: { kind: "idle" },
    accepted: { kind: "idle" },
  },
  allStatuses: [
    "idea", "spec_review", "blocked", "needs_info", "directive", "inactive", "in_progress",
    "in_review", "merged", "rolling_back", "rolled_back", "failed", "aborted", "accepted",
  ],
  terminalStatuses: ["merged", "aborted", "failed", "rolled_back", "accepted"],
};

// Build the six status tables from the served meta — or, when `meta` is missing/empty (a
// failed fetch), from DEFAULT_STATE_META so the returned sets are NEVER empty. Pure: returns
// the tables, touches no module state and no DOM (applyStateMeta assigns them in).
export function statusSetsFrom(meta: Partial<ServedStateMeta> | null | undefined): StatusSets {
  const ok = !!meta && Array.isArray(meta.allStatuses) && meta.allStatuses.length > 0;
  const src = ok ? (meta as ServedStateMeta) : DEFAULT_STATE_META;
  const stateMeta = src.stateMeta || {};
  const all = src.allStatuses || [];
  const terminal = src.terminalStatuses || [];
  // These two DELIBERATELY shadow the exported module-level bindings of the same name:
  // statusSetsFrom is pure and must build fresh tables without touching module state.
  // Only applyStateMeta assigns to the exported bindings.
  const STATE_KIND: Record<string, StateKind> = {};
  const AGENT_TYPE: Record<string, string> = {};
  for (const s of all) {
    const m = stateMeta[s] || {};
    STATE_KIND[s] = m.kind || "idle";
    if (m.agentType) AGENT_TYPE[s] = m.agentType;
  }
  const FILTER = all.flatMap((s) => (s === "in_progress" ? [s, "needs_user_input", "idle"] : [s]));
  // Story (node) statuses live alongside task statuses in the unified work list, so the
  // filter chips must narrow stories too. Append the story-specific statuses not already
  // present (`aborted` is shared with tasks, so it's already in the set).
  for (const s of ["open", "done"]) if (!FILTER.includes(s)) FILTER.push(s);
  return {
    STATE_KIND,
    AGENT_TYPE,
    ALL_STATUSES: all.slice(),
    TERMINAL_STATUSES: terminal.slice(),
    ACTIVE_STATUSES: all.filter((s) => !terminal.includes(s)),
    FILTER_STATUSES: FILTER,
  };
}

// Fetch the server-owned state metadata and (re)build every table above from it. Called once
// at boot BEFORE the first render, then re-tried on SSE events until it succeeds (see App.tsx's
// SSE effect). On failure the tables fall back to the non-empty DEFAULT_STATE_META so the
// pipeline/filters keep working, and stateMetaLoaded stays false so the next event retries.
export async function loadStateMeta(): Promise<void> {
  try {
    applyStateMeta(await api<ServedStateMeta>("GET", "/state-meta"));
    stateMetaLoaded = true;
  } catch (e) {
    console.error("state-meta load failed; using built-in defaults, will retry on next event", e);
    applyStateMeta(DEFAULT_STATE_META);
  }
}
export function applyStateMeta(meta: Partial<ServedStateMeta> | null | undefined): void {
  const sets = statusSetsFrom(meta);
  STATE_KIND = sets.STATE_KIND;
  AGENT_TYPE = sets.AGENT_TYPE;
  ALL_STATUSES = sets.ALL_STATUSES;
  TERMINAL_STATUSES = sets.TERMINAL_STATUSES;
  ACTIVE_STATUSES = sets.ACTIVE_STATUSES;
  FILTER_STATUSES = sets.FILTER_STATUSES;
}

export function stateKind(status: string | null | undefined): StateKind {
  // `needs_user_input` is a synthetic effStatus (not in the server's STATE_KIND table) — it
  // is a feedback condition (a human must answer), so surface it like the feedback states.
  if (status === "needs_user_input") return "feedback";
  return (status && STATE_KIND[status]) || "idle";
}

/** Re-exported for the views that read a story's per-status rollup. */
export type { StatusCounts };
