// Tests for Phase B-PLUMB of the 3-level branch-isolation merge model (CONTRIBUTING
// §11). This phase is INERT: git.ts gains an optional `base?` (merge-target ref) on its
// base-consuming functions and ff-target params on merge(), EACH defaulting to today's
// single-level values (defaultBranch(dir) / { dir, defaultBranch }). tasks.ts gains the
// resolveBase / resolveMergeContext resolvers (returning today's values for everyone),
// and db.ts gains the workspaces.branch_isolation + stories.isolated columns (default 0).
//
// What this exercises:
//   1. base-param DEFAULTING — for createWorktree / diff / diffStat / commitsBehind /
//      hasChanges / rebaseOntoDefault / merge, OMITTING `base` == passing the explicit
//      default branch (byte-for-byte today's behavior), incl. merge()'s ff target + shas.
//   2. base RETARGETING — passing an explicit non-default base actually changes the ref
//      used (createWorktree branches from it; commitsBehind measures vs it).
//   3. storyBranchName — pure `butchr/story/<id>` output.
//   4. the new columns (workspaces.branch_isolation / stories.isolated) default to 0.
//
// Uses a REAL temp git repo (git.ts shells out to git) + the temp DB/data-dir seam for
// the column test. No claude/herdr/bun-build subprocess is spawned.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO: string;
let DEFAULT: string; // the repo's default branch name (main / master, git-version dependent)
// Distinct workspace id — the db/config singletons are shared across test files, so a
// unique id keeps this file's rows from colliding with another file's.
const DIR_ID = "branch-iso-plumb-dir";

let gitMod: typeof import("../src/git.ts");
let tasksMod: typeof import("../src/tasks.ts");
let dbMod: typeof import("../src/db.ts");

function git(args: string[], cwd = REPO): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}
/** Write a file under `cwd`, stage + commit it, returning the new HEAD sha. */
function commit(cwd: string, file: string, content: string, msg: string): string {
  writeFileSync(join(cwd, file), content);
  git(["add", "-A"], cwd);
  git(["commit", "-q", "-m", msg], cwd);
  return git(["rev-parse", "HEAD"], cwd);
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-biso-data-"));
  REPO = mkdtempSync(join(tmpdir(), "butchr-biso-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  execFileSync("git", ["init", "-q", REPO], { stdio: "ignore" });
  git(["config", "user.email", "test@butchr.local"]);
  git(["config", "user.name", "butchr test"]);
  commit(REPO, "base.txt", "1\n", "init");
  DEFAULT = git(["symbolic-ref", "--short", "HEAD"]);

  gitMod = await import("../src/git.ts");
  tasksMod = await import("../src/tasks.ts");
  dbMod = await import("../src/db.ts");
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO, { recursive: true, force: true });
});

describe("storyBranchName", () => {
  test("is the pure butchr/story/<id> name", () => {
    expect(gitMod.storyBranchName("st-bbca649e")).toBe("butchr/story/st-bbca649e");
    expect(gitMod.storyBranchName("anything")).toBe("butchr/story/anything");
  });
});

describe("createWorktree base defaulting + retargeting", () => {
  test("omitted base branches from the default tip (today's behavior)", async () => {
    const defTip = git(["rev-parse", DEFAULT]);
    const wt = await gitMod.createWorktree(REPO, "biso-wt-default");
    expect(git(["rev-parse", "HEAD"], wt)).toBe(defTip);
    expect(git(["symbolic-ref", "--short", "HEAD"], wt)).toBe("biso-wt-default");
    await gitMod.cleanup(REPO, "biso-wt-default");
  });

  test("explicit base branches the worktree FROM that ref", async () => {
    // A divergent branch with its own commit, NOT on the default branch.
    git(["branch", "biso-feature", DEFAULT]);
    const featTip = commit(
      // commit onto the feature branch via a throwaway worktree
      await gitMod.createWorktree(REPO, "biso-feat-build", "biso-feature"),
      "feat.txt",
      "feat\n",
      "feature commit",
    );
    // The feature worktree is checked out on its OWN task branch, not biso-feature;
    // fast-forward biso-feature to the new commit so the branch ref points at featTip.
    git(["branch", "-f", "biso-feature", featTip]);
    await gitMod.cleanup(REPO, "biso-feat-build");

    const defTip = git(["rev-parse", DEFAULT]);
    expect(featTip).not.toBe(defTip);

    const wt = await gitMod.createWorktree(REPO, "biso-wt-feat", "biso-feature");
    expect(git(["rev-parse", "HEAD"], wt)).toBe(featTip);
    await gitMod.cleanup(REPO, "biso-wt-feat");
    git(["branch", "-D", "biso-feature"]);
  });
});

