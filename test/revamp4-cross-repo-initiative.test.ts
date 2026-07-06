// REVAMP-4 Phase 3 / P3e (story st-1a82a2e1) — CROSS-REPO project initiatives + the R5 blocked_by
// verification that GATED this build. A CEO can fan ONE initiative into MULTIPLE member repos (each
// landing an ordinary repo-scoped story managed by that repo's CTO/leader), grouped by one
// initiative id with a completion ROLLUP that fires when every child lands.
//
// This suite pins:
//   FAN-OUT: createCrossRepoInitiative seeds one story per target member repo, spanning repos,
//     each stamped with the shared initiative id + managed by its own leader; a non-member target
//     is refused (409) ATOMICALLY (validate-all-first — no half-created stories); empty targets 400.
//   ROLLUP: listProjectInitiatives / getProjectInitiative report per-repo children + doneness; the
//     initiative is DONE only when EVERY child lands `done`, and `initiative.completed` fires up the
//     project channel exactly on the LAST child's landing (not before).
//   BYTE-IDENTICAL: the single-repo {repo,brief} initiative (P3d) is unchanged.
//   R5 — Finding A (PROVEN GLOBAL): a LEAF in repo B blocked_by a LEAF in repo A stays `blocked`
//     until A's blocker merges, then auto-unblocks to `inactive` — cross-REPO, resolved globally by
//     the dispatcher's auto-unblock sweep (no dir scoping). This is why cross-repo fan-out is safe.
//   R5 — Finding B (THE DOCUMENTED GAP → why sequencing is split out): node-on-node blocked_by is
//     NOT supported — setWorkBlockedBy 409s on a NODE, and a story launches its leader IMMEDIATELY
//     on creation with no dependency gate. Cross-repo SEQUENCING is deferred to a follow-up.
//
// Pure / in-process (mirrors revamp4-ceo-directive.test.ts): real service fns + the db singleton,
// BUTCHR_HERDR_BIN=true so best-effort leader launches are harmless no-ops. Dedicated dirs + ids.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
const DIRA = "dir-p3e-a"; // member repo A (cross-repo target + R5 blocker repo)
const DIRB = "dir-p3e-b"; // member repo B (cross-repo target + R5 dependent repo)
const DIRC = "dir-p3e-c"; // a repo NOT registered under PROJ (non-member 409 case)

let PROJ: string; // a project node anchored to DIRA, with DIRA + DIRB as members

let dbMod: typeof import("../src/db.ts");
let tasksMod: typeof import("../src/tasks.ts");
let workspacesMod: typeof import("../src/workspaces.ts");
let storiesMod: typeof import("../src/stories.ts");
let workApiMod: typeof import("../src/work-api.ts");
let eventsMod: typeof import("../src/events.ts");

