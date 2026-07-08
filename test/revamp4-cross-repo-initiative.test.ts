// REVAMP-4 Phase 3 / P3e (story st-1a82a2e1) + RFC Q1/Q6 Phase B1 (story st-30a7dccd) — project
// initiatives + the R5 blocked_by verification that GATED the P3e build. THE B1 CAPABILITY FLIP: a
// CEO initiative no longer FORGES stories (and launches their leaders) — it fans out CEO DIRECTIVES,
// one per target member repo, and THAT repo's CTO accepts & decomposes each into the actual stories.
// All directives (and the stories they become) share one initiative id with a completion ROLLUP that
// fires when every decomposed story lands.
//
// This suite pins:
//   FAN-OUT (B1): createCrossRepoInitiative / createProjectInitiative land one DIRECTIVE per target
//     member repo — a `directive` leaf under the repo, stamped the shared initiative id, and NO story
//     node / NO leader launched by the initiative (the whole point). A non-member target is refused
//     (409) ATOMICALLY (validate-all-first — no half-fanned directives); empty targets 400. The
//     single-repo {repo,brief} initiative now ALSO mints an initiative id (uniform rollup).
//   ACCEPT (B1): the repo CTO's acceptDirective turns a directive into the initiative_id-stamped
//     story node(s) + their leaders; the directive goes terminal `accepted`.
//   ROLLUP: listProjectInitiatives / getProjectInitiative report per-repo children — a PENDING
//     directive is the anchor until its CTO decomposes it, then the resulting stories; the initiative
//     is DONE only when EVERY child story lands `done`, and `initiative.completed` fires up the project
//     channel exactly on the LAST landing (a still-pending sibling directive GUARDS against a premature
//     fire).
//   R5 — Finding A (PROVEN GLOBAL): a LEAF in repo B blocked_by a LEAF in repo A stays `blocked`
//     until A's blocker merges, then auto-unblocks to `inactive` — cross-REPO, resolved globally by
//     the dispatcher's auto-unblock sweep (no dir scoping). This is why cross-repo fan-out is safe.
//   R5 — Finding B (NOW BUILT — Phase A1, story st-30a7dccd RFC Q3): node-on-node blocked_by
//     SEQUENCING — setWorkBlockedBy accepts a STORY NODE (still 409s a repo/project container), a
//     node held behind an unmerged blocker keeps its LEADER unlaunched (the node stays `open`), and
//     the node-arm unblock sweep AUTO-LAUNCHES it once the blocker reaches `done`. An EMPTY
//     blocked_by launches immediately (byte-identical). The node-tier mirror of Finding A.
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

