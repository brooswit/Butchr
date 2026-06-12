// Workspace service: register/list/unregister workspaces. Each workspace is a
// git repo that maps 1:1 to a herdr workspace.
import { basename, dirname, join, resolve } from "node:path";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { config } from "./config.ts";
import { stopCtoAgent } from "./cto-agent.ts";
import { db, nowIso } from "./db.ts";
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

When requirements are ambiguous or you hit a judgment call, call the **\`ask\`**
MCP tool (provided by the butchr MCP server) instead of guessing. It is
non-blocking: it records your question and returns immediately, after which you
should STOP and exit — butchr will re-launch you in the same session once it's
answered. Keep your questions specific and actionable.

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
      `SELECT status, COUNT(*) AS n FROM tasks WHERE workspace_id=? GROUP BY status`,
    )
    .all(workspaceId);
  // One bucket per canonical status (see db.STATE_META), plus the orthogonal `idle`
  // pseudo-bucket (a flag on a LIVE in_progress agent, peeled out below).
  const out: Record<string, number> = {
    idea: 0, spec_review: 0, blocked: 0, needs_info: 0, inactive: 0, in_progress: 0, idle: 0,
    in_review: 0, rolling_back: 0, rolled_back: 0, merged: 0, failed: 0, aborted: 0,
  };
  for (const r of rows) out[r.status] = r.n;
  // `idle` is a flag on a LIVE build agent (in_progress with a pane), not a status —
  // peel it out of the in_progress count so the dashboard shows active vs. quiet agents.
  const idle = db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM tasks WHERE workspace_id=? AND status='in_progress' AND herdr_pane_id IS NOT NULL AND idle=1`,
    )
    .get(workspaceId)!.n;
  out.idle = idle;
  out.in_progress -= idle;
  return out;
}

/** Look up a registered workspace by its id, or null if none matches. */
export function getWorkspace(id: string): WorkspaceRow | null {
  return (
    db.query<WorkspaceRow, [string]>(`SELECT * FROM workspaces WHERE id=?`).get(id) ??
    null
  );
}

/** Look up a registered workspace by its absolute filesystem path, or null if none matches. */
export function getWorkspaceByPath(path: string): WorkspaceRow | null {
  return (
    db.query<WorkspaceRow, [string]>(`SELECT * FROM workspaces WHERE path=?`).get(path) ??
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
    `UPDATE workspaces SET herdr_workspace=?, herdr_pane=? WHERE id=?`,
  ).run(ws.workspaceId ?? null, ws.rootPaneId ?? null, workspaceId);
  return { workspaceId: ws.workspaceId, created: true };
}

export function listWorkspaces(): WorkspaceView[] {
  const rows = db
    .query<WorkspaceRow, []>(`SELECT * FROM workspaces ORDER BY created_at ASC`)
    .all();
  return rows.map((d) => ({ ...d, counts: counts(d.id) }));
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
  const dir = getWorkspace(id);
  if (dir && dir.gate_cmd !== null) return dir.gate_cmd;
  return config.verifyCmd;
}

/**
 * Normalize an incoming gate-command value for storage. `undefined`/`null` clears
 * the override (→ NULL → falls back to the default); a string is stored verbatim
 * (the empty string is a deliberate "disable the gate for this workspace" setting,
 * mirroring an empty BUTCHR_VERIFY_CMD). Anything else is a 400.
 */
function normalizeGateCmd(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new HttpError(400, "gate_cmd must be a string (or null to use the default)");
  }
  return value;
}

/**
 * Update (or clear) a workspace's per-workspace build/test gate command and return
 * the refreshed view. Pass `null`/`undefined` to clear the override (revert to the
 * default `config.verifyCmd`); a string (incl. "") sets it. 404 if the workspace is
 * gone. Takes effect on the NEXT gate run for that workspace (the next task entering
 * review, and the next merge's post-merge verify) — nothing in flight is disturbed.
 */
export function updateWorkspaceGateCmd(id: string, gateCmd: unknown): WorkspaceView {
  const dir = getWorkspace(id);
  if (!dir) throw new HttpError(404, `workspace not found: ${id}`);
  const value = normalizeGateCmd(gateCmd);
  db.query(`UPDATE workspaces SET gate_cmd=? WHERE id=?`).run(value, id);
  const view: WorkspaceView = { ...getWorkspace(id)!, counts: counts(id) };
  publish({ type: "workspace.updated", workspace: view });
  return view;
}

