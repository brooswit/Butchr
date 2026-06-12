// Tests for the reaper self-heal visibility seam consumed by GET /health
// (see reaper.getLastReap + server.healthResponse). Pure / in-process: no real
// git repo or herdr — with NO workspaces registered, reapOrphans walks nothing,
// and herdrUp=false skips the husk pass, so it just returns {0,0} and stamps
// lastReap. BUTCHR_HERDR_BIN points at `true` so any incidental herdr probe is a
// harmless no-op, matching the other test files.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let reaperMod: typeof import("../src/reaper.ts");

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-reaper-data-"));
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  // Force db/config singletons onto the temp paths before importing reaper.
  await import("../src/db.ts");
  await import("../src/config.ts");
  reaperMod = await import("../src/reaper.ts");
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("reaper self-heal visibility", () => {
  test("getLastReap starts at zeros with a null timestamp", () => {
    const before = reaperMod.getLastReap();
    expect(before.worktrees).toBe(0);
    expect(before.husks).toBe(0);
    expect(before.at).toBeNull();
  });

  test("reapOrphans stamps lastReap with counts + an ISO timestamp", async () => {
    const out = await reaperMod.reapOrphans(false); // no dirs registered, herdr down
    expect(out).toEqual({ worktrees: 0, husks: 0 });

    const after = reaperMod.getLastReap();
    expect(after.worktrees).toBe(0);
    expect(after.husks).toBe(0);
    expect(after.at).not.toBeNull();
    // ISO 8601 timestamp that round-trips through Date.
    expect(Number.isNaN(Date.parse(after.at as string))).toBe(false);
  });
});
