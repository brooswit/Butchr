// SQLite state. Per the spec, SQLite tracks only runtime state — task.md on
// disk is the source of truth for prompt/metadata. Everything here is derivable
// or re-syncable from the filesystem.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.ts";
import { median, spanMs } from "./duration.ts";
import type { EstimateRow } from "./estimate.ts";

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath, { create: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

// ---------------------------------------------------------------------------
// IN-PLACE RENAME: directories -> workspaces (pre-1.0 conceptual rename).
// MUST run BEFORE the baseline CREATE TABLEs *and* before migrateCtoAgentPerWorkspace
// so an existing DB is renamed IN PLACE — every row and its opaque `dir-…` id VALUE
// preserved (we never rewrite id values) — and the later `CREATE TABLE IF NOT EXISTS`
// / cto-agent migration become no-ops. On a fresh DB every guard is false, so this is
// a clean no-op and the baseline creates the new shape directly.
//
// IDEMPOTENT: each ALTER is guarded by a presence check, so re-running on an
// already-migrated DB (workspaces exists, directories doesn't) skips every statement
// and never throws. SQLite with legacy_alter_table OFF (bun's default) auto-rewrites
// the child FK references `REFERENCES directories(id)` -> `workspaces(id)` in
// tasks/cto_agent on the table rename, and updates the renamed column inside indexes.
function tableExists(database: Database, name: string): boolean {
  return !!database
    .query<{ name: string }, [string]>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
    )
    .get(name);
}
function columnExists(database: Database, table: string, column: string): boolean {
  return database
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .some((c) => c.name === column);
}
// True iff a VIEW (type='view', distinct from a table) of this name exists. The
// workspaces→directory cutover (migrateRenameWorkspacesToDirectory) uses this to tell the
// step-1 `directory` VIEW apart from the real `directory` TABLE this step creates, so we
// only ever `DROP VIEW` an actual view (a `DROP VIEW` on a table name throws even with
// IF EXISTS), keeping the guarded rename a clean idempotent no-op once converged.
function viewExists(database: Database, name: string): boolean {
  return !!database
    .query<{ name: string }, [string]>(
      `SELECT name FROM sqlite_master WHERE type='view' AND name=?`,
    )
    .get(name);
}
// Pure (takes the connection) so it is unit-testable on a hand-built legacy DB
// independent of the module-level singleton (see test/workspace-migration.test.ts).
export function migrateDirectoriesToWorkspaces(database: Database): void {
  if (tableExists(database, "directories") && !tableExists(database, "workspaces")) {
    database.exec(`ALTER TABLE directories RENAME TO workspaces`);
  }
  if (
    tableExists(database, "tasks") &&
    columnExists(database, "tasks", "directory_id") &&
    !columnExists(database, "tasks", "workspace_id")
  ) {
    database.exec(`ALTER TABLE tasks RENAME COLUMN directory_id TO workspace_id`);
  }
  if (
    tableExists(database, "cto_agent") &&
    columnExists(database, "cto_agent", "directory_id") &&
    !columnExists(database, "cto_agent", "workspace_id")
  ) {
    database.exec(`ALTER TABLE cto_agent RENAME COLUMN directory_id TO workspace_id`);
  }
  // The old index carried the renamed column under a stale name; drop it so the
  // baseline below can (re)create idx_tasks_ws. IF EXISTS keeps this idempotent.
  database.exec(`DROP INDEX IF EXISTS idx_tasks_dir`);
}
// Baseline schema. Idempotent — every statement is CREATE TABLE/INDEX IF NOT
// EXISTS — so it is a clean no-op on an already-created DB. Run (in MIGRATIONS
// order) AFTER the directories→workspaces rename so an existing DB is renamed in
// place rather than getting a fresh empty `workspaces` table here.
function createBaselineSchema(): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS workspaces (
  id              TEXT PRIMARY KEY,
  path            TEXT UNIQUE NOT NULL,
  label           TEXT,
  herdr_workspace TEXT,
  herdr_pane      TEXT,
  created_at      TEXT NOT NULL
);

-- STORIES (Phase 1: DATA MODEL ONLY — fully inert). A story is a CONTAINER that
-- GROUPS subtasks (tasks carry a nullable story_id FK — see the tasks.story_id column
-- migration below). Later phases add a story-leader agent + a responder-escalation
-- chain; NOTHING reads this table to drive behavior yet. Cascade-deletes with its
-- workspace exactly like tasks do (unregistering a workspace removes its stories);
-- deleting a STORY does NOT delete its member tasks — the service NULLs out their
-- story_id (tasks are real work; only the grouping goes away — see stories.deleteStory).
--   - brief   the story's goal/description.
--   - status  one of 'open' | 'done' | 'aborted' (default 'open'; see StoryStatus).
-- Created in the baseline (before the tasks.story_id ALTER below) so the referenced
-- table always exists by the time that column is added.
CREATE TABLE IF NOT EXISTS stories (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brief           TEXT,
  status          TEXT NOT NULL DEFAULT 'open',   -- open | done | aborted (see StoryStatus)
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stories_ws ON stories(workspace_id);

CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status          TEXT NOT NULL,            -- CANONICAL 12-state model: idea | spec_review | blocked | needs_info | inactive | in_progress | in_review | merged | rolling_back | rolled_back | failed | aborted (see TaskStatus / STATE_META)
  output_snapshot TEXT,
  conflict        INTEGER NOT NULL DEFAULT 0,
  review_note     TEXT,
  created_at      TEXT NOT NULL,
  started_at      TEXT,
  completed_at    TEXT,
  merged_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_ws    ON tasks(workspace_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

-- PER-TASK AUDIT TIMELINE: an append-only log of a task's status transitions. One
-- row per change (from_status -> to_status) with the wall-clock time and a short
-- human note explaining WHY it moved. Purely additive — nothing reads it to drive
-- behavior; it powers the task-detail timeline (see recordTaskEvent /
-- listTaskEvents below + server GET /api/tasks/:id/events). from_status is NULL for
-- the creation event. Cascade-deletes with its task (which only happens when a
-- workspace is unregistered — merged tasks keep their rows + history).
CREATE TABLE IF NOT EXISTS task_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  at          TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  note        TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, at);

-- GLOBAL SETTINGS: a tiny key/value store for server-wide runtime state that must
-- survive a restart but isn't per-task and isn't a static env knob (which lives in
-- config.ts). Currently holds the DISPATCHER PAUSE flag ('dispatch_paused' =
-- '1'/'0') — see dispatcher.{isPaused,setPaused}. Read/written through
-- getSetting/setSetting below; persistence here is what keeps a pause in effect
-- across a butchr restart (it stays paused until explicitly resumed).
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);
}

