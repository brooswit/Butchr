// Tests for butchr's SPEC-CONFORMANCE GATE (see db.ts conformance_status/
// conformance_summary columns and conformance.{triggerConformance,setConformanceRunner}
// fired from tasks.markReview / markReviewFromAgent).
//
// Pure / in-process: no real claude or herdr is spawned (BUTCHR_HERDR_BIN points at
// `true`) and — crucially — NO real headless `claude` reviewer is spawned:
// setConformanceRunner injects a fake runner, so these tests exercise the persistence
// + trigger wiring without ever shelling out. The fake runner emulates a reviewer
// judging completeness from the task's signals, so a CONFORMING change settles 'pass'
// and a STUB/INCOMPLETE change settles 'concern'.
//
// What this exercises (mapped to the spec):
//   1. triggerConformance persistence — a conforming verdict → conformance_status
//      'pass'; a partial/off-spec verdict → 'concern' with the reviewer's reason; a
//      null verdict (reviewer couldn't decide) → conformance_status NULL.
//   2. the review TRANSITION trigger — a genuine running→review transition fires the
//      gate (conformance_status flips to 'checking' then settles); guards skip a task
//      with no worktree and don't write back onto a task that left review mid-run.
//   3. the pure helpers — buildReviewPrompt + parseConformanceVerdict.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
// Distinct workspace id — the db/config singletons are shared across test files, so a
// unique dir keeps this file's rows from colliding with another file's.
const DIR_ID = "conformance-gate-dir";

let tasksMod: typeof import("../src/tasks.ts");
let confMod: typeof import("../src/conformance.ts");
let dbMod: typeof import("../src/db.ts");
let taskmdMod: typeof import("../src/taskmd.ts");

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-conf-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-conf-repo-"));

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
  tasksMod = await import("../src/tasks.ts");
  confMod = await import("../src/conformance.ts");

  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(DIR_ID, REPO_ROOT, "test", dbMod.nowIso());
});

