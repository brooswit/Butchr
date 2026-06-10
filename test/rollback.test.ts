// Tests for butchr's ONE-CLICK ROLLBACK path (tasks.rollbackTask + git.revertCommits).
//
// The DECISION branches (not found / not merged / already rolled back / no merge
// range recorded / empty range) are pure DB logic and reach no git. The SUCCESS
// path drives a REAL throwaway git repo (REPO_ROOT is `git init`-ed below) so the
// revert is exercised end-to-end: a recorded merge range is reverted off the
// default branch and the task is stamped `rolled_back_at` while STAYING merged.
//
// As in the sibling tests, env is set before a dynamic import so config/db read
// our temp paths, and BUTCHR_HERDR_BIN points at `true` (rollback touches no herdr,
// but this keeps any incidental probe a harmless no-op). A distinct directory id
// keeps this file's rows from colliding with another file's in the shared db.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
const DIR_ID = "rollback-dir";

let tasksMod: typeof import("../src/tasks.ts");
let dbMod: typeof import("../src/db.ts");

/** Run a git command in REPO_ROOT, returning trimmed stdout (throws on failure). */
function git(...args: string[]): string {
  const res = Bun.spawnSync(["git", "-C", REPO_ROOT, ...args]);
  if (res.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${res.stderr.toString() || res.stdout.toString()}`,
    );
  }
  return res.stdout.toString().trim();
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-rollback-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-rollback-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  // Real repo so the success path's `git revert` runs for real.
  git("init", "-q");
  git("config", "user.email", "test@butchr.local");
  git("config", "user.name", "butchr test");

  dbMod = await import("../src/db.ts");
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

/** Seed a task row directly (rollback reads only the DB row, not task.md). */
function seedTask(opts: {
  id: string;
  status: string;
  mergeBaseSha?: string | null;
  mergedSha?: string | null;
  rolledBackAt?: string | null;
}): string {
  dbMod.db
    .query(
      `INSERT INTO tasks (id, directory_id, status, merge_base_sha, merged_sha, rolled_back_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.id,
      DIR_ID,
      opts.status,
      opts.mergeBaseSha ?? null,
      opts.mergedSha ?? null,
      opts.rolledBackAt ?? null,
      dbMod.nowIso(),
    );
  return opts.id;
}

function dbRow(id: string) {
  return dbMod.db.query<any, [string]>(`SELECT * FROM tasks WHERE id=?`).get(id)!;
}

async function expectStatus(fn: () => Promise<unknown>, status: number) {
  let err: any;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeDefined();
  expect(err.status).toBe(status);
  return err;
}

describe("rollbackTask — decision branches (no git)", () => {
  test("404 on a nonexistent task", async () => {
    await expectStatus(() => tasksMod.rollbackTask("no-such-task"), 404);
  });

  test("409 when the task is not merged", async () => {
    for (const status of ["queued", "running", "review", "aborted", "failed"]) {
      const id = seedTask({
        id: `rb-notmerged-${status}`,
        status,
        mergeBaseSha: "aaaa",
        mergedSha: "bbbb",
      });
      await expectStatus(() => tasksMod.rollbackTask(id), 409);
      // Untouched.
      expect(dbRow(id).rolled_back_at).toBeNull();
    }
  });

  test("409 when the task was already rolled back", async () => {
    const id = seedTask({
      id: "rb-already",
      status: "merged",
      mergeBaseSha: "aaaa",
      mergedSha: "bbbb",
      rolledBackAt: dbMod.nowIso(),
    });
    await expectStatus(() => tasksMod.rollbackTask(id), 409);
  });

  test("409 when no merge range was recorded (merged before rollback support)", async () => {
    const id = seedTask({ id: "rb-norange", status: "merged" });
    await expectStatus(() => tasksMod.rollbackTask(id), 409);
  });

  test("409 when the task landed no commits (empty range)", async () => {
    const id = seedTask({
      id: "rb-emptyrange",
      status: "merged",
      mergeBaseSha: "deadbeef",
      mergedSha: "deadbeef",
    });
    await expectStatus(() => tasksMod.rollbackTask(id), 409);
  });
});

describe("rollbackTask — success path (real git revert)", () => {
  test("reverts the recorded range off the default branch and stamps rolled_back_at", async () => {
    // C0: base commit. C1: the task's commit. Range C0..C1 is what we revert.
    await Bun.write(join(REPO_ROOT, "foo.txt"), "base\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    const baseSha = git("rev-parse", "HEAD");

    await Bun.write(join(REPO_ROOT, "foo.txt"), "task change\n");
    git("add", "-A");
    git("commit", "-q", "-m", "task work");
    const mergedSha = git("rev-parse", "HEAD");

    const id = seedTask({
      id: "rb-success",
      status: "merged",
      mergeBaseSha: baseSha,
      mergedSha,
    });

    const before = git("rev-parse", "HEAD");
    const view = await tasksMod.rollbackTask(id);

    // Task stays merged but is now flagged rolled back.
    expect(view.status).toBe("merged");
    expect(view.rolled_back_at).toBeTruthy();
    expect(dbRow(id).rolled_back_at).toBeTruthy();

    // A revert commit landed on top of HEAD, and the task's change is undone.
    const after = git("rev-parse", "HEAD");
    expect(after).not.toBe(before);
    expect(Bun.spawnSync(["git", "-C", REPO_ROOT, "show", "HEAD:foo.txt"]).stdout.toString())
      .toBe("base\n");
    // The working tree is clean (no half-applied revert / stray markers).
    expect(git("status", "--porcelain")).toBe("");
  });

  test("a second rollback of the same task is refused (409)", async () => {
    await expectStatus(() => tasksMod.rollbackTask("rb-success"), 409);
  });
});
