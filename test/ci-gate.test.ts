// Tests for butchr's CI GATE (see db.ts ci_status/ci_summary columns and
// tasks.{triggerCi,setCiRunner} fired from markReview / markReviewFromAgent).
//
// Pure / in-process: no real claude or herdr is spawned (BUTCHR_HERDR_BIN points
// at `true`, so herdr probes are harmless no-ops) and — crucially — NO real `bun`
// build/test is spawned: setCiRunner injects a fake runner, so these tests
// exercise the persistence + trigger wiring without ever shelling out to bun.
//
// What this exercises (mapped to the spec):
//   1. triggerCi persistence — pass / fail / runner-error results land in
//      ci_status + ci_summary (label on the first line).
//   2. the review TRANSITION trigger — a genuine running→review transition (both
//      markReview and markReviewFromAgent) kicks off CI (ci_status flips to
//      'running' and the runner is invoked); a duplicate review→review call does
//      NOT re-run it.
//   3. guards — CI is skipped when the task has no worktree, and a result is NOT
//      written back onto a task that left `review` while CI was running.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
// Distinct workspace id — the db/config singletons are shared across test files,
// so a unique dir keeps this file's rows from colliding with another file's.
const DIR_ID = "ci-gate-dir";

let tasksMod: typeof import("../src/tasks.ts");
let dbMod: typeof import("../src/db.ts");
let taskmdMod: typeof import("../src/taskmd.ts");
let wsMod: typeof import("../src/workspaces.ts");

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-ci-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-ci-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  // A real git repo so REPO_ROOT looks like a registered workspace (task.md +
  // worktree paths live under it). One commit so it's a valid repo.
  execFileSync("git", ["init", "-q", REPO_ROOT], { stdio: "ignore" });
  const g = (args: string[]) =>
    execFileSync("git", ["-C", REPO_ROOT, ...args], { stdio: "ignore" });
  g(["config", "user.email", "test@butchr.local"]);
  g(["config", "user.name", "butchr test"]);
  g(["commit", "--allow-empty", "-q", "-m", "init"]);

  dbMod = await import("../src/db.ts");
  taskmdMod = await import("../src/taskmd.ts");
  tasksMod = await import("../src/tasks.ts");
  wsMod = await import("../src/workspaces.ts");

  dbMod.db
    .query(
      `INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`,
    )
    .run(DIR_ID, REPO_ROOT, "test", dbMod.nowIso());
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

/**
 * Seed a DB-row task + its on-disk task.md. `worktree:true` also creates the
 * task's worktree directory so triggerCi's existsSync gate passes (we don't need
 * a real git worktree — the fake CI runner never touches it, only the gate does).
 */
