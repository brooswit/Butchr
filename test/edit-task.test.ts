// Tests for the IN-PLACE task prompt/context EDIT (tasks.editTask + the
// taskmd.updateTaskMdContext / updateTaskMdPrompt rewriters it drives). editTask is the
// operator surface for refining a PAUSED subtask instead of abort+recreate: it rewrites
// task.md (the on-disk source of truth for prompt + context) in place, preserving the
// Review Notes / Clarifications sections, and leaves grounding_fp untouched so the resume
// path's fingerprint comparison drives the reground.
//
// Pure / in-process: no real claude/herdr/bun/git is spawned (BUTCHR_HERDR_BIN points at
// `true`). editTask touches only task.md on disk, so we seed the workspace + task rows
// directly and write task.md with writeTaskMd — no createTask (which would need a live
// git repo). The db/config singletons are SHARED across test files, so we use distinct
// ids and assert only on our own rows.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
const WS = "edit-task-ws";

let dbMod: typeof import("../src/db.ts");
let tasksMod: typeof import("../src/tasks.ts");
let taskmdMod: typeof import("../src/taskmd.ts");

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-edit-task-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-edit-task-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  dbMod = await import("../src/db.ts");
  tasksMod = await import("../src/tasks.ts");
  taskmdMod = await import("../src/taskmd.ts");

  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(WS, REPO_ROOT, "edit-task", dbMod.nowIso());
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

/** Seed a task: a DB row + an on-disk task.md (prompt + context). */
function seed(
  id: string,
  status: string,
  prompt = "original prompt",
  context: string[] = ["a.ts", "b.ts"],
): void {
  dbMod.db
    .query(`INSERT INTO tasks (id, workspace_id, status, created_at) VALUES (?, ?, ?, ?)`)
    .run(id, WS, status, dbMod.nowIso());
  taskmdMod.writeTaskMd(
    REPO_ROOT,
    { id, created: dbMod.nowIso(), status: status as any, context, kind: "task" },
    prompt,
  );
}

