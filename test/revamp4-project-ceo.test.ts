// REVAMP-4 Phase 3 / P3a (story st-1a82a2e1) — extend the recursive responder to the CEO rung:
// PROJECT container nodes + a CONTAINER-LADDER responder that derives every tier (INCLUDING the
// terminals) from the actual container ancestors. The bar is BYTE-IDENTICAL routing for every
// current shape (no project nodes materialize in prod), then a NEW `{ ceo }` tier once a project
// node sits above a repo.
//
// This suite pins:
//   A. BYTE-IDENTICAL with NO project node (repo.parent_id NULL): resolveWorkResponder /
//      workResponderChain / pendingResponder produce the EXACT captured values they do today for a
//      standalone leaf, a story member, and a story node — and `ceo` is UNREACHABLE for any real
//      shape (reachable only via a test-synthesized project node).
//   B. A TEST-ONLY project node inserted above the repo (repo.parent_id → project) enables the
//      CEO rung: a repo-level ask chains repo → [{cto},{ceo},{user}]; a leaf under it chains the
//      same; the project node itself resolves {ceo}; and a work item directly under the project
//      makes pendingResponder return "ceo" — which the routing consumers (operatorActionableItems)
//      handle WITHOUT crashing (dormant → not owned by the CTO feed; live scope is P3b).
//
// Pure / in-process: rows are inserted directly via the db singleton (no live herdr/claude). The
// db/config singletons are SHARED across test files, so we use a DEDICATED dir + distinct ids and
// assert only on our own rows. The project node is created by a TEST-ONLY helper here (the real
// CEO creation surface is P3d).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
const DIR = "dir-p3a"; // the repo node id == this dir id (S0a construction)
const NODE = "node-p3a"; // a materialized STORY node (parent of the member case)
const PROJ = "proj-p3a"; // a TEST-ONLY project node (the real surface is P3d)

let dbMod: typeof import("../src/db.ts");
let tasksMod: typeof import("../src/tasks.ts");
let workMod: typeof import("../src/work.ts");

let seq = 0;
/** Seed a bare task row with the columns the structural resolution reads. */
function seedTask(opts: { status?: string; parentId?: string | null; workKind?: string } = {}): string {
  const id = `p3a-${seq++}`;
  dbMod.db
    .query(
      `INSERT INTO tasks (id, workspace_id, status, work_kind, parent_id, escalated_to_user, idle, has_agent, created_at)
       VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?)`,
    )
    .run(id, DIR, opts.status ?? "in_review", opts.workKind ?? "leaf", opts.parentId ?? null, dbMod.nowIso());
  return id;
}

/** TEST-ONLY: materialize a PROJECT container node (work_kind='project', top of the tree). The real
 *  project-node creation surface is P3d — this is clearly test-scoped, mirroring the S0a repo-node
 *  shape (status='merged', a synthetic container invisible to leaf/node loops). */
