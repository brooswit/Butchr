// DISK-USAGE accounting for butchr's two unbounded-growth footprints: the per-task
// git WORKTREES under each registered repo (one checkout per live task) and the DB
// BACKUP directory (a snapshot every interval). Both can quietly accumulate gigabytes
// on a long-running install, so /health surfaces their sizes plus an advisory warning
// when the total crosses a configurable threshold (see config.diskWarnBytes).
//
// Everything here is BEST-EFFORT and BOUNDED: the walk skips symlinks (no cycles,
// no double counting), swallows per-entry stat errors, and caps how many entries it
// will visit so a pathological tree can never make /health hang. A path that doesn't
// exist (e.g. the backup dir before the first snapshot) sizes to 0, never an error.
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { listWorktrees } from "./git.ts";
import { listDirectories } from "./directories.ts";

/** Default ceiling on entries a single dirSizeBytes walk will visit before it stops. */
export const DEFAULT_MAX_ENTRIES = 100_000;

export type DirSize = {
  /** Total bytes of regular files in the tree (symlinks/dirs themselves not counted). */
  bytes: number;
  /** How many filesystem entries the walk visited (files + dirs). */
  entries: number;
  /** True if the walk hit the entry cap and stopped early — `bytes` is then a floor. */
  truncated: boolean;
};

/**
 * Best-effort recursive byte size of the file tree at `path`. Iterative (an explicit
 * stack, so deep trees can't blow the call stack) and BOUNDED by `maxEntries`. Uses
 * `lstat` so symlinks are counted as the link itself (never followed) — this avoids
 * both cycles and counting a linked target twice. Missing path → all zeros. Per-entry
 * errors (races, permissions, broken links) are skipped silently.
 */
export function dirSizeBytes(
  path: string,
  maxEntries: number = DEFAULT_MAX_ENTRIES,
): DirSize {
  if (!existsSync(path)) return { bytes: 0, entries: 0, truncated: false };
  let bytes = 0;
  let entries = 0;
  const stack: string[] = [path];
  while (stack.length > 0) {
    if (entries >= maxEntries) return { bytes, entries, truncated: true };
    const cur = stack.pop()!;
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      continue; // vanished / unreadable between enqueue and visit
    }
    entries++;
    if (st.isSymbolicLink()) {
      // Count the link entry itself; never traverse it (cycle / double-count guard).
      bytes += st.size;
      continue;
    }
    if (st.isDirectory()) {
      let names: string[];
      try {
        names = readdirSync(cur);
      } catch {
        continue; // unreadable dir — skip its contents
      }
      for (const name of names) stack.push(join(cur, name));
      continue;
    }
    if (st.isFile()) bytes += st.size;
  }
  return { bytes, entries, truncated: false };
}

export type DiskUsage = {
  /** Total bytes across every task worktree under every registered repo. */
  worktreesBytes: number;
  /** Number of task worktrees counted. */
  worktreeCount: number;
  /** Total bytes of the DB backup directory (0 if it doesn't exist yet). */
  backupsBytes: number;
  /** worktreesBytes + backupsBytes — what the advisory threshold is checked against. */
  totalBytes: number;
  /** The configured advisory threshold (bytes); 0 means the warning is disabled. */
  warnBytes: number;
  /** True when warnBytes > 0 and totalBytes exceeds it — purely advisory. */
  warn: boolean;
  /** True if any walk hit its entry cap, so the byte totals are a floor, not exact. */
  truncated: boolean;
};

// /health is polled often (the webapp re-checks it on every SSE event, plus the
// health watchdog every ~30s), so the worktree walk is memoized for a short TTL —
// rapid polls reuse a recent result instead of re-walking every checkout each time.
const CACHE_TTL_MS = 30_000;
let cache: { at: number; usage: DiskUsage } | null = null;

/**
 * Compute butchr's disk footprint: the task worktrees under each registered repo and
 * the DB backup directory. Best-effort throughout — a failure sizing any one repo's
 * worktrees contributes 0 rather than throwing, so /health can always include this.
 * Result is cached for `CACHE_TTL_MS` so frequent /health polls stay cheap.
 */
export async function computeDiskUsage(): Promise<DiskUsage> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.usage;
  const usage = await computeDiskUsageUncached();
  cache = { at: Date.now(), usage };
  return usage;
}

async function computeDiskUsageUncached(): Promise<DiskUsage> {
  let worktreesBytes = 0;
  let worktreeCount = 0;
  let truncated = false;

  for (const dir of listDirectories()) {
    let worktrees: string[];
    try {
      worktrees = await listWorktrees(dir.path);
    } catch {
      continue; // not a repo anymore / git error — skip this directory
    }
    for (const wt of worktrees) {
      const size = dirSizeBytes(wt);
      worktreesBytes += size.bytes;
      worktreeCount++;
      if (size.truncated) truncated = true;
    }
  }

  const backups = dirSizeBytes(config.backupDir);
  if (backups.truncated) truncated = true;
  const backupsBytes = backups.bytes;

  const totalBytes = worktreesBytes + backupsBytes;
  const warnBytes = config.diskWarnBytes;
  return {
    worktreesBytes,
    worktreeCount,
    backupsBytes,
    totalBytes,
    warnBytes,
    warn: warnBytes > 0 && totalBytes > warnBytes,
    truncated,
  };
}
