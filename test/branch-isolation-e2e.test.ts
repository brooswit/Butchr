// END-TO-END proof of Phase F-ACTIVATE of the 3-level branch-isolation merge model
// (CONTRIBUTING §11.8 / §11.9 step 5). Unlike the D/E unit tests — which insert workspace +
// story rows directly — this drives the WHOLE flow through the real PUBLIC entry points:
//
//   - the OPERATOR SWITCH (workspaces.setWorkspaceBranchIsolation) flips branch_isolation ON;
//   - createStory captures isolated=1 from the live flag (the §11.8 bootstrapping cut);
//   - createSubtask (the story leader's decompose surface) branches each subtask OFF the
//     lazily-created story branch, runs BOTH gates (subtask CI via triggerCi + the post-merge
//     verify in the STORY worktree via finalizeMerge), and merges into the story branch — main
//     untouched throughout;
//   - request-completion (updateStory `done`) routes to `merging`, then landStory re-gates the
//     assembled story (GREEN), merges story→main, runs the post-merge verify in `dir`, removes
//     the story branch/worktree, and lands `done` with story-level shas + the leader torn down;
//   - a RED story-level re-gate is a HARD BLOCK → `merge_blocked`, main UNTOUCHED, a gate-red
//     event to the leader;
//   - STRICT flag-OFF parity: a workspace WITHOUT the flag — both a standalone task and a
//     non-isolated story's PATCH-`done` — behaves BYTE-FOR-BYTE as today (straight to main, no
//     story-branch machinery).
//
// All REAL git (throwaway repos + real `git worktree`); only the CI + verify RUNNERS are
// mocked (tasks.setCiRunner / verify.setVerifyRunner) so the green/red decisions are
// deterministic, and herdr is stubbed (BUTCHR_HERDR_BIN=true) so createStory's leader launch
// is a harmless no-op. The db/config singletons read BUTCHR_* env at import, so we set them
// first, and use unique workspace/story ids since those singletons are shared across files.
//
// NOTE: branch_isolation is proven here ONLY on throwaway TEST workspaces; enabling it on any
// live workspace is a separate operator action (it is NOT enabled on dir-8b35f904 by this work).
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ISO: string; // workspace with branch_isolation turned ON via the switch
let REPO_STD: string; // workspace with branch_isolation OFF (default)
let DEFAULT_ISO: string;
let DEFAULT_STD: string;

// Unique ids — the db/config singletons are shared across test files.
const WS_ISO = "e2e-iso-ws";
const WS_STD = "e2e-std-ws";

let tasksMod: typeof import("../src/tasks.ts");
let storiesMod: typeof import("../src/stories.ts");
let workspacesMod: typeof import("../src/workspaces.ts");
let dbMod: typeof import("../src/db.ts");
let taskmdMod: typeof import("../src/taskmd.ts");
let verifyMod: typeof import("../src/verify.ts");
let gitMod: typeof import("../src/git.ts");
let eventsMod: typeof import("../src/events.ts");

