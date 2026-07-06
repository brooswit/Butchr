// REVAMP-2 Phase B.5b INCIDENT REGRESSION (story st-78a8b4e7). The first B.5b live flip
// crash-looped: migrateDropStoriesMirror's table-rebuild turned the `workspaces` back-compat
// VIEW into a TABLE, so the next boot's migrateWorkspacesView `DROP VIEW IF EXISTS workspaces`
// threw "use DROP TABLE to delete table workspaces" → unbootable. These guard the two fixes:
//   (A) migrateWorkspacesView SELF-HEALS a stray `workspaces` TABLE back into the view.
//   (B) migrateDropStoriesMirror leaves `workspaces` a VIEW (legacy_alter_table ON around the
//       rebuild so ALTER never materializes the view).
//
// Isolated DB (BUTCHR_DB set before importing db.ts, which migrates at import). The db/config
// singletons are shared across files, so we assert only on schema-object types (global to the db)
// after driving the migration primitives directly — no per-workspace row coupling.
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dbMod: typeof import("../src/db.ts");

const wsType = (): string | undefined =>
  dbMod.db
    .query<{ type: string }, []>(`SELECT type FROM sqlite_master WHERE name='workspaces'`)
    .get()?.type;
const hasTable = (n: string): boolean =>
  dbMod.db.query(`SELECT name FROM sqlite_master WHERE name=?`).all(n).length > 0;
const tasksHasStoryId = (): boolean =>
  dbMod.db.query(`PRAGMA table_info(tasks)`).all().some((c: any) => c.name === "story_id");

beforeAll(async () => {
  const DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-b5b-wsview-"));
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";
  dbMod = await import("../src/db.ts");
});

describe("B.5b incident: the workspaces back-compat view survives / self-heals", () => {
  test("FIX A — migrateWorkspacesView recovers a stray `workspaces` TABLE into the view (no crash)", () => {
    // Reproduce the corrupt state the failed flip left: workspaces is a TABLE, not a view.
    dbMod.db.exec(`DROP TRIGGER IF EXISTS workspaces_view_insert`);
    dbMod.db.exec(`DROP TRIGGER IF EXISTS workspaces_view_update`);
    dbMod.db.exec(`DROP TRIGGER IF EXISTS workspaces_view_delete`);
    dbMod.db.exec(`DROP VIEW IF EXISTS workspaces`);
    dbMod.db.exec(`CREATE TABLE workspaces (id TEXT)`);
    expect(wsType()).toBe("table");

    // The old code did a bare `DROP VIEW IF EXISTS workspaces` here → threw on a table → crash-loop.
    expect(() => dbMod.migrateWorkspacesView(dbMod.db)).not.toThrow();
    expect(wsType()).toBe("view");
  });

  test("FIX B — migrateDropStoriesMirror leaves `workspaces` a VIEW while dropping the mirror", () => {
    // db.ts already migrated at import (post-drop: no stories, no tasks.story_id, workspaces=view).
    // Re-arm a pre-drop shape so the drop migration runs its FULL rebuild WITH the view present —
    // the exact path that materialized the view into a table on the live flip.
    expect(wsType()).toBe("view");
    if (!hasTable("stories")) {
      dbMod.db.exec(
        `CREATE TABLE stories (id TEXT PRIMARY KEY, workspace_id TEXT, brief TEXT, status TEXT,
           created_at TEXT, isolated INTEGER, pending_ask TEXT, ask_responder TEXT)`,
      );
    }
    if (!tasksHasStoryId()) dbMod.db.exec(`ALTER TABLE tasks ADD COLUMN story_id TEXT`);

    expect(() => dbMod.migrateDropStoriesMirror()).not.toThrow();

    // The rebuild must NOT have materialized the view into a table, and the mirror is gone.
    expect(wsType()).toBe("view");
    expect(hasTable("stories")).toBe(false);
    expect(tasksHasStoryId()).toBe(false);
    // legacy_alter_table must be restored to its default (0) after the migration.
    expect((dbMod.db.query(`PRAGMA legacy_alter_table`).get() as any).legacy_alter_table).toBe(0);
    // foreign_keys re-enabled.
    expect((dbMod.db.query(`PRAGMA foreign_keys`).get() as any).foreign_keys).toBe(1);
  });
});
