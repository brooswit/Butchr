// RFC Q5 — Phase C1 (story st-30a7dccd): CEO CROSS-REPO INITIATIVE REVIEW. The CEO reviews landed
// work across its member repos at INITIATIVE granularity — the project-tier mirror of a story
// leader's completion sign-off, one rung up. The per-diff merge stays the CTO's; the CEO gets no
// reject/rollback.
//
// This suite pins:
//   REVIEW ROLLUP: reviewProjectInitiative returns, per child story, WHAT LANDED — the story summary
//     + its story-level merge sha + its MERGED subtasks (each a drill-down handle for GET
//     /api/work/:id/diff). Pending directives (nothing landed) are excluded. 404 project/initiative.
//   ACTIONABLE SET: on completion the initiative appears in ceoInitiativesAwaitingReview (the CEO's
//     actionable-review set); acceptInitiativeReview stamps it + publishes initiative.reviewed, and it
//     drops out of the set (no re-nag). accept 409s an in-flight (not-done) initiative.
//   CHANNEL SURFACE: the AttentionBridge translates initiative.completed into a CEO 'ready for review'
//     notification for the PROJECT bridge whose scopeProject matches — and ONLY that bridge (a
//     story/CTO bridge stays silent).
//
// Pure / in-process (mirrors revamp4-cross-repo-initiative.test.ts): real service fns + the db
// singleton, BUTCHR_HERDR_BIN=true so best-effort leader launches are harmless no-ops.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
const DIRA = "dir-c1-a"; // member repo A
const DIRB = "dir-c1-b"; // member repo B

let PROJ: string; // a project node anchored to DIRA, with DIRA + DIRB as members

let dbMod: typeof import("../src/db.ts");
let tasksMod: typeof import("../src/tasks.ts");
let workspacesMod: typeof import("../src/workspaces.ts");
let storiesMod: typeof import("../src/stories.ts");
let eventsMod: typeof import("../src/events.ts");
let channelMod: typeof import("../src/channel.ts");

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
/** Seed a MERGED-terminal leaf subtask under a story node, with a landed sha (the drill-down handle). */
function seedMergedSubtask(
  dir: string,
  storyId: string,
  summary: string,
  sha: string,
  status: "merged" | "rolled_back" = "merged",
): string {
  const id = `c1-sub-${leafSeq++}`;
  dbMod.db
    .query(
      `INSERT INTO tasks (id, workspace_id, status, work_kind, parent_id, summary, merged_sha, has_agent, created_at)
       VALUES (?, ?, ?, 'leaf', ?, ?, ?, 0, ?)`,
    )
    .run(id, dir, status, storyId, summary, sha, dbMod.nowIso());
  return id;
}

/** Fan a cross-repo initiative into DIRA+DIRB, accept both directives, and (optionally) land the
 *  resulting stories `done`. Returns the initiative id + the two story node ids (by repo). */
