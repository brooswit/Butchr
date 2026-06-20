// Tests for Phase E-STORY-MERGE of the 3-level branch-isolation merge model (CONTRIBUTING
// §11.4/§11.5/§11.6/§11.7). The story→main COMPLETION path of an ISOLATED story, entirely
// behind the isolated=1 guard (workspace branch_isolation ON AND the story's captured
// isolated bit = 1). It exercises the whole matrix:
//
//   - GREEN re-gate → story→main ff + post-merge verify + removeStoryBranch cleanup → `done`,
//     with story-level merge_base_sha/merged_sha set and the leader torn down (desired=false);
//   - RED re-gate → `merge_blocked`, main UNTOUCHED, story branch intact, a `gate-red`
//     attention event to the LEADER (target:story);
//   - story↔main CONFLICT → `merge_blocked`, the rebase aborted (story branch + main
//     untouched), a `merge-conflict` attention event to the CTO (target:cto) carrying a runbook;
//   - BOOT RECOVERY of a story left `merging` → recoverMergingStories re-drives it to `done`;
//   - a NON-isolated story → PATCH `done` lands `done` immediately, NO story branch/worktree.
//
// All REAL git (throwaway repos + real `git worktree`); only the verify RUNNER is mocked
// (verify.setVerifyRunner) so the green/red decision is deterministic. The db/config
// singletons read BUTCHR_* env at import, so we set them first, and use unique ids since
// those singletons are shared across test files.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ISO: string; // workspace with branch_isolation ON
let REPO_STD: string; // workspace with branch_isolation OFF (default)
let DEFAULT_ISO: string;
let DEFAULT_STD: string;

// Unique ids — the db/config singletons are shared across test files.
const WS_ISO = "smerge-iso-ws";
const WS_STD = "smerge-std-ws";

let tasksMod: typeof import("../src/tasks.ts");
let storiesMod: typeof import("../src/stories.ts");
let storyAgentMod: typeof import("../src/story-agent.ts");
let dbMod: typeof import("../src/db.ts");
let taskmdMod: typeof import("../src/taskmd.ts");
let verifyMod: typeof import("../src/verify.ts");
let gitMod: typeof import("../src/git.ts");
let eventsMod: typeof import("../src/events.ts");

