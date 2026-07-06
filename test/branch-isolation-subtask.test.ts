// Tests for Phase D-SUBTASK-MERGE of the 3-level branch-isolation merge model (CONTRIBUTING
// §11.2/§11.4/§11.5/§11.6). The subtask side of an ISOLATED story is retargeted onto the
// STORY branch + STORY worktree, entirely behind the isolated=1 guard (workspace
// branch_isolation ON AND the story's captured isolated bit = 1). This file exercises BOTH
// sides:
//
//   - an ISOLATED story member branches off the story branch, its diff is measured against
//     the story branch (NOT main), it fast-forwards INTO the story worktree (main untouched)
//     with story-branch shas, and a RED post-merge verify resets the STORY worktree (never
//     main) to the captured story-branch pre-merge tip;
//   - a NON-isolated story member + a standalone task are byte-for-byte unchanged: they
//     resolve to the default branch, no story branch/worktree is ever created, and they
//     fast-forward into MAIN at the repo root exactly as today.
//
// All REAL git (throwaway repos + real `git worktree`); only the post-merge verify RUNNER is
// mocked (verify.setVerifyRunner) so the green/red decision is deterministic. The db/config
// singletons read BUTCHR_* env at import, so we set them before importing the modules, and
// use unique workspace/story ids since those singletons are shared across test files.
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
const WS_ISO = "dmerge-iso-ws";
const WS_STD = "dmerge-std-ws";
const STORY_ISO = "st-dmerge01"; // isolated=1, in WS_ISO
const STORY_NONISO = "st-dmerge02"; // isolated=0, in WS_STD

let tasksMod: typeof import("../src/tasks.ts");
let dbMod: typeof import("../src/db.ts");
let taskmdMod: typeof import("../src/taskmd.ts");
let verifyMod: typeof import("../src/verify.ts");
let gitMod: typeof import("../src/git.ts");

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

function dbRow(id: string) {
  return dbMod.db.query<any, [string]>(`SELECT * FROM tasks WHERE id=?`).get(id)!;
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-dmerge-data-"));
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  REPO_ISO = initRepo("butchr-dmerge-iso-repo-");
  REPO_STD = initRepo("butchr-dmerge-std-repo-");

  dbMod = await import("../src/db.ts");
  taskmdMod = await import("../src/taskmd.ts");
  tasksMod = await import("../src/tasks.ts");
  verifyMod = await import("../src/verify.ts");
  gitMod = await import("../src/git.ts");

  DEFAULT_ISO = await gitMod.defaultBranch(REPO_ISO);
  DEFAULT_STD = await gitMod.defaultBranch(REPO_STD);

  // ISOLATED workspace: branch_isolation ON, + a story whose captured isolated bit is 1.
  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, branch_isolation, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(WS_ISO, REPO_ISO, "iso", 1, dbMod.nowIso());
  dbMod.db
    .query(`INSERT INTO stories (id, workspace_id, brief, status, isolated, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(STORY_ISO, WS_ISO, "isolated story", "open", 1, dbMod.nowIso());
  dbMod.ensureStoryWorkNode(STORY_ISO); // materialize the node (as createStory does) for B.4 reads

  // NON-isolated workspace (flag OFF = default) + a story captured isolated=0.
  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(WS_STD, REPO_STD, "std", dbMod.nowIso());
  dbMod.db
    .query(`INSERT INTO stories (id, workspace_id, brief, status, isolated, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(STORY_NONISO, WS_STD, "non-isolated story", "open", 0, dbMod.nowIso());
  dbMod.ensureStoryWorkNode(STORY_NONISO); // materialize the node for B.4 reads
});

afterEach(() => {
  verifyMod.setVerifyRunner(); // restore the real runner between tests
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ISO, { recursive: true, force: true });
  rmSync(REPO_STD, { recursive: true, force: true });
});

