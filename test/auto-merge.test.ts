// Tests for AUTO-MERGE of green, low-risk tasks (see config.autoMerge*, db.ts
// auto_merged column, git.diffStat, and tasks.{isLowRiskChange, maybeAutoMerge}
// fired from triggerCi + the dispatcher tick backstop).
//
// Like post-merge-verify.test.ts these are REAL: a throwaway git repo, real
// worktrees/branches from createTask, real commits, and a real git.merge — so we
// assert the default branch genuinely advances (or doesn't). The POST-MERGE verify
// runner is mocked (verify.setVerifyRunner) so the approve path inside
// maybeAutoMerge is GREEN deterministically without spawning a real bun build/test.
//
// Auto-merge config is OFF by default (opt-in); each test toggles the shared
// config object (read at call-time by maybeAutoMerge) and restores it afterwards.
//
// BUTCHR_HERDR_BIN points at `true` so every herdr probe is a harmless no-op.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
const DIR_ID = "auto-merge-dir";

let tasksMod: typeof import("../src/tasks.ts");
let dbMod: typeof import("../src/db.ts");
let taskmdMod: typeof import("../src/taskmd.ts");
let verifyMod: typeof import("../src/verify.ts");
let configMod: typeof import("../src/config.ts");

function g(args: string[], cwd = REPO_ROOT): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-am-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-am-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  execFileSync("git", ["init", "-q", REPO_ROOT], { stdio: "ignore" });
  g(["config", "user.email", "test@butchr.local"]);
  g(["config", "user.name", "butchr test"]);
  writeFileSync(join(REPO_ROOT, "README.md"), "base\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "init"]);

  dbMod = await import("../src/db.ts");
  taskmdMod = await import("../src/taskmd.ts");
  tasksMod = await import("../src/tasks.ts");
  verifyMod = await import("../src/verify.ts");
  configMod = await import("../src/config.ts");

  dbMod.db
    .query(
      `INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`,
    )
    .run(DIR_ID, REPO_ROOT, "test", dbMod.nowIso());
});

// Snapshot + restore the auto-merge config so tests don't leak into each other or
// other test files (config is a shared singleton).
const cfgDefaults = {
  enabled: false,
  allowlist: ["public/", "test/", "docs/", "*.md"],
  max: 150,
};
function enableAutoMerge(over: Partial<{ allowlist: string[]; max: number }> = {}) {
  configMod.config.autoMergeEnabled = true;
  configMod.config.autoMergeAllowlist = over.allowlist ?? cfgDefaults.allowlist;
  configMod.config.autoMergeMaxChangedLines = over.max ?? cfgDefaults.max;
}

