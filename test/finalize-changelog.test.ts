// Tests for the MERGE-TIME VERSION BUMP (git.bumpVersionFile, called from git.merge)
// and the FLIPPED changelog rule. butchr no longer ASSUMES a project's version /
// changelog shape, so it works on ANY repo:
//   - the version bump is OPT-IN per workspace (a `version_file`); with none set it
//     never touches the version, and a missing/parseless file is a graceful no-op;
//   - butchr no longer WRITES the changelog — the task/agent owns its entry, and an
//     entry the agent committed lands on main untouched (no butchr-authored bullet,
//     no duplication). The changelog GATE is exercised in test/ci-gate.test.ts.
//
// Pure / in-process like the other merge tests: BUTCHR_HERDR_BIN points at `true`
// (herdr probes are no-ops) and the post-merge verify runner is stubbed GREEN so
// approveTask reaches the real git.merge fast-forward. Everything else is REAL — a
// throwaway git repo with a CHANGELOG.md + package.json, a real worktree/branch, a
// real committed change — so we assert what genuinely lands on main.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
const WS_ID = "finalize-changelog-ws";

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
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-finalize-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-finalize-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  execFileSync("git", ["init", "-q", REPO_ROOT], { stdio: "ignore" });
  g(["config", "user.email", "test@butchr.local"]);
  g(["config", "user.name", "butchr test"]);
  writeFileSync(join(REPO_ROOT, "CHANGELOG.md"), CHANGELOG_SEED);
  writeFileSync(
    join(REPO_ROOT, "package.json"),
    `{\n  "name": "demo",\n  "version": "0.3.7"\n}\n`,
  );
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
});

afterEach(() => {
  verifyMod.setVerifyRunner(); // restore the real runner between tests
  wsMod.updateWorkspaceVersionFile(WS_ID, null); // clear the version-bump override
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

function changelog(): string {
  return readFileSync(join(REPO_ROOT, "CHANGELOG.md"), "utf8");
}
function version(): string {
  return JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version;
}

/**
 * Create a REAL task, have the "agent" commit `file` in its worktree (optionally also
 * editing CHANGELOG.md to simulate the new task-owns-the-changelog convention), and
 * move it to `review` so approveTask can merge it.
 */
async function seedReviewTask(
  file: string,
  content: string,
  opts: { changelogEntry?: string } = {},
): Promise<string> {
  const view = await tasksMod.createTask(WS_ID, `Add ${file}`);
  const id = view.id;
  const wt = join(REPO_ROOT, id);
  writeFileSync(join(wt, file), content);
  if (opts.changelogEntry) {
    // The agent owns its changelog entry now — append a real bullet under [Unreleased].
    const cl = readFileSync(join(wt, "CHANGELOG.md"), "utf8").replace(
      "## [Unreleased]",
      `## [Unreleased]\n\n### Changed\n- ${opts.changelogEntry}`,
    );
    writeFileSync(join(wt, "CHANGELOG.md"), cl);
  }
  g(["add", "-A"], wt);
  g(["commit", "-q", "-m", `add ${file}`], wt);
  dbMod.db.query(`UPDATE tasks SET status='in_review' WHERE id=?`).run(id);
  taskmdMod.updateTaskMdStatus(REPO_ROOT, id, "in_review");
  return id;
}

async function merge(id: string): Promise<void> {
  // Approve runs the mechanical merge synchronously (rebase → gate → merge → teardown).
  await tasksMod.approveTask(id);
}

function status(id: string): string {
  return dbMod.db.query<any, [string]>(`SELECT status FROM tasks WHERE id=?`).get(id)!.status;
}

describe("merge-time version bump (opt-in) + flipped changelog rule", () => {
  test("default (no version_file): merge bumps NOTHING and never writes the changelog", async () => {
    verifyMod.setVerifyRunner(async () => ({ ok: true, output: "" }));
    const before = version();
    const clBefore = changelog();

    const id = await seedReviewTask("feature.ts", "export const x = 1;\n");
    await merge(id);
    expect(status(id)).toBe("merged");

    // Version untouched (bump is opt-in and this workspace didn't opt in)…
    expect(version()).toBe(before);
    // …and butchr wrote NO changelog entry (the agent didn't either).
    expect(changelog()).toBe(clBefore);
    // No butchr bookkeeping commit landed.
    expect(g(["log", "--oneline", "-5"])).not.toContain("butchr: bump version");
  });

  test("opt-in: with version_file set, a code task patch-bumps the version", async () => {
    verifyMod.setVerifyRunner(async () => ({ ok: true, output: "" }));
    wsMod.updateWorkspaceVersionFile(WS_ID, "package.json");
    const before = version(); // 0.3.7

    const id = await seedReviewTask("feature2.ts", "export const y = 2;\n");
    await merge(id);

    // Patch bump only, in butchr's own dedicated commit (the agent never touched it).
    const [maj, min, patch] = before.split(".").map(Number);
    expect(version()).toBe(`${maj}.${min}.${patch! + 1}`);
    expect(g(["log", "--oneline", "-3"])).toContain(`butchr: bump version ${before} →`);
  });

  test("opt-in: a docs-only task does NOT bump the version", async () => {
    verifyMod.setVerifyRunner(async () => ({ ok: true, output: "" }));
    wsMod.updateWorkspaceVersionFile(WS_ID, "package.json");
    const before = version();

    const id = await seedReviewTask("NOTES.md", "# notes\n");
    await merge(id);

    expect(version()).toBe(before); // docs-only → no bump
  });

  test("opt-in: a missing version file is a graceful no-op (works on ANY repo)", async () => {
    verifyMod.setVerifyRunner(async () => ({ ok: true, output: "" }));
    // Point the workspace at a version file this repo does NOT have.
    wsMod.updateWorkspaceVersionFile(WS_ID, "VERSION");
    const before = version(); // package.json is left alone

    const id = await seedReviewTask("feature3.ts", "export const z = 3;\n");
    await merge(id); // must still merge cleanly

    expect(status(id)).toBe("merged");
    expect(version()).toBe(before); // nothing bumped (no such file)
    // No bump commit for THIS task — the tip is the agent's own commit.
    expect(g(["log", "--oneline", "-1"])).toContain("add feature3.ts");
    expect(g(["log", "--oneline", "-1"])).not.toContain("butchr: bump version");
  });

  test("the task owns the changelog: an agent-committed entry lands on main untouched", async () => {
    verifyMod.setVerifyRunner(async () => ({ ok: true, output: "" }));

    const id = await seedReviewTask("feature4.ts", "export const w = 4;\n", {
      changelogEntry: "A change the agent itself documented",
    });
    await merge(id);

    const log = changelog();
    // The agent's own entry is present exactly once — butchr neither added nor
    // duplicated a bullet of its own.
    expect(log).toContain("A change the agent itself documented");
    expect(log.split("A change the agent itself documented").length - 1).toBe(1);
    // The pre-existing seeded entry survives.
    expect(log).toContain("An earlier feature.");
  });
});
