// Tests for the UNIFIED WORK API facade (src/work-api.ts) — WORK + WORKSPACE unification
// step 5. `/api/work/*` resolves a work id to a LEAF (task) or a NODE (story) and dispatches
// to the EXISTING tasks.ts / stories.ts operations. These tests prove:
//   (a) resolveWork distinguishes leaf/node and 404s on an unknown id;
//   (b) create maps to createStory (node) + createSubtask (leaf child);
//   (c) the unified WorkView EMBEDS the existing taskView / storyView byte-for-byte (the
//       facade is a pure superset — it adds work_kind + the informational responder, and
//       changes nothing about the embedded view), and reads cause no state drift;
//   (d) leaf verbs (approve/reject/priority) map to the task ops and 409 on a node; blocked_by
//       maps to the task op for a leaf AND accepts a story node (node-on-node sequencing), still
//       409ing a repo/project container; node verbs (ask/escalate/answer) map to the story-ask
//       ops and 409 on a leaf;
//   (e) the unified answer/escalate verbs route by kind.
//
// createSubtask exercises the REAL createTask (worktree + task.md + DB row), so we stand up
// a throwaway git repo with one commit. Pure / in-process otherwise: BUTCHR_HERDR_BIN → `true`
// so every herdr probe (incl. the story-leader launch hook on createStory) is a no-op.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
// Distinct ids — the db/config singletons are shared across test files.
const WS = "workapi-ws";
const WS2 = "workapi-ws2";

let workApi: typeof import("../src/work-api.ts");
let storiesMod: typeof import("../src/stories.ts");
let tasksMod: typeof import("../src/tasks.ts");
let dbMod: typeof import("../src/db.ts");
let harnessMod: typeof import("../src/harness.ts");
let waMod: typeof import("../src/workspace-agent.ts");

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-workapi-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-workapi-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  const g = (args: string[]) =>
    execFileSync("git", ["-C", REPO_ROOT, ...args], { stdio: "ignore" });
  execFileSync("git", ["init", "-q", REPO_ROOT], { stdio: "ignore" });
  g(["config", "user.email", "test@butchr.local"]);
  g(["config", "user.name", "butchr test"]);
  g(["commit", "--allow-empty", "-q", "-m", "init"]);

  dbMod = await import("../src/db.ts");
  storiesMod = await import("../src/stories.ts");
  tasksMod = await import("../src/tasks.ts");
  workApi = await import("../src/work-api.ts");
  harnessMod = await import("../src/harness.ts");
  waMod = await import("../src/workspace-agent.ts");

  // WS lives at the git repo root (createTask makes worktrees there); WS2 is just a row.
  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(WS, REPO_ROOT, "main", dbMod.nowIso());
  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(WS2, join(REPO_ROOT, "ws2"), "other", dbMod.nowIso());
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

/** Capture the HttpError status thrown by a sync call, or undefined if it returns. */
function syncStatusOf(fn: () => unknown): number | undefined {
  try {
    fn();
  } catch (e) {
    return (e as { status?: number }).status;
  }
  return undefined;
}

/** Capture the HttpError status thrown by an async call, or undefined if it resolves. */
async function statusOf(fn: () => Promise<unknown>): Promise<number | undefined> {
  try {
    await fn();
  } catch (e) {
    return (e as { status?: number }).status;
  }
  return undefined;
}

describe("resolveWork: id → leaf (task) | node (story)", () => {
  test("resolves a task to a LEAF and a story to a NODE; 404s on an unknown id", async () => {
    const node = workApi.createWork(WS, "resolve me");
    const leaf = await workApi.createWorkChild(node.id, { prompt: "a child task" });

    const rLeaf = workApi.resolveWork(leaf.id);
    expect(rLeaf.kind).toBe("leaf");
    const rNode = workApi.resolveWork(node.id);
    expect(rNode.kind).toBe("node");

    expect(syncStatusOf(() => workApi.resolveWork("no-such-work"))).toBe(404);
  });
});

