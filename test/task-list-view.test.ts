// Tests for the DIRECTORY TASK-LIST projection (tasks.taskListView, behind
// `GET /api/workspaces/:id/tasks`). Per CONTRIBUTING §3 the list endpoint returns
// the parsed `taskView` shape — NOT raw DB rows — so the webapp/CLI consume one
// consistent form: `blocked_by` / `spawned_subtasks` come back as real id arrays
// (the DB stores them as JSON-string TEXT) and each blocker's status is precomputed
// (`blockerStates` / `deadBlockers`). It is the LIGHTER sibling of taskView: it does
// NOT carry the task.md-derived prompt/context/review_notes or the duration estimate
// (the list/board/graph views don't use those).
//
// Pure / in-process: no real claude or herdr. Rows are seeded straight into the DB
// so we control status / blocked_by / spawned_subtasks / created_at ordering.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
// Distinct workspace id — the db/config singletons are shared across test files, so
// a unique dir keeps this file's rows from colliding with another file's.
const DIR_ID = "list-view-dir";
const OTHER_DIR_ID = "list-view-other-dir";

let tasksMod: typeof import("../src/tasks.ts");
let dbMod: typeof import("../src/db.ts");

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-listview-data-"));
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  dbMod = await import("../src/db.ts");
  tasksMod = await import("../src/tasks.ts");

  for (const id of [DIR_ID, OTHER_DIR_ID]) {
    dbMod.db
      .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
      .run(id, `/tmp/${id}`, "test", dbMod.nowIso());
  }
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

/** Seed a bare DB-row task with explicit status / blocked_by / spawned_subtasks. */
function seed(opts: {
  id: string;
  status: string;
  createdAt: string;
  blockedBy?: string[];
  spawnedSubtasks?: string[];
  kind?: string;
  idle?: number;
  ciStatus?: string;
  workspaceId?: string;
}): string {
  dbMod.db
    .query(
      `INSERT INTO tasks (id, workspace_id, status, blocked_by, spawned_subtasks,
         kind, idle, ci_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.id,
      opts.workspaceId ?? DIR_ID,
      opts.status,
      opts.blockedBy ? JSON.stringify(opts.blockedBy) : null,
      opts.spawnedSubtasks ? JSON.stringify(opts.spawnedSubtasks) : null,
      opts.kind ?? "task",
      opts.idle ?? 0,
      opts.ciStatus ?? null,
      opts.createdAt,
    );
  return opts.id;
}

test("parses blocked_by / spawned_subtasks into real id arrays (not JSON strings)", () => {
  seed({ id: "lv-blk-merged", status: "merged", createdAt: "2026-01-01T00:00:00.000Z" });
  seed({
    id: "lv-task",
    status: "blocked",
    createdAt: "2026-01-01T00:00:01.000Z",
    blockedBy: ["lv-blk-merged"],
  });
  seed({
    id: "lv-plan",
    status: "decomposed",
    kind: "plan",
    createdAt: "2026-01-01T00:00:02.000Z",
    spawnedSubtasks: ["lv-blk-merged", "lv-task"],
  });

  const byId = new Map(tasksMod.taskListView(DIR_ID).map((t) => [t.id, t]));

  const task = byId.get("lv-task")!;
  expect(Array.isArray(task.blocked_by)).toBe(true);
  expect(task.blocked_by).toEqual(["lv-blk-merged"]);

  const plan = byId.get("lv-plan")!;
  expect(Array.isArray(plan.spawned_subtasks)).toBe(true);
  expect(plan.spawned_subtasks).toEqual(["lv-blk-merged", "lv-task"]);

  // A task with no deps reports empty arrays, never null / a raw string.
  const blk = byId.get("lv-blk-merged")!;
  expect(blk.blocked_by).toEqual([]);
  expect(blk.spawned_subtasks).toEqual([]);
});

test("precomputes blockerStates and deadBlockers (matching the detail view)", () => {
  seed({ id: "lv-bs-running", status: "running", createdAt: "2026-01-02T00:00:00.000Z" });
  seed({ id: "lv-bs-aborted", status: "aborted", createdAt: "2026-01-02T00:00:01.000Z" });
  seed({
    id: "lv-bs-task",
    status: "blocked",
    createdAt: "2026-01-02T00:00:02.000Z",
    // a live blocker, a dead (aborted) blocker, and one that doesn't exist ("gone").
    blockedBy: ["lv-bs-running", "lv-bs-aborted", "lv-bs-ghost"],
  });

  const v = tasksMod.taskListView(DIR_ID).find((t) => t.id === "lv-bs-task")!;
  expect(v.blockerStates).toEqual({
    "lv-bs-running": "running",
    "lv-bs-aborted": "aborted",
    "lv-bs-ghost": "gone",
  });
  // dead = terminal-non-merged (aborted) OR gone; the running one is still pending.
  expect(v.deadBlockers.sort()).toEqual(["lv-bs-aborted", "lv-bs-ghost"]);

  // ...and it agrees with the single-task detail projection for the same task.
  const detail = tasksMod.taskView("lv-bs-task")!;
  expect(v.blockerStates).toEqual(detail.blockerStates);
  expect(v.deadBlockers.sort()).toEqual(detail.deadBlockers.sort());
});

test("is the LIGHT projection: no task.md bodies or estimate, but keeps row fields", () => {
  seed({
    id: "lv-light",
    status: "running",
    createdAt: "2026-01-03T00:00:00.000Z",
    idle: 1,
    ciStatus: "pass",
  });
  const v = tasksMod.taskListView(DIR_ID).find((t) => t.id === "lv-light")!;

  // Omitted (these are what made it lighter than the full taskView).
  expect("prompt" in v).toBe(false);
  expect("context" in v).toBe(false);
  expect("review_notes" in v).toBe(false);
  expect("estimate" in v).toBe(false);

  // Plain row scalars survive via the `...row` spread.
  expect(v.status).toBe("running");
  expect(v.idle).toBe(1);
  expect(v.ci_status).toBe("pass");
});

test("scoped to the workspace and ordered newest-first", () => {
  seed({ id: "lv-ord-old", status: "queued", createdAt: "2026-01-04T00:00:00.000Z" });
  seed({ id: "lv-ord-new", status: "queued", createdAt: "2026-01-04T00:00:05.000Z" });
  // A task in a different workspace must not leak into this list.
  seed({
    id: "lv-other",
    status: "queued",
    createdAt: "2026-01-04T00:00:10.000Z",
    workspaceId: OTHER_DIR_ID,
  });

  const ids = tasksMod.taskListView(DIR_ID).map((t) => t.id);
  expect(ids).not.toContain("lv-other");
  // created_at DESC: the newer of our two pair sorts ahead of the older.
  expect(ids.indexOf("lv-ord-new")).toBeLessThan(ids.indexOf("lv-ord-old"));
});
