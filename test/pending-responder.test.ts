// Tests for the FW-3 feedback-step routing primitives: the pure state→step map
// (tasks.feedbackStep) and the resolved per-step responder for a task's current pending
// step (tasks.pendingResponder), which composes feedbackStep with the per-workspace
// step-responder config (workspaces.responderFor, FW-1). These pin the mapping the CTO
// self-check + the webapp's awaiting-who emphasis route on, including the `needs_info`
// plan-vs-question discriminator (keyed off plan_preview).
//
// Pure / in-process: no real claude/herdr is spawned (BUTCHR_HERDR_BIN → `true`), and
// workspace rows are inserted directly (no registerWorkspace, which needs a live herdr).
// pendingResponder only reads row.status / row.plan_preview / row.workspace_id, so synthetic
// partial rows (cast through the row type) exercise it without creating real tasks.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
const WS_DEFAULT = "pr-ws-default"; // all steps default cto
const WS_MIXED = "pr-ws-mixed"; // diff-review=user, plan-approval=user

let tasksMod: typeof import("../src/tasks.ts");
let dirsMod: typeof import("../src/workspaces.ts");
let dbMod: typeof import("../src/db.ts");

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-pr-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-pr-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  dbMod = await import("../src/db.ts");
  dirsMod = await import("../src/workspaces.ts");
  tasksMod = await import("../src/tasks.ts");

  const ins = (id: string) =>
    dbMod.db
      .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
      .run(id, join(REPO_ROOT, id), id, dbMod.nowIso());
  ins(WS_DEFAULT);
  ins(WS_MIXED);
  dirsMod.updateWorkspaceStepResponders(WS_MIXED, {
    "diff-review": "user",
    "plan-approval": "user",
  });
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

// Build a synthetic row carrying only the three fields pendingResponder reads.
function row(workspaceId: string, status: string, planPreview = false) {
  return {
    workspace_id: workspaceId,
    status: status as import("../src/db.ts").TaskStatus,
    plan_preview: planPreview ? 1 : 0,
  } as import("../src/db.ts").TaskRow;
}

describe("feedbackStep (state→step map)", () => {
  test("each feedback state maps to its canonical step", () => {
    expect(tasksMod.feedbackStep("idea", false)).toBe("spec-generation");
    expect(tasksMod.feedbackStep("spec_review", false)).toBe("spec-approval");
    expect(tasksMod.feedbackStep("in_review", false)).toBe("diff-review");
  });

  test("needs_info discriminates plan-preview (plan) from a raised question", () => {
    // A plan-preview task parked in needs_info is holding a PROPOSED PLAN.
    expect(tasksMod.feedbackStep("needs_info", true)).toBe("plan-approval");
    // Any other needs_info is a raised question.
    expect(tasksMod.feedbackStep("needs_info", false)).toBe("answer-question");
  });

  test("plan_preview only matters in needs_info (not other feedback states)", () => {
    // A plan-preview spec_review/in_review still maps by state, ignoring the flag.
    expect(tasksMod.feedbackStep("spec_review", true)).toBe("spec-approval");
    expect(tasksMod.feedbackStep("in_review", true)).toBe("diff-review");
  });

  test("non-feedback states map to null", () => {
    for (const s of ["blocked", "inactive", "in_progress", "rolling_back", "rolled_back", "merged", "failed", "aborted"] as const) {
      expect(tasksMod.feedbackStep(s, false)).toBeNull();
      expect(tasksMod.feedbackStep(s, true)).toBeNull();
    }
  });

  test("every feedback step it returns is a canonical RESPONDER_STEP", () => {
    for (const s of ["idea", "spec_review", "in_review", "needs_info"] as const) {
      const step = tasksMod.feedbackStep(s, s === "needs_info");
      expect(dirsMod.isResponderStep(step!)).toBe(true);
    }
  });
});

describe("pendingResponder (state→step→responder)", () => {
  test("defaults every feedback step to cto for an all-default workspace", () => {
    expect(tasksMod.pendingResponder(row(WS_DEFAULT, "idea"))).toBe("cto");
    expect(tasksMod.pendingResponder(row(WS_DEFAULT, "spec_review"))).toBe("cto");
    expect(tasksMod.pendingResponder(row(WS_DEFAULT, "in_review"))).toBe("cto");
    expect(tasksMod.pendingResponder(row(WS_DEFAULT, "needs_info", true))).toBe("cto");
    expect(tasksMod.pendingResponder(row(WS_DEFAULT, "needs_info", false))).toBe("cto");
  });

  test("reflects the workspace's per-step overrides", () => {
    // diff-review=user → an in_review task is awaiting the user.
    expect(tasksMod.pendingResponder(row(WS_MIXED, "in_review"))).toBe("user");
    // plan-approval=user → a plan-preview needs_info task is awaiting the user...
    expect(tasksMod.pendingResponder(row(WS_MIXED, "needs_info", true))).toBe("user");
    // ...but a non-plan needs_info uses answer-question (still default cto).
    expect(tasksMod.pendingResponder(row(WS_MIXED, "needs_info", false))).toBe("cto");
    // Untouched steps stay cto.
    expect(tasksMod.pendingResponder(row(WS_MIXED, "spec_review"))).toBe("cto");
    expect(tasksMod.pendingResponder(row(WS_MIXED, "idea"))).toBe("cto");
  });

  test("a non-feedback task has no pending responder (null)", () => {
    expect(tasksMod.pendingResponder(row(WS_MIXED, "in_progress"))).toBeNull();
    expect(tasksMod.pendingResponder(row(WS_DEFAULT, "merged"))).toBeNull();
    expect(tasksMod.pendingResponder(row(WS_MIXED, "blocked", true))).toBeNull();
  });

  test("an unknown workspace falls back to the cto default", () => {
    expect(tasksMod.pendingResponder(row("does-not-exist", "in_review"))).toBe("cto");
    expect(tasksMod.pendingResponder(row("does-not-exist", "needs_info", true))).toBe("cto");
  });
});
