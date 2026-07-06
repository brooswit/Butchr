// Workspace service: register/list/unregister workspaces. Each workspace is a
// git repo that maps 1:1 to a herdr workspace.
import { basename, dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { config } from "./config.ts";
import {
  ensureWorkspaceAgentRow,
  startWorkspaceAgent,
  stopCtoAgent,
  stopWorkspaceAgent,
  stopWorkspaceStoryAgents,
} from "./workspace-agent.ts";
// RUNTIME-ONLY circular import: tasks.ts statically imports workspaces.ts, and strandedItems is
// a hoisted function CALLED only at request time (dashboard()), never at module-eval — so the
// cycle resolves with no load-time TDZ (mirrors tasks.ts's work.ts/workspace-agent.ts cycles).
import { strandedItems } from "./tasks.ts";
import type { StrandedItem } from "./tasks.ts";
import { ALL_STATUSES, db, nowIso, REVIEW_STATES, saveWorkspaceAgentRow, sumStatuses } from "./db.ts";
import type { WorkspaceRow, TaskRow } from "./db.ts";
import { publish } from "./events.ts";
import * as git from "./git.ts";
import { harness } from "./harness.ts";
import * as herdr from "./herdr.ts";
import { generateWorkspaceId } from "./ids.ts";
import { ctoMdPath } from "./taskmd.ts";

// Default CTO context seeded into a freshly registered workspace's
// `.butchr/CTO.md`. Kept short and editable; surfaced to every agent by
// renderAgentPrompt (which adds the `# CTO context` heading above it).
const DEFAULT_CTO_CONTEXT = `A CTO — the human's principal engineer (the Claude running in the project
root) — is available for guidance on this work.

When requirements are ambiguous, you hit a judgment call, or the task itself looks
wrong (wrong scope, should be split, or should be decomposed into sub-tasks), call
the **\`raise\`** MCP tool (provided by the butchr MCP server) instead of guessing.
You are a worker, not a task-manager: raise a question, a suggested task change, or a
suggested decomposition and the operator/CTO acts on it. It is non-blocking: it
records your message and returns immediately, after which you should STOP and exit —
butchr will re-launch you in the same session once it's answered. Keep what you raise
specific and actionable.

## Project conventions

<!-- Fill in project-specific conventions, norms, and gotchas here. -->
`;

// Seed `<path>/.butchr/CTO.md` on registration unless one already exists (never
// clobber a user-edited file). Best-effort: a write failure must not break
// registration. Seed source is BUTCHR_CTO_CONTEXT when readable, else the
// built-in default.
function seedCtoContext(path: string): void {
  const target = ctoMdPath(path);
  if (existsSync(target)) return;

  let contents = DEFAULT_CTO_CONTEXT;
  if (config.ctoContextPath) {
    try {
      contents = readFileSync(config.ctoContextPath, "utf8");
    } catch {
      // unreadable seed file — fall back to the built-in default
    }
  }

  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents, "utf8");
  } catch (e) {
    console.error(
      `butchr: failed to seed CTO context at ${target}: ${(e as Error).message}`,
    );
  }
}

export type WorkspaceView = WorkspaceRow & {
  counts: Record<string, number>;
};

function counts(workspaceId: string): Record<string, number> {
  const rows = db
    .query<{ status: string; n: number }, [string]>(
      // EXCLUDE materialized story Work NODES (st-540ba705 step 6a — see tasks.listTasks): a
      // story's anchor `tasks` row is not a real task and must not inflate the workspace's
      // per-status counts (it would otherwise add a phantom `merged` per story). The
      // work_kind='node' discriminator is the node membership test (REVAMP-2 B.5a).
      `SELECT status, COUNT(*) AS n FROM tasks
        WHERE workspace_id=? AND work_kind != 'node'
        GROUP BY status`,
    )
    .all(workspaceId);
  // One bucket per canonical status (from the exported ALL_STATUSES), plus the orthogonal
  // `idle` and `needs_user_input` pseudo-buckets (flags on a LIVE in_progress agent, peeled
  // out below).
  const out: Record<string, number> = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0]));
  out.idle = 0;
  out.needs_user_input = 0;
  for (const r of rows) out[r.status] = r.n;
  // `needs_user_input` is a flag on a LIVE build agent wedged at a human-only prompt — peel it
  // out of in_progress FIRST (it WINS over idle: the more specific, highest-attention signal,
  // mirroring tasks.attentionReason / the webapp's effStatus precedence) so a wedged agent is
  // surfaced distinctly on the dashboard.
  const needsInput = db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM tasks WHERE workspace_id=? AND status='in_progress' AND has_agent=1 AND needs_user_input=1`,
    )
    .get(workspaceId)!.n;
  out.needs_user_input = needsInput;
  out.in_progress -= needsInput;
  // `idle` is a flag on a LIVE build agent (in_progress with a pane), not a status — peel it
  // out of the in_progress count so the dashboard shows active vs. quiet agents. EXCLUDE the
  // needs_user_input ones (already peeled above) so a task in both buckets counts exactly once.
  const idle = db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM tasks WHERE workspace_id=? AND status='in_progress' AND has_agent=1 AND idle=1 AND needs_user_input=0`,
    )
    .get(workspaceId)!.n;
  out.idle = idle;
  out.in_progress -= idle;
  return out;
}

