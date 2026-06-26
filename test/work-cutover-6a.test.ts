// WORK + WORKSPACE UNIFICATION — step 6a CUTOVER (story st-540ba705). Proves the
// BACKWARD-SAFE + IDEMPOTENT activation migration (db.migrateUnifyStoryParent) and that the
// LIVE feedback routing (tasks.pendingResponder, config.unifiedWork DEFAULT ON) now resolves
// over the backfilled `parent_id`:
//   1. Every story member's parent_id is BACKFILLED from its story_id.
//   2. Each story is MATERIALIZED as a Work NODE — a `tasks` row whose id IS the story id,
//      carrying the inert terminal status `merged` (the FK anchor; story state stays in the
//      stories table).
//   3. A standalone task's parent_id stays NULL; the stories table + story_id are intact.
//   4. IDEMPOTENT — re-running the full boot pass twice more changes nothing (no duplicate
//      nodes, no clobbered parent_id).
//   5. ROUTING — a migrated member resolves 'story' (the depth-1 instance, byte-identical to
//      the old story rule); a standalone task resolves 'cto'.
//
// Mirrors test/work-workspace-foundation.test.ts: db.ts's boot pass runs at import in an
// ISOLATED SUBPROCESS bound to a seeded DB via BUTCHR_DB (never the live DB). Legacy rows are
// seeded (members with story_id but parent_id NULL, stories NOT yet materialized) AFTER the
// first boot, then runMigrations() re-runs the ordered pass — exercising the real migration.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let out: any;

const SUBPROCESS = `
const m = await import(process.env.DB_TS);
const ts = "2026-06-01T00:00:00.000Z";

// Workspace + three stories (open / done / aborted) + member tasks carrying story_id but NO
// parent_id (the pre-6a shape — story_id is a plain TEXT column, so this is FK-legal), plus a
// standalone task. The stories are NOT yet materialized as tasks rows.
m.db.query("INSERT INTO workspaces (id, path, created_at) VALUES ('dir-1','/tmp/ws-1',?)").run(ts);
m.db.query("INSERT INTO stories (id, workspace_id, brief, status, created_at) VALUES ('st-open','dir-1','o','open',?)").run(ts);
m.db.query("INSERT INTO stories (id, workspace_id, brief, status, created_at) VALUES ('st-done','dir-1','d','done',?)").run(ts);
m.db.query("INSERT INTO stories (id, workspace_id, brief, status, created_at) VALUES ('st-abrt','dir-1','a','aborted',?)").run(ts);
m.db.query("INSERT INTO tasks (id, workspace_id, status, story_id, created_at) VALUES ('m1','dir-1','in_review','st-open',?)").run(ts);
m.db.query("INSERT INTO tasks (id, workspace_id, status, story_id, created_at) VALUES ('m2','dir-1','needs_info','st-open',?)").run(ts);
m.db.query("INSERT INTO tasks (id, workspace_id, status, story_id, created_at) VALUES ('m3','dir-1','idea','st-done',?)").run(ts);
m.db.query("INSERT INTO tasks (id, workspace_id, status, created_at) VALUES ('solo','dir-1','in_review',?)").run(ts);

const before = m.db.query("SELECT id, story_id, parent_id FROM tasks ORDER BY id").all();

// Run the full ordered boot pass over the seeded legacy rows (includes migrateUnifyStoryParent).
m.runMigrations();
const after1 = m.db.query("SELECT id, status, story_id, parent_id FROM tasks ORDER BY id").all();
const nodes1 = m.db.query("SELECT id, status, story_id, parent_id FROM tasks WHERE id LIKE 'st-%' ORDER BY id").all();
const storiesIntact = m.db.query("SELECT id, status FROM stories ORDER BY id").all();

// IDEMPOTENCE — run the pass twice more; nothing should change.
m.runMigrations();
m.runMigrations();
const after2 = m.db.query("SELECT id, status, story_id, parent_id FROM tasks ORDER BY id").all();
const taskCount = m.db.query("SELECT COUNT(*) AS n FROM tasks").get().n;

// LIVE ROUTING — pendingResponder (unifiedWork ON) over the backfilled parent_id.
const tasks = await import(process.env.TASKS_TS);
const route = {
  m1: tasks.pendingResponder(tasks.getTask('m1')),
  m2: tasks.pendingResponder(tasks.getTask('m2')),
  solo: tasks.pendingResponder(tasks.getTask('solo')),
};

console.log("RESULT:" + JSON.stringify({ before, after1, nodes1, storiesIntact, after2, taskCount, route }));
`;

