// REVAMP Phase B.4 — node-state READ-FLIP (story st-6372812d).
//
// B.4 points the node-state read accessors at the node's OWN `tasks` row (guarded work_kind='node')
// instead of the `stories` table. After the flip tasks.* is the source of truth and stories.* is the
// (still-present) B.3 dual-write MIRROR — so under normal operation the two agree and behavior is
// identical. These tests PROVE the source moved by DIVERGING the two (writing ONLY the tasks node,
// bypassing the dual-write) and asserting every node-state read returns the TASKS value, not the
// stale stories mirror:
//
//   storyStatusOf / getStoryRow / listStories / openStoryCount (dashboard) / recoverMergingStories /
//   blocker terminality (blockerState → storyStatusOf, the same family nodeWorkIsTerminal &
//   parentStoryStatus route through)
//
// Plus: (i) getStoryRow's shape is BYTE-IDENTICAL to the old `SELECT * FROM stories` (exactly the
// ten StoryRow columns, same values); (ii) a story is IMMEDIATELY readable via the flipped
// getStoryRow right after createStory (B.3 eager materialization → no lazy-gap regression, since
// getStoryRow now hard-depends on the node tasks row existing).
//
// All no-git: createStory/updateStory + direct reads need no worktree. recoverMergingStories uses a
// NON-isolated story so landStory returns early (isolated!=1) — the read source is what's under test,
// not the merge. The db/config singletons read BUTCHR_* env at import, so we set them first.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
const WS = "b4rf-ws"; // non-isolated, no real git

let dbMod: typeof import("../src/db.ts");
let tasksMod: typeof import("../src/tasks.ts");
let storiesMod: typeof import("../src/stories.ts");
let workspacesMod: typeof import("../src/workspaces.ts");

// The exact StoryRow column set — getStoryRow must return precisely these keys (no 11th field), so
// the tasks-sourced row is byte-identical to the pre-flip `SELECT * FROM stories`.
const STORY_ROW_KEYS = [
  "id",
  "workspace_id",
  "brief",
  "status",
  "isolated",
  "pending_ask",
  "ask_responder",
  "merge_base_sha",
  "merged_sha",
  "created_at",
] as const;

const storyRow = (id: string) =>
  dbMod.db.query<any, [string]>(`SELECT * FROM stories WHERE id=?`).get(id);

/** Write ONLY the node's `tasks` row (bypassing setStoryStatus' dual-write) so the tasks node and
 *  the stories mirror DIVERGE — the setup for every "reads follow tasks" assertion. */
function divergeNode(id: string, cols: Record<string, string | number | null>): void {
  const assigns = Object.keys(cols).map((c) => `${c}=?`);
  dbMod.db
    .query(`UPDATE tasks SET ${assigns.join(", ")} WHERE id=? AND work_kind='node'`)
    .run(...Object.values(cols), id);
}

