// Tests for the CTO ergonomics / workflow refinements:
//   1. PER-TASK FILE ALLOWLIST gate — a declared `allowlist` fails the CI gate when the
//      diff strays outside it; an empty allowlist is inert; the value round-trips through
//      createTask → DB → taskView and task.md front matter.
//   2. AGENT-LIVENESS verdict (livenessView) — working / stalled / dead from the stored
//      signals (idle flag + /proc liveness via an injected cmdline lister).
//   3. STRUCTURED plan approve/reject — approvePlan / rejectPlan resume a plan-preview
//      needs_info task with the right decision, and 409 outside the plan-approval step.
//
// In-process: a real git repo (so createTask's worktree + git.diffStat work), a faked CI
// runner (setCiRunner — no real bun), and BUTCHR_HERDR_BIN=true so herdr probes/teardown
// are no-ops. Patterned on test/auto-merge.test.ts.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
const DIR_ID = "cto-ergo-dir";

let dbMod: typeof import("../src/db.ts");
let tasksMod: typeof import("../src/tasks.ts");
let taskmdMod: typeof import("../src/taskmd.ts");
let livenessMod: typeof import("../src/liveness.ts");

function g(args: string[], cwd = REPO_ROOT): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-ergo-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-ergo-repo-"));

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
  livenessMod = await import("../src/liveness.ts");

  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(DIR_ID, REPO_ROOT, "test", dbMod.nowIso());
});

