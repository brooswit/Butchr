// WORK + WORKSPACE UNIFICATION — step 1 SCHEMA FOUNDATION (story st-540ba705).
// Proves the additive/inert step-1 shapes exist and that NOTHING existing broke:
//   1. tasks.parent_id (nullable self-FK) is present AND coexists with story_id — both
//      columns survive, parent_id is NULL on every existing row, and a real parent/child
//      link can be written while story_id is ALSO set (coexistence), with the self-FK
//      enforced (a bogus parent_id is rejected).
//   2. the new singular `workspace` table exists with the full expected column set.
//   3. POST-6c shape — the st-540ba705 step-6c cutover INVERTED the step-1 alias: `directory`
//      is now the authoritative TABLE and `workspaces` is the writable back-compat VIEW over
//      it (same rows), and the listDirectories() accessor reads the `directory` table.
//   4. UNAFFECTED — the legacy DB still converges exactly as before (the existing
//      directories→workspaces rename, cto-singleton fold, status folds), existing
//      task/story/workspace SELECTs still run and return the same rows.
//   5. IDEMPOTENCE — re-running the full boot pass twice more is a clean no-op (schema +
//      rows byte-identical), since it runs on the live DB every boot (the rename is guarded,
//      the workspaces view is DROP+CREATEd each boot, the workspace table is CREATE-IF-NOT-EXISTS).
//
// Mirrors test/db-migrations.test.ts: db.ts is a module-level singleton whose boot pass
// runs at import time, so we exercise the REAL boot path in an ISOLATED SUBPROCESS bound
// to a seeded legacy DB via BUTCHR_DB (never the live DB).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let out: any;

const SUBPROCESS = `
import { Database } from "bun:sqlite";
const path = process.env.BUTCHR_DB;

// Hand-build the OLD pre-canonical shape (same legacy seed as db-migrations.test.ts) so
// the full ordered boot pass exercises end-to-end, then close so db.ts opens it fresh.
const old = new Database(path, { create: true });
old.exec("PRAGMA foreign_keys = ON;");
old.exec(\`
  CREATE TABLE directories (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    directory_id TEXT NOT NULL REFERENCES directories(id) ON DELETE CASCADE,
    status TEXT NOT NULL, stage TEXT NOT NULL DEFAULT 'build',
    herdr_pane_id TEXT, herdr_tab_id TEXT, created_at TEXT NOT NULL
  );
  CREATE INDEX idx_tasks_dir ON tasks(directory_id);
  CREATE TABLE cto_agent (id TEXT PRIMARY KEY, session_id TEXT, desired INTEGER NOT NULL DEFAULT 0);
\`);
old.query("INSERT INTO directories (id, path, created_at) VALUES ('dir-1', '/tmp/ws-1', '2026-06-01T00:00:00.000Z')").run();
old.query("INSERT INTO cto_agent (id, session_id, desired) VALUES ('singleton', 'old', 1)").run();
const seed = (id, status, stage, pane) =>
  old.query("INSERT INTO tasks (id, directory_id, status, stage, herdr_pane_id, herdr_tab_id, created_at) VALUES (?, 'dir-1', ?, ?, ?, ?, '2026-06-01T00:00:00.000Z')").run(id, status, stage, pane, pane ? "t-" + id : null);
seed("t-queued", "queued", "build", null);
seed("t-running", "running", "build", "px");
seed("t-merged", "merged", "build", null);
old.close();

// Import db.ts -> its module-load runMigrations() runs the full ordered pass ONCE.
const m = await import(process.env.DB_TS);

// --- STRUCTURE + CONVERGENCE snapshot (no extra rows yet, for idempotence) ---
const snap = () => ({
  schema: m.db.query("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all(),
  tasks: m.db.query("SELECT id, status, story_id, parent_id FROM tasks ORDER BY id").all(),
  workspaces: m.db.query("SELECT id FROM workspaces ORDER BY id").all().map((r) => r.id),
});
const snapA = snap();
m.runMigrations();
m.runMigrations();
const snapB = snap();

const taskCols = m.db.query("PRAGMA table_info(tasks)").all().map((c) => c.name);
const workspaceTableExists = m.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='workspace'").all().length > 0;
const workspaceCols = m.db.query("PRAGMA table_info(workspace)").all().map((c) => c.name);
// st-540ba705 step 6c INVERTED the step-1 alias: directory is now the real TABLE and
// workspaces is the back-compat VIEW over it. Capture both object types to assert that.
const directoryType = m.db.query("SELECT type FROM sqlite_master WHERE name='directory'").get()?.type;
const workspacesType = m.db.query("SELECT type FROM sqlite_master WHERE name='workspaces'").get()?.type;
const directoryIds = m.db.query("SELECT id FROM directory ORDER BY id").all().map((r) => r.id);
const workspacesIds = m.db.query("SELECT id FROM workspaces ORDER BY id").all().map((r) => r.id);
const listDirectoriesIds = m.listDirectories().map((r) => r.id);

// Existing queries still run (stories table from the baseline; tasks/workspaces selects).
let existingQueriesOk = true;
try {
  m.db.query("SELECT COUNT(*) AS n FROM stories").get();
  m.db.query("SELECT id, status FROM tasks ORDER BY id").all();
  m.db.query("SELECT id, path FROM workspaces ORDER BY id").all();
} catch (e) { existingQueriesOk = false; }

// --- WRITE-EXERCISE (after the idempotence snapshot so it can't perturb it) ---
// parent/child link + story_id coexistence + self-FK enforcement on the converged schema.
const write = { childInserted: false, coexist: null, fkRejected: false };
const ts = "2026-06-02T00:00:00.000Z";
m.db.query("INSERT INTO stories (id, workspace_id, status, created_at) VALUES ('s-1', 'dir-1', 'open', ?)").run(ts);
m.db.query("INSERT INTO tasks (id, workspace_id, status, created_at) VALUES ('parent', 'dir-1', 'idea', ?)").run(ts);
// A child with BOTH a real parent_id (self-FK) AND a story_id set — proves coexistence.
m.db.query("INSERT INTO tasks (id, workspace_id, status, created_at, story_id, parent_id) VALUES ('child', 'dir-1', 'idea', ?, 's-1', 'parent')").run(ts);
write.childInserted = true;
write.coexist = m.db.query("SELECT story_id, parent_id FROM tasks WHERE id='child'").get();
// A bogus parent_id must be rejected by the self-FK (foreign_keys is ON).
try {
  m.db.query("INSERT INTO tasks (id, workspace_id, status, created_at, parent_id) VALUES ('orphan', 'dir-1', 'idea', ?, 'does-not-exist')").run(ts);
} catch (e) { write.fkRejected = true; }

console.log("RESULT:" + JSON.stringify({
  snapA, snapB, taskCols, workspaceTableExists, workspaceCols,
  directoryType, workspacesType, directoryIds, workspacesIds, listDirectoriesIds,
  existingQueriesOk, write,
}));
`;

