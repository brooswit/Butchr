// Tests for the AUTHORITY FLIP (Phase 7 of the STORIES epic). After this flip the
// operator/CTO can ONLY create STORIES; the work TASKS are created EXCLUSIVELY by story
// leaders. The restriction lives at the HTTP ENTRY POINT — the POST /api/workspaces/:id/tasks
// route calls tasks.assertWorkspaceTaskCreationAllowed(kind), which admits ONLY a ROLLBACK
// (the 'Roll back' flow) and rejects every ordinary/idea standalone create with 409. The
// in-process primitives (createTask / createSubtask) are DELIBERATELY untouched, so leader
// decomposition + any internal/system task creation keep working.
//
// Two layers are exercised: (1) the gate function directly (pure — mirrors csrf-guard);
// (2) the in-process service paths that MUST still create tasks — createStory (the operator
// path), createSubtask (leader decomposition), createTask kind='rollback' (the rollback
// flow), and createTask kind='task' (internal/system creation bypasses the route gate).
// createTask exercises the REAL git worktree, so we stand up a throwaway repo with one commit.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
const WS = "flip-ws";

let tasksMod: typeof import("../src/tasks.ts");
let storiesMod: typeof import("../src/stories.ts");
let dbMod: typeof import("../src/db.ts");

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-flip-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-flip-repo-"));

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
  tasksMod = await import("../src/tasks.ts");
  storiesMod = await import("../src/stories.ts");

  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(WS, REPO_ROOT, "main", dbMod.nowIso());
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

/** Capture the HttpError status code thrown by a (sync or async) call, else undefined. */
async function statusOf(fn: () => unknown): Promise<number | undefined> {
  try {
    await fn();
  } catch (e) {
    return (e as { status?: number }).status;
  }
  return undefined;
}

// ---- (1) the gate function (the operator standalone-task-creation restriction) ----

test("assertWorkspaceTaskCreationAllowed: rejects an ordinary task (409)", async () => {
  expect(await statusOf(() => tasksMod.assertWorkspaceTaskCreationAllowed("task"))).toBe(409);
});

test("assertWorkspaceTaskCreationAllowed: allows a rollback (the 'Roll back' flow)", () => {
  // Returns (does not throw) for a rollback — the one kind still creatable from a workspace.
  expect(() => tasksMod.assertWorkspaceTaskCreationAllowed("rollback")).not.toThrow();
});

test("assertWorkspaceTaskCreationAllowed: the 409 points the caller at story creation", async () => {
  let msg = "";
  try {
    tasksMod.assertWorkspaceTaskCreationAllowed("task");
  } catch (e) {
    msg = (e as Error).message;
  }
  expect(msg).toContain("/api/workspaces/:id/stories");
  expect(msg).toContain("/api/stories/:id/tasks");
});

// ---- (2) the paths that MUST still create tasks after the flip ----

test("STORY creation is the operator's entry point for new work", () => {
  const story = storiesMod.createStory(WS, "Deliver the widget");
  expect(story.status).toBe("open");
  expect(story.workspace_id).toBe(WS);
});

test("LEADER decomposition still creates real, dispatchable tasks", async () => {
  const story = storiesMod.createStory(WS, "Decompose me");
  const sub = await storiesMod.createSubtask(story.id, { prompt: "build part one" });
  // A genuine task: pinned to the story, enqueued for dispatch (no blockers, not an idea).
  expect(sub.story_id).toBe(story.id);
  expect(sub.workspace_id).toBe(WS);
  expect(sub.status).toBe("inactive");
});

test("the ROLLBACK flow still creates a task (gate admits kind='rollback')", async () => {
  const view = await tasksMod.createTask(WS, "Revert the change", [], [], "rollback");
  expect(view.kind).toBe("rollback");
  expect(view.status).toBe("inactive");
});

test("internal/system createTask is UNAFFECTED (the gate is at the route, not here)", async () => {
  // createTask itself never calls the gate — only the HTTP route does. So an in-process
  // ordinary task creation (an internal/system path) still succeeds.
  const view = await tasksMod.createTask(WS, "an internal task", []);
  expect(view.kind).toBe("task");
  expect(view.status).toBe("inactive");
});