/** Run `fn` and return the HttpError status it throws (or 0 if it does not throw). */
function statusOf(fn: () => unknown): number {
  try {
    fn();
    return 0;
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
}

let leafSeq = 0;
/** Seed a bare LEAF task row (no worktree) in a given workspace with an explicit status. */
function seedLeaf(dir: string, status: string, blockedBy?: string[]): string {
  const id = `p3e-leaf-${leafSeq++}`;
  dbMod.db
    .query(
      `INSERT INTO tasks (id, workspace_id, status, work_kind, blocked_by, has_agent, created_at)
       VALUES (?, ?, ?, 'leaf', ?, 0, ?)`,
    )
    .run(id, dir, status, blockedBy ? JSON.stringify(blockedBy) : null, dbMod.nowIso());
  return id;
}

/** Count story NODES in a workspace (to assert fan-out atomicity). */
function nodeCount(dir: string): number {
  return dbMod.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM tasks WHERE workspace_id=? AND work_kind='node'`,
    )
    .get(dir)!.n;
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-p3e-"));
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";
  delete process.env.BUTCHR_UNIFIED_WORK; // unified routing ON (default) — assert the live path

  dbMod = await import("../src/db.ts");
  tasksMod = await import("../src/tasks.ts");
  workspacesMod = await import("../src/workspaces.ts");
  storiesMod = await import("../src/stories.ts");
  workApiMod = await import("../src/work-api.ts");
  eventsMod = await import("../src/events.ts");

  // Three registered repos, then materialize their repo nodes (the boot pass at import time ran
  // before these rows existed).
  for (const [dir, sub] of [
    [DIRA, "repoA"],
    [DIRB, "repoB"],
    [DIRC, "repoC"],
  ] as const) {
    dbMod.db
      .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
      .run(dir, join(DATA_DIR, sub), dir, dbMod.nowIso());
  }
  dbMod.migrateMaterializeRepoNodes();

  // A project anchored to DIRA; register DIRA + DIRB under it (DIRC stays a non-member).
  PROJ = workspacesMod.createProject(DIRA).id;
  workspacesMod.registerRepoUnderProject(PROJ, DIRA);
  workspacesMod.registerRepoUnderProject(PROJ, DIRB);
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

// --- CROSS-REPO FAN-OUT ------------------------------------------------------
describe("P3e — cross-repo initiative fan-out", () => {
  test("fans ONE initiative into TWO member repos, grouped + each leader-managed", () => {
    const ini = storiesMod.createCrossRepoInitiative(PROJ, [
      { repo: DIRA, brief: "repo A part" },
      { repo: DIRB, brief: "repo B part" },
    ]);
    expect(ini.project_id).toBe(PROJ);
    expect(ini.initiative_id).toMatch(/^ini-/);
    expect(ini.children).toHaveLength(2);

    // The children SPAN both repos, each an OPEN node stamped with the shared initiative id.
    const byWs = new Map(ini.children.map((c) => [c.workspace_id, c]));
    expect([...byWs.keys()].sort()).toEqual([DIRA, DIRB]);
    for (const child of ini.children) {
      expect(child.status).toBe("open");
      const node = tasksMod.getTask(child.id)!;
      expect(node.work_kind).toBe("node");
      expect(node.initiative_id).toBe(ini.initiative_id);
      // Reparented onto its OWN repo node (so it bubbles repo→cto→project→ceo, exactly like P3d).
      expect(node.parent_id).toBe(child.workspace_id);
      // Managed by that repo's own LEADER (a mini-CTO), launched immediately — NOT the CEO.
      const leader = dbMod.getWorkspaceAgentRow(`ws-leader-${child.id}`);
      expect(leader?.kind).toBe("leader");
      expect(leader?.desired).toBe(1);
    }
  });

  test("a NON-member target is refused (409) ATOMICALLY — no story created for the valid target", () => {
    const before = nodeCount(DIRA) + nodeCount(DIRB);
    // DIRC is a real repo but NOT registered under PROJ → not a member.
    expect(
      statusOf(() =>
        storiesMod.createCrossRepoInitiative(PROJ, [
          { repo: DIRA, brief: "should not land" },
          { repo: DIRC, brief: "non-member" },
        ]),
      ),
    ).toBe(409);
    // validate-all-first: the DIRA story was NEVER created (no partial fan-out).
    expect(nodeCount(DIRA) + nodeCount(DIRB)).toBe(before);
  });

  test("empty / non-array targets is a 400", () => {
    expect(statusOf(() => storiesMod.createCrossRepoInitiative(PROJ, []))).toBe(400);
    expect(statusOf(() => storiesMod.createCrossRepoInitiative(PROJ, "nope"))).toBe(400);
  });

  test("a blank brief in a target is a 400 (validated before any story lands)", () => {
    const before = nodeCount(DIRA) + nodeCount(DIRB);
    expect(
      statusOf(() =>
        storiesMod.createCrossRepoInitiative(PROJ, [
          { repo: DIRA, brief: "ok" },
          { repo: DIRB, brief: "   " },
        ]),
      ),
    ).toBe(400);
    expect(nodeCount(DIRA) + nodeCount(DIRB)).toBe(before);
  });

  test("the SINGLE-repo initiative (P3d) is byte-identical (no initiative_id)", () => {
    const story = storiesMod.createProjectInitiative(PROJ, DIRA, "single-repo, unchanged");
    expect(story.status).toBe("open");
    expect(story.workspace_id).toBe(DIRA);
    // Ungrouped — a single-repo initiative carries NO initiative_id.
    expect(tasksMod.getTask(story.id)!.initiative_id).toBeNull();
  });
});

// --- COMPLETION ROLLUP -------------------------------------------------------
describe("P3e — initiative completion rollup", () => {
  test("DONE only when EVERY child lands; initiative.completed fires on the LAST landing", () => {
    const ini = storiesMod.createCrossRepoInitiative(PROJ, [
      { repo: DIRA, brief: "rollup A" },
      { repo: DIRB, brief: "rollup B" },
    ]);
    const [c1, c2] = ini.children;

    // Fresh initiative — surfaced by the rollup, not yet done.
    const found = storiesMod
      .listProjectInitiatives(PROJ)
      .find((i) => i.initiative_id === ini.initiative_id)!;
    expect(found).toBeDefined();
    expect(found.done).toBe(false);
    expect(found.children).toHaveLength(2);

    // Capture initiative.completed pushes for THIS initiative.
    const completed: Array<Record<string, unknown>> = [];
    const unsub = eventsMod.subscribe((e) => {
      const ev = e as Record<string, unknown>;
      if (ev.type === "initiative.completed" && ev.initiative_id === ini.initiative_id) {
        completed.push(ev);
      }
    });
    try {
      // First child lands → still not done, NO completion push yet.
      storiesMod.updateStory(c1.id, { status: "done" });
      expect(storiesMod.getProjectInitiative(PROJ, ini.initiative_id)!.done).toBe(false);
      expect(completed).toHaveLength(0);

      // Last child lands → DONE + exactly ONE completion push, project-scoped.
      storiesMod.updateStory(c2.id, { status: "done" });
      const done = storiesMod.getProjectInitiative(PROJ, ini.initiative_id)!;
      expect(done.done).toBe(true);
      expect(done.children.every((c) => c.status === "done")).toBe(true);
      expect(completed).toHaveLength(1);
      expect(completed[0]!.project_id).toBe(PROJ);
    } finally {
      unsub();
    }
  });
});

// --- R5 — FINDING A: cross-repo blocked_by is PROVEN GLOBAL (leaves) ----------
describe("P3e R5 (Finding A) — cross-repo LEAF blocked_by resolves globally", () => {
  test("a leaf in repo B blocked_by a leaf in repo A unblocks when A's blocker merges", () => {
    const blockerInA = seedLeaf(DIRA, "in_progress");
    const dependentInB = seedLeaf(DIRB, "blocked", [blockerInA]);

    // Cross-REPO blocker still unmerged → the dependent stays blocked (global resolution, no dir
    // scoping in the dispatcher's auto-unblock sweep).
    tasksMod.reevaluateAllBlocked();
    expect(tasksMod.getTask(dependentInB)!.status).toBe("blocked");

    // The repo-A blocker MERGES → the repo-B dependent auto-unblocks to `inactive` (dispatchable).
    dbMod.db.query(`UPDATE tasks SET status='merged' WHERE id=?`).run(blockerInA);
    tasksMod.reevaluateAllBlocked();
    expect(tasksMod.getTask(dependentInB)!.status).toBe("inactive");
  });
});

// --- R5 — FINDING B: node-on-node blocked_by is the DOCUMENTED GAP ------------
describe("P3e R5 (Finding B) — node-on-node blocked_by is NOT supported (sequencing split out)", () => {
  test("setWorkBlockedBy 409s on a NODE (a story has no settable dependency set)", async () => {
    const story = storiesMod.createStory(DIRA, "a node cannot be blocked_by set");
    let status = 0;
    try {
      await workApiMod.setWorkBlockedBy(story.id, ["anything"]);
    } catch (e) {
      status = (e as { status?: number }).status ?? -1;
    }
    expect(status).toBe(409);
  });

  test("a story launches its leader IMMEDIATELY on creation — no dependency gate", () => {
    // Even with an unmerged sibling that a CEO might WANT to sequence behind, the new story's
    // leader is desired + launched at once. This is exactly why cross-repo SEQUENCING needs a
    // separate node-gating primitive and is deferred to a follow-up.
    const blocker = storiesMod.createStory(DIRA, "would-be blocker (still open)");
    expect(storiesMod.getStory(blocker.id)!.status).toBe("open");
    const dependent = storiesMod.createStory(DIRB, "would-be dependent");
    const leader = dbMod.getWorkspaceAgentRow(`ws-leader-${dependent.id}`);
    expect(leader?.desired).toBe(1); // launched immediately, ignoring any intended dependency
  });
});
