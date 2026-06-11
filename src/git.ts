// Git operations butchr owns directly. All run against a directory root that
// is a git repository. Task branches/worktrees are named by task ID.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  bumpPatchVersion,
  insertUnreleasedEntry,
  isDocsOnlyDiff,
} from "./changelog.ts";
import { config } from "./config.ts";
import { run, runOrThrow, type ExecResult } from "./exec.ts";

const git = config.gitBin;

export async function isGitRepo(dir: string): Promise<boolean> {
  if (!existsSync(dir)) return false;
  const res = await run([git, "-C", dir, "rev-parse", "--is-inside-work-tree"]);
  return res.ok && res.stdout.trim() === "true";
}

/** Resolve the repo's default branch (the merge target). Falls back to HEAD's branch. */
export async function defaultBranch(dir: string): Promise<string> {
  // Prefer the current branch — butchr merges task branches into wherever the
  // operator's main line is checked out.
  const head = await run([git, "-C", dir, "symbolic-ref", "--short", "HEAD"]);
  if (head.ok && head.stdout.trim()) return head.stdout.trim();
  for (const b of ["main", "master"]) {
    const r = await run([git, "-C", dir, "rev-parse", "--verify", b]);
    if (r.ok) return b;
  }
  return "main";
}

/**
 * Absolute path to a task's git worktree: <dir>/<taskId>. The single source of
 * truth for where a task's checkout lives — used by createWorktree/diff/merge here
 * and by the CI gate (tasks.ts) to run build/tests in the task's tree.
 */
export function worktreePath(dir: string, taskId: string): string {
  return join(dir, taskId);
}

/**
 * List the LINKED (task) worktrees of the repo at `dir` — i.e. every worktree
 * EXCEPT the main checkout (`dir` itself). butchr creates one worktree per task at
 * `<dir>/<taskId>`, so this is the authoritative set of task checkouts on disk
 * (including any orphaned ones a crash left behind). Returns absolute paths.
 *
 * Parses `git worktree list --porcelain`: a block per worktree, each starting with a
 * `worktree <abs-path>` line. The FIRST block is always the main worktree, which we
 * drop. Best-effort: a git error (e.g. `dir` is no longer a repo) yields an empty list.
 */
export async function listWorktrees(dir: string): Promise<string[]> {
  const res = await run([git, "-C", dir, "worktree", "list", "--porcelain"]);
  if (!res.ok) return [];
  const paths: string[] = [];
  for (const line of res.stdout.split("\n")) {
    if (line.startsWith("worktree ")) paths.push(line.slice("worktree ".length).trim());
  }
  // The first entry is the main worktree (the repo root). Drop it — and defensively
  // drop any entry equal to `dir` — so only the per-task checkouts remain.
  const main = resolve(dir);
  return paths.filter((p) => resolve(p) !== main);
}

/**
 * Whether the directory ALREADY present at a task's worktree path is a REUSABLE
 * live worktree for branch <taskId> — as opposed to a stale/broken leftover (a
 * crash, an interrupted cleanup, or a repo MOVE that broke the worktree's `.git`
 * gitdir link). Reusing such a leftover is exactly what stranded agent work behind
 * a broken link and once nearly REVERTED merged code from a stale base — so
 * createWorktree validates before trusting an existing dir. Reusable iff ALL hold:
 *
 *  1. git recognizes it as a LIVE LINKED worktree — `rev-parse --git-dir` succeeds
 *     from inside it (catches a broken/missing `.git` gitdir link) AND <path>
 *     appears in the repo's `worktree list` (catches a dir absent from the admin
 *     records, e.g. a half-pruned entry).
 *  2. it is checked out on branch <taskId> (not some other / detached HEAD).
 *  3. it is NOT a never-worked leftover on a STALE base. If the current default
 *     tip is already contained in the branch, it's current → fine. If the branch
 *     is BEHIND the tip, it's reusable ONLY when it carries real commits of its
 *     own: those are live agent work the pre-dispatch / merge-time rebase replays
 *     onto the tip (rebuilding would silently DISCARD them, so we must not). A
 *     behind branch with NO commits is a stale leftover with nothing to preserve →
 *     not reusable, so it's rebuilt fresh on the current tip.
 *
 * Best-effort: every probe is a plain `run` (no throw); a git error fails closed
 * (returns false → rebuild), never throwing on a recoverable stale state.
 */
