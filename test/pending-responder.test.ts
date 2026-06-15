// Tests for the STRUCTURAL feedback-routing primitives (responder redesign, story
// st-def561dd, design §3): tasks.isAwaitingFeedback (is a task on a feedback surface?) and
// tasks.pendingResponder (WHO is awaited — `story` | `cto` | `user` | `null`). Both resolve
// PURELY from the row's status / idle / story_id / escalated_to_user — there is no
// per-workspace step-responder config anymore (it was removed in this redesign).
//
// Pure / in-process: these two functions read only those row fields, so synthetic partial
// rows (cast through the row type) exercise them without a db / herdr. We still set the DB
// env + import the module (its db.ts side-imports run migrations on import).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;

let tasksMod: typeof import("../src/tasks.ts");

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-pr-data-"));
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";
  tasksMod = await import("../src/tasks.ts");
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

// Build a synthetic row carrying only the fields the structural resolution reads.
function row(
  status: string,
  opts: { idle?: number; storyId?: string | null; escalated?: number } = {},
) {
  return {
    status: status as import("../src/db.ts").TaskStatus,
    idle: opts.idle ?? 0,
    story_id: opts.storyId ?? null,
    escalated_to_user: opts.escalated ?? 0,
  } as import("../src/db.ts").TaskRow;
}

describe("isAwaitingFeedback (design §3)", () => {
  test("true for every feedback state", () => {
    for (const s of ["idea", "spec_review", "in_review", "needs_info"] as const) {
      expect(tasksMod.isAwaitingFeedback(row(s))).toBe(true);
    }
  });

  test("in_progress is a feedback surface ONLY when idle", () => {
    expect(tasksMod.isAwaitingFeedback(row("in_progress", { idle: 0 }))).toBe(false);
    expect(tasksMod.isAwaitingFeedback(row("in_progress", { idle: 1 }))).toBe(true);
  });

  test("non-feedback states are false", () => {
    for (const s of ["blocked", "inactive", "rolling_back", "rolled_back", "merged", "failed", "aborted"] as const) {
      expect(tasksMod.isAwaitingFeedback(row(s))).toBe(false);
    }
  });
});

describe("pendingResponder (structural — story | cto | user | null)", () => {
  test("a task NOT awaiting feedback resolves null", () => {
    expect(tasksMod.pendingResponder(row("in_progress", { idle: 0 }))).toBeNull();
    expect(tasksMod.pendingResponder(row("merged"))).toBeNull();
    expect(tasksMod.pendingResponder(row("blocked"))).toBeNull();
    // null even for a story member that is not on a feedback surface.
    expect(tasksMod.pendingResponder(row("merged", { storyId: "st-x" }))).toBeNull();
  });

  test("a STORY MEMBER resolves 'story' ALWAYS (terminal at the leader)", () => {
    for (const s of ["idea", "spec_review", "in_review", "needs_info"] as const) {
      expect(tasksMod.pendingResponder(row(s, { storyId: "st-x" }))).toBe("story");
    }
    // An idle story-member build agent is also the leader's.
    expect(tasksMod.pendingResponder(row("in_progress", { idle: 1, storyId: "st-x" }))).toBe("story");
    // escalated_to_user is IGNORED for a story member — never reaches the user.
    expect(tasksMod.pendingResponder(row("in_review", { storyId: "st-x", escalated: 1 }))).toBe("story");
  });

  test("a NON-STORY task resolves 'cto' when not escalated, 'user' once escalated", () => {
    expect(tasksMod.pendingResponder(row("in_review", { storyId: null }))).toBe("cto");
    expect(tasksMod.pendingResponder(row("needs_info", { storyId: null }))).toBe("cto");
    expect(tasksMod.pendingResponder(row("in_review", { storyId: null, escalated: 1 }))).toBe("user");
    // The idle surface follows the same non-story resolution.
    expect(tasksMod.pendingResponder(row("in_progress", { idle: 1, storyId: null }))).toBe("cto");
    expect(tasksMod.pendingResponder(row("in_progress", { idle: 1, storyId: null, escalated: 1 }))).toBe("user");
  });

  test("the needs_info plan-vs-question split does NOT change the responder", () => {
    // Who responds is structural; the plan-preview discriminator only affects the surface
    // copy/emphasis, not pending_responder.
    expect(tasksMod.pendingResponder(row("needs_info", { storyId: null }))).toBe("cto");
    expect(tasksMod.pendingResponder(row("needs_info", { storyId: "st-x" }))).toBe("story");
  });
});
