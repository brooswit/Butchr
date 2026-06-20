// Regression test for the RESURRECTION RACE in the feedback-resume path (F1).
//
// resumeWithAnswer (src/tasks.ts) is the SINGLE chokepoint all three feedback-resume
// entrypoints funnel through — answerTask (via respondToFeedback) and the structured
// approvePlan / rejectPlan. Each validates the row is in `needs_info` ONCE at the top,
// then `await herdr.teardownTask(id)` BEFORE re-arming the task to `inactive`.
//
// THE RACE: while that teardown await is in flight, a CONCURRENT abortTask flips the row
// to the terminal `aborted` status. Without a guard, resumeWithAnswer's setStatus uses a
// WHERE-id-only clause and would force the aborted task back to `inactive` — a re-dispatched
// zombie whose worktree was already discarded. The fix adds `from:"needs_info"` to that
// setStatus so the re-arm becomes a NO-OP once the row has left needs_info.
//
// We reproduce the race DETERMINISTICALLY without mocks: teardownTask's first line spawns
// the herdr binary (BUTCHR_HERDR_BIN=true → the `true` subprocess), so the resume genuinely
// SUSPENDS at that await. We invoke the resume WITHOUT awaiting it (it runs synchronously
// past the top-of-function needs_info validation, then suspends at teardownTask), land the
// concurrent abort with a synchronous UPDATE (mirroring abortTask's setStatus("aborted")),
// then await the resume. The guarded re-arm then sees `aborted` and must no-op.
//
// Covers BOTH entrypoints so a future refactor that splits the shared helper can't silently
// regress one path: (a) the answer path (answerTask) and (b) the plan path (approvePlan AND
// rejectPlan, needs_info + plan_preview). A positive control proves the guard does NOT break
// the normal resume.
//
// Env is set before a dynamic import so config/db read our temp paths.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
const DIR_ID = "test-dir-resume-abort";

let tasksMod: typeof import("../src/tasks.ts");
let dbMod: typeof import("../src/db.ts");
let taskmdMod: typeof import("../src/taskmd.ts");

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  // Point the herdr binary at `true`: every probe resolves to "not found", so teardownTask
  // is a no-op — but still a genuine subprocess spawn, so the resume suspends at its await.
  process.env.BUTCHR_HERDR_BIN = "true";

  dbMod = await import("../src/db.ts");
  taskmdMod = await import("../src/taskmd.ts");
  tasksMod = await import("../src/tasks.ts");

  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(DIR_ID, REPO_ROOT, "test", dbMod.nowIso());
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

/** Seed a needs_info task (its DB row + on-disk task.md), optionally a plan-preview one. */
function seedNeedsInfo(opts: { id: string; planPreview?: boolean; question?: string }): string {
  const created = dbMod.nowIso();
  dbMod.db
    .query(
      `INSERT INTO tasks (id, workspace_id, status, session_id, has_agent, plan_preview, question, started_at, created_at)
       VALUES (?, ?, 'needs_info', ?, 0, ?, ?, ?, ?)`,
    )
    .run(
      opts.id,
      DIR_ID,
      `sess-${opts.id}`,
      opts.planPreview ? 1 : 0,
      opts.question ?? "a pending question",
      created,
      created,
    );
  taskmdMod.writeTaskMd(
    REPO_ROOT,
    { id: opts.id, created, status: "needs_info" as any, context: [] },
    `Implement feature for ${opts.id}.`,
  );
  taskmdMod.updateTaskMdStatus(REPO_ROOT, opts.id, "needs_info" as any);
  return opts.id;
}

function dbRow(id: string) {
  return dbMod.db.query<any, [string]>(`SELECT * FROM tasks WHERE id=?`).get(id)!;
}

/**
 * Drive `invoke()` (a feedback-resume call) and land a CONCURRENT abort while it is
 * suspended inside resumeWithAnswer's `await herdr.teardownTask`. Calling `invoke()` runs
 * synchronously past the top-of-function needs_info validation and suspends at teardownTask
 * (a real subprocess spawn), returning control here; the synchronous UPDATE then mirrors
 * abortTask's terminal setStatus("aborted") winning the race before the guarded re-arm runs.
 */
async function abortDuringResume(id: string, invoke: () => Promise<unknown>): Promise<void> {
  const pending = invoke();
  dbMod.db
    .query(`UPDATE tasks SET status='aborted', completed_at=? WHERE id=?`)
    .run(dbMod.nowIso(), id);
  await pending;
}

describe("resumeWithAnswer resurrection-race guard (from:needs_info)", () => {
  test("answer path: a concurrently-aborted task is NOT resurrected to inactive", async () => {
    const id = seedNeedsInfo({ id: "race-answer" });
    await abortDuringResume(id, () => tasksMod.answerTask(id, "Per-user cache."));

    const row = dbRow(id);
    // The guarded re-arm no-ops: the task stays TERMINAL, never flipped back to a
    // dispatchable `inactive`, so the dispatcher can never pick it up as a zombie.
    expect(row.status).toBe("aborted");
    // Proof the whole re-arm `set` block was skipped (no answer/clear applied).
    expect(row.answer).toBeNull();
    expect(row.question).not.toBeNull();
  });

  test("plan path (approve): a concurrently-aborted plan-preview task is NOT resurrected", async () => {
    const id = seedNeedsInfo({ id: "race-approve", planPreview: true });
    await abortDuringResume(id, () => tasksMod.approvePlan(id));

    const row = dbRow(id);
    expect(row.status).toBe("aborted");
    expect(row.answer).toBeNull();
  });

  test("plan path (reject): a concurrently-aborted plan-preview task is NOT resurrected", async () => {
    const id = seedNeedsInfo({ id: "race-reject", planPreview: true });
    await abortDuringResume(id, () => tasksMod.rejectPlan(id, "Revise the caching approach."));

    const row = dbRow(id);
    expect(row.status).toBe("aborted");
    expect(row.answer).toBeNull();
  });

  test("positive control: WITHOUT a concurrent abort, the resume still re-arms to inactive", async () => {
    const id = seedNeedsInfo({ id: "no-race-answer" });
    const view = await tasksMod.answerTask(id, "SQLite.");

    // The guard must not break the happy path: a genuine needs_info answer still re-arms.
    expect(view.status).toBe("inactive");
    const row = dbRow(id);
    expect(row.status).toBe("inactive");
    expect(row.answer).toBe("SQLite.");
    expect(row.question).toBeNull();
  });
});
