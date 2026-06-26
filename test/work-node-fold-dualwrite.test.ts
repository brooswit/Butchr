// REVAMP Phase B.3 — DUAL-WRITE lock-step invariant (story st-6372812d).
//
// B.3 starts writing a story NODE's REAL state onto its OWN `tasks` row (replacing the frozen
// `merged` anchor on node rows), kept lock-step with the still-authoritative `stories` table. The
// `stories` table stays the SOURCE OF TRUTH for reads this phase (storyStatusOf / getStoryRow are
// UNCHANGED) — so behavior is preserved; this only makes the node row a faithful shadow ready for
// the B.4 read-flip. These tests assert, after EVERY story transition driven through the real
// service functions, that the node `tasks` row == the `stories` row on the dual-written columns:
//
//   create / updateStory(done) / updateStory(aborted) / brief-only PATCH /
//   openStoryAsk / escalateStoryAsk / answerStoryAsk / landStory(→done) / landStory(→merge_blocked)
//
// Plus: (i) READS are still from `stories` (corrupt the node row → storyStatusOf/getStoryRow are
// unmoved); (ii) the (A) blockerState fix — a story NODE used as a leaf's blocker resolves via the
// AUTHORITATIVE story status (open ⇒ pending, done ⇒ satisfied, aborted ⇒ dead), no longer the old
// always-satisfied `merged` anchor; (iii) the (B) abortTask node guard refuses a node id.
//
// The non-git block uses a plain workspace row (createStory/updateStory/asks need no worktree). The
// landStory block uses a REAL throwaway git repo + verify.setVerifyRunner to make the green/red
// decision deterministic (mirrors story-merge.test.ts — the operator's "stub the runner" path). The
// db/config singletons read BUTCHR_* env at import, so we set them first and use unique ids.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ISO: string;
let DEFAULT_ISO: string;
const WS_STD = "b3dw-std-ws"; // non-isolated, no real git (CRUD/ask transitions)
const WS_ISO = "b3dw-iso-ws"; // branch_isolation ON, real git (landStory)

let dbMod: typeof import("../src/db.ts");
let taskmdMod: typeof import("../src/taskmd.ts");
let tasksMod: typeof import("../src/tasks.ts");
let storiesMod: typeof import("../src/stories.ts");
let verifyMod: typeof import("../src/verify.ts");
let gitMod: typeof import("../src/git.ts");

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

const storyRow = (id: string) =>
  dbMod.db.query<any, [string]>(`SELECT * FROM stories WHERE id=?`).get(id);
const nodeRow = (id: string) =>
  dbMod.db.query<any, [string]>(`SELECT * FROM tasks WHERE id=? AND work_kind='node'`).get(id);
const taskRow = (id: string) =>
  dbMod.db.query<any, [string]>(`SELECT * FROM tasks WHERE id=?`).get(id);

// The columns the node row dual-writes from the stories row (status superset + the node-only
// fields + the merge-range shas). After ANY transition the two rows must agree on all of them.
const MIRRORED = [
  "status",
  "brief",
  "isolated",
  "pending_ask",
  "ask_responder",
  "merge_base_sha",
  "merged_sha",
] as const;

/** The B.3 invariant: the node's `tasks` row is a byte-for-byte shadow of the `stories` row. */
function assertLockStep(id: string): void {
  const s = storyRow(id);
  const n = nodeRow(id);
  expect(s).toBeTruthy();
  expect(n).toBeTruthy(); // the node row exists (eager-materialized / ensured on dual-write)
  for (const c of MIRRORED) expect(n[c]).toEqual(s[c]);
}

/** Reads are STILL from `stories`: corrupt the node row's status, prove the read accessors are
 *  unmoved, then restore lock-step. Proves B.3 is behavior-preserving (no read flipped to tasks). */
function assertReadsFromStories(id: string): void {
  const real = storyRow(id).status;
  dbMod.db.query(`UPDATE tasks SET status='__corrupt__' WHERE id=? AND work_kind='node'`).run(id);
  expect(dbMod.storyStatusOf(id)).toBe(real); // storyStatusOf reads stories, not the node row
  expect(dbMod.getStoryRow(id)!.status).toBe(real); // getStoryRow too
  dbMod.db.query(`UPDATE tasks SET status=? WHERE id=? AND work_kind='node'`).run(real, id); // restore
  assertLockStep(id);
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-b3dw-data-"));
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  REPO_ISO = initRepo("butchr-b3dw-iso-repo-");

  dbMod = await import("../src/db.ts");
  taskmdMod = await import("../src/taskmd.ts");
  tasksMod = await import("../src/tasks.ts");
  storiesMod = await import("../src/stories.ts");
  verifyMod = await import("../src/verify.ts");
  gitMod = await import("../src/git.ts");

  DEFAULT_ISO = await gitMod.defaultBranch(REPO_ISO);

  // Non-isolated workspace — no real git needed for CRUD/ask transitions.
  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(WS_STD, join(DATA_DIR, "std-repo"), "std", dbMod.nowIso());
  // Isolated workspace (branch_isolation ON) on a real repo — for the landStory merge path.
  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, branch_isolation, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(WS_ISO, REPO_ISO, "iso", 1, dbMod.nowIso());
});

