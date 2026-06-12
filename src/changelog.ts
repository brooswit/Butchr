// Pure, side-effect-free text helpers for butchr's living-docs gates at merge /
// review time:
//
//  1. VERSION BUMP (opt-in, per-workspace) — `bumpVersion` bumps a version file's
//     `"version": "x.y.z"` field by a declared LEVEL (patch/minor/major);
//     `isDocsPath`/`isDocsOnlyDiff` classify a diff so a pure-docs change skips the
//     bump (only OUTSIDE release_mode — see below). butchr only bumps when a workspace
//     configures a version file (config.versionFile / the `version_file` column) — not
//     every repo has one. src/git.ts reads the file, applies the bump, writes it back,
//     and commits inside the merge lock — see git.bumpVersionFile.
//
//  2. CHANGELOG-UPDATE GATE (opt-in, per-workspace) — `checkChangelogUpdated` decides
//     whether a task's diff satisfies the rule "a code change must update the
//     changelog." Outside release_mode butchr does NOT WRITE the changelog (it used to
//     append a fixed `[Unreleased]` bullet, which collided across concurrent tasks);
//     the task/agent owns its entry and tasks.triggerCi enforces this check as an
//     advisory CI badge — see config.changelogPath / workspaces.workspaceChangelogPath.
//
//  3. RELEASE STAMP (per-workspace release_mode) — `promoteUnreleased` moves the
//     current `## [Unreleased]` body into a versioned `## [X.Y.Z] - DATE` section and
//     leaves a fresh empty `## [Unreleased]` above it. butchr applies this at merge in
//     the SAME commit as the version bump (git.bumpVersionFile) so each merge OWNS its
//     own heading — ending the `[Unreleased]` cascade conflicts concurrent tasks kept
//     hitting. The task only authors prose under `[Unreleased]`; butchr relocates it.
//
// Keeping these as pure string functions (no fs, no git) makes them unit-testable on
// synthetic input (test/changelog.test.ts) independently of the merge/gate wiring.

/** A semantic-version bump level, declared per task. patch/minor allowed freely;
 * major is gated behind the human double-confirm ritual (see tasks.confirmMajor). */
export type VersionBumpLevel = "patch" | "minor" | "major";

/**
 * Bump the `"version": "x.y.z"` field of a version file's raw text by `level`, via a
 * targeted replace (preserving all other formatting/whitespace), returning the new
 * text plus the from/to versions — or `null` if no semver version field is found.
 *   - patch → x.y.(z+1)
 *   - minor → x.(y+1).0      (zeroes the patch)
 *   - major → (x+1).0.0      (zeroes minor + patch)
 */
export function bumpVersion(
  text: string,
  level: VersionBumpLevel = "patch",
): { text: string; from: string; to: string } | null {
  const m = text.match(/("version"\s*:\s*")(\d+)\.(\d+)\.(\d+)(")/);
  if (!m) return null;
  const [whole, pre, majS, minS, patchS, post] = m;
  const maj = parseInt(majS!, 10);
  const min = parseInt(minS!, 10);
  const patch = parseInt(patchS!, 10);
  const from = `${maj}.${min}.${patch}`;
  let to: string;
  if (level === "major") to = `${maj + 1}.0.0`;
  else if (level === "minor") to = `${maj}.${min + 1}.0`;
  else to = `${maj}.${min}.${patch + 1}`;
  return { text: text.replace(whole, `${pre}${to}${post}`), from, to };
}

/**
 * RELEASE STAMP (pure). Move the current `## [Unreleased]` section's body into a new
 * `## [version] - dateISO` section and leave a FRESH EMPTY `## [Unreleased]` heading
 * above it — so the next merge starts a clean `[Unreleased]` and each merge owns its
 * own versioned heading (the structural fix for the `[Unreleased]` cascade conflicts).
 *
 * Behavior:
 *  - If an `## [Unreleased]` heading exists, its body (everything up to the next
 *    `## ` heading, or EOF) is relocated verbatim under the new versioned heading; a
 *    fresh empty `## [Unreleased]` is left in its place.
 *  - If there is NO `## [Unreleased]` heading, the versioned section is inserted at the
 *    top of the body — immediately ABOVE the first existing `## ` section heading, or
 *    appended at the end if there are none — without inventing an `[Unreleased]`.
 *  - The trailing `[Unreleased]: <url>` link-reference footer (if any) is left
 *    untouched — it lives below the version sections and is editorial.
 *
 * Pure string transform (no fs/git); `dateISO` is passed in (callers stamp the date)
 * so it stays deterministic and unit-testable.
 */