// NOTE (st-540ba705 STEP 6c): the directory+config table is now physically `directory`
// (renamed from `workspaces` — see db.migrateRenameWorkspacesToDirectory). This canonical
// service reads AND writes `directory` DIRECTLY; `workspaces` survives only as a writable
// back-compat VIEW for the running OLD server (db.migrateWorkspacesView). The exported
// names/types keep the "workspace" wording — the concept is unchanged; only the table moved.

/** Look up a registered workspace by its id, or null if none matches. */
export function getWorkspace(id: string): WorkspaceRow | null {
  return (
    db.query<WorkspaceRow, [string]>(`SELECT * FROM directory WHERE id=?`).get(id) ??
    null
  );
}

/** Look up a registered workspace by its absolute filesystem path, or null if none matches. */
export function getWorkspaceByPath(path: string): WorkspaceRow | null {
  return (
    db.query<WorkspaceRow, [string]>(`SELECT * FROM directory WHERE path=?`).get(path) ??
    null
  );
}

export type WorkspaceHeal = { workspaceId: string | undefined; created: boolean };

// In-flight herdr-workspace create/heal keyed by workspace id. BOTH callers that heal a
// workspace's herdr workspace — the dispatcher (task agents) and the managed CTO agent —
// funnel through this ONE map, so a CTO (re)launch and a task dispatch both racing the
// SAME workspace's closed/restarted herdr workspace can no longer each see
// workspaceExists=false and double-create (the second persist UPDATE would clobber the
// first, orphaning a workspace). The FIRST caller runs the heal; concurrent callers
// await its result. The entry is cleared once the heal settles, so a LATER heal (a
// subsequent close/restart) starts fresh.
const workspaceInFlight = new Map<string, Promise<WorkspaceHeal>>();

/**
 * Ensure the workspace's herdr workspace exists, recreating it (and persisting the
 * new ids on the workspace row) when herdr was restarted or the workspace was closed
 * out from under us. The single existence-check + create + row UPDATE both the
 * dispatcher (task agents) and the managed CTO agent funnel through — one herdr
 * workspace per workspace backs both — and the in-flight dedupe lives HERE (not in any one
 * caller) so EVERY path collapses to exactly one create per workspace under
 * concurrency. Goes through the swappable `harness` runner so a test-injected fake
 * backend is honored.
 *
 * Returns the workspace id and whether a fresh one was `created` (vs the existing one
 * being reused) so the caller can do its own create-only bookkeeping (the dispatcher
 * logs + mutates its in-memory WorkspaceRow; the CTO agent does neither). The single
 * underlying create is owned by — and reported `created: true` to — the FIRST caller;
 * concurrent callers that merely await that in-flight heal get the same workspace id
 * with `created: false`, so the create-only bookkeeping runs exactly once no matter how
 * many race.
 */
export async function ensureHerdrWorkspace(
  workspaceId: string,
  cwd: string,
  label: string,
): Promise<WorkspaceHeal> {
  const existing = workspaceInFlight.get(workspaceId);
  if (existing) {
    // An awaiter: share the in-flight heal's workspace id, but never re-claim the
    // create — the initiator owns it (and its create-only bookkeeping).
    const { workspaceId } = await existing;
    return { workspaceId, created: false };
  }
  const p = healHerdrWorkspace(workspaceId, cwd, label).finally(() =>
    workspaceInFlight.delete(workspaceId),
  );
  workspaceInFlight.set(workspaceId, p);
  return p;
}

// The actual existence-check + create + row UPDATE, run once per in-flight heal (see
// ensureHerdrWorkspace's dedupe). Reuses the recorded workspace when it still
// exists; otherwise creates a fresh one and persists its ids on the workspace row.
async function healHerdrWorkspace(
  workspaceId: string,
  cwd: string,
  label: string,
): Promise<WorkspaceHeal> {
  const existing = getWorkspace(workspaceId)?.herdr_workspace ?? null;
  if (existing && (await harness.workspaceExists(existing))) {
    return { workspaceId: existing, created: false };
  }
  const ws = await harness.workspaceCreate(cwd, label);
  db.query(
    `UPDATE directory SET herdr_workspace=?, herdr_pane=? WHERE id=?`,
  ).run(ws.workspaceId ?? null, ws.rootPaneId ?? null, workspaceId);
  return { workspaceId: ws.workspaceId, created: true };
}

