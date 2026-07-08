// Tests for the MERGE-LOCK ADDITIVE-CONFLICT SAFETY NET (git.tryUnionChangelogConflict,
// reached via git.merge ← finalizeMerge ← approveTask). The single riskiest manual ritual
// the CTO reached around butchr for: a merge-lock rebase that bounced a TRIVIAL ADDITIVE
// changelog conflict (both tasks added a bullet under [Unreleased]) back to an agent. The
// net mechanically UNIONs exactly that shape and NOTHING else.
//
// Real git throughout (a throwaway repo + real worktrees/branches/commits), with the
// post-merge verify runner stubbed GREEN and herdr probes no-op'd — exactly like
// test/finalize-changelog.test.ts — so we assert what genuinely lands on main.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
const WS_ID = "merge-union-ws";

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

### Added
- An earlier feature.

## [0.1.0] - 2026-01-01

### Added
- Initial release.
`;

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-union-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-union-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  execFileSync("git", ["init", "-q", REPO_ROOT], { stdio: "ignore" });
  g(["config", "user.email", "test@butchr.local"]);
  g(["config", "user.name", "butchr test"]);
  writeFileSync(join(REPO_ROOT, "CHANGELOG.md"), CHANGELOG_SEED);
  writeFileSync(join(REPO_ROOT, "README.md"), "shared readme line\n");
  writeFileSync(join(REPO_ROOT, "lib.ts"), "export const shared = 0;\n");
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
  // The net's changelog path is the workspace's configured changelog (finalizeMerge passes
  // workspaceChangelogPath into git.merge unconditionally).
  // changelog_path is READ-ONLY-INERT (no setter) but still read by the release stamp — set the column directly.
  dbMod.db.query(`UPDATE directory SET changelog_path=? WHERE id=?`).run("CHANGELOG.md", WS_ID);
});

afterEach(() => {
  verifyMod.setVerifyRunner();
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

function changelog(): string {
  return readFileSync(join(REPO_ROOT, "CHANGELOG.md"), "utf8");
}

/**
 * Create a task whose worktree branches from the CURRENT main, apply `mutate` to its
 * worktree files, commit, and move it to `review`. Returns the id. Does NOT merge — the
 * caller controls merge ORDER so a second task can rebase onto the first's landed work.
 */
async function seedReviewTask(
  label: string,
  mutate: (wt: string) => void,
): Promise<string> {
  const view = await tasksMod.createTask(WS_ID, label);
  const id = view.id;
  const wt = join(REPO_ROOT, id);
  mutate(wt);
  g(["add", "-A"], wt);
  g(["commit", "-q", "-m", label], wt);
  dbMod.db.query(`UPDATE tasks SET status='in_review' WHERE id=?`).run(id);
  taskmdMod.updateTaskMdStatus(REPO_ROOT, id, "in_review");
  return id;
}

function status(id: string): string {
  return dbMod.db.query<any, [string]>(`SELECT status FROM tasks WHERE id=?`).get(id)!.status;
}

/** Insert a bullet immediately under the `## [Unreleased]` heading (the cascade spot). */
function addUnreleasedBullet(wt: string, bullet: string): void {
  const cl = readFileSync(join(wt, "CHANGELOG.md"), "utf8").replace(
    "## [Unreleased]\n",
    `## [Unreleased]\n${bullet}\n`,
  );
  writeFileSync(join(wt, "CHANGELOG.md"), cl);
}

