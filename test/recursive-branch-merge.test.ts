// Tests for STEP 4 of the WORK+WORKSPACE unification (story st-540ba705): the ARBITRARY-DEPTH
// RECURSIVE branch/merge model — the generalization of story B's 3-level branch isolation
// (the depth-1 instance) to a branch-per-node tree (docs/rfc-work-workspace-unification.md §4,
// Q9). Everything here is ADDITIVE + INERT + GATED OFF (config.recursiveBranchIsolation): the
// recursive resolvers + git.mergeWorkBranch have NO live caller, so today's single-level merge
// path is byte-for-byte authoritative. This file exercises the new layer DIRECTLY.
//
// >>> THE FIX (why the prior step-4 attempt failed the FULL-suite gate) <<<
// mergeWorkBranch RE-GATES the node-branch tip (verify runner) BEFORE merging — separate from
// the post-merge verify. The prior test stubbed ONLY the post-merge verify, so the re-gate ran
// the REAL gate against the throwaway repo and returned gateRed instead of landed. Here we stub
// BOTH gate paths GREEN for the land cases (verify.setVerifyRunner — which covers the re-gate
// AND the post-merge verify — AND tasks.setCiRunner, defensively) and set the workspace
// gate_cmd="" so NO real gate ever shells out in the full suite, and RESET both in afterEach.
//
// All REAL git (throwaway repos + real `git worktree`); only the gate runners are mocked. The
// db/config singletons read BUTCHR_* env at import, so we set them before importing the modules;
// the recursive flag is a GLOBAL config knob, toggled per-test via the mutable config object
// (mirroring test/workspace-agent.test.ts). Unique workspace ids + unique repo dirs per case
// keep the shared singletons isolated across cases (and across other test files).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
const REPOS: string[] = []; // every throwaway repo, torn down in afterAll

let tasksMod: typeof import("../src/tasks.ts");
let dbMod: typeof import("../src/db.ts");
let verifyMod: typeof import("../src/verify.ts");
let gitMod: typeof import("../src/git.ts");
let configMod: typeof import("../src/config.ts");

/** Run git in a working dir, returning trimmed stdout. */
function g(args: string[], cwd: string): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

/** A fresh throwaway git repo with an initial commit + explicit identity. Tracked for cleanup. */
function initRepo(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  REPOS.push(repo);
  execFileSync("git", ["init", "-q", repo], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "user.email", "test@butchr.local"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "butchr test"]);
  writeFileSync(join(repo, ".gitignore"), ".butchr/\n");
  writeFileSync(join(repo, "README.md"), "base\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "init"]);
  return repo;
}

/** Register a workspace row pointing at `repo`, with the gate DISABLED (gate_cmd=""). */
function registerWs(wsId: string, repo: string): void {
  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, gate_cmd, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(wsId, repo, "rec", "", dbMod.nowIso());
}

/** Insert a Work row (a task row) with an explicit parent_id (null = top-level node). */
function insertWork(id: string, wsId: string, parentId: string | null): void {
  dbMod.db
    .query(`INSERT INTO tasks (id, workspace_id, status, created_at, parent_id) VALUES (?, ?, ?, ?, ?)`)
    .run(id, wsId, "in_review", dbMod.nowIso(), parentId);
}

/** Ensure a node's branch chain, then commit a file in that node's OWN work worktree so its
 * work branch carries real work to merge upward. Returns the node's worktree path. */
async function ensureAndCommit(repo: string, workId: string, file: string, content: string): Promise<string> {
  const wt = await tasksMod.ensureNodeChain(repo, workId);
  writeFileSync(join(wt, file), content);
  g(["add", "-A"], wt);
  g(["commit", "-q", "-m", `add ${file}`], wt);
  return wt;
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-recmerge-data-"));
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  dbMod = await import("../src/db.ts");
  tasksMod = await import("../src/tasks.ts");
  verifyMod = await import("../src/verify.ts");
  gitMod = await import("../src/git.ts");
  configMod = await import("../src/config.ts");
});

beforeEach(() => {
  // Stub BOTH gate paths GREEN so the LAND cases are deterministic regardless of which runner a
  // path touches. The re-gate + post-merge verify both flow through the verify runner; the CI
  // runner is stubbed defensively (mergeWorkBranch doesn't use it, but this guarantees no real
  // gate can leak from any interaction in the full suite). gate_cmd="" on the workspace is the
  // belt to this suspenders.
  verifyMod.setVerifyRunner(async () => ({ ok: true, output: "" }));
  tasksMod.setCiRunner(async () => ({ status: "pass", label: "gate passed", detail: "" }));
});

