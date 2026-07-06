// Tests for Phase C-LIFECYCLE of the 3-level branch-isolation merge model (CONTRIBUTING
// §11). Everything here is ADDITIVE + GUARDED/UNUSED at runtime — these tests exercise the
// new building blocks DIRECTLY (no dispatch path reaches them yet, since no story is
// isolated while the workspace branch_isolation flag is OFF):
//
//   - git.ensureStoryBranch / removeStoryBranch — lazy create + teardown of a story's
//     branch + its STORY WORKTREE (<repo>/butchr-story-<id>), with createWorktree-style
//     validate-or-rebuild idempotency that NEVER discards merged subtask work (§11.1/§11.3).
//   - git.mergeStoryToMain — the generalized story→main merge (task = story branch, base =
//     main, source = the story worktree, ff main at the repo root) (§11.4).
//   - stories.createStory captures the per-story `isolated` bit from the workspace flag at
//     creation (§11.8 bootstrapping cut): 0 while the flag is off, 1 when it is on.
//
// All REAL git (a throwaway repo + real `git worktree` plumbing). The db/config singletons
// read BUTCHR_* env at import, so we set them before importing the modules.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let REPO_ROOT: string;
let DATA_DIR: string;
// Distinct id — the db/config singletons are shared across test files.
const WS = "storylife-ws";

let gitMod: typeof import("../src/git.ts");
let dbMod: typeof import("../src/db.ts");
let storiesMod: typeof import("../src/stories.ts");

