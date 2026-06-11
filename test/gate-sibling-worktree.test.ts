// Regression test for the SIBLING-WORKTREE TEST-DISCOVERY BUG.
//
// butchr lays out each task's git worktree as a SUBDIRECTORY of the repo
// (`<dir>/<taskId>` — see src/git.ts worktreePath). The post-merge verify gate
// (verify.verifyDefaultBranch) runs the default gate command in the repo ROOT.
// A bare `bun test` (no path) globs the WHOLE tree from cwd, so from the repo
// root it discovers + runs the test files inside EVERY sibling task worktree
// (`<dir>/<otherTask>/test/*.test.ts`). A production incident saw this run 1044
// tests across 125 files instead of ~321/37, and an in-flight worktree's failing
// test auto-reverted an unrelated green merge.
//
// The fix scopes test discovery to the repo's OWN `./test`: the default
// config.verifyCmd passes `bun test ./test`, and bunfig.toml pins `[test] root`
// to "./test" so even a bare `bun test` is scoped. This test proves BOTH the
// default gate command and a bare `bun test` (under the repo's bunfig.toml) run
// ONLY the repo's own suite and are unaffected by a sibling worktree dir — with
// a STABLE test count regardless of how many siblings exist.
import { describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config.ts";
import { runGate } from "../src/gate.ts";

const REPO_BUNFIG = join(import.meta.dir, "..", "bunfig.toml");

/**
 * Build a synthetic "repo root" containing the repo's OWN ./test (a passing
 * test) plus N sibling task-worktree dirs, each with a FAILING test under its
 * own test/ — mirroring butchr's `<dir>/<taskId>/test/*.test.ts` layout.
 */
function makeRepoWithSiblings(siblings: number, withBunfig: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "butchr-sibling-repo-"));
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(
    join(root, "test", "own.test.ts"),
    `import { test, expect } from "bun:test";\n` +
      `test("repo's own test", () => { expect(1).toBe(1); });\n`,
  );
  for (let i = 0; i < siblings; i++) {
    const wt = join(root, `sibling-task-${i}`);
    mkdirSync(join(wt, "test"), { recursive: true });
    writeFileSync(
      join(wt, "test", "sibling.test.ts"),
      `import { test, expect } from "bun:test";\n` +
        `test("SIBLING worktree test — must NOT be discovered", () => { expect(1).toBe(2); });\n`,
    );
  }
  if (withBunfig) copyFileSync(REPO_BUNFIG, join(root, "bunfig.toml"));
  return root;
}

describe("default gate command scopes test discovery to ./test", () => {
  test("config.verifyCmd targets `bun test ./test`, not a bare `bun test`", () => {
    // The build step is unconstrained, but the test run MUST be path-scoped.
    expect(config.verifyCmd).toContain("bun test ./test");
    // No UNSCOPED `bun test` survives once the scoped form is removed — a bare
    // `bun test` (no path) would glob the whole tree and pick up sibling worktrees.
    expect(config.verifyCmd.replaceAll("bun test ./test", "")).not.toContain("bun test");
  });

  test("the repo's bunfig.toml pins `[test] root` to ./test", () => {
    const toml = require("node:fs").readFileSync(REPO_BUNFIG, "utf8") as string;
    expect(toml).toMatch(/\[test\]/);
    expect(toml).toMatch(/root\s*=\s*"\.\/test"/);
  });
});

describe("the gate ignores sibling worktree tests (run from the repo root)", () => {
  test("`bun test ./test` runs ONLY the repo's own suite and PASSES despite a failing sibling", async () => {
    const root = makeRepoWithSiblings(1, /*withBunfig*/ false);
    try {
      const gate = await runGate(["bash", "-lc", "bun test ./test"], {
        cwd: root,
        timeoutMs: 60000,
      });
      expect(gate.ok).toBe(true);
      // Exactly the repo's own single test ran — the sibling was never discovered.
      expect(gate.output).toContain("1 pass");
      expect(gate.output).toContain("Ran 1 test across 1 file");
      expect(gate.output).not.toContain("SIBLING worktree test");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the count is STABLE regardless of how many sibling worktrees exist", async () => {
    // 0 siblings vs 5 siblings must produce the IDENTICAL scoped run.
    const a = makeRepoWithSiblings(0, false);
    const b = makeRepoWithSiblings(5, false);
    try {
      const ga = await runGate(["bash", "-lc", "bun test ./test"], { cwd: a, timeoutMs: 60000 });
      const gb = await runGate(["bash", "-lc", "bun test ./test"], { cwd: b, timeoutMs: 60000 });
      expect(ga.ok).toBe(true);
      expect(gb.ok).toBe(true);
      expect(ga.output).toContain("Ran 1 test across 1 file");
      expect(gb.output).toContain("Ran 1 test across 1 file");
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  test("CONTROL: a bare `bun test` (no scoping) WOULD pick up the failing sibling", async () => {
    // Proves the scoping is load-bearing — without it the sibling's failing test
    // RED's the gate and would auto-revert an unrelated green merge.
    const root = makeRepoWithSiblings(1, /*withBunfig*/ false);
    try {
      const gate = await runGate(["bash", "-lc", "bun test"], { cwd: root, timeoutMs: 60000 });
      expect(gate.ok).toBe(false);
      expect(gate.output).toContain("SIBLING worktree test");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("bunfig.toml `[test] root` scopes even a bare `bun test` to ./test", async () => {
    // Defense-in-depth: a developer / script running a bare `bun test` from the
    // repo root is protected by bunfig.toml without needing the ./test arg.
    const root = makeRepoWithSiblings(1, /*withBunfig*/ true);
    expect(existsSync(join(root, "bunfig.toml"))).toBe(true);
    try {
      const gate = await runGate(["bash", "-lc", "bun test"], { cwd: root, timeoutMs: 60000 });
      expect(gate.ok).toBe(true);
      expect(gate.output).toContain("Ran 1 test across 1 file");
      expect(gate.output).not.toContain("SIBLING worktree test");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
