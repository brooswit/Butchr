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
import { db, nowIso } from "./db.ts";
import type { DirectoryRow, TaskRow } from "./db.ts";
import { publish } from "./events.ts";
import * as git from "./git.ts";
import * as herdr from "./herdr.ts";
import { generateDirectoryId } from "./ids.ts";
import { ctoMdPath } from "./taskmd.ts";

// Default CTO context seeded into a freshly registered directory's
// `.butchr/CTO.md`. Kept short and editable; surfaced to every agent by
// renderAgentPrompt (which adds the `# CTO context` heading above it).
const DEFAULT_CTO_CONTEXT = `A CTO — the human's principal engineer (the Claude running in the project
root) — is available for guidance on this work.

When requirements are ambiguous or you hit a judgment call, call the **\`ask\`**
MCP tool (provided by the butchr MCP server) to consult the CTO before
guessing. Keep your questions specific and actionable.

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
  const out: Record<string, number> = {
    queued: 0, running: 0, idle: 0, review: 0, finalizing: 0, merged: 0, rejected: 0, aborted: 0,
  };
  for (const r of rows) out[r.status] = r.n;
  // `idle` is a flag on running tasks, not a status — peel it out of the running
  // count so the dashboard shows active vs. quiet agents separately.
  const idle = db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM tasks WHERE directory_id=? AND status='running' AND idle=1`,
    )
    .get(directoryId)!.n;
  out.idle = idle;
  out.running -= idle;
  return out;
}

export function getDirectory(id: string): DirectoryRow | null {
  return (
    db.query<DirectoryRow, [string]>(`SELECT * FROM directories WHERE id=?`).get(id) ??
    null
  );
}

export function getDirectoryByPath(path: string): DirectoryRow | null {
  return (
    db.query<DirectoryRow, [string]>(`SELECT * FROM directories WHERE path=?`).get(path) ??
    null
  );
}

export function listDirectories(): DirectoryView[] {
  const rows = db
    .query<DirectoryRow, []>(`SELECT * FROM directories ORDER BY created_at ASC`)
    .all();
  return rows.map((d) => ({ ...d, counts: counts(d.id) }));
}

export async function registerDirectory(
  rawPath: string,
  label?: string,
): Promise<DirectoryView> {
  const path = resolve(rawPath);

  if (!(await git.isGitRepo(path))) {
    throw new HttpError(400, `not a git repository: ${path}`);
  }
  if (getDirectoryByPath(path)) {
    throw new HttpError(409, `directory already registered: ${path}`);
  }

  const finalLabel = label?.trim() || basename(path);

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
    `INSERT INTO directories (id, path, label, herdr_workspace, herdr_pane, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, path, finalLabel, workspaceId, paneId, created);

  const row = getDirectory(id)!;
  const view: DirectoryView = { ...row, counts: counts(id) };
  publish({ type: "directory.created", directory: view });
  return view;
}

export async function unregisterDirectory(id: string): Promise<void> {
  const dir = getDirectory(id);
  if (!dir) throw new HttpError(404, `directory not found: ${id}`);

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