export function listWorkspaces(): WorkspaceView[] {
  const rows = db
    .query<WorkspaceRow, []>(`SELECT * FROM directory ORDER BY created_at ASC`)
    .all();
  return rows.map((d) => ({ ...d, counts: counts(d.id) }));
}

/**
 * PATH-BOUNDARY containment: true if `path` resolves to, or strictly under, `base`.
 * Both sides are resolved/normalized first, then compared on a separator boundary so
 * `/tmp/foo` matches base `/tmp` but `/tmproom/foo` does NOT (a bare string-prefix check
 * would wrongly match the latter).
 */
function isUnder(path: string, base: string): boolean {
  const p = resolve(path);
  const b = resolve(base);
  return p === b || p.startsWith(b.endsWith(sep) ? b : b + sep);
}

/**
 * Whether a workspace path lives under the OS temp dir. `os.tmpdir()` is the source of
 * truth; we ALSO treat a literal `/tmp` prefix as temp so Linux CI repos under `/tmp`
 * are caught on platforms where `tmpdir()` differs (e.g. macOS `/var/folders/...`).
 */
function isTempPath(path: string): boolean {
  return isUnder(path, tmpdir()) || isUnder(path, "/tmp");
}

/**
 * Boot-time housekeeping: unregister every workspace whose path lives under the OS temp
 * dir (see isTempPath). These are leftovers from selftest/integration runs whose tmp dirs
 * are long gone — they clutter the dashboard + CTO channel with dead `test` workspaces and
 * orphaned tasks. Each prune reuses the EXISTING unregisterWorkspace() so the removal
 * CASCADES to the workspace's tasks and tears down its panes/worktrees/CTO agent — no
 * hand-rolled DB delete. A workspace under a real path (e.g. /home/...) is NEVER touched.
 *
 * Best-effort PER WORKSPACE: a failure pruning one tmp workspace is logged and skipped so
 * it can't abort boot or block the rest of the sweep. Returns the count actually pruned.
 */
export async function pruneTempWorkspaces(): Promise<number> {
  let pruned = 0;
  for (const ws of listWorkspaces()) {
    if (!isTempPath(ws.path)) continue;
    try {
      await unregisterWorkspace(ws.id);
      pruned++;
    } catch (e) {
      console.error(
        `[butchr] failed to prune temp workspace ${ws.path}: ${(e as Error).message}`,
      );
    }
  }
  return pruned;
}

/**
 * The EFFECTIVE build/test gate command for a workspace: its own `gate_cmd` if it
 * set one (a non-null value, including the empty string which DISABLES the gate),
 * else the global default `config.verifyCmd` (EMPTY by default — no gate — unless
 * set via BUTCHR_VERIFY_CMD). This is the single resolution point for BOTH gates —
 * the in-worktree CI gate (tasks.triggerCi) and the post-merge verify gate
 * (verify.verifyDefaultBranch) — so a workspace's command can never diverge between
 * them. An unknown id falls back to the default. Pure read of the workspace row + config.
 */
export function workspaceGateCmd(id: string): string {
  return effectiveOverride(id, "gate_cmd", config.verifyCmd);
}

// The shared resolution for every per-workspace optional-string override (gate_cmd /
// version_file / changelog_path): the workspace's own column value if it set one (a
// non-null value, incl. "" = disabled), else the global `fallback`. Unknown id →
// fallback. Pure read of the workspace row.
function effectiveOverride(
  id: string,
  column: "gate_cmd" | "version_file" | "changelog_path",
  fallback: string,
): string {
  const value = getWorkspace(id)?.[column] ?? null;
  return value !== null ? value : fallback;
}

/**
 * The EFFECTIVE version-file path for a workspace: its own `version_file` if it set
 * one (a non-null value, including "" which DISABLES the merge-time bump), else the
 * global default `config.versionFile` (EMPTY by default — no bump — unless set via
 * BUTCHR_VERSION_FILE). An EMPTY result means "no version bump for this workspace"
 * (the opt-in default). Pure read of the workspace row + config; unknown id → default.
 */
export function workspaceVersionFile(id: string): string {
  return effectiveOverride(id, "version_file", config.versionFile);
}

/**
 * The EFFECTIVE changelog-gate path for a workspace: its own `changelog_path` if it
 * set one (a non-null value, including "" which DISABLES the gate), else the global
 * default `config.changelogPath` (EMPTY by default — gate off — unless set via
 * BUTCHR_CHANGELOG_PATH). An EMPTY result means "no changelog gate for this
 * workspace" (the opt-in default). Pure read; unknown id → default.
 */
export function workspaceChangelogPath(id: string): string {
  return effectiveOverride(id, "changelog_path", config.changelogPath);
}