afterEach(() => {
  verifyMod.setVerifyRunner(); // restore the real verify runner
  configMod.config.autoMergeEnabled = cfgDefaults.enabled;
  configMod.config.autoMergeAllowlist = cfgDefaults.allowlist;
  configMod.config.autoMergeMaxChangedLines = cfgDefaults.max;
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

function dbRow(id: string) {
  return dbMod.db.query<any, [string]>(`SELECT * FROM tasks WHERE id=?`).get(id)!;
}

/**
 * Create a REAL task (worktree + branch + task.md + DB row), write+commit the
 * given files in its worktree, and move it to `review` with ci_status='pass' — the
 * exact state the auto-merge hook sees. `files` maps relative path → contents.
 */
async function seedGreenReviewTask(
  files: Record<string, string>,
): Promise<string> {
  const view = await tasksMod.createTask(DIR_ID, `Work ${Object.keys(files).join(",")}`);
  const id = view.id;
  const wt = join(REPO_ROOT, id);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(wt, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  g(["add", "-A"], wt);
  g(["commit", "-q", "-m", "task work"], wt);
  dbMod.db
    .query(`UPDATE tasks SET status='in_review', ci_status='pass' WHERE id=?`)
    .run(id);
  taskmdMod.updateTaskMdStatus(REPO_ROOT, id, "in_review");
  return id;
}

describe("isLowRiskChange (pure decision)", () => {
  const opts = { allowlist: cfgDefaults.allowlist, maxChangedLines: 150 };

  test("all-allowlisted small diff is low-risk", () => {
    expect(
      tasksMod.isLowRiskChange(["public/a.html", "docs/b.txt", "README.md"], 40, opts),
    ).toBe(true);
  });

  test("a src/ file is NOT low-risk", () => {
    expect(tasksMod.isLowRiskChange(["public/a.html", "src/x.ts"], 10, opts)).toBe(false);
  });

  test("over the line threshold is NOT low-risk", () => {
    expect(tasksMod.isLowRiskChange(["public/a.html"], 151, opts)).toBe(false);
  });

  test("a NESTED .md is NOT matched by the top-level *.md entry", () => {
    expect(tasksMod.isLowRiskChange(["src/deep/notes.md"], 5, opts)).toBe(false);
  });

  test("an empty diff is NOT low-risk", () => {
    expect(tasksMod.isLowRiskChange([], 0, opts)).toBe(false);
  });
});

describe("maybeAutoMerge", () => {
  test("a CI-green public/-only small diff AUTO-MERGES", async () => {
    enableAutoMerge();
    verifyMod.setVerifyRunner(async () => ({ ok: true, output: "" }));
    const id = await seedGreenReviewTask({ "public/page.html": "<h1>hi</h1>\n" });
    const tipBefore = g(["rev-parse", "HEAD"]);

    const merged = await tasksMod.maybeAutoMerge(id);

    expect(merged).toBe(true);
    const row = dbRow(id);
    expect(row.status).toBe("merged");
    expect(row.auto_merged).toBe(1);
    // Main genuinely advanced and the file landed at the repo root.
    expect(g(["rev-parse", "HEAD"])).not.toBe(tipBefore);
    expect(existsSync(join(REPO_ROOT, "public", "page.html"))).toBe(true);
  });

  test("a src/ change does NOT auto-merge (waits for human review)", async () => {
    enableAutoMerge();
    verifyMod.setVerifyRunner(async () => ({ ok: true, output: "" }));
    const id = await seedGreenReviewTask({ "src/feature.ts": "export const x = 1;\n" });

    const merged = await tasksMod.maybeAutoMerge(id);

    expect(merged).toBe(false);
    const row = dbRow(id);
    expect(row.status).toBe("in_review");
    expect(row.auto_merged).toBe(0);
  });

  test("an oversized allowlisted diff does NOT auto-merge", async () => {
    enableAutoMerge({ max: 150 });
    verifyMod.setVerifyRunner(async () => ({ ok: true, output: "" }));
    const big = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const id = await seedGreenReviewTask({ "public/big.txt": big });

    const merged = await tasksMod.maybeAutoMerge(id);

    expect(merged).toBe(false);
    expect(dbRow(id).status).toBe("in_review");
  });

  test("DEFAULT-OFF: a qualifying task does NOT auto-merge when disabled", async () => {
    // Auto-merge left disabled (the default) — qualifying or not, nothing lands.
    verifyMod.setVerifyRunner(async () => ({ ok: true, output: "" }));
    const id = await seedGreenReviewTask({ "public/ok.html": "<p>ok</p>\n" });

    const merged = await tasksMod.maybeAutoMerge(id);

    expect(merged).toBe(false);
    expect(dbRow(id).status).toBe("in_review");
    expect(dbRow(id).auto_merged).toBe(0);
  });

  test("CI-fail never auto-merges (even if otherwise low-risk)", async () => {
    enableAutoMerge();
    verifyMod.setVerifyRunner(async () => ({ ok: true, output: "" }));
    const id = await seedGreenReviewTask({ "public/maybe.html": "<p>x</p>\n" });
    // CI came back red.
    dbMod.db.query(`UPDATE tasks SET ci_status='fail' WHERE id=?`).run(id);

    const merged = await tasksMod.maybeAutoMerge(id);

    expect(merged).toBe(false);
    expect(dbRow(id).status).toBe("in_review");
  });

  test("a CONFLICT never auto-merges — it routes back to the agent, not main", async () => {
    enableAutoMerge();
    verifyMod.setVerifyRunner(async () => ({ ok: true, output: "" }));
    // Task edits a top-level .md (allowlisted, tiny) — but main then changes the
    // SAME file differently, so the approve-time rebase conflicts.
    const id = await seedGreenReviewTask({ "README.md": "task change\n" });
    // Advance main with a conflicting edit to README.md.
    writeFileSync(join(REPO_ROOT, "README.md"), "main change\n");
    g(["commit", "-aqm", "main edits README"]);
    const tipBefore = g(["rev-parse", "HEAD"]);

    const merged = await tasksMod.maybeAutoMerge(id);

    expect(merged).toBe(false);
    // Nothing landed on main; the conflicting content did not overwrite it.
    expect(g(["rev-parse", "HEAD"])).toBe(tipBefore);
    expect(g(["show", "HEAD:README.md"])).toBe("main change");
    // finalizeMerge's conflict path kicked it back (requestChanges → in_progress), and it
    // is certainly NOT merged / auto_merged.
    const row = dbRow(id);
    expect(row.status).not.toBe("merged");
    expect(row.auto_merged).toBe(0);
  });
});
