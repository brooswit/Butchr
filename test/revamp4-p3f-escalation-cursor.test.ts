// REVAMP-4 Phase 3 / P3f (story st-1a82a2e1) — HUMAN-AT-ROOT: the upward escalation cursor +
// dashboard container-attribution. escalateStoryAsk now ADVANCES `ask_responder` along the node's
// container ladder (work.workResponderChain) instead of a single cto→user hop; the terminal `user`
// rung is reached only ABOVE the root container. operatorActionableItems gains the project-scoped
// CEO ownership branch (+ a project-direct guard on the CTO branch).
//
// The bar is BYTE-IDENTICAL for the current, project-less tree (escalation cto→user;
// needs_user_input→user; the CTO dashboard unchanged), then the NEW `ceo` rung once a project node
// sits above a repo.
//
// Pure / in-process: rows are inserted directly via the db singleton (no live herdr/claude). The
// db/config singletons are SHARED across test files, so we use DEDICATED dirs + distinct ids and
// assert only on our own rows.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
const DIR = "dir-p3f"; // a repo registered UNDER the project (its node id == this dir id, S0a)
const DIR2 = "dir-p3f-solo"; // a standalone repo (NOT under a project) — the byte-identical case
const PROJ = "proj-p3f"; // a TEST-ONLY project node above DIR
const SP = "st-p3f-proj"; // a story node under DIR (→ its ask ladder reaches the CEO)
const SB = "st-p3f-solo"; // a story node under DIR2 (→ its ask ladder is cto→user, byte-identical)

let dbMod: typeof import("../src/db.ts");
let tasksMod: typeof import("../src/tasks.ts");
let workMod: typeof import("../src/work.ts");
let storiesMod: typeof import("../src/stories.ts");
let eventsMod: typeof import("../src/events.ts");

let seq = 0;
/** Seed a bare LEAF task row with the columns the structural resolution reads. */
function seedLeaf(opts: {
  status?: string;
  parentId?: string | null;
  workspaceId?: string;
  needsUserInput?: boolean;
}): string {
  const id = `p3f-${seq++}`;
  dbMod.db
    .query(
      `INSERT INTO tasks (id, workspace_id, status, work_kind, parent_id, escalated_to_user, idle, needs_user_input, has_agent, created_at)
       VALUES (?, ?, ?, 'leaf', ?, 0, 0, ?, ?, ?)`,
    )
    .run(
      id,
      opts.workspaceId ?? DIR,
      opts.status ?? "in_review",
      opts.parentId ?? null,
      opts.needsUserInput ? 1 : 0,
      opts.needsUserInput ? 1 : 0, // an in_progress+needs_user_input agent needs has_agent for isAwaitingFeedback; in_review doesn't care
      dbMod.nowIso(),
    );
  return id;
}

/** Seed an OPEN story NODE row (work_kind='node', status='open') directly — no leader is launched. */
function seedStoryNode(id: string, parentId: string | null, workspaceId: string): void {
  dbMod.db
    .query(
      `INSERT INTO tasks (id, workspace_id, brief, status, work_kind, parent_id, created_at)
       VALUES (?, ?, ?, 'open', 'node', ?, ?)`,
    )
    .run(id, workspaceId, `brief ${id}`, parentId, dbMod.nowIso());
}

/** TEST-ONLY: materialize a PROJECT container node (work_kind='project', top of the tree). */
function insertProjectNode(id: string): void {
  dbMod.db
    .query(
      `INSERT INTO tasks (id, workspace_id, status, work_kind, parent_id, created_at)
       VALUES (?, ?, 'merged', 'project', NULL, ?)`,
    )
    .run(id, DIR, dbMod.nowIso());
}

