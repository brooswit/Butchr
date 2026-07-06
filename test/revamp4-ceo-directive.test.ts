// REVAMP-4 Phase 3 / P3d (story st-1a82a2e1) — the CEO DIRECTIVE SURFACE: a running CEO's creation
// authority. Register repos under its project (reparent repo.parent_id → project) + seed project-
// level initiatives that delegate to a member repo's CTO/leader. Authority is LEVEL-BASED
// (assertCreationAllowed) and every EXISTING creation path stays byte-identical.
//
// This suite pins:
//   A. LEVEL AUTHORITY (pure fn): each tier may create only the tier one level below it
//      (ceo→repo/story, cto→story, leader→subtask); a CEO cannot create a build leaf, a CTO cannot
//      create a project, a leader cannot create a story — all 403.
//   B. BYTE-IDENTICAL: assertWorkspaceTaskCreationAllowed still 409s a standalone leaf + allows
//      rollback (the existing CTO/operator gate is untouched).
//   C. REGISTER: registerRepoUnderProject reparents a repo node → the project; idempotent; rejects
//      a non-repo id / a repo already under another project; unregister is reversible (→ NULL);
//      listProjectRepos surfaces the members.
//   D. LADDER: after registration, repo-work bubbles repo→{cto}→project→{ceo}→{user} via the P3a
//      container ladder — immediate responder stays {cto} + project_id stays null for repo-work
//      (opt-in, non-disruptive). An UNREGISTERED repo's work stays [{cto},{user}].
//   E. INITIATIVE OWNERSHIP: a CEO initiative is a STORY seeded into a MEMBER repo (member-guarded,
//      single-repo) that is managed by that repo's LEADER and whose asks/completion route to the
//      repo's CTO — the CEO DELEGATES (immediate responder {cto}), it does not own the story; the
//      CEO sits above only via the escalation chain.
//   F. escalateStoryAsk stays byte-identical (cto→user single hop) for a NON-project-repo story —
//      P3d does NOT touch the runtime escalation cursor (its CEO-rung generalization is deferred).
//
// Pure / in-process: rows are created via the real service functions + the db singleton (no live
// herdr/claude — BUTCHR_HERDR_BIN=true makes the best-effort leader launch a harmless no-op). The
// db/config singletons are SHARED across test files, so we use DEDICATED dirs + distinct ids and
// assert only on our own rows.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
const DIRA = "dir-p3d-a"; // a repo registered under PROJ (register + ladder + initiative)
const DIRB = "dir-p3d-b"; // a repo kept UNREGISTERED (escalate + reject cases)

let PROJ: string; // a project node (anchored to DIRA)
let PROJ2: string; // a second project node (foreign-project cases)

let dbMod: typeof import("../src/db.ts");
let tasksMod: typeof import("../src/tasks.ts");
let workMod: typeof import("../src/work.ts");
let workspacesMod: typeof import("../src/workspaces.ts");
let storiesMod: typeof import("../src/stories.ts");

let seq = 0;
/** Seed a bare LEAF task row under `parentId` (the columns structural resolution reads). */
function seedLeaf(parentId: string | null): string {
  const id = `p3d-${seq++}`;
  dbMod.db
    .query(
      `INSERT INTO tasks (id, workspace_id, status, work_kind, parent_id, escalated_to_user, idle, has_agent, created_at)
       VALUES (?, ?, 'in_review', 'leaf', ?, 0, 0, 0, ?)`,
    )
    .run(id, parentId === DIRB ? DIRB : DIRA, parentId, dbMod.nowIso());
  return id;
}

