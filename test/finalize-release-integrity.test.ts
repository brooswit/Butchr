// Tests for MERGE-PIPELINE HARDENING S2 (story st-e79fcb83) — the release/target-integrity
// guards in git.merge, reached end-to-end through approveTask → finalizeMerge → git.merge:
//
//   F2 — a FAILED version-bump commit must NOT report a release. If git.bumpVersionFile's
//        commit fails (here: a commit-msg hook that rejects exactly `butchr: release`), the
//        merge must FAIL — main must NOT fast-forward to a version-less tip, no released_version
//        is recorded, and bumpVersionFile reverts its own staged edits so a re-queue is clean.
//
//   F4 — the ff-target must be on the EXPECTED branch. If the repo root is left in a DETACHED
//        HEAD state, git.merge must refuse cleanly (a 409 hard refusal) and leave the default
//        branch untouched, rather than advancing the wrong ref.
//
// Pure / in-process like the other merge tests: BUTCHR_HERDR_BIN points at `true` (herdr probes
// are no-ops) and the verify runner is stubbed GREEN so the mechanical merge reaches the real
// git.merge. Everything else is REAL — a throwaway repo with package.json + CHANGELOG.md, real
// worktrees/branches/commits — so we assert what genuinely lands (or doesn't) on main.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
const WS_ID = "release-integrity-ws";
const HOOK = () => join(REPO_ROOT, ".git", "hooks", "commit-msg");

let tasksMod: typeof import("../src/tasks.ts");
let dbMod: typeof import("../src/db.ts");
let taskmdMod: typeof import("../src/taskmd.ts");
let verifyMod: typeof import("../src/verify.ts");
let wsMod: typeof import("../src/workspaces.ts");

function g(args: string[], cwd = REPO_ROOT): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

const CHANGELOG_SEED = `# Changelog

## [Unreleased]

## [0.1.0] - 2026-01-01

### Added
- Initial release.
`;

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-relint-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-relint-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  // `-b main` for a DETERMINISTIC default branch (the F4 detach asserts against it).
  execFileSync("git", ["init", "-q", "-b", "main", REPO_ROOT], { stdio: "ignore" });
  g(["config", "user.email", "test@butchr.local"]);
  g(["config", "user.name", "butchr test"]);
  writeFileSync(join(REPO_ROOT, "CHANGELOG.md"), CHANGELOG_SEED);
  writeFileSync(join(REPO_ROOT, "package.json"), `{\n  "name": "demo",\n  "version": "0.9.0"\n}\n`);
  writeFileSync(join(REPO_ROOT, "README.md"), "base\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "init"]);

  dbMod = await import("../src/db.ts");
  taskmdMod = await import("../src/taskmd.ts");
  tasksMod = await import("../src/tasks.ts");
  verifyMod = await import("../src/verify.ts");
  wsMod = await import("../src/workspaces.ts");

  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(WS_ID, REPO_ROOT, "test", dbMod.nowIso());
  // Versioned-releases ON — so a (non-)release is observable via released_version + the changelog.
  wsMod.updateWorkspaceVersionFile(WS_ID, "package.json");
  // changelog_path is READ-ONLY-INERT (no setter) but still read by the release stamp — set the column directly.
  dbMod.db.query(`UPDATE directory SET changelog_path=? WHERE id=?`).run("CHANGELOG.md", WS_ID);
  wsMod.setWorkspaceReleaseMode(WS_ID, true);
  // Verify gate stubbed GREEN for the whole suite (restored in afterAll).
  verifyMod.setVerifyRunner(async () => ({ ok: true, output: "" }));
});

