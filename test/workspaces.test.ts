// Unit tests for src/workspaces.ts pure reads.
//
// isCtoEnabled resolution: the per-workspace `cto_enabled` column WINS over the
// GLOBAL default config.ctoAgentEnabled (1 → on, 0 → off, NULL → inherit the global
// default; an unknown workspace → not enabled). Relocated here from the (now-deleted)
// cto-agent.test.ts when isCtoEnabled moved to its cycle-free home in workspaces.ts
// (REVAMP-1 Phase C).
//
// config fields are set DIRECTLY on the imported config object (not via env) so the
// test is deterministic regardless of bun's shared-config import order.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let dbMod: typeof import("../src/db.ts");
let cfgMod: typeof import("../src/config.ts");
let workspaces: typeof import("../src/workspaces.ts");

const DIR = "dir-wstest1";

function insertDir(id: string): void {
  dbMod.db
    .query(
      `INSERT OR IGNORE INTO workspaces (id, path, label, herdr_workspace, herdr_pane, gate_cmd, cto_enabled, created_at)
       VALUES (?, ?, ?, NULL, NULL, NULL, 1, ?)`,
    )
    .run(id, join(DATA_DIR, id), id, dbMod.nowIso());
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-ws-data-"));
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  cfgMod = await import("../src/config.ts");
  dbMod = await import("../src/db.ts");
  workspaces = await import("../src/workspaces.ts");

  // Prove per-workspace cto_enabled=1 WINS over a global default of OFF.
  cfgMod.config.ctoAgentEnabled = false;

  insertDir(DIR);
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("isCtoEnabled resolution (per-workspace wins over the global default)", () => {
  test("explicit 1/0 override the global default; NULL inherits it", async () => {
    dbMod.db.query(`UPDATE workspaces SET cto_enabled=1 WHERE id=?`).run(DIR);
    expect(workspaces.isCtoEnabled(DIR)).toBe(true);
    dbMod.db.query(`UPDATE workspaces SET cto_enabled=0 WHERE id=?`).run(DIR);
    expect(workspaces.isCtoEnabled(DIR)).toBe(false);

    dbMod.db.query(`UPDATE workspaces SET cto_enabled=NULL WHERE id=?`).run(DIR);
    cfgMod.config.ctoAgentEnabled = false;
    expect(workspaces.isCtoEnabled(DIR)).toBe(false); // inherit global OFF
    cfgMod.config.ctoAgentEnabled = true;
    expect(workspaces.isCtoEnabled(DIR)).toBe(true); // inherit global ON

    // restore the suite's invariant
    cfgMod.config.ctoAgentEnabled = false;
    dbMod.db.query(`UPDATE workspaces SET cto_enabled=1 WHERE id=?`).run(DIR);
    expect(workspaces.isCtoEnabled("dir-nonexistent")).toBe(false);
  });
});
