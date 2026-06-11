// Regression test for butchr's ASK -> NEEDS_INFO -> ANSWER -> RESUME path —
// the unified non-blocking handshake that replaced the old auto-answer-via-CTO
// mechanism (src/cto.ts, now retired).
//
// Like reject-resume.test.ts this covers ONLY the pure / in-process logic: a butchr
// task agent's sandbox has no live claude or herdr, so nothing spawns a real agent
// or talks to a real herdr. BUTCHR_HERDR_BIN=true points the herdr binary at the
// `true` binary (exits 0, empty stdout), so every herdr probe resolves to "not
// found" and teardownTask becomes a no-op. The actual `claude --resume` re-entry is
// verified separately by the operator (it needs a live stack).
//
// What this exercises:
//   1. tasks.markNeedsInfoFromAgent — the MCP `ask` tool's core: in_progress ->
//      needs_info, stores the question, clears the pane (the agent exits), and
//      reports terminal/notfound for non-running tasks. NON-blocking, no CTO Claude.
//   2. tasks.answerTask — answer validation, needs_info -> in_progress transition,
//      answer persistence (the `answer` column the dispatcher injects), question
//      clearing, task.md Q&A logging, and (critically) that session_id is PRESERVED
//      so the dispatcher will `--resume` rather than start fresh.
//   3. taskmd.renderAnswerPrompt — the focused answer-resume prompt the relaunched
//      agent reads, including the answer text and the review protocol.
//   4. dispatcher.resolveLaunchCommand on the answered row — proving the re-queued
//      task resumes the SAME session (the relaunch the operator/real stack runs).
//
// Env is set before a dynamic import so config/db read our temp paths.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
const DIR_ID = "test-dir-ask";

let tasksMod: typeof import("../src/tasks.ts");
let dbMod: typeof import("../src/db.ts");
let taskmdMod: typeof import("../src/taskmd.ts");
let dispatchMod: typeof import("../src/dispatcher.ts");

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  dbMod = await import("../src/db.ts");
  taskmdMod = await import("../src/taskmd.ts");
  tasksMod = await import("../src/tasks.ts");
  dispatchMod = await import("../src/dispatcher.ts");

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

/**
 * Seed a task: a DB row plus its on-disk task.md. A `started_at` is stamped so the
 * task looks like one that has already run an agent (so the answer-resume path sees a
 * rework, not a fresh dispatch). Returns the task id.
 */