describe("createWork / createWorkChild map to createStory / createSubtask", () => {
  test("createWork makes a top-level NODE (story) in the workspace", () => {
    const node = workApi.createWork(WS, "Ship the unified surface");
    expect(node.status).toBe("open");
    expect(node.workspace_id).toBe(WS);
    // It is the SAME story createStory makes (round-trips through getStory).
    expect(storiesMod.getStory(node.id)!.brief).toBe("Ship the unified surface");
  });

  test("createWork 404s on an unknown workspace and 400s on a blank brief", async () => {
    expect(syncStatusOf(() => workApi.createWork("no-ws", "x"))).toBe(404);
    expect(syncStatusOf(() => workApi.createWork(WS, "   "))).toBe(400);
  });

  test("createWorkChild adds a LEAF subtask under a node (story_id set, enqueued)", async () => {
    const node = workApi.createWork(WS, "decompose me");
    const child = await workApi.createWorkChild(node.id, { prompt: "build part one" });
    expect(child.story_id).toBe(node.id);
    expect(child.workspace_id).toBe(WS);
    expect(child.status).toBe("inactive");
  });

  test("createWorkChild 409s when the parent is a LEAF (only a node decomposes)", async () => {
    const node = workApi.createWork(WS, "parent");
    const leaf = await workApi.createWorkChild(node.id, { prompt: "leaf parent attempt" });
    expect(await statusOf(() => workApi.createWorkChild(leaf.id, { prompt: "grandchild" }))).toBe(
      409,
    );
    expect(await statusOf(() => workApi.createWorkChild("no-such", { prompt: "orphan" }))).toBe(404);
  });
});

describe("workView EMBEDS the existing task/story views byte-for-byte (pure superset)", () => {
  test("a LEAF view = taskView + work_kind + informational responder; nothing else changes", async () => {
    const node = workApi.createWork(WS, "embed-leaf story");
    const leaf = await workApi.createWorkChild(node.id, { prompt: "embed leaf" });

    const before = tasksMod.taskView(leaf.id)!;
    const wv = await workApi.workView(leaf.id);
    // Reading the work view must not drift the underlying task view.
    expect(tasksMod.taskView(leaf.id)!).toEqual(before);

    expect((wv as any).work_kind).toBe("leaf");
    // The task row's OWN `kind` column ('task'/'rollback') is preserved alongside work_kind.
    expect((wv as any).kind).toBe("task");
    // As of the step-6a cutover parent_id is LIVE: a subtask leaf's parent IS its story node,
    // so the informational Work responder/chain reflect the real `leaf → node → cto → user`
    // bubble-up (the node id is the story id — see db.ensureStoryWorkNode).
    expect((wv as any).work_responder).toEqual({ kind: "work", work_id: node.id });
    expect((wv as any).work_responder_chain).toEqual([
      { kind: "work", work_id: node.id },
      { kind: "cto" },
      { kind: "user" },
    ]);

    // Strip the three added keys → byte-identical to the existing taskView.
    const { work_kind, work_responder, work_responder_chain, ...embedded } = wv as any;
    expect(embedded).toEqual(before);
  });

  test("a NODE view = storyView + work_kind; the story data is unchanged", async () => {
    const node = workApi.createWork(WS, "embed-node story");
    // First probe ADOPTS the live leader (stamps its `since`), so prime it before snapshotting
    // — the `leader` block is a live herdr probe that legitimately varies across calls and is
    // NOT part of the persisted story data the facade embeds.
    await storiesMod.storyView(node.id);
    const before = await storiesMod.storyView(node.id);
    const wv = await workApi.workView(node.id);

    expect((wv as any).work_kind).toBe("node");
    const { work_kind, leader: wvLeader, ...embedded } = wv as any;
    const { leader: beforeLeader, ...beforeRest } = before as any;
    // The embedded STORY DATA (row + counts) is byte-for-byte the existing storyView's.
    expect(embedded).toEqual(beforeRest);
    // The live leader block is present (its exact `since` is a live-probe detail).
    expect(wvLeader).toBeDefined();
  });

  test("workView 404s on an unknown id", async () => {
    expect(await statusOf(() => workApi.workView("ghost"))).toBe(404);
  });
});

