// Tests for the DRY + DESYNC-FIX consolidation on the task state-machine spine:
//
//  1. T1 — the task.md MIRROR is now kept in lockstep on the transitions that used to
//     skip it. markRunning (→ in_progress), backToQueued (→ inactive), and
//     markDispatchFailure under the retry cap (→ inactive) all route through setStatus,
//     so the on-disk `status:` front-matter follows the DB. markDispatchFailure's
//     under-cap re-arm also now records an audit event (it recorded none before).
//
//  2. G3/G4 — the shared gate helpers in src/gate.ts: makeGateLiveness (independent
//     mark/clear/isLive trackers) and settleGate (the in_review-guarded settle write that
//     resets gate_recovery_attempts, with an optional "still stuck on the same value"
//     require guard).
//
// In-process: no real claude/herdr (BUTCHR_HERDR_BIN=true), gate_cmd="" so review never
// shells out a real build. createTask runs for real (worktree + task.md + DB row).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
const DIR_ID = "sync-dir";

let tasksMod: typeof import("../src/tasks.ts");
let dbMod: typeof import("../src/db.ts");
let taskmdMod: typeof import("../src/taskmd.ts");
let gateMod: typeof import("../src/gate.ts");
let conformanceMod: typeof import("../src/conformance.ts");

function g(args: string[], cwd = REPO_ROOT): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}
function row(id: string) {
  return dbMod.db.query<any, [string]>(`SELECT * FROM tasks WHERE id=?`).get(id)!;
}
/** The `status:` front-matter line written into the task's on-disk task.md. */
function mdStatus(id: string): string {
  const md = readFileSync(taskmdMod.taskMdPath(REPO_ROOT, id), "utf8");
  return md.match(/^status:\s*(.+)$/m)?.[1]?.trim() ?? "";
}
function transitions(id: string): [string | null, string][] {
  return dbMod.listTaskEvents(id).map((e) => [e.from_status, e.to_status]);
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-sync-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-sync-repo-"));

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
  gateMod = await import("../src/gate.ts");
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

describe("T1 — task.md mirror stays in lockstep on the migrated transitions", () => {
  test("markRunning mirrors in_progress into task.md (was skipped before)", async () => {
    const v = await tasksMod.createTask(DIR_ID, "mirror on launch");
    expect(row(v.id).status).toBe("inactive");
    expect(mdStatus(v.id)).toBe("inactive");

    tasksMod.markRunning(v.id, `pane-${v.id}`, `sess-${v.id}`, `tab-${v.id}`);
    expect(row(v.id).status).toBe("in_progress");
    // The desync fix: the on-disk mirror now follows the DB transition.
    expect(mdStatus(v.id)).toBe("in_progress");
  });

  test("backToQueued mirrors inactive into task.md", async () => {
    const v = await tasksMod.createTask(DIR_ID, "mirror on requeue");
    tasksMod.markRunning(v.id, `pane-${v.id}`, `sess-${v.id}`, `tab-${v.id}`);
    expect(mdStatus(v.id)).toBe("in_progress");

    await tasksMod.backToQueued(v.id);
    expect(row(v.id).status).toBe("inactive");
    expect(mdStatus(v.id)).toBe("inactive");
  });

  test("markDispatchFailure under the cap mirrors inactive AND records an audit event", async () => {
    const v = await tasksMod.createTask(DIR_ID, "mirror on dispatch failure");
    tasksMod.markRunning(v.id, `pane-${v.id}`, `sess-${v.id}`, `tab-${v.id}`);
    expect(row(v.id).status).toBe("in_progress");

    await tasksMod.markDispatchFailure(v.id, "spawn failed");
    const r = row(v.id);
    // Under the cap (default 5): re-armed READY inactive with a backoff + attempt count.
    expect(r.status).toBe("inactive");
    expect(r.dispatch_attempts).toBe(1);
    expect(r.last_dispatch_error).toBe("spawn failed");
    expect(r.next_dispatch_at).toBeTruthy();
    // The desync fix: the mirror follows, and the genuine transition is now audited.
    expect(mdStatus(v.id)).toBe("inactive");
    expect(transitions(v.id)).toContainEqual(["in_progress", "inactive"]);
  });

  test("markRunning stamps session_id once but re-stamps grounding_fp when supplied", async () => {
    const v = await tasksMod.createTask(DIR_ID, "coalesce semantics");
    tasksMod.markRunning(v.id, "pane-a", "sess-first", "tab-a", "fp-1");
    expect(row(v.id).session_id).toBe("sess-first");
    expect(row(v.id).grounding_fp).toBe("fp-1");

    // Re-arm and relaunch: session_id is stamp-once (keep) so it sticks; grounding_fp is
    // overwrite-if-supplied (setIfPresent) so a new fingerprint replaces it, but a null
    // one leaves it untouched.
    await tasksMod.backToQueued(v.id);
    tasksMod.markRunning(v.id, "pane-b", "sess-second", "tab-b");
    expect(row(v.id).session_id).toBe("sess-first"); // kept
    expect(row(v.id).grounding_fp).toBe("fp-1"); // untouched (no fp supplied)

    await tasksMod.backToQueued(v.id);
    tasksMod.markRunning(v.id, "pane-c", "sess-third", "tab-c", "fp-2");
    expect(row(v.id).session_id).toBe("sess-first"); // still kept
    expect(row(v.id).grounding_fp).toBe("fp-2"); // overwritten
  });
});

describe("T2 — parkExitingAgent reproduces each caller's exact herdr id column set", () => {
  // markInReview (dead-agent rescue) clears BOTH herdr_pane_id AND herdr_tab_id (the
  // caller is tearing the tab down); the two agent-tool paths clear ONLY herdr_pane_id.
  // This locks that per-caller difference so the extraction can't silently drop the tab
  // clear again.
  async function runningWithPaneAndTab(prompt: string): Promise<string> {
    const v = await tasksMod.createTask(DIR_ID, prompt);
    tasksMod.markRunning(v.id, `pane-${v.id}`, `sess-${v.id}`, `tab-${v.id}`);
    const r = row(v.id);
    expect(r.status).toBe("in_progress");
    expect(r.herdr_pane_id).toBe(`pane-${v.id}`);
    expect(r.herdr_tab_id).toBe(`tab-${v.id}`);
    return v.id;
  }

  test("markInReview clears herdr_pane_id AND herdr_tab_id", async () => {
    const id = await runningWithPaneAndTab("rescue clears both ids");
    tasksMod.markInReview(id, "run-log snapshot");
    const r = row(id);
    expect(r.status).toBe("in_review");
    expect(r.herdr_pane_id).toBeNull();
    expect(r.herdr_tab_id).toBeNull(); // the regression the reviewer caught
  });

  test("markReviewFromAgent clears herdr_pane_id but LEAVES herdr_tab_id", async () => {
    const id = await runningWithPaneAndTab("request_review leaves tab id");
    expect(tasksMod.markReviewFromAgent(id, "done")).toBe("ok");
    const r = row(id);
    expect(r.status).toBe("in_review");
    expect(r.herdr_pane_id).toBeNull();
    expect(r.herdr_tab_id).toBe(`tab-${id}`); // NOT cleared (matches pre-refactor)
  });

  test("markNeedsInfoFromAgent clears herdr_pane_id but LEAVES herdr_tab_id", async () => {
    const id = await runningWithPaneAndTab("raise leaves tab id");
    expect(tasksMod.markNeedsInfoFromAgent(id, "which approach?")).toBe("ok");
    const r = row(id);
    expect(r.status).toBe("needs_info");
    expect(r.herdr_pane_id).toBeNull();
    expect(r.herdr_tab_id).toBe(`tab-${id}`); // NOT cleared (matches pre-refactor)
  });

  test("the agent-tool paths return notfound/terminal without transitioning", async () => {
    expect(tasksMod.markReviewFromAgent("no-such-task")).toBe("notfound");
    expect(tasksMod.markNeedsInfoFromAgent("no-such-task", "q")).toBe("notfound");
    const merged = await tasksMod.createTask(DIR_ID, "terminal task");
    dbMod.db.query(`UPDATE tasks SET status='merged' WHERE id=?`).run(merged.id);
    expect(tasksMod.markReviewFromAgent(merged.id)).toBe("terminal");
    expect(tasksMod.markNeedsInfoFromAgent(merged.id, "q")).toBe("terminal");
    expect(row(merged.id).status).toBe("merged"); // untouched
  });
});

describe("G3/G4 — shared gate helpers (src/gate.ts)", () => {
  test("makeGateLiveness tracks mark/clear/isLive independently per instance", () => {
    const a = gateMod.makeGateLiveness();
    const b = gateMod.makeGateLiveness();
    expect(a.isLive("t1")).toBe(false);
    a.mark("t1");
    expect(a.isLive("t1")).toBe(true);
    // Independent instances don't share state.
    expect(b.isLive("t1")).toBe(false);
    a.clear("t1");
    expect(a.isLive("t1")).toBe(false);
  });

  test("settleGate writes + resets gate_recovery_attempts only while in_review", async () => {
    const v = await tasksMod.createTask(DIR_ID, "settle while in_review");
    // Force the row in_review with a mid-flight gate + a non-zero recovery streak.
    dbMod.db
      .query(`UPDATE tasks SET status='in_review', ci_status='running', gate_recovery_attempts=3 WHERE id=?`)
      .run(v.id);

    const changed = gateMod.settleGate(v.id, { ci_status: "pass", ci_summary: "gate passed" });
    expect(changed).toBe(true);
    expect(row(v.id).ci_status).toBe("pass");
    expect(row(v.id).ci_summary).toBe("gate passed");
    expect(row(v.id).gate_recovery_attempts).toBe(0);

    // No longer in_review → the guard makes the settle a no-op.
    dbMod.db.query(`UPDATE tasks SET status='merged' WHERE id=?`).run(v.id);
    const again = gateMod.settleGate(v.id, { ci_status: "fail", ci_summary: "late" });
    expect(again).toBe(false);
    expect(row(v.id).ci_status).toBe("pass"); // unchanged
  });

  test("settleGate's require guard force-settles only the still-stuck value", async () => {
    const v = await tasksMod.createTask(DIR_ID, "force-settle require guard");
    dbMod.db
      .query(`UPDATE tasks SET status='in_review', ci_status='running' WHERE id=?`)
      .run(v.id);

    // require: ci_status='running' matches → force-settle to 'fail'.
    expect(
      gateMod.settleGate(v.id, { ci_status: "fail", ci_summary: "stuck" }, { require: { ci_status: "running" } }),
    ).toBe(true);
    expect(row(v.id).ci_status).toBe("fail");

    // The stuck value is gone now ('fail', not 'running') → the require guard blocks it.
    expect(
      gateMod.settleGate(v.id, { ci_status: "pass", ci_summary: "x" }, { require: { ci_status: "running" } }),
    ).toBe(false);
    expect(row(v.id).ci_status).toBe("fail"); // unchanged
  });
});