describe("merge-lock additive changelog union", () => {
  test("two tasks each add an adjacent [Unreleased] bullet → the conflict is auto-unioned and BOTH land", async () => {
    verifyMod.setVerifyRunner(async () => ({ ok: true, output: "" }));

    // Both worktrees branch from the SAME base (before either merges).
    const a = await seedReviewTask("task A", (wt) => addUnreleasedBullet(wt, "- Feature A"));
    const b = await seedReviewTask("task B", (wt) => addUnreleasedBullet(wt, "- Feature B"));

    await tasksMod.approveTask(a);
    expect(status(a)).toBe("merged");

    // B's branch is now BEHIND main and its bullet sits at the same anchor as A's → the
    // merge-lock rebase conflicts on CHANGELOG.md only, additively. The net unions it.
    const outcome = await tasksMod.approveTask(b);
    expect(outcome.conflictSentBack).toBeFalsy();
    expect(status(b)).toBe("merged");

    const log = changelog();
    expect(log).toContain("- Feature A");
    expect(log).toContain("- Feature B");
    // The pre-existing seeded bullet survives, each new bullet appears exactly once.
    expect(log).toContain("- An earlier feature.");
    expect(log.split("- Feature A").length - 1).toBe(1);
    expect(log.split("- Feature B").length - 1).toBe(1);
  });

  test("EXACTLY-changelog gate: two code files + the changelog all conflicting → BOUNCE untouched", async () => {
    verifyMod.setVerifyRunner(async () => ({ ok: true, output: "" }));

    const a = await seedReviewTask("code task A", (wt) => {
      addUnreleasedBullet(wt, "- Feature A2");
      writeFileSync(join(wt, "README.md"), "readme edited by A\n");
      writeFileSync(join(wt, "lib.ts"), "export const shared = 1; // A\n");
    });
    const b = await seedReviewTask("code task B", (wt) => {
      addUnreleasedBullet(wt, "- Feature B2");
      writeFileSync(join(wt, "README.md"), "readme edited by B\n");
      writeFileSync(join(wt, "lib.ts"), "export const shared = 2; // B\n");
    });

    await tasksMod.approveTask(a);
    expect(status(a)).toBe("merged");
    const mainTip = g(["rev-parse", "HEAD"]);
    const logBefore = changelog();

    // B conflicts on README.md + lib.ts AS WELL AS the changelog → the unmerged set is NOT
    // exactly [CHANGELOG.md], so the net must NOT partial-resolve: bounce the WHOLE rebase.
    const outcome = await tasksMod.approveTask(b);
    expect(outcome.conflictSentBack).toBe(true);
    expect(status(b)).not.toBe("merged");
    // Main is UNTOUCHED — no partial changelog write leaked through.
    expect(g(["rev-parse", "HEAD"])).toBe(mainTip);
    expect(changelog()).toBe(logBefore);
    expect(changelog()).not.toContain("- Feature B2");
  });

  test("non-additive: one side EDITS an existing bullet → BOUNCE (only additive unions)", async () => {
    verifyMod.setVerifyRunner(async () => ({ ok: true, output: "" }));

    // Both rewrite the SAME existing bullet differently — a changelog-only conflict, but
    // NOT additive (an ancestor line was edited), so the resolver returns null → bounce.
    const a = await seedReviewTask("edit task A", (wt) => {
      const cl = readFileSync(join(wt, "CHANGELOG.md"), "utf8").replace(
        "- An earlier feature.",
        "- An earlier feature, clarified by A.",
      );
      writeFileSync(join(wt, "CHANGELOG.md"), cl);
    });
    const b = await seedReviewTask("edit task B", (wt) => {
      const cl = readFileSync(join(wt, "CHANGELOG.md"), "utf8").replace(
        "- An earlier feature.",
        "- An earlier feature, reworded by B.",
      );
      writeFileSync(join(wt, "CHANGELOG.md"), cl);
    });

    await tasksMod.approveTask(a);
    expect(status(a)).toBe("merged");
    const mainTip = g(["rev-parse", "HEAD"]);

    const outcome = await tasksMod.approveTask(b);
    expect(outcome.conflictSentBack).toBe(true);
    expect(status(b)).not.toBe("merged");
    // Main untouched; B's reword never landed.
    expect(g(["rev-parse", "HEAD"])).toBe(mainTip);
    expect(changelog()).not.toContain("reworded by B");
    expect(changelog()).toContain("clarified by A");
  });
});
