// REGRESSION GUARD for the herdr_pane_id/herdr_tab_id NAME-ONLY CUTOVER (story st-086e8860).
//
// THE INCIDENT this guards: story st-a77b050f (released 0.9.107) dropped the EPHEMERAL
// `herdr_pane_id`/`herdr_tab_id` columns from tasks/cto_agent/story_agent and converted the
// runtime queries to the honest `has_agent` marker. A binary built from an EARLIER,
// INCONSISTENT state of that work shipped: the schema drop had landed but a runtime query
// still referenced the dropped column, so once the schema activated the story views and the
// dashboard rollup 500'd in prod with `SQLiteError: no such column: herdr_pane_id`.
//
// The SIBLING test (db-migrations.test.ts) proves the columns are physically DROPPED and that
// the has_agent backfill is ordered before the drop — but it NEVER calls the endpoints that
// actually 500'd. So a future change that drops a column while leaving a runtime query against
// it would still pass that test and ship broken. THIS test closes that gap: it migrates a
// legacy pre-has_agent DB to completion (columns GONE), then CALLS the exact runtime paths
// that 500'd — storyCounts, storyView/listStoryViews (GET /api/stories(/:id)) and
// listWorkspaces/dashboard (the dashboard `counts` rollup) — against that real post-drop
// schema and fails LOUDLY if any of them throws (e.g. `no such column`).
//
// db.ts binds its connection + runs the boot pass at IMPORT time, so — as in the sibling test
// — we exercise the real boot path in an ISOLATED `bun` subprocess: build the legacy DB,
// import db.ts (migrate), assert the columns are gone (PRECONDITION — proves the runtime calls
// below ran against the genuine post-drop schema, not a trivially-passing one), seed a story +
// member tasks, then call each runtime path and report whether it threw.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let out: {
  pre: { taskCols: string[]; ctoCols: string[]; storyAgentCols: string[] };
  calls: Record<string, { ok: boolean; error: string | null; value: unknown }>;
};

const SUBPROCESS = `
import { Database } from "bun:sqlite";
const path = process.env.BUTCHR_DB;
const SRC = process.env.SRC_DIR;

// Hand-build the OLD pre-has_agent shape (directories + tasks WITH the soon-to-be-dropped
// herdr_pane_id/herdr_tab_id + the legacy cto_agent singleton), then close so db.ts opens it
// fresh and migrates it forward on import.
const old = new Database(path, { create: true });
old.exec("PRAGMA foreign_keys = ON;");
old.exec(\`
  CREATE TABLE directories (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    directory_id TEXT NOT NULL REFERENCES directories(id) ON DELETE CASCADE,
    status TEXT NOT NULL, stage TEXT NOT NULL DEFAULT 'build',
    herdr_pane_id TEXT, herdr_tab_id TEXT, created_at TEXT NOT NULL
  );
  CREATE INDEX idx_tasks_dir ON tasks(directory_id);
  CREATE TABLE cto_agent (id TEXT PRIMARY KEY, session_id TEXT, herdr_pane_id TEXT, herdr_tab_id TEXT, desired INTEGER NOT NULL DEFAULT 0);
\`);
old.query("INSERT INTO directories (id, path, created_at) VALUES ('dir-1', '/tmp/ws-1', '2026-06-01T00:00:00.000Z')").run();
old.query("INSERT INTO cto_agent (id, session_id, desired) VALUES ('singleton', 'old', 1)").run();
// One legacy LIVE task so the herdr_pane_id drop runs on a populated table (mirrors prod).
old.query("INSERT INTO tasks (id, directory_id, status, stage, herdr_pane_id, herdr_tab_id, created_at) VALUES ('t-legacy', 'dir-1', 'running', 'build', 'px', 't-px', '2026-06-01T00:00:00.000Z')").run();
old.close();

// Import db.ts -> its module-load runMigrations() runs the full ordered pass, dropping the
// pane/tab columns. A FAKE runner so storyView's leader probe (harness.agentExists) is
// deterministic + never reaches herdr.
const m = await import(SRC + "/db.ts");
const { setRunner } = await import(SRC + "/harness.ts");
setRunner({ agentExists: async () => false });

const colsOf = (t) => m.db.query("PRAGMA table_info(" + t + ")").all().map((c) => c.name);
const pre = { taskCols: colsOf("tasks"), ctoCols: colsOf("cto_agent"), storyAgentCols: colsOf("story_agent") };

// Seed a story + member tasks AFTER migration (the post-drop schema: story_id + has_agent +
// idle exist; herdr_pane_id/herdr_tab_id do not). Include an in_progress member with
// has_agent=1 AND idle=1 so storyCounts / the dashboard counts actually execute the
// \`has_agent=1 AND idle=1\` peel-out subquery (the exact branch the dropped-column query lived
// next to), not just the GROUP BY.
m.db.query("INSERT INTO stories (id, workspace_id, brief, status, created_at) VALUES ('st-1', 'dir-1', 'b', 'open', '2026-06-02T00:00:00.000Z')").run();
const seed = (id, status, hasAgent, idle) =>
  m.db.query("INSERT INTO tasks (id, workspace_id, status, story_id, has_agent, idle, created_at) VALUES (?, 'dir-1', ?, 'st-1', ?, ?, '2026-06-02T00:00:00.000Z')").run(id, status, hasAgent, idle);
seed("m-idle", "in_progress", 1, 1);    // LIVE but quiet -> peeled into the \`idle\` bucket
seed("m-active", "in_progress", 1, 0);  // LIVE + working -> stays in \`in_progress\`
seed("m-review", "in_review", 0, 0);
seed("m-merged", "merged", 0, 0);

const stories = await import(SRC + "/stories.ts");
const workspaces = await import(SRC + "/workspaces.ts");

// Call each runtime path that 500'd; record whether it threw (esp. \`no such column\`).
const run = async (fn) => {
  try { return { ok: true, error: null, value: await fn() }; }
  catch (e) { return { ok: false, error: (e && e.message) || String(e), value: null }; }
};
const calls = {
  storyCounts: await run(() => stories.storyCounts("st-1")),
  storyView: await run(() => stories.storyView("st-1")),
  listStoryViews: await run(() => stories.listStoryViews("dir-1")),
  listWorkspaces: await run(() => workspaces.listWorkspaces()),
  dashboard: await run(() => workspaces.dashboard()),
};
console.log("RESULT:" + JSON.stringify({ pre, calls }));
`;

