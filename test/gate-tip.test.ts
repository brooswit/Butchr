// Tests for STALE-GREEN GATE INVALIDATION (scope 2) and the always-present worktree_path
// on the task view (scope 3).
//
// A settled gate result (ci/conformance) is only meaningful for the EXACT branch tip it
// ran against (ci_tip / conformance_tip). When the tip moves, the stored result is for a
// DIFFERENT tip and must never be trusted as green — invalidateStaleGates clears it and
// maybeAutoMerge refuses to merge on it.
//
// Real git + real worktrees, like the other merge tests; herdr probes no-op'd.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
const WS_ID = "gate-tip-ws";

let tasksMod: typeof import("../src/tasks.ts");
let dbMod: typeof import("../src/db.ts");
let taskmdMod: typeof import("../src/taskmd.ts");
let verifyMod: typeof import("../src/verify.ts");
let wsMod: typeof import("../src/workspaces.ts");
let configMod: typeof import("../src/config.ts");

function g(args: string[], cwd = REPO_ROOT): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-gatetip-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-gatetip-repo-"));

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
  wsMod = await import("../src/workspaces.ts");
  configMod = await import("../src/config.ts");

  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(WS_ID, REPO_ROOT, "test", dbMod.nowIso());
});

afterEach(() => {
  verifyMod.setVerifyRunner();
  configMod.config.autoMergeEnabled = false;
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

function dbRow(id: string) {
  return dbMod.db.query<any, [string]>(`SELECT * FROM tasks WHERE id=?`).get(id)!;
}

/** Create a task with a real worktree + one committed change, left in_review. Returns
 * { id, tip } where tip is the worktree branch HEAD. */
async function seedReviewTask(file: string): Promise<{ id: string; tip: string }> {
  const view = await tasksMod.createTask(WS_ID, `Add ${file}`);
  const id = view.id;
  const wt = join(REPO_ROOT, id);
  writeFileSync(join(wt, file), "export const x = 1;\n");
  g(["add", "-A"], wt);
  g(["commit", "-q", "-m", `add ${file}`], wt);
  const tip = g(["rev-parse", "HEAD"], wt);
  dbMod.db.query(`UPDATE tasks SET status='in_review' WHERE id=?`).run(id);
  taskmdMod.updateTaskMdStatus(REPO_ROOT, id, "in_review");
  return { id, tip };
}

describe("invalidateStaleGates", () => {
  test("clears a settled gate whose stored tip ≠ HEAD; leaves a matching-tip gate untouched", async () => {
    const { id, tip } = await seedReviewTask("a.ts");
    // CI bound to a STALE tip; conformance bound to the CURRENT tip.
    dbMod.db
      .query(
        `UPDATE tasks SET ci_status='pass', ci_summary='ok', ci_tip=?,
           conformance_status='pass', conformance_summary='conforms', conformance_tip=? WHERE id=?`,
      )
      .run("0000000000000000000000000000000000000000", tip, id);

    const changed = await tasksMod.invalidateStaleGates(id);
    expect(changed).toBe(true);

    const row = dbRow(id);
    // Stale CI cleared entirely…
    expect(row.ci_status).toBeNull();
    expect(row.ci_summary).toBeNull();
    expect(row.ci_tip).toBeNull();
    // …matching-tip conformance untouched.
    expect(row.conformance_status).toBe("pass");
    expect(row.conformance_tip).toBe(tip);
  });

  test("a gate already bound to the current tip is a no-op", async () => {
    const { id, tip } = await seedReviewTask("b.ts");
    dbMod.db
      .query(`UPDATE tasks SET ci_status='pass', ci_summary='ok', ci_tip=? WHERE id=?`)
      .run(tip, id);
    expect(await tasksMod.invalidateStaleGates(id)).toBe(false);
    expect(dbRow(id).ci_status).toBe("pass");
  });

  test("an in-flight ('running') gate carries no tip and is never cleared", async () => {
    const { id } = await seedReviewTask("c.ts");
    dbMod.db
      .query(`UPDATE tasks SET ci_status='running', ci_tip=NULL WHERE id=?`)
      .run(id);
    expect(await tasksMod.invalidateStaleGates(id)).toBe(false);
    expect(dbRow(id).ci_status).toBe("running");
  });
});

describe("maybeAutoMerge stale-green guard", () => {
  test("a green bound to a STALE tip is NOT auto-merged (main is untouched)", async () => {
    configMod.config.autoMergeEnabled = true;
    verifyMod.setVerifyRunner(async () => ({ ok: true, output: "" }));
    // A gate command that's harmless + RED so the guard's re-run can't go on to merge in the
    // background — keeps the assertion deterministic (the stale green itself must not merge).
    wsMod.updateWorkspaceGateCmd(WS_ID, "false");

    const { id } = await seedReviewTask("stale.ts");
    // Mark green, but bound to a tip that is NOT the current HEAD.
    dbMod.db
      .query(`UPDATE tasks SET ci_status='pass', ci_summary='ok', ci_tip=? WHERE id=?`)
      .run("0000000000000000000000000000000000000000", id);
    const mainBefore = g(["rev-parse", "HEAD"]);

    const merged = await tasksMod.maybeAutoMerge(id);

    expect(merged).toBe(false); // refused — the green is for a different tip
    expect(g(["rev-parse", "HEAD"])).toBe(mainBefore); // main never advanced
    expect(dbRow(id).status).toBe("in_review");
    wsMod.updateWorkspaceGateCmd(WS_ID, null);
  });
});

describe("worktree_path on the task view (always present, deterministic)", () => {
  test("taskView and taskListView expose the deterministic worktree path", async () => {
    const { id } = await seedReviewTask("d.ts");
    const expected = join(REPO_ROOT, id);

    expect(tasksMod.taskView(id)!.worktree_path).toBe(expected);
    const listed = tasksMod.taskListView(WS_ID).find((t) => t.id === id)!;
    expect(listed.worktree_path).toBe(expected);
  });

  test("the path is present even when the worktree directory is gone (it's a derived path, not an existence check)", async () => {
    const { id } = await seedReviewTask("e.ts");
    const expected = join(REPO_ROOT, id);
    // Remove the on-disk worktree (as happens after a merge/cleanup).
    g(["worktree", "remove", "--force", expected]);

    expect(tasksMod.taskView(id)!.worktree_path).toBe(expected);
  });
});
