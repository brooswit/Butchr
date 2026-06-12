// Tests for the UNIFIED task-state pipeline (idea → spec_review → inactive → in_progress
// → in_review → merged, with the lateral states). The CEO's SINGLE state machine:
//   - createTask({idea:true}) creates the task in the FRONT state `idea` (a one-line
//     brief, no spec yet) — a WAITING/feedback state. butchr runs NO agent for it: it
//     pushes a `spec requested` event on the CTO channel and WAITS.
//   - the spec-generation RESPONDER (the CTO agent, or a human in the webapp) submits the
//     spec via submitSpec / POST /api/tasks/:id/spec, which rewrites the prompt brief →
//     spec and advances the task to `spec_review` for the operator's sign-off — where the
//     operator approves to `inactive` (ready).
//   - createTask() (no idea) creates directly in `inactive` ('ready').
//   - the retracted `stage` axis is folded out: the DB migration flips legacy stage='idea'
//     rows to status='idea'; everything else is untouched; task.md `stage:` lines are
//     ignored on parse.
//
// In-process: no real claude or herdr is spawned. BUTCHR_HERDR_BIN points at `true` so
// every herdr probe is a harmless no-op; the CI / conformance / verify gates are disabled
// (gate_cmd="" + a no-op conformance runner) so review/merge never shells out a real
// build. There is no longer any spec-generator fork to mock — the spec is submitted via
// the public submitSpec API. createTask exercises the REAL function (worktree + task.md +
// DB row), so we set up a throwaway git repo with one commit for `git worktree add`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
const DIR_ID = "idea-dir";

let tasksMod: typeof import("../src/tasks.ts");
let dbMod: typeof import("../src/db.ts");
let taskmdMod: typeof import("../src/taskmd.ts");
let dispatcherMod: typeof import("../src/dispatcher.ts");
let conformanceMod: typeof import("../src/conformance.ts");

function g(args: string[], cwd = REPO_ROOT): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-idea-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-idea-repo-"));

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
  dispatcherMod = await import("../src/dispatcher.ts");
  conformanceMod = await import("../src/conformance.ts");

  // gate_cmd="" disables the in-worktree CI gate + the post-merge verify gate for this
  // workspace; the conformance gate is silenced with a no-op runner.
  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, gate_cmd, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(DIR_ID, REPO_ROOT, "test", "", dbMod.nowIso());
  conformanceMod.setConformanceRunner(async () => null);
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

function row(id: string) {
  return dbMod.db.query<any, [string]>(`SELECT * FROM tasks WHERE id=?`).get(id)!;
}

describe("a normal task enters 'ready' (inactive) directly", () => {
  test("createTask() with no idea flag: status=inactive (ready), normal review protocol", async () => {
    const view = await tasksMod.createTask(DIR_ID, "Do some ordinary work.");
    expect(view.status).toBe("inactive"); // 'ready' (no live agent yet)
    // No stage line is ever written, and the FIRST rendered prompt is the normal review
    // protocol — there is no idea/spec protocol anymore.
    const md = readFileSync(taskmdMod.taskMdPath(REPO_ROOT, view.id), "utf8");
    expect(md).not.toContain("stage:");
    const prompt = taskmdMod.renderAgentPrompt(REPO_ROOT, taskmdMod.readTaskMd(REPO_ROOT, view.id));
    expect(prompt).toContain("request_review");
    expect(prompt).not.toContain("IDEA/SPEC");
    // The build agent is told to self-drive to completion (the baked-in "keep going"
    // persistence) and to STOP only on request_review or `raise` — replacing the
    // external "continue" nudge.
    expect(prompt).toContain("Keep going until the task is done");
    expect(prompt).toContain("AUTONOMOUSLY and CONTINUOUSLY");
    expect(prompt).toContain("SELF-VERIFY");
    expect(prompt).toContain("`raise`");
  });

  test("validateIdea coerces/validates the flag", () => {
    expect(tasksMod.validateIdea(undefined)).toBe(false);
    expect(tasksMod.validateIdea(null)).toBe(false);
    expect(tasksMod.validateIdea(true)).toBe(true);
    expect(() => tasksMod.validateIdea("idea")).toThrow();
  });
});

