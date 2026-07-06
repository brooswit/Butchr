// REVAMP-4 Phase 1 / S1 (story st-1a82a2e1) — REPARENT top-level Work under its REPO node +
// make the responder CONTAINER-AWARE. The bar is BYTE-IDENTICAL routing/behavior for every
// existing shape: this phase changes DATA (a top-level Work's parent_id now points at its repo
// node instead of NULL) + internal resolution, but NO observable routing changes.
//
// This suite pins:
//   A. migrateReparentTopLevelUnderRepo repoints top-level leaves + story NODES to their repo
//      node; repo nodes stay parent_id NULL; it is idempotent + the full boot pass re-runs clean.
//   B. resolveWorkResponder / workResponderChain / pendingResponder / taskView.story_id are
//      BYTE-IDENTICAL for the two parent forms (parent_id NULL vs parent_id = the repo node),
//      across all three shapes (standalone leaf, story member, story node) — HARDENING #2: the
//      comparison is between the TWO forms, not against a hardcoded expectation.
//   C. HARDENING #1 (the whole point of the D re-projection): a repo-parented TOP-LEVEL item still
//      lands in the CTO feed — operatorActionableItems' CTO branch (story_id==null) OWNS it exactly
//      as it did when the parent was NULL (a `cto`-awaiting item AND a `failed` item).
//   D. strandedItems still surfaces a top-level idea + a dead-blocked task after the repoint (E).
//   E. escalateTask succeeds on a repo-parented top-level task (F).
//   F. the write paths (createTask / assignTaskToStory-clear / detachStoryMembers) re-introduce a
//      top-level task's parent as its REPO node, not NULL (G).
//
// Pure / in-process: rows are inserted directly via the db singleton (no live herdr/claude). The
// db/config singletons are SHARED across test files, so we use a DEDICATED dir + distinct ids and
// assert only on our own rows.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
const DIR = "dir-reparent-s1"; // the repo node id == this dir id (S0a construction)
const NODE = "node-reparent-s1"; // a materialized STORY node (parent of member cases)

let dbMod: typeof import("../src/db.ts");
let tasksMod: typeof import("../src/tasks.ts");
let workMod: typeof import("../src/work.ts");
let storiesMod: typeof import("../src/stories.ts");

