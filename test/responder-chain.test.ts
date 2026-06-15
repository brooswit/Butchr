// Tests for the RESPONDER ESCALATION CHAIN (Phase 2 of the STORIES epic). A STORY-MEMBER
// task's pending feedback resolves up the FIXED chain ['story','cto','user'] keyed by the
// new tasks.responder_tier column; POST /api/tasks/:id/escalate (tasks.escalateTask) bumps
// it one rung; the tier RESETS to 0 on each new feedback event. NON-member tasks are
// unchanged — they still resolve via the workspace step_responders config.
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
let dirsMod: typeof import("../src/workspaces.ts");
let dbMod: typeof import("../src/db.ts");

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-respchain-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-respchain-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  dbMod = await import("../src/db.ts");
  dirsMod = await import("../src/workspaces.ts");
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

/** Seed a bare task row with the columns the escalation chain reads. */
function seedTask(
  id: string,
  status: string,
  opts: {
    storyId?: string | null;
    tier?: number;
    idle?: number;
    paneId?: string | null;
    planPreview?: number;
  } = {},
) {
  dbMod.db
    .query(
      `INSERT INTO tasks (id, workspace_id, status, idle, herdr_pane_id, story_id, responder_tier, plan_preview, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      DIR,
      status,
      opts.idle ?? 0,
      opts.paneId ?? null,
      opts.storyId ?? null,
      opts.tier ?? 0,
      opts.planPreview ?? 0,
      dbMod.nowIso(),
    );
}

const tierOf = (id: string) =>
  dbMod.db
    .query<{ responder_tier: number }, [string]>(`SELECT responder_tier FROM tasks WHERE id=?`)
    .get(id)!.responder_tier;

describe("story-member escalation chain", () => {
  test("a member task in needs_info resolves 'story' at tier 0, then escalates story→cto→user", () => {
    const id = "rc-member";
    seedTask(id, "needs_info", { storyId: STORY });

    // Tier 0 → the story leader.
    expect(tasksMod.pendingResponder(tasksMod.getTask(id)!)).toBe("story");

    // escalate → cto (tier 1)
    let view = tasksMod.escalateTask(id);
    expect(view.responder_tier).toBe(1);
    expect(view.pending_responder).toBe("cto");
    expect(tierOf(id)).toBe(1);

    // escalate → user (tier 2)
    view = tasksMod.escalateTask(id);
    expect(view.responder_tier).toBe(2);
    expect(view.pending_responder).toBe("user");
    expect(tierOf(id)).toBe(2);

    // escalate again → 409 (already at the last rung) and the tier is unchanged.
    expect(() => tasksMod.escalateTask(id)).toThrow(/already at the last escalation rung/);
    expect(tierOf(id)).toBe(2);
  });

  test("the chain ignores the workspace step_responders config (fixed for story members)", () => {
    // Even with the answer-question step configured to `user`, a member at tier 0 is `story`.
    dirsMod.updateWorkspaceStepResponders(DIR, { "answer-question": "user" });
    const id = "rc-member-fixed";
    seedTask(id, "needs_info", { storyId: STORY });
    expect(tasksMod.pendingResponder(tasksMod.getTask(id)!)).toBe("story");
    // Reset the config so it doesn't leak into the non-member test below.
    dirsMod.updateWorkspaceStepResponders(DIR, { "answer-question": "cto" });
  });

  test("escalate 409s when the task is NOT in a feedback state", () => {
    const id = "rc-member-nonfeedback";
    seedTask(id, "in_progress", { storyId: STORY, paneId: "pane-x" });
    expect(() => tasksMod.escalateTask(id)).toThrow(/not awaiting feedback/);
  });
});

describe("non-member tasks are unchanged (resolve via workspace config)", () => {
  test("a non-member needs_info task resolves via the workspace step config, not the chain", () => {
    const id = "rc-nonmember";
    // story_id NULL → ordinary task. responder_tier is ignored even if non-zero.
    seedTask(id, "needs_info", { storyId: null, tier: 2 });

    // Default config → answer-question is `cto`.
    expect(tasksMod.pendingResponder(tasksMod.getTask(id)!)).toBe("cto");

    // Flipping the step config to `user` governs it (proving config still drives non-members).
    dirsMod.updateWorkspaceStepResponders(DIR, { "answer-question": "user" });
    expect(tasksMod.pendingResponder(tasksMod.getTask(id)!)).toBe("user");
    dirsMod.updateWorkspaceStepResponders(DIR, { "answer-question": "cto" });
  });

  test("escalate 409s on a non-member task (only members have the chain)", () => {
    const id = "rc-nonmember-escalate";
    seedTask(id, "needs_info", { storyId: null });
    expect(() => tasksMod.escalateTask(id)).toThrow(/not a story member/);
  });
});

describe("responder_tier resets to 0 on a new feedback event", () => {
  test("entering the idle-handling feedback surface resets an escalated member back to 'story'", () => {
    // A live story-member build agent, already escalated to the top rung.
    const id = "rc-reset";
    seedTask(id, "in_progress", { storyId: STORY, tier: 2, idle: 0, paneId: "pane-reset" });
    // Not idle yet → not a feedback surface → no pending responder.
    expect(tasksMod.pendingResponder(tasksMod.getTask(id)!)).toBeNull();

    // The 0→1 idle flip ENTERS the idle-handling feedback surface — a new feedback event —
    // so the escalation resets back to rung 0 (the story leader).
    tasksMod.setIdle(id, true);
    expect(tierOf(id)).toBe(0);
    expect(tasksMod.pendingResponder(tasksMod.getTask(id)!)).toBe("story");
  });
});
