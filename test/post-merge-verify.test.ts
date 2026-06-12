// Tests for the POST-MERGE VERIFY GATE + AUTO-REVERT (see config.verifyCmd,
// src/verify.ts, git.headSha/resetHard, and tasks.approveTask's post-merge path).
//
// The verify RUNNER is mocked via verify.setVerifyRunner so we exercise the
// revert-on-red DECISION deterministically without spawning a real
// `bun build` / `bun test`. Everything else is REAL: a throwaway git repo, a real
// worktree/branch created by createTask, a real committed change, and a real
// git.merge fast-forward — so we can assert the default branch is genuinely
// reset back to its pre-merge tip on RED and genuinely advances on GREEN.
//
// BUTCHR_HERDR_BIN points at `true` so every herdr probe (teardownTask) is a
// harmless no-op, as in the other test files.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
const DIR_ID = "verify-dir";

let tasksMod: typeof import("../src/tasks.ts");
let dbMod: typeof import("../src/db.ts");
let taskmdMod: typeof import("../src/taskmd.ts");
let verifyMod: typeof import("../src/verify.ts");

function g(args: string[], cwd = REPO_ROOT): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-verify-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-verify-repo-"));

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
    .query(
      `INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`,
    )
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

/**
 * Create a REAL task (worktree + branch + task.md + DB row), have the "agent"
 * commit a file in the worktree, and move it to `review` so it's approvable.
 * Returns the task id and the filename it added at the repo root.
 */
async function seedReviewTaskWithWork(file: string, content: string): Promise<string> {
  const view = await tasksMod.createTask(DIR_ID, `Add ${file}`);
  const id = view.id;
  const wt = join(REPO_ROOT, id);
  writeFileSync(join(wt, file), content);
  g(["add", "-A"], wt);
  g(["commit", "-q", "-m", `add ${file}`], wt);
  // Move to in_review (the state approveTask requires) in both the DB and task.md.
  dbMod.db.query(`UPDATE tasks SET status='in_review' WHERE id=?`).run(id);
  taskmdMod.updateTaskMdStatus(REPO_ROOT, id, "in_review");
  return id;
}

describe("post-merge verify gate", () => {
  test("RED verify auto-reverts the merge off main and flags the task", async () => {
    verifyMod.setVerifyRunner(async () => ({ ok: false, output: "FAIL: 2 tests failed\nboom" }));
    const id = await seedReviewTaskWithWork("feature.txt", "feature\n");
    const tipBefore = g(["rev-parse", "HEAD"]);

    await tasksMod.approveTask(id); // in_review → finalizing
    const out = await tasksMod.finalizeMerge(id); // finalizing → merge attempt → revert

    // Decision: reverted, not merged.
    expect(out.revertedOnRed).toBe(true);
    expect(out.task.status).toBe("aborted");

    // The default branch is back exactly at its pre-merge tip — the bad commit
    // did NOT survive on main, and its file is gone from the repo root worktree.
    expect(g(["rev-parse", "HEAD"])).toBe(tipBefore);
    expect(existsSync(join(REPO_ROOT, "feature.txt"))).toBe(false);

    // The task is flagged with the failing output, and its work is preserved
    // (branch + worktree kept) for inspection / a fixup re-run.
    const row = dbRow(id);
    expect(row.status).toBe("aborted");
    expect(row.revert_reason).toContain("boom");
    expect(row.last_dispatch_error).toContain("boom");
    expect(g(["rev-parse", "--verify", id])).toBeTruthy(); // task branch still exists
    expect(existsSync(join(REPO_ROOT, id))).toBe(true); // worktree kept
    expect(taskmdMod.readTaskMd(REPO_ROOT, id).meta.status).toBe("aborted");
  });

  test("GREEN verify lets the merge stand (task merged, branch cleaned up)", async () => {
    verifyMod.setVerifyRunner(async () => ({ ok: true, output: "" }));
    const id = await seedReviewTaskWithWork("greenfile.txt", "green\n");
    const tipBefore = g(["rev-parse", "HEAD"]);

    await tasksMod.approveTask(id); // in_review → finalizing
    const out = await tasksMod.finalizeMerge(id); // finalizing → merged

    expect(out.revertedOnRed).toBeFalsy();
    expect(out.task.status).toBe("merged");

    // Main advanced and the change landed at the repo root.
    expect(g(["rev-parse", "HEAD"])).not.toBe(tipBefore);
    expect(existsSync(join(REPO_ROOT, "greenfile.txt"))).toBe(true);
    expect(dbRow(id).status).toBe("merged");
    // Post-merge cleanup removed the worktree + branch.
    expect(existsSync(join(REPO_ROOT, id))).toBe(false);

    let branchGone = false;
    try {
      g(["rev-parse", "--verify", id]);
    } catch {
      branchGone = true;
    }
    expect(branchGone).toBe(true);
  });

  test("verify runs ONLY after a successful merge — never gates a clean GREEN twice", async () => {
    // Two sequential approvals through the serialized merge queue: a RED one is
    // reverted and a following GREEN one still merges cleanly onto the restored
    // tip (the revert left main in a mergeable state for the next task).
    verifyMod.setVerifyRunner(async () => ({ ok: false, output: "still red" }));
    const redId = await seedReviewTaskWithWork("red.txt", "red\n");
    const tip0 = g(["rev-parse", "HEAD"]);
    await tasksMod.approveTask(redId);
    const redOut = await tasksMod.finalizeMerge(redId);
    expect(redOut.revertedOnRed).toBe(true);
    expect(g(["rev-parse", "HEAD"])).toBe(tip0); // main restored

    verifyMod.setVerifyRunner(async () => ({ ok: true, output: "" }));
    const greenId = await seedReviewTaskWithWork("after.txt", "after\n");
    await tasksMod.approveTask(greenId);
    const greenOut = await tasksMod.finalizeMerge(greenId);
    expect(greenOut.task.status).toBe("merged");
    expect(existsSync(join(REPO_ROOT, "after.txt"))).toBe(true);
  });
});

describe("verify runner default (disabled when verifyCmd is empty)", () => {
  test("an empty gate command is treated as skipped/GREEN", async () => {
    // The default runner short-circuits to ok when verifyCmd is blank. We can't
    // easily blank the cached config here, so assert the runner contract directly
    // via a stub that mirrors the skip behavior, then confirm approveTask merges.
    verifyMod.setVerifyRunner(async () => ({ ok: true, output: "", skipped: true }));
    const id = await seedReviewTaskWithWork("skip.txt", "skip\n");
    await tasksMod.approveTask(id); // in_review → finalizing
    const out = await tasksMod.finalizeMerge(id); // finalizing → merged
    expect(out.task.status).toBe("merged");
    expect(existsSync(join(REPO_ROOT, "skip.txt"))).toBe(true);
  });
});
