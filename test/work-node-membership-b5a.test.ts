// REVAMP-2 Phase B.5a (story st-78a8b4e7) — the LAST stories-TABLE membership/identity reads
// converted to the work_kind discriminator. This pins the byte-identity that makes the swap safe:
// with a node IN SYNC (present both in `stories` AND as a `work_kind='node'` tasks row, kept in
// lock-step by the B.3 dual-write), the converted `work_kind != 'node'` / `work_kind='node'` reads
// return EXACTLY what the old `id [NOT] IN (SELECT id FROM stories)` reads did.
//
// Coverage (the 8 converted sites):
//   (a) EXCLUSION reads — health rollup (server.ts), listTasks (tasks.ts), workspace per-status
//       counts (workspaces.ts), and the CTO stranded-item findings (tasks.ts) all EXCLUDE the node
//       row and INCLUDE the real leaf. Proven via the real exported functions AND a direct
//       old-vs-new predicate equivalence (the two WHERE clauses select the identical id set).
//   (b) ENUMERATION reads — the story-agent node enumeration / teardown / path lookups
//       (`SELECT id FROM tasks WHERE work_kind='node'`) FIND the node, matching `SELECT id FROM
//       stories` exactly.
//
// Shared-singleton-safe (the db is process-wide across test files — see work-node-exclusion.test.ts):
// every assertion is scoped to OUR OWN workspace/ids, never a global count, and no global mutating
// sweep runs. herdr stubbed (BUTCHR_HERDR_BIN → `true`); pure in-process, no git, no merge path.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
// Distinct ids — the db/config singletons are shared across test files.
const WS = "b5a-ws";
const NODE = "st-b5a-node"; // story id == the materialized node's tasks-row id
const LEAF = "b5a-leaf"; // a real leaf member of NODE

let dbMod: typeof import("../src/db.ts");
let tasksMod: typeof import("../src/tasks.ts");
let workspacesMod: typeof import("../src/workspaces.ts");