beforeAll(() => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-cutover6a-"));
  const DB_PATH = join(DATA_DIR, "test.db");
  const DB_TS = join(import.meta.dir, "../src/db.ts");
  const TASKS_TS = join(import.meta.dir, "../src/tasks.ts");
  const res = Bun.spawnSync(["bun", "-e", SUBPROCESS], {
    env: {
      ...process.env,
      BUTCHR_DB: DB_PATH,
      BUTCHR_DATA_DIR: DATA_DIR,
      BUTCHR_LOG_FILE: "",
      BUTCHR_HERDR_BIN: "true",
      DB_TS,
      TASKS_TS,
    },
  });
  const stdout = res.stdout.toString();
  const stderr = res.stderr.toString();
  const line = stdout.split("\n").find((l) => l.startsWith("RESULT:"));
  if (!line) {
    throw new Error(`cutover-6a subprocess produced no RESULT (exit ${res.exitCode}).\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  out = JSON.parse(line.slice("RESULT:".length));
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("step 6a — parent_id backfill from story_id", () => {
  test("members start with story_id set and parent_id NULL (pre-migration)", () => {
    const before = Object.fromEntries(out.before.map((t: any) => [t.id, t]));
    expect(before.m1).toEqual({ id: "m1", story_id: "st-open", parent_id: null });
    expect(before.m2).toEqual({ id: "m2", story_id: "st-open", parent_id: null });
    expect(before.m3).toEqual({ id: "m3", story_id: "st-done", parent_id: null });
    expect(before.solo).toEqual({ id: "solo", story_id: null, parent_id: null });
    // No story nodes exist in `tasks` yet.
    expect(out.before.some((t: any) => t.id.startsWith("st-"))).toBe(false);
  });

  test("each member's parent_id is backfilled to its story_id", () => {
    const after = Object.fromEntries(out.after1.map((t: any) => [t.id, t]));
    expect(after.m1.parent_id).toBe("st-open");
    expect(after.m2.parent_id).toBe("st-open");
    expect(after.m3.parent_id).toBe("st-done");
    // story_id is preserved alongside parent_id (lock-step; story_id stays authoritative).
    expect(after.m1.story_id).toBe("st-open");
    expect(after.m3.story_id).toBe("st-done");
  });

  test("a standalone task's parent_id stays NULL", () => {
    const after = Object.fromEntries(out.after1.map((t: any) => [t.id, t]));
    expect(after.solo.parent_id).toBeNull();
    expect(after.solo.story_id).toBeNull();
  });
});

describe("step 6a — each story is materialized as a Work node carrying its REAL story status", () => {
  test("every story has a tasks node (id == story id) carrying the story's real status (B.3)", () => {
    const ids = out.nodes1.map((n: any) => n.id);
    expect(ids).toEqual(["st-abrt", "st-done", "st-open"]);
    // B.3 (story st-6372812d): the node row is the DUAL-WRITE shadow of the story — it carries the
    // story's REAL status, NOT the old frozen `merged` FK anchor. Safe because B.2 excludes nodes
    // from every loop STRUCTURALLY via work_kind, not via the incidental terminal status.
    const expectedStatus: Record<string, string> = {
      "st-abrt": "aborted",
      "st-done": "done",
      "st-open": "open",
    };
    for (const n of out.nodes1) {
      expect(n.status).toBe(expectedStatus[n.id]); // the dual-write shadow of stories.status
      expect(n.parent_id).toBeNull(); // a top-level node
      expect(n.story_id).toBeNull(); // NOT a member of itself (excluded from storyCounts etc.)
    }
  });

  test("the stories table + story statuses are left fully intact", () => {
    expect(out.storiesIntact).toEqual([
      { id: "st-abrt", status: "aborted" },
      { id: "st-done", status: "done" },
      { id: "st-open", status: "open" },
    ]);
  });
});

describe("step 6a — the migration is idempotent", () => {
  test("re-running the boot pass twice more changes nothing", () => {
    expect(out.after2).toEqual(out.after1);
    // 4 original rows (m1, m2, m3, solo) + 3 materialized nodes = 7; no duplicate nodes.
    expect(out.taskCount).toBe(7);
  });
});

describe("step 6a — live routing resolves over the backfilled parent_id", () => {
  test("a migrated member resolves 'story'; a standalone resolves 'cto'", () => {
    expect(out.route.m1).toBe("story");
    expect(out.route.m2).toBe("story");
    expect(out.route.solo).toBe("cto");
  });
});
