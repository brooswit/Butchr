// Tests for POWER-LOSS RESILIENCE in src/git.ts:
//   - setGitDurability sets the fsync object-write config on a repo (idempotently).
//     This is exactly the function registerWorkspace calls on a freshly-registered
//     workspace; registerWorkspace itself needs a live herdr (it shells to herdr
//     directly, not the harness), so it's covered here at the primitive level —
//     matching the convention in gate-command.test.ts.
//   - healLooseObjects removes an UNREACHABLE empty loose object and leaves the repo
//     fsck-clean.
//   - healLooseObjects does NOT delete a REACHABLE corrupt object — it bails
//     (skipped=true), surfaces the sha, and leaves the file on disk. This is the
//     critical safety path: a bug here would corrupt a managed repo.
//
// Pure / in-process: no claude/herdr/bun subprocess. Real temp `git init` repos
// stand in for managed repos (mirroring how other tests build a temp repo). git.ts
// reads BUTCHR_GIT_FSYNC at import via config, so env is set before importing it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let gitMod: typeof import("../src/git.ts");
const GIT = "git";

/** Run a git command synchronously in `cwd`, returning trimmed stdout. */
function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync([GIT, "-C", cwd, ...args]);
  return new TextDecoder().decode(r.stdout).trim();
}

/** Create a fresh temp repo with one commit; returns its path. */
function makeRepo(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `butchr-resilience-${label}-`));
  Bun.spawnSync([GIT, "-C", dir, "init", "-q"]);
  git(dir, "config", "user.email", "test@butchr.test");
  git(dir, "config", "user.name", "butchr test");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "file.txt"), `content for ${label}\n`, "utf8");
  git(dir, "add", "file.txt");
  git(dir, "commit", "-q", "-m", "initial commit");
  return dir;
}

/** Read a git config value (empty string if unset). */
function getConfig(dir: string, key: string): string {
  const r = Bun.spawnSync([GIT, "-C", dir, "config", "--get", key]);
  return new TextDecoder().decode(r.stdout).trim();
}

const repos: string[] = [];
function track(dir: string): string {
  repos.push(dir);
  return dir;
}

beforeAll(async () => {
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_GIT_FSYNC = "1";
  gitMod = await import("../src/git.ts");
});

afterAll(() => {
  for (const d of repos) rmSync(d, { recursive: true, force: true });
});

describe("setGitDurability", () => {
  test("sets fsync object-write config and is idempotent", async () => {
    const repo = track(makeRepo("durable"));

    await gitMod.setGitDurability(repo);
    expect(getConfig(repo, "core.fsyncObjectFiles")).toBe("true");
    expect(getConfig(repo, "core.fsync")).toBe("all");

    // Idempotent: a second call leaves the same values (no duplicate/clobber).
    await gitMod.setGitDurability(repo);
    expect(getConfig(repo, "core.fsyncObjectFiles")).toBe("true");
    expect(getConfig(repo, "core.fsync")).toBe("all");
  });
});

describe("healLooseObjects — unreachable empty loose object", () => {
  test("removes it and leaves the repo fsck-clean", async () => {
    const repo = track(makeRepo("unreachable"));

    // Fabricate a 0-byte loose object that no ref points at (an unreachable
    // truncation artifact). sha = <dir><file>; the content is empty.
    const sha = "ab" + "0".repeat(38);
    const objDir = join(repo, ".git", "objects", sha.slice(0, 2));
    mkdirSync(objDir, { recursive: true });
    const objPath = join(objDir, sha.slice(2));
    writeFileSync(objPath, "");
    expect(statSync(objPath).size).toBe(0);

    const rep = await gitMod.healLooseObjects(repo);

    expect(rep.skipped).toBe(false);
    expect(rep.removed).toContain(sha);
    expect(rep.reachableCorrupt).toEqual([]);
    expect(existsSync(objPath)).toBe(false); // the corrupt object is gone

    // Repo is healthy again: fsck exits clean.
    const fsck = Bun.spawnSync([GIT, "-C", repo, "fsck"]);
    expect(fsck.exitCode).toBe(0);
    expect(rep.note).toContain("fsck clean");
  });

  test("clean repo with no corrupt objects is a cheap no-op", async () => {
    const repo = track(makeRepo("clean"));
    const rep = await gitMod.healLooseObjects(repo);
    expect(rep.removed).toEqual([]);
    expect(rep.reachableCorrupt).toEqual([]);
    expect(rep.skipped).toBe(false);
  });

  test("non-empty but fsck-corrupt unreachable object → detected via fsck + removed", async () => {
    const repo = track(makeRepo("nonempty-corrupt"));

    // Create a valid loose object NOT referenced by any tree/commit (unreachable),
    // then corrupt its CONTENT while keeping the file NON-empty — the size scan
    // alone can't see this; only `git fsck` flags it, so this exercises the fsck
    // detector being run unconditionally (not gated behind finding a 0-byte object).
    const r = Bun.spawnSync([GIT, "-C", repo, "hash-object", "-w", "--stdin"], {
      stdin: new TextEncoder().encode("a dangling blob that we will corrupt\n"),
    });
    const sha = new TextDecoder().decode(r.stdout).trim();
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const objPath = join(repo, ".git", "objects", sha.slice(0, 2), sha.slice(2));
    expect(existsSync(objPath)).toBe(true);
    // git writes loose objects read-only; replace with non-empty garbage (not valid
    // zlib → fsck reports it corrupt) via remove-then-recreate.
    rmSync(objPath, { force: true });
    writeFileSync(objPath, "this is not a valid git object payload");
    expect(statSync(objPath).size).toBeGreaterThan(0);

    const rep = await gitMod.healLooseObjects(repo);

    expect(rep.skipped).toBe(false);
    expect(rep.removed).toContain(sha); // detected (via fsck) and removed
    expect(rep.reachableCorrupt).toEqual([]);
    expect(existsSync(objPath)).toBe(false);

    const fsck = Bun.spawnSync([GIT, "-C", repo, "fsck"]);
    expect(fsck.exitCode).toBe(0);
  });
});

describe("healLooseObjects — REACHABLE corrupt object (safety)", () => {
  test("does NOT delete it: bails, surfaces the sha, leaves the file on disk", async () => {
    const repo = track(makeRepo("reachable"));

    // Truncate the HEAD COMMIT object — reachable from refs/heads/<branch> and HEAD.
    // (Loose, since a tiny fresh repo hasn't been packed.) rev-list must inflate the
    // commit to walk it, so the all-refs walk will FAIL → the heal must bail.
    const commit = git(repo, "rev-parse", "HEAD");
    const objPath = join(repo, ".git", "objects", commit.slice(0, 2), commit.slice(2));
    expect(existsSync(objPath)).toBe(true);
    // git writes loose objects read-only (0444), so truncate by remove-then-recreate
    // (same path → same sha, still reachable from the refs — just corrupt now).
    rmSync(objPath, { force: true });
    writeFileSync(objPath, "");
    expect(statSync(objPath).size).toBe(0);

    const rep = await gitMod.healLooseObjects(repo);

    expect(rep.skipped).toBe(true); // bailed — reachable corruption present
    expect(rep.removed).toEqual([]); // deleted NOTHING
    expect(rep.reachableCorrupt).toContain(commit); // surfaced for manual repair
    expect(existsSync(objPath)).toBe(true); // the reachable object is STILL on disk

    // Sanity: the candidate really was a loose object under .git/objects (not packed),
    // so this genuinely exercised the bail path rather than a no-op.
    expect(readdirSync(join(repo, ".git", "objects", commit.slice(0, 2)))).toContain(
      commit.slice(2),
    );
  });
});
