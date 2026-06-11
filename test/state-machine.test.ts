// Tests for the CANONICAL 9-STATE TASK STATE MACHINE (the CEO's exact model) and the
// UNIFIED FEEDBACK MECHANISM. Covers:
//   1. STATE METADATA — every state's kind (idle|agent|feedback) and, for agent states,
//      its agentType (ceo-agent|workspace-agent), via db.STATE_META, plus db.isTerminal.
//   2. THE spec_review GATE — idea → spec_review (NOT auto-build); approve → in_progress;
//      request-changes → idea (revise the spec, re-running the CEO/CTO-fork generator).
//   3. in_review APPROVE → finalizing → merged (the workspace agent's 'final thoughts'
//      then the system finalize).
//   4. needs_info ROUND-TRIP — an agent asks (markNeedsInfoFromAgent) → answer → resume.
//   5. THE UNIFIED FEEDBACK MECHANISM — feedbackInfo + respondToFeedback drive all three
//      feedback states through one code path (artifact → response → forward/resume).
//
// In-process: no real claude or herdr (BUTCHR_HERDR_BIN=true). The CTO-fork spec writer
// is mocked (setSpecWriter) and the conformance runner silenced; gate_cmd="" disables
// the CI + post-merge verify gates so review/merge never shell out a real build.
// createTask runs for real (worktree + task.md + DB row), so we set up a throwaway repo.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
const DIR_ID = "sm-dir";

let tasksMod: typeof import("../src/tasks.ts");
let dbMod: typeof import("../src/db.ts");
let taskmdMod: typeof import("../src/taskmd.ts");
let ctoMod: typeof import("../src/cto.ts");
let dispatcherMod: typeof import("../src/dispatcher.ts");
let conformanceMod: typeof import("../src/conformance.ts");

