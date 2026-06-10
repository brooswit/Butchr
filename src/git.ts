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

  // Clean rebase — the task branch is now linear atop base. Fast-forward base to
  // it (no merge commit). This cannot conflict; it can only fail if base moved
  // between the rebase and here (callers serialize merges to prevent that).
  const ff = await run([git, "-C", dir, "merge", "--ff-only", taskId]);
  if (ff.ok) {
    return { ok: true, conflict: false, message: ff.stdout.trim(), conflictFiles: [] };
  }
  return {
    ok: false,
    conflict: false,
    message: (ff.stderr || ff.stdout).trim() || `fast-forward into ${base} failed`,
    conflictFiles: [],
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
