// Tests for the BOOT-TIME PRUNE of stale temp-dir workspace registrations
// (see workspaces.pruneTempWorkspaces, wired into the index.ts boot path).
//
// Pure / in-process: no real claude/herdr/bun is spawned. BUTCHR_HERDR_BIN points at
// `true` so herdr probes/teardown are no-ops, and workspace + task rows are inserted
// directly (no registerWorkspace, which would need a live herdr). We assert the prune
// removes ONLY workspaces whose path resolves under the OS temp dir — cascading to
// their tasks — and leaves a real (/home/...) workspace and its tasks untouched.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let TMP_REPO: string;

// Distinct ids — the db/config singletons are shared across test files.
const TMP_DIR_ID = "prune-tmp-ws";
const REAL_DIR_ID = "prune-real-ws";
// A real, non-temp absolute path that must survive the prune untouched.
const REAL_PATH = "/home/butchr-fake/keep-me-repo";

let dirsMod: typeof import("../src/workspaces.ts");
let dbMod: typeof import("../src/db.ts");

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-prune-data-"));
  // A workspace path that genuinely lives UNDER the OS temp dir — the prune target.
  TMP_REPO = mkdtempSync(join(tmpdir(), "butchr-prune-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  dbMod = await import("../src/db.ts");
  dirsMod = await import("../src/workspaces.ts");

  const insWs = (id: string, path: string) =>
    dbMod.db
      .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
      .run(id, path, id, dbMod.nowIso());
  insWs(TMP_DIR_ID, TMP_REPO);
  insWs(REAL_DIR_ID, REAL_PATH);

  // Seed a task in each workspace so we can assert the tmp one's tasks CASCADE away
  // while the real one's tasks survive.
  const insTask = (id: string, dir: string) =>
    dbMod.db
      .query(`INSERT INTO tasks (id, workspace_id, status, created_at) VALUES (?, ?, ?, ?)`)
      .run(id, dir, "idea", dbMod.nowIso());
  insTask("prune-tmp-task", TMP_DIR_ID);
  insTask("prune-real-task", REAL_DIR_ID);
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(TMP_REPO, { recursive: true, force: true });
});

const taskCount = (dir: string): number =>
  dbMod.db
    .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM tasks WHERE workspace_id=?`)
    .get(dir)!.n;

// NOTE: the db is a process-wide singleton shared across every test file, so other
// files may have left their own (incl. temp-pathed) workspace rows behind. We therefore
// assert on OUR specific rows + a `>= 1` floor on the prune count, never an exact global
// count — that would be order-dependent and flaky.
describe("pruneTempWorkspaces", () => {
  test("removes temp-dir workspaces (cascading tasks) and keeps real ones", async () => {
    // Both of our workspaces + their tasks exist up front.
    expect(dirsMod.getWorkspace(TMP_DIR_ID)).not.toBeNull();
    expect(dirsMod.getWorkspace(REAL_DIR_ID)).not.toBeNull();
    expect(taskCount(TMP_DIR_ID)).toBe(1);
    expect(taskCount(REAL_DIR_ID)).toBe(1);

    const pruned = await dirsMod.pruneTempWorkspaces();

    // At least our one temp workspace was pruned (other test files may add more).
    expect(pruned).toBeGreaterThanOrEqual(1);

    // Our temp workspace is gone and its task cascaded away.
    expect(dirsMod.getWorkspace(TMP_DIR_ID)).toBeNull();
    expect(taskCount(TMP_DIR_ID)).toBe(0);

    // Our real (/home/...) workspace and its task are untouched.
    expect(dirsMod.getWorkspace(REAL_DIR_ID)).not.toBeNull();
    expect(taskCount(REAL_DIR_ID)).toBe(1);
  });

  test("re-running never touches a real (non-temp) workspace", async () => {
    await dirsMod.pruneTempWorkspaces();
    // The real workspace + its task survive repeated prunes; the temp one stays gone.
    expect(dirsMod.getWorkspace(REAL_DIR_ID)).not.toBeNull();
    expect(taskCount(REAL_DIR_ID)).toBe(1);
    expect(dirsMod.getWorkspace(TMP_DIR_ID)).toBeNull();
  });
});