async function worktreeIsReusable(
  dir: string,
  taskId: string,
  path: string,
): Promise<boolean> {
  // (1) Live linked worktree: recognized from inside AND present in the admin list.
  const gitDir = await run([git, "-C", path, "rev-parse", "--git-dir"]);
  if (!gitDir.ok) return false;
  const listed = await listWorktrees(dir);
  if (!listed.some((p) => resolve(p) === resolve(path))) return false;

  // (2) Checked out on the task branch.
  const head = await run([git, "-C", path, "symbolic-ref", "--short", "HEAD"]);
  if (!head.ok || head.stdout.trim() !== taskId) return false;

  // (3) Not a never-worked leftover on a stale base. Current tip already contained
  // → current. Behind the tip → reusable only if the branch has its own commits
  // (real work the rebase replays onto the tip; discarding it is the bug to avoid).
  const base = await defaultBranch(dir);
  const contained = await run([
    git, "-C", dir, "merge-base", "--is-ancestor", base, taskId,
  ]);
  if (contained.ok) return true;
  const count = await run([
    git, "-C", dir, "rev-list", "--count", `${base}..${taskId}`,
  ]);
  return count.ok && parseInt(count.stdout.trim(), 10) > 0;
}

/**
 * Remove a stale/broken leftover at a task's worktree path AND its git admin entry
 * + branch ref, so a fresh `git worktree add -b <taskId>` can recreate it. Only ever
 * called when worktreeIsReusable() said no (broken link, wrong branch, or a
 * never-worked stale base — never a branch carrying commits we'd lose). Best-effort
 * and idempotent: try the clean `worktree remove --force`; if the dir survives
 * (git no longer recognizes it, e.g. a broken `.git` link), delete it outright and
 * `worktree prune` the dangling admin record; finally delete the branch so the
 * recreate's `-b <taskId>` is free to make it again.
 */
async function removeStaleWorktree(
  dir: string,
  taskId: string,
  path: string,
): Promise<void> {
  await run([git, "-C", dir, "worktree", "remove", "--force", path]);
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  await run([git, "-C", dir, "worktree", "prune"]);
  await run([git, "-C", dir, "branch", "-D", taskId]);
}

/**
 * Create a worktree on a new branch <taskId> at <dir>/<taskId>.
 *
 * VALIDATE-OR-REBUILD on an existing dir: a dir already at the worktree path is
 * REUSED only when worktreeIsReusable() confirms it's a live, correct, non-stale
 * worktree (preserving today's idempotent-dispatch behavior). A stale/broken/
 * stale-base leftover is REBUILT — removed and recreated fresh on the current
 * default tip — never silently reused (the root cause of two production
 * near-misses). The normal no-leftover path is unchanged: `worktree add -b`.
 */
export async function createWorktree(
  dir: string,
  taskId: string,
): Promise<string> {
  const path = worktreePath(dir, taskId);
  // Locally ignore the worktree dir so it never shows as an untracked/embedded
  // repo (and can't be accidentally `git add`-ed). Uses .git/info/exclude, which
  // is local-only — we never touch the user's tracked .gitignore for this.
  await addLocalExclude(dir, `/${taskId}/`);
  if (existsSync(path)) {
    if (await worktreeIsReusable(dir, taskId, path)) return path; // idempotent reuse
    await removeStaleWorktree(dir, taskId, path); // stale/broken/stale-base → rebuild
  }
  await runOrThrow([git, "-C", dir, "worktree", "add", "-b", taskId, path]);
  return path;
}

