// Directory service: register/list/unregister directories. Each directory is a
// git repo that maps 1:1 to a herdr workspace.
import { resolve } from "node:path";
import { basename } from "node:path";
import { db, nowIso } from "./db.ts";
import type { DirectoryRow, TaskRow } from "./db.ts";
import { publish } from "./events.ts";
import * as git from "./git.ts";
import * as herdr from "./herdr.ts";
import { generateDirectoryId } from "./ids.ts";

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
    queued: 0, running: 0, review: 0, merged: 0, rejected: 0, aborted: 0,
  };
  for (const r of rows) out[r.status] = r.n;
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
    if (t.herdr_pane_id) await herdr.paneClose(t.herdr_pane_id).catch(() => {});
    if (t.status !== "merged") {
      await git.cleanup(dir.path, t.id).catch(() => {});
    }
  }

  if (dir.herdr_workspace) {
    await herdr.workspaceClose(dir.herdr_workspace).catch(() => {});
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
