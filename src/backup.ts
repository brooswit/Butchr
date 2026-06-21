// SQLite SNAPSHOT + RESTORE — resilience for the source-of-truth DB.
//
// The SQLite database (src/db.ts) is the source of truth for all task state and
// history. A crash mid-write (e.g. a power loss) can leave it inconsistent or
// lose recent work. This module takes periodic, SQLITE-SAFE snapshots and offers
// a restore path so a damaged db can be rolled back to the last good copy.
//
// Why VACUUM INTO (not a file copy): a butchr db runs in WAL mode, so a raw
// `cp butchr.db backup.db` mid-write captures a torn page set — the committed
// state lives partly in `butchr.db` and partly in the `-wal` sidecar. `VACUUM
// INTO` is SQLite's blessed online-backup primitive: it writes a clean, fully
// consistent, defragmented copy of the LIVE committed state to a new file, safe
// to run while the db is open and being written. The output is a standalone
// (non-WAL) db file with no sidecars, which is exactly what a restore wants.
//
// db.ts is imported DYNAMICALLY inside snapshotDb() rather than at the top of the
// module. That keeps importing this module side-effect-free w.r.t. opening the
// live database — so the restore CLI path (bin/butchr restore) can reuse these
// helpers WITHOUT db.ts's top-level `new Database(...)` opening (and leaving WAL
// sidecars on) the very db file it is about to overwrite.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { config } from "./config.ts";

// Snapshot files are named `butchr-<fs-safe-iso>.db` so they sort chronologically
// by name and are trivially recognizable. The prefix/suffix double as the filter
// for listing + pruning so unrelated files in the backup dir are never touched.
const PREFIX = "butchr-";
const SUFFIX = ".db";

// Wall-clock of the most recent successful snapshot (ISO), surfaced on /health.
// null until the first snapshot of this process run.
let lastSnapshotAt: string | null = null;

/** ISO timestamp of the last successful snapshot this run, or null. For /health. */
export function getLastSnapshotAt(): string | null {
  return lastSnapshotAt;
}

// A filesystem-safe timestamp for a snapshot filename: ISO with ':' and '.'
// (illegal/awkward on some filesystems) swapped for '-'. Still lexically sortable.
function fsStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// SQLite has no bind-parameter form for VACUUM INTO's target — it must be a
// string literal — so quote the path the SQL way (double any single quotes).
function sqlQuote(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

// Pick a not-yet-existing target path. VACUUM INTO refuses to overwrite an
// existing file, and two snapshots can land in the same millisecond, so append a
// numeric disambiguator when the timestamped name is already taken.
function uniqueTarget(dir: string, stamp: string): string {
  let target = join(dir, `${PREFIX}${stamp}${SUFFIX}`);
  let n = 1;
  while (existsSync(target)) {
    target = join(dir, `${PREFIX}${stamp}-${n}${SUFFIX}`);
    n++;
  }
  return target;
}

/** Metadata for one snapshot file in the backup directory. */
export type BackupInfo = { name: string; path: string; mtimeMs: number; size: number };

/** All snapshots in `config.backupDir`, NEWEST FIRST (by mtime, name as tie-break). */
export function listBackups(): BackupInfo[] {
  const dir = config.backupDir;
  if (!existsSync(dir)) return [];
  const out: BackupInfo[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(PREFIX) || !name.endsWith(SUFFIX)) continue;
    const path = join(dir, name);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue; // vanished between readdir and stat
    }
    if (!st.isFile()) continue;
    out.push({ name, path, mtimeMs: st.mtimeMs, size: st.size });
  }
  // Newest first. mtime is the primary key; the embedded timestamp in the name is
  // the tie-break (and disambiguates same-mtime files deterministically).
  out.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
  return out;
}

/**
 * Write a fresh SQLITE-SAFE snapshot of the live db to `config.backupDir` and
 * return its path. Uses `VACUUM INTO` (see module header) so it is consistent even
 * while the db is being written. Creates the backup dir if needed. Throws on
 * failure (callers in the periodic loop swallow + log it).
 */