/**
 * Whether a workspace is in VERSIONED-RELEASES MODE (the `release_mode` column !== 0).
 * When on, every merge bumps the version + stamps the changelog with a versioned heading
 * and the changelog gate is strict (see git.bumpVersionFile / tasks.finalizeMerge /
 * tasks.triggerCi). Default off (today's opt-in patch-bump behavior). Pure read of the
 * workspace row; unknown id → false. EVERYTHING keys off this — no workspace id is ever
 * hardcoded.
 */
export function workspaceReleaseMode(id: string): boolean {
  return (getWorkspace(id)?.release_mode ?? 0) !== 0;
}

/**
 * Whether a workspace has 3-LEVEL BRANCH ISOLATION enabled (the `branch_isolation` column
 * !== 0 — see db.ts + CONTRIBUTING §11). Mirrors workspaceReleaseMode. Stories OPENED while
 * this is on capture isolated=1; thereafter isolation keys off that captured per-story bit,
 * NOT this live flag (§11.8), so flipping the flag never retroactively changes an open story.
 * Pure read of the workspace row; unknown id → false. LIVE but guarded by each story's
 * captured isolated bit — default OFF (set via setWorkspaceBranchIsolation).
 */
export function workspaceBranchIsolation(id: string): boolean {
  return (getWorkspace(id)?.branch_isolation ?? 0) !== 0;
}

/**
 * Normalize an incoming optional-string override for storage. `undefined`/`null`
 * clears the override (→ NULL → falls back to the global default); a string is
 * stored verbatim (the empty string is a deliberate "disable for this workspace"
 * setting). Anything else is a 400. Shared by the gate_cmd / version_file /
 * changelog_path setters (all three carry identical NULL=default / ""=off semantics).
 */
function normalizeOverride(field: string, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new HttpError(400, `${field} must be a string (or null to use the default)`);
  }
  return value;
}

/**
 * The shared persist tail for every per-field workspace updater: 404 if the workspace is
 * gone, UPDATE the one `column`, rebuild the view, publish `workspace.updated`, and return
 * it. `column` is a trusted internal literal (never user input) — callers do their own
 * validation/normalization before delegating here.
 */
function updateWorkspaceColumn(
  id: string,
  column:
    | "gate_cmd"
    | "version_file"
    | "changelog_path"
    | "cto_enabled"
    | "release_mode"
    | "branch_isolation",
  stored: string | number | null,
): WorkspaceView {
  if (!getWorkspace(id)) throw new HttpError(404, `workspace not found: ${id}`);
  db.query(`UPDATE directory SET ${column}=? WHERE id=?`).run(stored, id);
  const view: WorkspaceView = { ...getWorkspace(id)!, counts: counts(id) };
  publish({ type: "workspace.updated", workspace: view });
  return view;
}

/**
 * Update (or clear) a workspace's per-workspace build/test gate command and return
 * the refreshed view. Pass `null`/`undefined` to clear the override (revert to the
 * default `config.verifyCmd`); a string (incl. "") sets it. 404 if the workspace is
 * gone. Takes effect on the NEXT gate run for that workspace (the next task entering
 * review, and the next merge's post-merge verify) — nothing in flight is disturbed.
 */
export function updateWorkspaceGateCmd(id: string, gateCmd: unknown): WorkspaceView {
  return updateWorkspaceColumn(id, "gate_cmd", normalizeOverride("gate_cmd", gateCmd));
}

/**
 * Update (or clear) a workspace's optional MERGE-TIME VERSION FILE and return the
 * refreshed view. Pass `null`/`undefined` to clear the override (inherit
 * `config.versionFile`); a string (incl. "" to disable the bump) sets it; a path
 * (e.g. "package.json") opts the workspace into the patch-bump. 404 if the workspace
 * is gone. Takes effect on the next merge for that workspace.
 */
export function updateWorkspaceVersionFile(id: string, versionFile: unknown): WorkspaceView {
  return updateWorkspaceColumn(id, "version_file", normalizeOverride("version_file", versionFile));
}

/**
 * Update (or clear) a workspace's optional CHANGELOG-GATE PATH and return the
 * refreshed view. Pass `null`/`undefined` to clear the override (inherit
 * `config.changelogPath`); a string (incl. "" to disable the gate) sets it; a path
 * (e.g. "CHANGELOG.md") opts the workspace into the changelog-update CI gate. 404 if
 * the workspace is gone. Takes effect on the next task entering review.
 */
export function updateWorkspaceChangelogPath(id: string, changelogPath: unknown): WorkspaceView {
  return updateWorkspaceColumn(
    id, "changelog_path", normalizeOverride("changelog_path", changelogPath),
  );
}

