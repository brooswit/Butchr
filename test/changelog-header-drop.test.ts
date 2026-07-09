// Tests for the CHANGELOG rebase-race guard inside the repo's own `./scripts/ci` (the sole
// gate). The rule it enforces: a branch only ever ADDS to `[Unreleased]`, so a diff that
// DELETES a released version header (`## [0.9.x]`) is always the merge rebase silently
// dropping an already-released section and orphaning its bullets.
//
// These tests run the REAL `scripts/ci` text against REAL temp git repos, with its top-level
// `bun`/`bunx` lines (install, backend build, typecheck, FE whole-graph build, `bun test`)
// stripped — otherwise the gate would install a node_modules, typecheck a `src/` the fixture
// does not have, and recursively re-run the whole suite. Everything below the strip is
// byte-identical to what ships, so the check under test is the shipped one, not a
// re-implementation.
//
// The strip is `!/^bunx?\s/`, which matches only UNINDENTED lines. The FE per-file loop's
// INDENTED `if ! bun build "$f"` is therefore NOT stripped and DOES execute here, once per
// test. That cannot be avoided — dropping indented `bun` lines would leave `if ! ; then` and a
// bash syntax error. So the fixture below deliberately carries a minimally-real
// `public/app.js`: `scripts/ci` unconditionally asserts a non-empty `public/**/*.js` glob, and
// a fixture with no `public/` would (correctly) fail that guard.
//
// `bunx?` (not a bare `bun`) is load-bearing: the typecheck step is spelled `bunx --bun tsc`,
// and `^bun\s` does not match `bunx `. A new top-level gate step invoked by any OTHER command
// will silently execute here — that is the standing hazard of a harness that re-runs the gate's
// own source, and the reason this comment names the pattern.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");

/** The shipped scripts/ci minus its top-level `bun`/`bunx` lines (see file header). */
function ciScriptWithoutBun(): string {
  return readFileSync(join(REPO, "scripts", "ci"), "utf8")
    .split("\n")
    .filter((l) => !/^bunx?\s/.test(l))
    .join("\n");
}

const CHANGELOG_ON_MAIN = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "- an in-flight bullet",
  "",
  "## [0.9.246] - 2026-07-09",
  "",
  "- the released thing",
  "",
  "## [0.9.245] - 2026-07-08",
  "",
  "- the older released thing",
  "",
].join("\n");

const git = (cwd: string, args: string[]) =>
  spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

/**
 * Build a temp repo whose `main` carries CHANGELOG_ON_MAIN + a code file, then apply
 * `branchFiles` on a branch off it. Returns the repo path.
 */
function mkRepo(branchFiles: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "butchr-clog-race-"));
  spawnSync("git", ["init", "-q", "-b", "main", dir], { stdio: "ignore" });
  git(dir, ["config", "user.email", "test@butchr.local"]);
  git(dir, ["config", "user.name", "butchr test"]);
  writeFileSync(join(dir, "CHANGELOG.md"), CHANGELOG_ON_MAIN);
  writeFileSync(join(dir, "src.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "notes.md"), `A doc quoting a header:\n\n## [0.9.246] - 2026-07-09\n`);
  // Satisfies the gate's FE guard (see file header). It belongs in the BASE commit, never in
  // `branchFiles` — on the branch it would be a non-docs file in `git diff "$BASE"...HEAD` and
  // would perturb the very CHANGELOG assertions these tests exist to make.
  mkdirSync(join(dir, "public"), { recursive: true });
  writeFileSync(join(dir, "public", "app.js"), "export const a = 1;\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);

  git(dir, ["checkout", "-q", "-b", "task"]);
  for (const [path, body] of Object.entries(branchFiles)) writeFileSync(join(dir, path), body);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "task work"]);
  return dir;
}

/** Run the (bun-stripped) real scripts/ci in `repo` with BUTCHR_BASE_REF=main. */
function runCi(repo: string): { code: number; stderr: string } {
  const script = join(repo, "ci.sh");
  writeFileSync(script, ciScriptWithoutBun());
  chmodSync(script, 0o755);
  const r = spawnSync(script, [], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, BUTCHR_BASE_REF: "main" },
  });
  return { code: r.status ?? -1, stderr: r.stderr ?? "" };
}

