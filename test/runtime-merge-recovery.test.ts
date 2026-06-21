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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("F2 — recoverMergedTasks boot sweep reconciles the stranded task", () => {
  test("an already-landed in_review task is finalized at boot WITHOUT re-bumping", async () => {
    const b = await seedReviewTask("beta.ts", "export const b = 2;\n");
    await tasksMod.approveTask(b);
    expect(row(b).status).toBe("merged");
    expect(version()).toBe("0.9.2"); // second real release of the suite
    const headingsBefore = headingCount();

    restrandAsCrashed(b);
    expect(row(b).status).toBe("in_review");

    const dep = await tasksMod.createTask(
      WS_ID, "depends on beta", [], [b], "task", null, [], 0, false, false, "patch",
    );
    expect(row(dep.id).status).toBe("blocked");

    const versionBefore = version();
    const changelogBefore = changelog();

    // BOOT SWEEP — the in_review sibling of recoverRollingBackTasks.
    const recovered = await tasksMod.recoverMergedTasks();
    expect(recovered).toBeGreaterThanOrEqual(1);

    // Finalized to a TERMINAL state (no re-dispatch loop), with no second release.
    expect(row(b).status).toBe("merged");
    expect(version()).toBe(versionBefore);
    expect(changelog()).toBe(changelogBefore);
    expect(headingCount()).toBe(headingsBefore);
    expect(changelog()).not.toMatch(/## \[0\.9\.3\]/);

    // Dependent released.
    expect(row(dep.id).status).toBe("inactive");
  });

  test("a genuinely-unmerged in_review task is NOT swept (its tip carries unmerged commits)", async () => {
    // Seed but do NOT merge: the branch has its own commit not in main, so its tip is NOT an
    // ancestor of main → branchAlreadyMerged is false → the sweep must leave it alone.
    const c = await seedReviewTask("gamma.ts", "export const c = 3;\n");
    expect(row(c).status).toBe("in_review");
    const versionBefore = version();
    const changelogBefore = changelog();

    await tasksMod.recoverMergedTasks();

    expect(row(c).status).toBe("in_review"); // untouched
    expect(version()).toBe(versionBefore); // no spurious bump
    expect(changelog()).toBe(changelogBefore);
  });
});
