// Tests for the INERT needs_user_input SPINE (story st-2fe571a0): an orthogonal FLAG on a
// LIVE in_progress build agent hung at a human-only OS/CLI dialog — the EXACT `idle` pattern,
// but routing the task's feedback STRAIGHT to the user (pendingResponder → 'user', regardless
// of parent_id) so it stays off every agent push-feed. NOTHING sets the flag in production yet
// (detection lands later); these tests drive tasks.setNeedsUserInput DIRECTLY. Covers:
//   - tasks.setNeedsUserInput: flips 0→1 ONLY for a LIVE in_progress + has_agent agent,
//     capturing the run-log tail into needs_user_input_context (thunk invoked ONLY on the
//     flip); clearing (→0) wipes it; an empty capture stores NULL; a no-op off the live phase.
//   - tasks.isAwaitingFeedback / pendingResponder: a LIVE in_progress + needs_user_input task
//     is a feedback surface whose responder is 'user' EVEN for a story member (parent_id set),
//     overriding the parent-chain bubble-up.
//   - tasks.attentionReason: needs-user-input WINS over idle-handling when both flags are set
//     (the more specific, human-only signal).
//   - tasks.attentionList: a needs_user_input agent appears in the operator pull feed with
//     reason 'needs-user-input' and detail = the captured context.
//   - reset: a setStatus transition out of the live build phase clears the flag + context.
//
// In-process: no real claude or herdr (BUTCHR_HERDR_BIN→true). An isolated BUTCHR_DB so the
// dev-runs-migrate-live-db hazard is avoided.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
const DIR_ID = "needs-user-input-dir";

let dbMod: typeof import("../src/db.ts");
let tasksMod: typeof import("../src/tasks.ts");

function rowOf(id: string) {
  return tasksMod.getTask(id)!;
}

