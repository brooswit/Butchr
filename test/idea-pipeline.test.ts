// Tests for the UNIFIED task-state pipeline (idea → ready → in_progress → review →
// merged, with the lateral states). The CEO retracted the earlier two-axis design (a
// separate `stage` field orthogonal to `status`) in favor of this SINGLE state machine:
//   - createTask({idea:true}) creates the task in the FRONT state `idea` (a one-line
//     brief, no spec yet) — NOT a build agent.
//   - the dispatcher runs the CTO-fork spec generator (src/cto.ts, mocked here) to turn
//     the brief into a SPEC, then advances the task to `queued` ('ready') carrying the
//     spec as its prompt (promoteIdeaToReady) — where it dispatches the build agent.
//   - createTask() (no idea) creates directly in `queued` ('ready') as today — UNCHANGED.
//   - the retracted `stage` axis is folded out: the DB migration flips legacy stage='idea'
//     rows to status='idea'; everything else is untouched; task.md `stage:` lines are
//     ignored on parse.
//
// In-process: no real claude or herdr is spawned. BUTCHR_HERDR_BIN points at `true` so
// every herdr probe is a harmless no-op; the CI / conformance / verify gates are disabled
// (gate_cmd="" + a no-op conformance runner) so review/merge never shells out a real
// build; and the CTO-fork spec writer is replaced with a fake (setSpecWriter). createTask
// exercises the REAL function (worktree + task.md + DB row), so we set up a throwaway git
// repo with one commit for `git worktree add`.
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
let ctoMod: typeof import("../src/cto.ts");
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
  ctoMod = await import("../src/cto.ts");
  dispatcherMod = await import("../src/dispatcher.ts");
  conformanceMod = await import("../src/conformance.ts");

  // gate_cmd="" disables the in-worktree CI gate + the post-merge verify gate for this
  // directory; the conformance gate is silenced with a no-op runner.
  dbMod.db
    .query(`INSERT INTO directories (id, path, label, gate_cmd, created_at) VALUES (?, ?, ?, ?, ?)`)
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
function dirRow() {
  return dbMod.db.query<any, [string]>(`SELECT * FROM directories WHERE id=?`).get(DIR_ID)!;
}

describe("a normal task enters 'ready' (queued) directly", () => {
  test("createTask() with no idea flag is unchanged: status=queued, normal review protocol", async () => {
    const view = await tasksMod.createTask(DIR_ID, "Do some ordinary work.");
    expect(view.status).toBe("queued"); // 'ready' (internal value kept)
    // No stage line is ever written, and the FIRST rendered prompt is the normal review
    // protocol — there is no idea/spec protocol anymore.
    const md = readFileSync(taskmdMod.taskMdPath(REPO_ROOT, view.id), "utf8");
    expect(md).not.toContain("stage:");
    const prompt = taskmdMod.renderAgentPrompt(REPO_ROOT, taskmdMod.readTaskMd(REPO_ROOT, view.id));
    expect(prompt).toContain("request_review");
    expect(prompt).not.toContain("IDEA/SPEC");
  });

  test("validateIdea coerces/validates the flag", () => {
    expect(tasksMod.validateIdea(undefined)).toBe(false);
    expect(tasksMod.validateIdea(null)).toBe(false);
    expect(tasksMod.validateIdea(true)).toBe(true);
    expect(() => tasksMod.validateIdea("idea")).toThrow();
  });
});

describe("an idea task is created in the 'idea' front state", () => {
  test("createTask({idea}) starts in status=idea with the brief as its prompt", async () => {
    const BRIEF = "add a dark-mode toggle to the header";
    const view = await tasksMod.createTask(
      DIR_ID, BRIEF, [], [], "task", null, [], 0, false, true,
    );
    expect(view.status).toBe("idea");
    expect(row(view.id).status).toBe("idea");
    // The brief is stored as the initial prompt (it becomes the spec input).
    expect(view.prompt).toBe(BRIEF);
    // The creation audit event records it as an idea task.
    const events = dbMod.listTaskEvents(view.id);
    expect(events[0]!.to_status).toBe("idea");
    expect(events[0]!.note).toBe("idea task created");
  });
});

