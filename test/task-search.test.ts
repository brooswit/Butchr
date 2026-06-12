// Tests for FULL-TEXT TASK SEARCH (server-side `?q=` on the workspace task-list
// endpoint, backed by tasks.taskListView's optional `q` arg + db.matchesQuery).
// Search matches case-insensitively across a task's:
//   - prompt + accumulated review notes (read from task.md on disk),
//   - request_review summary + live review_note (DB columns),
//   - id.
// It extends the existing id/status/tag filtering rather than replacing it — a
// blank query returns the full list unchanged and reads no task.md.
//
// In-process / pure: rows are seeded straight into the DB and their task.md written
// to a real on-disk directory root (registered as the workspace's path) so the
// prompt-on-disk read path is exercised. No real claude or herdr.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_DIR: string; // the directory ROOT where .butchr/tasks/<id>/task.md live
const DIR_ID = "search-dir";

let tasksMod: typeof import("../src/tasks.ts");
let dbMod: typeof import("../src/db.ts");
let taskmdMod: typeof import("../src/taskmd.ts");

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-search-data-"));
  REPO_DIR = mkdtempSync(join(tmpdir(), "butchr-search-repo-"));
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  dbMod = await import("../src/db.ts");
  tasksMod = await import("../src/tasks.ts");
  taskmdMod = await import("../src/taskmd.ts");

  // The workspace's path points at the on-disk repo root so taskListView can read
  // each task's task.md to scan its prompt.
  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(DIR_ID, REPO_DIR, "test", dbMod.nowIso());
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_DIR, { recursive: true, force: true });
});

/** Seed a DB task row AND write its task.md (with `prompt`) to REPO_DIR. */
function seed(opts: {
  id: string;
  status: string;
  createdAt: string;
  prompt: string;
  summary?: string | null;
  reviewNote?: string | null;
}): string {
  dbMod.db
    .query(
      `INSERT INTO tasks (id, workspace_id, status, summary, review_note, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(opts.id, DIR_ID, opts.status, opts.summary ?? null, opts.reviewNote ?? null, opts.createdAt);
  taskmdMod.writeTaskMd(
    REPO_DIR,
    { id: opts.id, created: opts.createdAt, status: opts.status as any, context: [] },
    opts.prompt,
  );
  return opts.id;
}

const idsFor = (q?: string) => tasksMod.taskListView(DIR_ID, q).map((t) => t.id).sort();

test("db.matchesQuery: case-insensitive substring; blank query matches everything", () => {
  expect(dbMod.matchesQuery("Add OAuth login flow", "oauth")).toBe(true);
  expect(dbMod.matchesQuery("Add OAuth login flow", "OAUTH")).toBe(true);
  expect(dbMod.matchesQuery("Add OAuth login flow", "logout")).toBe(false);
  // A blank / whitespace-only query applies no filter.
  expect(dbMod.matchesQuery("anything", "")).toBe(true);
  expect(dbMod.matchesQuery("anything", "   ")).toBe(true);
});

test("matches on PROMPT text (read from task.md) and SUMMARY text", () => {
  seed({
    id: "se-prompt",
    status: "queued",
    createdAt: "2026-02-01T00:00:00.000Z",
    prompt: "Implement the websocket reconnection backoff logic",
  });
  seed({
    id: "se-summary",
    status: "merged",
    createdAt: "2026-02-01T00:00:01.000Z",
    prompt: "Unrelated prompt body here",
    summary: "Refactored the websocket handshake for clarity",
  });
  seed({
    id: "se-miss",
    status: "queued",
    createdAt: "2026-02-01T00:00:02.000Z",
    prompt: "Totally different work about CSS grid",
  });

  // The prompt-only task and the summary-only task both match "websocket"; the
  // unrelated one does not. Proves search reaches BOTH the on-disk prompt and the
  // DB summary, and spans active (queued) + finished (merged) tasks.
  expect(idsFor("websocket")).toEqual(["se-prompt", "se-summary"]);
  // Case-insensitive.
  expect(idsFor("WEBSOCKET")).toEqual(["se-prompt", "se-summary"]);
  // A blank query returns everything (no filter) — same as omitting it.
  expect(idsFor("").length).toBe(tasksMod.taskListView(DIR_ID).length);
});

test("matches on REVIEW NOTE text and on the task id", () => {
  seed({
    id: "se-zephyr-id",
    status: "queued",
    createdAt: "2026-02-02T00:00:00.000Z",
    prompt: "nothing notable",
  });
  seed({
    id: "se-note",
    status: "queued",
    createdAt: "2026-02-02T00:00:01.000Z",
    prompt: "nothing notable either",
    reviewNote: "Please also handle the zephyr edge case",
  });

  // "zephyr" appears in se-zephyr-id's id and in se-note's review_note.
  expect(idsFor("zephyr")).toEqual(["se-note", "se-zephyr-id"]);
});

test("composes with status filtering on the returned set", () => {
  // Two tasks share a search term but differ in status; the search returns both and
  // a status filter (applied by the webapp/CLI over the result) narrows further.
  const all = tasksMod.taskListView(DIR_ID, "websocket");
  expect(all.map((t) => t.id).sort()).toEqual(["se-prompt", "se-summary"]);
  const onlyMerged = all.filter((t) => t.status === "merged").map((t) => t.id);
  expect(onlyMerged).toEqual(["se-summary"]);
});