/** Run git in a working dir (default: the repo root / main worktree). */
function g(args: string[], cwd = REPO_ROOT): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}
const headOf = (dir: string) => g(["rev-parse", "HEAD"], dir);
const excludeText = () => readFileSync(join(REPO_ROOT, ".git", "info", "exclude"), "utf8");

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-storylife-data-"));
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-storylife-repo-"));
  execFileSync("git", ["init", "-q", REPO_ROOT], { stdio: "ignore" });
  g(["config", "user.email", "test@butchr.local"]);
  g(["config", "user.name", "butchr test"]);
  writeFileSync(join(REPO_ROOT, ".gitignore"), ".butchr/\n");
  writeFileSync(join(REPO_ROOT, "README.md"), "base\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "init"]);

  dbMod = await import("../src/db.ts");
  gitMod = await import("../src/git.ts");
  storiesMod = await import("../src/stories.ts");

  // WS lives at the git repo root (createStory only needs a workspace row to exist).
  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(WS, REPO_ROOT, "main", dbMod.nowIso());
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

describe("ensureStoryBranch: validate-or-rebuild + worktree", () => {
  test("(a) first call creates the branch + a worktree checked out on it, and excludes the dir", async () => {
    const branch = gitMod.storyBranchName("st-life01");
    const path = gitMod.storyWorktreePath(REPO_ROOT, "st-life01");
    expect(existsSync(path)).toBe(false);

    const out = await gitMod.ensureStoryBranch(REPO_ROOT, branch);
    expect(out).toBe(path);
    expect(existsSync(path)).toBe(true);
    // The worktree is a live linked checkout on the story branch...
    expect(g(["symbolic-ref", "--short", "HEAD"], path)).toBe(branch);
    expect(await gitMod.branchExists(REPO_ROOT, branch)).toBe(true);
    // ...cut off the current main tip...
    expect(headOf(path)).toBe(headOf(REPO_ROOT));
    // ...and the worktree dir is locally excluded.
    expect(excludeText()).toContain("/butchr-story-st-life01/");
  });

  test("(b) a valid story worktree is REUSED unchanged (even after the branch advances)", async () => {
    const branch = gitMod.storyBranchName("st-life02");
    const path = await gitMod.ensureStoryBranch(REPO_ROOT, branch);

    // The story branch accrues real work (a "subtask merge") in its worktree.
    writeFileSync(join(path, "sub.txt"), "subtask work\n");
    g(["add", "--", "sub.txt"], path);
    g(["commit", "-q", "-m", "subtask merged into story"], path);
    const storyTip = headOf(path);
    // A sentinel untracked file proves reuse-vs-rebuild (a rebuild would wipe the dir).
    writeFileSync(join(path, "SENTINEL"), "keep me\n");

    const again = await gitMod.ensureStoryBranch(REPO_ROOT, branch); // idempotent re-call
    expect(again).toBe(path);
    // Reused, NOT rebuilt: the commit AND the untracked sentinel both survive. A story
    // branch legitimately diverges from main and must never be discarded for being behind.
    expect(headOf(path)).toBe(storyTip);
    expect(existsSync(join(path, "SENTINEL"))).toBe(true);
    expect(existsSync(join(path, "sub.txt"))).toBe(true);
  });

  test("(c) a BROKEN worktree is rebuilt onto the SAME branch — merged work is preserved", async () => {
    const branch = gitMod.storyBranchName("st-life03");
    const path = await gitMod.ensureStoryBranch(REPO_ROOT, branch);

    // Real merged work on the story branch, captured before we break the worktree.
    writeFileSync(join(path, "feature.txt"), "feature\n");
    g(["add", "--", "feature.txt"], path);
    g(["commit", "-q", "-m", "merged subtask"], path);
    const storyTip = headOf(path);

    // Simulate a repo MOVE that broke the worktree's gitdir link (mirrors the
    // createWorktree broken-link case): point `.git` nowhere.
    writeFileSync(
      join(path, ".git"),
      "gitdir: /nonexistent/path/.git/worktrees/butchr-story-st-life03\n",
    );
    let recognized = true;
    try {
      execFileSync("git", ["-C", path, "rev-parse", "--git-dir"], { stdio: "ignore" });
    } catch {
      recognized = false;
    }
    expect(recognized).toBe(false);

    // Rebuild: a fresh worktree RE-ATTACHED onto the EXISTING branch (the branch — and its
    // merged commit — must NOT be deleted by the worktree-only stale removal).
    const out = await gitMod.ensureStoryBranch(REPO_ROOT, branch);
    expect(out).toBe(path);
    expect(g(["symbolic-ref", "--short", "HEAD"], path)).toBe(branch);
    expect(headOf(path)).toBe(storyTip); // branch tip preserved
    expect(existsSync(join(path, "feature.txt"))).toBe(true); // merged work preserved
  });

  test("(d) removeStoryBranch removes the worktree AND deletes the branch", async () => {
    const branch = gitMod.storyBranchName("st-life04");
    const path = await gitMod.ensureStoryBranch(REPO_ROOT, branch);
    expect(existsSync(path)).toBe(true);
    expect(await gitMod.branchExists(REPO_ROOT, branch)).toBe(true);

    await gitMod.removeStoryBranch(REPO_ROOT, branch);
    expect(existsSync(path)).toBe(false);
    expect(await gitMod.branchExists(REPO_ROOT, branch)).toBe(false);
    // Idempotent — a second teardown is a clean no-op.
    await gitMod.removeStoryBranch(REPO_ROOT, branch);
    expect(await gitMod.branchExists(REPO_ROOT, branch)).toBe(false);
  });
});

describe("mergeStoryToMain: the generalized story→main merge (§11.4)", () => {
  test("a story branch with a commit fast-forwards into main", async () => {
    const storyId = "st-merge01";
    const branch = gitMod.storyBranchName(storyId);
    const path = await gitMod.ensureStoryBranch(REPO_ROOT, branch);

    // Whole-story work sits on the story branch in the story worktree.
    writeFileSync(join(path, "story-feature.txt"), "shipped\n");
    g(["add", "--", "story-feature.txt"], path);
    g(["commit", "-q", "-m", "story complete"], path);
    const storyTip = headOf(path);

    const res = await gitMod.mergeStoryToMain(REPO_ROOT, storyId);
    expect(res.ok).toBe(true);
    expect(res.conflict).toBe(false);
    // main advanced to the story tip and now carries the story's file.
    expect(headOf(REPO_ROOT)).toBe(storyTip);
    expect(existsSync(join(REPO_ROOT, "story-feature.txt"))).toBe(true);
    // The recorded merge range brackets the landed commit on main.
    expect(res.mergedSha).toBe(storyTip);

    await gitMod.removeStoryBranch(REPO_ROOT, branch); // cleanup
  });
});

describe("createStory captures the per-story isolated bit (§11.8)", () => {
  test("isolated=0 while the workspace flag is OFF, isolated=1 once it is ON", () => {
    // Flag OFF (the default for WS) → every new story captures isolated=0.
    const off = storiesMod.createStory(WS, "story opened with isolation off");
    expect(off.isolated).toBe(0);

    // Force the workspace flag ON, then a NEW story captures isolated=1 (the captured bit,
    // not the live flag, is what later phases key off).
    dbMod.db.query(`UPDATE workspaces SET branch_isolation=1 WHERE id=?`).run(WS);
    const on = storiesMod.createStory(WS, "story opened with isolation on");
    expect(on.isolated).toBe(1);

    // The already-open story keeps its captured 0 — flipping the flag never retroactively
    // changes it (the §11.8 bootstrapping guarantee).
    expect(storiesMod.getStory(off.id)!.isolated).toBe(0);

    // Restore the flag so the workspace row is left as found.
    dbMod.db.query(`UPDATE workspaces SET branch_isolation=0 WHERE id=?`).run(WS);
  });
});

describe("story-status CAS / from-guard (st-a632b2cc F2)", () => {
  /** Insert a story directly in WS with a given status (no createStory → no leader launch).
   *  Also materializes the node's `tasks` row (as production does) so the B.4-flipped read
   *  accessors — reading the node's own tasks row — resolve it at the given status. */
  function mkStoryAt(id: string, status: string): void {
    dbMod.db
      .query(
        `INSERT INTO stories (id, workspace_id, brief, status, isolated, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, WS, `story ${id}`, status, 0, dbMod.nowIso());
    dbMod.ensureStoryWorkNode(id);
  }

  test("(a) RE-OPEN from `done` is REJECTED — a PATCH {status:'open'} no-ops, status stays done", () => {
    const SID = "st-f2reopen";
    mkStoryAt(SID, "done");

    // `open`'s only legal source is `open` itself — a terminal story can never be re-opened
    // (the bug: writing `open` over a merged-and-deleted `done` would relaunch its leader).
    const row = storiesMod.updateStory(SID, { status: "open" });
    expect(row.status).toBe("done");
    expect(storiesMod.getStory(SID)!.status).toBe("done");
  });

  test("(a') a terminal `done` cannot be re-transitioned to `aborted` either", () => {
    const SID = "st-f2done-abort";
    mkStoryAt(SID, "done");

    // `aborted`'s legal sources are open/merge_blocked — never a terminal row.
    const row = storiesMod.updateStory(SID, { status: "aborted" });
    expect(row.status).toBe("done");
    expect(storiesMod.getStory(SID)!.status).toBe("done");
  });

  test("a legal transition still fires: `open` → `aborted` succeeds", () => {
    const SID = "st-f2legal";
    mkStoryAt(SID, "open");
    const row = storiesMod.updateStory(SID, { status: "aborted" });
    expect(row.status).toBe("aborted");
    expect(storiesMod.getStory(SID)!.status).toBe("aborted");
  });

  test("a brief-only PATCH still edits the brief in ANY state (no status guard)", () => {
    const SID = "st-f2brief";
    mkStoryAt(SID, "done");
    const row = storiesMod.updateStory(SID, { brief: "edited brief on a done story" });
    expect(row.brief).toBe("edited brief on a done story");
    expect(row.status).toBe("done"); // untouched
  });
});
