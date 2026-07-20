// A PROJECT SELF-HOSTS its own home directory instead of borrowing a member workspace.
//
// THE BUG THIS UNBLOCKS: on a FRESH INSTALL with ZERO workspaces the dashboard could never create a
// project — createProject demanded an "anchor workspace" that must already exist, and the ONLY UI
// path to add a workspace lives INSIDE a project detail view. A hard deadlock on a new server.
//
// THE FIX: createProject mints its id FIRST, then provisions its OWN synthetic home via
// ensureCeoHomeDirectory (`<dataDir>/projects/<id>` + a `ceo-dir-<id>` row, story st-307edc78) and
// anchors tasks.workspace_id there. Reusing the CEO-home pair — rather than a new `proj-dir-` prefix
// — means the `ceo-dir-%` exclusion in listWorkspaces already keeps it off the dashboard.
//
// This suite pins:
//   (1) a project is creatable on a DB with ZERO directory rows (the fresh-install deadlock);
//   (2) the synthetic home is INVISIBLE to listWorkspaces but resolvable by exact id;
//   (3) NON-DESTRUCTIVE migration — a LEGACY project row anchored to a real member repo still
//       resolves through listProjects/getProject and keeps repo-membership;
//   (4) the CASCADE HAZARD — tasks.workspace_id is ON DELETE CASCADE (db.ts:107/116), so a
//       self-hosted project's anchor row can cascade the project away. deleteProject must still
//       return the right row and leave nothing behind.
//
// Pure / in-process against the db singleton with an isolated DATA_DIR, mirroring
// ceo-home-directory.test.ts. No real herdr/claude is driven.
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

// ISOLATION. The db singleton is SHARED across test files in a bun-test process, and assertion (1)
// needs a GENUINELY empty `directory` table (that emptiness IS the fresh-install bug being fixed).
// Clearing it outright strands rows that earlier-loaded suites seeded in their own beforeAll and
// breaks them downstream — observed as real, reproducible failures in auto-resume/resume-reground.
// So each test runs inside a TRANSACTION that is ROLLED BACK afterward: SQLite restores the shared
// tables byte-for-byte, and the wipe below is only ever visible within one test.
const WIPED_TABLES = ["workspace", "tasks", "directory"] as const;

function wipe(): void {
  for (const t of WIPED_TABLES) dbMod.db.query(`DELETE FROM ${t}`).run();
}

/** A no-op fake launcher — deleteProject tears down a CEO runtime by name. */
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

/** Seed a plain member-repo `directory` row (the LEGACY anchor shape). */
function insertDir(id: string): void {
  dbMod.db
    .query(
      `INSERT OR IGNORE INTO directory (id, path, label, herdr_workspace, herdr_pane, created_at)
       VALUES (?, ?, ?, NULL, NULL, ?)`,
    )
    .run(id, join(DATA_DIR, id), id, dbMod.nowIso());
}

let PREV_DATA_DIR: string;

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-selfhost-"));

  cfgMod = await import("../src/config.ts");
  dbMod = await import("../src/db.ts");
  wa = await import("../src/workspace-agent.ts");
  dirsMod = await import("../src/workspaces.ts");
  // The CONFIG singleton is shared across test files too. Pin dataDir so the project home lands
  // under our isolated dir regardless of any prior importer — and RESTORE it in afterAll, because
  // leaving it pointed at a dir we then rmSync breaks whichever suite bun happens to run next
  // (observed: auto-resume + resume-reground failing only when this file is present).
  PREV_DATA_DIR = cfgMod.config.dataDir;
  cfgMod.config.dataDir = DATA_DIR;
});