describe("diff / diffStat: omitted base == explicit default base", () => {
  test("identical results with omitted vs explicit default", async () => {
    const wt = await gitMod.createWorktree(REPO, "biso-diff");
    commit(wt, "changed.txt", "hello\nworld\n", "add changed.txt");

    expect(await gitMod.diff(REPO, "biso-diff")).toBe(
      await gitMod.diff(REPO, "biso-diff", DEFAULT),
    );
    const omitted = await gitMod.diffStat(REPO, "biso-diff");
    const explicit = await gitMod.diffStat(REPO, "biso-diff", DEFAULT);
    expect(omitted).toEqual(explicit);
    expect(omitted.files).toContain("changed.txt");
    expect(omitted.changedLines).toBeGreaterThan(0);

    await gitMod.cleanup(REPO, "biso-diff");
  });
});

describe("hasChanges: omitted base == explicit default base", () => {
  test("a committed change is seen via omitted and explicit default", async () => {
    const wt = await gitMod.createWorktree(REPO, "biso-has");
    commit(wt, "x.txt", "x\n", "add x");
    expect(await gitMod.hasChanges(REPO, "biso-has")).toBe(true);
    expect(await gitMod.hasChanges(REPO, "biso-has", DEFAULT)).toBe(true);
    await gitMod.cleanup(REPO, "biso-has");
  });
});

describe("commitsBehind: omitted base == default; explicit base retargets", () => {
  test("counts commits the branch is behind the default; a contained base = 0", async () => {
    // Branch a task from the default tip, then advance the default branch by one commit.
    await gitMod.createWorktree(REPO, "biso-behind");
    const staleTip = git(["rev-parse", DEFAULT]); // the task's creation base
    git(["branch", "biso-stale", staleTip]); // a ref AT the task's base (contained in it)
    commit(REPO, "advance.txt", "adv\n", "advance default");

    // Omitted == explicit default: the branch is 1 commit behind the (advanced) default.
    expect(await gitMod.commitsBehind(REPO, "biso-behind")).toBe(1);
    expect(await gitMod.commitsBehind(REPO, "biso-behind", DEFAULT)).toBe(1);
    // Retargeted onto a base the branch already contains → 0 behind.
    expect(await gitMod.commitsBehind(REPO, "biso-behind", "biso-stale")).toBe(0);

    await gitMod.cleanup(REPO, "biso-behind");
    git(["branch", "-D", "biso-stale"]);
  });
});

describe("rebaseOntoDefault: omitted base == explicit default base", () => {
  test("a fresh (no-own-commits) branch is reset onto the advanced default tip", async () => {
    // Two sibling tasks, both branched from the same (now-stale) tip, then default moves.
    await gitMod.createWorktree(REPO, "biso-reb-a");
    await gitMod.createWorktree(REPO, "biso-reb-b");
    const newTip = commit(REPO, "reb.txt", "reb\n", "advance for rebase");

    const a = await gitMod.rebaseOntoDefault(REPO, "biso-reb-a"); // omitted base
    const b = await gitMod.rebaseOntoDefault(REPO, "biso-reb-b", "", DEFAULT); // explicit
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(a.rebased).toBe(true);
    expect(b.rebased).toBe(true);
    // Both branches were reset onto the new default tip — identical outcome.
    expect(git(["rev-parse", "biso-reb-a"])).toBe(newTip);
    expect(git(["rev-parse", "biso-reb-b"])).toBe(newTip);

    await gitMod.cleanup(REPO, "biso-reb-a");
    await gitMod.cleanup(REPO, "biso-reb-b");
  });
});