/** Append a pattern to .git/info/exclude (local, non-committed) if absent. */
async function addLocalExclude(dir: string, pattern: string): Promise<void> {
  const res = await run([git, "-C", dir, "rev-parse", "--git-path", "info/exclude"]);
  if (!res.ok) return;
  const rel = res.stdout.trim();
  const excludePath = rel.startsWith("/") ? rel : join(dir, rel);
  let text = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
  const lines = text.split("\n").map((l) => l.trim());
  if (lines.includes(pattern)) return;
  if (text.length > 0 && !text.endsWith("\n")) text += "\n";
  writeFileSync(excludePath, text + pattern + "\n", "utf8");
}

/** Whether the task branch has any changes vs the default branch. */
export async function hasChanges(dir: string, taskId: string): Promise<boolean> {
  const base = await defaultBranch(dir);
  const res = await run([
    git, "-C", dir, "rev-list", "--count", `${base}..${taskId}`,
  ]);
  if (res.ok && parseInt(res.stdout.trim(), 10) > 0) return true;
  // Also count uncommitted changes in the worktree (agent may not have committed).
  const wt = worktreePath(dir, taskId);
  if (existsSync(wt)) {
    const st = await run([git, "-C", wt, "status", "--porcelain"]);
    if (st.ok && st.stdout.trim().length > 0) return true;
  }
  return false;
}

/** Diff of the task branch vs the default branch, for review. */
export async function diff(dir: string, taskId: string): Promise<string> {
  const base = await defaultBranch(dir);
  // Commit diff against merge base.
  const committed = await run([
    git, "-C", dir, "diff", `${base}...${taskId}`,
  ]);
  let out = committed.ok ? committed.stdout : "";
  // Include uncommitted work in the worktree too.
  const wt = worktreePath(dir, taskId);
  if (existsSync(wt)) {
    const uncommitted = await run([git, "-C", wt, "diff", "HEAD"]);
    if (uncommitted.ok && uncommitted.stdout.trim()) {
      out += (out ? "\n" : "") +
        "# ---- uncommitted changes in worktree ----\n" +
        uncommitted.stdout;
    }
  }
  return out;
}

/** A task branch's change footprint vs the default branch: which files changed
 * and how many lines (added + deleted) total. Used by the AUTO-MERGE low-risk
 * gate (see tasks.maybeAutoMerge / isLowRiskChange). */
export type DiffStat = {
  /** Changed file paths, relative to the repo root (deduped union of committed
   * + uncommitted changes). */
  files: string[];
  /** Total changed lines = added + deleted across all files. Binary files count
   * toward `files` but contribute 0 lines (git reports `-` for them). */
  changedLines: number;
};

/** Parse `git diff --numstat` output, accumulating files + line totals into `acc`. */
function accumulateNumstat(
  output: string,
  files: Set<string>,
  counts: { lines: number },
): void {
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Format: `<added>\t<deleted>\t<path>` (added/deleted are `-` for binary).
    const m = trimmed.match(/^(-|\d+)\t(-|\d+)\t(.+)$/);
    if (!m) continue;
    const added = m[1] === "-" ? 0 : parseInt(m[1]!, 10);
    const deleted = m[2] === "-" ? 0 : parseInt(m[2]!, 10);
    counts.lines += added + deleted;
    files.add(m[3]!);
  }
}

/**
 * Compute a task branch's change footprint vs the default branch: the set of
 * changed files and the total changed-line count. Mirrors diff()'s two-part view
 * (committed commits `base...taskId` PLUS any uncommitted worktree changes) so the
 * low-risk gate sees exactly what would merge. Files are deduped across the two
 * sources; line counts are summed (a file edited in a commit and again uncommitted
 * counts both, which only ever OVER-estimates size — safe for a low-risk ceiling).
 */
