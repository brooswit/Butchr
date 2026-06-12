// Tests for butchr's BOUNDED DISPATCH RETRY state machine (see
// dispatcher.dispatch's catch + tasks.markDispatchFailure / markRunning /
// requeueTask). These are pure / in-process: no real claude or herdr is spawned.
// As in reject-resume.test.ts, BUTCHR_HERDR_BIN points at `true` so every herdr
// probe (teardownTask et al.) is a harmless no-op.
//
// What this exercises:
//   1. markDispatchFailure — increments dispatch_attempts, records the error, and
//      schedules a FUTURE next_dispatch_at backoff while under the cap (status
//      stays `in_progress` with herdr_pane_id NULL), then GIVES UP to `aborted`
//      (clearing next_dispatch_at) at the cap. The dispatcher then stops retrying.
//   2. dispatchBackoffMs — exponential growth capped at the configured cap.
//   3. markRunning — a successful launch RESETS the retry state.
//   4. rejectTask / backToQueued — the reject (rework) and clean re-queue paths do
//      NOT count as dispatch failures: they reset dispatch_attempts + next_dispatch_at.
//   5. requeueTask — the operator escape hatch revives a backoff'd `in_progress`
//      task with a clean retry state. An `aborted` give-up task is TERMINAL and
//      cannot be requeued (409).
//
// Env is set before a dynamic import so config/db read our temp paths. We force a
// small MAX so the give-up boundary is cheap to reach.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
// Unique per-file id: bun caches the db/config singletons across test files, so
// the first-imported file's BUTCHR_DB wins and all files share ONE database. A
// distinct workspace id keeps this file's rows from colliding with another file's.
const DIR_ID = "retry-dir";

let tasksMod: typeof import("../src/tasks.ts");
let dbMod: typeof import("../src/db.ts");
let taskmdMod: typeof import("../src/taskmd.ts");
let cfg: typeof import("../src/config.ts").config;

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-retry-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-retry-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";
  // Small, deterministic retry knobs so the give-up boundary is cheap to hit and
  // the backoff math is easy to assert.
  process.env.BUTCHR_MAX_DISPATCH_ATTEMPTS = "3";
  process.env.BUTCHR_DISPATCH_BACKOFF_BASE_MS = "1000";
  process.env.BUTCHR_DISPATCH_BACKOFF_CAP_MS = "5000";

  dbMod = await import("../src/db.ts");
  taskmdMod = await import("../src/taskmd.ts");
  cfg = (await import("../src/config.ts")).config;
  tasksMod = await import("../src/tasks.ts");

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

