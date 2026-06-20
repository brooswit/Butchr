// Tests for the F1 STALE-BASE GUARD + PRE-FF RE-GATE in tasks.finalizeMerge (story
// st-e79fcb83, merge-pipeline hardening S1).
//
// The single-task human-approve merge path now mirrors mergeWorkBranch/mergeStoryBranch:
// AFTER git.merge()'s internal rebase (which can silently fold in newer base content the
// task's own tests never exercise) and BEFORE the fast-forward, finalizeMerge RE-GATES the
// rebased tip via verifyDefaultBranch. A RED re-gate REFUSES the ff — the default branch is
// left UNTOUCHED, the task is held in review with an actionable note, and the work survives.
// The same hook also invalidates a now-stale CI green (ci_tip bound to the pre-rebase tip).
//
// Everything is REAL except the verify runner (mocked via verify.setVerifyRunner so the
// re-gate's pass/fail is deterministic without spawning bun): a throwaway git repo, a real
// worktree/branch, real commits, a real git.merge rebase + ff. BUTCHR_HERDR_BIN=`true` makes
// herdr probes harmless no-ops.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
const DIR_ID = "regate-dir";

let tasksMod: typeof import("../src/tasks.ts");
let dbMod: typeof import("../src/db.ts");
let taskmdMod: typeof import("../src/taskmd.ts");
let verifyMod: typeof import("../src/verify.ts");

function g(args: string[], cwd = REPO_ROOT): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-regate-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-regate-repo-"));

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

/** Create a REAL task (worktree + branch + task.md + DB row), commit a file in the
 * worktree, and move it to in_review so it's approvable. */
async function seedReviewTaskWithWork(file: string, content: string): Promise<string> {
  const view = await tasksMod.createTask(DIR_ID, `Add ${file}`);
  const id = view.id;
  const wt = join(REPO_ROOT, id);
  writeFileSync(join(wt, file), content);
  g(["add", "-A"], wt);
  g(["commit", "-q", "-m", `add ${file}`], wt);
  dbMod.db.query(`UPDATE tasks SET status='in_review' WHERE id=?`).run(id);
  taskmdMod.updateTaskMdStatus(REPO_ROOT, id, "in_review");
  return id;
}

/** Advance the default branch (main) at the repo root by one independent commit, so a
 * task branched from the earlier tip is now BEHIND — forcing git.merge to rebase it. */
function advanceMain(file: string, content: string): void {
  writeFileSync(join(REPO_ROOT, file), content);
  g(["add", "-A"]);
  g(["commit", "-q", "-m", `advance ${file}`]);
}

describe("F1 — stale-base guard + pre-ff re-gate (finalizeMerge)", () => {
  test("a task behind main whose REBASED tip fails the gate is NOT merged (main untouched, work kept)", async () => {
    const id = await seedReviewTaskWithWork("feat.txt", "feat\n");
    // Make the base move AHEAD so finalizeMerge must rebase the task before the ff.
    advanceMain("other.txt", "other\n");
    const mainTipBefore = g(["rev-parse", "HEAD"]);

    // The re-gate runs verifyDefaultBranch in the TASK worktree (the rebased tip). Fail it
    // there; anything else (e.g. the post-merge backstop at the repo root) stays green so we
    // prove the PRE-FF gate — not the backstop — is what blocked the merge.
    const taskWt = join(REPO_ROOT, id);
    verifyMod.setVerifyRunner(async (dir: string) =>
      dir === taskWt ? { ok: false, output: "TypeError: undefined is not a function\nboom" } : { ok: true, output: "" },
    );

    const out = await tasksMod.approveTask(id);

    // Held by the pre-ff re-gate — NOT landed, NOT post-merge-reverted.
    expect(out.gateRed).toBe(true);
    expect(out.revertedOnRed).toBeFalsy();
    expect(out.task.status).toBe("in_review");

    // The default branch never moved — the ff was refused before it touched main.
    expect(g(["rev-parse", "HEAD"])).toBe(mainTipBefore);
    expect(existsSync(join(REPO_ROOT, "feat.txt"))).toBe(false);

    // The task is flagged for the approver with the actionable verdict + the gate output,
    // and its branch + worktree are KEPT for a fixup / fresh re-queue.
    const row = dbRow(id);
    expect(row.status).toBe("in_review");
    expect(row.conflict).toBe(1);
    expect(row.review_note).toContain("stale base");
    expect(row.review_note).toContain("abort+requeue");
    expect(row.review_note).toContain("boom");
    expect(g(["rev-parse", "--verify", id])).toBeTruthy(); // task branch still exists
    expect(existsSync(taskWt)).toBe(true); // worktree kept
  });

  test("a stale CI green (ci_tip ≠ post-rebase tip) is invalidated before the ff", async () => {
    const id = await seedReviewTaskWithWork("greenfeat.txt", "green\n");
    // Bind a CI 'pass' to the task's CURRENT (pre-rebase) tip.
    const preRebaseTip = g(["rev-parse", "HEAD"], join(REPO_ROOT, id));
    dbMod.db
      .query(`UPDATE tasks SET ci_status='pass', ci_summary='gate passed', ci_tip=? WHERE id=?`)
      .run(preRebaseTip, id);

    // Move main ahead so the merge rebases the task (its tip MOVES past ci_tip).
    advanceMain("sibling.txt", "sibling\n");

    // All-green verify so the merge actually lands — we want to observe the invalidation
    // that happened inside the pre-ff hook survive onto the merged row.
    verifyMod.setVerifyRunner(async () => ({ ok: true, output: "" }));

    const out = await tasksMod.approveTask(id);
    expect(out.task.status).toBe("merged");

    // The rebase moved the tip past the gated ci_tip, so the now-stale green was cleared
    // BEFORE the ff (mirrors maybeAutoMerge's ci_tip staleness guard).
    const row = dbRow(id);
    expect(row.ci_status).toBeNull();
    expect(row.ci_tip).toBeNull();
    expect(row.ci_summary).toBeNull();
  });
});
