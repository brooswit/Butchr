// F2 regression: a NEGATIVE quietMs (a backward system-clock jump, or a run-log mtime in
// the FUTURE) must be treated as UNKNOWN — refreshIdle clamps it to null at the SOURCE so
// no downstream consumer (a) clears a legitimately-set needs_user_input flag or (b) infers
// the agent is active. Before the fix, a negative value fell through
// clearNeedsUserInputOnResume's `quietMs === null || isGenuinelyIdle(quietMs)` early-return
// (not null, not > idleMs) and wiped the flag every watcher tick.
//
// In-process: no real claude or herdr (BUTCHR_HERDR_BIN→true). Isolated BUTCHR_DB so the
// dev-runs-migrate-live-db hazard is avoided.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
const DIR_ID = "idle-skew-dir";

let dbMod: typeof import("../src/db.ts");
let tasksMod: typeof import("../src/tasks.ts");
let dispatchMod: typeof import("../src/dispatcher.ts");

function rowOf(id: string) {
  return tasksMod.getTask(id)!;
}

// A LIVE launched build agent: in_progress + has_agent=1 (the precondition
// setNeedsUserInput guards on). Same shape the needs_user_input tests use.
function seedLive(id: string): void {
  dbMod.db
    .query(
      `INSERT INTO tasks (id, workspace_id, status, has_agent, created_at)
       VALUES (?, ?, 'in_progress', 1, ?)`,
    )
    .run(id, DIR_ID, dbMod.nowIso());
}

// Write a run-log file whose mtime is `offsetMs` from now (negative = past, positive =
// future). A future mtime is exactly the clock-skew condition that yields a negative quietMs.
function writeLogWithMtime(path: string, offsetMs: number): void {
  writeFileSync(path, "agent output\n");
  const when = new Date(Date.now() + offsetMs);
  utimesSync(path, when, when);
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-idle-skew-data-"));
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";
  process.env.BUTCHR_IDLE_MS = "60000"; // 60s — idle detection ON so refreshIdle runs

  dbMod = await import("../src/db.ts");
  tasksMod = await import("../src/tasks.ts");
  dispatchMod = await import("../src/dispatcher.ts");

  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(DIR_ID, DATA_DIR, "test", dbMod.nowIso());
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("F2: negative quietMs (clock skew) is clamped to null at the source", () => {
  test("a FUTURE log mtime makes refreshIdle return null, not a negative number", () => {
    const log = join(DATA_DIR, "future.log");
    writeLogWithMtime(log, 5 * 60_000); // mtime 5 min in the FUTURE → quietMs would be ~-5min
    expect(dispatchMod.refreshIdle("skew-future-mtime", log)).toBeNull();
  });

  test("a normal (past) log mtime still returns a real positive quietMs", () => {
    const log = join(DATA_DIR, "past.log");
    writeLogWithMtime(log, -90_000); // 90s ago → ~90s quiet, past the 60s idle threshold
    const quietMs = dispatchMod.refreshIdle("skew-past-mtime", log);
    expect(quietMs).not.toBeNull();
    expect(quietMs!).toBeGreaterThan(0);
    expect(dispatchMod.isGenuinelyIdle(quietMs)).toBe(true);
  });

  test("a negative quietMs (as null) does NOT clear a set needs_user_input flag", () => {
    seedLive("skew-keeps-flag");
    tasksMod.setNeedsUserInput("skew-keeps-flag", true, () => "wedged at a human-only prompt");
    expect(rowOf("skew-keeps-flag").needs_user_input).toBe(1);

    // Drive the actual watcher chain refreshIdle feeds: a future-mtime log → null → the
    // clear-on-resume step must NOT wipe the flag (the F2 bug cleared it every tick).
    const log = join(DATA_DIR, "keeps-flag.log");
    writeLogWithMtime(log, 5 * 60_000);
    const quietMs = dispatchMod.refreshIdle("skew-keeps-flag", log);
    expect(quietMs).toBeNull();
    dispatchMod.clearNeedsUserInputOnResume("skew-keeps-flag", quietMs);
    expect(rowOf("skew-keeps-flag").needs_user_input).toBe(1); // STILL set — not cleared
  });

  test("a null quietMs is treated as UNKNOWN, never as active/idle", async () => {
    // isGenuinelyIdle(null) is false (not idle), and handleIdleAgent no-ops on null
    // (neither inferring active nor surfacing idle) — the whole point of the source clamp.
    expect(dispatchMod.isGenuinelyIdle(null)).toBe(false);
    seedLive("skew-unknown-noop");
    await dispatchMod.handleIdleAgent("skew-unknown-noop", "in_progress", null);
    // No flag was set or cleared by the no-op handling.
    expect(rowOf("skew-unknown-noop").needs_user_input).toBe(0);
    expect(rowOf("skew-unknown-noop").idle).toBe(0);
  });
});
