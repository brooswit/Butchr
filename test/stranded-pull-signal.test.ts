// Tests for the agent-INDEPENDENT STRANDED-WORK pull-signal (story st-a4cc6082, S2 —
// src/tasks.ts strandedItems/strandedTotals, surfaced on the dashboard (src/workspaces.ts
// dashboard()) and /health (src/server.ts healthResponse)).
//
// A responder is STRANDED iff its owning CTO/leader workspace agent is dead-while-desired
// (S1's durable workspace.gave_up=1) OR disabled (a CTO whose directory cto_enabled is off; a
// leader whose `ws-leader-<story>` row is desired=0 while the story is non-terminal). For each
// stranded responder we enumerate its pending items:
//   F1 idea           — an `idea` task whose CTO responder is stranded.
//   F2 dead_blocked    — a `blocked` task on a never-merging dep whose CTO responder is stranded.
//   F3 stuck_story     — an OPEN story settled with a dead member whose leader is stranded.
//   F4 merge_blocked   — a `merge_blocked` story whose leader is stranded.
//
// CRITICAL PROPERTY (per-finding): with the owning responder LIVE (gave_up=0 AND enabled/
// desired), stranded=0 and the dashboard `needsAttention` is byte-for-byte the prior
// REVIEW_STATES sum — NO double-surfacing. Items already in REVIEW_STATES are never re-counted.
//
// Pure / in-process: no real claude/herdr/bun is spawned (BUTCHR_HERDR_BIN=true). Rows are
// inserted directly (no registerWorkspace, which needs a live herdr). The db/config singletons
// are SHARED across test files, so we use distinct ids and assert only on our own rows.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;

let dbMod: typeof import("../src/db.ts");
let tasksMod: typeof import("../src/tasks.ts");
let workspacesMod: typeof import("../src/workspaces.ts");

// Distinct ids — the db/config singletons are shared across test files.
const WS_CTO_GAVEUP = "s2-ws-cto-gaveup";
const WS_CTO_DISABLED = "s2-ws-cto-disabled";
const WS_CTO_LIVE = "s2-ws-cto-live";
const WS_STORY = "s2-ws-story"; // CTO live here, so only leader findings appear

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-stranded-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-stranded-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  dbMod = await import("../src/db.ts");
  tasksMod = await import("../src/tasks.ts");
  workspacesMod = await import("../src/workspaces.ts");

  // Insert a directory row with an explicit cto_enabled flag (NULL inherits the global default,
  // which is OFF). Routed through the `workspaces` back-compat view (mirrors stories.test.ts).
  const insWs = (id: string, ctoEnabled: 1 | 0 | null) =>
    dbMod.db
      .query(
        `INSERT INTO workspaces (id, path, label, cto_enabled, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, join(REPO_ROOT, id), id, ctoEnabled, dbMod.nowIso());
  insWs(WS_CTO_GAVEUP, 1);
  insWs(WS_CTO_DISABLED, 0);
  insWs(WS_CTO_LIVE, 1);
  insWs(WS_STORY, 1);

  // CTO workspace-agent rows. The deterministic id is `ws-cto-<directory>` (db.ts seedUnified).
  //  - GAVEUP: enabled (cto_enabled=1) but gave_up=1 → stranded (dead).
  //  - LIVE:   enabled and gave_up=0 → live.
  //  - DISABLED workspace needs no cto row: isCtoEnabled=false alone makes it stranded.
  dbMod.saveWorkspaceAgentRow(`ws-cto-${WS_CTO_GAVEUP}`, {
    kind: "cto",
    directory_id: WS_CTO_GAVEUP,
    desired: 1,
    gave_up: 1,
  });
  dbMod.saveWorkspaceAgentRow(`ws-cto-${WS_CTO_LIVE}`, {
    kind: "cto",
    directory_id: WS_CTO_LIVE,
    desired: 1,
    gave_up: 0,
  });
  dbMod.saveWorkspaceAgentRow(`ws-cto-${WS_STORY}`, {
    kind: "cto",
    directory_id: WS_STORY,
    desired: 1,
    gave_up: 0,
  });
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

/** Seed a task row (status defaults to inactive). Optional story_id + blocked_by (JSON ids). */
function seedTask(
  id: string,
  ws: string,
  status: string,
  opts: { story_id?: string; blocked_by?: string[] } = {},
) {
  dbMod.db
    .query(
      `INSERT INTO tasks (id, workspace_id, status, story_id, blocked_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      ws,
      status,
      opts.story_id ?? null,
      opts.blocked_by ? JSON.stringify(opts.blocked_by) : null,
      dbMod.nowIso(),
    );
}