describe("listWork unifies leaves + nodes, each tagged work_kind, with filters", () => {
  test("includes both a leaf and a node; filters by workspace / status / q", async () => {
    const node = workApi.createWork(WS, "listwork-needle story");
    const leaf = await workApi.createWorkChild(node.id, { prompt: "listwork leaf" });

    const all = await workApi.listWork();
    const leafItem = all.find((w) => w.id === leaf.id);
    const nodeItem = all.find((w) => w.id === node.id);
    expect(leafItem?.work_kind).toBe("leaf");
    expect(nodeItem?.work_kind).toBe("node");

    // workspace filter keeps both (they live in WS); a foreign workspace excludes them.
    const ws2only = await workApi.listWork({ workspace: WS2 });
    expect(ws2only.find((w) => w.id === leaf.id)).toBeUndefined();
    expect(ws2only.find((w) => w.id === node.id)).toBeUndefined();

    // status filter — 'open' is a STORY status, so it returns the node but not the leaf.
    const open = await workApi.listWork({ status: "open" });
    expect(open.find((w) => w.id === node.id)?.work_kind).toBe("node");
    expect(open.find((w) => w.id === leaf.id)).toBeUndefined();

    // q matches the node's brief.
    const q = await workApi.listWork({ q: "listwork-needle" });
    expect(q.find((w) => w.id === node.id)).toBeDefined();
  });

  // PERF (story st-337b45bc): the LIST projection strips the DETAIL-ONLY columns so GET
  // /api/work stays small/fast, while the per-task DETAIL view (taskView / workView) keeps them.
  // `output_snapshot` was the heaviest of them until story st-b8c9249e stopped storing it.
  test("LIST omits detail-only last_dispatch_error/revert_reason; DETAIL keeps them", async () => {
    const node = workApi.createWork(WS, "listwork-strip story");
    const leaf = await workApi.createWorkChild(node.id, { prompt: "listwork strip leaf" });

    // Seed NON-NULL values so the assertions would FAIL if any field leaked into a list row.
    const DISPATCH_ERR = "spawn failed after 5 attempts";
    const REVERT = "post-merge verify red";
    dbMod.db
      .query(`UPDATE tasks SET last_dispatch_error=?, revert_reason=? WHERE id=?`)
      .run(DISPATCH_ERR, REVERT, leaf.id);

    const DETAIL_ONLY = ["last_dispatch_error", "revert_reason"] as const;

    // (a) EVERY list surface — listWork(), allTasksView(), per-workspace taskListView() — must
    //     NOT carry the three keys at all (data-level key-absence, not a size check).
    const fromListWork = (await workApi.listWork()).find((w) => w.id === leaf.id)!;
    const fromAllTasks = tasksMod.allTasksView().find((t) => t.id === leaf.id)!;
    const fromTaskList = tasksMod.taskListView(WS).find((t) => t.id === leaf.id)!;
    for (const item of [fromListWork, fromAllTasks, fromTaskList]) {
      for (const k of DETAIL_ONLY) {
        expect(Object.hasOwn(item, k)).toBe(false);
      }
    }

    // (b) the DETAIL path — taskView() and workView() — DOES surface the same fields.
    const detail = tasksMod.taskView(leaf.id)!;
    expect(detail.last_dispatch_error).toBe(DISPATCH_ERR);
    expect(detail.revert_reason).toBe(REVERT);
    const wv = (await workApi.workView(leaf.id)) as any;
    expect(wv.last_dispatch_error).toBe(DISPATCH_ERR);
    expect(wv.revert_reason).toBe(REVERT);
  });
});