export async function snapshotDb(): Promise<string> {
  mkdirSync(config.backupDir, { recursive: true });
  const target = uniqueTarget(config.backupDir, fsStamp());
  // db.ts is loaded lazily here, not at module top — see the module header for why.
  const { db } = await import("./db.ts");
  try {
    db.exec(`VACUUM INTO ${sqlQuote(target)}`);
  } catch (e) {
    // A failed VACUUM INTO (e.g. disk full) can leave a partial target file that
    // would later masquerade as a valid backup. Best-effort remove it, then
    // re-throw so callers (snapshotAndPrune) catch+log exactly as before.
    rmSync(target, { force: true });
    throw e;
  }
  lastSnapshotAt = new Date().toISOString();
  return target;
}

/**
 * Prune old snapshots, keeping the `keep` NEWEST and deleting the rest. A `keep`
 * of 0 or negative is treated as "keep ALL" (pruning disabled) — never an
 * instruction to delete every backup. Returns the paths actually removed.
 */
export function pruneBackups(keep: number = config.backupKeep): { pruned: string[] } {
  if (!(keep > 0)) return { pruned: [] };
  const stale = listBackups().slice(keep); // listBackups is newest-first
  const pruned: string[] = [];
  for (const b of stale) {
    try {
      rmSync(b.path, { force: true });
      pruned.push(b.path);
    } catch {
      /* best-effort: a file we couldn't remove stays, harmlessly */
    }
  }
  return { pruned };
}