/** Collect story.attention events for `storyId` published while `fn` runs. */
async function captureAsk(storyId: string, fn: () => void): Promise<Record<string, unknown>[]> {
  const got: Record<string, unknown>[] = [];
  const unsub = eventsMod.subscribe((e: Record<string, unknown>) => {
    if (e.type === "story.attention" && e.story_id === storyId) got.push(e);
  });
  try {
    fn();
    await Promise.resolve();
  } finally {
    unsub();
  }
  return got;
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-p3f-"));
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";
  delete process.env.BUTCHR_UNIFIED_WORK; // unified routing ON (default) — assert the live path

  dbMod = await import("../src/db.ts");
  tasksMod = await import("../src/tasks.ts");
  workMod = await import("../src/work.ts");
  storiesMod = await import("../src/stories.ts");
  eventsMod = await import("../src/events.ts");

  // Two registered repos → their repo nodes; then a project node above DIR only.
  for (const d of [DIR, DIR2]) {
    dbMod.db
      .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
      .run(d, join(DATA_DIR, d), d, dbMod.nowIso());
  }
  dbMod.migrateMaterializeRepoNodes();
  insertProjectNode(PROJ);
  dbMod.db.query(`UPDATE tasks SET parent_id=? WHERE id=?`).run(PROJ, DIR); // DIR → PROJ

  // A story node under each repo (parent = the repo node id, the canonical S1 top-level shape).
  seedStoryNode(SP, DIR, DIR); // under the project-registered repo
  seedStoryNode(SB, DIR2, DIR2); // under the standalone repo
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

// --- A. BYTE-IDENTICAL: a story-ask under a repo NOT beneath a project (cto→user) -------------
describe("P3f — byte-identical story-ask cursor (repo NOT under a project): cto→user", () => {
  test("the node's ask ladder is [{cto},{user}] and ask_project_id is null", async () => {
    expect(workMod.workResponderChain(SB)).toEqual([{ kind: "cto" }, { kind: "user" }]);
    expect((await storiesMod.storyView(SB))!.ask_project_id).toBeNull();
  });

  test("open→escalate advances cto→user and republishes target:user (no marker/project_id)", async () => {
    storiesMod.openStoryAsk(SB, "Ship it?");
    expect(storiesMod.getStory(SB)!.ask_responder).toBe("cto");
    const events = await captureAsk(SB, () => storiesMod.escalateStoryAsk(SB));
    expect(storiesMod.getStory(SB)!.ask_responder).toBe("user");
    // Byte-identical event: target:user, no `marker`, no `project_id` (the pre-P3f single-hop shape).
    expect(events).toEqual([
      {
        type: "story.attention",
        story_id: SB,
        workspace_id: DIR2,
        target: "user",
        reason: "ask",
        detail: "Ship it?",
      },
    ]);
  });

  test("a second escalate 409s once the cursor is at the terminal user rung", () => {
    expect(() => storiesMod.escalateStoryAsk(SB)).toThrow(/no further rung to escalate/);
  });
});

// --- B. A repo UNDER a project: the ask ladder gains the {ceo} rung ----------------------------
describe("P3f — story-ask cursor walks cto→ceo→user under a project", () => {
  test("the node's ask ladder is [{cto},{ceo},{user}] and ask_project_id is the project", async () => {
    expect(workMod.workResponderChain(SP)).toEqual([
      { kind: "cto" },
      { kind: "ceo", project_id: PROJ },
      { kind: "user" },
    ]);
    expect((await storiesMod.storyView(SP))!.ask_project_id).toBe(PROJ);
  });

  test("escalate advances cto→ceo, publishing target:ceo + project_id + de-dup marker", async () => {
    storiesMod.openStoryAsk(SP, "Cross-repo scope call?");
    expect(storiesMod.getStory(SP)!.ask_responder).toBe("cto");
    const events = await captureAsk(SP, () => storiesMod.escalateStoryAsk(SP));
    expect(storiesMod.getStory(SP)!.ask_responder).toBe("ceo");
    expect(events).toEqual([
      {
        type: "story.attention",
        story_id: SP,
        workspace_id: DIR,
        target: "ceo",
        reason: "ask",
        detail: "Cross-repo scope call?",
        project_id: PROJ,
        marker: "Cross-repo scope call?",
      },
    ]);
  });

  test("a further escalate advances ceo→user (target:user, terminal — no marker/project_id)", async () => {
    const events = await captureAsk(SP, () => storiesMod.escalateStoryAsk(SP));
    expect(storiesMod.getStory(SP)!.ask_responder).toBe("user");
    expect(events).toEqual([
      {
        type: "story.attention",
        story_id: SP,
        workspace_id: DIR,
        target: "user",
        reason: "ask",
        detail: "Cross-repo scope call?",
      },
    ]);
  });

  test("escalating past the terminal user rung 409s", () => {
    expect(() => storiesMod.escalateStoryAsk(SP)).toThrow(/no further rung to escalate/);
  });
});

// --- C. needs_user_input short-circuits STRAIGHT to the user from a deep node ------------------
describe("P3f — needs_user_input still jumps straight to {user} from any depth", () => {
  test("a needs_user_input leaf deep under the project resolves 'user', NOT 'ceo'/'story'", () => {
    // leaf → story node (SP) → repo (DIR) → project (PROJ): a 4-rung ladder. needs_user_input is a
    // human-only OS/CLI dialog, so it short-circuits the whole bubble-up straight to the user.
    const leaf = seedLeaf({ status: "in_progress", parentId: SP, needsUserInput: true });
    expect(tasksMod.pendingResponder(tasksMod.getTask(leaf)!)).toBe("user");
    // Its static ladder still records the full path (the short-circuit is a routing decision only).
    expect(workMod.workResponderChain(leaf).map((r) => r.kind)).toEqual([
      "work",
      "cto",
      "ceo",
      "user",
    ]);
  });
});

// --- D. Dashboard container-attribution (operatorActionableItems CEO branch + CTO guard) -------
describe("P3f — operatorActionableItems attributes a project-direct item to the CEO, not the CTO", () => {
  const ceoRow = () => ({ kind: "ceo", work_id: PROJ }) as import("../src/db.ts").WorkspaceAgentRow;
  const ctoRow = () =>
    ({ kind: "cto", directory_id: DIR }) as import("../src/db.ts").WorkspaceAgentRow;

  test("a project-direct in_review item (responder 'ceo') is owned by the CEO, excluded from the CTO", () => {
    const item = seedLeaf({ status: "in_review", parentId: PROJ, workspaceId: DIR });
    expect(tasksMod.pendingResponder(tasksMod.getTask(item)!)).toBe("ceo");

    const ceoOwned = tasksMod.operatorActionableItems(ceoRow()).map((i) => i.id);
    expect(ceoOwned).toContain(item);

    // The CTO branch's `project_id == null` guard keeps a project-direct item off the CTO feed.
    const ctoOwned = tasksMod.operatorActionableItems(ctoRow()).map((i) => i.id);
    expect(ctoOwned).not.toContain(item);
  });

  test("a FAILED project-direct child is owned by the CEO, not leaked into the CTO feed", () => {
    const failed = seedLeaf({ status: "failed", parentId: PROJ, workspaceId: DIR });
    const ceoOwned = tasksMod.operatorActionableItems(ceoRow()).map((i) => i.id);
    expect(ceoOwned).toContain(failed);
    const ctoOwned = tasksMod.operatorActionableItems(ctoRow()).map((i) => i.id);
    expect(ctoOwned).not.toContain(failed);
  });

  test("a ceo workspace row with no work_id owns nothing (defensive)", () => {
    const noProj = { kind: "ceo", work_id: null } as import("../src/db.ts").WorkspaceAgentRow;
    expect(tasksMod.operatorActionableItems(noProj)).toEqual([]);
  });

  test("the AttentionItem for a project-direct item carries its project_id", () => {
    const item = seedLeaf({ status: "in_review", parentId: PROJ, workspaceId: DIR });
    const ai = tasksMod.attentionList().find((i) => i.id === item);
    expect(ai).toBeDefined();
    expect(ai!.project_id).toBe(PROJ);
    expect(ai!.story_id).toBeNull();
  });
});
