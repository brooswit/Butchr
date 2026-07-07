// CREATE-NEW-REPOS — the CEO's create-a-new-repo primitive (REVAMP-4 CEO-operating-model RFC,
// story st-30a7dccd, Phase A2 / Q2 / DECISION 1 = config.reposRoot). Pins workspaces.createRepoUnderProject
// + the POST /api/projects/:id/repos/create route: `git init` a fresh repo under config.reposRoot, then
// hand it to the EXISTING registerWorkspaceUnderProject so it materializes + parents the repo node and
// mints a herdr workspace. In-process on the shared DB singleton (asserts only on its own uniquely-named
// rows), with a temp reposRoot + the herdr binary stubbed (BUTCHR_HERDR_BIN=true) so it stays CI-safe.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPOS_ROOT: string;
let dbMod: typeof import("../src/db.ts");
let gitMod: typeof import("../src/git.ts");
let workspacesMod: typeof import("../src/workspaces.ts");
let serverMod: typeof import("../src/server.ts");
let server: ReturnType<typeof import("../src/server.ts").startServer>;
let BASE: string;
let PROJ: string;

const M1 = "dir-cr-m1"; // an existing directory to anchor the test project to
const M2 = "dir-cr-m2"; // a repo node (NOT a project) for the route 404 case

/** Run an async `fn` and return the HttpError status it threw (0 if none, -1 if statusless). */
async function statusOfAsync(fn: () => Promise<unknown>): Promise<number> {
  try {
    await fn();
    return 0;
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
}

describe("createRepoUnderProject + POST /api/projects/:id/repos/create", () => {
  beforeAll(async () => {
    DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-cr-"));
    REPOS_ROOT = join(DATA_DIR, "repos");
    process.env.BUTCHR_DATA_DIR = DATA_DIR;
    process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
    process.env.BUTCHR_LOG_FILE = "";
    process.env.BUTCHR_HERDR_BIN = "true";
    // Provide a git identity for the fresh repo's ROOT commit so the test is hermetic regardless of
    // whether the CI runner has a global git user configured (initRepo uses ambient git config).
    process.env.GIT_AUTHOR_NAME = "butchr test";
    process.env.GIT_AUTHOR_EMAIL = "t@butchr.local";
    process.env.GIT_COMMITTER_NAME = "butchr test";
    process.env.GIT_COMMITTER_EMAIL = "t@butchr.local";

    dbMod = await import("../src/db.ts");
    gitMod = await import("../src/git.ts");
    workspacesMod = await import("../src/workspaces.ts");
    serverMod = await import("../src/server.ts");
    // config is a singleton locked at first import, so pin the mutable fields for this test: a
    // conflict-free ephemeral port and a temp reposRoot (BUTCHR_REPOS_ROOT may be stale in a shared run).
    const { config } = await import("../src/config.ts");
    config.port = 0;
    config.reposRoot = REPOS_ROOT;

    // Two dedicated directories (own ids) + their repo nodes; a project anchored to M1.
    for (const dir of [M1, M2]) {
      dbMod.db
        .query(`INSERT OR IGNORE INTO directory (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
        .run(dir, join(DATA_DIR, dir), dir, dbMod.nowIso());
    }
    dbMod.migrateMaterializeRepoNodes();
    PROJ = workspacesMod.createProject(M1).id;

    server = serverMod.startServer();
    BASE = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server?.stop(true);
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  test("materializes a git repo under reposRoot, registers + parents it under the project", async () => {
    const view = await workspacesMod.createRepoUnderProject(PROJ, "alpha", "Alpha");
    const path = join(REPOS_ROOT, "alpha");
    // A real git repo now exists on disk with a root commit on `main`.
    expect(existsSync(path)).toBe(true);
    expect(await gitMod.isGitRepo(path)).toBe(true);
    expect(await gitMod.defaultBranch(path)).toBe("main");
    expect(await gitMod.branchExists(path, "main")).toBe(true);
    // Registered at the created path, with its repo node parented under the project.
    expect(view.path).toBe(path);
    const node = workspacesMod.getRepoNode(view.id)!;
    expect(node).toBeTruthy();
    expect(node.parent_id).toBe(PROJ);
    expect(workspacesMod.listProjectRepos(PROJ).map((r) => r.id)).toContain(view.id);
  });

  test("route returns 201 with the created workspace and parents the repo", async () => {
    const res = await fetch(`${BASE}/api/projects/${PROJ}/repos/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "beta", label: "Beta" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; path: string };
    expect(body.id).toBeTruthy();
    expect(body.path).toBe(join(REPOS_ROOT, "beta"));
    expect(await gitMod.isGitRepo(join(REPOS_ROOT, "beta"))).toBe(true);
    expect(workspacesMod.getRepoNode(body.id)!.parent_id).toBe(PROJ);
  });

  test("409: a pre-existing NON-empty path is refused (never clobbered)", async () => {
    const path = join(REPOS_ROOT, "occupied");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "keep.txt"), "existing content", "utf8");
    const status = await statusOfAsync(() =>
      workspacesMod.createRepoUnderProject(PROJ, "occupied"),
    );
    expect(status).toBe(409);
    // Untouched: our file survives and no workspace was registered at that path.
    expect(readdirSync(path)).toEqual(["keep.txt"]);
    expect(workspacesMod.getWorkspaceByPath(path)).toBeNull();
  });

  test("404: a missing project is rejected", async () => {
    const status = await statusOfAsync(() =>
      workspacesMod.createRepoUnderProject("proj-does-not-exist", "orphan"),
    );
    expect(status).toBe(404);
    expect(existsSync(join(REPOS_ROOT, "orphan"))).toBe(false); // no repo materialized
  });

  test("404: the route rejects a non-project id WITHOUT creating a repo", async () => {
    const res = await fetch(`${BASE}/api/projects/${M2}/repos/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "under-nonproject" }),
    });
    expect(res.status).toBe(404); // M2 is a repo node, not a project
    expect(existsSync(join(REPOS_ROOT, "under-nonproject"))).toBe(false);
  });

  test("400: traversal / multi-segment / absolute names are refused (no repo escapes reposRoot)", async () => {
    for (const bad of ["../evil", "a/b", "..", ".", "/abs", "nested\\seg"]) {
      const status = await statusOfAsync(() => workspacesMod.createRepoUnderProject(PROJ, bad));
      expect(status).toBe(400);
    }
    // Nothing was created outside reposRoot (the sibling of reposRoot stays clean).
    expect(existsSync(join(DATA_DIR, "evil"))).toBe(false);
  });

  test("400: an empty / non-string name is refused", async () => {
    expect(await statusOfAsync(() => workspacesMod.createRepoUnderProject(PROJ, ""))).toBe(400);
    expect(await statusOfAsync(() => workspacesMod.createRepoUnderProject(PROJ, "   "))).toBe(400);
    expect(await statusOfAsync(() => workspacesMod.createRepoUnderProject(PROJ, 42))).toBe(400);
  });
});
