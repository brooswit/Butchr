// WORK + WORKSPACE UNIFICATION — step 2: UNIFIED WORK MODEL + RECURSIVE FEEDBACK
// (story st-540ba705). Exercises src/work.ts: the self-referential Work abstraction over
// tasks.parent_id (leaf vs node) and the RECURSIVE parent-chain feedback responder
// (leaf → node → … → top-level → CTO → user, with the needs_user_input short-circuit and a
// malformed-cycle guard). Also asserts the OFF gate flag and that the LIVE 2-level
// pendingResponder routing is UNCHANGED for the same rows (the new path is inert).
//
// Pure / in-process (mirrors test/responder-chain.test.ts): no real claude/herdr/bun is
// spawned (BUTCHR_HERDR_BIN points at `true`); rows are inserted directly into an isolated
// BUTCHR_DB. Distinct ids — the db/config singletons are shared across test files — and every
// assertion is scoped to our own rows.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
const DIR = "work-rf-dir";

let workMod: typeof import("../src/work.ts");
let tasksMod: typeof import("../src/tasks.ts");
let dbMod: typeof import("../src/db.ts");

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-workrf-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-workrf-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";
  // The gate must be OFF by default for this run (do NOT set BUTCHR_UNIFIED_WORK).
  delete process.env.BUTCHR_UNIFIED_WORK;

  dbMod = await import("../src/db.ts");
  tasksMod = await import("../src/tasks.ts");
  workMod = await import("../src/work.ts");

  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(DIR, join(REPO_ROOT, DIR), DIR, dbMod.nowIso());
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

/**
 * Seed a bare Work row (a tasks row) with the columns the structural Work resolution reads.
 * IMPORTANT: a parent must be inserted BEFORE its child (the parent_id self-FK is enforced).
 */
