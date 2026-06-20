// Git operations butchr owns directly. All run against a workspace root that
// is a git repository. Task branches/worktrees are named by task ID.
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  bumpVersion,
  isDocsOnlyDiff,
  promoteUnreleased,
  unionAdditiveChangelogConflict,
} from "./changelog.ts";
import type { VersionBumpLevel } from "./changelog.ts";
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
 * F4 GUARD — assert the ff-target worktree is safe to fast-forward BEFORE we advance it.
 * `git merge --ff-only` advances whatever HEAD `ffWorktree` currently points at; the
 * ff-target branch name is otherwise only used for the rev-parse capture/reset. So if the
 * worktree is left DETACHED or on the WRONG branch, the ff (and the post-merge verify +
 * auto-revert, which operate on that same checkout) would silently act on the wrong ref.
 * We refuse loudly instead (a 409-style hard refusal upstream). Returns {ok:false,message}
 * when:
 *  (a) DETACHED HEAD — `symbolic-ref --short HEAD` fails (the dangerous case: defaultBranch()
 *      falls back to "main", so ffTargetBranch looks valid while HEAD is detached);
 *  (b) WRONG BRANCH — the checked-out branch ≠ the expected ffTargetBranch;
 *  (c) DIRTY TRACKED tree — uncommitted TRACKED changes. Untracked files are IGNORED on
 *      purpose: butchr legitimately leaves an untracked `<root>/.butchr/tasks/.../task.md`
 *      in the repo root during normal operation, so a naive clean-check would refuse every
 *      merge. (ff-only already fails-safe on a tree dirty enough to block the ff; this just
 *      turns the tracked-dirty case into a clear message.)
 * Generic over both flows: the default-main ff (ffWorktree=root, ffTargetBranch=default) and
 * the isolated story-member ff (ffWorktree=story worktree, ffTargetBranch=story branch). The
 * SOURCE worktree where the bump commits is never the ff worktree, so (c) won't false-trip.
 */
async function assertFfTargetReady(
  ffWorktree: string,
  ffTargetBranch: string,
): Promise<{ ok: boolean; message: string }> {
  const head = await run([git, "-C", ffWorktree, "symbolic-ref", "--short", "HEAD"]);
  const cur = head.ok ? head.stdout.trim() : "";
  if (!cur) {
    return {
      ok: false,
      message:
        `ff-target worktree ${ffWorktree} is in a DETACHED HEAD state ` +
        `(expected branch '${ffTargetBranch}'); merge refused to avoid advancing the wrong ref`,
    };
  }
  if (cur !== ffTargetBranch) {
    return {
      ok: false,
      message:
        `ff-target worktree ${ffWorktree} is on '${cur}', not the expected ` +
        `'${ffTargetBranch}'; merge refused`,
    };
  }
  const st = await run([git, "-C", ffWorktree, "status", "--porcelain", "--untracked-files=no"]);
  if (st.ok && st.stdout.trim().length > 0) {
    return {
      ok: false,
      message:
        `ff-target branch '${ffTargetBranch}' has uncommitted tracked changes in ` +
        `${ffWorktree}; merge refused`,
    };
  }
  return { ok: true, message: "" };
}

// ---- STALE-BASE PROBES -------------------------------------------------------
// Two cheap reads that answer "where is the task branch relative to the default
// tip?" — shared by every place that has to reason about a possibly-stale base
// (worktreeIsReusable, hasChanges, isBehindDefault, rebaseOntoDefault). Both are
// best-effort plain `run`s that fail closed (false / 0) rather than throwing, so a
// git error never breaks a recoverable stale state.

/**
 * Whether `base`'s tip is ALREADY contained in the task branch — i.e. base is an
 * ancestor of (or equal to) <taskId>, so the branch is current rather than behind.
 * `merge-base --is-ancestor` exits 0 iff so; any git error → false (treat as behind).
 */
async function branchContainsBase(dir: string, base: string, taskId: string): Promise<boolean> {
  const anc = await run([
    git, "-C", dir, "merge-base", "--is-ancestor", base, taskId,
  ]);
  return anc.ok;
}

/**
 * Count of commits unique to the task branch vs `base` (the `base..taskId` range) —
 * i.e. the branch's own work the rebase would replay. 0 on any git error (fail closed:
 * "no work to preserve").
 */
async function branchOwnCommitCount(dir: string, base: string, taskId: string): Promise<number> {
  const count = await run([
    git, "-C", dir, "rev-list", "--count", `${base}..${taskId}`,
  ]);
  return count.ok ? parseInt(count.stdout.trim(), 10) || 0 : 0;
}

/**
 * Count of commits on the default branch that the task branch does NOT yet contain
 * (the `taskId..base` range) — i.e. how many commits BEHIND the current default tip
 * the branch is. 0 means the branch already contains the tip (it is "on tip"). The
 * behind-count sibling of the private branchOwnCommitCount (which counts the branch's
 * OWN commits, the `base..taskId` range). Best-effort: 0 on any git error (fail closed
 * — treat as not-behind). Used by the read-only readiness view (tasks.taskReadiness).
 *
 * `base` is the merge-target ref the branch is measured behind; it DEFAULTS to
 * defaultBranch(dir) when omitted, so today's callers are byte-for-byte unchanged.
 * Threaded so a story member can be measured against its story branch (CONTRIBUTING §11.2).
 */
export async function commitsBehind(
  dir: string,
  taskId: string,
  base?: string,
): Promise<number> {
  base ??= await defaultBranch(dir);
  const count = await run([
    git, "-C", dir, "rev-list", "--count", `${taskId}..${base}`,
  ]);
  return count.ok ? parseInt(count.stdout.trim(), 10) || 0 : 0;
}

/**
 * Whether the task branch ref <taskId> exists in the repo at `dir`. Used by the
 * empty-submission guard (tasks.markReviewFromAgent) to confirm the submission is even
 * MEASURABLE before concluding it carries no changes: with no task branch there is
 * nothing to diff against, so the guard FAILS OPEN (proceeds to review) rather than
 * false-bouncing a submission it cannot probe. Best-effort: false on any git error.
 */