/** Take a snapshot, then prune to the retention limit. Logs the outcome; never throws. */
async function snapshotAndPrune(reason: string): Promise<void> {
  try {
    const path = await snapshotDb();
    const { pruned } = pruneBackups();
    const tail = pruned.length ? ` (pruned ${pruned.length} old)` : "";
    console.log(`[butchr] db snapshot (${reason}) → ${path}${tail}`);
  } catch (e) {
    console.error(`[butchr] db snapshot (${reason}) failed:`, (e as Error).message);
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the periodic snapshot loop. No-op (with a one-line log) when backups are
 * disabled or the interval is non-positive. Idempotent — a second call while
 * already running does nothing. The first snapshot fires after one interval, not
 * immediately (boot already restored/reconciled state; an instant snapshot would
 * add no resilience and just churn the boot path).
 */
export function startBackupLoop(): void {
  if (timer) return;
  if (!config.backupEnabled) {
    console.log("[butchr] periodic DB snapshots disabled (BUTCHR_BACKUP_ENABLED=0)");
    return;
  }
  if (!(config.backupIntervalMs > 0)) {
    console.log("[butchr] periodic DB snapshots disabled (BUTCHR_BACKUP_INTERVAL_MS<=0)");
    return;
  }
  timer = setInterval(() => {
    void snapshotAndPrune("scheduled");
  }, config.backupIntervalMs);
  console.log(
    `[butchr] periodic DB snapshots every ${Math.round(config.backupIntervalMs / 1000)}s ` +
      `→ ${config.backupDir} (keep ${config.backupKeep})`,
  );
}

/** Stop the periodic snapshot loop. Idempotent. */
export function stopBackupLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/**
 * Take one final snapshot on clean shutdown so the very latest state is captured
 * before exit. Best-effort and awaited by the shutdown handler; never throws.
 * Skipped when backups are disabled.
 */
export async function snapshotOnShutdown(): Promise<void> {
  if (!config.backupEnabled) return;
  await snapshotAndPrune("shutdown");
}

// ---- RESTORE ---------------------------------------------------------------
// Restore is an OFFLINE operation: butchr must be stopped first (a running server
// holds the db open). These helpers only touch the filesystem — they never open
// the live db (see the module header) — so the restoring process leaves no stale
// WAL sidecar on the file it is replacing.

/**
 * Resolve a restore target to an absolute snapshot path. Accepts:
 *  - `"latest"` → the newest snapshot in `config.backupDir`.
 *  - an absolute path to a snapshot file.
 *  - a bare filename, resolved within `config.backupDir`.
 * Throws if nothing matches / the file is missing.
 */
export function resolveBackup(target: string): string {
  if (target === "latest") {
    // listBackups() honestly returns EVERY prefix/suffix-matching file (so pruning
    // can still reap zero-byte leftovers). For auto-selection, skip an obvious
    // partial: pick the newest snapshot with positive size. (F1's validator is the
    // real safety net for explicit path/filename restores.)
    const newest = listBackups().find((b) => b.size > 0);
    if (!newest) throw new Error(`no snapshots found in ${config.backupDir}`);
    return newest.path;
  }
  const path = isAbsolute(target) ? target : join(config.backupDir, basename(target));
  if (!existsSync(path)) throw new Error(`snapshot file not found: ${path}`);
  return path;
}

// The 16-byte SQLite file header: the 15-char ASCII string plus a trailing NUL.
// Compared as BYTES (not a JS string) so the NUL terminator is significant.
const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "latin1");

/**
 * Validate that `from` is a non-empty, well-formed, integrity-clean SQLite file
 * BEFORE it is allowed to overwrite the live db. Throws (restore ABORTED, live db
 * left untouched) on any failure. Checks run cheapest→strongest, and size+magic
 * run BEFORE any db open so a zero-byte/garbage file never reaches SQLite:
 *   1. non-zero size,
 *   2. 16-byte SQLite header magic (byte-compared),
 *   3. a throwaway READ-ONLY open + `PRAGMA quick_check` returning a single 'ok' row.
 * Database is imported HERE (not from ./db.ts) to keep this module's "never open the
 * live db at import" property; the readonly open of a VACUUM-INTO file leaves no
 * -wal/-shm sidecars and is closed in a `finally` regardless.
 */
function validateBackupSource(from: string): void {
  const fail = (reason: string): never => {
    throw new Error(
      `invalid/corrupt backup, restore ABORTED (live DB untouched): ${from} — ${reason}`,
    );
  };

  // 1. Non-zero size.
  let size: number;
  try {
    size = statSync(from).size;
  } catch (e) {
    return fail(`cannot stat source: ${(e as Error).message}`);
  }
  if (!(size > 0)) return fail("zero-byte file");

  // 2. SQLite header magic (byte-compare; the trailing NUL matters).
  let head: Buffer;
  try {
    head = readFileSync(from).subarray(0, 16);
  } catch (e) {
    return fail(`cannot read source header: ${(e as Error).message}`);
  }
  if (!head.equals(SQLITE_MAGIC)) return fail("not a SQLite database (bad header magic)");

  // 3. Throwaway read-only integrity check. quick_check is cheaper than
  // integrity_check and returns a single row keyed `quick_check` whose value is
  // 'ok' on a clean db. Any non-'ok' row (or a throw on open) means corrupt.
  const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
  let probe: import("bun:sqlite").Database | null = null;
  try {
    probe = new Database(from, { readonly: true });
    const row = probe.query<{ quick_check: string }, []>(`PRAGMA quick_check`).get();
    if (!row || row.quick_check !== "ok") {
      return fail(`integrity check failed: ${row?.quick_check ?? "no result"}`);
    }
  } catch (e) {
    return fail(`cannot open/verify as SQLite: ${(e as Error).message}`);
  } finally {
    probe?.close();
  }
}

export type RestoreResult = { restored: string; from: string; backedUp: string | null };

/**
 * Restore the db at `config.dbPath` from a snapshot (`"latest"`, a path, or a bare
 * filename). The CURRENT db, if any, is first copied aside to
 * `<dbPath>.pre-restore-<ts>` so a mistaken restore is itself recoverable. Stale
 * `-wal`/`-shm` sidecars are removed so SQLite reads the restored file as-is
 * instead of replaying an old write-ahead log over it.
 *
 * Caller MUST ensure butchr is stopped — overwriting the db under a live process
 * corrupts it. This never opens the db, so it adds no sidecars of its own.
 */
export function restoreFromBackup(target: string): RestoreResult {
  const from = resolveBackup(target);
  // Validate the SOURCE before touching anything: this runs before the pre-restore
  // copy and before the clobbering copyFileSync, so on any failure the live db is
  // left BYTE-FOR-BYTE untouched and no success is reported.
  validateBackupSource(from);
  const dbPath = config.dbPath;
  mkdirSync(dirname(dbPath), { recursive: true });

  let backedUp: string | null = null;
  if (existsSync(dbPath)) {
    backedUp = `${dbPath}.pre-restore-${fsStamp()}`;
    copyFileSync(dbPath, backedUp);
  }

  copyFileSync(from, dbPath);
  // Drop any sidecars left by a prior process so the restored file is authoritative.
  for (const sfx of ["-wal", "-shm"]) rmSync(dbPath + sfx, { force: true });

  return { restored: dbPath, from, backedUp };
}