/**
 * Create a REAL task (worktree branched off its RESOLVED base + branch + task.md + DB row),
 * have the "agent" commit a file in the worktree, and move it to `in_review` so finalizeMerge
 * will land it. `storyId` null = a standalone task. Returns the task id.
 */
async function seed(
  repo: string,
  wsId: string,
  storyId: string | null,
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
  return id;
}

describe("isolated story member — branches off + merges into the STORY worktree (§11.4/§11.6)", () => {
  const storyBranch = () => gitMod.storyBranchName(STORY_ISO);
  const storyWt = () => gitMod.storyWorktreePath(REPO_ISO, STORY_ISO);

  test("a green member fast-forwards into the story worktree; main untouched; shas are story-branch shas", async () => {
    const mainTip0 = g(["rev-parse", DEFAULT_ISO]);

    // Creating the member lazily cuts the story branch off main + makes the story worktree,
    // then branches the member's worktree off the story branch (resolveBase).
    const aId = await seed(REPO_ISO, WS_ISO, STORY_ISO, "a.txt", "a\n");
    expect(existsSync(storyWt())).toBe(true);
    const storyTipBeforeA = g(["rev-parse", "HEAD"], storyWt());
    expect(storyTipBeforeA).toBe(mainTip0); // cut off the current main tip

    verifyMod.setVerifyRunner(async () => ({ ok: true, output: "" }));
    const outA = await tasksMod.finalizeMerge(aId);
    expect(outA.task.status).toBe("merged");

    // The story branch advanced (a.txt landed in the STORY worktree), and main NEVER moved
    // and never saw a.txt.
    const storyTipAfterA = g(["rev-parse", "HEAD"], storyWt());
    expect(storyTipAfterA).not.toBe(storyTipBeforeA);
    expect(existsSync(join(storyWt(), "a.txt"))).toBe(true);
    expect(g(["rev-parse", DEFAULT_ISO])).toBe(mainTip0);
    expect(existsSync(join(REPO_ISO, "a.txt"))).toBe(false);

    // Subtask merge_base_sha / merged_sha are the STORY-branch tips (before/after the ff).
    const rowA = dbRow(aId);
    expect(rowA.merge_base_sha).toBe(storyTipBeforeA);
    expect(rowA.merged_sha).toBe(storyTipAfterA);

    // The member's own worktree + branch were torn down post-merge (story worktree kept).
    expect(existsSync(join(REPO_ISO, aId))).toBe(false);
    expect(existsSync(storyWt())).toBe(true);
  });

  test("a member's diff is measured against the story branch, not main", async () => {
    // a.txt is already on the story branch (merged above). A new member branches off the
    // ADVANCED story branch, so its own diff vs the story branch excludes a.txt — proving
    // the gate diffStats are retargeted onto the story branch.
    const bId = await seed(REPO_ISO, WS_ISO, STORY_ISO, "b.txt", "b\n");
    const rowB = tasksMod.getTask(bId)!;
    expect(await tasksMod.resolveBase(rowB)).toBe(storyBranch());

    const vsStory = await gitMod.diffStat(REPO_ISO, bId, storyBranch());
    expect(vsStory.files).toEqual(["b.txt"]);

    // vs the OLD (wrong) base, main: both a.txt and b.txt — so the retarget genuinely matters.
    const vsMain = await gitMod.diffStat(REPO_ISO, bId, DEFAULT_ISO);
    expect([...vsMain.files].sort()).toEqual(["a.txt", "b.txt"]);
  });

  test("a RED post-merge verify resets the STORY worktree to its pre-merge tip; main never touched", async () => {
    const mainTip = g(["rev-parse", DEFAULT_ISO]);
    const storyTipBeforeC = g(["rev-parse", "HEAD"], storyWt());

    const cId = await seed(REPO_ISO, WS_ISO, STORY_ISO, "c.txt", "c\n");
    // finalizeMerge now gates TWICE: the F1 pre-ff RE-GATE in the MEMBER's own worktree
    // (the rebased tip), then the post-merge backstop in the STORY worktree (the ff-target).
    // This test targets the post-merge reset, so pass the re-gate (green in the member
    // worktree) and fail only the backstop (red in the story worktree).
    verifyMod.setVerifyRunner(async (dir: string) =>
      dir === storyWt() ? { ok: false, output: "red gate\nboom" } : { ok: true, output: "" },
    );
    const outC = await tasksMod.finalizeMerge(cId);

    // Reverted, not merged → terminal `failed` (an execution failure).
    expect(outC.revertedOnRed).toBe(true);
    expect(outC.task.status).toBe("failed");

    // The STORY worktree was reset to its captured pre-merge tip — c.txt did NOT survive on
    // the story branch — and MAIN was never touched.
    expect(g(["rev-parse", "HEAD"], storyWt())).toBe(storyTipBeforeC);
    expect(existsSync(join(storyWt(), "c.txt"))).toBe(false);
    expect(g(["rev-parse", DEFAULT_ISO])).toBe(mainTip);

    // The member's work is preserved (branch + worktree kept) for inspection / fixup.
    expect(existsSync(join(REPO_ISO, cId))).toBe(true);
    const rowC = dbRow(cId);
    expect(rowC.status).toBe("failed");
    expect(rowC.revert_reason).toContain("boom");
  });
});

