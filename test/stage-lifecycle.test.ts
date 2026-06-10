// Tests for the IDEA → SPEC → BUILD task-stage lifecycle (see db.ts `stage`,
// tasks.createTask(stage) / validateStage, tasks.approveTask's SPEC GATE +
// approveSpecStage, tasks.flipIdeaToSpec, and taskmd.renderAgentPrompt's idea/spec
// protocol).
//
// In-process: no real claude or herdr is spawned. BUTCHR_HERDR_BIN points at `true`
// so every herdr probe is a harmless no-op, and the CI / conformance / verify gate
// commands are set EMPTY so the review/merge transitions never shell out a real build.
// createTask exercises the REAL function (worktree + task.md + DB row), so we set up an
// actual throwaway git repo with one commit for `git worktree add`.
//
// What this covers (the spec's required cases):
//   1. stage DEFAULTS to 'build' (backward compatible) — an ordinary task is unchanged.
//   2. createTask(stage='idea') stamps the row + task.md and gets the idea/spec protocol
//      (write a SPEC, submit via request_review) instead of the normal review protocol.
//   3. idea→spec is AUTOMATIC: submitting the spec for review advances stage to 'spec'.
//   4. THE SPEC GATE: approving an idea/spec-stage task spawns a stage='build' task whose
//      prompt IS the approved spec, and completes the spec task terminally.
//   5. a stage='build' task runs the normal approve→merge flow UNCHANGED (no spawn).
//   6. validateStage rejects an unknown stage (400).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
const DIR_ID = "stage-dir";

let tasksMod: typeof import("../src/tasks.ts");
let dbMod: typeof import("../src/db.ts");
let taskmdMod: typeof import("../src/taskmd.ts");
let conformanceMod: typeof import("../src/conformance.ts");

function g(args: string[], cwd = REPO_ROOT): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-stage-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-stage-repo-"));

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

  // gate_cmd="" DISABLES both the in-worktree CI gate (triggerCi) and the post-merge
  // verify gate for this directory, so the review/merge transitions never shell out a
  // real build. (BUTCHR_VERIFY_CMD="" can't be used — an empty env var falls back to
  // the default command.) The conformance gate is silenced with a no-op runner so it
  // never spawns a headless claude.
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

describe("stage defaults to 'build' (backward compatible)", () => {
  test("an ordinary task has stage 'build', no task.md stage line, and the normal protocol", async () => {
    const view = await tasksMod.createTask(DIR_ID, "Do some ordinary work.");
    // DB row + serialized view both default to 'build'.
    expect(row(view.id).stage).toBe("build");
    expect((view as any).stage).toBe("build");

    // task.md omits the stage line entirely (existing files stay unchanged) and parses
    // back as the 'build' default.
    const md = readFileSync(taskmdMod.taskMdPath(REPO_ROOT, view.id), "utf8");
    expect(md).not.toContain("stage:");
    const doc = taskmdMod.readTaskMd(REPO_ROOT, view.id);
    expect(doc.meta.stage).toBe("build");

    // The FIRST rendered prompt is the normal review protocol — NOT the idea/spec one.
    const prompt = taskmdMod.renderAgentPrompt(REPO_ROOT, doc);
    expect(prompt).toContain("request_review");
    expect(prompt).not.toContain("IDEA/SPEC");
    expect(prompt).not.toContain("Do NOT implement");
  });
});

describe("createTask(stage='idea')", () => {
  test("an idea task is stamped on the row + task.md and gets the idea/spec protocol", async () => {
    const view = await tasksMod.createTask(
      DIR_ID, "Add a dark-mode toggle.", [], [], "task", null, [], 0, false, "idea",
    );
    expect(row(view.id).stage).toBe("idea");
    expect((view as any).stage).toBe("idea");

    const md = readFileSync(taskmdMod.taskMdPath(REPO_ROOT, view.id), "utf8");
    expect(md).toContain("stage: idea");
    const doc = taskmdMod.readTaskMd(REPO_ROOT, view.id);
    expect(doc.meta.stage).toBe("idea");

    // The FIRST rendered prompt hands the agent the idea/spec protocol: write a SPEC and
    // submit it via request_review's summary — do NOT implement.
    const prompt = taskmdMod.renderAgentPrompt(REPO_ROOT, doc);
    expect(prompt).toContain("IDEA/SPEC");
    expect(prompt).toContain("Do NOT implement");
    expect(prompt).toContain("request_review");
    expect(prompt).toContain("summary");
  });

  test("validateStage rejects an unknown stage (400)", async () => {
    expect(() => tasksMod.validateStage("nonsense")).toThrow();
    let err: any;
    try {
      await tasksMod.createTask(DIR_ID, "x", [], [], "task", null, [], 0, false, "bogus");
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.status).toBe(400);
    // Unset / blank stage normalizes to the 'build' default.
    expect(tasksMod.validateStage(undefined)).toBe("build");
    expect(tasksMod.validateStage("")).toBe("build");
  });
});

