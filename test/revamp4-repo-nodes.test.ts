// REVAMP-4 Phase 0 / S0a (story st-1a82a2e1) — CONTAINER node kinds ('repo'/'project') in the
// unified `tasks` tree. This pins the ADDITIVE + ZERO-BEHAVIOR contract:
//   1. migrateMaterializeRepoNodes materializes ONE work_kind='repo' node per `directory` row,
//      with the node id EQUAL to the directory id, status = the inert 'merged' terminal anchor,
//      parent_id NULL, workspace_id = the same id (self).
//   2. It is INSERT-ONCE idempotent — re-running the step (and the full boot pass) never dups it.
//   3. work_kind round-trips the new 'repo' and 'project' values through getTask.
//   4. A repo node is INVISIBLE to every existing story/leaf read: listTasks, the workspace
//      per-status counts, metricRows, isWorkLeaf/isWorkNode, and resolveWork all treat it as
//      neither a real task nor a story node.
//   5. The boot merged-sweep (recoverMergedTasks) NEVER touches a repo node (a status='merged'
//      anchor with no branch/worktree) — it stays materialized, not force-removed/re-processed.
//
// Pure / in-process: rows are inserted directly via the db singleton (no live herdr/claude). The
// db/config singletons are SHARED across test files, so we use distinct ids + a dedicated
// workspace and assert only on our own rows (metricRows is checked as a DELTA to stay robust to
// other files' rows).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;

// Distinct ids — the db/config singletons are shared across test files. The repo NODE id is, by
// design, EQUAL to the directory (workspace) id, so REPO_DIR doubles as both.
const REPO_DIR = "dir-repo-node-s0a";
const OTHER_DIR = "dir-repo-node-s0a-2";
const LEAF = "task-repo-node-s0a-leaf";
const PROJECT = "proj-repo-node-s0a";

let dbMod: typeof import("../src/db.ts");
let tasksMod: typeof import("../src/tasks.ts");
let workMod: typeof import("../src/work.ts");
let workApiMod: typeof import("../src/work-api.ts");
let workspacesMod: typeof import("../src/workspaces.ts");

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-repo-nodes-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-repo-nodes-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  dbMod = await import("../src/db.ts");
  tasksMod = await import("../src/tasks.ts");
  workMod = await import("../src/work.ts");
  workApiMod = await import("../src/work-api.ts");
  workspacesMod = await import("../src/workspaces.ts");

  // Two registered repos (via the writable `workspaces` view → `directory` table). No repo nodes
  // exist yet — the boot pass at import time ran before these rows existed; each test triggers the
  // migration explicitly so it is exercised against these seeded directories.
  for (const [id, sub] of [[REPO_DIR, "r1"], [OTHER_DIR, "r2"]] as const) {
    dbMod.db
      .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
      .run(id, join(REPO_ROOT, sub), id, dbMod.nowIso());
  }
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

