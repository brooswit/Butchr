// Tests for the UNIFIED WORKSPACE SUPERVISOR (src/workspace-agent.ts, story st-540ba705
// step 3) — the ONE supervision loop that generalizes the three agent kinds (build / story
// leader / CTO) into a single (agent + directory) execution context over the `workspace`
// table. It is gated OFF + INERT in production; these tests flip config.unifiedWorkspaceEnabled
// ON to exercise the loop, and one case proves it is a no-op while OFF.
//
// The supervisor delegates the actual agent LAUNCH through an injectable seam
// (setLauncherForTest), so the supervision LOGIC (adopt/relaunch/backoff/dead-detection/1:N)
// is what's exercised here — with NO real herdr/claude. `harness.agentExists` (registration)
// is driven by a FAKE AgentRunner sharing a `live` set with the fake launcher; /proc liveness
// (claudeLiveness) is driven via setCmdlineLister. config fields are set DIRECTLY on the
// imported singleton (robust to bun's shared-import order).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
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
let originalRunner: AgentRunner;

const DIR = "dir-wstest1";

/** Insert a directory (today's `workspaces`) row so workspace.directory_id FK resolves. */
function insertDir(id: string): void {
  dbMod.db
    .query(
      `INSERT OR IGNORE INTO workspaces (id, path, label, herdr_workspace, herdr_pane, created_at)
       VALUES (?, ?, ?, NULL, NULL, ?)`,
    )
    .run(id, join(DATA_DIR, id), id, dbMod.nowIso());
}

/** Insert a task (Work) row so workspace.work_id FK resolves. */
function insertTask(id: string): void {
  dbMod.db
    .query(
      `INSERT OR IGNORE INTO tasks (id, workspace_id, status, created_at) VALUES (?, ?, 'inactive', ?)`,
    )
    .run(id, DIR, dbMod.nowIso());
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-wsagent-data-"));
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  cfgMod = await import("../src/config.ts");
  dbMod = await import("../src/db.ts");
  harnessMod = await import("../src/harness.ts");
  livenessMod = await import("../src/liveness.ts");
  wa = await import("../src/workspace-agent.ts");
  originalRunner = harnessMod.getRunner();

  // Deterministic supervision knobs (the unified loop reuses the CTO knobs).
  cfgMod.config.ctoMaxRestarts = 3;
  cfgMod.config.ctoRestartBackoffBaseMs = 0; // no real backoff wait in tests
  cfgMod.config.ctoRestartBackoffCapMs = 0;
  cfgMod.config.ctoPromptPollMs = 1;
  cfgMod.config.ctoPromptMaxPolls = 1;
  cfgMod.config.ctoPromptQuietPolls = 1;

  insertDir(DIR);
});

afterAll(() => {
  harnessMod.setRunner(originalRunner);
  livenessMod.setCmdlineLister(null);
  wa.setLauncherForTest(null);
  rmSync(DATA_DIR, { recursive: true, force: true });
});

/**
 * A combined fake: a minimal AgentRunner whose `agentExists` reads a shared `live` set, and
 * a WorkspaceLauncher that records calls, marks the launched name live, persists the row
 * shape a real launch would (session_id + has_agent=1 + desired=1), and enforces the 1:N
 * demote — so the supervisor's decisions can be asserted with no real herdr. `throwOnLaunch`
 * makes every launch fail (the backoff-cap scenario).
 */
function makeFake(opts: { throwOnLaunch?: boolean } = {}) {
  const live = new Set<string>();
  const calls = {
    launch: [] as Array<{ id: string; fresh: boolean }>,
    teardown: [] as string[],
    order: [] as string[],
  };
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
    async teardownTask(name) { calls.teardown.push(name); calls.order.push("teardown"); live.delete(name); },
    async agentDeregister(name) { live.delete(name); },
    async runHeadless() { return { ok: true, code: 0, stdout: "", stderr: "", timedOut: false }; },
  };
  const launcher: WorkspaceLauncher = {
    async launch(row: WorkspaceAgentRow, fresh: boolean) {
      calls.launch.push({ id: row.id, fresh });
      calls.order.push("launch");
      if (opts.throwOnLaunch) throw new Error("launch boom");
      const sid = row.session_id ?? `sess-${row.id}`;
      dbMod.saveWorkspaceAgentRow(row.id, {
        session_id: sid,
        started_at: dbMod.nowIso(),
        desired: 1,
        has_agent: 1,
        last_error: null,
      });
      if (row.work_id) dbMod.demoteSiblingWorkspaceAgents(row.work_id, row.id);
      live.add(wa.workspaceAgentName(row));
    },
    async teardown(name: string) { calls.teardown.push(name); calls.order.push("teardown"); live.delete(name); },
  };
  return { runner, launcher, calls, live };
}

