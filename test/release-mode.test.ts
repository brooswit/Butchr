// Tests for VERSIONED-RELEASES MODE (per-workspace release_mode): on EVERY merge butchr
// bumps the version file by the task's declared level AND stamps that task's changelog
// entry with the assigned version + date (promoteUnreleased), inside the merge lock — so
// each merge owns its own `## [X.Y.Z]` heading. A 'major' bump is gated behind the human
// DOUBLE-CONFIRM ritual: approve PARKS the task (no merge, no increment); only two
// CONSECUTIVE confirm-major calls land it, and any other action resets the streak.
//
// Pure / in-process like the other merge tests: BUTCHR_HERDR_BIN points at `true` (herdr
// probes are no-ops) and the post-merge verify runner is stubbed GREEN so the mechanical
// merge reaches the real git.merge fast-forward. Everything else is REAL — a throwaway git
// repo with a CHANGELOG.md + package.json, a real worktree/branch, a real committed change
// — so we assert what genuinely lands on main.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
const WS_ID = "release-mode-ws";

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
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-release-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-release-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  execFileSync("git", ["init", "-q", REPO_ROOT], { stdio: "ignore" });
  g(["config", "user.email", "test@butchr.local"]);
  g(["config", "user.name", "butchr test"]);
  writeFileSync(join(REPO_ROOT, "CHANGELOG.md"), CHANGELOG_SEED);
  writeFileSync(
    join(REPO_ROOT, "package.json"),
    `{\n  "name": "demo",\n  "version": "0.9.0"\n}\n`,
  );
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
  // Activate versioned-releases for this workspace.
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
function status(id: string): string {
  return dbMod.db.query<any, [string]>(`SELECT status FROM tasks WHERE id=?`).get(id)!.status;
}
function row(id: string): any {
  return dbMod.db.query<any, [string]>(`SELECT * FROM tasks WHERE id=?`).get(id)!;
}

/**
 * Create a REAL task (with a declared `version_bump`), have the "agent" commit `file` in
 * its worktree AND author a bullet under `## [Unreleased]` in CHANGELOG.md (the
 * task-owns-its-entry convention), then move it to in_review so the mechanical merge runs.
 */
