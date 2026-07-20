// RFC — CEO OPERATING MODEL, PHASE D1 (FINAL, story st-30a7dccd): the NORTH-STAR acceptance test.
// A single, deterministic, CI-safe end-to-end proof that the whole CEO operating model runs the
// canonical LIBRARY-EXTRACTION scenario over its REST surface. This is the one runnable validation
// the RFC is judged by — it exercises the FULL plumbing built across phases A1→C1, in order:
//
//   (a) MEMBER REPOS ADDED BY THE USER: 2 fresh library repos are `git init`ed on disk (as the USER
//       does) and registered under the project via the register-EXISTING flow
//       (registerWorkspaceUnderProject). The CEO does NOT provision repos — repos are USER-added; the
//       CEO then DIRECTS work over the members. (Repo-CREATION was walked back — story st-576b459f.)
//   (b) DIRECTIVE FAN-OUT (Phase B1 / Q1): the CEO fans ONE directive-based initiative across all
//       three member repos (the 2 new libs + the source repo) — POST /api/projects/:id/initiatives
//       with a {targets:[…]} body → one `directive` LEAF per repo, all sharing one initiative id,
//       and NO story / NO leader forged by the initiative (the CEO delegates to the CTOs).
//   (c) CTO ACCEPT & DECOMPOSE (Phase A3): each repo's CTO turns its directive into an
//       initiative_id-stamped story — POST /api/work/:directiveId/stories → the directive goes
//       terminal `accepted`, the story leader launches.
//   (d) CROSS-REPO NODE-ON-NODE SEQUENCING (Phase A1 / Q3) — THE CROWN: the source-repo CONSUME
//       story is sequenced BEHIND both library stories — PUT /api/work/:id/blocked_by → its leader
//       is held DOWN (desired=0, node stays `open`) while the libs are unlanded, and AUTO-LAUNCHES
//       (desired=1) the instant BOTH library stories reach `done`.
//   (e) CROSS-REPO REVIEW (Phase C1 / Q5): on completion the CEO reviews what landed across every
//       repo — GET /api/projects/:id/initiatives/:iid/review returns each repo's landed summary +
//       merge sha + merged-subtask drill-down handles.
//
// SCOPE: this validates ORCHESTRATION PLUMBING, not agent cognition. LLM cognition is not
// determinism-testable, so we drive the REST verbs DIRECTLY — the CTO "accept" is the accept verb,
// not a live agent. Leaders launch as harmless no-ops (BUTCHR_HERDR_BIN=true); the dispatcher's
// merge-driven unblock sweep is invoked in-process (reevaluateAllBlocked) since no dispatcher runs
// under test; landing a story `done` uses the service transition (updateStory) exactly as the
// sibling suites (revamp4-cross-repo-initiative / initiative-review) do. Everything is hermetic:
// a temp BUTCHR_DATA_DIR/BUTCHR_DB + a temp repos dir + injected git identity + afterAll
// cleanup — fully isolated from any live state, no network, no registry publish (sequence-on-MERGE
// only). Mirrors the style of test/revamp4-cross-repo-initiative.test.ts and bin/butchr selftest.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPOS_ROOT: string;
let BASE: string;
let PROJ: string;

const SOURCE = "dir-ns-src"; // the throwaway SOURCE repo the library is extracted OUT OF (a member)

let dbMod: typeof import("../src/db.ts");
let gitMod: typeof import("../src/git.ts");
let tasksMod: typeof import("../src/tasks.ts");
let workspacesMod: typeof import("../src/workspaces.ts");
let storiesMod: typeof import("../src/stories.ts");
let serverMod: typeof import("../src/server.ts");
let server: ReturnType<typeof import("../src/server.ts").startServer>;