/**
 * Is a workspace's CTO agent ENABLED for boot auto-start + supervision? The
 * workspace's own `cto_enabled` column WINS (1 → on, 0 → off); NULL inherits the
 * GLOBAL default config.ctoAgentEnabled (itself default OFF). An unknown workspace →
 * not enabled. Exported for testing.
 */
export function isCtoEnabled(workspaceId: string): boolean {
  const row = db
    .query<{ cto_enabled: number | null }, [string]>(
      `SELECT cto_enabled FROM workspaces WHERE id=?`,
    )
    .get(workspaceId);
  if (!row) return false;
  if (row.cto_enabled !== null) return row.cto_enabled === 1;
  return config.ctoAgentEnabled;
}

/**
 * Set (or clear) a workspace's per-workspace CTO-agent enable and return the refreshed
 * view. `true`/`false` forces the workspace's CTO agent on/off (boot auto-start +
 * supervision); `null`/`undefined` CLEARS the override so it inherits the global
 * default config.ctoAgentEnabled. 404 if the workspace is gone; 400 if the value is
 * neither a boolean nor null. Takes effect on the next boot reconcile / supervision
 * tick (and is reflected immediately in the workspace's CTO status). See
 * isCtoEnabled (in this module).
 *
 * UNIFIED MIRROR (story st-93384200, Bug 1): after writing directory.cto_enabled, mirror the
 * EFFECTIVE state into the unified `workspace` runtime row (id `ws-cto-<id>`) so the unified
 * supervisor honors it — DISABLED → stopWorkspaceAgent (immediate teardown + desired=0);
 * ENABLED → ensure the row exists + desired=1 so the supervisor relaunches it. The unified path
 * is AUTHORITATIVE; the legacy cto_agent.desired writes are KEPT as a mirror (MIRROR-AND-DEFER).
 * Async because the disable teardown is awaited.
 */
export async function setWorkspaceCtoEnabled(id: string, value: unknown): Promise<WorkspaceView> {
  if (!getWorkspace(id)) throw new HttpError(404, `workspace not found: ${id}`);
  let stored: number | null;
  if (value === undefined || value === null) stored = null;
  else if (typeof value === "boolean") stored = value ? 1 : 0;
  else throw new HttpError(400, "cto_enabled must be a boolean (or null to use the default)");
  const view = updateWorkspaceColumn(id, "cto_enabled", stored);
  const wsId = `ws-cto-${id}`;
  if (isCtoEnabled(id)) {
    ensureWorkspaceAgentRow(wsId, { kind: "cto", directory_id: id });
    saveWorkspaceAgentRow(wsId, { desired: 1 });
  } else {
    await stopWorkspaceAgent(wsId);
  }
  return view;
}

/**
 * Set a workspace's VERSIONED-RELEASES MODE and return the refreshed view. `true`/`false`
 * turns release_mode on/off; `null`/`undefined` is treated as OFF (the default — unlike the
 * tri-state inherit columns, this is a plain on/off flag, not an inherit). 404 if the
 * workspace is gone; 400 if the value is neither a boolean nor null. Takes effect on the
 * next merge / changelog gate for that workspace. See workspaceReleaseMode.
 */
export function setWorkspaceReleaseMode(id: string, value: unknown): WorkspaceView {
  if (!getWorkspace(id)) throw new HttpError(404, `workspace not found: ${id}`);
  let stored: number;
  if (value === undefined || value === null) stored = 0;
  else if (typeof value === "boolean") stored = value ? 1 : 0;
  else throw new HttpError(400, "release_mode must be a boolean (or null for off)");
  return updateWorkspaceColumn(id, "release_mode", stored);
}

/**
 * Set a workspace's 3-LEVEL BRANCH-ISOLATION guard and return the refreshed view (the
 * F-ACTIVATE operator switch — CONTRIBUTING §11.8). `true`/`false` turns branch_isolation
 * on/off; `null`/`undefined` is treated as OFF (the default — a plain on/off flag, not a
 * tri-state inherit, mirroring setWorkspaceReleaseMode). 404 if the workspace is gone; 400
 * if the value is neither a boolean nor null. Takes effect on the NEXT story OPENED in this
 * workspace: that story captures isolated=1 at createStory and gets a story branch. Stories
 * already open keep the isolated bit they captured at create — flipping this flag never
 * retroactively changes them (§11.8). See workspaceBranchIsolation.
 */
export function setWorkspaceBranchIsolation(id: string, value: unknown): WorkspaceView {
  if (!getWorkspace(id)) throw new HttpError(404, `workspace not found: ${id}`);
  let stored: number;
  if (value === undefined || value === null) stored = 0;
  else if (typeof value === "boolean") stored = value ? 1 : 0;
  else throw new HttpError(400, "branch_isolation must be a boolean (or null for off)");
  return updateWorkspaceColumn(id, "branch_isolation", stored);
}