describe("idea→spec auto + the SPEC GATE", () => {
  test("submitting the spec advances stage idea→spec; approving spawns a build task carrying the spec", async () => {
    const SESSION = "stage-session-aaaa-bbbb-cccc";
    const idea = await tasksMod.createTask(
      DIR_ID, "Add request logging.", [], [], "task", null, [], 0, false, "idea",
    );
    // Simulate the idea agent having launched (running with a session id + pane).
    dbMod.db
      .query(
        `UPDATE tasks SET status='running', session_id=?, herdr_pane_id=?, started_at=? WHERE id=?`,
      )
      .run(SESSION, "pane-1", dbMod.nowIso(), idea.id);

    // The agent (mocked) submits its SPEC as the request_review summary.
    const SPEC =
      "Implement request logging: add a logging middleware in src/server.ts that " +
      "records method, path, and status for every /api request; add a test in " +
      "test/logging.test.ts asserting a request is logged.";
    const state = tasksMod.markReviewFromAgent(idea.id, SPEC);
    expect(state).toBe("ok");

    // idea→spec is AUTOMATIC: the record now reads as a spec awaiting sign-off.
    const reviewing = row(idea.id);
    expect(reviewing.status).toBe("review");
    expect(reviewing.stage).toBe("spec");
    expect(reviewing.summary).toBe(SPEC);
    const md = readFileSync(taskmdMod.taskMdPath(REPO_ROOT, idea.id), "utf8");
    expect(md).toContain("stage: spec");

    // THE SPEC GATE: approving the spec spawns a stage='build' task whose prompt IS the
    // approved spec, and completes the spec task terminally (it merges nothing of its own).
    const outcome = await tasksMod.approveTask(idea.id);
    expect(outcome.task.status).toBe("merged");
    const specRow = row(idea.id);
    expect(specRow.status).toBe("merged");
    const spawned = JSON.parse(specRow.spawned_subtasks);
    expect(spawned.length).toBe(1);

    const buildId = spawned[0];
    const buildView = tasksMod.taskView(buildId)!;
    expect((buildView as any).stage).toBe("build");
    expect(buildView.prompt).toBe(SPEC); // the build task carries the approved spec
    expect(buildView.status).toBe("queued"); // ready to run the normal flow
    expect(buildView.kind).toBe("task");
  });

  test("the SPEC GATE falls back to the brief when no spec summary was captured", async () => {
    const BRIEF = "Add a /healthz endpoint that returns 200 ok.";
    const idea = await tasksMod.createTask(
      DIR_ID, BRIEF, [], [], "task", null, [], 0, false, "idea",
    );
    // Park it directly in review (stage stays 'idea') with NO summary — the gate must
    // still fire (it keys on stage!=='build') and fall back to the brief prompt.
    dbMod.db.query(`UPDATE tasks SET status='review' WHERE id=?`).run(idea.id);
    taskmdMod.updateTaskMdStatus(REPO_ROOT, idea.id, "review");

    const outcome = await tasksMod.approveTask(idea.id);
    expect(outcome.task.status).toBe("merged");
    const buildId = JSON.parse(row(idea.id).spawned_subtasks)[0];
    expect(tasksMod.taskView(buildId)!.prompt).toBe(BRIEF);
  });
});

describe("a stage='build' task runs the normal flow unchanged", () => {
  test("approving a build task merges it (no spawn, no spec gate)", async () => {
    const view = await tasksMod.createTask(DIR_ID, "Add buildflow.txt.");
    const id = view.id;
    // The "agent" commits a file in the worktree.
    const wt = join(REPO_ROOT, id);
    writeFileSync(join(wt, "buildflow.txt"), "built\n");
    g(["add", "-A"], wt);
    g(["commit", "-q", "-m", "add buildflow.txt"], wt);
    // Move to review directly (skip the CI/conformance triggers).
    dbMod.db.query(`UPDATE tasks SET status='review' WHERE id=?`).run(id);
    taskmdMod.updateTaskMdStatus(REPO_ROOT, id, "review");
    const tipBefore = g(["rev-parse", "HEAD"]);

    const outcome = await tasksMod.approveTask(id);

    // It went through the MERGE path, not the spec gate: merged, nothing spawned, and
    // the change landed on the default branch.
    expect(outcome.task.status).toBe("merged");
    expect(outcome.task.spawned_subtasks).toEqual([]);
    expect(g(["rev-parse", "HEAD"])).not.toBe(tipBefore);
    expect(existsSync(join(REPO_ROOT, "buildflow.txt"))).toBe(true);
  });
});
