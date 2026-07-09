// Tests for the PHANTOM-RELEASE / merge work-loss GUARD (story st-3988b68e).
//
// INCIDENT (0.9.150): under the high-velocity CHANGELOG rebase-race, a task's conflict
// resolution (`git reset --soft main` + re-commit) re-committed ONLY the CHANGELOG and
// silently DROPPED the code commits; the subsequent merge rebase was clean (the branch
// carried only the CHANGELOG promotion) so the gate cut an EMPTY release — a package.json
// bump + CHANGELOG header with the real fix never reaching main. The merge funnels all three
// entry points through git.merge, which now — AFTER the rebase, BEFORE the bump + ff — asserts
// the rebased branch still CARRIES the task's code (git.detectPhantomDrop), comparing the
// task's ORIGINAL code-file set (its durable review-time `code_files` footprint, captured
// BEFORE the agent's reset --soft could erase it — NON-SHRINKING) against the rebased tip's
// NET code diff. A drop REFUSES the ff (no release, branch preserved) and bounces the task.
//
// Two halves:
//  1. PURE unit tests of detectPhantomDrop — each defense layer (structural / durable / belt)
//     proven in isolation, and the no-false-block case.
//  2. END-TO-END through approveTask → finalizeMerge → git.merge on a REAL throwaway repo +
//     worktree (verify runner stubbed GREEN, BUTCHR_HERDR_BIN=`true`), asserting what actually
//     lands (or doesn't) on main. Mirrors test/finalize-release-integrity.test.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
const WS_ID = "phantom-guard-ws";

let tasksMod: typeof import("../src/tasks.ts");
let gitMod: typeof import("../src/git.ts");
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
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-phantom-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-phantom-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

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
  gitMod = await import("../src/git.ts");
  verifyMod = await import("../src/verify.ts");
  wsMod = await import("../src/workspaces.ts");

  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(WS_ID, REPO_ROOT, "test", dbMod.nowIso());
  // Versioned-releases ON so a (non-)release is observable via released_version + the changelog.
  wsMod.updateWorkspaceVersionFile(WS_ID, "package.json");
  // changelog_path is READ-ONLY-INERT (no setter) but still read by the release stamp — set the column directly.
  dbMod.db.query(`UPDATE directory SET changelog_path=? WHERE id=?`).run("CHANGELOG.md", WS_ID);
  wsMod.setWorkspaceReleaseMode(WS_ID, true);
  // Verify gate stubbed GREEN for the whole suite (restored in afterAll) so a mechanical merge
  // reaches the real git.merge / phantom guard deterministically.
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
function branchExists(id: string): boolean {
  try {
    g(["rev-parse", "--verify", "--quiet", `refs/heads/${id}`]);
    return true;
  } catch {
    return false;
  }
}
function mainHasFile(path: string): boolean {
  try {
    g(["cat-file", "-e", `main:${path}`]);
    return true;
  } catch {
    return false;
  }
}

/** Seed a REAL review task: branch a worktree off main, optionally commit `file` (the task's
 *  CODE), ALWAYS author an [Unreleased] bullet, commit, and move it to in_review so the
 *  mechanical merge runs on approve. Returns the task id + its worktree dir. */
async function seedReviewTask(
  title: string,
  file: string | null,
  content: string,
): Promise<{ id: string; wt: string }> {
  const view = await tasksMod.createTask(
    WS_ID, title, [], [], "task", null, [], 0, false, false, "patch",
  );
  const id = view.id;
  const wt = join(REPO_ROOT, id);
  if (file) writeFileSync(join(wt, file), content);
  const cl = readFileSync(join(wt, "CHANGELOG.md"), "utf8").replace(
    "## [Unreleased]",
    `## [Unreleased]\n\n### Added\n- ${title}`,
  );
  writeFileSync(join(wt, "CHANGELOG.md"), cl);
  g(["add", "-A"], wt);
  g(["commit", "-q", "-m", title], wt);
  dbMod.db.query(`UPDATE tasks SET status='in_review' WHERE id=?`).run(id);
  taskmdMod.updateTaskMdStatus(REPO_ROOT, id, "in_review");
  return { id, wt };
}