/** The open-story count for WS, read via the public dashboard (exercises the flipped openStoryCount). */
function openStoriesFor(workspaceId: string): number {
  return workspacesMod.dashboard().workspaces.find((w) => w.id === workspaceId)!.openStories;
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-b4rf-data-"));
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  dbMod = await import("../src/db.ts");
  tasksMod = await import("../src/tasks.ts");
  storiesMod = await import("../src/stories.ts");
  workspacesMod = await import("../src/workspaces.ts");

  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(WS, join(DATA_DIR, "repo"), "ws", dbMod.nowIso());
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("B.4 — a fresh story is immediately readable via the flipped accessors", () => {
  test("createStory → getStoryRow/storyStatusOf resolve at once (eager node, no lazy gap)", () => {
    const st = storiesMod.createStory(WS, "read me now");
    // getStoryRow now hard-depends on the tasks node row; B.3 materializes it eagerly at create.
    expect(dbMod.getStoryRow(st.id)).toBeTruthy();
    expect(dbMod.storyStatusOf(st.id)).toBe("open");
    expect(dbMod.getStoryRow(st.id)!.brief).toBe("read me now");
  });

  test("getStoryRow shape is byte-identical to the stories row (exactly the 10 StoryRow cols)", () => {
    const st = storiesMod.createStory(WS, "shape check");
    const row = dbMod.getStoryRow(st.id)!;
    expect(Object.keys(row).sort()).toEqual([...STORY_ROW_KEYS].sort());
    const s = storyRow(st.id);
    for (const k of STORY_ROW_KEYS) expect((row as any)[k]).toEqual(s[k]);
  });
});

describe("B.4 — every node-state read follows the TASKS node, not the stories mirror", () => {
  test("storyStatusOf + getStoryRow track a diverged tasks node status", () => {
    const st = storiesMod.createStory(WS, "status divergence");
    divergeNode(st.id, { status: "aborted" }); // tasks only; stories stays 'open'
    expect(storyRow(st.id).status).toBe("open"); // mirror untouched
    expect(dbMod.storyStatusOf(st.id)).toBe("aborted"); // read follows tasks
    expect(dbMod.getStoryRow(st.id)!.status).toBe("aborted");
  });

  test("getStoryRow tracks diverged node-only fields (brief) from the tasks node", () => {
    const st = storiesMod.createStory(WS, "orig brief");
    divergeNode(st.id, { brief: "tasks-only brief" });
    expect(storyRow(st.id).brief).toBe("orig brief"); // mirror untouched
    expect(dbMod.getStoryRow(st.id)!.brief).toBe("tasks-only brief"); // read follows tasks
  });

  test("listStories reads the node rows from tasks (diverged status is reflected)", () => {
    const st = storiesMod.createStory(WS, "list divergence");
    divergeNode(st.id, { status: "done" });
    const listed = storiesMod.listStories(WS).find((s) => s.id === st.id)!;
    expect(listed).toBeTruthy();
    expect(listed.status).toBe("done"); // from tasks
    expect(storyRow(st.id).status).toBe("open"); // mirror untouched
  });

  test("openStoryCount (dashboard) counts open TASKS nodes, not the stories mirror", () => {
    const before = openStoriesFor(WS);
    const st = storiesMod.createStory(WS, "count me open");
    expect(openStoriesFor(WS)).toBe(before + 1); // the new open node is counted
    divergeNode(st.id, { status: "done" }); // tasks only → no longer open per tasks
    expect(storyRow(st.id).status).toBe("open"); // mirror still 'open'...
    expect(openStoriesFor(WS)).toBe(before); // ...but the count follows tasks
  });

  test("recoverMergingStories scans the TASKS nodes for 'merging' (misses none, invents none)", async () => {
    const st = storiesMod.createStory(WS, "recover from tasks");
    divergeNode(st.id, { status: "merging" }); // tasks only; stories stays 'open'
    // The old `SELECT id FROM stories WHERE status='merging'` would return 0 here; the flipped
    // read finds the node via tasks. landStory returns early (non-isolated) → no side effects.
    const n = await storiesMod.recoverMergingStories();
    expect(n).toBeGreaterThanOrEqual(1);
    expect(storyRow(st.id).status).toBe("open"); // stories mirror never said 'merging'
  });
});

describe("B.4 — node terminality (blockerState → storyStatusOf) follows the tasks node", () => {
  // blockerState resolves a node blocker via storyStatusOf — the SAME accessor nodeWorkIsTerminal
  // (leader teardown) and parentStoryStatus (merge guard) route through. Diverging the tasks node
  // and observing the blocked-leaf outcome proves that whole family now reads tasks.
  function blockedLeaf(id: string, nodeId: string): void {
    dbMod.db
      .query(
        `INSERT INTO tasks (id, workspace_id, status, created_at, blocked_by, work_kind)
         VALUES (?, ?, 'blocked', ?, ?, 'leaf')`,
      )
      .run(id, WS, dbMod.nowIso(), JSON.stringify([nodeId]));
  }

  test("a tasks-node diverged to 'done' satisfies a blocker (leaf unblocks) though stories says open", () => {
    const st = storiesMod.createStory(WS, "blocker done via tasks");
    blockedLeaf("b4rf-leaf-done", st.id);
    divergeNode(st.id, { status: "done" }); // tasks only; stories stays 'open'
    tasksMod.reevaluateAllBlocked();
    // If blockerState still read stories ('open') the leaf would stay blocked; it unblocks ⇒ tasks.
    expect(dbMod.db.query<any, [string]>(`SELECT status FROM tasks WHERE id=?`).get("b4rf-leaf-done").status)
      .toBe("inactive");
    expect(storyRow(st.id).status).toBe("open"); // mirror untouched
  });
});
