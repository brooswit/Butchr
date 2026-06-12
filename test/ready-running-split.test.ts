// Tests for the READY/RUNNING SPLIT boot migration (db.migrateReadyRunningSplit) — the
// CRITICAL correctness point on the restart that activates the 12-state model. Under the
// OLD model `in_progress` + a NULL `herdr_pane_id` meant READY (the dispatcher relaunched
// it) and a pane meant a LIVE agent. The new model carries that distinction in the STATUS
// itself: `inactive` = ready (the dispatcher keys on it), `in_progress` = a live agent. So
// on the activating restart we MUST re-bucket every existing row, or a ready task would be
// orphaned (the dispatcher no longer looks at `in_progress`+null-pane).
//
// This protects the live system: it asserts the migration maps legacy rows correctly AND
// that the dispatcher's REAL selection (selectQueuedForDispatch) then picks up the migrated
// ready task. Pure / in-process (BUTCHR_HERDR_BIN=true → herdr probes are no-ops).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
const DIR_ID = "rrsplit-dir";

let dbMod: typeof import("../src/db.ts");
let dispatcherMod: typeof import("../src/dispatcher.ts");

function row(id: string) {
  return dbMod.db.query<any, [string]>(`SELECT * FROM tasks WHERE id=?`).get(id)!;
}

// Seed a task row directly with an explicit status + pane (bypassing createTask) so we can
// reproduce the OLD-model shapes the migration must re-bucket.
function seed(id: string, status: string, paneId: string | null): void {
  dbMod.db
    .query(
      `INSERT INTO tasks (id, workspace_id, status, herdr_pane_id, herdr_tab_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, DIR_ID, status, paneId, paneId ? `tab-${id}` : null, dbMod.nowIso());
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-rrsplit-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-rrsplit-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  dbMod = await import("../src/db.ts");
  dispatcherMod = await import("../src/dispatcher.ts");

  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(DIR_ID, REPO_ROOT, "test", dbMod.nowIso());
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

describe("migrateReadyRunningSplit (the restart that activates the 12-state model)", () => {
  test("an in_progress+null-pane row (legacy READY) becomes inactive; a +pane row stays in_progress", () => {
    // Legacy READY: in_progress with no live pane — the dispatcher used to relaunch it.
    seed("rr-ready", "in_progress", null);
    // Legacy RUNNING: in_progress with a live pane — a re-adopted agent.
    seed("rr-running", "in_progress", "pane-running");

    dbMod.migrateReadyRunningSplit();

    // The ready row is re-bucketed to `inactive` so the dispatcher (now keying on
    // `inactive`) can pick it up — NOT stranded as in_progress+null-pane.
    expect(row("rr-ready").status).toBe("inactive");
    // The running row is left as-is so reconcileRunningTasks re-adopts its live agent.
    expect(row("rr-running").status).toBe("in_progress");
    expect(row("rr-running").herdr_pane_id).toBe("pane-running");
  });

  test("a lingering finalizing row is routed to in_review (pane cleared) — no agent stranded", () => {
    // finalizing is a REMOVED state; an approve-time merge is now mechanical. A row left
    // mid-finalize must not strand: route it to in_review for the operator to re-approve.
    seed("rr-fin-pane", "finalizing", "pane-fin");
    seed("rr-fin-null", "finalizing", null);

    dbMod.migrateReadyRunningSplit();

    for (const id of ["rr-fin-pane", "rr-fin-null"]) {
      expect(row(id).status).toBe("in_review");
      expect(row(id).herdr_pane_id).toBeNull();
      expect(row(id).herdr_tab_id).toBeNull();
    }
  });

  test("after the migration the dispatcher SELECTS the migrated-ready task (not orphaned)", () => {
    // The whole point: a legacy ready row must be dispatchable again post-migration. Use
    // the REAL selection the tick calls so the wiring is exercised, not a replica.
    seed("rr-select", "in_progress", null);
    dbMod.migrateReadyRunningSplit();
    expect(row("rr-select").status).toBe("inactive");

    const ids = dispatcherMod.selectQueuedForDispatch(new Date().toISOString()).map((r) => r.id);
    expect(ids).toContain("rr-select");
  });

  test("idempotent: re-running it is a no-op once converged (a live in_progress is untouched)", () => {
    // In the new model a running in_progress ALWAYS has a pane, so re-running the migration
    // never wrongly demotes a live agent.
    seed("rr-idem", "in_progress", "pane-idem");
    dbMod.migrateReadyRunningSplit();
    dbMod.migrateReadyRunningSplit();
    expect(row("rr-idem").status).toBe("in_progress");
    expect(row("rr-idem").herdr_pane_id).toBe("pane-idem");
  });
});