/**
 * Set (or clear) a workspace's per-workspace CTO-agent enable and return the refreshed
 * view. `true`/`false` forces the workspace's CTO agent on/off (boot auto-start +
 * supervision); `null`/`undefined` CLEARS the override so it inherits the global
 * default config.ctoAgentEnabled. 404 if the workspace is gone; 400 if the value is
 * neither a boolean nor null. Takes effect on the next boot reconcile / supervision
 * tick (and is reflected immediately in the workspace's CTO status). See
 * cto-agent.isCtoEnabled.
 */
export function setWorkspaceCtoEnabled(id: string, value: unknown): WorkspaceView {
  const dir = getWorkspace(id);
  if (!dir) throw new HttpError(404, `workspace not found: ${id}`);
  let stored: number | null;
  if (value === undefined || value === null) stored = null;
  else if (typeof value === "boolean") stored = value ? 1 : 0;
  else throw new HttpError(400, "cto_enabled must be a boolean (or null to use the default)");
  db.query(`UPDATE workspaces SET cto_enabled=? WHERE id=?`).run(stored, id);
  const view: WorkspaceView = { ...getWorkspace(id)!, counts: counts(id) };
  publish({ type: "workspace.updated", workspace: view });
  return view;
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
 *  - `needsAttention` — what to look at right now (= review + failed).
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
};

export type Dashboard = {
  workspaces: DashboardWorkspace[];
  totals: {
    workspaces: number;
    active: number;
    review: number;
    failed: number;
    needsAttention: number;
  };
};

export function dashboard(): Dashboard {
  const rows = db
    .query<WorkspaceRow, []>(`SELECT * FROM workspaces ORDER BY created_at ASC`)
    .all();
  const totals = { workspaces: rows.length, active: 0, review: 0, failed: 0, needsAttention: 0 };
  const workspaces = rows.map((d) => {
    const c = counts(d.id);
    const active =
      (c.idea ?? 0) + (c.blocked ?? 0) + (c.inactive ?? 0) + (c.in_progress ?? 0) +
      (c.idle ?? 0) + (c.rolling_back ?? 0);
    // FEEDBACK states awaiting a human (kept under the `review` field name).
    const review = (c.spec_review ?? 0) + (c.in_review ?? 0) + (c.needs_info ?? 0);
    const failed = c.failed ?? 0; // the terminal `failed` state — see comment above
    const needsAttention = review + failed;
    totals.active += active;
    totals.review += review;
    totals.failed += failed;
    totals.needsAttention += needsAttention;
    return {
      id: d.id,
      path: d.path,
      label: d.label,
      gate_cmd: d.gate_cmd,
      effective_gate_cmd: d.gate_cmd !== null ? d.gate_cmd : config.verifyCmd,
      counts: c,
      active,
      review,
      failed,
      needsAttention,
    };
  });
  return { workspaces, totals };
}

export async function registerWorkspace(
  rawPath: string,
  label?: string,
  gateCmd?: unknown,
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
  const finalGateCmd = normalizeGateCmd(gateCmd);

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
    `INSERT INTO workspaces (id, path, label, herdr_workspace, herdr_pane, gate_cmd, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, path, finalLabel, workspaceId, paneId, finalGateCmd, created);

  const row = getWorkspace(id)!;
  const view: WorkspaceView = { ...row, counts: counts(id) };
  publish({ type: "workspace.created", workspace: view });
  return view;
}

export async function unregisterWorkspace(id: string): Promise<void> {
  const dir = getWorkspace(id);
  if (!dir) throw new HttpError(404, `workspace not found: ${id}`);

  // Tear down this workspace's managed CTO agent FIRST (close its tab/pane + free its
  // name) so the DELETE below — which cascade-removes its cto_agent row — can't strand
  // an orphaned CTO pane. Best-effort; never block unregister.
  await stopCtoAgent(id).catch(() => {});

  // Best effort: clean up any worktrees for non-terminal tasks.
  const tasks = db
    .query<TaskRow, [string]>(`SELECT * FROM tasks WHERE workspace_id=?`)
    .all(id);
  for (const t of tasks) {
    // Close the task's dedicated tab (kills its agent + removes the tab); the
    // workspace close below is a backstop, but per-tab teardown keeps things tidy
    // even if the workspace outlives this workspace.
    await herdr.teardownTask(t.herdr_tab_id, t.id, t.herdr_pane_id);
    if (t.status !== "merged") {
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

  db.query(`DELETE FROM workspaces WHERE id=?`).run(id); // cascades to tasks
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
