// story st-307edc78 — a project's managed CEO gets its OWN directory (and therefore its OWN herdr
// workspace), NEVER a member repo directory. This is the ROOT-CAUSE fix for the dashboard
// terminal-button crossing: a CEO anchored to its repo's directory co-located with that repo's CTO
// in ONE herdr workspace (both keyed by directory_id), so `herdr agent attach <name>` hit the
// shared workspace's ACTIVE pane and the two terminal buttons crossed. Distinct directory_id ⇒
// distinct ensureHerdrWorkspace key ⇒ distinct herdr workspace ⇒ unambiguous attach.
//
// This suite pins:
//   (a) setWorkspaceCeoEnabled anchors the ws-ceo row's directory_id to the CEO HOME dir under
//       config.dataDir — NOT project.workspace_id / any repo dir — and that dir resolves on disk.
//   (b) SEPARATE herdr workspaces: a project CEO and that repo's CTO end up keyed to DIFFERENT
//       directory_ids (the launcher keys the herdr workspace by directory_id).
//   (c) the boot re-anchor MIGRATION moves an already-anchored (old repo-dir) CEO onto its home,
//       clearing herdr_workspace + freeing the old pane BY NAME, while PRESERVING session_id +
//       desired (so the supervisor --resumes the same Claude session in the new cwd).
//   (d) synthetic CEO-home dirs are EXCLUDED from the repo-workspace listing (no phantom cards).
//
// Pure / in-process: rows are seeded via the db singleton with a fake launcher (setLauncherForTest),
// so NO real herdr/claude is driven. The db/config singletons are SHARED across test files, so we
// use a dedicated DATA_DIR + distinct ids and assert only on our own rows.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceLauncher } from "../src/workspace-agent.ts";

let DATA_DIR: string;
let cfgMod: typeof import("../src/config.ts");
let dbMod: typeof import("../src/db.ts");
let wa: typeof import("../src/workspace-agent.ts");
let dirsMod: typeof import("../src/workspaces.ts");

const REPO_DIR = "dir-ceohome-repo"; // the member repo's directory (== its repo-node id, S0a)
const PROJ = "pj-ceohome"; // a project node anchored to REPO_DIR

/** Seed a directory row (the real `directory` table) so a workspace's directory_id FK resolves. */
function insertDir(id: string): void {
  dbMod.db
    .query(
      `INSERT OR IGNORE INTO directory (id, path, label, herdr_workspace, herdr_pane, created_at)
       VALUES (?, ?, ?, NULL, NULL, ?)`,
    )
    .run(id, join(DATA_DIR, id), id, dbMod.nowIso());
}

/** Seed a PROJECT node (work_kind='project') anchored to REPO_DIR, mirroring createProject's shape. */
function insertProjectNode(id: string): void {
  dbMod.db
    .query(
      `INSERT OR IGNORE INTO tasks (id, workspace_id, status, work_kind, parent_id, created_at)
       VALUES (?, ?, 'merged', 'project', NULL, ?)`,
    )
    .run(id, REPO_DIR, dbMod.nowIso());
}

/** A no-op fake launcher that records teardown-by-name calls (no real herdr). */
function makeFakeLauncher() {
  const teardowns: string[] = [];
  const launcher: WorkspaceLauncher = {
    async launch() {
      /* never launched in these tests */
    },
    async teardown(name: string) {
      teardowns.push(name);
    },
  };
  return { launcher, teardowns };
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-ceohome-"));
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  cfgMod = await import("../src/config.ts");
  dbMod = await import("../src/db.ts");
  wa = await import("../src/workspace-agent.ts");
  dirsMod = await import("../src/workspaces.ts");
  // config.dataDir is read at import; the env is set before import, but pin it defensively so the
  // CEO home resolves under our isolated dir regardless of any prior importer.
  cfgMod.config.dataDir = DATA_DIR;
});