let seq = 0;
function seed(
  opts: {
    status?: string;
    parentId?: string | null;
    workKind?: string;
    escalated?: number;
    idle?: number;
    hasAgent?: number;
    blockedBy?: string[];
  } = {},
): string {
  const id = `s1-${seq++}`;
  dbMod.db
    .query(
      `INSERT INTO tasks (id, workspace_id, status, work_kind, parent_id, escalated_to_user, idle, has_agent, blocked_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      DIR,
      opts.status ?? "in_review",
      opts.workKind ?? "leaf",
      opts.parentId ?? null,
      opts.escalated ?? 0,
      opts.idle ?? 0,
      opts.hasAgent ?? 0,
      JSON.stringify(opts.blockedBy ?? []),
      dbMod.nowIso(),
    );
  return id;
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-reparent-s1-"));
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";
  delete process.env.BUTCHR_UNIFIED_WORK; // unified routing ON (default) — assert against the live path

  dbMod = await import("../src/db.ts");
  tasksMod = await import("../src/tasks.ts");
  workMod = await import("../src/work.ts");
  storiesMod = await import("../src/stories.ts");

  // A registered repo (via the writable `workspaces` view → `directory` table), then materialize
  // its repo node (the boot pass at import time ran before this row existed).
  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(DIR, join(DATA_DIR, "repo"), DIR, dbMod.nowIso());
  dbMod.migrateMaterializeRepoNodes();
  // A materialized STORY node (work_kind='node') under the repo — the parent for member cases.
  dbMod.db
    .query(
      `INSERT INTO tasks (id, workspace_id, status, work_kind, parent_id, created_at) VALUES (?, ?, 'merged', 'node', ?, ?)`,
    )
    .run(NODE, DIR, DIR, dbMod.nowIso());
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

// --- A. The repoint migration ------------------------------------------------
describe("REVAMP-4 S1 — migrateReparentTopLevelUnderRepo", () => {
  test("repoints top-level leaves + story nodes to their repo node; repo node stays NULL", () => {
    // Fresh top-level rows with parent_id NULL (pre-repoint shape).
    const leaf = seed({ status: "in_review", parentId: null });
    dbMod.db
      .query(
        `INSERT INTO tasks (id, workspace_id, status, work_kind, parent_id, created_at) VALUES (?, ?, 'merged', 'node', NULL, ?)`,
      )
      .run("s1-toplevel-node", DIR, dbMod.nowIso());

    dbMod.migrateReparentTopLevelUnderRepo();

    // Both a top-level leaf and a top-level story node now point at the repo node (id == DIR).
    expect(tasksMod.getTask(leaf)!.parent_id).toBe(DIR);
    expect(tasksMod.getTask("s1-toplevel-node")!.parent_id).toBe(DIR);
    // The repo node itself stays NULL (it is the top of the tree until the project tier).
    expect(tasksMod.getTask(DIR)!.parent_id).toBeNull();
    // A story MEMBER (parent is a story node) is untouched — still points at its node.
    const member = seed({ status: "in_review", parentId: NODE });
    dbMod.migrateReparentTopLevelUnderRepo();
    expect(tasksMod.getTask(member)!.parent_id).toBe(NODE);
  });

  test("is idempotent — a second run repoints nothing new (already non-NULL)", () => {
    const leaf = seed({ parentId: null });
    dbMod.migrateReparentTopLevelUnderRepo();
    expect(tasksMod.getTask(leaf)!.parent_id).toBe(DIR);
    // Re-run: the row already has a non-NULL parent, so the `parent_id IS NULL` filter skips it.
    dbMod.migrateReparentTopLevelUnderRepo();
    dbMod.migrateReparentTopLevelUnderRepo();
    expect(tasksMod.getTask(leaf)!.parent_id).toBe(DIR); // unchanged, not double-touched
  });

  test("the full boot migration pass re-runs as a clean no-op (repo node stays NULL)", () => {
    expect(() => dbMod.runMigrations()).not.toThrow();
    expect(tasksMod.getTask(DIR)!.parent_id).toBeNull();
    expect(tasksMod.getTask(DIR)!.work_kind).toBe("repo");
  });
});

// --- B. Byte-identical routing across the two parent forms (HARDENING #2) -----
describe("REVAMP-4 S1 — routing is byte-identical: parent_id NULL vs repo node", () => {
  // The rigorous form of the requirement: take ONE logical row, resolve it with parent_id NULL
  // (pre-repoint), FLIP that same parent_id to the repo node (post-repoint) IN PLACE, resolve
  // again, and assert every resolver returns an IDENTICAL result across the pair — not against a
  // hardcoded expectation. `flipId` is the row whose parent toggles (for a story member that is
  // the member's NODE, so the member's own resolution is measured across the two node-parent forms).
  function snapshot(measureId: string) {
    return {
      responder: workMod.resolveWorkResponder(measureId),
      chain: workMod.workResponderChain(measureId),
      pending: tasksMod.pendingResponder(tasksMod.getTask(measureId)!),
      storyId: tasksMod.taskView(measureId)!.story_id,
    };
  }
  function assertParityAcrossFlip(measureId: string, flipId: string) {
    dbMod.db.query(`UPDATE tasks SET parent_id=NULL WHERE id=?`).run(flipId);
    const nullForm = snapshot(measureId);
    dbMod.db.query(`UPDATE tasks SET parent_id=? WHERE id=?`).run(DIR, flipId);
    const repoForm = snapshot(measureId);
    expect(repoForm.responder).toEqual(nullForm.responder);
    expect(JSON.stringify(repoForm.chain)).toBe(JSON.stringify(nullForm.chain));
    expect(repoForm.pending).toBe(nullForm.pending);
    expect(repoForm.storyId).toBe(nullForm.storyId);
    return repoForm; // the post-repoint (repo-parent) snapshot, for concrete-value assertions
  }

  test("standalone leaf — flipping its parent NULL↔repo is byte-identical (→ cto / [cto,user] / null)", () => {
    const leaf = seed({ status: "in_review", parentId: null });
    const repoForm = assertParityAcrossFlip(leaf, leaf);
    expect(repoForm.responder).toEqual({ kind: "cto" });
    expect(repoForm.chain).toEqual([{ kind: "cto" }, { kind: "user" }]);
    expect(repoForm.pending).toBe("cto");
    expect(repoForm.storyId).toBeNull();
  });

  test("standalone leaf ESCALATED — flipping to a repo parent still routes to the user (not dropped)", () => {
    const leaf = seed({ status: "in_review", parentId: null, escalated: 1 });
    const repoForm = assertParityAcrossFlip(leaf, leaf);
    expect(repoForm.pending).toBe("user"); // escalated_to_user honored on a repo-parented top-level task
  });

  test("story member — flipping the story NODE's parent NULL↔repo leaves the member's routing identical", () => {
    dbMod.db
      .query(
        `INSERT INTO tasks (id, workspace_id, status, work_kind, parent_id, created_at) VALUES ('s1-mem-node', ?, 'merged', 'node', NULL, ?)`,
      )
      .run(DIR, dbMod.nowIso());
    const member = seed({ status: "in_review", parentId: "s1-mem-node" });
    // Measure the MEMBER across the two forms of its NODE's parent (NULL vs repo).
    const repoForm = assertParityAcrossFlip(member, "s1-mem-node");
    // A member is `story`; its chain walks up through its node to cto→user (the repo tier is NOT
    // pushed — the break-before-repo guard covers exactly this).
    expect(repoForm.pending).toBe("story");
    expect(repoForm.chain).toEqual([
      { kind: "work", work_id: "s1-mem-node" },
      { kind: "cto" },
      { kind: "user" },
    ]);
    expect(repoForm.storyId).toBe("s1-mem-node"); // a real member re-projects to its node, not null
  });

  test("story node itself — flipping its OWN parent NULL↔repo is byte-identical (→ cto, top-level)", () => {
    dbMod.db
      .query(
        `INSERT INTO tasks (id, workspace_id, status, work_kind, parent_id, created_at) VALUES ('s1-lone-node', ?, 'merged', 'node', NULL, ?)`,
      )
      .run(DIR, dbMod.nowIso());
    const repoForm = assertParityAcrossFlip("s1-lone-node", "s1-lone-node");
    expect(repoForm.responder).toEqual({ kind: "cto" });
    expect(workMod.isTopLevelWork("s1-lone-node")).toBe(true); // repo-parented ⇒ still top-level
  });
});

// --- C. CTO-feed regression (HARDENING #1) -----------------------------------
describe("REVAMP-4 S1 — a repo-parented top-level item still lands in the CTO feed", () => {
  const ctoRow = { kind: "cto", directory_id: DIR } as import("../src/db.ts").WorkspaceAgentRow;

  test("operatorActionableItems' CTO branch OWNS a repo-parented in_review item, identical to NULL parent", () => {
    const nullForm = seed({ status: "in_review", parentId: null });
    const repoForm = seed({ status: "in_review", parentId: DIR });
    const owned = tasksMod.operatorActionableItems(ctoRow).map((i) => i.id);
    // The whole reason the D re-projection exists: the repo-parented item is CTO-owned (story_id
    // re-collapsed to null → routeOwns/operatorActionableItems' `story_id == null` branch owns it).
    expect(owned).toContain(repoForm);
    expect(owned).toContain(nullForm); // and the NULL-parent form is owned identically
    // Prove it is via the CTO (story_id==null) path, not a leader path.
    const item = tasksMod.attentionList().find((i) => i.id === repoForm)!;
    expect(item.story_id).toBeNull();
    expect(item.pending_responder).toBe("cto");
  });

  test("a repo-parented top-level FAILED item is CTO-owned (story_id==null, failed)", () => {
    const failed = seed({ status: "failed", parentId: DIR });
    const owned = tasksMod.operatorActionableItems(ctoRow).map((i) => i.id);
    expect(owned).toContain(failed);
    expect(tasksMod.attentionList().find((i) => i.id === failed)!.story_id).toBeNull();
  });

  test("a story MEMBER is NOT in the CTO feed (owned by its leader, story_id non-null)", () => {
    const member = seed({ status: "in_review", parentId: NODE });
    const owned = tasksMod.operatorActionableItems(ctoRow).map((i) => i.id);
    expect(owned).not.toContain(member);
    expect(tasksMod.attentionList().find((i) => i.id === member)!.story_id).toBe(NODE);
  });
});

// --- D. strandedItems still surfaces top-level idea + dead-blocked (E) --------
describe("REVAMP-4 S1 — strandedItems surfaces repo-parented top-level items", () => {
  test("a top-level idea + a top-level dead-blocked task both surface after the repoint", () => {
    // Strand the CTO so strandedItems runs its F1/F2 findings branch.
    dbMod.db.query(`UPDATE workspaces SET cto_enabled=0 WHERE id=?`).run(DIR);
    const idea = seed({ status: "idea", parentId: DIR });
    // A blocked task depending on a GONE (never-mergeable → dead) blocker.
    const deadBlocked = seed({ status: "blocked", parentId: DIR, blockedBy: ["s1-gone-blocker"] });

    const items = tasksMod.strandedItems(DIR);
    const byId = new Map(items.map((i) => [i.workId, i]));
    expect(byId.get(idea)?.kind).toBe("idea");
    expect(byId.get(deadBlocked)?.kind).toBe("dead_blocked");
  });
});

// --- E. escalateTask on a repo-parented top-level task (F) --------------------
describe("REVAMP-4 S1 — escalateTask on a repo-parented top-level task", () => {
  test("succeeds (a repo parent is NOT a story member)", () => {
    const top = seed({ status: "in_review", parentId: DIR });
    const view = tasksMod.escalateTask(top);
    expect(view.escalated_to_user).toBe(1);
    // A story MEMBER, by contrast, is still rejected (terminal at the leader).
    const member = seed({ status: "in_review", parentId: NODE });
    expect(() => tasksMod.escalateTask(member)).toThrow(/story member/);
  });
});

// --- F. write paths re-introduce a repo parent, not NULL (G) ------------------
describe("REVAMP-4 S1 — write paths keep top-level Work parented at its repo node", () => {
  test("deleteStory detaches its members onto the repo node (correlated subquery, not NULL)", () => {
    // A materialized story with one member; deleting it detaches the member — which must land on
    // the repo node, not NULL (the invariant going forward).
    dbMod.db
      .query(
        `INSERT INTO tasks (id, workspace_id, status, work_kind, parent_id, created_at) VALUES ('s1-detach-node', ?, 'open', 'node', ?, ?)`,
      )
      .run(DIR, DIR, dbMod.nowIso());
    const member = seed({ status: "in_review", parentId: "s1-detach-node" });
    storiesMod.deleteStory("s1-detach-node");
    expect(tasksMod.getTask(member)!.parent_id).toBe(DIR); // repo node, not NULL
    expect(tasksMod.getTask("s1-detach-node")).toBeNull(); // the node row is removed
  });

  test("assignTaskToStory(id, null) clears membership onto the repo node (not NULL)", () => {
    const member = seed({ status: "in_review", parentId: NODE });
    storiesMod.assignTaskToStory(member, null);
    expect(tasksMod.getTask(member)!.parent_id).toBe(DIR); // cleared → repo node, not NULL
    expect(tasksMod.taskView(member)!.story_id).toBeNull(); // and it re-projects to a top-level item
  });

  test("owningRepoOf(workspace) resolves the repo node used by the createTask/assign write paths", () => {
    // The write paths compute `storyId ?? owningRepoOf(workspace_id)`; the repo node id == the
    // workspace id, so owningRepoOf(DIR) is exactly the parent a new top-level task receives.
    expect(workMod.owningRepoOf(DIR)).toBe(DIR);
  });
});
