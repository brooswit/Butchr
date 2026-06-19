// WORK + WORKSPACE UNIFICATION — STEP 6c CUTOVER (story st-540ba705): the PHYSICAL,
// BACKWARD-SAFE rename of the directory+config table `workspaces` → `directory`, INVERTING
// step 1's `directory`-VIEW-over-`workspaces`. This proves the two pure boot migrations
// (db.migrateRenameWorkspacesToDirectory + db.migrateWorkspacesView):
//
//   1. RENAME PRESERVES DATA — a hand-built POST-STEP-1 DB (a real `workspaces` table + the
//      step-1 `directory` VIEW over it + child FK tables) is renamed IN PLACE so `directory`
//      becomes the authoritative TABLE and every row + its opaque `dir-…` id VALUE survives
//      (we never rewrite id values). The child FK `REFERENCES workspaces(id)` is auto-rewritten
//      to `directory(id)` by SQLite (legacy_alter_table OFF), so the cascade still fires.
//   2. NEW CODE READS `directory` — the authoritative table holds the rows directly.
//   3. THE `workspaces` VIEW SERVES OLD-SHAPE QUERIES — a `SELECT … FROM workspaces` returns
//      the same rows (the running OLD server keeps READING unchanged).
//   4. THE VIEW IS WRITABLE — every write pattern the old server + the ~80 workspace-writing
//      test files use is redirected to `directory` by the INSTEAD OF triggers: INSERT (partial
//      column list defaulting release_mode/branch_isolation; full list), INSERT OR IGNORE
//      (tolerant on a PK re-insert), UPDATE (incl. an explicit set-to-NULL that MUST persist
//      NULL — the COALESCE is INSERT-only), and DELETE (cascades to children).
//   5. IDEMPOTENT — re-running both migrations is a clean no-op (directory stays the TABLE,
//      workspaces stays the VIEW), never throwing.
//
// The migrations are exercised on a STANDALONE Database (never the live db / the module
// singleton), mirroring test/workspace-migration.test.ts, so the test is independent of which
// test file bound the shared singleton first.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let db: Database;
let rename: (database: Database) => void;
let makeView: (database: Database) => void;