async function seedReviewTask(
  file: string,
  content: string,
  bump: "patch" | "minor" | "major" = "patch",
  kind: "task" | "rollback" = "task",
): Promise<string> {
  const view = await tasksMod.createTask(
    WS_ID, `Add ${file}`, [], [], kind, null, [], 0, false, false, bump,
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

describe("release_mode: every merge bumps + stamps the changelog", () => {
  test("a patch task bumps the patch and stamps a versioned heading with a fresh [Unreleased]", async () => {
    const before = version(); // 0.9.0
    const [maj, min, patch] = before.split(".").map(Number);
    const expected = `${maj}.${min}.${patch! + 1}`;

    const id = await seedReviewTask("feature.ts", "export const x = 1;\n", "patch");
    const out = await tasksMod.approveTask(id);
    expect(status(id)).toBe("merged");

    // Version bumped by the declared level.
    expect(version()).toBe(expected);
    // The changelog now carries a versioned heading owning the task's authored bullet,
    // with a fresh empty [Unreleased] left above it.
    const cl = changelog();
    expect(cl).toContain(`## [${expected}] -`);
    expect(cl).toContain(`## [${expected}] - `);
    expect(cl).toContain("- feature.ts landed");
    expect(cl.match(/^## \[Unreleased\]/gm)!.length).toBe(1);
    // The assigned version is stamped on the task row + surfaced on the view.
    expect(row(id).released_version).toBe(expected);
    expect(out.task.released_version).toBe(expected);
    // It landed in a single butchr release commit.
    expect(g(["log", "--oneline", "-2"])).toContain(`butchr: release ${expected}`);
  });

  test("a minor task ZEROES the patch", async () => {
    const before = version();
    const [maj, min] = before.split(".").map(Number);
    const expected = `${maj}.${min! + 1}.0`;

    const id = await seedReviewTask("minor.ts", "export const m = 1;\n", "minor");
    await tasksMod.approveTask(id);
    expect(status(id)).toBe("merged");
    expect(version()).toBe(expected);
    expect(changelog()).toContain(`## [${expected}] -`);
  });

  test("a DOCS-ONLY change still bumps + stamps in release_mode (no docs-only skip)", async () => {
    const before = version();
    const [maj, min, patch] = before.split(".").map(Number);
    const expected = `${maj}.${min}.${patch! + 1}`;

    // A pure docs change — only README.md (+ the authored changelog bullet).
    const id = await seedReviewTask("README.md", "base\nmore docs\n", "patch");
    await tasksMod.approveTask(id);
    expect(status(id)).toBe("merged");
    expect(version()).toBe(expected); // bumped despite being docs-only
    expect(changelog()).toContain(`## [${expected}] -`);
  });

  test("TWO sequential release merges produce two distinct version sections + one [Unreleased]", async () => {
    const v1 = version();
    const id1 = await seedReviewTask("seqA.ts", "export const a = 1;\n", "patch");
    await tasksMod.approveTask(id1);
    const after1 = version();

    // Second task is created AFTER the first merge, so its worktree branches from the
    // updated base (clean rebase, no [Unreleased] cascade conflict).
    const id2 = await seedReviewTask("seqB.ts", "export const b = 1;\n", "patch");
    await tasksMod.approveTask(id2);
    const after2 = version();

    expect(after1).not.toBe(v1);
    expect(after2).not.toBe(after1);
    const cl = changelog();
    // Both versioned headings exist, distinct, each owning its own bullet…
    expect(cl).toContain(`## [${after1}] -`);
    expect(cl).toContain(`## [${after2}] -`);
    expect(cl).toContain("- seqA.ts landed");
    expect(cl).toContain("- seqB.ts landed");
    // …and exactly ONE [Unreleased] remains (the cascade is ended).
    expect(cl.match(/^## \[Unreleased\]/gm)!.length).toBe(1);
  });

  test("a ROLLBACK task in release_mode also bumps + stamps (lands rolled_back)", async () => {
    const before = version();
    const [maj, min, patch] = before.split(".").map(Number);
    const expected = `${maj}.${min}.${patch! + 1}`;

    const id = await seedReviewTask("revert.ts", "export const r = 0;\n", "patch", "rollback");
    await tasksMod.approveTask(id);
    // A rollback task lands as rolled_back, not merged…
    expect(status(id)).toBe("rolled_back");
    // …but is still a change: it bumped + stamped like any other release.
    expect(version()).toBe(expected);
    expect(changelog()).toContain(`## [${expected}] -`);
    expect(row(id).released_version).toBe(expected);
  });
});

describe("release_mode: major double-confirm interlock", () => {
  test("approve PARKS a major task (no merge, no increment); two consecutive confirms land it", async () => {
    const before = version();
    const [maj] = before.split(".").map(Number);
    const expectedMajor = `${maj! + 1}.0.0`;

    const id = await seedReviewTask("big.ts", "export const big = 1;\n", "major");

    // Approve PARKS: it does NOT merge, does NOT increment — count stays 0.
    const a = await tasksMod.approveTask(id);
    expect(a.awaitingMajorConfirm).toBe(true);
    expect(status(id)).toBe("in_review");
    expect(row(id).major_confirm_count).toBe(0);
    expect(version()).toBe(before); // nothing bumped

    // First confirm-major → streak 1, still parked.
    const c1 = await tasksMod.confirmMajor(id);
    expect(c1.awaitingMajorConfirm).toBe(true);
    expect(status(id)).toBe("in_review");
    expect(row(id).major_confirm_count).toBe(1);
    expect(version()).toBe(before);

    // Second consecutive confirm-major → reaches 2 → merges with the major bump.
    const c2 = await tasksMod.confirmMajor(id);
    expect(status(id)).toBe("merged");
    expect(version()).toBe(expectedMajor);
    expect(changelog()).toContain(`## [${expectedMajor}] -`);
    expect(c2.task.released_version).toBe(expectedMajor);
  });

  test("an intervening action RESETS the streak — confirms must be consecutive", async () => {
    const before = version();
    const id = await seedReviewTask("big2.ts", "export const big2 = 1;\n", "major");

    // One confirm → streak 1.
    await tasksMod.confirmMajor(id);
    expect(row(id).major_confirm_count).toBe(1);

    // An intervening EDIT (re-declaring the bump) resets the streak to 0.
    tasksMod.setVersionBump(id, "major");
    expect(row(id).major_confirm_count).toBe(0);

    // So the NEXT single confirm is only streak 1 again — NOT 2 — and does NOT merge.
    const c = await tasksMod.confirmMajor(id);
    expect(c.awaitingMajorConfirm).toBe(true);
    expect(status(id)).toBe("in_review");
    expect(row(id).major_confirm_count).toBe(1);
    expect(version()).toBe(before); // still nothing bumped

    // Two consecutive from here land it.
    await tasksMod.confirmMajor(id);
    expect(status(id)).toBe("merged");
  });

  test("confirm-major is rejected on a non-major task", async () => {
    const id = await seedReviewTask("nm.ts", "export const nm = 1;\n", "patch");
    await expect(tasksMod.confirmMajor(id)).rejects.toThrow(/version_bump to be 'major'/);
    // It still merges normally via approve.
    await tasksMod.approveTask(id);
    expect(status(id)).toBe("merged");
  });
});
