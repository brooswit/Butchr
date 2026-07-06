// Tests for RUNTIME-RECOVERY F2 (story st-b00a021c) — the post-ff / pre-DB-write GAP in
// finalizeMerge. A crash AFTER git fast-forwards the task's code + version bump onto the
// default branch but BEFORE the DB `merged` write (the verify + teardown gap) leaves the task
// `in_review` forever. Two failures are fixed and asserted here:
//
//   (1) RE-APPROVE IDEMPOTENCY — re-approving the already-landed task must NOT re-rebase /
//       re-ff / re-bump: no SECOND version bump, no duplicate changelog heading, and the
//       task's dependents are released (reevaluateAllBlocked fired).
//
//   (2) BOOT SWEEP — recoverMergedTasks() reconciles the same already-landed in_review task
//       to `merged` (+ releases dependents) at boot, also without re-bumping, leaving it in a
//       terminal state (no re-dispatch loop).
//
//   (NON-REGRESSION) a genuinely-unmerged in_review task (its tip carries its own commits, so
//       it is NOT an ancestor of the default branch) is left UNTOUCHED by the boot sweep.
//
// The TRUE crash state is reproduced faithfully: approve a task normally (its code + release
// land on main, its branch is torn down), then RECREATE the task branch at main's tip and
// reset the DB row to `in_review` — branch present + code/release on main + DB says in_review,
// exactly the post-ff/pre-DB-write window.
//
// Pure / in-process like the other merge tests: BUTCHR_HERDR_BIN points at `true` (herdr probes
// are no-ops) and the verify runner is stubbed GREEN so the mechanical merge reaches the real
// git.merge. Everything else is REAL — a throwaway repo with package.json + CHANGELOG.md, real
// worktrees/branches/commits — so we assert what genuinely lands (or doesn't) on main.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
const WS_ID = "runtime-recovery-ws";

let tasksMod: typeof import("../src/tasks.ts");
let dbMod: typeof import("../src/db.ts");
let taskmdMod: typeof import("../src/taskmd.ts");
let verifyMod: typeof import("../src/verify.ts");
let wsMod: typeof import("../src/workspaces.ts");
let storiesMod: typeof import("../src/stories.ts");
let gitMod: typeof import("../src/git.ts");

function g(args: string[], cwd = REPO_ROOT): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

const CHANGELOG_SEED = `# Changelog

## [Unreleased]

## [0.1.0] - 2026-01-01

### Added
- Initial release.
`;

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-rtrec-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-rtrec-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  // `-b main` for a DETERMINISTIC default branch (the ancestor probe checks against it).
  execFileSync("git", ["init", "-q", "-b", "main", REPO_ROOT], { stdio: "ignore" });
  g(["config", "user.email", "test@butchr.local"]);
  g(["config", "user.name", "butchr test"]);
  writeFileSync(join(REPO_ROOT, "CHANGELOG.md"), CHANGELOG_SEED);
  writeFileSync(join(REPO_ROOT, "package.json"), `{\n  "name": "demo",\n  "version": "0.9.0"\n}\n`);
  writeFileSync(join(REPO_ROOT, "README.md"), "base\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "init"]);

  dbMod = await import("../src/db.ts");
  taskmdMod = await import("../src/taskmd.ts");
  tasksMod = await import("../src/tasks.ts");
  verifyMod = await import("../src/verify.ts");
  wsMod = await import("../src/workspaces.ts");
  storiesMod = await import("../src/stories.ts");
  gitMod = await import("../src/git.ts");

  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(WS_ID, REPO_ROOT, "test", dbMod.nowIso());
  // Versioned-releases ON — so a (non-)release is observable via released_version + the changelog.
  wsMod.updateWorkspaceVersionFile(WS_ID, "package.json");
  wsMod.updateWorkspaceChangelogPath(WS_ID, "CHANGELOG.md");
  wsMod.setWorkspaceReleaseMode(WS_ID, true);
  // Verify gate stubbed GREEN for the whole suite (restored in afterAll).
  verifyMod.setVerifyRunner(async () => ({ ok: true, output: "" }));
});