/** POST JSON to a route; returns the HTTP status + parsed body. */
async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** PUT JSON to a route; returns the HTTP status + parsed body. */
async function put(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** GET JSON from a route; returns the HTTP status + parsed body. */
async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** The `desired` flag on a story node's leader workspace-agent row (null if no row). */
function leaderDesired(storyId: string): number | null {
  return dbMod.getWorkspaceAgentRow(`ws-leader-${storyId}`)?.desired ?? null;
}

let subSeq = 0;
/** Seed a MERGED-terminal leaf subtask under a story node with a landed sha — the "what landed"
 *  drill-down handle the CEO review surfaces (mirrors initiative-review.test.ts's helper). */
function seedMergedSubtask(dir: string, storyId: string, summary: string, sha: string): string {
  const id = `ns-sub-${subSeq++}`;
  dbMod.db
    .query(
      `INSERT INTO tasks (id, workspace_id, status, work_kind, parent_id, summary, merged_sha, has_agent, created_at)
       VALUES (?, ?, 'merged', 'leaf', ?, ?, ?, 0, ?)`,
    )
    .run(id, dir, storyId, summary, sha, dbMod.nowIso());
  return id;
}

/** Stand up a real git repo on disk at `path` (as the USER would before registering it): a
 *  `main`-branch repo with a root commit so it passes isGitRepo + resolves defaultBranch cleanly. */
function gitInitAt(path: string): void {
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", path], { stdio: "ignore" });
  execFileSync("git", ["-C", path, "config", "user.email", "t@butchr.local"], { stdio: "ignore" });
  execFileSync("git", ["-C", path, "config", "user.name", "butchr test"], { stdio: "ignore" });
  execFileSync("git", ["-C", path, "commit", "--allow-empty", "-q", "-m", "init"], {
    stdio: "ignore",
  });
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-ns-"));
  REPOS_ROOT = join(DATA_DIR, "repos");
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true"; // leader launches are harmless no-ops
  delete process.env.BUTCHR_UNIFIED_WORK; // unified routing ON (default) — assert the live path
  // A hermetic git identity for the fresh library repos' ROOT commits, regardless of ambient config.
  process.env.GIT_AUTHOR_NAME = "butchr test";
  process.env.GIT_AUTHOR_EMAIL = "t@butchr.local";
  process.env.GIT_COMMITTER_NAME = "butchr test";
  process.env.GIT_COMMITTER_EMAIL = "t@butchr.local";

  dbMod = await import("../src/db.ts");
  gitMod = await import("../src/git.ts");
  tasksMod = await import("../src/tasks.ts");
  workspacesMod = await import("../src/workspaces.ts");
  storiesMod = await import("../src/stories.ts");
  serverMod = await import("../src/server.ts");
  // config is a singleton locked at first import — pin the ephemeral port for this run (BUTCHR_PORT
  // may be stale in a shared suite run). The library repos are git-init'ed under REPOS_ROOT, a plain
  // temp dir, by the USER-style setup below (butchr no longer provisions repos).
  const { config } = await import("../src/config.ts");
  config.port = 0;

  // The SOURCE repo: a dedicated directory row + its repo node, anchored + registered as a PROJECT
  // member. (No git needed — nothing merges here; the leaders are no-ops and the library repos are
  // the only ones `git init`ed on disk.)
  dbMod.db
    .query(`INSERT OR IGNORE INTO directory (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(SOURCE, join(DATA_DIR, "source"), SOURCE, dbMod.nowIso());
  dbMod.migrateMaterializeRepoNodes();
  PROJ = workspacesMod.createProject().id;
  workspacesMod.registerRepoUnderProject(PROJ, SOURCE);

  server = serverMod.startServer();
  BASE = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("NORTH STAR — the CEO operating model runs the library-extraction scenario end-to-end", () => {
  test("user-added repos → directive fan-out → accept → cross-repo sequencing → cross-repo review", async () => {
    // ---- (a) MEMBER REPOS ADDED BY THE USER: two library repos git-init'ed on disk, then --------
    // registered under the project via the register-EXISTING flow. The CEO does NOT provision repos;
    // the USER stands them up and adds them, and the CEO then directs work over the members.
    const libRepos: Record<string, string> = {}; // name → workspace id
    for (const [name, label] of [
      ["libcore", "Lib Core"],
      ["libutil", "Lib Util"],
    ] as const) {
      const path = join(REPOS_ROOT, name);
      gitInitAt(path); // the USER stands up a real repo on disk
      expect(existsSync(path)).toBe(true);
      expect(await gitMod.isGitRepo(path)).toBe(true); // a REAL git repo on disk
      expect(await gitMod.defaultBranch(path)).toBe("main");
      // The USER registers it under the project (register-EXISTING = adoption, not creation).
      const view = await workspacesMod.registerWorkspaceUnderProject(PROJ, path, label);
      expect(view.path).toBe(path);
      // Registered + parented under the project (a member the CEO can now direct).
      expect(workspacesMod.getRepoNode(view.id)!.parent_id).toBe(PROJ);
      libRepos[name] = view.id;
    }
    const LIB1 = libRepos.libcore!;
    const LIB2 = libRepos.libutil!;

    // ---- (b) DIRECTIVE FAN-OUT (Phase B1): ONE initiative → a directive per member repo --------
    // The CEO delegates: "build the library" to each new repo's CTO, "gut and depend on the libs"
    // to the source repo's CTO — all one initiative, fanned as directives (NOT stories/leaders).
    const fan = await post(`/api/projects/${PROJ}/initiatives`, {
      targets: [
        { repo: LIB1, brief: "build the core library" },
        { repo: LIB2, brief: "build the util library" },
        { repo: SOURCE, brief: "gut the source and depend on the new libraries" },
      ],
    });
    expect(fan.status).toBe(201);
    const iid: string = fan.body.initiative_id;
    expect(iid).toMatch(/^ini-/);
    expect(fan.body.project_id).toBe(PROJ);
    expect(fan.body.directives).toHaveLength(3);

    const directiveByRepo = new Map<string, any>(
      fan.body.directives.map((d: any) => [d.workspace_id, d]),
    );
    expect([...directiveByRepo.keys()].sort()).toEqual([LIB1, LIB2, SOURCE].sort());
    for (const d of fan.body.directives) {
      expect(d.work_kind).toBe("leaf");
      expect(d.status).toBe("directive");
      expect(d.initiative_id).toBe(iid); // one shared grouping key across all three repos
      // THE WHOLE POINT OF B1: the initiative forges NO story and launches NO leader — the CEO
      // directs; the CTOs (below) create the stories.
      expect(dbMod.getWorkspaceAgentRow(`ws-leader-${d.id}`)).toBeNull();
    }

    // ---- (c) CTO ACCEPT & DECOMPOSE (Phase A3): each directive → an initiative_id-stamped story -
    const storyByRepo: Record<string, string> = {};
    for (const repo of [LIB1, LIB2, SOURCE]) {
      const d = directiveByRepo.get(repo);
      const acc = await post(`/api/work/${d.id}/stories`, {
        targets: [{ brief: `story for ${repo}` }],
      });
      expect(acc.status).toBe(201);
      expect(acc.body.initiative_id).toBe(iid);
      expect(acc.body.stories).toHaveLength(1);
      const storyId: string = acc.body.stories[0].id;
      const node = tasksMod.getTask(storyId)!;
      expect(node.work_kind).toBe("node");
      expect(node.initiative_id).toBe(iid); // inherited the directive's grouping key
      expect(node.parent_id).toBe(repo); // parented under its repo node (bubbles like any story)
      // The CTO's accept launches the leader; the directive itself goes terminal `accepted`.
      expect(leaderDesired(storyId)).toBe(1);
      expect(tasksMod.getTask(d.id)!.status).toBe("accepted");
      storyByRepo[repo] = storyId;
    }
    const libStory1 = storyByRepo[LIB1]!;
    const libStory2 = storyByRepo[LIB2]!;
    const srcStory = storyByRepo[SOURCE]!;

    // ---- (d) CROSS-REPO NODE-ON-NODE SEQUENCING (Phase A1) — THE CROWN ------------------------
    // The source CONSUME story must not start until BOTH libraries exist. Sequence it behind the
    // two library stories via node-on-node blocked_by.
    const seq = await put(`/api/work/${srcStory}/blocked_by`, {
      blocked_by: [libStory1, libStory2],
    });
    expect(seq.status).toBe(200);
    // blocked_by is persisted as a JSON string on the task row — parse it to assert the set.
    expect(JSON.parse(tasksMod.getTask(srcStory)!.blocked_by as unknown as string).sort()).toEqual(
      [libStory1, libStory2].sort(),
    );

    // The consume leader is HELD DOWN (kill-on-block) and the node STAYS `open` — unlaunched while
    // the libraries are unlanded.
    expect(leaderDesired(srcStory)).toBe(0);
    expect(tasksMod.getTask(srcStory)!.status).toBe("open");

    // The dispatcher's node-arm unblock sweep does NOT release it while the libs are still open.
    tasksMod.reevaluateAllBlocked();
    expect(leaderDesired(srcStory)).toBe(0);

    // Land library 1 `done` — but library 2 is still open, so the consume story stays HELD.
    storiesMod.updateStory(libStory1, { status: "done" });
    tasksMod.reevaluateAllBlocked();
    expect(leaderDesired(srcStory)).toBe(0);

    // Land library 2 `done` → NOW both blockers are landed → the node-arm sweep AUTO-LAUNCHES the
    // consume story's leader. This is cross-repo sequencing working end-to-end.
    storiesMod.updateStory(libStory2, { status: "done" });
    tasksMod.reevaluateAllBlocked();
    expect(leaderDesired(srcStory)).toBe(1);

    // ---- (e) CROSS-REPO REVIEW (Phase C1): the CEO reviews what landed across every repo -------
    // The consume story lands too; stamp each landed story with a merge sha + a merged subtask (the
    // drill-down handle) so the review has real "what landed" to roll up.
    storiesMod.updateStory(srcStory, { status: "done" });
    const shaByRepo: Record<string, string> = {};
    for (const [repo, storyId, sha, subLabel] of [
      [LIB1, libStory1, "shaLibCore", "core library scaffold"],
      [LIB2, libStory2, "shaLibUtil", "util library scaffold"],
      [SOURCE, srcStory, "shaSource", "remove inlined code; depend on libs"],
    ] as const) {
      dbMod.db.query(`UPDATE tasks SET merged_sha=? WHERE id=?`).run(sha, storyId);
      seedMergedSubtask(repo, storyId, subLabel, `${sha}-sub`);
      shaByRepo[repo] = sha;
    }

    const review = await get(`/api/projects/${PROJ}/initiatives/${iid}/review`);
    expect(review.status).toBe(200);
    expect(review.body.initiative_id).toBe(iid);
    expect(review.body.project_id).toBe(PROJ);
    expect(review.body.done).toBe(true); // every member-repo story landed
    expect(review.body.reviewed).toBe(false); // not yet signed off

    // One landed summary per repo, each with its story-level sha + its merged-subtask handles.
    const reviewByRepo = new Map<string, any>(
      review.body.stories.map((s: any) => [s.workspace_id, s]),
    );
    expect([...reviewByRepo.keys()].sort()).toEqual([LIB1, LIB2, SOURCE].sort());
    for (const repo of [LIB1, LIB2, SOURCE]) {
      const s = reviewByRepo.get(repo)!;
      expect(s.story_id).toBe(storyByRepo[repo]);
      expect(s.status).toBe("done");
      expect(s.merged_sha).toBe(shaByRepo[repo]);
      expect(s.merged_subtasks.length).toBeGreaterThanOrEqual(1);
      expect(s.merged_subtasks.map((m: any) => m.merged_sha)).toContain(`${shaByRepo[repo]}-sub`);
    }
  });
});
