// SQLite state. Per the spec, SQLite tracks only runtime state — task.md on
// disk is the source of truth for prompt/metadata. Everything here is derivable
// or re-syncable from the filesystem.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.ts";

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath, { create: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS directories (
  id              TEXT PRIMARY KEY,
  path            TEXT UNIQUE NOT NULL,
  label           TEXT,
  herdr_workspace TEXT,
  herdr_pane      TEXT,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  directory_id    TEXT NOT NULL REFERENCES directories(id) ON DELETE CASCADE,
  status          TEXT NOT NULL,            -- queued | running | review | merged | rejected
  herdr_pane_id   TEXT,
  output_snapshot TEXT,
  conflict        INTEGER NOT NULL DEFAULT 0,
  review_note     TEXT,
  created_at      TEXT NOT NULL,
  started_at      TEXT,
  completed_at    TEXT,
  merged_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_dir    ON tasks(directory_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
`);

export type DirectoryRow = {
  id: string;
  path: string;
  label: string | null;
  herdr_workspace: string | null;
  herdr_pane: string | null;
  created_at: string;
};

export type TaskStatus = "queued" | "running" | "review" | "merged" | "rejected";

export type TaskRow = {
  id: string;
  directory_id: string;
  status: TaskStatus;
  herdr_pane_id: string | null;
  output_snapshot: string | null;
  conflict: number;
  review_note: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  merged_at: string | null;
};

export function nowIso(): string {
  return new Date().toISOString();
}

// On startup, any task left in `running` (e.g. service was killed mid-flight)
// has lost its watcher. Demote it back to queued so the dispatcher re-runs it.
export function recoverRunningTasks(): number {
  const res = db
    .query(
      `UPDATE tasks SET status='queued', herdr_pane_id=NULL WHERE status='running'`,
    )
    .run();
  return res.changes;
}
