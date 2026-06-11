// Tests for AUTO-REBASE on unblock / before dispatch (see git.isBehindDefault /
// git.rebaseOntoDefault and tasks.prepareBranchForDispatch, wired into the
// dispatcher right after createWorktree).
//
// The conflict gap this closes: a chained/blocked task's branch is cut from the
// default-branch HEAD at CREATE time — before its blockers merged — so even though
// it runs AFTER the blockers land, its edits would only collide at the final merge.
// The fix brings the branch up to the CURRENT default tip before the agent runs:
//   - never started (no commits)  -> hard-reset onto the tip (fresh start)
//   - has commits                 -> rebase onto the tip (clean -> proceed)
//   - rebase conflict             -> surfaced (note recorded), NOT silently dispatched
//   - uncommitted changes         -> skipped (never clobbered)
//
// Everything is REAL git: a throwaway repo, real worktrees/branches made by
// createTask, real commits. BUTCHR_HERDR_BIN points at `true` so herdr probes are
// harmless no-ops, as in the other test files. The db/config singletons are shared
// across test files, so we use a unique DIR_ID + REPO_ROOT to avoid collisions.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
const DIR_ID = "auto-rebase-dir";

let tasksMod: typeof import("../src/tasks.ts");
let gitMod: typeof import("../src/git.ts");
let dbMod: typeof import("../src/db.ts");
let taskmdMod: typeof import("../src/taskmd.ts");

/** Run git in a given working dir (default: the repo root / main worktree). */
function g(args: string[], cwd = REPO_ROOT): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

