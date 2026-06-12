// Tests for COMMIT-ON-REVIEW durability (git.commitWorktree + the tasks.ts
// transitions that call it). The contract: when a WORKSPACE-agent task transitions
// OUT of `in_progress` into a non-merged review state (`in_review` / `needs_info`),
// butchr auto-commits the agent's uncommitted worktree diff onto the TASK BRANCH so
// the work survives the worktree being deleted — the branch, not the transient
// worktree, is the durable source of truth for review-state work.
//
// Covers the four required scenarios:
//   1. in_progress → in_review with uncommitted worktree changes COMMITS them onto
//      the branch (branch ahead of base; the diff is preserved).
//   2. a needs_info round-trip (ask → answer → resume) preserves the work.
//   3. request-changes → resume keeps the WIP commit AND the agent's further changes
//      still merge cleanly all the way to `merged`.
//   4. a worktree with conflict markers still gets WIP-committed but is still REFUSED
//      at merge time (the findConflictMarkers guard protects the base).
//
// In-process: no real claude or herdr (BUTCHR_HERDR_BIN=true); conformance silenced;
// gate_cmd="" disables the CI + post-merge verify gates. createTask runs for real
// (worktree + task.md + DB row), so we set up a throwaway repo.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
const DIR_ID = "cor-dir";

let tasksMod: typeof import("../src/tasks.ts");
let dbMod: typeof import("../src/db.ts");
let gitMod: typeof import("../src/git.ts");
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
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-cor-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-cor-repo-"));

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
  gitMod = await import("../src/git.ts");
  conformanceMod = await import("../src/conformance.ts");

  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, gate_cmd, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(DIR_ID, REPO_ROOT, "test", "", dbMod.nowIso());
  conformanceMod.setConformanceRunner(async () => null);
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

/**
 * Drive a fresh task to a LIVE in_progress build agent (worktree created, pane
 * recorded) WITHOUT committing anything — the agent is told butchr captures its
 * worktree, so its work is left UNCOMMITTED, which is exactly the durability gap.
 */
async function liveBuild(prompt: string): Promise<string> {
  const v = await tasksMod.createTask(DIR_ID, prompt);
  expect(v.status).toBe("inactive"); // ready; markRunning flips it to in_progress
  tasksMod.markRunning(v.id, `pane-${v.id}`, `sess-${v.id}`, `tab-${v.id}`);
  return v.id;
}

