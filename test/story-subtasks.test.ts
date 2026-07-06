// Tests for LEADER DECOMPOSITION (Phase 5 of the STORIES epic — see
// stories.createSubtask, the POST /api/stories/:id/tasks route, and the story_id thread
// into tasks.createTask). A story leader decomposes its story by creating SUBTASKS that
// carry the story's story_id and dispatch like any task.
//
// createSubtask exercises the REAL createTask (worktree + task.md + DB row), so we stand
// up a throwaway git repo with one commit for `git worktree add` to work. Pure /
// in-process otherwise: BUTCHR_HERDR_BIN points at `true` so every herdr probe (incl. the
// story-leader launch hook fired on createStory) is a no-op.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
// Distinct ids — the db/config singletons are shared across test files.
const WS = "substory-ws";
// A SECOND workspace, used only to host a cross-workspace story (no tasks are created in
// it, so its path need not be a git repo).
const WS2 = "substory-ws2";

let storiesMod: typeof import("../src/stories.ts");
let tasksMod: typeof import("../src/tasks.ts");
let dbMod: typeof import("../src/db.ts");

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-substory-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-substory-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  // A real git repo with one commit so createTask's `git worktree add -b` works.
  const g = (args: string[]) =>
    execFileSync("git", ["-C", REPO_ROOT, ...args], { stdio: "ignore" });
  execFileSync("git", ["init", "-q", REPO_ROOT], { stdio: "ignore" });
  g(["config", "user.email", "test@butchr.local"]);
  g(["config", "user.name", "butchr test"]);
  g(["commit", "--allow-empty", "-q", "-m", "init"]);

  dbMod = await import("../src/db.ts");
  storiesMod = await import("../src/stories.ts");
  tasksMod = await import("../src/tasks.ts");

  // WS lives at the git repo root (createTask makes worktrees there); WS2 is just a row.
  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(WS, REPO_ROOT, "main", dbMod.nowIso());
  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(WS2, join(REPO_ROOT, "ws2"), "other", dbMod.nowIso());
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

/** Capture the HttpError status code thrown by an async call, or undefined if it resolves. */
async function statusOf(fn: () => Promise<unknown>): Promise<number | undefined> {
  try {
    await fn();
  } catch (e) {
    return (e as { status?: number }).status;
  }
  return undefined;
}

describe("createSubtask creates a story-owned subtask", () => {
  test("sets story_id + enqueues the new task (no blockers → inactive)", async () => {
    const story = storiesMod.createStory(WS, "Ship the feature");
    const view = await storiesMod.createSubtask(story.id, { prompt: "build part one" });

    // The subtask belongs to the story...
    expect(view.story_id).toBe(story.id);
    // ...lands in the workspace the story belongs to...
    expect(view.workspace_id).toBe(WS);
    // ...and is ENQUEUED (ready for the dispatcher — no blockers, not an idea).
    expect(view.status).toBe("inactive");

    // story_id round-trips on the full task view (re-derived wire field); the raw DB row now
    // carries membership on parent_id (B.5b — the story_id column is dropped).
    expect(tasksMod.taskView(view.id)!.story_id).toBe(story.id);
    const row = dbMod.db
      .query<{ parent_id: string | null }, [string]>(`SELECT parent_id FROM tasks WHERE id=?`)
      .get(view.id)!;
    expect(row.parent_id).toBe(story.id);
  });

  test("409 when the story is not open (done/aborted)", async () => {
    const story = storiesMod.createStory(WS, "Already shipped");
    storiesMod.updateStory(story.id, { status: "done" });
    expect(await statusOf(() => storiesMod.createSubtask(story.id, { prompt: "late work" }))).toBe(
      409,
    );

    const aborted = storiesMod.createStory(WS, "Scrapped");
    storiesMod.updateStory(aborted.id, { status: "aborted" });
    expect(
      await statusOf(() => storiesMod.createSubtask(aborted.id, { prompt: "dead work" })),
    ).toBe(409);
  });

  test("404 when the story is gone", async () => {
    expect(
      await statusOf(() => storiesMod.createSubtask("no-such-story", { prompt: "orphan" })),
    ).toBe(404);
  });
});

describe("createTask story_id validation (cross-workspace safety)", () => {
  test("rejects a story belonging to a DIFFERENT workspace (400)", async () => {
    const storyB = storiesMod.createStory(WS2, "B's story");
    // The task targets WS but names WS2's story → cross-workspace, rejected BEFORE any
    // worktree is created.
    const status = await statusOf(() =>
      tasksMod.createTask(
        WS,
        "cross-workspace work",
        [],
        [],
        "task",
        null,
        [],
        0,
        false,
        false,
        "patch",
        [],
        storyB.id,
      ),
    );
    expect(status).toBe(400);
  });

  test("404s on an unknown story_id", async () => {
    const status = await statusOf(() =>
      tasksMod.createTask(
        WS,
        "phantom story work",
        [],
        [],
        "task",
        null,
        [],
        0,
        false,
        false,
        "patch",
        [],
        "st-does-not-exist",
      ),
    );
    expect(status).toBe(404);
  });

  test("a standalone task (no story_id) is unaffected — story_id stays null", async () => {
    const view = await tasksMod.createTask(WS, "plain standalone task");
    expect(view.story_id).toBeNull();
  });
});