/**
 * A workspace's detail view: the WorkspaceView (counts + raw columns) — the shape GET
 * /api/workspaces/:id returns and the webapp consumes. 404 if the workspace is gone.
 * Responder routing is now STRUCTURAL (per-task pending_responder), so there is no
 * per-workspace responder config to attach here.
 */
export function workspaceDetail(id: string): WorkspaceView {
  const dir = getWorkspace(id);
  if (!dir) throw new HttpError(404, `workspace not found: ${id}`);
  return { ...dir, counts: counts(id) };
}

/**
 * Per-workspace needs-attention rollup, the projection behind the cross-project
 * DASHBOARD (GET /api/dashboard). For every registered workspace it folds the
 * per-status `counts` into the four operator-facing buckets the dashboard surfaces,
 * plus the workspace's effective gate command, and accumulates a `totals` row. The
 * buckets (a task can fall in more than one — `needsAttention` is the operator
 * pull-signal, deliberately overlapping `review`/`failed`, matching /health):
 *  - `active`         — in-flight work needing no human (idle/agent, non-feedback):
 *                       idea + blocked + inactive + in_progress + idle + rolling_back.
 *  - `review`         — FEEDBACK states awaiting a human: spec_review + in_review +
 *                       needs_info (kept under the `review` field name for the API).
 *  - `failed`         — the terminal `failed` state (a dispatch/spec-gen give-up or a
 *                       post-merge verify revert) — execution failures a human should see.
 *  - `needsAttention` — what to look at right now (= review + failed + stranded).
 *  - `stranded`       — agent-INDEPENDENT pull-signal (story st-a4cc6082, S2 + st-a32c8138 PART 2):
 *                       pending work whose OWNING responder (CTO or story leader) is NOT acting on
 *                       it — dead-while-desired (gave_up) or disabled (idea / dead-blocked task;
 *                       stuck / merge_blocked story), OR a LIVE CTO gone durably IDLE while owning
 *                       ≥1 actionable item (the `idle_responder` summary). FOLDED into
 *                       needsAttention so the existing badge lights up; a LIVE-AND-WORKING
 *                       responder ⇒ stranded=0 ⇒ needsAttention byte-for-byte unchanged.
 */
export type DashboardWorkspace = {
  id: string;
  path: string;
  label: string | null;
  gate_cmd: string | null;
  /** The effective gate command (own gate_cmd or the default) — what actually runs. */
  effective_gate_cmd: string;
  counts: Record<string, number>;
  active: number;
  review: number;
  failed: number;
  needsAttention: number;
  /** Count of stranded pending items (= strandedItems.length), folded into needsAttention. */
  stranded: number;
  /** The stranded pending items (work id + kind + human reason) — see tasks.strandedItems. */
  strandedItems: StrandedItem[];
  /** OPEN stories in this workspace (Phase 6 story rollup) — the count of stories still
   *  driving work, so the dashboard surfaces story-level progress alongside task buckets.
   *  Per-story member-task counts + leader status live on GET /api/stories(/:id). */
  openStories: number;
};

export type Dashboard = {
  workspaces: DashboardWorkspace[];
  totals: {
    workspaces: number;
    active: number;
    review: number;
    failed: number;
    needsAttention: number;
    stranded: number;
    openStories: number;
  };
};

/** The count of OPEN stories in a workspace (the dashboard story rollup; cheap COUNT).
 *  REVAMP Phase B.4 (story st-6372812d): counts the authoritative `tasks` node rows
 *  (work_kind='node'), not the `stories` mirror. Byte-identical (B.3 dual-write). */