describe("idea → (spec via CTO-fork, mocked) → ready", () => {
  test("the CTO-fork spec generator advances an idea task to 'ready' carrying the spec", async () => {
    const BRIEF = "add request logging";
    const SPEC =
      "Implement request logging: add a logging middleware in src/server.ts that records " +
      "method, path, and status for every /api request; add test/logging.test.ts.";

    // Mock the CTO-fork: capture what the generator is asked, return the SPEC. This stands
    // in for the headless `claude -p ... --fork-session` run.
    let sawBrief = "";
    let sawCwd = "";
    ctoMod.setSpecWriter(async (input) => {
      sawBrief = input.brief;
      sawCwd = input.cwd;
      return SPEC;
    });

    const idea = await tasksMod.createTask(
      DIR_ID, BRIEF, [], [], "task", null, [], 0, false, true,
    );
    expect(row(idea.id).status).toBe("idea");

    // Drive the dispatcher's idea path (what the tick calls for each idea-state task).
    await dispatcherMod.generateSpecForIdea(dirRow(), row(idea.id));

    // The generator saw the brief and ran in the task's worktree.
    expect(sawBrief).toBe(BRIEF);
    expect(sawCwd).toContain(idea.id);

    // The task advanced to 'ready' (queued) carrying the SPEC as its prompt.
    const after = tasksMod.taskView(idea.id)!;
    expect(after.status).toBe("queued");
    expect(after.prompt).toBe(SPEC);

    // task.md's Prompt section was rewritten brief → spec, so the build agent's rendered
    // prompt IS the spec (with the normal review protocol).
    const md = readFileSync(taskmdMod.taskMdPath(REPO_ROOT, idea.id), "utf8");
    expect(md).toContain(SPEC);
    expect(md).not.toContain(BRIEF);
    const built = taskmdMod.renderAgentPrompt(REPO_ROOT, taskmdMod.readTaskMd(REPO_ROOT, idea.id));
    expect(built).toContain(SPEC);
    expect(built).toContain("request_review");
  });

  test("a spec-generation FAILURE keeps the task in 'idea' (bounded retry) then gives up to 'failed'", async () => {
    // Make the generator fail (returns null).
    ctoMod.setSpecWriter(async () => null);
    const idea = await tasksMod.createTask(
      DIR_ID, "something that will fail to spec", [], [], "task", null, [], 0, false, true,
    );

    // First failure: stays in 'idea' with a backoff stamped (retry, not give-up).
    await dispatcherMod.generateSpecForIdea(dirRow(), row(idea.id));
    let r = row(idea.id);
    expect(r.status).toBe("idea");
    expect(r.dispatch_attempts).toBe(1);
    expect(r.next_dispatch_at).toBeTruthy();

    // Burn through the remaining attempts: at the cap it moves to 'failed'.
    for (let i = 0; i < 10 && row(idea.id).status === "idea"; i++) {
      // Clear the backoff so markSpecGenFailure increments each call deterministically.
      dbMod.db.query(`UPDATE tasks SET next_dispatch_at=NULL WHERE id=?`).run(idea.id);
      await dispatcherMod.generateSpecForIdea(dirRow(), row(idea.id));
    }
    expect(row(idea.id).status).toBe("failed");
  });
});

describe("the full idea → ready → in_progress → review → merged pipeline", () => {
  test("an idea flows through the single state machine end-to-end", async () => {
    const SPEC = "Add pipeline.txt containing the word built.";
    ctoMod.setSpecWriter(async () => SPEC);

    // idea
    const t = await tasksMod.createTask(
      DIR_ID, "make a pipeline file", [], [], "task", null, [], 0, false, true,
    );
    expect(row(t.id).status).toBe("idea");

    // idea → ready (queued) via the CTO-fork
    await dispatcherMod.generateSpecForIdea(dirRow(), row(t.id));
    expect(row(t.id).status).toBe("queued");
    expect(tasksMod.taskView(t.id)!.prompt).toBe(SPEC);

    // ready → in_progress (running): simulate the dispatcher launching the build agent.
    tasksMod.markRunning(t.id, "pane-x", "idea-session-1234", "tab-x");
    expect(row(t.id).status).toBe("running");

    // The "agent" does the work in its worktree and commits a file.
    const wt = join(REPO_ROOT, t.id);
    writeFileSync(join(wt, "pipeline.txt"), "built\n");
    g(["add", "-A"], wt);
    g(["commit", "-q", "-m", "add pipeline.txt"], wt);

    // in_progress → review: the agent calls request_review. NO stage flip happens — there
    // is no second axis; review is of the CODE, not a spec.
    const state = tasksMod.markReviewFromAgent(t.id, "done");
    expect(state).toBe("ok");
    expect(row(t.id).status).toBe("review");

    // review → merged: approving runs the normal merge path (no spec gate, no spawn).
    const tipBefore = g(["rev-parse", "HEAD"]);
    const outcome = await tasksMod.approveTask(t.id);
    expect(outcome.task.status).toBe("merged");
    expect(outcome.task.spawned_subtasks).toEqual([]);
    expect(g(["rev-parse", "HEAD"])).not.toBe(tipBefore);
    expect(existsSync(join(REPO_ROOT, "pipeline.txt"))).toBe(true);

    // The transition timeline reflects the unified pipeline.
    const flow = dbMod.listTaskEvents(t.id).map((e) => e.to_status);
    expect(flow).toEqual(["idea", "queued", "running", "review", "merged"]);
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
        .query(`INSERT INTO tasks (id, directory_id, status, stage, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(id, DIR_ID, status, stage, dbMod.nowIso());
    };
    mk("legacy-idea-queued", "queued", "idea"); // pre-spec idea → should become 'idea'
    mk("legacy-idea-running", "running", "idea"); // mid-flight → left alone
    mk("legacy-spec-review", "review", "spec"); // a spec in review → left alone
    mk("legacy-build-merged", "merged", "build"); // ordinary task → left alone

    dbMod.migrateStageAxisToStatus();

    expect(row("legacy-idea-queued").status).toBe("idea");
    expect(row("legacy-idea-running").status).toBe("running");
    expect(row("legacy-spec-review").status).toBe("review");
    expect(row("legacy-build-merged").status).toBe("merged");
  });

  test("a task.md carrying a legacy `stage:` line parses cleanly and gets the normal protocol", () => {
    const raw = [
      "---",
      "id: legacy-md",
      "created: 2026-01-01T00:00:00.000Z",
      "status: queued",
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
    expect(doc.meta.status).toBe("queued");
    expect((doc.meta as any).stage).toBeUndefined();
    expect(doc.prompt).toBe("Some legacy idea prompt.");
  });
});
