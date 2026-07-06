// REVAMP-4 Phase 0 / S0c — the workspace.kind CHECK-widening table REBUILD
// (db.migrateWidenWorkspaceKindCheck). SQLite cannot ALTER a column CHECK in place, so widening
// it to admit the new 'ceo' supervisor kind is a full table rebuild following
// migrateDropStoriesMirror's procedure. The single HIGHEST-RISK operation in the subtask is the
// same class that crash-looped B.5b — a rebuild that MATERIALIZED the `workspaces` back-compat
// VIEW into a TABLE and crash-looped boot. This test proves:
//   - an EXISTING db born with the NARROW 3-kind CHECK is rebuilt to admit 'ceo';
//   - pre-existing rows SURVIVE the rebuild (no data loss);
//   - the `workspaces` compat VIEW SURVIVES as a VIEW (never a table) and stays selectable;
//   - the migration is IDEMPOTENT (a clean no-op once the CHECK contains 'ceo');
//   - a full runMigrations() re-run stays a clean no-op.
//
// migrateWidenWorkspaceKindCheck operates on the db.ts SINGLETON (not a passed-in Database), so we
// bind the singleton to a private temp DB, hand-rebuild the workspace table with the OLD narrow
// CHECK to simulate a pre-S0c db, then drive the real migration and assert.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let dbMod: typeof import("../src/db.ts");

const DIR = "dir-ceomig1";

/** The workspace table's live CREATE SQL from sqlite_master, or null. */
function workspaceSql(): string | null {
  return (
    dbMod.db
      .query<{ sql: string }, []>(`SELECT sql FROM sqlite_master WHERE type='table' AND name='workspace'`)
      .get()?.sql ?? null
  );
}

/** The schema OBJECT TYPE registered under a name ('table' | 'view' | undefined). */
function objectType(name: string): string | undefined {
  return dbMod.db
    .query<{ type: string }, [string]>(`SELECT type FROM sqlite_master WHERE name=?`)
    .get(name)?.type;
}