function seedInitiative(land: boolean): { iid: string; storyA: string; storyB: string } {
  const ini = storiesMod.createCrossRepoInitiative(PROJ, [
    { repo: DIRA, brief: "A part" },
    { repo: DIRB, brief: "B part" },
  ]);
  const dA = ini.directives.find((d) => d.workspace_id === DIRA)!;
  const dB = ini.directives.find((d) => d.workspace_id === DIRB)!;
  const storyA = storiesMod.acceptDirective(dA.id, [{ brief: "A story" }]).stories[0]!.id;
  const storyB = storiesMod.acceptDirective(dB.id, [{ brief: "B story" }]).stories[0]!.id;
  if (land) {
    storiesMod.updateStory(storyA, { status: "done" });
    storiesMod.updateStory(storyB, { status: "done" });
  }
  return { iid: ini.initiative_id, storyA, storyB };
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-c1-"));
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";
  delete process.env.BUTCHR_UNIFIED_WORK;

  dbMod = await import("../src/db.ts");
  tasksMod = await import("../src/tasks.ts");
  workspacesMod = await import("../src/workspaces.ts");
  storiesMod = await import("../src/stories.ts");
  eventsMod = await import("../src/events.ts");
  channelMod = await import("../src/channel.ts");

  for (const [dir, sub] of [
    [DIRA, "repoA"],
    [DIRB, "repoB"],
  ] as const) {
    dbMod.db
      .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
      .run(dir, join(DATA_DIR, sub), dir, dbMod.nowIso());
  }
  dbMod.migrateMaterializeRepoNodes();

  PROJ = workspacesMod.createProject(DIRA).id;
  workspacesMod.registerRepoUnderProject(PROJ, DIRA);
  workspacesMod.registerRepoUnderProject(PROJ, DIRB);
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

// --- REVIEW ROLLUP: what landed per repo -------------------------------------
describe("reviewProjectInitiative — per-repo landed summaries + shas + drill-down handles", () => {
  test("rolls up each child story's summary, story-level sha, and its MERGED subtasks", () => {
    const { iid, storyA, storyB } = seedInitiative(true);
    // Repo A's story landed as an isolated story (a story-level merged_sha); each story carries merged
    // subtasks — the drill-down handles the CEO opens via GET /api/work/:id/diff.
    dbMod.db.query(`UPDATE tasks SET merged_sha=? WHERE id=?`).run("shaStoryA", storyA);
    const subA1 = seedMergedSubtask(DIRA, storyA, "A subtask 1", "shaA1");
    const subA2 = seedMergedSubtask(DIRA, storyA, "A subtask 2", "shaA2", "rolled_back");
    const subB1 = seedMergedSubtask(DIRB, storyB, "B subtask 1", "shaB1");

    const review = storiesMod.reviewProjectInitiative(PROJ, iid);
    expect(review.initiative_id).toBe(iid);
    expect(review.project_id).toBe(PROJ);
    expect(review.done).toBe(true);
    expect(review.reviewed).toBe(false); // not yet accepted

    // Two child stories (one per repo), each with its repo/workspace + summary + landed status.
    const byRepo = new Map(review.stories.map((s) => [s.workspace_id, s]));
    expect([...byRepo.keys()].sort()).toEqual([DIRA, DIRB]);
    const a = byRepo.get(DIRA)!;
    const b = byRepo.get(DIRB)!;
    expect(a.story_id).toBe(storyA);
    expect(a.summary).toBe("A story");
    expect(a.status).toBe("done");
    expect(a.merged_sha).toBe("shaStoryA"); // isolated story-level landed tip
    expect(b.merged_sha).toBeNull(); // non-isolated story: no story-level sha

    // Repo A's MERGED subtasks are the drill-down handles (ids + shas), ordered by creation.
    expect(a.merged_subtasks.map((m) => m.id)).toEqual([subA1, subA2]);
    expect(a.merged_subtasks.map((m) => m.merged_sha)).toEqual(["shaA1", "shaA2"]);
    expect(a.merged_subtasks.map((m) => m.status)).toEqual(["merged", "rolled_back"]);
    expect(b.merged_subtasks.map((m) => m.id)).toEqual([subB1]);
  });

  test("EXCLUDES a still-pending directive (nothing landed) and 404s a missing project/initiative", () => {
    // A fresh initiative whose directives are NOT yet accepted → no story nodes → empty review.stories.
    const ini = storiesMod.createCrossRepoInitiative(PROJ, [{ repo: DIRA, brief: "pending only" }]);
    const review = storiesMod.reviewProjectInitiative(PROJ, ini.initiative_id);
    expect(review.done).toBe(false);
    expect(review.stories).toHaveLength(0); // the pending directive leaf is not a landed story

    expect(statusOf(() => storiesMod.reviewProjectInitiative("no-such-project", ini.initiative_id))).toBe(404);
    expect(statusOf(() => storiesMod.reviewProjectInitiative(PROJ, "ini-does-not-exist"))).toBe(404);
  });
});

// --- ACTIONABLE-REVIEW SET + ACCEPT ------------------------------------------
describe("ceoInitiativesAwaitingReview + acceptInitiativeReview", () => {
  test("a completed initiative appears in the CEO's actionable set, then clears on accept", () => {
    const { iid } = seedInitiative(true);

    // On completion it is in the CEO's actionable-review set.
    const awaiting = () => storiesMod.ceoInitiativesAwaitingReview(PROJ).map((i) => i.initiative_id);
    expect(awaiting()).toContain(iid);

    // ACCEPT publishes initiative.reviewed (report completion to the human) + stamps the sign-off.
    const reviewed: Array<Record<string, unknown>> = [];
    const unsub = eventsMod.subscribe((e) => {
      const ev = e as Record<string, unknown>;
      if (ev.type === "initiative.reviewed" && ev.initiative_id === iid) reviewed.push(ev);
    });
    try {
      const res = storiesMod.acceptInitiativeReview(PROJ, iid);
      expect(res.initiative_id).toBe(iid);
      expect(res.project_id).toBe(PROJ);
      expect(res.reviewed_at).toBeTruthy();
      expect(reviewed).toHaveLength(1);
      expect(reviewed[0]!.project_id).toBe(PROJ);
    } finally {
      unsub();
    }

    // It DROPS OUT of the actionable set (no re-nag) and the review now reads reviewed=true.
    expect(awaiting()).not.toContain(iid);
    expect(storiesMod.reviewProjectInitiative(PROJ, iid).reviewed).toBe(true);
  });

  test("accept 409s an in-flight (not-done) initiative and 404s a missing one", () => {
    const { iid } = seedInitiative(false); // accepted directives → OPEN stories (not landed)
    expect(storiesMod.ceoInitiativesAwaitingReview(PROJ).map((i) => i.initiative_id)).not.toContain(iid);
    expect(statusOf(() => storiesMod.acceptInitiativeReview(PROJ, iid))).toBe(409);
    expect(statusOf(() => storiesMod.acceptInitiativeReview(PROJ, "ini-nope"))).toBe(404);
  });
});

// --- CHANNEL SURFACE: 'ready for review' to the CEO's project bridge only -----
describe("AttentionBridge — initiative.completed surfaces to the matching project bridge only", () => {
  const completedEvent = (projectId: string, iid: string) => ({
    type: "initiative.completed" as const,
    project_id: projectId,
    initiative_id: iid,
    detail: `initiative ${iid}: all member-repo stories landed`,
  });

  test("the project bridge scoped to this project emits a 'ready for review' notification", () => {
    const bridge = new channelMod.AttentionBridge(undefined, false, undefined, PROJ);
    const note = bridge.consume(completedEvent(PROJ, "ini-xyz"));
    expect(note).not.toBeNull();
    expect(note!.meta.state).toBe("initiative_review");
    expect(note!.meta.initiative_id).toBe("ini-xyz");
    expect(note!.meta.project_id).toBe(PROJ);
    expect(note!.content).toContain("READY FOR REVIEW");
    expect(note!.content).toContain("ini-xyz");
  });

  test("a DIFFERENT project's bridge, and a story/CTO bridge, stay silent", () => {
    // Wrong project scope → not owned.
    expect(
      new channelMod.AttentionBridge(undefined, false, undefined, "proj-other").consume(
        completedEvent(PROJ, "ini-xyz"),
      ),
    ).toBeNull();
    // A story-leader bridge and an unscoped CTO bridge never own a project-tier initiative event.
    expect(
      new channelMod.AttentionBridge(undefined, false, "some-story").consume(completedEvent(PROJ, "ini-xyz")),
    ).toBeNull();
    expect(new channelMod.AttentionBridge().consume(completedEvent(PROJ, "ini-xyz"))).toBeNull();
  });
});