/** Run `fn` and return the HttpError status it throws (or 0 if it does not throw). */
function statusOf(fn: () => unknown): number {
  try {
    fn();
    return 0;
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-p3d-"));
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";
  delete process.env.BUTCHR_UNIFIED_WORK; // unified routing ON (default) — assert against the live path

  dbMod = await import("../src/db.ts");
  tasksMod = await import("../src/tasks.ts");
  workMod = await import("../src/work.ts");
  workspacesMod = await import("../src/workspaces.ts");
  storiesMod = await import("../src/stories.ts");

  // Two registered repos (via the writable `workspaces` view → `directory` table), then
  // materialize their repo nodes (the boot pass at import time ran before these rows existed).
  for (const [dir, sub] of [
    [DIRA, "repoA"],
    [DIRB, "repoB"],
  ] as const) {
    dbMod.db
      .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
      .run(dir, join(DATA_DIR, sub), dir, dbMod.nowIso());
  }
  dbMod.migrateMaterializeRepoNodes();

  // Two project nodes (the real P3c surface). Anchored to a real directory (createProject requires
  // one). parent_id NULL — top of the tree.
  PROJ = workspacesMod.createProject(DIRA).id;
  PROJ2 = workspacesMod.createProject(DIRB).id;
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

// --- A. Level-based creation authority (pure) --------------------------------
describe("REVAMP-4 P3d — assertCreationAllowed level rule", () => {
  test("each tier may create the tier ONE level below it", () => {
    expect(() => tasksMod.assertCreationAllowed("ceo", "repo")).not.toThrow();
    expect(() => tasksMod.assertCreationAllowed("ceo", "story")).not.toThrow(); // initiative
    expect(() => tasksMod.assertCreationAllowed("cto", "story")).not.toThrow();
    expect(() => tasksMod.assertCreationAllowed("leader", "subtask")).not.toThrow();
  });

  test("reaching the wrong level is refused (403) — ceo↛subtask, cto↛project, leader↛story", () => {
    expect(statusOf(() => tasksMod.assertCreationAllowed("ceo", "subtask"))).toBe(403); // no direct leaf
    expect(statusOf(() => tasksMod.assertCreationAllowed("ceo", "project"))).toBe(403); // not its own tier
    expect(statusOf(() => tasksMod.assertCreationAllowed("cto", "project"))).toBe(403);
    expect(statusOf(() => tasksMod.assertCreationAllowed("cto", "repo"))).toBe(403);
    expect(statusOf(() => tasksMod.assertCreationAllowed("cto", "subtask"))).toBe(403);
    expect(statusOf(() => tasksMod.assertCreationAllowed("leader", "story"))).toBe(403);
    expect(statusOf(() => tasksMod.assertCreationAllowed("leader", "repo"))).toBe(403);
  });
});

// --- B. Existing creation gate byte-identical --------------------------------
describe("REVAMP-4 P3d — existing creation gate is byte-identical", () => {
  test("assertWorkspaceTaskCreationAllowed still 409s a standalone leaf + allows rollback", () => {
    expect(statusOf(() => tasksMod.assertWorkspaceTaskCreationAllowed("task"))).toBe(409);
    expect(() => tasksMod.assertWorkspaceTaskCreationAllowed("rollback")).not.toThrow();
  });
});

// --- C. Register / unregister / list repos under a project -------------------
describe("REVAMP-4 P3d — register repos under a project", () => {
  test("registerRepoUnderProject reparents the repo node → the project (idempotent)", () => {
    const repo = workspacesMod.registerRepoUnderProject(PROJ, DIRA);
    expect(repo.parent_id).toBe(PROJ);
    expect(tasksMod.getTask(DIRA)!.parent_id).toBe(PROJ);
    // Idempotent — a second register is a no-op success.
    expect(workspacesMod.registerRepoUnderProject(PROJ, DIRA).parent_id).toBe(PROJ);
  });

  test("rejects a non-repo id (404) and a repo already under another project (409)", () => {
    // A project id is not a repo node → 404 (getRepoNode filters work_kind='repo').
    expect(statusOf(() => workspacesMod.registerRepoUnderProject(PROJ, PROJ2))).toBe(404);
    // A leaf id is not a repo node → 404.
    const leaf = seedLeaf(DIRA);
    expect(statusOf(() => workspacesMod.registerRepoUnderProject(PROJ, leaf))).toBe(404);
    // DIRA is registered under PROJ — registering it under PROJ2 is refused (unregister first).
    expect(statusOf(() => workspacesMod.registerRepoUnderProject(PROJ2, DIRA))).toBe(409);
  });

  test("listProjectRepos surfaces the members", () => {
    const ids = workspacesMod.listProjectRepos(PROJ).map((r) => r.id);
    expect(ids).toContain(DIRA);
    expect(workspacesMod.listProjectRepos(PROJ2)).toEqual([]); // no members yet
  });

  test("unregister is reversible (→ NULL) + idempotent; a foreign project's repo is refused (409)", () => {
    // Roundtrip on DIRB so DIRA stays registered for the ladder/initiative tests.
    expect(workspacesMod.registerRepoUnderProject(PROJ, DIRB).parent_id).toBe(PROJ);
    expect(workspacesMod.unregisterRepoFromProject(PROJ, DIRB).parent_id).toBeNull();
    // Idempotent — already unregistered.
    expect(workspacesMod.unregisterRepoFromProject(PROJ, DIRB).parent_id).toBeNull();
    // DIRA belongs to PROJ, so unregistering it FROM PROJ2 is refused.
    expect(statusOf(() => workspacesMod.unregisterRepoFromProject(PROJ2, DIRA))).toBe(409);
    expect(tasksMod.getTask(DIRA)!.parent_id).toBe(PROJ); // untouched
  });
});

// --- D. Responder ladder after registration ----------------------------------
describe("REVAMP-4 P3d — repo-work bubbles to the CEO after registration (opt-in)", () => {
  test("an UNREGISTERED repo's top-level work stays [{cto},{user}] (no ceo tier)", () => {
    const leaf = seedLeaf(DIRB); // DIRB is not under any project
    expect(workMod.resolveWorkResponder(leaf)).toEqual({ kind: "cto" });
    expect(workMod.workResponderChain(leaf)).toEqual([{ kind: "cto" }, { kind: "user" }]);
  });

  test("a REGISTERED repo's top-level work chains repo→cto→project→ceo→user", () => {
    const leaf = seedLeaf(DIRA); // DIRA is registered under PROJ
    // Immediate responder is STILL the CTO — byte-identical day-to-day ownership.
    expect(workMod.resolveWorkResponder(leaf)).toEqual({ kind: "cto" });
    expect(tasksMod.pendingResponder(tasksMod.getTask(leaf)!)).toBe("cto");
    // project_id stays null for repo-work (its parent is the repo, not the project directly).
    expect(workMod.projectParentOf(leaf)).toBeNull();
    // Only the escalation CHAIN gains the {ceo} tier.
    expect(workMod.workResponderChain(leaf)).toEqual([
      { kind: "cto" },
      { kind: "ceo", project_id: PROJ },
      { kind: "user" },
    ]);
  });
});

// --- E. Initiative ownership (the CEO delegates, does not own) ----------------
describe("REVAMP-4 P3d — a CEO initiative delegates to the member repo's CTO/leader", () => {
  test("createProjectInitiative seeds a story into the member repo, managed by that repo's LEADER", () => {
    const story = storiesMod.createProjectInitiative(PROJ, DIRA, "ship the widget");
    // The story is a NODE landed OPEN in the member repo's workspace.
    expect(story.status).toBe("open");
    expect(story.workspace_id).toBe(DIRA);
    const node = tasksMod.getTask(story.id)!;
    expect(node.work_kind).toBe("node");
    // Reparented onto the repo node so its chain reaches the CEO.
    expect(node.parent_id).toBe(DIRA);
    // Managed by the repo's own LEADER (the mini-CTO onStoryCreated materialized), NOT the CEO.
    const leaderRow = dbMod.getWorkspaceAgentRow(`ws-leader-${story.id}`);
    expect(leaderRow?.kind).toBe("leader");
    expect(leaderRow?.work_id).toBe(story.id);
    expect(leaderRow?.directory_id).toBe(DIRA);
    expect(leaderRow?.desired).toBe(1);
    // Story-level asks / completion route to the repo's CTO (immediate responder), CEO above only
    // via the chain — proving the CEO DELEGATES, it does not own the story's lifecycle.
    expect(workMod.resolveWorkResponder(story.id)).toEqual({ kind: "cto" });
    expect(workMod.workResponderChain(story.id)).toEqual([
      { kind: "cto" },
      { kind: "ceo", project_id: PROJ },
      { kind: "user" },
    ]);
  });

  test("member-guard + single-repo: a non-member repo is refused (409), a CEO cannot direct-leaf", () => {
    // DIRA belongs to PROJ, not PROJ2 → not a member of PROJ2.
    expect(statusOf(() => storiesMod.createProjectInitiative(PROJ2, DIRA, "x"))).toBe(409);
    // DIRB is not registered under PROJ → not a member.
    expect(statusOf(() => storiesMod.createProjectInitiative(PROJ, DIRB, "x"))).toBe(409);
    // The authority rule keeps a CEO from creating a build leaf directly.
    expect(statusOf(() => tasksMod.assertCreationAllowed("ceo", "subtask"))).toBe(403);
  });
});

// --- F. escalateStoryAsk byte-identical for a non-project-repo story ----------
describe("REVAMP-4 P3d — escalateStoryAsk stays byte-identical (cto→user single hop)", () => {
  test("a NON-project-repo story escalates cto→user unchanged (P3d does not touch the cursor)", () => {
    // DIRB is NOT registered under any project — the pre-P3d shape.
    const story = storiesMod.createStory(DIRB, "plain story");
    storiesMod.openStoryAsk(story.id, "which approach?");
    expect(storiesMod.getStory(story.id)!.ask_responder).toBe("cto");
    const escalated = storiesMod.escalateStoryAsk(story.id);
    expect(escalated.ask_responder).toBe("user"); // single hop cto→user, unchanged
  });
});