// A LIVE launched build agent: in_progress + has_agent=1 (the precondition setNeedsUserInput
// guards on, the honest ownership marker markRunning sets). Optional parent_id makes it a
// story member (its feedback would normally bubble to the parent node).
function seedLive(id: string, parentId: string | null = null): void {
  dbMod.db
    .query(
      `INSERT INTO tasks (id, workspace_id, status, has_agent, parent_id, created_at)
       VALUES (?, ?, 'in_progress', 1, ?, ?)`,
    )
    .run(id, DIR_ID, parentId, dbMod.nowIso());
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-needs-user-input-data-"));
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  dbMod = await import("../src/db.ts");
  tasksMod = await import("../src/tasks.ts");

  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(DIR_ID, DATA_DIR, "test", dbMod.nowIso());
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("tasks.setNeedsUserInput (flag + context in lockstep, like setIdle)", () => {
  test("flipping on captures the context thunk; the thunk runs ONLY on the flip", () => {
    seedLive("nui-ctx-task");
    let calls = 0;
    const capture = () => {
      calls++;
      return "...wedged at the channel-confirm dialog...";
    };
    // 0→1: captures.
    tasksMod.setNeedsUserInput("nui-ctx-task", true, capture);
    expect(rowOf("nui-ctx-task").needs_user_input).toBe(1);
    expect(rowOf("nui-ctx-task").needs_user_input_context).toBe(
      "...wedged at the channel-confirm dialog...",
    );
    expect(calls).toBe(1);
    // Already set (no flip): the thunk is NOT invoked again.
    tasksMod.setNeedsUserInput("nui-ctx-task", true, capture);
    expect(calls).toBe(1);
  });

  test("clearing wipes needs_user_input_context back to NULL", () => {
    seedLive("nui-clear-task");
    tasksMod.setNeedsUserInput("nui-clear-task", true, () => "snapshot");
    expect(rowOf("nui-clear-task").needs_user_input_context).toBe("snapshot");
    tasksMod.setNeedsUserInput("nui-clear-task", false);
    expect(rowOf("nui-clear-task").needs_user_input).toBe(0);
    expect(rowOf("nui-clear-task").needs_user_input_context).toBeNull();
  });

  test("an empty captured context stores NULL, not an empty string", () => {
    seedLive("nui-empty-ctx");
    tasksMod.setNeedsUserInput("nui-empty-ctx", true, () => "");
    expect(rowOf("nui-empty-ctx").needs_user_input).toBe(1);
    expect(rowOf("nui-empty-ctx").needs_user_input_context).toBeNull();
  });

  test("a NO-OP off the live build phase: not in_progress, or no owned agent", () => {
    // No owned agent (has_agent=0): nothing to attach a human-only prompt to.
    dbMod.db
      .query(
        `INSERT INTO tasks (id, workspace_id, status, has_agent, created_at)
         VALUES ('nui-no-agent', ?, 'in_progress', 0, ?)`,
      )
      .run(DIR_ID, dbMod.nowIso());
    tasksMod.setNeedsUserInput("nui-no-agent", true, () => "x");
    expect(rowOf("nui-no-agent").needs_user_input).toBe(0);

    // Not in_progress (inactive): no live agent.
    dbMod.db
      .query(
        `INSERT INTO tasks (id, workspace_id, status, has_agent, created_at)
         VALUES ('nui-inactive-task', ?, 'inactive', 0, ?)`,
      )
      .run(DIR_ID, dbMod.nowIso());
    tasksMod.setNeedsUserInput("nui-inactive-task", true, () => "x");
    expect(rowOf("nui-inactive-task").needs_user_input).toBe(0);
  });
});

describe("needs_user_input as a feedback surface routed STRAIGHT to the user", () => {
  test("a LIVE in_progress + needs_user_input task IS awaiting feedback", () => {
    seedLive("nui-pending-nui");
    tasksMod.setNeedsUserInput("nui-pending-nui", true, () => "ctx");
    expect(tasksMod.isAwaitingFeedback(rowOf("nui-pending-nui"))).toBe(true);
    expect(tasksMod.pendingResponder(rowOf("nui-pending-nui"))).toBe("user");
  });

  test("pendingResponder returns 'user' EVEN for a story member (parent_id set)", () => {
    // The parent NODE (the FK anchor a member's parent_id points at) — an inert `merged`
    // anchor, exactly as the unification migration materializes it.
    dbMod.db
      .query(
        `INSERT INTO tasks (id, workspace_id, status, created_at)
         VALUES ('nui-parent-node', ?, 'merged', ?)`,
      )
      .run(DIR_ID, dbMod.nowIso());
    seedLive("nui-member-nui", "nui-parent-node");

    // WITHOUT the flag, a story member's idle feedback bubbles to its parent node → 'story'.
    tasksMod.setIdle("nui-member-nui", true, () => "idle ctx");
    expect(tasksMod.pendingResponder(rowOf("nui-member-nui"))).toBe("story");

    // WITH the flag, the human-only prompt OVERRIDES the parent-chain → straight to 'user',
    // bypassing even the story leader (broader than escalated_to_user).
    tasksMod.setNeedsUserInput("nui-member-nui", true, () => "human-only ctx");
    expect(tasksMod.pendingResponder(rowOf("nui-member-nui"))).toBe("user");
  });
});

describe("attention surfacing (precedence + operator pull feed)", () => {
  test("attentionReason: needs-user-input WINS over idle-handling when both are set", () => {
    seedLive("nui-both-flags");
    tasksMod.setIdle("nui-both-flags", true, () => "idle ctx");
    tasksMod.setNeedsUserInput("nui-both-flags", true, () => "human-only ctx");
    const row = rowOf("nui-both-flags");
    expect(row.idle).toBe(1);
    expect(row.needs_user_input).toBe(1);
    expect(tasksMod.attentionReason(row, false)).toBe("needs-user-input");
  });

  test("attentionList surfaces a needs_user_input agent with its reason + captured context", () => {
    seedLive("nui-feed-nui");
    tasksMod.setNeedsUserInput("nui-feed-nui", true, () => "approve the dev channel? [y/N]");
    const item = tasksMod.attentionList().find((i) => i.id === "nui-feed-nui");
    expect(item).toBeDefined();
    expect(item!.reason).toBe("needs-user-input");
    expect(item!.detail).toBe("approve the dev channel? [y/N]");
    // It routes to the user — NOT the CTO/leader (which keeps it off every agent push-feed).
    expect(item!.pending_responder).toBe("user");
  });
});

describe("reset clears the flag + context when leaving the live build phase", () => {
  test("markInReview wipes a lingering needs_user_input snapshot", () => {
    seedLive("nui-review-clears-nui");
    tasksMod.setNeedsUserInput("nui-review-clears-nui", true, () => "stale prompt");
    expect(rowOf("nui-review-clears-nui").needs_user_input_context).toBe("stale prompt");
    tasksMod.markInReview("nui-review-clears-nui", "done");
    const row = rowOf("nui-review-clears-nui");
    expect(row.status).toBe("in_review");
    expect(row.needs_user_input).toBe(0);
    expect(row.needs_user_input_context).toBeNull();
  });
});