afterEach(() => {
  tasksMod.setCiRunner((async () => ({ status: "pass", label: "noop", detail: "" })) as any);
  livenessMod.setCmdlineLister(null);
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

function dbRow(id: string) {
  return dbMod.db.query<any, [string]>(`SELECT * FROM tasks WHERE id=?`).get(id)!;
}

/** Create a real task with the given allowlist, write+commit `files` in its worktree, and
 * move it to in_review — the state triggerCi runs against. */
async function seedReviewTask(allowlist: string[], files: Record<string, string>): Promise<string> {
  const view = await tasksMod.createTask(
    DIR_ID, "Allowlist work", [], [], "task", null, [], 0, false, false, "patch", allowlist,
  );
  const id = view.id;
  const wt = join(REPO_ROOT, id);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(wt, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  g(["add", "-A"], wt);
  g(["commit", "-q", "-m", "task work"], wt);
  dbMod.db.query(`UPDATE tasks SET status='in_review' WHERE id=?`).run(id);
  taskmdMod.updateTaskMdStatus(REPO_ROOT, id, "in_review");
  return id;
}

describe("per-task allowlist gate", () => {
  test("createTask persists + surfaces the allowlist as an array (and round-trips in task.md)", async () => {
    const view = await tasksMod.createTask(
      DIR_ID, "x", [], [], "task", null, [], 0, false, false, "patch", ["src/foo.ts", "test/"],
    );
    expect(view.allowlist).toEqual(["src/foo.ts", "test/"]);
    // task.md front matter round-trips it.
    const md = readFileSync(join(REPO_ROOT, ".butchr", "tasks", view.id, "task.md"), "utf8");
    expect(md).toContain("allowlist:");
    expect(md).toContain("- src/foo.ts");
    const parsed = taskmdMod.parseTaskMd(md);
    expect(parsed.meta.allowlist).toEqual(["src/foo.ts", "test/"]);
  });

  test("a diff that strays OUTSIDE the allowlist FAILS the gate (even with a green build)", async () => {
    tasksMod.setCiRunner((async () => ({ status: "pass", label: "build + 1", detail: "" })) as any);
    const id = await seedReviewTask(["src/"], { "src/ok.ts": "a\n", "public/stray.html": "b\n" });
    await tasksMod.triggerCi(id);
    const r = dbRow(id);
    expect(r.ci_status).toBe("fail");
    expect(r.ci_summary).toContain("outside allowlist");
    expect(r.ci_summary).toContain("public/stray.html");
    expect(r.ci_summary).not.toContain("src/ok.ts"); // the allowed file isn't flagged
  });

  test("a diff fully WITHIN the allowlist passes the gate", async () => {
    tasksMod.setCiRunner((async () => ({ status: "pass", label: "build + 1", detail: "" })) as any);
    const id = await seedReviewTask(["src/", "*.md"], { "src/ok.ts": "a\n", "NOTES.md": "c\n" });
    await tasksMod.triggerCi(id);
    expect(dbRow(id).ci_status).toBe("pass");
  });

  test("an EMPTY allowlist is inert — every file passes", async () => {
    tasksMod.setCiRunner((async () => ({ status: "pass", label: "build + 1", detail: "" })) as any);
    const id = await seedReviewTask([], { "anywhere/whatever.ts": "a\n" });
    await tasksMod.triggerCi(id);
    expect(dbRow(id).ci_status).toBe("pass");
  });

  test("a RED build is still red — the allowlist gate never runs on a failed build", async () => {
    tasksMod.setCiRunner((async () => ({ status: "fail", label: "build failed", detail: "boom" })) as any);
    const id = await seedReviewTask(["src/"], { "public/stray.html": "b\n" });
    await tasksMod.triggerCi(id);
    const r = dbRow(id);
    expect(r.ci_status).toBe("fail");
    expect(r.ci_summary).toContain("build failed"); // not the allowlist label
  });
});

describe("agent-liveness verdict (livenessView)", () => {
  const rowOf = (over: Record<string, unknown>) =>
    ({ status: "in_progress", idle: 0, session_id: "sess-uuid", ...over }) as any;

  test("null unless the task is a live in_progress agent", () => {
    expect(tasksMod.livenessView(rowOf({ status: "in_review" }))).toBeNull();
    expect(tasksMod.livenessView(rowOf({ status: "merged" }))).toBeNull();
  });

  test("a non-idle in_progress agent is WORKING without probing /proc", () => {
    let scanned = 0;
    livenessMod.setCmdlineLister(() => { scanned++; return []; });
    const v = tasksMod.livenessView(rowOf({ idle: 0 }));
    expect(v?.state).toBe("working");
    expect(scanned).toBe(0); // recent output proves alive — no /proc scan
  });

  test("an idle agent with a live process is STALLED", () => {
    livenessMod.setCmdlineLister(() => [["claude", "--session-id", "sess-uuid"]]);
    expect(tasksMod.livenessView(rowOf({ idle: 1 }))?.state).toBe("stalled");
  });

  test("an idle agent with NO live process is DEAD", () => {
    livenessMod.setCmdlineLister(() => [["bash", "-lc", "something-else"]]);
    expect(tasksMod.livenessView(rowOf({ idle: 1 }))?.state).toBe("dead");
  });
});

describe("structured plan approve/reject", () => {
  /** Create a plan-preview task and park it in needs_info holding a proposed plan. */
  async function seedPlanTask(): Promise<string> {
    const view = await tasksMod.createTask(
      DIR_ID, "Plan work", [], [], "task", null, [], 0, true /* planPreview */,
    );
    dbMod.db
      .query(`UPDATE tasks SET status='needs_info', question=? WHERE id=?`)
      .run("Here is my plan: do X then Y.", view.id);
    return view.id;
  }

  test("approvePlan resumes the agent to implement (needs_info → inactive, answer set)", async () => {
    const id = await seedPlanTask();
    const v = await tasksMod.approvePlan(id);
    expect(v.status).toBe("inactive");
    const r = dbRow(id);
    expect(r.question).toBeNull();
    expect(r.answer).toContain("APPROVED");
    expect(r.answer).toContain("IMPLEMENT");
  });

  test("approvePlan folds in optional steering notes", async () => {
    const id = await seedPlanTask();
    await tasksMod.approvePlan(id, "also add a test");
    expect(dbRow(id).answer).toContain("also add a test");
  });

  test("rejectPlan sends the plan back for revision with required feedback", async () => {
    const id = await seedPlanTask();
    const v = await tasksMod.rejectPlan(id, "the plan misses the migration step");
    expect(v.status).toBe("inactive");
    const r = dbRow(id);
    expect(r.answer).toContain("NOT approved");
    expect(r.answer).toContain("propose_plan");
    expect(r.answer).toContain("migration step");
  });

  test("rejectPlan requires a note", async () => {
    const id = await seedPlanTask();
    await expect(tasksMod.rejectPlan(id, "  ")).rejects.toThrow(/note is required/);
  });

  test("the plan endpoints 409 outside the plan-approval step", async () => {
    // A non-plan-preview needs_info task (a raised question) → use /answer, not /plan/*.
    const view = await tasksMod.createTask(DIR_ID, "Q work");
    dbMod.db.query(`UPDATE tasks SET status='needs_info', question=? WHERE id=?`).run("a question", view.id);
    await expect(tasksMod.approvePlan(view.id)).rejects.toThrow(/not awaiting plan approval/);
    await expect(tasksMod.rejectPlan(view.id, "n")).rejects.toThrow(/not awaiting plan approval/);
  });
});
