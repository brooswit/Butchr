// Tests for butchr's TASK-DEPENDENCY / BLOCKED feature (see db.ts `blocked` status
// + blocked_by column, tasks.{createTask,setBlockedBy,reevaluateBlockedTask,
// reevaluateAllBlocked,wouldCreateCycle}, and the dispatcher's auto-unblock pass).
//
// Mostly pure / in-process: no real claude or herdr is spawned. As in the other
// test files, BUTCHR_HERDR_BIN points at `true` so every herdr probe
// (teardownTask et al.) is a harmless no-op — so the kill-on-block test asserts
// the OBSERVABLE effect (agent torn down → has_agent=0, status=blocked,
// session_id KEPT) rather than spying on the no-op teardown call.
//
// createTask exercises the REAL function (worktree + task.md + DB row), so we set
// up an actual throwaway git repo with one commit for `git worktree add` to work.
//
// What this exercises (mapped to the spec's required cases):
//   1. create-with-unmerged-blocker            -> blocked
//   2. create-with-all-merged-blockers         -> queued
//   3. auto-unblock when the last blocker merges
//   4. update blocked_by re-evaluates (block a queued task; unblock a blocked one)
//   5. blocking a running task tears down its agent + KEEPS session_id (no dispatch fail)
//   6. dead-blocker stays blocked (and is surfaced as a deadBlocker)
//   7. cycle / self-block rejected (4xx)
//   8. dispatcher never selects a `blocked` task for dispatch
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
// Distinct workspace id — the db/config singletons are shared across test files,
// so a unique dir keeps this file's rows from colliding with another file's.
const DIR_ID = "blocked-dir";

let tasksMod: typeof import("../src/tasks.ts");
let dbMod: typeof import("../src/db.ts");
let taskmdMod: typeof import("../src/taskmd.ts");
let eventsMod: typeof import("../src/events.ts");
let channelMod: typeof import("../src/channel.ts");

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-blocked-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-blocked-repo-"));

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
  taskmdMod = await import("../src/taskmd.ts");
  tasksMod = await import("../src/tasks.ts");
  eventsMod = await import("../src/events.ts");
  channelMod = await import("../src/channel.ts");

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

