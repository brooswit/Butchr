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

/** Create a worktree on a new branch <taskId> at <dir>/<taskId>. */
export async function createWorktree(
  dir: string,
  taskId: string,
): Promise<string> {
  const path = join(dir, taskId);
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
  const wt = join(dir, taskId);
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
  const wt = join(dir, taskId);
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
 * Commit any uncommitted worktree changes, then fast-forward-merge the task
 * branch into the default branch. On conflict, returns conflict=true (and the
 * conflicting file paths) so the caller can kick the task back to the agent.
 * The half-applied merge is always aborted so the working tree is left CLEAN.
 */
export async function merge(dir: string, taskId: string): Promise<MergeResult> {
  const base = await defaultBranch(dir);
  const wt = join(dir, taskId);

  // Auto-commit any dangling worktree changes so they're part of the merge.
  if (existsSync(wt)) {
    const st = await run([git, "-C", wt, "status", "--porcelain"]);
    if (st.ok && st.stdout.trim().length > 0) {
      await run([git, "-C", wt, "add", "-A"]);
      await run([
        git, "-C", wt, "commit", "-m", `butchr: finalize task ${taskId}`,
      ]);
    }
  }

  // Try fast-forward first, then a regular merge as fallback.
  let m = await run([git, "-C", dir, "merge", "--ff-only", taskId]);
  if (!m.ok) {
    m = await run([
      git, "-C", dir, "merge", "--no-edit", taskId,
    ]);
  }
  if (m.ok) {
    return { ok: true, conflict: false, message: m.stdout.trim(), conflictFiles: [] };
  }

  const combined = m.stdout + "\n" + m.stderr;
  const conflict = /conflict/i.test(combined);
  const conflictFiles = conflict ? parseConflictFiles(combined) : [];
  if (conflict) {
    // Abort the half-applied merge so the working tree + index are left CLEAN.
    // The agent (or a fresh one) resolves in its worktree and re-submits.
    await run([git, "-C", dir, "merge", "--abort"]);
  }
  return {
    ok: false,
    conflict,
    message: (m.stderr || m.stdout).trim() || `merge into ${base} failed`,
    conflictFiles,
  };
}

/** Remove the worktree and delete the task branch (post-merge cleanup). */
export async function cleanup(dir: string, taskId: string): Promise<void> {
  const path = join(dir, taskId);
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