function g(args: string[], cwd = REPO_ROOT): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}
function row(id: string) {
  return dbMod.db.query<any, [string]>(`SELECT * FROM tasks WHERE id=?`).get(id)!;
}
function dirRow() {
  return dbMod.db.query<any, [string]>(`SELECT * FROM directories WHERE id=?`).get(DIR_ID)!;
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-sm-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-sm-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  execFileSync("git", ["init", "-q", REPO_ROOT], { stdio: "ignore" });
  g(["config", "user.email", "test@butchr.local"]);
  g(["config", "user.name", "butchr test"]);
  writeFileSync(join(REPO_ROOT, "README.md"), "base\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "init"]);

  dbMod = await import("../src/db.ts");
  taskmdMod = await import("../src/taskmd.ts");
  tasksMod = await import("../src/tasks.ts");
  ctoMod = await import("../src/cto.ts");
  dispatcherMod = await import("../src/dispatcher.ts");
  conformanceMod = await import("../src/conformance.ts");

  dbMod.db
    .query(`INSERT INTO directories (id, path, label, gate_cmd, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(DIR_ID, REPO_ROOT, "test", "", dbMod.nowIso());
  conformanceMod.setConformanceRunner(async () => null);
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

// Drive a task all the way to a committed in_progress build awaiting markReviewFromAgent.
async function buildReadyTask(prompt: string, file: string, content: string): Promise<string> {
  const v = await tasksMod.createTask(DIR_ID, prompt);
  // A 'New task' (with a spec) starts READY in in_progress (no live agent yet).
  expect(v.status).toBe("in_progress");
  // Simulate the dispatcher launching the build agent (records the pane → running).
  tasksMod.markRunning(v.id, `pane-${v.id}`, `sess-${v.id}`, `tab-${v.id}`);
  const wt = join(REPO_ROOT, v.id);
  writeFileSync(join(wt, file), content);
  g(["add", "-A"], wt);
  g(["commit", "-q", "-m", `work ${v.id}`], wt);
  return v.id;
}

describe("1. state metadata (kind + agentType per state)", () => {
  test("STATE_META categorizes every canonical state exactly", () => {
    const M = dbMod.STATE_META;
    expect(M.idea).toEqual({ kind: "agent", agentType: "ceo-agent" });
    expect(M.spec_review).toEqual({ kind: "feedback" });
    expect(M.blocked).toEqual({ kind: "idle" });
    expect(M.needs_info).toEqual({ kind: "feedback" });
    expect(M.in_progress).toEqual({ kind: "agent", agentType: "workspace-agent" });
    expect(M.in_review).toEqual({ kind: "feedback" });
    expect(M.finalizing).toEqual({ kind: "agent", agentType: "workspace-agent" });
    expect(M.merged).toEqual({ kind: "idle" });
    expect(M.aborted).toEqual({ kind: "idle" });
    // Exactly the nine canonical states, no more.
    expect(dbMod.ALL_STATUSES.length).toBe(9);
    expect(Object.keys(M).sort()).toEqual([...dbMod.ALL_STATUSES].sort());
  });

  test("isTerminal identifies exactly the two terminal states", () => {
    expect(dbMod.isTerminal("merged")).toBe(true);
    expect(dbMod.isTerminal("aborted")).toBe(true);
    expect(dbMod.isTerminal("in_progress")).toBe(false);
  });

  test("feedbackInfo surfaces each feedback state's artifact + accepted responses", () => {
    expect(tasksMod.feedbackInfo("spec_review")).toMatchObject({
      artifact: "spec",
      accepts: ["approve", "request_changes"],
    });
    expect(tasksMod.feedbackInfo("in_review")).toMatchObject({
      artifact: "diff",
      accepts: ["approve", "request_changes"],
    });
    expect(tasksMod.feedbackInfo("needs_info")).toMatchObject({
      artifact: "question",
      accepts: ["answer"],
    });
    // Non-feedback states have no feedback info.
    expect(tasksMod.feedbackInfo("in_progress")).toBeNull();
    expect(tasksMod.feedbackInfo("idea")).toBeNull();
    expect(tasksMod.feedbackInfo("merged")).toBeNull();
  });
});

describe("2. the spec_review gate (idea → spec_review, NOT auto-build)", () => {
  test("an idea generates a spec and STOPS in spec_review (does not auto-build)", async () => {
    const SPEC = "Add a spec_review.txt file containing the word reviewed.";
    ctoMod.setSpecWriter(async () => SPEC);
    const idea = await tasksMod.createTask(DIR_ID, "make a spec_review file", [], [], "task", null, [], 0, false, true);
    expect(row(idea.id).status).toBe("idea");

    await dispatcherMod.generateSpecForIdea(dirRow(), row(idea.id));

    // It parks in spec_review carrying the spec as its prompt — it did NOT advance to
    // in_progress on its own.
    const after = tasksMod.taskView(idea.id)!;
    expect(after.status).toBe("spec_review");
    expect(after.prompt).toBe(SPEC);
    const md = readFileSync(taskmdMod.taskMdPath(REPO_ROOT, idea.id), "utf8");
    expect(md).toContain("status: spec_review");
  });

  test("approving the spec FORWARDS to in_progress (ready to build)", async () => {
    ctoMod.setSpecWriter(async () => "Add approved_spec.txt with the word ok.");
    const idea = await tasksMod.createTask(DIR_ID, "approve me", [], [], "task", null, [], 0, false, true);
    await dispatcherMod.generateSpecForIdea(dirRow(), row(idea.id));
    expect(row(idea.id).status).toBe("spec_review");

    const out = await tasksMod.approveTask(idea.id);
    expect(out.task.status).toBe("in_progress");
    // Ready — no live agent yet (the dispatcher will launch it).
    expect(row(idea.id).herdr_pane_id).toBeNull();
  });

  test("requesting spec changes sends it BACK to idea and re-generates with the notes", async () => {
    let calls = 0;
    let sawNotes: string | undefined;
    ctoMod.setSpecWriter(async (input) => {
      calls++;
      sawNotes = input.notes;
      return `Spec v${calls}: add specrev_${calls}.txt`;
    });
    const idea = await tasksMod.createTask(DIR_ID, "needs revision", [], [], "task", null, [], 0, false, true);
    await dispatcherMod.generateSpecForIdea(dirRow(), row(idea.id));
    expect(row(idea.id).status).toBe("spec_review");
    expect(calls).toBe(1);

    // Request changes → back to idea (revise).
    const view = await tasksMod.rejectTask(idea.id, "Please also add error handling.");
    expect(view.status).toBe("idea");
    expect(row(idea.id).review_note).toContain("error handling");

    // Re-run the CEO agent: it sees the change notes and produces a revised spec → spec_review again.
    await dispatcherMod.generateSpecForIdea(dirRow(), row(idea.id));
    expect(calls).toBe(2);
    expect(sawNotes).toContain("error handling");
    expect(row(idea.id).status).toBe("spec_review");
    expect(tasksMod.taskView(idea.id)!.prompt).toContain("Spec v2");
  });

  test("spec_review rejects an `answer` response (it awaits approve/request-changes)", async () => {
    ctoMod.setSpecWriter(async () => "Add x.txt");
    const idea = await tasksMod.createTask(DIR_ID, "wrong response", [], [], "task", null, [], 0, false, true);
    await dispatcherMod.generateSpecForIdea(dirRow(), row(idea.id));
    let err: any;
    try {
      await tasksMod.answerTask(idea.id, "an answer");
    } catch (e) {
      err = e;
    }
    expect(err?.status).toBe(409);
    expect(row(idea.id).status).toBe("spec_review");
  });
});

describe("3. in_review approve → finalizing → merged", () => {
  test("approve forwards in_review to finalizing; the finalize agent's request_review then merges", async () => {
    const id = await buildReadyTask("build a thing", "thing.txt", "thing\n");
    // Build agent submits → in_review.
    expect(tasksMod.markReviewFromAgent(id, "done")).toBe("ok");
    expect(row(id).status).toBe("in_review");

    // Approve → finalizing (NOT merged yet — the workspace agent does final thoughts first).
    const out = await tasksMod.approveTask(id);
    expect(out.task.status).toBe("finalizing");
    expect(out.task.merged_sha == null).toBe(true);

    // The dispatcher launches the finalize agent (records the pane).
    tasksMod.markRunning(id, `pane-fin-${id}`, `sess-${id}`, `tab-fin-${id}`);
    expect(row(id).status).toBe("finalizing");

    // The finalize ('final thoughts') agent calls request_review → markReviewFromAgent
    // kicks finalizeMerge off (fire-and-forget). Poll briefly for the merge to land.
    const tipBefore = g(["rev-parse", "HEAD"]);
    const state = tasksMod.markReviewFromAgent(id, "wrapped up");
    expect(state).toBe("ok");
    for (let i = 0; i < 100 && row(id).status !== "merged"; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(row(id).status).toBe("merged");
    expect(g(["rev-parse", "HEAD"])).not.toBe(tipBefore);
    expect(existsSync(join(REPO_ROOT, "thing.txt"))).toBe(true);

    // The transition timeline reflects the happy path.
    const flow = dbMod.listTaskEvents(id).map((e) => e.to_status);
    expect(flow).toContain("in_review");
    expect(flow).toContain("finalizing");
    expect(flow[flow.length - 1]).toBe("merged");
  });

  test("a finalize agent that just ends (no request_review) still finalizes via finalizeMerge", async () => {
    const id = await buildReadyTask("auto-finalize", "auto.txt", "auto\n");
    tasksMod.markReviewFromAgent(id, "done");
    await tasksMod.approveTask(id);
    expect(row(id).status).toBe("finalizing");
    // Simulate the watcher/recovery path: finalize directly.
    const out = await tasksMod.finalizeMerge(id);
    expect(out.task.status).toBe("merged");
  });
});

describe("4. needs_info round-trip (any agent stage → ask → answer → resume)", () => {
  test("an in_progress agent asks → needs_info; answering resumes it to in_progress", async () => {
    const id = await buildReadyTask("ask me", "q.txt", "q\n");
    expect(row(id).status).toBe("in_progress");

    // The agent calls the MCP `ask` tool.
    const state = tasksMod.markNeedsInfoFromAgent(id, "Per-user or global cache?");
    expect(state).toBe("ok");
    expect(row(id).status).toBe("needs_info");
    expect(row(id).question).toBe("Per-user or global cache?");
    expect(row(id).herdr_pane_id).toBeNull();

    // Answering resumes the SAME session: back to in_progress (ready), answer stored,
    // question cleared, session_id preserved.
    const view = await tasksMod.answerTask(id, "Per-user.");
    expect(view.status).toBe("in_progress");
    expect(row(id).answer).toBe("Per-user.");
    expect(row(id).question).toBeNull();
    expect(row(id).session_id).toBe(`sess-${id}`);

    const md = readFileSync(taskmdMod.taskMdPath(REPO_ROOT, id), "utf8");
    expect(md).toContain("Clarifications");
    expect(md).toContain("Per-user.");
  });
});

describe("5. the unified feedback mechanism (one code path)", () => {
  test("respondToFeedback drives spec_review/in_review/needs_info through one entry point", async () => {
    // spec_review approve via respondToFeedback.
    ctoMod.setSpecWriter(async () => "Add unified.txt");
    const a = await tasksMod.createTask(DIR_ID, "unified spec", [], [], "task", null, [], 0, false, true);
    await dispatcherMod.generateSpecForIdea(dirRow(), row(a.id));
    const r1 = await tasksMod.respondToFeedback(a.id, { type: "approve" });
    expect(r1.task.status).toBe("in_progress");

    // in_review request_changes via respondToFeedback → resume the agent (in_progress).
    const b = await buildReadyTask("unified review", "u2.txt", "u2\n");
    tasksMod.markReviewFromAgent(b, "done");
    const r2 = await tasksMod.respondToFeedback(b, { type: "request_changes", note: "tweak it" });
    expect(r2.task.status).toBe("in_progress");
    expect(row(b).review_note).toContain("tweak it");

    // needs_info answer via respondToFeedback → resume.
    const c = await buildReadyTask("unified ask", "u3.txt", "u3\n");
    tasksMod.markNeedsInfoFromAgent(c, "which?");
    const r3 = await tasksMod.respondToFeedback(c, { type: "answer", answer: "this one" });
    expect(r3.task.status).toBe("in_progress");
  });

  test("respondToFeedback rejects a non-feedback task and a wrong response type", async () => {
    const id = await buildReadyTask("not feedback", "nf.txt", "nf\n");
    // in_progress is an agent state, not feedback.
    let err: any;
    try {
      await tasksMod.respondToFeedback(id, { type: "approve" });
    } catch (e) {
      err = e;
    }
    expect(err?.status).toBe(409);

    // in_review does not accept `answer`.
    tasksMod.markReviewFromAgent(id, "done");
    let err2: any;
    try {
      await tasksMod.respondToFeedback(id, { type: "answer", answer: "x" });
    } catch (e) {
      err2 = e;
    }
    expect(err2?.status).toBe(409);
    expect(row(id).status).toBe("in_review");
  });
});