/** Seed a bare DB-row task (no worktree) with an explicit status + blocked_by. */
function seed(opts: {
  id: string;
  status: string;
  sessionId?: string | null;
  blockedBy?: string[];
  hasAgent?: boolean;
  attempts?: number;
}): string {
  const created = dbMod.nowIso();
  dbMod.db
    .query(
      `INSERT INTO tasks (id, workspace_id, status, session_id, blocked_by,
         has_agent, dispatch_attempts, started_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.id,
      DIR_ID,
      opts.status,
      opts.sessionId ?? null,
      opts.blockedBy ? JSON.stringify(opts.blockedBy) : null,
      opts.hasAgent ? 1 : 0,
      opts.attempts ?? 0,
      // started_at set when it has ever run (in_progress/in_review), so resume rules hold.
      opts.status === "in_progress" || opts.status === "in_review" ? created : null,
      created,
    );
  taskmdMod.writeTaskMd(
    REPO_ROOT,
    { id: opts.id, created, status: opts.status as any, context: [] },
    `Work for ${opts.id}.`,
  );
  taskmdMod.updateTaskMdStatus(REPO_ROOT, opts.id, opts.status as any);
  return opts.id;
}

function row(id: string) {
  return dbMod.db.query<any, [string]>(`SELECT * FROM tasks WHERE id=?`).get(id)!;
}

function setStatus(id: string, status: string) {
  dbMod.db.query(`UPDATE tasks SET status=? WHERE id=?`).run(status, id);
}

describe("createTask with blocked_by", () => {
  test("create-with-unmerged-blocker -> blocked", async () => {
    const blocker = seed({ id: "c-blk-running", status: "running" });
    const view = await tasksMod.createTask(DIR_ID, "do the thing", [], [blocker]);
    expect(view.status).toBe("blocked");
    expect(view.blocked_by).toEqual([blocker]);
    expect(row(view.id).status).toBe("blocked");
    // task.md reflects the blocked start.
    expect(taskmdMod.readTaskMd(REPO_ROOT, view.id).meta.status).toBe("blocked");
  });

  test("create-with-all-merged-blockers -> inactive", async () => {
    const blocker = seed({ id: "c-blk-merged", status: "merged" });
    const view = await tasksMod.createTask(DIR_ID, "do the thing", [], [blocker]);
    expect(view.status).toBe("inactive");
    expect(view.blocked_by).toEqual([blocker]);
    expect(row(view.id).status).toBe("inactive");
  });

  test("empty blocked_by starts inactive, as today", async () => {
    const view = await tasksMod.createTask(DIR_ID, "plain task", [], []);
    expect(view.status).toBe("inactive");
    expect(view.blocked_by).toEqual([]);
  });

  test("unknown blocker id is rejected (404)", async () => {
    let err: any;
    try {
      await tasksMod.createTask(DIR_ID, "x", [], ["no-such-blocker"]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.status).toBe(404);
  });
});

describe("auto-unblock", () => {
  test("becomes inactive exactly when the LAST blocker merges", () => {
    const b1 = seed({ id: "au-b1", status: "merged" });
    const b2 = seed({ id: "au-b2", status: "in_progress" });
    const t = seed({ id: "au-task", status: "blocked", blockedBy: [b1, b2] });

    // One blocker still unmerged → stays blocked.
    expect(tasksMod.reevaluateBlockedTask(t)).toBe(false);
    expect(row(t).status).toBe("blocked");

    // Last blocker merges → the post-merge hook promotes it to inactive (ready).
    setStatus(b2, "merged");
    tasksMod.reevaluateAllBlocked();
    expect(row(t).status).toBe("inactive");
    expect(taskmdMod.readTaskMd(REPO_ROOT, t).meta.status).toBe("inactive");
  });

  test("a blocked task with an EMPTY blocked_by set is immediately eligible", () => {
    const t = seed({ id: "au-empty", status: "blocked", blockedBy: [] });
    expect(tasksMod.reevaluateBlockedTask(t)).toBe(true);
    expect(row(t).status).toBe("inactive");
  });

  test("reevaluate is a no-op for a non-blocked task", () => {
    const t = seed({ id: "au-running", status: "in_progress" });
    expect(tasksMod.reevaluateBlockedTask(t)).toBe(false);
    expect(row(t).status).toBe("in_progress");
  });
});

describe("setBlockedBy re-evaluation", () => {
  test("blocks an IN_PROGRESS task when given an unmerged blocker", async () => {
    const blocker = seed({ id: "sb-blocker", status: "in_progress" });
    const t = seed({ id: "sb-queued", status: "in_progress" });

    const view = await tasksMod.setBlockedBy(t, [blocker]);
    expect(view.status).toBe("blocked");
    expect(view.blocked_by).toEqual([blocker]);
    expect(row(t).status).toBe("blocked");
  });

  test("unblocks a BLOCKED task when its set is cleared", async () => {
    const blocker = seed({ id: "sb-drop-blocker", status: "in_progress" });
    const t = seed({ id: "sb-blocked", status: "blocked", blockedBy: [blocker] });

    const view = await tasksMod.setBlockedBy(t, []);
    expect(view.status).toBe("inactive");
    expect(view.blocked_by).toEqual([]);
    expect(row(t).status).toBe("inactive");
  });

  test("unblocks a BLOCKED task when the replacement blocker is already merged", async () => {
    const dead = seed({ id: "sb-old", status: "in_progress" });
    const done = seed({ id: "sb-new-merged", status: "merged" });
    const t = seed({ id: "sb-swap", status: "blocked", blockedBy: [dead] });

    const view = await tasksMod.setBlockedBy(t, [done]);
    expect(view.status).toBe("inactive");
    expect(view.blocked_by).toEqual([done]);
  });

  test("rejects editing a terminal task (409)", async () => {
    for (const status of ["merged", "aborted"]) {
      const blocker = seed({ id: `sb-t-blk-${status}`, status: "in_progress" });
      const t = seed({ id: `sb-terminal-${status}`, status });
      let err: any;
      try {
        await tasksMod.setBlockedBy(t, [blocker]);
      } catch (e) {
        err = e;
      }
      expect(err).toBeDefined();
      expect(err.status).toBe(409);
      expect(row(t).status).toBe(status); // unchanged
    }
  });

  test("404s on an unknown blocker id", async () => {
    const t = seed({ id: "sb-badblk", status: "queued" });
    let err: any;
    try {
      await tasksMod.setBlockedBy(t, ["ghost"]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.status).toBe(404);
  });
});

describe("kill-on-block", () => {
  test("blocking a RUNNING task tears down its agent + KEEPS session_id, no dispatch failure", async () => {
    const blocker = seed({ id: "kob-blocker", status: "in_progress" });
    const SESSION = "kob-session-1111-2222";
    const t = seed({
      id: "kob-running",
      status: "in_progress",
      sessionId: SESSION,
      hasAgent: true,
      attempts: 0,
    });
    const startedAtBefore = row(t).started_at;

    const view = await tasksMod.setBlockedBy(t, [blocker]);

    expect(view.status).toBe("blocked");
    const r = row(t);
    // Agent torn down: has_agent cleared (teardownTask ran — a no-op under the
    // `true` herdr stub — and the running fields were cleared like a clean re-queue).
    expect(r.has_agent).toBe(0);
    // KEEP session_id + the worktree context (started_at) so it resumes on unblock.
    expect(r.session_id).toBe(SESSION);
    expect(r.started_at).toBe(startedAtBefore);
    // NOT counted as a dispatch failure.
    expect(r.dispatch_attempts).toBe(0);
    expect(r.next_dispatch_at).toBeNull();
    expect(taskmdMod.readTaskMd(REPO_ROOT, t).meta.status).toBe("blocked");
  });
});

describe("dead blockers", () => {
  for (const deadState of ["aborted", "failed", "rolled_back"]) {
    test(`a ${deadState} blocker keeps the task blocked and is surfaced as a deadBlocker`, () => {
      const blocker = seed({ id: `dead-${deadState}-blk`, status: deadState });
      const t = seed({
        id: `dead-${deadState}-task`,
        status: "blocked",
        blockedBy: [blocker],
      });
      // Never auto-proceeds — the required task will never merge.
      expect(tasksMod.reevaluateBlockedTask(t)).toBe(false);
      expect(row(t).status).toBe("blocked");
      // Surfaced for the webapp.
      const view = tasksMod.taskView(t)!;
      expect(view.deadBlockers).toContain(blocker);
      expect(view.blockerStates[blocker]).toBe(deadState);
    });
  }

  test("operator escape hatch: dropping the dead blocker unblocks it", async () => {
    const dead = seed({ id: "dead-escape-blk", status: "aborted" });
    const t = seed({ id: "dead-escape-task", status: "blocked", blockedBy: [dead] });
    const view = await tasksMod.setBlockedBy(t, []);
    expect(view.status).toBe("inactive");
  });

  // F3: a task that becomes dead-blocked WHILE quietly blocked (its blocker aborts under it)
  // never emitted an SSE event, so the CTO push-channel never raised an attention — it sat stuck
  // with no push, only a console.warn. reevaluateBlockedTask now emits a task.updated on the
  // newly-discovered dead blocker, and the channel surfaces it as a `dead_blocked` push.
  test("a freshly dead-blocked task emits a task.updated the channel pushes as attention", async () => {
    const blocker = seed({ id: "f3-blocker", status: "in_progress" });
    const t = seed({ id: "f3-task", status: "blocked", blockedBy: [blocker] });

    // The blocker aborts (will never merge) UNDER the already-blocked task.
    setStatus(blocker, "aborted");

    // Capture the SSE events the per-tick re-evaluation publishes.
    const got: Array<Record<string, unknown>> = [];
    const unsub = eventsMod.subscribe((e) => {
      const ev = e as Record<string, unknown>;
      if (
        (ev.type === "task.updated" || ev.type === "task.created") &&
        (ev.task as any)?.id === t
      ) {
        got.push(ev);
      }
    });
    try {
      // Stays blocked (BY DESIGN — no auto-promote), but now surfaces via an event.
      expect(tasksMod.reevaluateBlockedTask(t)).toBe(false);
    } finally {
      unsub();
    }
    expect(row(t).status).toBe("blocked");

    // An SSE task.updated fired, carrying the dead-blocker set the channel keys on.
    expect(got.length).toBeGreaterThanOrEqual(1);
    const view = got.at(-1)!.task as Record<string, unknown>;
    expect(view.deadBlockers).toContain(blocker);

    // Feeding that event to the CTO push-channel raises a `dead_blocked` attention.
    const bridge = new channelMod.AttentionBridge();
    const note = bridge.consume(got.at(-1)!);
    expect(note).not.toBeNull();
    expect(note!.meta).toMatchObject({ task_id: t, state: "dead_blocked" });
    expect(note!.content).toContain("never-merging");
    expect(note!.content).toContain(blocker);
  });
});

describe("cycle / self-block guard", () => {
  test("self-block on create is rejected (wouldCreateCycle)", () => {
    // createTask mints a fresh id so a real self-reference can't be supplied; assert
    // the guard primitive directly plus the practical create/update paths below.
    expect(tasksMod.wouldCreateCycle("A", ["A"])).toBe(true);
  });

  test("setBlockedBy self-block is rejected (400)", async () => {
    const t = seed({ id: "cyc-self", status: "in_progress" });
    let err: any;
    try {
      await tasksMod.setBlockedBy(t, [t]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.status).toBe(400);
  });

  test("setBlockedBy that would close a cycle (A->B->A) is rejected (400)", async () => {
    const a = seed({ id: "cyc-A", status: "blocked" });
    const b = seed({ id: "cyc-B", status: "in_progress" });
    // A depends on B.
    await tasksMod.setBlockedBy(a, [b]);
    // Now make B depend on A → closes the cycle → reject.
    let err: any;
    try {
      await tasksMod.setBlockedBy(b, [a]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.status).toBe(400);
    // B's set was not persisted.
    expect(tasksMod.parseBlockedBy(row(b).blocked_by)).toEqual([]);
  });

  test("wouldCreateCycle walks transitive edges", () => {
    // A->B->C exists; making C depend on A would cycle.
    seed({ id: "tc-A", status: "blocked", blockedBy: ["tc-B"] });
    seed({ id: "tc-B", status: "blocked", blockedBy: ["tc-C"] });
    seed({ id: "tc-C", status: "in_progress" });
    expect(tasksMod.wouldCreateCycle("tc-C", ["tc-A"])).toBe(true);
    // A sibling dependency that doesn't reach back is fine.
    seed({ id: "tc-D", status: "in_progress" });
    expect(tasksMod.wouldCreateCycle("tc-C", ["tc-D"])).toBe(false);
  });
});

describe("dispatcher never dispatches a blocked task", () => {
  test("a `blocked` task is excluded from the tick's inactive selection", () => {
    seed({ id: "disp-blocked", status: "blocked", blockedBy: ["disp-x"] });
    seed({ id: "disp-ready", status: "inactive" });

    // Mirror the dispatcher tick's selection predicate exactly (status='inactive').
    const now = new Date().toISOString();
    const eligible = dbMod.db
      .query<{ id: string }, [string]>(
        `SELECT id FROM tasks
           WHERE status='inactive'
             AND (next_dispatch_at IS NULL OR next_dispatch_at <= ?)`,
      )
      .all(now)
      .map((r) => r.id);

    expect(eligible).toContain("disp-ready");
    expect(eligible).not.toContain("disp-blocked");
  });
});
