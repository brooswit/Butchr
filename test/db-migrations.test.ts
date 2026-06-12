// Test the ORDERED BOOT MIGRATION RUNNER (db.ts MIGRATIONS / runMigrations). The five
// forward migrations + the baseline schema + the additive column set are run by ONE
// ordered loop on every boot, so two properties must hold:
//   1. CONVERGENCE — a seeded LEGACY DB (pre-rename `directories`, an old singleton
//      `cto_agent`, the retracted `stage` axis, and pre-canonical statuses) is migrated
//      forward to the current 12-state shape in a single pass.
//   2. IDEMPOTENCE — running the FULL pass AGAIN is a clean no-op: identical schema,
//      identical rows, never throwing (it runs against a live DB on every boot).
//
// db.ts is a module-level SINGLETON whose connection is bound (and the boot pass runs)
// at import time, and bun shares that module across the test process — so we exercise
// the real boot path in an ISOLATED SUBPROCESS: it builds the legacy DB, imports db.ts
// (pass #1 runs at load), then calls runMigrations() twice more and prints schema+row
// snapshots. The parent asserts convergence + that the snapshots are byte-identical.
// (Rename idempotency + cto-singleton convergence also have their own focused tests —
// workspace-migration / cto-migration; this guards the whole ordered pass end to end.)
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let out: { snapA: any; snapB: any };

// Runs entirely inside a fresh `bun` process so the db.ts singleton + its boot pass are
// bound to OUR seeded legacy DB, with no interference from the shared test process.
const SUBPROCESS = `
import { Database } from "bun:sqlite";
const path = process.env.BUTCHR_DB;

// Hand-build the OLD pre-canonical shape, seed the artifacts the 5 migrations key on,
// then close so db.ts opens the same file fresh.
const old = new Database(path, { create: true });
old.exec("PRAGMA foreign_keys = ON;");
old.exec(\`
  CREATE TABLE directories (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    directory_id TEXT NOT NULL REFERENCES directories(id) ON DELETE CASCADE,
    status TEXT NOT NULL, stage TEXT NOT NULL DEFAULT 'build',
    herdr_pane_id TEXT, created_at TEXT NOT NULL
  );
  CREATE INDEX idx_tasks_dir ON tasks(directory_id);
  CREATE TABLE cto_agent (id TEXT PRIMARY KEY, session_id TEXT, desired INTEGER NOT NULL DEFAULT 0);
\`);
old.query("INSERT INTO directories (id, path, created_at) VALUES ('dir-1', '/tmp/ws-1', '2026-06-01T00:00:00.000Z')").run();
old.query("INSERT INTO cto_agent (id, session_id, desired) VALUES ('singleton', 'old', 1)").run();
const seed = (id, status, stage, pane) =>
  old.query("INSERT INTO tasks (id, directory_id, status, stage, herdr_pane_id, created_at) VALUES (?, 'dir-1', ?, ?, ?, '2026-06-01T00:00:00.000Z')").run(id, status, stage, pane);
seed("t-idea", "queued", "idea", null);       // stage idea         -> status 'idea'
seed("t-queued", "queued", "build", null);    // queued->in_progress-> inactive (no pane)
seed("t-running", "running", "build", "px");  // running            -> in_progress (pane)
seed("t-review", "review", "build", null);    // review             -> in_review
seed("t-await", "awaiting_input", "build", null); // awaiting_input -> needs_info
seed("t-rejected", "rejected", "build", null);// rejected           -> aborted
seed("t-merged", "merged", "build", null);    // canonical          -> unchanged
seed("t-failed", "failed", "build", null);    // deliberately NOT folded
old.close();

// Import db.ts -> its module-load runMigrations() runs the full ordered pass ONCE.
const m = await import(process.env.DB_TS);
const snap = () => ({
  schema: m.db.query("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all(),
  tasks: m.db.query("SELECT id, status, herdr_pane_id FROM tasks ORDER BY id").all(),
  workspaces: m.db.query("SELECT id FROM workspaces ORDER BY id").all().map((r) => r.id),
  hasDirectories: m.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='directories'").all().length > 0,
  ctoCols: m.db.query("PRAGMA table_info(cto_agent)").all().map((c) => c.name),
  ctoRows: m.db.query("SELECT COUNT(*) AS n FROM cto_agent").get().n,
});
const snapA = snap();
m.runMigrations();
m.runMigrations();
const snapB = snap();
console.log("RESULT:" + JSON.stringify({ snapA, snapB }));
`;

beforeAll(() => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-db-migrate-"));
  const DB_PATH = join(DATA_DIR, "test.db");
  const DB_TS = join(import.meta.dir, "../src/db.ts");
  const res = Bun.spawnSync(["bun", "-e", SUBPROCESS], {
    env: { ...process.env, BUTCHR_DB: DB_PATH, BUTCHR_DATA_DIR: DATA_DIR, DB_TS },
  });
  const stdout = res.stdout.toString();
  const stderr = res.stderr.toString();
  const line = stdout.split("\n").find((l) => l.startsWith("RESULT:"));
  if (!line) {
    throw new Error(`migration subprocess produced no RESULT (exit ${res.exitCode}).\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  out = JSON.parse(line.slice("RESULT:".length));
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("boot migration runner — convergence", () => {
  test("the legacy shape is migrated forward in a single pass", () => {
    const { snapA } = out;
    // directories → workspaces (renamed in place; row + opaque id preserved).
    expect(snapA.hasDirectories).toBe(false);
    expect(snapA.workspaces).toEqual(["dir-1"]);
    // cto_agent migrated to the per-workspace shape (old singleton row dropped).
    expect(snapA.ctoCols).toContain("workspace_id");
    expect(snapA.ctoCols).not.toContain("id");
    expect(snapA.ctoRows).toBe(0);
    // pre-canonical statuses folded into the 12-state model.
    const statuses = Object.fromEntries(snapA.tasks.map((t: any) => [t.id, t.status]));
    expect(statuses).toEqual({
      "t-idea": "idea",
      "t-queued": "inactive",
      "t-running": "in_progress",
      "t-review": "in_review",
      "t-await": "needs_info",
      "t-rejected": "aborted",
      "t-merged": "merged",
      "t-failed": "failed",
    });
  });
});

describe("boot migration runner — idempotence", () => {
  test("re-running the full pass twice more is a clean no-op (schema + rows unchanged)", () => {
    expect(out.snapB).toEqual(out.snapA);
  });
});
