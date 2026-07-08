// REVAMP-4 — DELETE /api/projects/:id (deleteProject). Additive teardown surface: the Projects UI
// can create/register/launch a project but had no way to REMOVE one. deleteProject refuses to orphan
// or cascade-delete real work — a project only deletes once EMPTY — and tears down its managed CEO
// runtime on a clean delete.
//
// This suite pins:
//   (a) an EMPTY project deletes cleanly — the row is gone afterward (getProject → null).
//   (b) a project WITH a registered repo → 409 (asserting the SPECIFIC repos message).
//   (c) a project WITH an active initiative → 409, checked initiatives-FIRST (asserting the SPECIFIC
//       initiatives message — proving the guard is independently reachable and not shadowed by repos).
//   (d) a non-project id → 404.
//   (e) a CEO-ENABLED empty project — its ws-ceo-<id> workspace agent row is torn down on delete.
//
// Pure / in-process, mirroring revamp4-ceo-directive.test.ts: rows via the real service functions +
// the db singleton (BUTCHR_HERDR_BIN=true makes the best-effort leader launch a harmless no-op). The
// db/config singletons are SHARED across test files, so we use DEDICATED dirs + distinct ids.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
const DIRR = "dir-pdel-repo"; // a repo registered under a project (guard cases)

let dbMod: typeof import("../src/db.ts");
let tasksMod: typeof import("../src/tasks.ts");
let workspacesMod: typeof import("../src/workspaces.ts");
let storiesMod: typeof import("../src/stories.ts");

/** Run `fn` and return the HttpError it throws (or null if it does not throw). */
async function errOf(fn: () => unknown): Promise<{ status: number; message: string } | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return { status: (e as { status?: number }).status ?? -1, message: (e as Error).message };
  }
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-pdel-"));
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";
  delete process.env.BUTCHR_UNIFIED_WORK; // unified routing ON (default)

  dbMod = await import("../src/db.ts");
  tasksMod = await import("../src/tasks.ts");
  workspacesMod = await import("../src/workspaces.ts");
  storiesMod = await import("../src/stories.ts");

  // One registered repo (via the writable `workspaces` view → `directory` table), then materialize
  // its repo node (the boot pass at import time ran before this row existed).
  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(DIRR, join(DATA_DIR, "repo"), DIRR, dbMod.nowIso());
  dbMod.migrateMaterializeRepoNodes();
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("REVAMP-4 — deleteProject", () => {
  test("(d) a non-project id → 404", async () => {
    const err = await errOf(() => workspacesMod.deleteProject("not-a-project"));
    expect(err?.status).toBe(404);
  });

  test("(a) an EMPTY project deletes cleanly (row gone afterward; getProject → null)", async () => {
    const proj = workspacesMod.createProject(DIRR).id;
    expect(workspacesMod.getProject(proj)).not.toBeNull();

    const returned = await workspacesMod.deleteProject(proj);
    expect(returned.id).toBe(proj); // returns the deleted row

    expect(workspacesMod.getProject(proj)).toBeNull(); // gone
    expect(tasksMod.getTask(proj)).toBeNull(); // no stray tasks row either
  });

  test("(b) a project WITH a registered repo → 409 (repos message)", async () => {
    const proj = workspacesMod.createProject(DIRR).id;
    workspacesMod.registerRepoUnderProject(proj, DIRR);

    const err = await errOf(() => workspacesMod.deleteProject(proj));
    expect(err?.status).toBe(409);
    expect(err?.message).toContain("registered repo"); // the repos guard, NOT the initiatives one
    expect(err?.message).not.toContain("initiative");

    // Guard-only: nothing deleted, repo untouched.
    expect(workspacesMod.getProject(proj)).not.toBeNull();
    expect(tasksMod.getTask(DIRR)!.parent_id).toBe(proj);

    // cleanup for the next test — unregister the repo so this project is empty again.
    workspacesMod.unregisterRepoFromProject(proj, DIRR);
    await workspacesMod.deleteProject(proj);
  });

  test("(c) a project WITH an active initiative → 409, checked initiatives-FIRST (initiatives message)", async () => {
    const proj = workspacesMod.createProject(DIRR).id;
    workspacesMod.registerRepoUnderProject(proj, DIRR);
    // B1: an initiative = a CEO DIRECTIVE landed under the member repo (directive.parent_id = repo,
    // repo.parent_id = project). It lands `directive` → non-terminal → an ACTIVE initiative (pending
    // its CTO's decomposition).
    const ini = storiesMod.createProjectInitiative(proj, DIRR, "ship the thing");
    const directive = ini.directives[0]!;
    expect(tasksMod.getTask(directive.id)!.status).toBe("directive");

    const err = await errOf(() => workspacesMod.deleteProject(proj));
    expect(err?.status).toBe(409);
    // Initiatives are checked BEFORE repos, so despite the repo also being registered this hits the
    // INITIATIVES message — proving that guard is independently reachable (not shadowed by repos).
    expect(err?.message).toContain("active initiative");
    expect(err?.message).not.toContain("registered repo");

    // Once the directive reaches a terminal status (`accepted`) it no longer blocks (repos guard now
    // surfaces).
    dbMod.db.query(`UPDATE tasks SET status='accepted' WHERE id=?`).run(directive.id);
    const err2 = await errOf(() => workspacesMod.deleteProject(proj));
    expect(err2?.status).toBe(409);
    expect(err2?.message).toContain("registered repo");
  });

  test("(e) a CEO-enabled empty project tears down its ws-ceo-<id> row on delete", async () => {
    const proj = workspacesMod.createProject(DIRR).id;
    await workspacesMod.setWorkspaceCeoEnabled(proj, true); // materializes the ws-ceo-<id> row
    const wsId = `ws-ceo-${proj}`;
    expect(dbMod.getWorkspaceAgentRow(wsId)).not.toBeNull();

    await workspacesMod.deleteProject(proj);

    expect(dbMod.getWorkspaceAgentRow(wsId)).toBeNull(); // torn down, not orphaned
    expect(workspacesMod.getProject(proj)).toBeNull();
  });
});
