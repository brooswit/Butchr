// Tests the workspace double-create DEDUPE in ensureDirectoryWorkspace
// (src/directories.ts). The bug: the dispatcher used to dedupe concurrent same-directory
// heals in its OWN in-flight map, but the CTO agent called ensureDirectoryWorkspace
// directly — bypassing it — so a CTO (re)launch and a task dispatch both racing a
// closed/restarted herdr workspace could each see workspaceExists=false and double-create
// (the second persist UPDATE clobbers the first, orphaning a workspace). The fix moves the
// in-flight map DOWN into ensureDirectoryWorkspace so EVERY caller funnels through one
// create per directory. This drives two concurrent ensureDirectoryWorkspace calls against a
// fake AgentRunner whose workspaceExists returns false (every call would otherwise create)
// and asserts workspaceCreate ran exactly ONCE and both callers got the same workspace id.
//
// Only the agent runtime is faked (setRunner); the DB is real (a temp file). Env is set
// before a dynamic import so config/db read our temp paths.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunner } from "../src/harness.ts";

let DATA_DIR: string;
const DIR_ID = "dedupe-dir";

let dbMod: typeof import("../src/db.ts");
let dirMod: typeof import("../src/directories.ts");
let harnessMod: typeof import("../src/harness.ts");
let originalRunner: AgentRunner;

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-dedupe-data-"));
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  dbMod = await import("../src/db.ts");
  dirMod = await import("../src/directories.ts");
  harnessMod = await import("../src/harness.ts");
  originalRunner = harnessMod.getRunner(); // the real herdr backend, restored in afterAll

  // A registered directory with NO recorded workspace yet, so the heal goes straight to
  // create. (bun shares the db singleton across files; a unique id avoids collisions.)
  dbMod.db
    .query(`INSERT INTO directories (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(DIR_ID, "/tmp/dedupe-repo", "dedupe", dbMod.nowIso());
});

afterAll(() => {
  // Restore the real (herdr) backend so a swapped fake can't leak into other files.
  harnessMod.setRunner(originalRunner);
  rmSync(DATA_DIR, { recursive: true, force: true });
});

// A minimal fake: workspaceExists=false forces a heal on every call; workspaceCreate
// counts its invocations and hands back a unique id. It yields a microtask before
// returning, so two concurrent callers genuinely OVERLAP inside the heal — without the
// dedupe the second would race straight into a second create (createCount === 2). Only the
// three methods ensureDirectoryWorkspace touches are implemented; the cast keeps the fake
// focused on what this test exercises.
function makeFake(): { runner: AgentRunner; createCount: () => number } {
  let creates = 0;
  const runner = {
    async isUp() {
      return true;
    },
    async workspaceExists() {
      return false; // force a heal → workspaceCreate on every call
    },
    async workspaceCreate() {
      creates++;
      await Promise.resolve(); // yield so a concurrent caller would overlap here
      return { workspaceId: `ws-${creates}`, rootPaneId: `root-${creates}` };
    },
  } as unknown as AgentRunner;
  return { runner, createCount: () => creates };
}

test("two concurrent ensureDirectoryWorkspace heals share ONE workspaceCreate", async () => {
  const { runner, createCount } = makeFake();
  harnessMod.setRunner(runner);

  // Two heals of the SAME directory, kicked off together (the CTO-launch-vs-dispatch race).
  const [a, b] = await Promise.all([
    dirMod.ensureDirectoryWorkspace(DIR_ID, "/tmp/dedupe-repo", "dedupe"),
    dirMod.ensureDirectoryWorkspace(DIR_ID, "/tmp/dedupe-repo", "dedupe"),
  ]);

  // Exactly one create despite two racing callers — no double-create / clobbered persist.
  expect(createCount()).toBe(1);
  // Both callers got the SAME (single) workspace id.
  expect(a.workspaceId).toBeDefined();
  expect(a.workspaceId).toBe(b.workspaceId);
  // The single underlying create is owned by exactly ONE caller (created=true); the other
  // shares it (created=false), so create-only bookkeeping runs exactly once.
  expect([a.created, b.created].filter(Boolean).length).toBe(1);

  // The persisted directory row reflects that one workspace.
  const row = dbMod.db
    .query<{ herdr_workspace: string | null }, [string]>(
      `SELECT herdr_workspace FROM directories WHERE id=?`,
    )
    .get(DIR_ID)!;
  expect(row.herdr_workspace).toBe(a.workspaceId ?? null);
});