afterAll(() => {
  verifyMod.setVerifyRunner();
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

function changelog(): string {
  return readFileSync(join(REPO_ROOT, "CHANGELOG.md"), "utf8");
}
function version(): string {
  return JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version;
}
function row(id: string): any {
  return dbMod.db.query<any, [string]>(`SELECT * FROM tasks WHERE id=?`).get(id)!;
}

/** Seed a REAL release task: branch a worktree off main, commit `file` + an authored [Unreleased]
 *  bullet, and move it to in_review so the mechanical merge runs on approve. */
async function seedReviewTask(file: string, content: string): Promise<string> {
  const view = await tasksMod.createTask(
    WS_ID, `Add ${file}`, [], [], "task", null, [], 0, false, false, "patch",
  );
  const id = view.id;
  const wt = join(REPO_ROOT, id);
  writeFileSync(join(wt, file), content);
  const cl = readFileSync(join(wt, "CHANGELOG.md"), "utf8").replace(
    "## [Unreleased]",
    `## [Unreleased]\n\n### Added\n- ${file} landed`,
  );
  writeFileSync(join(wt, "CHANGELOG.md"), cl);
  g(["add", "-A"], wt);
  g(["commit", "-q", "-m", `add ${file}`], wt);
  dbMod.db.query(`UPDATE tasks SET status='in_review' WHERE id=?`).run(id);
  taskmdMod.updateTaskMdStatus(REPO_ROOT, id, "in_review");
  return id;
}

/** Install a commit-msg hook that rejects ONLY the bump commit (`butchr: release|bump`) — the
 *  agent's seed commit and the "butchr: finalize task" dangling commit are left to succeed.
 *  Hooks live in the COMMON git dir, so this fires for commits made inside the task worktree. */
function installBumpRejectingHook(): void {
  writeFileSync(
    HOOK(),
    '#!/bin/sh\nif grep -qE "butchr: (release|bump)" "$1"; then\n  echo "rejected by test hook" >&2\n  exit 1\nfi\nexit 0\n',
  );
  chmodSync(HOOK(), 0o755);
}

describe("F2 — a failed version-bump commit yields NO recorded release and does NOT ff", () => {
  test("a rejecting commit-msg hook fails the merge; main untouched, released_version NULL", async () => {
    const mainBefore = g(["rev-parse", "HEAD"]);
    const versionBefore = version();
    const changelogBefore = changelog();

    const id = await seedReviewTask("feature.ts", "export const x = 1;\n");
    installBumpRejectingHook();
    try {
      // The bump commit (`butchr: release …`) is rejected → git.merge fails → finalizeMerge
      // surfaces it as a 409 (no teardown). approveTask propagates the throw.
      await expect(tasksMod.approveTask(id)).rejects.toThrow();
    } finally {
      rmSync(HOOK(), { force: true });
    }

    // No phantom release: main never advanced, the version file + changelog are byte-for-byte
    // unchanged (no version bump, no new `## [X.Y.Z]` heading), and the row records no release.
    expect(g(["rev-parse", "HEAD"])).toBe(mainBefore);
    expect(version()).toBe(versionBefore);
    expect(changelog()).toBe(changelogBefore);
    expect(changelog()).not.toMatch(/## \[0\.9\.1\]/);
    const r = row(id);
    expect(r.status).not.toBe("merged");
    expect(r.released_version ?? null).toBeNull();

    // bumpVersionFile reverted its own staged edits → the task worktree tree is CLEAN (only an
    // untracked `.butchr/` remains), so a re-queue won't double-bump.
    const wtDirty = g(["status", "--porcelain", "--untracked-files=no"], join(REPO_ROOT, id));
    expect(wtDirty).toBe("");
  });

  test("AFTER the hook is removed, the SAME repo merges normally — the guard isn't sticky", async () => {
    const id = await seedReviewTask("after.ts", "export const y = 2;\n");
    await tasksMod.approveTask(id);
    expect(row(id).status).toBe("merged");
    // A real release landed now that the commit can succeed.
    expect(version()).toBe("0.9.1");
    expect(row(id).released_version).toBe("0.9.1");
  });
});

describe("F4 — a detached repo-root HEAD aborts the merge cleanly", () => {
  test("detached HEAD → merge refused with a clear message; the default branch is untouched", async () => {
    const id = await seedReviewTask("iso.ts", "export const z = 3;\n");

    const mainRef = g(["rev-parse", "main"]);
    // Leave the repo root in a DETACHED HEAD state (the F4 hazard).
    g(["checkout", "--detach"]);
    try {
      await expect(tasksMod.approveTask(id)).rejects.toThrow(/detached/i);
    } finally {
      g(["checkout", "main"]); // restore for hygiene
    }

    // The default branch ref never moved, and the task did not merge.
    expect(g(["rev-parse", "main"])).toBe(mainRef);
    expect(row(id).status).not.toBe("merged");
  });
});