// MANAGED CTO AGENT (PER-WORKSPACE). butchr runs ONE CTO agent per registered
// workspace (repo), in that repo's ROOT — a FIRST-CLASS, butchr-launched,
// channel-connected Claude session, like a workspace agent but with NO worktree/
// branch/review/merge. Each workspace's runtime handles live in their OWN row, keyed
// by workspace_id with a FK cascade so a workspace's CTO state dies with the
// workspace. (This SUPERSEDES the old GLOBAL SINGLETON table keyed by the literal id
// 'singleton'; the migration below drops that shape — pre-1.0, destroying the old
// singleton row is fine.)
//   - session_id: the Claude Code session UUID, RESUMED (--resume) on every
//     supervised relaunch + boot-adopt so the CTO never cold-starts (see src/workspace-agent.ts).
//   - herdr_workspace: its live herdr workspace grouping handle (per-butchr-workspace,
//     stable). The CTO is addressed/torn-down BY NAME — no per-agent pane/tab is stored.
//   - desired: 1 when the operator/boot wants it UP (supervisor relaunches on death),
//     0 when explicitly stopped (supervisor leaves it down -- survives a restart).
//   - restarts: count of supervised relaunches since the last fresh start.
//   - last_error: most recent launch/supervision failure, surfaced to the operator.
// The per-workspace ENABLE flag is the `workspaces.cto_enabled` column (NULL =
// inherit the global default config.ctoAgentEnabled, 1 = on, 0 = off — see below),
// not a column here, so a workspace can be enabled before its first launch.
function migrateCtoAgentPerWorkspace(): void {
  // An existing table with no `workspace_id` column is the OLD singleton shape — drop
  // it (pre-1.0: the priority is "works forward"; the old singleton row is discarded).
  // (tableExists ≡ the old `cols.length > 0`: PRAGMA on a missing table returns [].)
  if (tableExists(db, "cto_agent") && !columnExists(db, "cto_agent", "workspace_id")) {
    db.exec(`DROP TABLE cto_agent`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS cto_agent (
      workspace_id    TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
      session_id      TEXT,
      herdr_workspace TEXT,
      desired         INTEGER NOT NULL DEFAULT 0,
      started_at      TEXT,
      restarts        INTEGER NOT NULL DEFAULT 0,
      last_error      TEXT,
      updated_at      TEXT
    );
  `);
}

// MANAGED STORY-LEADER AGENT (PER-STORY). Phase 3 of the STORIES epic. butchr runs ONE
// story-leader agent per OPEN story — a persistent, supervised, --resume'd Claude session
// scoped to that story, running in its workspace's repo ROOT (it is an OPERATOR, not a
// builder — no worktree/branch/review/merge of its own). This table MIRRORS `cto_agent`
// exactly, keyed by `story_id` (FK cascade so a story's leader state dies with the story —
// and, transitively, with its workspace). Columns mirror cto_agent 1:1 (incl. `updated_at`,
// which the reconcile honor-stop check reads). story_agent is a BRAND-NEW table (no legacy
// shape to drop, unlike migrateCtoAgentPerWorkspace), so this is a plain CREATE-IF-NOT-EXISTS.
// Runs AFTER createBaselineSchema (which creates `stories`) so the FK target exists.
//   - session_id: the Claude Code session UUID, RESUMED (--resume) on every supervised
//     relaunch + boot-adopt so the leader never cold-starts (see src/workspace-agent.ts).
//   - herdr_workspace: its live herdr workspace grouping handle (the leader shares its
//     workspace's herdr workspace, like the CTO agent). Addressed/torn-down BY NAME — no
//     per-agent pane/tab is stored.
//   - desired: 1 when butchr wants it UP (supervisor relaunches on death — a story is
//     desired-up while it is `open`), 0 when explicitly stopped (done/aborted/deleted).
//   - restarts: count of supervised relaunches since the last fresh start.
//   - last_error: most recent launch/supervision failure.
function migrateStoryAgentTable(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS story_agent (
      story_id        TEXT PRIMARY KEY REFERENCES stories(id) ON DELETE CASCADE,
      session_id      TEXT,
      herdr_workspace TEXT,
      desired         INTEGER NOT NULL DEFAULT 0,
      started_at      TEXT,
      restarts        INTEGER NOT NULL DEFAULT 0,
      last_error      TEXT,
      updated_at      TEXT
    );
  `);
}

// UNIFIED WORKSPACE TABLE (story st-540ba705, step 1 — SCHEMA FOUNDATION, fully inert).
// The future model unifies the THREE agent surfaces (build agent / story leader / CTO)
// into ONE "Workspace" = the (agent + directory) EXECUTION CONTEXT in which Work runs —
// the place and the agent, distinct from Work itself (the WHAT). See
// docs/rfc-work-workspace-unification.md §2.2. This is the single table that, at the
// later step-6 cutover, SUPERSEDES the three parallel agent shapes (cto_agent /
// story_agent / a task's live-agent columns).
//
// NAMING: the table is the SINGULAR `workspace`. The PLURAL `workspaces` table is really a
// DIRECTORY + per-repo config and is renamed `directory` at the step-6c cutover (see
// migrateRenameWorkspacesToDirectory; `workspaces` then survives as a writable back-compat
// view, migrateWorkspacesView). The two names do not collide. Likewise the row type is
// `WorkspaceAgentRow` this
// step because `WorkspaceRow` is ALREADY the directory row and must not be renamed/broken
// here; it becomes the canonical Workspace at the cutover.
//
// BRAND-NEW (no legacy shape to drop, unlike migrateCtoAgentPerWorkspace) → a plain
// CREATE-IF-NOT-EXISTS. Runs AFTER createBaselineSchema (its `workspaces`/`tasks` FK
// targets must already exist). NOTHING reads or writes it yet — purely additive/inert.
//   - kind: which agent runs here — 'cto' | 'leader' | 'build' (CHECK-pinned).
//   - directory_id: the DIRECTORY this runs in → today's `workspaces(id)` (FK cascade so
//     the context dies with its directory). Renamed `directory` at the cutover.
//   - work_id: the OPTIONAL Work this executes (FK to tasks(id), cascade); NULL for a CTO
//     workspace (it is not bound to one unit of Work — RFC Q3/Q5).
//   - session_id / desired / started_at / restarts / last_error: the supervised-session
//     runtime state, mirroring cto_agent / story_agent.
//   - has_agent / idle / idle_context: the honest owned-agent + idle markers, generalizing
//     the per-task columns of the same name across all agent kinds.
//   - herdr_workspace: the live herdr workspace grouping handle (agents are addressed BY
//     NAME — story st-a77b050f — so no per-agent pane/tab is stored).
function migrateWorkspaceTable(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace (
      id              TEXT PRIMARY KEY,
      name            TEXT,
      kind            TEXT NOT NULL CHECK (kind IN ('cto','leader','build','ceo')),
      directory_id    TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
      work_id         TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      session_id      TEXT,
      desired         INTEGER NOT NULL DEFAULT 0,
      started_at      TEXT,
      restarts        INTEGER NOT NULL DEFAULT 0,
      last_error      TEXT,
      has_agent       INTEGER NOT NULL DEFAULT 0,
      idle            INTEGER NOT NULL DEFAULT 0,
      idle_context    TEXT,
      herdr_workspace TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_dir  ON workspace(directory_id);
    CREATE INDEX IF NOT EXISTS idx_workspace_work ON workspace(work_id);
  `);
}

// PHYSICAL RENAME `workspaces` → `directory` (story st-540ba705, STEP 6c — the cutover).
// This INVERTS step 1's `directory`-VIEW-over-`workspaces`: the directory+config table
// becomes the REAL `directory` table and `workspaces` becomes a (writable) back-compat VIEW
// over it (migrateWorkspacesView, below). The CONTRIBUTING §5 sanctioned pre-1.0 in-place
// conceptual rename — every row AND its opaque `dir-…` id VALUE is preserved (we never
// rewrite id values), exactly like migrateDirectoriesToWorkspaces.
//
// ORDER (load-bearing): runs AFTER the cto_agent/story_agent/`workspace` tables are created
// (so the rename rewrites their child FK `REFERENCES workspaces(id)` → `directory(id)`) and
// BEFORE ensureForwardColumns (so the additive column ALTERs target the real `directory`
// table). SQLite with legacy_alter_table OFF (bun's default) auto-rewrites every child FK
// reference in tasks/stories/cto_agent/`workspace` on the table rename — the same mechanism
// migrateDirectoriesToWorkspaces relies on.
//
// BACKWARD-SAFE (the dev-runs-migrate-live-db hazard): a gate/build importing db.ts can run
// this against the LIVE db WHILE the OLD server runs on old code. The OLD server both READS
// and WRITES `workspaces`; the writable VIEW created by migrateWorkspacesView keeps both
// working unchanged until the deliberate restart — no destructive DROP/RENAME the old server
// depends on. The final hard removal of the `workspaces` view is a LATER post-restart release.
//
// IDEMPOTENT: guarded on `workspaces` still being a real TABLE and `directory` not yet a
// table — once converged (`workspaces` is a view, `directory` is the table) the whole block
// is skipped and never throws. The step-1 `directory` VIEW (if present) is dropped FIRST
// (viewExists-guarded — never a `DROP VIEW` on the real table) so the name frees up for the
// rename, and so SQLite doesn't rewrite that view into a self-referential `SELECT * FROM
// directory` during the rename. Pure (takes the connection) so it is unit-testable on a
// hand-built post-step-1 DB independent of the module singleton (test/work-cutover-6c.test.ts).
export function migrateRenameWorkspacesToDirectory(database: Database): void {
  if (tableExists(database, "workspaces") && !tableExists(database, "directory")) {
    if (viewExists(database, "directory")) database.exec(`DROP VIEW directory`);
    database.exec(`ALTER TABLE workspaces RENAME TO directory`);
  }
}

// `workspaces` BACKWARD-COMPAT WRITABLE VIEW (story st-540ba705, STEP 6c). After the rename
// above, `directory` is the authoritative table; this re-creates `workspaces` as a VIEW over
// it so the running OLD server — and the test suite, which writes to `workspaces` throughout —
// keep working byte-identically until the deliberate restart. REPLACES step 1's
// migrateDirectoryAlias and stays LAST in the boot pass so the view mirrors the FULL column
// set after ensureForwardColumns (a `CREATE VIEW … SELECT *` snapshots columns at creation
// time). DROP-then-CREATE every boot is non-destructive (a view holds NO data) + idempotent
// (byte-identical sqlite_master SQL each pass).
//
// WRITABLE via three INSTEAD OF triggers redirecting every write to `directory` (a plain
// SQLite view is read-only). Faithful mapping:
//   - INSERT: forwards NEW.* with COALESCE only on the two NOT NULL DEFAULT 0 columns
//     (release_mode/branch_isolation), so an INSERT that OMITS them — the common test/old
//     shape `(id, path, label, created_at)` — gets the table default instead of a NOT NULL
//     violation. `INSERT OR IGNORE` so an explicit `INSERT OR IGNORE INTO workspaces` (the
//     shared-singleton test idiom) stays tolerant rather than throwing on a PK re-insert.
//   - UPDATE: writes NEW.* VERBATIM (NO COALESCE) — NEW already carries each unchanged
//     column's existing value, and an UPDATE that explicitly sets a column to NULL MUST
//     persist NULL (COALESCE would wrongly clobber it back to a default). WHERE id=OLD.id.
//   - DELETE: `DELETE FROM directory WHERE id=OLD.id`, which cascades to tasks/stories/etc.
//     via the FK rewritten by the rename — preserving the old `DELETE FROM workspaces` cascade.
// Pure (takes the connection) for standalone testing, mirroring migrateRenameWorkspacesToDirectory.
export function migrateWorkspacesView(database: Database): void {
  // DROP the view (which also drops its INSTEAD OF triggers); the explicit trigger drops are
  // a belt-and-suspenders no-op for the impossible trigger-without-view state.
  database.exec(`DROP TRIGGER IF EXISTS workspaces_view_insert`);
  database.exec(`DROP TRIGGER IF EXISTS workspaces_view_update`);
  database.exec(`DROP TRIGGER IF EXISTS workspaces_view_delete`);
  // DEFENSIVE SELF-HEAL (REVAMP-2 B.5b incident): drop `workspaces` by its ACTUAL object type.
  // It is normally a VIEW, but a botched table-rebuild once left it as a TABLE, and a plain
  // `DROP VIEW` throws "use DROP TABLE to delete table workspaces" on a table → boot crash-loop.
  // Querying the type and dropping accordingly turns that unbootable state into a self-healing
  // convergence (the stray table is dropped and rebuilt as the view on the very next boot).
  const wsType = database
    .query<{ type: string }, []>(`SELECT type FROM sqlite_master WHERE name='workspaces'`)
    .get()?.type;
  if (wsType === "table") database.exec(`DROP TABLE IF EXISTS workspaces`);
  else database.exec(`DROP VIEW IF EXISTS workspaces`);
  database.exec(`CREATE VIEW workspaces AS SELECT * FROM directory`);
  database.exec(`
    CREATE TRIGGER workspaces_view_insert INSTEAD OF INSERT ON workspaces BEGIN
      INSERT OR IGNORE INTO directory
        (id, path, label, herdr_workspace, herdr_pane, gate_cmd, version_file,
         changelog_path, cto_enabled, release_mode, branch_isolation, created_at)
      VALUES
        (NEW.id, NEW.path, NEW.label, NEW.herdr_workspace, NEW.herdr_pane, NEW.gate_cmd,
         NEW.version_file, NEW.changelog_path, NEW.cto_enabled,
         COALESCE(NEW.release_mode, 0), COALESCE(NEW.branch_isolation, 0), NEW.created_at);
    END;
  `);
  database.exec(`
    CREATE TRIGGER workspaces_view_update INSTEAD OF UPDATE ON workspaces BEGIN
      UPDATE directory SET
        id=NEW.id, path=NEW.path, label=NEW.label, herdr_workspace=NEW.herdr_workspace,
        herdr_pane=NEW.herdr_pane, gate_cmd=NEW.gate_cmd, version_file=NEW.version_file,
        changelog_path=NEW.changelog_path, cto_enabled=NEW.cto_enabled,
        release_mode=NEW.release_mode, branch_isolation=NEW.branch_isolation,
        created_at=NEW.created_at
      WHERE id=OLD.id;
    END;
  `);
  database.exec(`
    CREATE TRIGGER workspaces_view_delete INSTEAD OF DELETE ON workspaces BEGIN
      DELETE FROM directory WHERE id=OLD.id;
    END;
  `);
}

// Lightweight forward migrations: add columns introduced after the initial
// schema. Guarded so existing databases upgrade in place without data loss.
function ensureColumn(table: string, column: string, decl: string): void {
  if (!columnExists(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

// DROP a column that a later migration retired. PRAGMA-guarded so it is a no-op when the
// column is already absent (a fresh DB never created it; an existing DB drops it once),
// making the migration safe to re-run. Uses ALTER TABLE ... DROP COLUMN (SQLite >= 3.35,
// which Bun's bundled SQLite supports).
function dropColumnIfExists(table: string, column: string): void {
  if (columnExists(db, table, column)) {
    db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  }
}

// All the additive column migrations, in order. Wrapped so the boot MIGRATIONS
// runner executes them as ONE ordered step (after the baseline schema, before the
// status-fold migrations). Each ensureColumn is independently idempotent.
function ensureForwardColumns(): void {

// NOTE (st-540ba705 STEP 6c): the directory+config table is now physically `directory`
// (renamed from `workspaces` by migrateRenameWorkspacesToDirectory, which runs immediately
// before this step). These additive column ALTERs therefore target `directory` — the real
// table — NOT the `workspaces` back-compat VIEW (an `ALTER TABLE` on a view throws). The
// view (migrateWorkspacesView) runs LAST and `SELECT *`s these columns through for the old
// server. The column comments still say "PER-WORKSPACE" — the CONCEPT is unchanged; only the
// physical table name moved.

// PER-WORKSPACE BUILD/TEST GATE COMMAND. The CI gate (pre-merge, in a task's
// worktree) and the post-merge verify gate (repo root) both need a build/test
// command to run. butchr manages OTHER projects with no universal build command, so
// this column lets each registered workspace carry its OWN gate command (e.g. a
// 'sandbox' repo defines its own build/test), threaded into both gates. Semantics:
// NULL means "use the default" (`config.verifyCmd`, which is EMPTY by default — i.e.
// no gate — and is set globally via BUTCHR_VERIFY_CMD); a non-null value (including
// the empty string, which DISABLES the gate for that workspace) is used verbatim.
// Resolved by workspaces.workspaceGateCmd and run via `bash -lc` in the relevant
// cwd. Settable at register time and updatable via PATCH /api/workspaces/:id.
ensureColumn("directory", "gate_cmd", "TEXT");

// PER-WORKSPACE OPTIONAL VERSION FILE. butchr no longer ASSUMES every repo carries a
// version file — auto-patch-bumping at merge is opt-in. This column is the relative
// path of the version file butchr patch-bumps on a successful merge (e.g.
// `package.json`). Semantics mirror gate_cmd: NULL means "use the GLOBAL default"
// (`config.versionFile`, itself EMPTY by default — i.e. OFF — settable via
// BUTCHR_VERSION_FILE); a non-null value (incl. the empty string, which DISABLES the
// bump for that workspace) is used verbatim. Resolved by workspaces.workspaceVersionFile;
// applied at merge by git.bumpVersionFile (a no-op when the file is absent / has no
// semver version field). Settable at register time + via PATCH /api/workspaces/:id.
ensureColumn("directory", "version_file", "TEXT");

// PER-WORKSPACE OPTIONAL CHANGELOG-GATE PATH. butchr no longer WRITES the changelog at
// merge — the task/agent owns its entry and the CI gate VERIFIES one was added. This
// column is the relative path of the changelog file that gate checks (e.g.
// `CHANGELOG.md`). Semantics mirror gate_cmd: NULL means "use the GLOBAL default"
// (`config.changelogPath`, itself EMPTY by default — i.e. the gate is OFF — settable
// via BUTCHR_CHANGELOG_PATH); a non-null value (incl. the empty string, which DISABLES
// the gate for that workspace) is used verbatim. Resolved by
// workspaces.workspaceChangelogPath; enforced in tasks.triggerCi via
// changelog.checkChangelogUpdated. Settable at register time + via PATCH /api/workspaces/:id.
ensureColumn("directory", "changelog_path", "TEXT");

// PER-WORKSPACE CTO-AGENT ENABLE. The managed CTO agent is now ONE PER WORKSPACE (it
// runs in the repo root and IS that project's principal/dev agent — see the cto_agent
// table). This column is that workspace's master switch for boot auto-start +
// crash supervision: NULL (the default every existing row backfills to) means "inherit
// the GLOBAL default" config.ctoAgentEnabled (itself DEFAULT OFF); 1 forces it ON, 0
// forces it OFF — so a workspace's own setting WINS over the global default. Resolved
// by workspaces.isCtoEnabled; settable via PATCH /api/workspaces/:id. (The on-demand
// /api/workspaces/:id/cto/* endpoints still work regardless, so an operator can start
// one even when boot-auto-start is off.)
ensureColumn("directory", "cto_enabled", "INTEGER");

// PER-WORKSPACE VERSIONED-RELEASES MODE. When 1, butchr treats this workspace as a
// versioned-release repo: EVERY merged change bumps the version file by the task's
// declared level AND stamps that task's changelog entry with the assigned version +
// date (promoteUnreleased), in the SAME merge-lock commit — so each merge owns its own
// `## [X.Y.Z]` heading (ending the `[Unreleased]` cascade conflicts). It also makes the
// changelog gate STRICT (every non-empty diff, incl. docs-only, must carry an entry) and
// drops the docs-only bump-skip. Default 0 (off — today's opt-in patch-bump behavior).
// Resolved by workspaces.workspaceReleaseMode; everything keys off THIS column (no
// hardcoded workspace id). Settable via PATCH /api/workspaces/:id.
ensureColumn("directory", "release_mode", "INTEGER NOT NULL DEFAULT 0");

// PER-WORKSPACE 3-LEVEL BRANCH-ISOLATION GUARD (the stories merge model — CONTRIBUTING
// §11). When 1, stories OPENED AFTER the flag is set are ISOLATED: each gets its own
// branch off the default branch, its subtasks merge into the STORY branch (not the
// default), and the completed story is re-gated + merged into the default branch — so the
// default branch only ever sees whole, verified stories. Mirrors release_mode exactly:
// default 0 (OFF — today's behavior, every task merges straight to the default branch).
// LIVE: the isolation paths read it (gated per story), but it stays OFF by default and is
// not enabled on any live workspace by default. Critically, isolation keys off a story's
// CAPTURED `isolated` bit (see stories.isolated), NOT this live flag, so flipping it NEVER
// retroactively changes an already-open story (§11.8). Settable via PATCH /api/workspaces/:id
// (workspaces.setWorkspaceBranchIsolation).
ensureColumn("directory", "branch_isolation", "INTEGER NOT NULL DEFAULT 0");

// PER-STORY ISOLATION BIT (the bootstrapping cut — CONTRIBUTING §11.8). Captured ONCE at
// createStory time from the workspace `branch_isolation` flag: 1 = this story is isolated
// (its own branch; subtasks merge into the story branch; re-gate + merge to the default
// branch on completion), 0 = standalone (its subtasks merge straight to the default
// branch — today's behavior). Base/merge-context resolution keys off THIS captured bit,
// NOT the live workspace flag, so flipping the flag never retroactively changes an
// already-open story. Default 0 (every existing row + every story opened while the flag is
// OFF). LIVE: captured at createStory and consumed by the base/merge-context resolvers +
// the story→main land path. Additive nullable-with-default column, mirroring release_mode.
ensureColumn("stories", "isolated", "INTEGER NOT NULL DEFAULT 0");

// STORY-LEVEL MERGE-RANGE bookkeeping (CONTRIBUTING §11.6 — Phase E). When an isolated
// story's branch is merged into the default branch (the story→main step on completion),
// we record the SHAs that bracket the WHOLE story's commit range ON the default branch:
// `merge_base_sha` = the default-branch tip BEFORE the story's fast-forward (exclusive
// lower bound), `merged_sha` = the new tip AFTER it (inclusive upper bound). These are the
// story-level analog of the per-task merge_base_sha/merged_sha and are the unit a
// whole-story rollback reverts (the story→main rebase rewrites the subtasks' commits, so
// their story-branch shas are meaningless against main afterward — §11.6 caveat). NULL for
// every non-isolated story and any story not yet landed. Additive nullable columns.
ensureColumn("stories", "merge_base_sha", "TEXT");
ensureColumn("stories", "merged_sha", "TEXT");

// `summary` holds the agent's optional request_review summary (shown in review).
ensureColumn("tasks", "summary", "TEXT");

// `idle` flags a running task whose agent has gone quiet (no recent CLI output).
// It is orthogonal to `status` — only ever set while status='running' — much
// like `conflict` is orthogonal to status='review'. The dispatcher watcher owns
// it and clears it as soon as output resumes or the task leaves `running`.
ensureColumn("tasks", "idle", "INTEGER NOT NULL DEFAULT 0");

// `idle_context` is the ANSI-stripped tail of the agent's run log captured at the
// instant `idle` flips 0→1, so the idle-handling responder (the CTO agent or a human)
// can SEE what the agent was doing and where it stopped (a mid-task pause, a finished-
// but-not-submitted turn, a wedged prompt) instead of blindly poking it. Cleared (NULL)
// the moment the agent resumes (idle→0) or the task leaves the live build phase, so a
// stale snapshot never lingers. Set/cleared alongside `idle` (see tasks.setIdle).
ensureColumn("tasks", "idle_context", "TEXT");

// `gave_up` is the DURABLE verdict that the unified-workspace supervisor has hit the
// consecutive-relaunch cap (config.ctoMaxRestarts) for a desired-up agent and STOPPED
// trying — i.e. the CTO/leader is dead-and-abandoned, awaiting an operator. The supervisor's
// give-up was previously IN-MEMORY only (supState.consecutiveFailures) and surfaced only via
// console.error, so nothing could DB-query stranded work (story st-a4cc6082). It is an
// orthogonal MARKER on the workspace row — NOT a status — set when the cap is reached and
// cleared the moment the agent becomes healthy again or an operator start/enable resets
// supervision. Owned by workspace-agent.superviseWorkspace; default 0.
ensureColumn("workspace", "gave_up", "INTEGER NOT NULL DEFAULT 0");

// `idle_escalated_at` is the DURABLE timestamp (epoch ms) of the LAST leader-idle escalation
// published for this workspace, powering the REPEATING idle escalation (story st-926eea1c S1).
// It REPLACES the in-process supState.lastIdleSignaled flag, which reset on every butchr restart
// (so after a restart the push re-fired once then went silent forever). Persisting it means a
// still-idle leader keeps re-firing on the flat cadence (config.idleEscalateEveryMs) EVEN across a
// process restart. NULL = no escalation outstanding / re-armed. Owned by
// workspace-agent.reconcileOperatorIdle (stamped=now on each cadence fire); cleared to NULL ATOMICALLY
// with the idle→0 flip in setWorkspaceIdle and with the desired→0 teardown, so a resolved
// (active-or-retired) operator re-arms a fresh future episode. Nullable, default NULL.
ensureColumn("workspace", "idle_escalated_at", "INTEGER");

// `needs_user_input` flags a running task whose agent is hung ALIVE at a pre-MCP OS/CLI
// dialog (e.g. a channel-confirm prompt) that ONLY A HUMAN can answer by sending keystrokes
// to the live pane. Like `idle`, it is an orthogonal FLAG on a LIVE in_progress agent — NOT
// a 13th status — and it is the EXACT idle pattern: the agent stays in_progress/attachable
// (a status transition would run parkExitingAgent and the pane would vanish, but the human
// must keep the pane to answer). It differs from idle only in ROUTING: it forces the task's
// feedback STRAIGHT to the user (pendingResponder → 'user', regardless of parent_id), so it
// never reaches the CTO/leader push-feed. NOTHING sets it yet (detection lands later); this
// spine is INERT. See tasks.setNeedsUserInput.
ensureColumn("tasks", "needs_user_input", "INTEGER NOT NULL DEFAULT 0");

// `needs_user_input_context` is the ANSI-stripped tail of the agent's run log captured at the
// instant `needs_user_input` flips 0→1, so the user can SEE what dialog the agent is wedged
// on before answering. Cleared (NULL) the moment the flag clears (→0) or the task leaves the
// live build phase, so a stale snapshot never lingers. Set/cleared alongside
// `needs_user_input` (see tasks.setNeedsUserInput), exactly like idle_context tracks idle.
ensureColumn("tasks", "needs_user_input_context", "TEXT");

// `aborting` is a one-way, member-level NON-MERGEABLE latch (story st-a632b2cc F3): set 1
// SYNCHRONOUSLY on a story's LIVE members the instant a cascade-abort/delete begins tearing
// them down (stories.abortInflightMembers' pre-await prefix, only for the abort+delete callers).
// It closes the orphan-merge WINDOW: deleteStory REMOVES the story row + NULLs each member's
// story_id, so the story-level F1 parent-status guard (which reads the `stories` row) can no
// longer see the parent — a human approval landing mid-teardown would otherwise merge the member
// to main as a STANDALONE orphan. finalizeMerge/maybeAutoMerge refuse any `aborting` member
// BEFORE the merge lock, so it can never reach main. A one-way latch on purpose: a member of a
// deleted/aborted story must NEVER merge, so even a best-effort abort that FAILS (member left
// in_review) stays permanently non-mergeable. Owned by stories.ts; default 0.
ensureColumn("tasks", "aborting", "INTEGER NOT NULL DEFAULT 0");

// `session_id` is the Claude Code session UUID butchr assigns to the agent at
// launch (`--session-id <uuid>`). It is what makes the review handshake durable:
// once set, butchr can re-launch the SAME session with full prior context via
// `claude --resume <session_id>` — used to hand a rejected task's notes back to
// the agent without holding a live, blocking process open. Persisted so it
// survives a butchr restart while a task waits in `review`.
ensureColumn("tasks", "session_id", "TEXT");

// Dispatch retry/backoff bookkeeping. A task whose dispatch() keeps throwing used
// to re-queue and hot-loop every tick forever, silently. These columns make the
// retry bounded and visible (see dispatcher.markDispatchFailure + tick gating):
//   - `dispatch_attempts` counts consecutive FAILED dispatch attempts; reset to 0
//     on a successful launch (markRunning) and on a fresh re-queue (reject /
//     reconcile / requeue), so it only ever reflects an unbroken run of failures.
//   - `last_dispatch_error` is the most recent dispatch failure message, surfaced
//     for the operator and carried onto a `failed` task.
//   - `next_dispatch_at` is an ISO timestamp: while set in the FUTURE the task is
//     waiting out a backoff and the tick loop must NOT dispatch it yet.
ensureColumn("tasks", "dispatch_attempts", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("tasks", "last_dispatch_error", "TEXT");
ensureColumn("tasks", "next_dispatch_at", "TEXT");

// `resume_attempts` counts CONSECUTIVE host/herdr-restart AUTO-RESUMES of this task
// that did NOT make progress. When butchr finds a task it thinks is in_progress but
// whose claude process isn't actually alive (a power loss / herdr restart left a bare
// login-shell pane — see src/liveness.ts), it re-dispatches the same session via
// `claude --resume`. This counter bounds that (config.maxResumeAttempts) so a session
// that dies the instant it relaunches can't re-dispatch-loop forever; past the cap the
// task is rescued to review for a human. Distinct from `dispatch_attempts` (which
// counts dispatch() *launch* failures): a resume that launches fine but whose agent is
// then killed again is not a dispatch failure. Reset to 0 on real progress (reaching
// review) and on any operator re-queue. See tasks.requeueForResume.
ensureColumn("tasks", "resume_attempts", "INTEGER NOT NULL DEFAULT 0");

// `gate_recovery_attempts` is the GATE sibling of `resume_attempts`: it counts
// CONSECUTIVE host/herdr-restart RECOVERY re-triggers of this task's CI / conformance
// gate that did NOT settle a real result. The CI gate (tasks.triggerCi) and the
// spec-conformance reviewer (conformance.triggerConformance) run fire-and-forget in
// butchr's OWN process, so a power loss / restart kills a gate mid-run and leaves the
// task stuck `ci_status='running'` / `conformance_status='checking'` forever. On startup
// (and the reaper backstop) butchr re-triggers every such stale in-flight gate; this
// counter bounds that (config.maxGateRecoveryAttempts) so a gate that dies the instant
// it starts can't loop across crash-restarts — past the cap the stuck gate is
// force-settled (CI → 'fail', conformance → cleared) instead. Reset to 0 the moment ANY
// gate settles a real result (the triggerCi / triggerConformance write-back). See
// tasks.recoverStuckGates.
ensureColumn("tasks", "gate_recovery_attempts", "INTEGER NOT NULL DEFAULT 0");

// `blocked_by` is a JSON-array TEXT column holding the ids of the tasks this task
// is BLOCKED ON (its dependency set). A task with any not-yet-merged blocker sits
// in status='blocked' (a pre-dispatch waiting state — no agent runs) until every
// blocker has merged, at which point it is promoted to 'queued' and dispatches
// normally. NULL / "[]" means no dependencies. We use a JSON column (not a join
// table) to stay consistent with the additive single-column migration pattern
// above. See tasks.ts (parseBlockedBy / reevaluateBlockedTask / setBlockedBy) and
// the dispatcher tick's auto-unblock pass.
ensureColumn("tasks", "blocked_by", "TEXT");

// `initiative_id` groups the per-repo child STORIES of a CROSS-REPO project initiative
// (REVAMP-4 Phase 3 / P3e). A CEO's cross-repo initiative fans one brief into MULTIPLE
// member repos — each landing an ordinary repo-scoped story NODE — and stamps every child
// node's `initiative_id` with the SAME generated grouping key (an `ini-` id that is NOT
// itself a row). NULL on every other row: single-repo P3d initiatives, ordinary stories,
// and all leaves are untouched, so this is inert to every leaf-only loop. The completion
// ROLLUP (stories.listProjectInitiatives / reportInitiativeCompletionIfDone) reads it to
// decide the initiative is DONE when every child node has landed `done`.
ensureColumn("tasks", "initiative_id", "TEXT");

// CI GATE bookkeeping. When a task transitions to `review`, butchr asynchronously
// runs build + tests in that task's worktree and records the outcome here so the
// webapp can show a pass/fail badge in the review panel (before the diff):
//   - `ci_status` is 'running' while the build/test job is in flight, then 'pass'
//     or 'fail' once it settles; NULL means CI never ran for this task (e.g. it was
//     rescued to review with no worktree). It is orthogonal to `status` — only ever
//     meaningful while status='review' — much like `conflict`/`idle`.
//   - `ci_summary` is a short human-readable summary: the first line is a compact
//     badge label ("build + N tests" / "build failed" / "K test failures") and the
//     rest (if any) is a tail of the build/test output for the reviewer.
// See tasks.ts (triggerCi / runCi, fired from markReview / markReviewFromAgent).
ensureColumn("tasks", "ci_status", "TEXT");
ensureColumn("tasks", "ci_summary", "TEXT");
// `ci_tip` is the task-branch HEAD sha the CI gate ran against, stamped when the gate
// settles (see tasks.triggerCi). It BINDS a stored pass/fail to the exact tip it gated:
// if the branch tip later moves (e.g. a pre-dispatch rebase), the stored result is for a
// DIFFERENT tip and must not be trusted as green — auto-merge re-checks ci_tip against the
// live HEAD (maybeAutoMerge) and a tip-change invalidates it (invalidateStaleGates). NULL
// when CI never settled a real result. See conformance_tip for the sibling gate.
ensureColumn("tasks", "ci_tip", "TEXT");

// SPEC-CONFORMANCE GATE bookkeeping. When a task enters `review`, butchr also runs
// an advisory read-only reviewer (a headless Claude — see src/conformance.ts) that
// judges whether the task's DIFF actually SATISFIES its PROMPT (complete + on-spec),
// so half-implemented / off-spec work is flagged before a human reads the diff. CI
// proves the task BUILDS + tests pass; this proves it did WHAT WAS ASKED — a
// complementary, orthogonal signal recorded here:
//   - `conformance_status` is 'checking' while the reviewer is in flight, then 'pass'
//     (conforms) or 'concern' (partial/off-spec/incomplete) once it settles; NULL
//     means it never ran or couldn't (no worktree, the gate disabled, a spawn error,
//     or an unparseable verdict — best-effort). Orthogonal to `status` — only ever
//     meaningful while status='review', like `ci_status`/`conflict`.
//   - `conformance_summary` is the reviewer's short reason naming any missing /
//     incomplete / off-spec parts (empty/"conforms" on a pass).
// ADVISORY ONLY — it never hard-blocks approval (mirrors the CI-fail warning). See
// tasks.ts (the triggerConformance hook in markReview / markReviewFromAgent).
ensureColumn("tasks", "conformance_status", "TEXT");
ensureColumn("tasks", "conformance_summary", "TEXT");
// `conformance_tip` is the sibling of `ci_tip` for the conformance gate: the task-branch
// HEAD sha that gate ran against, stamped on settle (see tasks.triggerConformance), so a
// stored verdict bound to a stale tip is invalidated when the branch moves. NULL until it
// settles a real result.
ensureColumn("tasks", "conformance_tip", "TEXT");

// `revert_reason` records WHY a task's merge was auto-reverted off the default
// branch: the post-merge verify gate (build + tests) came back RED, so the merge
// was undone (git reset to the pre-merge tip) and the task flagged. It holds the
// failing build/test output. Orthogonal to `status` — set alongside status='failed'
// so the dispatcher won't re-launch it and the reaper leaves its worktree/branch
// intact for inspection; its presence is what the webapp keys on to render a
// "reverted from main" panel (distinct from a dispatch failure). See
// tasks.approveTask's post-merge verify path. This is the POST-MERGE gate (repo
// root, blocking + auto-revert) — distinct from the CI gate above, which is the
// pre-merge, in-worktree, advisory review badge.
ensureColumn("tasks", "revert_reason", "TEXT");

// TASK KIND. `kind` distinguishes an ordinary work task ('task', the default) from a
// 'rollback' task (created from the built-in `rollback` template — see the webapp's
// "Roll back" button + src/templates.ts): an ordinary build task whose revert lands
// through its OWN lifecycle tail — it shows `rolling_back` while the mechanical merge
// runs and lands `rolled_back` (terminal) instead of `merged` (see tasks.finalizeMerge).
//
// RETIRED: the old 'plan' kind + its `spawned_subtasks` column (the AUTO-DECOMPOSE
// path) were removed — agents are WORKERS, not task-managers, so an agent no longer
// decomposes work into sub-tasks (a suggested decomposition is now RAISED to the
// operator via the `raise` MCP tool, acted on through the REST API). We KEEP the `kind`
// column (rollback uses it) but deliberately do NOT add an `ensureColumn` for
// `spawned_subtasks` and do NOT drop it: a fresh DB never has it, while an OLD DB keeps
// it ORPHANED (never read or written), avoiding a destructive ALTER on the live table.
// See mcp.ts (raise) / tasks.createTask.
ensureColumn("tasks", "kind", "TEXT NOT NULL DEFAULT 'task'");

// AUTO-MERGE bookkeeping. Set to 1 when butchr auto-approved + merged this task
// (CI-green + low-risk) instead of a human approving it — see config.autoMergeEnabled
// and tasks.maybeAutoMerge. Orthogonal to `status`: it records HOW a merged task
// landed (auto vs human), and the webapp can badge auto-merged tasks. Only ever set
// once a merge actually succeeds (a conflict/revert never sets it).
ensureColumn("tasks", "auto_merged", "INTEGER NOT NULL DEFAULT 0");

// Merge-range bookkeeping. When a task merges, we record the SHAs that bracket the
// commits it landed on the default branch:
//   - `merge_base_sha` is the base tip BEFORE the fast-forward (exclusive lower
//     bound); `merged_sha` is the new tip AFTER it (inclusive upper bound). The
//     task's commits are exactly `merge_base_sha..merged_sha`.
// Rollback is a deliberate TASK now (created from the `rollback` template via the
// webapp's "Roll back" button — see src/templates.ts), not a mechanical revert, so
// these SHAs let that button pre-fill the exact commit to revert. Tasks merged
// before this feature have NULL SHAs (the button is hidden for them).
ensureColumn("tasks", "merge_base_sha", "TEXT");
ensureColumn("tasks", "merged_sha", "TEXT");

// PER-TASK MODEL + TOKEN/COST accounting.
//   - `model` is the model alias/name the task REQUESTED at creation (e.g. 'opus',
//     'sonnet', 'haiku', or a full 'claude-*' id). NULL means "unset" → the launch
//     command threads no --model flag and claude uses its current default. Validated
//     at creation (tasks.validateModel) and threaded into the agent launch via the
//     `{{MODEL_FLAG}}` placeholder (config.agentCmd/resumeCmd, dispatcher.resolveLaunchCommand).
//   - `model_used` is the model the agent ACTUALLY ran under, read back from the
//     Claude Code session transcript (usage.ts). Useful when `model` is unset (shows
//     what the default resolved to) or to confirm the requested model took effect.
//   - The `usage_*_tokens` columns hold cumulative token counts for the session,
//     summed across every assistant turn in the transcript (input, output, and the
//     two cache buckets). Captured on the review/merge transition (tasks.captureSessionUsage).
//   - `cost_usd` is a placeholder: Claude Code's session transcript records token
//     usage but NOT a dollar cost, and butchr ships no per-model pricing table, so
//     we do NOT fabricate a number. The column exists for when a cost source is
//     wired up (TODO: derive from usage_* tokens × a model pricing table, or read it
//     if a future claude exposes costUSD in the transcript). It stays NULL for now.
ensureColumn("tasks", "model", "TEXT");
ensureColumn("tasks", "model_used", "TEXT");
ensureColumn("tasks", "usage_input_tokens", "INTEGER");
ensureColumn("tasks", "usage_output_tokens", "INTEGER");
ensureColumn("tasks", "usage_cache_read_tokens", "INTEGER");
ensureColumn("tasks", "usage_cache_creation_tokens", "INTEGER");
ensureColumn("tasks", "cost_usd", "REAL");

// RAISE HANDSHAKE. When a running agent calls the MCP `raise` tool, butchr records
// what it raised (a question, a suggested task change, or a suggested decomposition)
// and parks the task in status='needs_info' (the agent returns immediately and exits —
// no live process, exactly like the non-blocking review handshake). Whoever operates
// answers through ONE unified surface (API / CLI / webapp), and butchr re-launches the
// SAME Claude session via `--resume` with the response injected (mirroring
// reject→resume):
//   - `question` holds the agent's pending raised item, surfaced while
//     status='needs_info' (webapp answer box + /health needsAttention). Cleared when it
//     is answered. (Column name predates the broader `raise`; kept to preserve rows.)
//   - `answer` is the operator's response, held transiently for the resume dispatch to
//     inject into the prompt, then consumed (cleared) the moment the agent re-launches
//     (markRunning). Orthogonal to `status`. See tasks.markNeedsInfoFromAgent /
//     tasks.answerTask / dispatcher.dispatch (the answer-resume prompt).
ensureColumn("tasks", "question", "TEXT");
ensureColumn("tasks", "answer", "TEXT");

// DURATION-ESTIMATE FOOTPRINT. Two cheap signals captured WHEN A TASK ENTERS REVIEW
// (while its worktree still exists), used to bucket the task for the rough
// duration-estimate model (see src/estimate.ts):
//   - `diff_lines` is the task's final changed-line count (added + deleted vs the
//     default branch, from git.diffStat) → its SIZE bucket (small/medium/large).
//   - `path_type` is a coarse path-based TYPE ('docs'/'webapp'/'core'/'mixed')
//     derived from the changed file set (estimate.classifyPathType).
// Both are NULL for tasks that never reached review / predate this feature; such
// tasks only feed the overall-pool estimate, never a size/type bucket. Captured by
// tasks.captureDiffFootprint (best-effort, re-captured on each review transition so
// a rework's final footprint wins). Orthogonal to `status`. See src/estimate.ts.
ensureColumn("tasks", "diff_lines", "INTEGER");
ensureColumn("tasks", "path_type", "TEXT");

// PHANTOM-RELEASE GUARD FOOTPRINT (story st-3988b68e). The task's CODE file set
// (JSON-array TEXT, repo-relative, EXCLUDING the workspace's configured changelog +
// version-file paths) captured at review/GREEN time by tasks.captureDiffFootprint —
// the DURABLE record the merge-time guard (git.merge → detectPhantomDrop) compares the
// rebased branch against to catch a rebase / CHANGELOG-conflict resolution that silently
// DROPPED the code (the EMPTY 0.9.150 phantom release). NON-SHRINKING: a later code-less
// re-capture (e.g. a `reset --soft` that dropped the code commits) KEEPS the prior
// non-empty set so a corrupted re-submission can't erase the evidence. NULL / "[]" means
// the task carried no code (pure changelog/docs) — the guard is a no-op for it.
ensureColumn("tasks", "code_files", "TEXT");

// `tags` is a JSON-array TEXT column holding a task's free-form LABELS — short
// strings the operator attaches at creation to organize a growing task list
// (e.g. "webapp", "core", "docs", "spike"). Purely organizational: nothing in the
// dispatch/review/merge machinery reads them; they exist to be filtered on (the
// webapp filter bar + the CLI `ls --tag`) and shown as chips. Settable only at
// creation for now. NULL / "[]" means no tags. A JSON column (not a join table)
// keeps it consistent with the additive single-column pattern used by `blocked_by`
// above. See tasks.ts (parseTags / normalizeTags) — surfaced
// as a real string[] on the serialized TaskView, and round-tripped in task.md's
// front matter (taskmd.ts).
ensureColumn("tasks", "tags", "TEXT");

// PER-TASK FILE ALLOWLIST. A JSON-array TEXT column holding the glob/path entries a
// task is ALLOWED to change — the same membership rule the auto-merge allowlist uses
// (tasks.fileAllowed: a `dir/` prefix, a top-level `*.ext` glob, or an exact path).
// When non-empty, the CI gate (tasks.triggerCi) FAILS the task if its diff touches any
// file outside the set, so scope creep is caught mechanically instead of by hand-diffing.
// NULL / "[]" means no allowlist (the gate is inert — every file is allowed), so existing
// rows backfill to "no restriction" and non-allowlist tasks are unchanged. Set only at
// creation (API/CLI/webapp), round-tripped in task.md's front matter. See tasks.ts
// (parseAllowlist / validateAllowlist) + the `allowlist` gate block in triggerCi.
ensureColumn("tasks", "allowlist", "TEXT");

// PER-TASK DISPATCH PRIORITY. Higher = dispatched sooner: the dispatcher's queued
// selection orders by `priority DESC, created_at ASC`, so a high-priority task
// JUMPS the queue ahead of older lower-priority ones while ties stay FIFO (see
// dispatcher.selectQueuedForDispatch). Default 0 (the baseline every existing row
// backfills to); a negative value pushes a task LATER than the default. Set at
// creation (API/CLI/webapp) and updatable any time via POST /api/tasks/:id/priority
// (tasks.setPriority). Orthogonal to `status` — it only affects the order `queued`
// tasks dispatch in; it is ignored once a task is running/terminal.
ensureColumn("tasks", "priority", "INTEGER NOT NULL DEFAULT 0");

// PLAN-PREVIEW GATE. 1 when a task opts into the plan-preview gate, else 0 (the
// default every existing row backfills to). A plan-preview task is an ordinary work
// task that writes code, but its FIRST dispatch renders a prompt that instructs the
// agent to submit a concise implementation PLAN via the MCP `propose_plan` tool and
// STOP, parking the task in `needs_info` (reusing the `raise` feedback handshake)
// holding the plan. The operator reviews the plan and answers 'proceed' or steering
// notes; butchr re-launches the SAME session via `--resume` with the decision and the
// agent then implements + calls request_review as normal. Orthogonal to `kind` and
// `status`. Set only at creation (API/CLI/webapp). See tasks.createTask / mcp.ts (propose_plan) /
// taskmd.renderAgentPrompt's plan-preview protocol.
ensureColumn("tasks", "plan_preview", "INTEGER NOT NULL DEFAULT 0");

// VERSIONED-RELEASES (per-task) bookkeeping — only meaningful when the task's workspace
// has release_mode=1 (see workspaces.release_mode):
//   - `version_bump` is the TASK-DECLARED semver bump level applied at merge: 'patch'
//     (default — every existing row backfills to it), 'minor' (allowed freely), or
//     'major' (gated behind the human DOUBLE-CONFIRM ritual — see major_confirm_count
//     and tasks.confirmMajor). The CHECK pins it to those three values. Outside
//     release_mode it is recorded but inert (the opt-in patch bump ignores it).
//   - `major_confirm_count` is the streak of CONSECUTIVE human `confirm-major` calls on
//     this task (0/1/2). A major-bump task in `in_review` does NOT merge on approve; it
//     parks until this reaches 2, then finalizeMerge lands it. ANY other action (reject,
//     conflict kick-back, re-review, setBlockedBy, requeue, changing version_bump)
//     resets it to 0, so it is literally "two confirm-major calls in a row". Default 0.
//   - `released_version` is the version butchr ASSIGNED + stamped at merge (e.g.
//     '0.9.74'), captured for display on the merged task. NULL until merged in
//     release_mode (and for every non-release_mode merge). See git.bumpVersionFile /
//     tasks.finalizeMerge.
ensureColumn("tasks", "version_bump", "TEXT NOT NULL DEFAULT 'patch' CHECK (version_bump IN ('patch','minor','major'))");
ensureColumn("tasks", "major_confirm_count", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("tasks", "released_version", "TEXT");

// RESUME RE-GROUNDING FINGERPRINT. A sha256 over the task's PROMPT + CONTEXT-FILE LIST
// (taskmd.groundingFingerprint), recorded by markRunning every time butchr GROUNDS an
// agent — i.e. launches it carrying the full prompt+context: a fresh first launch, or a
// re-grounded resume. A resume re-enters the SAME `claude --resume` session, which still
// holds the prompt+context the agent saw when last grounded, so its focused answer/rework
// message normally restates none of it. But the broadened `raise` tool lets an operator
// EDIT a paused task's prompt/context (or it can change for any reason) while the agent
// waits in needs_info / in_review; on resume the dispatcher compares this stored
// fingerprint against the CURRENT task.md and, on a mismatch, prepends the updated
// definition (taskmd.renderRegroundBlock) so the resumed agent re-grounds in the current
// task rather than the stale snapshot in its session. Review notes are deliberately NOT
// part of the fingerprint — they already flow into the rework prompt. NULL for a task
// never grounded (or paused before this column existed) — treated as a mismatch, so the
// next resume re-grounds once, which is safe. Orthogonal to `status`.
ensureColumn("tasks", "grounding_fp", "TEXT");

// STORY MEMBERSHIP (Phase 1: DATA MODEL ONLY — fully inert). A nullable FK to
// stories.id grouping this task under a STORY (a container of subtasks — see the
// `stories` table above). NULL (the default every existing row backfills to) means an
// ORDINARY STANDALONE task — today's behavior, entirely unchanged. Assigned/cleared
// ONLY via POST /api/tasks/:id/story (stories.assignTaskToStory), validated to
// reference a story IN THE SAME workspace; createTask deliberately takes no story_id
// param this phase so the task-creation spine is untouched. PURELY STORED this phase —
// nothing in dispatch/review/lifecycle reads it yet (later phases consume it).
// Following the same additive nullable-id-column pattern as `blocked_by` (the cross-
// workspace integrity is enforced in the service layer, like the guards elsewhere, not
// by a retroactive table-level FK an ALTER can't add). Surfaced on TaskView via the
// `...row` spread so it round-trips.
ensureColumn("tasks", "story_id", "TEXT");

// UNIFIED-WORK PARENT POINTER (story st-540ba705, step 1 — SCHEMA FOUNDATION, fully
// inert). A nullable SELF-FK to tasks.id: the future `work` model unifies tasks +
// stories into ONE self-referential resource where a leaf (no children) is today's
// task and a node (has children) is today's story, with the leaf-vs-node distinction
// carried STRUCTURALLY by this column (see docs/rfc-work-workspace-unification.md §2.1).
// NULL (the default every existing row backfills to) = a top-level / standalone unit —
// today's behavior, entirely unchanged. This column COEXISTS with `story_id` this step
// (it is NOT a replacement and NOT a rename): story_id stays the authoritative grouping
// FK and is left fully intact — no read of parent_id, no story_id→parent_id backfill, no
// drop (that is the step-6 cutover, separately gated). PURELY STORED — nothing in
// dispatch/review/lifecycle/feedback reads it yet. Unlike `story_id` (a plain TEXT column
// whose integrity lives in the service layer), this is a real column-level self-FK:
// SQLite ACCEPTS a `REFERENCES` clause on `ALTER TABLE ... ADD COLUMN` when the column is
// nullable (default NULL), so the FK is enforced from creation without a destructive
// table rebuild. Surfaced on TaskView via the `...row` spread so it round-trips.
ensureColumn("tasks", "parent_id", "TEXT REFERENCES tasks(id)");

// RESPONDER-REDESIGN SCHEMA (story st-def561dd, design §2). Feedback flows UP to the
// STRUCTURAL parent: a non-story task gets a single cto→user boundary (a boolean), and a
// story carries its leader's open story-level ask.
//
// `escalated_to_user` is set ONLY on a NON-STORY task when the CTO escalates its pending
// feedback to the user — the single cto→user boundary for a task (a story member's feedback
// is TERMINAL at its leader, so it never escalates to the user). Resets to 0 whenever the
// task enters a fresh feedback state. Default 0; existing rows backfill to it. Resolved by
// tasks.pendingResponder; surfaced on TaskView via the `...row` spread (no extra plumbing).
ensureColumn("tasks", "escalated_to_user", "INTEGER NOT NULL DEFAULT 0");

// `pending_ask` is a story LEADER's open STORY-LEVEL question to the CTO (NULL when none) —
// the leader's escalation seam (design §4b). `ask_responder` is who currently OWNS that
// open ask: 'cto' (the leader raised it to the CTO) or 'user' (the CTO escalated it onward),
// NULL when no ask is open. Both nullable, default NULL.
ensureColumn("stories", "pending_ask", "TEXT");
ensureColumn("stories", "ask_responder", "TEXT");

// RESPONDER-REDESIGN ACTIVATION (story st-def561dd, design §2/§6, Q-D). The V1 responder
// model is gone, so its two columns are retired: `tasks.responder_tier` (the 3-rung
// escalation walk, replaced by the structural pending_responder + escalated_to_user) and
// `directory.step_responders` (the per-step responder config — on today's `directory`
// table, renamed from `workspaces` in step 6c above — replaced by structural routing).
// PRAGMA-guarded so a fresh DB (never created them) and an existing DB (drops them once)
// both succeed. Pre-1.0: no back-compat, the columns are physically dropped.
dropColumnIfExists("tasks", "responder_tier");
dropColumnIfExists("directory", "step_responders");

// HONEST AGENT-OWNERSHIP MARKER (story st-a77b050f — AGENT IDENTITY = NAME ONLY). 1 ⇔
// butchr launched an agent for this `in_progress` task and hasn't torn it down. It is the
// truthful in-DB replacement for the old `herdr_pane_id IS NOT NULL`-as-liveness proxy: a
// pane id survives a herdr/host restart that KILLED claude (and was mis-recorded by the
// boot reconcile), so "has a pane" never honestly meant "agent is live". This marker is
// honest about what it IS — an OWNED-agent record, not a liveness claim — and is used
// ONLY as the cheap SQL/JS pre-filter; the TRUE liveness signal at the recovery/nudge
// sites stays the /proc probe (claudeAlive/agentExists). Default 0 (the value every
// existing row backfills to); the one-shot backfill below seeds 1 from the legacy pane
// signal BEFORE the pane column is dropped. Maintained in markRunning (=1), setStatus's
// exit rule (=0 on any transition off in_progress), and requeueForResume (=0).
ensureColumn("tasks", "has_agent", "INTEGER NOT NULL DEFAULT 0");

// WORK-UNIFICATION FOLD SCHEMA (REVAMP Phase B.1 — story st-6372812d, ADDITIVE + INERT).
// Lay the columns the fold needs on `tasks` so a story NODE's OWN `tasks` row can later
// become authoritative (replacing the separate `stories` table). NOTHING reads any of these
// for any decision YET — `stories.status` + getStoryRow stay the source of truth; the read
// flip is a LATER phase (B.4). Purely stored this step.
//
//   - `work_kind` is the persisted node/leaf DISCRIMINATOR the fold keys on: 'leaf' (the
//     default every existing row + every standalone task backfills to — today's task) or
//     'node' (a materialized story Work node — a row whose id IS a story id). Backfilled to
//     'node' for every materialized node by migrateBackfillNodeFold (below, after the nodes
//     are materialized) AND stamped at materialization time in migrateUnifyStoryParent /
//     ensureStoryWorkNode so a node carries it the instant it exists. This IS the SINGLE
//     authoritative node-definition the fold consults: the node/leaf PREDICATES isWorkNode/
//     isWorkLeaf (work.ts) key on it (B.2, shipped — no longer the structural child-count
//     test), and as of B.4 the node-state read accessors (storyStatusOf/getStoryRow, below)
//     read the node's OWN tasks row guarded on work_kind='node'. The resolveWork FACADE
//     (work-api.ts) still dispatches node-vs-leaf via getStory-first, not work_kind directly
//     — that identity unification lands in B.5 with the stories-table drop.
ensureColumn("tasks", "work_kind", "TEXT NOT NULL DEFAULT 'leaf'");

//   - The NODE-ONLY fields that today live ONLY on the `stories` table and have no home on
//     `tasks`: `brief` (the story's goal/description), `isolated` (the per-story isolation
//     bit — own branch; default 0), and the responder-redesign ask seam `pending_ask` /
//     `ask_responder` (a leader's open story-level ask + who owns it). Mirrored here so a
//     node row can carry them after the fold; backfilled from the id-matched `stories` row by
//     migrateBackfillNodeFold + copied at materialization time. INERT — nothing reads them yet.
//     (NOTE: `merge_base_sha` / `merged_sha` — the other two stories-only fields — ALREADY
//     exist on tasks (above), so they are deliberately NOT re-added here.)
ensureColumn("tasks", "brief", "TEXT");
ensureColumn("tasks", "isolated", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("tasks", "pending_ask", "TEXT");
ensureColumn("tasks", "ask_responder", "TEXT");

// PER-PROJECT CEO-AGENT ENABLE (REVAMP-4 Phase 3 / P3c — story st-1a82a2e1). The CEO analog of
// `directory.cto_enabled`, but keyed on the PROJECT NODE's OWN `tasks` row (a work_kind='project'
// node — there is no `directory` sidecar for a project). Read ONLY for that project node (every
// leaf/repo/story-node row leaves it NULL, exactly like the node-only brief/isolated/pending_ask
// columns above). Tri-state master switch for the project's CEO agent (boot auto-start + crash
// supervision): NULL = inherit the GLOBAL default config.ceoAgentEnabled (itself DEFAULT OFF), 1
// forces it ON, 0 forces it OFF — a project's own setting WINS over the global default. Resolved
// by workspaces.isCeoEnabled; settable via PATCH /api/projects/:id. DEFAULT OFF ⇒ with no
// config.ceoAgentEnabled and no project nodes, prod is byte-identical (no CEO ever boots).
ensureColumn("tasks", "ceo_enabled", "INTEGER");

// NAME-ONLY CUTOVER (story st-a77b050f, step 3 — final). Drop the per-agent EPHEMERAL
// herdr handles `herdr_pane_id`/`herdr_tab_id` from tasks/cto_agent/story_agent: agents
// are now addressed, torn down, and liveness-checked BY NAME (steps 1+2), so these
// columns are dead persistence. (herdr_workspace — the stable per-butchr-workspace
// grouping handle — is a DIFFERENT, out-of-scope column and stays.)
//
// MIGRATION SAFETY (load-bearing ORDER): the has_agent backfill that used to live in
// migrateReadyRunningSplit (step 7) MUST run BEFORE we drop herdr_pane_id, and the whole
// pass re-runs every boot. On the FIRST cutover boot of a DB at the pre-has_agent schema
// (older non-self-hosted repos), the additive ensureColumn above defaults has_agent=0;
// without this seed the step-7 re-bucket (`status='inactive' WHERE in_progress AND
// has_agent=0`) would DEMOTE a genuinely-live agent to ready and orphan its claude. So we
// seed has_agent=1 from the legacy pane signal HERE, guarded on the source column still
// existing, immediately before the drop. Idempotent + self-disabling (the guard fails
// once the column is gone), so it is NOT a lingering legacy migration.
//
// CRUCIAL: this runs in step 4 — BEFORE the `running`→`in_progress` status fold (step 6,
// migrateStatusModel). So a pre-canonical legacy LIVE agent is still `status='running'`
// (not yet `in_progress`) at this point; we MUST match BOTH live shapes — the pre-fold
// `running` and an already-folded `in_progress` — or the still-`running` live agent would
// backfill has_agent=0 and then be demoted to `inactive` by step 7. (Pre-canonical
// `queued`/terminal rows never carried a live pane, so the pane signal is unambiguous.)
if (columnExists(db, "tasks", "herdr_pane_id")) {
  db.exec(
    `UPDATE tasks SET has_agent=1 WHERE status IN ('in_progress','running') AND herdr_pane_id IS NOT NULL`,
  );
}
dropColumnIfExists("tasks", "herdr_pane_id");
dropColumnIfExists("tasks", "herdr_tab_id");
dropColumnIfExists("cto_agent", "herdr_pane_id");
dropColumnIfExists("cto_agent", "herdr_tab_id");
dropColumnIfExists("story_agent", "herdr_pane_id");
dropColumnIfExists("story_agent", "herdr_tab_id");
}

// UNIFY TASK STATE — fold out the retracted idea→spec→build `stage` axis. An earlier
// design (task playful-rabbit-0405) carried a SECOND axis (`stage` = idea|spec|build)
// orthogonal to `status`; the CEO retracted it as over-complicated. The idea-vs-rest
// distinction is now carried by the SINGLE status pipeline via a new FRONT state,
// `idea` — a task that has NO spec yet. butchr does NOT run an agent for it; it WAITS for
// the spec-generation responder (the CTO agent or a human) to submit a spec via
// POST /api/tasks/:id/spec, which advances it to `spec_review` carrying that spec as its
// prompt. The `stage` column is no longer written or read.
//
// MIGRATION (backward-compatible, one-time): any task still in the PRE-SPEC idea stage
// (stage='idea' and not yet dispatched — queued/blocked) becomes status='idea'; every
// other row keeps its current status untouched (a `build` task is exactly today's flow;
// a mid-flight idea/spec task in running/review just finishes through the normal
// running→review→merged transitions). Guarded on the column still existing, so a fresh
// DB (which never had a stage axis) skips it. We deliberately do NOT drop the column —
// an old DB keeps it orphaned (it defaults 'build' on inserts that omit it) rather than
// risk a destructive ALTER on the core tasks table.
export function migrateStageAxisToStatus(): void {
  if (!columnExists(db, "tasks", "stage")) return; // fresh DB — never had a stage axis
  db.exec(
    `UPDATE tasks SET status='idea' WHERE stage='idea' AND status IN ('queued','blocked')`,
  );
}

// CANONICAL STATE-MODEL MIGRATION (one-time, forward-only). The pre-canonical status
// set folds into the canonical states (pre-1.0 — migrate/destroy freely; priority =
// works forward):
//   queued        → in_progress  (then migrateReadyRunningSplit below moves the ready,
//                                  pane-NULL ones to `inactive`)
//   running       → in_progress  (a live build agent — keeps its pane)
//   review        → in_review
//   awaiting_input→ needs_info
//   rejected      → aborted       (no `rejected` state — request-changes loops back)
// `failed` is DELIBERATELY NOT folded: the 12-state model has a real terminal `failed`
// state (a dispatch/spec-gen give-up or a post-merge revert), so a legacy `failed` row
// is ALREADY correct — and, critically, since this runs every boot, folding it would
// CORRUPT every genuine new `failed` task into `aborted` on the next restart. Runs every
// boot but is a no-op once converged (no old values remain). We do NOT rewrite
// task_events history (from_status/to_status are an immutable audit log).
export function migrateStatusModel(): void {
  const renames: [string, string][] = [
    ["queued", "in_progress"],
    ["running", "in_progress"],
    ["review", "in_review"],
    ["awaiting_input", "needs_info"],
    ["rejected", "aborted"],
  ];
  for (const [from, to] of renames) {
    db.query(`UPDATE tasks SET status=? WHERE status=?`).run(to, from);
  }
}

// READY/RUNNING SPLIT MIGRATION (one-time, forward-only — the critical correctness
// point on the restart that activates the 12-state model). The old model overloaded
// `in_progress`: a row with a NULL `herdr_pane_id` meant READY (the dispatcher should
// (re-)launch it) and a row WITH a pane meant a LIVE agent. The new model carries that
// distinction in the STATUS itself: `inactive` = ready/queued (dispatcher keys on it),
// `in_progress` = a live workspace agent. So on this boot we MUST re-bucket every
// existing row or a ready task would be stranded (the dispatcher no longer looks at a
// ready `in_progress` row). The re-bucket keys off the honest `has_agent` marker (seeded
// from the legacy pane signal in ensureForwardColumns, immediately before the pane column
// is dropped — see the name-only cutover block there):
//   in_progress + no owned agent → inactive   (ready — the dispatcher will pick it up)
//   in_progress + an owned agent → in_progress (running — reconcileRunningTasks re-adopts)
// Lingering `finalizing` rows (a removed state — the post-approval merge is now
// MECHANICAL, no finalize agent): route to `in_review` so the operator re-approves into
// the new mechanical-merge-on-approve path rather than us auto-merging stale work at boot
// without a fresh gate. Any orphaned finalize agent is reaped (reapOrphans). Idempotent:
// in the new model a running `in_progress` ALWAYS has has_agent=1 (markRunning sets
// status+marker atomically; a dispatch failure clears the marker AND moves to `inactive`),
// so no steady-state `in_progress`+has_agent=0 lingers and re-running this is a no-op once
// converged.
export function migrateReadyRunningSplit(): void {
  // Re-bucket legacy READY rows — `in_progress` with NO owned agent — to `inactive` so the
  // dispatcher (which keys on `inactive`) picks them up instead of stranding them. Keyed
  // on has_agent (seeded from the legacy pane signal in ensureForwardColumns before the
  // pane column was dropped): equivalent to the old pane-IS-NULL test.
  db.exec(
    `UPDATE tasks SET status='inactive' WHERE status='in_progress' AND has_agent=0`,
  );
  db.exec(
    `UPDATE tasks SET status='in_review' WHERE status='finalizing'`,
  );
}

// UNIFIED-WORK ACTIVATION MIGRATION (story st-540ba705, step 6a — BACKWARD-SAFE +
// IDEMPOTENT). Make `tasks.parent_id` the AUTHORITATIVE parent pointer for the unified
// Work model (work.resolveWorkResponder) by (1) materializing each `stories` row as a Work
// NODE — a `tasks` row whose id IS the story id, the FK anchor a member's parent_id points
// at — and (2) backfilling every story member's parent_id from its story_id.
//
// BACKWARD-SAFE (the dev-runs-migrate-live-db hazard): this migration can run against the
// LIVE db (a gate/build importing db.ts) WHILE the OLD server is still running on old code,
// so it must not disturb that server. It is purely ADDITIVE — it INSERTs rows + sets the
// previously-inert parent_id column; it never DROPs/RENAMEs anything, and the `stories`
// table + `story_id` stay fully intact + authoritative (story state is still read via the
// stories table / storyView, and the /api/stories path is untouched until step 6d).
//
// The materialized node carries the story's REAL status (the B.3 dual-write shadow — story
// st-6372812d), NOT the old frozen `merged` anchor. NO loop acts on it because B.2 made every
// loop exclude nodes STRUCTURALLY via work_kind='leaf' (dispatcher/auto-merge/reaper/recovery)
// — node-exclusion no longer depends on the incidental terminal `merged`, so it is safe for the
// node to carry a live-looking status (open/merging/merge_blocked/done/aborted). Reads stay
// AUTHORITATIVE on the stories table this phase; the node row is the lock-step shadow the B.4
// read-flip will consult. isStoryComplete / storyCounts still key on story_id (the node's is
// NULL, so it is never counted as a member), and routing reads parent_id, never the parent row.
//
// IDEMPOTENT: INSERT OR IGNORE skips already-materialized nodes; the backfill is guarded by
// `parent_id IS NULL` (so it never clobbers a parent_id set by new code) and an FK-safe
// `story_id IN (SELECT id FROM tasks)` guard. Runs AFTER ensureForwardColumns (parent_id +
// the defaulted NOT NULL columns must exist) and the status folds.
export function migrateUnifyStoryParent(): void {
  // POST-DROP GUARD (REVAMP Phase B.5b, story st-78a8b4e7): once migrateDropStoriesMirror has
  // removed the `stories` table, its members' parent_id is already fully backfilled and every
  // story IS its node — so this backfill is dead and would throw on the missing table. Skip it,
  // keeping the whole boot pass green on a post-drop db.
  if (!tableExists(db, "stories")) return;
  // (1) Materialize each story as a Work node — id = story id, the FK anchor for members'
  // parent_id. id/workspace_id/created_at plus the story's REAL status (the B.3 dual-write
  // shadow — NOT the old frozen `merged` anchor) and the Phase B.1 node fields (work_kind='node'
  // + the node-only stories columns brief/isolated/pending_ask/ask_responder) are supplied so a
  // node carries its fold marker + node data the instant it materializes; every other NOT NULL
  // column carries a schema DEFAULT (kind='task', version_bump='patch', has_agent=0,
  // escalated_to_user=0, conflict=0, idle=0, …) so the projection is valid. Reads stay on the
  // stories table this phase; migrateBackfillNodeFold re-syncs (status + node fields) any node
  // already materialized by a PRIOR run (INSERT OR IGNORE skips those here).
  db.exec(
    `INSERT OR IGNORE INTO tasks
       (id, workspace_id, status, created_at, work_kind, brief, isolated, pending_ask, ask_responder)
       SELECT id, workspace_id, status, created_at, 'node', brief, isolated, pending_ask, ask_responder
         FROM stories`,
  );
  // (2) Backfill members' parent_id from story_id (the node now exists → FK-safe). Guarded so
  // a re-run, or a row whose new code already set parent_id, is left untouched.
  db.exec(
    `UPDATE tasks SET parent_id = story_id
       WHERE story_id IS NOT NULL AND parent_id IS NULL
         AND story_id IN (SELECT id FROM tasks)`,
  );
}

// WORK-UNIFICATION FOLD BACKFILL (REVAMP Phase B.1 → B.3 — story st-6372812d, ADDITIVE +
// IDEMPOTENT). Stamp the persisted node discriminator + mirror the node `stories` fields onto
// every materialized story Work node's OWN `tasks` row, so the row carries the data the fold
// (B.4) will later read instead of the separate `stories` table. B.3 adds the node's `status`
// to the copied set so the row is a FAITHFUL lock-step shadow of the story (no longer the frozen
// `merged` anchor). `stories.status` + getStoryRow stay AUTHORITATIVE for reads this step — the
// shadow is written but not yet read; B.4 flips the reads.
//
// Runs AFTER migrateUnifyStoryParent (which materializes the node rows this keys on) and the
// forward-column step (which adds work_kind + the four mirror columns). migrateUnifyStoryParent /
// ensureStoryWorkNode ALREADY stamp status + these fields at materialization time; this backfill
// is the belt for a node materialized by a PRIOR run (whose INSERT OR IGNORE predates this fold
// and so left work_kind at the 'leaf' DEFAULT + status at the old 'merged' anchor + the mirror
// columns unset).
//
// BACKWARD-SAFE (the dev-runs-migrate-live-db hazard): an additive UPDATE that copies from the
// authoritative `stories` table — it never DROPs/RENAMEs anything. Writing the real node status
// is safe even against a live server because B.2 (already shipped) made every loop exclude nodes
// via work_kind, so no loop acts on a node whatever its status. IDEMPOTENT: `stories` is the
// source of truth, so re-running re-copies identical values (work_kind='node' + the live status
// for every id that IS a story). Correlated subqueries mirror migrateUnifyStoryParent's style.
export function migrateBackfillNodeFold(): void {
  // POST-DROP GUARD (REVAMP Phase B.5b, story st-78a8b4e7): the node fold is already applied and
  // there is no `stories` table to re-copy from once migrateDropStoriesMirror has run — skip so
  // the boot pass stays green on a post-drop db.
  if (!tableExists(db, "stories")) return;
  db.exec(
    `UPDATE tasks SET
       work_kind='node',
       status       =(SELECT s.status        FROM stories s WHERE s.id=tasks.id),
       brief        =(SELECT s.brief         FROM stories s WHERE s.id=tasks.id),
       isolated     =(SELECT s.isolated      FROM stories s WHERE s.id=tasks.id),
       pending_ask  =(SELECT s.pending_ask   FROM stories s WHERE s.id=tasks.id),
       ask_responder=(SELECT s.ask_responder FROM stories s WHERE s.id=tasks.id)
     WHERE id IN (SELECT id FROM stories)`,
  );
}

/**
 * DEFENSIVE NO-OP existence belt for a story's Work NODE (the FK anchor a member's parent_id
 * points at). Kept — with its call sites intact — so the runtime story-membership writers
 * (createTask / assignTaskToStory / onStoryCreated) read the same as before.
 *
 * REVAMP Phase B.5b (story st-78a8b4e7): with the `stories` table DROPPED, the node's own
 * `tasks` row IS the authoritative story record and is materialized DIRECTLY at createStory
 * (stories.createStory), no longer projected lazily from `stories`. Every runtime caller
 * operates on a story that already exists (getStory 404s otherwise → its node is present), so
 * this is a no-op. It NEVER reads `stories` (which is gone) and NEVER throws — exactly the
 * FK-anchor safety it always provided, now that the node is created up front.
 */
export function ensureStoryWorkNode(_storyId: string): void {
  // Intentionally empty: the story NODE row is created eagerly by createStory and is the sole
  // source of truth post-B.5b. See the doc comment above.
}

// REVAMP-4 Phase 0 / S0a — CONTAINER (repo) node materialization (story st-1a82a2e1, ADDITIVE +
// INSERT-ONCE IDEMPOTENT). Materialize each registered repo as a `tasks` NODE in the SAME
// recursive Work tree, discriminated by work_kind='repo' — the foundation of the recursive
// PROJECT/CEO tier. This is the additive, zero-behavior first step: repos become in-tree nodes
// so a later phase can reparent stories under their repo and add a project tier above repos.
//
//   - id = the `directory` id VERBATIM (a `dir-…` id) so a repo node shares its id with its
//     `directory` row (e.g. dir-8b35f904). That shared id IS the link to the config sidecar —
//     the `directory` table STAYS the repo's 1:1 config record (gate_cmd/version_file/…); NOTHING
//     is moved or duplicated onto the tasks node and there is NO new FK column.
//   - workspace_id = the same id (self). tasks.workspace_id is NOT NULL and FK-references
//     directory(id); the repo's own directory row satisfies it, and ON DELETE CASCADE ties the
//     repo node's lifetime to its directory (unregister the repo → its node cascades away).
//   - status = 'merged' — the SAME stable, inert TERMINAL anchor a materialized story node
//     carries (mirrors migrateBackfillNodeFold), so no lifecycle loop ever acts on it. Combined
//     with work_kind='repo' it is doubly invisible: every leaf-only loop filters `work_kind='leaf'`
//     and the boot merged-sweep (recoverMergedTasks) only looks at `status='in_review' AND leaf`.
//   - created_at = the directory's own created_at (tasks.created_at is NOT NULL with no default).
//   - parent_id left NULL — no project tier yet (a LATER phase reparents). Every other NOT-NULL
//     column takes its schema DEFAULT (kind='task', has_agent=0, isolated=0, …) exactly as the
//     story-node INSERT (migrateUnifyStoryParent) relies on.
//
// INSERT OR IGNORE ⇒ insert-once: a re-run (or a repo whose node already exists) is a no-op.
// BACKWARD-SAFE (dev-runs-migrate-live-db hazard): a purely ADDITIVE insert into `tasks`; it
// never DROPs/RENAMEs/repoints anything, and B.2's structural node-exclusion means no live loop
// acts on the new rows. Runs LAST in the ordered pass (the converged idempotent position); it
// depends only on `directory` (always present post-baseline/rename), independent of the story
// folds. Presence-guarded implicitly — a fresh db with no directories inserts nothing.
export function migrateMaterializeRepoNodes(): void {
  db.exec(
    `INSERT OR IGNORE INTO tasks (id, workspace_id, status, created_at, work_kind)
       SELECT id, id, 'merged', created_at, 'repo'
         FROM directory`,
  );
}

// REPARENT TOP-LEVEL WORK UNDER ITS REPO NODE (story st-1a82a2e1 REVAMP-4 Phase 1 / S1). The
// foundation S0a laid down one work_kind='repo' node per directory (id == directory id) sitting
// parent_id NULL. This step repoints EVERY top-level unit of Work — a standalone leaf OR a story
// NODE (parent_id NULL, work_kind in ('leaf','node')) — so its parent_id points at its OWNING repo
// node (its workspace_id, which IS the repo node's id by S0a construction). The parent chain thus
// becomes leaf → story-node → repo-node; the recursive responder (work.resolveWorkResponder /
// workResponderChain) treats that repo ancestor's responder as {cto}, so ALL routing stays
// byte-identical — this migration changes DATA, not observable behavior.
//
//   - work_kind='repo' nodes KEEP parent_id NULL (they are the top of the tree until the project
//     tier arrives in Phase 3). The `work_kind IN ('leaf','node')` filter excludes them.
//   - workspace_id IN (SELECT id FROM tasks WHERE work_kind='repo') guards the repoint to rows
//     whose repo node actually exists — a defensive belt (S0a materializes one per directory, so
//     at real boot none are skipped; a fresh db with no repo nodes repoints nothing).
//
// IDEMPOTENT (re-run is a no-op): an already-repointed row has a NON-NULL parent_id, so the
// `parent_id IS NULL` filter excludes it — the UPDATE touches zero rows on a second pass.
// REVERSIBLE: the repoint is parent=repo ↔ NULL, fully recoverable — a repo-parented top-level
// row's owning repo is exactly its workspace_id (owningRepoOf), so `SET parent_id=NULL WHERE
// parent_id IN (SELECT id FROM tasks WHERE work_kind='repo')` undoes it losslessly.
// BACKWARD-SAFE ordering: runs AFTER migrateMaterializeRepoNodes (needs the repo nodes present);
// purely repoints existing `tasks` rows (no DROP/RENAME), and B.2's structural node-exclusion
// (`work_kind='leaf'` loops) means no live loop's membership changes from a repo parent.
export function migrateReparentTopLevelUnderRepo(): void {
  db.exec(
    `UPDATE tasks SET parent_id = workspace_id
       WHERE parent_id IS NULL
         AND work_kind IN ('leaf','node')
         AND workspace_id IN (SELECT id FROM tasks WHERE work_kind='repo')`,
  );
}

// ADOPT LOOSE REPOS UNDER A SINGLE DEFAULT PROJECT (story st-6560e4f3 Hierarchical Projects IA / S1).
// The Hierarchical Projects IA makes PROJECTS the top tier and forbids "loose" repos (a work_kind='repo'
// node sitting parent_id NULL, i.e. under no project). This ONE-TIME boot adoption seeds a single
// deterministic default project and reparents EVERY loose repo under it, so an existing single-repo
// install (0 projects, one loose repo) comes up with its repo already nested — no operator action.
//
// DETERMINISTIC + REPRODUCIBLE: the default project has the fixed id `DEFAULT_PROJECT_ID` and is
// anchored to `MIN(id)` of the loose repos (a repo node's id == its directory id — S0a — so this is a
// real directory / valid tasks.workspace_id FK, and the choice is stable across re-runs). It is the
// SAME inert shape createProject (workspaces.ts) mints: status='merged' (the stable terminal anchor no
// lifecycle loop acts on) + parent_id NULL (a project is the top of the tree).
//
// THREE ORDERED GUARDS (idempotent + reversible + non-coercive):
//   (a) the default project already exists → NO-OP. This is the idempotency + reversibility anchor: a
//       re-run of the boot pass never mints a SECOND default, and once the default exists a repo that
//       was deliberately unregistered (parent_id → NULL via unregisterRepoFromProject) is NOT silently
//       re-adopted on the next boot — the reversible unregister stays reversible.
//   (b) some repo already sits under SOME project (a user registered repos themselves) → NO-OP. Never
//       FORCE a default onto an install that already organizes its repos into project(s).
//   (c) no loose repos at all (incl. a fresh db with no directories) → NO-OP.
// Otherwise: INSERT the default project (INSERT OR IGNORE — belt for the guarded id) then
// `UPDATE ... SET parent_id=DEFAULT_PROJECT_ID WHERE work_kind='repo' AND parent_id IS NULL` to adopt
// every loose repo in one statement.
//
// BYTE-IDENTICAL WORK VIEWS: GET /api/work (work-api.listWork) EXCLUDES repo + project nodes, so a repo
// merely gaining a parent_id changes NO work list — this migration alters DATA (the inert repo-node
// parent pointer), not observable work/routing behavior. It never touches `directory` / worktrees /
// agents (all keyed on directory id, left intact). REVERSIBLE via unregisterRepoFromProject (→ NULL).
// BACKWARD-SAFE ordering: runs AFTER migrateMaterializeRepoNodes / migrateReparentTopLevelUnderRepo
// (needs the repo nodes present with their loose/parented state settled); purely reparents/inserts
// `tasks` rows (no DROP/RENAME).
export const DEFAULT_PROJECT_ID = "proj-default";
export function migrateAdoptLooseReposUnderDefaultProject(): void {
  // (a) a default project already exists → never mint a second / never re-adopt an unregistered repo.
  if (db.query(`SELECT 1 FROM tasks WHERE id=? AND work_kind='project'`).get(DEFAULT_PROJECT_ID)) return;
  // (b) some repo already sits under some project → the install organizes its own repos; don't coerce.
  const alreadyOrganized = db
    .query<{ n: number }, []>(
      `SELECT COUNT(*) AS n
         FROM tasks r JOIN tasks p ON p.id = r.parent_id AND p.work_kind='project'
        WHERE r.work_kind='repo'`,
    )
    .get()!.n;
  if (alreadyOrganized > 0) return;
  // (c) no loose repos (incl. a fresh db) → nothing to adopt.
  const anchor = db
    .query<{ id: string | null }, []>(
      `SELECT MIN(id) AS id FROM tasks WHERE work_kind='repo' AND parent_id IS NULL`,
    )
    .get()!.id;
  if (anchor == null) return;

  db.query(
    `INSERT OR IGNORE INTO tasks (id, workspace_id, status, created_at, work_kind, brief)
     VALUES (?, ?, 'merged', ?, 'project', 'Default project')`,
  ).run(DEFAULT_PROJECT_ID, anchor, nowIso());
  db.query(
    `UPDATE tasks SET parent_id=? WHERE work_kind='repo' AND parent_id IS NULL`,
  ).run(DEFAULT_PROJECT_ID);
}

// UNIFIED-WORKSPACE ACTIVATION MIGRATION (story st-540ba705, step 6b — BACKWARD-SAFE +
// IDEMPOTENT). Populate the unified `workspace` table from the two legacy operator-agent
// tables so the unified supervisor (src/workspace-agent.ts), activated this step, re-adopts
// EVERY live operator agent BY NAME at the CTO's deliberate restart — orphaning none:
//   - each `cto_agent` row → a `kind='cto'` workspace row (directory_id = its workspace_id,
//     work_id = NULL — a CTO is not bound to one unit of Work, RFC Q3/Q5);
//   - each `story_agent` row → a `kind='leader'` workspace row (work_id = its story_id,
//     directory_id = the story's workspace_id).
// `name` is left NULL precisely so workspaceAgentName() DERIVES the OLD herdr names verbatim
// (cto → `<prefix>-<directory_id>`, leader → `<prefix>-story-<work_id>`) — the Story D
// name-only identity — so a restart ADOPTS the live agent the old server launched rather than
// double-launching it. session_id/desired/started_at/restarts/last_error/herdr_workspace are
// carried so the session resumes with full context; `desired` is carried even for a stopped
// (desired=0) agent so the supervisor's honor-stop check is preserved (updated_at carried so
// that check, which requires updated_at, fires). has_agent is seeded = desired (a desired-up
// migrated agent is presumed live-and-owned; adopt re-affirms it).
//
// BUILD agents are deliberately NOT migrated: they live in `tasks` (per-task lifecycle +
// per-task watcher) and stay DISPATCHER-owned — routing them through the unified supervisor
// would DOUBLE-supervise them. The supervisor's kind='build' capability (step 3) is exercised
// by its own tests; live build supervision is a separate, larger change, out of scope for 6b.
//
// BACKWARD-SAFE (the dev-runs-migrate-live-db hazard): this can run against the LIVE db (a
// gate/build importing db.ts) WHILE the OLD server runs on old code, so it is purely ADDITIVE —
// it INSERTs into the previously-inert `workspace` table and never touches `cto_agent` /
// `story_agent` (their tables + rows stay fully intact, so the old server's cto/story
// supervisors keep working until the deliberate restart). It NEVER DROPs/RENAMEs anything.
// FK-safe: directory_id → workspaces(id); a leader's work_id → the materialized story Work node
// in tasks(id) (so this MUST run AFTER migrateUnifyStoryParent).
//
// FK-safe leader guard: the leader INSERT requires its work_id (= story_id) to resolve to a
// materialized story Work node in tasks(id). migrateUnifyStoryParent (which runs BEFORE this in
// the boot pass) materializes one per story, so at real boot none are skipped; the
// `WHERE sa.story_id IN (SELECT id FROM tasks)` guard (mirroring migrateUnifyStoryParent) is a
// defensive belt — a story_agent row whose node is somehow absent is SKIPPED rather than crashing
// the migration on the FK.
//
// IDEMPOTENT + INSERT-ONCE: a deterministic id (`ws-cto-<workspace_id>` / `ws-leader-<story_id>`)
// + INSERT OR IGNORE means a re-run skips an already-materialized row and NEVER clobbers it —
// so once the cutover restart flips the unified supervisor on and it begins writing the
// `workspace` row (session/desired/restarts), a later migration re-run can't overwrite that
// live state from the now-FROZEN legacy tables (mirrors migrateUnifyStoryParent's insert-once
// rule). The final hard removal of cto_agent/story_agent is a LATER post-restart release.
export function migrateWorkspaceAgentRows(): void {
  // POST-DROP GUARD (REVAMP Phase B.5b, story st-78a8b4e7): the leader INSERT (2) JOINs the
  // dropped `stories` table, so once migrateDropStoriesMirror has run this whole step is dead
  // (the unified `workspace` rows are already materialized + insert-once) and would throw on the
  // missing table. Skip so the boot pass stays green on a post-drop db.
  if (!tableExists(db, "stories")) return;
  const now = nowIso();
  // (1) Each CTO agent → a kind='cto' workspace row (no Work binding).
  db.query(
    `INSERT OR IGNORE INTO workspace
       (id, name, kind, directory_id, work_id, session_id, desired, started_at,
        restarts, last_error, has_agent, herdr_workspace, created_at, updated_at)
     SELECT 'ws-cto-' || workspace_id, NULL, 'cto', workspace_id, NULL,
            session_id, desired, started_at, restarts, last_error,
            desired, herdr_workspace, ?, updated_at
       FROM cto_agent`,
  ).run(now);
  // (2) Each story LEADER → a kind='leader' workspace row bound to its story Work node. The
  // JOIN to stories yields the directory_id (the story's workspace) and guarantees the story
  // (hence its materialized tasks node, FK target of work_id) still exists.
  db.query(
    `INSERT OR IGNORE INTO workspace
       (id, name, kind, directory_id, work_id, session_id, desired, started_at,
        restarts, last_error, has_agent, herdr_workspace, created_at, updated_at)
     SELECT 'ws-leader-' || sa.story_id, NULL, 'leader', s.workspace_id, sa.story_id,
            sa.session_id, sa.desired, sa.started_at, sa.restarts, sa.last_error,
            sa.desired, sa.herdr_workspace, ?, sa.updated_at
       FROM story_agent sa JOIN stories s ON s.id = sa.story_id
       WHERE sa.story_id IN (SELECT id FROM tasks)`,
  ).run(now);
}

// STORIES-MIRROR DESTRUCTIVE FLIP (REVAMP Phase B.5b, story st-78a8b4e7). The keystone that
// finishes the Work-unification fold: the story NODE's own `tasks` row is already the
// authoritative story record (B.4 flipped every read; B.3 kept the mirror in lock-step), so the
// legacy `stories` table + `tasks.story_id` column are now pure dead weight. This drops them.
//
// story_agent is NOT dropped here (descoped to Phase C — it still has LIVE readers/writers:
// onStoryCreated/stopStoryAgent write it, storyAgentStatus reads
// it via storyView → GET /api/work). But story_agent.story_id FK-references stories(id) — the
// ONLY remaining FK to `stories` — so we first REBUILD story_agent to re-point that FK at
// tasks(id) ON DELETE CASCADE (the story node), preserving its cascade cleanup (deleteStory
// DELETEs the tasks node → cascades the story_agent row) while unblocking the `stories` drop
// without touching a single live caller.
//
// IDEMPOTENT: guarded on `stories` still existing, so it is a clean no-op once converged and the
// whole boot pass is GREEN on both a pre-drop and a post-drop db. The three stories-sourcing
// migrations above (migrateUnifyStoryParent / migrateBackfillNodeFold / migrateWorkspaceAgentRows)
// carry the same guard, so they no-op post-drop rather than throwing on the missing table.
//
// FK DISCIPLINE: SQLite cannot rebuild a table / drop an FK-referenced parent cleanly with
// foreign_keys ON, so the destructive block runs under `PRAGMA foreign_keys = OFF` — the standard
// table-rebuild procedure — with a `foreign_key_check` afterward (throwing on any violation)
// before restoring `PRAGMA foreign_keys = ON`. runMigrations is not wrapped in a transaction, so
// the pragma toggle takes effect (it is a no-op inside a transaction).
//
// COMPAT-VIEW RE-PARSE HAZARD: the `workspaces` back-compat VIEW + its INSTEAD OF triggers
// (migrateWorkspacesView) reference directory columns as `NEW.label`, `NEW.path`, … Every
// `ALTER TABLE` in this block (the story_agent RENAME, the tasks.story_id DROP COLUMN) makes
// SQLite RE-PARSE all dependent schema objects — and on some legacy schemas that re-parse of the
// unrelated compat trigger throws (`no such column: NEW.label` / `SQL logic error`). So we DROP
// the view + its triggers for the duration of the table surgery and RECREATE them (idempotently,
// via migrateWorkspacesView) afterward — nothing reads `workspaces` mid-migration.
export function migrateDropStoriesMirror(): void {
  if (!tableExists(db, "stories")) return; // converged already — no-op

  db.exec("PRAGMA foreign_keys = OFF;");
  // ROOT-CAUSE FIX (REVAMP-2 B.5b incident): with legacy_alter_table OFF (SQLite's default), an
  // `ALTER TABLE … RENAME`/`DROP COLUMN` REWRITES every view/trigger that references the touched
  // table — which, in the live flip, MATERIALIZED the `workspaces` back-compat VIEW into a TABLE,
  // so the next boot's migrateWorkspacesView `DROP VIEW` threw and crash-looped. Turn legacy mode
  // ON for the duration of the rebuilds so ALTER only touches the renamed table itself and never
  // rewrites/materializes the `workspaces` view. Restored in `finally`.
  db.exec("PRAGMA legacy_alter_table = ON;");
  // Remove the compat view + triggers so no ALTER below re-parses them (recreated in `finally`).
  db.exec(`DROP TRIGGER IF EXISTS workspaces_view_insert`);
  db.exec(`DROP TRIGGER IF EXISTS workspaces_view_update`);
  db.exec(`DROP TRIGGER IF EXISTS workspaces_view_delete`);
  db.exec(`DROP VIEW IF EXISTS workspaces`);
  try {
    // (1) Rebuild story_agent, re-pointing its FK stories(id) → tasks(id) ON DELETE CASCADE (the
    // materialized story node). Column set is byte-identical to migrateStoryAgentTable. Copy only
    // rows whose story_id resolves to a node (FK-safe under the new reference); a story_agent row
    // exists only for a live story, each of which has a node, so none is legitimately dropped.
    db.exec(`
      CREATE TABLE story_agent_new (
        story_id        TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        session_id      TEXT,
        herdr_workspace TEXT,
        desired         INTEGER NOT NULL DEFAULT 0,
        started_at      TEXT,
        restarts        INTEGER NOT NULL DEFAULT 0,
        last_error      TEXT,
        updated_at      TEXT
      );
    `);
    db.exec(
      `INSERT INTO story_agent_new
         (story_id, session_id, herdr_workspace, desired, started_at, restarts, last_error, updated_at)
       SELECT story_id, session_id, herdr_workspace, desired, started_at, restarts, last_error, updated_at
         FROM story_agent WHERE story_id IN (SELECT id FROM tasks)`,
    );
    db.exec(`DROP TABLE story_agent`);
    db.exec(`ALTER TABLE story_agent_new RENAME TO story_agent`);

    // (2) Drop the now-dead legacy membership column (parent_id carries every value in lock-step).
    dropColumnIfExists("tasks", "story_id");

    // (3) Drop the legacy mirror table — nothing references it any more (story_agent re-pointed).
    db.exec(`DROP TABLE IF EXISTS stories`);

    // Prove referential integrity survived the rebuild before re-enabling enforcement.
    const violations = db.query<{ table: string }, []>(`PRAGMA foreign_key_check`).all();
    if (violations.length > 0) {
      throw new Error(
        `migrateDropStoriesMirror: foreign_key_check found ${violations.length} violation(s): ${JSON.stringify(violations)}`,
      );
    }
  } finally {
    // Recreate the `workspaces` compat view + triggers (idempotent DROP+CREATE) and restore FKs.
    migrateWorkspacesView(db);
    db.exec("PRAGMA legacy_alter_table = OFF;");
    db.exec("PRAGMA foreign_keys = ON;");
  }
}

// REVAMP-4 Phase 0 / S0c — WIDEN the `workspace.kind` CHECK to admit the new supervisor tier
// kind 'ceo' (story st-1a82a2e1). SQLite cannot ALTER a column CHECK in place, so this is a
// TABLE REBUILD following migrateDropStoriesMirror's sanctioned procedure EXACTLY. The baseline
// migrateWorkspaceTable CREATE was widened in lockstep, so a FRESH db is born with the widened
// CHECK and this step is a clean no-op there; only an EXISTING db (created with the narrow
// 3-kind CHECK) is rebuilt. ADDITIVE + ZERO-BEHAVIOR: it does not add/drop/rename a column,
// only relaxes the CHECK; no ceo row is created (Phase 3 owns the CEO surface).
//
// IDEMPOTENT: guarded on the live `workspace` CREATE SQL NOT already containing 'ceo', so it is a
// clean no-op once converged (fresh db) or after its one-shot rebuild (existing db) — the whole
// boot pass stays GREEN on a pre- and a post-widen db.
//
// B.5b REGRESSION GUARD (the crash-loop where a failed rebuild MATERIALIZED the `workspaces`
// back-compat VIEW into a TABLE and crash-looped boot): the exact belt-and-suspenders
// migrateDropStoriesMirror uses is baked in UNCONDITIONALLY — the rebuild runs under
// `PRAGMA legacy_alter_table = ON` (so the DROP/RENAME never re-parses/rewrites a dependent
// view/trigger) AND the `workspaces` compat view + its INSTEAD OF triggers are DROPPED for the
// duration of the surgery and RECREATED (idempotently, via migrateWorkspacesView) in `finally`,
// so a re-parse can never touch them. `foreign_keys` is OFF during the rebuild with a
// `foreign_key_check` afterward, then restored. runMigrations is not wrapped in a transaction,
// so the pragma toggles take effect.
//
// SCHEMA-FAITHFUL REBUILD: the new-table DDL is DERIVED from the LIVE `workspace` CREATE SQL by
// string-substitution (widen the CHECK; rename the table to `workspace_new`) rather than a
// hardcoded copy. This is deliberate — the live schema is NOT the baseline migrateWorkspaceTable
// text: the rename migration (migrateRenameWorkspacesToDirectory) REPOINTED workspace.directory_id
// from `workspaces` → `directory`, and ensureForwardColumns APPENDED `gave_up` + `idle_escalated_at`.
// Deriving from the live SQL reproduces the EXACT current column set AND foreign-key targets, so a
// hardcoded copy can neither drop a future column nor mis-point the FK (a mis-pointed FK to the now-
// VIEW `workspaces` is exactly what a naive baseline copy would do — and foreign_key_check would
// reject). The INSERT column list is likewise read live from PRAGMA table_info.
export function migrateWidenWorkspaceKindCheck(): void {
  const cur = db
    .query<{ sql: string }, []>(`SELECT sql FROM sqlite_master WHERE type='table' AND name='workspace'`)
    .get();
  if (!cur) return; // no table yet (pre-baseline) — nothing to widen
  if (cur.sql.includes("'ceo'")) return; // already widened — clean no-op

  // Widen the narrow kind CHECK in the live DDL; fail LOUDLY if the expected clause is absent (an
  // unrecognized schema shape must never silently no-op nor half-rebuild).
  const widened = cur.sql.replace(
    "kind IN ('cto','leader','build')",
    "kind IN ('cto','leader','build','ceo')",
  );
  if (widened === cur.sql) {
    throw new Error(
      `migrateWidenWorkspaceKindCheck: narrow kind CHECK not found in live workspace schema — ` +
        `refusing to rebuild. Live SQL: ${cur.sql}`,
    );
  }
  const createNew = widened.replace(/CREATE TABLE\s+"?workspace"?/, "CREATE TABLE workspace_new");
  const cols = db
    .query<{ name: string }, []>(`PRAGMA table_info(workspace)`)
    .all()
    .map((r) => r.name)
    .join(", ");

  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec("PRAGMA legacy_alter_table = ON;");
  db.exec(`DROP TRIGGER IF EXISTS workspaces_view_insert`);
  db.exec(`DROP TRIGGER IF EXISTS workspaces_view_update`);
  db.exec(`DROP TRIGGER IF EXISTS workspaces_view_delete`);
  db.exec(`DROP VIEW IF EXISTS workspaces`);
  try {
    db.exec(createNew);
    db.exec(`INSERT INTO workspace_new (${cols}) SELECT ${cols} FROM workspace`);
    db.exec(`DROP TABLE workspace`);
    db.exec(`ALTER TABLE workspace_new RENAME TO workspace`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_workspace_dir  ON workspace(directory_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_workspace_work ON workspace(work_id)`);

    const violations = db.query<{ table: string }, []>(`PRAGMA foreign_key_check`).all();
    if (violations.length > 0) {
      throw new Error(
        `migrateWidenWorkspaceKindCheck: foreign_key_check found ${violations.length} violation(s): ${JSON.stringify(violations)}`,
      );
    }
  } finally {
    migrateWorkspacesView(db);
    db.exec("PRAGMA legacy_alter_table = OFF;");
    db.exec("PRAGMA foreign_keys = ON;");
  }
}

// ---- BOOT MIGRATION RUNNER -------------------------------------------------
// The ONE ordered list of boot-time schema steps, run by the single loop below.
// ORDER IS LOAD-BEARING and was previously only documented in the comments on each
// step — here it is EXECUTABLE. The sequence reproduces the historical top-to-bottom
// order exactly:
//   1. rename directories→workspaces   (MUST precede the baseline so an existing DB
//                                        is renamed in place, not recreated empty)
//   2. baseline schema                  (CREATE TABLE/INDEX IF NOT EXISTS)
//   3. per-workspace cto_agent table    (drop old singleton shape, then CREATE)
//   3b. per-story story_agent table      (CREATE IF NOT EXISTS — after the baseline so
//                                         its `stories` FK target exists; brand-new, no
//                                         legacy shape to drop)
//   3c. unified `workspace` table         (CREATE IF NOT EXISTS — after the baseline so its
//                                         `workspaces`/`tasks` FK targets exist; brand-new,
//                                         no legacy shape to drop; inert — nothing reads it)
//   3d. rename workspaces→directory       (st-540ba705 step 6c — guarded ALTER … RENAME, the
//                                         INVERSE of step 1's directory-VIEW-over-workspaces.
//                                         MUST run AFTER the cto_agent/story_agent/`workspace`
//                                         tables (so the rename rewrites their child FKs →
//                                         directory) and BEFORE step 4 (so the additive ALTERs
//                                         target the real `directory` table). The matching
//                                         `workspaces` writable VIEW is step 8.)
//   4. additive forward columns         (ensureColumn ×N on `directory` + retired-column drops —
//                                        must precede the folds; this is also where the
//                                        has_agent seed-then-drop name-only cutover runs,
//                                        so readyRunningSplit can key purely on has_agent)
//   5. fold out the retracted `stage` axis
//   6. fold the pre-canonical status set into the 12-state model
//   7. ready/running split + finalizing rescue
//   7b. unify story→parent_id (st-540ba705 step 6a) — materialize each story as a Work node +
//                                         backfill members' parent_id from story_id; backward-
//                                         safe + idempotent. After the status folds so the node
//                                         lands as a canonical `merged` row.
//   7c. populate `workspace` from cto_agent + story_agent (st-540ba705 step 6b) — one cto/leader
//                                         workspace row per legacy operator-agent row so the
//                                         unified supervisor re-adopts each BY NAME at restart.
//                                         AFTER 7b so a leader's work_id → the materialized story
//                                         Work node is FK-safe; backward-safe (legacy tables left
//                                         intact) + insert-once idempotent.
//   8. `workspaces` writable view        (st-540ba705 step 6c — DROP+CREATE VIEW over `directory`
//                                         + INSTEAD OF write triggers — runs LAST so the view
//                                         mirrors the FULL `directory` column set after step 4;
//                                         the back-compat surface for the running OLD server.)
//   9. drop the `stories` mirror          (st-78a8b4e7 REVAMP Phase B.5b — the DESTRUCTIVE FLIP:
//                                         rebuild story_agent off the stories FK, drop
//                                         tasks.story_id, DROP TABLE stories. Runs LAST, AFTER the
//                                         stories-sourcing folds (7b/7c) have applied; those carry
//                                         a tableExists('stories') guard so the pass stays green
//                                         once this has converged. STAGED — the live flip is HELD.)
//  10. materialize repo NODES             (st-1a82a2e1 REVAMP-4 Phase 0 / S0a — one work_kind='repo'
//                                         `tasks` node per `directory` row, id == directory id.
//                                         ADDITIVE + INSERT-ONCE idempotent; the foundation of the
//                                         recursive PROJECT/CEO tier. Runs LAST — depends only on
//                                         `directory`, independent of the story folds.)
//  11. widen workspace.kind CHECK          (st-1a82a2e1 REVAMP-4 Phase 0 / S0c — admit the 'ceo'
//                                         supervisor kind via a CHECK-widening table REBUILD
//                                         following migrateDropStoriesMirror's procedure. ADDITIVE
//                                         + idempotent (no-op once the CHECK contains 'ceo'); no
//                                         ceo row created. Runs LAST — depends only on `workspace`.)
// Every step is independently idempotent (presence-guarded ALTER/UPDATE/RENAME, IF NOT EXISTS,
// or DROP-then-CREATE of a data-less view), so the whole pass is a no-op once converged and
// safe to re-run on every boot.
const MIGRATIONS: Array<() => void> = [
  () => migrateDirectoriesToWorkspaces(db),
  createBaselineSchema,
  migrateCtoAgentPerWorkspace,
  migrateStoryAgentTable,
  migrateWorkspaceTable,
  () => migrateRenameWorkspacesToDirectory(db),
  ensureForwardColumns,
  migrateStageAxisToStatus,
  migrateStatusModel,
  migrateReadyRunningSplit,
  migrateUnifyStoryParent,
  migrateBackfillNodeFold,
  migrateWorkspaceAgentRows,
  () => migrateWorkspacesView(db),
  migrateDropStoriesMirror,
  migrateMaterializeRepoNodes,
  migrateReparentTopLevelUnderRepo,
  migrateWidenWorkspaceKindCheck,
  migrateAdoptLooseReposUnderDefaultProject,
];

/**
 * LAST-BOOT MIGRATION OUTCOME — the snapshot the read-only /api/health surfaces so an
 * operator can confirm the boot migration pass ran cleanly in ONE pull instead of
 * grepping the journal. `at` is when the last pass finished (null before the first
 * run); `ran` is how many of the ordered steps executed; `ok` is true iff the whole
 * pass completed without throwing; `error` names the failing step + message when a
 * migration threw. On a successfully BOOTED server `ok` is always true (a thrown
 * migration aborts boot — see runMigrations), so the value's worth is the timestamp +
 * step count confirming the pass converged this boot.
 */
export type MigrationOutcome = {
  at: string | null;
  ran: number;
  ok: boolean;
  error: { step: number; message: string } | null;
};

let lastMigrationOutcome: MigrationOutcome = { at: null, ran: 0, ok: false, error: null };

/** The last-boot migration outcome snapshot (see MigrationOutcome). Read-only; safe pre-run (returns the unset default). */
export function getLastMigrationOutcome(): MigrationOutcome {
  return lastMigrationOutcome;
}

/**
 * Run the ordered boot migrations once, in order, against the module DB. Invoked
 * at module load; also exported so a test can re-run the full pass and assert it is
 * a clean idempotent no-op (every step is presence-guarded / IF NOT EXISTS).
 *
 * Records the pass outcome into lastMigrationOutcome (getLastMigrationOutcome) for the
 * /api/health migration block — pure instrumentation. A throwing migration records the
 * failure (which step + message) and then RE-THROWS, preserving the existing
 * crash-on-failed-migration boot behavior.
 */
export function runMigrations(): void {
  let ran = 0;
  for (let i = 0; i < MIGRATIONS.length; i++) {
    try {
      MIGRATIONS[i]!();
      ran++;
    } catch (e) {
      lastMigrationOutcome = {
        at: nowIso(),
        ran,
        ok: false,
        error: { step: i, message: (e as Error).message },
      };
      throw e;
    }
  }
  lastMigrationOutcome = { at: nowIso(), ran, ok: true, error: null };
}
runMigrations();

export type WorkspaceRow = {
  id: string;
  path: string;
  label: string | null;
  herdr_workspace: string | null;
  herdr_pane: string | null;
  // Per-workspace build/test gate command (see the ensureColumn above). NULL = use
  // the default (config.verifyCmd); a non-null value (incl. "" to disable) is used
  // verbatim by both the CI gate and the post-merge verify gate for this workspace.
  gate_cmd: string | null;
  // Per-workspace OPTIONAL version file (see the version_file ensureColumn above). NULL
  // = inherit the global default (config.versionFile, EMPTY/off by default); "" disables
  // the merge-time version bump for this workspace; a path is patch-bumped at merge.
  version_file: string | null;
  // Per-workspace OPTIONAL changelog-gate path (see the changelog_path ensureColumn
  // above). NULL = inherit the global default (config.changelogPath, EMPTY/off by
  // default); "" disables the changelog gate for this workspace; a path is the file the
  // CI gate requires a code change to update.
  changelog_path: string | null;
  // Per-workspace CTO-agent enable (see the cto_enabled ensureColumn above). NULL =
  // inherit the global default config.ctoAgentEnabled; 1 = on; 0 = off. Resolved by
  // workspaces.isCtoEnabled (per-workspace WINS over the global default).
  cto_enabled: number | null;
  // Per-workspace VERSIONED-RELEASES MODE (see the release_mode ensureColumn above): 1 =
  // every merge bumps + stamps the changelog with a versioned heading and the changelog
  // gate is strict; 0 (default) = today's opt-in patch-bump behavior. Resolved by
  // workspaces.workspaceReleaseMode.
  release_mode: number;
  // Per-workspace 3-LEVEL BRANCH-ISOLATION guard (see the branch_isolation ensureColumn
  // above): 1 = stories opened after the flag is set are isolated (own branch; subtasks
  // merge into the story branch; re-gate + merge to the default branch on completion);
  // 0 (default) = today's behavior. LIVE but guarded per story; OFF by default (CONTRIBUTING §11).
  branch_isolation: number;
  created_at: string;
};

// A task's KIND: an ordinary work task, or a ROLLBACK task (built from the `rollback`
// template) whose job is to revert a merged change — it runs the normal build/review
// pipeline but lands as `rolled_back` (terminal) via its own `rolling_back` merge state
// instead of `merged` (see tasks.finalizeMerge). The old 'plan' kind was retired (see
// the `kind` column comment above).
export type TaskKind = "task" | "rollback";

// A STORY's lifecycle status (see the `stories` table above). The three OPERATOR-set
// values: `open` (the default) — the story is active and accepting subtasks; `done` — its
// work is complete (for an ISOLATED story this means its branch LANDED on the default
// branch and the post-merge verify was green — §11.7); `aborted` — it was cancelled. The
// two remaining values are BUTCHR-OWNED and transient, used ONLY on an isolated story's
// completion path (CONTRIBUTING §11.7, Phase E) — never set directly via PATCH:
//   - `merging`       — completion was requested; the story-level re-gate + story→main
//                       merge are in flight (transient, serialized through the global merge
//                       queue, restart-recoverable — re-driven on boot like a rolling_back
//                       task). The leader is kept UP.
//   - `merge_blocked` — the re-gate came back RED, or the story↔main merge hit a conflict:
//                       the story did NOT land, the default branch is untouched, an
//                       escalation fired. A visible merge-failed surface, NOT `done`. The
//                       leader is kept UP to re-attempt (fix a RED via more subtasks, or a
//                       CTO/human resolves a conflict, then re-request → `merging`).
// A non-isolated story only ever uses open/done/aborted (its PATCH-`done` is immediate).
export type StoryStatus = "open" | "merging" | "merge_blocked" | "done" | "aborted";

// A STORY row (see the `stories` table above): a CONTAINER grouping member tasks (which
// carry a nullable story_id FK). Phase 1 is data-model only — fully inert; later phases
// add the story-leader agent + escalation chain. See src/stories.ts for the CRUD service.
export type StoryRow = {
  id: string;
  workspace_id: string;
  // The story's goal/description.
  brief: string | null;
  status: StoryStatus;
  // PER-STORY ISOLATION BIT (see the isolated ensureColumn above): 1 = isolated (own
  // branch; subtasks merge into the story branch), 0 (default) = standalone (subtasks
  // merge straight to the default branch). Captured ONCE at createStory from the
  // workspace branch_isolation flag, NOT the live flag. LIVE (CONTRIBUTING §11.8).
  isolated: number;
  // RESPONDER-REDESIGN (story st-def561dd — see the pending_ask/ask_responder ensureColumns
  // above): a story LEADER's open STORY-LEVEL ask to the CTO. `pending_ask` is the question
  // text (NULL when none); `ask_responder` is who owns it — 'cto' | 'user' — or NULL when no
  // ask is open. Set/cleared by the story /ask, /escalate, /answer endpoints; surfaced on
  // StoryView via the `...story` spread (no extra plumbing).
  pending_ask: string | null;
  ask_responder: string | null;
  // STORY-LEVEL MERGE-RANGE shas (see the merge_base_sha/merged_sha ensureColumns above):
  // the default-branch tips bracketing the whole story's commit range, set ONLY when an
  // isolated story's branch LANDS on the default branch (§11.6, Phase E). NULL otherwise.
  merge_base_sha: string | null;
  merged_sha: string | null;
  created_at: string;
};

// ===========================================================================
// CANONICAL story-NODE READ ACCESSORS (REVAMP Phase A seam — story st-26a5c2e1;
// FLIPPED to the tasks node row in Phase B.4 — story st-6372812d)
// ===========================================================================
// The SINGLE seam through which the rest of the codebase reads a story row BY ID.
// They live HERE (not stories.ts) on purpose: db.ts is the cycle-free low-level
// module that tasks.ts / workspace-agent.ts / reaper.ts already
// import, so routing their previously-inline `SELECT ... WHERE id=?` reads through
// these adds NO new import edge (importing stories.ts back into those modules would
// close the tasks↔stories cycle the inline SQL was written to dodge).
//
// PHASE B.4 READ-FLIP: as of B.4 these read the node's OWN `tasks` row (guarded on
// work_kind='node') — the node is now AUTHORITATIVE from its own row. The `stories`
// table remains only as the B.3 dual-write MIRROR (setStoryStatus still writes it)
// until it is dropped in B.5. Because the mirror is kept in lock-step, the flip is
// behavior-identical, and it is REVERSIBLE by swapping the source back to `stories`
// in these bodies. They still decide NOTHING about story_id vs parent_id (linkage
// stays the workParentId seam in work.ts) and add NO fallback.

/** A story's raw `status` by id, or null if no such story NODE exists. The single
 *  scalar status read — node-terminality (workspace-agent.nodeWorkIsTerminal) and a
 *  member's parent-story status (tasks.parentStoryStatus) both route through here.
 *
 *  REVAMP Phase B.4 (story st-6372812d): reads the node's OWN `tasks` row (the
 *  authoritative source post-flip), NOT the `stories` mirror. The `work_kind='node'`
 *  guard preserves the pre-flip contract — a non-node id (a leaf task, or an id that
 *  is no story) resolves to null, exactly as `SELECT ... FROM stories WHERE id=?` did.
 *  B.3's dual-write keeps tasks==stories, so this is behavior-identical; reversible by
 *  swapping the source back. The `stories` table stays (mirror) until B.5. */
export function storyStatusOf(id: string): string | null {
  return (
    db
      .query<{ status: string }, [string]>(
        `SELECT status FROM tasks WHERE id=? AND work_kind='node'`,
      )
      .get(id)?.status ?? null
  );
}

/** A full story row by id, or null if no such story NODE exists. The single by-id
 *  full-row read; callers that need only one column read it off the returned row.
 *
 *  REVAMP Phase B.4 (story st-6372812d): constructs the StoryRow from the node's OWN
 *  `tasks` row (authoritative post-flip), NOT the `stories` mirror. An EXPLICIT column
 *  list (NOT `SELECT *`, which on `tasks` carries dozens of extra columns) yields the
 *  byte-identical StoryRow shape every consumer expects; the `work_kind='node'` guard
 *  preserves "null for a non-node id". All ten StoryRow columns live on `tasks` (B.1
 *  added brief/isolated/pending_ask/ask_responder; the rest predate it). B.3's
 *  dual-write keeps the values identical to the `stories` row; reversible. */
export function getStoryRow(id: string): StoryRow | null {
  return (
    db
      .query<StoryRow, [string]>(
        `SELECT id, workspace_id, brief, status, isolated, pending_ask, ask_responder,
                merge_base_sha, merged_sha, created_at
           FROM tasks WHERE id=? AND work_kind='node'`,
      )
      .get(id) ?? null
  );
}

// ===========================================================================
// THE CANONICAL TASK STATE MACHINE (the CEO's exact model).
// ===========================================================================
// Every task is in exactly one of TWELVE states. Each state has a KIND — one of three
// kinds — and an AGENT state additionally has a TYPE (which agent runs it):
//
//   KIND      meaning
//   --------  ----------------------------------------------------------------
//   idle      no agent is running and butchr awaits nothing from the operator —
//             the task is either terminal or waiting on something mechanical.
//   agent     an agent is (or is about to be) running for this task.
//   feedback  butchr has surfaced an ARTIFACT and is awaiting an OPERATOR response.
//
//   AGENT TYPE     which agent
//   -------------  -------------------------------------------------------------
//   workspace-agent the interactive agent that builds the code in the worktree.
//
// THE 12 STATES (happy path: idea → spec_review → inactive → in_progress → in_review →
// (approve) merged; needs_info is an ad-hoc feedback stage ANY agent state can enter
// and then resume):
//
//   idea         feedback (brief)     — a one-line brief AWAITING a spec. butchr does NOT
//                                       run an agent: it pushes a `spec requested` channel
//                                       event and waits for the spec-generation responder
//                                       (the CTO agent, or a human in the webapp) to submit
//                                       the spec via POST /api/tasks/:id/spec → spec_review.
//   spec_review  feedback (spec)      — operator approves → inactive, or requests
//                                       changes → revise the spec (back to idea).
//   blocked      idle                 — waiting on blocked_by dependencies.
//   needs_info   feedback (question)  — an agent asked the operator a question; on
//                                       /answer the agent resumes (→ inactive → dispatch).
//   inactive     agent/workspace-agent— READY: a build task queued for the dispatcher,
//                                       no live agent yet. The dispatcher launches its
//                                       workspace agent and flips it to in_progress.
//   in_progress  agent/workspace-agent— a LIVE workspace agent is building the code.
//   in_review    feedback (diff)      — operator approves → MECHANICAL MERGE (no agent:
//                                       rebase → gate → merge → merged; a conflict
//                                       bounces back to inactive for the same agent to
//                                       resolve in-context), or requests changes →
//                                       resume the workspace agent (→ inactive).
//   merged       idle (terminal)      — landed on the default branch.
//   rolling_back idle (mechanical)     — a ROLLBACK task (built from the `rollback`
//                                       template) whose revert is being mechanically
//                                       merged (no agent runs); lands as rolled_back.
//                                       Happens AFTER something is merged.
//   rolled_back  idle (terminal)      — a rollback task's revert landed on the default
//                                       branch (the rollback equivalent of `merged`).
//   failed       idle (terminal)      — an EXECUTION/dispatch failure: a dispatch
//                                       give-up, or a post-merge verify revert.
//                                       (NOT operator-initiated — see `aborted`.)
//   aborted      idle (terminal)      — DELIBERATELY cancelled by the operator. Reserved
//                                       strictly for operator cancel; failures use `failed`.
//
// NOTE on the ready-vs-running distinction: it is carried by the STATUS itself —
// `inactive` is READY (the dispatcher (re-)launches its agent) and `in_progress` is a
// LIVE agent. markRunning flips inactive→in_progress atomically with recording the
// pane; a dispatch failure / resume clears the pane AND moves back to `inactive`. So a
// running `in_progress` ALWAYS has a pane and a ready `inactive` never does. This is
// restart-safe (status + pane are persisted) and is the single signal the
// dispatcher/reconcile/watcher key off.
export type TaskStatus =
  | "idea"
  | "spec_review"
  | "blocked"
  | "needs_info"
  // A CEO DIRECTIVE (RFC Q1 directive machinery) — a leaf parented under a REPO node awaiting
  // that repo's CTO to ACCEPT&DECOMPOSE it into stories (acceptDirective → `accepted`) or push it
  // back up the ladder (escalate). A FEEDBACK state: no agent runs, it surfaces on the CTO channel
  // (ATTENTION_STATES) and resolves to the repo's CTO via the existing structural responder.
  | "directive"
  | "inactive"
  | "in_progress"
  | "in_review"
  | "merged"
  | "rolling_back"
  | "rolled_back"
  | "failed"
  | "aborted"
  // A directive the CTO has ACCEPTED — its stories were created (acceptDirective), so the
  // directive itself is DONE. A TERMINAL, idle state (like merged/rolled_back): no agent, no
  // attention, nothing to review.
  | "accepted";

/** The three kinds of state. */
export type StateKind = "idle" | "agent" | "feedback";
/** Which agent runs an `agent`-kind state. (Only the workspace agent runs tasks now —
 * `idea` no longer forks a spec-writing agent; it WAITS for a responder's spec.) */
export type AgentType = "workspace-agent";
/** A state's category: its kind, and (for agent states) which agent runs it. */
export type StateMeta = { kind: StateKind; agentType?: AgentType };

/**
 * The single source of truth categorizing each canonical state — its KIND, and for
 * AGENT states the agent TYPE. Logic (dispatcher/reconcile/feedback) and the UI both
 * derive their behavior from this map rather than hard-coding status lists, so the
 * kind / agent-type model has exactly ONE definition.
 */
export const STATE_META: Record<TaskStatus, StateMeta> = {
  idea: { kind: "feedback" },
  spec_review: { kind: "feedback" },
  blocked: { kind: "idle" },
  needs_info: { kind: "feedback" },
  // A CEO directive awaits its repo's CTO — a feedback state, no agent (RFC Q1 directive machinery).
  directive: { kind: "feedback" },
  inactive: { kind: "agent", agentType: "workspace-agent" },
  in_progress: { kind: "agent", agentType: "workspace-agent" },
  in_review: { kind: "feedback" },
  merged: { kind: "idle" },
  rolling_back: { kind: "idle" },
  rolled_back: { kind: "idle" },
  failed: { kind: "idle" },
  aborted: { kind: "idle" },
  // A CTO-accepted directive is terminal + idle — its work now lives in the stories it spawned.
  accepted: { kind: "idle" },
};

/** Every canonical status (stable order: roughly the happy-path order). */
export const ALL_STATUSES: TaskStatus[] = [
  "idea",
  "spec_review",
  "blocked",
  "needs_info",
  "directive",
  "inactive",
  "in_progress",
  "in_review",
  "merged",
  "rolling_back",
  "rolled_back",
  "failed",
  "aborted",
  "accepted",
];

/** The terminal states — a task at rest (merged/aborted/failed/rolled_back), plus a CTO-`accepted`
 *  CEO directive (its work now lives in the stories it spawned, so the directive itself is DONE). */
export function isTerminal(status: TaskStatus): boolean {
  return (
    status === "merged" ||
    status === "aborted" ||
    status === "failed" ||
    status === "rolled_back" ||
    status === "accepted"
  );
}

/**
 * STATUS-MEMBERSHIP SINGLE SOURCES. These name the two semantically-distinct
 * "needs someone's attention" subsets of the 12-state machine, so logic that used to
 * open-code them (server.ts's operator pull-signal, channel.ts's CTO push-feed) shares
 * ONE definition. `as const satisfies readonly TaskStatus[]` compile-checks every member
 * against the canonical TaskStatus union — a typo or a state that no longer exists is a
 * build error, giving the membership real teeth.
 */

/**
 * REVIEW_STATES — the OPERATOR pull-signal: tasks needing a human's eyes right now (a
 * generated spec awaiting approval, a diff awaiting review, an agent question awaiting an
 * answer, or an execution-`failed` task to inspect). This is the dashboard "needs
 * attention" badge set; see server.healthResponse.
 */
export const REVIEW_STATES = [
  "spec_review",
  "in_review",
  "needs_info",
  "failed",
] as const satisfies readonly TaskStatus[];

/**
 * ATTENTION_STATES — the CTO push-feed (channel) set: every state whose ENTRY the CTO
 * notification channel surfaces. It is REVIEW_STATES plus `idea` (the front of the
 * pipeline — a brief awaiting a spec), `aborted` (a terminal abort to inspect), and
 * `directive` (a CEO directive awaiting the repo's CTO to accept&decompose or escalate —
 * RFC Q1 directive machinery). See src/channel.ts.
 */
export const ATTENTION_STATES = [
  "idea",
  "spec_review",
  "in_review",
  "needs_info",
  "failed",
  "aborted",
  "directive",
] as const satisfies readonly TaskStatus[];

/** Sum the per-status counts for the given membership set (missing keys count as 0). */
export function sumStatuses(
  counts: Record<string, number>,
  states: readonly TaskStatus[],
): number {
  return states.reduce((n, s) => n + (counts[s] ?? 0), 0);
}

export type TaskRow = {
  id: string;
  workspace_id: string;
  status: TaskStatus;
  session_id: string | null;
  // HONEST AGENT-OWNERSHIP MARKER (story st-a77b050f): 1 ⇔ butchr LAUNCHED an agent for
  // this `in_progress` task and has not torn it down. It is the truthful replacement for
  // the old `herdr_pane_id IS NOT NULL`-as-liveness proxy — an OWNED-agent record, NOT a
  // process-liveness claim (it survives a herdr/host restart exactly like the pane did, so
  // TRUE liveness still comes from the /proc probe, claudeAlive in src/liveness.ts). Set
  // once in markRunning (atomic with status=in_progress), cleared centrally in setStatus
  // on every exit from in_progress, and cleared explicitly in requeueForResume (which
  // keeps status=in_progress while the agent is gone, awaiting --resume). Seeded from the
  // legacy pane signal in db.ensureForwardColumns just before the pane column was dropped.
  has_agent: number;
  output_snapshot: string | null;
  conflict: number;
  idle: number;
  // ANSI-stripped run-log tail captured when `idle` flips on, surfaced to the
  // idle-handling responder; NULL whenever the task is not idle. See tasks.setIdle.
  idle_context: string | null;
  // Orthogonal flag on a LIVE in_progress agent hung at a human-only OS/CLI dialog — the
  // exact `idle` pattern, but routing the task's feedback STRAIGHT to the user
  // (pendingResponder → 'user'). NOTHING sets it yet (inert spine). See tasks.setNeedsUserInput.
  needs_user_input: number;
  // ANSI-stripped run-log tail captured when `needs_user_input` flips on, surfaced to the
  // user; NULL whenever the flag is clear. See tasks.setNeedsUserInput.
  needs_user_input_context: string | null;
  // NON-MERGEABLE latch (story st-a632b2cc F3): 1 ⇔ this member is being torn down by a
  // story cascade-abort/delete; finalizeMerge/maybeAutoMerge refuse it so it can never merge
  // to main as an orphan once its story row/story_id is gone. Set synchronously in
  // stories.abortInflightMembers' pre-await prefix; one-way (never cleared). See the
  // `aborting` ensureColumn comment.
  aborting: number;
  review_note: string | null;
  summary: string | null;
  // RAISE handshake (see the `question`/`answer` ensureColumn block above): `question`
  // holds what the agent raised (question / suggested task change / decomposition)
  // while status='needs_info'; `answer` is the operator's response, held transiently
  // for the resume dispatch and consumed at re-launch. Surfaced on TaskView via the
  // `...row` spread.
  question: string | null;
  answer: string | null;
  dispatch_attempts: number;
  last_dispatch_error: string | null;
  next_dispatch_at: string | null;
  // Consecutive host/herdr-restart auto-resumes of this task that didn't make
  // progress (bounded by config.maxResumeAttempts). See tasks.requeueForResume.
  resume_attempts: number;
  // Consecutive host/herdr-restart RECOVERY re-triggers of this task's CI / conformance
  // gate that didn't settle a real result (bounded by config.maxGateRecoveryAttempts).
  // The GATE sibling of resume_attempts. See tasks.recoverStuckGates.
  gate_recovery_attempts: number;
  // Build/test failure output when this task's merge was auto-reverted off the
  // default branch by the post-merge verify gate (null otherwise). See approveTask.
  revert_reason: string | null;
  // Raw JSON-array TEXT of blocker task ids (or null). Parsed via
  // tasks.parseBlockedBy; surfaced as a real string[] on the serialized TaskView.
  blocked_by: string | null;
  // Raw JSON-array TEXT of free-form organizational LABELS (or null). Parsed via
  // tasks.parseTags; surfaced as a real string[] on the serialized TaskView. Set
  // at creation; filtered on in the webapp + CLI. See the `tags` column comment.
  tags: string | null;
  // Raw JSON-array TEXT of the task's FILE ALLOWLIST glob/path entries (or null). Parsed
  // via tasks.parseAllowlist; surfaced as a real string[] on the serialized TaskView. When
  // non-empty, the CI gate fails any diff that strays outside it. See the `allowlist`
  // column comment + tasks.triggerCi.
  allowlist: string | null;
  // CI GATE: build/test outcome captured on the review transition (see tasks.ts).
  // `ci_status` is 'running' | 'pass' | 'fail' | null; `ci_summary` carries a short
  // badge label on its first line plus an output tail. Surfaced on TaskView via the
  // `...row` spread (no extra plumbing in taskView).
  ci_status: string | null;
  ci_summary: string | null;
  // The branch HEAD sha the CI gate ran against (stamped on settle). Binds the stored
  // ci_status to a specific tip so a stale-green can't survive a tip change. NULL until
  // CI settles. See the ensureColumn block above.
  ci_tip: string | null;
  // SPEC-CONFORMANCE GATE: advisory verdict on whether the diff satisfies the prompt,
  // captured on the review transition (see the ensureColumn block above +
  // src/conformance.ts). `conformance_status` is 'checking' | 'pass' | 'concern' | null;
  // `conformance_summary` carries the reviewer's short reason. Surfaced on TaskView via
  // the `...row` spread (no extra plumbing in taskView), like ci_status/ci_summary.
  conformance_status: string | null;
  conformance_summary: string | null;
  // The branch HEAD sha the conformance gate ran against (sibling of ci_tip). NULL until
  // it settles. See the ensureColumn block above.
  conformance_tip: string | null;
  // Merge-range bookkeeping (see the ensureColumn block above): the SHAs bracketing
  // the commits this task landed (`merge_base_sha..merged_sha`), used to pre-fill a
  // rollback task with the exact commit to revert.
  merge_base_sha: string | null;
  merged_sha: string | null;
  // AUTO-MERGE: 1 when butchr auto-merged this task (CI-green + low-risk), else 0.
  // Surfaced on TaskView via the `...row` spread. See tasks.maybeAutoMerge.
  auto_merged: number;
  // TASK KIND: 'task' (default) or 'rollback' (see the `kind` column comment above).
  // The retired `spawned_subtasks` column (the removed plan-decompose path) is
  // intentionally absent from this row type — orphaned in old DBs, never read/written.
  kind: TaskKind;
  // PER-TASK MODEL + TOKEN/COST (see the ensureColumn block above). `model` is the
  // requested model (null = default); `model_used` is what the transcript shows ran;
  // the `usage_*_tokens` are cumulative session token counts; `cost_usd` is a
  // deliberately-unfabricated placeholder (null — no cost source yet). Surfaced on
  // TaskView via the `...row` spread (no extra plumbing in taskView).
  model: string | null;
  model_used: string | null;
  usage_input_tokens: number | null;
  usage_output_tokens: number | null;
  usage_cache_read_tokens: number | null;
  usage_cache_creation_tokens: number | null;
  cost_usd: number | null;
  // DURATION-ESTIMATE FOOTPRINT (see the ensureColumn block above + src/estimate.ts):
  // `diff_lines` is the final changed-line count and `path_type` the coarse
  // path-based type, both captured on the review transition and used to bucket the
  // task for its rough duration estimate. NULL until/unless a footprint was captured.
  diff_lines: number | null;
  path_type: string | null;
  // PHANTOM-RELEASE GUARD FOOTPRINT (see the ensureColumn block above + git.merge): the task's
  // CODE-file set captured at review time as JSON-array TEXT, NON-SHRINKING. NULL/"[]" = no code.
  code_files: string | null;
  // PER-TASK DISPATCH PRIORITY (see the ensureColumn block above): higher dispatches
  // sooner; the queued selection orders by `priority DESC, created_at ASC`. Default
  // 0. Surfaced on TaskView via the `...row` spread (no extra plumbing in taskView).
  priority: number;
  // PLAN-PREVIEW GATE (see the ensureColumn block above): 1 when the task opts into
  // the plan-preview gate (the agent proposes a plan and pauses for operator approval
  // before writing code), else 0. Surfaced on TaskView via the `...row` spread.
  plan_preview: number;
  // VERSIONED-RELEASES (per-task) bookkeeping (see the ensureColumn block above): only
  // meaningful when the workspace has release_mode=1. `version_bump` is the task-declared
  // bump level ('patch'|'minor'|'major'); `major_confirm_count` is the consecutive human
  // confirm-major streak (0/1/2) gating a major merge; `released_version` is the version
  // butchr assigned + stamped at merge (NULL until a release_mode merge). Surfaced on
  // TaskView via the `...row` spread.
  version_bump: "patch" | "minor" | "major";
  major_confirm_count: number;
  released_version: string | null;
  // RESUME RE-GROUNDING FINGERPRINT (see the ensureColumn block above): a sha256 of the
  // prompt + context-file list the agent was last grounded in. Compared on resume to
  // detect a prompt/context edit made while the task was paused (needs_info / in_review),
  // which triggers a re-ground (taskmd.renderRegroundBlock). NULL until first grounded.
  grounding_fp: string | null;
  // UNIFIED-WORK PARENT POINTER (story st-540ba705): the self-referential `work` model's
  // parent FK (a leaf = a task, a node-with-children = a story). NULL = top-level /
  // standalone. As of REVAMP Phase B.5b (story st-78a8b4e7) this is the SOLE membership
  // pointer — the legacy `story_id` column has been dropped (parent_id carried the same
  // value in lock-step). The `story_id` field consumers still read is re-derived from
  // `parent_id` on TaskView (see tasks.taskView) so the wire/API shape is unchanged.
  parent_id: string | null;
  // RESPONDER-REDESIGN (story st-def561dd — see the escalated_to_user ensureColumn above):
  // 1 ONLY on a NON-STORY task whose pending feedback the CTO escalated to the user (the
  // single cto→user boundary for a task; a story member's feedback is terminal at its
  // leader, so it never escalates to the user); resets to 0 on each fresh feedback state.
  // Default 0. Resolved by tasks.pendingResponder; surfaced on TaskView via the `...row`
  // spread (no extra plumbing).
  escalated_to_user: number;
  // WORK-UNIFICATION FOLD DISCRIMINATOR (REVAMP Phase B.2 — story st-6372812d): the persisted
  // node/leaf marker (see the work_kind ensureColumn above) — 'leaf' (every standalone task,
  // the schema default) or 'node' (a materialized story Work node, a row whose id IS a story id
  // and whose tasks.status is today the inert 'merged' FK anchor). As of B.2 this is the SINGLE
  // authoritative node-definition: isWorkNode / resolveWork key on it, and every loop that reads
  // a node's tasks.status excludes nodes via `work_kind='leaf'` (structurally, NOT via the magic
  // 'merged' status). DELIBERATELY STRIPPED from the serialized views (FOLD_VIEW_OMIT, tasks.ts)
  // so TaskView/TaskListView stay byte-identical; read it only off a raw getTask() row.
  //
  // REVAMP-4 Phase 0 / S0a (story st-1a82a2e1): widened with the CONTAINER node kinds 'repo' and
  // 'project' — nodes in the SAME recursive `tasks` tree discriminated by work_kind, the
  // foundation of the recursive PROJECT/CEO tier. A 'repo' node is materialized 1:1 per
  // `directory` row (id == directory id — migrateMaterializeRepoNodes) as its ADDITIVE, inert
  // in-tree handle; the `directory` table stays the repo's 1:1 config sidecar keyed by the same
  // id. Container nodes are INVISIBLE to every existing story/leaf loop: leaf-only reads filter
  // `work_kind='leaf'` (so they never pick up a container) and node/story reads filter
  // `work_kind='node'` (so a repo is never mistaken for a story). 'project' has no materializer
  // yet — it is the reserved kind the project tier lands on next.
  work_kind: "leaf" | "node" | "repo" | "project";
  // PER-PROJECT CEO-AGENT ENABLE (REVAMP-4 Phase 3 / P3c — see the ceo_enabled ensureColumn
  // above): the tri-state master switch on a work_kind='project' node's OWN row — 1 on, 0 off,
  // NULL inherit config.ceoAgentEnabled. NULL for every non-project row (the CEO analog of
  // directory.cto_enabled). Read only via workspaces.isCeoEnabled; never surfaced on any view.
  ceo_enabled: number | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  merged_at: string | null;
};

/** Current wall-clock time as an ISO-8601 string — the canonical timestamp format for all task/db columns. */
export function nowIso(): string {
  return new Date().toISOString();
}

// ---- FULL-TEXT TASK SEARCH (predicate) ------------------------------------
// The matching primitive behind server-side `?q=` task search (the workspace
// task-list endpoint + CLI `ls --search`). A task's searchable text — its prompt
// and review notes (from task.md on disk) plus its DB summary / review_note and id
// — is assembled in tasks.ts (taskSearchText) and tested here against this
// predicate. Case-insensitive substring match; a blank/whitespace query matches
// everything (no filter), so callers can pass an unset `q` through unconditionally.
export function matchesQuery(haystack: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return haystack.toLowerCase().includes(needle);
}

// ---- GLOBAL SETTINGS (key/value runtime state) ----------------------------
// Read a server-wide setting, or null if it was never set. Used for runtime state
// that must persist across restarts but isn't per-task or a static env knob (e.g.
// the dispatcher pause flag — see dispatcher.isPaused).
export function getSetting(key: string): string | null {
  const row = db
    .query<{ value: string }, [string]>(`SELECT value FROM settings WHERE key=?`)
    .get(key);
  return row ? row.value : null;
}

// Upsert a server-wide setting. Single-row write, never throws by design — the
// caller treats settings as best-effort durable state.
export function setSetting(key: string, value: string): void {
  db.query(
    `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
  ).run(key, value);
}

// ---- MANAGED CTO AGENT (per-workspace records) ----------------------------
// One row per registered workspace (keyed by workspace_id), tracking that
// workspace's CTO agent runtime handles. See the cto_agent table comment above and
// src/workspace-agent.ts.
export type CtoAgentRow = {
  workspace_id: string;
  session_id: string | null;
  herdr_workspace: string | null;
  desired: number; // 1 = should be running (supervised), 0 = stopped
  started_at: string | null;
  restarts: number;
  last_error: string | null;
  updated_at: string | null;
};

/** A workspace's CTO-agent record, or null if it has never been written. */
export function getCtoAgentRow(workspaceId: string): CtoAgentRow | null {
  return (
    db
      .query<CtoAgentRow, [string]>(`SELECT * FROM cto_agent WHERE workspace_id=?`)
      .get(workspaceId) ?? null
  );
}

/** Every CTO-agent record (one per workspace that has ever launched/been desired). */
export function listCtoAgentRows(): CtoAgentRow[] {
  return db.query<CtoAgentRow, []>(`SELECT * FROM cto_agent`).all();
}

/** Drop a workspace's CTO-agent record (the workspace DELETE also cascades this). */
export function deleteCtoAgentRow(workspaceId: string): void {
  db.query(`DELETE FROM cto_agent WHERE workspace_id=?`).run(workspaceId);
}

/**
 * Upsert a partial patch onto a workspace's CTO-agent record (stamping updated_at).
 * Single-row write; the supervisor/lifecycle treat this as best-effort durable state
 * the same way settings are. Unspecified fields are left untouched on an existing row.
 * Requires the workspace to exist (the FK cascade keys the row to it).
 */
export function saveCtoAgentRow(
  workspaceId: string,
  patch: Partial<Omit<CtoAgentRow, "workspace_id">>,
): void {
  const cur = getCtoAgentRow(workspaceId);
  const next: CtoAgentRow = {
    workspace_id: workspaceId,
    session_id: cur?.session_id ?? null,
    herdr_workspace: cur?.herdr_workspace ?? null,
    desired: cur?.desired ?? 0,
    started_at: cur?.started_at ?? null,
    restarts: cur?.restarts ?? 0,
    last_error: cur?.last_error ?? null,
    updated_at: cur?.updated_at ?? null,
    ...patch,
  };
  db.query(
    `INSERT INTO cto_agent
       (workspace_id, session_id, herdr_workspace,
        desired, started_at, restarts, last_error, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET
       session_id=excluded.session_id,
       herdr_workspace=excluded.herdr_workspace,
       desired=excluded.desired,
       started_at=excluded.started_at,
       restarts=excluded.restarts,
       last_error=excluded.last_error,
       updated_at=excluded.updated_at`,
  ).run(
    next.workspace_id,
    next.session_id,
    next.herdr_workspace,
    next.desired,
    next.started_at,
    next.restarts,
    next.last_error,
    nowIso(),
  );
}

// ---- MANAGED STORY-LEADER AGENT (per-story records) -----------------------
// One row per story whose leader has ever launched/been desired (keyed by story_id).
// MIRRORS CtoAgentRow exactly. See the story_agent table comment above and
// src/workspace-agent.ts.
export type StoryAgentRow = {
  story_id: string;
  session_id: string | null;
  herdr_workspace: string | null;
  desired: number; // 1 = should be running (supervised), 0 = stopped
  started_at: string | null;
  restarts: number;
  last_error: string | null;
  updated_at: string | null;
};

/** A story's leader-agent record, or null if it has never been written. */
export function getStoryAgentRow(storyId: string): StoryAgentRow | null {
  return (
    db
      .query<StoryAgentRow, [string]>(`SELECT * FROM story_agent WHERE story_id=?`)
      .get(storyId) ?? null
  );
}

/** Every story-leader-agent record (one per story that has ever launched/been desired). */
export function listStoryAgentRows(): StoryAgentRow[] {
  return db.query<StoryAgentRow, []>(`SELECT * FROM story_agent`).all();
}

/**
 * Upsert a partial patch onto a story's leader-agent record (stamping updated_at).
 * Mirrors saveCtoAgentRow: single-row write, unspecified fields untouched on an existing
 * row. Requires the story to exist (the FK cascade keys the row to it).
 */
export function saveStoryAgentRow(
  storyId: string,
  patch: Partial<Omit<StoryAgentRow, "story_id">>,
): void {
  const cur = getStoryAgentRow(storyId);
  const next: StoryAgentRow = {
    story_id: storyId,
    session_id: cur?.session_id ?? null,
    herdr_workspace: cur?.herdr_workspace ?? null,
    desired: cur?.desired ?? 0,
    started_at: cur?.started_at ?? null,
    restarts: cur?.restarts ?? 0,
    last_error: cur?.last_error ?? null,
    updated_at: cur?.updated_at ?? null,
    ...patch,
  };
  db.query(
    `INSERT INTO story_agent
       (story_id, session_id, herdr_workspace,
        desired, started_at, restarts, last_error, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(story_id) DO UPDATE SET
       session_id=excluded.session_id,
       herdr_workspace=excluded.herdr_workspace,
       desired=excluded.desired,
       started_at=excluded.started_at,
       restarts=excluded.restarts,
       last_error=excluded.last_error,
       updated_at=excluded.updated_at`,
  ).run(
    next.story_id,
    next.session_id,
    next.herdr_workspace,
    next.desired,
    next.started_at,
    next.restarts,
    next.last_error,
    nowIso(),
  );
}

// ---- UNIFIED WORKSPACE (agent + directory execution context) --------------
// The row type for the new `workspace` table (see migrateWorkspaceTable). Step 1 is
// SCHEMA FOUNDATION only — fully inert: this type + table exist so later steps can build
// the unified Workspace model, but NOTHING reads or writes the table yet. Named
// `WorkspaceAgentRow` because `WorkspaceRow` (above) is already the DIRECTORY row and must
// not be renamed this step; it becomes the canonical Workspace at the step-6 cutover. See
// docs/rfc-work-workspace-unification.md §2.2.
export type WorkspaceAgentRow = {
  id: string;
  name: string | null;
  // Which agent runs in this context (CHECK-pinned in the table). REVAMP-4 Phase 0 / S0c widened
  // this with 'ceo' — the project-tier supervisor kind (SUPERVISOR_KINDS, src/workspace-agent.ts).
  // As of Phase 3 / P3c a ceo row is LIVE-CAPABLE behind the per-project enable (isCeoEnabled) —
  // DEFAULT OFF, so none boots without a CEO-enabled work_kind='project' node.
  kind: "cto" | "leader" | "build" | "ceo";
  // The DIRECTORY this runs in → today's `workspaces(id)` (renamed `directory` at cutover).
  directory_id: string | null;
  // The OPTIONAL Work this executes (tasks(id)); NULL for a CTO workspace (RFC Q3/Q5).
  work_id: string | null;
  session_id: string | null;
  desired: number; // 1 = should be running (supervised), 0 = stopped
  started_at: string | null;
  restarts: number;
  last_error: string | null;
  has_agent: number; // honest owned-agent marker, generalized across agent kinds
  idle: number;
  idle_context: string | null;
  // 1 = the supervisor gave up relaunching this desired-up agent at the restart cap
  // (dead-and-abandoned); cleared when it becomes healthy or an operator restarts it.
  gave_up: number;
  // Epoch-ms of the last leader-idle escalation published for this workspace (story st-926eea1c);
  // NULL when none outstanding / re-armed. Durable so the repeating idle push survives a restart.
  idle_escalated_at: number | null;
  herdr_workspace: string | null;
  created_at: string;
  updated_at: string | null;
};

// ---- `directory` — the directory+config table -----------------------------
// As of st-540ba705 STEP 6c, `directory` is the AUTHORITATIVE table (physically renamed
// from `workspaces` by migrateRenameWorkspacesToDirectory); `workspaces` is now a writable
// back-compat VIEW over it (migrateWorkspacesView) for the running OLD server. A
// `DirectoryRow` is structurally identical to a `WorkspaceRow` (the rename preserved every
// column), so the two row types remain aliases.
export type DirectoryRow = WorkspaceRow;

/**
 * Every directory, read from the canonical `directory` table. New code addresses the
 * directory concept by this name; the legacy `workspaces` view exists only so the old
 * server keeps working until the deliberate restart.
 */
export function listDirectories(): DirectoryRow[] {
  return db.query<DirectoryRow, []>(`SELECT * FROM directory ORDER BY created_at ASC`).all();
}

// ---- PER-TASK AUDIT TIMELINE ----------------------------------------------
// A row in the task_events log: one status transition for one task.
export type TaskEventRow = {
  id: number;
  task_id: string;
  at: string;
  from_status: string | null;
  to_status: string;
  note: string | null;
};

/**
 * Append a status-transition event for a task. Called from the status-setting
 * functions in tasks.ts AFTER the row's status actually changed (so the log only
 * ever reflects real transitions). `from` is null for the creation event. Cheap,
 * non-throwing-by-design single INSERT — never gate a status change on it.
 */
export function recordTaskEvent(
  taskId: string,
  from: string | null,
  to: string,
  note?: string | null,
): void {
  db.query(
    `INSERT INTO task_events (task_id, at, from_status, to_status, note)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(taskId, nowIso(), from, to, note ?? null);
}

/** The full transition timeline for a task, oldest → newest. */
export function listTaskEvents(taskId: string): TaskEventRow[] {
  return db
    .query<TaskEventRow, [string]>(
      `SELECT id, task_id, at, from_status, to_status, note
         FROM task_events WHERE task_id=? ORDER BY at ASC, id ASC`,
    )
    .all(taskId);
}

// ---- METRICS (read-only aggregation) --------------------------------------
// Powers the webapp's Metrics view. A single SELECT pulls just the columns the
// aggregation needs (metricRows), and computeMetrics() turns the raw rows into
// dashboard aggregates with NO DB access — so the aggregation is unit-testable
// against synthetic rows and `now`. Timestamp semantics (see tasks.ts):
//   started_at   — running transition (agent launched)
//   completed_at — running→review transition (work submitted for review)
//   merged_at    — merged into the default branch
// so started→review uses (started_at, completed_at) and started→merge uses
// (started_at, merged_at). The orthogonal flags (conflict/ci_status) reflect a
// task's CURRENT row state, not its full history — they can be cleared as a task
// moves on — so the derived rates are best-effort snapshots (surfaced as such).

// Columns the metrics aggregation reads; nothing else is fetched.
export type MetricRow = {
  status: string;
  started_at: string | null;
  completed_at: string | null;
  merged_at: string | null;
  conflict: number;
  auto_merged: number;
  revert_reason: string | null;
  ci_status: string | null;
};

/** Fetch the raw per-task rows the metrics aggregation needs; computeMetrics() turns them into dashboard aggregates with no further DB access. */
export function metricRows(): MetricRow[] {
  // `work_kind='leaf'` counts only real LEAF tasks (B.2). metricRows is the ONE aggregate over
  // tasks.status that lacked ANY node filter, so the inert node anchor (status='merged') was
  // miscounted as a real merged task in byStatus.merged / totalMerged / total — a latent
  // inconsistency vs every sibling rollup (workspace counts, health), which already exclude the
  // node. Filtering here both fixes that and prevents B.3 (real node status) from corrupting the
  // metrics. This is the single documented output change in B.2 (see CHANGELOG); every other
  // converted site is behavior-identical.
  // REVAMP-4 S0a: was `work_kind != 'node'`; narrowed to `= 'leaf'` (a pure identity when only
  // leaf/node exist) so the new CONTAINER nodes ('repo'/'project', status='merged') are ALSO
  // excluded — a repo node must never be miscounted as a merged task, the same as a story node.
  return db
    .query<MetricRow, []>(
      `SELECT status, started_at, completed_at, merged_at,
              conflict, auto_merged, revert_reason, ci_status
         FROM tasks WHERE work_kind='leaf'`,
    )
    .all();
}

// ---- DURATION ESTIMATES (raw rows for the estimator) ----------------------
// The columns the estimate model reads (see src/estimate.ts). The shape is the
// canonical `EstimateRow` (estimate.ts) EXCEPT `blocked_by`, which comes back as
// the raw JSON-array TEXT here; the caller (tasks.estimateInputRows) parses it into
// a string[] before handing rows to the pure estimator — the single JSON-parse seam.
export type EstimateRowRaw = Omit<EstimateRow, "blocked_by"> & {
  blocked_by: string | null;
};

export function estimateRows(): EstimateRowRaw[] {
  // `work_kind='leaf'` drops story Work NODES at the SOURCE (B.2): a node row would otherwise
  // feed the estimator, where it is excluded only by its inert 'merged' status (estimate.ts's
  // `status==='merged'` → 0/already-landed handling). That merged-handling is KEPT exactly as-is
  // — it legitimately zeroes REAL merged LEAF tasks (landed blockers contribute 0 duration); we
  // only stop the phantom node from reaching it, so node-exclusion is structural, not via status.
  return db
    .query<EstimateRowRaw, []>(
      `SELECT id, status, started_at, completed_at, merged_at,
              diff_lines, path_type, blocked_by
         FROM tasks WHERE work_kind='leaf'`,
    )
    .all();
}

// A rate plus its raw numerator/denominator, so the UI can show "12% (3/25)" and
// distinguish a real 0% from "no data yet" (rate=null when the denominator is 0).
export type Rate = { rate: number | null; num: number; of: number };
export type Median = { medianMs: number | null; count: number };

export type Metrics = {
  total: number;
  byStatus: Record<string, number>;
  throughput: {
    days: number;
    perDay: { date: string; count: number }[]; // oldest → newest, length === days
    windowMerged: number; // merged within the window
    totalMerged: number; // merged all-time (status='merged')
  };
  timeToReview: Median; // started_at → completed_at
  timeToMerge: Median; // started_at → merged_at
  conflictRate: Rate; // conflict=1 over dispatched (started_at set)
  revertRate: Rate; // revert_reason set over (merged + reverted) merge attempts
  ciPassRate: Rate; // ci_status='pass' over (pass + fail) settled CI runs
  autoMergeRate: Rate; // auto_merged=1 over merged tasks
};

const DAY_MS = 86_400_000;

// `median` (averaging-for-even) + `spanMs` live in src/duration.ts, shared with the
// estimator. NOTE: metrics medians AVERAGE the two middle values for an even count
// (pinned by test/metrics.test.ts) — distinct from the estimator's nearest-rank
// `percentile`; keep using `median` here, not `percentile(_, 0.5)`.

function rate(num: number, of: number): Rate {
  return { rate: of > 0 ? num / of : null, num, of };
}

// Pure: derive dashboard aggregates from raw rows + the current time. `days` is
// the throughput window length (UTC-day buckets, oldest → newest).
export function computeMetrics(rows: MetricRow[], nowMs: number, days = 14): Metrics {
  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;

  // Throughput: merged tasks bucketed by UTC day across the last `days` days.
  // ISO timestamps are UTC ('…Z'), so the first 10 chars are the UTC date.
  const perDay: { date: string; count: number }[] = [];
  const dayIdx = new Map<string, number>();
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(nowMs - i * DAY_MS).toISOString().slice(0, 10);
    dayIdx.set(date, perDay.length);
    perDay.push({ date, count: 0 });
  }
  let windowMerged = 0;
  for (const r of rows) {
    if (!r.merged_at) continue;
    const at = dayIdx.get(r.merged_at.slice(0, 10));
    if (at !== undefined) {
      perDay[at]!.count++;
      windowMerged++;
    }
  }

  const toReview: number[] = [];
  const toMerge: number[] = [];
  let started = 0;
  let conflicts = 0;
  let reverted = 0;
  let ciPass = 0;
  let ciFail = 0;
  let autoMerged = 0;
  for (const r of rows) {
    if (r.started_at) started++;
    if (r.conflict) conflicts++;
    if (r.revert_reason) reverted++;
    if (r.ci_status === "pass") ciPass++;
    else if (r.ci_status === "fail") ciFail++;
    if (r.auto_merged) autoMerged++;
    const tr = spanMs(r.started_at, r.completed_at);
    if (tr !== null) toReview.push(tr);
    const tm = spanMs(r.started_at, r.merged_at);
    if (tm !== null) toMerge.push(tm);
  }
  const merged = byStatus.merged ?? 0;

  return {
    total: rows.length,
    byStatus,
    throughput: { days, perDay, windowMerged, totalMerged: merged },
    timeToReview: { medianMs: median(toReview), count: toReview.length },
    timeToMerge: { medianMs: median(toMerge), count: toMerge.length },
    conflictRate: rate(conflicts, started),
    // A revertedOnRed task ends `failed` (carrying revert_reason), so it is NOT in
    // the merged count — merge attempts that landed (if only briefly) are
    // merged + reverted.
    revertRate: rate(reverted, merged + reverted),
    ciPassRate: rate(ciPass, ciPass + ciFail),
    autoMergeRate: rate(autoMerged, merged),
  };
}

// NOTE: there is deliberately no blind "running → queued" recovery here. A task
// left `running` after a restart still has a live herdr agent whose name is taken;
// re-queuing it just makes the dispatcher collide on `agent_name_taken`. Startup
// reconciliation (dispatcher.reconcileRunningTasks, wired in index.ts) instead
// re-adopts the live agent or rescues a dead one.

// ---- UNIFIED WORKSPACE (agent + directory) — CRUD helpers -----------------
// (story st-540ba705, step 3 — UNIFIED WORKSPACE ABSTRACTION, gated OFF + INERT.)
// Additive accessors over the `workspace` table (created inert in step 1 by
// migrateWorkspaceTable; row type WorkspaceAgentRow above). NOTHING in the live
// paths calls these — they back the gated unified supervisor (src/workspace-agent.ts)
// and its tests. Mirror the saveCtoAgentRow / saveStoryAgentRow upsert pattern, keyed
// by the workspace's own opaque id. Appended at EOF so this step's db.ts additions are
// localized (minimizing rebase churn against the parallel spine subtask).

/** A unified-workspace row, or null if it has never been written. */
export function getWorkspaceAgentRow(id: string): WorkspaceAgentRow | null {
  return (
    db
      .query<WorkspaceAgentRow, [string]>(`SELECT * FROM workspace WHERE id=?`)
      .get(id) ?? null
  );
}

/** Every unified-workspace row (all kinds), oldest → newest. */
export function listWorkspaceAgentRows(): WorkspaceAgentRow[] {
  return db
    .query<WorkspaceAgentRow, []>(`SELECT * FROM workspace ORDER BY created_at ASC`)
    .all();
}

/** Every unified-workspace row bound to one unit of Work (a tasks(id)), oldest → newest. */
export function listWorkspaceAgentRowsForWork(workId: string): WorkspaceAgentRow[] {
  return db
    .query<WorkspaceAgentRow, [string]>(
      `SELECT * FROM workspace WHERE work_id=? ORDER BY created_at ASC`,
    )
    .all(workId);
}

/**
 * The single LIVE workspace for a unit of Work — the one row whose honest owned-agent
 * marker (`has_agent`) is set — or null if none is live. The reader half of the RFC Q3
 * invariant "Work↔Workspace is 1:N with exactly one LIVE at a time" (enforced on the
 * write side by demoteSiblingWorkspaceAgents). Returns the newest if (defensively) more
 * than one is marked live.
 */
export function liveWorkspaceForWork(workId: string): WorkspaceAgentRow | null {
  return (
    db
      .query<WorkspaceAgentRow, [string]>(
        `SELECT * FROM workspace WHERE work_id=? AND has_agent=1 ORDER BY created_at DESC LIMIT 1`,
      )
      .get(workId) ?? null
  );
}

/**
 * 1:N "one live per Work" ENFORCEMENT (RFC Q3): demote every OTHER workspace bound to
 * `workId` — clear its desired flag AND its owned-agent marker — leaving `keepId` the
 * sole live one. A no-op when the Work has no siblings. The caller marks `keepId` live
 * (saveWorkspaceAgentRow has_agent=1) as part of launching it.
 */
export function demoteSiblingWorkspaceAgents(workId: string, keepId: string): void {
  db.query(
    `UPDATE workspace SET desired=0, has_agent=0, updated_at=? WHERE work_id=? AND id<>?`,
  ).run(nowIso(), workId, keepId);
}

/** Drop a unified-workspace row (the directory/Work DELETE also cascades this). */
export function deleteWorkspaceAgentRow(id: string): void {
  db.query(`DELETE FROM workspace WHERE id=?`).run(id);
}

/**
 * Upsert a partial patch onto a unified-workspace row (stamping updated_at). Mirrors
 * saveCtoAgentRow: single-row write, unspecified fields untouched on an existing row.
 * `kind` is required on INSERT (the table CHECK-pins it and it has no safe default) —
 * supply it in the patch when creating a row; on an UPDATE the existing kind is kept.
 */
export function saveWorkspaceAgentRow(
  id: string,
  patch: Partial<Omit<WorkspaceAgentRow, "id">>,
): void {
  const cur = getWorkspaceAgentRow(id);
  const kind = patch.kind ?? cur?.kind;
  if (!kind) {
    throw new Error(`saveWorkspaceAgentRow(${id}): kind is required to create a workspace row`);
  }
  const next: WorkspaceAgentRow = {
    id,
    name: cur?.name ?? null,
    kind,
    directory_id: cur?.directory_id ?? null,
    work_id: cur?.work_id ?? null,
    session_id: cur?.session_id ?? null,
    desired: cur?.desired ?? 0,
    started_at: cur?.started_at ?? null,
    restarts: cur?.restarts ?? 0,
    last_error: cur?.last_error ?? null,
    has_agent: cur?.has_agent ?? 0,
    idle: cur?.idle ?? 0,
    idle_context: cur?.idle_context ?? null,
    gave_up: cur?.gave_up ?? 0,
    idle_escalated_at: cur?.idle_escalated_at ?? null,
    herdr_workspace: cur?.herdr_workspace ?? null,
    created_at: cur?.created_at ?? nowIso(),
    updated_at: cur?.updated_at ?? null,
    ...patch,
    // `id`/`kind` are resolved above; keep them authoritative over a stray patch spread.
    kind,
  };
  db.query(
    `INSERT INTO workspace
       (id, name, kind, directory_id, work_id, session_id, desired, started_at,
        restarts, last_error, has_agent, idle, idle_context, gave_up, idle_escalated_at,
        herdr_workspace, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name,
       kind=excluded.kind,
       directory_id=excluded.directory_id,
       work_id=excluded.work_id,
       session_id=excluded.session_id,
       desired=excluded.desired,
       started_at=excluded.started_at,
       restarts=excluded.restarts,
       last_error=excluded.last_error,
       has_agent=excluded.has_agent,
       idle=excluded.idle,
       idle_context=excluded.idle_context,
       gave_up=excluded.gave_up,
       idle_escalated_at=excluded.idle_escalated_at,
       herdr_workspace=excluded.herdr_workspace,
       updated_at=excluded.updated_at`,
  ).run(
    next.id,
    next.name,
    next.kind,
    next.directory_id,
    next.work_id,
    next.session_id,
    next.desired,
    next.started_at,
    next.restarts,
    next.last_error,
    next.has_agent,
    next.idle,
    next.idle_context,
    next.gave_up,
    next.idle_escalated_at,
    next.herdr_workspace,
    next.created_at,
    nowIso(),
  );
}

/**
 * Flag/unflag a LIVE OPERATOR workspace (kind cto|leader) as `idle` (agent alive but its
 * agent.log has been quiet past the idle window), capturing/clearing the `idle_context`
 * snapshot in lockstep. A byte-faithful mirror of tasks.setIdle (the build-agent machinery):
 *   - PEEK the current row first: a no-op unless this is a genuine FLIP of a live operator
 *     agent (kind cto|leader AND has_agent=1 AND idle<>want), so a per-supervise-tick call
 *     while a stall persists writes nothing;
 *   - the (log-reading) `captureContext` thunk runs ONLY on the 0→1 flip (empty → NULL);
 *     clearing (→0) wipes the context to NULL;
 *   - the UPDATE re-guards atomically with `AND has_agent=1 AND idle<>?`.
 *
 * DELIBERATELY EMITS NO SSE — unlike setIdle (tasks have a `task.updated` surface). Operator
 * idle is a DURABLE PROJECTION INPUT with the SAME shape as `gave_up` (st-a4cc6082): the
 * dashboard/health reads it as a SYNC DB projection with no per-request liveness probe (PART 2,
 * warm-slate-c7b8), and the `workspace.updated` SSE carries the DIRECTORY view (WorkspaceView),
 * NOT this agent row, so publishing it here would be a category error. The higher-up push
 * (leader-idle → CTO) rides the story.attention rail from superviseWorkspace, not this write.
 */
export function setWorkspaceIdle(
  id: string,
  idle: boolean,
  captureContext?: () => string,
): void {
  const want = idle ? 1 : 0;
  // Peek first: only a genuine flip of a LIVE operator agent does anything — and only then do
  // we run the (log-reading) capture thunk.
  const cur = db
    .query<{ idle: number; kind: string; has_agent: number }, [string]>(
      `SELECT idle, kind, has_agent FROM workspace WHERE id=?`,
    )
    .get(id);
  if (
    !cur ||
    (cur.kind !== "cto" && cur.kind !== "leader") ||
    cur.has_agent === 0 ||
    cur.idle === want
  ) {
    return;
  }
  // Going idle → snapshot the agent.log tail as context (empty → NULL); clearing → NULL.
  const context = want === 1 ? captureContext?.() || null : null;
  // ATOMIC RE-ARM (story st-926eea1c S1): clearing to idle=0 ALSO clears the durable
  // idle_escalated_at in the SAME write, so a leader going active can never linger-race with the
  // repeating-escalation cadence. On the 0→1 flip the timestamp is left untouched (a fresh episode
  // starts NULL/re-armed already, and the first escalation stamps it in reconcileOperatorIdle).
  if (want === 0) {
    db.query(
      `UPDATE workspace SET idle=0, idle_context=NULL, idle_escalated_at=NULL, updated_at=?
         WHERE id=? AND has_agent=1 AND idle<>0`,
    ).run(nowIso(), id);
  } else {
    db.query(
      `UPDATE workspace SET idle=1, idle_context=?, updated_at=? WHERE id=? AND has_agent=1 AND idle<>1`,
    ).run(context, nowIso(), id);
  }
}