/** Run git in a working dir (default: the isolated repo's main worktree). */
function g(args: string[], cwd = REPO_ISO): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function initRepo(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init", "-q", repo], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "user.email", "test@butchr.local"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "butchr test"]);
  writeFileSync(join(repo, ".gitignore"), ".butchr/\n");
  writeFileSync(join(repo, "README.md"), "base\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "init"]);
  return repo;
}

function storyRow(id: string) {
  // B.5b (st-78a8b4e7): the `stories` mirror is dropped — the story record IS its Work NODE row.
  return dbMod.db.query<any, [string]>(`SELECT * FROM tasks WHERE id=? AND work_kind='node'`).get(id)!;
}
function taskRow(id: string) {
  return dbMod.db.query<any, [string]>(`SELECT * FROM tasks WHERE id=?`).get(id)!;
}

/** Poll until `pred()` holds (the fire-and-forget landStory from updateStory has settled), or
 *  throw after `timeoutMs`. Deterministic await of butchr's own background land path. */
async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Capture every story.attention event published during `fn`. */
async function captureStoryEvents(fn: () => Promise<void>): Promise<any[]> {
  const seen: any[] = [];
  const unsub = eventsMod.subscribe((e) => {
    if ((e as any).type === "story.attention") seen.push(e);
  });
  try {
    await fn();
  } finally {
    unsub();
  }
  return seen;
}

/**
 * Drive a full subtask through BOTH gates onto the story branch: createSubtask → "agent"
 * commits `file` in its worktree → SUBTASK CI gate (triggerCi, GREEN) → finalizeMerge (the
 * post-merge verify runs in the STORY worktree, GREEN). Asserts ci_status='pass' and a
 * `merged` outcome. Returns the merged subtask id.
 */
async function landSubtask(
  repo: string,
  storyId: string,
  file: string,
  content: string,
): Promise<string> {
  const view = await storiesMod.createSubtask(storyId, { prompt: `Add ${file}` });
  const id = view.id;
  expect(view.story_id).toBe(storyId);

  const wt = join(repo, id);
  expect(existsSync(wt)).toBe(true);
  writeFileSync(join(wt, file), content);
  execFileSync("git", ["-C", wt, "add", "-A"]);
  execFileSync("git", ["-C", wt, "commit", "-q", "-m", `add ${file}`]);

  // Enter review (CI settles only on an in_review task — same as the real review entry).
  dbMod.db.query(`UPDATE tasks SET status='in_review' WHERE id=?`).run(id);
  taskmdMod.updateTaskMdStatus(repo, id, "in_review");

  // BOTH-gate (1/2): the SUBTASK CI gate runs in the subtask worktree.
  tasksMod.setCiRunner(async () => ({ status: "pass", label: "build + tests", detail: "" }));
  await tasksMod.triggerCi(id);
  expect(taskRow(id).ci_status).toBe("pass");

  // BOTH-gate (2/2): finalizeMerge ffs into the STORY worktree + runs the post-merge verify there.
  verifyMod.setVerifyRunner(async () => ({ ok: true, output: "" }));
  const out = await tasksMod.finalizeMerge(id);
  expect(out.task.status).toBe("merged");
  return id;
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-e2e-data-"));
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  REPO_ISO = initRepo("butchr-e2e-iso-repo-");
  REPO_STD = initRepo("butchr-e2e-std-repo-");

  dbMod = await import("../src/db.ts");
  taskmdMod = await import("../src/taskmd.ts");
  tasksMod = await import("../src/tasks.ts");
  storiesMod = await import("../src/stories.ts");
  workspacesMod = await import("../src/workspaces.ts");
  verifyMod = await import("../src/verify.ts");
  gitMod = await import("../src/git.ts");
  eventsMod = await import("../src/events.ts");

  DEFAULT_ISO = await gitMod.defaultBranch(REPO_ISO);
  DEFAULT_STD = await gitMod.defaultBranch(REPO_STD);

  // Register BOTH workspaces with the flag OFF (the default) — the ISO workspace gets it
  // turned ON below via the operator switch itself, so the switch is part of the e2e.
  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(WS_ISO, REPO_ISO, "iso", dbMod.nowIso());
  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(WS_STD, REPO_STD, "std", dbMod.nowIso());
});

afterEach(() => {
  verifyMod.setVerifyRunner(); // restore the real verify runner between tests
  // (the CI runner is re-injected GREEN by landSubtask on every use; no per-test reset needed.)
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ISO, { recursive: true, force: true });
  rmSync(REPO_STD, { recursive: true, force: true });
});

describe("F-ACTIVATE — the operator switch turns branch_isolation ON", () => {
  test("setWorkspaceBranchIsolation flips the flag; OFF→ON→OFF round-trips, bad input 400s", () => {
    // Default OFF.
    expect(workspacesMod.workspaceBranchIsolation(WS_ISO)).toBe(false);
    // The switch turns it ON.
    const on = workspacesMod.setWorkspaceBranchIsolation(WS_ISO, true);
    expect(on.branch_isolation).toBe(1);
    expect(workspacesMod.workspaceBranchIsolation(WS_ISO)).toBe(true);
    // null = OFF, and round-trips back.
    expect(workspacesMod.setWorkspaceBranchIsolation(WS_ISO, null).branch_isolation).toBe(0);
    expect(workspacesMod.setWorkspaceBranchIsolation(WS_ISO, true).branch_isolation).toBe(1);
    // Non-boolean is a 400; an unknown workspace is a 404.
    expect(() => workspacesMod.setWorkspaceBranchIsolation(WS_ISO, "yes")).toThrow(/must be a boolean/);
    expect(() => workspacesMod.setWorkspaceBranchIsolation("nope", true)).toThrow(/workspace not found/);
    // Leave it ON for the flow tests below.
    workspacesMod.setWorkspaceBranchIsolation(WS_ISO, true);
  });
});