describe("an idea task is created in the 'idea' front state (a waiting/feedback state)", () => {
  test("createTask({idea}) starts in status=idea with the brief as its prompt and NO agent", async () => {
    const BRIEF = "add a dark-mode toggle to the header";
    const view = await tasksMod.createTask(
      DIR_ID, BRIEF, [], [], "task", null, [], 0, false, true,
    );
    expect(view.status).toBe("idea");
    expect(row(view.id).status).toBe("idea");
    // The brief is stored as the initial prompt (it becomes the spec input).
    expect(view.prompt).toBe(BRIEF);
    // It is a WAITING state — no live agent / pane / session was created.
    expect(row(view.id).herdr_pane_id).toBeNull();
    expect(row(view.id).session_id).toBeNull();
    expect(row(view.id).started_at).toBeNull();
    // The creation audit event records it as an idea task.
    const events = dbMod.listTaskEvents(view.id);
    expect(events[0]!.to_status).toBe("idea");
    expect(events[0]!.note).toBe("idea task created");
  });

  test("idea is a feedback state awaiting a spec; the dispatcher never selects it", async () => {
    const idea = await tasksMod.createTask(
      DIR_ID, "a brief the dispatcher must ignore", [], [], "task", null, [], 0, false, true,
    );
    // STATE_META + the feedback descriptor classify `idea` as a feedback (waiting) state.
    expect(dbMod.STATE_META.idea).toEqual({ kind: "feedback" });
    const info = tasksMod.feedbackInfo("idea");
    expect(info).not.toBeNull();
    expect(info!.artifact).toBe("brief");
    expect(info!.accepts).toEqual(["submit_spec"]);
    // The dispatcher's NEW-DISPATCH gate selects only `inactive` (ready) tasks — never an
    // `idea` task — so a parked idea is inert to the dispatch loop (no agent is launched).
    const queued = dispatcherMod.selectQueuedForDispatch(new Date().toISOString());
    expect(queued.some((r) => r.id === idea.id)).toBe(false);
  });
});

describe("idea → (responder submits spec) → spec_review", () => {
  test("submitSpec advances an idea task to 'spec_review' carrying the spec as its prompt", async () => {
    const BRIEF = "add request logging";
    const SPEC =
      "Implement request logging: add a logging middleware in src/server.ts that records " +
      "method, path, and status for every /api request; add test/logging.test.ts.";

    const idea = await tasksMod.createTask(
      DIR_ID, BRIEF, [], [], "task", null, [], 0, false, true,
    );
    expect(row(idea.id).status).toBe("idea");

    // The spec-generation responder (CTO agent or human) submits the written spec.
    const after = await tasksMod.submitSpec(idea.id, SPEC);

    // The task advanced to 'spec_review' carrying the SPEC as its prompt.
    expect(after.status).toBe("spec_review");
    expect(after.prompt).toBe(SPEC);
    expect(row(idea.id).status).toBe("spec_review");

    // task.md's Prompt section was rewritten brief → spec, so the build agent's rendered
    // prompt IS the spec (with the normal review protocol).
    const md = readFileSync(taskmdMod.taskMdPath(REPO_ROOT, idea.id), "utf8");
    expect(md).toContain(SPEC);
    expect(md).not.toContain(BRIEF);
    const built = taskmdMod.renderAgentPrompt(REPO_ROOT, taskmdMod.readTaskMd(REPO_ROOT, idea.id));
    expect(built).toContain(SPEC);
    expect(built).toContain("request_review");
  });

  test("submitSpec rejects a blank spec (400) and a non-idea task (409)", async () => {
    const idea = await tasksMod.createTask(
      DIR_ID, "another brief", [], [], "task", null, [], 0, false, true,
    );
    // Blank spec → 400.
    await expect(tasksMod.submitSpec(idea.id, "   ")).rejects.toThrow();
    expect(row(idea.id).status).toBe("idea"); // unchanged

    // Submit once to advance to spec_review, then a second submit must 409 (not idea).
    await tasksMod.submitSpec(idea.id, "A concrete spec.");
    expect(row(idea.id).status).toBe("spec_review");
    await expect(tasksMod.submitSpec(idea.id, "another spec")).rejects.toThrow();
  });

  test("spec_review request_changes sends the task back to 'idea' to await a revised spec", async () => {
    const idea = await tasksMod.createTask(
      DIR_ID, "feature needing a revised spec", [], [], "task", null, [], 0, false, true,
    );
    await tasksMod.submitSpec(idea.id, "First-draft spec.");
    expect(row(idea.id).status).toBe("spec_review");

    // Operator requests changes → back to idea (awaiting a revised spec), note preserved.
    await tasksMod.rejectTask(idea.id, "scope it to just the header, please");
    expect(row(idea.id).status).toBe("idea");
    expect(row(idea.id).review_note).toContain("scope it to just the header");

    // A revised spec submitted via the same endpoint advances it again.
    const after = await tasksMod.submitSpec(idea.id, "Revised spec: header only.");
    expect(after.status).toBe("spec_review");
    expect(after.prompt).toBe("Revised spec: header only.");
  });
});

