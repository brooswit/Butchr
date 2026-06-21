// Tests for the PHANTOM-RELEASE / merge work-loss GUARD (story st-3988b68e).
//
// INCIDENT (0.9.150): under the high-velocity CHANGELOG rebase-race, a task's conflict
// resolution (`git reset --soft main` + re-commit) re-committed ONLY the CHANGELOG and
// silently DROPPED the code commits; the subsequent merge rebase was clean (the branch
// carried only the CHANGELOG promotion) so the gate cut an EMPTY release — a package.json
// bump + CHANGELOG header with the real fix never reaching main. The merge funnels all three
// entry points through git.merge, which now — AFTER the rebase, BEFORE the bump + ff — asserts
// the rebased branch still CARRIES the task's code (git.detectPhantomDrop), comparing the
// task's ORIGINAL code-file set (its durable review-time `code_files` footprint, captured
// BEFORE the agent's reset --soft could erase it — NON-SHRINKING) against the rebased tip's
// NET code diff. A drop REFUSES the ff (no release, branch preserved) and bounces the task.
//
// Two halves:
//  1. PURE unit tests of detectPhantomDrop — each defense layer (structural / durable / belt)
//     proven in isolation, and the no-false-block case.
//  2. END-TO-END through approveTask → finalizeMerge → git.merge on a REAL throwaway repo +
//     worktree (verify runner stubbed GREEN, BUTCHR_HERDR_BIN=`true`), asserting what actually
//     lands (or doesn't) on main. Mirrors test/finalize-release-integrity.test.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
const WS_ID = "phantom-guard-ws";

let tasksMod: typeof import("../src/tasks.ts");
let gitMod: typeof import("../src/git.ts");
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
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-phantom-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-phantom-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

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
  gitMod = await import("../src/git.ts");
  verifyMod = await import("../src/verify.ts");
  wsMod = await import("../src/workspaces.ts");

  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(WS_ID, REPO_ROOT, "test", dbMod.nowIso());
  // Versioned-releases ON so a (non-)release is observable via released_version + the changelog.
  wsMod.updateWorkspaceVersionFile(WS_ID, "package.json");
  wsMod.updateWorkspaceChangelogPath(WS_ID, "CHANGELOG.md");
  wsMod.setWorkspaceReleaseMode(WS_ID, true);
  // Verify gate stubbed GREEN for the whole suite (restored in afterAll) so a mechanical merge
  // reaches the real git.merge / phantom guard deterministically.
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
function branchExists(id: string): boolean {
  try {
    g(["rev-parse", "--verify", "--quiet", `refs/heads/${id}`]);
    return true;
  } catch {
    return false;
  }
}
function mainHasFile(path: string): boolean {
  try {
    g(["cat-file", "-e", `main:${path}`]);
    return true;
  } catch {
    return false;
  }
}

/** Seed a REAL review task: branch a worktree off main, optionally commit `file` (the task's
 *  CODE), ALWAYS author an [Unreleased] bullet, commit, and move it to in_review so the
 *  mechanical merge runs on approve. Returns the task id + its worktree dir. */
async function seedReviewTask(
  title: string,
  file: string | null,
  content: string,
): Promise<{ id: string; wt: string }> {
  const view = await tasksMod.createTask(
    WS_ID, title, [], [], "task", null, [], 0, false, false, "patch",
  );
  const id = view.id;
  const wt = join(REPO_ROOT, id);
  if (file) writeFileSync(join(wt, file), content);
  const cl = readFileSync(join(wt, "CHANGELOG.md"), "utf8").replace(
    "## [Unreleased]",
    `## [Unreleased]\n\n### Added\n- ${title}`,
  );
  writeFileSync(join(wt, "CHANGELOG.md"), cl);
  g(["add", "-A"], wt);
  g(["commit", "-q", "-m", title], wt);
  dbMod.db.query(`UPDATE tasks SET status='in_review' WHERE id=?`).run(id);
  taskmdMod.updateTaskMdStatus(REPO_ROOT, id, "in_review");
  return { id, wt };
}

/** Model the corrupting CHANGELOG-only conflict resolution: drop ALL of the task's code and
 *  re-commit ONLY a CHANGELOG bullet, leaving a CLEAN tree (so git.merge's dangling-commit
 *  step can't re-add the code). The net effect of the incident's `reset --soft` + selective
 *  re-commit, reproduced deterministically. */