beforeAll(() => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-db-runtime-"));
  const DB_PATH = join(DATA_DIR, "test.db");
  const SRC_DIR = join(import.meta.dir, "../src");
  const res = Bun.spawnSync(["bun", "-e", SUBPROCESS], {
    env: { ...process.env, BUTCHR_DB: DB_PATH, BUTCHR_DATA_DIR: DATA_DIR, SRC_DIR },
  });
  const stdout = res.stdout.toString();
  const stderr = res.stderr.toString();
  const line = stdout.split("\n").find((l) => l.startsWith("RESULT:"));
  if (!line) {
    throw new Error(`runtime-paths subprocess produced no RESULT (exit ${res.exitCode}).\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  out = JSON.parse(line.slice("RESULT:".length));
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("post-cutover runtime paths — PRECONDITION (columns are physically gone)", () => {
  // Without this, the runtime assertions below could pass trivially against a DB where a
  // future change silently SKIPPED the drop. Asserting the post-drop schema proves the calls
  // ran against the real shape that 500'd in prod.
  test("the dropped pane/tab columns are gone from tasks/cto_agent/story_agent; has_agent is present", () => {
    for (const t of [out.pre.taskCols, out.pre.ctoCols, out.pre.storyAgentCols]) {
      expect(t).not.toContain("herdr_pane_id");
      expect(t).not.toContain("herdr_tab_id");
    }
    expect(out.pre.taskCols).toContain("has_agent");
  });
});

describe("post-cutover runtime paths — the endpoints that 500'd must NOT throw", () => {
  // The CLASS of bug: a future change drops a column but leaves a runtime query referencing
  // it. Each of these would have surfaced `SQLiteError: no such column: herdr_pane_id` in the
  // incident; assert they complete cleanly (no error, and explicitly no `no such column`).
  for (const name of ["storyCounts", "storyView", "listStoryViews", "listWorkspaces", "dashboard"]) {
    test(`${name} returns without a SQLite error`, () => {
      const call = out.calls[name];
      expect(call).toBeDefined();
      // Surface the actual error message in the failure (loud, not swallowed).
      expect(call.error).toBeNull();
      expect(call.ok).toBe(true);
      expect(call.error ?? "").not.toContain("no such column");
    });
  }

  test("storyCounts executed the has_agent+idle peel-out branch (not just the GROUP BY)", () => {
    // Two LIVE in_progress members were seeded — one idle, one active. The idle one must be
    // peeled out of in_progress into the `idle` bucket (the exact subquery near where the
    // dropped-column query lived), proving that branch ran against the post-drop schema.
    const counts = out.calls.storyCounts.value as Record<string, number>;
    expect(counts.idle).toBe(1);
    expect(counts.in_progress).toBe(1);
    expect(counts.in_review).toBe(1);
    expect(counts.merged).toBe(1);
  });
});