describe("the full idea → spec_review → inactive → in_progress → in_review → merged pipeline", () => {
  test("an idea flows through the single state machine end-to-end", async () => {
    const SPEC = "Add pipeline.txt containing the word built.";

    // idea
    const t = await tasksMod.createTask(
      DIR_ID, "make a pipeline file", [], [], "task", null, [], 0, false, true,
    );
    expect(row(t.id).status).toBe("idea");

    // idea → spec_review via the responder submitting the spec.
    await tasksMod.submitSpec(t.id, SPEC);
    expect(row(t.id).status).toBe("spec_review");
    expect(tasksMod.taskView(t.id)!.prompt).toBe(SPEC);

    // spec_review → inactive: operator approves the spec.
    await tasksMod.approveTask(t.id);
    expect(row(t.id).status).toBe("inactive");
    expect(row(t.id).herdr_pane_id).toBeNull();

    // inactive → in_progress: simulate the dispatcher launching the build agent.
    tasksMod.markRunning(t.id, "pane-x", "idea-session-1234", "tab-x");
    expect(row(t.id).status).toBe("in_progress");
    expect(row(t.id).herdr_pane_id).toBe("pane-x");

    // The "agent" does the work in its worktree and commits a file.
    const wt = join(REPO_ROOT, t.id);
    writeFileSync(join(wt, "pipeline.txt"), "built\n");
    g(["add", "-A"], wt);
    g(["commit", "-q", "-m", "add pipeline.txt"], wt);

    // in_progress → in_review: the agent calls request_review.
    const state = tasksMod.markReviewFromAgent(t.id, "done");
    expect(state).toBe("ok");
    expect(row(t.id).status).toBe("in_review");

    // in_review → merged: approving runs the MECHANICAL merge directly (no finalize agent).
    const tipBefore = g(["rev-parse", "HEAD"]);
    const approveOut = await tasksMod.approveTask(t.id);
    expect(approveOut.task.status).toBe("merged");
    expect(row(t.id).status).toBe("merged");
    expect(g(["rev-parse", "HEAD"])).not.toBe(tipBefore);
    expect(existsSync(join(REPO_ROOT, "pipeline.txt"))).toBe(true);

    // The transition timeline reflects the unified pipeline — and never visits finalizing.
    const flow = dbMod.listTaskEvents(t.id).map((e) => e.to_status);
    expect(flow).toContain("idea");
    expect(flow).toContain("spec_review");
    expect(flow).toContain("inactive");
    expect(flow).toContain("in_progress");
    expect(flow).toContain("in_review");
    expect(flow).not.toContain("finalizing");
    expect(flow[flow.length - 1]).toBe("merged");
  });
});

