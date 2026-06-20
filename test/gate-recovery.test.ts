// Tests for GATE RECOVERY after a host/herdr restart — the sibling of the agent
// auto-resume fix (auto-resume.test.ts). The CI build/test gate (tasks.triggerCi) and
// the spec-conformance reviewer (conformance.triggerConformance) run FIRE-AND-FORGET in
// butchr's OWN process, so a power loss / restart kills a gate mid-run and leaves the
// task stuck `ci_status='running'` / `conformance_status='checking'` FOREVER (it can
// never become mergeable until requeued by hand — the real incident). tasks.recoverStuckGates
// (called on startup from index.ts and as the reaper.reapStuckGates backstop) re-triggers
// every such stale in-flight gate, bounded by config.maxGateRecoveryAttempts.
//
// Pure / in-process: no real claude or herdr is spawned (BUTCHR_HERDR_BIN=true) and NO
// real `bun` build / headless reviewer runs — setCiRunner / setConformanceRunner inject
// fakes, so these tests exercise the detection + re-trigger wiring only.
//
// What this exercises (mapped to the spec):
//   1. a stuck ci_status='running' with no live gate process → re-triggered (status
//      moves off 'running'); same for conformance_status='checking'; both at once.
//   2. liveness reuse — a gate genuinely RUNNING in this process (ciGateInFlight) is NOT
//      re-triggered (the mid-run-death-without-restart guard).
//   3. bound — past config.maxGateRecoveryAttempts (or a missing worktree) the stuck gate
//      is FORCE-SETTLED (CI→'fail', conformance→NULL) instead of looping; the streak
//      resets to 0 on a real gate result.
//   4. the reaper backstop (reapStuckGates) recovers too, and is a no-op when nothing is stuck.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
// Distinct workspace id — the db/config singletons are shared across test files, so a
// unique dir keeps this file's rows from colliding with another file's.
const DIR_ID = "gate-recovery-dir";

let tasksMod: typeof import("../src/tasks.ts");
let dbMod: typeof import("../src/db.ts");
let taskmdMod: typeof import("../src/taskmd.ts");
let confMod: typeof import("../src/conformance.ts");
let reaperMod: typeof import("../src/reaper.ts");
let configMod: typeof import("../src/config.ts");

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-gaterec-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-gaterec-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  execFileSync("git", ["init", "-q", REPO_ROOT], { stdio: "ignore" });
  const g = (args: string[]) =>
    execFileSync("git", ["-C", REPO_ROOT, ...args], { stdio: "ignore" });
  g(["config", "user.email", "test@butchr.local"]);
  g(["config", "user.name", "butchr test"]);
  g(["commit", "--allow-empty", "-q", "-m", "init"]);

  dbMod = await import("../src/db.ts");
  taskmdMod = await import("../src/taskmd.ts");
  confMod = await import("../src/conformance.ts");
  tasksMod = await import("../src/tasks.ts");
  reaperMod = await import("../src/reaper.ts");
  configMod = await import("../src/config.ts");

  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(DIR_ID, REPO_ROOT, "test", dbMod.nowIso());
});