describe("leaf verbs map to task ops and 409 on a node", () => {
  test("prioritizeWork / setWorkBlockedBy map to setPriority / setBlockedBy", async () => {
    const node = workApi.createWork(WS, "leaf-verbs story");
    const a = await workApi.createWorkChild(node.id, { prompt: "leaf a" });
    const b = await workApi.createWorkChild(node.id, { prompt: "leaf b" });

    const prioritized = workApi.prioritizeWork(a.id, 5);
    expect(prioritized.priority).toBe(5);
    expect(tasksMod.taskView(a.id)!.priority).toBe(5);

    const blocked = await workApi.setWorkBlockedBy(b.id, [a.id]);
    expect(blocked.blocked_by).toEqual([a.id]);
    expect(tasksMod.taskView(b.id)!.blocked_by).toEqual([a.id]);
  });

  test("approve / reject / priority 409 on a NODE", async () => {
    const node = workApi.createWork(WS, "node-rejects-leaf-verbs");
    expect(await statusOf(() => workApi.approveWork(node.id))).toBe(409);
    expect(await statusOf(() => workApi.rejectWork(node.id, "nope"))).toBe(409);
    expect(syncStatusOf(() => workApi.prioritizeWork(node.id, 1))).toBe(409);
  });

  test("blocked_by ACCEPTS a story NODE (node-on-node sequencing) — an empty set is a no-op", async () => {
    // Since the Phase A1 sequencing engine (story st-30a7dccd), a STORY node carries its OWN
    // dependency set — setWorkBlockedBy no longer 409s a node. An empty set succeeds (no throw).
    const node = workApi.createWork(WS, "node-accepts-blocked_by");
    expect(await statusOf(() => workApi.setWorkBlockedBy(node.id, []))).toBeUndefined();
    expect(tasksMod.taskView(node.id)!.blocked_by).toEqual([]);
  });

  test("escalateWork on a fresh leaf routes to escalateTask (409 — not awaiting feedback)", async () => {
    const node = workApi.createWork(WS, "leaf-escalate story");
    const leaf = await workApi.createWorkChild(node.id, { prompt: "leaf to escalate" });
    // A freshly-enqueued leaf is not awaiting feedback → escalateTask's own 409 guard fires,
    // proving the verb dispatched to the LEAF path.
    expect(syncStatusOf(() => workApi.escalateWork(leaf.id))).toBe(409);
  });
});

describe("node verbs (ask / escalate / answer) map to the story-ask ops and 409 on a leaf", () => {
  test("askWork → openStoryAsk; escalateWork → escalateStoryAsk; answerWork → answerStoryAsk", async () => {
    const node = workApi.createWork(WS, "node-ask story");

    const asked = workApi.askWork(node.id, "decomposition ok?") as any;
    expect(asked.pending_ask).toBe("decomposition ok?");
    expect(asked.ask_responder).toBe("cto");
    expect(storiesMod.getStory(node.id)!.ask_responder).toBe("cto");

    const escalated = workApi.escalateWork(node.id) as any;
    expect(escalated.ask_responder).toBe("user");

    const answered = (await workApi.answerWork(node.id, "yes, proceed")) as any;
    expect(answered.pending_ask).toBeNull();
    expect(answered.ask_responder).toBeNull();
  });

  test("askWork 409s on a LEAF (a leaf raises via its agent, not a story-level ask)", async () => {
    const node = workApi.createWork(WS, "leaf-ask story");
    const leaf = await workApi.createWorkChild(node.id, { prompt: "leaf no ask" });
    expect(syncStatusOf(() => workApi.askWork(leaf.id, "may I?"))).toBe(409);
  });
});

