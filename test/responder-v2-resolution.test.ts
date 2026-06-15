// Tests for the RESPONDER-REDESIGN V2 task resolution (story st-def561dd, spine subtask 2;
// design §3 / §4 / §4a). With the BUTCHR_RESPONDER_V2 gate FORCED ON, pendingResponder
// resolves STRUCTURALLY (story member → 'story' always, non-story → 'cto'/'user' by the
// escalated_to_user boolean), and escalateTask is the single cto→user boundary for a
// NON-story task. These are INERT by default — the gate-off V1 behavior is pinned by
// responder-chain.test.ts / pending-responder.test.ts, which must keep passing.
//
// CRITICAL: every test restores BUTCHR_RESPONDER_V2 in afterEach (which bun runs even when
// an assertion throws), so the gate can NEVER leak into the V1 test files that share this
// process's db/config singletons.
//
// Pure / in-process: no real claude/herdr/bun is spawned (BUTCHR_HERDR_BIN → `true`).
// Workspace / story / task rows are inserted directly; escalateTask reads the row via
// getTask, so tasks are seeded into the db (not synthetic casts). Distinct ids, scoped
// assertions.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
const DIR = "resp-v2-dir";
const STORY = "resp-v2-story";

let tasksMod: typeof import("../src/tasks.ts");
let dbMod: typeof import("../src/db.ts");

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-respv2-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-respv2-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";
  // The gate is forced ON per-test (in the body), not here — so an import-time read by any
  // other module can't observe it, and afterEach can always restore the prior value.

  dbMod = await import("../src/db.ts");
  tasksMod = await import("../src/tasks.ts");

  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(DIR, join(REPO_ROOT, DIR), DIR, dbMod.nowIso());
  dbMod.db
    .query(`INSERT INTO stories (id, workspace_id, brief, status, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(STORY, DIR, "test story", "open", dbMod.nowIso());
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

// Restore the gate after EVERY test — runs even on assertion failure, so V2 never leaks
// into the V1 test files that share this process.
const priorGate = process.env.BUTCHR_RESPONDER_V2;
afterEach(() => {
  if (priorGate === undefined) delete process.env.BUTCHR_RESPONDER_V2;
  else process.env.BUTCHR_RESPONDER_V2 = priorGate;
});
const enableV2 = () => {
  process.env.BUTCHR_RESPONDER_V2 = "1";
};

/** Seed a bare task row with the columns the V2 resolution reads. */
function seedTask(
  id: string,
  status: string,
  opts: {
    storyId?: string | null;
    tier?: number;
    escalated?: number;
    idle?: number;
    paneId?: string | null;
    planPreview?: number;
  } = {},
) {
  dbMod.db
    .query(
      `INSERT INTO tasks (id, workspace_id, status, idle, herdr_pane_id, story_id, responder_tier, escalated_to_user, plan_preview, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      DIR,
      status,
      opts.idle ?? 0,
      opts.paneId ?? null,
      opts.storyId ?? null,
      opts.tier ?? 0,
      opts.escalated ?? 0,
      opts.planPreview ?? 0,
      dbMod.nowIso(),
    );
}

const escalatedOf = (id: string) =>
  dbMod.db
    .query<{ escalated_to_user: number }, [string]>(`SELECT escalated_to_user FROM tasks WHERE id=?`)
    .get(id)!.escalated_to_user;

describe("isAwaitingFeedback predicate (design §3)", () => {
  test("true for every feedback state and for in_progress+idle; false otherwise", () => {
    const mk = (status: string, idle = 0) =>
      ({ status, idle } as unknown as import("../src/db.ts").TaskRow);
    for (const s of ["idea", "spec_review", "in_review", "needs_info"] as const) {
      expect(tasksMod.isAwaitingFeedback(mk(s))).toBe(true);
    }
    // in_progress is only a feedback surface when idle.
    expect(tasksMod.isAwaitingFeedback(mk("in_progress", 0))).toBe(false);
    expect(tasksMod.isAwaitingFeedback(mk("in_progress", 1))).toBe(true);
    for (const s of ["blocked", "inactive", "rolling_back", "rolled_back", "merged", "failed", "aborted"] as const) {
      expect(tasksMod.isAwaitingFeedback(mk(s))).toBe(false);
    }
  });
});

