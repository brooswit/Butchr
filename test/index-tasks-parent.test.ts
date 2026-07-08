// PERF guard (story st-718bd185): the covering index `idx_tasks_parent` on
// tasks(parent_id, work_kind, status). It is the load-bearing fix for GET /api/work list
// latency — storyCounts (src/stories.ts) runs two `WHERE parent_id=? AND work_kind='leaf'`
// queries PER story node on every list call, and without this index each is a FULL SCAN of
// the (multi-MB) tasks table (profiled: storyCounts x60 = 1482ms -> 1.7ms with the index).
//
// This test pins the index into place so a future schema change that drops or reshapes it
// fails LOUDLY rather than silently regressing the list path back to full scans:
//   1. the index EXISTS with EXACTLY the columns (parent_id, work_kind, status), in order; and
//   2. the real storyCounts query PLAN actually USES it as a covering index (EXPLAIN QUERY
//      PLAN mentions idx_tasks_parent) — the presence of the index is worthless if the
//      planner does not pick it for the query it was built for.
//
// Pure / in-process: importing db.ts runs the real boot migration pass (which creates the
// index) against an isolated temp DB. The db singleton is shared across test files, but this
// test only inspects the schema, so it is order-independent.
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dbMod: typeof import("../src/db.ts");

beforeAll(async () => {
  const DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-idx-parent-data-"));
  process.env.BUTCHR_DATA_DIR ??= DATA_DIR;
  process.env.BUTCHR_DB ??= join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE ??= "";
  process.env.BUTCHR_HERDR_BIN ??= "true";
  dbMod = await import("../src/db.ts");
});

describe("idx_tasks_parent covering index (GET /api/work list perf)", () => {
  test("the index exists on tasks with exactly (parent_id, work_kind, status) in order", () => {
    const names = dbMod.db
      .query<{ name: string }, []>(`PRAGMA index_list(tasks)`)
      .all()
      .map((r) => r.name);
    expect(names).toContain("idx_tasks_parent");

    // seqno orders the columns as declared; assert the exact covering shape/order.
    const cols = dbMod.db
      .query<{ seqno: number; name: string }, []>(`PRAGMA index_info(idx_tasks_parent)`)
      .all()
      .sort((a, b) => a.seqno - b.seqno)
      .map((r) => r.name);
    expect(cols).toEqual(["parent_id", "work_kind", "status"]);
  });

  test("the storyCounts query plan USES the covering index (no full table scan)", () => {
    // The exact rollup query from storyCounts (src/stories.ts) — the hot path this index serves.
    const plan = dbMod.db
      .query<{ detail: string }, [string]>(
        `EXPLAIN QUERY PLAN SELECT status, COUNT(*) AS n FROM tasks WHERE parent_id=? AND work_kind='leaf' GROUP BY status`,
      )
      .all("parent-does-not-matter")
      .map((r) => r.detail)
      .join(" | ");
    // Must SEARCH via idx_tasks_parent, NOT SCAN the whole tasks table.
    expect(plan).toContain("idx_tasks_parent");
    expect(plan).not.toContain("SCAN tasks");
  });
});