beforeAll(() => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-work-foundation-"));
  const DB_PATH = join(DATA_DIR, "test.db");
  const DB_TS = join(import.meta.dir, "../src/db.ts");
  const res = Bun.spawnSync(["bun", "-e", SUBPROCESS], {
    env: { ...process.env, BUTCHR_DB: DB_PATH, BUTCHR_DATA_DIR: DATA_DIR, DB_TS },
  });
  const stdout = res.stdout.toString();
  const stderr = res.stderr.toString();
  const line = stdout.split("\n").find((l) => l.startsWith("RESULT:"));
  if (!line) {
    throw new Error(`foundation subprocess produced no RESULT (exit ${res.exitCode}).\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  out = JSON.parse(line.slice("RESULT:".length));
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("step 1 — tasks.parent_id (nullable self-FK, coexists with story_id)", () => {
  test("parent_id is present alongside story_id (coexistence, not a replacement)", () => {
    expect(out.taskCols).toContain("parent_id");
    expect(out.taskCols).toContain("story_id");
  });

  test("parent_id is NULL on every existing row", () => {
    for (const t of out.snapA.tasks) expect(t.parent_id).toBeNull();
  });

  test("a parent/child link can be written with story_id ALSO set (coexistence)", () => {
    expect(out.write.childInserted).toBe(true);
    expect(out.write.coexist).toEqual({ story_id: "s-1", parent_id: "parent" });
  });

  test("the self-FK is enforced — a bogus parent_id is rejected", () => {
    expect(out.write.fkRejected).toBe(true);
  });
});

describe("step 1 — the new `workspace` table", () => {
  test("the table exists with the full expected column set", () => {
    expect(out.workspaceTableExists).toBe(true);
    expect(out.workspaceCols.sort()).toEqual(
      [
        "created_at", "desired", "directory_id", "has_agent", "herdr_workspace",
        "id", "idle", "idle_context", "kind", "last_error", "name", "restarts",
        "session_id", "started_at", "updated_at", "work_id",
      ].sort(),
    );
  });
});

// st-540ba705 step 6c INVERTED the step-1 alias: `directory` is the authoritative TABLE and
// `workspaces` is the writable back-compat VIEW over it (see test/work-cutover-6c.test.ts for
// the focused proof). This guards that the converged live shape reflects the cutover.
describe("step 6c — `directory` is the table and `workspaces` is the view", () => {
  test("directory is a TABLE, workspaces is a VIEW, and both expose the same rows", () => {
    expect(out.directoryType).toBe("table");
    expect(out.workspacesType).toBe("view");
    expect(out.directoryIds).toEqual(out.workspacesIds);
    expect(out.directoryIds).toEqual(["dir-1"]);
  });

  test("listDirectories() reads the canonical `directory` table", () => {
    expect(out.listDirectoriesIds).toEqual(["dir-1"]);
  });
});

describe("step 1 — existing behavior is UNAFFECTED", () => {
  test("the legacy DB still converges exactly as before", () => {
    expect(out.workspacesIds).toEqual(["dir-1"]); // directories → workspaces, id preserved
    const statuses = Object.fromEntries(out.snapA.tasks.map((t: any) => [t.id, t.status]));
    expect(statuses).toEqual({
      "t-queued": "inactive", // queued → in_progress → inactive (no pane = ready)
      "t-running": "in_progress", // running → in_progress (pane = LIVE)
      "t-merged": "merged", // canonical, unchanged
    });
  });

  test("existing task/story/workspace queries still run", () => {
    expect(out.existingQueriesOk).toBe(true);
  });
});

describe("step 1 — idempotence", () => {
  test("re-running the full boot pass twice more is a clean no-op (schema + rows unchanged)", () => {
    expect(out.snapB).toEqual(out.snapA);
  });
});