function dropCodeKeepChangelogOnly(id: string, wt: string, bullet: string): void {
  g(["reset", "--hard", "main"], wt); // wipe the code commit AND the worktree code file
  const cl = readFileSync(join(wt, "CHANGELOG.md"), "utf8").replace(
    "## [Unreleased]",
    `## [Unreleased]\n\n### Added\n- ${bullet}`,
  );
  writeFileSync(join(wt, "CHANGELOG.md"), cl);
  g(["add", "CHANGELOG.md"], wt);
  g(["commit", "-q", "-m", "changelog only (dropped code)"], wt);
}

// ---------------------------------------------------------------------------------------------
// 1. PURE unit — each defense layer in isolation.
// ---------------------------------------------------------------------------------------------
describe("detectPhantomDrop — each layer fires (or not) in isolation", () => {
  const baseArgs = { releaseMode: true, isRollback: false, isCodeTask: false };

  test("(A) structural — code present at merge entry, gone after rebase", () => {
    const v = gitMod.detectPhantomDrop({
      ...baseArgs, preRebaseCode: ["src/x.ts"], originalCodeFiles: [], netCode: [],
    });
    expect(v).not.toBeNull();
    expect(v!.missing).toEqual(["src/x.ts"]);
  });

  test("(B) durable — the review-time footprint's code is missing after rebase", () => {
    const v = gitMod.detectPhantomDrop({
      ...baseArgs, preRebaseCode: [], originalCodeFiles: ["src/x.ts"], netCode: [],
    });
    expect(v).not.toBeNull();
    expect(v!.missing).toEqual(["src/x.ts"]);
  });

  test("(B) durable — partial drop (one of several original files gone) still fires", () => {
    const v = gitMod.detectPhantomDrop({
      ...baseArgs, preRebaseCode: [], originalCodeFiles: ["a.ts", "b.ts"], netCode: ["a.ts"],
    });
    expect(v).not.toBeNull();
    expect(v!.missing).toEqual(["b.ts"]);
  });

  test("(BELT) empty-net release for a KNOWN code task — fires even with both per-file sets empty", () => {
    const v = gitMod.detectPhantomDrop({
      preRebaseCode: [], originalCodeFiles: [], netCode: [],
      releaseMode: true, isRollback: false, isCodeTask: true,
    });
    expect(v).not.toBeNull();
  });

  test("(BELT) a ROLLBACK task is exempt from the empty-net release check", () => {
    const v = gitMod.detectPhantomDrop({
      preRebaseCode: [], originalCodeFiles: [], netCode: [],
      releaseMode: true, isRollback: true, isCodeTask: true,
    });
    expect(v).toBeNull();
  });

  test("NO false block — a pure docs/changelog task (empty sets, non-code) merges", () => {
    const v = gitMod.detectPhantomDrop({
      preRebaseCode: [], originalCodeFiles: [], netCode: [],
      releaseMode: true, isRollback: false, isCodeTask: false,
    });
    expect(v).toBeNull();
  });

  test("NO false block — code that SURVIVED the rebase is not flagged", () => {
    const v = gitMod.detectPhantomDrop({
      preRebaseCode: ["src/x.ts"], originalCodeFiles: ["src/x.ts"], netCode: ["src/x.ts"],
      releaseMode: true, isRollback: false, isCodeTask: true,
    });
    expect(v).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// 2. END-TO-END through approveTask → finalizeMerge → git.merge.
// ---------------------------------------------------------------------------------------------
describe("(a) a task whose rebase DROPS its code is ABORTED — the 0.9.150 replay", () => {
  test("non-shrinking footprint survives a code-less re-capture; the guard then bounces the merge", async () => {
    const mainBefore = g(["rev-parse", "HEAD"]);
    const versionBefore = version();
    const changelogBefore = changelog();

    const { id, wt } = await seedReviewTask("Add feature.ts", "feature.ts", "export const x = 1;\n");

    // GREEN-time footprint capture: records the task's code file.
    await tasksMod.captureDiffFootprint(id);
    expect(row(id).code_files).toBe(JSON.stringify(["feature.ts"]));

    // The corrupting resolution drops the code, then a code-less RE-CAPTURE must NOT erase the
    // footprint (the NON-SHRINKING invariant — the whole reason the guard isn't blind to 0.9.150).
    dropCodeKeepChangelogOnly(id, wt, "feature landed (changelog only)");
    await tasksMod.captureDiffFootprint(id);
    expect(row(id).code_files).toBe(JSON.stringify(["feature.ts"]));

    // Approve → the guard sees the durable footprint's code missing from the rebased tip → ABORT.
    await tasksMod.approveTask(id);

    const r = row(id);
    expect(r.status).not.toBe("merged");
    expect(r.released_version ?? null).toBeNull();
    // Bounced through the SAME conflict/requestChanges path: re-queued to its agent (inactive)
    // with the guard message naming the dropped file in the review note.
    expect(r.status).toBe("inactive");
    expect(r.review_note).toMatch(/phantom-release guard/);
    expect(r.review_note).toMatch(/feature\.ts/);
    // Nothing landed: main, the version file, and the changelog are byte-for-byte unchanged.
    expect(g(["rev-parse", "HEAD"])).toBe(mainBefore);
    expect(version()).toBe(versionBefore);
    expect(changelog()).toBe(changelogBefore);
    expect(mainHasFile("feature.ts")).toBe(false);
    // The work survives — the branch is preserved for re-resolution, not deleted.
    expect(branchExists(id)).toBe(true);
  });
});

describe("(b) a normal task whose code SURVIVES the rebase merges fine", () => {
  test("merges + cuts a real release; the code is on main", async () => {
    const { id } = await seedReviewTask("Add survives.ts", "survives.ts", "export const y = 2;\n");
    await tasksMod.captureDiffFootprint(id);
    expect(row(id).code_files).toBe(JSON.stringify(["survives.ts"]));

    await tasksMod.approveTask(id);

    const r = row(id);
    expect(r.status).toBe("merged");
    expect(r.released_version).toBeTruthy(); // a real version was assigned + stamped
    expect(mainHasFile("survives.ts")).toBe(true);
  });
});

describe("(c) a legit CHANGELOG-only task (no original code) is NOT falsely blocked", () => {
  test("merges + releases despite carrying zero code files", async () => {
    const { id } = await seedReviewTask("Docs only", null, "");
    await tasksMod.captureDiffFootprint(id);
    // No code files captured (the changelog is excluded); path_type is non-code.
    expect(row(id).code_files).toBe(JSON.stringify([]));
    expect(row(id).path_type).toBe("docs");

    await tasksMod.approveTask(id);

    const r = row(id);
    expect(r.status).toBe("merged");
    expect(r.released_version).toBeTruthy();
  });
});

describe("(d) the empty-release BELT rejects a zero-net-code release for a code task", () => {
  test("a known code task (path_type=core) that nets no code is refused — even with the per-file footprint lost", async () => {
    const mainBefore = g(["rev-parse", "HEAD"]);
    const versionBefore = version();

    const { id, wt } = await seedReviewTask("Add belt.ts", "belt.ts", "export const z = 3;\n");
    await tasksMod.captureDiffFootprint(id);
    // KNOWN code task: it touched belt.ts (code) + the CHANGELOG bullet → path_type 'mixed'
    // (non-docs), so isCodeTask is true and the belt can fire.
    expect(row(id).path_type).toBe("mixed");

    // Isolate the BELT: clear the per-file footprint (simulating it being lost/empty) but KEEP
    // the coarse code path_type, so layers (A)/(B) cannot fire and only the belt is left to catch it.
    dbMod.db.query(`UPDATE tasks SET code_files='[]' WHERE id=?`).run(id);
    dropCodeKeepChangelogOnly(id, wt, "belt landed (changelog only)");

    await tasksMod.approveTask(id);

    const r = row(id);
    expect(r.status).not.toBe("merged");
    expect(r.released_version ?? null).toBeNull();
    expect(g(["rev-parse", "HEAD"])).toBe(mainBefore);
    expect(version()).toBe(versionBefore);
    expect(mainHasFile("belt.ts")).toBe(false);
    expect(branchExists(id)).toBe(true);
  });
});
