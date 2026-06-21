// Tests for the DB SNAPSHOT + RESTORE resilience layer (see src/backup.ts).
//
// Pure / in-process: no real claude or herdr is spawned (BUTCHR_HERDR_BIN points
// at `true`). These exercise the real snapshot (VACUUM INTO), retention pruning,
// and restore against a real on-disk SQLite db.
//
// The config/db singletons are SHARED across test files in one `bun test` run, so
// we don't rely on env-driven paths being ours: we OVERRIDE config.backupDir /
// backupKeep / dbPath at runtime (saving + restoring them) the same way
// test/ci-gate.test.ts mutates config.ciRetries.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let BACKUP_DIR: string;
// Distinct workspace id so this file's rows don't collide with another file's in
// the shared db.
const DIR_ID = "backup-test-dir";

let backupMod: typeof import("../src/backup.ts");
let dbMod: typeof import("../src/db.ts");
let configMod: typeof import("../src/config.ts");

let savedBackupDir: string;
let savedBackupKeep: number;
let savedDbPath: string;

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-backup-data-"));
  BACKUP_DIR = join(DATA_DIR, "backups");

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  dbMod = await import("../src/db.ts");
  configMod = await import("../src/config.ts");
  backupMod = await import("../src/backup.ts");

  // Point backups at our own dir regardless of which file won the singleton race.
  savedBackupDir = configMod.config.backupDir;
  savedBackupKeep = configMod.config.backupKeep;
  savedDbPath = configMod.config.dbPath;
  configMod.config.backupDir = BACKUP_DIR;

  // Seed a workspace + a couple of tasks so a snapshot has real content to verify.
  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(DIR_ID, DATA_DIR, "test", dbMod.nowIso());
  for (const id of ["bk-a", "bk-b", "bk-c"]) {
    dbMod.db
      .query(`INSERT INTO tasks (id, workspace_id, status, created_at) VALUES (?, ?, ?, ?)`)
      .run(id, DIR_ID, "queued", dbMod.nowIso());
  }
});

afterEach(() => {
  // Reset retention + clear out any snapshots between tests for isolation.
  configMod.config.backupKeep = savedBackupKeep;
  configMod.config.dbPath = savedDbPath;
  if (existsSync(BACKUP_DIR)) rmSync(BACKUP_DIR, { recursive: true, force: true });
});

afterAll(() => {
  configMod.config.backupDir = savedBackupDir;
  configMod.config.backupKeep = savedBackupKeep;
  configMod.config.dbPath = savedDbPath;
  rmSync(DATA_DIR, { recursive: true, force: true });
});

/** How many snapshot files (butchr-*.db) currently exist in the backup dir. */
function snapshotCount(): number {
  if (!existsSync(BACKUP_DIR)) return 0;
  return readdirSync(BACKUP_DIR).filter((n) => n.startsWith("butchr-") && n.endsWith(".db")).length;
}

describe("snapshotDb", () => {
  test("creates a consistent, queryable SQLite copy of the live db", async () => {
    const path = await backupMod.snapshotDb();

    expect(existsSync(path)).toBe(true);
    expect(path.startsWith(BACKUP_DIR)).toBe(true);

    // The snapshot is a standalone SQLite db whose content matches the live db.
    const snap = new Database(path, { readonly: true });
    try {
      const n = snap
        .query<{ c: number }, [string]>(`SELECT COUNT(*) AS c FROM tasks WHERE workspace_id=?`)
        .get(DIR_ID)!.c;
      expect(n).toBe(3);
    } finally {
      snap.close();
    }

    // It is a clean VACUUM INTO copy — no WAL sidecars left next to it.
    expect(existsSync(path + "-wal")).toBe(false);
    expect(existsSync(path + "-shm")).toBe(false);
  });

  test("records lastSnapshotAt for /health", async () => {
    expect(backupMod.getLastSnapshotAt()).not.toBeNull();
  });

  test("two snapshots in quick succession get distinct filenames (no overwrite)", async () => {
    const a = await backupMod.snapshotDb();
    const b = await backupMod.snapshotDb();
    expect(a).not.toBe(b);
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);
    expect(snapshotCount()).toBe(2);
  });
});

describe("listBackups", () => {
  test("returns snapshots newest-first", async () => {
    const first = await backupMod.snapshotDb();
    await new Promise((r) => setTimeout(r, 5));
    const second = await backupMod.snapshotDb();
    const list = backupMod.listBackups();
    expect(list.length).toBe(2);
    expect(list[0]!.path).toBe(second); // newest first
    expect(list[1]!.path).toBe(first);
  });

  test("ignores unrelated files in the backup dir", async () => {
    await backupMod.snapshotDb();
    // A stray file that isn't a butchr-*.db snapshot must not be listed.
    await Bun.write(join(BACKUP_DIR, "notes.txt"), "hi");
    expect(backupMod.listBackups().length).toBe(1);
  });
});