afterAll(() => {
  wa.setLauncherForTest(null);
  rmSync(DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  dbMod.db.query(`DELETE FROM workspace`).run();
  dbMod.db.query(`DELETE FROM tasks`).run();
  dbMod.db.query(`DELETE FROM directory WHERE id LIKE 'ceo-dir-%'`).run();
  wa._resetSupervisionStateForTest();
  insertDir(REPO_DIR);
  insertProjectNode(PROJ);
});

afterEach(() => {
  wa.setLauncherForTest(null);
});

describe("CEO home directory (story st-307edc78)", () => {
  test("ensureCeoHomeDirectory creates a home dir + minimal directory row, idempotently", () => {
    const dirId = dirsMod.ensureCeoHomeDirectory(PROJ);
    expect(dirId).toBe(`ceo-dir-${PROJ}`);

    const expectedPath = join(DATA_DIR, "projects", PROJ);
    expect(existsSync(expectedPath)).toBe(true);

    const row = dirsMod.getWorkspace(dirId);
    expect(row).not.toBeNull();
    expect(row!.path).toBe(expectedPath);
    expect(row!.herdr_workspace).toBeNull(); // minted lazily at first launch

    // Idempotent: a re-run returns the same id and does not duplicate the row.
    expect(dirsMod.ensureCeoHomeDirectory(PROJ)).toBe(dirId);
    const n = dbMod.db
      .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM directory WHERE id=?`)
      .get(dirId)!.n;
    expect(n).toBe(1);
  });

  test("(a) setWorkspaceCeoEnabled anchors the ws-ceo row to the CEO home, NOT the repo dir", async () => {
    const { launcher } = makeFakeLauncher();
    wa.setLauncherForTest(launcher);

    await dirsMod.setWorkspaceCeoEnabled(PROJ, true);

    const wsId = `ws-ceo-${PROJ}`;
    const row = dbMod.getWorkspaceAgentRow(wsId);
    expect(row).not.toBeNull();
    expect(row!.kind).toBe("ceo");
    expect(row!.desired).toBe(1);

    // The anchor is the CEO home — NOT project.workspace_id (the repo dir).
    expect(row!.directory_id).toBe(`ceo-dir-${PROJ}`);
    expect(row!.directory_id).not.toBe(REPO_DIR);

    // And it resolves to a real cwd under config.dataDir (the launcher's directoryPath source).
    const home = dirsMod.getWorkspace(row!.directory_id!);
    expect(home!.path).toBe(join(DATA_DIR, "projects", PROJ));
    expect(home!.path.startsWith(cfgMod.config.dataDir)).toBe(true);
  });

  test("(b) a project CEO and that repo's CTO are keyed to DIFFERENT directory_ids (separate herdr workspaces)", async () => {
    const { launcher } = makeFakeLauncher();
    wa.setLauncherForTest(launcher);

    // The repo's CTO workspace row is anchored to the repo directory.
    dbMod.saveWorkspaceAgentRow(`ws-cto-${REPO_DIR}`, { kind: "cto", directory_id: REPO_DIR });

    await dirsMod.setWorkspaceCeoEnabled(PROJ, true);

    const ctoDir = dbMod.getWorkspaceAgentRow(`ws-cto-${REPO_DIR}`)!.directory_id;
    const ceoDir = dbMod.getWorkspaceAgentRow(`ws-ceo-${PROJ}`)!.directory_id;
    // The launcher keys ensureHerdrWorkspace by directory_id — distinct ids ⇒ distinct workspaces.
    expect(ceoDir).not.toBe(ctoDir);
    expect(ctoDir).toBe(REPO_DIR);
    expect(ceoDir).toBe(`ceo-dir-${PROJ}`);
  });

  test("(c) boot re-anchor MOVES an already-anchored CEO onto its home; session_id + desired preserved, old pane freed", async () => {
    const { launcher, teardowns } = makeFakeLauncher();
    wa.setLauncherForTest(launcher);

    const wsId = `ws-ceo-${PROJ}`;
    // Pre-seed the OLD-world shape: a live CEO anchored to the repo dir, sharing the CTO's herdr ws.
    dbMod.saveWorkspaceAgentRow(wsId, {
      kind: "ceo",
      work_id: PROJ,
      directory_id: REPO_DIR,
      session_id: "sess-ceo-keepme",
      herdr_workspace: "w-shared-with-cto",
      has_agent: 1,
      desired: 1,
      started_at: dbMod.nowIso(),
    });

    await dirsMod.reanchorAllCeoHomes();

    const row = dbMod.getWorkspaceAgentRow(wsId)!;
    expect(row.directory_id).toBe(`ceo-dir-${PROJ}`); // moved to its home
    expect(row.herdr_workspace).toBeNull(); // cleared → re-minted at new dir on relaunch
    expect(row.has_agent).toBe(0); // supervisor will relaunch fresh in the new cwd
    expect(row.session_id).toBe("sess-ceo-keepme"); // --resume continuity preserved
    expect(row.desired).toBe(1); // still enabled

    // ONLY the CEO's own pane was freed, by its stable name (the shared herdr workspace + CTO pane
    // are untouched — teardown is agentDeregister/teardownTask by NAME, never a workspace destroy).
    const ceoName = wa.workspaceAgentName(row);
    expect(teardowns).toEqual([ceoName]);

    // Idempotent: a second pass is a no-op (already home) — no further teardown.
    await dirsMod.reanchorAllCeoHomes();
    expect(teardowns).toEqual([ceoName]);
  });

  test("(d) synthetic CEO-home dirs are excluded from the repo-workspace listing (no phantom cards)", () => {
    dirsMod.ensureCeoHomeDirectory(PROJ);
    const ids = dirsMod.listWorkspaces().map((w) => w.id);
    expect(ids).toContain(REPO_DIR); // real repo still listed
    expect(ids).not.toContain(`ceo-dir-${PROJ}`); // internal agent home hidden
  });
});