describe("merge: omitted base/ff-target == explicit { base, ffWorktree, ffTargetBranch }", () => {
  test("both fast-forward the default branch with matching base/merged shas", async () => {
    // task1 merges with DEFAULTS; task2 merges passing the explicit single-level defaults.
    // Each must ff the default branch and report baseSha = prior tip, mergedSha = new tip.
    const wt1 = await gitMod.createWorktree(REPO, "biso-merge-1");
    commit(wt1, "m1.txt", "m1\n", "task1 work");
    const before1 = git(["rev-parse", DEFAULT]);
    const r1 = await gitMod.merge(REPO, "biso-merge-1"); // omitted base + ff-target
    expect(r1.ok).toBe(true);
    expect(r1.conflict).toBe(false);
    expect(r1.baseSha).toBe(before1);
    expect(r1.mergedSha).toBe(git(["rev-parse", DEFAULT]));
    expect(git(["rev-parse", DEFAULT])).not.toBe(before1); // default advanced
    await gitMod.cleanup(REPO, "biso-merge-1");

    const wt2 = await gitMod.createWorktree(REPO, "biso-merge-2");
    commit(wt2, "m2.txt", "m2\n", "task2 work");
    const before2 = git(["rev-parse", DEFAULT]);
    const r2 = await gitMod.merge(REPO, "biso-merge-2", {
      base: DEFAULT,
      ffWorktree: REPO,
      ffTargetBranch: DEFAULT,
    });
    expect(r2.ok).toBe(true);
    expect(r2.conflict).toBe(false);
    expect(r2.baseSha).toBe(before2);
    expect(r2.mergedSha).toBe(git(["rev-parse", DEFAULT]));
    expect(git(["rev-parse", DEFAULT])).not.toBe(before2);
    await gitMod.cleanup(REPO, "biso-merge-2");
  });
});

describe("tasks resolvers are inert (today's values for everyone)", () => {
  test("resolveBase / resolveMergeContext return the default branch / { dir, default }", async () => {
    dbMod.db
      .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
      .run(DIR_ID, REPO, "test", dbMod.nowIso());
    const tid = "biso-resolve-task";
    dbMod.db
      .query(`INSERT INTO tasks (id, workspace_id, status, created_at) VALUES (?, ?, ?, ?)`)
      .run(tid, DIR_ID, "inactive", dbMod.nowIso());
    const row = tasksMod.getTask(tid)!;

    expect(await tasksMod.resolveBase(row)).toBe(DEFAULT);
    const ctx = await tasksMod.resolveMergeContext(row);
    expect(ctx).toEqual({ ffWorktree: REPO, targetBranch: DEFAULT, base: DEFAULT });
  });
});

describe("new isolation columns default to 0", () => {
  test("workspaces.branch_isolation defaults to 0", () => {
    const wsId = "biso-col-ws";
    dbMod.db
      .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
      .run(wsId, join(REPO, "col-ws"), "col", dbMod.nowIso());
    const ws = dbMod.db
      .query<{ branch_isolation: number }, [string]>(
        `SELECT branch_isolation FROM workspaces WHERE id=?`,
      )
      .get(wsId);
    expect(ws?.branch_isolation).toBe(0);
  });

  test("stories.isolated defaults to 0", () => {
    const wsId = "biso-col-ws2";
    const stId = "biso-col-story";
    dbMod.db
      .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
      .run(wsId, join(REPO, "col-ws2"), "col2", dbMod.nowIso());
    // B.5b (st-78a8b4e7): a story IS its Work NODE row (the `stories` mirror is dropped); the
    // node's `isolated` column defaults to 0 just as the dropped table's did.
    dbMod.db
      .query(
        `INSERT INTO tasks (id, workspace_id, status, created_at, work_kind, brief) VALUES (?, ?, 'open', ?, 'node', ?)`,
      )
      .run(stId, wsId, dbMod.nowIso(), "a story");
    const st = dbMod.db
      .query<{ isolated: number }, [string]>(`SELECT isolated FROM tasks WHERE id=? AND work_kind='node'`)
      .get(stId);
    expect(st?.isolated).toBe(0);
  });
});