/** Rebuild `workspace` with the OLD narrow 3-kind CHECK (all 18 live columns) to simulate pre-S0c. */
function installNarrowWorkspaceTable(): void {
  const db = dbMod.db;
  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec("DROP TABLE IF EXISTS workspace;");
  db.exec(`
    CREATE TABLE workspace (
      id              TEXT PRIMARY KEY,
      name            TEXT,
      kind            TEXT NOT NULL CHECK (kind IN ('cto','leader','build')),
      directory_id    TEXT REFERENCES "directory"(id) ON DELETE CASCADE,
      work_id         TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      session_id      TEXT,
      desired         INTEGER NOT NULL DEFAULT 0,
      started_at      TEXT,
      restarts        INTEGER NOT NULL DEFAULT 0,
      last_error      TEXT,
      has_agent       INTEGER NOT NULL DEFAULT 0,
      idle            INTEGER NOT NULL DEFAULT 0,
      idle_context    TEXT,
      herdr_workspace TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT,
      gave_up         INTEGER NOT NULL DEFAULT 0,
      idle_escalated_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_dir  ON workspace(directory_id);
    CREATE INDEX IF NOT EXISTS idx_workspace_work ON workspace(work_id);
  `);
  db.exec("PRAGMA foreign_keys = ON;");
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-ceomig-"));
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  dbMod = await import("../src/db.ts");

  // Seed a directory (FK target for workspace.directory_id via the `workspaces` compat view) and a
  // task (FK target for work_id), so the rows we insert are FK-valid under `PRAGMA foreign_keys=ON`.
  dbMod.db
    .query(
      `INSERT OR IGNORE INTO workspaces (id, path, label, herdr_workspace, herdr_pane, created_at)
       VALUES (?, ?, ?, NULL, NULL, ?)`,
    )
    .run(DIR, join(DATA_DIR, "repo"), "ceomig", dbMod.nowIso());
  dbMod.db
    .query(`INSERT OR IGNORE INTO tasks (id, workspace_id, status, created_at) VALUES (?, ?, 'inactive', ?)`)
    .run("proj-node-1", DIR, dbMod.nowIso());
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("migrateWidenWorkspaceKindCheck (S0c CHECK widen)", () => {
  test("rebuilds a narrow-CHECK table to admit 'ceo', preserving rows AND the workspaces view", () => {
    const db = dbMod.db;
    installNarrowWorkspaceTable();

    // Seed one row per existing kind so we can prove survival across the rebuild.
    db.query(`INSERT INTO workspace (id, kind, directory_id, created_at) VALUES (?, 'cto', ?, ?)`)
      .run("ws-cto-x", DIR, dbMod.nowIso());
    db.query(`INSERT INTO workspace (id, kind, directory_id, work_id, created_at) VALUES (?, 'leader', ?, ?, ?)`)
      .run("ws-leader-x", DIR, "proj-node-1", dbMod.nowIso());
    db.query(`INSERT INTO workspace (id, kind, work_id, created_at) VALUES (?, 'build', ?, ?)`)
      .run("ws-build-x", "proj-node-1", dbMod.nowIso());

    // PRECONDITIONS: the narrow CHECK REJECTS 'ceo', and `workspaces` is a VIEW.
    expect(workspaceSql()).not.toContain("'ceo'");
    expect(() =>
      db.query(`INSERT INTO workspace (id, kind, created_at) VALUES ('ws-ceo-x', 'ceo', ?)`).run(dbMod.nowIso()),
    ).toThrow();
    expect(objectType("workspaces")).toBe("view");

    // RUN the migration.
    dbMod.migrateWidenWorkspaceKindCheck();

    // The CHECK now admits 'ceo'.
    expect(workspaceSql()).toContain("'ceo'");
    // Pre-existing rows survived the rebuild (same 3 rows, unchanged ids/kinds).
    const rows = db
      .query<{ id: string; kind: string }, []>(`SELECT id, kind FROM workspace ORDER BY id`)
      .all();
    expect(rows).toEqual([
      { id: "ws-build-x", kind: "build" },
      { id: "ws-cto-x", kind: "cto" },
      { id: "ws-leader-x", kind: "leader" },
    ]);
    // A 'ceo' insert now SUCCEEDS.
    db.query(`INSERT INTO workspace (id, kind, work_id, created_at) VALUES ('ws-ceo-x', 'ceo', ?, ?)`)
      .run("proj-node-1", dbMod.nowIso());
    expect(db.query(`SELECT kind FROM workspace WHERE id='ws-ceo-x'`).get()).toEqual({ kind: "ceo" });

    // B.5b REGRESSION GUARD: the `workspaces` compat VIEW survived AS A VIEW (never materialized to
    // a table) and is still SELECTABLE.
    expect(objectType("workspaces")).toBe("view");
    expect(() => db.query(`SELECT * FROM workspaces`).all()).not.toThrow();
    // Its INSTEAD OF triggers are back too (the writable compat surface).
    expect(objectType("workspaces_view_insert")).toBe("trigger");

    // The two indexes were recreated.
    const idx = db
      .query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='workspace'`)
      .all()
      .map((r) => r.name);
    expect(idx).toContain("idx_workspace_dir");
    expect(idx).toContain("idx_workspace_work");
  });

  test("is idempotent — a second call is a clean no-op (view still a view, ceo still allowed)", () => {
    const before = workspaceSql();
    expect(before).toContain("'ceo'");
    // Second call must NOT rebuild (guarded on the CHECK already containing 'ceo').
    dbMod.migrateWidenWorkspaceKindCheck();
    expect(workspaceSql()).toBe(before);
    expect(objectType("workspaces")).toBe("view");
  });

  test("a full runMigrations() re-run stays a clean no-op (whole boot pass green)", () => {
    expect(() => dbMod.runMigrations()).not.toThrow();
    const outcome = dbMod.getLastMigrationOutcome();
    expect(outcome.ok).toBe(true);
    expect(outcome.error).toBeNull();
    // Still converged: ceo admitted, view intact.
    expect(workspaceSql()).toContain("'ceo'");
    expect(objectType("workspaces")).toBe("view");
  });
});