export async function branchExists(dir: string, taskId: string): Promise<boolean> {
  const res = await run([
    git, "-C", dir, "rev-parse", "--verify", "--quiet", `refs/heads/${taskId}`,
  ]);
  return res.ok;
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
 * The branch-name prefix for a STORY's branch (`butchr/story/`). The single source of
 * truth for the prefix, shared by storyBranchName (build) and storyIdFromBranch (parse).
 */
const STORY_BRANCH_PREFIX = "butchr/story/";

/**
 * The branch name for a STORY's branch: `butchr/story/<storyId>`. Pure (no git I/O).
 * The `butchr/story/` prefix can't collide with task branches (named by the
 * `adjective-noun-4hex` task id) or the default branch (CONTRIBUTING §11.3). Used by
 * the branch-isolation merge model to cut/merge a story branch off the default branch.
 */
export function storyBranchName(storyId: string): string {
  return `${STORY_BRANCH_PREFIX}${storyId}`;
}

/**
 * Absolute path to an isolated story's STORY WORKTREE: `<dir>/butchr-story-<storyId>`
 * (CONTRIBUTING §11.1). Pure (no git I/O). The DASH-joined dir name deliberately differs
 * from the SLASH-prefixed branch (`butchr/story/<storyId>`) so the branch can't collide
 * with task branches while the worktree stays a single flat sibling dir of the repo root.
 */
export function storyWorktreePath(dir: string, storyId: string): string {
  return join(dir, `butchr-story-${storyId}`);
}

/** Recover a storyId from its story branch (`butchr/story/<id>` → `<id>`). The inverse of
 * storyBranchName; falls back to the input unchanged if it carries no story prefix. */
function storyIdFromBranch(storyBranch: string): string {
  return storyBranch.startsWith(STORY_BRANCH_PREFIX)
    ? storyBranch.slice(STORY_BRANCH_PREFIX.length)
    : storyBranch;
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
 *
 * `base` is the merge-target ref the stale-base probes (branchContainsBase /
 * branchOwnCommitCount) measure against; it DEFAULTS to defaultBranch(dir) when omitted
 * (today's behavior). A story member passes its story branch (CONTRIBUTING §11.2).
 */
async function worktreeIsReusable(
  dir: string,
  taskId: string,
  path: string,
  base?: string,
): Promise<boolean> {
  base ??= await defaultBranch(dir);
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
  if (await branchContainsBase(dir, base, taskId)) return true;
  return (await branchOwnCommitCount(dir, base, taskId)) > 0;
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
 *
 * `base` is the ref the new branch is cut FROM (`worktree add -b <taskId> <path>
 * <base>`) and the ref the reuse/stale probes measure against. It DEFAULTS to
 * defaultBranch(dir) when omitted, so today's behavior is byte-for-byte unchanged
 * (a fresh worktree branches off the default tip). A story member passes its story
 * branch so its worktree is cut from the story branch (CONTRIBUTING §11.2/§11.4).
 */
export async function createWorktree(
  dir: string,
  taskId: string,
  base?: string,
): Promise<string> {
  base ??= await defaultBranch(dir);
  const path = worktreePath(dir, taskId);
  // Locally ignore the worktree dir so it never shows as an untracked/embedded
  // repo (and can't be accidentally `git add`-ed). Uses .git/info/exclude, which
  // is local-only — we never touch the user's tracked .gitignore for this.
  await addLocalExclude(dir, `/${taskId}/`);
  if (existsSync(path)) {
    if (await worktreeIsReusable(dir, taskId, path, base)) return path; // idempotent reuse
    await removeStaleWorktree(dir, taskId, path); // stale/broken/stale-base → rebuild
  }
  await runOrThrow([git, "-C", dir, "worktree", "add", "-b", taskId, path, base]);
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

// ---- STORY BRANCH LIFECYCLE (3-level branch-isolation merge model — CONTRIBUTING §11) --
// A story worktree is to its subtasks exactly what the repo root is to standalone tasks
// (§11.1): an isolated open story gets a checkout on its story branch at
// <repo>/butchr-story-<storyId>; subtasks branch FROM and fast-forward INTO it. These
// helpers create / remove that branch + worktree. LIVE but GUARDED per story: they run only
// for an isolated story (the workspace branch_isolation flag was ON when it was opened, so it
// captured isolated=1); resolveBase reaches ensureStoryBranch only on that guarded path.

/**
 * Lazily ensure an isolated story's BRANCH + its STORY WORKTREE exist, returning the story
 * worktree path (`<repo>/butchr-story-<storyId>`, §11.1). Mirrors createWorktree's
 * VALIDATE-OR-REBUILD idempotency so it is restart-safe and safe to call before every
 * subtask is branched off the story branch (§11.3):
 *
 *  1. A VALID story worktree at the path is reused unchanged. The reuse probe passes
 *     `base = the story branch itself`, so the stale-base check in worktreeIsReusable is
 *     trivially satisfied (the branch is its own ancestor): a story branch LEGITIMATELY
 *     diverges from main (it accrues subtask merges) and must NEVER be rebuilt for being
 *     "behind" the default tip.
 *  2. A broken/missing-link leftover at the path is removed WORKTREE-ONLY
 *     (removeStaleStoryWorktree — it does NOT delete the branch, which carries merged
 *     subtask commits) and re-attached below.
 *  3. If the branch already exists (it holds subtask work) but had no live worktree, a
 *     fresh worktree is attached onto the EXISTING branch (preserving the work). Only the
 *     FIRST creation cuts the branch off the CURRENT default-branch (main) tip.
 *
 * The story worktree dir is added to .git/info/exclude like task worktrees, so it never
 * shows as untracked. Throws (via runOrThrow) only if the worktree add itself fails.
 */
export async function ensureStoryBranch(dir: string, storyBranch: string): Promise<string> {
  const storyId = storyIdFromBranch(storyBranch);
  const path = storyWorktreePath(dir, storyId);
  await addLocalExclude(dir, `/butchr-story-${storyId}/`);
  if (existsSync(path)) {
    // base = the story branch itself → the stale-base probe is a trivial no-op (see above),
    // so a valid story worktree is reused even when it has fallen "behind" the moving main.
    if (await worktreeIsReusable(dir, storyBranch, path, storyBranch)) return path;
    await removeStaleStoryWorktree(dir, path); // WORKTREE-ONLY — never deletes the branch
  }
  if (await branchExists(dir, storyBranch)) {
    // Branch exists (merged subtask work) but its worktree was missing/broken → re-attach a
    // worktree onto the EXISTING branch so none of that work is lost.
    await runOrThrow([git, "-C", dir, "worktree", "add", path, storyBranch]);
  } else {
    // First lazy creation → cut the story branch off the CURRENT main tip + check it out.
    const base = await defaultBranch(dir);
    await runOrThrow([git, "-C", dir, "worktree", "add", "-b", storyBranch, path, base]);
  }
  return path;
}

/**
 * Remove a stale/broken story WORKTREE at `path` and its git admin entry, but DELIBERATELY
 * NOT the branch — the story branch carries merged subtask commits that must survive (the
 * worktree is re-attached onto it by ensureStoryBranch). The worktree-only sibling of
 * removeStaleWorktree (which also `branch -D`s). Best-effort + idempotent: try the clean
 * `worktree remove --force`; if the dir survives (a broken `.git` link git no longer
 * recognizes), delete it outright and `worktree prune` the dangling admin record.
 */
async function removeStaleStoryWorktree(dir: string, path: string): Promise<void> {
  await run([git, "-C", dir, "worktree", "remove", "--force", path]);
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  await run([git, "-C", dir, "worktree", "prune"]);
}

/**
 * Tear down an isolated story's worktree AND delete its branch — the completion/cleanup
 * counterpart of ensureStoryBranch (§11.4/§11.9). Removes the story worktree (clean
 * remove, then an outright delete + prune if a broken link left the dir behind) and then
 * `branch -D`s the story branch. Best-effort + idempotent (a no-op when neither exists).
 */
export async function removeStoryBranch(dir: string, storyBranch: string): Promise<void> {
  const storyId = storyIdFromBranch(storyBranch);
  const path = storyWorktreePath(dir, storyId);
  if (existsSync(path)) {
    await run([git, "-C", dir, "worktree", "remove", "--force", path]);
  }
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  await run([git, "-C", dir, "worktree", "prune"]);
  await run([git, "-C", dir, "branch", "-D", storyBranch]);
}

/**
 * Whether the task branch has any changes vs `base` (committed commits OR a dirty
 * worktree). `base` DEFAULTS to defaultBranch(dir) when omitted (today's behavior);
 * a story member passes its story branch (CONTRIBUTING §11.2).
 */
export async function hasChanges(
  dir: string,
  taskId: string,
  base?: string,
): Promise<boolean> {
  base ??= await defaultBranch(dir);
  if ((await branchOwnCommitCount(dir, base, taskId)) > 0) return true;
  // Also count uncommitted changes in the worktree (agent may not have committed).
  const wt = worktreePath(dir, taskId);
  if (existsSync(wt)) {
    const st = await run([git, "-C", wt, "status", "--porcelain"]);
    if (st.ok && st.stdout.trim().length > 0) return true;
  }
  return false;
}

/**
 * Diff of the task branch vs `base`, for review. `base` DEFAULTS to defaultBranch(dir)
 * when omitted (today's behavior); a story member passes its story branch (CONTRIBUTING §11.2).
 */
export async function diff(
  dir: string,
  taskId: string,
  base?: string,
): Promise<string> {
  base ??= await defaultBranch(dir);
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
 *
 * `base` DEFAULTS to defaultBranch(dir) when omitted (today's behavior); a story
 * member passes its story branch so its footprint is measured against the story
 * branch (CONTRIBUTING §11.2/§11.5).
 */
export async function diffStat(
  dir: string,
  taskId: string,
  base?: string,
): Promise<DiffStat> {
  base ??= await defaultBranch(dir);
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

/**
 * COMMIT-ON-REVIEW durability. Stage and commit ALL worktree changes onto the task
 * branch <taskId> so the agent's diff lives on the BRANCH — the durable source of
 * truth — and can't be lost if the worktree is later deleted (a repo move's DELETE
 * cascade, the reaper, a crash cleanup) or reset on re-dispatch.
 *
 * Called when a WORKSPACE-agent task transitions OUT of `in_progress` into a
 * non-merged review state (`in_review` / `needs_info`) where it would otherwise be
 * left as uncommitted worktree state only (see tasks.markInReview /
 * markReviewFromAgent / markNeedsInfoFromAgent). Reuses the same `git add -A` +
 * commit mechanism merge() uses at merge time; the WIP commit it leaves is later
 * collapsed/replayed by merge()'s rebase, and a resume (request-changes / answer)
 * continues on TOP of it (the agent's further changes still merge cleanly).
 *
 * UNCONDITIONAL: commits even when unresolved conflict markers are present —
 * preserving the work matters more, and merge()'s findConflictMarkers guard still
 * REFUSES to land poisoned content into the base. This also removes the old
 * "no commits → reset onto tip" fragility in rebaseOntoDefault: a review-state
 * branch now always has at least this commit.
 *
 * BEST-EFFORT + IDEMPOTENT: never throws and returns false (a no-op) when there is
 * no worktree, nothing to commit, or git fails — so a commit failure can NEVER break
 * the state transition. Synchronous (via Bun.spawnSync) so the sync transition
 * functions can commit FIRST, before the worktree is exposed to deletion.
 *
 * Returns true iff a WIP commit was actually created.
 */
export function commitWorktree(
  dir: string,
  taskId: string,
  message: string,
): boolean {
  const wt = worktreePath(dir, taskId);
  if (!existsSync(wt)) return false;
  try {
    const add = Bun.spawnSync([git, "-C", wt, "add", "-A"]);
    if (!add.success) return false;
    // `git commit` exits non-zero on "nothing to commit" — that's a benign no-op
    // (idempotent: a second call, or a tree with no changes, simply does nothing).
    const commit = Bun.spawnSync([
      git, "-C", wt, "commit", "-m", message,
    ]);
    return commit.success;
  } catch {
    return false; // best-effort: a git/spawn failure must never break the caller
  }
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
  // In release_mode (see MergeOptions.releaseMode), the version butchr ASSIGNED and
  // stamped at this merge (e.g. "0.9.74") — bumped by the task's declared level and
  // written into both the version file and the changelog's new versioned heading. Unset
  // for a non-release merge, or when no version file/field could be bumped.
  version?: string;
  // Set true when the `onRebased` hook (the caller's pre-ff RE-GATE) returned RED on the
  // REBASED tip: the fast-forward was REFUSED, so the ff-target branch is UNTOUCHED — the
  // rebased task branch + its worktree are left intact for inspection. Distinct from a
  // `conflict` (the rebase itself failed). `gateOutput` carries the gate's output tail so
  // the caller can surface the verdict to the approver. ok=false on this result.
  gateRed?: boolean;
  gateOutput?: string;
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

/** The refuse-to-merge MergeResult for a worktree poisoned with unresolved
 * conflict markers — see merge()'s pre-rebase guard. */
function poisonedResult(taskId: string, poisoned: string[]): MergeResult {
  return {
    ok: false,
    conflict: true,
    message:
      `refusing to merge ${taskId}: unresolved git conflict markers in ` +
      poisoned.join(", "),
    conflictFiles: poisoned,
  };
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
 * MERGE-LOCK SAFETY NET. On a rebase CONFLICT, attempt to AUTO-RESOLVE it in place IFF
 * the conflict is a TRIVIAL ADDITIVE changelog conflict — both sides only ADDED bullets
 * under the same heading (a changelog cascade). This is the single riskiest manual
 * ritual the CTO reached around butchr for; everything else still bounces to the agent.
 *
 * HARD GUARD-RAILS (the whole safety case):
 *  1. Fires ONLY when the unmerged set is EXACTLY [changelogRel] and non-empty. ANY other
 *     conflicted file → return false → the caller bounces the WHOLE rebase untouched
 *     (never a partial resolve).
 *  2. The union itself NEVER crosses a `## ` heading boundary and only merges bullets —
 *     enforced by changelog.unionAdditiveChangelogConflict, which returns null otherwise.
 *  3. Non-additive of ANY kind (an ancestor line edited/removed, a non-bullet added,
 *     malformed/missing diff3 markers, or a `rebase --continue` that fails for any other
 *     reason) → return false → bounce. The safe default is always "hand it to the agent."
 *  4. On a successful auto-resolve it logs a `[butchr]` line (task id + that it unioned
 *     the changelog) — never a silent rewrite, so the operator can audit it fired.
 *
 * Loops because a multi-commit rebase can stop again on the next replayed commit. Returns
 * true iff the rebase is now COMPLETE (linear atop base); false leaves the rebase STILL
 * IN PROGRESS so the caller's collectConflictAndAbort aborts it cleanly. An empty
 * `changelogRel` (no changelog configured) disables the net.
 */
async function tryUnionChangelogConflict(
  rebaseDir: string,
  base: string,
  taskId: string,
  changelogRel: string,
): Promise<boolean> {
  const rel = changelogRel.trim();
  if (!rel) return false; // net disabled — no changelog path configured
  let unions = 0;
  // Bounded loop: a backstop far above any real rebase depth. Each iteration must make
  // progress (a successful --continue) or it returns false and bounces.
  for (let guard = 0; guard < 1000; guard++) {
    // GUARD-RAIL 1: the unmerged set must be EXACTLY the changelog. Any other conflicted
    // file (or none) → bounce the whole rebase untouched.
    const unmerged = await run([
      git, "-C", rebaseDir, "diff", "--name-only", "--diff-filter=U",
    ]);
    const files = unmerged.ok
      ? unmerged.stdout.split("\n").map((l) => l.trim()).filter(Boolean)
      : [];
    if (files.length !== 1 || files[0] !== rel) return false;

    // Re-materialize the conflict in diff3 style (without redoing the merge) so the pure
    // resolver can see the common ancestor, then try the additive union.
    const clogPath = join(rebaseDir, rel);
    const co = await run([
      git, "-C", rebaseDir, "checkout", "--conflict=diff3", "--", rel,
    ]);
    if (!co.ok || !existsSync(clogPath)) return false;
    const resolved = unionAdditiveChangelogConflict(readFileSync(clogPath, "utf8"));
    if (resolved === null) return false; // GUARD-RAIL 2/3: not a clean additive union → bounce

    writeFileSync(clogPath, resolved, "utf8");
    await run([git, "-C", rebaseDir, "add", rel]);
    unions++;
    // Continue the rebase. `core.editor=true` keeps it non-interactive if git would
    // otherwise open an editor for the replayed commit message.
    const cont = await run([
      git, "-c", "core.editor=true", "-C", rebaseDir, "rebase", "--continue",
    ]);
    if (cont.ok) {
      // GUARD-RAIL 4: observable, never silent.
      console.log(
        `[butchr] merge net: auto-unioned ${unions} additive changelog conflict(s) ` +
          `in ${rel} for task ${taskId} (rebase onto ${base})`,
      );
      return true; // rebase complete
    }
    // --continue stopped again. If the rebase is genuinely gone (a hard error rather than
    // a new conflict to inspect), bail; otherwise loop and re-check the unmerged set.
    if (/no rebase in progress/i.test(`${cont.stderr}\n${cont.stdout}`)) return false;
  }
  return false;
}

/**
 * Whether the task branch's diff vs `base` touches ONLY docs files (so the
 * version bump is skipped). Resolved from the committed range `base...taskId`
 * AFTER the rebase, so it reflects exactly the task's own code changes (not the
 * version edit, which bumpVersionFile commits afterward). On any git error we return
 * false → a normal bump (the safe default — never silently skip).
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
 * MERGE-TIME VERSION BUMP (+ release-mode changelog stamp): on a successful merge,
 * butchr bumps the workspace's configured version file (`versionFile`, relative to the
 * repo root — e.g. `package.json`) so concurrent tasks stop colliding on it (agents no
 * longer hand-bump). Two modes, driven by `opts.releaseMode`:
 *
 *   NON-release_mode (the default, opt-in): PATCH-bump only, and SKIP a docs-only diff
 *   (a pure prose change isn't a new release surface). butchr does NOT write the
 *   changelog — that's the task/agent's job, enforced by the CI changelog gate
 *   (tasks.triggerCi). This preserves today's exact behavior.
 *
 *   release_mode: bump by the task's DECLARED level (`opts.bumpLevel`) — and bump on
 *   EVERY change, including docs-only — AND, in the SAME commit, stamp the changelog
 *   (`opts.changelogPath`) via promoteUnreleased: the current `## [Unreleased]` body
 *   moves into a fresh `## [X.Y.Z] - DATE` section with a clean `[Unreleased]` left
 *   above. So each merge owns its own heading (the cascade-conflict fix).
 *
 * Called from merge() AFTER a clean rebase (so it edits the up-to-date base content
 * and can't conflict) and BEFORE the fast-forward, in the worktree where the task
 * branch is checked out — the edit is committed onto the task branch so it
 * fast-forwards onto the base with the rest of the work.
 *
 * GRACEFUL NO-OP when version bumping doesn't apply, so butchr works on ANY repo: an
 * empty `versionFile` (bump disabled / not configured), a missing file, an
 * unparseable one / one with no semver `version` field (and, outside release_mode, a
 * docs-only diff) all skip the bump without failing the merge. Returns the ASSIGNED
 * version on a real bump, else undefined.
 */
async function bumpVersionFile(
  dir: string,
  wt: string,
  taskId: string,
  base: string,
  versionFile: string,
  opts: {
    releaseMode?: boolean;
    bumpLevel?: VersionBumpLevel;
    changelogPath?: string;
    dateISO?: string;
  } = {},
): Promise<string | undefined> {
  const rel = versionFile.trim();
  if (!rel) return undefined; // version bumping disabled for this workspace
  // Outside release_mode, a docs-only diff isn't a new release surface → never bump.
  // In release_mode EVERY change bumps (incl. docs-only), so this skip does not apply.
  if (!opts.releaseMode && (await taskDiffIsDocsOnly(dir, taskId, base))) return undefined;

  const pkgPath = join(wt, rel);
  if (!existsSync(pkgPath)) return undefined; // no version file in this repo → no-op
  const level: VersionBumpLevel = opts.releaseMode ? (opts.bumpLevel ?? "patch") : "patch";
  const bumped = bumpVersion(readFileSync(pkgPath, "utf8"), level);
  if (!bumped) return undefined; // no semver version field → nothing to bump

  writeFileSync(pkgPath, bumped.text, "utf8");
  await run([git, "-C", wt, "add", rel]);
  // Track exactly the paths WE staged so we can revert precisely if the commit fails (F2).
  const stagedPaths = [rel];

  // release_mode: stamp the changelog in the SAME commit so the version file + the
  // versioned `## [X.Y.Z]` heading land atomically. Best-effort on the changelog write
  // (a missing/unconfigured changelog still bumps the version) — but when both apply we
  // commit them together.
  const relClog = (opts.changelogPath ?? "").trim();
  if (opts.releaseMode && relClog) {
    const clogPath = join(wt, relClog);
    if (existsSync(clogPath)) {
      const date = opts.dateISO ?? new Date().toISOString().slice(0, 10);
      const stamped = promoteUnreleased(readFileSync(clogPath, "utf8"), bumped.to, date);
      writeFileSync(clogPath, stamped, "utf8");
      await run([git, "-C", wt, "add", relClog]);
      stagedPaths.push(relClog);
    }
  }

  const msg = opts.releaseMode
    ? `butchr: release ${bumped.to} (${level} bump from ${bumped.from}, task ${taskId})`
    : `butchr: bump version ${bumped.from} → ${bumped.to} (task ${taskId})`;
  // F2 — the commit can FAIL (no user.email/name, a rejecting commit hook, disk error).
  // If we ignored that and returned bumped.to, merge() would ff WITHOUT this version/
  // changelog commit yet still report a version → finalizeMerge records a PHANTOM release
  // whose bump never landed, and the teardown discards the stranded staged edit. So check
  // `.ok` and, on failure, FAIL the merge (throw — merge() converts this to ok:false and
  // refuses the ff; no version is returned, no release recorded). Before throwing, REVERT
  // our own staged edits (`git checkout HEAD -- <paths>` restores both index + worktree)
  // so a re-queue starts from a CLEAN tree: otherwise a later merge()'s dangling-changes
  // step would commit them as "finalize task" and THEN bump a SECOND time — a double patch
  // jump + a duplicate `## [X.Y.Z]` heading. At this point the rest of the tree is already
  // clean (dangling committed, rebase done), so this touches only the files we dirtied.
  const commit = await run([git, "-C", wt, "commit", "-m", msg]);
  if (!commit.ok) {
    await run([git, "-C", wt, "checkout", "HEAD", "--", ...stagedPaths]);
    throw new Error(
      `version bump commit failed (task ${taskId}): ` +
        ((commit.stderr || commit.stdout).trim() || "git commit returned non-zero"),
    );
  }
  return bumped.to;
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
/**
 * Merge-time options resolved by the caller (tasks.finalizeMerge):
 *  - `versionFile` — the per-workspace version file to bump, EMPTY to disable the bump
 *    (the default — version bumping is opt-in per workspace). See bumpVersionFile.
 *  - `releaseMode` — when true (the workspace's release_mode), bump by `bumpLevel` on
 *    EVERY change AND stamp the changelog (`changelogPath`) with a versioned heading in
 *    the same commit; when false, today's patch-only / docs-only-skip behavior.
 *  - `bumpLevel` — the task's declared bump level (release_mode only; default patch).
 *  - `changelogPath` — the changelog to stamp (release_mode only).
 *  - `dateISO` — the date for the stamped heading (defaults to today; passed in so the
 *    caller controls it).
 *  - `base` — the ref the task branch is REBASED onto. DEFAULTS to defaultBranch(dir)
 *    when omitted (today's behavior). A story member passes its story branch.
 *  - `ffWorktree` / `ffTargetBranch` — the FF-TARGET: the worktree to fast-forward in
 *    and the branch it advances. DEFAULT to `{ dir, defaultBranch(dir) }` when omitted
 *    (today: ff `main` in the repo root). A story member passes its story worktree +
 *    story branch so the subtask fast-forwards into the story checkout (CONTRIBUTING
 *    §11.2/§11.4). With the defaults the git commands + captured shas are identical to
 *    today's single-level merge.
 *  - `sourceWorktree` — the SOURCE checkout where `taskId`'s branch is committed + rebased
 *    (and the version bump is committed). DEFAULTS to `worktreePath(dir, taskId)` — the
 *    task's own worktree — so an omitted value is byte-for-byte today's merge. A story→main
 *    merge passes the STORY WORKTREE: the story branch (`butchr/story/<id>`) and its
 *    worktree dir (`butchr-story-<id>`) diverge, so the default `worktreePath(dir, taskId)`
 *    would not find the checkout. `taskId` itself stays the git REF used for the rebase
 *    target / ff source / diff range (CONTRIBUTING §11.4).
 */
export type MergeOptions = {
  versionFile?: string;
  releaseMode?: boolean;
  bumpLevel?: VersionBumpLevel;
  changelogPath?: string;
  dateISO?: string;
  base?: string;
  ffWorktree?: string;
  ffTargetBranch?: string;
  sourceWorktree?: string;
  // RE-GATE HOOK: run by the caller (tasks.finalizeMerge) on the REBASED (+bumped) task
  // tip — AFTER the rebase/version-bump, BEFORE the fast-forward. Receives the rebase
  // worktree dir so the caller can build/test that exact tip. A `false` result REFUSES
  // the ff (the ff-target branch is left UNTOUCHED) and merge returns `{ ok:false,
  // gateRed:true, gateOutput }`. This is the spot — and the ONLY spot — that gates the
  // true tip that would land: git's 3-way rebase can silently auto-resolve newer
  // non-overlapping base content the task's own (stale) tests never exercise, so a tip
  // that was green pre-rebase can be red post-rebase. Omitted = today's merge, unchanged.
  onRebased?: (rebaseDir: string) => Promise<{ ok: boolean; output: string }>;
};

export async function merge(
  dir: string,
  taskId: string,
  opts: MergeOptions = {},
): Promise<MergeResult> {
  // Resolve the rebase base + the ff-target (worktree to ff in + branch it advances).
  // All default to the single-level main flow ({ base: main, ffWorktree: dir,
  // ffTargetBranch: main }), so an omitted opts is byte-for-byte today's merge.
  const def = await defaultBranch(dir);
  const base = opts.base ?? def;
  const ffWorktree = opts.ffWorktree ?? dir;
  const ffTargetBranch = opts.ffTargetBranch ?? def;
  // The SOURCE checkout where the task branch is committed + rebased. Defaults to the
  // task's own worktree (<dir>/<taskId>); a story→main merge overrides it with the story
  // worktree (the story branch ref and its worktree dir name diverge — see MergeOptions).
  // Every use of `wt` below flows from this one definition, so an omitted override is
  // byte-for-byte today's merge.
  const wt = opts.sourceWorktree ?? worktreePath(dir, taskId);

  // F4 — assert the ff-target worktree is on the EXPECTED branch (not detached / not the
  // wrong branch) and tracked-clean BEFORE we mutate anything. Done at the TOP — ahead of
  // the dangling-changes commit, the rebase, the version bump, and the ff — so a detached
  // or wrong-branch ff-target refuses the merge without touching the source worktree (in
  // particular before the bump commits onto the task branch, which would otherwise leave a
  // bump commit that re-bumps on a later re-queue). The ff-target's state is independent of
  // the rebase (which runs in the SOURCE worktree), so checking here is equivalent to
  // checking right before the ff but wastes no work. Refusal returns a non-conflict failure
  // → finalizeMerge's 409 hard-refusal path (ff-target untouched, no teardown).
  const ffReady = await assertFfTargetReady(ffWorktree, ffTargetBranch);
  if (!ffReady.ok) {
    return { ok: false, conflict: false, message: ffReady.message, conflictFiles: [] };
  }

  // Auto-commit any dangling worktree changes so they're part of the rebase.
  if (existsSync(wt)) {
    const st = await run([git, "-C", wt, "status", "--porcelain"]);
    const dirty = st.ok && st.stdout.trim().length > 0;
    // Stage everything first so the marker scan also sees newly-added files.
    if (dirty) await run([git, "-C", wt, "add", "-A"]);
    // GUARD: never commit/merge content that still has unresolved conflict markers —
    // that's exactly how a poisoned diff reached the base before. Scan ONCE; this
    // catches both dirty (staged) and already-COMMITTED markers. Hold the task for
    // human review instead (worktree left staged, base untouched).
    const poisoned = await findConflictMarkers(wt);
    if (poisoned.length > 0) return poisonedResult(taskId, poisoned);
    // Clean — commit the (now staged) dangling changes onto the task branch. The commit
    // result is intentionally unchecked: it's FAIL-SAFE. If this commit fails (e.g. a
    // rejecting hook / missing identity), the staged changes stay in the worktree, so the
    // very next `git rebase base` refuses on a dirty tree (rb.ok=false) and we bounce down
    // the conflict/abort path below with the base UNTOUCHED — no half-merged tip escapes.
    // (Contrast the version-bump commit in bumpVersionFile, which we DO check: it runs after
    // the rebase, so a dirty tree wouldn't be caught by anything downstream.)
    if (dirty) {
      await run([
        git, "-C", wt, "commit", "-m", `butchr: finalize task ${taskId}`,
      ]);
    }
  }

  // Rebase the task branch onto the current base tip. Run it in the worktree
  // where the task branch is checked out (the base stays checked out at `dir`).
  const rebaseDir = existsSync(wt) ? wt : dir;
  const rb = await run([git, "-C", rebaseDir, "rebase", base]);
  if (!rb.ok) {
    // SAFETY NET: a purely-additive changelog conflict (both sides only ADDED bullets) is
    // auto-unioned in place rather than bounced — the riskiest manual ritual. ANY other
    // file, or a non-additive edit, still bounces untouched (tryUnionChangelogConflict's
    // guard-rails). On a successful union the rebase is now linear atop base, so we fall
    // through to the bump + ff below exactly as on a clean rebase.
    const unioned = await tryUnionChangelogConflict(
      rebaseDir, base, taskId, opts.changelogPath ?? "",
    );
    if (!unioned) {
      // Conflict (or other rebase failure). Abort so the task branch + worktree are
      // left CLEAN and the base UNTOUCHED; the agent (or a fresh one) integrates
      // base and re-submits.
      const { conflict, conflictFiles, message } =
        await collectConflictAndAbort(rebaseDir, rb, base);
      return { ok: false, conflict, message, conflictFiles };
    }
  }

  // Clean rebase — the task branch is now linear atop base. If the workspace opted
  // into a merge-time version bump, butchr patch-bumps the version file here,
  // committed onto the task branch so it fast-forwards with the rest of the work.
  // Done AFTER the rebase so it edits the up-to-date base content and can't collide
  // with a concurrent task — the whole reason the bump moved off the agents. butchr
  // does NOT write the changelog (the task owns it; the CI gate enforces it).
  // Best-effort no-op when disabled / no version file (see bumpVersionFile); only
  // when the branch has a worktree. In release_mode this also stamps the changelog with
  // the versioned heading in the same commit, and returns the assigned version.
  let assignedVersion: string | undefined;
  if (existsSync(wt)) {
    try {
      assignedVersion = await bumpVersionFile(dir, wt, taskId, base, opts.versionFile ?? "", {
        releaseMode: opts.releaseMode,
        bumpLevel: opts.bumpLevel,
        changelogPath: opts.changelogPath,
        dateISO: opts.dateISO,
      });
    } catch (e) {
      // F2 — the version-bump commit FAILED (bumpVersionFile already reverted its own staged
      // edits, leaving the worktree clean). REFUSE the ff: returning ok:false with NO version
      // means finalizeMerge records no phantom release and tears nothing down (the work
      // survives for a fixup / re-queue). Routes through finalizeMerge's 409 hard-refusal.
      return {
        ok: false,
        conflict: false,
        conflictFiles: [],
        message: e instanceof Error ? e.message : `version bump failed: ${String(e)}`,
      };
    }
  }

  // RE-GATE the REBASED (+bumped) tip BEFORE the fast-forward. This is the crux of the
  // stale-base guard: the rebase above may have silently folded in newer base content the
  // task's own tests don't cover, so a tip that was green when the agent submitted can be
  // red now. Run the caller's gate on the rebase worktree (where the linear tip lives); a
  // RED result REFUSES the ff so a broken commit never reaches the ff-target branch — the
  // target is left exactly where it was. Mirrors mergeWorkBranch/mergeStoryBranch's re-gate,
  // but inserted on the POST-rebase tip (those gate the pre-rebase tip in their wrapper).
  if (opts.onRebased) {
    const gate = await opts.onRebased(rebaseDir);
    if (!gate.ok) {
      return {
        ok: false,
        conflict: false,
        gateRed: true,
        gateOutput: gate.output,
        message: "rebased tip failed the re-gate; fast-forward refused",
        conflictFiles: [],
      };
    }
  }

  // Capture the ff-target branch tip BEFORE the fast-forward: it's the exclusive lower
  // bound of the commits this task is about to land, recorded so the merge can be
  // reverted later (this range now also covers the changelog/version commit above).
  // Read in the ff-worktree against the target branch — with the defaults this is
  // `git -C dir rev-parse main`, identical to before.
  const baseBefore = await run([git, "-C", ffWorktree, "rev-parse", ffTargetBranch]);
  // Fast-forward the ff-target branch to it (no merge commit). `git merge --ff-only`
  // advances whatever branch is checked out in ffWorktree (the target branch). This
  // cannot conflict; it can only fail if the target moved between the rebase and here
  // (callers serialize merges to prevent that).
  const ff = await run([git, "-C", ffWorktree, "merge", "--ff-only", taskId]);
  if (ff.ok) {
    const after = await run([git, "-C", ffWorktree, "rev-parse", ffTargetBranch]);
    return {
      ok: true,
      conflict: false,
      message: ff.stdout.trim(),
      conflictFiles: [],
      baseSha: baseBefore.ok ? baseBefore.stdout.trim() : undefined,
      mergedSha: after.ok ? after.stdout.trim() : undefined,
      version: assignedVersion,
    };
  }
  return {
    ok: false,
    conflict: false,
    message: (ff.stderr || ff.stdout).trim() || `fast-forward into ${ffTargetBranch} failed`,
    conflictFiles: [],
  };
}

/**
 * Merge a completed isolated story's BRANCH into the default branch (main) — the story→main
 * step of the 3-level model (CONTRIBUTING §11.4). A THIN wrapper over the generalized
 * merge(): task = the story branch, base = main, the SOURCE checkout = the story worktree
 * (where the story branch is checked out), and the ff-target = main at the repo root (dir).
 * This is "today's merge() flow with task = story-branch and base = main" the design calls
 * for; encoding the §11.4 mapping in one place keeps the completion path trivial.
 * Called from tasks.mergeStoryBranch on an isolated story's completion path — LIVE but
 * guarded by that story's captured isolated bit (stories.landStory only lands isolated stories).
 */
export async function mergeStoryToMain(
  dir: string,
  storyId: string,
  opts: Omit<MergeOptions, "base" | "sourceWorktree" | "ffWorktree" | "ffTargetBranch"> = {},
): Promise<MergeResult> {
  const main = await defaultBranch(dir);
  return merge(dir, storyBranchName(storyId), {
    ...opts,
    base: main,
    sourceWorktree: storyWorktreePath(dir, storyId),
    ffWorktree: dir,
    ffTargetBranch: main,
  });
}

// ---- RECURSIVE WORK-NODE BRANCH LIFECYCLE (st-540ba705 step 4 — ADDITIVE + INERT) ----
// The ARBITRARY-DEPTH generalization of the STORY-branch helpers above (§4, Q9 of
// docs/rfc-work-workspace-unification.md): every NODE Work can own a branch + worktree, a
// child branches FROM and fast-forwards INTO its parent node's branch (which itself merges
// upward), bottoming out at the default branch for a top-level node. These are PARALLEL,
// purely-additive helpers — the live STORY path (storyBranchName / ensureStoryBranch /
// mergeStoryToMain / removeStoryBranch) is UNTOUCHED. They have NO live caller this step
// (tasks.ts wires them only behind the OFF config.recursiveBranchIsolation gate, exercised
// by tests); activation is a separate deliberate call (RFC Q9). The branch prefix differs
// from the story prefix so the two models can't collide on a ref.

/**
 * The branch-name prefix for a WORK-NODE branch (`butchr/work/`). The single source of
 * truth, shared by workBranchName (build) and workIdFromBranch (parse). Distinct from
 * STORY_BRANCH_PREFIX so a recursive work-node branch can't collide with a story branch.
 */
const WORK_BRANCH_PREFIX = "butchr/work/";

/**
 * The branch name for a WORK NODE's branch: `butchr/work/<workId>`. Pure (no git I/O). The
 * `butchr/work/` prefix can't collide with task branches (named by the `adjective-noun-4hex`
 * id), the default branch, or story branches (`butchr/story/`). The arbitrary-depth analogue
 * of storyBranchName.
 */
export function workBranchName(workId: string): string {
  return `${WORK_BRANCH_PREFIX}${workId}`;
}

/**
 * Absolute path to a WORK NODE's worktree: `<dir>/butchr-work-<workId>`. Pure (no git I/O).
 * The DASH-joined dir name deliberately differs from the SLASH-prefixed branch
 * (`butchr/work/<workId>`) so the branch can't collide with task branches while the worktree
 * stays a single flat sibling dir of the repo root. The analogue of storyWorktreePath.
 */
export function workWorktreePath(dir: string, workId: string): string {
  return join(dir, `butchr-work-${workId}`);
}

/** Recover a workId from its work-node branch (`butchr/work/<id>` → `<id>`). The inverse of
 * workBranchName; falls back to the input unchanged if it carries no work prefix. */
export function workIdFromBranch(workBranch: string): string {
  return workBranch.startsWith(WORK_BRANCH_PREFIX)
    ? workBranch.slice(WORK_BRANCH_PREFIX.length)
    : workBranch;
}

/**
 * Lazily ensure a WORK NODE's BRANCH + its worktree exist, returning the worktree path
 * (`<dir>/butchr-work-<workId>`). The arbitrary-depth generalization of ensureStoryBranch:
 * IDENTICAL validate-or-rebuild idempotency (restart-safe, safe to call before every child is
 * branched off it), with ONE difference — the FIRST creation cuts the node branch off the
 * EXPLICIT `base` param rather than always the repo default. A top-level node passes the
 * default branch (today's story behavior); a child node passes its PARENT node's work branch,
 * so the tree nests to arbitrary depth (RFC §4/Q8). `base` must be a real ref (the caller
 * ensures the parent chain first — see tasks.ensureNodeChain).
 *
 *  1. A VALID worktree at the path is reused unchanged — the reuse probe passes
 *     `base = the work branch itself`, so the stale-base check is trivially satisfied: a node
 *     branch LEGITIMATELY diverges from its base (it accrues child merges) and must NEVER be
 *     rebuilt for being "behind".
 *  2. A broken/missing-link leftover is removed WORKTREE-ONLY (it does NOT delete the branch,
 *     which carries merged child commits) and re-attached.
 *  3. If the branch already exists (it holds child work) but had no live worktree, a fresh
 *     worktree is attached onto the EXISTING branch (preserving the work). Only the FIRST
 *     creation cuts the branch off `base`.
 */
export async function ensureWorkBranch(
  dir: string,
  workBranch: string,
  base: string,
): Promise<string> {
  const workId = workIdFromBranch(workBranch);
  const path = workWorktreePath(dir, workId);
  await addLocalExclude(dir, `/butchr-work-${workId}/`);
  if (existsSync(path)) {
    // base = the work branch itself → the stale-base probe is a trivial no-op, so a valid
    // node worktree is reused even when it has fallen "behind" the moving base.
    if (await worktreeIsReusable(dir, workBranch, path, workBranch)) return path;
    await removeStaleStoryWorktree(dir, path); // WORKTREE-ONLY — never deletes the branch
  }
  if (await branchExists(dir, workBranch)) {
    // Branch exists (merged child work) but its worktree was missing/broken → re-attach a
    // worktree onto the EXISTING branch so none of that work is lost.
    await runOrThrow([git, "-C", dir, "worktree", "add", path, workBranch]);
  } else {
    // First lazy creation → cut the node branch off the EXPLICIT base (default tip for a
    // top-level node, the parent node's work branch for a child) + check it out.
    await runOrThrow([git, "-C", dir, "worktree", "add", "-b", workBranch, path, base]);
  }
  return path;
}

/**
 * Tear down a WORK NODE's worktree AND delete its branch — the completion/cleanup counterpart
 * of ensureWorkBranch (the analogue of removeStoryBranch). Removes the worktree (clean
 * remove, then an outright delete + prune if a broken link left the dir behind) and then
 * `branch -D`s the work branch. Best-effort + idempotent (a no-op when neither exists).
 */
export async function removeWorkBranch(dir: string, workBranch: string): Promise<void> {
  const workId = workIdFromBranch(workBranch);
  const path = workWorktreePath(dir, workId);
  if (existsSync(path)) {
    await run([git, "-C", dir, "worktree", "remove", "--force", path]);
  }
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  await run([git, "-C", dir, "worktree", "prune"]);
  await run([git, "-C", dir, "branch", "-D", workBranch]);
}

/**
 * Merge a completed WORK NODE's branch INTO its PARENT — the node→parent step of the
 * recursive model, the arbitrary-depth analogue of mergeStoryToMain. A THIN wrapper over the
 * generalized merge(): task = the node's work branch, base = the parent branch, the SOURCE
 * checkout = the node's worktree (where the work branch is checked out), and the ff-target =
 * the parent branch in the PARENT worktree. For a TOP-LEVEL node the caller passes the
 * default branch + repo root as the parent context, so it lands on the default branch exactly
 * as mergeStoryToMain does. Encoding the mapping here keeps the completion path trivial. NO
 * live caller this step — invoked only by tasks.mergeWorkBranch behind the OFF gate.
 */
export async function mergeWorkToParent(
  dir: string,
  workId: string,
  parentBranch: string,
  parentWorktree: string,
  opts: Omit<MergeOptions, "base" | "sourceWorktree" | "ffWorktree" | "ffTargetBranch"> = {},
): Promise<MergeResult> {
  return merge(dir, workBranchName(workId), {
    ...opts,
    base: parentBranch,
    sourceWorktree: workWorktreePath(dir, workId),
    ffWorktree: parentWorktree,
    ffTargetBranch: parentBranch,
  });
}

/**
 * Whether the task branch is BEHIND the default branch — i.e. the current
 * default-branch tip is NOT already contained in the task branch. A freshly
 * created worktree branches from the current default HEAD, so it is up to date
 * and this returns false; it returns true only for a branch cut from a STALE
 * default tip (e.g. a chained/blocked task whose worktree was created before its
 * blockers merged). Used as the cheap, lock-free gate in front of the (serialized)
 * pre-dispatch rebase so up-to-date branches never pay for the merge queue.
 *
 * `base` is the ref the branch is measured behind; it DEFAULTS to defaultBranch(dir)
 * when omitted (today's behavior). A story member passes its story branch (CONTRIBUTING §11.2).
 */
export async function isBehindDefault(
  dir: string,
  taskId: string,
  base?: string,
): Promise<boolean> {
  base ??= await defaultBranch(dir);
  // The branch already contains the tip → not behind. branchContainsBase wraps the
  // `merge-base --is-ancestor` probe.
  return !(await branchContainsBase(dir, base, taskId));
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
 *
 * `base` is the ref the branch is rebased/reset onto; it DEFAULTS to defaultBranch(dir)
 * when omitted (today's behavior). A story member passes its story branch so an
 * in-flight member tracks the advancing story branch (CONTRIBUTING §11.2/§11.4). It is
 * the LAST param so the existing `(dir, taskId, changelogPath)` callers are unchanged.
 */
export async function rebaseOntoDefault(
  dir: string,
  taskId: string,
  changelogPath = "",
  base?: string,
): Promise<RebaseResult> {
  base ??= await defaultBranch(dir);
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
  if (await branchContainsBase(dir, base, taskId)) return noop();

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
  const hasCommits = (await branchOwnCommitCount(dir, base, taskId)) > 0;

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

  // SAFETY NET: auto-union a purely-additive changelog conflict in place (same guard-rails
  // as merge() — only the changelog, only additive bullets, else bounce).
  if (await tryUnionChangelogConflict(wt, base, taskId, changelogPath)) {
    return noop({
      rebased: true,
      message: `rebased ${taskId} onto ${base} (additive changelog conflict auto-unioned)`,
    });
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

/** Ensure `.butchr/` is gitignored in the workspace root. */
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

// ---- POWER-LOSS RESILIENCE ---------------------------------------------------
// A power loss that interrupts a git write mid-fsync can leave TRUNCATED/0-byte
// loose objects in .git/objects; git then refuses to merge/prune and the repo
// wedges (the real incident this hardens against — an operator had to fsck + hand
// remove the dangling corrupt objects). Two defenses, both applied to EVERY managed
// repo: setGitDurability (fsync object writes so the truncation can't happen) and
// healLooseObjects (auto-recover from any that already exist — but ONLY the ones
// provably unreachable from a ref).

/**
 * DURABLE OBJECT WRITES: configure `dir`'s git so a power loss can't leave a
 * truncated/empty loose object behind.
 *  - core.fsyncObjectFiles=true — fsync each loose object (honored by git < 2.36).
 *  - core.fsync=all             — fsync objects + refs + index (git >= 2.36; the
 *                                 older knob is ignored there). Harmless on older git.
 * Idempotent (`git config` just overwrites) and best-effort (never throws): a config
 * failure must not break registration or boot. Gated by config.gitFsync (a no-op
 * when off, so an operator who manages these settings themselves can opt out).
 */
export async function setGitDurability(dir: string): Promise<void> {
  if (!config.gitFsync) return;
  await run([git, "-C", dir, "config", "core.fsyncObjectFiles", "true"]);
  await run([git, "-C", dir, "config", "core.fsync", "all"]);
}

export type HealReport = {
  /** SHAs of corrupt loose objects PROVABLY-unreachable from any ref and removed. */
  removed: string[];
  /** SHAs of corrupt objects left in place because reachable corruption was
   *  detected — surfaced for manual repair, NEVER auto-deleted. */
  reachableCorrupt: string[];
  /** True iff we bailed without deleting anything (reachable corruption present). */
  skipped: boolean;
  /** Human-readable note (fsck status after removal, or the bail reason). */
  note: string;
};

/** Scan `<objectsDir>/<xx>/<38hex>` for 0-byte (truncated) loose objects → sha→path. */
function scanEmptyLooseObjects(objectsDir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(objectsDir)) return out;
  let subs: string[];
  try {
    subs = readdirSync(objectsDir);
  } catch {
    return out;
  }
  for (const sub of subs) {
    if (!/^[0-9a-f]{2}$/.test(sub)) continue;
    const subdir = join(objectsDir, sub);
    let files: string[];
    try {
      files = readdirSync(subdir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!/^[0-9a-f]{38}$/.test(f)) continue;
      const p = join(subdir, f);
      try {
        if (statSync(p).size === 0) out.set(sub + f, p);
      } catch {
        /* vanished between readdir and stat — ignore */
      }
    }
  }
  return out;
}

/**
 * SHAs `git fsck` names as empty/corrupt/missing (best-effort; empty on a clean repo).
 * Handles BOTH forms git emits: a bare 40-hex sha ("loose object <sha> is corrupt",
 * "<sha>: object corrupt or missing") and an object-file PATH
 * (".git/objects/ab/cdef… is empty"), reassembling the latter into a sha.
 */
async function fsckCorruptShas(dir: string): Promise<string[]> {
  const r = await run([git, "-C", dir, "fsck", "--no-dangling", "--no-progress"]);
  const shas = new Set<string>();
  for (const line of (r.stdout + "\n" + r.stderr).split("\n")) {
    if (!/empty|corrupt|missing/i.test(line)) continue;
    const bare = line.match(/[0-9a-f]{40}/);
    if (bare) {
      shas.add(bare[0]);
      continue;
    }
    const pathForm = line.match(/objects[/\\]([0-9a-f]{2})[/\\]([0-9a-f]{38})/);
    if (pathForm) shas.add(pathForm[1] + pathForm[2]);
  }
  return [...shas];
}

/** The object shas each resolvable ref (branches/tags + HEAD) points at, deduped. */
async function resolvableRefShas(dir: string): Promise<string[]> {
  const shas = new Set<string>();
  const fer = await run([git, "-C", dir, "for-each-ref", "--format=%(objectname)"]);
  if (fer.ok) {
    for (const l of fer.stdout.split("\n")) {
      const s = l.trim();
      if (/^[0-9a-f]{40}$/.test(s)) shas.add(s);
    }
  }
  const head = await run([git, "-C", dir, "rev-parse", "--verify", "--quiet", "HEAD"]);
  if (head.ok && /^[0-9a-f]{40}$/.test(head.stdout.trim())) shas.add(head.stdout.trim());
  return [...shas];
}

/**
 * Walk every resolvable ref's object closure. `ok` is false iff ANY ref's
 * `git rev-list --objects <ref>` failed — rev-list inflates every commit/tree it
 * reaches and exits non-zero the instant it hits a corrupt/missing one, so a failure
 * means there is REACHABLE corruption. `reachable` is the union of all object shas
 * enumerated across the SUCCESSFUL walks — the same closure `rev-list --objects
 * --all` produces — used for the blob-safe cross-check (rev-list enumerates blobs by
 * name WITHOUT inflating them, so a corrupt blob wouldn't fail the walk but its sha
 * still appears here). A repo with no resolvable refs yields ok=true + an empty set
 * (nothing is reachable, so every candidate is trivially safe to remove).
 */
async function refClosure(dir: string): Promise<{ ok: boolean; reachable: Set<string> }> {
  const reachable = new Set<string>();
  let ok = true;
  for (const ref of await resolvableRefShas(dir)) {
    const r = await run([git, "-C", dir, "rev-list", "--objects", ref]);
    if (!r.ok) {
      ok = false;
      continue;
    }
    for (const line of r.stdout.split("\n")) {
      const tok = line.trim().split(" ")[0];
      if (tok) reachable.add(tok);
    }
  }
  return { ok, reachable };
}

/**
 * POWER-LOSS SELF-HEAL of dangling/corrupt LOOSE OBJECTS in `dir`. Removes the
 * truncated/empty (and fsck-corrupt) loose objects a power loss can leave behind —
 * but ONLY the ones PROVABLY unreachable from any ref. The proof runs in order and
 * deletes nothing unless BOTH guards pass:
 *
 *  1. DETECT (candidate set = UNION): (a) a cheap filesystem scan for 0-byte loose
 *     object files PLUS (b) the SHAs `git fsck` flags as empty/corrupt that still
 *     exist as loose objects — so a NON-empty-but-corrupt object is detected too, not
 *     only 0-byte truncations. fsck runs unconditionally and only WIDENS the set (it
 *     is never a delete trigger on its own). No candidates from EITHER → cheap no-op
 *     return, WITHOUT the expensive ref walk (a clean boot stays cheap).
 *  3. ALL-REFS-INTACT: walk EVERY resolvable ref with `git rev-list --objects`. If
 *     ANY ref's walk fails there is REACHABLE corruption (a corrupt commit/tree) →
 *     BAIL: delete nothing, return skipped=true with the corrupt shas surfaced.
 *  4. BELT-AND-SUSPENDERS: from the successful walks we have the full reachable
 *     closure. If ANY candidate sha is in it (e.g. a corrupt BLOB, which step 3
 *     enumerates by name without inflating, so wouldn't have failed) → BAIL the same
 *     way. Only candidates PROVABLY ABSENT from the reachable closure are removed.
 *
 * Removal is surgical + load-bearing: `rmSync` each provably-unreachable corrupt
 * loose object. The follow-on `git prune` is OPTIONAL hygiene — best-effort, its
 * failure never fails the heal (the rmSync above already fixed the corruption).
 * Finally re-run fsck for the report note. Best-effort throughout: a git error
 * yields a benign empty report rather than throwing into boot.
 */
export async function healLooseObjects(dir: string): Promise<HealReport> {
  const report = (over: Partial<HealReport> = {}): HealReport => ({
    removed: [],
    reachableCorrupt: [],
    skipped: false,
    note: "",
    ...over,
  });

  const gp = await run([git, "-C", dir, "rev-parse", "--git-path", "objects"]);
  if (!gp.ok) return report({ note: "not a git repository" });
  const objectsDir = resolve(dir, gp.stdout.trim());

  // (1) DETECT: the candidate set is the UNION of two detectors —
  //   (a) 0-byte loose object FILES (the classic power-loss truncation), found by a
  //       cheap filesystem scan; and
  //   (b) SHAs `git fsck` flags as empty/corrupt that still exist on disk as loose
  //       objects — this catches a NON-empty-but-corrupt object (a truncation that
  //       left a partial, non-zero file), which the size scan alone would miss.
  // fsck runs UNCONDITIONALLY so that class is never missed; it only WIDENS the set
  // (it is never a delete trigger on its own — deletion still requires the
  // unreachable proof below). We no-op only when BOTH detectors come back empty.
  const candidates = scanEmptyLooseObjects(objectsDir); // (a)
  for (const sha of await fsckCorruptShas(dir)) {        // (b)
    if (candidates.has(sha)) continue;
    const p = join(objectsDir, sha.slice(0, 2), sha.slice(2));
    if (existsSync(p)) candidates.set(sha, p);
  }
  if (candidates.size === 0) return report({ note: "no corrupt loose objects" });

  // (3)+(4) Prove every candidate is unreachable BEFORE deleting anything.
  const { ok, reachable } = await refClosure(dir);
  const candidateShas = [...candidates.keys()];
  if (!ok) {
    return report({
      skipped: true,
      reachableCorrupt: candidateShas,
      note: "a ref's rev-list failed — reachable corruption present; removed nothing",
    });
  }
  const reachableHit = candidateShas.filter((s) => reachable.has(s));
  if (reachableHit.length > 0) {
    return report({
      skipped: true,
      reachableCorrupt: reachableHit,
      note: "corrupt object(s) reachable from a ref; removed nothing",
    });
  }

  // All candidates proven unreachable → surgical removal (load-bearing).
  const removed: string[] = [];
  for (const [sha, p] of candidates) {
    try {
      rmSync(p, { force: true });
      removed.push(sha);
    } catch {
      /* leave it; surfaced via the fsck note below */
    }
  }

  // Optional hygiene: sweep any remaining danglers. Best-effort — a prune failure
  // must NOT fail the heal (the rmSync above already removed the corruption, and
  // plain prune respects reflogs + the default grace, so it can't drop live work).
  await run([git, "-C", dir, "prune"]);

  const after = await run([git, "-C", dir, "fsck", "--no-progress"]);
  return report({
    removed,
    note: after.ok ? "fsck clean after removal" : "fsck still reports issues after removal",
  });
}