describe("F-ACTIVATE — full isolated-story flow, opened AFTER the flag is ON", () => {
  test("open → subtasks (both gates) → request completion → re-gate GREEN → story→main → done", async () => {
    // The flag is ON ⇒ createStory captures isolated=1 (the §11.8 bootstrapping cut).
    const story = storiesMod.createStory(WS_ISO, "Build the isolated widget");
    const SID = story.id;
    expect(story.isolated).toBe(1);
    const storyBranch = gitMod.storyBranchName(SID);
    const storyWt = gitMod.storyWorktreePath(REPO_ISO, SID);

    // Lazy: no story branch/worktree exists until the first subtask is branched off it.
    expect(existsSync(storyWt)).toBe(false);
    expect(await gitMod.branchExists(REPO_ISO, storyBranch)).toBe(false);

    const mainBefore = g(["rev-parse", DEFAULT_ISO]);

    // First subtask lazily cuts the story branch off the current main tip + makes the worktree.
    const a = await landSubtask(REPO_ISO, SID, "alpha.txt", "alpha\n");
    expect(existsSync(storyWt)).toBe(true);
    expect(await gitMod.branchExists(REPO_ISO, storyBranch)).toBe(true);
    // The subtask landed on the STORY branch — present in the story worktree, NOT on main.
    expect(existsSync(join(storyWt, "alpha.txt"))).toBe(true);
    expect(existsSync(join(REPO_ISO, "alpha.txt"))).toBe(false);
    expect(g(["rev-parse", DEFAULT_ISO])).toBe(mainBefore); // main never moved
    // Its merge shas are STORY-branch shas (not main).
    expect(taskRow(a).merge_base_sha).toBe(mainBefore); // story branch was cut at main's tip
    expect(taskRow(a).merged_sha).toBe(g(["rev-parse", "HEAD"], storyWt));

    // Second subtask branches off the ADVANCED story branch and also merges into it.
    await landSubtask(REPO_ISO, SID, "beta.txt", "beta\n");
    expect(existsSync(join(storyWt, "beta.txt"))).toBe(true);
    expect(existsSync(join(REPO_ISO, "beta.txt"))).toBe(false);
    expect(g(["rev-parse", DEFAULT_ISO])).toBe(mainBefore); // STILL untouched

    // REQUEST COMPLETION via the real entry point: an isolated story's PATCH-`done` is a
    // request to LAND → it returns `merging` (never an immediate `done`) and kicks the
    // fire-and-forget land in the background. We subscribe FIRST, then await that SAME
    // background land settling (no second landStory call — that would race + re-drive it):
    // story-level re-gate GREEN → story→main ff → post-merge verify in `dir` GREEN → cleanup.
    verifyMod.setVerifyRunner(async () => ({ ok: true, output: "" }));
    const events: any[] = [];
    const unsub = eventsMod.subscribe((e) => {
      if ((e as any).type === "story.attention") events.push(e);
    });
    const merging = storiesMod.updateStory(SID, { status: "done" });
    expect(merging.status).toBe("merging");
    await waitFor(() => storyRow(SID).status === "done");
    unsub();

    const row = storyRow(SID);
    expect(row.status).toBe("done"); // ONLY a landed-and-green story reaches done
    // The whole story is now on MAIN.
    const mainAfter = g(["rev-parse", DEFAULT_ISO]);
    expect(mainAfter).not.toBe(mainBefore);
    expect(existsSync(join(REPO_ISO, "alpha.txt"))).toBe(true);
    expect(existsSync(join(REPO_ISO, "beta.txt"))).toBe(true);
    // Story-level merge range = main tips before/after the ff (§11.6).
    expect(row.merge_base_sha).toBe(mainBefore);
    expect(row.merged_sha).toBe(mainAfter);
    // The story branch + worktree were removed (removeStoryBranch).
    expect(existsSync(storyWt)).toBe(false);
    expect(await gitMod.branchExists(REPO_ISO, storyBranch)).toBe(false);
    // `complete` reported UP to the CTO, and the leader is torn down (only a landed story does so).
    const complete = events.find((e) => e.reason === "complete");
    expect(complete).toBeTruthy();
    expect(complete.target).toBe("cto");
    expect(["open", "merging", "merge_blocked"].includes(row.status)).toBe(false);
  });

  test("RED story-level re-gate is a HARD BLOCK → merge_blocked, main UNTOUCHED, gate-red to the leader", async () => {
    const story = storiesMod.createStory(WS_ISO, "Story that fails its re-gate");
    const SID = story.id;
    expect(story.isolated).toBe(1);
    const storyBranch = gitMod.storyBranchName(SID);
    const storyWt = gitMod.storyWorktreePath(REPO_ISO, SID);

    await landSubtask(REPO_ISO, SID, "gamma.txt", "gamma\n");
    const mainBefore = g(["rev-parse", DEFAULT_ISO]);

    // The story-level re-gate comes back RED → the merge must NOT run.
    verifyMod.setVerifyRunner(async () => ({ ok: false, output: "story re-gate boom" }));
    const events = await captureStoryEvents(async () => {
      await storiesMod.landStory(SID);
    });

    const row = storyRow(SID);
    expect(row.status).toBe("merge_blocked");
    expect(row.merge_base_sha).toBeNull();
    expect(row.merged_sha).toBeNull();
    // Main NEVER moved and never saw the story; the story branch + worktree survive.
    expect(g(["rev-parse", DEFAULT_ISO])).toBe(mainBefore);
    expect(existsSync(join(REPO_ISO, "gamma.txt"))).toBe(false);
    expect(existsSync(storyWt)).toBe(true);
    expect(await gitMod.branchExists(REPO_ISO, storyBranch)).toBe(true);
    // A gate-red event went to the LEADER (target:story), which is KEPT UP to fix it.
    const red = events.find((e) => e.reason === "gate-red");
    expect(red).toBeTruthy();
    expect(red.target).toBe("story");
    expect(red.detail).toContain("boom");
    expect(["open", "merging", "merge_blocked"].includes(row.status)).toBe(true);
  });
});

