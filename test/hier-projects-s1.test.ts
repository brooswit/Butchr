// Hierarchical Projects IA — S1 foundation (story st-6560e4f3). Pins the backend model everything
// else nests on:
//   (1) the ONE-TIME default-project ADOPT migration (migrateAdoptLooseReposUnderDefaultProject) —
//       nests every loose repo under a single deterministic `proj-default`, guarded so it is
//       idempotent (no 2nd default / no re-adopt of a deliberately unregistered repo), reversible
//       (unregister → parent_id NULL), non-coercive (a pre-existing user project blocks the default),
//       and leaves the WORK VIEWS byte-identical (repo/project nodes are excluded from GET /api/work).
//       The migration is GLOBAL (adopts ALL loose repos into ONE default), so it is exercised in an
//       ISOLATED SUBPROCESS bound to a seeded DB via BUTCHR_DB — never the shared full-suite db
//       singleton (mirrors test/db-migrations.test.ts / test/work-workspace-foundation.test.ts).
//   (2) the atomic register-under-project surface — the service fn registerWorkspaceUnderProject +
//       the POST /api/projects/:id/workspaces route: register an EXISTING git dir, materialize its
//       repo node, reparent it under the project, and ROLL BACK the registration if the reparent
//       fails so no loose repo is ever stranded (happy 201, 404 non-project, 400 non-git, atomicity).
//       These assert only on their own uniquely-named rows, so they run in-process on the singleton.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ============================================================================
// (1) The default-project ADOPT migration — isolated subprocess, seeded DB.
// ============================================================================
// The subprocess boots db.ts against a FRESH DB (so the boot pass runs on an empty slate), seeds a
// known set of loose repos, then drives every S1 scenario deterministically and prints one RESULT.
const MIGRATION_SUBPROCESS = `
const m = await import(process.env.DB_TS);
const wsm = await import(process.env.WS_TS);
const wapi = await import(process.env.WORK_API_TS);
const db = m.db;

// Three loose repo directories (DB rows only — no git needed for the migration path) + repo nodes.
for (const d of ["dir-1", "dir-2", "dir-3"]) {
  db.query("INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)").run(d, "/tmp/" + d, d, m.nowIso());
}
m.migrateMaterializeRepoNodes();
// A real leaf so the byte-identical work-view snapshot has teeth (a leaf is INCLUDED in GET /api/work).
db.query("INSERT INTO tasks (id, workspace_id, status, work_kind, parent_id, created_at) VALUES ('leaf-1', 'dir-1', 'in_review', 'leaf', 'dir-1', ?)").run(m.nowIso());

const parentOf = (id) => wsm.getRepoNode(id).parent_id;
const projCount = () => db.query("SELECT COUNT(*) AS n FROM tasks WHERE work_kind='project'").get().n;
const result = {};

// --- GUARD (b): a pre-existing USER project blocks the default (run first, before any proj-default).
const userProj = wsm.createProject("dir-3").id;
wsm.registerRepoUnderProject(userProj, "dir-3");
m.migrateAdoptLooseReposUnderDefaultProject();
result.guardB = {
  defaultMinted: !!wsm.getProject("proj-default"), // expect false — a repo already sits under a project
  d1: parentOf("dir-1"), // null (loose)
  d2: parentOf("dir-2"), // null (loose)
  d3: parentOf("dir-3"), // userProj
  userProj,
};
// Reset to a clean slate for the adopt scenarios: detach dir-3 + drop the user project.
wsm.unregisterRepoFromProject(userProj, "dir-3");
db.query("DELETE FROM tasks WHERE id=?").run(userProj);

// --- ADOPT + anchor + byte-identical work views.
const beforeWork = await wapi.listWork();
m.migrateAdoptLooseReposUnderDefaultProject();
const afterWork = await wapi.listWork();
const proj = wsm.getProject("proj-default");
result.adopt = {
  exists: !!proj,
  work_kind: proj && proj.work_kind,
  status: proj && proj.status,
  brief: proj && proj.brief,
  parent_id: proj && proj.parent_id,
  anchor: proj && proj.workspace_id, // deterministic MIN(id) of the loose repos → 'dir-1'
  members: wsm.listProjectRepos("proj-default").map((r) => r.id).sort(),
  d1: parentOf("dir-1"),
  d2: parentOf("dir-2"),
  d3: parentOf("dir-3"),
};
result.byteIdentical = JSON.stringify(beforeWork) === JSON.stringify(afterWork);
result.workHasLeaf = beforeWork.some((w) => w.id === "leaf-1");

// --- IDEMPOTENT: a re-run mints no second default and changes nothing.
const projCountBefore = projCount();
const parentsBefore = ["dir-1", "dir-2", "dir-3"].map(parentOf);
m.migrateAdoptLooseReposUnderDefaultProject();
result.idempotent = {
  projCountBefore,
  projCountAfter: projCount(),
  parentsBefore,
  parentsAfter: ["dir-1", "dir-2", "dir-3"].map(parentOf),
};

// --- REVERSIBLE + no re-adopt: unregister → NULL, and a re-run leaves it NULL (guard a).
wsm.unregisterRepoFromProject("proj-default", "dir-1");
result.afterUnregister = parentOf("dir-1"); // null
m.migrateAdoptLooseReposUnderDefaultProject();
result.afterReRun = parentOf("dir-1"); // still null — the default already exists, no re-adopt
result.projCountFinal = projCount(); // still exactly 1

console.log("RESULT:" + JSON.stringify(result));
`;

