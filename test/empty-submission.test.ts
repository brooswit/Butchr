// Tests for the EMPTY-SUBMISSION guard in tasks.markReviewFromAgent. The contract:
// when the build agent calls request_review but its branch carries NO work — zero
// commits ahead of the default branch AND a clean worktree (e.g. a `git reset` wiped
// its uncommitted changes) — butchr must NOT enter `in_review` (an empty tree builds
// green and would present a clean diff that is actually nothing). It bounces the task
// back like a changes-request (→ inactive + review_note, re-launched in the same
// session) and markReviewFromAgent returns "empty". A genuine non-empty submission —
// committed OR merely uncommitted (incl. brand-new UNTRACKED files) — is unaffected
// and still enters review.
//
// In-process: no real claude/herdr (BUTCHR_HERDR_BIN=true); conformance silenced;
// gate_cmd="" disables the CI + post-merge gates. createTask runs for real (worktree +
// task.md + DB row), so we set up a throwaway repo with a real branch per task.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
const DIR_ID = "empty-dir";

let tasksMod: typeof import("../src/tasks.ts");
let dbMod: typeof import("../src/db.ts");
let conformanceMod: typeof import("../src/conformance.ts");

function g(args: string[], cwd = REPO_ROOT): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}
function row(id: string) {
  return dbMod.db.query<any, [string]>(`SELECT * FROM tasks WHERE id=?`).get(id)!;
}
/** Number of commits the task branch carries beyond the default branch. */
function commitsAhead(id: string): number {
  const base = g(["symbolic-ref", "--short", "HEAD"]);
  return parseInt(g(["rev-list", "--count", `${base}..${id}`]), 10);
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-empty-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-empty-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  execFileSync("git", ["init", "-q", REPO_ROOT], { stdio: "ignore" });
  g(["config", "user.email", "test@butchr.local"]);
  g(["config", "user.name", "butchr test"]);
  writeFileSync(join(REPO_ROOT, "README.md"), "base\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "init"]);

  dbMod = await import("../src/db.ts");
  tasksMod = await import("../src/tasks.ts");
  conformanceMod = await import("../src/conformance.ts");

  // gate_cmd="" disables the in-worktree CI gate so a non-empty submission never shells
  // out a real build; the no-op conformance runner does the same for conformance.
  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, gate_cmd, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(DIR_ID, REPO_ROOT, "test", "", dbMod.nowIso());
  conformanceMod.setConformanceRunner(async () => null);
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

/** Drive a fresh task to a LIVE in_progress build agent (real worktree + branch). */
async function liveBuild(prompt: string): Promise<string> {
  const v = await tasksMod.createTask(DIR_ID, prompt);
  expect(v.status).toBe("inactive"); // ready; markRunning flips it to in_progress
  tasksMod.markRunning(v.id, `pane-${v.id}`, `sess-${v.id}`, `tab-${v.id}`);
  expect(row(v.id).status).toBe("in_progress");
  return v.id;
}

describe("empty-submission guard (markReviewFromAgent)", () => {
  test("EMPTY submission (no commits + clean tree) is BOUNCED, not entered into review", async () => {
    const id = await liveBuild("do a thing but lose the work");
    // The agent's work was lost: branch == base, worktree clean. The exact incident.
    expect(commitsAhead(id)).toBe(0);

    const state = await tasksMod.markReviewFromAgent(id, "done (but actually nothing)");
    expect(state).toBe("empty");

    // It did NOT enter review — it was re-queued for rework (→ inactive).
    const r = row(id);
    expect(r.status).toBe("inactive");
    expect(r.status).not.toBe("in_review");
    // The reason is recorded so the resumed agent learns it submitted nothing.
    expect(r.review_note).toBeTruthy();
    expect(r.review_note).toContain("EMPTY");
    // No CI verdict was produced for the (non-existent) empty diff.
    expect(r.ci_status ?? null).toBeNull();
    // The live pane was torn down on the bounce (same as a normal changes-request).
    expect(r.herdr_pane_id).toBeNull();
  });

  test("a COMMITTED change enters review normally (unaffected)", async () => {
    const id = await liveBuild("build and commit");
    const wt = join(REPO_ROOT, id);
    writeFileSync(join(wt, "feature.txt"), "real work\n");
    g(["add", "-A"], wt);
    g(["commit", "-q", "-m", "feature"], wt);
    expect(commitsAhead(id)).toBeGreaterThan(0);

    expect(await tasksMod.markReviewFromAgent(id, "v1")).toBe("ok");
    expect(row(id).status).toBe("in_review");
  });

  test("an UNCOMMITTED brand-new (untracked) file is non-empty → enters review", async () => {
    // Guards the subtle trap: `git diff HEAD` ignores UNTRACKED files, so the guard must
    // use a dirty-tree probe (git.hasChanges → `git status --porcelain`) that sees them.
    // butchr captures the worktree, so an agent legitimately leaves new files uncommitted.
    const id = await liveBuild("build, leave it uncommitted");
    expect(commitsAhead(id)).toBe(0); // nothing committed yet
    writeFileSync(join(REPO_ROOT, id, "fresh.txt"), "uncommitted new file\n");

    expect(await tasksMod.markReviewFromAgent(id, "v1 uncommitted")).toBe("ok");
    expect(row(id).status).toBe("in_review");
    // The transition auto-committed the worktree onto the branch (commit-on-review).
    expect(commitsAhead(id)).toBeGreaterThan(0);
  });

  test("a duplicate request_review on an already in_review task is a no-op ok", async () => {
    const id = await liveBuild("submit twice");
    writeFileSync(join(REPO_ROOT, id, "thing.txt"), "work\n");
    expect(await tasksMod.markReviewFromAgent(id, "v1")).toBe("ok");
    expect(row(id).status).toBe("in_review");

    // Second call (already in_review) — the guard only runs on a genuine in_progress
    // submission, so this stays a no-op ok and the task remains in review.
    expect(await tasksMod.markReviewFromAgent(id, "v1 again")).toBe("ok");
    expect(row(id).status).toBe("in_review");
  });
});