afterEach(() => {
  verifyMod.setVerifyRunner(); // restore the real verify runner between tests
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ISO, { recursive: true, force: true });
});

describe("B.3 dual-write lock-step — CRUD + ask transitions (no git)", () => {
  test("createStory eagerly materializes the node, lock-step at status 'open'", () => {
    const st = storiesMod.createStory(WS_STD, "ship the widget");
    const n = nodeRow(st.id);
    expect(n).toBeTruthy(); // eager materialization (not lazy at first member)
    expect(n.status).toBe("open");
    expect(n.work_kind).toBe("node");
    expect(n.brief).toBe("ship the widget");
    assertLockStep(st.id);
    assertReadsFromStories(st.id);
  });

  test("updateStory open→done dual-writes status onto the node", () => {
    const st = storiesMod.createStory(WS_STD, "done story");
    storiesMod.updateStory(st.id, { status: "done" });
    expect(storyRow(st.id).status).toBe("done");
    expect(nodeRow(st.id).status).toBe("done");
    assertLockStep(st.id);
    assertReadsFromStories(st.id);
  });

  test("updateStory open→aborted dual-writes status onto the node", () => {
    const st = storiesMod.createStory(WS_STD, "aborted story");
    storiesMod.updateStory(st.id, { status: "aborted" });
    expect(nodeRow(st.id).status).toBe("aborted");
    assertLockStep(st.id);
  });

  test("brief-only PATCH mirrors brief onto the node (status untouched)", () => {
    const st = storiesMod.createStory(WS_STD, "old brief");
    storiesMod.updateStory(st.id, { brief: "new brief" });
    expect(nodeRow(st.id).brief).toBe("new brief");
    expect(nodeRow(st.id).status).toBe("open");
    assertLockStep(st.id);
  });

  test("openStoryAsk / escalateStoryAsk / answerStoryAsk mirror the ask seam", () => {
    const st = storiesMod.createStory(WS_STD, "ask story");
    storiesMod.openStoryAsk(st.id, "which approach?");
    expect(nodeRow(st.id).pending_ask).toBe("which approach?");
    expect(nodeRow(st.id).ask_responder).toBe("cto");
    assertLockStep(st.id);

    storiesMod.escalateStoryAsk(st.id);
    expect(nodeRow(st.id).ask_responder).toBe("user");
    assertLockStep(st.id);

    storiesMod.answerStoryAsk(st.id, "approach A");
    expect(nodeRow(st.id).pending_ask).toBeNull();
    expect(nodeRow(st.id).ask_responder).toBeNull();
    assertLockStep(st.id);
  });

  test("a terminal transition clears the open ask on BOTH rows in one write", () => {
    const st = storiesMod.createStory(WS_STD, "ask then done");
    storiesMod.openStoryAsk(st.id, "blocking question");
    storiesMod.updateStory(st.id, { status: "done" });
    const n = nodeRow(st.id);
    expect(n.status).toBe("done");
    expect(n.pending_ask).toBeNull(); // the terminal-clear rode the SAME dual-write
    expect(n.ask_responder).toBeNull();
    assertLockStep(st.id);
  });
});