function openStoryCount(workspaceId: string): number {
  return db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM tasks WHERE workspace_id=? AND work_kind='node' AND status='open'`,
    )
    .get(workspaceId)!.n;
}

export function dashboard(): Dashboard {
  const rows = db
    .query<WorkspaceRow, []>(`SELECT * FROM directory ORDER BY created_at ASC`)
    .all();
  const totals = {
    workspaces: rows.length,
    active: 0,
    review: 0,
    failed: 0,
    needsAttention: 0,
    stranded: 0,
    openStories: 0,
  };
  const workspaces = rows.map((d) => {
    const c = counts(d.id);
    const active =
      (c.idea ?? 0) + (c.blocked ?? 0) + (c.inactive ?? 0) + (c.in_progress ?? 0) +
      (c.idle ?? 0) + (c.needs_user_input ?? 0) + (c.rolling_back ?? 0);
    // FEEDBACK states awaiting a human (kept under the `review` field name).
    const review = (c.spec_review ?? 0) + (c.in_review ?? 0) + (c.needs_info ?? 0);
    const failed = c.failed ?? 0; // the terminal `failed` state — see comment above
    // STRANDED pull-signal (story st-a4cc6082 S2 + st-a32c8138 PART 2): pending items whose owning
    // responder is not acting — dead-while-desired (gave_up) / disabled, or a LIVE CTO durably idle
    // with owned actionable work — a SYNC DB projection, no liveness probe.
    const strandedItemsList = strandedItems(d.id);
    const stranded = strandedItemsList.length;
    // = review + failed (REVIEW_STATES) + stranded. A LIVE responder ⇒ stranded=0 ⇒ this equals
    // the prior sumStatuses(c, REVIEW_STATES) byte-for-byte (idea/blocked/story-ids are all
    // OUTSIDE REVIEW_STATES, so a stranded item is never double-counted).
    const needsAttention = sumStatuses(c, REVIEW_STATES) + stranded;
    const openStories = openStoryCount(d.id);
    totals.active += active;
    totals.review += review;
    totals.failed += failed;
    totals.needsAttention += needsAttention;
    totals.stranded += stranded;
    totals.openStories += openStories;
    return {
      id: d.id,
      path: d.path,
      label: d.label,
      gate_cmd: d.gate_cmd,
      effective_gate_cmd: workspaceGateCmd(d.id),
      counts: c,
      active,
      review,
      failed,
      needsAttention,
      stranded,
      strandedItems: strandedItemsList,
      openStories,
    };
  });
  return { workspaces, totals };
}

/**
 * CREATE-TIME unified `workspace` cto row for a directory (story st-93384200, Bug 3). Called by
 * registerWorkspace right after the directory row is inserted so the unified supervisor — the
 * SOLE launcher — owns this directory's CTO immediately (launch AND relaunch-on-death) WITHOUT
 * waiting for a restart to re-seed it from the legacy cto_agent table.
 * `desired` reflects whether the CTO is ENABLED (the per-workspace override resolved against the
 * global default); a disabled / globally-off CTO gets desired=0 and is NOT launched (the unified
 * reconcile/supervise already tears down any stray desired=1 cto row for a disabled directory).
 * The legacy cto_agent path has NO direct CTO start at registration (the CTO comes up via the
 * supervisor), so there is nothing to gate off here. The optional low-latency launch kick is
 * serialized behind the SAME per-id launchInFlight guard the supervisor uses
 * (workspace-agent.guarded), so it can't double-launch with a racing supervise tick.
 * EXPORTED for direct testing — registerWorkspace itself needs a live herdr to drive end-to-end.
 */
export function ensureCtoWorkspaceRow(directoryId: string): void {
  const wsId = `ws-cto-${directoryId}`;
  const ctoOn = isCtoEnabled(directoryId);
  ensureWorkspaceAgentRow(wsId, { kind: "cto", directory_id: directoryId }); // work_id NULL, has_agent 0
  saveWorkspaceAgentRow(wsId, { desired: ctoOn ? 1 : 0 });
  if (ctoOn) {
    void startWorkspaceAgent(wsId).catch((e) => {
      console.error(`[butchr] CTO launch failed for ${directoryId}: ${(e as Error).message}`);
    });
  }
}

export async function registerWorkspace(
  rawPath: string,
  label?: string,
  gateCmd?: unknown,
  versionFile?: unknown,
  changelogPath?: unknown,
): Promise<WorkspaceView> {
  const path = resolve(rawPath);

  if (!(await git.isGitRepo(path))) {
    throw new HttpError(400, `not a git repository: ${path}`);
  }
  if (getWorkspaceByPath(path)) {
    throw new HttpError(409, `workspace already registered: ${path}`);
  }

  const finalLabel = label?.trim() || basename(path);
  // Optional per-workspace build/test gate command, set at register time (NULL =
  // use the default config.verifyCmd; "" = disable the gate for this workspace).
  const finalGateCmd = normalizeOverride("gate_cmd", gateCmd);
  // Optional per-workspace version-bump file + changelog-gate path (NULL = inherit
  // the global default; "" = off; a path opts in). See the columns in db.ts.
  const finalVersionFile = normalizeOverride("version_file", versionFile);
  const finalChangelogPath = normalizeOverride("changelog_path", changelogPath);

  // Provision the herdr workspace (best effort — workspace still usable if the
  // herdr server is briefly down; dispatch will retry).
  let workspaceId: string | null = null;
  let paneId: string | null = null;
  try {
    const ws = await herdr.workspaceCreate(path, finalLabel);
    workspaceId = ws.workspaceId ?? null;
    paneId = ws.rootPaneId ?? null;
  } catch (e) {
    throw new HttpError(
      502,
      `failed to create herdr workspace (is the herdr server running?): ${(e as Error).message}`,
    );
  }

  git.ensureGitignore(path);

  // Harden the repo against power-loss object corruption from the moment it's
  // managed: fsync loose-object writes so a crash can't leave a truncated object
  // (the boot self-heal also re-applies this to already-registered repos).
  // Best-effort + idempotent — never blocks registration.
  await git.setGitDurability(path);

  // Seed the CTO context into the (now-gitignored) `.butchr/` folder so every
  // task agent launched here starts with it.
  seedCtoContext(path);

  const id = generateWorkspaceId();
  const created = nowIso();
  db.query(
    `INSERT INTO directory (id, path, label, herdr_workspace, herdr_pane, gate_cmd, version_file, changelog_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, path, finalLabel, workspaceId, paneId,
    finalGateCmd, finalVersionFile, finalChangelogPath, created,
  );

  // UNIFIED CREATE-TIME ROW (story st-93384200, Bug 3): materialize this directory's unified
  // `workspace` cto row NOW so the unified supervisor owns its CTO immediately — no restart
  // needed to re-seed it from the legacy cto_agent table. See ensureCtoWorkspaceRow.
  ensureCtoWorkspaceRow(id);

  const row = getWorkspace(id)!;
  const view: WorkspaceView = { ...row, counts: counts(id) };
  publish({ type: "workspace.created", workspace: view });
  return view;
}

