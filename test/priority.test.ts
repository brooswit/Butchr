// Tests for PER-TASK DISPATCH PRIORITY (see the `priority` column in db.ts,
// dispatcher.selectQueuedForDispatch's `priority DESC, created_at ASC` ordering,
// and tasks.{validatePriority,setPriority,createTask}).
//
// Pure / in-process: no real claude or herdr is spawned (BUTCHR_HERDR_BIN points
// at `true`). The ordering assertion uses the REAL function the tick calls —
// selectQueuedForDispatch — so the queue order is exercised, not a replica.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
// Unique per-file directory id — the db/config singletons are shared across test
// files in one run, so a distinct id keeps this file's rows from colliding.
const DIR_ID = "priority-dir";

let dbMod: typeof import("../src/db.ts");
let dispatcherMod: typeof import("../src/dispatcher.ts");
let tasksMod: typeof import("../src/tasks.ts");

// Insert a queued task directly with an explicit created_at + priority so the
// ordering is deterministic (no reliance on insert timing).
function insertQueued(id: string, createdAt: string, priority: number): void {
  dbMod.db
    .query(
      `INSERT INTO tasks (id, directory_id, status, priority, created_at)
       VALUES (?, ?, 'queued', ?, ?)`,
    )
    .run(id, DIR_ID, priority, createdAt);
}

const queuedIds = (now: string) =>
  dispatcherMod.selectQueuedForDispatch(now).map((r) => r.id);

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-priority-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-priority-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  dbMod = await import("../src/db.ts");
  dispatcherMod = await import("../src/dispatcher.ts");
  tasksMod = await import("../src/tasks.ts");

  dbMod.db
    .query(
      `INSERT INTO directories (id, path, label, created_at) VALUES (?, ?, ?, ?)`,
    )
    .run(DIR_ID, REPO_ROOT, "test", dbMod.nowIso());
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

describe("dispatch priority ordering", () => {
  test("a higher-priority queued task is selected before an older lower-priority one", () => {
    // `older-low` was created FIRST but at the default priority (0); `newer-high`
    // was created LATER but with a higher priority. Priority must win.
    insertQueued("older-low", "2024-01-01T00:00:00.000Z", 0);
    insertQueued("newer-high", "2024-06-01T00:00:00.000Z", 5);

    const ids = queuedIds(new Date().toISOString());
    expect(ids.indexOf("newer-high")).toBeLessThan(ids.indexOf("older-low"));
    // And the high-priority task is at the very front of the queue.
    expect(ids[0]).toBe("newer-high");
  });

  test("ties at the same priority stay FIFO (oldest created_at first)", () => {
    insertQueued("tie-old", "2024-02-01T00:00:00.000Z", 3);
    insertQueued("tie-new", "2024-03-01T00:00:00.000Z", 3);
    const ids = queuedIds(new Date().toISOString());
    expect(ids.indexOf("tie-old")).toBeLessThan(ids.indexOf("tie-new"));
  });

  test("setPriority re-orders the queue", () => {
    insertQueued("bump-me", "2025-01-01T00:00:00.000Z", 0);
    // Before the bump it sits behind every higher-priority task.
    let ids = queuedIds(new Date().toISOString());
    expect(ids[0]).not.toBe("bump-me");
    // Bump it above everything else; now it leads.
    tasksMod.setPriority("bump-me", 10);
    ids = queuedIds(new Date().toISOString());
    expect(ids[0]).toBe("bump-me");
  });
});

describe("validatePriority", () => {
  test("defaults blank/unset to 0", () => {
    expect(tasksMod.validatePriority(undefined)).toBe(0);
    expect(tasksMod.validatePriority(null)).toBe(0);
    expect(tasksMod.validatePriority("")).toBe(0);
  });

  test("accepts integers and numeric strings (incl. negatives)", () => {
    expect(tasksMod.validatePriority(7)).toBe(7);
    expect(tasksMod.validatePriority("3")).toBe(3);
    expect(tasksMod.validatePriority(-2)).toBe(-2);
  });

  test("rejects non-integers", () => {
    expect(() => tasksMod.validatePriority(1.5)).toThrow();
    expect(() => tasksMod.validatePriority("abc")).toThrow();
  });
});