describe("B.3 (A) — a story NODE used as a leaf's blocker resolves via story terminality", () => {
  // Insert a `blocked` leaf depending on a node directly (block command / setBlockedBy do NOT
  // validate blocker-leaf-ness, so a node id CAN reach blocked_by), then re-evaluate.
  function blockedLeaf(id: string, nodeId: string): void {
    dbMod.db
      .query(
        `INSERT INTO tasks (id, workspace_id, status, created_at, blocked_by, work_kind)
         VALUES (?, ?, 'blocked', ?, ?, 'leaf')`,
      )
      .run(id, WS_STD, dbMod.nowIso(), JSON.stringify([nodeId]));
  }

  test("OPEN node blocker ⇒ pending (leaf STAYS blocked) — fixes the always-satisfied bug", () => {
    const st = storiesMod.createStory(WS_STD, "open blocker");
    blockedLeaf("b3dw-leaf-open", st.id);
    tasksMod.reevaluateAllBlocked();
    // Pre-B.3 the frozen-'merged' node read as satisfied → the leaf would wrongly unblock.
    expect(taskRow("b3dw-leaf-open").status).toBe("blocked");
  });

  test("DONE node blocker ⇒ satisfied (leaf unblocks → inactive)", () => {
    const st = storiesMod.createStory(WS_STD, "done blocker");
    storiesMod.updateStory(st.id, { status: "done" });
    blockedLeaf("b3dw-leaf-done", st.id);
    tasksMod.reevaluateAllBlocked();
    expect(taskRow("b3dw-leaf-done").status).toBe("inactive"); // all blockers merged/satisfied
  });

  test("ABORTED node blocker ⇒ dead (leaf stays blocked, surfaced as a dead blocker)", () => {
    const st = storiesMod.createStory(WS_STD, "aborted blocker");
    storiesMod.updateStory(st.id, { status: "aborted" });
    blockedLeaf("b3dw-leaf-aborted", st.id);
    tasksMod.reevaluateAllBlocked();
    expect(taskRow("b3dw-leaf-aborted").status).toBe("blocked");
    expect(tasksMod.taskView("b3dw-leaf-aborted")!.deadBlockers).toContain(st.id);
  });
});

describe("B.3 (B) — abortTask refuses a story NODE id (defensive guard)", () => {
  test("abortTask on a node id throws 409 and never tears the story down", async () => {
    const st = storiesMod.createStory(WS_STD, "do not abort me as a task");
    expect(nodeRow(st.id).status).toBe("open"); // a live-looking status post-B.3
    await expect(tasksMod.abortTask(st.id)).rejects.toThrow(/node work item/);
    expect(storyRow(st.id).status).toBe("open"); // untouched
    expect(nodeRow(st.id).status).toBe("open");
  });
});

describe("B.3 dual-write lock-step — landStory merge path (real git, isolated)", () => {
  // Create a REAL subtask of an isolated story, commit a file in its worktree, and land it onto the
  // story branch via finalizeMerge with a GREEN verify — so the story branch exists to land.
  async function seedMerged(storyId: string, file: string): Promise<void> {
    const view = await tasksMod.createTask(
      WS_ISO, `Add ${file}`, [], [], "task", null, [], 0, false, false, "patch", [], storyId,
    );
    const id = view.id;
    const wt = join(REPO_ISO, id);
    writeFileSync(join(wt, file), `${file}\n`);
    execFileSync("git", ["-C", wt, "add", "-A"]);
    execFileSync("git", ["-C", wt, "commit", "-q", "-m", `add ${file}`]);
    dbMod.db.query(`UPDATE tasks SET status='in_review' WHERE id=?`).run(id);
    taskmdMod.updateTaskMdStatus(REPO_ISO, id, "in_review");
    verifyMod.setVerifyRunner(async () => ({ ok: true, output: "" }));
    const out = await tasksMod.finalizeMerge(id);
    expect(out.task.status).toBe("merged");
  }

  test("landStory GREEN: merging→done lock-step, merge shas mirrored onto the node", async () => {
    const st = storiesMod.createStory(WS_ISO, "green land");
    expect(st.isolated).toBe(1);
    await seedMerged(st.id, "green.txt");

    verifyMod.setVerifyRunner(async () => ({ ok: true, output: "" }));
    await storiesMod.landStory(st.id);

    const s = storyRow(st.id);
    expect(s.status).toBe("done");
    expect(s.merged_sha).toBe(g(["rev-parse", DEFAULT_ISO]));
    const n = nodeRow(st.id);
    expect(n.status).toBe("done"); // node off the frozen 'merged' anchor, carrying the real status
    expect(n.merged_sha).toBe(s.merged_sha);
    expect(n.merge_base_sha).toBe(s.merge_base_sha);
    assertLockStep(st.id);
    expect(existsSync(join(REPO_ISO, "green.txt"))).toBe(true); // it really landed on main
  });

  test("landStory RED re-gate: merging→merge_blocked lock-step", async () => {
    const st = storiesMod.createStory(WS_ISO, "red land");
    await seedMerged(st.id, "red.txt");

    verifyMod.setVerifyRunner(async () => ({ ok: false, output: "gate boom" }));
    await storiesMod.landStory(st.id);

    expect(storyRow(st.id).status).toBe("merge_blocked");
    expect(nodeRow(st.id).status).toBe("merge_blocked"); // the transient state shadowed too
    assertLockStep(st.id);
  });
});
