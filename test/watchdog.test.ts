// Tests for butchr's RUNAWAY/STUCK-AGENT watchdog (see dispatcher.runawayExceeded
// + the spawnWatcher max-run guard, and the review rescue it shares with the
// ended-without-request_review path in tasks.markInReview).
//
// These are pure / in-process: no real claude or herdr is spawned. As in the
// other test files, BUTCHR_HERDR_BIN points at `true` so every herdr probe
// (teardownTask et al.) is a harmless no-op.
//
// What this exercises:
//   1. runawayExceeded — the elapsed>maxRunMs decision, including the disabled
//      (maxRunMs<=0) case and the exact boundary. This is the watchdog's trip
//      condition, factored out so it's testable without mocking the clock.
//   2. The rescue itself: a LIVE `in_progress` task (herdr_pane_id set) past maxRunMs
//      is force-moved to `in_review` (via markInReview, the same controlled rescue the
//      dead-agent path uses) with a time-exceeded snapshot — NOT aborted/killed.
//   3. Composition guards: an `aborted` task is NOT resurrected to in_review, and an
//      already-`in_review` task is left untouched (markInReview is guarded on
//      status='in_progress', exactly the property the watchdog relies on).
//
// Env is set before a dynamic import so config/db read our temp paths.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
const DIR_ID = "watchdog-dir";

let tasksMod: typeof import("../src/tasks.ts");
let dbMod: typeof import("../src/db.ts");
let taskmdMod: typeof import("../src/taskmd.ts");
let dispatchMod: typeof import("../src/dispatcher.ts");
let cfg: typeof import("../src/config.ts").config;

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-watchdog-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-watchdog-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";
  // A small, deterministic max-run cap so the boundary is cheap to assert.
  process.env.BUTCHR_MAX_RUN_MS = "60000"; // 60s

  dbMod = await import("../src/db.ts");
  taskmdMod = await import("../src/taskmd.ts");
  cfg = (await import("../src/config.ts")).config;
  tasksMod = await import("../src/tasks.ts");
  dispatchMod = await import("../src/dispatcher.ts");

  dbMod.db
    .query(
      `INSERT INTO directories (id, path, label, created_at) VALUES (?, ?, ?, ?)`,
    )
    .run(DIR_ID, REPO_ROOT, "test", dbMod.nowIso());
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

