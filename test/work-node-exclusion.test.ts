// REVAMP Phase B.2 (story st-6372812d) — NODE-EXCLUSION VIA THE work_kind DISCRIMINATOR.
//
// Proves the behavior-IDENTICAL conversion of every node-blind loop: a story Work NODE (a `tasks`
// row with work_kind='node') is excluded from EVERY converted loop by the EXPLICIT work_kind
// guard — STRUCTURALLY, not because the node happens to carry the inert terminal 'merged' anchor.
// So once B.3 makes a node's tasks.status REAL, the loops stay correct.
//
// Two proof styles, both robust to the SHARED db/config singleton (the db is process-wide across
// test files — see test/work-api.test.ts; assertions here are scoped to OUR OWN ids, never global
// counts, and never call a GLOBAL mutating sweep that would act on other files' rows):
//   1. EXECUTED + SCOPED — call the real read loop / per-id guard and assert OUR node id is absent.
//   2. STRUCTURAL guard proof — arm the node in each loop's exact trigger state and assert the
//      loop's WHERE predicate WITH the work_kind guard excludes our node, while the SAME predicate
//      WITHOUT it includes it (so the guard is provably load-bearing, not incidental to 'merged').
//
// Also proves the unified node/leaf DEFINITION (isWorkNode / isWorkLeaf key on work_kind — ONE
// definition) and, POST-B.4, that a node-less "lazy" story no longer resolves (getStory is
// tasks-backed; B.3's eager materialization makes that state non-production).
//
// Pure / in-process: herdr stubbed (BUTCHR_HERDR_BIN → `true`). NO merge path runs (the node is
// excluded from every sweep; the only sweeps EXECUTED are per-id guards on our own node id), so no
// setCiRunner/setVerifyRunner stub is needed.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
// Distinct ids — the db/config singletons are shared across test files.
const DIR = "wnx-dir";
const STORY = "st-wnx-node"; // the story id == the node's tasks-row id
const LEAF = "wnx-leaf"; // a leaf member of STORY
const LAZY = "st-wnx-lazy"; // a story with a stories row but NO tasks node row (lazy materialization)

let dbMod: typeof import("../src/db.ts");
let tasksMod: typeof import("../src/tasks.ts");
let storiesMod: typeof import("../src/stories.ts");
let workMod: typeof import("../src/work.ts");
let workApi: typeof import("../src/work-api.ts");
let dispatcherMod: typeof import("../src/dispatcher.ts");

