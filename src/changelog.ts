// Pure text transforms butchr uses to OWN the living-docs bookkeeping at merge
// time: appending a CHANGELOG `[Unreleased]` entry and patch-bumping the
// package.json version. Keeping these as side-effect-free string functions (no
// fs, no git) makes them unit-testable on synthetic input; src/git.ts reads the
// files, applies these, writes them back, and commits — see finalizeLivingDocs.
//
// WHY this moved off the agents: the old convention had every task hand-edit
// CHANGELOG.md (Unreleased) and bump package.json. Under concurrency every task
// touched those same two files, so they ALL collided at merge and each needed an
// auto-resolve pass. butchr now records the entry + bump itself, inside the
// serialized merge lock, AFTER the rebase — so the edit lands on the latest base
// content and two merges can't race the same lines.
import { collapseWs } from "./text.ts";

/**
 * The idempotency marker butchr stamps on every entry it generates, so re-merging
 * the same task (the entry already present) is a no-op rather than a second entry.
 */
export function taskMarker(id: string): string {
  return `(task ${id})`;
}

/**
 * Collapse a (possibly multi-line / empty) task summary into a single-line
 * changelog bullet body, falling back to a generic line keyed by task id when the
 * agent left no summary.
 */
export function summaryLine(summary: string | null | undefined, id: string): string {
  const s = collapseWs(summary ?? "");
  return s || `Changes from task ${id}`;
}

/**
 * Append a CHANGELOG entry for a finalized task under the `## [Unreleased]`
 * heading, returning the new file text — or `null` to signal "leave the file
 * alone". `null` is returned when there is no `[Unreleased]` section to append to,
 * OR when an entry for this task id is already present in that section (the
 * idempotency guard, keyed off `taskMarker(id)`), so a re-merge never double-adds.
 *
 * The bullet is filed under a `### Changed` group (butchr's default — it can't
 * reliably classify the change type the way a human author would), created right
 * after the `[Unreleased]` heading if that group doesn't exist yet, otherwise the
 * new bullet is inserted as the first item under the existing `### Changed`.
 */
export function insertUnreleasedEntry(
  text: string,
  summary: string | null | undefined,
  id: string,
): string | null {
  const marker = taskMarker(id);
  const lines = text.split("\n");

  // Locate the [Unreleased] heading. No section → nothing to append to.
  const unreleasedIdx = lines.findIndex((l) => /^##\s+\[Unreleased\]/i.test(l));
  if (unreleasedIdx === -1) return null;

  // The Unreleased section runs until the next "## " heading (the latest release).
  let endIdx = lines.length;
  for (let i = unreleasedIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i]!)) {
      endIdx = i;
      break;
    }
  }

  // Idempotency: this task's marker already in the Unreleased section → no-op.
  if (lines.slice(unreleasedIdx, endIdx).join("\n").includes(marker)) return null;

  const bullet = `- ${summaryLine(summary, id)} ${marker}`;

  // Insert under an existing "### Changed" group within the section, if present.
  for (let i = unreleasedIdx + 1; i < endIdx; i++) {
    if (/^###\s+Changed\s*$/.test(lines[i]!)) {
      lines.splice(i + 1, 0, bullet);
      return lines.join("\n");
    }
  }

  // No "### Changed" group yet — create one right after the [Unreleased] heading.
  lines.splice(unreleasedIdx + 1, 0, "", "### Changed", bullet);
  return lines.join("\n");
}

/**
 * Patch-bump the `"version": "x.y.z"` field of a package.json's raw text via a
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
 * Whether a repo-relative path is "docs" for the docs-only version-bump skip:
 * a markdown/text file (`.md`/`.mdx`/`.txt`) or anything under a `docs/` dir. A
 * diff that touches ONLY such files patch-bumps nothing (a pure prose change isn't
 * a new release surface); any non-docs file in the diff means a normal bump.
 */
export function isDocsPath(path: string): boolean {
  const lower = path.toLowerCase();
  return /\.(md|mdx|txt)$/.test(lower) || lower.startsWith("docs/");
}

/** True iff every path is a docs path (and there is at least one). */
export function isDocsOnlyDiff(paths: string[]): boolean {
  return paths.length > 0 && paths.every(isDocsPath);
}
