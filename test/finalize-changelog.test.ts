// Tests for MERGE-TIME LIVING-DOCS BOOKKEEPING (see git.finalizeLivingDocs +
// src/changelog.ts). butchr now OWNS the CHANGELOG `[Unreleased]` entry and the
// package.json version bump at MERGE time, inside the serialized merge lock and
// AFTER the rebase — so concurrent tasks stop colliding on those two files and
// the AGENT never edits them.
//
// Pure / in-process like the other merge tests: BUTCHR_HERDR_BIN points at `true`
// (herdr probes are no-ops) and the post-merge verify runner is stubbed GREEN so
// approveTask reaches the real git.merge fast-forward. Everything else is REAL — a
// throwaway git repo with a CHANGELOG.md + package.json, a real worktree/branch,
// a real committed change — so we assert the entry + bump genuinely land on main
// WITHOUT the agent touching either file.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
const DIR_ID = "finalize-changelog-dir";

let tasksMod: typeof import("../src/tasks.ts");
let dbMod: typeof import("../src/db.ts");
let taskmdMod: typeof import("../src/taskmd.ts");
let verifyMod: typeof import("../src/verify.ts");

function g(args: string[], cwd = REPO_ROOT): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

const CHANGELOG_SEED = `# Changelog

## [Unreleased]

### Added
- An earlier feature.

## [0.1.0] - 2026-01-01

### Added
- Initial release.
`;

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-finalize-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-finalize-repo-"));

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
    `{\n  "name": "demo",\n  "version": "0.3.7"\n}\n`,
  );
  writeFileSync(join(REPO_ROOT, "README.md"), "base\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "init"]);

  dbMod = await import("../src/db.ts");
  taskmdMod = await import("../src/taskmd.ts");
  tasksMod = await import("../src/tasks.ts");
  verifyMod = await import("../src/verify.ts");

  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(DIR_ID, REPO_ROOT, "test", dbMod.nowIso());
});

afterEach(() => {
  verifyMod.setVerifyRunner(); // restore the real runner between tests
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

function dbRow(id: string) {
  return dbMod.db.query<any, [string]>(`SELECT * FROM tasks WHERE id=?`).get(id)!;
}

function changelog(): string {
  return readFileSync(join(REPO_ROOT, "CHANGELOG.md"), "utf8");
}
function version(): string {
  return JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version;
}

/**
 * Create a REAL task, have the "agent" commit `file` in its worktree (WITHOUT ever
 * editing CHANGELOG.md / package.json), set its request_review summary, and move it
 * to `review` so approveTask can merge it.
 */
async function seedReviewTask(file: string, content: string, summary: string): Promise<string> {
  const view = await tasksMod.createTask(DIR_ID, `Add ${file}`);
  const id = view.id;
  const wt = join(REPO_ROOT, id);
  writeFileSync(join(wt, file), content);
  g(["add", "-A"], wt);
  g(["commit", "-q", "-m", `add ${file}`], wt);
  dbMod.db
    .query(`UPDATE tasks SET status='in_review', summary=? WHERE id=?`)
    .run(summary, id);
  taskmdMod.updateTaskMdStatus(REPO_ROOT, id, "in_review");
  return id;
}

describe("merge-time CHANGELOG entry + version bump", () => {
  test("a code task: butchr appends an [Unreleased] entry and patch-bumps the version", async () => {
    verifyMod.setVerifyRunner(async () => ({ ok: true, output: "" }));
    const before = version(); // 0.3.7

    const id = await seedReviewTask("feature.ts", "export const x = 1;\n", "Add a shiny feature");
    const out = await tasksMod.approveTask(id); // in_review → mechanical merge → merged
    expect(out.task.status).toBe("merged");

    // The entry landed under [Unreleased] on main — derived from summary + id, and
    // filed under ### Changed (butchr's default group).
    const log = changelog();
    const unreleased = log.slice(
      log.indexOf("## [Unreleased]"),
      log.indexOf("## [0.1.0]"),
    );
    expect(unreleased).toContain("Add a shiny feature");
    expect(unreleased).toContain(`(task ${id})`);
    expect(unreleased).toContain("### Changed");
    // The pre-existing Added bullet is untouched.
    expect(unreleased).toContain("An earlier feature.");

    // Patch bump only.
    expect(version()).toBe("0.3.8");
    expect(before).toBe("0.3.7");

    // The agent's own commit did NOT touch CHANGELOG.md / package.json — butchr's
    // dedicated finalize commit did.
    const log2 = g(["log", "--oneline", `-3`]);
    expect(log2).toContain(`butchr: changelog + version bump (task ${id})`);
  });

  test("the agent never edited those files — the entry is entirely butchr's", async () => {
    verifyMod.setVerifyRunner(async () => ({ ok: true, output: "" }));
    const id = await seedReviewTask("other.ts", "export const y = 2;\n", "Second change");

    // Sanity: the task branch's OWN diff (before merge) touches only the new file.
    const base = g(["symbolic-ref", "--short", "HEAD"]);
    const files = g(["diff", "--name-only", `${base}...${id}`]).split("\n").filter(Boolean);
    expect(files).toEqual(["other.ts"]);

    await tasksMod.approveTask(id); // in_review → mechanical merge → merged
    expect(changelog()).toContain(`(task ${id})`);
    expect(version()).toBe("0.3.9"); // bumped again
  });

  test("a docs-only task appends the entry but does NOT bump the version", async () => {
    verifyMod.setVerifyRunner(async () => ({ ok: true, output: "" }));
    const vBefore = version(); // 0.3.9

    const id = await seedReviewTask("NOTES.md", "# notes\n", "Document a thing");
    await tasksMod.approveTask(id); // in_review → mechanical merge → merged

    expect(changelog()).toContain(`(task ${id})`);
    expect(changelog()).toContain("Document a thing");
    // Docs-only diff → version unchanged.
    expect(version()).toBe(vBefore);
  });
});