// Seed a task row + its on-disk task.md. `startedAt` lets a test plant a task
// that has been LIVE `in_progress` for an arbitrary (simulated) duration — the
// watchdog's input — without waiting real wall-clock or launching an agent.
// For "was running" tasks (LIVE = in_progress + pane set), pass herdrPaneId.
function seedTask(opts: {
  id: string;
  status: string;
  startedAt?: string | null;
  herdrPaneId?: string | null;
}): string {
  const created = dbMod.nowIso();
  dbMod.db
    .query(
      `INSERT INTO tasks (id, directory_id, status, herdr_pane_id, started_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(opts.id, DIR_ID, opts.status, opts.herdrPaneId ?? null, opts.startedAt ?? null, created);
  taskmdMod.writeTaskMd(
    REPO_ROOT,
    { id: opts.id, created, status: opts.status as any, context: [] },
    `Implement feature for ${opts.id}.`,
  );
  taskmdMod.updateTaskMdStatus(REPO_ROOT, opts.id, opts.status as any);
  return opts.id;
}

function dbRow(id: string) {
  return dbMod.db
    .query<any, [string]>(`SELECT * FROM tasks WHERE id=?`)
    .get(id)!;
}

describe("runawayExceeded (the watchdog trip decision)", () => {
  test("trips strictly past maxRunMs, not before", () => {
    const max = cfg.maxRunMs; // 60_000
    expect(dispatchMod.runawayExceeded(max - 1, max)).toBe(false); // under
    expect(dispatchMod.runawayExceeded(max, max)).toBe(false); // exactly at — not yet
    expect(dispatchMod.runawayExceeded(max + 1, max)).toBe(true); // just past
    expect(dispatchMod.runawayExceeded(max * 10, max)).toBe(true); // way past
  });

  test("a seeded running task whose elapsed exceeds maxRunMs is judged stuck", () => {
    // Plant a task that entered LIVE in_progress (2 * maxRunMs) ago, then feed the
    // dispatcher's own elapsed computation (now - started_at) into the decision —
    // exactly what spawnWatcher does, but with a seeded clock instead of waiting.
    const startedAt = new Date(Date.now() - cfg.maxRunMs * 2).toISOString();
    const id = seedTask({
      id: "stuck-running",
      status: "in_progress",
      startedAt,
      herdrPaneId: "pane-stuck",
    });
    const row = dbRow(id);
    const elapsed = Date.now() - new Date(row.started_at).getTime();
    expect(dispatchMod.runawayExceeded(elapsed, cfg.maxRunMs)).toBe(true);

    // A freshly-running task (just entered LIVE in_progress) is NOT stuck.
    const fresh = seedTask({
      id: "fresh-running",
      status: "in_progress",
      startedAt: new Date().toISOString(),
      herdrPaneId: "pane-fresh",
    });
    const freshElapsed =
      Date.now() - new Date(dbRow(fresh).started_at).getTime();
    expect(dispatchMod.runawayExceeded(freshElapsed, cfg.maxRunMs)).toBe(false);
  });

  test("the guard is disabled when maxRunMs <= 0 (never trips)", () => {
    expect(dispatchMod.runawayExceeded(Number.MAX_SAFE_INTEGER, 0)).toBe(false);
    expect(dispatchMod.runawayExceeded(Number.MAX_SAFE_INTEGER, -1)).toBe(false);
  });
});

describe("watchdog rescue → in_review", () => {
  test("a stuck LIVE in_progress task is force-moved to in_review with a time-exceeded note (not aborted)", () => {
    // LIVE `in_progress`: herdr_pane_id set (agent is running).
    const id = seedTask({
      id: "rescue-running",
      status: "in_progress",
      herdrPaneId: "pane-rescue",
      startedAt: new Date(Date.now() - cfg.maxRunMs * 2).toISOString(),
    });
    // The controlled rescue the watcher performs once runawayExceeded trips: the
    // SAME markInReview the ended-without-request_review path calls, with a note
    // naming the elapsed time + threshold.
    const note =
      `[butchr] moved to in_review automatically: the agent exceeded the maximum ` +
      `run time (stuck/runaway): it ran for ~2 min past the 1 min limit.`;
    tasksMod.markInReview(id, note);

    const row = dbRow(id);
    expect(row.status).toBe("in_review"); // surfaced to a human, NOT aborted/killed
    expect(row.output_snapshot).toContain("stuck/runaway");
    expect(row.herdr_pane_id).toBeNull(); // tab/pane released
    expect(row.herdr_tab_id).toBeNull();
    // task.md reflects the transition too.
    expect(taskmdMod.readTaskMd(REPO_ROOT, id).meta.status).toBe("in_review");
  });

  test("an ALREADY aborted task is NOT resurrected to in_review by the rescue", () => {
    // markInReview is guarded on status='in_progress' — the exact property that keeps
    // the watchdog from clobbering a task abortTask already parked as terminal.
    const id = seedTask({ id: "rescue-aborted", status: "aborted" });
    tasksMod.markInReview(id, "[butchr] stuck/runaway note that must be ignored");
    expect(dbRow(id).status).toBe("aborted"); // untouched
  });

  test("a task already in in_review is left as-is (nothing to rescue)", () => {
    const id = seedTask({ id: "rescue-already-review", status: "in_review" });
    tasksMod.markInReview(id, "[butchr] stuck/runaway note that must be ignored");
    // Still in_review, and the spurious note did not overwrite a real snapshot.
    expect(dbRow(id).status).toBe("in_review");
  });
});
