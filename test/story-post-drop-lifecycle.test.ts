// GATE (a) for REVAMP-2 Phase B.5b (story st-78a8b4e7) — the DESTRUCTIVE-FLIP belt.
//
// Boots on the POST-DROP schema (importing db.ts runs the full ordered migration pass, whose
// LAST step — migrateDropStoriesMirror — drops the `stories` table + the `tasks.story_id` column
// and re-points story_agent's FK from stories(id) → tasks(id)). It then drives the FULL story
// lifecycle purely through the service API, asserting that EVERY read / loop / recovery works with
// the story NODE's own `tasks` row (work_kind='node') as the SOLE source and membership resolved
// by `parent_id`. This is the belt that proves NO code still references the dropped objects.
//
// Pure / in-process (BUTCHR_HERDR_BIN=true → herdr probes are no-ops; leader launches are
// best-effort fire-and-forget and never touch the assertions here). The db/config singletons are
// shared across test files, so we use distinct ids and assert only on our own rows.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
const WS = "b5b-post-drop-ws";

let dbMod: typeof import("../src/db.ts");
let storiesMod: typeof import("../src/stories.ts");
let tasksMod: typeof import("../src/tasks.ts");

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-b5b-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-b5b-repo-"));
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  dbMod = await import("../src/db.ts"); // module-load runs the FULL pass incl. the drop
  storiesMod = await import("../src/stories.ts");
  tasksMod = await import("../src/tasks.ts");

  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(WS, join(REPO_ROOT, WS), WS, dbMod.nowIso());
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