export async function diffStat(dir: string, taskId: string): Promise<DiffStat> {
  const base = await defaultBranch(dir);
  const files = new Set<string>();
  const counts = { lines: 0 };

  const committed = await run([
    git, "-C", dir, "diff", "--numstat", `${base}...${taskId}`,
  ]);
  if (committed.ok) accumulateNumstat(committed.stdout, files, counts);

  const wt = worktreePath(dir, taskId);
  if (existsSync(wt)) {
    const uncommitted = await run([git, "-C", wt, "diff", "--numstat", "HEAD"]);
    if (uncommitted.ok) accumulateNumstat(uncommitted.stdout, files, counts);
  }

  return { files: [...files], changedLines: counts.lines };
}

export type MergeResult = {
  ok: boolean;
  conflict: boolean;
  message: string;
  // On a content conflict, the files git reported as conflicting (parsed from
  // its output). Empty if none could be parsed.
  conflictFiles: string[];
  // On a SUCCESSFUL merge, the SHAs bracketing the commits this task contributed
  // to the default branch: `baseSha` is the base tip BEFORE the fast-forward
  // (the exclusive lower bound) and `mergedSha` is the new tip AFTER it (the
  // inclusive upper bound). Recorded by the caller so a deliberate ROLLBACK task
  // (created from the `rollback` template) can be pre-filled with the exact commit
  // to revert (see src/templates.ts + the webapp's "Roll back" button).
  baseSha?: string;
  mergedSha?: string;
};

/**
 * Scan the task worktree for committed git conflict markers an agent may have
 * left behind. Returns the list of tracked text files (relative to the worktree)
 * whose content contains a marker line (`<<<<<<<`, `=======`, `>>>>>>>`). Binary
 * and untracked files are skipped. Used to refuse merging poisoned content into
 * the base — see merge().
 */
