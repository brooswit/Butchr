// Tests for the canonical story READ accessors (REVAMP Phase A — story st-26a5c2e1):
// db.storyStatusOf + db.getStoryRow. These centralize what were once inline
// `SELECT ... FROM stories WHERE id=?` reads behind ONE definition each. REVAMP-2 Phase
// B.5b (st-78a8b4e7) DROPPED the `stories` mirror table, so the node `tasks` row
// (work_kind='node') is now the SOLE source these accessors read — there is no `stories`
// table left to compare against. This guard pins the accessors' behavior (correct row /
// status for a PRESENT id, null for an ABSENT id) directly against the node source.
//
// Pure / in-process: workspace + story rows are inserted directly via the db singleton
// (no live herdr/claude). The db/config singletons are SHARED across test files, so we
// use distinct ids and assert only on our own rows.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
// Distinct ids — the db/config singletons are shared across test files.
const WS = "accessors-ws";
const ABSENT = "st-accessors-absent";

let dbMod: typeof import("../src/db.ts");
let storiesMod: typeof import("../src/stories.ts");

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-accessors-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-accessors-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  dbMod = await import("../src/db.ts");
  storiesMod = await import("../src/stories.ts");

  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(WS, join(REPO_ROOT, WS), WS, dbMod.nowIso());
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

describe("db story-read accessors", () => {
  test("getStoryRow returns the story's node row (the sole source post-B.5b)", () => {
    const story = storiesMod.createStory(WS, "Accessor round-trip");
    const viaAccessor = dbMod.getStoryRow(story.id);
    expect(viaAccessor).not.toBeNull();
    // The node `tasks` row (work_kind='node') IS the story record now.
    expect(viaAccessor!.id).toBe(story.id);
    // Spot-check the fields call sites read off the row.
    expect(viaAccessor!.workspace_id).toBe(WS);
    expect(viaAccessor!.brief).toBe("Accessor round-trip");
    expect(viaAccessor!.status).toBe("open");
  });

  test("getStoryRow returns null for an ABSENT id (Phase B guard)", () => {
    expect(dbMod.getStoryRow(ABSENT)).toBeNull();
  });

  test("storyStatusOf returns the node's status and tracks a change", () => {
    const story = storiesMod.createStory(WS, "Status read");
    expect(dbMod.storyStatusOf(story.id)).toBe("open");

    // Tracks a status change on the node row.
    storiesMod.updateStory(story.id, { status: "done" });
    expect(dbMod.storyStatusOf(story.id)).toBe("done");
  });

  test("storyStatusOf returns null for an ABSENT id (Phase B guard)", () => {
    expect(dbMod.storyStatusOf(ABSENT)).toBeNull();
  });

  test("getStory delegates to getStoryRow (single canonical definition)", () => {
    const story = storiesMod.createStory(WS, "Delegation");
    expect(storiesMod.getStory(story.id)).toEqual(dbMod.getStoryRow(story.id)!);
    expect(storiesMod.getStory(ABSENT)).toBeNull();
  });
});