function seedTask(opts: {
  id: string;
  status: string;
  sessionId?: string | null;
  paneId?: string | null;
}): string {
  const created = dbMod.nowIso();
  dbMod.db
    .query(
      `INSERT INTO tasks (id, directory_id, status, session_id, herdr_pane_id, started_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.id,
      DIR_ID,
      opts.status,
      opts.sessionId ?? null,
      opts.paneId ?? null,
      created,
      created,
    );
  taskmdMod.writeTaskMd(
    REPO_ROOT,
    { id: opts.id, created, status: opts.status as any, context: [] },
    `Implement feature for ${opts.id}.`,
  );
  taskmdMod.updateTaskMdStatus(REPO_ROOT, opts.id, opts.status as any);
  return opts.id;
}

function dbRow(id: string) {
  return dbMod.db
    .query<any, [string]>(`SELECT * FROM tasks WHERE id=?`)
    .get(id)!;
}

describe("markNeedsInfoFromAgent (the `ask` tool core)", () => {
  test("in_progress -> needs_info: stores the question, clears the pane", () => {
    const id = seedTask({
      id: "ask-ok",
      status: "in_progress",
      sessionId: "sess-ask-1",
      paneId: "pane-7",
    });
    const question = "Should the cache be per-user or global?";

    const state = tasksMod.markNeedsInfoFromAgent(id, question);
    expect(state).toBe("ok");

    const row = dbRow(id);
    expect(row.status).toBe("needs_info");
    expect(row.question).toBe(question);
    // The agent is exiting — no live pane is held for a needs_info task.
    expect(row.herdr_pane_id).toBeNull();
    // Session id is untouched (it's what the answer-resume will `--resume`).
    expect(row.session_id).toBe("sess-ask-1");

    // task.md mirrors the new status.
    const md = readFileSync(taskmdMod.taskMdPath(REPO_ROOT, id), "utf8");
    expect(md).toContain("status: needs_info");
  });

  test("a duplicate ask (already needs_info) stays ok and keeps the question", () => {
    const id = seedTask({ id: "ask-dup", status: "in_progress", sessionId: "sess-dup" });
    expect(tasksMod.markNeedsInfoFromAgent(id, "first?")).toBe("ok");
    expect(tasksMod.markNeedsInfoFromAgent(id, "second?")).toBe("ok");
    const row = dbRow(id);
    expect(row.status).toBe("needs_info");
    expect(row.question).toBe("second?");
  });

  test("a terminal task reports `terminal` and is left untouched", () => {
    for (const status of ["merged", "aborted"]) {
      const id = seedTask({ id: `ask-term-${status}`, status });
      expect(tasksMod.markNeedsInfoFromAgent(id, "q?")).toBe("terminal");
      expect(dbRow(id).status).toBe(status);
      expect(dbRow(id).question).toBeNull();
    }
  });

  test("an unknown task reports `notfound`", () => {
    expect(tasksMod.markNeedsInfoFromAgent("no-such", "q?")).toBe("notfound");
  });
});

describe("answerTask", () => {
  test("needs_info -> in_progress: stores answer, clears question, PRESERVES session_id", async () => {
    const SESSION = "sess-answer-aaaa-bbbb";
    const id = seedTask({ id: "ans-ok", status: "in_progress", sessionId: SESSION });
    tasksMod.markNeedsInfoFromAgent(id, "Per-user or global cache?");

    const answer = "Per-user — keyed by the authenticated user id.";
    const view = await tasksMod.answerTask(id, answer);

    // Re-queued for the --resume relaunch.
    expect(view.status).toBe("in_progress");
    const row = dbRow(id);
    expect(row.status).toBe("in_progress");
    // The answer is held for the dispatcher to inject; the question is cleared.
    expect(row.answer).toBe(answer);
    expect(row.question).toBeNull();
    // The whole point of resume: the session id is untouched.
    expect(row.session_id).toBe(SESSION);

    // task.md records the Q&A and the in_progress status.
    const md = readFileSync(taskmdMod.taskMdPath(REPO_ROOT, id), "utf8");
    expect(md).toContain("Clarifications");
    expect(md).toContain("Per-user or global cache?");
    expect(md).toContain(answer);
    expect(md).toContain("status: in_progress");
  });

  test("answering a task NOT in needs_info errors with 409", async () => {
    for (const status of ["in_progress", "in_review", "merged"]) {
      const id = seedTask({ id: `ans-bad-${status}`, status, sessionId: "s" });
      let err: any;
      try {
        await tasksMod.answerTask(id, "an answer");
      } catch (e) {
        err = e;
      }
      expect(err).toBeDefined();
      expect(err.status).toBe(409);
      expect(dbRow(id).status).toBe(status);
    }
  });

  test("empty / whitespace answer is rejected with 400; task stays needs_info", async () => {
    const id = seedTask({ id: "ans-empty", status: "in_progress", sessionId: "s" });
    tasksMod.markNeedsInfoFromAgent(id, "q?");
    for (const bad of ["", "   ", "\n\t "]) {
      let err: any;
      try {
        await tasksMod.answerTask(id, bad);
      } catch (e) {
        err = e;
      }
      expect(err).toBeDefined();
      expect(err.status).toBe(400);
    }
    const row = dbRow(id);
    expect(row.status).toBe("needs_info");
    expect(row.question).toBe("q?");
    expect(row.answer).toBeNull();
  });

  test("answering a nonexistent task errors with 404", async () => {
    let err: any;
    try {
      await tasksMod.answerTask("no-such-task", "answer");
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.status).toBe(404);
  });
});

describe("renderAnswerPrompt", () => {
  test("includes the answer verbatim and points the agent back at request_review", () => {
    const answer = "Use the per-user cache; invalidate it on logout.";
    const prompt = taskmdMod.renderAnswerPrompt(answer);
    expect(prompt).toContain("Answer to your question");
    expect(prompt).toContain(answer);
    expect(prompt).toContain("request_review");
  });
});

describe("answer-resume relaunch (dispatcher.resolveLaunchCommand)", () => {
  // After answerTask the row is in_progress, carries an `answer`, and keeps started_at +
  // session_id — so the dispatcher resumes the SAME claude session and injects the
  // answer prompt. We assert resolveLaunchCommand picks the --resume path; the
  // answer-vs-rework prompt selection itself is renderAnswerPrompt (above).
  test("an answered task resumes its existing session via --resume", async () => {
    const SESSION = "11111111-2222-3333-4444-aaaaaaaaaaaa";
    const id = seedTask({ id: "ans-resume", status: "in_progress", sessionId: SESSION });
    tasksMod.markNeedsInfoFromAgent(id, "Which db?");
    await tasksMod.answerTask(id, "SQLite.");

    const row = dbRow(id);
    expect(row.answer).toBe("SQLite.");
    const plan = dispatchMod.resolveLaunchCommand(
      { started_at: row.started_at, session_id: row.session_id, model: row.model } as any,
      "/data/prompts/t.md",
      "/data/mcp/t.json",
    );
    expect(plan.isResume).toBe(true);
    expect(plan.sessionId).toBe(SESSION);
    expect(plan.agentCmd).toContain(`--resume ${SESSION}`);
  });
});