export function promoteUnreleased(
  changelogText: string,
  version: string,
  dateISO: string,
): string {
  const versioned = `## [${version}] - ${dateISO}`;
  const lines = changelogText.split("\n");

  // Find the `## [Unreleased]` heading (case-insensitive on the word, exact bracket).
  const unrelIdx = lines.findIndex((l) => /^##\s*\[Unreleased\]\s*$/i.test(l));

  // The index of the FIRST `## ` section heading at/after `from` (a version section
  // boundary), or -1 if none. Used to bound the section body.
  const nextHeadingAfter = (from: number): number => {
    for (let i = from; i < lines.length; i++) {
      if (/^##\s+/.test(lines[i]!)) return i;
    }
    return -1;
  };

  if (unrelIdx === -1) {
    // No [Unreleased] heading — insert the versioned section above the first `## `
    // section heading, or append it at the end.
    const firstHeading = nextHeadingAfter(0);
    const block = [versioned, ""];
    if (firstHeading === -1) {
      const out = changelogText.replace(/\n*$/, "\n");
      return `${out}\n${versioned}\n`;
    }
    lines.splice(firstHeading, 0, ...block);
    return lines.join("\n");
  }

  // Body = everything after the `## [Unreleased]` line up to (excluding) the next
  // `## ` heading, or EOF.
  const bodyStart = unrelIdx + 1;
  const nextHeading = nextHeadingAfter(bodyStart);
  const bodyEnd = nextHeading === -1 ? lines.length : nextHeading;
  const body = lines.slice(bodyStart, bodyEnd);

  // Rebuild: fresh empty [Unreleased] (heading + one blank line), then the versioned
  // heading carrying the relocated body, then the remainder (the old version sections
  // + footer) unchanged.
  const before = lines.slice(0, unrelIdx);
  const after = lines.slice(bodyEnd);
  const rebuilt = [
    ...before,
    "## [Unreleased]",
    "",
    versioned,
    ...body,
    ...after,
  ];
  return rebuilt.join("\n");
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
 *  - An EMPTY diff → exempt → ok (nothing landed, so nothing to record).
 *  - A docs-only diff → exempt → ok (a pure prose change, INCLUDING a changelog-only
 *    edit, needs no further entry) — UNLESS `strict` is set (see below).
 *  - Otherwise (a code change) → ok IFF the changelog file is among the changed paths;
 *    a code change that didn't touch it FAILS, so the task adds its own entry.
 *
 * `strict` (release_mode): EVERY non-empty diff must touch the changelog — the
 * docs-only exemption is dropped, because in release_mode every change bumps the
 * version and stamps a versioned changelog entry, so even a docs-only change must
 * author one. (An empty diff stays exempt — there is genuinely nothing to record.)
 */
export function checkChangelogUpdated(
  paths: string[],
  changelogPath: string,
  opts: { strict?: boolean } = {},
): ChangelogCheck {
  const target = normalizeRel(changelogPath);
  if (!target) {
    return { ok: true, reason: "changelog gate disabled (no path configured)" };
  }
  if (paths.length === 0) {
    return { ok: true, reason: "empty diff — no changelog entry required" };
  }
  if (!opts.strict && isDocsOnlyDiff(paths)) {
    return { ok: true, reason: "docs-only diff — no changelog entry required" };
  }
  const updated = paths.some((p) => normalizeRel(p) === target);
  if (updated) return { ok: true, reason: `${target} was updated` };
  return {
    ok: false,
    reason: `${target} was not updated — a code change must add a changelog entry`,
  };
}

// === ADDITIVE-CONFLICT UNION (merge-lock safety net) =======================
// The single riskiest manual ritual the CTO reaches around butchr for: a merge-lock
// rebase that bounces a TRIVIAL ADDITIVE changelog conflict (both sides only ADDED
// bullets under the same heading) back to an agent, which garbles it. This pure
// resolver mechanically UNIONs exactly that shape and NOTHING else — see
// git.tryUnionChangelogConflict for the (heavily-guarded) wiring. Kept here as a
// pure string transform so the whole safety case is unit-testable (test/changelog.test.ts)
// on synthetic diff3 input, independent of git.

/** A diff3 conflict marker test: 7 of the marker char, then a space or EOL. */
const isStart = (l: string): boolean => /^<{7}( |$)/.test(l); // <<<<<<< ours
const isAncestor = (l: string): boolean => /^\|{7}( |$)/.test(l); // ||||||| ancestor
const isSep = (l: string): boolean => /^={7}( |$)/.test(l); // =======
const isEnd = (l: string): boolean => /^>{7}( |$)/.test(l); // >>>>>>> theirs

/** A line that may be ADDED in a purely-additive changelog union: a list bullet
 * (`- `/`* `/`+ `, any indent) or a blank line. Anything else (prose, a heading,
 * an edited body line) makes the hunk non-additive → the union bails. */
function isAdditiveLine(l: string): boolean {
  return l.trim() === "" || /^\s*[-*+]\s/.test(l);
}

/** A markdown heading (`#`..`######`). A conflict hunk that contains one straddles a
 * section boundary, so the union NEVER fires across it (operator guard-rail 2). */
function isHeading(l: string): boolean {
  return /^#{1,6}\s/.test(l);
}

/**
 * Split one side of a diff3 hunk into the gaps AROUND the ancestor "anchor" lines:
 * `gaps[k]` holds the lines this side ADDED between anchor k-1 and anchor k (gaps[0]
 * before the first anchor, gaps[anchors.length] after the last). Requires `anchors`
 * to appear as an in-ORDER subsequence of `side` (every ancestor line preserved, none
 * edited or removed) and every added line to be additive — returns null otherwise, so
 * any non-additive change (an edited/removed ancestor line, a non-bullet addition)
 * bounces the whole resolve.
 */
function splitByAnchors(side: string[], anchors: string[]): string[][] | null {
  const gaps: string[][] = Array.from({ length: anchors.length + 1 }, () => []);
  let j = 0; // next ancestor anchor to match
  for (const line of side) {
    if (j < anchors.length && line === anchors[j]) {
      j++; // consumed an anchor; subsequent additions fall in the next gap
    } else {
      if (!isAdditiveLine(line)) return null; // a non-bullet edit → not additive
      gaps[j]!.push(line);
    }
  }
  if (j !== anchors.length) return null; // an ancestor line was edited/removed
  return gaps;
}

/**
 * UNION a purely-additive changelog conflict. Takes the FULL file text WITH diff3
 * conflict markers (`<<<<<<<` / `|||||||` ancestor / `=======` / `>>>>>>>` — diff3
 * style is REQUIRED so we can see the common ancestor) and returns the resolved text,
 * or `null` to BOUNCE (the safe default — hand it to the agent) for ANYTHING that
 * isn't an unambiguous additive bullet union.
 *
 * A hunk unions IFF, relative to the common ancestor, BOTH sides only ADDED bullet
 * (or blank) lines and neither edited or removed an ancestor line (splitByAnchors).
 * The union keeps the ancestor anchors in place and, in each gap, emits OURS-added
 * bullets then THEIRS-added bullets — deterministic, newest-bullets-preserved order.
 *
 * Bounces to null on: a 2-way (non-diff3) or malformed/unterminated hunk; a hunk that
 * contains ANY markdown heading (would union across a `## ` section boundary); a
 * non-additive change on either side; or no conflict hunk at all. Pure — no fs/git.
 */
export function unionAdditiveChangelogConflict(diff3Text: string): string | null {
  const lines = diff3Text.split("\n");
  const out: string[] = [];
  let sawHunk = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!isStart(line)) {
      out.push(line);
      continue;
    }
    // Parse one hunk: ours … |||||| ancestor … ======= theirs … >>>>>>>
    sawHunk = true;
    const ours: string[] = [];
    const ancestor: string[] = [];
    const theirs: string[] = [];
    i++;
    while (i < lines.length && !isAncestor(lines[i]!)) {
      if (isSep(lines[i]!) || isEnd(lines[i]!) || isStart(lines[i]!)) return null; // malformed / 2-way (no ancestor)
      ours.push(lines[i]!);
      i++;
    }
    if (i >= lines.length) return null; // unterminated: missing ancestor marker
    i++; // skip the |||||||
    while (i < lines.length && !isSep(lines[i]!)) {
      if (isEnd(lines[i]!) || isStart(lines[i]!) || isAncestor(lines[i]!)) return null;
      ancestor.push(lines[i]!);
      i++;
    }
    if (i >= lines.length) return null; // unterminated: missing =======
    i++; // skip the =======
    while (i < lines.length && !isEnd(lines[i]!)) {
      if (isSep(lines[i]!) || isStart(lines[i]!) || isAncestor(lines[i]!)) return null;
      theirs.push(lines[i]!);
      i++;
    }
    if (i >= lines.length) return null; // unterminated: missing >>>>>>>
    // (loop's i++ steps past the >>>>>>> end marker.)

    // GUARD: never union across a section boundary — a heading anywhere in the hunk
    // means the conflict isn't a within-section bullet add.
    if ([...ours, ...ancestor, ...theirs].some(isHeading)) return null;

    const oursGaps = splitByAnchors(ours, ancestor);
    const theirsGaps = splitByAnchors(theirs, ancestor);
    if (!oursGaps || !theirsGaps) return null; // a non-additive change → bounce

    // Reconstruct: ours-added then theirs-added in each gap, anchors preserved.
    for (let k = 0; k <= ancestor.length; k++) {
      out.push(...oursGaps[k]!, ...theirsGaps[k]!);
      if (k < ancestor.length) out.push(ancestor[k]!);
    }
  }

  if (!sawHunk) return null; // nothing to resolve — let the caller bounce
  return out.join("\n");
}
