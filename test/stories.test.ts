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
let eventsMod: typeof import("../src/events.ts");
let storyAgentMod: typeof import("../src/story-agent.ts");

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
  eventsMod = await import("../src/events.ts");
  storyAgentMod = await import("../src/story-agent.ts");

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

// --- PHASE 6: COMPLETION DETECTION + SURFACING ------------------------------

/** Seed a member task pinned to a story (with optional idle/pane for the idle peel-out). */
function seedMember(
  id: string,
  ws: string,
  storyId: string,
  status: string,
  opts: { idle?: boolean; pane?: string } = {},
) {
  dbMod.db
    .query(
      `INSERT INTO tasks (id, workspace_id, status, story_id, herdr_pane_id, idle, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, ws, status, storyId, opts.pane ?? null, opts.idle ? 1 : 0, dbMod.nowIso());
}

/** Capture every `story.attention` event for a given story while `fn` runs. */
async function captureStoryEvents(
  storyId: string,
  fn: () => void | Promise<void>,
): Promise<Array<Record<string, unknown>>> {
  const got: Array<Record<string, unknown>> = [];
  const unsub = eventsMod.subscribe((e) => {
    const ev = e as Record<string, unknown>;
    if (ev.type === "story.attention" && ev.story_id === storyId) got.push(ev);
  });
  try {
    await fn();
  } finally {
    unsub();
  }
  return got;
}

/** Poll `pred` until true (the leader teardown is fire-and-forget / async). */
async function waitFor(pred: () => boolean, tries = 100, ms = 10): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, ms));
  }
  throw new Error("waitFor timed out");
}

describe("Phase 6: all-subtasks-merged completion detection", () => {
  test("all members merged → completion-review event fires to the leader feed", async () => {
    const story = storiesMod.createStory(WS_A, "Completion story");
    seedMember("st6-c-1", WS_A, story.id, "merged");
    seedMember("st6-c-2", WS_A, story.id, "merged");

    expect(tasksMod.isStoryComplete(story.id)).toBe(true);
    let fired = false;
    const events = await captureStoryEvents(story.id, () => {
      fired = tasksMod.notifyStoryCompletionIfReady(story.id);
    });
    expect(fired).toBe(true);
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({
      type: "story.attention",
      story_id: story.id,
      workspace_id: WS_A,
      target: "story",
      reason: "completion-review",
    });
  });

  test("rolled_back counts as a terminal merged state for completion", () => {
    const story = storiesMod.createStory(WS_A, "Rollback completion");
    seedMember("st6-rb-1", WS_A, story.id, "merged");
    seedMember("st6-rb-2", WS_A, story.id, "rolled_back");
    expect(tasksMod.isStoryComplete(story.id)).toBe(true);
  });

  test("a PARTIAL story (a member still in flight) fires nothing", async () => {
    const story = storiesMod.createStory(WS_A, "Partial story");
    seedMember("st6-p-1", WS_A, story.id, "merged");
    seedMember("st6-p-2", WS_A, story.id, "inactive");

    expect(tasksMod.isStoryComplete(story.id)).toBe(false);
    let fired = true;
    const events = await captureStoryEvents(story.id, () => {
      fired = tasksMod.notifyStoryCompletionIfReady(story.id);
    });
    expect(fired).toBe(false);
    expect(events.length).toBe(0);
  });

  test("a story with NO subtasks is never complete (>=1 subtask required)", () => {
    const story = storiesMod.createStory(WS_A, "Empty story");
    expect(tasksMod.isStoryComplete(story.id)).toBe(false);
    expect(tasksMod.notifyStoryCompletionIfReady(story.id)).toBe(false);
  });

  test("a member that aborted/failed (terminal but NOT merged) is not complete", () => {
    const story = storiesMod.createStory(WS_A, "Failed-member story");
    seedMember("st6-f-1", WS_A, story.id, "merged");
    seedMember("st6-f-2", WS_A, story.id, "failed");
    expect(tasksMod.isStoryComplete(story.id)).toBe(false);
  });

  test("completion does not fire for a done/aborted story (no live leader)", async () => {
    const story = storiesMod.createStory(WS_A, "Already-done story");
    seedMember("st6-d-1", WS_A, story.id, "merged");
    // Flip the story status directly (avoid the leader-teardown side effects of updateStory).
    dbMod.db.query(`UPDATE stories SET status='done' WHERE id=?`).run(story.id);
    expect(tasksMod.notifyStoryCompletionIfReady(story.id)).toBe(false);
  });
});

describe("Phase 6: member-task rollup + leader status surfacing", () => {
  test("storyCounts reports per-status member counts", () => {
    const story = storiesMod.createStory(WS_A, "Rollup story");
    seedMember("st6-rc-1", WS_A, story.id, "merged");
    seedMember("st6-rc-2", WS_A, story.id, "in_review");
    seedMember("st6-rc-3", WS_A, story.id, "inactive");
    const counts = storiesMod.storyCounts(story.id);
    expect(counts.merged).toBe(1);
    expect(counts.in_review).toBe(1);
    expect(counts.inactive).toBe(1);
    expect(counts.failed).toBe(0);
  });

  test("storyCounts peels idle out of in_progress (mirrors workspace counts)", () => {
    const story = storiesMod.createStory(WS_A, "Idle rollup story");
    seedMember("st6-ip-1", WS_A, story.id, "in_progress", { idle: true, pane: "pane-x" });
    seedMember("st6-ip-2", WS_A, story.id, "in_progress", { pane: "pane-y" });
    const counts = storiesMod.storyCounts(story.id);
    expect(counts.idle).toBe(1);
    expect(counts.in_progress).toBe(1); // the busy (non-idle) agent only
  });

  test("storyView carries the row + counts + leader status", async () => {
    const story = storiesMod.createStory(WS_A, "View story");
    seedMember("st6-v-1", WS_A, story.id, "merged");
    const view = await storiesMod.storyView(story.id);
    expect(view).not.toBeNull();
    expect(view!.id).toBe(story.id);
    expect(view!.brief).toBe("View story");
    expect(view!.counts.merged).toBe(1);
    expect(view!.leader.storyId).toBe(story.id);
  });

  test("storyView is null for an unknown story", async () => {
    expect(await storiesMod.storyView("st-nope")).toBeNull();
  });

  test("listStoryViews returns enriched views for a workspace's stories", async () => {
    const story = storiesMod.createStory(WS_A, "Listed story");
    seedMember("st6-l-1", WS_A, story.id, "merged");
    const views = await storiesMod.listStoryViews(WS_A);
    const mine = views.find((v) => v.id === story.id);
    expect(mine).toBeDefined();
    expect(mine!.counts.merged).toBe(1);
    expect(mine!.leader.storyId).toBe(story.id);
  });
});

describe("Phase 6: marking a story done reports up + tears the leader down", () => {
  test("updateStory(done) fires the 'story complete' CTO event and stops the leader", async () => {
    const story = storiesMod.createStory(WS_A, "Done story");
    // onStoryCreated marked the leader desired-up synchronously.
    expect(dbMod.getStoryAgentRow(story.id)?.desired).toBe(1);
    // Let the fire-and-forget launch settle so the subsequent stop isn't a no-op behind
    // an in-flight launch (guarded serializes lifecycle ops per story).
    await storyAgentMod.launchStoryAgent(story.id).catch(() => {});

    const events = await captureStoryEvents(story.id, () => {
      storiesMod.updateStory(story.id, { status: "done" });
    });
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({
      type: "story.attention",
      story_id: story.id,
      target: "cto",
      reason: "complete",
    });

    // The leader is torn down: its desired flag flips to 0 (teardown is async/best-effort).
    await waitFor(() => dbMod.getStoryAgentRow(story.id)?.desired === 0);
    expect(dbMod.getStoryAgentRow(story.id)!.desired).toBe(0);
  });

  test("a no-op re-PATCH to done does not re-fire the completion report", async () => {
    const story = storiesMod.createStory(WS_A, "Done-once story");
    await storyAgentMod.launchStoryAgent(story.id).catch(() => {});
    storiesMod.updateStory(story.id, { status: "done" });
    await waitFor(() => dbMod.getStoryAgentRow(story.id)?.desired === 0);
    // A second done PATCH (status already done) must NOT publish another 'complete'.
    const events = await captureStoryEvents(story.id, () => {
      storiesMod.updateStory(story.id, { status: "done" });
    });
    expect(events.length).toBe(0);
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
