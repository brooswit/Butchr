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
  if (existsSync(path)) return path; // already created (idempotent dispatch)
  await runOrThrow([git, "-C", dir, "worktree", "add", "-b", taskId, path]);
  return path;
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

export type MergeResult = { ok: boolean; conflict: boolean; message: string };

/**
 * Commit any uncommitted worktree changes, then fast-forward-merge the task
 * branch into the default branch. On conflict, returns conflict=true so the
 * caller can hold the task in review.
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
  if (m.ok) return { ok: true, conflict: false, message: m.stdout.trim() };

  const conflict = /conflict/i.test(m.stdout + m.stderr);
  if (conflict) {
    // Abort the half-applied merge so the repo is left clean; human resolves.
    await run([git, "-C", dir, "merge", "--abort"]);
  }
  return {
    ok: false,
    conflict,
    message: (m.stderr || m.stdout).trim() || `merge into ${base} failed`,
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