/** Run a thunk and return the HttpError status it throws (or 0 if it didn't throw). */
function statusOf(fn: () => unknown): number {
  try {
    fn();
    return 0;
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
}

describe("editTask — happy paths", () => {
  test("prompt-only edit updates the prompt, leaves context untouched", () => {
    seed("e-prompt", "needs_info");
    const view = tasksMod.editTask("e-prompt", { prompt: "refined prompt" });
    expect(view.prompt).toBe("refined prompt");
    expect(view.context).toEqual(["a.ts", "b.ts"]);
    // task.md on disk round-trips the same way.
    const doc = taskmdMod.readTaskMd(REPO_ROOT, "e-prompt");
    expect(doc.prompt).toBe("refined prompt");
    expect(doc.meta.context).toEqual(["a.ts", "b.ts"]);
  });

  test("context-only edit updates the context list, leaves the prompt untouched", () => {
    seed("e-context", "in_review");
    const view = tasksMod.editTask("e-context", { context: ["x.ts", "y.ts", "z.ts"] });
    expect(view.context).toEqual(["x.ts", "y.ts", "z.ts"]);
    expect(view.prompt).toBe("original prompt");
    const doc = taskmdMod.readTaskMd(REPO_ROOT, "e-context");
    expect(doc.meta.context).toEqual(["x.ts", "y.ts", "z.ts"]);
    expect(doc.prompt).toBe("original prompt");
  });

  test("editing context to an empty list clears it (context: [])", () => {
    seed("e-clear", "needs_info");
    const view = tasksMod.editTask("e-clear", { context: [] });
    expect(view.context).toEqual([]);
    const doc = taskmdMod.readTaskMd(REPO_ROOT, "e-clear");
    expect(doc.meta.context).toEqual([]);
  });

  test("both prompt and context can be edited in one call", () => {
    seed("e-both", "needs_info");
    const view = tasksMod.editTask("e-both", {
      prompt: "new prompt",
      context: ["only.ts"],
    });
    expect(view.prompt).toBe("new prompt");
    expect(view.context).toEqual(["only.ts"]);
  });

  test("context entries are trimmed and blanks dropped", () => {
    seed("e-trim", "needs_info");
    const view = tasksMod.editTask("e-trim", { context: ["  keep.ts  ", "", "   "] });
    expect(view.context).toEqual(["keep.ts"]);
  });

  test("editing a live in_progress task is allowed (takes effect on next resume)", () => {
    seed("e-running", "in_progress");
    const view = tasksMod.editTask("e-running", { prompt: "tweaked while running" });
    expect(view.prompt).toBe("tweaked while running");
  });
});

describe("editTask — preservation + reground", () => {
  test("Review Notes and Clarifications survive an edit", () => {
    seed("e-preserve", "in_review");
    taskmdMod.appendRejection(REPO_ROOT, "e-preserve", "please fix the edge case", "2026-06-15T00:00:00Z");
    taskmdMod.appendAnswer(REPO_ROOT, "e-preserve", "which file?", "src/server.ts", "2026-06-15T00:01:00Z");

    tasksMod.editTask("e-preserve", { prompt: "p2", context: ["c2.ts"] });

    const doc = taskmdMod.readTaskMd(REPO_ROOT, "e-preserve");
    expect(doc.prompt).toBe("p2");
    expect(doc.meta.context).toEqual(["c2.ts"]);
    // The accumulated review notes + clarifications are untouched.
    expect(doc.reviewNotes).toContain("please fix the edge case");
    expect(doc.raw).toContain("## Clarifications");
    expect(doc.raw).toContain("src/server.ts");
    // Front matter still parses intact.
    expect(doc.meta.id).toBe("e-preserve");
    expect(doc.meta.kind).toBe("task");
  });

  test("the grounding fingerprint changes after an edit (drives the resume reground)", () => {
    seed("e-fp", "needs_info");
    const before = taskmdMod.groundingFingerprint(taskmdMod.readTaskMd(REPO_ROOT, "e-fp"));
    tasksMod.editTask("e-fp", { prompt: "changed", context: ["new.ts"] });
    const after = taskmdMod.groundingFingerprint(taskmdMod.readTaskMd(REPO_ROOT, "e-fp"));
    expect(after).not.toBe(before);
  });

  test("editTask does NOT touch grounding_fp on the row (the resume path compares it)", () => {
    seed("e-fp-row", "needs_info");
    dbMod.db.query(`UPDATE tasks SET grounding_fp=? WHERE id=?`).run("stale-fp", "e-fp-row");
    tasksMod.editTask("e-fp-row", { prompt: "changed" });
    const row = tasksMod.getTask("e-fp-row")!;
    expect(row.grounding_fp).toBe("stale-fp");
  });
});

describe("editTask — gating + validation", () => {
  test("404 when the task is gone", () => {
    expect(statusOf(() => tasksMod.editTask("nope", { prompt: "x" }))).toBe(404);
  });

  test("400 when neither prompt nor context is supplied", () => {
    seed("e-empty", "needs_info");
    expect(statusOf(() => tasksMod.editTask("e-empty", {}))).toBe(400);
  });

  test("400 when prompt is supplied but blank", () => {
    seed("e-blank", "needs_info");
    expect(statusOf(() => tasksMod.editTask("e-blank", { prompt: "   " }))).toBe(400);
  });

  test("400 when context is not an array of strings", () => {
    seed("e-badctx", "needs_info");
    expect(statusOf(() => tasksMod.editTask("e-badctx", { context: [1 as any] }))).toBe(400);
  });

  test("409 on a terminal (merged) task", () => {
    seed("e-merged", "merged");
    expect(statusOf(() => tasksMod.editTask("e-merged", { prompt: "x" }))).toBe(409);
  });

  test("409 on an aborted task", () => {
    seed("e-aborted", "aborted");
    expect(statusOf(() => tasksMod.editTask("e-aborted", { prompt: "x" }))).toBe(409);
  });

  test("409 on a rolling_back task (mid-rollback pipeline, not an operator's to refine)", () => {
    seed("e-rolling", "rolling_back");
    expect(statusOf(() => tasksMod.editTask("e-rolling", { prompt: "x" }))).toBe(409);
  });
});
