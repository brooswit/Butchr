// STORY st-b8c9249e — `tasks.output_snapshot` is RETIRED.
//
// The column was a display-only copy of the agent's run log: unbounded (up to ~2 MB/task) and,
// measured on the live db, 54 MB of 78 MB. It is gone from the code but the COLUMN stays
// physically present (its DROP is batched into the later operator-present cleanup, alongside the
// inert gate_cmd / changelog_path columns). Three properties must hold:
//
//   (A) NOTHING WRITES IT. Every former write site is detached, so the column stays NULL.
//   (B) NO VISIBILITY GAP. The column carried two distinct things, and both survive:
//         - the AGENT's output → now read from the on-disk session transcript
//           (GET /api/work/:id/transcript), which is richer and outlives the worktree; and
//         - butchr's own RESCUE NOTE ("stuck/runaway", "the agent ended while butchr was
//           offline", "resume cap exceeded") — words the agent never wrote, so the transcript
//           CANNOT carry them. These now live in `task_events.note` and are rendered by the
//           webapp's Timeline plus a dedicated "Why butchr moved this to review" panel.
//       The db-side half of (B) is asserted in test/watchdog.test.ts (the rescue's audit-event
//       note contains "stuck/runaway"). The FE half is asserted HERE, by driving the real
//       `rescueNote()` out of public/app.js.
//   (C) The boot migration NULLs the payload and is IDEMPOTENT across boots.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("(A) nothing writes output_snapshot", () => {
  // A source-level guard, deliberately: the write sites were spread across merge/landed, the
  // merge auto-revert, parkExitingAgent and the resume-cap rescue, several of which need a real
  // git merge to reach. A re-introduced `output_snapshot: <value>` in either module fails here.
  // Matches WRITE FORMS (`output_snapshot:` / `output_snapshot =`) with comment lines stripped,
  // so the surviving explanatory comments don't false-positive.
  test("src/tasks.ts and src/dispatcher.ts contain no output_snapshot writes", () => {
    for (const f of ["src/tasks.ts", "src/dispatcher.ts"]) {
      const code = read(f)
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join("\n");
      expect(code).not.toMatch(/output_snapshot\s*[:=]/);
    }
  });

  test("the detail/list view projections no longer reference the column", () => {
    // The LIST_QUERY_OMIT / LIST_VIEW_OMIT omits existed ONLY to keep this heavy blob out of
    // the list payload. With the column dead they must not name it (nor the TaskListView union).
    const tasks = read("src/tasks.ts");
    expect(tasks).toContain('const LIST_QUERY_OMIT = new Set(["last_dispatch_error", "revert_reason"])');
    expect(tasks).toContain('const LIST_VIEW_OMIT = ["last_dispatch_error", "revert_reason"] as const');
  });

  test("the webapp no longer renders t.output_snapshot", () => {
    expect(read("public/app.js")).not.toContain("t.output_snapshot");
  });

  test("the column and its row type SURVIVE (dead-but-present; DROP is batched separately)", () => {
    const db = read("src/db.ts");
    expect(db).toContain("output_snapshot TEXT");
    expect(db).toContain("output_snapshot: string | null");
  });

  test("readRunLogSnapshot SURVIVES — it still backs readRunLogTail → idle_context", () => {
    const dispatcher = read("src/dispatcher.ts");
    expect(dispatcher).toContain("export function readRunLogSnapshot");
    expect(dispatcher).toContain("readRunLogSnapshot(taskId)"); // called by readRunLogTail
  });
});

describe("(B) the rescue reason is still visible on a rescued task", () => {
  // Drive the REAL `rescueNote()` from public/app.js (the browser bundle is not importable, so
  // scrape the function and evaluate it — the same harness other FE tests use). This is what
  // decides whether the "Why butchr moved this to review" panel renders.
  const src = read("public/app.js");
  const fn = src.match(/function rescueNote\(events, status\) \{[\s\S]*?\n\}/);
  if (!fn) throw new Error("rescueNote() not found in public/app.js — did it get renamed?");
  const rescueNote = new Function(`${fn[0]}; return rescueNote;`)() as (
    events: unknown[],
    status: string,
  ) => string | null;

  // The three real rescue notes butchr authors (dispatcher.ts watcher + startup reconcile,
  // tasks.ts resume-cap). All share the prefix the panel keys on.
  const RUNAWAY =
    "[butchr] moved to review automatically: the agent exceeded the maximum run time (stuck/runaway).";
  const OFFLINE =
    "[butchr] moved to review automatically: the agent ended while butchr was offline.";
  const CAP = "[butchr] moved to review automatically: not auto-resumed; resume cap exceeded.";

  const ev = (to_status: string, note: string | null) => ({ to_status, note });

  test.each([
    ["runaway", RUNAWAY],
    ["agent died while butchr was offline", OFFLINE],
    ["resume cap exceeded", CAP],
  ])("surfaces the %s rescue note", (_label, note) => {
    const events = [ev("in_progress", "dispatched"), ev("in_review", note)];
    expect(rescueNote(events, "in_review")).toBe(note);
  });

  test("a NORMAL request_review submission shows no rescue panel", () => {
    const events = [ev("in_progress", "dispatched"), ev("in_review", "agent finished — submitted for review")];
    expect(rescueNote(events, "in_review")).toBeNull();
  });

  test("no panel once the task leaves review (the Timeline keeps the history)", () => {
    const events = [ev("in_review", RUNAWAY), ev("merged", "merged into the default branch")];
    expect(rescueNote(events, "merged")).toBeNull();
  });

  test("a RE-rescued task shows the LATEST reason, not a stale one", () => {
    const events = [ev("in_review", OFFLINE), ev("inactive", "auto re-dispatch"), ev("in_review", RUNAWAY)];
    expect(rescueNote(events, "in_review")).toBe(RUNAWAY);
  });

  test("tolerates a missing/!array events payload (the fetch is best-effort)", () => {
    expect(rescueNote([], "in_review")).toBeNull();
    expect(rescueNote(undefined as unknown as unknown[], "in_review")).toBeNull();
    expect(rescueNote([ev("in_review", null)], "in_review")).toBeNull();
  });
});

