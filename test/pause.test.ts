// Tests for the DISPATCHER PAUSE / maintenance mode (see dispatcher.{isPaused,
// setPaused,selectQueuedForDispatch} + the `settings` table in db.ts).
//
// Pure / in-process: no real claude or herdr is spawned (BUTCHR_HERDR_BIN points
// at `true`, so any herdr probe is a harmless no-op). The behavioral assertion
// uses the REAL function the tick calls — selectQueuedForDispatch — so the gate
// itself is exercised, not a replica:
//   1. when NOT paused, an eligible READY `inactive` task
//      is selected for dispatch;
//   2. when PAUSED, the selection is EMPTY (no new agent is launched), even though
//      the task is still `inactive` and eligible;
//   3. resume restores selection;
//   4. the flag persists to the `settings` table (key 'dispatch_paused'), which is
//      what keeps a pause in effect across a butchr restart.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
// Unique per-file workspace id — the db/config singletons are shared across test
// files in one run, so a distinct id keeps this file's rows from colliding.
const DIR_ID = "pause-dir";

let dbMod: typeof import("../src/db.ts");
let dispatcherMod: typeof import("../src/dispatcher.ts");

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-pause-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-pause-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  dbMod = await import("../src/db.ts");
  dispatcherMod = await import("../src/dispatcher.ts");

  dbMod.db
    .query(
      `INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`,
    )
    .run(DIR_ID, REPO_ROOT, "test", dbMod.nowIso());

  // One plain, immediately-eligible READY `inactive` task (has_agent=0,
  // no dispatch backoff). This is the new dispatchable state (was `queued`).
  dbMod.db
    .query(
      `INSERT INTO tasks (id, workspace_id, status, has_agent, created_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .run("pause-q1", DIR_ID, "inactive", 0, dbMod.nowIso());
});

afterAll(() => {
  // Leave dispatch un-paused so a shared singleton doesn't affect other files.
  dispatcherMod.setPaused(false);
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

const ids = (now: string) =>
  dispatcherMod.selectQueuedForDispatch(now).map((r) => r.id);

describe("dispatcher pause gate", () => {
  test("not paused by default: an eligible READY inactive task is selected", () => {
    expect(dispatcherMod.isPaused()).toBe(false);
    expect(ids(new Date().toISOString())).toContain("pause-q1");
  });

  test("paused: no inactive task is dispatched (drain-only)", () => {
    dispatcherMod.setPaused(true);
    expect(dispatcherMod.isPaused()).toBe(true);
    // The task is still inactive + eligible (READY), but the gate returns nothing.
    expect(ids(new Date().toISOString())).toEqual([]);
    const row = dbMod.db
      .query<{ status: string }, [string]>(`SELECT status FROM tasks WHERE id=?`)
      .get("pause-q1");
    expect(row?.status).toBe("inactive");
  });

  test("paused state is persisted to the settings table (survives restart)", () => {
    expect(dbMod.getSetting("dispatch_paused")).toBe("1");
  });

  test("resume restores dispatch", () => {
    dispatcherMod.setPaused(false);
    expect(dispatcherMod.isPaused()).toBe(false);
    expect(dbMod.getSetting("dispatch_paused")).toBe("0");
    expect(ids(new Date().toISOString())).toContain("pause-q1");
  });
});
