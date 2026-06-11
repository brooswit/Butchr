// Tests for createWorktree's VALIDATE-OR-REBUILD behavior (src/git.ts).
//
// createWorktree no longer trusts ANY directory already sitting at <dir>/<taskId>.
// Before reusing one it validates that the dir is a LIVE linked worktree, checked
// out on branch <taskId>, and not a never-worked leftover on a STALE base. This
// closes two production near-misses: (a) agent work stranded behind a `.git` link
// broken by a repo move; (b) a task re-dispatched into a leftover dir on a stale
// base that would have silently REVERTED merged code while CI stayed green.
//
// Everything is REAL git: a throwaway repo + real `git worktree` plumbing. We call
// git.createWorktree directly (no DB / dispatcher needed). The config singleton
// reads BUTCHR_* env at import, so we set them before importing the module.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let REPO_ROOT: string;
let gitMod: typeof import("../src/git.ts");

/** Run git in a working dir (default: the repo root / main worktree). */
function g(args: string[], cwd = REPO_ROOT): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}
/** Add a file + commit it on the DEFAULT branch (advances the tip). */
function commitOnMain(file: string, content: string, msg: string): void {
  writeFileSync(join(REPO_ROOT, file), content);
  g(["add", "--", file]);
  g(["commit", "-q", "-m", msg]);
}
const headOf = (dir: string) => g(["rev-parse", "HEAD"], dir);
const wtOf = (id: string) => join(REPO_ROOT, id);

beforeAll(async () => {
  process.env.BUTCHR_DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-wtval-data-"));
  process.env.BUTCHR_DB = join(process.env.BUTCHR_DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-wtval-repo-"));
  execFileSync("git", ["init", "-q", REPO_ROOT], { stdio: "ignore" });
  g(["config", "user.email", "test@butchr.local"]);
  g(["config", "user.name", "butchr test"]);
  writeFileSync(join(REPO_ROOT, ".gitignore"), ".butchr/\n");
  writeFileSync(join(REPO_ROOT, "README.md"), "base\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "init"]);

  gitMod = await import("../src/git.ts");
});

afterAll(() => {
  rmSync(process.env.BUTCHR_DATA_DIR!, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

/** Assert <path> is a healthy linked worktree on branch <id> at the current tip. */
function expectHealthy(id: string): void {
  const wt = wtOf(id);
  expect(existsSync(wt)).toBe(true);
  // rev-parse from inside succeeds (live .git link) and HEAD is the task branch.
  expect(g(["rev-parse", "--git-dir"], wt).length).toBeGreaterThan(0);
  expect(g(["symbolic-ref", "--short", "HEAD"], wt)).toBe(id);
  // The branch contains the current default tip.
  expect(gitMod.listWorktrees(REPO_ROOT)).resolves.toContain(wt);
}

describe("createWorktree: validate-or-rebuild", () => {
  test("(4) normal path with NO leftover dir creates a fresh worktree on the tip", async () => {
    const id = "wtval-fresh";
    expect(existsSync(wtOf(id))).toBe(false);
    const path = await gitMod.createWorktree(REPO_ROOT, id);
    expect(path).toBe(wtOf(id));
    expectHealthy(id);
    expect(headOf(wtOf(id))).toBe(headOf(REPO_ROOT));
  });

  test("(1) a pre-existing VALID worktree on the right branch+base is reused UNCHANGED", async () => {
    const id = "wtval-reuse";
    await gitMod.createWorktree(REPO_ROOT, id);
    // Drop a sentinel untracked file: if the dir were rebuilt it would be wiped.
    const sentinel = join(wtOf(id), "SENTINEL");
    writeFileSync(sentinel, "keep me\n");

    const path = await gitMod.createWorktree(REPO_ROOT, id); // idempotent re-call
    expect(path).toBe(wtOf(id));
    expect(existsSync(sentinel)).toBe(true); // reused, not rebuilt
    expect(readFileSync(sentinel, "utf8")).toBe("keep me\n");
    expectHealthy(id);
  });

  test("(2) a dir with a BROKEN .git link is rebuilt into a valid worktree", async () => {
    const id = "wtval-broken";
    await gitMod.createWorktree(REPO_ROOT, id);
    const wt = wtOf(id);
    const dotGit = join(wt, ".git");
    expect(existsSync(dotGit)).toBe(true);
    // Simulate a repo MOVE that broke the worktree's gitdir link: point it nowhere.
    // A linked worktree's `.git` is a file `gitdir: <path-to-admin-dir>`.
    writeFileSync(dotGit, "gitdir: /nonexistent/path/.git/worktrees/wtval-broken\n");
    // Sanity: git can no longer recognize it from inside.
    let recognized = true;
    try {
      execFileSync("git", ["-C", wt, "rev-parse", "--git-dir"], { stdio: "ignore" });
    } catch {
      recognized = false;
    }
    expect(recognized).toBe(false);

    // Rebuild: a fresh, valid worktree on the current tip.
    const path = await gitMod.createWorktree(REPO_ROOT, id);
    expect(path).toBe(wt);
    expectHealthy(id);
    expect(headOf(wt)).toBe(headOf(REPO_ROOT));
  });

  test("(3) a leftover worktree on a STALE base (behind the tip, no commits) is rebuilt onto the current tip", async () => {
    const id = "wtval-stale";
    await gitMod.createWorktree(REPO_ROOT, id);
    const wt = wtOf(id);
    const staleBase = headOf(wt);
    // A sentinel untracked file proves rebuild-vs-reuse (rebuild wipes the dir).
    writeFileSync(join(wt, "SENTINEL"), "x\n");

    // The default branch advances past the leftover's base → it is now STALE.
    commitOnMain("advanced.txt", "advanced\n", "mainline advanced");
    const newTip = headOf(REPO_ROOT);
    expect(newTip).not.toBe(staleBase);
    expect(await gitMod.isBehindDefault(REPO_ROOT, id)).toBe(true);

    // Rebuild onto the CURRENT tip (NOT reused — that would strand a stale base).
    const path = await gitMod.createWorktree(REPO_ROOT, id);
    expect(path).toBe(wt);
    expect(existsSync(join(wt, "SENTINEL"))).toBe(false); // rebuilt, not reused
    expect(headOf(wt)).toBe(newTip);
    expect(await gitMod.isBehindDefault(REPO_ROOT, id)).toBe(false);
    expectHealthy(id);
  });

  test("(5) a behind-base worktree WITH commits is REUSED (never rebuilt — its work must survive)", async () => {
    // Safety guard for the rework path: an in-progress branch with real commits
    // that has fallen behind the tip must NOT be discarded by createWorktree — the
    // pre-dispatch / merge-time rebase replays it. Rebuilding here would silently
    // destroy committed agent work.
    const id = "wtval-work";
    await gitMod.createWorktree(REPO_ROOT, id);
    const wt = wtOf(id);
    // The agent commits real work on the task branch.
    writeFileSync(join(wt, "feature.txt"), "feature\n");
    g(["add", "--", "feature.txt"], wt);
    g(["commit", "-q", "-m", "agent work"], wt);
    const workTip = headOf(wt);

    // The default branch advances → the branch is now behind, but it has commits.
    commitOnMain("other.txt", "other\n", "unrelated mainline");
    expect(await gitMod.isBehindDefault(REPO_ROOT, id)).toBe(true);

    const path = await gitMod.createWorktree(REPO_ROOT, id);
    expect(path).toBe(wt);
    // Reused unchanged: the agent's commit and file are still there.
    expect(headOf(wt)).toBe(workTip);
    expect(existsSync(join(wt, "feature.txt"))).toBe(true);
  });
});