// The opaque legacy id the running system minted with the `dir-` prefix — it must come
// through the rename untouched (we never rewrite id VALUES).
const WS_ID = "dir-8b35f904";
const TASK_ID = "swift-falcon-3a2f";

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-6c-"));
  const mod = await import("../src/db.ts");
  rename = mod.migrateRenameWorkspacesToDirectory;
  makeView = mod.migrateWorkspacesView;

  // Hand-build the POST-STEP-1 shape on a private connection: the real `workspaces` TABLE
  // (full column set, with release_mode/branch_isolation NOT NULL DEFAULT 0), the step-1
  // `directory` VIEW over it, and child FK tables referencing `workspaces(id)` — with FKs ON
  // (as the live DB runs them) so the rename has real FK refs to rewrite + a real cascade.
  db = new Database(join(DATA_DIR, "post-step1.db"), { create: true });
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE workspaces (
      id              TEXT PRIMARY KEY,
      path            TEXT UNIQUE NOT NULL,
      label           TEXT,
      herdr_workspace TEXT,
      herdr_pane      TEXT,
      gate_cmd        TEXT,
      version_file    TEXT,
      changelog_path  TEXT,
      cto_enabled     INTEGER,
      release_mode    INTEGER NOT NULL DEFAULT 0,
      branch_isolation INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL
    );
    CREATE TABLE tasks (
      id              TEXT PRIMARY KEY,
      workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      status          TEXT NOT NULL,
      created_at      TEXT NOT NULL
    );
    CREATE TABLE cto_agent (
      workspace_id    TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
      session_id      TEXT,
      desired         INTEGER NOT NULL DEFAULT 0
    );
    -- step-1 read-only alias (migrateDirectoryAlias), the shape this step INVERTS.
    CREATE VIEW directory AS SELECT * FROM workspaces;
  `);
  db.query(
    `INSERT INTO workspaces (id, path, label, gate_cmd, cto_enabled, release_mode, branch_isolation, created_at)
     VALUES (?, ?, 'butchr', 'bun test', 1, 1, 0, '2026-01-01T00:00:00.000Z')`,
  ).run(WS_ID, join(DATA_DIR, "repo"));
  db.query(
    `INSERT INTO tasks (id, workspace_id, status, created_at) VALUES (?, ?, 'merged', '2026-01-02T00:00:00.000Z')`,
  ).run(TASK_ID, WS_ID);
  db.query(
    `INSERT INTO cto_agent (workspace_id, session_id, desired) VALUES (?, 'sess-live', 1)`,
  ).run(WS_ID);

  // Run the step-6c migrations in place (first run).
  rename(db);
  makeView(db);
});

afterAll(() => {
  db.close();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

function objType(name: string): string | undefined {
  return db
    .query<{ type: string }, [string]>(`SELECT type FROM sqlite_master WHERE name=?`)
    .get(name)?.type;
}

describe("step 6c — workspaces → directory rename preserves data", () => {
  test("directory is now the TABLE and workspaces is now a VIEW", () => {
    expect(objType("directory")).toBe("table");
    expect(objType("workspaces")).toBe("view");
  });

  test("the registered row + its opaque dir- id VALUE survive untouched in `directory`", () => {
    const row = db
      .query<{ id: string; label: string; gate_cmd: string; cto_enabled: number }, [string]>(
        `SELECT id, label, gate_cmd, cto_enabled FROM directory WHERE id=?`,
      )
      .get(WS_ID);
    expect(row).not.toBeNull();
    expect(row!.id).toBe(WS_ID); // id VALUE is NOT rewritten — still the legacy dir- key
    expect(row!.label).toBe("butchr");
    expect(row!.gate_cmd).toBe("bun test");
    expect(row!.cto_enabled).toBe(1);
  });

  test("the FK was rewired to `directory` — deleting the directory row cascades to its task", () => {
    db.query(
      `INSERT INTO directory (id, path, label, created_at) VALUES ('dir-casc1', ?, 'c', '2026-01-03T00:00:00.000Z')`,
    ).run(join(DATA_DIR, "repo-c1"));
    db.query(
      `INSERT INTO tasks (id, workspace_id, status, created_at) VALUES ('t-casc1', 'dir-casc1', 'merged', '2026-01-03T00:00:00.000Z')`,
    ).run();
    db.query(`DELETE FROM directory WHERE id='dir-casc1'`).run();
    expect(
      db.query<{ id: string }, []>(`SELECT id FROM tasks WHERE id='t-casc1'`).get(),
    ).toBeNull(); // cascade fired ⇒ FK references directory(id)
  });
});

describe("step 6c — the `workspaces` VIEW serves old-shape queries (old server READS unchanged)", () => {
  test("SELECT … FROM workspaces returns the same row the table holds", () => {
    const viaView = db
      .query<{ id: string; label: string }, [string]>(
        `SELECT id, label FROM workspaces WHERE id=?`,
      )
      .get(WS_ID);
    expect(viaView).toEqual({ id: WS_ID, label: "butchr" });
  });
});

describe("step 6c — the `workspaces` VIEW is WRITABLE (old server WRITES unchanged)", () => {
  test("INSERT with a PARTIAL column list defaults release_mode/branch_isolation to 0", () => {
    db.query(
      `INSERT INTO workspaces (id, path, label, created_at) VALUES ('dir-ins-a', ?, 'a', '2026-02-01T00:00:00.000Z')`,
    ).run(join(DATA_DIR, "repo-ins-a"));
    const row = db
      .query<{ release_mode: number; branch_isolation: number; gate_cmd: string | null }, []>(
        `SELECT release_mode, branch_isolation, gate_cmd FROM directory WHERE id='dir-ins-a'`,
      )
      .get();
    expect(row).toEqual({ release_mode: 0, branch_isolation: 0, gate_cmd: null });
  });

  test("INSERT with a FULL column list (explicit release_mode/branch_isolation) lands verbatim", () => {
    db.query(
      `INSERT INTO workspaces
         (id, path, label, herdr_workspace, herdr_pane, gate_cmd, version_file, changelog_path, cto_enabled, release_mode, branch_isolation, created_at)
       VALUES ('dir-ins-b', ?, 'b', 'hw', 'hp', 'g', 'package.json', 'CHANGELOG.md', 0, 1, 1, '2026-02-02T00:00:00.000Z')`,
    ).run(join(DATA_DIR, "repo-ins-b"));
    const row = db
      .query<{ release_mode: number; branch_isolation: number; version_file: string }, []>(
        `SELECT release_mode, branch_isolation, version_file FROM directory WHERE id='dir-ins-b'`,
      )
      .get();
    expect(row).toEqual({ release_mode: 1, branch_isolation: 1, version_file: "package.json" });
  });

  test("INSERT OR IGNORE on a duplicate id is tolerant (no throw, original untouched)", () => {
    expect(() =>
      db
        .query(
          `INSERT OR IGNORE INTO workspaces (id, path, label, created_at) VALUES (?, '/somewhere/else', 'CLOBBERED', '2099-01-01T00:00:00.000Z')`,
        )
        .run(WS_ID),
    ).not.toThrow();
    // The original row is unchanged (the duplicate was ignored, not upserted).
    expect(
      db.query<{ label: string }, [string]>(`SELECT label FROM directory WHERE id=?`).get(WS_ID)!.label,
    ).toBe("butchr");
  });

  test("UPDATE through the view writes to `directory`", () => {
    db.query(`UPDATE workspaces SET gate_cmd='changed' WHERE id=?`).run(WS_ID);
    expect(
      db.query<{ gate_cmd: string }, [string]>(`SELECT gate_cmd FROM directory WHERE id=?`).get(WS_ID)!.gate_cmd,
    ).toBe("changed");
  });

  test("UPDATE that explicitly sets a column to NULL PERSISTS NULL (COALESCE is INSERT-only)", () => {
    // cto_enabled starts at 1; an explicit set-to-NULL must persist NULL, NOT be clobbered
    // back to a default by the UPDATE trigger (the steering-note correctness point).
    db.query(`UPDATE workspaces SET cto_enabled=NULL WHERE id=?`).run(WS_ID);
    expect(
      db.query<{ cto_enabled: number | null }, [string]>(`SELECT cto_enabled FROM directory WHERE id=?`).get(WS_ID)!.cto_enabled,
    ).toBeNull();
    // And a nullable string column likewise round-trips an explicit NULL.
    db.query(`UPDATE workspaces SET gate_cmd=NULL WHERE id=?`).run(WS_ID);
    expect(
      db.query<{ gate_cmd: string | null }, [string]>(`SELECT gate_cmd FROM directory WHERE id=?`).get(WS_ID)!.gate_cmd,
    ).toBeNull();
  });

  test("DELETE through the view removes the directory row and cascades to children", () => {
    db.query(
      `INSERT INTO workspaces (id, path, label, created_at) VALUES ('dir-casc2', ?, 'c2', '2026-03-01T00:00:00.000Z')`,
    ).run(join(DATA_DIR, "repo-casc2"));
    db.query(
      `INSERT INTO tasks (id, workspace_id, status, created_at) VALUES ('t-casc2', 'dir-casc2', 'merged', '2026-03-01T00:00:00.000Z')`,
    ).run();
    db.query(`DELETE FROM workspaces WHERE id='dir-casc2'`).run();
    expect(
      db.query<{ id: string }, []>(`SELECT id FROM directory WHERE id='dir-casc2'`).get(),
    ).toBeNull();
    expect(
      db.query<{ id: string }, []>(`SELECT id FROM tasks WHERE id='t-casc2'`).get(),
    ).toBeNull(); // cascade via the view's INSTEAD OF DELETE → DELETE FROM directory
  });
});

describe("step 6c — the migrations are idempotent", () => {
  test("re-running rename + view is a clean no-op (never throws; shapes stable)", () => {
    expect(() => {
      rename(db);
      makeView(db);
      rename(db);
      makeView(db);
    }).not.toThrow();
    expect(objType("directory")).toBe("table");
    expect(objType("workspaces")).toBe("view");
    // The preserved row is still addressable by both names.
    expect(
      db.query<{ id: string }, [string]>(`SELECT id FROM directory WHERE id=?`).get(WS_ID),
    ).not.toBeNull();
    expect(
      db.query<{ id: string }, [string]>(`SELECT id FROM workspaces WHERE id=?`).get(WS_ID),
    ).not.toBeNull();
  });
});
