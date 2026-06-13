// Tests for the CANONICAL 12-STATE TASK STATE MACHINE (the CEO's exact model) and the
// UNIFIED FEEDBACK MECHANISM. Covers:
//   1. STATE METADATA — every state's kind (idle|agent|feedback) and, for agent states,
//      its agentType (workspace-agent), via db.STATE_META, plus db.isTerminal.
//   2. THE idea/spec_review GATES — idea is a WAITING/feedback state; submitSpec advances
//      idea → spec_review (NOT auto-build); approve → inactive (ready); request-changes →
//      idea (revise → await a new spec).
//   3. in_review APPROVE → MECHANICAL MERGE → merged (no finalize agent — butchr rebases,
//      gates, and merges directly on approve).
//   4. needs_info ROUND-TRIP — an agent asks (markNeedsInfoFromAgent) → answer → resume
//      (→ inactive).
//   5. THE UNIFIED FEEDBACK MECHANISM — feedbackInfo + respondToFeedback drive all four
//      feedback states through one code path (artifact → response → forward/resume).
//
// In-process: no real claude or herdr (BUTCHR_HERDR_BIN=true). The spec is submitted via
// the public submitSpec API (no fork to mock) and the conformance runner is silenced;
// gate_cmd="" disables the CI + post-merge verify gates so review/merge never shell out a
// real build. createTask runs for real (worktree + task.md + DB row), so we set up a
// throwaway repo.
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
let conformanceMod: typeof import("../src/conformance.ts");