/** Ids matching a WHERE clause, scoped to OUR workspace (never a global set). */
function idsWhere(where: string): string[] {
  return dbMod.db
    .query<{ id: string }, [string]>(`SELECT id FROM tasks WHERE workspace_id=? AND ${where}`)
    .all(WS)
    .map((r) => r.id)
    .sort();
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-b5a-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-b5a-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  dbMod = await import("../src/db.ts");
  tasksMod = await import("../src/tasks.ts");
  workspacesMod = await import("../src/workspaces.ts");

  dbMod.db
    .query(`INSERT OR IGNORE INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(WS, join(REPO_ROOT, WS), WS, dbMod.nowIso());

  // A node IN SYNC: a `stories` row AND its materialized Work NODE (id == story id,
  // work_kind='node') — exactly the state the B.3 dual-write maintains. Node status='merged' (the
  // inert anchor) so that, if it were NOT excluded, it would inflate a 'merged' bucket / leak into
  // the task list. Plus one real 'in_progress' leaf member.
  dbMod.db
    .query(`INSERT INTO stories (id, workspace_id, status, created_at) VALUES (?, ?, 'open', ?)`)
    .run(NODE, WS, dbMod.nowIso());
  dbMod.db
    .query(
      `INSERT INTO tasks (id, workspace_id, status, work_kind, story_id, parent_id, created_at)
       VALUES (?, ?, 'merged', 'node', NULL, NULL, ?)`,
    )
    .run(NODE, WS, dbMod.nowIso());
  dbMod.db
    .query(
      `INSERT INTO tasks (id, workspace_id, status, work_kind, story_id, parent_id, created_at)
       VALUES (?, ?, 'in_progress', 'leaf', ?, ?, ?)`,
    )
    .run(LEAF, WS, NODE, NODE, dbMod.nowIso());
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

describe("B.5a: work_kind == stories-table membership (node IN SYNC)", () => {
  test("(equivalence) old `id [NOT] IN (SELECT id FROM stories)` == new work_kind predicate", () => {
    // The exact identity that makes every swap byte-identical, scoped to our workspace.
    expect(idsWhere("work_kind != 'node'")).toEqual(idsWhere("id NOT IN (SELECT id FROM stories)"));
    expect(idsWhere("work_kind = 'node'")).toEqual(idsWhere("id IN (SELECT id FROM stories)"));
    // ...and those sets are the ones we expect: leaf is the non-node, node is the node.
    expect(idsWhere("work_kind != 'node'")).toEqual([LEAF]);
    expect(idsWhere("work_kind = 'node'")).toEqual([NODE]);
  });

  test("(a) listTasks EXCLUDES the node, INCLUDES the leaf", () => {
    const ids = tasksMod.listTasks(WS).map((t) => t.id);
    expect(ids).not.toContain(NODE);
    expect(ids).toContain(LEAF);
  });

  test("(a) workspace per-status counts EXCLUDE the node's phantom 'merged'", () => {
    const detail = workspacesMod.workspaceDetail(WS);
    // The node's inert 'merged' anchor must NOT be counted; the real leaf IS.
    expect(detail.counts.merged ?? 0).toBe(0);
    expect(detail.counts.in_progress ?? 0).toBe(1);
  });

  test("(a) health rollup SQL (server.ts) EXCLUDES the node in-sync", () => {
    // Byte-identical to the server health rollup, scoped to our workspace so we assert on our rows.
    const rows = dbMod.db
      .query<{ status: string; n: number }, [string]>(
        `SELECT status, COUNT(*) AS n FROM tasks
          WHERE workspace_id=? AND work_kind != 'node' GROUP BY status`,
      )
      .all(WS);
    const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.n]));
    expect(byStatus.merged ?? 0).toBe(0); // node anchor excluded
    expect(byStatus.in_progress ?? 0).toBe(1); // leaf counted
  });

  test("(a) CTO stranded-item SQL keeps story_id IS NULL AND excludes the node", () => {
    // Mirrors tasks.strandedItems: the node guard is now work_kind, story_id IS NULL is untouched.
    // Node is status='merged' so it won't match 'idea'/'blocked' regardless — arm a NULL-story idea
    // node transiently to prove the work_kind guard (not the status) is what drops it.
    dbMod.db.query(`UPDATE tasks SET status='idea' WHERE id=?`).run(NODE);
    const ideas = idsWhere("story_id IS NULL AND status='idea' AND work_kind != 'node'");
    expect(ideas).not.toContain(NODE); // dropped by the work_kind guard, not by story_id
    dbMod.db.query(`UPDATE tasks SET status='merged' WHERE id=?`).run(NODE); // restore
  });

  test("(b) story-agent node enumeration FINDS the node (== SELECT id FROM stories)", () => {
    // Sites 6/7: `SELECT id FROM tasks WHERE work_kind='node'` replaces `SELECT id FROM stories`.
    const viaWorkKind = idsWhere("work_kind = 'node'");
    const viaStories = dbMod.db
      .query<{ id: string }, [string]>(`SELECT id FROM stories WHERE workspace_id=?`)
      .all(WS)
      .map((r) => r.id)
      .sort();
    expect(viaWorkKind).toEqual(viaStories);
    expect(viaWorkKind).toContain(NODE);
  });

  test("(b) storyWorkspacePath JOIN resolves the node's workspace path (== stories JOIN)", () => {
    // Site 8: the tasks-JOIN (guarded work_kind='node') returns the same path the stories-JOIN did.
    const viaTasks = dbMod.db
      .query<{ path: string }, [string]>(
        `SELECT w.path AS path FROM tasks t JOIN workspaces w ON w.id = t.workspace_id
          WHERE t.id=? AND t.work_kind='node'`,
      )
      .get(NODE);
    const viaStories = dbMod.db
      .query<{ path: string }, [string]>(
        `SELECT w.path AS path FROM stories s JOIN workspaces w ON w.id = s.workspace_id WHERE s.id=?`,
      )
      .get(NODE);
    expect(viaTasks?.path).toBe(viaStories?.path);
    expect(viaTasks?.path).toBe(join(REPO_ROOT, WS));
  });
});
