// WORK + WORKSPACE unification — STEP 6b: ACTIVATE THE UNIFIED WORKSPACE SUPERVISOR
// (story st-540ba705). This test proves the three deliverables of the cutover sub-step,
// against an ISOLATED BUTCHR_DB (never the live db):
//
//   1. BOOT MIGRATION (db.migrateWorkspaceAgentRows) — every legacy operator-agent row
//      (cto_agent → kind='cto', story_agent → kind='leader') is materialized into the
//      unified `workspace` table, carrying session/desired/herdr_workspace so NO live agent
//      is orphaned, with `name=NULL` so workspaceAgentName() DERIVES the OLD herdr name
//      (Story D name-only identity). BUILD agents are deliberately EXCLUDED (dispatcher-owned).
//      The migration is backward-safe (legacy tables LEFT INTACT) + insert-once idempotent.
//   2. NAME-BASED RE-ADOPT — with the gate ON, the unified supervisor's boot reconcile
//      ADOPTS each migrated cto/leader BY NAME (the live agent the old server launched),
//      rather than double-launching it.
//   3. SINGLE (not double) SUPERVISION — with the gate ON, the LEGACY per-kind cto + story
//      reconcile paths self-gate to a no-op, so the unified supervisor is the sole authority.
//
// The supervision LAUNCH is driven through the injectable seam (setLauncherForTest) + a fake
// AgentRunner sharing a `live` set, exactly like test/workspace-agent.test.ts — no real
// herdr/claude. /proc liveness is driven via setCmdlineLister.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunner, PaneInfo, StartedAgent } from "../src/harness.ts";
import type { WorkspaceAgentRow } from "../src/db.ts";
import type { WorkspaceLauncher } from "../src/workspace-agent.ts";

let DATA_DIR: string;
let dbMod: typeof import("../src/db.ts");
let cfgMod: typeof import("../src/config.ts");
let harnessMod: typeof import("../src/harness.ts");
let livenessMod: typeof import("../src/liveness.ts");
let wa: typeof import("../src/workspace-agent.ts");
let ctoMod: typeof import("../src/cto-agent.ts");
let storyMod: typeof import("../src/story-agent.ts");
let originalRunner: AgentRunner;

const DIR = "dir-6btest";
const STORY = "st-6btest";
const CTO_SESSION = "cto-sess-6b";
const LEADER_SESSION = "leader-sess-6b";

/** Insert a directory (today's `workspaces`) row so workspace.directory_id FK resolves. */
function insertDir(id: string): void {
  dbMod.db
    .query(
      `INSERT OR IGNORE INTO workspaces (id, path, label, herdr_workspace, herdr_pane, created_at)
       VALUES (?, ?, ?, NULL, NULL, ?)`,
    )
    .run(id, join(DATA_DIR, id), id, dbMod.nowIso());
}

/** Insert a story row (so story_agent FK resolves) + materialize its Work node (so a leader
 *  workspace row's work_id → tasks(id) FK resolves, exactly as step 6a does at runtime). */