/** Seed a story row directly (bypasses the leader-launch hook), then set its leader workspace
 *  row to the desired liveness state. */
function seedStory(
  id: string,
  ws: string,
  status: "open" | "merge_blocked",
  leader: { desired: 0 | 1; gave_up: 0 | 1 },
) {
  dbMod.db
    .query(
      `INSERT INTO stories (id, workspace_id, brief, status, isolated, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, ws, `brief ${id}`, status, 1, dbMod.nowIso());
  // The leader workspace row's work_id FK references the story's Work NODE (a `tasks` anchor
  // row). Materialize it (the anchor has story_id NULL, so it is never counted as a member).
  dbMod.ensureStoryWorkNode(id);
  dbMod.saveWorkspaceAgentRow(`ws-leader-${id}`, {
    kind: "leader",
    directory_id: ws,
    work_id: id,
    desired: leader.desired,
    gave_up: leader.gave_up,
  });
}

/** The kinds present in strandedItems(ws) for a given workId. */
function kindsFor(ws: string, workId: string): string[] {
  return tasksMod
    .strandedItems(ws)
    .filter((i) => i.workId === workId)
    .map((i) => i.kind);
}

/** The dashboard workspace entry for an id. */
function dashWs(id: string) {
  return workspacesMod.dashboard().workspaces.find((w) => w.id === id)!;
}

describe("F1 idea — stranded CTO responder", () => {
  test("gave_up CTO: the idea task surfaces on the dashboard + /health", () => {
    seedTask("s2-idea-gaveup", WS_CTO_GAVEUP, "idea");
    expect(kindsFor(WS_CTO_GAVEUP, "s2-idea-gaveup")).toEqual(["idea"]);

    const ws = dashWs(WS_CTO_GAVEUP);
    expect(ws.strandedItems.some((i) => i.workId === "s2-idea-gaveup" && i.kind === "idea")).toBe(
      true,
    );
    // /health pull-signal (strandedTotals is exactly what healthResponse folds in).
    expect(
      tasksMod.strandedTotals().items.some((i) => i.workId === "s2-idea-gaveup"),
    ).toBe(true);
  });

  test("disabled CTO: the idea task surfaces", () => {
    seedTask("s2-idea-disabled", WS_CTO_DISABLED, "idea");
    expect(kindsFor(WS_CTO_DISABLED, "s2-idea-disabled")).toEqual(["idea"]);
    expect(
      tasksMod.strandedTotals().items.some((i) => i.workId === "s2-idea-disabled"),
    ).toBe(true);
  });

  test("LIVE CTO: the idea task surfaces NOTHING", () => {
    seedTask("s2-idea-live", WS_CTO_LIVE, "idea");
    expect(kindsFor(WS_CTO_LIVE, "s2-idea-live")).toEqual([]);
    expect(
      tasksMod.strandedTotals().items.some((i) => i.workId === "s2-idea-live"),
    ).toBe(false);
  });
});

describe("F2 dead_blocked — stranded CTO responder", () => {
  test("gave_up CTO: a blocked task on a dead (gone) dependency surfaces", () => {
    seedTask("s2-blk-gaveup", WS_CTO_GAVEUP, "blocked", { blocked_by: ["s2-gone-dep"] });
    expect(kindsFor(WS_CTO_GAVEUP, "s2-blk-gaveup")).toEqual(["dead_blocked"]);
  });

  test("disabled CTO: the dead-blocked task surfaces", () => {
    seedTask("s2-blk-disabled", WS_CTO_DISABLED, "blocked", { blocked_by: ["s2-gone-dep"] });
    expect(kindsFor(WS_CTO_DISABLED, "s2-blk-disabled")).toEqual(["dead_blocked"]);
  });

  test("gave_up CTO but a LIVE blocker: not yet dead-blocked → surfaces nothing", () => {
    // The blocker exists and is in_progress (pending, not dead), so deadBlockerIds is empty.
    seedTask("s2-live-dep", WS_CTO_GAVEUP, "in_progress");
    seedTask("s2-blk-pending", WS_CTO_GAVEUP, "blocked", { blocked_by: ["s2-live-dep"] });
    expect(kindsFor(WS_CTO_GAVEUP, "s2-blk-pending")).toEqual([]);
  });

  test("LIVE CTO: the dead-blocked task surfaces NOTHING", () => {
    seedTask("s2-blk-live", WS_CTO_LIVE, "blocked", { blocked_by: ["s2-gone-dep"] });
    expect(kindsFor(WS_CTO_LIVE, "s2-blk-live")).toEqual([]);
  });
});

describe("F3 stuck_story — stranded leader responder", () => {
  // A story SETTLED with a dead member: every member terminal, one aborted (so never all-merged).
  function seedStuckMembers(storyId: string) {
    seedTask(`${storyId}-m1`, WS_STORY, "merged", { story_id: storyId });
    seedTask(`${storyId}-m2`, WS_STORY, "aborted", { story_id: storyId });
  }

  test("gave_up leader: the stuck story surfaces", () => {
    seedStory("st-f3-gaveup", WS_STORY, "open", { desired: 1, gave_up: 1 });
    seedStuckMembers("st-f3-gaveup");
    expect(kindsFor(WS_STORY, "st-f3-gaveup")).toEqual(["stuck_story"]);
    expect(
      tasksMod.strandedTotals().items.some((i) => i.workId === "st-f3-gaveup"),
    ).toBe(true);
  });

  test("disabled leader (desired=0): the stuck story surfaces", () => {
    seedStory("st-f3-disabled", WS_STORY, "open", { desired: 0, gave_up: 0 });
    seedStuckMembers("st-f3-disabled");
    expect(kindsFor(WS_STORY, "st-f3-disabled")).toEqual(["stuck_story"]);
  });

  test("LIVE leader: the stuck story surfaces NOTHING", () => {
    seedStory("st-f3-live", WS_STORY, "open", { desired: 1, gave_up: 0 });
    seedStuckMembers("st-f3-live");
    expect(kindsFor(WS_STORY, "st-f3-live")).toEqual([]);
  });

  test("gave_up leader but an IN-FLIGHT member: not settled → surfaces nothing", () => {
    seedStory("st-f3-inflight", WS_STORY, "open", { desired: 1, gave_up: 1 });
    seedTask("st-f3-inflight-m1", WS_STORY, "aborted", { story_id: "st-f3-inflight" });
    seedTask("st-f3-inflight-m2", WS_STORY, "in_progress", { story_id: "st-f3-inflight" });
    expect(kindsFor(WS_STORY, "st-f3-inflight")).toEqual([]);
  });
});

describe("F4 merge_blocked — stranded leader responder", () => {
  test("gave_up leader: the merge_blocked story surfaces", () => {
    seedStory("st-f4-gaveup", WS_STORY, "merge_blocked", { desired: 1, gave_up: 1 });
    expect(kindsFor(WS_STORY, "st-f4-gaveup")).toEqual(["merge_blocked"]);
    expect(
      tasksMod.strandedTotals().items.some((i) => i.workId === "st-f4-gaveup"),
    ).toBe(true);
  });

  test("disabled leader (desired=0): the merge_blocked story surfaces", () => {
    seedStory("st-f4-disabled", WS_STORY, "merge_blocked", { desired: 0, gave_up: 0 });
    expect(kindsFor(WS_STORY, "st-f4-disabled")).toEqual(["merge_blocked"]);
  });

  test("LIVE leader: the merge_blocked story surfaces NOTHING", () => {
    seedStory("st-f4-live", WS_STORY, "merge_blocked", { desired: 1, gave_up: 0 });
    expect(kindsFor(WS_STORY, "st-f4-live")).toEqual([]);
  });
});

describe("CRITICAL PROPERTY — live responder leaves needsAttention byte-for-byte unchanged", () => {
  test("a LIVE-CTO workspace with a review-state task: stranded=0, needsAttention = review+failed", () => {
    // An in_review task IS in REVIEW_STATES (the existing pull-signal). With idea + dead-blocked
    // tasks ALSO present (from F1/F2 above) but the CTO LIVE, none of those inflate the badge.
    seedTask("s2-review-live", WS_CTO_LIVE, "in_review");
    const ws = dashWs(WS_CTO_LIVE);
    expect(ws.stranded).toBe(0);
    expect(ws.strandedItems).toEqual([]);
    // needsAttention is exactly review + failed (the REVIEW_STATES sum) — no stranded inflation.
    expect(ws.needsAttention).toBe(ws.review + ws.failed);
    expect(ws.review).toBe(1); // the single in_review task
  });

  test("a stranded-CTO workspace folds stranded INTO needsAttention", () => {
    // WS_CTO_GAVEUP has an idea + a dead-blocked task (2 stranded), and no REVIEW_STATES tasks.
    const ws = dashWs(WS_CTO_GAVEUP);
    expect(ws.stranded).toBeGreaterThanOrEqual(2);
    // needsAttention = REVIEW_STATES sum (review+failed) + stranded.
    expect(ws.needsAttention).toBe(ws.review + ws.failed + ws.stranded);
    // The dashboard totals carry the new stranded bucket.
    expect(workspacesMod.dashboard().totals.stranded).toBeGreaterThanOrEqual(ws.stranded);
  });
});
