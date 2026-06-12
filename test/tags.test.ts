// Tests for TASK LABELS/TAGS (see db.ts `tags` column, tasks.{createTask,parseTags,
// normalizeTags,validateTags}, and the task.md front-matter round-trip in taskmd.ts).
//
// Two halves:
//   1. STORAGE / SERIALIZATION — createTask persists a clean tag set to the DB
//      (JSON-array TEXT), surfaces it as a real string[] on taskView / taskListView,
//      and round-trips it through task.md's front matter. Normalization (trim, dedupe,
//      drop blanks) and validation (400 on bad input) are exercised here too.
//   2. FILTERING — the ANY-match semantics the webapp filter bar + CLI `ls --tag`
//      apply over taskListView's `tags` arrays select the expected tasks.
//
// createTask exercises the REAL function (worktree + task.md + DB row), so we stand up
// a throwaway git repo with one commit for `git worktree add` to work. Pure / in-process
// otherwise: BUTCHR_HERDR_BIN points at `true` so every herdr probe is a no-op.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
// Distinct workspace id — the db/config singletons are shared across test files, so a
// unique dir keeps this file's rows from colliding with another file's.
const DIR_ID = "tags-dir";

let tasksMod: typeof import("../src/tasks.ts");
let dbMod: typeof import("../src/db.ts");
let taskmdMod: typeof import("../src/taskmd.ts");

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-tags-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-tags-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  // A real git repo with one commit so createTask's `git worktree add -b` works.
  const g = (args: string[]) =>
    execFileSync("git", ["-C", REPO_ROOT, ...args], { stdio: "ignore" });
  execFileSync("git", ["init", "-q", REPO_ROOT], { stdio: "ignore" });
  g(["config", "user.email", "test@butchr.local"]);
  g(["config", "user.name", "butchr test"]);
  g(["commit", "--allow-empty", "-q", "-m", "init"]);

  dbMod = await import("../src/db.ts");
  taskmdMod = await import("../src/taskmd.ts");
  tasksMod = await import("../src/tasks.ts");

  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(DIR_ID, REPO_ROOT, "test", dbMod.nowIso());
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

// ---- STORAGE / SERIALIZATION ----------------------------------------------

test("createTask stores tags: DB JSON, taskView/taskListView arrays, task.md round-trip", async () => {
  const v = await tasksMod.createTask(DIR_ID, "tagged work", [], [], "task", null, [
    "webapp",
    "core",
  ]);

  // Surfaced as a real string[] on the create view.
  expect(v.tags).toEqual(["webapp", "core"]);

  // Stored as JSON-array TEXT on the DB row.
  const row = dbMod.db
    .query<{ tags: string | null }, [string]>(`SELECT tags FROM tasks WHERE id=?`)
    .get(v.id)!;
  expect(JSON.parse(row.tags!)).toEqual(["webapp", "core"]);

  // taskView + taskListView both expose the parsed array.
  expect(tasksMod.taskView(v.id)!.tags).toEqual(["webapp", "core"]);
  const listed = tasksMod.taskListView(DIR_ID).find((t) => t.id === v.id)!;
  expect(listed.tags).toEqual(["webapp", "core"]);

  // Round-trips through the task.md front matter.
  const doc = taskmdMod.readTaskMd(REPO_ROOT, v.id);
  expect(doc.meta.tags).toEqual(["webapp", "core"]);
});

test("tags are normalized at creation: trimmed, de-duped, blanks dropped, order kept", async () => {
  const v = await tasksMod.createTask(DIR_ID, "messy tags", [], [], "task", null, [
    "  webapp ",
    "core",
    "webapp", // duplicate (after trim)
    "   ", // blank
    "docs",
  ]);
  expect(v.tags).toEqual(["webapp", "core", "docs"]);
});

test("a task created with no tags reports an empty array (never null/raw string)", async () => {
  const v = await tasksMod.createTask(DIR_ID, "untagged", []);
  expect(v.tags).toEqual([]);
  expect(tasksMod.taskListView(DIR_ID).find((t) => t.id === v.id)!.tags).toEqual([]);
  // task.md carries no `tags:` line, parsing back as [].
  expect(taskmdMod.readTaskMd(REPO_ROOT, v.id).meta.tags).toEqual([]);
});

test("validateTags rejects bad input and accepts/normalizes good input", () => {
  // Non-array.
  expect(() => tasksMod.validateTags("webapp")).toThrow(/array of strings/);
  // Array with a non-string member.
  expect(() => tasksMod.validateTags(["ok", 3])).toThrow(/array of strings/);
  // Over-long tag.
  expect(() => tasksMod.validateTags(["x".repeat(41)])).toThrow(/40 characters/);
  // Absent / empty → [].
  expect(tasksMod.validateTags(undefined)).toEqual([]);
  expect(tasksMod.validateTags(null)).toEqual([]);
  // Good input is normalized.
  expect(tasksMod.validateTags([" a ", "a", "b"])).toEqual(["a", "b"]);
});

test("createTask surfaces a tag-validation failure as a 400", async () => {
  let status: number | undefined;
  try {
    await tasksMod.createTask(DIR_ID, "bad tags", [], [], "task", null, [123 as unknown as string]);
  } catch (e) {
    status = (e as { status?: number }).status;
  }
  expect(status).toBe(400);
});

test("parseTags is tolerant: null/garbage → [], well-formed JSON → array", () => {
  expect(tasksMod.parseTags(null)).toEqual([]);
  expect(tasksMod.parseTags("not json")).toEqual([]);
  expect(tasksMod.parseTags("[]")).toEqual([]);
  expect(tasksMod.parseTags('["a","b"]')).toEqual(["a", "b"]);
  // Non-string members are filtered out.
  expect(tasksMod.parseTags('["a",2,"b"]')).toEqual(["a", "b"]);
});

// ---- FILTERING -------------------------------------------------------------

// The ANY-match predicate the webapp filter bar + CLI `ls --tag` apply: a task is
// kept if it carries at least one of the selected tags (empty selection = all). This
// mirrors taskMatchesFilter (app.js) / cmdLs's --tag filter (bin/butchr).
function filterByTags(tasks: { id: string; tags: string[] }[], selected: Set<string>) {
  if (selected.size === 0) return tasks;
  return tasks.filter((t) => t.tags.some((g) => selected.has(g)));
}

test("tag filtering selects tasks by ANY of the chosen tags", async () => {
  const fe = await tasksMod.createTask(DIR_ID, "fe", [], [], "task", null, ["webapp"]);
  const be = await tasksMod.createTask(DIR_ID, "be", [], [], "task", null, ["core"]);
  const both = await tasksMod.createTask(DIR_ID, "both", [], [], "task", null, ["webapp", "core"]);
  const docs = await tasksMod.createTask(DIR_ID, "docs", [], [], "task", null, ["docs"]);

  const mine = tasksMod
    .taskListView(DIR_ID)
    .filter((t) => [fe.id, be.id, both.id, docs.id].includes(t.id))
    .map((t) => ({ id: t.id, tags: t.tags }));

  // Single tag → tasks carrying it (incl. the multi-tag one).
  const webappOnly = filterByTags(mine, new Set(["webapp"])).map((t) => t.id).sort();
  expect(webappOnly).toEqual([both.id, fe.id].sort());

  // Multiple selected tags → union (ANY-match).
  const webappOrDocs = filterByTags(mine, new Set(["webapp", "docs"])).map((t) => t.id).sort();
  expect(webappOrDocs).toEqual([both.id, docs.id, fe.id].sort());

  // Empty selection → no filtering.
  expect(filterByTags(mine, new Set()).length).toBe(4);
});