function seed(opts: {
  id: string;
  status: string;
  worktree?: boolean;
}): string {
  const created = dbMod.nowIso();
  dbMod.db
    .query(
      `INSERT INTO tasks (id, workspace_id, status, started_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      opts.id,
      DIR_ID,
      opts.status,
      opts.status === "in_progress" || opts.status === "in_review" ? created : null,
      created,
    );
  taskmdMod.writeTaskMd(
    REPO_ROOT,
    { id: opts.id, created, status: opts.status as any, context: [] },
    `Work for ${opts.id}.`,
  );
  taskmdMod.updateTaskMdStatus(REPO_ROOT, opts.id, opts.status as any);
  if (opts.worktree) mkdirSync(join(REPO_ROOT, opts.id), { recursive: true });
  return opts.id;
}

function row(id: string) {
  return dbMod.db.query<any, [string]>(`SELECT * FROM tasks WHERE id=?`).get(id)!;
}

function setStatus(id: string, status: string) {
  dbMod.db.query(`UPDATE tasks SET status=? WHERE id=?`).run(status, id);
}

describe("triggerCi persistence", () => {
  test("a PASS result lands in ci_status + ci_summary (label on the first line)", async () => {
    const id = seed({ id: "ci-pass", status: "in_review", worktree: true });
    tasksMod.setCiRunner(async () => ({
      status: "pass",
      label: "build + 5 tests",
      detail: "5 pass\n0 fail",
    }));

    await tasksMod.triggerCi(id);

    const r = row(id);
    expect(r.ci_status).toBe("pass");
    expect(r.ci_summary.split("\n")[0]).toBe("build + 5 tests");
    expect(r.ci_summary).toContain("5 pass");
  });

  test("a FAIL result lands in ci_status + ci_summary", async () => {
    const id = seed({ id: "ci-fail", status: "in_review", worktree: true });
    tasksMod.setCiRunner(async () => ({
      status: "fail",
      label: "3 test failures",
      detail: "expected true to be false",
    }));

    await tasksMod.triggerCi(id);

    const r = row(id);
    expect(r.ci_status).toBe("fail");
    expect(r.ci_summary.split("\n")[0]).toBe("3 test failures");
    expect(r.ci_summary).toContain("expected true");
  });

  test("a runner error is recorded as a CI failure (never throws)", async () => {
    const id = seed({ id: "ci-error", status: "in_review", worktree: true });
    tasksMod.setCiRunner(async () => {
      throw new Error("bun blew up");
    });

    await tasksMod.triggerCi(id); // must not throw

    const r = row(id);
    expect(r.ci_status).toBe("fail");
    expect(r.ci_summary).toContain("CI error");
    expect(r.ci_summary).toContain("bun blew up");
  });

  test("skips entirely (ci_status stays NULL) when the task has no worktree", async () => {
    const id = seed({ id: "ci-noworktree", status: "in_review", worktree: false });
    let called = 0;
    tasksMod.setCiRunner(async () => {
      called++;
      return { status: "pass", label: "build + 1 tests", detail: "" };
    });

    await tasksMod.triggerCi(id);

    expect(called).toBe(0);
    expect(row(id).ci_status).toBeNull();
  });

  test("does NOT write a result onto a task that left review while CI ran", async () => {
    const id = seed({ id: "ci-raced", status: "in_review", worktree: true });
    let resolveRun: (r: any) => void;
    tasksMod.setCiRunner(
      () => new Promise((res) => { resolveRun = res; }),
    );

    const p = tasksMod.triggerCi(id);
    // Synchronous prefix already flipped ci_status to 'running'.
    expect(row(id).ci_status).toBe("running");

    // Task merges out from under the in-flight CI run.
    setStatus(id, "merged");
    resolveRun!({ status: "pass", label: "build + 9 tests", detail: "" });
    await p;

    // The guarded write (status='review') was a no-op — no stale 'pass' applied.
    expect(row(id).ci_status).toBe("running");
  });
});

describe("review-transition trigger", () => {
  test("markReviewFromAgent (in_progress→in_review) kicks off CI", async () => {
    const id = seed({ id: "trig-agent", status: "in_progress", worktree: true });
    const calls: string[] = [];
    tasksMod.setCiRunner((_dir, taskId) => {
      calls.push(taskId);
      return new Promise(() => {}); // never resolves: leaves ci_status='running'
    });

    expect(await tasksMod.markReviewFromAgent(id)).toBe("ok");
    // CI was kicked off synchronously by the transition.
    expect(calls).toEqual([id]);
    expect(row(id).status).toBe("in_review");
    expect(row(id).ci_status).toBe("running");
  });

  test("markInReview (dead-agent rescue path) kicks off CI", () => {
    const id = seed({ id: "trig-rescue", status: "in_progress", worktree: true });
    // markInReview requires in_progress + a pane set (simulates a live agent that ended).
    dbMod.db.query(`UPDATE tasks SET herdr_pane_id='rescue-pane' WHERE id=?`).run(id);
    const calls: string[] = [];
    tasksMod.setCiRunner((_dir, taskId) => {
      calls.push(taskId);
      return new Promise(() => {});
    });

    tasksMod.markInReview(id, "[butchr] rescued");
    expect(calls).toEqual([id]);
    expect(row(id).status).toBe("in_review");
    expect(row(id).ci_status).toBe("running");
  });

  test("a duplicate request_review (review→review) does NOT re-run CI", async () => {
    const id = seed({ id: "trig-dup", status: "in_review", worktree: true });
    const calls: string[] = [];
    tasksMod.setCiRunner((_dir, taskId) => {
      calls.push(taskId);
      return new Promise(() => {});
    });

    expect(await tasksMod.markReviewFromAgent(id, "again")).toBe("ok");
    expect(calls).toEqual([]); // no re-trigger on a non-transition
  });

  test("markInReview is a no-op (no CI) on a non-in_progress task", () => {
    const id = seed({ id: "trig-aborted", status: "aborted", worktree: true });
    const calls: string[] = [];
    tasksMod.setCiRunner((_dir, taskId) => {
      calls.push(taskId);
      return new Promise(() => {});
    });

    tasksMod.markInReview(id, "should be ignored");
    expect(calls).toEqual([]);
    expect(row(id).status).toBe("aborted");
  });
});

describe("flaky-CI retry (config.ciRetries, default 1)", () => {
  // The config module reads BUTCHR_CI_RETRIES once at import. It's already loaded
  // (shared singleton across the suite), so mutate the live config object to drive
  // the retry count deterministically rather than relying on env at import time.
  let configMod: typeof import("../src/config.ts");
  let savedRetries: number;

  beforeAll(async () => {
    configMod = await import("../src/config.ts");
    savedRetries = configMod.config.ciRetries;
  });
  afterAll(() => {
    configMod.config.ciRetries = savedRetries;
  });

  /** A runner that returns the given statuses in order, one per invocation. */
  function sequenceRunner(statuses: Array<"pass" | "fail">) {
    let i = 0;
    const calls = { n: 0 };
    const runner = async () => {
      calls.n++;
      const status = statuses[Math.min(i, statuses.length - 1)]!;
      i++;
      return {
        status,
        label: status === "pass" ? "build + 1 tests" : "1 test failures",
        detail: status === "pass" ? "1 pass" : "1 fail",
      };
    };
    return { runner, calls };
  }

  test("fail-then-pass: a retry that passes settles ci_status='pass'", async () => {
    configMod.config.ciRetries = 1;
    const id = seed({ id: "ci-retry-pass", status: "in_review", worktree: true });
    const { runner, calls } = sequenceRunner(["fail", "pass"]);
    tasksMod.setCiRunner(runner);

    await tasksMod.triggerCi(id);

    expect(calls.n).toBe(2); // initial run + one retry
    expect(row(id).ci_status).toBe("pass");
  });

  test("fail-twice: an exhausted retry settles ci_status='fail'", async () => {
    configMod.config.ciRetries = 1;
    const id = seed({ id: "ci-retry-fail", status: "in_review", worktree: true });
    const { runner, calls } = sequenceRunner(["fail", "fail"]);
    tasksMod.setCiRunner(runner);

    await tasksMod.triggerCi(id);

    expect(calls.n).toBe(2); // initial run + one retry, then give up
    expect(row(id).ci_status).toBe("fail");
    expect(row(id).ci_summary.split("\n")[0]).toBe("1 test failures");
  });

  test("a first-run PASS never retries", async () => {
    configMod.config.ciRetries = 1;
    const id = seed({ id: "ci-retry-clean", status: "in_review", worktree: true });
    const { runner, calls } = sequenceRunner(["pass"]);
    tasksMod.setCiRunner(runner);

    await tasksMod.triggerCi(id);

    expect(calls.n).toBe(1); // no retry on a green first run
    expect(row(id).ci_status).toBe("pass");
  });

  test("ciRetries=0 disables retries — the first FAIL settles immediately", async () => {
    configMod.config.ciRetries = 0;
    const id = seed({ id: "ci-retry-off", status: "in_review", worktree: true });
    const { runner, calls } = sequenceRunner(["fail", "pass"]);
    tasksMod.setCiRunner(runner);

    await tasksMod.triggerCi(id);

    expect(calls.n).toBe(1); // no retry; first fail is final
    expect(row(id).ci_status).toBe("fail");
  });

  test("ciRetries=2 retries twice — fail,fail,pass settles 'pass'", async () => {
    configMod.config.ciRetries = 2;
    const id = seed({ id: "ci-retry-twice", status: "in_review", worktree: true });
    const { runner, calls } = sequenceRunner(["fail", "fail", "pass"]);
    tasksMod.setCiRunner(runner);

    await tasksMod.triggerCi(id);

    expect(calls.n).toBe(3); // initial + two retries
    expect(row(id).ci_status).toBe("pass");
  });
});

// CHANGELOG-UPDATE GATE: an opt-in gate concern layered ON TOP of the build/test
// command. When the workspace configures a changelog path, a code (non-docs) change
// whose diff didn't touch that file FAILS the CI gate — enforcing that the task owns
// its changelog entry now that butchr no longer writes one. These need REAL git
// worktrees (the gate reads the task's diff via git.diffStat), so they create tasks
// through tasksMod.createTask rather than the bare-row `seed` helper above. The
// build/test runner is faked GREEN so the changelog gate is the only failing signal.
describe("changelog-update gate (config-driven, opt-in)", () => {
  /** Create a real task + worktree, commit the given files (path→content), and move
   * it to in_review so triggerCi runs + writes back. */
  async function seedRealTask(
    id_label: string,
    files: Record<string, string>,
  ): Promise<string> {
    const view = await tasksMod.createTask(DIR_ID, `Work ${id_label}`);
    const id = view.id;
    const wt = join(REPO_ROOT, id);
    const wg = (args: string[]) =>
      execFileSync("git", ["-C", wt, ...args], { stdio: "ignore" });
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(wt, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    wg(["add", "-A"]);
    wg(["commit", "-q", "-m", `work ${id_label}`]);
    dbMod.db.query(`UPDATE tasks SET status='in_review' WHERE id=?`).run(id);
    taskmdMod.updateTaskMdStatus(REPO_ROOT, id, "in_review");
    return id;
  }

  beforeAll(() => {
    // Build/test always green so only the changelog gate can fail.
    tasksMod.setCiRunner(async () => ({ status: "pass", label: "gate passed", detail: "" }));
    wsMod.updateWorkspaceChangelogPath(DIR_ID, "CHANGELOG.md");
  });
  afterAll(() => {
    wsMod.updateWorkspaceChangelogPath(DIR_ID, null); // clear the override
  });

  test("a code change WITHOUT a changelog update FAILS the gate", async () => {
    const id = await seedRealTask("no-changelog", { "src/feature.ts": "export const a = 1;\n" });
    await tasksMod.triggerCi(id);
    const r = row(id);
    expect(r.ci_status).toBe("fail");
    expect(r.ci_summary.split("\n")[0]).toBe("changelog not updated");
  });

  test("a code change WITH a changelog update PASSES the gate", async () => {
    const id = await seedRealTask("with-changelog", {
      "src/feature.ts": "export const b = 2;\n",
      "CHANGELOG.md": "# Changelog\n\n## [Unreleased]\n- did a thing\n",
    });
    await tasksMod.triggerCi(id);
    expect(row(id).ci_status).toBe("pass");
  });

  test("a docs-only change is exempt (passes without a changelog entry)", async () => {
    const id = await seedRealTask("docs-only", { "README.md": "# updated docs\n" });
    await tasksMod.triggerCi(id);
    expect(row(id).ci_status).toBe("pass");
  });

  test("with the gate disabled (path cleared), a code-only change passes", async () => {
    wsMod.updateWorkspaceChangelogPath(DIR_ID, ""); // disable for this workspace
    const id = await seedRealTask("gate-off", { "src/feature.ts": "export const c = 3;\n" });
    await tasksMod.triggerCi(id);
    expect(row(id).ci_status).toBe("pass");
    wsMod.updateWorkspaceChangelogPath(DIR_ID, "CHANGELOG.md"); // restore
  });
});