afterAll(() => {
  // Restore the default CI runner so the never-resolving fake injected here (to hold a CI
  // gate 'in flight') can't leak into a later test file — finalizeMerge now DRAINS in-flight
  // CI before merging, and an inherited never-settling runner would hang that drain.
  tasksMod.setCiRunner();
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

/**
 * Seed a DB-row task + its on-disk task.md (with `prompt`). `worktree:true` also
 * creates the task's worktree directory so triggerConformance's existsSync gate passes
 * (the fake runner never touches it; only the gate does).
 */
function seed(opts: {
  id: string;
  status: string;
  prompt?: string;
  summary?: string;
  worktree?: boolean;
}): string {
  const created = dbMod.nowIso();
  dbMod.db
    .query(
      `INSERT INTO tasks (id, workspace_id, status, summary, started_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.id,
      DIR_ID,
      opts.status,
      opts.summary ?? null,
      opts.status === "in_progress" || opts.status === "in_review" ? created : null,
      created,
    );
  taskmdMod.writeTaskMd(
    REPO_ROOT,
    { id: opts.id, created, status: opts.status as any, context: [] },
    opts.prompt ?? `Work for ${opts.id}.`,
  );
  taskmdMod.updateTaskMdStatus(REPO_ROOT, opts.id, opts.status as any);
  if (opts.worktree ?? true) mkdirSync(join(REPO_ROOT, opts.id), { recursive: true });
  return opts.id;
}

function row(id: string) {
  return dbMod.db.query<any, [string]>(`SELECT * FROM tasks WHERE id=?`).get(id)!;
}

function setStatus(id: string, status: string) {
  dbMod.db.query(`UPDATE tasks SET status=? WHERE id=?`).run(status, id);
}

// A fake reviewer that mimics judging completeness: a prompt/summary signalling a
// stub/incomplete change → 'partial' (concern); otherwise → 'yes' (pass).
function judgingRunner(calls?: string[]): import("../src/conformance.ts").ConformanceRunner {
  return async (input) => {
    calls?.push(input.taskId);
    const blob = `${input.prompt} ${input.summary}`.toLowerCase();
    if (blob.includes("stub") || blob.includes("todo") || blob.includes("not implemented")) {
      return {
        conforms: "partial",
        reason: "the request handler is a stub — validation and persistence are missing",
      };
    }
    return { conforms: "yes", reason: "" };
  };
}

describe("triggerConformance persistence", () => {
  test("a CONFORMING change settles conformance_status='pass'", async () => {
    const id = seed({
      id: "conf-pass",
      status: "in_review",
      prompt: "Add a /health endpoint returning 200 OK with the version.",
      summary: "Implemented the /health endpoint fully with the version field.",
    });
    confMod.setConformanceRunner(judgingRunner());

    await confMod.triggerConformance(id);

    const r = row(id);
    expect(r.conformance_status).toBe("pass");
    expect(r.conformance_summary).toBe("conforms");
  });

  test("a STUB/INCOMPLETE change settles conformance_status='concern' with the reason", async () => {
    const id = seed({
      id: "conf-concern",
      status: "in_review",
      prompt: "Implement login with input validation and session persistence.",
      summary: "Added a login handler stub; validation still TODO.",
    });
    confMod.setConformanceRunner(judgingRunner());

    await confMod.triggerConformance(id);

    const r = row(id);
    expect(r.conformance_status).toBe("concern");
    expect(r.conformance_summary).toContain("stub");
  });

  test("a null verdict (reviewer couldn't decide) leaves conformance_status NULL", async () => {
    const id = seed({ id: "conf-null", status: "in_review" });
    confMod.setConformanceRunner(async () => null);

    await confMod.triggerConformance(id); // must not throw

    expect(row(id).conformance_status).toBeNull();
  });

  test("a runner THROW is swallowed → conformance_status NULL (best-effort)", async () => {
    const id = seed({ id: "conf-throw", status: "in_review" });
    confMod.setConformanceRunner(async () => {
      throw new Error("claude blew up");
    });

    await confMod.triggerConformance(id); // must not throw

    expect(row(id).conformance_status).toBeNull();
  });

  test("skips entirely (conformance_status stays NULL) when the task has no worktree", async () => {
    const id = seed({ id: "conf-noworktree", status: "in_review", worktree: false });
    let called = 0;
    confMod.setConformanceRunner(async () => {
      called++;
      return { conforms: "yes", reason: "" };
    });

    await confMod.triggerConformance(id);

    expect(called).toBe(0);
    expect(row(id).conformance_status).toBeNull();
  });

  test("does NOT write a verdict onto a task that left review while the review ran", async () => {
    const id = seed({ id: "conf-raced", status: "in_review" });
    let resolveRun: (r: any) => void;
    let runnerStarted: () => void;
    const started = new Promise<void>((res) => { runnerStarted = res; });
    confMod.setConformanceRunner(
      () => new Promise((res) => { resolveRun = res; runnerStarted(); }),
    );

    const p = confMod.triggerConformance(id);
    // Synchronous prefix already flipped conformance_status to 'checking'.
    expect(row(id).conformance_status).toBe("checking");

    // Wait until the (async) gather is done and the runner is actually in flight.
    await started;
    // Task merges out from under the in-flight review.
    setStatus(id, "merged");
    resolveRun!({ conforms: "yes", reason: "" });
    await p;

    // The guarded write (status='review') was a no-op — no stale verdict applied.
    expect(row(id).conformance_status).toBe("checking");
  });
});

describe("review-transition trigger", () => {
  test("markReviewFromAgent (in_progress→in_review) kicks off the conformance gate", async () => {
    const id = seed({ id: "conf-trig-agent", status: "in_progress" });
    confMod.setConformanceRunner(() => new Promise(() => {})); // never resolves
    // The CI gate also fires on this transition — stub it so it doesn't spawn real bun.
    tasksMod.setCiRunner(() => new Promise(() => {}));

    expect(await tasksMod.markReviewFromAgent(id)).toBe("ok");
    expect(row(id).status).toBe("in_review");
    // The fire-and-forget gate's synchronous prefix already claimed the task → 'checking'.
    expect(row(id).conformance_status).toBe("checking");
  });

  test("a duplicate request_review (review→review) does NOT re-run the gate", async () => {
    // Seed already in review with NO conformance verdict; a duplicate request_review
    // must not kick the gate off (it would flip conformance_status to 'checking').
    const id = seed({ id: "conf-trig-dup", status: "in_review" });
    confMod.setConformanceRunner(() => new Promise(() => {}));
    tasksMod.setCiRunner(() => new Promise(() => {}));

    expect(await tasksMod.markReviewFromAgent(id, "again")).toBe("ok");
    expect(row(id).conformance_status).toBeNull(); // no re-trigger on a non-transition
  });
});

describe("pure helpers", () => {
  test("parseConformanceVerdict pulls the last JSON verdict out of prose", () => {
    const out = [
      "Let me check the diff against the prompt…",
      "The endpoint is present and returns the version.",
      '{"conforms": "yes", "reason": ""}',
    ].join("\n");
    expect(confMod.parseConformanceVerdict(out)).toEqual({ conforms: "yes", reason: "" });
  });

  test("parseConformanceVerdict normalizes case and trims the reason", () => {
    const out = 'verdict: {"conforms":"PARTIAL","reason":"  missing the retry path  "}';
    expect(confMod.parseConformanceVerdict(out)).toEqual({
      conforms: "partial",
      reason: "missing the retry path",
    });
  });

  test("parseConformanceVerdict returns null on no/invalid verdict", () => {
    expect(confMod.parseConformanceVerdict("no json here")).toBeNull();
    expect(confMod.parseConformanceVerdict('{"conforms":"maybe"}')).toBeNull();
    expect(confMod.parseConformanceVerdict("")).toBeNull();
  });

  test("buildReviewPrompt includes the prompt, summary, diff, and the JSON instruction", () => {
    const p = confMod.buildReviewPrompt({
      taskId: "t",
      cwd: "/tmp/t",
      prompt: "Add a widget",
      diff: "+++ widget.ts",
      summary: "added the widget",
    });
    expect(p).toContain("Add a widget");
    expect(p).toContain("added the widget");
    expect(p).toContain("+++ widget.ts");
    expect(p).toContain('"conforms"');
  });
});