export async function unregisterWorkspace(id: string): Promise<void> {
  const dir = getWorkspace(id);
  if (!dir) throw new HttpError(404, `workspace not found: ${id}`);

  // RACE-PREVENTION (story st-93384200 Bug 2): mark this directory's UNIFIED `workspace`
  // (singular) cto/leader rows desired=0 as the VERY FIRST teardown action — before the
  // legacy stops below close any pane BY NAME. stopWorkspaceAgent writes desired=0
  // SYNCHRONOUSLY (before its first await), so once these have run no unified supervise
  // tick can relaunch a just-closed pane at any point during unregister. Doing it last
  // (right before the DELETE) would instead MAXIMIZE the legacy-close -> DELETE window in
  // which a tick could revive the pane. This is RACE-prevention, NOT leak-prevention: the
  // rows themselves still cascade away on the DELETE below (FK ON DELETE CASCADE, db.ts).
  // Best-effort; never block unregister. No-op when the unified supervisor is gated OFF.
  await stopWorkspaceAgent(`ws-cto-${id}`).catch(() => {});
  const unifiedRows = db
    .query<{ id: string }, [string]>(
      `SELECT id FROM workspace WHERE directory_id=? AND kind IN ('cto','leader')`,
    )
    .all(id);
  for (const r of unifiedRows) {
    await stopWorkspaceAgent(r.id).catch(() => {});
  }

  // Tear down this workspace's managed CTO agent (close its tab/pane + free its name) so
  // the DELETE below — which cascade-removes its cto_agent row — can't strand an orphaned
  // CTO pane. Legacy MIRROR-AND-DEFER path, kept alongside the unified stop above.
  // Best-effort; never block unregister.
  await stopCtoAgent(id).catch(() => {});

  // Likewise tear down every STORY-LEADER agent for this workspace's stories (Phase 3) so
  // no leader pane is orphaned. Their story_agent rows cascade away with the stories (which
  // cascade with the workspace) on the DELETE below. Best-effort; never block unregister.
  await stopWorkspaceStoryAgents(id).catch(() => {});

  // Best effort: clean up any worktrees for non-terminal tasks.
  const tasks = db
    .query<TaskRow, [string]>(`SELECT * FROM tasks WHERE workspace_id=?`)
    .all(id);
  for (const t of tasks) {
    // Close the task's dedicated tab BY NAME (kills its agent + removes the tab); the
    // workspace close below is a backstop, but per-tab teardown keeps things tidy
    // even if the workspace outlives this workspace.
    await herdr.teardownTask(t.id);
    // Skip story Work NODES STRUCTURALLY (B.2): a node has no bare-id worktree/branch to clean,
    // and today it is skipped only because its inert anchor status is 'merged'. The work_kind
    // guard keeps it skipped once B.3 makes node status real, not via that magic value.
    if (t.work_kind !== "node" && t.status !== "merged") {
      await git.cleanup(dir.path, t.id).catch(() => {});
    }
  }

  if (dir.herdr_workspace) {
    await herdr.workspaceClose(dir.herdr_workspace).catch(() => {});
  }

  // Remove the CTO context we seeded on registration, and tidy `.butchr/` if it
  // is now empty. Best-effort: never let cleanup break unregister.
  try {
    const cto = ctoMdPath(dir.path);
    if (existsSync(cto)) rmSync(cto);
    const butchrDir = join(dir.path, ".butchr");
    if (existsSync(butchrDir) && readdirSync(butchrDir).length === 0) {
      rmSync(butchrDir, { recursive: true });
    }
  } catch {
    // ignore cleanup failures
  }

  db.query(`DELETE FROM directory WHERE id=?`).run(id); // cascades to tasks
  publish({ type: "workspace.deleted", id });
}

// Small typed error carrying an HTTP status, surfaced by the server layer.
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
