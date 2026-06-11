// Tests for butchr's PLAN-PREVIEW gate (see db.ts `plan_preview`,
// tasks.createTask(planPreview), taskmd.renderAgentPrompt's plan-preview protocol,
// and mcp.ts propose_plan). The gate REUSES the ASK -> NEEDS_INFO -> ANSWER ->
// RESUME handshake: a plan-preview agent proposes a plan via the MCP `propose_plan`
// tool, the task parks in `needs_info` holding the plan, the operator answers
// 'proceed', and the SAME claude session resumes to implement + request_review.
//
// In-process: no real claude or herdr is spawned. BUTCHR_HERDR_BIN points at `true`
// so every herdr probe (teardownTask et al.) is a harmless no-op. createTask exercises
// the REAL function (worktree + task.md + DB row), so we set up an actual throwaway
// git repo with one commit for `git worktree add`. The MCP tool calls go through the
// REAL handleMcp JSON-RPC transport — the "agent" is mocked by us issuing its calls.
//
// What this covers (the spec's required plan->needs_info->approve->resume path):
//   1. createTask(planPreview=true) stamps plan_preview on the DB row + task.md, and
//      renderAgentPrompt hands the FIRST launch the plan-preview protocol (propose_plan,
//      not request_review).
//   2. tools/list gating: a plan-preview task is offered propose_plan (+ request_review
//      + ask); an ordinary task is NOT offered propose_plan.
//   3. The agent calling propose_plan parks the task in needs_info holding the plan,
//      non-blocking (markNeedsInfoFromAgent core), and rejects a blank plan.
//   4. answerTask('proceed') re-queues the task PRESERVING session_id, and
//      resolveLaunchCommand resumes the SAME session — the implement phase.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
const DIR_ID = "plan-preview-dir";

let tasksMod: typeof import("../src/tasks.ts");
let dbMod: typeof import("../src/db.ts");
let taskmdMod: typeof import("../src/taskmd.ts");
let mcpMod: typeof import("../src/mcp.ts");
let dispatchMod: typeof import("../src/dispatcher.ts");

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-pp-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-pp-repo-"));

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
  mcpMod = await import("../src/mcp.ts");
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

function row(id: string) {
  return dbMod.db.query<any, [string]>(`SELECT * FROM tasks WHERE id=?`).get(id)!;
}