describe("migrateAdoptLooseReposUnderDefaultProject (isolated boot pass)", () => {
  let out: any;
  let DATA_DIR: string;

  beforeAll(() => {
    DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-hp-mig-"));
    const env = {
      ...process.env,
      BUTCHR_DB: join(DATA_DIR, "test.db"),
      BUTCHR_DATA_DIR: DATA_DIR,
      BUTCHR_LOG_FILE: "",
      BUTCHR_HERDR_BIN: "true",
      DB_TS: join(import.meta.dir, "../src/db.ts"),
      WS_TS: join(import.meta.dir, "../src/workspaces.ts"),
      WORK_API_TS: join(import.meta.dir, "../src/work-api.ts"),
    };
    const res = Bun.spawnSync(["bun", "-e", MIGRATION_SUBPROCESS], { env });
    const stdout = res.stdout.toString();
    const line = stdout.split("\n").find((l) => l.startsWith("RESULT:"));
    if (!line) {
      throw new Error(
        `migration subprocess produced no RESULT (exit ${res.exitCode}).\nstdout:\n${stdout}\nstderr:\n${res.stderr.toString()}`,
      );
    }
    out = JSON.parse(line.slice("RESULT:".length));
  });

  afterAll(() => rmSync(DATA_DIR, { recursive: true, force: true }));

  test("GUARD (b): a pre-existing user project blocks the default (no coercion)", () => {
    expect(out.guardB.defaultMinted).toBe(false);
    expect(out.guardB.d1).toBeNull(); // loose repos stay loose
    expect(out.guardB.d2).toBeNull();
    expect(out.guardB.d3).toBe(out.guardB.userProj); // the user's own membership is untouched
  });

  test("adopts EVERY loose repo under ONE default project anchored to MIN(id)", () => {
    expect(out.adopt.exists).toBe(true);
    expect(out.adopt.work_kind).toBe("project");
    expect(out.adopt.status).toBe("merged"); // inert terminal anchor
    expect(out.adopt.parent_id).toBeNull(); // the project is the tree-top
    expect(out.adopt.brief).toBe("Default project");
    expect(out.adopt.anchor).toBe("dir-1"); // deterministic MIN(id)
    expect(out.adopt.members).toEqual(["dir-1", "dir-2", "dir-3"]);
    expect(out.adopt.d1).toBe("proj-default");
    expect(out.adopt.d2).toBe("proj-default");
    expect(out.adopt.d3).toBe("proj-default");
  });

  test("BYTE-IDENTICAL work views: adoption does not change GET /api/work", () => {
    expect(out.workHasLeaf).toBe(true); // the snapshot actually has content
    expect(out.byteIdentical).toBe(true); // repo/project nodes are excluded — a new parent is invisible
  });

  test("IDEMPOTENT: a re-run mints no second default and changes nothing", () => {
    expect(out.idempotent.projCountBefore).toBe(1);
    expect(out.idempotent.projCountAfter).toBe(1); // no duplicate default
    expect(out.idempotent.parentsAfter).toEqual(out.idempotent.parentsBefore); // parents untouched
  });

  test("REVERSIBLE + no re-adopt: unregister → NULL, and a re-run leaves it NULL", () => {
    expect(out.afterUnregister).toBeNull(); // reversible via the existing inverse
    expect(out.afterReRun).toBeNull(); // guard (a): the default exists → no silent re-adopt
    expect(out.projCountFinal).toBe(1);
  });
});