function seedTask(opts: {
  id: string;
  status: string;
  sessionId?: string | null;
  attempts?: number;
  nextAt?: string | null;
  herdrPaneId?: string | null;
}): string {
  const created = dbMod.nowIso();
  dbMod.db
    .query(
      `INSERT INTO tasks (id, workspace_id, status, session_id, dispatch_attempts, next_dispatch_at, herdr_pane_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.id,
      DIR_ID,
      opts.status,
      opts.sessionId ?? null,
      opts.attempts ?? 0,
      opts.nextAt ?? null,
      opts.herdrPaneId ?? null,
      created,
    );
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

describe("dispatchBackoffMs", () => {
  test("exponential growth, capped (derived from config so it's import-order safe)", () => {
    const base = cfg.dispatchBackoffBaseMs;
    const cap = cfg.dispatchBackoffCapMs;
    expect(tasksMod.dispatchBackoffMs(1)).toBe(Math.min(base, cap)); // base * 2^0
    expect(tasksMod.dispatchBackoffMs(2)).toBe(Math.min(base * 2, cap)); // base * 2^1
    expect(tasksMod.dispatchBackoffMs(3)).toBe(Math.min(base * 4, cap)); // base * 2^2
    // Eventually reaches the cap and stays there.
    expect(tasksMod.dispatchBackoffMs(50)).toBe(cap);
    // attempts <= 0 don't underflow the exponent (clamped to base).
    expect(tasksMod.dispatchBackoffMs(0)).toBe(Math.min(base, cap));
    // Monotonic non-decreasing.
    expect(tasksMod.dispatchBackoffMs(2)).toBeGreaterThanOrEqual(
      tasksMod.dispatchBackoffMs(1),
    );
  });
});

describe("markDispatchFailure", () => {
  test("under the cap: increments attempts, records error, schedules a FUTURE backoff, stays in_progress", async () => {
    // A READY `in_progress` task (herdr_pane_id NULL) — this is the new dispatchable state.
    const id = seedTask({ id: "fail-backoff", status: "in_progress" });
    const before = Date.now();

    await tasksMod.markDispatchFailure(id, "worktree create failed");

    const row = dbRow(id);
    expect(row.status).toBe("in_progress"); // still retryable (agent-phase, pane cleared)
    expect(row.dispatch_attempts).toBe(1);
    expect(row.last_dispatch_error).toBe("worktree create failed");
    expect(row.next_dispatch_at).toBeTruthy();

    // next_dispatch_at is in the future, ~base (1000ms) ahead of now.
    const nextMs = new Date(row.next_dispatch_at).getTime();
    expect(nextMs).toBeGreaterThan(before);
    expect(nextMs - before).toBeGreaterThanOrEqual(1000);
    expect(nextMs - before).toBeLessThan(1000 + 2000); // base + slack

    // Second failure grows the backoff and the count.
    await tasksMod.markDispatchFailure(id, "herdr pane setup failed");
    const row2 = dbRow(id);
    expect(row2.status).toBe("in_progress");
    expect(row2.dispatch_attempts).toBe(2);
    expect(row2.last_dispatch_error).toBe("herdr pane setup failed");
  });

  test("at the cap: gives up to `aborted`, clears next_dispatch_at, keeps the error", async () => {
    // Seed already at MAX-1 attempts so one more failure tips it over.
    // A READY `in_progress` task (herdr_pane_id NULL) with a past backoff.
    const id = seedTask({
      id: "fail-giveup",
      status: "in_progress",
      attempts: cfg.maxDispatchAttempts - 1,
      nextAt: new Date(Date.now() - 1000).toISOString(),
    });

    await tasksMod.markDispatchFailure(id, "persistent boom");

    const row = dbRow(id);
    expect(row.status).toBe("aborted"); // terminal give-up (no `failed` state in canonical model)
    expect(row.dispatch_attempts).toBe(cfg.maxDispatchAttempts);
    expect(row.last_dispatch_error).toBe("persistent boom");
    expect(row.next_dispatch_at).toBeNull(); // no further retry scheduled

    // task.md reflects the give-up too.
    const md = taskmdMod.readTaskMd(REPO_ROOT, id);
    expect(md.meta.status).toBe("aborted");
  });

  test("an `aborted` give-up task is excluded from the dispatcher's READY selection", () => {
    // The give-up task from above is status='aborted', so the tick query
    // (status IN ('in_progress','finalizing') AND herdr_pane_id IS NULL) will never pick it up.
    const row = dbRow("fail-giveup");
    const ready = dbMod.db
      .query<any, [string]>(
        `SELECT id FROM tasks WHERE status IN ('in_progress','finalizing') AND herdr_pane_id IS NULL AND id=?`,
      )
      .get(row.id);
    expect(ready).toBeNull();
  });
});

describe("tick gating by next_dispatch_at", () => {
  test("an in_progress task in backoff is NOT selected; an elapsed one IS", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();
    seedTask({ id: "gate-future", status: "in_progress", attempts: 1, nextAt: future });
    seedTask({ id: "gate-past", status: "in_progress", attempts: 1, nextAt: past });
    seedTask({ id: "gate-null", status: "in_progress" });

    // Mirror the dispatcher's tick selection predicate exactly.
    const now = new Date().toISOString();
    const eligible = dbMod.db
      .query<{ id: string }, [string]>(
        `SELECT id FROM tasks
           WHERE status IN ('in_progress','finalizing') AND herdr_pane_id IS NULL
           AND (next_dispatch_at IS NULL OR next_dispatch_at <= ?)`,
      )
      .all(now)
      .map((r) => r.id);

    expect(eligible).toContain("gate-past");
    expect(eligible).toContain("gate-null");
    expect(eligible).not.toContain("gate-future");
  });
});

describe("markRunning resets retry state", () => {
  test("a successful launch clears attempts / error / backoff", () => {
    // Seed as a READY `in_progress` task (herdr_pane_id NULL) — markRunning sets the pane.
    const id = seedTask({
      id: "run-reset",
      status: "in_progress",
      attempts: 2,
      nextAt: new Date(Date.now() + 5000).toISOString(),
    });
    // Pre-set an error so we can confirm it's cleared.
    dbMod.db
      .query(`UPDATE tasks SET last_dispatch_error=? WHERE id=?`)
      .run("earlier failure", id);

    tasksMod.markRunning(id, "pane-1", "11111111-2222-3333-4444-555555555555", "tab-1");

    const row = dbRow(id);
    // Status stays `in_progress` — it's now LIVE (pane is set), not "running" in the old sense.
    expect(row.status).toBe("in_progress");
    expect(row.herdr_pane_id).toBe("pane-1"); // pane now set → LIVE agent
    expect(row.dispatch_attempts).toBe(0);
    expect(row.last_dispatch_error).toBeNull();
    expect(row.next_dispatch_at).toBeNull();
  });
});

describe("reject / re-queue do NOT count as dispatch failures", () => {
  test("rejectTask resets dispatch_attempts + next_dispatch_at", async () => {
    // Seed as `in_review` (the new name for `review`).
    const id = seedTask({
      id: "reject-reset",
      status: "in_review",
      sessionId: "sess-reject",
      attempts: 2,
      nextAt: new Date(Date.now() + 5000).toISOString(),
    });
    dbMod.db
      .query(`UPDATE tasks SET last_dispatch_error=? WHERE id=?`)
      .run("stale dispatch error", id);

    await tasksMod.rejectTask(id, "please tweak the naming");

    const row = dbRow(id);
    expect(row.status).toBe("in_progress"); // re-queued for --resume (READY: pane NULL)
    // Critically: NOT incremented — a reject is fresh intent, not a dispatch failure.
    expect(row.dispatch_attempts).toBe(0);
    expect(row.next_dispatch_at).toBeNull();
    expect(row.last_dispatch_error).toBeNull();
    // The resume session id is preserved (unrelated to retry state).
    expect(row.session_id).toBe("sess-reject");
  });

  test("backToQueued (clean re-queue, e.g. reconcile) resets retry state too", async () => {
    // Seed as LIVE `in_progress` (herdr_pane_id set — this was the old `running`).
    const id = seedTask({
      id: "backqueue-reset",
      status: "in_progress",
      herdrPaneId: "pane-stale",
      attempts: 2,
      nextAt: new Date(Date.now() + 5000).toISOString(),
    });
    dbMod.db
      .query(`UPDATE tasks SET last_dispatch_error=? WHERE id=?`)
      .run("stale", id);

    await tasksMod.backToQueued(id);

    const row = dbRow(id);
    expect(row.status).toBe("in_progress"); // READY again (pane cleared)
    expect(row.herdr_pane_id).toBeNull();
    expect(row.dispatch_attempts).toBe(0);
    expect(row.next_dispatch_at).toBeNull();
    expect(row.last_dispatch_error).toBeNull();
  });
});

describe("requeueTask (operator escape hatch)", () => {
  test("revives a backoff'd in_progress task to in_progress with a clean retry state", async () => {
    // Seed an `in_progress` task stuck in backoff (herdr_pane_id NULL, future next_dispatch_at).
    const id = seedTask({
      id: "requeue-backoff",
      status: "in_progress",
      attempts: cfg.maxDispatchAttempts - 1,
      nextAt: new Date(Date.now() + 60_000).toISOString(),
    });
    dbMod.db
      .query(`UPDATE tasks SET last_dispatch_error=? WHERE id=?`)
      .run("gave up earlier", id);

    const view = await tasksMod.requeueTask(id);

    expect(view.status).toBe("in_progress");
    const row = dbRow(id);
    expect(row.status).toBe("in_progress");
    expect(row.dispatch_attempts).toBe(0);
    expect(row.last_dispatch_error).toBeNull();
    expect(row.next_dispatch_at).toBeNull();
    expect(taskmdMod.readTaskMd(REPO_ROOT, id).meta.status).toBe("in_progress");
  });

  test("refuses a terminal (merged/aborted) task with 409", async () => {
    for (const status of ["merged", "aborted"]) {
      const id = seedTask({ id: `requeue-bad-${status}`, status });
      let err: any;
      try {
        await tasksMod.requeueTask(id);
      } catch (e) {
        err = e;
      }
      expect(err).toBeDefined();
      expect(err.status).toBe(409);
      expect(dbRow(id).status).toBe(status);
    }
  });

  test("404s on a nonexistent task", async () => {
    let err: any;
    try {
      await tasksMod.requeueTask("no-such-task");
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.status).toBe(404);
  });
});