afterAll(() => {
  // Restore the default CI runner so a never-resolving fake injected here can't leak into
  // a later test file (finalizeMerge now DRAINS in-flight CI before merging — an inherited
  // never-settling runner would hang that drain in another file's approve path).
  tasksMod.setCiRunner();
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

/**
 * Seed a DB-row task (in_review by default) + its on-disk task.md, with the gate
 * columns set to the stuck values under test. `worktree:true` creates the task's
 * worktree directory so the re-triggered gate's existsSync guard passes.
 */
function seed(opts: {
  id: string;
  status?: string;
  ci_status?: string | null;
  conformance_status?: string | null;
  gate_recovery_attempts?: number;
  worktree?: boolean;
}): string {
  const status = opts.status ?? "in_review";
  const created = dbMod.nowIso();
  dbMod.db
    .query(
      `INSERT INTO tasks (id, workspace_id, status, ci_status, conformance_status,
         gate_recovery_attempts, started_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.id,
      DIR_ID,
      status,
      opts.ci_status ?? null,
      opts.conformance_status ?? null,
      opts.gate_recovery_attempts ?? 0,
      created,
      created,
    );
  taskmdMod.writeTaskMd(
    REPO_ROOT,
    { id: opts.id, created, status: status as any, context: [] },
    `Work for ${opts.id}.`,
  );
  taskmdMod.updateTaskMdStatus(REPO_ROOT, opts.id, status as any);
  if (opts.worktree !== false) mkdirSync(join(REPO_ROOT, opts.id), { recursive: true });
  return opts.id;
}

function row(id: string) {
  return dbMod.db.query<any, [string]>(`SELECT * FROM tasks WHERE id=?`).get(id)!;
}

/** Poll `row(id)[col]` until it !== `stuck`, or fail after a short timeout. */
async function waitOffStuck(id: string, col: string, stuck: string): Promise<any> {
  for (let i = 0; i < 200; i++) {
    const v = row(id)[col];
    if (v !== stuck) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`${col} for ${id} never moved off '${stuck}' (still stuck)`);
}

describe("recoverStuckGates re-triggers stale in-flight gates", () => {
  test("a stuck ci_status='running' (no live process) is re-triggered → moves to 'pass'", async () => {
    const id = seed({ id: "rec-ci", ci_status: "running", worktree: true });
    const calls: string[] = [];
    tasksMod.setCiRunner(async (_dir, taskId) => {
      calls.push(taskId);
      return { status: "pass", label: "build + 3 tests", detail: "ok" };
    });

    const res = await tasksMod.recoverStuckGates();
    expect(res.ci).toBe(1);

    expect(calls).toEqual([id]); // the CI runner was re-invoked
    const settled = await waitOffStuck(id, "ci_status", "running");
    expect(settled).toBe("pass");
  });

  test("a stuck conformance_status='checking' is re-triggered → moves off 'checking'", async () => {
    const id = seed({ id: "rec-conf", conformance_status: "checking", worktree: true });
    const calls: string[] = [];
    confMod.setConformanceRunner(async (input) => {
      calls.push(input.taskId);
      return { conforms: "yes", reason: "" };
    });

    const res = await tasksMod.recoverStuckGates();
    expect(res.conformance).toBe(1);

    // The conformance runner is invoked after an internal await (git.diff), so assert via
    // the settle rather than a synchronous call capture.
    const settled = await waitOffStuck(id, "conformance_status", "checking");
    expect(settled).toBe("pass");
    expect(calls).toEqual([id]);
  });

  test("BOTH gates stuck on one task → both re-triggered", async () => {
    const id = seed({
      id: "rec-both",
      ci_status: "running",
      conformance_status: "checking",
      worktree: true,
    });
    const ciCalls: string[] = [];
    const confCalls: string[] = [];
    tasksMod.setCiRunner(async (_d, t) => {
      ciCalls.push(t);
      return { status: "pass", label: "build", detail: "" };
    });
    confMod.setConformanceRunner(async (input) => {
      confCalls.push(input.taskId);
      return { conforms: "yes", reason: "" };
    });

    const res = await tasksMod.recoverStuckGates();
    expect(res.ci).toBe(1);
    expect(res.conformance).toBe(1);
    // CI's runner is called synchronously; conformance's after an internal await — assert
    // it via the settle.
    expect(ciCalls).toEqual([id]);
    await waitOffStuck(id, "conformance_status", "checking");
    expect(confCalls).toEqual([id]);
  });

  test("a settled gate (ci_status='pass') is left alone — nothing to recover", async () => {
    const id = seed({ id: "rec-settled", ci_status: "pass", worktree: true });
    let called = 0;
    tasksMod.setCiRunner(async () => {
      called++;
      return { status: "pass", label: "build", detail: "" };
    });

    const res = await tasksMod.recoverStuckGates();
    expect(called).toBe(0);
    expect(res.ci).toBe(0);
    expect(row(id).ci_status).toBe("pass");
  });

  test("only acts on in_review tasks (a stuck-looking value on another status is ignored)", async () => {
    const id = seed({ id: "rec-notreview", status: "in_progress", ci_status: "running", worktree: true });
    let called = 0;
    tasksMod.setCiRunner(async () => {
      called++;
      return { status: "pass", label: "build", detail: "" };
    });

    await tasksMod.recoverStuckGates();
    expect(called).toBe(0);
    expect(row(id).ci_status).toBe("running"); // untouched
  });
});

describe("liveness reuse — a genuinely-running gate is NOT re-triggered", () => {
  test("ci_status='running' WITH a live in-process gate is skipped", async () => {
    const id = seed({ id: "rec-live", worktree: true });
    let calls = 0;
    // A runner that never resolves: triggerCi's synchronous prefix flips ci_status to
    // 'running' AND marks the gate in-flight in THIS process, then parks on the runner.
    tasksMod.setCiRunner(() => {
      calls++;
      return new Promise(() => {});
    });
    // Fire-and-forget (it never resolves) — this is the "gate still legitimately running"
    // state. The sync prefix runs before we continue.
    void tasksMod.triggerCi(id);
    expect(row(id).ci_status).toBe("running");
    expect(tasksMod.ciGateInFlight(id)).toBe(true);
    expect(calls).toBe(1);

    const res = await tasksMod.recoverStuckGates();
    // Not re-triggered: the gate is genuinely live in this process.
    expect(res.ci).toBe(0);
    expect(calls).toBe(1);
  });
});

describe("bounded recovery (config.maxGateRecoveryAttempts) + reset on a real result", () => {
  let saved: number;
  beforeAll(() => {
    saved = configMod.config.maxGateRecoveryAttempts;
  });
  afterAll(() => {
    configMod.config.maxGateRecoveryAttempts = saved;
  });

  test("under the cap: re-trigger increments the streak, then a real result resets it to 0", async () => {
    configMod.config.maxGateRecoveryAttempts = 5;
    const id = seed({ id: "rec-reset", ci_status: "running", gate_recovery_attempts: 0, worktree: true });
    tasksMod.setCiRunner(async () => ({ status: "fail", label: "1 fail", detail: "boom" }));

    await tasksMod.recoverStuckGates();
    // triggerCi settles 'fail' and resets the streak to 0 (a real gate result).
    const settled = await waitOffStuck(id, "ci_status", "running");
    expect(settled).toBe("fail");
    expect(row(id).gate_recovery_attempts).toBe(0);
  });

  test("past the cap: the stuck CI gate is FORCE-SETTLED 'fail' (not re-triggered)", async () => {
    configMod.config.maxGateRecoveryAttempts = 2;
    // attempts already at the cap → attempts+1 exceeds it → force-settle.
    const id = seed({ id: "rec-cap-ci", ci_status: "running", gate_recovery_attempts: 2, worktree: true });
    let called = 0;
    tasksMod.setCiRunner(async () => {
      called++;
      return { status: "pass", label: "build", detail: "" };
    });

    const res = await tasksMod.recoverStuckGates();
    expect(called).toBe(0); // not re-run
    expect(res.settled).toBe(1);
    const r = row(id);
    expect(r.ci_status).toBe("fail");
    expect(r.ci_summary).toContain("after a butchr restart");
    expect(r.gate_recovery_attempts).toBe(0); // reset
  });

  test("past the cap: the stuck conformance gate is FORCE-CLEARED to NULL", async () => {
    configMod.config.maxGateRecoveryAttempts = 2;
    const id = seed({
      id: "rec-cap-conf",
      conformance_status: "checking",
      gate_recovery_attempts: 2,
      worktree: true,
    });
    let called = 0;
    confMod.setConformanceRunner(async () => {
      called++;
      return { conforms: "yes", reason: "" };
    });

    const res = await tasksMod.recoverStuckGates();
    expect(called).toBe(0);
    expect(res.settled).toBe(1);
    expect(row(id).conformance_status).toBeNull();
  });

  test("maxGateRecoveryAttempts<=0 disables recovery — the stuck gate is force-settled immediately", async () => {
    configMod.config.maxGateRecoveryAttempts = 0;
    const id = seed({ id: "rec-disabled", ci_status: "running", gate_recovery_attempts: 0, worktree: true });
    let called = 0;
    tasksMod.setCiRunner(async () => {
      called++;
      return { status: "pass", label: "build", detail: "" };
    });

    await tasksMod.recoverStuckGates();
    expect(called).toBe(0);
    expect(row(id).ci_status).toBe("fail");
  });

  test("a missing worktree force-settles instead of re-triggering into a no-op", async () => {
    configMod.config.maxGateRecoveryAttempts = 5;
    const id = seed({ id: "rec-noworktree", ci_status: "running", worktree: false });
    let called = 0;
    tasksMod.setCiRunner(async () => {
      called++;
      return { status: "pass", label: "build", detail: "" };
    });

    const res = await tasksMod.recoverStuckGates();
    expect(called).toBe(0);
    expect(res.settled).toBe(1);
    const r = row(id);
    expect(r.ci_status).toBe("fail");
    expect(r.ci_summary).toContain("worktree is gone");
  });
});

describe("reaper backstop (reapStuckGates)", () => {
  test("re-triggers a stuck gate and reports the count", async () => {
    const id = seed({ id: "reap-ci", ci_status: "running", worktree: true });
    const calls: string[] = [];
    tasksMod.setCiRunner(async (_d, t) => {
      calls.push(t);
      return { status: "pass", label: "build", detail: "" };
    });

    const n = await reaperMod.reapStuckGates();
    expect(n).toBe(1);
    expect(calls).toEqual([id]);
    const settled = await waitOffStuck(id, "ci_status", "running");
    expect(settled).toBe("pass");
  });

  test("is a no-op when nothing is stuck", async () => {
    const n = await reaperMod.reapStuckGates();
    expect(n).toBe(0);
  });
});
