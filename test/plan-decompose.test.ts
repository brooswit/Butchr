// Tests for butchr's AUTO-DECOMPOSE / PLAN feature (see db.ts `kind` +
// `spawned_subtasks`, tasks.{createTask(kind),proposeSubtasks,planCreationOrder},
// taskmd.renderAgentPrompt's plan protocol, and mcp.ts propose_subtasks).
//
// In-process: no real claude or herdr is spawned. As in the other test files,
// BUTCHR_HERDR_BIN points at `true` so every herdr probe (teardownTask et al.) is a
// harmless no-op. createTask / proposeSubtasks exercise the REAL functions (worktree
// + task.md + DB row + git.cleanup), so we set up an actual throwaway git repo with
// one commit for `git worktree add` (and the plan's post-completion `git.cleanup`).
//
// What this exercises (mapped to the spec's required cases):
//   1. a PLAN task is created with kind='plan' (DB + task.md) and gets the plan
//      protocol in its rendered prompt.
//   2. proposeSubtasks creates the sub-tasks and wires blocked_by correctly
//      (sibling index -> the real id it was created with).
//   3. a cyclic (and self-referential / out-of-range) proposal is REJECTED (400)
//      and creates NOTHING.
//   4. a plan task results in the sub-tasks EXISTING and the plan completing with
//      the spawned ids recorded.
//   5. planCreationOrder is a correct topological sort / cycle detector (pure).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
const DIR_ID = "plan-dir";

let tasksMod: typeof import("../src/tasks.ts");
let dbMod: typeof import("../src/db.ts");
let taskmdMod: typeof import("../src/taskmd.ts");

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-plan-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-plan-repo-"));

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
function allRows() {
  return dbMod.db.query<any, []>(`SELECT * FROM tasks`).all();
}

describe("createTask with kind='plan'", () => {
  test("a plan task is recorded as kind='plan' in the DB and task.md", async () => {
    const view = await tasksMod.createTask(DIR_ID, "decompose me", [], [], "plan");
    expect((view as any).kind).toBe("plan");
    expect(view.status).toBe("queued");
    expect(view.spawned_subtasks).toEqual([]);
    expect(row(view.id).kind).toBe("plan");
    // task.md carries the kind so the dispatcher renders the plan protocol.
    expect(taskmdMod.readTaskMd(REPO_ROOT, view.id).meta.kind).toBe("plan");
  });

  test("an ordinary task defaults to kind='task' (no front-matter kind line)", async () => {
    const view = await tasksMod.createTask(DIR_ID, "just work", [], []);
    expect((view as any).kind).toBe("task");
    expect(row(view.id).kind).toBe("task");
    expect(taskmdMod.readTaskMd(REPO_ROOT, view.id).meta.kind).toBe("task");
  });

  test("renderAgentPrompt gives a plan task the decomposition protocol", () => {
    const plan = taskmdMod.parseTaskMd(
      ["---", "id: p1", "created: x", "status: queued", "kind: plan", "---", "", "## Prompt", "", "do it"].join("\n"),
    );
    const ordinary = taskmdMod.parseTaskMd(
      ["---", "id: t1", "created: x", "status: queued", "---", "", "## Prompt", "", "do it"].join("\n"),
    );
    const planPrompt = taskmdMod.renderAgentPrompt(REPO_ROOT, plan);
    const ordinaryPrompt = taskmdMod.renderAgentPrompt(REPO_ROOT, ordinary);
    expect(planPrompt).toContain("propose_subtasks");
    expect(planPrompt).toContain("PLAN task");
    expect(ordinaryPrompt).toContain("request_review");
    expect(ordinaryPrompt).not.toContain("propose_subtasks");
  });
});

describe("planCreationOrder (pure graph validation / topo sort)", () => {
  test("orders so every spec follows its blockers", () => {
    // 0 <- 1 <- 2 (2 depends on 1, 1 depends on 0)
    const order = tasksMod.planCreationOrder([
      { prompt: "a" },
      { prompt: "b", blocked_by: [0] },
      { prompt: "c", blocked_by: [1] },
    ])!;
    expect(order).not.toBeNull();
    // 0 before 1 before 2.
    expect(order.indexOf(0)).toBeLessThan(order.indexOf(1));
    expect(order.indexOf(1)).toBeLessThan(order.indexOf(2));
  });

  test("rejects a cycle (returns null)", () => {
    expect(
      tasksMod.planCreationOrder([
        { prompt: "a", blocked_by: [1] },
        { prompt: "b", blocked_by: [0] },
      ]),
    ).toBeNull();
  });

  test("rejects a self-reference and an out-of-range index", () => {
    expect(tasksMod.planCreationOrder([{ prompt: "a", blocked_by: [0] }])).toBeNull();
    expect(tasksMod.planCreationOrder([{ prompt: "a", blocked_by: [5] }])).toBeNull();
    expect(tasksMod.planCreationOrder([{ prompt: "a", blocked_by: [-1] }])).toBeNull();
  });
});