function withRepo(files: Record<string, string>, fn: (r: ReturnType<typeof runCi>) => void) {
  const repo = mkRepo(files);
  try {
    fn(runCi(repo));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

describe("scripts/ci — CHANGELOG rebase-race guard", () => {
  test("FAILS when the diff DELETES a released version header, naming the dropped line", () => {
    // The exact shape of the real incident: the 0.9.246 header line vanishes, orphaning its
    // bullet under [Unreleased].
    const dropped = CHANGELOG_ON_MAIN.replace("## [0.9.246] - 2026-07-09\n", "");
    withRepo(
      { "CHANGELOG.md": dropped.replace("- an in-flight bullet", "- an in-flight bullet\n- mine") },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain("REBASE-RACE");
        // The offending LINE is printed, not just a count — the reviewer sees which release died.
        expect(stderr).toContain("-## [0.9.246] - 2026-07-09");
        // ...and the remedy.
        expect(stderr).toContain("Rebase onto the latest main");
      },
    );
  });

  test("names EVERY dropped header when a rebase eats more than one", () => {
    const dropped = CHANGELOG_ON_MAIN.replace("## [0.9.246] - 2026-07-09\n", "").replace(
      "## [0.9.245] - 2026-07-08\n",
      "",
    );
    withRepo({ "CHANGELOG.md": dropped }, ({ code, stderr }) => {
      expect(code).toBe(1);
      expect(stderr).toContain("-## [0.9.246] - 2026-07-09");
      expect(stderr).toContain("-## [0.9.245] - 2026-07-08");
    });
  });

  test("PASSES an ordinary [Unreleased] edit — bullets ADDED and REMOVED", () => {
    const edited = CHANGELOG_ON_MAIN.replace("- an in-flight bullet", "- a replacement bullet");
    withRepo({ "CHANGELOG.md": edited, "src.ts": "export const a = 2;\n" }, ({ code, stderr }) => {
      expect(stderr).not.toContain("REBASE-RACE");
      expect(code).toBe(0);
    });
  });

  test("PASSES a pure ADD under [Unreleased] (the normal branch shape)", () => {
    const added = CHANGELOG_ON_MAIN.replace(
      "## [Unreleased]\n",
      "## [Unreleased]\n\n- my new entry\n",
    );
    withRepo({ "CHANGELOG.md": added, "src.ts": "export const a = 2;\n" }, ({ code }) => {
      expect(code).toBe(0);
    });
  });

  test("does NOT fire on a removed [Unreleased] header (it starts with a letter, not a digit)", () => {
    const noUnreleased = CHANGELOG_ON_MAIN.replace("## [Unreleased]\n\n- an in-flight bullet\n", "");
    withRepo({ "CHANGELOG.md": noUnreleased }, ({ code, stderr }) => {
      expect(stderr).not.toContain("REBASE-RACE");
      expect(code).toBe(0);
    });
  });

  test("does NOT fire on an ADDED version header (the release stamp itself)", () => {
    const stamped = CHANGELOG_ON_MAIN.replace(
      "## [Unreleased]\n\n- an in-flight bullet\n",
      "## [Unreleased]\n\n## [0.9.247] - 2026-07-10\n\n- an in-flight bullet\n",
    );
    withRepo({ "CHANGELOG.md": stamped }, ({ code, stderr }) => {
      expect(stderr).not.toContain("REBASE-RACE");
      expect(code).toBe(0);
    });
  });

  test("the pathspec holds: a version header removed from a DOC does not trip the check", () => {
    // notes.md quotes `## [0.9.246]`; deleting that quote is a legitimate doc edit. Without the
    // `-- CHANGELOG.md` pathspec this diff would be reported as a dropped release.
    withRepo(
      {
        "notes.md": "A doc that no longer quotes a header.\n",
        "CHANGELOG.md": CHANGELOG_ON_MAIN.replace(
          "## [Unreleased]\n",
          "## [Unreleased]\n\n- doc cleanup\n",
        ),
      },
      ({ code, stderr }) => {
        expect(stderr).not.toContain("REBASE-RACE");
        expect(code).toBe(0);
      },
    );
  });

  test("the guard survives `set -euo pipefail` on the happy path (no-match grep must not kill it)", () => {
    // A no-op-ish branch: CHANGELOG untouched, docs-only diff (exempt from the update rule).
    // The guard's grep matches nothing; under pipefail an unguarded grep would exit 1 here.
    withRepo({ "notes.md": "just a doc tweak\n" }, ({ code, stderr }) => {
      expect(stderr).toBe("");
      expect(code).toBe(0);
    });
  });
});