/** Count PENDING directive leaves in a workspace (to assert B1 fan-out atomicity). */
function directiveCount(dir: string): number {
  return dbMod.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM tasks WHERE workspace_id=? AND work_kind='leaf' AND status='directive'`,
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

// --- B1 CAPABILITY FLIP: FAN-OUT MATERIALIZES DIRECTIVES, NOT STORIES ---------
describe("B1 — initiative fan-out lands DIRECTIVES (no story, no leader)", () => {
  test("fans ONE initiative into TWO member repos as grouped DIRECTIVES", () => {
    const beforeNodes = nodeCount(DIRA) + nodeCount(DIRB);
    const ini = storiesMod.createCrossRepoInitiative(PROJ, [
      { repo: DIRA, brief: "repo A part" },
      { repo: DIRB, brief: "repo B part" },
    ]);
    expect(ini.project_id).toBe(PROJ);
    expect(ini.initiative_id).toMatch(/^ini-/);
    expect(ini.directives).toHaveLength(2);

    // The directives SPAN both repos, each a `directive` LEAF stamped with the shared initiative id.
    const byWs = new Map(ini.directives.map((d) => [d.workspace_id, d]));
    expect([...byWs.keys()].sort()).toEqual([DIRA, DIRB]);
    for (const d of ini.directives) {
      expect(d.work_kind).toBe("leaf");
      expect(d.status).toBe("directive");
      expect(d.initiative_id).toBe(ini.initiative_id);
      // Parented UNDER its own repo node (so it bubbles repo→cto→project→ceo — the CTO decomposes it).
      expect(d.parent_id).toBe(d.workspace_id);
      expect(d.summary).toBe(d.workspace_id === DIRA ? "repo A part" : "repo B part");
      // THE WHOLE POINT OF B1: an initiative launches NO leader (the CEO delegates to the CTO, who
      // launches the leader only when it accepts the directive).
      expect(dbMod.getWorkspaceAgentRow(`ws-leader-${d.id}`)).toBeNull();
    }
    // ...and it created NO story node either — only the two directive leaves.
    expect(nodeCount(DIRA) + nodeCount(DIRB)).toBe(beforeNodes);
  });

  test("the SINGLE-repo initiative ALSO lands a directive + mints an initiative id (uniform rollup)", () => {
    const beforeNodes = nodeCount(DIRA);
    const ini = storiesMod.createProjectInitiative(PROJ, DIRA, "single-repo directive");
    expect(ini.project_id).toBe(PROJ);
    // GROUPED now (was ungrouped/no-initiative_id pre-B1) so the rollup filter is uniform.
    expect(ini.initiative_id).toMatch(/^ini-/);
    expect(ini.directives).toHaveLength(1);
    const d = ini.directives[0]!;
    expect(d.work_kind).toBe("leaf");
    expect(d.status).toBe("directive");
    expect(d.workspace_id).toBe(DIRA);
    expect(d.initiative_id).toBe(ini.initiative_id);
    expect(d.summary).toBe("single-repo directive");
    expect(dbMod.getWorkspaceAgentRow(`ws-leader-${d.id}`)).toBeNull();
    expect(nodeCount(DIRA)).toBe(beforeNodes); // no story node forged
  });

  test("a NON-member target is refused (409) ATOMICALLY — no directive for the valid target", () => {
    const before = directiveCount(DIRA) + directiveCount(DIRB);
    // DIRC is a real repo but NOT registered under PROJ → not a member.
    expect(
      statusOf(() =>
        storiesMod.createCrossRepoInitiative(PROJ, [
          { repo: DIRA, brief: "should not land" },
          { repo: DIRC, brief: "non-member" },
        ]),
      ),
    ).toBe(409);
    // validate-all-first: the DIRA directive was NEVER created (no partial fan-out).
    expect(directiveCount(DIRA) + directiveCount(DIRB)).toBe(before);
  });

  test("empty / non-array targets is a 400", () => {
    expect(statusOf(() => storiesMod.createCrossRepoInitiative(PROJ, []))).toBe(400);
    expect(statusOf(() => storiesMod.createCrossRepoInitiative(PROJ, "nope"))).toBe(400);
  });

  test("a blank brief in a target is a 400 (validated before any directive lands)", () => {
    const before = directiveCount(DIRA) + directiveCount(DIRB);
    expect(
      statusOf(() =>
        storiesMod.createCrossRepoInitiative(PROJ, [
          { repo: DIRA, brief: "ok" },
          { repo: DIRB, brief: "   " },
        ]),
      ),
    ).toBe(400);
    expect(directiveCount(DIRA) + directiveCount(DIRB)).toBe(before);
  });
});

// --- B1: THE CTO ACCEPTS → the initiative_id-stamped stories appear -----------
describe("B1 — the repo CTO's accept produces the stamped stories + their leaders", () => {
  test("acceptDirective on each repo's directive yields initiative_id-stamped story nodes + leaders", () => {
    const ini = storiesMod.createCrossRepoInitiative(PROJ, [
      { repo: DIRA, brief: "A directive" },
      { repo: DIRB, brief: "B directive" },
    ]);
    for (const d of ini.directives) {
      const res = storiesMod.acceptDirective(d.id, [{ brief: `story for ${d.workspace_id}` }]);
      expect(res.initiative_id).toBe(ini.initiative_id);
      expect(res.stories).toHaveLength(1);
      const node = tasksMod.getTask(res.stories[0]!.id)!;
      expect(node.work_kind).toBe("node");
      expect(node.status).toBe("open");
      // Inherited the directive's grouping key + parented onto the repo node (bubbles like any story).
      expect(node.initiative_id).toBe(ini.initiative_id);
      expect(node.parent_id).toBe(d.workspace_id);
      // NOW a leader IS launched — by the CTO's accept, not by the initiative.
      expect(dbMod.getWorkspaceAgentRow(`ws-leader-${node.id}`)?.desired).toBe(1);
      // The directive itself is terminal `accepted`.
      expect(tasksMod.getTask(d.id)!.status).toBe("accepted");
    }
  });
});

// --- COMPLETION ROLLUP (directive anchor + premature-completion guard) --------
describe("B1 — rollup shows pending directives, then stories; completion guarded", () => {
  test("pending directive is the anchor; done only when EVERY child STORY lands (last landing pushes)", () => {
    const ini = storiesMod.createCrossRepoInitiative(PROJ, [
      { repo: DIRA, brief: "rollup A" },
      { repo: DIRB, brief: "rollup B" },
    ]);
    const dA = ini.directives.find((d) => d.workspace_id === DIRA)!;
    const dB = ini.directives.find((d) => d.workspace_id === DIRB)!;

    // Fresh initiative — the rollup surfaces its TWO PENDING DIRECTIVES (not yet decomposed), not done.
    // Each child's brief is taken from the directive's summary via COALESCE(brief, summary).
    let found = storiesMod
      .listProjectInitiatives(PROJ)
      .find((i) => i.initiative_id === ini.initiative_id)!;
    expect(found).toBeDefined();
    expect(found.done).toBe(false);
    expect(found.children).toHaveLength(2);
    expect(found.children.every((c) => c.status === "directive")).toBe(true);
    expect(found.children.map((c) => c.brief).sort()).toEqual(["rollup A", "rollup B"]);

    // Repo A's CTO accepts → A's child becomes an OPEN story node; the accepted directive drops out of
    // the rollup, replaced by its story. Repo B's directive is STILL a pending anchor.
    const sA = storiesMod.acceptDirective(dA.id, [{ brief: "A story" }]).stories[0]!;
    found = storiesMod.getProjectInitiative(PROJ, ini.initiative_id)!;
    expect(found.children).toHaveLength(2);
    expect(found.children.map((c) => c.status).sort()).toEqual(["directive", "open"]);
    expect(found.done).toBe(false);

    // Capture initiative.completed pushes for THIS initiative.
    const completed: Array<Record<string, unknown>> = [];
    const unsub = eventsMod.subscribe((e) => {
      const ev = e as Record<string, unknown>;
      if (ev.type === "initiative.completed" && ev.initiative_id === ini.initiative_id) {
        completed.push(ev);
      }
    });
    try {
      // A's story lands `done` — but repo B's directive is STILL PENDING, so the initiative is NOT done
      // and NO completion push fires (the premature-completion GUARD: a pending directive is not-done).
      storiesMod.updateStory(sA.id, { status: "done" });
      expect(storiesMod.getProjectInitiative(PROJ, ini.initiative_id)!.done).toBe(false);
      expect(completed).toHaveLength(0);

      // Repo B's CTO accepts → its story lands. Only now is EVERY child a done story → DONE + exactly
      // ONE completion push, project-scoped.
      const sB = storiesMod.acceptDirective(dB.id, [{ brief: "B story" }]).stories[0]!;
      expect(storiesMod.getProjectInitiative(PROJ, ini.initiative_id)!.done).toBe(false);
      storiesMod.updateStory(sB.id, { status: "done" });
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

// --- R5 — FINDING B (NOW BUILT): node-on-node blocked_by SEQUENCING ------------
// The Phase A1 sequencing engine (story st-30a7dccd, RFC Q3) discharges the former gap: a STORY
// NODE may carry a dependency set (setWorkBlockedBy no longer 409s a story node), and a node held
// behind an unmerged blocker keeps its LEADER unlaunched until the blocker clears — the node-tier
// mirror of Finding A. Byte-identical until a node is actually given a blocker.
describe("P3e R5 (Finding B) — node-on-node blocked_by SEQUENCING (Phase A1)", () => {
  test("setWorkBlockedBy SUCCEEDS on a story NODE, still 409s a repo/project container", async () => {
    // A story node accepts a dependency set (stored on its OWN tasks.blocked_by).
    const blocker = storiesMod.createStory(DIRA, "an existing blocker story");
    const story = storiesMod.createStory(DIRA, "a node CAN now be blocked_by set");
    await workApiMod.setWorkBlockedBy(story.id, [blocker.id]); // no throw
    expect(tasksMod.getTask(story.id)!.blocked_by).toContain(blocker.id);
    // A repo CONTAINER (DIRA repo node) and the PROJECT container still have no dependency set → 409.
    for (const container of [DIRA, PROJ]) {
      let status = 0;
      try {
        await workApiMod.setWorkBlockedBy(container, [blocker.id]);
      } catch (e) {
        status = (e as { status?: number }).status ?? -1;
      }
      expect(status).toBe(409);
    }
  });

  test("a story with EMPTY blocked_by launches its leader IMMEDIATELY (byte-identical)", () => {
    // The overwhelming default: no dependency set → the leader is desired + launched at once,
    // exactly as before the sequencing engine landed (inert-until-used regression guard).
    const dependent = storiesMod.createStory(DIRB, "ordinary story, no blockers");
    const leader = dbMod.getWorkspaceAgentRow(`ws-leader-${dependent.id}`);
    expect(leader?.desired).toBe(1);
  });

  test("a story blocked_by another story stays leader-UNLAUNCHED until the blocker reaches done", async () => {
    // Node-tier mirror of Finding A: a story in repo B sequenced behind a story in repo A holds
    // its leader down while A is unmerged, then AUTO-LAUNCHES once A reaches `done` (global,
    // cross-repo resolution — no dir scoping in the node-arm unblock sweep).
    const blockerInA = storiesMod.createStory(DIRA, "upstream story (repo A)");
    const dependentInB = storiesMod.createStory(DIRB, "downstream story (repo B)");
    // Both launched their leaders at creation (empty blocked_by).
    expect(dbMod.getWorkspaceAgentRow(`ws-leader-${dependentInB.id}`)?.desired).toBe(1);

    // Sequence B behind A → B's leader is held DOWN (kill-on-block); the node STAYS `open`.
    await workApiMod.setWorkBlockedBy(dependentInB.id, [blockerInA.id]);
    expect(dbMod.getWorkspaceAgentRow(`ws-leader-${dependentInB.id}`)?.desired).toBe(0);
    expect(storiesMod.getStory(dependentInB.id)!.status).toBe("open");

    // A still unmerged (open) → the sweep does NOT release B.
    tasksMod.reevaluateAllBlocked();
    expect(dbMod.getWorkspaceAgentRow(`ws-leader-${dependentInB.id}`)?.desired).toBe(0);

    // A reaches `done` → the node-arm sweep AUTO-LAUNCHES B's leader.
    dbMod.db.query(`UPDATE tasks SET status='done' WHERE id=?`).run(blockerInA.id);
    tasksMod.reevaluateAllBlocked();
    expect(dbMod.getWorkspaceAgentRow(`ws-leader-${dependentInB.id}`)?.desired).toBe(1);
  });
});