function insertProjectNode(id: string): void {
  dbMod.db
    .query(
      `INSERT INTO tasks (id, workspace_id, status, work_kind, parent_id, created_at)
       VALUES (?, ?, 'merged', 'project', NULL, ?)`,
    )
    .run(id, DIR, dbMod.nowIso());
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-p3a-"));
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";
  delete process.env.BUTCHR_UNIFIED_WORK; // unified routing ON (default) — assert the live path

  dbMod = await import("../src/db.ts");
  tasksMod = await import("../src/tasks.ts");
  workMod = await import("../src/work.ts");

  // A registered repo, then materialize its repo node (the boot pass ran before this row existed).
  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(DIR, join(DATA_DIR, "repo"), DIR, dbMod.nowIso());
  dbMod.migrateMaterializeRepoNodes();
  // A materialized STORY node (work_kind='node') under the repo — the parent for the member case.
  dbMod.db
    .query(
      `INSERT INTO tasks (id, workspace_id, status, work_kind, parent_id, created_at) VALUES (?, ?, 'in_review', 'node', ?, ?)`,
    )
    .run(NODE, DIR, DIR, dbMod.nowIso());
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

// --- A. BYTE-IDENTICAL with no project node (repo.parent_id NULL) --------------
describe("P3a — byte-identical (no project node): the container ladder is {cto} then {user}", () => {
  test("standalone leaf (parent = repo) → {cto} / [cto,user] / 'cto'", () => {
    const leaf = seedTask({ status: "in_review", parentId: DIR });
    expect(workMod.resolveWorkResponder(leaf)).toEqual({ kind: "cto" });
    expect(workMod.workResponderChain(leaf)).toEqual([{ kind: "cto" }, { kind: "user" }]);
    expect(tasksMod.pendingResponder(tasksMod.getTask(leaf)!)).toBe("cto");
  });

  test("story member (parent = story node) → {work,node} / [work,cto,user] / 'story'", () => {
    const member = seedTask({ status: "in_review", parentId: NODE });
    expect(workMod.resolveWorkResponder(member)).toEqual({ kind: "work", work_id: NODE });
    expect(workMod.workResponderChain(member)).toEqual([
      { kind: "work", work_id: NODE },
      { kind: "cto" },
      { kind: "user" },
    ]);
    expect(tasksMod.pendingResponder(tasksMod.getTask(member)!)).toBe("story");
  });

  test("story node itself (parent = repo) → {cto} / [cto,user] / 'cto' (its own tier is skipped)", () => {
    // NODE is a work_kind='node' with an awaiting-feedback status (in_review). A story node resolves
    // to its container above (the repo → cto), NOT to itself — reproducing today's isTopLevelWork.
    expect(workMod.resolveWorkResponder(NODE)).toEqual({ kind: "cto" });
    expect(workMod.workResponderChain(NODE)).toEqual([{ kind: "cto" }, { kind: "user" }]);
    expect(tasksMod.pendingResponder(tasksMod.getTask(NODE)!)).toBe("cto");
  });

  test("the repo node itself → {cto} / [cto,user] (byte-identical to the pre-P3a hardcoded base)", () => {
    expect(workMod.resolveWorkResponder(DIR)).toEqual({ kind: "cto" });
    expect(workMod.workResponderChain(DIR)).toEqual([{ kind: "cto" }, { kind: "user" }]);
  });

  test("an escalated / needs-user-input leaf flattens to 'user' (the fourth mapping)", () => {
    // Exercises flattenResponder's `user` arm through the public API so all four real mappings
    // (story / cto / ceo / user) are covered by the bun-test gate.
    const escalated = seedTask({ status: "in_review", parentId: DIR });
    dbMod.db.query(`UPDATE tasks SET escalated_to_user=1 WHERE id=?`).run(escalated);
    expect(tasksMod.pendingResponder(tasksMod.getTask(escalated)!)).toBe("user");
  });

  test("'ceo' is UNREACHABLE for every real shape while no project node exists", () => {
    const leaf = seedTask({ status: "in_review", parentId: DIR });
    const member = seedTask({ status: "in_review", parentId: NODE });
    for (const id of [leaf, member, NODE, DIR]) {
      expect(workMod.workResponderChain(id).some((r) => r.kind === "ceo")).toBe(false);
    }
    for (const id of [leaf, member, NODE]) {
      expect(tasksMod.pendingResponder(tasksMod.getTask(id)!)).not.toBe("ceo");
    }
  });
});

// --- B. A TEST-ONLY project node above the repo enables the CEO rung ----------
describe("P3a — a project node above the repo (repo.parent_id → project) adds the {ceo} tier", () => {
  beforeAll(() => {
    insertProjectNode(PROJ);
    // Point the repo node at the project (the P1 reparent invariant extended one level up). No
    // teardown: this DB is an isolated temp file torn down by the top-level afterAll, and this is
    // the last describe in the file — so the synthetic project tree is never seen elsewhere.
    dbMod.db.query(`UPDATE tasks SET parent_id=? WHERE id=?`).run(PROJ, DIR);
  });

  test("a repo-level ask resolves {cto} and chains repo → [cto, ceo, user]", () => {
    expect(workMod.resolveWorkResponder(DIR)).toEqual({ kind: "cto" });
    expect(workMod.workResponderChain(DIR)).toEqual([
      { kind: "cto" },
      { kind: "ceo", project_id: PROJ },
      { kind: "user" },
    ]);
  });

  test("a leaf under the repo chains [cto, ceo, user] (its immediate responder stays {cto})", () => {
    const leaf = seedTask({ status: "in_review", parentId: DIR });
    expect(workMod.resolveWorkResponder(leaf)).toEqual({ kind: "cto" });
    expect(workMod.workResponderChain(leaf)).toEqual([
      { kind: "cto" },
      { kind: "ceo", project_id: PROJ },
      { kind: "user" },
    ]);
    expect(tasksMod.pendingResponder(tasksMod.getTask(leaf)!)).toBe("cto");
  });

  test("a story member's chain now walks through the project too: [work, cto, ceo, user]", () => {
    const member = seedTask({ status: "in_review", parentId: NODE });
    expect(workMod.workResponderChain(member)).toEqual([
      { kind: "work", work_id: NODE },
      { kind: "cto" },
      { kind: "ceo", project_id: PROJ },
      { kind: "user" },
    ]);
  });

  test("the project node itself resolves {ceo} / chains [ceo, user] (its own container tier)", () => {
    expect(workMod.resolveWorkResponder(PROJ)).toEqual({ kind: "ceo", project_id: PROJ });
    expect(workMod.workResponderChain(PROJ)).toEqual([
      { kind: "ceo", project_id: PROJ },
      { kind: "user" },
    ]);
  });

  test("a work item DIRECTLY under the project → pendingResponder 'ceo', handled without crashing", () => {
    // Synthetic test-only shape (prod never parents a leaf directly under a project) — its sole
    // purpose is to drive the immediate responder to {ceo} and prove the flatten + consumers cope.
    const ceoWork = seedTask({ status: "in_review", parentId: PROJ });
    expect(workMod.resolveWorkResponder(ceoWork)).toEqual({ kind: "ceo", project_id: PROJ });
    expect(tasksMod.pendingResponder(tasksMod.getTask(ceoWork)!)).toBe("ceo");

    // DORMANT consumer: the CTO feed neither crashes on a 'ceo' item nor owns it (no CEO feed yet).
    const ctoRow = { kind: "cto", directory_id: DIR } as import("../src/db.ts").WorkspaceAgentRow;
    let owned: string[] = [];
    expect(() => {
      owned = tasksMod.operatorActionableItems(ctoRow).map((i) => i.id);
    }).not.toThrow();
    expect(owned).not.toContain(ceoWork);
  });
});
