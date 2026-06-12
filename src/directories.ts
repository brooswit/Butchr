// Directory service: register/list/unregister directories. Each directory is a
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
import type { DirectoryRow, TaskRow } from "./db.ts";
import { publish } from "./events.ts";
import * as git from "./git.ts";
import { harness } from "./harness.ts";
import * as herdr from "./herdr.ts";
import { generateDirectoryId } from "./ids.ts";
import { ctoMdPath } from "./taskmd.ts";

// Default CTO context seeded into a freshly registered directory's
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

export type DirectoryView = DirectoryRow & {
  counts: Record<string, number>;
};

function counts(directoryId: string): Record<string, number> {
  const rows = db
    .query<{ status: string; n: number }, [string]>(
      `SELECT status, COUNT(*) AS n FROM tasks WHERE directory_id=? GROUP BY status`,
    )
    .all(directoryId);
  // One bucket per canonical status (see db.STATE_META), plus the orthogonal `idle`
  // pseudo-bucket (a flag on a LIVE in_progress agent, peeled out below).
  const out: Record<string, number> = {
    idea: 0, spec_review: 0, blocked: 0, needs_info: 0, in_progress: 0, idle: 0,
    in_review: 0, finalizing: 0, merged: 0, aborted: 0,
  };
  for (const r of rows) out[r.status] = r.n;
  // `idle` is a flag on a LIVE build agent (in_progress with a pane), not a status —
  // peel it out of the in_progress count so the dashboard shows active vs. quiet agents.
  const idle = db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM tasks WHERE directory_id=? AND status='in_progress' AND herdr_pane_id IS NOT NULL AND idle=1`,
    )
    .get(directoryId)!.n;
  out.idle = idle;
  out.in_progress -= idle;
  return out;
}

/** Look up a registered directory by its id, or null if none matches. */
export function getDirectory(id: string): DirectoryRow | null {
  return (
    db.query<DirectoryRow, [string]>(`SELECT * FROM directories WHERE id=?`).get(id) ??
    null
  );
}

/** Look up a registered directory by its absolute filesystem path, or null if none matches. */
export function getDirectoryByPath(path: string): DirectoryRow | null {
  return (
    db.query<DirectoryRow, [string]>(`SELECT * FROM directories WHERE path=?`).get(path) ??
    null
  );
}

export type WorkspaceHeal = { workspaceId: string | undefined; created: boolean };

// In-flight workspace create/heal keyed by directory id. BOTH callers that heal a
// directory's workspace — the dispatcher (task agents) and the managed CTO agent —
// funnel through this ONE map, so a CTO (re)launch and a task dispatch both racing the
// SAME directory's closed/restarted herdr workspace can no longer each see
// workspaceExists=false and double-create (the second persist UPDATE would clobber the
// first, orphaning a workspace). The FIRST caller runs the heal; concurrent callers
// await its result. The entry is cleared once the heal settles, so a LATER heal (a
// subsequent close/restart) starts fresh.
const workspaceInFlight = new Map<string, Promise<WorkspaceHeal>>();

/**
 * Ensure the directory's herdr workspace exists, recreating it (and persisting the
 * new ids on the directory row) when herdr was restarted or the workspace was closed
 * out from under us. The single existence-check + create + row UPDATE both the
 * dispatcher (task agents) and the managed CTO agent funnel through — one workspace
 * per directory backs both — and the in-flight dedupe lives HERE (not in any one
 * caller) so EVERY path collapses to exactly one create per directory under
 * concurrency. Goes through the swappable `harness` runner so a test-injected fake
 * backend is honored.
 *
 * Returns the workspace id and whether a fresh one was `created` (vs the existing one
 * being reused) so the caller can do its own create-only bookkeeping (the dispatcher
 * logs + mutates its in-memory DirectoryRow; the CTO agent does neither). The single
 * underlying create is owned by — and reported `created: true` to — the FIRST caller;
 * concurrent callers that merely await that in-flight heal get the same workspace id
 * with `created: false`, so the create-only bookkeeping runs exactly once no matter how
 * many race.
 */
export async function ensureDirectoryWorkspace(
  directoryId: string,
  cwd: string,
  label: string,
): Promise<WorkspaceHeal> {
  const existing = workspaceInFlight.get(directoryId);
  if (existing) {
    // An awaiter: share the in-flight heal's workspace id, but never re-claim the
    // create — the initiator owns it (and its create-only bookkeeping).
    const { workspaceId } = await existing;
    return { workspaceId, created: false };
  }
  const p = healDirectoryWorkspace(directoryId, cwd, label).finally(() =>
    workspaceInFlight.delete(directoryId),
  );
  workspaceInFlight.set(directoryId, p);
  return p;
}

// The actual existence-check + create + row UPDATE, run once per in-flight heal (see
// ensureDirectoryWorkspace's dedupe). Reuses the recorded workspace when it still
// exists; otherwise creates a fresh one and persists its ids on the directory row.
async function healDirectoryWorkspace(
  directoryId: string,
  cwd: string,
  label: string,
): Promise<WorkspaceHeal> {
  const existing = getDirectory(directoryId)?.herdr_workspace ?? null;
  if (existing && (await harness.workspaceExists(existing))) {
    return { workspaceId: existing, created: false };
  }
  const ws = await harness.workspaceCreate(cwd, label);
  db.query(
    `UPDATE directories SET herdr_workspace=?, herdr_pane=? WHERE id=?`,
  ).run(ws.workspaceId ?? null, ws.rootPaneId ?? null, directoryId);
  return { workspaceId: ws.workspaceId, created: true };
}

export function listDirectories(): DirectoryView[] {
  const rows = db
    .query<DirectoryRow, []>(`SELECT * FROM directories ORDER BY created_at ASC`)
    .all();
  return rows.map((d) => ({ ...d, counts: counts(d.id) }));
}

/**
 * The EFFECTIVE build/test gate command for a directory: its own `gate_cmd` if it
 * set one (a non-null value, including the empty string which DISABLES the gate),
 * else the global default `config.verifyCmd` (EMPTY by default — no gate — unless
 * set via BUTCHR_VERIFY_CMD). This is the single resolution point for BOTH gates — the in-worktree CI
 * gate (tasks.triggerCi) and the post-merge verify gate (verify.verifyDefaultBranch)
 * — so a directory's command can never diverge between them. An unknown id falls
 * back to the default. Pure read of the directory row + config.
 */
export function directoryGateCmd(id: string): string {
  const dir = getDirectory(id);
  if (dir && dir.gate_cmd !== null) return dir.gate_cmd;
  return config.verifyCmd;
}

/**
 * Normalize an incoming gate-command value for storage. `undefined`/`null` clears
 * the override (→ NULL → falls back to the default); a string is stored verbatim
 * (the empty string is a deliberate "disable the gate for this directory" setting,
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
 * Update (or clear) a directory's per-directory build/test gate command and return
 * the refreshed view. Pass `null`/`undefined` to clear the override (revert to the
 * default `config.verifyCmd`); a string (incl. "") sets it. 404 if the directory is
 * gone. Takes effect on the NEXT gate run for that directory (the next task entering
 * review, and the next merge's post-merge verify) — nothing in flight is disturbed.
 */
export function updateDirectoryGateCmd(id: string, gateCmd: unknown): DirectoryView {
  const dir = getDirectory(id);
  if (!dir) throw new HttpError(404, `directory not found: ${id}`);
  const value = normalizeGateCmd(gateCmd);
  db.query(`UPDATE directories SET gate_cmd=? WHERE id=?`).run(value, id);
  const view: DirectoryView = { ...getDirectory(id)!, counts: counts(id) };
  publish({ type: "directory.updated", directory: view });
  return view;
}

/**
 * Set (or clear) a directory's per-directory CTO-agent enable and return the refreshed
 * view. `true`/`false` forces the directory's CTO agent on/off (boot auto-start +
 * supervision); `null`/`undefined` CLEARS the override so it inherits the global
 * default config.ctoAgentEnabled. 404 if the directory is gone; 400 if the value is
 * neither a boolean nor null. Takes effect on the next boot reconcile / supervision
 * tick (and is reflected immediately in the directory's CTO status). See
 * cto-agent.isCtoEnabled.
 */
export function setDirectoryCtoEnabled(id: string, value: unknown): DirectoryView {
  const dir = getDirectory(id);
  if (!dir) throw new HttpError(404, `directory not found: ${id}`);
  let stored: number | null;
  if (value === undefined || value === null) stored = null;
  else if (typeof value === "boolean") stored = value ? 1 : 0;
  else throw new HttpError(400, "cto_enabled must be a boolean (or null to use the default)");
  db.query(`UPDATE directories SET cto_enabled=? WHERE id=?`).run(stored, id);
  const view: DirectoryView = { ...getDirectory(id)!, counts: counts(id) };
  publish({ type: "directory.updated", directory: view });
  return view;
}

/**
 * Per-directory needs-attention rollup, the projection behind the cross-project
 * DASHBOARD (GET /api/dashboard). For every registered directory it folds the
 * per-status `counts` into the four operator-facing buckets the dashboard surfaces,
 * plus the directory's effective gate command, and accumulates a `totals` row. The
 * buckets (a task can fall in more than one — `needsAttention` is the operator
 * pull-signal, deliberately overlapping `review`/`failed`, matching /health):
 *  - `active`         — in-flight work needing no human (idle/agent, non-feedback):
 *                       idea + blocked + in_progress + idle + finalizing.
 *  - `review`         — FEEDBACK states awaiting a human: spec_review + in_review +
 *                       needs_info (kept under the `review` field name for the API).
 *  - `failed`         — retained field; always 0 (the canonical model has no `failed`
 *                       state — a dispatch/finalize give-up or revert lands in `aborted`).
 *  - `needsAttention` — what to look at right now (= review).
 */
export type DashboardDirectory = {
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
  directories: DashboardDirectory[];
  totals: {
    directories: number;
    active: number;
    review: number;
    failed: number;
    needsAttention: number;
  };
};

export function dashboard(): Dashboard {
  const rows = db
    .query<DirectoryRow, []>(`SELECT * FROM directories ORDER BY created_at ASC`)
    .all();
  const totals = { directories: rows.length, active: 0, review: 0, failed: 0, needsAttention: 0 };
  const directories = rows.map((d) => {
    const c = counts(d.id);
    const active =
      (c.idea ?? 0) + (c.blocked ?? 0) + (c.in_progress ?? 0) + (c.idle ?? 0) + (c.finalizing ?? 0);
    // FEEDBACK states awaiting a human (kept under the `review` field name).
    const review = (c.spec_review ?? 0) + (c.in_review ?? 0) + (c.needs_info ?? 0);
    const failed = 0; // no `failed` state in the canonical model — see comment above
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
  return { directories, totals };
}

export async function registerDirectory(
  rawPath: string,
  label?: string,
  gateCmd?: unknown,
): Promise<DirectoryView> {
  const path = resolve(rawPath);

  if (!(await git.isGitRepo(path))) {
    throw new HttpError(400, `not a git repository: ${path}`);
  }
  if (getDirectoryByPath(path)) {
    throw new HttpError(409, `directory already registered: ${path}`);
  }

  const finalLabel = label?.trim() || basename(path);
  // Optional per-directory build/test gate command, set at register time (NULL =
  // use the default config.verifyCmd; "" = disable the gate for this directory).
  const finalGateCmd = normalizeGateCmd(gateCmd);

  // Provision the herdr workspace (best effort — directory still usable if the
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

  // Seed the CTO context into the (now-gitignored) `.butchr/` folder so every
  // task agent launched here starts with it.
  seedCtoContext(path);

  const id = generateDirectoryId();
  const created = nowIso();
  db.query(
    `INSERT INTO directories (id, path, label, herdr_workspace, herdr_pane, gate_cmd, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, path, finalLabel, workspaceId, paneId, finalGateCmd, created);

  const row = getDirectory(id)!;
  const view: DirectoryView = { ...row, counts: counts(id) };
  publish({ type: "directory.created", directory: view });
  return view;
}

export async function unregisterDirectory(id: string): Promise<void> {
  const dir = getDirectory(id);
  if (!dir) throw new HttpError(404, `directory not found: ${id}`);

  // Tear down this directory's managed CTO agent FIRST (close its tab/pane + free its
  // name) so the DELETE below — which cascade-removes its cto_agent row — can't strand
  // an orphaned CTO pane. Best-effort; never block unregister.
  await stopCtoAgent(id).catch(() => {});

  // Best effort: clean up any worktrees for non-terminal tasks.
  const tasks = db
    .query<TaskRow, [string]>(`SELECT * FROM tasks WHERE directory_id=?`)
    .all(id);
  for (const t of tasks) {
    // Close the task's dedicated tab (kills its agent + removes the tab); the
    // workspace close below is a backstop, but per-tab teardown keeps things tidy
    // even if the workspace outlives this directory.
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

  db.query(`DELETE FROM directories WHERE id=?`).run(id); // cascades to tasks
  publish({ type: "directory.deleted", id });
}

// Small typed error carrying an HTTP status, surfaced by the server layer.
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