/** Add a file + commit it on the DEFAULT branch (the repo root worktree). */
function commitOnMain(file: string, content: string, msg: string): void {
  writeFileSync(join(REPO_ROOT, file), content);
  g(["add", "--", file]);
  g(["commit", "-q", "-m", msg]);
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-rebase-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-rebase-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  execFileSync("git", ["init", "-q", REPO_ROOT], { stdio: "ignore" });
  g(["config", "user.email", "test@butchr.local"]);
  g(["config", "user.name", "butchr test"]);
  // Keep .butchr (task.md store) out of the way of our explicit `git add`s.
  writeFileSync(join(REPO_ROOT, ".gitignore"), ".butchr/\n");
  writeFileSync(join(REPO_ROOT, "README.md"), "base\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "init"]);

  dbMod = await import("../src/db.ts");
  taskmdMod = await import("../src/taskmd.ts");
  gitMod = await import("../src/git.ts");
  tasksMod = await import("../src/tasks.ts");

  dbMod.db
    .query(
      `INSERT INTO directories (id, path, label, created_at) VALUES (?, ?, ?, ?)`,
    )
    .run(DIR_ID, REPO_ROOT, "test", dbMod.nowIso());
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

function dbRow(id: string) {
  return dbMod.db.query<any, [string]>(`SELECT * FROM tasks WHERE id=?`).get(id)!;
}
function setStatus(id: string, status: string) {
  dbMod.db.query(`UPDATE tasks SET status=? WHERE id=?`).run(status, id);
}
const headOf = (dir: string) => g(["rev-parse", "HEAD"], dir);
const wtOf = (id: string) => join(REPO_ROOT, id);

describe("auto-rebase: a blocked task promoted to in_progress ends up on the current tip", () => {
  test("a fresh blocked task created on a stale base is reset onto the tip at dispatch", async () => {
    // Blocker seeded as a plain DB row (no worktree needed to satisfy createTask).
    // In the new model, a LIVE agent task is `in_progress` with herdr_pane_id set.
    const blocker = "ar-blocker";
    dbMod.db
      .query(`INSERT INTO tasks (id, directory_id, status, herdr_pane_id, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(blocker, DIR_ID, "in_progress", "pane-blocker", dbMod.nowIso());

    // Dependent task: its worktree branches from the CURRENT (soon-to-be stale) tip.
    const dep = (await tasksMod.createTask(DIR_ID, "dependent work", [], [blocker])).id;
    expect(dbRow(dep).status).toBe("blocked");
    const staleBase = headOf(REPO_ROOT);
    expect(headOf(wtOf(dep))).toBe(staleBase);

    // The blocker "merges": the default branch advances past the dependent's base.
    commitOnMain("blocker-merged.txt", "from blocker\n", "blocker work");
    const newTip = headOf(REPO_ROOT);
    expect(newTip).not.toBe(staleBase);
    // The dependent is now genuinely behind its (stale) creation-time base.
    expect(await gitMod.isBehindDefault(REPO_ROOT, dep)).toBe(true);

    // Promote it (auto-unblock) — DB state flips to in_progress (READY), branch still stale...
    setStatus(blocker, "merged");
    expect(tasksMod.reevaluateBlockedTask(dep)).toBe(true);
    expect(dbRow(dep).status).toBe("in_progress"); // READY: no pane yet
    expect(headOf(wtOf(dep))).toBe(staleBase); // not moved yet

    // ...then the dispatch-time prep brings it onto the CURRENT tip (not the stale
    // creation-time base), so the agent works on top of the merged blocker.
    const prep = await tasksMod.prepareBranchForDispatch(dep);
    expect(prep).toEqual({ ok: true, rebased: true, conflict: false });
    expect(headOf(wtOf(dep))).toBe(newTip);
    expect(existsSync(join(wtOf(dep), "blocker-merged.txt"))).toBe(true);
    expect(await gitMod.isBehindDefault(REPO_ROOT, dep)).toBe(false);
  });
});

describe("auto-rebase: a behind-base branch WITH commits is rebased before dispatch", () => {
  test("a clean rebase replays the task's commit onto the new tip and proceeds", async () => {
    const id = (await tasksMod.createTask(DIR_ID, "feature work")).id;
    const wt = wtOf(id);

    // The agent commits a NON-conflicting file in its worktree.
    writeFileSync(join(wt, "feature.txt"), "feature\n");
    g(["add", "--", "feature.txt"], wt);
    g(["commit", "-q", "-m", "add feature"], wt);
    setStatus(id, "in_progress"); // it has run (LIVE agent-phase state)

    // Meanwhile the default branch advances on an UNRELATED file.
    commitOnMain("mainline.txt", "mainline\n", "mainline work");
    const newTip = headOf(REPO_ROOT);
    expect(await gitMod.isBehindDefault(REPO_ROOT, id)).toBe(true);

    const prep = await tasksMod.prepareBranchForDispatch(id);
    // Clean rebase -> proceed (ok, rebased, no conflict).
    expect(prep).toEqual({ ok: true, rebased: true, conflict: false });

    // The task's commit now sits ON TOP of the new tip: both files present, the new
    // tip is an ancestor, and there are no leftover conflict markers.
    expect(existsSync(join(wt, "feature.txt"))).toBe(true); // task's own work kept
    expect(existsSync(join(wt, "mainline.txt"))).toBe(true); // base integrated
    expect(await gitMod.isBehindDefault(REPO_ROOT, id)).toBe(false);
    expect(g(["status", "--porcelain"], wt)).toBe(""); // clean tree
    // No review_note recorded — a clean rebase is silent to the operator.
    expect(dbRow(id).review_note).toBeNull();
    // newTip is reachable from the rebased branch.
    expect(g(["merge-base", newTip, id])).toBe(newTip);
  });

  test("an already-up-to-date branch is a no-op (no lock, no move)", async () => {
    const id = (await tasksMod.createTask(DIR_ID, "uptodate work")).id;
    const before = headOf(wtOf(id));
    expect(await gitMod.isBehindDefault(REPO_ROOT, id)).toBe(false);
    const prep = await tasksMod.prepareBranchForDispatch(id);
    expect(prep).toEqual({ ok: true, rebased: false, conflict: false });
    expect(headOf(wtOf(id))).toBe(before);
  });
});

describe("auto-rebase: a conflicting rebase is surfaced, not silently dispatched", () => {
  test("a content conflict records a resolution note and leaves the branch CLEAN", async () => {
    const id = (await tasksMod.createTask(DIR_ID, "conflicting work")).id;
    const wt = wtOf(id);

    // The agent edits a SHARED file and commits.
    writeFileSync(join(wt, "README.md"), "agent change\n");
    g(["add", "--", "README.md"], wt);
    g(["commit", "-q", "-m", "agent edits README"], wt);
    const originalHead = headOf(wt); // the branch tip AFTER the agent's commit
    setStatus(id, "in_progress");

    // The default branch edits the SAME file differently -> rebase will conflict.
    commitOnMain("README.md", "main change\n", "main edits README");
    expect(await gitMod.isBehindDefault(REPO_ROOT, id)).toBe(true);

    const prep = await tasksMod.prepareBranchForDispatch(id);
    // Conflict surfaced (NOT silently dispatched on a stale base).
    expect(prep).toEqual({ ok: false, rebased: false, conflict: true });

    // The conflict is recorded for the (resumed) agent + the operator: review_note
    // names the file and the resolution steps; task.md carries the same note.
    const note = dbRow(id).review_note as string;
    expect(note).toContain("README.md");
    expect(note).toContain("Merge conflict");
    expect(note).toContain("request_review");
    // The gate REBASES, so the resolution guidance must stick under a rebase: it
    // tells the agent to rebase / reset --soft and explicitly warns AGAINST merging
    // (a merge commit is discarded by the rebase → the original commit replays and
    // re-conflicts in a loop). The only mention of `git merge` is the prohibition.
    expect(note).toContain("git rebase");
    expect(note).toContain("git reset --soft");
    expect(note).toContain("Do NOT use `git merge`");
    // It must not RECOMMEND a merge to resolve — the old note suggested
    // "(e.g. `git merge <base>` — or rebase …)" as the resolution step.
    expect(note).not.toContain("e.g. `git merge");
    expect(taskmdMod.readTaskMd(REPO_ROOT, id).reviewNotes).toContain("README.md");

    // The rebase was ABORTED: the branch is back on its ORIGINAL commit, the tree
    // is clean, and there are NO conflict markers left behind.
    expect(headOf(wt)).toBe(originalHead);
    expect(g(["status", "--porcelain"], wt)).toBe("");
    expect(readFileSync(join(wt, "README.md"), "utf8")).toBe("agent change\n");
    expect(readFileSync(join(wt, "README.md"), "utf8")).not.toContain("<<<<<<<");
  });

  test("git.rebaseOntoDefault reports the conflicting files directly", async () => {
    const id = (await tasksMod.createTask(DIR_ID, "raw conflict")).id;
    const wt = wtOf(id);
    writeFileSync(join(wt, "README.md"), "branch side\n");
    g(["add", "--", "README.md"], wt);
    g(["commit", "-q", "-m", "branch README"], wt);

    commitOnMain("README.md", "trunk side\n", "trunk README");

    const res = await gitMod.rebaseOntoDefault(REPO_ROOT, id);
    expect(res.ok).toBe(false);
    expect(res.conflict).toBe(true);
    expect(res.rebased).toBe(false);
    expect(res.conflictFiles).toContain("README.md");
    // Aborted cleanly.
    expect(g(["status", "--porcelain"], wt)).toBe("");
  });
});

describe("auto-rebase: safety — never clobber uncommitted worktree changes", () => {
  test("a dirty worktree is skipped (left untouched) even when behind the tip", async () => {
    const id = (await tasksMod.createTask(DIR_ID, "dirty work")).id;
    const wt = wtOf(id);
    const before = headOf(wt);

    // Uncommitted edit the agent hasn't committed yet.
    writeFileSync(join(wt, "wip.txt"), "work in progress\n");

    // Default branch advances -> the branch is behind, but we must NOT clobber WIP.
    commitOnMain("trunk.txt", "trunk\n", "trunk advance");
    expect(await gitMod.isBehindDefault(REPO_ROOT, id)).toBe(true);

    const res = await gitMod.rebaseOntoDefault(REPO_ROOT, id);
    expect(res.skippedDirty).toBe(true);
    expect(res.ok).toBe(true);
    expect(res.rebased).toBe(false);
    // Branch base unchanged and the uncommitted file is still there, intact.
    expect(headOf(wt)).toBe(before);
    expect(readFileSync(join(wt, "wip.txt"), "utf8")).toBe("work in progress\n");
  });
});
