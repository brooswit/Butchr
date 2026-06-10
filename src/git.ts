// Git operations butchr owns directly. All run against a directory root that
// is a git repository. Task branches/worktrees are named by task ID.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { run, runOrThrow } from "./exec.ts";

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

/** Create a worktree on a new branch <taskId> at <dir>/<taskId>. */
export async function createWorktree(
  dir: string,
  taskId: string,
): Promise<string> {
  const path = worktreePath(dir, taskId);
  // Locally ignore the worktree dir so it never shows as an untracked/embedded
  // repo (and can't be accidentally `git add`-ed). Uses .git/info/exclude, which
  // is local-only — we never touch the user's tracked .gitignore for this.
  await addLocalExclude(dir, `/${taskId}/`);
  if (existsSync(path)) return path; // already created (idempotent dispatch)
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
  // inclusive upper bound). Recorded by the caller so the task can later be rolled
  // back by reverting exactly this range (see revertCommits / tasks.rollbackTask).
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
export async function merge(dir: string, taskId: string): Promise<MergeResult> {
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
    // Conflict (or other rebase failure). Collect the unmerged files before we
    // abort — `--diff-filter=U` is more reliable than scraping git's text.
    const unmerged = await run([
      git, "-C", rebaseDir, "diff", "--name-only", "--diff-filter=U",
    ]);
    let conflictFiles = unmerged.ok
      ? unmerged.stdout.split("\n").map((l) => l.trim()).filter(Boolean)
      : [];
    if (conflictFiles.length === 0) {
      conflictFiles = parseConflictFiles(rb.stdout + "\n" + rb.stderr);
    }
    // Abort so the task branch + worktree are left CLEAN and the base UNTOUCHED.
    // The agent (or a fresh one) integrates base and re-submits.
    await run([git, "-C", rebaseDir, "rebase", "--abort"]);
    const combined = rb.stdout + "\n" + rb.stderr;
    const conflict = /conflict/i.test(combined) || conflictFiles.length > 0;
    return {
      ok: false,
      conflict,
      message: (rb.stderr || rb.stdout).trim() || `rebase onto ${base} failed`,
      conflictFiles,
    };
  }

  // Clean rebase — the task branch is now linear atop base. Capture the base tip
  // BEFORE the fast-forward: it's the exclusive lower bound of the commits this
  // task is about to land, recorded so the merge can be reverted later.
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

  // Conflict (or other rebase failure). Collect the unmerged files before aborting.
  const unmerged = await run([
    git, "-C", wt, "diff", "--name-only", "--diff-filter=U",
  ]);
  let conflictFiles = unmerged.ok
    ? unmerged.stdout.split("\n").map((l) => l.trim()).filter(Boolean)
    : [];
  if (conflictFiles.length === 0) {
    conflictFiles = parseConflictFiles(rb.stdout + "\n" + rb.stderr);
  }
  // Abort so the branch + worktree are left CLEAN on their original base.
  await run([git, "-C", wt, "rebase", "--abort"]);
  const combined = rb.stdout + "\n" + rb.stderr;
  const conflict = /conflict/i.test(combined) || conflictFiles.length > 0;
  return {
    ok: false,
    rebased: false,
    conflict,
    skippedDirty: false,
    message: (rb.stderr || rb.stdout).trim() || `rebase onto ${base} failed`,
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

export type RevertResult = {
  ok: boolean;
  // True when the revert couldn't apply cleanly because the reverted commits
  // conflict with later changes on the default branch (git left markers, which we
  // then abort away). The caller surfaces this distinctly so the operator knows a
  // manual revert is needed rather than something being broken.
  conflict: boolean;
  message: string;
  // On success, the new default-branch tip after the revert commit(s).
  revertedSha?: string;
};

/**
 * Roll back a previously-merged task by reverting the commits it contributed —
 * the range `(fromSha, toSha]` (fromSha exclusive, toSha inclusive) — as fresh
 * revert commits on the default branch. Runs at `dir`, where the default branch
 * is checked out, so the revert commits land directly on it.
 *
 * On a clean revert: returns ok=true with the new tip. On conflict (or any other
 * failure): aborts the in-progress revert so the working tree + index are left
 * CLEAN — never a half-applied revert or stray conflict markers — and returns
 * ok=false with `conflict` set when git reported a content conflict.
 */
export async function revertCommits(
  dir: string,
  fromSha: string,
  toSha: string,
): Promise<RevertResult> {
  const res = await run([
    git, "-C", dir, "revert", "--no-edit", `${fromSha}..${toSha}`,
  ]);
  if (!res.ok) {
    const combined = `${res.stdout}\n${res.stderr}`;
    const conflict = /conflict/i.test(combined);
    // Abort any in-progress revert so the tree is left clean. If no revert was
    // actually started (e.g. an empty range), `--abort` is a harmless no-op.
    await run([git, "-C", dir, "revert", "--abort"]);
    return {
      ok: false,
      conflict,
      message:
        (res.stderr || res.stdout).trim() ||
        `revert of ${fromSha}..${toSha} failed`,
    };
  }
  const tip = await run([git, "-C", dir, "rev-parse", "HEAD"]);
  return {
    ok: true,
    conflict: false,
    message: res.stdout.trim(),
    revertedSha: tip.ok ? tip.stdout.trim() : undefined,
  };
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