// ============================================================================
// (2) The atomic register-under-project surface — in-process (own rows only).
// ============================================================================
let DATA_DIR: string;
let dbMod: typeof import("../src/db.ts");
let workspacesMod: typeof import("../src/workspaces.ts");
let serverMod: typeof import("../src/server.ts");
let server: ReturnType<typeof import("../src/server.ts").startServer>;
let BASE: string;
let PROJ: string;

const M1 = "dir-hp-m1"; // an existing directory to anchor the test project to
const M2 = "dir-hp-m2"; // a repo node (NOT a project) for the 404 case
const gitRepos: string[] = [];

/** Run an async `fn` and return the HttpError status it threw (0 if none, -1 if statusless). */
async function statusOfAsync(fn: () => Promise<unknown>): Promise<number> {
  try {
    await fn();
    return 0;
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
}

/** A fresh, empty git repo dir (the register-EXISTING path requires a real git repo). */
function makeGitRepo(name: string): string {
  const p = mkdtempSync(join(tmpdir(), `butchr-hp-${name}-`));
  execFileSync("git", ["init", "-q", p], { stdio: "ignore" });
  execFileSync("git", ["-C", p, "config", "user.email", "t@butchr.local"], { stdio: "ignore" });
  execFileSync("git", ["-C", p, "config", "user.name", "butchr test"], { stdio: "ignore" });
  return p;
}

describe("registerWorkspaceUnderProject + POST /api/projects/:id/workspaces", () => {
  beforeAll(async () => {
    DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-hp-ep-"));
    process.env.BUTCHR_DATA_DIR = DATA_DIR;
    process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
    process.env.BUTCHR_LOG_FILE = "";
    process.env.BUTCHR_HERDR_BIN = "true";

    dbMod = await import("../src/db.ts");
    workspacesMod = await import("../src/workspaces.ts");
    serverMod = await import("../src/server.ts");
    // Force an EPHEMERAL port. config is a singleton locked at first import (so BUTCHR_PORT can be
    // stale in a shared full-suite process, AND the default :47800 may already be bound by a live
    // butchr) — overriding the mutable field pins a conflict-free port for startServer.
    (await import("../src/config.ts")).config.port = 0;

    // Two dedicated directories (own ids) + their repo nodes; a project anchored to M1.
    for (const dir of [M1, M2]) {
      dbMod.db
        .query(`INSERT OR IGNORE INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
        .run(dir, join(DATA_DIR, dir), dir, dbMod.nowIso());
    }
    dbMod.migrateMaterializeRepoNodes();
    PROJ = workspacesMod.createProject(M1).id;

    server = serverMod.startServer();
    BASE = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server?.stop(true);
    for (const p of gitRepos) rmSync(p, { recursive: true, force: true });
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  test("happy path: the new repo is registered AND parented under the project", async () => {
    const repoPath = makeGitRepo("happy");
    gitRepos.push(repoPath);
    const view = await workspacesMod.registerWorkspaceUnderProject(PROJ, repoPath, "happy");
    expect(view.id).toBeTruthy();
    const node = workspacesMod.getRepoNode(view.id)!;
    expect(node).toBeTruthy();
    expect(node.parent_id).toBe(PROJ);
    expect(workspacesMod.listProjectRepos(PROJ).map((r) => r.id)).toContain(view.id);
  });

  test("route returns 201 with the created workspace and parents the repo", async () => {
    const repoPath = makeGitRepo("route201");
    gitRepos.push(repoPath);
    const res = await fetch(`${BASE}/api/projects/${PROJ}/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: repoPath, label: "route201" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBeTruthy();
    expect(workspacesMod.getRepoNode(body.id)!.parent_id).toBe(PROJ);
  });

  test("409: an already-registered path is preserved (rollback must NOT tear it down)", async () => {
    const repoPath = makeGitRepo("dup");
    gitRepos.push(repoPath);
    const view = await workspacesMod.registerWorkspaceUnderProject(PROJ, repoPath, "dup");
    // A second register of the SAME path 409s inside registerWorkspace — which runs BEFORE (outside)
    // the reparent try/catch, so the compensating unregister must NOT fire on the pre-existing repo.
    const status = await statusOfAsync(() =>
      workspacesMod.registerWorkspaceUnderProject(PROJ, repoPath, "dup"),
    );
    expect(status).toBe(409);
    // The original workspace + its project membership survive intact.
    expect(workspacesMod.getWorkspaceByPath(repoPath)!.id).toBe(view.id);
    expect(workspacesMod.getRepoNode(view.id)!.parent_id).toBe(PROJ);
  });

  test("404: a non-project id is rejected by the route WITHOUT side effects", async () => {
    const before = workspacesMod.listWorkspaces().length;
    const res = await fetch(`${BASE}/api/projects/${M2}/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/nonexistent" }),
    });
    expect(res.status).toBe(404); // M2 is a repo node, not a project → pre-guard 404
    expect(workspacesMod.listWorkspaces().length).toBe(before); // nothing was registered
  });

  test("400: a non-git path is refused (register-existing only) and nothing is parented", async () => {
    const notGit = mkdtempSync(join(tmpdir(), "butchr-hp-notgit-"));
    gitRepos.push(notGit);
    const status = await statusOfAsync(() =>
      workspacesMod.registerWorkspaceUnderProject(PROJ, notGit),
    );
    expect(status).toBe(400);
    expect(workspacesMod.getWorkspaceByPath(notGit)).toBeNull(); // not registered
  });

  test("ATOMICITY: a failing reparent leaves NO loose repo (registration rolled back)", async () => {
    const repoPath = makeGitRepo("atomic");
    gitRepos.push(repoPath);
    // A bogus (non-project) id makes the internal reparent throw AFTER registration + node
    // materialization — the compensating unregister must remove the directory and its repo node.
    const status = await statusOfAsync(() =>
      workspacesMod.registerWorkspaceUnderProject("proj-does-not-exist", repoPath, "atomic"),
    );
    expect(status).toBe(404); // registerRepoUnderProject: project not found
    // Rolled fully back: no directory row, no repo node → no loose repo stranded.
    expect(workspacesMod.getWorkspaceByPath(repoPath)).toBeNull();
    const looseAtomic = dbMod.db
      .query<{ n: number }, []>(
        `SELECT COUNT(*) AS n FROM tasks WHERE work_kind='repo' AND parent_id IS NULL
           AND id IN (SELECT id FROM directory WHERE path=?)`,
      )
      .get(repoPath)!.n;
    expect(looseAtomic).toBe(0);
  });

  // KEEP-WORKING invariant (story st-576b459f): removing repo-CREATION dropped the vestigial
  // assertCreationAllowed("ceo","repo") guard from the register-EXISTING routes. Registering an
  // already-materialized repo node by id is ADOPTION (not creation) and must still 201 — the guard
  // would have 403'd it once "repo" left the ceo authority set.
  test("POST /api/projects/:id/repos: adopting an existing repo node by id still returns 201", async () => {
    const REG = "hp-ep-adopt-repo";
    dbMod.db
      .query(`INSERT OR IGNORE INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
      .run(REG, join(DATA_DIR, REG), REG, dbMod.nowIso());
    dbMod.migrateMaterializeRepoNodes();
    expect(workspacesMod.getRepoNode(REG)!.parent_id).toBeNull(); // a loose repo node

    const res = await fetch(`${BASE}/api/projects/${PROJ}/repos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: REG }),
    });
    expect(res.status).toBe(201);
    expect(workspacesMod.getRepoNode(REG)!.parent_id).toBe(PROJ); // now a member of the project
  });
});
