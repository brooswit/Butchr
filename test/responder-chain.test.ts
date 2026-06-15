// Tests for the STRUCTURAL responder escalation (responder redesign, story st-def561dd,
// design §4a). There is no longer a per-task tier chain: a STORY MEMBER's feedback is
// TERMINAL at its leader (pendingResponder → 'story', escalate 409s), and a NON-STORY task
// has a SINGLE cto→user boundary — POST /api/tasks/:id/escalate (tasks.escalateTask) sets
// `escalated_to_user`, which resets to 0 on each fresh feedback event.
//
// Pure / in-process: no real claude/herdr/bun is spawned. BUTCHR_HERDR_BIN points at
// `true` so herdr probes are no-ops. Workspace / story / task rows are inserted directly
// (no registerWorkspace, which would need a live herdr). Distinct ids — the db/config
// singletons are shared across test files — and every assertion is scoped to our own rows.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
const DIR = "resp-chain-dir";
const STORY = "resp-chain-story";

let tasksMod: typeof import("../src/tasks.ts");
let dbMod: typeof import("../src/db.ts");

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-respchain-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-respchain-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

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

/** Seed a bare task row with the columns the structural resolution reads. */
function seedTask(
  id: string,
  status: string,
  opts: {
    storyId?: string | null;
    escalated?: number;
    idle?: number;
    paneId?: string | null;
    planPreview?: number;
  } = {},
) {
  dbMod.db
    .query(
      `INSERT INTO tasks (id, workspace_id, status, idle, herdr_pane_id, story_id, escalated_to_user, plan_preview, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      DIR,
      status,
      opts.idle ?? 0,
      opts.paneId ?? null,
      opts.storyId ?? null,
      opts.escalated ?? 0,
      opts.planPreview ?? 0,
      dbMod.nowIso(),
    );
}

const escalatedOf = (id: string) =>
  dbMod.db
    .query<{ escalated_to_user: number }, [string]>(`SELECT escalated_to_user FROM tasks WHERE id=?`)
    .get(id)!.escalated_to_user;

describe("non-story cto→user boundary (escalateTask)", () => {
  test("a non-story awaiting task escalates: sets escalated_to_user and resolves 'user'", () => {
    const id = "rc-nonstory";
    seedTask(id, "needs_info", { storyId: null });
    // Before escalation → the CTO.
    expect(tasksMod.pendingResponder(tasksMod.getTask(id)!)).toBe("cto");

    const view = tasksMod.escalateTask(id);
    expect(view.escalated_to_user).toBe(1);
    expect(view.pending_responder).toBe("user");
    expect(escalatedOf(id)).toBe(1);
  });

  test("re-escalating an already-escalated non-story task 409s (single boundary)", () => {
    const id = "rc-nonstory-twice";
    seedTask(id, "in_review", { storyId: null, escalated: 1 });
    expect(() => tasksMod.escalateTask(id)).toThrow(/already escalated to the user/);
    expect(escalatedOf(id)).toBe(1);
  });

  test("escalate 409s when the task is NOT awaiting feedback", () => {
    const id = "rc-nonstory-nonfeedback";
    seedTask(id, "in_progress", { storyId: null, paneId: "pane-nf" }); // in_progress, not idle
    expect(() => tasksMod.escalateTask(id)).toThrow(/not awaiting feedback/);
    expect(escalatedOf(id)).toBe(0);
  });
});

describe("story members are terminal at the leader (no task escalation)", () => {
  test("a story member resolves 'story' and escalate 409s", () => {
    const id = "rc-member";
    seedTask(id, "needs_info", { storyId: STORY });
    expect(tasksMod.pendingResponder(tasksMod.getTask(id)!)).toBe("story");
    expect(() => tasksMod.escalateTask(id)).toThrow(/terminal at the leader/);
    // Untouched — a story member never carries escalated_to_user.
    expect(escalatedOf(id)).toBe(0);
  });
});

describe("escalated_to_user resets to 0 on a new feedback event", () => {
  test("entering the idle feedback surface clears a prior escalation back to 'cto'", () => {
    // A live NON-STORY build agent that carried escalated_to_user from an earlier cycle.
    const id = "rc-reset";
    seedTask(id, "in_progress", { storyId: null, escalated: 1, idle: 0, paneId: "pane-reset" });
    // Not idle yet → not awaiting feedback → no pending responder.
    expect(tasksMod.pendingResponder(tasksMod.getTask(id)!)).toBeNull();

    // The 0→1 idle flip ENTERS the idle feedback surface — a fresh feedback event — so the
    // escalation resets and the responder drops back to the CTO (not the user).
    tasksMod.setIdle(id, true);
    expect(escalatedOf(id)).toBe(0);
    expect(tasksMod.pendingResponder(tasksMod.getTask(id)!)).toBe("cto");
  });
});