/** Run git in a working dir (default: the isolated repo's main worktree). */
function g(args: string[], cwd = REPO_ISO): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function initRepo(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init", "-q", repo], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "user.email", "test@butchr.local"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "butchr test"]);
  writeFileSync(join(repo, ".gitignore"), ".butchr/\n");
  writeFileSync(join(repo, "README.md"), "base\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "init"]);
  return repo;
}

function storyRow(id: string) {
  return dbMod.db.query<any, [string]>(`SELECT * FROM stories WHERE id=?`).get(id)!;
}

/** Insert an isolated/non-isolated story directly (no createStory → no leader launch in tests). */
function mkStory(id: string, wsId: string, isolated: 0 | 1): void {
  dbMod.db
    .query(`INSERT INTO stories (id, workspace_id, brief, status, isolated, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, wsId, `story ${id}`, "open", isolated, dbMod.nowIso());
}

/** Capture every story.attention event published during `fn`. */
async function captureStoryEvents(fn: () => Promise<void>): Promise<any[]> {
  const seen: any[] = [];
  const unsub = eventsMod.subscribe((e) => {
    if ((e as any).type === "story.attention") seen.push(e);
  });
  try {
    await fn();
  } finally {
    unsub();
  }
  return seen;
}

/**
 * Create a REAL subtask of `storyId` in `repo`/`wsId`, have the "agent" commit a file in its
 * worktree, and land it onto its RESOLVED base (the story branch for an isolated story) via
 * finalizeMerge with a GREEN verify. Returns the merged task id.
 */
async function seedMerged(
  repo: string,
  wsId: string,
  storyId: string,
  file: string,
  content: string,
): Promise<string> {
  const view = await tasksMod.createTask(
    wsId, `Add ${file}`, [], [], "task", null, [], 0, false, false, "patch", [], storyId,
  );
  const id = view.id;
  const wt = join(repo, id);
  writeFileSync(join(wt, file), content);
  execFileSync("git", ["-C", wt, "add", "-A"]);
  execFileSync("git", ["-C", wt, "commit", "-q", "-m", `add ${file}`]);
  dbMod.db.query(`UPDATE tasks SET status='in_review' WHERE id=?`).run(id);
  taskmdMod.updateTaskMdStatus(repo, id, "in_review");
  verifyMod.setVerifyRunner(async () => ({ ok: true, output: "" }));
  const out = await tasksMod.finalizeMerge(id);
  expect(out.task.status).toBe("merged");
  return id;
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-smerge-data-"));
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  REPO_ISO = initRepo("butchr-smerge-iso-repo-");
  REPO_STD = initRepo("butchr-smerge-std-repo-");

  dbMod = await import("../src/db.ts");
  taskmdMod = await import("../src/taskmd.ts");
  tasksMod = await import("../src/tasks.ts");
  storiesMod = await import("../src/stories.ts");
  storyAgentMod = await import("../src/story-agent.ts");
  verifyMod = await import("../src/verify.ts");
  gitMod = await import("../src/git.ts");
  eventsMod = await import("../src/events.ts");

  DEFAULT_ISO = await gitMod.defaultBranch(REPO_ISO);
  DEFAULT_STD = await gitMod.defaultBranch(REPO_STD);

  // ISOLATED workspace: branch_isolation ON.
  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, branch_isolation, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(WS_ISO, REPO_ISO, "iso", 1, dbMod.nowIso());
  // NON-isolated workspace (flag OFF = default).
  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(WS_STD, REPO_STD, "std", dbMod.nowIso());
});

afterEach(() => {
  verifyMod.setVerifyRunner(); // restore the real runner between tests
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ISO, { recursive: true, force: true });
  rmSync(REPO_STD, { recursive: true, force: true });
});

describe("isolated story landing — story→main (§11.4/§11.5/§11.6/§11.7)", () => {
  test("GREEN re-gate → story→main ff + post-verify + cleanup → done; story-level shas; leader torn down", async () => {
    const SID = "st-smgreen1";
    mkStory(SID, WS_ISO, 1);
    const storyBranch = gitMod.storyBranchName(SID);
    const storyWt = gitMod.storyWorktreePath(REPO_ISO, SID);

    // A subtask lands on the STORY branch (main untouched so far).
    await seedMerged(REPO_ISO, WS_ISO, SID, "green.txt", "green\n");
    const mainBefore = g(["rev-parse", DEFAULT_ISO]);
    expect(existsSync(storyWt)).toBe(true);
    expect(existsSync(join(REPO_ISO, "green.txt"))).toBe(false); // not on main yet

    // Land the story: re-gate GREEN + post-merge verify GREEN.
    verifyMod.setVerifyRunner(async () => ({ ok: true, output: "" }));
    const events = await captureStoryEvents(async () => {
      await storiesMod.landStory(SID);
    });

    const row = storyRow(SID);
    expect(row.status).toBe("done");
    // Story-level merge range = main tips before/after the ff.
    const mainAfter = g(["rev-parse", DEFAULT_ISO]);
    expect(mainAfter).not.toBe(mainBefore);
    expect(row.merge_base_sha).toBe(mainBefore);
    expect(row.merged_sha).toBe(mainAfter);
    // The story actually landed on main, and the story branch + worktree were removed.
    expect(existsSync(join(REPO_ISO, "green.txt"))).toBe(true);
    expect(existsSync(storyWt)).toBe(false);
    expect(await gitMod.branchExists(REPO_ISO, storyBranch)).toBe(false);
    // A `complete` event was reported UP to the CTO (target:cto).
    const complete = events.find((e) => e.reason === "complete");
    expect(complete).toBeTruthy();
    expect(complete.target).toBe("cto");
    expect(complete.story_id).toBe(SID);
    // Only a landed story reaches done → the leader is no longer desired (torn down).
    expect(storyAgentMod.isStoryLeaderDesired(row)).toBe(false);
  });

  test("RED re-gate → merge_blocked, main UNTOUCHED, story branch intact, gate-red event to the LEADER", async () => {
    const SID = "st-smred1";
    mkStory(SID, WS_ISO, 1);
    const storyBranch = gitMod.storyBranchName(SID);
    const storyWt = gitMod.storyWorktreePath(REPO_ISO, SID);

    await seedMerged(REPO_ISO, WS_ISO, SID, "red.txt", "red\n");
    const mainBefore = g(["rev-parse", DEFAULT_ISO]);

    // Re-gate RED → HARD BLOCK before any merge.
    verifyMod.setVerifyRunner(async () => ({ ok: false, output: "story gate boom" }));
    const events = await captureStoryEvents(async () => {
      await storiesMod.landStory(SID);
    });

    const row = storyRow(SID);
    expect(row.status).toBe("merge_blocked");
    expect(row.merge_base_sha).toBeNull();
    expect(row.merged_sha).toBeNull();
    // Main NEVER moved and never saw the story; the story branch + worktree survive untouched.
    expect(g(["rev-parse", DEFAULT_ISO])).toBe(mainBefore);
    expect(existsSync(join(REPO_ISO, "red.txt"))).toBe(false);
    expect(existsSync(storyWt)).toBe(true);
    expect(await gitMod.branchExists(REPO_ISO, storyBranch)).toBe(true);
    // A `gate-red` event went to the LEADER (target:story) carrying the gate output.
    const red = events.find((e) => e.reason === "gate-red");
    expect(red).toBeTruthy();
    expect(red.target).toBe("story");
    expect(red.detail).toContain("boom");
    // The leader is KEPT UP (still desired) to fix the RED with more subtasks.
    expect(storyAgentMod.isStoryLeaderDesired(row)).toBe(true);
  });

  test("merge_blocked re-attempt: a fix subtask + a GREEN re-PATCH lands the story", async () => {
    const SID = "st-smretry1";
    mkStory(SID, WS_ISO, 1);
    await seedMerged(REPO_ISO, WS_ISO, SID, "retry-a.txt", "a\n");

    // First attempt RED → merge_blocked.
    verifyMod.setVerifyRunner(async () => ({ ok: false, output: "still red" }));
    await storiesMod.landStory(SID);
    expect(storyRow(SID).status).toBe("merge_blocked");

    // A merge_blocked story ACCEPTS a fix subtask (the leader's repair seam).
    const sub = await storiesMod.createSubtask(SID, { prompt: "fix it" });
    expect(sub.story_id).toBe(SID);
    // Land the fix subtask onto the story branch.
    const wt = join(REPO_ISO, sub.id);
    writeFileSync(join(wt, "retry-b.txt"), "b\n");
    execFileSync("git", ["-C", wt, "add", "-A"]);
    execFileSync("git", ["-C", wt, "commit", "-q", "-m", "fix"]);
    dbMod.db.query(`UPDATE tasks SET status='in_review' WHERE id=?`).run(sub.id);
    taskmdMod.updateTaskMdStatus(REPO_ISO, sub.id, "in_review");
    verifyMod.setVerifyRunner(async () => ({ ok: true, output: "" }));
    expect((await tasksMod.finalizeMerge(sub.id)).task.status).toBe("merged");

    // Re-attempt (merge_blocked → merging → done) now that the gate is green.
    verifyMod.setVerifyRunner(async () => ({ ok: true, output: "" }));
    await storiesMod.landStory(SID);
    expect(storyRow(SID).status).toBe("done");
    expect(existsSync(join(REPO_ISO, "retry-a.txt"))).toBe(true);
    expect(existsSync(join(REPO_ISO, "retry-b.txt"))).toBe(true);
  });

  test("story↔main CONFLICT → merge_blocked, rebase aborted (story branch + main untouched), merge-conflict event to the CTO", async () => {
    const SID = "st-smconf1";
    mkStory(SID, WS_ISO, 1);
    const storyBranch = gitMod.storyBranchName(SID);
    const storyWt = gitMod.storyWorktreePath(REPO_ISO, SID);

    // The story branch adds clash.txt="story".
    await seedMerged(REPO_ISO, WS_ISO, SID, "clash.txt", "story\n");
    // Meanwhile MAIN gains a CLASHING clash.txt="main" (committed at the repo root).
    writeFileSync(join(REPO_ISO, "clash.txt"), "main\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "main adds clash.txt"]);
    const mainBefore = g(["rev-parse", DEFAULT_ISO]);

    // Re-gate GREEN; the story→main rebase then CONFLICTS on clash.txt.
    verifyMod.setVerifyRunner(async () => ({ ok: true, output: "" }));
    const events = await captureStoryEvents(async () => {
      await storiesMod.landStory(SID);
    });

    const row = storyRow(SID);
    expect(row.status).toBe("merge_blocked");
    // The rebase was aborted: main is exactly where it was, with its own clash.txt content,
    // and the story branch + worktree survive untouched.
    expect(g(["rev-parse", DEFAULT_ISO])).toBe(mainBefore);
    expect(g(["show", `${DEFAULT_ISO}:clash.txt`])).toBe("main");
    expect(existsSync(storyWt)).toBe(true);
    expect(await gitMod.branchExists(REPO_ISO, storyBranch)).toBe(true);
    // A `merge-conflict` event went to the CTO (target:cto) carrying the resolution runbook.
    const conflict = events.find((e) => e.reason === "merge-conflict");
    expect(conflict).toBeTruthy();
    expect(conflict.target).toBe("cto");
    expect(conflict.detail).toContain("story worktree");
    expect(conflict.detail).toContain(SID);
    // Leader kept up to re-attempt after a human resolves the conflict.
    expect(storyAgentMod.isStoryLeaderDesired(row)).toBe(true);
  });

  test("BOOT RECOVERY: a story left `merging` is re-driven to done by recoverMergingStories", async () => {
    const SID = "st-smrec1";
    mkStory(SID, WS_ISO, 1);
    await seedMerged(REPO_ISO, WS_ISO, SID, "rec.txt", "rec\n");
    // Simulate a crash mid-land: the story is stuck `merging`.
    dbMod.db.query(`UPDATE stories SET status='merging' WHERE id=?`).run(SID);

    verifyMod.setVerifyRunner(async () => ({ ok: true, output: "" }));
    const n = await storiesMod.recoverMergingStories();
    expect(n).toBeGreaterThanOrEqual(1);

    expect(storyRow(SID).status).toBe("done");
    expect(existsSync(join(REPO_ISO, "rec.txt"))).toBe(true);
  });
});

describe("isolated `done` is a request to land (§11.7)", () => {
  test("PATCH done on an isolated open story sets `merging` (not `done`) and kicks the land path", async () => {
    const SID = "st-smpatch1";
    mkStory(SID, WS_ISO, 1);
    await seedMerged(REPO_ISO, WS_ISO, SID, "patch.txt", "p\n");

    // updateStory intercepts: it returns `merging`, never a direct `done`.
    verifyMod.setVerifyRunner(async () => ({ ok: true, output: "" }));
    const row = storiesMod.updateStory(SID, { status: "done" });
    expect(row.status).toBe("merging");

    // The async land settles to `done` (give the fire-and-forget landStory a tick).
    await storiesMod.landStory(SID); // idempotent re-drive; awaits the outcome deterministically
    expect(storyRow(SID).status).toBe("done");
  });

  test("a LANDED story clears any open story-level ask on the terminal `done` (hygiene)", async () => {
    const SID = "st-smask1";
    mkStory(SID, WS_ISO, 1);
    await seedMerged(REPO_ISO, WS_ISO, SID, "ask.txt", "a\n");
    // Leave a stale open ask on the story, then land it.
    storiesMod.openStoryAsk(SID, "leftover question?");
    expect(storyRow(SID).pending_ask).not.toBeNull();

    verifyMod.setVerifyRunner(async () => ({ ok: true, output: "" }));
    await storiesMod.landStory(SID);

    expect(storyRow(SID).status).toBe("done");
    expect(storyRow(SID).pending_ask).toBeNull();
    expect(storyRow(SID).ask_responder).toBeNull();
  });
});

describe("non-isolated story is unchanged (§11.8)", () => {
  test("PATCH done lands `done` immediately and creates NO story branch/worktree", async () => {
    const SID = "st-smstd1";
    mkStory(SID, WS_STD, 0);

    const events = await captureStoryEvents(async () => {
      const row = storiesMod.updateStory(SID, { status: "done" });
      expect(row.status).toBe("done"); // immediate, synchronous
    });

    expect(storyRow(SID).status).toBe("done");
    // No story branch/worktree machinery is ever created for a non-isolated story.
    expect(existsSync(gitMod.storyWorktreePath(REPO_STD, SID))).toBe(false);
    expect(await gitMod.branchExists(REPO_STD, gitMod.storyBranchName(SID))).toBe(false);
    // The classic `complete` report still fires to the CTO on entry into done.
    const complete = events.find((e) => e.reason === "complete");
    expect(complete).toBeTruthy();
    expect(complete.target).toBe("cto");
  });
});