describe("proposeSubtasks", () => {
  test("creates the sub-tasks and wires blocked_by correctly", async () => {
    const plan = await tasksMod.createTask(DIR_ID, "build a feature", [], [], "plan");
    // 3 sub-tasks: B depends on A, C depends on both A and B.
    const { created, plan: completed } = await tasksMod.proposeSubtasks(plan.id, [
      { prompt: "sub A" },
      { prompt: "sub B", blocked_by: [0] },
      { prompt: "sub C", blocked_by: [0, 1] },
    ]);

    expect(created.length).toBe(3);
    const [a, b, c] = created;

    // All three exist as real tasks.
    for (const id of created) expect(row(id)).toBeTruthy();

    // blocked_by wired to the REAL sibling ids (not indices).
    expect(tasksMod.parseBlockedBy(row(a).blocked_by)).toEqual([]);
    expect(tasksMod.parseBlockedBy(row(b).blocked_by)).toEqual([a]);
    expect(tasksMod.parseBlockedBy(row(c).blocked_by).sort()).toEqual([a, b].sort());

    // A has no blockers → queued; B and C have unmerged blockers → blocked.
    expect(row(a).status).toBe("queued");
    expect(row(b).status).toBe("blocked");
    expect(row(c).status).toBe("blocked");

    // The plan task completed, recording the spawned ids in proposal order.
    expect(completed.status).toBe("merged");
    expect(completed.spawned_subtasks).toEqual([a, b, c]);
    expect(row(plan.id).status).toBe("merged");

    // Sub-tasks are ordinary work tasks.
    for (const id of created) expect(row(id).kind).toBe("task");
  });

  test("a cyclic proposal is rejected (400) and creates NOTHING", async () => {
    const plan = await tasksMod.createTask(DIR_ID, "cyclic plan", [], [], "plan");
    const before = allRows().length;
    let err: any;
    try {
      await tasksMod.proposeSubtasks(plan.id, [
        { prompt: "x", blocked_by: [1] },
        { prompt: "y", blocked_by: [0] },
      ]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.status).toBe(400);
    // No sub-tasks were created.
    expect(allRows().length).toBe(before);
    // The plan task is untouched (still queued, not merged).
    expect(row(plan.id).status).toBe("queued");
    expect(tasksMod.parseBlockedBy(row(plan.id).spawned_subtasks)).toEqual([]);
  });

  test("an empty decomposition and a blank prompt are rejected (400)", async () => {
    const plan = await tasksMod.createTask(DIR_ID, "empty plan", [], [], "plan");
    for (const bad of [[], [{ prompt: "  " }]]) {
      let err: any;
      try {
        await tasksMod.proposeSubtasks(plan.id, bad as any);
      } catch (e) {
        err = e;
      }
      expect(err?.status).toBe(400);
    }
    expect(row(plan.id).status).toBe("queued");
  });

  test("proposing on a NON-plan task is rejected (409)", async () => {
    const ordinary = await tasksMod.createTask(DIR_ID, "not a plan", [], []);
    let err: any;
    try {
      await tasksMod.proposeSubtasks(ordinary.id, [{ prompt: "x" }]);
    } catch (e) {
      err = e;
    }
    expect(err?.status).toBe(409);
  });

  test("is idempotent — a second call returns the same spawned ids without re-creating", async () => {
    const plan = await tasksMod.createTask(DIR_ID, "idempotent plan", [], [], "plan");
    const first = await tasksMod.proposeSubtasks(plan.id, [{ prompt: "only one" }]);
    const countAfterFirst = allRows().length;
    const second = await tasksMod.proposeSubtasks(plan.id, [{ prompt: "ignored" }]);
    expect(second.created).toEqual(first.created);
    // No additional sub-tasks created on the duplicate call.
    expect(allRows().length).toBe(countAfterFirst);
  });
});