/** Model the corrupting CHANGELOG-only conflict resolution: drop ALL of the task's code and
 *  re-commit ONLY a CHANGELOG bullet, leaving a CLEAN tree (so git.merge's dangling-commit
 *  step can't re-add the code). The net effect of the incident's `reset --soft` + selective
 *  re-commit, reproduced deterministically. */
function dropCodeKeepChangelogOnly(id: string, wt: string, bullet: string): void {
  g(["reset", "--hard", "main"], wt); // wipe the code commit AND the worktree code file
  const cl = readFileSync(join(wt, "CHANGELOG.md"), "utf8").replace(
    "## [Unreleased]",
    `## [Unreleased]\n\n### Added\n- ${bullet}`,
  );
  writeFileSync(join(wt, "CHANGELOG.md"), cl);
  g(["add", "CHANGELOG.md"], wt);
  g(["commit", "-q", "-m", "changelog only (dropped code)"], wt);
}

// ---------------------------------------------------------------------------------------------
// 1. PURE unit — each defense layer in isolation.
// ---------------------------------------------------------------------------------------------
describe("detectPhantomDrop — each layer fires (or not) in isolation", () => {
  const baseArgs = { releaseMode: true, isRollback: false, isCodeTask: false };

  test("(A) structural — code present at merge entry, gone after rebase", () => {
    const v = gitMod.detectPhantomDrop({
      ...baseArgs, preRebaseCode: ["src/x.ts"], originalCodeFiles: [], netCode: [],
    });
    expect(v).not.toBeNull();
    expect(v!.missing).toEqual(["src/x.ts"]);
  });

  test("(B) durable — the review-time footprint's code is missing after rebase", () => {
    const v = gitMod.detectPhantomDrop({
      ...baseArgs, preRebaseCode: [], originalCodeFiles: ["src/x.ts"], netCode: [],
    });
    expect(v).not.toBeNull();
    expect(v!.missing).toEqual(["src/x.ts"]);
  });

  test("(B) durable — partial drop (one of several original files gone) still fires", () => {
    const v = gitMod.detectPhantomDrop({
      ...baseArgs, preRebaseCode: [], originalCodeFiles: ["a.ts", "b.ts"], netCode: ["a.ts"],
    });
    expect(v).not.toBeNull();
    expect(v!.missing).toEqual(["b.ts"]);
  });

  test("(BELT) empty-net release for a KNOWN code task — fires even with both per-file sets empty", () => {
    const v = gitMod.detectPhantomDrop({
      preRebaseCode: [], originalCodeFiles: [], netCode: [],
      releaseMode: true, isRollback: false, isCodeTask: true,
    });
    expect(v).not.toBeNull();
  });

  test("(BELT) a ROLLBACK task is exempt from the empty-net release check", () => {
    const v = gitMod.detectPhantomDrop({
      preRebaseCode: [], originalCodeFiles: [], netCode: [],
      releaseMode: true, isRollback: true, isCodeTask: true,
    });
    expect(v).toBeNull();
  });

  test("NO false block — a pure docs/changelog task (empty sets, non-code) merges", () => {
    const v = gitMod.detectPhantomDrop({
      preRebaseCode: [], originalCodeFiles: [], netCode: [],
      releaseMode: true, isRollback: false, isCodeTask: false,
    });
    expect(v).toBeNull();
  });

  test("NO false block — code that SURVIVED the rebase is not flagged", () => {
    const v = gitMod.detectPhantomDrop({
      preRebaseCode: ["src/x.ts"], originalCodeFiles: ["src/x.ts"], netCode: ["src/x.ts"],
      releaseMode: true, isRollback: false, isCodeTask: true,
    });
    expect(v).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// RENAME NORMALIZATION. The guard compares two captures of the same branch: `code_files`
// (diffStat → `git diff --numstat`) against `netCode` (changedCodeFiles → `git diff --name-only`).
// numstat spells a rename-detected file as `dir/{old.js => new.ts}`; name-only prints only
// `dir/new.ts`. Unnormalized, EVERY rename read as a dropped file and refused the merge forever.
// accumulateNumstat now stores the destination, so the two captures agree by construction.
// ---------------------------------------------------------------------------------------------

describe("accumulateNumstat — rename paths normalize to the destination", () => {
  function parse(output: string) {
    const files = new Set<string>();
    const counts = { lines: 0 };
    gitMod.accumulateNumstat(output, files, counts);
    return { files: [...files], lines: counts.lines };
  }

  test("compressed rename with a common PREFIX keeps the prefix and the new basename", () => {
    const r = parse("16\t13\tpublic/core/{format.js => format.ts}");
    expect(r.files).toEqual(["public/core/format.ts"]);
    expect(r.lines).toBe(29); // unchanged: numstat's +/- on a rename is already the content delta
  });

  test("compressed rename of a middle DIRECTORY keeps the trailing suffix", () => {
    const r = parse("3\t1\tdir/{a => b}/file.ts");
    expect(r.files).toEqual(["dir/b/file.ts"]);
    expect(r.lines).toBe(4);
  });

  test("compressed rename with an EMPTY side does not leave a doubled slash", () => {
    expect(parse("1\t0\tdir/{ => sub}/f.ts").files).toEqual(["dir/sub/f.ts"]);
    expect(parse("0\t1\tdir/{sub => }/f.ts").files).toEqual(["dir/f.ts"]);
  });

  test("bare rename (no common prefix or suffix) yields only the destination", () => {
    const r = parse("5\t4\told/a.js => new/b.ts");
    expect(r.files).toEqual(["new/b.ts"]);
    expect(r.lines).toBe(9);
  });

  test("a normal path passes through untouched", () => {
    const r = parse("7\t2\tsrc/git.ts");
    expect(r.files).toEqual(["src/git.ts"]);
    expect(r.lines).toBe(9);
  });

  test("a BINARY line (`-\\t-\\tpath`) counts zero lines and still records the file", () => {
    const r = parse("-\t-\tpublic/logo.png");
    expect(r.files).toEqual(["public/logo.png"]);
    expect(r.lines).toBe(0);
  });

  test("a binary RENAME normalizes too, still counting zero lines", () => {
    const r = parse("-\t-\tpublic/{old.png => new.png}");
    expect(r.files).toEqual(["public/new.png"]);
    expect(r.lines).toBe(0);
  });

  test("mixed output accumulates every shape into one deduped set + line total", () => {
    const r = parse(
      ["16\t13\tpublic/core/{format.js => format.ts}", "7\t2\tsrc/git.ts", "-\t-\tlogo.png", ""].join("\n"),
    );
    expect(r.files.sort()).toEqual(["logo.png", "public/core/format.ts", "src/git.ts"]);
    expect(r.lines).toBe(38);
  });

  // The QUIETER second bug, same root cause: estimate.classifyPathType is fed this same
  // `code_files` set. A raw brace path ends in `}`, so the EXTENSION rules never match and a
  // docs-only rename was labelled `core` — a CODE task, which feeds the guard's BELT layer and
  // auto-merge's risk classification. Normalizing upstream fixes it with no change to estimate.ts.
  test("the normalized set classifies correctly — a docs-only rename is NOT a code task", async () => {
    const { classifyPathType } = await import("../src/estimate.ts");
    expect(classifyPathType(parse("2\t1\t{guide.md => manual.md}").files)).toBe("docs");
    expect(classifyPathType(["{guide.md => manual.md}"])).toBe("core"); // the bug, pinned
    expect(classifyPathType(parse("16\t13\tpublic/core/{format.js => format.ts}").files)).toBe("webapp");
  });
});

describe("detectPhantomDrop — a renamed file is NOT a dropped file", () => {
  const RENAMED = "public/core/format.ts";

  test("the durable footprint of a rename matches the rebased net diff — merges", () => {
    // originalCodeFiles as accumulateNumstat now records it (destination), netCode as
    // changedCodeFiles reports it. Pre-fix, code_files held `public/core/{format.js => format.ts}`
    // and this returned a spurious drop, bouncing the task forever.
    const v = gitMod.detectPhantomDrop({
      preRebaseCode: [RENAMED], originalCodeFiles: [RENAMED], netCode: [RENAMED],
      releaseMode: true, isRollback: false, isCodeTask: true,
    });
    expect(v).toBeNull();
  });

  test("the RAW brace form would have false-positived — proving what the fix removes", () => {
    const v = gitMod.detectPhantomDrop({
      preRebaseCode: [], originalCodeFiles: ["public/core/{format.js => format.ts}"],
      netCode: [RENAMED], releaseMode: true, isRollback: false, isCodeTask: true,
    });
    expect(v).not.toBeNull(); // the bug, pinned: the un-normalized spelling never matches
  });

  test("NOT VACUOUS — a genuinely dropped file alongside a surviving rename still fires", () => {
    const v = gitMod.detectPhantomDrop({
      preRebaseCode: [], originalCodeFiles: [RENAMED, "src/real-fix.ts"], netCode: [RENAMED],
      releaseMode: true, isRollback: false, isCodeTask: true,
    });
    expect(v).not.toBeNull();
    expect(v!.missing).toEqual(["src/real-fix.ts"]); // the rename is not blamed
  });

  test("NOT VACUOUS — a rebase that drops the renamed file itself still fires", () => {
    const v = gitMod.detectPhantomDrop({
      preRebaseCode: [], originalCodeFiles: [RENAMED], netCode: [],
      releaseMode: true, isRollback: false, isCodeTask: true,
    });
    expect(v).not.toBeNull();
    expect(v!.missing).toEqual([RENAMED]);
  });
});

// REAL GIT, in a throwaway repo: prove diffStat and changedCodeFiles agree on a
// rename-detected branch — the exact `p4a-salvage` shape this hotfix unblocks.
describe("diffStat vs changedCodeFiles agree on a REAL rename-bearing branch", () => {
  let RENAME_REPO: string;
  const BRANCH = "rename-fixture";
  const BODY = Array.from({ length: 40 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n";

  beforeAll(() => {
    RENAME_REPO = mkdtempSync(join(tmpdir(), "butchr-rename-"));
    const gg = (args: string[]) => execFileSync("git", ["-C", RENAME_REPO, ...args], { stdio: "ignore" });
    execFileSync("git", ["init", "-q", "-b", "main", RENAME_REPO], { stdio: "ignore" });
    gg(["config", "user.email", "test@butchr.local"]);
    gg(["config", "user.name", "butchr test"]);
    // A root-level rename spells BARE (`a => b`); one under a shared directory spells
    // COMPRESSED (`dir/{a => b}`). Cover both shapes git actually emits.
    mkdirSync(join(RENAME_REPO, "public", "core"), { recursive: true });
    writeFileSync(join(RENAME_REPO, "format.js"), BODY);
    writeFileSync(join(RENAME_REPO, "public/core/state.js"), BODY);
    gg(["add", "-A"]);
    gg(["commit", "-q", "-m", "init"]);
    gg(["checkout", "-q", "-b", BRANCH]);
    gg(["mv", "format.js", "format.ts"]);
    gg(["mv", "public/core/state.js", "public/core/state.ts"]);
    // Small edits so each stays >50% similar: git rename-DETECTS them (a heavy rewrite is delete+add).
    writeFileSync(join(RENAME_REPO, "format.ts"), BODY + "export const added = true;\n");
    writeFileSync(join(RENAME_REPO, "public/core/state.ts"), BODY + "export const added = true;\n");
    gg(["add", "-A"]);
    gg(["commit", "-q", "-m", "rename js->ts"]);
    gg(["checkout", "-q", "main"]);
  });
  afterAll(() => rmSync(RENAME_REPO, { recursive: true, force: true }));

  test("git really rename-detects the fixture, in BOTH spellings (else this proves nothing)", () => {
    const raw = execFileSync("git", ["-C", RENAME_REPO, "diff", "--numstat", `main...${BRANCH}`], {
      encoding: "utf8",
    });
    expect(raw).toContain("format.js => format.ts"); // bare
    expect(raw).toContain("public/core/{state.js => state.ts}"); // compressed
  });

  test("the two captures agree, and the guard does NOT fire", async () => {
    const stat = await gitMod.diffStat(RENAME_REPO, BRANCH, "main");
    const net = await gitMod.changedCodeFiles(RENAME_REPO, "main", BRANCH);
    const expected = ["format.ts", "public/core/state.ts"];
    expect(stat.files.sort()).toEqual(expected);
    expect(net.sort()).toEqual(expected);
    expect(stat.changedLines).toBe(2); // content delta only — the renames themselves cost nothing

    const v = gitMod.detectPhantomDrop({
      preRebaseCode: net, originalCodeFiles: stat.files, netCode: net,
      releaseMode: true, isRollback: false, isCodeTask: true,
    });
    expect(v).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// 2. END-TO-END through approveTask → finalizeMerge → git.merge.
// ---------------------------------------------------------------------------------------------
describe("(a) a task whose rebase DROPS its code is ABORTED — the 0.9.150 replay", () => {
  test("non-shrinking footprint survives a code-less re-capture; the guard then bounces the merge", async () => {
    const mainBefore = g(["rev-parse", "HEAD"]);
    const versionBefore = version();
    const changelogBefore = changelog();

    const { id, wt } = await seedReviewTask("Add feature.ts", "feature.ts", "export const x = 1;\n");

    // GREEN-time footprint capture: records the task's code file.
    await tasksMod.captureDiffFootprint(id);
    expect(row(id).code_files).toBe(JSON.stringify(["feature.ts"]));

    // The corrupting resolution drops the code, then a code-less RE-CAPTURE must NOT erase the
    // footprint (the NON-SHRINKING invariant — the whole reason the guard isn't blind to 0.9.150).
    dropCodeKeepChangelogOnly(id, wt, "feature landed (changelog only)");
    await tasksMod.captureDiffFootprint(id);
    expect(row(id).code_files).toBe(JSON.stringify(["feature.ts"]));

    // Approve → the guard sees the durable footprint's code missing from the rebased tip → ABORT.
    await tasksMod.approveTask(id);

    const r = row(id);
    expect(r.status).not.toBe("merged");
    expect(r.released_version ?? null).toBeNull();
    // Bounced through the SAME conflict/requestChanges path: re-queued to its agent (inactive)
    // with the guard message naming the dropped file in the review note.
    expect(r.status).toBe("inactive");
    expect(r.review_note).toMatch(/phantom-release guard/);
    expect(r.review_note).toMatch(/feature\.ts/);
    // Nothing landed: main, the version file, and the changelog are byte-for-byte unchanged.
    expect(g(["rev-parse", "HEAD"])).toBe(mainBefore);
    expect(version()).toBe(versionBefore);
    expect(changelog()).toBe(changelogBefore);
    expect(mainHasFile("feature.ts")).toBe(false);
    // The work survives — the branch is preserved for re-resolution, not deleted.
    expect(branchExists(id)).toBe(true);
  });
});

describe("(b) a normal task whose code SURVIVES the rebase merges fine", () => {
  test("merges + cuts a real release; the code is on main", async () => {
    const { id } = await seedReviewTask("Add survives.ts", "survives.ts", "export const y = 2;\n");
    await tasksMod.captureDiffFootprint(id);
    expect(row(id).code_files).toBe(JSON.stringify(["survives.ts"]));

    await tasksMod.approveTask(id);

    const r = row(id);
    expect(r.status).toBe("merged");
    expect(r.released_version).toBeTruthy(); // a real version was assigned + stamped
    expect(mainHasFile("survives.ts")).toBe(true);
  });
});

describe("(c) a legit CHANGELOG-only task (no original code) is NOT falsely blocked", () => {
  test("merges + releases despite carrying zero code files", async () => {
    const { id } = await seedReviewTask("Docs only", null, "");
    await tasksMod.captureDiffFootprint(id);
    // No code files captured (the changelog is excluded); path_type is non-code.
    expect(row(id).code_files).toBe(JSON.stringify([]));
    expect(row(id).path_type).toBe("docs");

    await tasksMod.approveTask(id);

    const r = row(id);
    expect(r.status).toBe("merged");
    expect(r.released_version).toBeTruthy();
  });
});

describe("(d) the empty-release BELT rejects a zero-net-code release for a code task", () => {
  test("a known code task (path_type=core) that nets no code is refused — even with the per-file footprint lost", async () => {
    const mainBefore = g(["rev-parse", "HEAD"]);
    const versionBefore = version();

    const { id, wt } = await seedReviewTask("Add belt.ts", "belt.ts", "export const z = 3;\n");
    await tasksMod.captureDiffFootprint(id);
    // KNOWN code task: path_type is classified from the CODE-only set (belt.ts) — the CHANGELOG
    // bullet is an excluded bump surface, not code — so it lands as 'core' (non-docs), making
    // isCodeTask true so the belt can fire.
    expect(row(id).path_type).toBe("core");

    // Isolate the BELT: clear the per-file footprint (simulating it being lost/empty) but KEEP
    // the coarse code path_type, so layers (A)/(B) cannot fire and only the belt is left to catch it.
    dbMod.db.query(`UPDATE tasks SET code_files='[]' WHERE id=?`).run(id);
    dropCodeKeepChangelogOnly(id, wt, "belt landed (changelog only)");

    await tasksMod.approveTask(id);

    const r = row(id);
    expect(r.status).not.toBe("merged");
    expect(r.released_version ?? null).toBeNull();
    expect(g(["rev-parse", "HEAD"])).toBe(mainBefore);
    expect(version()).toBe(versionBefore);
    expect(mainHasFile("belt.ts")).toBe(false);
    expect(branchExists(id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. REGRESSION (story st-395141ad): a VERSION-FILE-ONLY task must NOT be falsely blocked by the
//    BELT. Root cause: path_type was classified from the RAW changed set, counting the version
//    file (package.json → 'core') as code, so isCodeTask was true while the per-file code_files
//    set (version/changelog excluded) was empty → the belt bounced a legit release. The capture
//    layer now classifies path_type from the SAME code-only set as code_files.
// ---------------------------------------------------------------------------------------------
describe("(e) a VERSION-FILE-ONLY task is NOT falsely blocked by the BELT", () => {
  test("path_type is 'docs' (no code), so it merges + cuts a real release that lands on main", async () => {
    // Its only non-changelog change edits the configured version file (package.json) itself —
    // here a benign field, not the version (the merge bump owns the version field).
    const { id } = await seedReviewTask(
      "Edit package.json",
      "package.json",
      `{\n  "name": "demo-versiononly",\n  "version": "0.9.0"\n}\n`,
    );
    await tasksMod.captureDiffFootprint(id);
    // The version file is an excluded bump surface → zero CODE files → path_type 'docs' (NOT
    // 'core'), so isCodeTask is false and the belt cannot fire.
    expect(row(id).code_files).toBe(JSON.stringify([]));
    expect(row(id).path_type).toBe("docs");

    await tasksMod.approveTask(id);

    const r = row(id);
    expect(r.status).toBe("merged"); // not bounced by a phantom-release false positive
    expect(r.released_version).toBeTruthy(); // a real version was assigned + stamped
    // The change actually landed (a REAL release, not a phantom): main's package.json carries
    // the edited field alongside the bumped version.
    expect(JSON.parse(g(["show", "main:package.json"])).name).toBe("demo-versiononly");
  });
});

describe("(f) the fix does not UNDER-flag — a version-file + real-code task stays a code task", () => {
  test("path_type 'core' and code_files=['feat.ts'] (version file excluded) keep isCodeTask true", async () => {
    const { id, wt } = await seedReviewTask("Add feat.ts", "feat.ts", "export const q = 1;\n");
    // ALSO touch the version file in the same task → its changed set is feat.ts + package.json +
    // CHANGELOG. The code-only footprint must drop the version/changelog but KEEP feat.ts.
    writeFileSync(join(wt, "package.json"), `{\n  "name": "demo-mixed",\n  "version": "0.9.0"\n}\n`);
    g(["add", "-A"], wt);
    g(["commit", "-q", "-m", "also touch version file"], wt);

    await tasksMod.captureDiffFootprint(id);
    expect(row(id).code_files).toBe(JSON.stringify(["feat.ts"]));
    expect(row(id).path_type).toBe("core"); // non-docs → isCodeTask stays true, guard armed
  });
});
