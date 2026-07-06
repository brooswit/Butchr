// WORK-UNIFICATION FOLD SCHEMA (REVAMP Phase B.1 — story st-6372812d). Guards the ADDITIVE +
// INERT columns the fold lays on `tasks` so a story NODE's OWN row can LATER become authoritative
// (replacing the separate `stories` table). This step changes NO reads / routing / behavior; it
// only ADDS columns + backfills them. The test pins:
//   1. SCHEMA — work_kind + the four node-only mirror columns (brief/isolated/pending_ask/
//      ask_responder) exist on `tasks`.
//   2. BACKFILL CORRECTNESS — a materialized story NODE (id ∈ stories) carries work_kind='node'
//      + the node-only fields copied from its `stories` row; a LEAF (id ∉ stories) keeps the
//      'leaf' DEFAULT + unset mirror columns; a CHILDLESS story still gets a stamped node.
//   3. BACKFILL RE-SYNC — migrateBackfillNodeFold re-flips a node whose work_kind was reset to
//      the 'leaf' DEFAULT (the belt for a node materialized by a PRE-fold run).
//   4. IDEMPOTENCE — re-running the full boot pass leaves the rows byte-identical.
//
// Pure / in-process (mirrors db-story-accessors.test.ts): rows are seeded directly via the db
// singleton + the exported runtime materializer. The db/config singletons are SHARED across test
// files, so we use DISTINCT ids and assert only on our own rows; runMigrations() is idempotent
// across the shared DB.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
let dbMod: typeof import("../src/db.ts");
let tasksMod: typeof import("../src/tasks.ts");
let workApiMod: typeof import("../src/work-api.ts");

// The five fold columns persisted on `tasks` this step — they must NOT leak onto any
// serialized task view (TaskView / TaskListView / the unified work list).
const FOLD_COLS = ["work_kind", "brief", "isolated", "pending_ask", "ask_responder"] as const;

// Distinct ids — the db/config singletons are shared across test files.
const WS = "nodefold-ws";
const SN = "st-nodefold-node"; // story WITH a member → node + leaf
const SC = "st-nodefold-childless"; // childless story → node, no members
const LEAF = "task-nodefold-leaf"; // a member leaf task (id NOT in stories)

const nodeCols = (id: string) =>
  dbMod.db
    .query(
      `SELECT work_kind, brief, isolated, pending_ask, ask_responder FROM tasks WHERE id=?`,
    )
    .get(id) as {
    work_kind: string;
    brief: string | null;
    isolated: number;
    pending_ask: string | null;
    ask_responder: string | null;
  } | null;

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-nodefold-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-nodefold-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  dbMod = await import("../src/db.ts");
  tasksMod = await import("../src/tasks.ts");
  workApiMod = await import("../src/work-api.ts");
  const now = dbMod.nowIso();

  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(WS, join(REPO_ROOT, WS), WS, now);

  // Story WITH a member — NON-TRIVIAL node-only field values so the copy is unambiguous.
  dbMod.db
    .query(
      `INSERT INTO stories (id, workspace_id, brief, status, created_at, isolated, pending_ask, ask_responder)
         VALUES (?, ?, ?, 'open', ?, 1, 'leader asks CTO', 'cto')`,
    )
    .run(SN, WS, "Goal A", now);
  // Childless story — distinct values, no members.
  dbMod.db
    .query(
      `INSERT INTO stories (id, workspace_id, brief, status, created_at, isolated, pending_ask, ask_responder)
         VALUES (?, ?, ?, 'open', ?, 0, NULL, NULL)`,
    )
    .run(SC, WS, "Goal C", now);
  // A member LEAF task (id NOT in stories → work_kind stays the 'leaf' DEFAULT).
  dbMod.db
    .query(
      `INSERT INTO tasks (id, workspace_id, status, created_at, story_id) VALUES (?, ?, 'inactive', ?, ?)`,
    )
    .run(LEAF, WS, now, SN);

  // Materialize SN's node via the RUNTIME single-story materializer (the INSERT-stamp path).
  dbMod.ensureStoryWorkNode(SN);
  // SC is left UN-materialized on purpose: the boot pass (migrateUnifyStoryParent) materializes
  // its node, proving a CHILDLESS story still gets a stamped node + a clean backfill.

  // Run the ordered boot pass again: materializes SC's node + runs migrateBackfillNodeFold.
  dbMod.runMigrations();
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

describe("Phase B.1 fold schema — additive columns", () => {
  test("work_kind + the four node-only mirror columns exist on tasks", () => {
    const cols = dbMod.db
      .query(`PRAGMA table_info(tasks)`)
      .all()
      .map((c: any) => c.name);
    expect(cols).toContain("work_kind");
    expect(cols).toContain("brief");
    expect(cols).toContain("isolated");
    expect(cols).toContain("pending_ask");
    expect(cols).toContain("ask_responder");
  });
});