afterEach(() => {
  verifyMod.setVerifyRunner(); // restore the real verify runner
  tasksMod.setCiRunner(); // restore the real CI runner (must not leak into other files)
  configMod.config.recursiveBranchIsolation = false; // restore the OFF default
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  for (const repo of REPOS) rmSync(repo, { recursive: true, force: true });
});

// ---- git.ts node helper units --------------------------------------------------------------

describe("git.ts work-node helpers", () => {
  test("workBranchName / workWorktreePath / workIdFromBranch are inverse + prefixed", () => {
    expect(gitMod.workBranchName("abc-1234")).toBe("butchr/work/abc-1234");
    expect(gitMod.workWorktreePath("/repo", "abc-1234")).toBe(join("/repo", "butchr-work-abc-1234"));
    expect(gitMod.workIdFromBranch("butchr/work/abc-1234")).toBe("abc-1234");
    // Falls back to the input unchanged when it carries no work prefix.
    expect(gitMod.workIdFromBranch("not-a-work-branch")).toBe("not-a-work-branch");
    // The work prefix is DISTINCT from the story prefix so the two models can't collide.
    expect(gitMod.workBranchName("x")).not.toBe(gitMod.storyBranchName("x"));
  });

  test("ensureWorkBranch cuts the FIRST creation from the EXPLICIT base", async () => {
    const repo = initRepo("butchr-recmerge-helper-");
    // A distinct base branch carrying a file that main does NOT have.
    g(["checkout", "-q", "-b", "altbase"], repo);
    writeFileSync(join(repo, "from-altbase.txt"), "alt\n");
    g(["add", "-A"], repo);
    g(["commit", "-q", "-m", "alt commit"], repo);
    const def = await gitMod.defaultBranch(repo);
    g(["checkout", "-q", def], repo);

    const branch = gitMod.workBranchName("cut-test");
    const wt = await gitMod.ensureWorkBranch(repo, branch, "altbase");
    expect(wt).toBe(gitMod.workWorktreePath(repo, "cut-test"));
    // The work branch was cut from altbase → it carries altbase's file, NOT just main's.
    expect(existsSync(join(wt, "from-altbase.txt"))).toBe(true);

    // Idempotent: a second call REUSES the worktree (same path, branch preserved).
    const wt2 = await gitMod.ensureWorkBranch(repo, branch, "altbase");
    expect(wt2).toBe(wt);

    // removeWorkBranch tears down the worktree AND the branch.
    await gitMod.removeWorkBranch(repo, branch);
    expect(existsSync(wt)).toBe(false);
    let branchGone = false;
    try {
      g(["rev-parse", "--verify", branch], repo);
    } catch {
      branchGone = true;
    }
    expect(branchGone).toBe(true);
  });
});

// ---- resolver units (flag ON): base + merge-context at depth 0/1/2/3 ------------------------

describe("recursive resolvers (flag ON)", () => {
  beforeEach(() => {
    configMod.config.recursiveBranchIsolation = true;
  });

  test("depth-0 (top-level node) returns TODAY'S EXACT single-level context", async () => {
    const repo = initRepo("butchr-recmerge-res0-");
    const ws = "rec-res0-ws";
    registerWs(ws, repo);
    insertWork("res0-top", ws, null);
    const def = await gitMod.defaultBranch(repo);
    const row = tasksMod.getTask("res0-top")!;

    // base = default branch; merge context = { dir.path, default, default } — byte-for-byte the
    // standalone values resolveBase / resolveMergeContext return today.
    expect(await tasksMod.resolveRecursiveBase(row)).toBe(def);
    expect(await tasksMod.resolveRecursiveMergeContext(row)).toEqual({
      ffWorktree: repo,
      targetBranch: def,
      base: def,
    });
    // A top-level node creates no parent ref, so no butchr/work branch is needed to resolve it.
  });

  test("depth-1/2/3 resolve to the IMMEDIATE parent's work branch + worktree", async () => {
    const repo = initRepo("butchr-recmerge-res123-");
    const ws = "rec-res123-ws";
    registerWs(ws, repo);
    // A 4-deep chain: top -> a -> b -> c (c is depth-3).
    insertWork("res-top", ws, null);
    insertWork("res-a", ws, "res-top");
    insertWork("res-b", ws, "res-a");
    insertWork("res-c", ws, "res-b");

    for (const [id, parent] of [
      ["res-a", "res-top"],
      ["res-b", "res-a"],
      ["res-c", "res-b"],
    ] as const) {
      const row = tasksMod.getTask(id)!;
      expect(await tasksMod.resolveRecursiveBase(row)).toBe(gitMod.workBranchName(parent));
      expect(await tasksMod.resolveRecursiveMergeContext(row)).toEqual({
        ffWorktree: gitMod.workWorktreePath(repo, parent),
        targetBranch: gitMod.workBranchName(parent),
        base: gitMod.workBranchName(parent),
      });
    }
  });
});