describe("commit-on-review durability", () => {
  test("1. in_progress → in_review commits uncommitted worktree changes onto the branch", async () => {
    const id = await liveBuild("build a thing");
    // Agent leaves UNCOMMITTED work in its worktree (butchr is supposed to capture it).
    const wt = join(REPO_ROOT, id);
    writeFileSync(join(wt, "thing.txt"), "the agent's work\n");
    // The branch carries no commits yet — the exact state a worktree deletion would lose.
    expect(commitsAhead(id)).toBe(0);

    // Live request_review: in_progress → in_review.
    expect(tasksMod.markReviewFromAgent(id, "done")).toBe("ok");
    expect(row(id).status).toBe("in_review");

    // The diff is now COMMITTED on the branch (branch ahead of base) as a WIP commit —
    // it no longer lives only as uncommitted worktree state.
    expect(commitsAhead(id)).toBeGreaterThan(0);
    expect(g(["log", "-1", "--format=%s", `refs/heads/${id}`])).toBe(
      `butchr: wip ${id} (auto-saved)`,
    );
    // The content is preserved on the branch tip, independent of the worktree.
    expect(g(["show", `${id}:thing.txt`])).toBe("the agent's work");
  });

  test("2. a needs_info round-trip preserves the work", async () => {
    const id = await liveBuild("ask me");
    const wt = join(REPO_ROOT, id);
    writeFileSync(join(wt, "wip.txt"), "half-done work\n");
    expect(commitsAhead(id)).toBe(0);

    // Agent calls `ask` → needs_info. The in-flight work is committed onto the branch.
    expect(tasksMod.markNeedsInfoFromAgent(id, "Per-user or global?")).toBe("ok");
    expect(row(id).status).toBe("needs_info");
    expect(commitsAhead(id)).toBeGreaterThan(0);
    expect(g(["show", `${id}:wip.txt`])).toBe("half-done work");

    // Answering resumes the agent (→ inactive) — the WIP commit must SURVIVE the
    // resume (no git reset of the branch) so the agent continues on top of it.
    const view = await tasksMod.answerTask(id, "Per-user.");
    expect(view.status).toBe("inactive");
    expect(commitsAhead(id)).toBeGreaterThan(0);
    expect(g(["show", `${id}:wip.txt`])).toBe("half-done work");
    // And the worktree file is untouched, so the resumed agent sees its prior work.
    expect(readFileSync(join(wt, "wip.txt"), "utf8")).toBe("half-done work\n");
  });

  test("3. request-changes → resume keeps the WIP commit AND further changes merge cleanly", async () => {
    const id = await liveBuild("review and rework");
    const wt = join(REPO_ROOT, id);
    // First pass: uncommitted file1 → review.
    writeFileSync(join(wt, "file1.txt"), "first pass\n");
    expect(tasksMod.markReviewFromAgent(id, "v1")).toBe("ok");
    expect(row(id).status).toBe("in_review");
    const afterFirst = commitsAhead(id);
    expect(afterFirst).toBeGreaterThan(0);

    // Reviewer requests changes → resume (→ inactive). The WIP commit and the
    // worktree file both survive the resume.
    await tasksMod.rejectTask(id, "also add file2");
    expect(row(id).status).toBe("inactive");
    expect(commitsAhead(id)).toBe(afterFirst);
    expect(existsSync(join(wt, "file1.txt"))).toBe(true);
    // Resume the build agent (inactive → in_progress) for the rework pass.
    tasksMod.markRunning(id, `pane-rw-${id}`, `sess-${id}`, `tab-rw-${id}`);

    // Resumed agent makes FURTHER (uncommitted) changes on top of the WIP commit.
    writeFileSync(join(wt, "file2.txt"), "second pass\n");
    expect(tasksMod.markReviewFromAgent(id, "v2")).toBe("ok");
    expect(row(id).status).toBe("in_review");

    // Approve → MECHANICAL merge. The agent's further changes must merge cleanly.
    await tasksMod.approveTask(id);
    expect(row(id).status).toBe("merged");
    // BOTH the first-pass and the further changes landed on the default branch.
    expect(existsSync(join(REPO_ROOT, "file1.txt"))).toBe(true);
    expect(existsSync(join(REPO_ROOT, "file2.txt"))).toBe(true);
  });

  test("4. a worktree with conflict markers is WIP-committed but REFUSED at merge", async () => {
    const id = await liveBuild("poisoned diff");
    const wt = join(REPO_ROOT, id);
    const poisoned =
      "line\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> other\nmore\n";
    writeFileSync(join(wt, "conflict.txt"), poisoned);

    // The work is still committed (durability is unconditional — we never DROP work,
    // even poisoned work; the merge gate, not this commit, protects the base).
    expect(tasksMod.markReviewFromAgent(id, "oops markers")).toBe("ok");
    expect(row(id).status).toBe("in_review");
    expect(commitsAhead(id)).toBeGreaterThan(0);
    expect(g(["show", `${id}:conflict.txt`])).toContain("<<<<<<<");

    // ...but merge() REFUSES it: findConflictMarkers sees the committed markers and
    // returns a conflict instead of landing poisoned content on the base.
    const mr = await gitMod.merge(REPO_ROOT, id);
    expect(mr.ok).toBe(false);
    expect(mr.conflict).toBe(true);
    expect(mr.conflictFiles).toContain("conflict.txt");
    // The base branch was left untouched (no conflict.txt on the default branch).
    expect(existsSync(join(REPO_ROOT, "conflict.txt"))).toBe(false);
  });

  test("4b. UNCOMMITTED (dirty) conflict markers are caught by the same merge guard", async () => {
    // The collapsed single guard must catch markers in DIRTY worktree state too —
    // not just already-committed ones (test 4). merge() stages the dirty changes,
    // scans ONCE, and refuses before committing them onto the branch.
    const id = await liveBuild("dirty poisoned diff");
    const wt = join(REPO_ROOT, id);
    const poisoned =
      "line\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> other\nmore\n";
    writeFileSync(join(wt, "dirty-conflict.txt"), poisoned);
    // Left UNCOMMITTED — no WIP commit, branch carries no commits yet.
    expect(commitsAhead(id)).toBe(0);

    const mr = await gitMod.merge(REPO_ROOT, id);
    expect(mr.ok).toBe(false);
    expect(mr.conflict).toBe(true);
    expect(mr.conflictFiles).toContain("dirty-conflict.txt");
    // Refused BEFORE the finalize commit — the poisoned work was never committed.
    expect(commitsAhead(id)).toBe(0);
    // Base untouched.
    expect(existsSync(join(REPO_ROOT, "dirty-conflict.txt"))).toBe(false);
  });
});