function g(args: string[], cwd = REPO_ROOT): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}
function row(id: string) {
  return dbMod.db.query<any, [string]>(`SELECT * FROM tasks WHERE id=?`).get(id)!;
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
  conformanceMod = await import("../src/conformance.ts");

  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, gate_cmd, created_at) VALUES (?, ?, ?, ?, ?)`)
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
  // A 'New task' (with a spec) starts READY in `inactive` (no live agent yet).
  expect(v.status).toBe("inactive");
  // Simulate the dispatcher launching the build agent (records the pane → in_progress).
  tasksMod.markRunning(v.id, `pane-${v.id}`, `sess-${v.id}`, `tab-${v.id}`);
  expect(row(v.id).status).toBe("in_progress");
  const wt = join(REPO_ROOT, v.id);
  writeFileSync(join(wt, file), content);
  g(["add", "-A"], wt);
  g(["commit", "-q", "-m", `work ${v.id}`], wt);
  return v.id;
}

describe("1. state metadata (kind + agentType per state)", () => {
  test("STATE_META categorizes every canonical state exactly", () => {
    const M = dbMod.STATE_META;
    expect(M.idea).toEqual({ kind: "feedback" });
    expect(M.spec_review).toEqual({ kind: "feedback" });
    expect(M.blocked).toEqual({ kind: "idle" });
    expect(M.needs_info).toEqual({ kind: "feedback" });
    expect(M.inactive).toEqual({ kind: "agent", agentType: "workspace-agent" });
    expect(M.in_progress).toEqual({ kind: "agent", agentType: "workspace-agent" });
    expect(M.in_review).toEqual({ kind: "feedback" });
    expect(M.rolling_back).toEqual({ kind: "idle" });
    expect(M.rolled_back).toEqual({ kind: "idle" });
    expect(M.merged).toEqual({ kind: "idle" });
    expect(M.failed).toEqual({ kind: "idle" });
    expect(M.aborted).toEqual({ kind: "idle" });
    // Exactly the twelve canonical states, no more (finalizing was removed).
    expect(dbMod.ALL_STATUSES.length).toBe(12);
    expect(M.finalizing).toBeUndefined();
    expect(Object.keys(M).sort()).toEqual([...dbMod.ALL_STATUSES].sort());
  });

  test("isTerminal identifies exactly the four terminal states", () => {
    expect(dbMod.isTerminal("merged")).toBe(true);
    expect(dbMod.isTerminal("failed")).toBe(true);
    expect(dbMod.isTerminal("rolled_back")).toBe(true);
    expect(dbMod.isTerminal("aborted")).toBe(true);
    expect(dbMod.isTerminal("rolling_back")).toBe(false);
    expect(dbMod.isTerminal("inactive")).toBe(false);
    expect(dbMod.isTerminal("in_progress")).toBe(false);
    // ALL_STATUSES.filter(isTerminal) is the single source the reaper derives its
    // terminal SQL/Set from — assert it equals the canonical four.
    expect(dbMod.ALL_STATUSES.filter(dbMod.isTerminal).sort()).toEqual(
      ["aborted", "failed", "merged", "rolled_back"].sort(),
    );
  });

  test("REVIEW_STATES / ATTENTION_STATES are well-formed subsets of ALL_STATUSES", () => {
    const all = new Set(dbMod.ALL_STATUSES);
    // Every member is a real canonical status (compile-checked too, via `satisfies`).
    for (const s of dbMod.REVIEW_STATES) expect(all.has(s)).toBe(true);
    for (const s of dbMod.ATTENTION_STATES) expect(all.has(s)).toBe(true);
    // REVIEW_STATES ⊆ ATTENTION_STATES.
    const attention = new Set(dbMod.ATTENTION_STATES);
    for (const s of dbMod.REVIEW_STATES) expect(attention.has(s)).toBe(true);
    // ATTENTION_STATES === REVIEW_STATES ∪ {idea, aborted}.
    expect([...dbMod.ATTENTION_STATES].sort()).toEqual(
      [...new Set([...dbMod.REVIEW_STATES, "idea", "aborted"])].sort(),
    );
    // The operator pull-signal set, exactly.
    expect([...dbMod.REVIEW_STATES].sort()).toEqual(
      ["failed", "in_review", "needs_info", "spec_review"].sort(),
    );
  });

  test("sumStatuses sums the counts for a membership set (missing keys = 0)", () => {
    const counts = { spec_review: 2, in_review: 1, needs_info: 3, failed: 4, merged: 9 };
    // Identical to the open-coded operator needs-attention sum it replaces.
    expect(dbMod.sumStatuses(counts, dbMod.REVIEW_STATES)).toBe(2 + 1 + 3 + 4);
    expect(dbMod.sumStatuses({}, dbMod.REVIEW_STATES)).toBe(0);
  });

  test("feedbackInfo surfaces each feedback state's artifact + accepted responses", () => {
    // `idea` is now a feedback state: a brief awaiting a submitted spec.
    expect(tasksMod.feedbackInfo("idea")).toMatchObject({
      artifact: "brief",
      accepts: ["submit_spec"],
    });
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
    expect(tasksMod.feedbackInfo("inactive")).toBeNull();
    expect(tasksMod.feedbackInfo("in_progress")).toBeNull();
    expect(tasksMod.feedbackInfo("merged")).toBeNull();
  });
});

describe("2. the idea/spec_review gates (idea waits for a spec, then spec_review)", () => {
  test("idea is a waiting/feedback state: submitSpec advances it to spec_review (no auto-build)", async () => {
    const SPEC = "Add a spec_review.txt file containing the word reviewed.";
    const idea = await tasksMod.createTask(DIR_ID, "make a spec_review file", [], [], "task", null, [], 0, false, true);
    expect(row(idea.id).status).toBe("idea");
    // It is a WAITING state — no agent was launched (no pane/session).
    expect(row(idea.id).herdr_pane_id).toBeNull();
    expect(row(idea.id).session_id).toBeNull();

    await tasksMod.submitSpec(idea.id, SPEC);

    // It parks in spec_review carrying the spec as its prompt — it did NOT advance to
    // inactive on its own.
    const after = tasksMod.taskView(idea.id)!;
    expect(after.status).toBe("spec_review");
    expect(after.prompt).toBe(SPEC);
    const md = readFileSync(taskmdMod.taskMdPath(REPO_ROOT, idea.id), "utf8");
    expect(md).toContain("status: spec_review");
  });

  test("approving the spec FORWARDS to inactive (ready to build)", async () => {
    const idea = await tasksMod.createTask(DIR_ID, "approve me", [], [], "task", null, [], 0, false, true);
    await tasksMod.submitSpec(idea.id, "Add approved_spec.txt with the word ok.");
    expect(row(idea.id).status).toBe("spec_review");

    const out = await tasksMod.approveTask(idea.id);
    expect(out.task.status).toBe("inactive");
    // Ready — no live agent yet (the dispatcher will launch it).
    expect(row(idea.id).herdr_pane_id).toBeNull();
  });

  test("requesting spec changes sends it BACK to idea to await a revised spec (note preserved)", async () => {
    const idea = await tasksMod.createTask(DIR_ID, "needs revision", [], [], "task", null, [], 0, false, true);
    await tasksMod.submitSpec(idea.id, "Spec v1: add specrev_1.txt");
    expect(row(idea.id).status).toBe("spec_review");

    // Request changes → back to idea (revise); the note is recorded for the responder.
    const view = await tasksMod.rejectTask(idea.id, "Please also add error handling.");
    expect(view.status).toBe("idea");
    expect(row(idea.id).review_note).toContain("error handling");

    // The responder submits a revised spec via the same endpoint → spec_review again.
    const after = await tasksMod.submitSpec(idea.id, "Spec v2: add specrev_2.txt + error handling");
    expect(after.status).toBe("spec_review");
    expect(tasksMod.taskView(idea.id)!.prompt).toContain("Spec v2");
  });

  test("idea rejects an `approve`/`answer` response (it awaits submit_spec)", async () => {
    const idea = await tasksMod.createTask(DIR_ID, "wrong response on idea", [], [], "task", null, [], 0, false, true);
    let err: any;
    try {
      await tasksMod.approveTask(idea.id);
    } catch (e) {
      err = e;
    }
    expect(err?.status).toBe(409);
    expect(row(idea.id).status).toBe("idea");
  });

  test("spec_review rejects an `answer` response (it awaits approve/request-changes)", async () => {
    const idea = await tasksMod.createTask(DIR_ID, "wrong response", [], [], "task", null, [], 0, false, true);
    await tasksMod.submitSpec(idea.id, "Add x.txt");
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

describe("3. in_review approve → MECHANICAL MERGE → merged", () => {
  test("approve merges the in_review task MECHANICALLY (no finalize agent)", async () => {
    const id = await buildReadyTask("build a thing", "thing.txt", "thing\n");
    // Build agent submits → in_review.
    expect(await tasksMod.markReviewFromAgent(id, "done")).toBe("ok");
    expect(row(id).status).toBe("in_review");

    // Approve → the mechanical merge runs synchronously inside approveTask (no finalize
    // agent, no extra dispatch): rebase → gate → merge → merged.
    const tipBefore = g(["rev-parse", "HEAD"]);
    const out = await tasksMod.approveTask(id);
    expect(out.task.status).toBe("merged");
    expect(row(id).status).toBe("merged");
    expect(g(["rev-parse", "HEAD"])).not.toBe(tipBefore);
    expect(existsSync(join(REPO_ROOT, "thing.txt"))).toBe(true);

    // The transition timeline reflects the happy path — and never visits finalizing.
    const flow = dbMod.listTaskEvents(id).map((e) => e.to_status);
    expect(flow).toContain("in_review");
    expect(flow).not.toContain("finalizing");
    expect(flow[flow.length - 1]).toBe("merged");
  });

  test("finalizeMerge is a no-op on a task that is not in_review/rolling_back", async () => {
    const id = await buildReadyTask("noop", "noop.txt", "noop\n");
    // Still in_progress (never reviewed) → finalizeMerge does nothing.
    const out = await tasksMod.finalizeMerge(id);
    expect(out.task.status).toBe("in_progress");
  });
});

describe("4. needs_info round-trip (any agent stage → ask → answer → resume)", () => {
  test("an in_progress agent asks → needs_info; answering resumes it to inactive", async () => {
    const id = await buildReadyTask("ask me", "q.txt", "q\n");
    expect(row(id).status).toBe("in_progress");

    // The agent calls the MCP `ask` tool.
    const state = tasksMod.markNeedsInfoFromAgent(id, "Per-user or global cache?");
    expect(state).toBe("ok");
    expect(row(id).status).toBe("needs_info");
    expect(row(id).question).toBe("Per-user or global cache?");
    expect(row(id).herdr_pane_id).toBeNull();

    // Answering resumes the SAME session: back to inactive (ready), answer stored,
    // question cleared, session_id preserved.
    const view = await tasksMod.answerTask(id, "Per-user.");
    expect(view.status).toBe("inactive");
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
    // idea submit_spec → spec_review, then approve, both via respondToFeedback.
    const a = await tasksMod.createTask(DIR_ID, "unified spec", [], [], "task", null, [], 0, false, true);
    const rs = await tasksMod.respondToFeedback(a.id, { type: "submit_spec", spec: "Add unified.txt" });
    expect(rs.task.status).toBe("spec_review");
    const r1 = await tasksMod.respondToFeedback(a.id, { type: "approve" });
    expect(r1.task.status).toBe("inactive");

    // in_review request_changes via respondToFeedback → resume the agent (→ inactive).
    const b = await buildReadyTask("unified review", "u2.txt", "u2\n");
    await tasksMod.markReviewFromAgent(b, "done");
    const r2 = await tasksMod.respondToFeedback(b, { type: "request_changes", note: "tweak it" });
    expect(r2.task.status).toBe("inactive");
    expect(row(b).review_note).toContain("tweak it");

    // needs_info answer via respondToFeedback → resume (→ inactive).
    const c = await buildReadyTask("unified ask", "u3.txt", "u3\n");
    tasksMod.markNeedsInfoFromAgent(c, "which?");
    const r3 = await tasksMod.respondToFeedback(c, { type: "answer", answer: "this one" });
    expect(r3.task.status).toBe("inactive");
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
    await tasksMod.markReviewFromAgent(id, "done");
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