describe("V2 pendingResponder (structural — design §3)", () => {
  test("a story member resolves 'story' ALWAYS, ignoring responder_tier", () => {
    enableV2();
    const id = "v2-member";
    // tier=2 would have meant 'user' under V1; V2 ignores it entirely.
    seedTask(id, "needs_info", { storyId: STORY, tier: 2 });
    expect(tasksMod.pendingResponder(tasksMod.getTask(id)!)).toBe("story");
  });

  test("a non-story task resolves 'cto' when not escalated", () => {
    enableV2();
    const id = "v2-nonstory-cto";
    seedTask(id, "in_review", { storyId: null });
    expect(tasksMod.pendingResponder(tasksMod.getTask(id)!)).toBe("cto");
  });

  test("a non-story task resolves 'user' once escalated_to_user", () => {
    enableV2();
    const id = "v2-nonstory-user";
    seedTask(id, "in_review", { storyId: null, escalated: 1 });
    expect(tasksMod.pendingResponder(tasksMod.getTask(id)!)).toBe("user");
  });

  test("a task not awaiting feedback resolves null (even a story member)", () => {
    enableV2();
    const idA = "v2-null-nonstory";
    const idB = "v2-null-member";
    seedTask(idA, "in_progress", { storyId: null, paneId: "pane-a" }); // not idle
    seedTask(idB, "merged", { storyId: STORY });
    expect(tasksMod.pendingResponder(tasksMod.getTask(idA)!)).toBeNull();
    expect(tasksMod.pendingResponder(tasksMod.getTask(idB)!)).toBeNull();
  });
});

describe("V2 escalateTask (single cto→user boundary — design §4a)", () => {
  test("a non-story awaiting task escalates: sets escalated_to_user and resolves 'user'", () => {
    enableV2();
    const id = "v2-escalate-ok";
    seedTask(id, "in_review", { storyId: null });
    expect(tasksMod.pendingResponder(tasksMod.getTask(id)!)).toBe("cto");

    const view = tasksMod.escalateTask(id);
    expect(view.pending_responder).toBe("user");
    expect(escalatedOf(id)).toBe(1);
  });

  test("re-escalating an already-escalated non-story task 409s", () => {
    enableV2();
    const id = "v2-escalate-twice";
    seedTask(id, "in_review", { storyId: null, escalated: 1 });
    expect(() => tasksMod.escalateTask(id)).toThrow(/already escalated to the user/);
    expect(escalatedOf(id)).toBe(1);
  });

  test("escalating a STORY MEMBER 409s — its feedback is terminal at the leader", () => {
    enableV2();
    const id = "v2-escalate-member";
    seedTask(id, "needs_info", { storyId: STORY });
    expect(() => tasksMod.escalateTask(id)).toThrow(/terminal at the leader/);
    expect(escalatedOf(id)).toBe(0);
  });

  test("escalating a task NOT awaiting feedback 409s", () => {
    enableV2();
    const id = "v2-escalate-nonfeedback";
    seedTask(id, "in_progress", { storyId: null, paneId: "pane-nf" }); // in_progress, not idle
    expect(() => tasksMod.escalateTask(id)).toThrow(/not awaiting feedback/);
    expect(escalatedOf(id)).toBe(0);
  });
});

describe("V2 escalated_to_user resets on a fresh feedback entry (design §4a)", () => {
  test("entering the idle-handling surface clears a prior escalation back to 'cto'", () => {
    enableV2();
    // A live non-story build agent that carried escalated_to_user from an earlier cycle.
    const id = "v2-reset-idle";
    seedTask(id, "in_progress", { storyId: null, escalated: 1, idle: 0, paneId: "pane-reset" });
    // Not idle yet → not awaiting feedback → no pending responder.
    expect(tasksMod.pendingResponder(tasksMod.getTask(id)!)).toBeNull();

    // The 0→1 idle flip ENTERS the idle-handling feedback surface — a fresh feedback event —
    // so the escalation resets, and the responder drops back to the CTO (not the user).
    tasksMod.setIdle(id, true);
    expect(escalatedOf(id)).toBe(0);
    expect(tasksMod.pendingResponder(tasksMod.getTask(id)!)).toBe("cto");
  });
});
