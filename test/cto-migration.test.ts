// Test the SINGLETON → PER-DIRECTORY migration for the managed CTO agent (db.ts
// migrateCtoAgentPerDirectory). An existing DB whose `cto_agent` table is the OLD
// singleton shape (PK `id`, one row keyed 'singleton') must be migrated forward to a
// table keyed by directory_id with a FK cascade — pre-1.0, the old singleton row is
// destroyed freely. We build an old-shape DB by hand, then import db.ts pointed at it
// so its module-load migration runs, and assert the new shape + behavior.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let DB_PATH: string;
let dbMod: typeof import("../src/db.ts");

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-cto-migrate-"));
  DB_PATH = join(DATA_DIR, "test.db");

  // 1) Hand-build the OLD singleton-shape cto_agent table + a singleton row, then close.
  const old = new Database(DB_PATH, { create: true });
  old.exec(`
    CREATE TABLE cto_agent (
      id              TEXT PRIMARY KEY,
      session_id      TEXT,
      herdr_pane_id   TEXT,
      herdr_tab_id    TEXT,
      herdr_workspace TEXT,
      desired         INTEGER NOT NULL DEFAULT 0,
      started_at      TEXT,
      restarts        INTEGER NOT NULL DEFAULT 0,
      last_error      TEXT,
      updated_at      TEXT
    );
  `);
  old.query(
    `INSERT INTO cto_agent (id, session_id, desired) VALUES ('singleton', 'old-session', 1)`,
  ).run();
  old.close();

  // 2) Point butchr at it and import db.ts → its load-time migration runs.
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = DB_PATH;
  process.env.BUTCHR_LOG_FILE = "";
  await import("../src/config.ts");
  dbMod = await import("../src/db.ts");
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("cto_agent singleton → per-directory migration", () => {
  test("the table is re-keyed by directory_id (the old singleton shape is dropped)", () => {
    const cols = dbMod.db
      .query<{ name: string; pk: number }, []>(`PRAGMA table_info(cto_agent)`)
      .all();
    const names = cols.map((c) => c.name);
    expect(names).toContain("directory_id");
    expect(names).not.toContain("id"); // the singleton PK column is gone
    // directory_id is the new primary key.
    expect(cols.find((c) => c.name === "directory_id")!.pk).toBe(1);
  });

  test("the old 'singleton' row is destroyed (no rows survive the drop)", () => {
    expect(dbMod.listCtoAgentRows().length).toBe(0);
    expect(dbMod.getCtoAgentRow("singleton")).toBeNull();
  });

  test("per-directory rows now work (keyed by directory_id, FK to directories)", () => {
    // A directory is required (FK cascade keys the row to it).
    dbMod.db
      .query(
        `INSERT INTO directories (id, path, label, herdr_workspace, herdr_pane, gate_cmd, cto_enabled, created_at)
         VALUES ('dir-mig1', ?, 'mig', NULL, NULL, NULL, NULL, ?)`,
      )
      .run(join(DATA_DIR, "repo"), dbMod.nowIso());

    dbMod.saveCtoAgentRow("dir-mig1", { session_id: "s1", desired: 1 });
    const r = dbMod.getCtoAgentRow("dir-mig1");
    expect(r?.directory_id).toBe("dir-mig1");
    expect(r?.session_id).toBe("s1");
    expect(r?.desired).toBe(1);

    // Deleting the directory cascade-removes its CTO row (the path-change/move hazard).
    dbMod.db.query(`DELETE FROM directories WHERE id='dir-mig1'`).run();
    expect(dbMod.getCtoAgentRow("dir-mig1")).toBeNull();
  });
});