describe("pruneBackups (retention)", () => {
  test("keeps the N newest and deletes the rest", async () => {
    // Create 5 snapshots, spacing them so mtime ordering is deterministic.
    const paths: string[] = [];
    for (let i = 0; i < 5; i++) {
      paths.push(await backupMod.snapshotDb());
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(snapshotCount()).toBe(5);

    const { pruned } = backupMod.pruneBackups(2);
    expect(pruned.length).toBe(3);
    expect(snapshotCount()).toBe(2);

    // The two newest survive; the three oldest are gone.
    const surviving = backupMod.listBackups().map((b) => b.path).sort();
    expect(surviving).toEqual(paths.slice(3).sort());
    for (const old of paths.slice(0, 3)) expect(existsSync(old)).toBe(false);
  });

  test("keep<=0 is treated as 'keep all' (never deletes everything)", async () => {
    await backupMod.snapshotDb();
    await backupMod.snapshotDb();
    expect(backupMod.pruneBackups(0).pruned).toEqual([]);
    expect(snapshotCount()).toBe(2);
  });

  test("pruning is a no-op when nothing exceeds the limit", async () => {
    await backupMod.snapshotDb();
    expect(backupMod.pruneBackups(5).pruned).toEqual([]);
    expect(snapshotCount()).toBe(1);
  });
});

describe("resolveBackup", () => {
  test("'latest' resolves to the newest snapshot", async () => {
    await backupMod.snapshotDb();
    await new Promise((r) => setTimeout(r, 5));
    const newest = await backupMod.snapshotDb();
    expect(backupMod.resolveBackup("latest")).toBe(newest);
  });

  test("a bare filename resolves within the backup dir", async () => {
    const path = await backupMod.snapshotDb();
    const name = path.slice(BACKUP_DIR.length + 1);
    expect(backupMod.resolveBackup(name)).toBe(path);
  });

  test("'latest' with no snapshots throws", () => {
    expect(() => backupMod.resolveBackup("latest")).toThrow(/no snapshots/);
  });

  test("a missing file throws", () => {
    expect(() => backupMod.resolveBackup("/nope/does-not-exist.db")).toThrow(/not found/);
  });
});

describe("restoreFromBackup", () => {
  test("restores a snapshot to dbPath and saves the previous db aside", async () => {
    // Snapshot the current 3-task db, then restore it into a SEPARATE target path
    // (so we don't clobber the shared live test db).
    const snap = await backupMod.snapshotDb();
    const target = join(DATA_DIR, "restore-target.db");
    configMod.config.dbPath = target;

    // Seed a pre-existing db at the target so we can confirm it's backed up.
    const pre = new Database(target, { create: true });
    pre.exec("CREATE TABLE marker (x)");
    pre.exec("INSERT INTO marker VALUES (42)");
    pre.close();

    const result = backupMod.restoreFromBackup("latest");
    expect(result.restored).toBe(target);
    expect(result.from).toBe(snap);
    expect(result.backedUp).not.toBeNull();
    expect(existsSync(result.backedUp!)).toBe(true);

    // The target now holds the snapshot's content (3 tasks), not the old marker.
    const restored = new Database(target, { readonly: true });
    try {
      const n = restored
        .query<{ c: number }, [string]>(`SELECT COUNT(*) AS c FROM tasks WHERE workspace_id=?`)
        .get(DIR_ID)!.c;
      expect(n).toBe(3);
    } finally {
      restored.close();
    }
  });

  test("restoring with no prior db at the target leaves backedUp null", async () => {
    await backupMod.snapshotDb();
    const target = join(DATA_DIR, "fresh-target.db");
    rmSync(target, { force: true });
    configMod.config.dbPath = target;

    const result = backupMod.restoreFromBackup("latest");
    expect(result.backedUp).toBeNull();
    expect(existsSync(target)).toBe(true);
  });
});

describe("restoreFromBackup — source validation (F1)", () => {
  // Seed a real live db at the target, capture its bytes, then attempt a restore
  // from an INVALID source — the restore must throw and leave the live db
  // byte-for-byte untouched (validation runs before any pre-restore copy/clobber).
  function seedLiveDb(): { target: string; before: Buffer } {
    const target = join(DATA_DIR, "validate-target.db");
    rmSync(target, { force: true });
    rmSync(target + "-wal", { force: true });
    rmSync(target + "-shm", { force: true });
    const live = new Database(target, { create: true });
    live.exec("PRAGMA journal_mode=DELETE"); // standalone file, no sidecars
    live.exec("CREATE TABLE marker (x)");
    live.exec("INSERT INTO marker VALUES (7)");
    live.close();
    configMod.config.dbPath = target;
    return { target, before: readFileSync(target) };
  }

  test("F1a: a zero-byte source aborts and leaves the live db untouched", () => {
    const { target, before } = seedLiveDb();
    const bad = join(DATA_DIR, "zero-source.db");
    writeFileSync(bad, "");

    expect(() => backupMod.restoreFromBackup(bad)).toThrow(/restore ABORTED/);
    // Live db is byte-for-byte identical to before.
    expect(readFileSync(target).equals(before)).toBe(true);
    // No pre-restore copy was made for THIS target (validation aborted first).
    expect(readdirSync(DATA_DIR).some((n) => n.startsWith("validate-target.db.pre-restore-"))).toBe(
      false,
    );
  });

  test("F1b: a non-zero non-SQLite (garbage) source aborts, live db untouched", () => {
    const { target, before } = seedLiveDb();
    const bad = join(DATA_DIR, "garbage-source.db");
    writeFileSync(bad, Buffer.from("this is definitely not a sqlite database header"));

    expect(() => backupMod.restoreFromBackup(bad)).toThrow(/restore ABORTED/);
    expect(readFileSync(target).equals(before)).toBe(true);
    expect(readdirSync(DATA_DIR).some((n) => n.startsWith("validate-target.db.pre-restore-"))).toBe(
      false,
    );
  });

  test("F1c: a valid snapshot restores successfully and returns a RestoreResult", async () => {
    const snap = await backupMod.snapshotDb();
    const target = join(DATA_DIR, "valid-restore-target.db");
    rmSync(target, { force: true });
    configMod.config.dbPath = target;

    const result = backupMod.restoreFromBackup(snap);
    expect(result.restored).toBe(target);
    expect(result.from).toBe(snap);

    const restored = new Database(target, { readonly: true });
    try {
      const n = restored
        .query<{ c: number }, [string]>(`SELECT COUNT(*) AS c FROM tasks WHERE workspace_id=?`)
        .get(DIR_ID)!.c;
      expect(n).toBe(3);
    } finally {
      restored.close();
    }
  });
});

describe("resolveBackup('latest') — skips zero-byte partials (F2)", () => {
  test("returns the newest POSITIVE-SIZE snapshot, not a newer zero-byte file", async () => {
    const valid = await backupMod.snapshotDb();
    await new Promise((r) => setTimeout(r, 5));
    // A NEWER (later-sorting name + later mtime) zero-byte butchr-*.db partial.
    const partial = join(BACKUP_DIR, "butchr-9999-zero.db");
    writeFileSync(partial, "");

    // Sanity: the partial IS the newest entry listBackups() reports (so pruning can
    // still reap it), but 'latest' must skip it.
    expect(backupMod.listBackups()[0]!.path).toBe(partial);
    expect(backupMod.resolveBackup("latest")).toBe(valid);
  });

  test("'latest' with only a zero-byte file throws", () => {
    mkdirSync(BACKUP_DIR, { recursive: true });
    writeFileSync(join(BACKUP_DIR, "butchr-only-zero.db"), "");
    expect(() => backupMod.resolveBackup("latest")).toThrow(/no snapshots/);
  });
});

describe("snapshotDb — failed VACUUM leaves no partial target (F3)", () => {
  test("a throwing VACUUM INTO removes the partial target and re-throws", async () => {
    const origExec = dbMod.db.exec.bind(dbMod.db);
    let partialPath: string | null = null;
    // Stub exec so a VACUUM INTO writes a partial file (as SQLite might on disk-full)
    // then throws — exactly the failure snapshotDb must clean up after.
    (dbMod.db as { exec: (sql: string) => unknown }).exec = (sql: string) => {
      const m = /VACUUM INTO '(.+)'/.exec(sql);
      if (m) {
        partialPath = m[1]!.replace(/''/g, "'");
        writeFileSync(partialPath, "");
        throw new Error("simulated disk full");
      }
      return origExec(sql);
    };

    try {
      await expect(backupMod.snapshotDb()).rejects.toThrow(/disk full/);
      expect(partialPath).not.toBeNull();
      expect(existsSync(partialPath!)).toBe(false);
    } finally {
      (dbMod.db as { exec: (sql: string) => unknown }).exec = origExec;
    }
  });
});