function repoNodeCount(dirId: string): number {
  return dbMod.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM tasks WHERE id=? AND work_kind='repo'`,
    )
    .get(dirId)!.n;
}

describe("REVAMP-4 S0a — repo node materialization", () => {
  test("materializes one work_kind='repo' node per directory, id == dir id", () => {
    dbMod.migrateMaterializeRepoNodes();

    for (const dirId of [REPO_DIR, OTHER_DIR]) {
      const node = tasksMod.getTask(dirId);
      expect(node).not.toBeNull();
      expect(node!.id).toBe(dirId); // node id EQUALS the directory id (the shared-id link)
      expect(node!.work_kind).toBe("repo");
      expect(node!.status).toBe("merged"); // the inert terminal anchor story nodes use
      expect(node!.parent_id).toBeNull(); // no project tier yet
      expect(node!.workspace_id).toBe(dirId); // self (FK-safe against directory(id))
    }
  });

  test("is INSERT-ONCE idempotent — re-running the step never dups a repo node", () => {
    expect(repoNodeCount(REPO_DIR)).toBe(1);
    dbMod.migrateMaterializeRepoNodes();
    dbMod.migrateMaterializeRepoNodes();
    expect(repoNodeCount(REPO_DIR)).toBe(1);
  });

  test("the full boot migration pass re-runs as a clean no-op (repo node stable)", () => {
    expect(() => dbMod.runMigrations()).not.toThrow();
    expect(repoNodeCount(REPO_DIR)).toBe(1);
    expect(repoNodeCount(OTHER_DIR)).toBe(1);
  });

  test("work_kind round-trips the new 'repo' and 'project' values", () => {
    // 'repo' round-trips via the materialized node above; assert 'project' round-trips too.
    dbMod.db
      .query(
        `INSERT INTO tasks (id, workspace_id, status, created_at, work_kind)
           VALUES (?, ?, 'merged', ?, 'project')`,
      )
      .run(PROJECT, REPO_DIR, dbMod.nowIso());
    expect(tasksMod.getTask(PROJECT)!.work_kind).toBe("project");
    expect(tasksMod.getTask(REPO_DIR)!.work_kind).toBe("repo");
  });
});

describe("REVAMP-4 S0a — a repo node is invisible to leaf/node logic", () => {
  beforeAll(() => {
    dbMod.migrateMaterializeRepoNodes();
    // A real LEAF task in the SAME workspace — the control that MUST still surface everywhere a
    // repo node must NOT.
    dbMod.db
      .query(
        `INSERT INTO tasks (id, workspace_id, status, created_at) VALUES (?, ?, 'in_progress', ?)`,
      )
      .run(LEAF, REPO_DIR, dbMod.nowIso());
  });

  test("listTasks excludes the repo node but keeps the real leaf", () => {
    const ids = tasksMod.listTasks(REPO_DIR).map((t) => t.id);
    expect(ids).toContain(LEAF);
    expect(ids).not.toContain(REPO_DIR); // the repo node (id == workspace id) must not surface
    expect(ids).not.toContain(PROJECT); // nor the reserved container kind
  });

  test("workspace per-status counts do not count the repo node's 'merged' anchor", () => {
    const counts = workspacesMod.workspaceDetail(REPO_DIR).counts;
    // The one real leaf is in_progress; the repo/project container anchors are 'merged' and must
    // NOT show up as a merged task in this workspace's rollup.
    expect(counts.in_progress).toBe(1);
    expect(counts.merged ?? 0).toBe(0);
  });

  test("metricRows does not pick up the repo node (merged count unchanged by materialization)", () => {
    const merged = () => dbMod.metricRows().filter((r) => r.status === "merged").length;
    const before = merged();
    dbMod.migrateMaterializeRepoNodes(); // no-op — node already exists
    expect(merged()).toBe(before); // repo node never enters the metrics aggregate
  });

  test("isWorkLeaf and isWorkNode are BOTH false for a repo node (neither leaf nor story node)", () => {
    expect(workMod.isWorkNode(REPO_DIR)).toBe(false);
    expect(workMod.isWorkLeaf(REPO_DIR)).toBe(false);
    // The real leaf and a missing id keep today's behavior.
    expect(workMod.isWorkLeaf(LEAF)).toBe(true);
    expect(workMod.isWorkLeaf("task-does-not-exist-s0a")).toBe(true);
  });

  test("resolveWork 404s a repo node id rather than mis-serving it as a leaf", () => {
    expect(() => workApiMod.resolveWork(REPO_DIR)).toThrow(/work not found/);
    expect(() => workApiMod.resolveWork(PROJECT)).toThrow(/work not found/);
    // The real leaf still resolves.
    expect(workApiMod.resolveWork(LEAF).kind).toBe("leaf");
  });
});

describe("REVAMP-4 S0a — boot merged-sweep leaves the repo node untouched", () => {
  test("recoverMergedTasks never force-removes or re-processes a repo node", async () => {
    dbMod.migrateMaterializeRepoNodes();
    const before = tasksMod.getTask(REPO_DIR)!;
    await expect(tasksMod.recoverMergedTasks()).resolves.toBeGreaterThanOrEqual(0);
    const after = tasksMod.getTask(REPO_DIR);
    // Still present, still the inert 'repo'/'merged' anchor — the sweep only touches
    // status='in_review' AND work_kind='leaf'.
    expect(after).not.toBeNull();
    expect(after!.work_kind).toBe("repo");
    expect(after!.status).toBe("merged");
    expect(after!.created_at).toBe(before.created_at);
  });
});
