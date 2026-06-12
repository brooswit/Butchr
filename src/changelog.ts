// Pure, side-effect-free text helpers for butchr's TWO opt-in living-docs gates at
// merge / review time:
//
//  1. VERSION BUMP (opt-in, per-workspace) — `bumpPatchVersion` patch-bumps a
//     version file's `"version": "x.y.z"` field; `isDocsPath`/`isDocsOnlyDiff`
//     classify a diff so a pure-docs change skips the bump. butchr only bumps when a
//     workspace configures a version file (config.versionFile / the `version_file`
//     column) — not every repo has one. src/git.ts reads the file, applies the bump,
//     writes it back, and commits inside the merge lock — see git.bumpVersionFile.
//
//  2. CHANGELOG-UPDATE GATE (opt-in, per-workspace) — `checkChangelogUpdated` decides
//     whether a task's diff satisfies the rule "a code change must update the
//     changelog." butchr no longer WRITES the changelog at merge (it used to append a
//     fixed `[Unreleased]` bullet, which collided across concurrent tasks); the
//     task/agent now owns its entry and tasks.triggerCi enforces this check as an
//     advisory CI badge — see config.changelogPath / workspaces.workspaceChangelogPath.
//
// Keeping these as pure string functions (no fs, no git) makes them unit-testable on
// synthetic input (test/changelog.test.ts) independently of the merge/gate wiring.

/**
 * Patch-bump the `"version": "x.y.z"` field of a version file's raw text via a
 * targeted replace (preserving all other formatting/whitespace), returning the new
 * text plus the from/to versions — or `null` if no semver version field is found.
 * Only the patch component is incremented (the simple, safe default for a single
 * landed task); release-time minor/major bumps stay a manual call.
 */
export function bumpPatchVersion(
  text: string,
): { text: string; from: string; to: string } | null {
  const m = text.match(/("version"\s*:\s*")(\d+)\.(\d+)\.(\d+)(")/);
  if (!m) return null;
  const [whole, pre, maj, min, patch, post] = m;
  const from = `${maj}.${min}.${patch}`;
  const to = `${maj}.${min}.${parseInt(patch!, 10) + 1}`;
  return {
    text: text.replace(whole, `${pre}${maj}.${min}.${parseInt(patch!, 10) + 1}${post}`),
    from,
    to,
  };
}

/**
 * Whether a repo-relative path is "docs" for the docs-only skips: a markdown/text
 * file (`.md`/`.mdx`/`.txt`) or anything under a `docs/` dir. A diff that touches
 * ONLY such files patch-bumps nothing (a pure prose change isn't a new release
 * surface) and is exempt from the changelog gate (a code change is what must carry an
 * entry); any non-docs file in the diff means a normal bump / a required entry.
 */
export function isDocsPath(path: string): boolean {
  const lower = path.toLowerCase();
  return /\.(md|mdx|txt)$/.test(lower) || lower.startsWith("docs/");
}

/** True iff every path is a docs path (and there is at least one). */
export function isDocsOnlyDiff(paths: string[]): boolean {
  return paths.length > 0 && paths.every(isDocsPath);
}

/** Normalize a repo-relative path for comparison: forward slashes, no leading `./`, trimmed. */
function normalizeRel(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Verdict from the changelog-update gate (see checkChangelogUpdated). */
export type ChangelogCheck = {
  /** true → the diff satisfies the gate (entry present, or exempt). */
  ok: boolean;
  /** Human-readable reason, surfaced on the CI badge. */
  reason: string;
};

/**
 * The CHANGELOG-UPDATE GATE check: given a task's changed-file paths (relative to the
 * repo root) and the configured changelog `changelogPath`, decide whether the diff
 * satisfies "a code change must update the changelog." PURE — no fs/git — so the rule
 * is pinned independently of where the file list comes from.
 *
 *  - Blank `changelogPath` → the gate is disabled → ok (defensive; callers only invoke
 *    this when a path is configured).
 *  - A docs-only or empty diff → exempt → ok (a pure prose change, INCLUDING a
 *    changelog-only edit, needs no further entry — isDocsOnlyDiff treats `.md` as docs).
 *  - Otherwise (a code change) → ok IFF the changelog file is among the changed paths;
 *    a code change that didn't touch it FAILS, so the task adds its own entry.
 */
export function checkChangelogUpdated(
  paths: string[],
  changelogPath: string,
): ChangelogCheck {
  const target = normalizeRel(changelogPath);
  if (!target) {
    return { ok: true, reason: "changelog gate disabled (no path configured)" };
  }
  if (paths.length === 0 || isDocsOnlyDiff(paths)) {
    return { ok: true, reason: "docs-only or empty diff — no changelog entry required" };
  }
  const updated = paths.some((p) => normalizeRel(p) === target);
  if (updated) return { ok: true, reason: `${target} was updated` };
  return {
    ok: false,
    reason: `${target} was not updated — a code change must add a changelog entry`,
  };
}