// ---- INERT proof (flag OFF) ----------------------------------------------------------------

describe("INERT when the flag is OFF", () => {
  test("a CHILD node resolves to today's standalone context; no butchr/work branch is created", async () => {
    configMod.config.recursiveBranchIsolation = false; // explicit (also the default)
    const repo = initRepo("butchr-recmerge-inert-");
    const ws = "rec-inert-ws";
    registerWs(ws, repo);
    insertWork("inert-top", ws, null);
    insertWork("inert-child", ws, "inert-top"); // HAS a parent, but the flag is OFF
    const def = await gitMod.defaultBranch(repo);
    const row = tasksMod.getTask("inert-child")!;

    // With the flag OFF the parent_id is IGNORED: base = default, context = standalone — exactly
    // resolveBase / resolveMergeContext for a non-isolated task.
    expect(await tasksMod.resolveRecursiveBase(row)).toBe(def);
    expect(await tasksMod.resolveRecursiveMergeContext(row)).toEqual({
      ffWorktree: repo,
      targetBranch: def,
      base: def,
    });

    // And NO node branch/worktree was lazily created (the recursive path never ran).
    const branches = g(["branch", "--list", "butchr/work/*"], repo);
    expect(branches).toBe("");
    expect(existsSync(gitMod.workWorktreePath(repo, "inert-top"))).toBe(false);
    expect(existsSync(gitMod.workWorktreePath(repo, "inert-child"))).toBe(false);

    // The LIVE single-level resolver is unchanged for the same row: a non-story task still
    // resolves to today's exact main context (the recursive layer didn't touch it).
    expect(await tasksMod.resolveMergeContext(row)).toEqual({
      ffWorktree: repo,
      targetBranch: def,
      base: def,
    });
  });
});

// ---- end-to-end ff/land at 1/2/3 levels (flag ON) ------------------------------------------

