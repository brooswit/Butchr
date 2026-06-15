// Tests for the STORIES data model + CRUD (Phase 1 — see src/stories.ts, the `stories`
// table + tasks.story_id column in db.ts). A story is a CONTAINER that groups subtasks;
// this phase is purely persistence + CRUD, fully inert (no agent/dispatch/responder).
//
// Pure / in-process: no real claude/herdr/bun is spawned (BUTCHR_HERDR_BIN points at
// `true` so herdr probes are no-ops). Workspace + task rows are inserted directly (no
// registerWorkspace, which would need a live herdr). The db/config singletons are SHARED
// across test files, so we use distinct ids and assert only on our own rows.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
// Distinct ids — the db/config singletons are shared across test files.
const WS_A = "stories-ws-a";
const WS_B = "stories-ws-b";

let storiesMod: typeof import("../src/stories.ts");
let tasksMod: typeof import("../src/tasks.ts");
let dbMod: typeof import("../src/db.ts");

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-stories-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-stories-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  dbMod = await import("../src/db.ts");
  storiesMod = await import("../src/stories.ts");
  tasksMod = await import("../src/tasks.ts");

  const insWs = (id: string) =>
    dbMod.db
      .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
      .run(id, join(REPO_ROOT, id), id, dbMod.nowIso());
  insWs(WS_A);
  insWs(WS_B);
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

/** Seed a bare task row in a workspace (status defaults to inactive). */
function seedTask(id: string, ws: string, status = "inactive") {
  dbMod.db
    .query(`INSERT INTO tasks (id, workspace_id, status, created_at) VALUES (?, ?, ?, ?)`)
    .run(id, ws, status, dbMod.nowIso());
}

describe("story CRUD", () => {
  test("create a story in a workspace, then list it", () => {
    const story = storiesMod.createStory(WS_A, "Ship the widget");
    expect(story.id).toMatch(/^st-/);
    expect(story.workspace_id).toBe(WS_A);
    expect(story.brief).toBe("Ship the widget");
    expect(story.status).toBe("open");

    const list = storiesMod.listStories(WS_A);
    expect(list.some((s) => s.id === story.id)).toBe(true);
    // getStory round-trips the same row.
    expect(storiesMod.getStory(story.id)!.brief).toBe("Ship the widget");
  });

  test("createStory 404s on an unknown workspace and 400s on a blank brief", () => {
    expect(() => storiesMod.createStory("nope", "x")).toThrow(/workspace not found/);
    expect(() => storiesMod.createStory(WS_A, "   ")).toThrow(/brief is required/);
  });

  test("updateStory changes status (open → done)", () => {
    const story = storiesMod.createStory(WS_A, "Refactor auth");
    const updated = storiesMod.updateStory(story.id, { status: "done" });
    expect(updated.status).toBe("done");
    // Persisted on the row.
    expect(storiesMod.getStory(story.id)!.status).toBe("done");
  });

  test("updateStory rejects a bad status and 404s on an unknown story", () => {
    const story = storiesMod.createStory(WS_A, "Tweak");
    expect(() => storiesMod.updateStory(story.id, { status: "bogus" })).toThrow(
      /must be 'open', 'done', or 'aborted'/,
    );
    expect(() => storiesMod.updateStory("missing", { status: "open" })).toThrow(
      /story not found/,
    );
  });
});

describe("task ↔ story assignment", () => {
  test("assign a task to a story and read story_id back on the task view", () => {
    const story = storiesMod.createStory(WS_A, "Grouping story");
    seedTask("st-task-1", WS_A);
    const view = storiesMod.assignTaskToStory("st-task-1", story.id);
    expect(view.story_id).toBe(story.id);
    // The full task view round-trips it too.
    expect(tasksMod.taskView("st-task-1")!.story_id).toBe(story.id);
  });

  test("clearing a task's story (null) detaches it", () => {
    const story = storiesMod.createStory(WS_A, "Temp group");
    seedTask("st-task-clear", WS_A);
    storiesMod.assignTaskToStory("st-task-clear", story.id);
    const cleared = storiesMod.assignTaskToStory("st-task-clear", null);
    expect(cleared.story_id).toBeNull();
  });

  test("reject assigning a story from a DIFFERENT workspace", () => {
    const storyB = storiesMod.createStory(WS_B, "B's story");
    seedTask("st-task-xws", WS_A); // task in WS_A
    expect(() => storiesMod.assignTaskToStory("st-task-xws", storyB.id)).toThrow(
      /different workspace/,
    );
    // The task was not modified.
    expect(tasksMod.taskView("st-task-xws")!.story_id).toBeNull();
  });

  test("assignTaskToStory 404s on an unknown task or story", () => {
    const story = storiesMod.createStory(WS_A, "Whatever");
    expect(() => storiesMod.assignTaskToStory("no-such-task", story.id)).toThrow(
      /task not found/,
    );
    seedTask("st-task-badstory", WS_A);
    expect(() => storiesMod.assignTaskToStory("st-task-badstory", "no-such-story")).toThrow(
      /story not found/,
    );
  });
});

describe("deleteStory NULLs out member tasks (does not delete them)", () => {
  test("member tasks survive with story_id cleared", () => {
    const story = storiesMod.createStory(WS_A, "Doomed grouping");
    seedTask("st-member-1", WS_A);
    seedTask("st-member-2", WS_A);
    storiesMod.assignTaskToStory("st-member-1", story.id);
    storiesMod.assignTaskToStory("st-member-2", story.id);

    storiesMod.deleteStory(story.id);

    // The story is gone...
    expect(storiesMod.getStory(story.id)).toBeNull();
    // ...but the tasks survive, with their story_id NULLed out.
    expect(tasksMod.getTask("st-member-1")).not.toBeNull();
    expect(tasksMod.getTask("st-member-2")).not.toBeNull();
    expect(tasksMod.getTask("st-member-1")!.story_id).toBeNull();
    expect(tasksMod.getTask("st-member-2")!.story_id).toBeNull();
  });

  test("deleteStory 404s on an unknown story", () => {
    expect(() => storiesMod.deleteStory("missing")).toThrow(/story not found/);
  });
});

describe("workspace deletion cascade-deletes its stories", () => {
  test("removing a workspace removes its stories (FK cascade)", () => {
    const WS_C = "stories-ws-c";
    dbMod.db
      .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
      .run(WS_C, join(REPO_ROOT, WS_C), WS_C, dbMod.nowIso());
    const s1 = storiesMod.createStory(WS_C, "C story 1");
    const s2 = storiesMod.createStory(WS_C, "C story 2");
    expect(storiesMod.listStories(WS_C).length).toBe(2);

    // Direct workspace delete (PRAGMA foreign_keys=ON → cascade).
    dbMod.db.query(`DELETE FROM workspaces WHERE id=?`).run(WS_C);

    expect(storiesMod.getStory(s1.id)).toBeNull();
    expect(storiesMod.getStory(s2.id)).toBeNull();
    expect(storiesMod.listStories(WS_C).length).toBe(0);
  });
});