describe("a parked idea is inert to the resilience code (no pane/session to resume)", () => {
  test("an idea task carries none of the markers the dispatch/reconcile/reaper/nudge paths key on", async () => {
    const idea = await tasksMod.createTask(
      DIR_ID, "a brief that must survive a restart untouched", [], [], "task", null, [], 0, false, true,
    );
    // The dispatch loop, the startup reconcile, the reaper's dead-agent sweep, and the
    // stalled-agent auto-nudge ALL act ONLY on `in_progress` tasks that hold a herdr pane
    // (reconcile/reaper select `status='in_progress' AND herdr_pane_id IS NOT NULL`; the
    // nudge requires `phase==='in_progress'`). A parked idea is a feedback/waiting state
    // with NO pane, NO session, and never-started — so it matches NONE of those paths and
    // can never be "resumed", rescued, or nudged. (Asserted purely off the row markers so
    // this stays side-effect-free in the shared-process test DB.)
    const r = row(idea.id);
    expect(r.status).toBe("idea");
    expect(r.herdr_pane_id).toBeNull();
    expect(r.session_id).toBeNull();
    expect(r.started_at).toBeNull();
    // The dispatcher's queued gate (a pure read) never returns it.
    expect(
      dispatcherMod.selectQueuedForDispatch(new Date().toISOString()).some((x) => x.id === idea.id),
    ).toBe(false);
  });
});

describe("the `stage` axis is folded out (backward compatibility)", () => {
  test("the DB migration flips a legacy stage='idea' row to status='idea' and leaves others", () => {
    // Simulate an OLD database that still carries the retracted `stage` column.
    const cols = dbMod.db.query<{ name: string }, []>(`PRAGMA table_info(tasks)`).all();
    if (!cols.some((c) => c.name === "stage")) {
      dbMod.db.exec(`ALTER TABLE tasks ADD COLUMN stage TEXT NOT NULL DEFAULT 'build'`);
    }
    const mk = (id: string, status: string, stage: string) => {
      dbMod.db
        .query(`INSERT INTO tasks (id, workspace_id, status, stage, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(id, DIR_ID, status, stage, dbMod.nowIso());
    };
    // Insert rows with old-style status values; migrateStageAxisToStatus runs BEFORE
    // migrateStatusModel renamed these, so we insert raw values and call both migrations.
    mk("legacy-idea-queued", "queued", "idea"); // pre-spec idea → should become 'idea'
    mk("legacy-idea-running", "running", "idea"); // mid-flight → left alone by stage migration
    mk("legacy-spec-review", "review", "spec"); // a spec in review → left alone by stage migration
    mk("legacy-build-merged", "merged", "build"); // ordinary task → left alone

    // The stage migration turns stage='idea' + status='queued' → status='idea'.
    dbMod.migrateStageAxisToStatus();
    // The status-rename migration maps remaining old names to the new canonical ones.
    dbMod.migrateStatusModel();

    expect(row("legacy-idea-queued").status).toBe("idea");
    // running → in_progress after migrateStatusModel
    expect(row("legacy-idea-running").status).toBe("in_progress");
    // review → in_review after migrateStatusModel
    expect(row("legacy-spec-review").status).toBe("in_review");
    expect(row("legacy-build-merged").status).toBe("merged");
  });

  test("a task.md carrying a legacy `stage:` line parses cleanly and gets the normal protocol", () => {
    const raw = [
      "---",
      "id: legacy-md",
      "created: 2026-01-01T00:00:00.000Z",
      "status: in_progress",
      "stage: idea", // retracted axis — must be ignored, not crash
      "context: []",
      "---",
      "",
      "## Prompt",
      "",
      "Some legacy idea prompt.",
      "",
      "## Review Notes",
      "",
    ].join("\n");
    const doc = taskmdMod.parseTaskMd(raw);
    expect(doc.meta.status).toBe("in_progress");
    expect((doc.meta as any).stage).toBeUndefined();
    expect(doc.prompt).toBe("Some legacy idea prompt.");
  });
});