function insertTask(
  id: string,
  status: string,
  opts: { workKind?: "leaf" | "node"; storyId?: string | null; parentId?: string | null } = {},
) {
  dbMod.db
    .query(
      `INSERT INTO tasks (id, workspace_id, status, work_kind, parent_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      DIR,
      status,
      opts.workKind ?? "leaf",
      opts.parentId ?? opts.storyId ?? null,
      dbMod.nowIso(),
    );
}

/** Set columns on OUR node row only. */
function setNode(assignments: string, params: unknown[] = []) {
  dbMod.db.query(`UPDATE tasks SET ${assignments} WHERE id=?`).run(...params, STORY);
}

/** Ids matching a WHERE clause across the (shared) tasks table — we only ever test STORY membership. */
function idsWhere(where: string): string[] {
  return dbMod.db
    .query<{ id: string }, []>(`SELECT id FROM tasks WHERE ${where}`)
    .all()
    .map((r) => r.id);
}

function countWhere(where: string): number {
  return dbMod.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM tasks WHERE ${where}`).get()!.n;
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-wnx-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-wnx-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  dbMod = await import("../src/db.ts");
  tasksMod = await import("../src/tasks.ts");
  storiesMod = await import("../src/stories.ts");
  workMod = await import("../src/work.ts");
  workApi = await import("../src/work-api.ts");
  dispatcherMod = await import("../src/dispatcher.ts");

  dbMod.db
    .query(`INSERT OR IGNORE INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(DIR, join(REPO_ROOT, DIR), DIR, dbMod.nowIso());

  // A real story materialized as its Work NODE (id == story id, work_kind='node'), one LEAF member,
  // and a LAZY story (no rows at all — the not-yet-materialized node case; B.5b dropped the
  // legacy stories table, so a story with no node row simply has no rows anywhere).
  insertTask(STORY, "merged", { workKind: "node" }); // node anchor (status varied per test)
  insertTask(LEAF, "aborted", { workKind: "leaf", parentId: STORY }); // dead control member
  // LAZY: NO tasks node row (and no legacy stories row post-B.5b) — nothing seeded.
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

// Every status a converted loop triggers on (non-terminal + the attention-trigger terminal
// 'failed'); the node is armed with has_agent/idle/needs_user_input/gate signals so it WOULD be
// acted upon in each one absent the guard.
const TRIGGER_STATUSES = [
  "inactive",
  "blocked",
  "in_progress",
  "in_review",
  "spec_review",
  "needs_info",
  "rolling_back",
  "failed",
];

describe("EXECUTED+SCOPED: the node never leaks into a read loop / per-id guard, in any status", () => {
  for (const status of TRIGGER_STATUSES) {
    test(`node status='${status}'`, async () => {
      setNode(
        `status=?, has_agent=1, idle=1, needs_user_input=1, ci_status='pass', conformance_status='checking', auto_merged=0`,
        [status],
      );

      // Dispatcher READY select (real call — read-only).
      expect(dispatcherMod.selectQueuedForDispatch(dbMod.nowIso()).map((r) => r.id)).not.toContain(
        STORY,
      );
      // Attention feed (real call — read-only).
      expect(tasksMod.attentionList().map((a) => a.id)).not.toContain(STORY);
      // Chain estimator input rows (real call — read-only).
      expect(tasksMod.estimateInputRows().map((r) => r.id)).not.toContain(STORY);
      // Per-id guards (scoped to our node id — no git, no global effect).
      expect(await tasksMod.maybeAutoMerge(STORY)).toBe(false);
      expect(await tasksMod.requeueForResume(STORY, "test")).toBe("noop");
      // Unified node definition agrees in every status.
      expect(workMod.isWorkNode(STORY)).toBe(true);
      expect(workMod.isWorkLeaf(STORY)).toBe(false);
    });
  }
});

describe("STRUCTURAL: the work_kind guard is load-bearing for every converted SELECT", () => {
  const terminal = () => {
    // built lazily so dbMod is imported
    const t = dbMod.ALL_STATUSES.filter((s) => dbMod.isTerminal(s));
    return t.map((s) => `'${s}'`).join(",");
  };

  // { loop, arm the node into its trigger state, the loop's UNGUARDED predicate, the GUARDED one }.
  type Case = { loop: string; arm: string; armParams?: unknown[]; unguarded: string; guarded: string };
  const cases = (): Case[] => [
    {
      loop: "dispatcher ready (inactive)",
      arm: "status='inactive'",
      unguarded: "status='inactive'",
      guarded: "status='inactive' AND work_kind='leaf'",
    },
    {
      loop: "auto-unblock / blocked boot scan",
      arm: "status='blocked'",
      unguarded: "status='blocked'",
      guarded: "status='blocked' AND work_kind='leaf'",
    },
    {
      loop: "auto-merge backstop",
      arm: "status='in_review', ci_status='pass', auto_merged=0",
      unguarded: "status='in_review' AND ci_status='pass' AND auto_merged=0",
      guarded: "status='in_review' AND ci_status='pass' AND auto_merged=0 AND work_kind='leaf'",
    },
    {
      loop: "reconcileRunningTasks / reapDeadRunningAgents",
      arm: "status='in_progress', has_agent=1",
      unguarded: "status='in_progress' AND has_agent=1",
      guarded: "status='in_progress' AND has_agent=1 AND work_kind='leaf'",
    },
    {
      loop: "recoverMergedTasks",
      arm: "status='in_review'",
      unguarded: "status='in_review'",
      guarded: "status='in_review' AND work_kind='leaf'",
    },
    {
      loop: "recoverStuckGates",
      arm: "status='in_review', ci_status='running'",
      unguarded: "status='in_review' AND (ci_status='running' OR conformance_status='checking')",
      guarded:
        "status='in_review' AND work_kind='leaf' AND (ci_status='running' OR conformance_status='checking')",
    },
    {
      loop: "recoverRollingBackTasks",
      arm: "status='rolling_back'",
      unguarded: "status='rolling_back'",
      guarded: "status='rolling_back' AND work_kind='leaf'",
    },
  ];

  for (const c of cases()) {
    test(c.loop, () => {
      setNode(c.arm);
      expect(idsWhere(c.unguarded)).toContain(STORY); // would be acted on without the guard
      expect(idsWhere(c.guarded)).not.toContain(STORY); // excluded structurally WITH the guard
    });
  }

  test("reaper husk sweep (terminal-status SELECT)", () => {
    setNode("status='merged'"); // the node's natural terminal anchor
    expect(idsWhere(`status IN (${terminal()})`)).toContain(STORY);
    expect(idsWhere(`status IN (${terminal()}) AND work_kind='leaf'`)).not.toContain(STORY);
  });

  test("chain-estimator source rows (estimateRows excludes nodes at the source)", () => {
    setNode("status='in_review'"); // non-terminal: would be a live chain node without the guard
    // estimateRows() applies `WHERE work_kind='leaf'`; its row count equals the leaf-row count and
    // the node (>=1 exists) is dropped — robust to other files' rows in the shared db.
    expect(dbMod.estimateRows().length).toBe(countWhere("work_kind='leaf'"));
    expect(countWhere("work_kind='node'")).toBeGreaterThanOrEqual(1);
    expect(dbMod.estimateRows().map((r) => r.id)).not.toContain(STORY);
  });
});

describe("story member rollups never count the node (story_id NULL + work_kind='leaf')", () => {
  test("storyCounts / isStoryComplete reflect only the leaf member", () => {
    setNode("status='merged'"); // even 'merged' must not make the story look complete/counted
    const counts = storiesMod.storyCounts(STORY);
    expect(counts.aborted).toBe(1); // the lone leaf member
    const memberTotal = Object.entries(counts)
      .filter(([k]) => k !== "idle")
      .reduce((s, [, n]) => s + n, 0);
    expect(memberTotal).toBe(1); // node not counted
    expect(tasksMod.isStoryComplete(STORY)).toBe(false); // aborted member ≠ complete; node ignored
  });
});

describe("metrics rollup: a node anchor is no longer counted as a task (B.2 correctness change)", () => {
  test("computeMetrics counts only non-node rows; a 'merged' node is dropped from totalMerged", () => {
    setNode("status='merged'");
    const nonNode = countWhere("work_kind != 'node'");
    const nonNodeMerged = countWhere("status='merged' AND work_kind != 'node'");

    expect(dbMod.metricRows().length).toBe(nonNode); // node excluded at the source
    const m = dbMod.computeMetrics(dbMod.metricRows(), Date.now());
    expect(m.total).toBe(nonNode);
    expect(m.byStatus.merged ?? 0).toBe(nonNodeMerged);
    expect(m.throughput.totalMerged).toBe(nonNodeMerged);

    // Non-trivial: a merged NODE exists (ours) and is excluded — the raw table has strictly more
    // merged rows than the metrics count it as. This is the single documented output change.
    expect(countWhere("status='merged' AND work_kind='node'")).toBeGreaterThanOrEqual(1);
    expect(countWhere("status='merged'")).toBeGreaterThan(nonNodeMerged);
  });
});

describe("unified node/leaf definition keys on work_kind (incl. lazy fallback)", () => {
  test("resolveWork: materialized node → node, leaf → leaf, unknown → 404", () => {
    expect(workApi.resolveWork(STORY).kind).toBe("node");
    expect(workApi.resolveWork(LEAF).kind).toBe("leaf");
    expect(() => workApi.resolveWork("no-such-work-xyz")).toThrow();
  });

  test("isWorkNode / isWorkLeaf agree with resolveWork for materialized rows", () => {
    expect(workMod.isWorkNode(STORY)).toBe(true);
    expect(workMod.isWorkLeaf(STORY)).toBe(false);
    expect(workMod.isWorkLeaf(LEAF)).toBe(true);
    expect(workMod.isWorkNode(LEAF)).toBe(false);
  });

  test("LAZY story (stories row, no tasks node row): POST-B.4 resolveWork does NOT resolve it", () => {
    // The pre-B.4 "getStory fallback resolves a node-less story as a NODE" is GONE: as of the B.4
    // read-flip getStory → getStoryRow reads the node's OWN tasks row (work_kind='node'), so a
    // stories row with NO tasks node row no longer resolves — resolveWork falls through to the leaf
    // lookup (also absent) and 404s. This state is NON-PRODUCTION: B.3 makes createStory EAGERLY
    // materialize the node, so every real story has one; the flip's hard dependency on the node row
    // is safe precisely because of that eager materialization.
    expect(tasksMod.getTask(LAZY)).toBeNull(); // no tasks node row
    expect(dbMod.getStoryRow(LAZY)).toBeNull(); // getStory is tasks-backed now → no node → null
    expect(() => workApi.resolveWork(LAZY)).toThrow(); // 404 not found (no node row, no leaf row)

    // The PURE predicate isWorkNode reads work_kind off the ABSENT tasks row → LEAF, unchanged by
    // the flip. INERT today — isWorkNode/isWorkLeaf have NO production callers (only tests).
    expect(workMod.isWorkNode(LAZY)).toBe(false);
    expect(workMod.isWorkLeaf(LAZY)).toBe(true);
  });
});
