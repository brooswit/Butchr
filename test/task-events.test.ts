// Tests for the PER-TASK AUDIT TIMELINE (see db.ts task_events table +
// recordTaskEvent/listTaskEvents, and the recordTaskEvent calls threaded through
// the status-setting functions in tasks.ts).
//
// In-process only: no real claude or herdr is spawned. BUTCHR_HERDR_BIN points at
// `true` so every herdr probe (teardownTask et al.) is a harmless no-op, and we
// inject a fake CI runner so the review transition never spawns a real `bun build`.
//
// createTask exercises the REAL function (worktree + task.md + DB row), so we set
// up an actual throwaway git repo with one commit for `git worktree add` to work.
//
// What this exercises: every recorded status transition lands one ordered
// task_events row with the right (from_status -> to_status) and a note — across the
// create -> run -> in_review -> reject(resume) -> abort lifecycle — and that a
// non-transition (a duplicate request_review) records NO extra event.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
// Distinct workspace id — the db/config singletons are shared across test files,
// so a unique dir keeps this file's rows from colliding with another file's.
const DIR_ID = "events-dir";

let tasksMod: typeof import("../src/tasks.ts");
let dbMod: typeof import("../src/db.ts");

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-events-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-events-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  // A real git repo with one commit so createTask's `git worktree add -b` works.
  const g = (args: string[]) =>
    execFileSync("git", ["-C", REPO_ROOT, ...args], { stdio: "ignore" });
  execFileSync("git", ["init", "-q", REPO_ROOT], { stdio: "ignore" });
  g(["config", "user.email", "test@butchr.local"]);
  g(["config", "user.name", "butchr test"]);
  g(["commit", "--allow-empty", "-q", "-m", "init"]);

  dbMod = await import("../src/db.ts");
  tasksMod = await import("../src/tasks.ts");

  // Don't spawn a real `bun build`/`bun test` on the review transition.
  tasksMod.setCiRunner(async () => ({ status: "pass", label: "fake", detail: "" }));

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

/** Shorthand: the (from -> to) transition pairs for a task, oldest -> newest. */
function transitions(id: string): [string | null, string][] {
  return dbMod.listTaskEvents(id).map((e) => [e.from_status, e.to_status]);
}

describe("task_events audit timeline", () => {
  test("createTask records the creation event (null -> in_progress) with a note", async () => {
    const view = await tasksMod.createTask(DIR_ID, "do a thing", [], []);
    const events = dbMod.listTaskEvents(view.id);
    expect(events.length).toBe(1);
    expect(events[0]!.from_status).toBeNull();
    expect(events[0]!.to_status).toBe("in_progress");
    expect(events[0]!.note).toBe("task created");
    expect(events[0]!.task_id).toBe(view.id);
    expect(typeof events[0]!.at).toBe("string");
  });

  test("a blocked create records null -> blocked", async () => {
    const blocker = await tasksMod.createTask(DIR_ID, "blocker", [], []);
    const view = await tasksMod.createTask(DIR_ID, "blocked one", [], [blocker.id]);
    expect(transitions(view.id)).toEqual([[null, "blocked"]]);
  });

  test("the full lifecycle records one ordered event per transition", async () => {
    const view = await tasksMod.createTask(DIR_ID, "lifecycle task", [], []);
    const id = view.id;

    // in_progress -> in_progress (pane set, status unchanged — markRunning records pane only)
    tasksMod.markRunning(id, "pane-1", "sess-lifecycle-1", "tab-1");
    expect(tasksMod.getTask(id)!.status).toBe("in_progress");

    // in_progress -> in_review (agent requested review)
    expect(tasksMod.markReviewFromAgent(id, "all done")).toBe("ok");
    expect(tasksMod.getTask(id)!.status).toBe("in_review");

    // A DUPLICATE request_review (in_review -> in_review) is NOT a transition: no event.
    expect(tasksMod.markReviewFromAgent(id, "still done")).toBe("ok");

    // in_review -> in_progress (reviewer requested changes; re-queued for resume)
    await tasksMod.rejectTask(id, "please tweak the thing");
    expect(tasksMod.getTask(id)!.status).toBe("in_progress");

    // in_progress -> aborted
    await tasksMod.abortTask(id);
    expect(tasksMod.getTask(id)!.status).toBe("aborted");

    expect(transitions(id)).toEqual([
      [null, "in_progress"],
      ["in_progress", "in_progress"], // agent launched (markRunning first-launch marker)
      ["in_progress", "in_review"],
      ["in_review", "in_progress"],
      ["in_progress", "aborted"],
    ]);

    // Every event carries a non-empty explanatory note.
    for (const e of dbMod.listTaskEvents(id)) {
      expect(e.note && e.note.length > 0).toBe(true);
    }
  });

  test("setBlockedBy and unblock record blocked<->in_progress transitions", async () => {
    const blocker = await tasksMod.createTask(DIR_ID, "dep", [], []);
    const t = await tasksMod.createTask(DIR_ID, "movable", [], []); // starts in_progress

    // in_progress -> blocked (operator added an unmerged dependency)
    await tasksMod.setBlockedBy(t.id, [blocker.id]);
    expect(tasksMod.getTask(t.id)!.status).toBe("blocked");

    // blocked -> in_progress (dependency set cleared by the operator)
    await tasksMod.setBlockedBy(t.id, []);
    expect(tasksMod.getTask(t.id)!.status).toBe("in_progress");

    expect(transitions(t.id)).toEqual([
      [null, "in_progress"],
      ["in_progress", "blocked"],
      ["blocked", "in_progress"],
    ]);
  });

  test("auto-unblock (reevaluate) records blocked -> in_progress when blockers merge", async () => {
    const blocker = await tasksMod.createTask(DIR_ID, "to-merge", [], []);
    const t = await tasksMod.createTask(DIR_ID, "waiter", [], [blocker.id]);
    expect(tasksMod.getTask(t.id)!.status).toBe("blocked");

    // Mark the blocker merged and re-evaluate — the waiter promotes to in_progress.
    dbMod.db.query(`UPDATE tasks SET status='merged' WHERE id=?`).run(blocker.id);
    tasksMod.reevaluateAllBlocked();
    expect(tasksMod.getTask(t.id)!.status).toBe("in_progress");

    expect(transitions(t.id)).toEqual([
      [null, "blocked"],
      ["blocked", "in_progress"],
    ]);
  });
});