/** Issue one JSON-RPC POST at the per-task MCP endpoint and parse the result. */
async function rpc(taskId: string, method: string, params?: unknown): Promise<any> {
  const req = new Request(`http://127.0.0.1/mcp/${taskId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const res = await mcpMod.handleMcp(req, taskId);
  return res.json();
}

describe("createTask(planPreview) + renderAgentPrompt", () => {
  test("a plan-preview task is stamped on the row + task.md and gets the plan-preview protocol", async () => {
    const view = await tasksMod.createTask(
      DIR_ID,
      "Add a /metrics endpoint.",
      [],
      [],
      "task",
      null,
      [],
      0,
      true,
    );
    // Row + serialized view carry the flag.
    expect(row(view.id).plan_preview).toBe(1);
    expect((view as any).plan_preview).toBe(1);

    // task.md round-trips the flag in the front matter.
    const md = readFileSync(taskmdMod.taskMdPath(REPO_ROOT, view.id), "utf8");
    expect(md).toContain("plan_preview: true");
    const doc = taskmdMod.readTaskMd(REPO_ROOT, view.id);
    expect(doc.meta.plan_preview).toBe(true);

    // The FIRST rendered prompt hands the agent the plan-preview protocol: propose a
    // plan via propose_plan, NOT dive into the work + request_review.
    const prompt = taskmdMod.renderAgentPrompt(REPO_ROOT, doc);
    expect(prompt).toContain("propose_plan");
    expect(prompt).toContain("PLAN-PREVIEW");
  });

  test("an ordinary task is unaffected (no flag, no plan-preview protocol)", async () => {
    const view = await tasksMod.createTask(DIR_ID, "Ordinary work.", [], [], "task");
    expect(row(view.id).plan_preview).toBe(0);
    const doc = taskmdMod.readTaskMd(REPO_ROOT, view.id);
    const prompt = taskmdMod.renderAgentPrompt(REPO_ROOT, doc);
    expect(prompt).not.toContain("propose_plan");
    expect(prompt).toContain("request_review");
  });

  test("plan_preview must be a boolean (400 otherwise)", async () => {
    let err: any;
    try {
      await tasksMod.createTask(DIR_ID, "x", [], [], "task", null, [], 0, "yes" as any);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.status).toBe(400);
  });
});

describe("tools/list gating", () => {
  test("a plan-preview task is offered propose_plan; an ordinary task is not", async () => {
    const pp = await tasksMod.createTask(
      DIR_ID, "Gated task.", [], [], "task", null, [], 0, true,
    );
    const ord = await tasksMod.createTask(DIR_ID, "Plain task.", [], [], "task");

    const ppTools = (await rpc(pp.id, "tools/list")).result.tools.map((t: any) => t.name);
    const ordTools = (await rpc(ord.id, "tools/list")).result.tools.map((t: any) => t.name);

    expect(ppTools).toContain("propose_plan");
    expect(ppTools).toContain("request_review");
    expect(ppTools).toContain("ask");
    expect(ppTools).not.toContain("propose_subtasks");

    expect(ordTools).not.toContain("propose_plan");
    expect(ordTools).toContain("request_review");
  });
});

describe("plan -> needs_info -> approve -> resume (mock the agent)", () => {
  test("propose_plan parks the task needs_info holding the plan; answer resumes the SAME session", async () => {
    const SESSION = "pp-session-1111-2222-3333";
    const pp = await tasksMod.createTask(
      DIR_ID, "Refactor the cache layer.", [], [], "task", null, [], 0, true,
    );
    // Simulate the agent having launched: stamp it in_progress with a session id + pane,
    // exactly as markRunning would after the first dispatch.
    dbMod.db
      .query(
        `UPDATE tasks SET status='in_progress', session_id=?, herdr_pane_id=?, started_at=? WHERE id=?`,
      )
      .run(SESSION, "pane-9", dbMod.nowIso(), pp.id);

    // The agent (mocked) calls propose_plan with its implementation plan.
    const PLAN =
      "1. Extract the cache into src/cache.ts. 2. Add an LRU bound. 3. Wire callers.";
    const out = await rpc(pp.id, "tools/call", {
      name: "propose_plan",
      arguments: { plan: PLAN },
    });
    // Non-blocking tool result reports needs_info.
    const payload = JSON.parse(out.result.content[0].text);
    expect(out.result.isError).toBe(false);
    expect(payload.status).toBe("needs_info");

    // The task parked in needs_info, holding the plan; the pane was cleared (the
    // agent exits) and the session id is preserved for the resume.
    const parked = row(pp.id);
    expect(parked.status).toBe("needs_info");
    expect(parked.question).toBe(PLAN);
    expect(parked.herdr_pane_id).toBeNull();
    expect(parked.session_id).toBe(SESSION);

    // The operator approves with a 'proceed' decision.
    const answered = await tasksMod.answerTask(pp.id, "proceed");
    expect(answered.status).toBe("in_progress");
    const requeued = row(pp.id);
    expect(requeued.answer).toBe("proceed");
    expect(requeued.question).toBeNull();
    expect(requeued.session_id).toBe(SESSION); // resume, not fresh

    // The implement phase resumes the SAME claude session (--resume), and the answer
    // prompt carries the review protocol so the agent implements + request_review.
    const plan = dispatchMod.resolveLaunchCommand(
      { started_at: requeued.started_at, session_id: requeued.session_id, model: requeued.model } as any,
      "/data/prompts/t.md",
      "/data/mcp/t.json",
    );
    expect(plan.isResume).toBe(true);
    expect(plan.sessionId).toBe(SESSION);
    expect(plan.agentCmd).toContain(`--resume ${SESSION}`);

    const answerPrompt = taskmdMod.renderAnswerPrompt("proceed");
    expect(answerPrompt).toContain("proceed");
    expect(answerPrompt).toContain("request_review");
  });

  test("a blank plan is rejected (isError) and the task stays in_progress", async () => {
    const pp = await tasksMod.createTask(
      DIR_ID, "Another gated task.", [], [], "task", null, [], 0, true,
    );
    dbMod.db
      .query(`UPDATE tasks SET status='in_progress', session_id=?, started_at=? WHERE id=?`)
      .run("s", dbMod.nowIso(), pp.id);

    const out = await rpc(pp.id, "tools/call", {
      name: "propose_plan",
      arguments: { plan: "   " },
    });
    expect(out.result.isError).toBe(true);
    // Not parked — the agent is expected to re-propose a real plan.
    expect(row(pp.id).status).toBe("in_progress");
  });
});