describe("(C) the boot migration NULLs the payload and is idempotent", () => {
  // Boot db.ts in a SUBPROCESS against a throwaway db, TWICE, so this exercises the real
  // import-time statement rather than a copy of it. Never touches the operator's live db:
  // BUTCHR_DB/BUTCHR_DATA_DIR are pinned to a temp dir, and no VACUUM runs anywhere.
  const boot = (dbFile: string, body: string) => {
    const script = `
      process.env.BUTCHR_DB = ${JSON.stringify(dbFile)};
      const { db } = await import(${JSON.stringify(join(ROOT, "src/db.ts"))});
      ${body}
    `;
    const p = Bun.spawnSync(["bun", "-e", script], {
      env: { ...process.env, BUTCHR_DB: dbFile, BUTCHR_DATA_DIR: dirname(dbFile) },
      stderr: "pipe",
      stdout: "pipe",
    });
    if (p.exitCode !== 0) throw new Error(`boot failed: ${p.stderr.toString()}`);
    return p.stdout.toString().trim();
  };

  test("boot 1 seeds → boot 2 NULLs it → boot 3 is a no-op (0 rows changed)", () => {
    const dir = mkdtempSync(join(tmpdir(), "butchr-snapshot-mig-"));
    const dbFile = join(dir, "test.db");
    try {
      // BOOT 1 — create the schema, then seed a workspace + a task carrying a snapshot payload.
      // The workspace row is REAL (not an FK-disabled orphan): a later boot runs
      // migrateDropStoriesMirror, which rebuilds `tasks` and asserts `PRAGMA foreign_key_check`
      // is clean, so a dangling workspace_id would blow up boot 2 rather than test the migration.
      boot(
        dbFile,
        `db.exec("INSERT INTO directory (id, path, label, created_at) " +
                 "VALUES ('ws','/tmp/ws-mig','ws','2026-01-01T00:00:00.000Z')");
         db.exec("INSERT INTO tasks (id, workspace_id, status, output_snapshot, created_at) " +
                 "VALUES ('mig-1','ws','merged','BIG SNAPSHOT PAYLOAD','2026-01-01T00:00:00.000Z')");`,
      );
      {
        const raw = new Database(dbFile, { readonly: true });
        expect(raw.query(`SELECT output_snapshot s FROM tasks WHERE id='mig-1'`).get() as any).toEqual({
          s: "BIG SNAPSHOT PAYLOAD",
        });
        raw.close();
      }

      // BOOT 2 — the import-time migration runs and NULLs the payload. The ROW itself survives
      // (only the blob is cleared). `nonNull` counts across ALL tasks, so nothing slips through.
      const after2 = boot(
        dbFile,
        `console.log(JSON.stringify({
           seededRowSurvives: !!db.query("SELECT 1 FROM tasks WHERE id='mig-1'").get(),
           seededSnapshot: db.query("SELECT output_snapshot s FROM tasks WHERE id='mig-1'").get().s,
           nonNull: db.query("SELECT COUNT(output_snapshot) c FROM tasks").get().c,
         }));`,
      );
      expect(JSON.parse(after2)).toEqual({ seededRowSurvives: true, seededSnapshot: null, nonNull: 0 });

      // BOOT 3 — IDEMPOTENT: the `IS NOT NULL` guard makes the second run match ZERO rows.
      // Re-running the exact statement must report 0 changes (and the row must still be there).
      const after3 = boot(
        dbFile,
        `const r = db.run("UPDATE tasks SET output_snapshot = NULL WHERE output_snapshot IS NOT NULL");
         console.log(JSON.stringify({
           changes: r.changes,
           seededRowSurvives: !!db.query("SELECT 1 FROM tasks WHERE id='mig-1'").get(),
         }));`,
      );
      expect(JSON.parse(after3)).toEqual({ changes: 0, seededRowSurvives: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the migration is wired at boot, guarded, and carries NO vacuum", () => {
    const db = read("src/db.ts");
    // Wired at import time, and GUARDED (`IS NOT NULL`) — that guard is what makes it idempotent.
    expect(db).toContain("UPDATE tasks SET output_snapshot = NULL WHERE output_snapshot IS NOT NULL");
    // ...and PRAGMA-guarded: `output_snapshot` is a baseline-only column, so a db predating it
    // (see the legacy fixtures in test/db-migrations*.test.ts) never grows one. Without this the
    // UPDATE throws `no such column` and crash-loops the server at startup.
    expect(db).toContain('if (columnExists(db, "tasks", "output_snapshot"))');
    // No VACUUM anywhere in the boot path or the gate — reclaiming the freed pages is a manual,
    // operator-run step. Comment lines are stripped so the rationale comments don't false-positive.
    const codeOnly = (s: string) =>
      s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*|#)/.test(l)).join("\n").toUpperCase();
    expect(codeOnly(db)).not.toContain("VACUUM");
    expect(codeOnly(read("scripts/ci"))).not.toContain("VACUUM");
  });
});