const tableExists = (name: string): boolean =>
  !!dbMod.db
    .query<{ name: string }, [string]>(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(name);
const taskCols = (): string[] =>
  dbMod.db.query<{ name: string }, []>(`PRAGMA table_info(tasks)`).all().map((c) => c.name);

function seedTask(id: string, status = "inactive") {
  dbMod.db
    .query(`INSERT INTO tasks (id, workspace_id, status, created_at) VALUES (?, ?, ?, ?)`)
    .run(id, WS, status, dbMod.nowIso());
}
/** Seed a member directly on a story NODE (bypasses the leader-launch side effects of the
 *  service). Membership is by parent_id (the SOLE pointer — story_id column is dropped). */
function seedMember(id: string, parentId: string, status: string) {
  dbMod.db
    .query(
      `INSERT INTO tasks (id, workspace_id, status, parent_id, created_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, WS, status, parentId, dbMod.nowIso());
}

describe("B.5b: the stories mirror + story_id column are gone", () => {
  test("stories table dropped, tasks.story_id column dropped, parent_id remains", () => {
    expect(tableExists("stories")).toBe(false);
    expect(taskCols()).not.toContain("story_id");
    expect(taskCols()).toContain("parent_id");
  });

  test("story_agent survives with its FK re-pointed to tasks(id)", () => {
    expect(tableExists("story_agent")).toBe(true);
    const ddl = dbMod.db
      .query<{ sql: string }, []>(`SELECT sql FROM sqlite_master WHERE name='story_agent'`)
      .get()!.sql;
    expect(ddl).toContain("REFERENCES tasks(id)");
    expect(ddl).not.toContain("REFERENCES stories");
  });

  test("the full migration pass is idempotent + green on the post-drop db", () => {
    dbMod.runMigrations();
    dbMod.runMigrations();
    const outcome = dbMod.getLastMigrationOutcome();
    expect(outcome.ok).toBe(true);
    expect(outcome.error).toBeNull();
    // still gone after re-running
    expect(tableExists("stories")).toBe(false);
    expect(taskCols()).not.toContain("story_id");
  });
});

describe("B.5b: createStory materializes the node as the SOLE story record", () => {
  test("createStory → getStory / listStories read the node; it is a work_kind='node' tasks row", () => {
    const s = storiesMod.createStory(WS, "Node-authoritative story");
    expect(s.id).toMatch(/^st-/);
    expect(s.status).toBe("open");
    expect(s.brief).toBe("Node-authoritative story");

    // getStory reads the node row (post-drop authoritative source).
    expect(storiesMod.getStory(s.id)!.id).toBe(s.id);
    const node = dbMod.db
      .query<{ work_kind: string; status: string; parent_id: string | null }, [string]>(
        `SELECT work_kind, status, parent_id FROM tasks WHERE id=?`,
      )
      .get(s.id)!;
    expect(node.work_kind).toBe("node");
    expect(node.status).toBe("open");
    expect(node.parent_id).toBeNull(); // a story node is top-level

    expect(storiesMod.listStories(WS).some((r) => r.id === s.id)).toBe(true);
  });
});

describe("B.5b: membership + rollups resolve via parent_id", () => {
  test("assignTaskToStory wires parent_id; the wire story_id field round-trips (from parent_id)", () => {
    const s = storiesMod.createStory(WS, "Membership story");
    seedTask("b5b-m-assign");
    const view = storiesMod.assignTaskToStory("b5b-m-assign", s.id);
    expect(view.story_id).toBe(s.id); // preserved wire field, re-derived from parent_id
    expect(tasksMod.getTask("b5b-m-assign")!.parent_id).toBe(s.id);
    // clearing membership
    const cleared = storiesMod.assignTaskToStory("b5b-m-assign", null);
    expect(cleared.story_id).toBeNull();
    expect(tasksMod.getTask("b5b-m-assign")!.parent_id).toBeNull();
  });

  test("storyCounts + isStoryComplete + completion detection are correct via parent_id", () => {
    const s = storiesMod.createStory(WS, "Rollup story");
    seedMember("b5b-r-1", s.id, "merged");
    seedMember("b5b-r-2", s.id, "rolled_back");
    seedMember("b5b-r-3", s.id, "in_progress");

    const counts = storiesMod.storyCounts(s.id);
    expect(counts.merged).toBe(1);
    expect(counts.rolled_back).toBe(1);
    expect(counts.in_progress).toBe(1);

    // not complete while a member is still in flight
    expect(tasksMod.isStoryComplete(s.id)).toBe(false);
    // finish the in-flight member → all terminal-merged → complete + completion event fires
    dbMod.db.query(`UPDATE tasks SET status='merged' WHERE id=?`).run("b5b-r-3");
    expect(tasksMod.isStoryComplete(s.id)).toBe(true);
    expect(tasksMod.notifyStoryCompletionIfReady(s.id)).toBe(true);
  });
});

describe("B.5b: state-machine transitions drive the node CAS", () => {
  test("open → done publishes complete + the CAS refuses re-opening a terminal story", () => {
    const s = storiesMod.createStory(WS, "Transition done");
    const done = storiesMod.updateStory(s.id, { status: "done" });
    expect(done.status).toBe("done");
    // re-open of a terminal story is a no-op (CAS from-guard preserved byte-identically)
    expect(storiesMod.updateStory(s.id, { status: "open" }).status).toBe("done");
    // a re-done is likewise a no-op
    expect(storiesMod.updateStory(s.id, { status: "done" }).status).toBe("done");
  });

  test("open → aborted cascades a live member's abort (parent_id-scoped)", async () => {
    const s = storiesMod.createStory(WS, "Transition abort");
    seedMember("b5b-ab-live", s.id, "inactive");
    seedMember("b5b-ab-merged", s.id, "merged");
    const aborted = storiesMod.updateStory(s.id, { status: "aborted" });
    expect(aborted.status).toBe("aborted");
    // the live member is torn down; the already-merged member is preserved
    await Bun.sleep(50);
    expect(tasksMod.getTask("b5b-ab-live")!.status).toBe("aborted");
    expect(tasksMod.getTask("b5b-ab-merged")!.status).toBe("merged");
  });
});

describe("B.5b: story-level ask reads/writes the node", () => {
  test("openStoryAsk → escalateStoryAsk → answerStoryAsk round-trips on the node row", () => {
    const s = storiesMod.createStory(WS, "Ask story");
    const asked = storiesMod.openStoryAsk(s.id, "which approach?");
    expect(asked.pending_ask).toBe("which approach?");
    expect(asked.ask_responder).toBe("cto");
    const escalated = storiesMod.escalateStoryAsk(s.id);
    expect(escalated.ask_responder).toBe("user");
    const answered = storiesMod.answerStoryAsk(s.id, "approach A");
    expect(answered.pending_ask).toBeNull();
    expect(answered.ask_responder).toBeNull();
    // the values live on the node's own tasks row
    const node = dbMod.db
      .query<{ pending_ask: string | null }, [string]>(`SELECT pending_ask FROM tasks WHERE id=?`)
      .get(s.id)!;
    expect(node.pending_ask).toBeNull();
  });
});

describe("B.5b: boot recovery reads the node", () => {
  test("recoverMergingStories re-drives a node left in 'merging' (query keys on the node row)", async () => {
    const s = storiesMod.createStory(WS, "Recover story");
    // Force the NODE into the transient merging state directly (a non-isolated story → landStory
    // no-ops on it, so no git is exercised; this asserts the recovery QUERY reads the node).
    dbMod.db.query(`UPDATE tasks SET status='merging' WHERE id=? AND work_kind='node'`).run(s.id);
    const n = await storiesMod.recoverMergingStories();
    expect(n).toBeGreaterThanOrEqual(1);
  });
});

describe("B.5b: story_agent cascade fires via the re-pointed tasks(id) FK", () => {
  test("createStory writes a story_agent row; deleteStory removes it via ON DELETE CASCADE", () => {
    const s = storiesMod.createStory(WS, "Cascade story");
    // onStoryCreated persisted the leader's story_agent row (keyed by the story id).
    expect(dbMod.getStoryAgentRow(s.id)).not.toBeNull();
    // deleteStory DELETEs the tasks node → the story_agent row cascades away (new FK → tasks(id)).
    storiesMod.deleteStory(s.id);
    expect(storiesMod.getStory(s.id)).toBeNull();
    expect(dbMod.getStoryAgentRow(s.id)).toBeNull();
  });
});