function seedWork(
  id: string,
  status: string,
  opts: { parentId?: string | null; blockedBy?: string[]; idle?: number; hasAgent?: number } = {},
) {
  dbMod.db
    .query(
      `INSERT INTO tasks (id, workspace_id, status, idle, has_agent, parent_id, blocked_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      DIR,
      status,
      opts.idle ?? 0,
      opts.hasAgent ?? 0,
      opts.parentId ?? null,
      opts.blockedBy ? JSON.stringify(opts.blockedBy) : null,
      dbMod.nowIso(),
    );
}

describe("step 2 — Work structure (leaf vs node over parent_id)", () => {
  // A 3-level tree: A (top-level node) ← B (mid node) ← C (leaf). Feedback states so the
  // recursive responder applies (idea/in_review/needs_info are feedback states).
  beforeAll(() => {
    seedWork("wrf-A", "in_review"); // top-level (parent_id NULL)
    seedWork("wrf-B", "in_review", { parentId: "wrf-A" });
    seedWork("wrf-C", "needs_info", { parentId: "wrf-B" }); // leaf
  });

  test("a Work with children is a NODE; a childless Work is a LEAF", () => {
    expect(workMod.isWorkNode("wrf-A")).toBe(true); // has child B
    expect(workMod.isWorkNode("wrf-B")).toBe(true); // has child C
    expect(workMod.isWorkLeaf("wrf-C")).toBe(true); // no children
    expect(workMod.isWorkLeaf("wrf-A")).toBe(false);
    expect(workMod.workChildCount("wrf-A")).toBe(1);
    expect(workMod.workChildren("wrf-A").map((r) => r.id)).toEqual(["wrf-B"]);
  });

  test("workParentId walks the structural parent pointer (null at the top)", () => {
    expect(workMod.workParentId("wrf-C")).toBe("wrf-B");
    expect(workMod.workParentId("wrf-B")).toBe("wrf-A");
    expect(workMod.workParentId("wrf-A")).toBeNull();
  });

  test("getWork / isWorkAwaitingFeedback are re-exported from the task seam", () => {
    expect(workMod.getWork("wrf-C")!.id).toBe("wrf-C");
    expect(workMod.isWorkAwaitingFeedback(workMod.getWork("wrf-C")!)).toBe(true);
  });
});

describe("step 2 — immediate responder (one tier)", () => {
  test("a leaf's feedback routes to its PARENT node", () => {
    expect(workMod.resolveWorkResponder("wrf-C")).toEqual({ kind: "work", work_id: "wrf-B" });
  });
  test("a mid node bubbles to ITS parent node", () => {
    expect(workMod.resolveWorkResponder("wrf-B")).toEqual({ kind: "work", work_id: "wrf-A" });
  });
  test("a top-level Work's parent-responder is the CTO", () => {
    expect(workMod.resolveWorkResponder("wrf-A")).toEqual({ kind: "cto" });
  });
});

describe("step 2 — recursive parent-chain bubble-up (3+ levels)", () => {
  test("the full chain walks leaf → node → … → top-level → CTO → user", () => {
    expect(workMod.workResponderChain("wrf-C")).toEqual([
      { kind: "work", work_id: "wrf-B" },
      { kind: "work", work_id: "wrf-A" },
      { kind: "cto" },
      { kind: "user" },
    ]);
  });

  test("a 4-level tree proves ARBITRARY nesting depth (RFC Q8)", () => {
    seedWork("wrf-T", "in_review"); // top
    seedWork("wrf-U", "in_review", { parentId: "wrf-T" });
    seedWork("wrf-V", "in_review", { parentId: "wrf-U" });
    seedWork("wrf-W", "needs_info", { parentId: "wrf-V" }); // deepest leaf
    expect(workMod.workResponderChain("wrf-W")).toEqual([
      { kind: "work", work_id: "wrf-V" },
      { kind: "work", work_id: "wrf-U" },
      { kind: "work", work_id: "wrf-T" },
      { kind: "cto" },
      { kind: "user" },
    ]);
  });

  test("a top-level Work's chain is just CTO → user (base case)", () => {
    expect(workMod.workResponderChain("wrf-A")).toEqual([{ kind: "cto" }, { kind: "user" }]);
  });
});

describe("step 2 — needs_user_input short-circuits STRAIGHT to the user", () => {
  test("the whole bubble-up is bypassed → [{ user }]", () => {
    expect(workMod.resolveWorkResponder("wrf-C", { needsUserInput: true })).toEqual({
      kind: "user",
    });
    expect(workMod.workResponderChain("wrf-C", { needsUserInput: true })).toEqual([
      { kind: "user" },
    ]);
    // Even a top-level Work short-circuits past the CTO straight to the user.
    expect(workMod.workResponderChain("wrf-A", { needsUserInput: true })).toEqual([
      { kind: "user" },
    ]);
  });
});

describe("step 2 — malformed parent cycle/self-parent guard terminates", () => {
  test("a self-parented row does not hang the walk", () => {
    // Insert with a NULL parent (FK), then force a self-cycle directly (bypassing the FK
    // path) to simulate corrupt data — the walk must still terminate.
    seedWork("wrf-self", "needs_info");
    dbMod.db.query(`UPDATE tasks SET parent_id='wrf-self' WHERE id='wrf-self'`).run();
    expect(workMod.workResponderChain("wrf-self")).toEqual([
      { kind: "work", work_id: "wrf-self" },
      { kind: "cto" },
      { kind: "user" },
    ]);
  });

  test("a two-row parent cycle terminates", () => {
    seedWork("wrf-cyc1", "needs_info");
    seedWork("wrf-cyc2", "needs_info", { parentId: "wrf-cyc1" });
    dbMod.db.query(`UPDATE tasks SET parent_id='wrf-cyc2' WHERE id='wrf-cyc1'`).run();
    const chain = workMod.workResponderChain("wrf-cyc2");
    // Walk stops once a row is revisited; chain still ends cto→user (no infinite loop).
    expect(chain[chain.length - 2]).toEqual({ kind: "cto" });
    expect(chain[chain.length - 1]).toEqual({ kind: "user" });
    expect(chain.length).toBeLessThanOrEqual(5);
  });
});

describe("step 2 — blocked_by reused UNCHANGED for node-on-node blocking", () => {
  test("a NODE can block on another NODE via the existing blocked_by seam", () => {
    // Two nodes (each given a child so they are nodes): nodeY blocks on nodeX.
    seedWork("wrf-nodeX", "in_review");
    seedWork("wrf-nodeX-child", "needs_info", { parentId: "wrf-nodeX" });
    seedWork("wrf-nodeY", "blocked", { blockedBy: ["wrf-nodeX"] });
    seedWork("wrf-nodeY-child", "needs_info", { parentId: "wrf-nodeY" });

    expect(workMod.isWorkNode("wrf-nodeX")).toBe(true);
    expect(workMod.isWorkNode("wrf-nodeY")).toBe(true);
    // The existing parse seam returns the node-on-node dependency unchanged.
    expect(tasksMod.parseBlockedBy(workMod.getWork("wrf-nodeY")!.blocked_by)).toEqual([
      "wrf-nodeX",
    ]);
    // The existing cycle guard: the node-on-node edge nodeY→nodeX is acyclic, while the
    // reverse edge nodeX→nodeY would close the loop (nodeX→nodeY→nodeX) → a cycle.
    expect(tasksMod.wouldCreateCycle("wrf-nodeY", ["wrf-nodeX"])).toBe(false);
    expect(tasksMod.wouldCreateCycle("wrf-nodeX", ["wrf-nodeY"])).toBe(true);
  });
});

describe("step 2 — the gate is OFF and the LIVE 2-level routing is UNCHANGED", () => {
  test("unifiedWorkEnabled() defaults OFF (nothing in the live path branches on it)", () => {
    expect(workMod.unifiedWorkEnabled()).toBe(false);
  });

  test("tasks.pendingResponder (the authoritative live seam) is unaffected for the same rows", () => {
    // wrf-A is a non-story task awaiting feedback → the live resolver still says 'cto',
    // exactly as before; the recursive Work path is inert.
    const row = tasksMod.getTask("wrf-A")!;
    expect(row.story_id).toBeNull();
    expect(tasksMod.pendingResponder(row)).toBe("cto");
  });
});
