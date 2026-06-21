// Regression tests for the startup reaper's STORY-WORKTREE safety (src/reaper.ts).
//
// A story's worktree lives at `<repo>/butchr-story-<storyId>` (git.storyWorktreePath) — a
// DIRECT child of the repo root, exactly like a task worktree (`<repo>/<taskId>`). Before
// the fix, reapOrphans treated it as a task id, found no tasks row, and force-removed a LIVE
// open story's checkout on EVERY boot. These tests pin both halves of the fix:
//   1. a `butchr-story-<id>` worktree of an OPEN story is LEFT ALONE.
//   2. a genuinely-orphaned TASK worktree (no task row) is STILL reaped.
//
// We stand up a throwaway git repo and create real worktrees with the git CLI, then run the
// real reapOrphans against it. herdr is down (reapOrphans(false)) so only the worktree sweep
// runs. BUTCHR_HERDR_BIN points at `true` so any incidental herdr probe is a no-op.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
// Distinct id — the db/config singletons are shared across test files.
const WS = "reaper-story-ws";

let dbMod: typeof import("../src/db.ts");
let reaperMod: typeof import("../src/reaper.ts");
let gitMod: typeof import("../src/git.ts");

const g = (args: string[]) => execFileSync("git", ["-C", REPO_ROOT, ...args], { stdio: "ignore" });

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-reaper-story-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-reaper-story-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  // A real git repo with one commit so `git worktree add -b` works.
  execFileSync("git", ["init", "-q", REPO_ROOT], { stdio: "ignore" });
  g(["config", "user.email", "test@butchr.local"]);
  g(["config", "user.name", "butchr test"]);
  g(["commit", "--allow-empty", "-q", "-m", "init"]);

  dbMod = await import("../src/db.ts");
  reaperMod = await import("../src/reaper.ts");
  gitMod = await import("../src/git.ts");

  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(WS, REPO_ROOT, "main", dbMod.nowIso());
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

test("reaper does NOT remove a butchr-story-<id> worktree of an OPEN story", async () => {
  const storyId = "st-reaper01";
  const storyBranch = gitMod.storyBranchName(storyId); // butchr/story/st-reaper01
  const storyWt = gitMod.storyWorktreePath(REPO_ROOT, storyId); // <repo>/butchr-story-st-reaper01

  // An OPEN story owns this worktree (the live case the reaper must respect).
  dbMod.db
    .query(`INSERT INTO stories (id, workspace_id, brief, status, created_at) VALUES (?, ?, ?, 'open', ?)`)
    .run(storyId, WS, "ship it", dbMod.nowIso());
  // Create the real story worktree on its story branch.
  g(["worktree", "add", "-q", "-b", storyBranch, storyWt]);
  expect(existsSync(storyWt)).toBe(true);

  await reaperMod.reapOrphans(false);

  // The live story's checkout + branch must survive the boot sweep untouched.
  expect(existsSync(storyWt)).toBe(true);
  const branch = execFileSync("git", ["-C", REPO_ROOT, "branch", "--list", storyBranch], {
    encoding: "utf8",
  });
  expect(branch.trim().length).toBeGreaterThan(0);
});

test("reaper STILL reaps a genuinely-orphaned task worktree (no task row)", async () => {
  const taskId = "orphan-task-ab12";
  const taskWt = join(REPO_ROOT, taskId); // <repo>/orphan-task-ab12 — a task-style worktree

  // No tasks row for this id → genuinely orphaned (e.g. a crash left it behind).
  g(["worktree", "add", "-q", "-b", taskId, taskWt]);
  expect(existsSync(taskWt)).toBe(true);

  const out = await reaperMod.reapOrphans(false);

  // The orphaned task worktree + its branch are gone, and it was counted.
  expect(existsSync(taskWt)).toBe(false);
  expect(out.worktrees).toBeGreaterThanOrEqual(1);
  const branch = execFileSync("git", ["-C", REPO_ROOT, "branch", "--list", taskId], {
    encoding: "utf8",
  });
  expect(branch.trim().length).toBe(0);
});