function insertStory(id: string, workspaceId: string): void {
  dbMod.db
    .query(
      `INSERT OR IGNORE INTO stories (id, workspace_id, brief, status, created_at)
       VALUES (?, ?, ?, 'open', ?)`,
    )
    .run(id, workspaceId, "a story", dbMod.nowIso());
  dbMod.ensureStoryWorkNode(id); // the FK anchor a leader's work_id points at
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-6b-data-"));
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  cfgMod = await import("../src/config.ts");
  dbMod = await import("../src/db.ts");
  harnessMod = await import("../src/harness.ts");
  livenessMod = await import("../src/liveness.ts");
  wa = await import("../src/workspace-agent.ts");
  ctoMod = await import("../src/cto-agent.ts");
  storyMod = await import("../src/story-agent.ts");
  originalRunner = harnessMod.getRunner();

  // Deterministic supervision knobs (the unified loop reuses the CTO knobs).
  cfgMod.config.ctoAgentName = "butchr-cto-agent";
  cfgMod.config.ctoMaxRestarts = 3;
  cfgMod.config.ctoRestartBackoffBaseMs = 0;
  cfgMod.config.ctoRestartBackoffCapMs = 0;
  cfgMod.config.ctoPromptPollMs = 1;
  cfgMod.config.ctoPromptMaxPolls = 1;
  cfgMod.config.ctoPromptQuietPolls = 1;
  // Migration is flag-independent; keep OFF here so the legacy-path assertions are unaffected
  // until a test flips it. Each test that needs the gate ON sets it and afterEach restores OFF.
  cfgMod.config.unifiedWorkspaceEnabled = false;

  // CLEAN SLATE: bun shares the db singleton across test files (the first importer binds it),
  // so other files' rows can be present. This file asserts WHOLE-TABLE shapes (row counts,
  // reconcile-over-all-rows), so clear the tables it touches before seeding — mirroring
  // workspace-agent.test.ts's `DELETE FROM workspace`/`tasks`. Children before parents.
  dbMod.db.query(`DELETE FROM workspace`).run();
  dbMod.db.query(`DELETE FROM story_agent`).run();
  dbMod.db.query(`DELETE FROM cto_agent`).run();
  dbMod.db.query(`DELETE FROM stories`).run();
  dbMod.db.query(`DELETE FROM tasks`).run();

  // Seed the legacy operator-agent state a running OLD server would hold: a directory with a
  // live CTO agent + an open story with a live leader. desired=1 (both up). updated_at is
  // stamped by save*AgentRow.
  insertDir(DIR);
  // A directory with a LIVE CTO agent was, by definition, cto-enabled — reflect that so the
  // unified supervisor's cto_enabled gate (st-93384200) adopts the migrated cto rather than
  // tearing it down.
  dbMod.db.query(`UPDATE workspaces SET cto_enabled=1 WHERE id=?`).run(DIR);
  insertStory(STORY, DIR);
  dbMod.saveCtoAgentRow(DIR, {
    session_id: CTO_SESSION,
    herdr_workspace: "hw-cto",
    desired: 1,
    started_at: dbMod.nowIso(),
    restarts: 2,
  });
  dbMod.saveStoryAgentRow(STORY, {
    session_id: LEADER_SESSION,
    herdr_workspace: "hw-leader",
    desired: 1,
    started_at: dbMod.nowIso(),
    restarts: 1,
  });

  // Run the step-6b boot migration (it also runs in the MIGRATIONS pass at import, but the
  // legacy rows above were seeded AFTER import — so invoke it explicitly here, mirroring boot).
  dbMod.migrateWorkspaceAgentRows();
});

afterAll(() => {
  harnessMod.setRunner(originalRunner);
  livenessMod.setCmdlineLister(null);
  wa.setLauncherForTest(null);
  rmSync(DATA_DIR, { recursive: true, force: true });
});

afterEach(() => {
  cfgMod.config.unifiedWorkspaceEnabled = false; // restore the legacy-safe default for the next test
  wa.setLauncherForTest(null);
  harnessMod.setRunner(originalRunner);
  livenessMod.setCmdlineLister(null);
  wa._resetSupervisionStateForTest();
});

// Same combined fake as workspace-agent.test.ts: a minimal AgentRunner whose agentExists reads
// a shared `live` set, and a WorkspaceLauncher that records launches + marks the launched name
// live. The OLD agents are pre-registered into `live` to model panes that survived the restart.
function makeFake() {
  const live = new Set<string>();
  const calls = { launch: [] as Array<{ id: string; fresh: boolean }>, teardown: [] as string[] };
  const runner: AgentRunner = {
    async isUp() { return true; },
    async workspaceCreate() { return { workspaceId: "ws", rootPaneId: "rp" }; },
    async workspaceExists() { return true; },
    async workspaceClose() {},
    async tabCreate() { return { tabId: "tab", rootPaneId: "rp" }; },
    async tabClose() {},
    async agentTabId() { return undefined; },
    async agentStart(): Promise<StartedAgent> { return { paneId: "p", terminalId: "t" }; },
    async agentExists(name) { return live.has(name); },
    async agentPaneId(name) { return live.has(name) ? "p" : undefined; },
    async agentTerminalId() { return "t"; },
    async paneTerminalId() { return "t"; },
    async paneList(): Promise<PaneInfo[]> { return []; },
    async resolveAgentPane() { return "p"; },
    isAgentNameTaken() { return false; },
    async agentRead() { return ""; },
    async send() {},
    async paneClose() {},
    async teardownTask(name) { calls.teardown.push(name); live.delete(name); },
    async agentDeregister(name) { live.delete(name); },
    async runHeadless() { return { ok: true, code: 0, stdout: "", stderr: "", timedOut: false }; },
  };
  const launcher: WorkspaceLauncher = {
    async launch(row: WorkspaceAgentRow, fresh: boolean) {
      calls.launch.push({ id: row.id, fresh });
      live.add(wa.workspaceAgentName(row));
    },
    async teardown(name: string) { calls.teardown.push(name); live.delete(name); },
  };
  return { runner, launcher, calls, live };
}