describe("mergeWorkBranch ff/land up to the default branch", () => {
  beforeEach(() => {
    configMod.config.recursiveBranchIsolation = true;
  });

  test("1 level: a top-level node lands on the default branch + is cleaned up", async () => {
    const repo = initRepo("butchr-recmerge-l1-");
    const ws = "rec-l1-ws";
    registerWs(ws, repo);
    insertWork("l1-top", ws, null);
    await ensureAndCommit(repo, "l1-top", "l1-feature.txt", "l1\n");
    const def = await gitMod.defaultBranch(repo);
    const tipBefore = g(["rev-parse", def], repo);

    const out = await tasksMod.mergeWorkBranch("l1-top");

    expect(out.kind).toBe("landed");
    // The node's file landed on the default branch at the repo root, and main advanced.
    expect(existsSync(join(repo, "l1-feature.txt"))).toBe(true);
    expect(g(["rev-parse", def], repo)).not.toBe(tipBefore);
    // A landed TOP-LEVEL node is fully merged → its branch + worktree are removed.
    expect(existsSync(gitMod.workWorktreePath(repo, "l1-top"))).toBe(false);
    expect(g(["branch", "--list", gitMod.workBranchName("l1-top")], repo)).toBe("");
  });

  test("2 levels: child -> parent node -> default branch", async () => {
    const repo = initRepo("butchr-recmerge-l2-");
    const ws = "rec-l2-ws";
    registerWs(ws, repo);
    insertWork("l2-top", ws, null);
    insertWork("l2-child", ws, "l2-top");
    const def = await gitMod.defaultBranch(repo);

    // The child carries the work; commit it on the child node branch.
    await ensureAndCommit(repo, "l2-child", "l2-child.txt", "child\n");

    // Child -> parent: ff's INTO the parent node's worktree (main untouched), branch KEPT.
    const mainTip0 = g(["rev-parse", def], repo);
    const childOut = await tasksMod.mergeWorkBranch("l2-child");
    expect(childOut.kind).toBe("landed");
    expect(g(["rev-parse", def], repo)).toBe(mainTip0); // main NOT touched yet
    // The child's file is now on the PARENT node branch (its worktree), not on main.
    expect(existsSync(join(gitMod.workWorktreePath(repo, "l2-top"), "l2-child.txt"))).toBe(true);
    expect(existsSync(join(repo, "l2-child.txt"))).toBe(false);
    // A child node's branch is KEPT (it remains the live base its parent merges upward).
    expect(g(["branch", "--list", gitMod.workBranchName("l2-child")], repo)).not.toBe("");

    // Parent (top-level) -> default: the assembled work reaches main + the parent is cleaned up.
    const topOut = await tasksMod.mergeWorkBranch("l2-top");
    expect(topOut.kind).toBe("landed");
    expect(existsSync(join(repo, "l2-child.txt"))).toBe(true); // reached main
    expect(g(["rev-parse", def], repo)).not.toBe(mainTip0);
    expect(g(["branch", "--list", gitMod.workBranchName("l2-top")], repo)).toBe("");
  });

  test("3 levels: leaf-node -> mid-node -> top-node -> default branch", async () => {
    const repo = initRepo("butchr-recmerge-l3-");
    const ws = "rec-l3-ws";
    registerWs(ws, repo);
    insertWork("l3-top", ws, null);
    insertWork("l3-mid", ws, "l3-top");
    insertWork("l3-leaf", ws, "l3-mid");
    const def = await gitMod.defaultBranch(repo);
    const mainTip0 = g(["rev-parse", def], repo);

    await ensureAndCommit(repo, "l3-leaf", "l3-deep.txt", "deep\n");

    // Bubble up the tree one node at a time; only the final top-level merge touches main.
    expect((await tasksMod.mergeWorkBranch("l3-leaf")).kind).toBe("landed");
    expect(g(["rev-parse", def], repo)).toBe(mainTip0);
    expect((await tasksMod.mergeWorkBranch("l3-mid")).kind).toBe("landed");
    expect(g(["rev-parse", def], repo)).toBe(mainTip0);
    expect((await tasksMod.mergeWorkBranch("l3-top")).kind).toBe("landed");

    // The deeply-nested file reached the default branch, and the top node was cleaned up.
    expect(existsSync(join(repo, "l3-deep.txt"))).toBe(true);
    expect(g(["rev-parse", def], repo)).not.toBe(mainTip0);
    expect(g(["branch", "--list", gitMod.workBranchName("l3-top")], repo)).toBe("");
  });
});

// ---- RED re-gate is a HARD BLOCK -----------------------------------------------------------

describe("mergeWorkBranch re-gate hard-block", () => {
  test("a RED re-gate returns gateRed with NO merge — the parent is untouched", async () => {
    configMod.config.recursiveBranchIsolation = true;
    const repo = initRepo("butchr-recmerge-red-");
    const ws = "rec-red-ws";
    registerWs(ws, repo);
    insertWork("red-top", ws, null);
    await ensureAndCommit(repo, "red-top", "red-feature.txt", "red\n");
    const def = await gitMod.defaultBranch(repo);
    const tipBefore = g(["rev-parse", def], repo);

    // The re-gate (verify runner) comes back RED → HARD BLOCK before any merge runs.
    verifyMod.setVerifyRunner(async () => ({ ok: false, output: "boom: gate failed" }));
    const out = await tasksMod.mergeWorkBranch("red-top");

    expect(out.kind).toBe("gateRed");
    if (out.kind === "gateRed") expect(out.output).toContain("boom");
    // No merge ran: main is byte-for-byte untouched, the file never reached it, and the node
    // branch + worktree are KEPT (nothing was cleaned up).
    expect(g(["rev-parse", def], repo)).toBe(tipBefore);
    expect(existsSync(join(repo, "red-feature.txt"))).toBe(false);
    expect(g(["branch", "--list", gitMod.workBranchName("red-top")], repo)).not.toBe("");
    expect(existsSync(gitMod.workWorktreePath(repo, "red-top"))).toBe(true);
  });
});
