// Tests for the STRUCTURAL feedback-routing primitives (responder redesign, story
// st-def561dd, design §3; rewired for the unified Work model in story st-540ba705 step 6a):
// tasks.isAwaitingFeedback (is a task on a feedback surface?) and tasks.pendingResponder
// (WHO is awaited — `story` | `cto` | `user` | `null`).
//
// isAwaitingFeedback is a PURE read of status/idle, so synthetic partial rows still exercise
// it. pendingResponder now DELEGATES the live routing (config.unifiedWork, DEFAULT ON) to the
// recursive parent-chain responder (work.resolveWorkResponder over `parent_id`), which reads
// the parent pointer from the DB — so its cases seed REAL rows in an isolated BUTCHR_DB:
//   - has a parent node (parent_id set — a story member, or any nested Work) → `story`
//   - top-level (parent_id NULL) → `cto`, or `user` once escalated_to_user.
// This is BEHAVIOR-IDENTICAL to the old 2-level rule for today's shapes (a story member's
// parent_id == its story_id, backfilled by the step-6a migration).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
const DIR = "pr-dir";
const NODE = "pr-node"; // a materialized parent NODE (a Work with children) for member cases

let tasksMod: typeof import("../src/tasks.ts");
let dbMod: typeof import("../src/db.ts");

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-pr-data-"));
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";
  // The unified-work routing is ON by default as of step 6a; assert that here so a stray env
  // override in the shared process can't silently flip the routing under us.
  delete process.env.BUTCHR_UNIFIED_WORK;
  dbMod = await import("../src/db.ts");
  tasksMod = await import("../src/tasks.ts");

  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(DIR, join(DATA_DIR, DIR), DIR, dbMod.nowIso());
  // The parent NODE the member cases point at (status is irrelevant to routing — a Work node
  // is anything a child's parent_id references).
  dbMod.db
    .query(`INSERT INTO tasks (id, workspace_id, status, created_at) VALUES (?, ?, 'merged', ?)`)
    .run(NODE, DIR, dbMod.nowIso());
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

// Build a synthetic row carrying only the fields isAwaitingFeedback reads (status / idle).
function row(status: string, opts: { idle?: number } = {}) {
  return {
    status: status as import("../src/db.ts").TaskStatus,
    idle: opts.idle ?? 0,
  } as import("../src/db.ts").TaskRow;
}

// Seed a REAL task row (so pendingResponder's parent-chain resolver reads its parent_id from
// the DB) and return the stored row. `parentId` makes it a member of the NODE; `escalated`
// sets the cto→user boundary bit. Unique ids per call.
let seq = 0;
function seedRow(
  status: string,
  opts: { idle?: number; parentId?: string | null; escalated?: number; hasAgent?: number } = {},
): import("../src/db.ts").TaskRow {
  const id = `pr-${seq++}`;
  dbMod.db
    .query(
      `INSERT INTO tasks (id, workspace_id, status, idle, has_agent, parent_id, escalated_to_user, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      DIR,
      status,
      opts.idle ?? 0,
      opts.hasAgent ?? 0,
      opts.parentId ?? null,
      opts.escalated ?? 0,
      dbMod.nowIso(),
    );
  return tasksMod.getTask(id)!;
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
    expect(tasksMod.pendingResponder(seedRow("in_progress", { idle: 0 }))).toBeNull();
    expect(tasksMod.pendingResponder(seedRow("merged"))).toBeNull();
    expect(tasksMod.pendingResponder(seedRow("blocked"))).toBeNull();
    // null even for a member that is not on a feedback surface.
    expect(tasksMod.pendingResponder(seedRow("merged", { parentId: NODE }))).toBeNull();
  });

  test("a member (parent node) resolves 'story' ALWAYS (terminal at the leader)", () => {
    for (const s of ["idea", "spec_review", "in_review", "needs_info"] as const) {
      expect(tasksMod.pendingResponder(seedRow(s, { parentId: NODE }))).toBe("story");
    }
    // An idle member build agent is also the leader's.
    expect(tasksMod.pendingResponder(seedRow("in_progress", { idle: 1, parentId: NODE, hasAgent: 1 }))).toBe("story");
    // escalated_to_user is IGNORED for a member — never reaches the user (the needs_user_input
    // short-circuit is gated on parent_id == null).
    expect(tasksMod.pendingResponder(seedRow("in_review", { parentId: NODE, escalated: 1 }))).toBe("story");
  });

  test("a top-level task resolves 'cto' when not escalated, 'user' once escalated", () => {
    expect(tasksMod.pendingResponder(seedRow("in_review", { parentId: null }))).toBe("cto");
    expect(tasksMod.pendingResponder(seedRow("needs_info", { parentId: null }))).toBe("cto");
    expect(tasksMod.pendingResponder(seedRow("in_review", { parentId: null, escalated: 1 }))).toBe("user");
    // The idle surface follows the same top-level resolution.
    expect(tasksMod.pendingResponder(seedRow("in_progress", { idle: 1, parentId: null, hasAgent: 1 }))).toBe("cto");
    expect(tasksMod.pendingResponder(seedRow("in_progress", { idle: 1, parentId: null, escalated: 1, hasAgent: 1 }))).toBe("user");
  });

  test("the needs_info plan-vs-question split does NOT change the responder", () => {
    // Who responds is structural; the plan-preview discriminator only affects the surface
    // copy/emphasis, not pending_responder.
    expect(tasksMod.pendingResponder(seedRow("needs_info", { parentId: null }))).toBe("cto");
    expect(tasksMod.pendingResponder(seedRow("needs_info", { parentId: NODE }))).toBe("story");
  });
});