async function findConflictMarkers(wt: string): Promise<string[]> {
  // `git grep` over tracked content: -I skips binaries, -l lists matching files
  // only, -E enables extended regex. A non-zero exit with no output just means
  // "no matches", which we treat as clean.
  const res = await run([
    git, "-C", wt, "grep", "-I", "-l", "-E",
    "^(<<<<<<<|=======|>>>>>>>)( |$)",
  ]);
  if (!res.ok || !res.stdout.trim()) return [];
  return res.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Parse `CONFLICT (...): Merge conflict in <path>` lines from git output. */
function parseConflictFiles(output: string): string[] {
  const files: string[] = [];
  for (const line of output.split("\n")) {
    const m = line.match(/Merge conflict in (.+?)\s*$/);
    if (m && !files.includes(m[1])) files.push(m[1]);
  }
  return files;
}

/**
 * Tail shared by `merge()` and `rebaseOntoDefault()` when a `git rebase` fails:
 * collect the conflicting file paths, abort the rebase, and decide whether the
 * failure was a conflict.
 *
 * Ordering matters: collect the unmerged files BEFORE the abort (the abort clears
 * them). Prefer `--diff-filter=U` over scraping git's text, falling back to the
 * text scrape only when the porcelain list is empty. `conflict` is true if either
 * signal fires.
 */
async function collectConflictAndAbort(
  cwd: string,
  rb: ExecResult,
  base: string,
): Promise<{ conflict: boolean; conflictFiles: string[]; message: string }> {
  const unmerged = await run([
    git, "-C", cwd, "diff", "--name-only", "--diff-filter=U",
  ]);
  let conflictFiles = unmerged.ok
    ? unmerged.stdout.split("\n").map((l) => l.trim()).filter(Boolean)
    : [];
  if (conflictFiles.length === 0) {
    conflictFiles = parseConflictFiles(rb.stdout + "\n" + rb.stderr);
  }
  await run([git, "-C", cwd, "rebase", "--abort"]);
  const combined = rb.stdout + "\n" + rb.stderr;
  const conflict = /conflict/i.test(combined) || conflictFiles.length > 0;
  return {
    conflict,
    conflictFiles,
    message: (rb.stderr || rb.stdout).trim() || `rebase onto ${base} failed`,
  };
}

/**
 * Whether the task branch's diff vs `base` touches ONLY docs files (so the
 * version bump is skipped). Resolved from the committed range `base...taskId`
 * AFTER the rebase, so it reflects exactly the task's own code changes (not the
 * CHANGELOG/version edits, which finalizeLivingDocs commits afterward). On any git
 * error we return false → a normal bump (the safe default — never silently skip).
 */
async function taskDiffIsDocsOnly(
  dir: string,
  taskId: string,
  base: string,
): Promise<boolean> {
  const res = await run([
    git, "-C", dir, "diff", "--name-only", `${base}...${taskId}`,
  ]);
  if (!res.ok) return false;
  const files = res.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  return isDocsOnlyDiff(files);
}

/**
 * MERGE-TIME LIVING-DOCS BOOKKEEPING: butchr OWNS the CHANGELOG entry + version
 * bump so concurrent tasks stop colliding on CHANGELOG.md / package.json (agents
 * no longer edit either). Called from merge() AFTER a clean rebase (so it edits the
 * up-to-date base content and can't conflict) and BEFORE the fast-forward, in the
 * worktree where the task branch is checked out — the edits are committed onto the
 * task branch so they fast-forward onto the base with the rest of the work.
 *
 *  - CHANGELOG.md: append an `[Unreleased]` entry derived from the task summary +
 *    id. The append is the IDEMPOTENCY key — insertUnreleasedEntry returns null
 *    when this task's marker is already present (a re-merge), in which case we skip
 *    EVERYTHING (incl. the version bump) so nothing is recorded twice.
 *  - package.json: patch-bump the version, UNLESS the task's diff is docs-only.
 *
 * Everything is best-effort: a repo with no CHANGELOG.md / package.json, or an
 * unparseable one, simply skips that piece — never failing the merge. The summary
 * is whatever the agent passed to request_review (may be empty → a generic line).
 */
async function finalizeLivingDocs(
  dir: string,
  wt: string,
  taskId: string,
  base: string,
  summary: string | null,
): Promise<void> {
  let staged = false;

  // CHANGELOG first: it carries the idempotency marker. If the entry is already
  // present (re-merge) we bail entirely so the version can't double-bump either.
  const changelogPath = join(wt, "CHANGELOG.md");
  if (existsSync(changelogPath)) {
    const updated = insertUnreleasedEntry(
      readFileSync(changelogPath, "utf8"),
      summary,
      taskId,
    );
    if (updated === null) return; // already recorded → idempotent no-op
    writeFileSync(changelogPath, updated, "utf8");
    await run([git, "-C", wt, "add", "CHANGELOG.md"]);
    staged = true;
  }

  // Version: patch-bump unless this task's diff is docs-only.
  const pkgPath = join(wt, "package.json");
  if (existsSync(pkgPath) && !(await taskDiffIsDocsOnly(dir, taskId, base))) {
    const bumped = bumpPatchVersion(readFileSync(pkgPath, "utf8"));
    if (bumped) {
      writeFileSync(pkgPath, bumped.text, "utf8");
      await run([git, "-C", wt, "add", "package.json"]);
      staged = true;
    }
  }

  if (staged) {
    await run([
      git, "-C", wt, "commit", "-m", `butchr: changelog + version bump (task ${taskId})`,
    ]);
  }
}

/**
 * Commit any uncommitted worktree changes, then REBASE the task branch onto the
 * current tip of the default branch and fast-forward the default branch to it.
 *
 * Rebase (rather than a merge commit) keeps history linear and, crucially, makes
 * the result deterministic when approvals land close together: callers serialize
 * this through a single merge queue (see src/tasks.ts), so each task rebases onto
 * the up-to-date base tip left by the previous merge and then fast-forwards — no
 * racing merges into a moving default branch, no surprise merge commits.
 *
 * On a clean rebase: ff the base to the (now linear) task branch → ok=true.
 * On a rebase conflict: abort the rebase (task branch + worktree left UNCHANGED,
 * base UNTOUCHED) and return conflict=true with the conflicting file paths so the
 * caller can kick the task back to the agent to resolve and re-submit.
 */
export async function merge(
  dir: string,
  taskId: string,
  summary: string | null = null,
): Promise<MergeResult> {
  const base = await defaultBranch(dir);
  const wt = worktreePath(dir, taskId);

  // Auto-commit any dangling worktree changes so they're part of the rebase.
  if (existsSync(wt)) {
    const st = await run([git, "-C", wt, "status", "--porcelain"]);
    if (st.ok && st.stdout.trim().length > 0) {
      // Stage everything first so the marker scan also sees newly-added files.
      await run([git, "-C", wt, "add", "-A"]);
      // GUARD: never commit/merge content that still has unresolved conflict
      // markers — that's exactly how a poisoned diff reached the base before.
      // Hold the task for human review instead (worktree left staged, base
      // untouched).
      const poisoned = await findConflictMarkers(wt);
      if (poisoned.length > 0) {
        return {
          ok: false,
          conflict: true,
          message:
            `refusing to merge ${taskId}: unresolved git conflict markers in ` +
            poisoned.join(", "),
          conflictFiles: poisoned,
        };
      }
      await run([
        git, "-C", wt, "commit", "-m", `butchr: finalize task ${taskId}`,
      ]);
    } else {
      // No dangling changes, but the agent may have COMMITTED markers earlier.
      const poisoned = await findConflictMarkers(wt);
      if (poisoned.length > 0) {
        return {
          ok: false,
          conflict: true,
          message:
            `refusing to merge ${taskId}: unresolved git conflict markers in ` +
            poisoned.join(", "),
          conflictFiles: poisoned,
        };
      }
    }
  }

  // Rebase the task branch onto the current base tip. Run it in the worktree
  // where the task branch is checked out (the base stays checked out at `dir`).
  const rebaseDir = existsSync(wt) ? wt : dir;
  const rb = await run([git, "-C", rebaseDir, "rebase", base]);
  if (!rb.ok) {
    // Conflict (or other rebase failure). Abort so the task branch + worktree are
    // left CLEAN and the base UNTOUCHED; the agent (or a fresh one) integrates
    // base and re-submits.
    const { conflict, conflictFiles, message } =
      await collectConflictAndAbort(rebaseDir, rb, base);
    return { ok: false, conflict, message, conflictFiles };
  }

  // Clean rebase — the task branch is now linear atop base. butchr OWNS the
  // living-docs bookkeeping here (CHANGELOG entry + version bump), committed onto
  // the task branch so it fast-forwards with the rest of the work. Done AFTER the
  // rebase so it edits the up-to-date base content and can't collide with a
  // concurrent task — the whole reason these edits moved off the agents. Idempotent
  // and best-effort (see finalizeLivingDocs); only when the branch has a worktree.
  if (existsSync(wt)) {
    await finalizeLivingDocs(dir, wt, taskId, base, summary);
  }

  // Capture the base tip BEFORE the fast-forward: it's the exclusive lower bound of
  // the commits this task is about to land, recorded so the merge can be reverted
  // later (this range now also covers the changelog/version commit above).
  const baseBefore = await run([git, "-C", dir, "rev-parse", base]);
  // Fast-forward base to it (no merge commit). This cannot conflict; it can only
  // fail if base moved between the rebase and here (callers serialize merges to
  // prevent that).
  const ff = await run([git, "-C", dir, "merge", "--ff-only", taskId]);
  if (ff.ok) {
    const after = await run([git, "-C", dir, "rev-parse", base]);
    return {
      ok: true,
      conflict: false,
      message: ff.stdout.trim(),
      conflictFiles: [],
      baseSha: baseBefore.ok ? baseBefore.stdout.trim() : undefined,
      mergedSha: after.ok ? after.stdout.trim() : undefined,
    };
  }
  return {
    ok: false,
    conflict: false,
    message: (ff.stderr || ff.stdout).trim() || `fast-forward into ${base} failed`,
    conflictFiles: [],
  };
}

/**
 * Whether the task branch is BEHIND the default branch — i.e. the current
 * default-branch tip is NOT already contained in the task branch. A freshly
 * created worktree branches from the current default HEAD, so it is up to date
 * and this returns false; it returns true only for a branch cut from a STALE
 * default tip (e.g. a chained/blocked task whose worktree was created before its
 * blockers merged). Used as the cheap, lock-free gate in front of the (serialized)
 * pre-dispatch rebase so up-to-date branches never pay for the merge queue.
 */
export async function isBehindDefault(dir: string, taskId: string): Promise<boolean> {
  const base = await defaultBranch(dir);
  // `merge-base --is-ancestor <base> <taskId>` exits 0 iff base is an ancestor of
  // (or equal to) the task branch — meaning the branch already contains the tip.
  const anc = await run([
    git, "-C", dir, "merge-base", "--is-ancestor", base, taskId,
  ]);
  return !anc.ok;
}

export type RebaseResult = {
  // The branch is safely based on the current default tip after this call (either
  // it was moved cleanly, or it already was up to date, or we deliberately left a
  // dirty worktree untouched). false only on a conflict or a hard git error.
  ok: boolean;
  // True iff the branch base was actually moved (reset or rebased) this call.
  rebased: boolean;
  // True iff a rebase hit a conflict; the rebase was aborted, so the branch +
  // worktree are left CLEAN on their ORIGINAL base (nothing clobbered).
  conflict: boolean;
  // True iff we skipped because the worktree had uncommitted changes we must not
  // clobber — left as-is for the merge-time rebase (which commits first) to handle.
  skippedDirty: boolean;
  message: string;
  conflictFiles: string[];
};

/**
 * AUTO-REBASE a task branch onto the CURRENT default-branch tip, before its agent
 * runs. Closes the chained-task conflict gap: a branch cut from a stale default
 * HEAD (before its blockers merged) would otherwise only collide at the final
 * merge. By bringing it up to the tip up front, the agent works on the merged
 * state and a collision surfaces now (as a conflict the caller can route to the
 * agent) instead of at merge time.
 *
 * Safety (never clobber uncommitted work — mirrors how merge() guards its tree):
 *   - No worktree, or already up to date          → no-op (ok, rebased=false).
 *   - Uncommitted changes in the worktree         → SKIP (skippedDirty); the
 *     merge-time rebase, which commits first, integrates the base later.
 *   - No commits beyond base (never really started, e.g. a fresh/blocked task on a
 *     stale base) → hard-reset the branch onto the tip (a clean fresh start).
 *   - Has commits → REBASE them onto the tip. On CONFLICT, abort (branch + worktree
 *     left CLEAN on the original base, default branch UNTOUCHED) and report the
 *     conflicting files so the caller can hand resolution to the agent.
 *
 * Reads the default branch but never moves it; callers serialize this through the
 * merge queue so it can't race a concurrent merge advancing the default ref.
 */
export async function rebaseOntoDefault(
  dir: string,
  taskId: string,
): Promise<RebaseResult> {
  const base = await defaultBranch(dir);
  const wt = worktreePath(dir, taskId);
  const noop = (over: Partial<RebaseResult> = {}): RebaseResult => ({
    ok: true,
    rebased: false,
    conflict: false,
    skippedDirty: false,
    message: "",
    conflictFiles: [],
    ...over,
  });

  // No worktree yet → nothing to rebase (createWorktree branches a fresh one from
  // the current tip when it makes one).
  if (!existsSync(wt)) return noop();

  // Already contains the current default tip → nothing to do.
  const anc = await run([
    git, "-C", dir, "merge-base", "--is-ancestor", base, taskId,
  ]);
  if (anc.ok) return noop();

  // CAUTION: never clobber uncommitted worktree changes. If the agent left dirty
  // state, skip the pre-dispatch rebase entirely and let the merge-time rebase
  // (which auto-commits first) integrate the base later.
  const st = await run([git, "-C", wt, "status", "--porcelain"]);
  if (st.ok && st.stdout.trim().length > 0) {
    return noop({
      skippedDirty: true,
      message: `skipped rebase of ${taskId}: uncommitted changes in worktree`,
    });
  }

  // Count commits unique to the task branch. Zero → it never advanced past its
  // (now stale) creation base, so there is no real work: hard-reset it onto the
  // current tip for a clean fresh start atop the merged blockers.
  const count = await run([
    git, "-C", dir, "rev-list", "--count", `${base}..${taskId}`,
  ]);
  const hasCommits = count.ok && parseInt(count.stdout.trim(), 10) > 0;

  if (!hasCommits) {
    const reset = await run([git, "-C", wt, "reset", "--hard", base]);
    if (reset.ok) {
      return noop({ rebased: true, message: `reset ${taskId} onto ${base}` });
    }
    return {
      ok: false,
      rebased: false,
      conflict: false,
      skippedDirty: false,
      message: (reset.stderr || reset.stdout).trim() || `reset ${taskId} onto ${base} failed`,
      conflictFiles: [],
    };
  }

  // Has real commits — rebase them onto the current tip. Run in the worktree where
  // the task branch is checked out.
  const rb = await run([git, "-C", wt, "rebase", base]);
  if (rb.ok) {
    return noop({ rebased: true, message: `rebased ${taskId} onto ${base}` });
  }

  // Conflict (or other rebase failure). Abort so the branch + worktree are left
  // CLEAN on their original base.
  const { conflict, conflictFiles, message } =
    await collectConflictAndAbort(wt, rb, base);
  return {
    ok: false,
    rebased: false,
    conflict,
    skippedDirty: false,
    message,
    conflictFiles,
  };
}

/** Current commit SHA of HEAD at `dir` (the default-branch tip when run at the repo root). */
export async function headSha(dir: string): Promise<string> {
  const res = await run([git, "-C", dir, "rev-parse", "HEAD"]);
  if (!res.ok) {
    throw new Error(`rev-parse HEAD failed in ${dir}: ${(res.stderr || res.stdout).trim()}`);
  }
  return res.stdout.trim();
}

/**
 * Hard-reset the branch checked out at `dir` back to `sha`. Used to UNDO a
 * just-merged fast-forward when the post-merge verify gate fails (see
 * tasks.approveTask): because merges are serialized through the global merge
 * queue, nothing else landed after the ff, so resetting to the captured pre-merge
 * tip cleanly removes exactly the bad commits and keeps history linear — no revert
 * commit clutter. Throws on failure so the caller can log loudly.
 */
export async function resetHard(dir: string, sha: string): Promise<void> {
  await runOrThrow([git, "-C", dir, "reset", "--hard", sha]);
}

/** Remove the worktree and delete the task branch (post-merge cleanup). */
export async function cleanup(dir: string, taskId: string): Promise<void> {
  const path = worktreePath(dir, taskId);
  if (existsSync(path)) {
    await run([git, "-C", dir, "worktree", "remove", "--force", path]);
  }
  await run([git, "-C", dir, "branch", "-D", taskId]);
}

/** Ensure `.butchr/` is gitignored in the directory root. */
export function ensureGitignore(dir: string): void {
  const p = join(dir, ".gitignore");
  let text = existsSync(p) ? readFileSync(p, "utf8") : "";
  const lines = text.split("\n").map((l) => l.trim());
  if (!lines.includes(".butchr/") && !lines.includes(".butchr")) {
    if (text.length > 0 && !text.endsWith("\n")) text += "\n";
    text += ".butchr/\n";
    writeFileSync(p, text, "utf8");
  }
}