afterAll(() => {
  verifyMod.setVerifyRunner();
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

function changelog(): string {
  return readFileSync(join(REPO_ROOT, "CHANGELOG.md"), "utf8");
}
function version(): string {
  return JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version;
}
function row(id: string): any {
  return dbMod.db.query<any, [string]>(`SELECT * FROM tasks WHERE id=?`).get(id)!;
}
/** Count `## [X.Y.Z] - DATE` versioned changelog headings — exactly one per real release. */
function headingCount(): number {
  return (changelog().match(/^## \[\d+\.\d+\.\d+\]/gm) || []).length;
}

/** Seed a REAL release task: branch a worktree off main, commit `file` + an authored [Unreleased]
 *  bullet, and move it to in_review so the mechanical merge runs on approve. */
async function seedReviewTask(file: string, content: string): Promise<string> {
  const view = await tasksMod.createTask(
    WS_ID, `Add ${file}`, [], [], "task", null, [], 0, false, false, "patch",
  );
  const id = view.id;
  const wt = join(REPO_ROOT, id);
  writeFileSync(join(wt, file), content);
  const cl = readFileSync(join(wt, "CHANGELOG.md"), "utf8").replace(
    "## [Unreleased]",
    `## [Unreleased]\n\n### Added\n- ${file} landed`,
  );
  writeFileSync(join(wt, "CHANGELOG.md"), cl);
  g(["add", "-A"], wt);
  g(["commit", "-q", "-m", `add ${file}`], wt);
  dbMod.db.query(`UPDATE tasks SET status='in_review' WHERE id=?`).run(id);
  taskmdMod.updateTaskMdStatus(REPO_ROOT, id, "in_review");
  return id;
}

/** Reproduce the post-ff / pre-DB-write CRASH STATE for an already-merged task: recreate its
 *  branch at main's current tip (the merged tip) and reset the DB row to `in_review`, clearing
 *  the landed columns. Result: branch present + code/release on main + DB says in_review. */
function restrandAsCrashed(id: string): void {
  g(["branch", id, "main"]); // recreate the torn-down branch at the merged tip
  dbMod.db
    .query(
      `UPDATE tasks SET status='in_review', merged_at=NULL, completed_at=NULL,
         released_version=NULL, merged_sha=NULL, merge_base_sha=NULL WHERE id=?`,
    )
    .run(id);
  taskmdMod.updateTaskMdStatus(REPO_ROOT, id, "in_review");
}

/** Reflog-FAITHFUL crash-in-gap state for a GENUINELY-diverged task: fast-forward main onto the
 *  branch's tip WITHOUT tearing the branch down, leaving the DB row in_review. The branch keeps
 *  its real `git worktree add -b` "Created from main" reflog (so its OLDEST reflog entry is the
 *  true fork point and `fork..tip` >= 1) AND its tip is now an ancestor of main AND its worktree
 *  is clean — exactly what GUARD B's reflog probe must still reconcile (unlike `git branch <id>
 *  main`, which discards the fork history → fork==tip → 0 divergence). main is checked out at
 *  REPO_ROOT, so a `--ff-only` merge there advances main. */
function landViaFastForward(id: string): void {
  g(["merge", "--ff-only", id]);
}

describe("F2 — re-approve of an already-landed task is IDEMPOTENT (no second release)", () => {
  test("re-approve lands `merged` WITHOUT re-bumping, and releases dependents", async () => {
    // Land A for real → cuts 0.9.1, tears down the branch.
    const a = await seedReviewTask("alpha.ts", "export const a = 1;\n");
    await tasksMod.approveTask(a);
    expect(row(a).status).toBe("merged");
    expect(version()).toBe("0.9.1");
    const headingsAfterFirstRelease = headingCount();
    expect(changelog()).toMatch(/## \[0\.9\.1\]/);

    // Reproduce the crash window: branch back at main's tip, DB row reset to in_review.
    restrandAsCrashed(a);
    expect(row(a).status).toBe("in_review");

    // A dependent blocked on A — it must be released when A is finalized.
    const dep = await tasksMod.createTask(
      WS_ID, "depends on alpha", [], [a], "task", null, [], 0, false, false, "patch",
    );
    expect(row(dep.id).status).toBe("blocked");

    const versionBefore = version();
    const changelogBefore = changelog();
    const mainBefore = g(["rev-parse", "main"]);

    // RE-APPROVE → idempotent finalize. No re-rebase / re-ff / re-bump.
    await tasksMod.approveTask(a);

    expect(row(a).status).toBe("merged");
    // No SECOND release: version file, changelog, and main are byte-for-byte unchanged.
    expect(version()).toBe(versionBefore);
    expect(version()).toBe("0.9.1");
    expect(changelog()).toBe(changelogBefore);
    expect(g(["rev-parse", "main"])).toBe(mainBefore);
    // No duplicate `## [0.9.1]` heading, and no phantom 0.9.2 heading.
    expect(headingCount()).toBe(headingsAfterFirstRelease);
    expect(changelog()).not.toMatch(/## \[0\.9\.2\]/);

    // Dependent released (reevaluateAllBlocked fired): blocked → inactive.
    expect(row(dep.id).status).toBe("inactive");
  });
});

describe("recoverMergedTasks boot sweep — empty-branch false-positive guards (story st-794f8920)", () => {
  test("(c) a GENUINELY-diverged branch that already LANDED is still reconciled to `merged`", async () => {
    // Reflog-faithful crash-in-gap: real fork divergence + tip is an ancestor of main + clean
    // worktree. GUARD B (fork-relative own-commits) must see >=1 and let the heal proceed.
    const c = await seedReviewTask("beta.ts", "export const b = 2;\n");
    landViaFastForward(c);
    expect(row(c).status).toBe("in_review");
    // The discriminator GUARD B relies on: own-commits vs the FORK base are >=1 even though
    // vs the CURRENT base (main, post-ff) they are 0 — the trap GUARD B must avoid.
    expect(g(["rev-list", "--count", `${g(["rev-parse", c])}..main`])).toBe("0"); // current-base trap
    expect(await gitMod.branchDivergedFromFork(REPO_ROOT, c)).toBe(true); // fork-relative truth

    const dep = await tasksMod.createTask(
      WS_ID, "depends on beta", [], [c], "task", null, [], 0, false, false, "patch",
    );
    expect(row(dep.id).status).toBe("blocked");

    const versionBefore = version();
    const changelogBefore = changelog();
    const headingsBefore = headingCount();

    // BOOT SWEEP — the in_review sibling of recoverRollingBackTasks.
    const recovered = await tasksMod.recoverMergedTasks();
    expect(recovered).toBeGreaterThanOrEqual(1);

    // Finalized to a TERMINAL state (heal NOT regressed), with no second release.
    expect(row(c).status).toBe("merged");
    expect(version()).toBe(versionBefore);
    expect(changelog()).toBe(changelogBefore);
    expect(headingCount()).toBe(headingsBefore);

    // Dependent released.
    expect(row(dep.id).status).toBe("inactive");
  });

  test("(a) an EMPTY never-diverged branch (clean worktree) is NOT marked merged, worktree kept", async () => {
    // Real `git worktree add -b` path with ZERO commits: tip == main (trivially an ancestor →
    // branchAlreadyMerged TRUE) but fork..tip == 0. GUARD B must skip; GUARD A is a no-op (clean).
    const view = await tasksMod.createTask(
      WS_ID, "empty branch", [], [], "task", null, [], 0, false, false, "patch",
    );
    const e = view.id;
    dbMod.db.query(`UPDATE tasks SET status='in_review' WHERE id=?`).run(e);
    taskmdMod.updateTaskMdStatus(REPO_ROOT, e, "in_review");
    const wt = join(REPO_ROOT, e);
    expect(g(["status", "--porcelain"], wt)).toBe(""); // clean worktree
    expect(g(["rev-parse", e])).toBe(g(["rev-parse", "main"])); // 0 own commits (tip == base)
    expect(await gitMod.branchDivergedFromFork(REPO_ROOT, e)).toBe(false);

    await tasksMod.recoverMergedTasks();

    expect(row(e).status).toBe("in_review"); // NOT falsely marked merged
    expect(existsSync(wt)).toBe(true); // worktree NOT discarded
  });

  test("(b) REAL uncommitted work whose auto-commit FAILED (dirty + empty branch) is PRESERVED", async () => {
    // The data-loss trigger: an empty branch (autoCommitOnReview returned false) with live
    // uncommitted work in the worktree. GUARD A must skip BEFORE any teardown.
    const view = await tasksMod.createTask(
      WS_ID, "dirty branch", [], [], "task", null, [], 0, false, false, "patch",
    );
    const d = view.id;
    dbMod.db.query(`UPDATE tasks SET status='in_review' WHERE id=?`).run(d);
    taskmdMod.updateTaskMdStatus(REPO_ROOT, d, "in_review");
    const wt = join(REPO_ROOT, d);
    writeFileSync(join(wt, "lost-work.ts"), "export const precious = 42;\n"); // never committed
    expect(g(["status", "--porcelain"], wt)).not.toBe(""); // dirty
    expect(await gitMod.worktreeHasUncommittedWork(REPO_ROOT, d)).toBe(true);

    await tasksMod.recoverMergedTasks();

    expect(row(d).status).toBe("in_review"); // NOT marked merged
    expect(existsSync(join(wt, "lost-work.ts"))).toBe(true); // uncommitted work PRESERVED
    expect(readFileSync(join(wt, "lost-work.ts"), "utf8")).toBe(
      "export const precious = 42;\n",
    );
  });

  test("a genuinely-unmerged in_review task is NOT swept (its tip carries unmerged commits)", async () => {
    // Seed but do NOT land: the branch has its own commit not in main, so its tip is NOT an
    // ancestor of main → branchAlreadyMerged is false → the sweep must leave it alone.
    const u = await seedReviewTask("gamma.ts", "export const c = 3;\n");
    expect(row(u).status).toBe("in_review");
    const versionBefore = version();
    const changelogBefore = changelog();

    await tasksMod.recoverMergedTasks();

    expect(row(u).status).toBe("in_review"); // untouched
    expect(version()).toBe(versionBefore); // no spurious bump
    expect(changelog()).toBe(changelogBefore);
  });

  test("(d) an ABORTING task / a member of an ABORTED story is NOT reconciled (no story-branch recreation)", async () => {
    // (d1) the aborting latch — a genuinely-landed task with aborting=1 must be refused by GUARD C.
    const ab = await seedReviewTask("epsilon.ts", "export const ee = 5;\n");
    landViaFastForward(ab);
    dbMod.db.query(`UPDATE tasks SET aborting=1 WHERE id=?`).run(ab);

    await tasksMod.recoverMergedTasks();
    expect(row(ab).status).toBe("in_review"); // GUARD C (aborting) skipped it, not reconciled

    // (d2) an isolated member of an ABORTED/DELETED story — GUARD C must run BEFORE
    // resolveMergeContext so its lazy ensure-story-branch side effect never RECREATES the
    // deleted story branch to false-merge into.
    wsMod.setWorkspaceBranchIsolation(WS_ID, true); // story captures isolated=1 at creation
    const story = storiesMod.createStory(WS_ID, "isolated story");
    const member = await storiesMod.createSubtask(story.id, { prompt: "member work" });
    const m = member.id;
    const storyBranch = gitMod.storyBranchName(story.id);
    // createSubtask lazily ensured the story branch + worktree; tear them down to model the
    // deleted-story state, then strand the member in_review.
    execFileSync(
      "git",
      ["-C", REPO_ROOT, "worktree", "remove", "--force", join(REPO_ROOT, `butchr-story-${story.id}`)],
      { stdio: "ignore" },
    );
    execFileSync("git", ["-C", REPO_ROOT, "branch", "-D", storyBranch], { stdio: "ignore" });
    dbMod.db.query(`UPDATE stories SET status='aborted' WHERE id=?`).run(story.id);
    // Mirror the aborted status onto the story NODE — the B.4-flipped guard C reads the node
    // (via storyStatusOf), and production keeps stories↔node lock-step.
    dbMod.db.query(`UPDATE tasks SET status='aborted' WHERE id=? AND work_kind='node'`).run(story.id);
    dbMod.db.query(`UPDATE tasks SET status='in_review' WHERE id=?`).run(m);
    expect(() => g(["rev-parse", "--verify", storyBranch])).toThrow(); // precondition: absent

    await tasksMod.recoverMergedTasks();

    expect(row(m).status).toBe("in_review"); // member NOT reconciled
    expect(() => g(["rev-parse", "--verify", storyBranch])).toThrow(); // story branch NOT recreated
    wsMod.setWorkspaceBranchIsolation(WS_ID, false); // restore the shared workspace flag
  });
});