describe("F-ACTIVATE — flag OFF is byte-for-byte today's behavior (STRICT parity)", () => {
  test("a standalone task in a flag-OFF workspace merges straight to main, no story machinery", async () => {
    expect(workspacesMod.workspaceBranchIsolation(WS_STD)).toBe(false);

    const view = await tasksMod.createTask(
      WS_STD, "Add standalone.txt", [], [], "task", null, [], 0, false, false, "patch", [], null,
    );
    const id = view.id;
    const row = tasksMod.getTask(id)!;
    // Standalone resolves to the default branch + the single-level merge context — exactly today.
    expect(await tasksMod.resolveBase(row)).toBe(DEFAULT_STD);
    expect(await tasksMod.resolveMergeContext(row)).toEqual({
      ffWorktree: REPO_STD,
      targetBranch: DEFAULT_STD,
      base: DEFAULT_STD,
    });

    const wt = join(REPO_STD, id);
    writeFileSync(join(wt, "standalone.txt"), "s\n");
    execFileSync("git", ["-C", wt, "add", "-A"]);
    execFileSync("git", ["-C", wt, "commit", "-q", "-m", "add standalone.txt"]);
    dbMod.db.query(`UPDATE tasks SET status='in_review' WHERE id=?`).run(id);
    taskmdMod.updateTaskMdStatus(REPO_STD, id, "in_review");

    const mainBefore = g(["rev-parse", "HEAD"], REPO_STD);
    verifyMod.setVerifyRunner(async () => ({ ok: true, output: "" }));
    const out = await tasksMod.finalizeMerge(id);
    expect(out.task.status).toBe("merged");

    // Fast-forwarded into MAIN at the repo root; shas bracket the main tip.
    const mainAfter = g(["rev-parse", "HEAD"], REPO_STD);
    expect(mainAfter).not.toBe(mainBefore);
    expect(existsSync(join(REPO_STD, "standalone.txt"))).toBe(true);
    expect(taskRow(id).merge_base_sha).toBe(mainBefore);
    expect(taskRow(id).merged_sha).toBe(mainAfter);
    // NO story-branch machinery is ever created in a flag-OFF workspace (no butchr-story-* worktree).
    const worktrees = await gitMod.listWorktrees(REPO_STD);
    expect(worktrees.some((w) => w.includes("butchr-story-"))).toBe(false);
  });

  test("a non-isolated story's PATCH-`done` lands `done` IMMEDIATELY, with no story branch/worktree", async () => {
    // The flag is OFF ⇒ createStory captures isolated=0.
    const story = storiesMod.createStory(WS_STD, "Non-isolated grouping");
    const SID = story.id;
    expect(story.isolated).toBe(0);

    const events = await captureStoryEvents(async () => {
      const row = storiesMod.updateStory(SID, { status: "done" });
      expect(row.status).toBe("done"); // immediate + synchronous — NOT `merging`
    });

    expect(storyRow(SID).status).toBe("done");
    // No story-branch machinery for a non-isolated story.
    expect(existsSync(gitMod.storyWorktreePath(REPO_STD, SID))).toBe(false);
    expect(await gitMod.branchExists(REPO_STD, gitMod.storyBranchName(SID))).toBe(false);
    // The classic `complete` report still fires to the CTO on entry into done.
    const complete = events.find((e) => e.reason === "complete");
    expect(complete).toBeTruthy();
    expect(complete.target).toBe("cto");
  });
});
