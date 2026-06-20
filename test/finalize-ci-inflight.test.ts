// Tests for the F3 CI-IN-FLIGHT GUARD in tasks.finalizeMerge (story st-e79fcb83,
// merge-pipeline hardening S1).
//
// CI is fired fire-and-forget on review entry (void triggerCi) and runs the workspace
// build/test IN the task worktree. A human approve before CI settles would make
// finalizeMerge rebase (git.merge) + teardown that worktree WHILE the CI subprocess is
// still executing there. finalizeMerge now DRAINS any in-flight CI (ciGateInFlight) BEFORE
// it takes the merge lock / touches the worktree, so the teardown can never race a live CI
// run. This test injects a CI runner that parks on a latch to hold the gate "in flight",
// then asserts the approve defers until the latch releases.
//
// Real throwaway repo + worktree + git.merge; the verify runner is mocked GREEN so the
// merge lands once CI clears. BUTCHR_HERDR_BIN=`true` makes herdr probes no-ops.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
const DIR_ID = "ci-inflight-dir";

let tasksMod: typeof import("../src/tasks.ts");
let dbMod: typeof import("../src/db.ts");
let taskmdMod: typeof import("../src/taskmd.ts");
let verifyMod: typeof import("../src/verify.ts");

function g(args: string[], cwd = REPO_ROOT): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-ciflight-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-ciflight-repo-"));

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
  verifyMod.setVerifyRunner();
  tasksMod.setCiRunner();
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

function dbRow(id: string) {
  return dbMod.db.query<any, [string]>(`SELECT * FROM tasks WHERE id=?`).get(id)!;
}

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

describe("F3 — CI-in-flight guard (finalizeMerge)", () => {
  test("an approve while CI is in flight defers the merge/teardown until CI settles", async () => {
    verifyMod.setVerifyRunner(async () => ({ ok: true, output: "" }));
    const id = await seedReviewTaskWithWork("ciflight.txt", "x\n");

    // A CI runner that parks until released, recording whether it is actively running so we
    // can assert the worktree was NOT torn down while the CI process was live in it.
    let releaseCi!: () => void;
    const ciGate = new Promise<void>((res) => { releaseCi = res; });
    let ciRunning = false;
    tasksMod.setCiRunner(async () => {
      ciRunning = true;
      await ciGate;
      ciRunning = false;
      return { status: "pass", label: "gate passed", detail: "" };
    });

    // Fire CI fire-and-forget exactly as review entry does; it marks liveness + enters the
    // (parked) runner synchronously before yielding.
    void tasksMod.triggerCi(id);
    await delay(10);
    expect(tasksMod.ciGateInFlight(id)).toBe(true);
    expect(ciRunning).toBe(true);

    // Approve WHILE CI is in flight — finalizeMerge must drain CI before it rebases/tears
    // down the worktree, so it parks instead of proceeding.
    const mergeP = tasksMod.approveTask(id);
    await delay(60); // ample time for the drain loop to (wrongly) proceed if it didn't wait

    // Still parked: not merged, worktree intact, CI still live in it.
    expect(dbRow(id).status).toBe("in_review");
    expect(existsSync(join(REPO_ROOT, id))).toBe(true);
    expect(ciRunning).toBe(true);

    // Release CI → liveness clears → the drain lets the merge proceed and land.
    releaseCi();
    const out = await mergeP;

    expect(out.task.status).toBe("merged");
    // CI had fully settled (not running) before the worktree was discarded.
    expect(ciRunning).toBe(false);
    expect(existsSync(join(REPO_ROOT, id))).toBe(false);
    expect(g(["rev-parse", "HEAD"])).not.toBe(""); // main advanced cleanly
  });

  test("an approve with NO CI in flight merges without waiting", async () => {
    verifyMod.setVerifyRunner(async () => ({ ok: true, output: "" }));
    const id = await seedReviewTaskWithWork("nociflight.txt", "y\n");
    expect(tasksMod.ciGateInFlight(id)).toBe(false);

    const out = await tasksMod.approveTask(id);
    expect(out.task.status).toBe("merged");
    expect(existsSync(join(REPO_ROOT, id))).toBe(false);
  });
});