describe("BYTE-IDENTICAL guard: the existing views are unchanged by the work surface", () => {
  test("allTasksView / allStoryViews snapshots survive a full work-surface round-trip", async () => {
    workApi.createWork(WS, "snapshot story");
    const node = workApi.createWork(WS, "snapshot story 2");
    await workApi.createWorkChild(node.id, { prompt: "snapshot leaf" });

    const tasksBefore = tasksMod.allTasksView();
    const storiesBefore = await storiesMod.allStoryViews();

    // Exercise every read path of the work surface.
    await workApi.listWork();
    await workApi.listWork({ workspace: WS, status: "open", q: "snapshot" });
    await workApi.workView(node.id);

    // The existing cross-resource views are byte-for-byte unchanged.
    expect(tasksMod.allTasksView()).toEqual(tasksBefore);
    expect(await storiesMod.allStoryViews()).toEqual(storiesBefore);
  });
});

// PERF (story st-ed265b9d): a workspace-scoped listWork must not BUILD the other workspaces'
// story views. The scope now lives in allStoryViews rather than a post-filter in listWork.
//
// The probe is the proof. Building a StoryView runs storyView → storyAgentStatus, which spawns
// exactly ONE harness.agentExists call per story whose story_agent row is desired=1. So counting
// agentExists calls counts the desired-leader stories actually CONSTRUCTED. Under the old
// build-then-filter code the scoped call built WS2's story too and its leader probe fired, so the
// scoped count was 2, not 1 — a result-set-equality check alone would have passed there.
describe("listWork PERF: a scoped work list BUILDS only that workspace's story views", () => {
  /** Swap in a runner that counts/records agentExists calls; returns the recorded names. */
  function recordProbes(): { names: string[]; restore: () => void } {
    const names: string[] = [];
    const original = harnessMod.getRunner();
    harnessMod.setRunner({
      ...original,
      async agentExists(name: string) {
        names.push(name);
        return false;
      },
    });
    return { names, restore: () => harnessMod.setRunner(original) };
  }

  test("scoped listWork never constructs the other workspace's story views", async () => {
    const mine = workApi.createWork(WS, "scoped story");
    const theirs = workApi.createWork(WS2, "other-workspace story");
    // Only a DESIRED leader probes herdr; createWork's leader hook marks both stories desired,
    // so each story view actually BUILT contributes exactly one probe of its leader's name.
    dbMod.saveStoryAgentRow(mine.id, { desired: 1 });
    dbMod.saveStoryAgentRow(theirs.id, { desired: 1 });
    const mineName = waMod.storyAgentName(mine.id);
    const theirsName = waMod.storyAgentName(theirs.id);

    const { names, restore } = recordProbes();
    try {
      const scoped = await workApi.listWork({ workspace: WS });
      // WS2's story view was NEVER built — its leader was never probed. (The old build-then-filter
      // code probed it here.) WS's own story WAS built, so the probe count is not trivially zero.
      expect(names).not.toContain(theirsName);
      expect(names).toContain(mineName);
      expect(scoped.some((w) => w.id === mine.id)).toBe(true);
      expect(scoped.some((w) => w.id === theirs.id)).toBe(false);
      expect(scoped.every((w) => w.workspace_id === WS)).toBe(true);

      // …and the UNSCOPED list still builds both (newest-first across workspaces).
      names.length = 0;
      const all = await workApi.listWork();
      expect(names).toContain(mineName);
      expect(names).toContain(theirsName);
      expect(all.some((w) => w.id === theirs.id)).toBe(true);
      const nodeDates = all.filter((w) => w.work_kind === "node").map((w) => w.created_at);
      expect([...nodeDates].sort().reverse()).toEqual(nodeDates);
    } finally {
      restore();
    }
  });

  test("an EMPTY `workspace` is UNSCOPED, exactly as the old post-filter treated it", async () => {
    const nodeIds = async (opts: { workspace?: string }) =>
      (await workApi.listWork(opts)).filter((w) => w.work_kind === "node").map((w) => w.id);
    expect(await nodeIds({ workspace: "" })).toEqual(await nodeIds({}));
  });
});