describe("Phase B.1 fold schema — backfill correctness", () => {
  test("a materialized story NODE carries work_kind='node' + the node-only fields copied", () => {
    const n = nodeCols(SN)!;
    expect(n.work_kind).toBe("node");
    expect(n.brief).toBe("Goal A");
    expect(n.isolated).toBe(1);
    expect(n.pending_ask).toBe("leader asks CTO");
    expect(n.ask_responder).toBe("cto");
  });

  test("a LEAF (id ∉ stories) keeps the 'leaf' DEFAULT + unset mirror columns", () => {
    const l = nodeCols(LEAF)!;
    expect(l.work_kind).toBe("leaf");
    expect(l.brief).toBeNull();
    expect(l.isolated).toBe(0);
    expect(l.pending_ask).toBeNull();
    expect(l.ask_responder).toBeNull();
  });

  test("a CHILDLESS story still gets a stamped node with its fields copied", () => {
    const c = nodeCols(SC)!;
    expect(c.work_kind).toBe("node");
    expect(c.brief).toBe("Goal C");
    expect(c.isolated).toBe(0);
    expect(c.pending_ask).toBeNull();
    expect(c.ask_responder).toBeNull();
  });
});

describe("Phase B.1 fold schema — backfill re-sync", () => {
  test("migrateBackfillNodeFold re-flips a node reset to the 'leaf' DEFAULT", () => {
    // Simulate a node materialized by a PRE-fold run (work_kind at the DEFAULT, mirror cols unset).
    dbMod.db
      .query(
        `UPDATE tasks SET work_kind='leaf', brief=NULL, isolated=0, pending_ask=NULL, ask_responder=NULL WHERE id=?`,
      )
      .run(SN);
    expect(nodeCols(SN)!.work_kind).toBe("leaf"); // sanity: actually reset

    dbMod.runMigrations(); // the boot backfill catches it

    const n = nodeCols(SN)!;
    expect(n.work_kind).toBe("node");
    expect(n.brief).toBe("Goal A");
    expect(n.isolated).toBe(1);
    expect(n.pending_ask).toBe("leader asks CTO");
    expect(n.ask_responder).toBe("cto");
  });
});

describe("Phase B.1 fold schema — idempotence", () => {
  test("re-running the full boot pass leaves our rows byte-identical", () => {
    const snap = () =>
      dbMod.db
        .query(
          `SELECT id, work_kind, brief, isolated, pending_ask, ask_responder
             FROM tasks WHERE id IN (?, ?, ?) ORDER BY id`,
        )
        .all(SN, SC, LEAF);
    const before = snap();
    dbMod.runMigrations();
    expect(snap()).toEqual(before);
  });
});

// The fold columns are PERSISTED on `tasks` but must stay OFF every serialized task view so
// the read surface is BYTE-IDENTICAL to Phase A (the read-flip is B.4). A `...row` spread would
// otherwise leak them — and `work_kind` would collide with the work-api facade's own
// discriminator. Pin all three view builders (taskView / taskListView / allTasksView) AND the
// unified GET /api/work list (listWork → allTasksView) so a regression at any one is caught.
describe("Phase B.1 fold schema — INERT: columns do not leak onto task views", () => {
  test("taskView (leaf + node anchor) carries none of the 5 fold columns", () => {
    const leaf = tasksMod.taskView(LEAF)!;
    const node = tasksMod.taskView(SN)!;
    for (const k of FOLD_COLS) {
      expect(k in leaf).toBe(false);
      expect(k in node).toBe(false);
    }
  });

  test("the per-workspace taskListView carries none of the 5 fold columns", () => {
    const leaf = tasksMod.taskListView(WS).find((t) => t.id === LEAF)!;
    expect(leaf).toBeDefined();
    for (const k of FOLD_COLS) expect(k in leaf).toBe(false);
  });

  test("the cross-workspace allTasksView (GET /api/work source) carries none of the 5 fold columns", () => {
    const leaf = tasksMod.allTasksView({ workspace: WS }).find((t) => t.id === LEAF)!;
    expect(leaf).toBeDefined();
    for (const k of FOLD_COLS) expect(k in leaf).toBe(false);
  });

  test("the unified GET /api/work list adds work_kind='leaf' from the FACADE — never the 4 node-only fields", async () => {
    const list = await workApiMod.listWork({ workspace: WS });
    const leaf = list.find((w) => w.id === LEAF)!;
    expect(leaf).toBeDefined();
    // The facade's discriminator is present + correct...
    expect(leaf.work_kind).toBe("leaf");
    // ...but the 4 node-only mirror columns must NOT have leaked through allTasksView.
    for (const k of ["brief", "isolated", "pending_ask", "ask_responder"] as const) {
      expect(k in leaf).toBe(false);
    }
  });
});