describe("non-isolated is byte-for-byte unchanged — ff into MAIN (§11.8)", () => {
  test("a standalone task resolves to the default branch + ff's into main at the repo root", async () => {
    const sId = await seed(REPO_STD, WS_STD, null, "s.txt", "s\n");
    const rowS = tasksMod.getTask(sId)!;
    expect(await tasksMod.resolveBase(rowS)).toBe(DEFAULT_STD);
    expect(await tasksMod.resolveMergeContext(rowS)).toEqual({
      ffWorktree: REPO_STD,
      targetBranch: DEFAULT_STD,
      base: DEFAULT_STD,
    });

    const mainBefore = g(["rev-parse", "HEAD"], REPO_STD);
    verifyMod.setVerifyRunner(async () => ({ ok: true, output: "" }));
    const outS = await tasksMod.finalizeMerge(sId);
    expect(outS.task.status).toBe("merged");

    // Fast-forwarded into MAIN at the repo root, and the shas bracket the main tip.
    const mainAfter = g(["rev-parse", "HEAD"], REPO_STD);
    expect(mainAfter).not.toBe(mainBefore);
    expect(existsSync(join(REPO_STD, "s.txt"))).toBe(true);
    const rowS2 = dbRow(sId);
    expect(rowS2.merge_base_sha).toBe(mainBefore);
    expect(rowS2.merged_sha).toBe(mainAfter);
    // No story branch/worktree machinery is ever created for a non-isolated workspace.
    expect(existsSync(gitMod.storyWorktreePath(REPO_STD, STORY_NONISO))).toBe(false);
  });

  test("a non-isolated story member (flag OFF, isolated=0) still merges to main — no story branch", async () => {
    const mId = await seed(REPO_STD, WS_STD, STORY_NONISO, "m.txt", "m\n");
    const rowM = tasksMod.getTask(mId)!;
    // The guard returns null (flag OFF + isolated=0), so the base is the default branch and
    // NO story branch/worktree was lazily created.
    expect(await tasksMod.resolveBase(rowM)).toBe(DEFAULT_STD);
    expect(existsSync(gitMod.storyWorktreePath(REPO_STD, STORY_NONISO))).toBe(false);

    const mainBefore = g(["rev-parse", "HEAD"], REPO_STD);
    verifyMod.setVerifyRunner(async () => ({ ok: true, output: "" }));
    const outM = await tasksMod.finalizeMerge(mId);
    expect(outM.task.status).toBe("merged");
    expect(g(["rev-parse", "HEAD"], REPO_STD)).not.toBe(mainBefore); // ff into main
    expect(existsSync(join(REPO_STD, "m.txt"))).toBe(true);
  });
});