afterAll(() => {
  wa.setLauncherForTest(null);
  cfgMod.config.dataDir = PREV_DATA_DIR;
  rmSync(DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  dbMod.db.query(`BEGIN`).run();
  // A genuinely EMPTY slate — including the `directory` table, which is the whole point of (1).
  // Undone by the ROLLBACK below, so no other suite ever sees it.
  wipe();
  wa._resetSupervisionStateForTest();
});

afterEach(() => {
  dbMod.db.query(`ROLLBACK`).run();
  wa.setLauncherForTest(null);
});

describe("a project self-hosts its own home directory", () => {
  test("(1) FRESH INSTALL: createProject succeeds on a DB with ZERO workspaces", () => {
    // The precondition that used to deadlock: nothing to anchor to.
    expect(dirsMod.listWorkspaces()).toHaveLength(0);
    expect(
      dbMod.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM directory`).get()!.n,
    ).toBe(0);

    const proj = dirsMod.createProject("bootstrap a brand-new server");

    expect(proj.work_kind).toBe("project");
    expect(proj.status).toBe("merged");
    expect(proj.parent_id).toBeNull();
    expect(proj.brief).toBe("bootstrap a brand-new server");
    // It minted its OWN anchor rather than borrowing one.
    expect(proj.workspace_id).toBe(dirsMod.ceoHomeDirectoryId(proj.id));
    // ...which is a REAL row (the NOT NULL FK→directory is genuinely satisfied, not bypassed)...
    expect(dirsMod.getWorkspace(proj.workspace_id!)).not.toBeNull();
    // ...backed by a real dir on disk, where the CEO will actually launch.
    expect(existsSync(join(DATA_DIR, "projects", proj.id))).toBe(true);
  });

  test("(1b) each project gets its OWN distinct home; no id collides", () => {
    const a = dirsMod.createProject();
    const b = dirsMod.createProject();
    expect(a.id).not.toBe(b.id);
    expect(a.workspace_id).not.toBe(b.workspace_id);
    expect(
      dbMod.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM directory`).get()!.n,
    ).toBe(2);
  });

  test("(2) the synthetic home is HIDDEN from listWorkspaces but resolves by exact id", () => {
    insertDir("dir-real-repo"); // a genuine member repo, for contrast
    const proj = dirsMod.createProject();

    // The dashboard surface shows the repo and ONLY the repo — no phantom project-home card.
    const listed = dirsMod.listWorkspaces().map((w) => w.id);
    expect(listed).toContain("dir-real-repo");
    expect(listed).not.toContain(proj.workspace_id);
    expect(listed).toHaveLength(1);

    // But the launcher's exact-id lookup still resolves it (that is how the CEO gets its cwd).
    const home = dirsMod.getWorkspace(proj.workspace_id!)!;
    expect(home.path).toBe(join(DATA_DIR, "projects", proj.id));
  });

  test("(3) MIGRATION is non-destructive: a LEGACY member-repo-anchored project still resolves", () => {
    insertDir("dir-legacy-repo");
    // A project row EXACTLY as pre-change createProject wrote it: anchored to a member repo.
    const legacyId = "pj-legacy-0001";
    dbMod.db
      .query(
        `INSERT INTO tasks (id, workspace_id, status, created_at, work_kind, brief)
         VALUES (?, 'dir-legacy-repo', 'merged', ?, 'project', 'legacy shape')`,
      )
      .run(legacyId, dbMod.nowIso());

    const fresh = dirsMod.createProject("new shape");

    // BOTH shapes resolve identically through the read surfaces — nothing rewrote the old anchor.
    const legacy = dirsMod.getProject(legacyId)!;
    expect(legacy.workspace_id).toBe("dir-legacy-repo"); // untouched
    expect(legacy.brief).toBe("legacy shape");
    const listed = dirsMod.listProjects();
    expect(listed.map((p) => p.id).sort()).toEqual([fresh.id, legacyId].sort());
    expect(listed.find((p) => p.id === legacyId)!.workspace_id).toBe("dir-legacy-repo");

    // Repo-membership works for a LEGACY project (a repo node reparented under it)...
    dbMod.db
      .query(
        `INSERT INTO tasks (id, workspace_id, status, work_kind, parent_id, created_at)
         VALUES ('dir-legacy-repo', 'dir-legacy-repo', 'merged', 'repo', ?, ?)`,
      )
      .run(legacyId, dbMod.nowIso());
    expect(dirsMod.listProjectRepos(legacyId).map((r) => r.id)).toEqual(["dir-legacy-repo"]);
    // ...and the legacy anchor is a real repo, so it still shows as a workspace card.
    expect(dirsMod.listWorkspaces().map((w) => w.id)).toContain("dir-legacy-repo");

    // The CEO status surface (the CEO panel's read) works for BOTH shapes.
    expect(dirsMod.isCeoEnabled(legacyId)).toBe(cfgMod.config.ceoAgentEnabled);
    expect(dirsMod.isCeoEnabled(fresh.id)).toBe(cfgMod.config.ceoAgentEnabled);
  });

  test("(4) HAZARD: deleteProject on a SELF-HOSTED project — the anchor cascade does not eat it", async () => {
    const { launcher } = makeFakeLauncher();
    wa.setLauncherForTest(launcher);
    const proj = dirsMod.createProject("delete me");
    const home = proj.workspace_id!;
    expect(home).toBe(`ceo-dir-${proj.id}`);

    // tasks.workspace_id is ON DELETE CASCADE (db.ts) — so dropping `home` would take the project
    // row with it. deleteProject deletes the project row EXPLICITLY FIRST, then the home. NOTE: the
    // reverse order reaches an IDENTICAL end state via that cascade (verified by disarming the
    // ordering — this test passes either way), so what is pinned here is the OUTCOME, not the order:
    // the returned row is real and complete, and no row survives on either side of the FK.
    const deleted = await dirsMod.deleteProject(proj.id);

    // The captured row comes back intact (id/brief/kind), not an empty shell.
    expect(deleted.id).toBe(proj.id);
    expect(deleted.brief).toBe("delete me");
    expect(deleted.work_kind).toBe("project");

    // And BOTH rows are actually gone — the project AND its synthetic home.
    expect(dirsMod.getProject(proj.id)).toBeNull();
    expect(dirsMod.getWorkspace(home)).toBeNull();
    expect(dirsMod.listProjects()).toHaveLength(0);
    expect(
      dbMod.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM directory`).get()!.n,
    ).toBe(0);
  });

  test("(4b) deleting a self-hosted project leaves a LEGACY sibling's member repo alone", async () => {
    const { launcher } = makeFakeLauncher();
    wa.setLauncherForTest(launcher);
    insertDir("dir-shared-repo");
    const legacyId = "pj-legacy-0002";
    dbMod.db
      .query(
        `INSERT INTO tasks (id, workspace_id, status, created_at, work_kind)
         VALUES (?, 'dir-shared-repo', 'merged', ?, 'project')`,
      )
      .run(legacyId, dbMod.nowIso());
    const fresh = dirsMod.createProject();

    await dirsMod.deleteProject(fresh.id);

    // The self-hosted delete touched ONLY its own home — the shared repo and the legacy project
    // anchored to it survive (the delete is scoped to `ceo-dir-<its own id>`).
    expect(dirsMod.getWorkspace("dir-shared-repo")).not.toBeNull();
    expect(dirsMod.getProject(legacyId)).not.toBeNull();
    expect(dirsMod.getProject(legacyId)!.workspace_id).toBe("dir-shared-repo");
  });

  test("(4c) deleteProject still REFUSES a non-empty project (guards run before any teardown)", async () => {
    const { launcher } = makeFakeLauncher();
    wa.setLauncherForTest(launcher);
    const proj = dirsMod.createProject();
    insertDir("dir-member");
    dbMod.db
      .query(
        `INSERT INTO tasks (id, workspace_id, status, work_kind, parent_id, created_at)
         VALUES ('dir-member', 'dir-member', 'merged', 'repo', ?, ?)`,
      )
      .run(proj.id, dbMod.nowIso());

    await expect(dirsMod.deleteProject(proj.id)).rejects.toThrow(/registered repo/);
    // The refusal is TOTAL: the project AND its home survive intact for a retry.
    expect(dirsMod.getProject(proj.id)).not.toBeNull();
    expect(dirsMod.getWorkspace(proj.workspace_id!)).not.toBeNull();
  });
});
