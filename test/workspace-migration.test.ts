// Test the IN-PLACE rename migration directories -> workspaces (db.ts
// migrateDirectoriesToWorkspaces). A LIVE pre-rename DB — a `directories` table, a
// `tasks.directory_id` FK column, and a per-workspace `cto_agent.directory_id` — must
// be renamed IN PLACE so every existing row AND its opaque `dir-…` id VALUE survives
// (the running system's registered workspaces, including its own `dir-…` ids, keep
// working). We hand-build the OLD shape on a private connection, seed real rows, run
// the (pure) migration against it, and assert the new shape + row/id preservation.
// Finally we run the migration a SECOND time to prove it is idempotent (a clean no-op
// on an already-migrated DB, never throwing).
//
// The migration is exercised on a STANDALONE Database, not the db.ts singleton, so it
// is independent of which test file bound the shared singleton first.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let db: Database;
let migrate: (database: Database) => void;

// The two opaque legacy ids the running system minted with the old `dir-` prefix —
// they must come through the rename untouched (we never rewrite id VALUES).
const WS_ID = "dir-8b35f904"; // butchr's own workspace, per the task brief
const TASK_ID = "swift-falcon-3a2f";

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-ws-migrate-"));
  migrate = (await import("../src/db.ts")).migrateDirectoriesToWorkspaces;

  // Hand-build the OLD pre-rename schema on a private connection: `directories` +
  // `tasks.directory_id` + per-workspace `cto_agent.directory_id`, with foreign keys
  // ON (as the live DB runs them) so the rename has real FK refs to rewrite.
  db = new Database(join(DATA_DIR, "legacy.db"), { create: true });
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE directories (
      id              TEXT PRIMARY KEY,
      path            TEXT UNIQUE NOT NULL,
      label           TEXT,
      herdr_workspace TEXT,
      herdr_pane      TEXT,
      gate_cmd        TEXT,
      cto_enabled     INTEGER,
      created_at      TEXT NOT NULL
    );
    CREATE TABLE tasks (
      id              TEXT PRIMARY KEY,
      directory_id    TEXT NOT NULL REFERENCES directories(id) ON DELETE CASCADE,
      status          TEXT NOT NULL,
      created_at      TEXT NOT NULL
    );
    CREATE INDEX idx_tasks_dir ON tasks(directory_id);
    CREATE TABLE cto_agent (
      directory_id    TEXT PRIMARY KEY REFERENCES directories(id) ON DELETE CASCADE,
      session_id      TEXT,
      desired         INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.query(
    `INSERT INTO directories (id, path, label, created_at) VALUES (?, ?, 'butchr', '2026-01-01T00:00:00.000Z')`,
  ).run(WS_ID, join(DATA_DIR, "repo"));
  db.query(
    `INSERT INTO tasks (id, directory_id, status, created_at) VALUES (?, ?, 'merged', '2026-01-02T00:00:00.000Z')`,
  ).run(TASK_ID, WS_ID);
  db.query(
    `INSERT INTO cto_agent (directory_id, session_id, desired) VALUES (?, 'sess-live', 1)`,
  ).run(WS_ID);

  // Run the migration in place (first run).
  migrate(db);
});

afterAll(() => {
  db.close();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

function tableNames(): string[] {
  return db
    .query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type='table'`)
    .all()
    .map((r) => r.name);
}
function columnNames(table: string): string[] {
  return db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);
}

describe("directories → workspaces in-place rename migration", () => {
  test("the table is renamed (workspaces exists, directories is gone)", () => {
    const names = tableNames();
    expect(names).toContain("workspaces");
    expect(names).not.toContain("directories");
  });

  test("tasks.directory_id is renamed to workspace_id (no old column left)", () => {
    const cols = columnNames("tasks");
    expect(cols).toContain("workspace_id");
    expect(cols).not.toContain("directory_id");
  });

  test("cto_agent.directory_id is renamed to workspace_id", () => {
    const cols = columnNames("cto_agent");
    expect(cols).toContain("workspace_id");
    expect(cols).not.toContain("directory_id");
  });

  test("the registered workspace row + its opaque dir- id VALUE survive untouched", () => {
    const row = db
      .query<{ id: string; label: string }, [string]>(`SELECT id, label FROM workspaces WHERE id=?`)
      .get(WS_ID);
    expect(row).not.toBeNull();
    expect(row!.id).toBe(WS_ID); // id VALUE is NOT rewritten — still the legacy dir- key
    expect(row!.label).toBe("butchr");
  });

  test("the task row survives and its workspace_id still points at the dir- id", () => {
    const row = db
      .query<{ id: string; workspace_id: string }, [string]>(
        `SELECT id, workspace_id FROM tasks WHERE id=?`,
      )
      .get(TASK_ID);
    expect(row).not.toBeNull();
    expect(row!.workspace_id).toBe(WS_ID);
  });

  test("the cto_agent row survives and is keyed by the workspace_id", () => {
    const r = db
      .query<{ workspace_id: string; session_id: string; desired: number }, [string]>(
        `SELECT workspace_id, session_id, desired FROM cto_agent WHERE workspace_id=?`,
      )
      .get(WS_ID);
    expect(r?.workspace_id).toBe(WS_ID);
    expect(r?.session_id).toBe("sess-live");
    expect(r?.desired).toBe(1);
  });

  test("the FK was rewired to workspaces — deleting the workspace cascades to its task", () => {
    // Use a throwaway workspace so we don't disturb the preserved rows under test.
    db.query(
      `INSERT INTO workspaces (id, path, label, created_at) VALUES ('dir-cascade', ?, 'c', '2026-01-03T00:00:00.000Z')`,
    ).run(join(DATA_DIR, "repo-c"));
    db.query(
      `INSERT INTO tasks (id, workspace_id, status, created_at) VALUES ('t-cascade', 'dir-cascade', 'merged', '2026-01-03T00:00:00.000Z')`,
    ).run();
    db.query(`DELETE FROM workspaces WHERE id='dir-cascade'`).run();
    const orphan = db
      .query<{ id: string }, []>(`SELECT id FROM tasks WHERE id='t-cascade'`)
      .get();
    expect(orphan).toBeNull(); // cascade fired ⇒ FK references workspaces(id)
  });

  test("running the migration AGAIN is an idempotent no-op (never throws)", () => {
    // On an already-migrated DB every ALTER guard is false, so this must do nothing.
    expect(() => migrate(db)).not.toThrow();
    expect(() => migrate(db)).not.toThrow();
    // State is unchanged: still renamed, and the preserved rows are still there.
    const names = tableNames();
    expect(names).toContain("workspaces");
    expect(names).not.toContain("directories");
    expect(columnNames("tasks")).toContain("workspace_id");
    expect(
      db.query<{ id: string }, [string]>(`SELECT id FROM workspaces WHERE id=?`).get(WS_ID),
    ).not.toBeNull();
  });
});