beforeEach(() => {
  cfgMod.config.unifiedWorkspaceEnabled = true; // ON for most cases; the inert case flips it off
  dbMod.db.query(`DELETE FROM workspace`).run();
  dbMod.db.query(`DELETE FROM tasks`).run();
  wa._resetSupervisionStateForTest();
  livenessMod.setCmdlineLister(() => []); // default: "unknown" liveness → adopt-safe
});

afterEach(() => {
  wa.setLauncherForTest(null);
});

describe("unified workspace supervisor", () => {
  test("name-only identity is derived per kind to match today's names", () => {
    const cto: WorkspaceAgentRow = mkRow({ id: "w-cto", kind: "cto", directory_id: DIR });
    const leader: WorkspaceAgentRow = mkRow({ id: "w-l", kind: "leader", work_id: "story-1", directory_id: DIR });
    const build: WorkspaceAgentRow = mkRow({ id: "w-b", kind: "build", work_id: "task-9", directory_id: DIR });
    expect(wa.workspaceAgentName(cto)).toBe(`${cfgMod.config.ctoAgentName}-${DIR}`);
    expect(wa.workspaceAgentName(leader)).toBe(`${cfgMod.config.ctoAgentName}-story-story-1`);
    expect(wa.workspaceAgentName(build)).toBe("task-9");
    // A pinned `name` column wins over the derived form.
    expect(wa.workspaceAgentName(mkRow({ id: "w", kind: "cto", name: "custom", directory_id: DIR }))).toBe("custom");
  });

  test("start LAUNCHES a desired-but-dead workspace (one launch, row marked live)", async () => {
    const { runner, launcher, calls } = makeFake();
    harnessMod.setRunner(runner);
    wa.setLauncherForTest(launcher);
    dbMod.saveWorkspaceAgentRow("w1", { kind: "cto", directory_id: DIR });

    const status = await wa.startWorkspaceAgent("w1");

    expect(calls.launch.map((c) => c.id)).toEqual(["w1"]);
    expect(calls.launch[0]!.fresh).toBe(false);
    const r = dbMod.getWorkspaceAgentRow("w1")!;
    expect(r.desired).toBe(1);
    expect(r.has_agent).toBe(1);
    expect(r.session_id).toBe("sess-w1");
    expect(status.running).toBe(true);
    expect(status.kind).toBe("cto");
  });

  test("start ADOPTS a live workspace (single instance — no launch)", async () => {
    const { runner, launcher, calls, live } = makeFake();
    harnessMod.setRunner(runner);
    wa.setLauncherForTest(launcher);
    dbMod.saveWorkspaceAgentRow("w1", { kind: "cto", directory_id: DIR, session_id: "sess-x" });
    live.add(wa.workspaceAgentName(dbMod.getWorkspaceAgentRow("w1")!)); // already registered

    const status = await wa.startWorkspaceAgent("w1");

    expect(calls.launch.length).toBe(0); // adopted, not relaunched
    expect(status.running).toBe(true);
    const r = dbMod.getWorkspaceAgentRow("w1")!;
    expect(r.desired).toBe(1);
    expect(r.has_agent).toBe(1);
  });

  test("a registered-but-DEAD pane (host reboot) is torn down BEFORE the --resume relaunch", async () => {
    const { runner, launcher, calls, live } = makeFake();
    harnessMod.setRunner(runner);
    wa.setLauncherForTest(launcher);
    dbMod.saveWorkspaceAgentRow("w1", { kind: "cto", directory_id: DIR, session_id: "sess-dead" });
    live.add(wa.workspaceAgentName(dbMod.getWorkspaceAgentRow("w1")!)); // pane registered…
    // …but /proc has processes and NONE carry the session id → provably DEAD (reboot case).
    livenessMod.setCmdlineLister(() => [["claude", "--resume", "someone-else"]]);

    await wa.startWorkspaceAgent("w1");

    expect(calls.launch.map((c) => c.id)).toEqual(["w1"]); // relaunched
    // Teardown of the stale husk ran BEFORE the relaunch.
    expect(calls.order.indexOf("teardown")).toBeLessThan(calls.order.indexOf("launch"));
  });

  test("the ONE loop supervises ALL THREE kinds (cto / leader / build)", async () => {
    const { runner, launcher, calls } = makeFake();
    harnessMod.setRunner(runner);
    wa.setLauncherForTest(launcher);
    insertTask("story-1");
    insertTask("task-1");
    dbMod.saveWorkspaceAgentRow("w-cto", { kind: "cto", directory_id: DIR, desired: 1 });
    dbMod.saveWorkspaceAgentRow("w-leader", { kind: "leader", directory_id: DIR, work_id: "story-1", desired: 1 });
    dbMod.saveWorkspaceAgentRow("w-build", { kind: "build", directory_id: DIR, work_id: "task-1", desired: 1 });

    // All desired-up but dead → the single tick relaunches each.
    await wa._superviseTickForTest("w-cto");
    await wa._superviseTickForTest("w-leader");
    await wa._superviseTickForTest("w-build");

    expect(new Set(calls.launch.map((c) => c.id))).toEqual(new Set(["w-cto", "w-leader", "w-build"]));
  });

  test("supervise relaunches on death with bounded backoff, then GIVES UP at the cap", async () => {
    const { runner, launcher, calls } = makeFake({ throwOnLaunch: true });
    harnessMod.setRunner(runner);
    wa.setLauncherForTest(launcher);
    dbMod.saveWorkspaceAgentRow("w1", { kind: "cto", directory_id: DIR, desired: 1 });

    // Each tick relaunches (and fails) until ctoMaxRestarts (3) consecutive failures.
    for (let i = 0; i < 6; i++) await wa._superviseTickForTest("w1");

    expect(calls.launch.length).toBe(3); // stopped trying at the cap
    expect(dbMod.getWorkspaceAgentRow("w1")!.last_error).toContain("launch boom");
  });

  test("Work→Workspace 1:N — exactly ONE live workspace per Work (siblings demoted)", async () => {
    const { runner, launcher, live } = makeFake();
    harnessMod.setRunner(runner);
    wa.setLauncherForTest(launcher);
    insertTask("task-1");
    // Two workspaces bound to the SAME Work, both (defensively) marked live.
    dbMod.saveWorkspaceAgentRow("w-a", { kind: "build", directory_id: DIR, work_id: "task-1", desired: 1, has_agent: 1, session_id: "sess-a" });
    dbMod.saveWorkspaceAgentRow("w-b", { kind: "build", directory_id: DIR, work_id: "task-1", desired: 1, has_agent: 1, session_id: "sess-b" });
    live.add(wa.workspaceAgentName(dbMod.getWorkspaceAgentRow("w-b")!)); // w-b is the one registered/alive

    // Adopt w-b (it's alive) — adoptOrLaunch enforces the 1:N invariant by demoting siblings.
    await wa.startWorkspaceAgent("w-b");

    expect(dbMod.liveWorkspaceForWork("task-1")!.id).toBe("w-b");
    const a = dbMod.getWorkspaceAgentRow("w-a")!;
    expect(a.desired).toBe(0);
    expect(a.has_agent).toBe(0);
  });

  test("INERT while gated OFF — start / supervise / reconcile are no-ops", async () => {
    cfgMod.config.unifiedWorkspaceEnabled = false;
    const { runner, launcher, calls } = makeFake();
    harnessMod.setRunner(runner);
    wa.setLauncherForTest(launcher);
    dbMod.saveWorkspaceAgentRow("w1", { kind: "cto", directory_id: DIR, desired: 1 });

    await wa.startWorkspaceAgent("w1");
    await wa._superviseTickForTest("w1");
    const recon = await wa.reconcileWorkspaceAgents(true);

    expect(calls.launch.length).toBe(0); // nothing launched while gated off
    expect(recon).toEqual({ adopted: 0, launched: 0, skipped: 0 });
    // The row is untouched — never marked live by the gated-off path.
    expect(dbMod.getWorkspaceAgentRow("w1")!.has_agent).toBe(0);
  });
});

/** Build a full WorkspaceAgentRow for the pure-helper cases (no DB write). */
function mkRow(p: Partial<WorkspaceAgentRow> & { id: string; kind: WorkspaceAgentRow["kind"] }): WorkspaceAgentRow {
  return {
    id: p.id,
    name: p.name ?? null,
    kind: p.kind,
    directory_id: p.directory_id ?? null,
    work_id: p.work_id ?? null,
    session_id: p.session_id ?? null,
    desired: p.desired ?? 0,
    started_at: p.started_at ?? null,
    restarts: p.restarts ?? 0,
    last_error: p.last_error ?? null,
    has_agent: p.has_agent ?? 0,
    idle: p.idle ?? 0,
    idle_context: p.idle_context ?? null,
    herdr_workspace: p.herdr_workspace ?? null,
    created_at: p.created_at ?? "2026-01-01T00:00:00.000Z",
    updated_at: p.updated_at ?? null,
  };
}