describe("step 6b — boot migration: cto_agent + story_agent → workspace rows", () => {
  test("each CTO agent → a kind='cto' workspace row carrying its session/desired/herdr_workspace", () => {
    const row = dbMod.getWorkspaceAgentRow(`ws-cto-${DIR}`)!;
    expect(row).toBeTruthy();
    expect(row.kind).toBe("cto");
    expect(row.directory_id).toBe(DIR);
    expect(row.work_id).toBeNull(); // a CTO is not bound to one unit of Work
    expect(row.session_id).toBe(CTO_SESSION);
    expect(row.desired).toBe(1);
    expect(row.has_agent).toBe(1); // seeded = desired (presumed live-and-owned)
    expect(row.herdr_workspace).toBe("hw-cto");
    expect(row.restarts).toBe(2);
    expect(row.name).toBeNull(); // NULL → the name is DERIVED (see below)
  });

  test("each story LEADER → a kind='leader' workspace row bound to its story Work node", () => {
    const row = dbMod.getWorkspaceAgentRow(`ws-leader-${STORY}`)!;
    expect(row).toBeTruthy();
    expect(row.kind).toBe("leader");
    expect(row.directory_id).toBe(DIR); // from the story's workspace
    expect(row.work_id).toBe(STORY); // → the materialized story Work node (FK-safe via 6a)
    expect(row.session_id).toBe(LEADER_SESSION);
    expect(row.desired).toBe(1);
    expect(row.herdr_workspace).toBe("hw-leader");
    expect(row.name).toBeNull();
  });

  test("name=NULL → workspaceAgentName DERIVES the OLD herdr names verbatim (re-adopt BY NAME)", () => {
    const cto = dbMod.getWorkspaceAgentRow(`ws-cto-${DIR}`)!;
    const leader = dbMod.getWorkspaceAgentRow(`ws-leader-${STORY}`)!;
    expect(wa.workspaceAgentName(cto)).toBe(ctoMod.ctoAgentName(DIR));
    expect(wa.workspaceAgentName(leader)).toBe(storyMod.storyAgentName(STORY));
  });

  test("BUILD agents are NOT migrated (they stay dispatcher-owned) — only cto + leader rows exist", () => {
    const rows = dbMod.listWorkspaceAgentRows();
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((r) => r.kind))).toEqual(new Set(["cto", "leader"]));
    expect(rows.some((r) => r.kind === "build")).toBe(false);
  });

  test("the legacy cto_agent / story_agent tables are LEFT INTACT (old server survives until restart)", () => {
    expect(dbMod.getCtoAgentRow(DIR)!.session_id).toBe(CTO_SESSION);
    expect(dbMod.getStoryAgentRow(STORY)!.session_id).toBe(LEADER_SESSION);
  });

  test("INSERT-ONCE idempotent — a re-run adds no duplicate and NEVER clobbers live state", () => {
    // Simulate the unified supervisor having updated the row AFTER the cutover restart.
    dbMod.saveWorkspaceAgentRow(`ws-cto-${DIR}`, { session_id: "live-resumed", restarts: 9 });
    dbMod.migrateWorkspaceAgentRows();
    dbMod.migrateWorkspaceAgentRows();
    expect(dbMod.listWorkspaceAgentRows().length).toBe(2); // no dupes
    const row = dbMod.getWorkspaceAgentRow(`ws-cto-${DIR}`)!;
    expect(row.session_id).toBe("live-resumed"); // NOT clobbered back to the legacy value
    expect(row.restarts).toBe(9);
  });
});

describe("step 6b — name-based re-adopt by the unified supervisor", () => {
  test("boot reconcile ADOPTS the migrated cto + leader BY NAME (no double-launch)", async () => {
    cfgMod.config.unifiedWorkspaceEnabled = true;
    const { runner, launcher, calls, live } = makeFake();
    harnessMod.setRunner(runner);
    wa.setLauncherForTest(launcher);
    livenessMod.setCmdlineLister(() => []); // "unknown" liveness → adopt-safe (not dead)

    // The panes the OLD server launched survived the restart, registered under the OLD names.
    live.add(wa.workspaceAgentName(dbMod.getWorkspaceAgentRow(`ws-cto-${DIR}`)!));
    live.add(wa.workspaceAgentName(dbMod.getWorkspaceAgentRow(`ws-leader-${STORY}`)!));

    const res = await wa.reconcileWorkspaceAgents(true);

    expect(res.adopted).toBe(2);
    expect(res.launched).toBe(0);
    expect(calls.launch.length).toBe(0); // adopted by name — nothing relaunched/orphaned
  });
});

describe("step 6b — single (not double) supervision when the gate is ON", () => {
  test("the legacy cto + story reconcile paths self-gate to a no-op", async () => {
    cfgMod.config.unifiedWorkspaceEnabled = true;
    // Both legacy reconciles must do NOTHING (no adopt/launch) so the unified supervisor — which
    // re-adopted the same agents BY NAME above — is the sole authority over cto/leader.
    expect(await ctoMod.reconcileCtoAgents(true)).toEqual({ adopted: 0, launched: 0, skipped: 0 });
    expect(await storyMod.reconcileStoryAgents(true)).toEqual({ adopted: 0, launched: 0, skipped: 0 });
  });
});
