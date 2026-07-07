// Tests for the UNIFIED WORKSPACE SUPERVISOR (src/workspace-agent.ts, story st-540ba705
// step 3) — the ONE supervision loop that generalizes the three agent kinds (build / story
// leader / CTO) into a single (agent + directory) execution context over the `workspace`
// table. It is the SOLE boot authority over the cto/leader operator agents (src/index.ts).
//
// The supervisor delegates the actual agent LAUNCH through an injectable seam
// (setLauncherForTest), so the supervision LOGIC (adopt/relaunch/backoff/dead-detection/1:N)
// is what's exercised here — with NO real herdr/claude. `harness.agentExists` (registration)
// is driven by a FAKE AgentRunner sharing a `live` set with the fake launcher; /proc liveness
// (claudeLiveness) is driven via setCmdlineLister. config fields are set DIRECTLY on the
// imported singleton (robust to bun's shared-import order).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunner, PaneInfo, SendInput, StartedAgent } from "../src/harness.ts";
import type { ConfirmRule } from "../src/startup-confirm.ts";
import type { WorkspaceAgentRow } from "../src/db.ts";
import type { WorkspaceLauncher } from "../src/workspace-agent.ts";

let DATA_DIR: string;
let dbMod: typeof import("../src/db.ts");
let cfgMod: typeof import("../src/config.ts");
let harnessMod: typeof import("../src/harness.ts");
let livenessMod: typeof import("../src/liveness.ts");
let wa: typeof import("../src/workspace-agent.ts");
let storiesMod: typeof import("../src/stories.ts");
let dirsMod: typeof import("../src/workspaces.ts");
let eventsMod: typeof import("../src/events.ts");
let tasksMod: typeof import("../src/tasks.ts");
let originalRunner: AgentRunner;

/** Let fire-and-forget teardowns (updateStory's `void teardownLeaderWorkspaceForWork`) settle. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * BOUNDED poll until `pred()` is true (NOT a fixed sleep — no unbounded waits, no flakes).
 * Used to await the DETACHED, fire-and-forget startup auto-confirm (adoptOrLaunch no longer
 * awaits it) before asserting on its observable effects (sends issued / reads consumed).
 */
async function waitFor(pred: () => boolean, timeoutMs = 1000, stepMs = 1): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("waitFor: predicate not met within timeout");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

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
  storiesMod = await import("../src/stories.ts");
  dirsMod = await import("../src/workspaces.ts");
  eventsMod = await import("../src/events.ts");
  tasksMod = await import("../src/tasks.ts");
  originalRunner = harnessMod.getRunner();

  // Deterministic supervision knobs (the unified loop reuses the CTO knobs).
  cfgMod.config.ctoMaxRestarts = 3;
  cfgMod.config.ctoRestartBackoffBaseMs = 0; // no real backoff wait in tests
  cfgMod.config.ctoRestartBackoffCapMs = 0;
  cfgMod.config.ctoPromptPollMs = 1;
  cfgMod.config.ctoPromptMaxPolls = 1;
  cfgMod.config.ctoPromptQuietPolls = 1;
  // Mid-session probe knobs (deterministic): a 60s idle threshold (the controllable agent.log
  // mtime seam sets the pane "idle" or "active" relative to it) and probe-every-tick by default
  // (individual cases override the cadence for the throttle test).
  cfgMod.config.idleMs = 60_000;
  cfgMod.config.ctoMidProbeEverySupervisions = 1;

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
  dbMod.db.query(`DELETE FROM workspace`).run();
  dbMod.db.query(`DELETE FROM tasks`).run(); // node rows live here too post-B.5b (stories table dropped)
  wa._resetSupervisionStateForTest();
  cfgMod.config.ctoMidProbeEverySupervisions = 1; // probe every tick unless a case overrides
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
    // The supervisor now gates cto-kind rows on directory.cto_enabled (st-93384200) — enable it
    // so the cto workspace is supervised like the leader/build kinds.
    dbMod.db.query(`UPDATE workspaces SET cto_enabled=1 WHERE id=?`).run(DIR);
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
    // Enable the directory's CTO so the cto-kind gate (st-93384200) doesn't short-circuit the
    // relaunch path under test here.
    dbMod.db.query(`UPDATE workspaces SET cto_enabled=1 WHERE id=?`).run(DIR);
    dbMod.saveWorkspaceAgentRow("w1", { kind: "cto", directory_id: DIR, desired: 1 });

    // Each tick relaunches (and fails) until ctoMaxRestarts (3) consecutive failures.
    for (let i = 0; i < 6; i++) await wa._superviseTickForTest("w1");

    expect(calls.launch.length).toBe(3); // stopped trying at the cap
    expect(dbMod.getWorkspaceAgentRow("w1")!.last_error).toContain("launch boom");
    // (a) The give-up is now DURABLE: the row carries the gave_up marker (st-a4cc6082 S1).
    expect(dbMod.getWorkspaceAgentRow("w1")!.gave_up).toBe(1);
  });

  test("gave_up CLEARS on a subsequent healthy tick", async () => {
    const { runner, launcher, live } = makeFake({ throwOnLaunch: true });
    harnessMod.setRunner(runner);
    wa.setLauncherForTest(launcher);
    dbMod.db.query(`UPDATE workspaces SET cto_enabled=1 WHERE id=?`).run(DIR);
    dbMod.saveWorkspaceAgentRow("w1", { kind: "cto", directory_id: DIR, desired: 1 });

    // Drive to the cap → gave_up set.
    for (let i = 0; i < 6; i++) await wa._superviseTickForTest("w1");
    expect(dbMod.getWorkspaceAgentRow("w1")!.gave_up).toBe(1);

    // (b) The agent comes back to life → the next healthy tick clears the marker.
    live.add(wa.workspaceAgentName(dbMod.getWorkspaceAgentRow("w1")!));
    await wa._superviseTickForTest("w1");
    expect(dbMod.getWorkspaceAgentRow("w1")!.gave_up).toBe(0);
  });

  test("an operator start CLEARS gave_up", async () => {
    const { runner, launcher } = makeFake();
    harnessMod.setRunner(runner);
    wa.setLauncherForTest(launcher);
    // A row the supervisor previously abandoned.
    dbMod.saveWorkspaceAgentRow("w1", { kind: "cto", directory_id: DIR, desired: 1, gave_up: 1 });

    // (c) A deliberate operator start resets supervision and drops the marker.
    await wa.startWorkspaceAgent("w1");
    expect(dbMod.getWorkspaceAgentRow("w1")!.gave_up).toBe(0);
  });

  test("gave_up defaults to 0 and a normally-live agent never sets it", async () => {
    const { runner, launcher, live } = makeFake();
    harnessMod.setRunner(runner);
    wa.setLauncherForTest(launcher);
    dbMod.saveWorkspaceAgentRow("w1", { kind: "cto", directory_id: DIR, desired: 1, has_agent: 1 });
    live.add(wa.workspaceAgentName(dbMod.getWorkspaceAgentRow("w1")!)); // alive from the start

    // (d) Default is 0, and supervising a healthy agent never trips the marker.
    expect(dbMod.getWorkspaceAgentRow("w1")!.gave_up).toBe(0);
    for (let i = 0; i < 3; i++) await wa._superviseTickForTest("w1");
    expect(dbMod.getWorkspaceAgentRow("w1")!.gave_up).toBe(0);
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

});

// ── leader teardown on node-Work completion (unified) ────────────────────────
// A node-Work (story) has a `stories` row (AUTHORITATIVE status) AND a materialized `tasks`
// row whose status is ALWAYS 'merged'. Terminal-ness of a node must be read from the story
// status, never the tasks row. These tests prove (1) completing a node tears its leader
// workspace down, (2) boot reconcile won't revive a terminal node's leader, and (3) the
// REQUIRED trap: an OPEN node whose RAW tasks.status='merged' is NOT treated as terminal.
describe("leader teardown on node-Work completion (unified)", () => {
  /** Seed the story's materialized Work NODE (work_kind='node') carrying the AUTHORITATIVE status,
   *  as production's createStory does, so the B.4-flipped reads — which read the node's OWN tasks
   *  row — resolve it at this status. isolated=0 so a `done` PATCH lands immediately. Post-B.5b the
   *  node IS the story (the legacy `stories` table is dropped). */
  function insertStory(id: string, status: string): void {
    dbMod.db
      .query(
        `INSERT OR IGNORE INTO tasks (id, workspace_id, status, work_kind, brief, isolated, created_at)
         VALUES (?, ?, ?, 'node', ?, 0, ?)`,
      )
      .run(id, DIR, status, `brief ${id}`, dbMod.nowIso());
  }

  /** Seed a LIVE leader `workspace` row for a story node (+ the FK-target materialized `tasks` row). */
  function seedLiveLeader(wsId: string, storyId: string, live: Set<string>): string {
    // The materialized story NODE — FK target of the leader's work_id (belt; insertStory usually
    // created it already). Post-B.5b the node row IS the story.
    dbMod.db
      .query(
        `INSERT OR IGNORE INTO tasks (id, workspace_id, status, work_kind, brief, isolated, created_at)
         VALUES (?, ?, 'open', 'node', ?, 0, ?)`,
      )
      .run(storyId, DIR, `brief ${storyId}`, dbMod.nowIso());
    dbMod.saveWorkspaceAgentRow(wsId, {
      kind: "leader",
      directory_id: DIR,
      work_id: storyId,
      desired: 1,
      has_agent: 1,
      session_id: `sess-${wsId}`,
    });
    const name = wa.workspaceAgentName(dbMod.getWorkspaceAgentRow(wsId)!);
    live.add(name); // the leader's pane is registered/alive
    return name;
  }

  test("completing a node-Work (done) tears its leader workspace down (desired=0, not running)", async () => {
    const { runner, launcher, calls, live } = makeFake();
    harnessMod.setRunner(runner);
    wa.setLauncherForTest(launcher);
    insertStory("st-done", "open");
    const name = seedLiveLeader("ws-leader-st-done", "st-done", live);

    storiesMod.updateStory("st-done", { status: "done" });

    // desired=0 lands SYNCHRONOUSLY (stopWorkspaceAgent writes it before its first await)…
    expect(dbMod.getWorkspaceAgentRow("ws-leader-st-done")!.desired).toBe(0);
    // …the async pane teardown settles on the next tick (per the steering note, await it).
    await flush();
    expect(calls.teardown).toContain(name);
    expect((await wa.workspaceAgentStatus("ws-leader-st-done")).running).toBe(false);
  });

  test("aborting a node-Work tears its leader workspace down (desired=0, not running)", async () => {
    const { runner, launcher, calls, live } = makeFake();
    harnessMod.setRunner(runner);
    wa.setLauncherForTest(launcher);
    insertStory("st-abort", "open");
    const name = seedLiveLeader("ws-leader-st-abort", "st-abort", live);

    storiesMod.updateStory("st-abort", { status: "aborted" });

    expect(dbMod.getWorkspaceAgentRow("ws-leader-st-abort")!.desired).toBe(0);
    await flush();
    expect(calls.teardown).toContain(name);
    expect((await wa.workspaceAgentStatus("ws-leader-st-abort")).running).toBe(false);
  });

  test("boot reconcile does NOT adopt/relaunch a leader whose node-Work is terminal (sets desired=0)", async () => {
    const { runner, launcher, calls, live } = makeFake();
    harnessMod.setRunner(runner);
    wa.setLauncherForTest(launcher);
    insertStory("st-term", "done"); // AUTHORITATIVE terminal
    seedLiveLeader("ws-leader-st-term", "st-term", live); // pane survived the restart

    const res = await wa.reconcileWorkspaceAgents(true);

    expect(res.adopted).toBe(0);
    expect(res.launched).toBe(0);
    expect(calls.launch.length).toBe(0); // never relaunched
    expect(dbMod.getWorkspaceAgentRow("ws-leader-st-term")!.desired).toBe(0); // desired zeroed
  });

  test("REQUIRED: an OPEN node whose RAW tasks.status='merged' is NOT terminal — leader is KEPT", async () => {
    const { runner, launcher, calls, live } = makeFake();
    harnessMod.setRunner(runner);
    wa.setLauncherForTest(launcher);
    insertStory("st-trap", "open"); // AUTHORITATIVE: open (ACTIVE)
    seedLiveLeader("ws-leader-st-trap", "st-trap", live);
    // The materialized node's RAW tasks row reads 'merged' — the exact trap. A raw-status check
    // would wrongly tear the ACTIVE story's leader down.
    dbMod.db.query(`UPDATE tasks SET status='merged' WHERE id=?`).run("st-trap");

    // Boot reconcile must ADOPT (keep) the leader, NOT stop it.
    const res = await wa.reconcileWorkspaceAgents(true);

    expect(res.adopted).toBe(1);
    expect(calls.launch.length).toBe(0);
    expect(dbMod.getWorkspaceAgentRow("ws-leader-st-trap")!.desired).toBe(1); // STILL desired-up
    expect((await wa.workspaceAgentStatus("ws-leader-st-trap")).running).toBe(true); // still alive
    // (Completion-teardown can't be fooled by the raw status either: it's gated by the CALLER on
    // a `done`/`aborted` PATCH, which never fires for this `open` story.)
  });

  test("a node in a TRANSIENT state (merging / merge_blocked) KEEPS its leader (not terminal)", async () => {
    for (const status of ["merging", "merge_blocked"] as const) {
      dbMod.db.query(`DELETE FROM workspace`).run();
      dbMod.db.query(`DELETE FROM tasks`).run(); // node rows live here too post-B.5b
      wa._resetSupervisionStateForTest();
      const { runner, launcher, calls, live } = makeFake();
      harnessMod.setRunner(runner);
      wa.setLauncherForTest(launcher);
      insertStory(`st-${status}`, status);
      seedLiveLeader(`ws-${status}`, `st-${status}`, live);

      const res = await wa.reconcileWorkspaceAgents(true);

      expect(res.adopted).toBe(1); // KEPT (adopted), not stopped
      expect(calls.launch.length).toBe(0);
      expect(dbMod.getWorkspaceAgentRow(`ws-${status}`)!.desired).toBe(1);
    }
  });

  // ---- F1: superviseWorkspace's RELAUNCH branch must not revive a terminal leader ----------
  // The dead-while-desired RELAUNCH path (NOT boot reconcile) had no terminal-leader guard, so a
  // leader whose story is done/aborted but still has a stray desired=1 would be relaunched every
  // supervise tick forever. The guard sits ABOVE the backoff/restart-budget lines, so a terminal
  // leader never burns restart-budget nor logs a false "died — relaunching".
  test("F1: superviseWorkspace does NOT relaunch a DEAD leader whose node-Work is terminal — forces desired=0", async () => {
    const { runner, launcher, calls } = makeFake();
    harnessMod.setRunner(runner);
    wa.setLauncherForTest(launcher);
    insertStory("st-f1", "done"); // AUTHORITATIVE terminal
    insertTask("st-f1"); // FK target of the leader's work_id
    dbMod.saveWorkspaceAgentRow("ws-f1", {
      kind: "leader",
      directory_id: DIR,
      work_id: "st-f1",
      desired: 1, // stray desired-up
      has_agent: 1,
      session_id: "sess-ws-f1",
    });
    // The pane is DEAD (never added to `live`) → the dead-while-desired RELAUNCH path.

    // Several ticks: a terminal leader must NEVER be relaunched, no matter how many times polled.
    for (let i = 0; i < 5; i++) await wa._superviseTickForTest("ws-f1");

    expect(calls.launch.length).toBe(0); // never relaunched (also: restart-budget never burned)
    expect(dbMod.getWorkspaceAgentRow("ws-f1")!.desired).toBe(0); // forced desired-down
  });

  // ---- F2: STOP must WIN a race with an in-flight (slow) relaunch --------------------------
  // A leader pane dies → superviseWorkspace relaunches via guarded() (a slow launch keeps
  // launchInFlight set) → concurrently the story goes done → teardownLeaderWorkspaceForWork →
  // stopWorkspaceAgent. The stop used to write desired=0 INSIDE guarded(), which early-returns
  // the in-flight launch promise → the stop body was swallowed → the completing launch resurrected
  // desired=1 → the terminal leader got relaunched. Stop must now be authoritative: synchronous
  // desired=0 + a launch-tail re-check that refuses to let the completion stand.
  test("F2: a stop racing an in-flight relaunch wins — the completing launch does NOT resurrect desired=1", async () => {
    const { runner, calls, live } = makeFake();
    harnessMod.setRunner(runner);

    // A launcher whose launch BLOCKS on a gate (keeps launchInFlight set), then — like the real
    // one — writes desired=1 as its LAST step (the dangerous resurrecting write).
    let releaseGate!: () => void;
    const gate = new Promise<void>((res) => {
      releaseGate = res;
    });
    const gatedLauncher: WorkspaceLauncher = {
      async launch(row, fresh) {
        calls.launch.push({ id: row.id, fresh });
        await gate; // slow pane start — launchInFlight stays set across this await
        dbMod.saveWorkspaceAgentRow(row.id, {
          session_id: row.session_id ?? `sess-${row.id}`,
          started_at: dbMod.nowIso(),
          desired: 1,
          has_agent: 1,
          last_error: null,
        });
        live.add(wa.workspaceAgentName(row));
      },
      async teardown(name) {
        calls.teardown.push(name);
        live.delete(name);
      },
    };
    wa.setLauncherForTest(gatedLauncher);

    insertStory("st-f2", "open"); // OPEN at relaunch time, so the relaunch actually starts
    insertTask("st-f2");
    dbMod.saveWorkspaceAgentRow("ws-f2", {
      kind: "leader",
      directory_id: DIR,
      work_id: "st-f2",
      desired: 1,
      has_agent: 1,
      session_id: "sess-ws-f2",
    });
    // Pane DEAD → the relaunch path. Fire the tick WITHOUT awaiting (it parks on the gate).
    const name = wa.workspaceAgentName(dbMod.getWorkspaceAgentRow("ws-f2")!);
    const tickP = wa._superviseTickForTest("ws-f2");
    await flush(); // let the relaunch reach launcher.launch → launchInFlight now set
    expect(calls.launch.length).toBe(1); // relaunch is IN FLIGHT

    // Concurrently: the story goes terminal → teardown → stopWorkspaceAgent. desired=0 lands
    // SYNCHRONOUSLY even though guarded() swallows the stop body (in-flight launch claim).
    storiesMod.updateStory("st-f2", { status: "done" });
    expect(dbMod.getWorkspaceAgentRow("ws-f2")!.desired).toBe(0); // stop won synchronously

    // Now let the in-flight launch COMPLETE: its desired=1 write must NOT stand.
    releaseGate();
    await tickP;
    await flush();

    expect(dbMod.getWorkspaceAgentRow("ws-f2")!.desired).toBe(0); // NOT resurrected — stop wins
    expect(calls.teardown).toContain(name); // the freshly-launched pane was torn back down
    expect((await wa.workspaceAgentStatus("ws-f2")).running).toBe(false);
  });

  // ---- ADOPT-PATH startup auto-confirm (story st-a57a552e, subtask A) -------------------
  // An operator workspace can be ADOPTED while still parked at a blocking startup prompt
  // (butchr restarted during the launch auto-confirm window, leaving the operator frozen at
  // the dev-channels consent / folder-trust dialog with 0 children). The adopt branch must
  // run the SAME one-shot, de-bounced auto-confirm the launch path uses — but ONLY ever send
  // a keystroke while a prompt is actually on screen, so a working leader is never disturbed.

  test("adopt while PARKED at the dev-channels consent → exactly ONE confirming keystroke, then quiet", async () => {
    const { runner, launcher, calls, live } = makeFake();
    const sends: Array<{ name: string; input: unknown }> = [];
    // The pane is parked at the dev-channels consent box, then loads its live working UI after
    // the confirm — the `esc to interrupt` ACTIVE pane is the genuine past-startup signal that
    // ends the poll (a BLANK pane would keep polling, per the dev-channels-give-up fix).
    const ACTIVE = "  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt";
    const screens = [
      "❯ 1. I am using this for local development\n--dangerously-load-development-channels",
      ACTIVE,
      ACTIVE,
    ];
    let readIdx = 0;
    runner.agentRead = async () => screens[Math.min(readIdx++, screens.length - 1)];
    runner.send = async (name, input) => { sends.push({ name, input }); };
    harnessMod.setRunner(runner);
    wa.setLauncherForTest(launcher);

    // Let the de-bounce loop run more than the default single poll (then restore).
    const savedMax = cfgMod.config.ctoPromptMaxPolls;
    const savedQuiet = cfgMod.config.ctoPromptQuietPolls;
    cfgMod.config.ctoPromptMaxPolls = 6;
    cfgMod.config.ctoPromptQuietPolls = 2;
    try {
      dbMod.saveWorkspaceAgentRow("w-adopt", { kind: "cto", directory_id: DIR, session_id: "sess-adopt" });
      // The operator's pane is already registered/alive → the adopt branch is taken.
      live.add(wa.workspaceAgentName(dbMod.getWorkspaceAgentRow("w-adopt")!));

      const status = await wa.startWorkspaceAgent("w-adopt");

      expect(calls.launch.length).toBe(0); // adopted, NOT relaunched
      expect(status.running).toBe(true);
      // The auto-confirm is now DETACHED (fire-and-forget) so adopt returns without awaiting
      // the poll — wait (bounded) for the probe to issue its single keystroke, then confirm it
      // stays exactly one (the de-bounce holds across its remaining quiet reads).
      await waitFor(() => sends.length >= 1);
      await flush();
      // Exactly ONE confirming keystroke (the consent's option 1), then nothing more once quiet.
      expect(sends.length).toBe(1);
      expect(sends[0].input).toEqual({ text: "1", enter: true });
    } finally {
      cfgMod.config.ctoPromptMaxPolls = savedMax;
      cfgMod.config.ctoPromptQuietPolls = savedQuiet;
    }
  });

  test("adopt while already QUIET/working → NO keystroke is ever sent (a working leader is never disturbed)", async () => {
    const { runner, launcher, calls, live } = makeFake();
    const sends: Array<{ name: string; input: unknown }> = [];
    let reads = 0;
    // Already past startup — a live, WORKING leader pane (the `esc to interrupt` ACTIVE UI). This
    // is the genuine past-startup signal that ends the poll; a working pane is `active`, not blank.
    runner.agentRead = async () => {
      reads++;
      return "  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt";
    };
    runner.send = async (name, input) => { sends.push({ name, input }); };
    harnessMod.setRunner(runner);
    wa.setLauncherForTest(launcher);

    const savedMax = cfgMod.config.ctoPromptMaxPolls;
    const savedQuiet = cfgMod.config.ctoPromptQuietPolls;
    cfgMod.config.ctoPromptMaxPolls = 6;
    cfgMod.config.ctoPromptQuietPolls = 2;
    try {
      insertTask("st-quiet"); // FK target for the leader's work_id
      dbMod.saveWorkspaceAgentRow("w-quiet", {
        kind: "leader",
        directory_id: DIR,
        work_id: "st-quiet",
        session_id: "sess-quiet",
      });
      live.add(wa.workspaceAgentName(dbMod.getWorkspaceAgentRow("w-quiet")!));

      const status = await wa.startWorkspaceAgent("w-quiet");

      expect(calls.launch.length).toBe(0); // adopted
      expect(status.running).toBe(true);
      // The probe is DETACHED — bounded-wait for it to actually run its quiet reads to the
      // de-bounce exit, THEN assert it never sent a keystroke into a working leader.
      await waitFor(() => reads >= cfgMod.config.ctoPromptQuietPolls);
      await flush();
      expect(sends.length).toBe(0); // the quiet-poll de-bounce gate held — nothing sent
    } finally {
      cfgMod.config.ctoPromptMaxPolls = savedMax;
      cfgMod.config.ctoPromptQuietPolls = savedQuiet;
    }
  });

  // ---- HOTFIX Bug 1, acceptance (a): the boot/reconcile critical path MUST NOT block on the
  // per-workspace startup poll. Root cause of the 0.9.136 crash-loop: adoptOrLaunch AWAITED
  // autoConfirmWorkspaceStartup, so an operator pane that never goes quiet burned the full
  // maxPolls×pollMs budget and gated the port bind. The confirm is now fire-and-forget — this
  // test pins that with a NEVER-resolving read: if adopt still awaited the probe it would
  // deadlock on the gated read and this test would TIME OUT.
  test("adopt RETURNS PROMPTLY without awaiting the startup poll (never-quiet pane cannot block reconcile)", async () => {
    const { runner, launcher, calls, live } = makeFake();
    // The startup read BLOCKS forever (a pane that never classifies as quiet) until the test
    // releases it in `finally`, so the detached probe can finish and not leak.
    let releaseRead!: () => void;
    const readGate = new Promise<void>((r) => { releaseRead = r; });
    let readEntered = false;
    let readReturned = false;
    runner.agentRead = async () => {
      readEntered = true;
      await readGate; // block — the per-pane poll can never complete on its own
      readReturned = true;
      // ACTIVE once released (the live `esc to interrupt` UI), so the detached probe concludes
      // at `quietPolls` and exits cleanly (no leak). A BLANK read would keep polling to maxPolls
      // (the dev-channels-give-up fix), so we hand it the genuine past-startup signal instead.
      return "  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt";
    };
    harnessMod.setRunner(runner);
    wa.setLauncherForTest(launcher);

    // Give the poll a real (large) budget — the point is that adopt does NOT wait on it.
    const savedMax = cfgMod.config.ctoPromptMaxPolls;
    cfgMod.config.ctoPromptMaxPolls = 1000;
    try {
      dbMod.saveWorkspaceAgentRow("w-detach", { kind: "cto", directory_id: DIR, session_id: "sess-detach" });
      live.add(wa.workspaceAgentName(dbMod.getWorkspaceAgentRow("w-detach")!)); // live → adopt branch

      // Had adoptOrLaunch awaited the probe, this would never resolve (the read is gated open).
      const status = await wa.startWorkspaceAgent("w-detach");

      expect(calls.launch.length).toBe(0); // adopted, NOT relaunched
      expect(status.running).toBe(true);
      // The detached probe was kicked but is STILL PENDING on the gated read — the not-yet-
      // resolved seam proving the critical path returned without awaiting the poll.
      expect(readEntered).toBe(true);
      expect(readReturned).toBe(false);
    } finally {
      releaseRead(); // unblock the detached probe so it finishes (no dangling promise)
      await waitFor(() => readReturned).catch(() => {});
      await flush();
      cfgMod.config.ctoPromptMaxPolls = savedMax;
    }
  });
});

// unregisterWorkspace must close the teardown-vs-relaunch RACE on the UNIFIED `workspace`
// rows (story st-93384200 Bug 2): it marks the directory's cto/leader rows desired=0 as the
// VERY FIRST teardown action — before any pane is closed BY NAME — so no supervise tick can
// relaunch a just-closed pane during the teardown -> DELETE window. As of REVAMP-1 Phase C
// (S3) the CTO teardown itself routes through the UNIFIED stopWorkspaceAgent (the compat
// stopCtoAgent is now a thin `ws-cto-<id>` wrapper), so the pane close IS the unified
// launcher.teardown; the legacy harness.teardownTask-by-name path is gone. The rows
// themselves still cascade away on the DELETE (FK ON DELETE CASCADE).
describe("unregisterWorkspace race-prevention (st-93384200 Bug 2)", () => {
  test("a supervise tick during teardown does NOT relaunch the cto/leader rows", async () => {
    const UDIR = "dir-unreg-race";
    const ctoId = `ws-cto-${UDIR}`;
    const leaderId = "ws-leader-st-unreg-race";
    insertDir(UDIR);

    const { runner, launcher, calls, live } = makeFake();
    // Materialize live (desired=1, has_agent=1, registered) unified cto + leader rows.
    dbMod.saveWorkspaceAgentRow(ctoId, {
      kind: "cto", directory_id: UDIR, desired: 1, has_agent: 1, session_id: "sess-cto",
    });
    dbMod.saveWorkspaceAgentRow(leaderId, {
      kind: "leader", directory_id: UDIR, desired: 1, has_agent: 1, session_id: "sess-leader",
    });
    const ctoName = wa.workspaceAgentName(dbMod.getWorkspaceAgentRow(ctoId)!);
    const leaderName = wa.workspaceAgentName(dbMod.getWorkspaceAgentRow(leaderId)!);
    live.add(ctoName);
    live.add(leaderName);

    // The unified stop tears down each pane via launcher.teardown (stopWorkspaceAgent writes
    // desired=0 SYNCHRONOUSLY before its first await). We fire a supervise tick from INSIDE
    // teardown to prove the race is closed:
    //   (a) after EACH teardown — a tick while a pane may still be live: desired=0 (or a still-
    //       alive sibling) means no relaunch.
    //   (b) once BOTH unified rows are down (by the leader's teardown — unregisterWorkspace
    //       stops ws-cto first, then the leader): simulate BOTH panes already killed (names
    //       dropped from `live`), THEN tick. The early desired=0 must STILL prevent any relaunch
    //       even with the panes provably dead. (Were the unified stop deferred to just before
    //       the DELETE, desired would still be 1 here and these ticks WOULD relaunch — the
    //       regression this test guards.)
    const origTeardown = launcher.teardown;
    let firedDeadPaneTick = false;
    launcher.teardown = async (name: string) => {
      await origTeardown(name);
      await wa._superviseTickForTest(ctoId);
      await wa._superviseTickForTest(leaderId);
      if (name === leaderName && !firedDeadPaneTick) {
        firedDeadPaneTick = true;
        live.delete(ctoName);
        live.delete(leaderName);
        await wa._superviseTickForTest(ctoId);
        await wa._superviseTickForTest(leaderId);
      }
    };
    harnessMod.setRunner(runner);
    wa.setLauncherForTest(launcher);

    await dirsMod.unregisterWorkspace(UDIR);

    expect(firedDeadPaneTick).toBe(true); // the both-panes-dead teardown-window tick really ran
    // NO relaunch happened for either row across ANY of the ticks.
    expect(calls.launch).toHaveLength(0);
  });

  test("after unregister NO unified workspace rows remain for the directory (cascade)", async () => {
    const UDIR = "dir-unreg-cascade";
    insertDir(UDIR);
    dbMod.saveWorkspaceAgentRow(`ws-cto-${UDIR}`, { kind: "cto", directory_id: UDIR, desired: 1 });
    dbMod.saveWorkspaceAgentRow("ws-leader-st-unreg-cascade", {
      kind: "leader", directory_id: UDIR, desired: 1,
    });
    expect(
      dbMod.db.query(`SELECT COUNT(*) AS n FROM workspace WHERE directory_id=?`).get(UDIR),
    ).toMatchObject({ n: 2 });

    const { runner, launcher } = makeFake();
    harnessMod.setRunner(runner);
    wa.setLauncherForTest(launcher);

    await dirsMod.unregisterWorkspace(UDIR);

    expect(
      dbMod.db.query(`SELECT COUNT(*) AS n FROM workspace WHERE directory_id=?`).get(UDIR),
    ).toMatchObject({ n: 0 });
  });
});

// ── CTO-COMPAT SURFACE (REVAMP-1 Phase C, S3) ───────────────────────────────
// The /api/workspaces/:id/cto/* routes (server.ts) + unregisterWorkspace teardown now call
// the thin CTO-compat wrappers in workspace-agent.ts (the legacy per-workspace launcher was
// deleted in Phase C S5). These prove the two invariants the dashboard depends on: (1) the route
// response is the legacy CtoStatus SHAPE (keyed by the directory id, enabled from cto_enabled);
// (2) the LIFECYCLE ops (start/stop/restart) re-publish `cto.updated` exactly as legacy
// publishStatus did, while the STATUS read does NOT publish.
describe("CTO-compat surface via the unified workspace table (Phase C S3)", () => {
  const CDIR = "dir-cto-compat";
  const CWS = `ws-cto-${CDIR}`;
  let savedGlobalCtoEnabled: boolean;

  /** Capture published `cto.updated` events. */
  function captureCto() {
    const events: Array<{ cto: Record<string, unknown> }> = [];
    const unsub = eventsMod.subscribe((e) => {
      if ((e as { type?: string }).type === "cto.updated") {
        events.push(e as unknown as { cto: Record<string, unknown> });
      }
    });
    return { events, unsub };
  }

  beforeEach(() => {
    savedGlobalCtoEnabled = cfgMod.config.ctoAgentEnabled;
    cfgMod.config.ctoAgentEnabled = true; // directory has no override → global default enables it
    insertDir(CDIR);
    dbMod.saveWorkspaceAgentRow(CWS, {
      kind: "cto", directory_id: CDIR, desired: 1, has_agent: 1, session_id: "sess-cto-compat",
    });
  });
  afterEach(() => {
    cfgMod.config.ctoAgentEnabled = savedGlobalCtoEnabled;
    wa.setLauncherForTest(null);
    wa._resetSupervisionStateForTest(CWS);
    dbMod.db.query(`DELETE FROM workspace WHERE directory_id=?`).run(CDIR);
    dbMod.db.query(`DELETE FROM workspaces WHERE id=?`).run(CDIR);
  });

  test("ctoAgentStatus returns the legacy CtoStatus shape (keyed by directory id) and does NOT publish", async () => {
    const { runner, launcher, live } = makeFake();
    harnessMod.setRunner(runner);
    wa.setLauncherForTest(launcher);
    live.add(wa.ctoAgentName(CDIR)); // pane registered/alive

    const { events, unsub } = captureCto();
    const s = await wa.ctoAgentStatus(CDIR);
    unsub();

    // Exact legacy CtoStatus shape — the dashboard contract (server.ts GET /cto).
    expect(Object.keys(s).sort()).toEqual(
      ["desired", "enabled", "lastError", "restarts", "running", "sessionId", "since", "workspaceId"],
    );
    expect(s.workspaceId).toBe(CDIR); // keyed by the DIRECTORY id, not the ws-cto row id
    expect(s.enabled).toBe(true); // isCtoEnabled(dir)
    expect(s.desired).toBe(true);
    expect(s.running).toBe(true);
    expect(s.sessionId).toBe("sess-cto-compat");
    expect(events).toHaveLength(0); // a READ never publishes cto.updated
  });

  test("startCtoAgent / stopCtoAgent publish cto.updated with the CtoStatus payload", async () => {
    const { runner, launcher } = makeFake();
    harnessMod.setRunner(runner);
    wa.setLauncherForTest(launcher);

    const { events, unsub } = captureCto();
    const started = await wa.startCtoAgent(CDIR);
    expect(started.workspaceId).toBe(CDIR);
    expect(events).toHaveLength(1); // start published exactly one cto.updated
    expect(events[0]!.cto).toMatchObject({ workspaceId: CDIR, desired: true });

    const stopped = await wa.stopCtoAgent(CDIR);
    unsub();
    expect(stopped.workspaceId).toBe(CDIR);
    expect(stopped.desired).toBe(false);
    expect(events).toHaveLength(2); // stop published a second cto.updated
    expect(events[1]!.cto).toMatchObject({ workspaceId: CDIR, desired: false });
  });
});

// ── CTO enable/disable/stop authority through the unified workspace table ────
// (story st-93384200, Bug 1) The unified supervisor must HONOR directory.cto_enabled, and
// the CTO enable/disable/stop flows must drive the unified `workspace` row's `desired` so a
// stray desired=1 row can't keep a disabled CTO alive. MIRROR-AND-DEFER: the legacy
// cto_agent.desired writes are KEPT alongside the (authoritative) unified path.
describe("CTO enable/disable/stop authority via the unified workspace table (st-93384200)", () => {
  const WS_CTO = `ws-cto-${DIR}`;
  let savedGlobalCtoEnabled: boolean;

  /** Set the DIRECTORY's cto_enabled tri-state (the `workspaces`/directory config column). */
  function setDirCtoEnabled(val: number | null): void {
    dbMod.db.query(`UPDATE workspaces SET cto_enabled=? WHERE id=?`).run(val, DIR);
  }

  beforeEach(() => {
    savedGlobalCtoEnabled = cfgMod.config.ctoAgentEnabled;
    cfgMod.config.ctoAgentEnabled = false; // global default OFF — deterministic inherit
    setDirCtoEnabled(null); // no per-dir override unless a test sets one
    dbMod.db.query(`DELETE FROM cto_agent`).run(); // legacy mirror table — clean slate
  });

  afterEach(() => {
    cfgMod.config.ctoAgentEnabled = savedGlobalCtoEnabled;
    setDirCtoEnabled(null);
  });

  test("disabling a CTO (setWorkspaceCtoEnabled false) sets unified desired=0 and the supervisor does NOT relaunch", async () => {
    const { runner, launcher, calls, live } = makeFake();
    harnessMod.setRunner(runner);
    wa.setLauncherForTest(launcher);
    setDirCtoEnabled(1); // currently ENABLED
    dbMod.saveWorkspaceAgentRow(WS_CTO, {
      kind: "cto", directory_id: DIR, desired: 1, has_agent: 1, session_id: "sess-c",
    });
    const name = wa.workspaceAgentName(dbMod.getWorkspaceAgentRow(WS_CTO)!);
    live.add(name);

    await dirsMod.setWorkspaceCtoEnabled(DIR, false);

    // Unified row driven DESIRED-down + torn down immediately.
    expect(dbMod.getWorkspaceAgentRow(WS_CTO)!.desired).toBe(0);
    expect(calls.teardown).toContain(name);
    // Supervisor does NOT relaunch it.
    await wa._superviseTickForTest(WS_CTO);
    expect(calls.launch.length).toBe(0);
    // Reconcile reports it stopped (the cto-kind gate).
    expect((await wa.reconcileWorkspaceAgent(WS_CTO, true)).action).toBe("stopped");
  });

  test("a stray desired=1 ws-cto row with cto_enabled effectively false is NOT launched (the gate stops it)", async () => {
    const { runner, launcher, calls } = makeFake();
    harnessMod.setRunner(runner);
    wa.setLauncherForTest(launcher);
    // Global default OFF, no per-dir override → effectively disabled, yet a leaked desired=1.
    dbMod.saveWorkspaceAgentRow(WS_CTO, { kind: "cto", directory_id: DIR, desired: 1 });

    // The supervise gate short-circuits BEFORE the dead-while-desired relaunch branch.
    await wa._superviseTickForTest(WS_CTO);
    expect(calls.launch.length).toBe(0);

    // Reconcile stops the stray row (desired zeroed).
    expect((await wa.reconcileWorkspaceAgent(WS_CTO, true)).action).toBe("stopped");
    expect(dbMod.getWorkspaceAgentRow(WS_CTO)!.desired).toBe(0);
  });

  test("re-enabling a CTO (setWorkspaceCtoEnabled true) ensures the row + sets desired=1 and the supervisor launches it", async () => {
    const { runner, launcher, calls } = makeFake();
    harnessMod.setRunner(runner);
    wa.setLauncherForTest(launcher);
    // No ws-cto row yet — re-enable must CREATE it (ensureWorkspaceAgentRow) and set desired=1.
    expect(dbMod.getWorkspaceAgentRow(WS_CTO)).toBeNull();

    await dirsMod.setWorkspaceCtoEnabled(DIR, true);

    const row = dbMod.getWorkspaceAgentRow(WS_CTO)!;
    expect(row).not.toBeNull();
    expect(row.kind).toBe("cto");
    expect(row.directory_id).toBe(DIR);
    expect(row.desired).toBe(1);
    // The supervisor now launches the dead-but-desired, enabled row.
    await wa._superviseTickForTest(WS_CTO);
    expect(calls.launch.map((c) => c.id)).toEqual([WS_CTO]);
  });

  test("the cto/stop path sets unified desired=0 (transient — cto_enabled unchanged)", async () => {
    const { runner, launcher, calls, live } = makeFake();
    harnessMod.setRunner(runner);
    wa.setLauncherForTest(launcher);
    setDirCtoEnabled(1); // ENABLED — a transient stop must NOT flip this
    dbMod.saveWorkspaceAgentRow(WS_CTO, {
      kind: "cto", directory_id: DIR, desired: 1, has_agent: 1, session_id: "sess-s",
    });
    const name = wa.workspaceAgentName(dbMod.getWorkspaceAgentRow(WS_CTO)!);
    live.add(name);

    await wa.stopCtoAgent(DIR);

    // Unified row driven DESIRED-down + torn down.
    expect(dbMod.getWorkspaceAgentRow(WS_CTO)!.desired).toBe(0);
    expect(calls.teardown).toContain(name);
    // Transient: cto_enabled is unchanged (re-enable/boot can bring it back up).
    expect(dirsMod.isCtoEnabled(DIR)).toBe(true);
    // And the supervisor does not relaunch the desired-down row.
    await wa._superviseTickForTest(WS_CTO);
    expect(calls.launch.length).toBe(0);
  });
});

// ---- MID-SESSION PANE PROBE for OPERATOR workspaces (story st-a57a552e, subtask B) --------
// The supervisor is /proc-liveness-only and never reads a live pane, so an operator (cto/leader)
// parked at a blocking startup/permission dialog AFTER launch hangs silently with 0 progress.
// This is the ongoing mid-session safety net: a throttled, genuine-idle-gated read+classify+act
// mirroring the build-agent probe — a recognized dialog is auto-confirmed, an unrecognized one is
// surfaced via the workspace row's last_error, an active agent is left completely alone.
describe("operator mid-session pane probe (probeWorkspaceForPrompt — logic)", () => {
  // A minimal in-memory deps over a fake last_error store. `idle` defaults to true so the
  // classify→act cases run; an idle=false deps leaves the agent untouched.
  function makeDeps(
    screen: string | (() => Promise<string>),
    err = { v: null as string | null },
    idle = true,
    rules: ConfirmRule[] | undefined = undefined,
  ) {
    const calls = { reads: 0, sends: [] as SendInput[], setError: [] as Array<string | null> };
    return {
      err,
      calls,
      deps: {
        read: typeof screen === "function" ? screen : async () => { calls.reads++; return screen; },
        send: async (_n: string, input: SendInput) => { calls.sends.push(input); },
        idle: () => idle,
        getError: () => err.v,
        setError: (_id: string, msg: string | null) => { err.v = msg; calls.setError.push(msg); },
        rules,
      },
    };
  }

  test("auto-confirms a MATCHED prompt (sends the safe response)", async () => {
    const { deps, calls } = makeDeps(
      "WARNING: Loading development channels\n  1. I am using this for local development\n  2. Exit",
    );
    await wa.probeWorkspaceForPrompt("w", "n", deps);
    expect(calls.sends).toEqual([{ text: "1", enter: true }]);
  });

  test("SURFACES an UNMATCHED prompt-like pane via last_error (sentinel-prefixed snapshot)", async () => {
    // strictStuck (st-a32c8138 scope 5): the mid-session probe surfaces only a REAL dialog anchor,
    // not a bare numbered list. A GENUINE blocking dialog (y/n) that NO rule can auto-answer
    // (empty rules) still reaches `stuck` → surfaced.
    const stuck = "Some tool wants permission — allow? (y/n)";
    const { deps, calls, err } = makeDeps(stuck, { v: null }, true, []);
    await wa.probeWorkspaceForPrompt("w", "n", deps);
    expect(calls.sends).toEqual([]); // no rule → no safe keystroke
    expect(err.v?.startsWith(wa.WORKSPACE_STUCK_PREFIX)).toBe(true);
    expect(err.v).toContain("permission");
  });

  test("does NOT surface a BARE numbered-list pane (the false-positive fix, strictStuck)", async () => {
    // The exact false-positive: an active operator between turns whose pane shows ordinary
    // numbered output. Under strictStuck this is `quiet` → NOT surfaced, no keystroke.
    const { deps, calls, err } = makeDeps("Some tool wants permission:\n  1. Accept\n  2. Reject");
    await wa.probeWorkspaceForPrompt("w", "n", deps);
    expect(calls.sends).toEqual([]);
    expect(err.v).toBeNull();
  });

  test("a 'quiet' read CLEARS a prior probe-set signal (self-clearing lifecycle)", async () => {
    const { deps, calls } = makeDeps("● running normally — no prompt", {
      v: wa.WORKSPACE_STUCK_PREFIX + "old stuck screen",
    });
    await wa.probeWorkspaceForPrompt("w", "n", deps);
    expect(calls.sends).toEqual([]);
    expect(calls.setError).toEqual([null]);
  });

  test("a 'quiet' read NEVER clobbers a genuine (non-sentinel) launch error", async () => {
    const { deps, calls, err } = makeDeps("● running normally", { v: "launch boom" });
    await wa.probeWorkspaceForPrompt("w", "n", deps);
    expect(calls.setError).toEqual([]); // left intact — not our signal
    expect(err.v).toBe("launch boom");
  });

  test("auto-confirming a matched prompt ALSO clears a stale probe-set signal", async () => {
    const { deps, calls } = makeDeps("Do you trust the files in this folder?\n  1. Yes\n  2. No", {
      v: wa.WORKSPACE_STUCK_PREFIX + "earlier stuck",
    });
    await wa.probeWorkspaceForPrompt("w", "n", deps);
    expect(calls.sends).toEqual([{ text: "1", enter: true }]);
    expect(calls.setError).toEqual([null]);
  });

  test("GENUINE-IDLE GATE: an ACTIVE agent (idle=false) is a COMPLETE no-op (never read)", async () => {
    const stuck = "Some tool wants permission:\n  1. Accept\n  2. Reject";
    const { deps, calls } = makeDeps(stuck, { v: null }, /* idle */ false);
    await wa.probeWorkspaceForPrompt("w", "n", deps);
    expect(calls.reads).toBe(0); // not even read — the agent is producing output
    expect(calls.sends).toEqual([]);
    expect(calls.setError).toEqual([]);
  });

  test("best-effort: a READ failure does nothing (no send, no signal change)", async () => {
    const { deps, calls } = makeDeps(async () => { throw new Error("pane gone"); });
    await expect(wa.probeWorkspaceForPrompt("w", "n", deps)).resolves.toBeUndefined();
    expect(calls.sends).toEqual([]);
    expect(calls.setError).toEqual([]);
  });

  test("best-effort: a SEND failure on a matched prompt is swallowed (still clears stale signal)", async () => {
    const err = { v: wa.WORKSPACE_STUCK_PREFIX + "earlier" };
    const setError: Array<string | null> = [];
    const deps = {
      read: async () => "  1. I am using this for local development\n  2. Exit",
      send: async () => { throw new Error("dead pane"); },
      idle: () => true,
      getError: () => err.v as string | null,
      setError: (_id: string, msg: string | null) => { err.v = msg as string; setError.push(msg); },
    };
    await expect(wa.probeWorkspaceForPrompt("w", "n", deps)).resolves.toBeUndefined();
    expect(setError).toEqual([null]);
  });
});

describe("operator mid-session pane probe (superviseWorkspace wiring)", () => {
  /**
   * Set the workspace's agent.log mtime to `agoMs` in the past — the genuine-idle seam.
   * Writes under `config.dataDir` (what `workspaceQuietMs` reads), NOT the local DATA_DIR:
   * bun shares the `config` singleton across test files, so config.dataDir may be a different
   * file's temp dir in the full suite — using it directly keeps the seam robust to import order.
   */
  function setAgentLog(id: string, agoMs: number): void {
    const dir = join(cfgMod.config.dataDir, "workspace", id);
    mkdirSync(dir, { recursive: true });
    const f = join(dir, "agent.log");
    writeFileSync(f, "x");
    const t = (Date.now() - agoMs) / 1000;
    utimesSync(f, t, t);
  }
  const IDLE = 600_000; // quietMs (600s) >> idleMs (60s) → genuinely idle
  const ACTIVE = 0; //      quietMs (~0) <= idleMs → actively working

  // The supervisor gates kind='cto' rows on directory.cto_enabled (st-93384200, Bug 1), short-
  // circuiting BEFORE the live/probe branch — so a cto-kind probe case must enable it; reset after
  // so the flag never leaks into sibling tests that rely on the default-off behaviour.
  afterEach(() => {
    dbMod.db.query(`UPDATE workspaces SET cto_enabled=NULL WHERE id=?`).run(DIR);
  });

  /** Seed a LIVE, desired-up operator workspace and register its name so agentExists is true. */
  function seedLive(id: string, kind: "cto" | "leader", live: Set<string>): string {
    dbMod.saveWorkspaceAgentRow(id, {
      kind,
      directory_id: DIR,
      desired: 1,
      has_agent: 1,
      session_id: `sess-${id}`,
    });
    const name = wa.workspaceAgentName(dbMod.getWorkspaceAgentRow(id)!);
    live.add(name);
    return name;
  }

  test("1. RECOGNIZED dialog on a genuinely-idle operator → exactly ONE confirming keystroke", async () => {
    const { runner, launcher, live } = makeFake();
    const sends: Array<{ name: string; input: unknown }> = [];
    runner.agentRead = async () => "  1. I am using this for local development\n  2. Exit";
    runner.send = async (name, input) => { sends.push({ name, input }); };
    harnessMod.setRunner(runner);
    wa.setLauncherForTest(launcher);
    dbMod.db.query(`UPDATE workspaces SET cto_enabled=1 WHERE id=?`).run(DIR); // cto-kind: pass the cto_enabled gate
    const name = seedLive("w-rule", "cto", live);
    setAgentLog("w-rule", IDLE);

    await wa._superviseTickForTest("w-rule");

    expect(sends).toEqual([{ name, input: { text: "1", enter: true } }]);
    expect(dbMod.getWorkspaceAgentRow("w-rule")!.last_error).toBeNull();
  });

  test("2. a BARE numbered-list pane on a genuinely-idle operator → NOT surfaced (false-positive fix)", async () => {
    const { runner, launcher, live } = makeFake();
    const sends: unknown[] = [];
    // The exact false-positive (st-a32c8138 scope 5): an active operator between turns whose
    // agent.log went quiet but whose pane shows ORDINARY numbered output. strictStuck classifies
    // it `quiet` — NOT a stuck dialog — so no last_error is written and no keystroke is sent.
    const numbered = "An unknown mid-run consent:\n  1. Foo\n  2. Bar";
    runner.agentRead = async () => numbered;
    runner.send = async (_n, input) => { sends.push(input); };
    harnessMod.setRunner(runner);
    wa.setLauncherForTest(launcher);
    seedLive("w-stuck", "leader", live);
    setAgentLog("w-stuck", IDLE);

    await wa._superviseTickForTest("w-stuck");

    const err = dbMod.getWorkspaceAgentRow("w-stuck")!.last_error;
    expect(err).toBeNull();
    expect(sends).toEqual([]); // ordinary output → nothing sent
  });

  test("3. an ACTIVE leader (log fresh) → COMPLETE no-op: pane is NEVER read, no keystroke/signal", async () => {
    const { runner, launcher, live } = makeFake();
    const reads: string[] = [];
    const sends: unknown[] = [];
    runner.agentRead = async (name) => { reads.push(name); return "  1. Accept\n  2. Reject"; };
    runner.send = async (_n, input) => { sends.push(input); };
    harnessMod.setRunner(runner);
    wa.setLauncherForTest(launcher);
    seedLive("w-active", "leader", live);
    setAgentLog("w-active", ACTIVE); // fresh log → not genuinely idle

    await wa._superviseTickForTest("w-active");

    expect(reads).toEqual([]); // the genuine-idle gate held — pane never read
    expect(sends).toEqual([]);
    expect(dbMod.getWorkspaceAgentRow("w-active")!.last_error).toBeNull();
  });

  test("4. THROTTLE: the pane is read only on the cadence, not every supervise tick", async () => {
    cfgMod.config.ctoMidProbeEverySupervisions = 3;
    const { runner, launcher, live } = makeFake();
    const reads: number[] = [];
    runner.agentRead = async () => { reads.push(1); return "● working, no prompt"; };
    harnessMod.setRunner(runner);
    wa.setLauncherForTest(launcher);
    seedLive("w-throttle", "leader", live); // leader kind → kind-agnostic throttle, no cto_enabled gate
    setAgentLog("w-throttle", IDLE);

    for (let i = 0; i < 7; i++) await wa._superviseTickForTest("w-throttle");

    // every=3 over 7 ticks → reads fire on ticks 3 and 6 only.
    expect(reads.length).toBe(2);
  });

  test("5. SELF-CLEAR: a prior probe-set stuck signal is cleared once a later read goes quiet", async () => {
    const { runner, launcher, live } = makeFake();
    runner.agentRead = async () => "● back to work, no prompt"; // quiet/ordinary output
    harnessMod.setRunner(runner);
    wa.setLauncherForTest(launcher);
    seedLive("w-selfclear", "leader", live); // leader kind → kind-agnostic, no cto_enabled gate
    setAgentLog("w-selfclear", IDLE);
    // Seed a prior probe-set stuck signal (an earlier surfaced dialog the agent has since moved
    // past) so we exercise the self-clear path independent of what currently reaches `stuck`.
    dbMod.saveWorkspaceAgentRow("w-selfclear", {
      last_error: wa.WORKSPACE_STUCK_PREFIX + "earlier surfaced dialog",
    });

    // The pane is now quiet → the probe clears its OWN prior signal.
    await wa._superviseTickForTest("w-selfclear");
    expect(dbMod.getWorkspaceAgentRow("w-selfclear")!.last_error).toBeNull();
  });

  test("a BUILD-kind workspace is never pane-probed (operator kinds only)", async () => {
    const { runner, launcher, live } = makeFake();
    const reads: string[] = [];
    runner.agentRead = async (name) => { reads.push(name); return "  1. Accept\n  2. Reject"; };
    harnessMod.setRunner(runner);
    wa.setLauncherForTest(launcher);
    insertTask("task-probe");
    dbMod.saveWorkspaceAgentRow("w-build", {
      kind: "build",
      directory_id: DIR,
      work_id: "task-probe",
      desired: 1,
      has_agent: 1,
      session_id: "sess-build",
    });
    live.add(wa.workspaceAgentName(dbMod.getWorkspaceAgentRow("w-build")!));
    setAgentLog("w-build", IDLE);

    await wa._superviseTickForTest("w-build");

    expect(reads).toEqual([]); // build kind → no mid-session pane probe here
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

// ---- CREATE-TIME UNIFIED ROWS (story st-93384200, Bug 3) ----------------------------------
// A CTO/leader created (workspace registered / story created) AFTER boot must get its UNIFIED
// `workspace` row at CREATION time so the unified supervisor — the SOLE launcher when the flag
// is ON — owns it immediately (launch AND relaunch-on-death) without waiting for a restart to
// re-seed it from the legacy tables. These drive the real lifecycle hooks (ensureCtoWorkspaceRow
// for the cto row; storiesMod.createStory → onStoryCreated for the leader row) through the same
// injected launcher seam the rest of this file uses.
describe("create-time unified rows (st-93384200 Bug 3)", () => {
  test("a story created mid-uptime gets a desired-up ws-leader row; the create-time kick launches it once; a racing supervise tick does NOT double-launch; on death the supervisor RELAUNCHES (no restart)", async () => {
    const { runner, launcher, calls, live } = makeFake();
    harnessMod.setRunner(runner);
    wa.setLauncherForTest(launcher);

    const story = storiesMod.createStory(DIR, "mid-uptime story");
    const wsId = `ws-leader-${story.id}`;
    const leaderLaunches = () => calls.launch.filter((c) => c.id === wsId).length;

    // The unified row is created SYNCHRONOUSLY in onStoryCreated (the launch kick is async).
    const r0 = dbMod.getWorkspaceAgentRow(wsId)!;
    expect(r0).toBeTruthy();
    expect(r0.kind).toBe("leader");
    expect(r0.desired).toBe(1);
    expect(r0.work_id).toBe(story.id);
    expect(r0.directory_id).toBe(DIR); // == story.workspace_id → visible to unregister enumeration
    // The FK anchor (the story's materialized Work node) was created so the leader row is FK-valid.
    expect(dbMod.db.query(`SELECT id FROM tasks WHERE id=?`).get(story.id)).toBeTruthy();

    await flush(); // let the create-time kick settle

    // onStoryCreated writes ONLY the desired=1 MIRROR to the legacy story_agent row (no
    // session_id) — the launch runs through the unified ws-leader row, not a story_agent path.
    expect(dbMod.getStoryAgentRow(story.id)?.session_id ?? null).toBeNull();
    expect(dbMod.getStoryAgentRow(story.id)?.desired).toBe(1);

    // The create-time kick launched the leader EXACTLY once and it is now live.
    expect(leaderLaunches()).toBe(1);
    expect(dbMod.getWorkspaceAgentRow(wsId)!.has_agent).toBe(1);

    // NUDGE #1: a supervise tick RIGHT AFTER the kick must NOT double-launch (kick + tick share the
    // SAME per-id launchInFlight guard → the tick adopts the now-live agent, no second launch).
    await wa._superviseTickForTest(wsId);
    expect(leaderLaunches()).toBe(1); // still exactly one agent for this story name

    // RELAUNCH-ON-DEATH with NO restart: the agent dies, then a later supervise tick relaunches it.
    const name = wa.workspaceAgentName(dbMod.getWorkspaceAgentRow(wsId)!);
    live.delete(name); // agent died
    wa._resetSupervisionStateForTest(wsId); // clear backoff so the tick fires immediately
    await wa._superviseTickForTest(wsId);
    expect(leaderLaunches()).toBe(2); // relaunched without any restart
    expect(dbMod.getWorkspaceAgentRow(wsId)!.has_agent).toBe(1); // live again
  });

  test("NUDGE #2: onStoryCreated for a NONEXISTENT story creates NO ws-leader row (never a null-directory_id row)", async () => {
    const { runner, launcher, calls } = makeFake();
    harnessMod.setRunner(runner);
    wa.setLauncherForTest(launcher);

    // No `stories` row for this id → getStoryRow returns null. The hook must bail (record-and-skip),
    // NOT insert a directory_id=null leader row (which would be invisible to unregister enumeration).
    wa.onStoryCreated("st-does-not-exist");
    await flush();

    expect(dbMod.getWorkspaceAgentRow("ws-leader-st-does-not-exist")).toBeNull();
    expect(calls.launch.length).toBe(0); // nothing launched
  });

  test("ensureCtoWorkspaceRow: cto ENABLED → ws-cto row desired=1 and launched (no restart)", async () => {
    const { runner, launcher, calls } = makeFake();
    harnessMod.setRunner(runner);
    wa.setLauncherForTest(launcher);
    dbMod.db.query(`UPDATE workspaces SET cto_enabled=1 WHERE id=?`).run(DIR);

    dirsMod.ensureCtoWorkspaceRow(DIR);
    const wsId = `ws-cto-${DIR}`;
    const r = dbMod.getWorkspaceAgentRow(wsId)!;
    expect(r.kind).toBe("cto");
    expect(r.directory_id).toBe(DIR);
    expect(r.work_id).toBeNull(); // a CTO is not bound to a unit of Work
    expect(r.desired).toBe(1);

    await flush(); // create-time kick
    expect(calls.launch.filter((c) => c.id === wsId).length).toBe(1);
    expect(dbMod.getWorkspaceAgentRow(wsId)!.has_agent).toBe(1);
  });

  test("ensureCtoWorkspaceRow: cto DISABLED → ws-cto row desired=0 and NOT launched", async () => {
    const { runner, launcher, calls } = makeFake();
    harnessMod.setRunner(runner);
    wa.setLauncherForTest(launcher);
    dbMod.db.query(`UPDATE workspaces SET cto_enabled=0 WHERE id=?`).run(DIR);

    dirsMod.ensureCtoWorkspaceRow(DIR);
    const r = dbMod.getWorkspaceAgentRow(`ws-cto-${DIR}`)!;
    expect(r.desired).toBe(0);
    await flush();
    expect(calls.launch.length).toBe(0); // never kicked
  });

  test("ensureCtoWorkspaceRow: cto_enabled NULL + GLOBAL default OFF → ws-cto row desired=0 and NOT launched", async () => {
    const { runner, launcher, calls } = makeFake();
    harnessMod.setRunner(runner);
    wa.setLauncherForTest(launcher);
    cfgMod.config.ctoAgentEnabled = false; // the global default (inherited when the column is NULL)
    dbMod.db.query(`UPDATE workspaces SET cto_enabled=NULL WHERE id=?`).run(DIR);

    dirsMod.ensureCtoWorkspaceRow(DIR);
    const r = dbMod.getWorkspaceAgentRow(`ws-cto-${DIR}`)!;
    expect(r.desired).toBe(0);
    await flush();
    expect(calls.launch.length).toBe(0);
  });

  test("a leader whose story is MERGING / MERGE_BLOCKED is NOT torn down by reconcile OR supervise (keep-alive)", async () => {
    for (const status of ["merging", "merge_blocked"] as const) {
      dbMod.db.query(`DELETE FROM workspace`).run();
      dbMod.db.query(`DELETE FROM tasks`).run(); // node rows live here too post-B.5b
      wa._resetSupervisionStateForTest();
      const { runner, launcher, calls, live } = makeFake();
      harnessMod.setRunner(runner);
      wa.setLauncherForTest(launcher);

      const storyId = `st-keep-${status}`;
      // The materialized story NODE (FK target of the leader's work_id) carrying the story's REAL
      // AUTHORITATIVE transient status, so the B.4-flipped nodeWorkIsTerminal (which reads the node's
      // OWN tasks row through storyStatusOf) sees it. Post-B.5b the node IS the story. isolated=0 is
      // irrelevant here (no PATCH).
      dbMod.db
        .query(`INSERT INTO tasks (id, workspace_id, brief, status, work_kind, isolated, created_at) VALUES (?,?,?,?,'node',0,?)`)
        .run(storyId, DIR, `brief ${storyId}`, status, dbMod.nowIso());
      const wsId = `ws-leader-${storyId}`;
      dbMod.saveWorkspaceAgentRow(wsId, {
        kind: "leader", directory_id: DIR, work_id: storyId, desired: 1, has_agent: 1, session_id: `sess-${wsId}`,
      });
      const name = wa.workspaceAgentName(dbMod.getWorkspaceAgentRow(wsId)!);
      live.add(name); // the leader's pane is registered/alive

      // RECONCILE keeps (adopts) it — a non-terminal node is never stopped.
      const res = await wa.reconcileWorkspaceAgent(wsId, true);
      expect(res.action).toBe("adopted");
      expect(dbMod.getWorkspaceAgentRow(wsId)!.desired).toBe(1);

      // A SUPERVISE tick likewise leaves a live, non-terminal leader untouched (no teardown).
      await wa._superviseTickForTest(wsId);
      expect(calls.teardown).not.toContain(name);
      expect(dbMod.getWorkspaceAgentRow(wsId)!.desired).toBe(1);
      expect((await wa.workspaceAgentStatus(wsId)).running).toBe(true);
    }
  });
});

// OPERATOR-IDLE → HIGHER-UP (story st-a32c8138, PART 1): the durable idle projection, the shared
// noise-rule helper, and the leader→CTO push.
describe("operator-idle → higher-up (story st-a32c8138)", () => {
  /** Insert a leaf task in a given attention state, with optional story membership (story_id +
   *  parent_id → a member whose pending_responder resolves to 'story'; both null → a standalone
   *  task whose responder resolves to 'cto'). */
  function insertLeaf(
    id: string,
    opts: { status: string; story_id?: string | null },
  ): void {
    const story = opts.story_id ?? null;
    if (story) {
      // Materialize the parent story NODE task so parent_id's FK resolves AND resolveWorkResponder
      // (unified routing, default ON) walks parent_id → a 'story' responder for the member.
      dbMod.db
        .query(
          `INSERT OR IGNORE INTO tasks (id, workspace_id, status, work_kind, created_at)
           VALUES (?, ?, 'inactive', 'node', ?)`,
        )
        .run(story, DIR, dbMod.nowIso());
    }
    dbMod.db
      .query(
        `INSERT OR REPLACE INTO tasks (id, workspace_id, status, work_kind, parent_id, created_at)
         VALUES (?, ?, ?, 'leaf', ?, ?)`,
      )
      .run(id, DIR, opts.status, story, dbMod.nowIso());
  }

  /** Capture published `story.attention` events. */
  function captureAttention() {
    const events: Array<Record<string, unknown>> = [];
    const unsub = eventsMod.subscribe((e) => {
      if ((e as { type?: string }).type === "story.attention") {
        events.push(e as unknown as Record<string, unknown>);
      }
    });
    return { events, unsub };
  }

  function seedOperator(id: string, kind: "cto" | "leader", work_id: string | null): void {
    dbMod.saveWorkspaceAgentRow(id, {
      kind,
      directory_id: DIR,
      work_id,
      desired: 1,
      has_agent: 1,
      session_id: `sess-${id}`,
    });
  }

  // Isolate the attention set from any tasks/stories other describes in this file left behind
  // (attentionList queries globally; our partitions are story_id/dir-scoped, but clear to be safe).
  beforeEach(() => {
    dbMod.db.query(`DELETE FROM tasks WHERE workspace_id=?`).run(DIR); // node rows live here too post-B.5b
  });
  afterEach(() => {
    dbMod.db.query(`DELETE FROM tasks WHERE workspace_id=?`).run(DIR);
  });

  // ---- operatorActionableItems: partition the EXISTING attention set the routeOwns way --------

  test("operatorActionableItems — a LEADER owns its story's members (responder 'story' + failed), nothing else", () => {
    insertLeaf("m-review", { status: "in_review", story_id: "st-own" }); // responder 'story'
    insertLeaf("m-failed", { status: "failed", story_id: "st-own" }); // a member failure
    insertLeaf("m-other", { status: "in_review", story_id: "st-other" }); // another story's member
    insertLeaf("t-cto", { status: "in_review", story_id: null }); // a standalone (cto) task

    seedOperator("ws-leader-st-own", "leader", "st-own");
    const items = tasksMod.operatorActionableItems(
      dbMod.getWorkspaceAgentRow("ws-leader-st-own")!,
    );
    const ids = items.map((i) => i.id).sort();
    expect(ids).toEqual(["m-failed", "m-review"]);
  });

  test("operatorActionableItems — the CTO owns the dir's NON-story tasks (responder 'cto' + failed), never a story member", () => {
    insertLeaf("t-cto", { status: "in_review", story_id: null }); // responder 'cto'
    insertLeaf("t-failed", { status: "failed", story_id: null }); // a non-story failure
    insertLeaf("m-review", { status: "in_review", story_id: "st-x" }); // a story member → leader's

    seedOperator("ws-cto-dir", "cto", null);
    const items = tasksMod.operatorActionableItems(
      dbMod.getWorkspaceAgentRow("ws-cto-dir")!,
    );
    const ids = items.map((i) => i.id).sort();
    expect(ids).toEqual(["t-cto", "t-failed"]);
  });

  // ---- setWorkspaceIdle: the durable, gave_up-shaped projection ---------------------------------

  test("setWorkspaceIdle — flips 0→1 with context, is a no-op on repeat, clears on 1→0", () => {
    seedOperator("ws-leader-idlecol", "leader", null);
    dbMod.setWorkspaceIdle("ws-leader-idlecol", true, () => "tail-context");
    let row = dbMod.getWorkspaceAgentRow("ws-leader-idlecol")!;
    expect(row.idle).toBe(1);
    expect(row.idle_context).toBe("tail-context");

    // Repeat while still idle → the peek guard bails; the (log-reading) thunk must NOT re-run.
    let thunkRuns = 0;
    dbMod.setWorkspaceIdle("ws-leader-idlecol", true, () => {
      thunkRuns++;
      return "should-not-capture";
    });
    expect(thunkRuns).toBe(0);
    expect(dbMod.getWorkspaceAgentRow("ws-leader-idlecol")!.idle_context).toBe("tail-context");

    // Stamp a durable escalation timestamp, then clear idle → the SAME write wipes BOTH the
    // context AND idle_escalated_at (story st-926eea1c: atomic re-arm, no linger-race).
    dbMod.saveWorkspaceAgentRow("ws-leader-idlecol", { idle_escalated_at: 12345 });
    expect(dbMod.getWorkspaceAgentRow("ws-leader-idlecol")!.idle_escalated_at).toBe(12345);
    dbMod.setWorkspaceIdle("ws-leader-idlecol", false);
    row = dbMod.getWorkspaceAgentRow("ws-leader-idlecol")!;
    expect(row.idle).toBe(0);
    expect(row.idle_context).toBeNull();
    expect(row.idle_escalated_at).toBeNull(); // atomically re-armed with the idle→0 flip
  });

  test("setWorkspaceIdle — ignores a non-operator (build) kind and a dead (has_agent=0) row", () => {
    insertTask("t-build");
    dbMod.saveWorkspaceAgentRow("ws-build-idle", {
      kind: "build",
      directory_id: DIR,
      work_id: "t-build",
      desired: 1,
      has_agent: 1,
    });
    dbMod.setWorkspaceIdle("ws-build-idle", true, () => "x");
    expect(dbMod.getWorkspaceAgentRow("ws-build-idle")!.idle).toBe(0); // build kind → untouched

    dbMod.saveWorkspaceAgentRow("ws-leader-dead", {
      kind: "leader",
      directory_id: DIR,
      work_id: null,
      desired: 1,
      has_agent: 0,
    });
    dbMod.setWorkspaceIdle("ws-leader-dead", true, () => "x");
    expect(dbMod.getWorkspaceAgentRow("ws-leader-dead")!.idle).toBe(0); // dead → untouched
  });

  // ---- reconcileOperatorIdle: the REPEATING idle escalation (story st-926eea1c S1) --------------
  // The push is now a DURABLE cadence keyed off workspace.idle_escalated_at (NOT the retired
  // in-process flag), the zero-actionable suppression is DROPPED, and the leader-idle payload +
  // idle_context carry the Q2 hold label. `deps.now` drives the cadence deterministically.

  /** Count the leader-idle events emitted so far. */
  const idleCount = (events: Array<Record<string, unknown>>) =>
    events.filter((e) => e.reason === "leader-idle").length;

  test("(a) a genuinely-idle leader re-fires on the FLAT cadence, repeatedly, until active", () => {
    const CADENCE = cfgMod.config.idleEscalateEveryMs; // FLAT 15 min (CEO Q1)
    insertLeaf("m1", { status: "in_review", story_id: "st-push" });
    insertLeaf("m2", { status: "failed", story_id: "st-push" });
    seedOperator("ws-leader-st-push", "leader", "st-push");
    const row = () => dbMod.getWorkspaceAgentRow("ws-leader-st-push")!;
    const { events, unsub } = captureAttention();
    let t = 1_000_000;
    try {
      wa.reconcileOperatorIdle(row(), { idle: () => true, now: () => t }); // fresh episode → fires (1)
      expect(idleCount(events)).toBe(1);
      const ev = events[0];
      expect(ev.target).toBe("cto");
      expect(ev.story_id).toBe("st-push");
      expect(String(ev.detail)).toContain("2 item(s)");
      expect(ev.marker).toBeUndefined(); // live transition signal — never resynced
      // Durable projection + stamp populated.
      expect(row().idle).toBe(1);
      expect(row().idle_escalated_at).toBe(t);

      // Within the cadence → SILENT.
      wa.reconcileOperatorIdle(row(), { idle: () => true, now: () => t + CADENCE - 1 });
      expect(idleCount(events)).toBe(1);

      // At/after the cadence → re-fires, repeatedly.
      wa.reconcileOperatorIdle(row(), { idle: () => true, now: () => t + CADENCE });
      expect(idleCount(events)).toBe(2);
      expect(row().idle_escalated_at).toBe(t + CADENCE);
      wa.reconcileOperatorIdle(row(), { idle: () => true, now: () => t + 2 * CADENCE });
      expect(idleCount(events)).toBe(3);
    } finally {
      unsub();
    }
  });

  test("(b) escalation STOPS when the agent goes active OR desired=0 (idle_escalated_at cleared atomically)", () => {
    const CADENCE = cfgMod.config.idleEscalateEveryMs;
    insertLeaf("m1", { status: "in_review", story_id: "st-stop" });
    seedOperator("ws-leader-st-stop", "leader", "st-stop");
    const row = () => dbMod.getWorkspaceAgentRow("ws-leader-st-stop")!;
    const { events, unsub } = captureAttention();
    let t = 5_000_000;
    try {
      wa.reconcileOperatorIdle(row(), { idle: () => true, now: () => t }); // fires (1) + stamps
      expect(idleCount(events)).toBe(1);

      // Goes ACTIVE → setWorkspaceIdle clears idle=0 AND idle_escalated_at atomically; no fire.
      wa.reconcileOperatorIdle(row(), { idle: () => false, now: () => t + 10 * CADENCE });
      expect(idleCount(events)).toBe(1);
      expect(row().idle).toBe(0);
      expect(row().idle_escalated_at).toBeNull();

      // desired=0 path: a live idle stamp is re-armed by the teardown write. Re-idle + stamp, then
      // simulate the desired→0 teardown clear and confirm no fire while wanted-down.
      wa.reconcileOperatorIdle(row(), { idle: () => true, now: () => t + 11 * CADENCE }); // re-fires
      expect(row().idle_escalated_at).toBe(t + 11 * CADENCE);
      dbMod.saveWorkspaceAgentRow("ws-leader-st-stop", { desired: 0, idle_escalated_at: null });
      wa.reconcileOperatorIdle(row(), { idle: () => true, now: () => t + 99 * CADENCE });
      // desired=0 → the leader push is suppressed (wanted-down), stamp stays cleared.
      expect(row().idle_escalated_at).toBeNull();
    } finally {
      unsub();
    }
  });

  test("(c) idle + ZERO actionable STILL escalates (the dropped suppression)", () => {
    // A member NOT awaiting the leader (in_progress) → ZERO actionable, and NO open ask / completion.
    insertLeaf("m-busy", { status: "in_progress", story_id: "st-zero" });
    seedOperator("ws-leader-st-zero", "leader", "st-zero");
    expect(
      tasksMod.operatorActionableItems(dbMod.getWorkspaceAgentRow("ws-leader-st-zero")!).length,
    ).toBe(0);
    const { events, unsub } = captureAttention();
    try {
      wa.reconcileOperatorIdle(dbMod.getWorkspaceAgentRow("ws-leader-st-zero")!, {
        idle: () => true,
        now: () => 1,
      });
    } finally {
      unsub();
    }
    // OLD behavior was SILENT; the dropped suppression means it now STILL fires.
    expect(idleCount(events)).toBe(1);
    expect(String(events[0].detail)).toContain("0 item(s)");
    expect(dbMod.getWorkspaceAgentRow("ws-leader-st-zero")!.idle).toBe(1);
  });

  test("(d) an ACTIVE leader (not genuinely idle) is NEVER flagged — no event, no durable idle, no stamp", () => {
    insertLeaf("m1", { status: "in_review", story_id: "st-active" });
    seedOperator("ws-leader-st-active", "leader", "st-active");
    const { events, unsub } = captureAttention();
    try {
      wa.reconcileOperatorIdle(dbMod.getWorkspaceAgentRow("ws-leader-st-active")!, {
        idle: () => false,
        now: () => 1,
      });
    } finally {
      unsub();
    }
    expect(idleCount(events)).toBe(0);
    const row = dbMod.getWorkspaceAgentRow("ws-leader-st-active")!;
    expect(row.idle).toBe(0);
    expect(row.idle_escalated_at).toBeNull();
  });

  test("(e) REVAMP-4 leader: parked with ZERO owned, gate clears elsewhere — keeps firing on cadence until active", () => {
    const CADENCE = cfgMod.config.idleEscalateEveryMs;
    // The exact limbo the story kills: a leader parked on an unmet cross-story gate owns NOTHING.
    // Materialize the node (no members) so work_id's FK resolves.
    dbMod.db
      .query(`INSERT OR REPLACE INTO tasks (id, workspace_id, status, work_kind, created_at) VALUES (?, ?, 'open', 'node', ?)`)
      .run("st-parked", DIR, dbMod.nowIso());
    seedOperator("ws-leader-st-parked", "leader", "st-parked");
    expect(
      tasksMod.operatorActionableItems(dbMod.getWorkspaceAgentRow("ws-leader-st-parked")!).length,
    ).toBe(0);
    const row = () => dbMod.getWorkspaceAgentRow("ws-leader-st-parked")!;
    const { events, unsub } = captureAttention();
    let t = 7_000_000;
    try {
      // It keeps nagging on cadence even with zero owned — never a silent dead-end.
      wa.reconcileOperatorIdle(row(), { idle: () => true, now: () => t });
      wa.reconcileOperatorIdle(row(), { idle: () => true, now: () => t + CADENCE });
      wa.reconcileOperatorIdle(row(), { idle: () => true, now: () => t + 2 * CADENCE });
      expect(idleCount(events)).toBe(3);
      // Answered/woken → active → stops.
      wa.reconcileOperatorIdle(row(), { idle: () => false, now: () => t + 3 * CADENCE });
      wa.reconcileOperatorIdle(row(), { idle: () => false, now: () => t + 4 * CADENCE });
      expect(idleCount(events)).toBe(3);
    } finally {
      unsub();
    }
  });

  test("(f) escalation SURVIVES a butchr restart — a stale idle_escalated_at + still-idle re-fires on cadence", () => {
    insertLeaf("m1", { status: "in_review", story_id: "st-restart" });
    seedOperator("ws-leader-st-restart", "leader", "st-restart");
    // Simulate the state AFTER a restart: the durable row already carries idle=1 + a STALE stamp
    // (from before the restart), and the in-process SupState is fresh (the old in-process flag is
    // GONE — this is the bug the durable timestamp fixes: an in-process flag would have been reset
    // to false and then, more importantly, could never persist a cadence across the restart).
    const CADENCE = cfgMod.config.idleEscalateEveryMs;
    const staleAt = 100;
    dbMod.saveWorkspaceAgentRow("ws-leader-st-restart", { idle: 1, idle_escalated_at: staleAt });
    wa._resetSupervisionStateForTest(); // drop any in-process supervision state (fresh process)
    const row = () => dbMod.getWorkspaceAgentRow("ws-leader-st-restart")!;
    const { events, unsub } = captureAttention();
    try {
      // now - staleAt >> CADENCE → the still-idle leader re-fires despite the process restart.
      wa.reconcileOperatorIdle(row(), { idle: () => true, now: () => staleAt + CADENCE + 1 });
      expect(idleCount(events)).toBe(1);
      expect(row().idle_escalated_at).toBe(staleAt + CADENCE + 1);
    } finally {
      unsub();
    }
  });

  test("(g) Q2 labels: held-pending-ask vs done-awaiting-retire drive the payload + idle_context", () => {
    // (g1) OPEN pending_ask → "held pending … (open ask)" ⇒ responder ANSWERS.
    dbMod.db
      .query(
        `INSERT OR REPLACE INTO tasks (id, workspace_id, status, work_kind, brief, pending_ask, ask_responder, created_at)
         VALUES (?, ?, 'open', 'node', ?, ?, 'cto', ?)`,
      )
      .run("st-ask", DIR, "goal", "need the API port", dbMod.nowIso());
    seedOperator("ws-leader-st-ask", "leader", "st-ask");
    let cap = captureAttention();
    try {
      wa.reconcileOperatorIdle(dbMod.getWorkspaceAgentRow("ws-leader-st-ask")!, {
        idle: () => true,
        now: () => 1,
      });
    } finally {
      cap.unsub();
    }
    expect(String(cap.events[0].detail)).toContain("held pending need the API port (open ask)");
    expect(dbMod.getWorkspaceAgentRow("ws-leader-st-ask")!.idle_context).toContain(
      "held pending need the API port (open ask)",
    );

    // (g2) genuinely-complete story, NO open ask → "done, awaiting retire (no open ask)" ⇒ WIND DOWN.
    dbMod.db
      .query(`INSERT OR REPLACE INTO tasks (id, workspace_id, status, work_kind, brief, created_at) VALUES (?, ?, 'open', 'node', ?, ?)`)
      .run("st-done", DIR, "goal", dbMod.nowIso());
    insertLeaf("m-merged", { status: "merged", story_id: "st-done" });
    seedOperator("ws-leader-st-done", "leader", "st-done");
    cap = captureAttention();
    try {
      wa.reconcileOperatorIdle(dbMod.getWorkspaceAgentRow("ws-leader-st-done")!, {
        idle: () => true,
        now: () => 1,
      });
    } finally {
      cap.unsub();
    }
    expect(String(cap.events[0].detail)).toContain("done, awaiting retire (no open ask)");
    expect(String(cap.events[0].detail)).toContain("completion review");
    expect(dbMod.getWorkspaceAgentRow("ws-leader-st-done")!.idle_context).toContain(
      "done, awaiting retire (no open ask)",
    );
  });

  test("the CTO idle case populates durable idle but pushes NO event (PART 2 surfaces it on the dashboard)", () => {
    insertLeaf("t-cto", { status: "in_review", story_id: null }); // responder 'cto' → CTO owns it
    seedOperator("ws-cto-dir2", "cto", null);
    const { events, unsub } = captureAttention();
    try {
      wa.reconcileOperatorIdle(dbMod.getWorkspaceAgentRow("ws-cto-dir2")!, {
        idle: () => true,
        now: () => 1,
      });
    } finally {
      unsub();
    }
    expect(idleCount(events)).toBe(0); // no push for the CTO
    expect(dbMod.getWorkspaceAgentRow("ws-cto-dir2")!.idle).toBe(1); // but the durable idle IS set
  });
});

// ---- operator briefs restored in the unified launch path (story st-06aedeae) -------------
// The default launcher used to write an ~80-byte stub brief, so a unified-launched CTO/leader
// booted with no role and idled. buildWorkspaceBrief restores the real, kind-guarded briefs
// (ported from the legacy launchers Phase C deletes). The leader brief stays TIGHT — a
// one-line title + a runtime GET, never the full embedded brief — and BOTH briefs carry the
// concrete never-park (open-loop-ask) mechanism.
describe("operator briefs (buildWorkspaceBrief, st-06aedeae)", () => {
  /** Seed a story NODE (getStoryRow reads tasks WHERE work_kind='node') with a given brief. */
  function seedStoryNode(id: string, brief: string): void {
    dbMod.db
      .query(
        `INSERT OR REPLACE INTO tasks (id, workspace_id, status, work_kind, brief, isolated, created_at)
         VALUES (?, ?, 'open', 'node', ?, 0, ?)`,
      )
      .run(id, DIR, brief, dbMod.nowIso());
  }

  test("the CTO brief carries the create-STORIES role + the concrete never-park open-loop-ask mechanism (NOT the stub)", () => {
    const brief = wa.buildWorkspaceBrief(mkRow({ id: "w-cto-b", kind: "cto", directory_id: DIR }));
    expect(brief).toContain("butchr CTO");
    expect(brief).toContain("you create stories, NOT tasks");
    // never-park invariant, named concretely:
    expect(brief).toContain("pending_ask");
    expect(brief).toContain("An idle agent is never a silent dead-end");
    // definitely NOT the old stub:
    expect(brief).not.toContain("workspace agent\n\nWorkspace");
    expect(brief.length).toBeGreaterThan(1000);
  });

  test("the LEADER brief derives a ONE-LINE clamped title + instructs a runtime GET — it does NOT embed the full brief", () => {
    const firstLine = "Restore operator briefs in the unified launch path";
    const fullBrief = `${firstLine}\n\nThis is a long multi-line body that MUST NOT be embedded verbatim into the leader prompt — the leader fetches it live instead. Second body paragraph. Third body paragraph.`;
    seedStoryNode("story-brief-1", fullBrief);
    const brief = wa.buildWorkspaceBrief(
      mkRow({ id: "w-l-b", kind: "leader", work_id: "story-brief-1", directory_id: DIR }),
    );
    // one-line title present…
    expect(brief).toContain(`LEADER of story story-brief-1`);
    expect(brief).toContain(firstLine);
    // …runtime fetch instruction present…
    expect(brief).toContain("GET /api/work/story-brief-1");
    // …but the full multi-line body is NOT embedded (the whole point of keeping it tight):
    expect(brief).not.toContain("MUST NOT be embedded verbatim");
    expect(brief).not.toContain("Second body paragraph");
    // never-park invariant, named concretely with the leader's ask endpoint:
    expect(brief).toContain("POST /api/work/story-brief-1/ask");
    expect(brief).toContain("pending_ask");
    expect(brief).toContain("silent dead-end"); // (phrase may line-wrap; match the tail)
  });

  test("a LEADER whose story node is GONE yields a non-stub fallback keyed on work_id, still instructing the runtime GET (no throw)", () => {
    const brief = wa.buildWorkspaceBrief(
      mkRow({ id: "w-l-gone", kind: "leader", work_id: "story-missing", directory_id: DIR }),
    );
    expect(brief).toContain("LEADER of story story-missing");
    expect(brief).toContain("GET /api/work/story-missing");
    // no embedded title colon since the row is gone, but still a real (non-stub) brief:
    expect(brief).not.toContain('LEADER of story story-missing: "');
    expect(brief.length).toBeGreaterThan(1000);
  });

  test("a very long story first-line title is CLAMPED to ~80 chars (kept small)", () => {
    const longLine = "X".repeat(200);
    seedStoryNode("story-long", `${longLine}\n\nbody`);
    const brief = wa.buildWorkspaceBrief(
      mkRow({ id: "w-l-long", kind: "leader", work_id: "story-long", directory_id: DIR }),
    );
    expect(brief).not.toContain("X".repeat(120)); // the full 200-char line is NOT present
    expect(brief).toContain("…"); // it was clamped with an ellipsis
  });
});

// ---- SUPERVISOR_KINDS CAPABILITY TABLE (REVAMP-4 Phase 0 / S0c) --------------------------------
// The CTO ruling: a future supervisor tier must be ONE TABLE ROW, not scattered `kind === "…"`
// conditionals. These tests PROVE the table reproduces each existing kind's behavior BYTE-FOR-BYTE
// (name / channel scope / launch cmd / operator+enable gates) — the ZERO-BEHAVIOR guardrail. The
// 'ceo' row is now LIVE-CAPABLE behind the per-project enable (REVAMP-4 P3c): its `enabled`
// resolves isCeoEnabled(work_id), which is false with no CEO-enabled project node (DEFAULT OFF), so
// a stray desired=1 ceo row is still torn down — prod byte-identical. The CEO lifecycle proper is
// exercised by the "CEO lifecycle (REVAMP-4 P3c)" describe below.
describe("SUPERVISOR_KINDS capability table (S0c)", () => {
  const prefix = () => cfgMod.config.ctoAgentName;

  test("agentName reproduces each existing kind's name byte-for-byte + the ceo pattern", () => {
    const cto = mkRow({ id: "w-cto", kind: "cto", directory_id: DIR });
    const leader = mkRow({ id: "w-l", kind: "leader", work_id: "story-1", directory_id: DIR });
    const build = mkRow({ id: "w-b", kind: "build", work_id: "task-9", directory_id: DIR });
    const ceo = mkRow({ id: "w-ceo", kind: "ceo", work_id: "proj-1", directory_id: DIR });
    // Byte-for-byte vs the former hardcoded formulas.
    expect(wa.SUPERVISOR_KINDS.cto.agentName(cto)).toBe(`${prefix()}-${DIR}`);
    expect(wa.SUPERVISOR_KINDS.leader.agentName(leader)).toBe(`${prefix()}-story-story-1`);
    expect(wa.SUPERVISOR_KINDS.build.agentName(build)).toBe("task-9");
    expect(wa.SUPERVISOR_KINDS.ceo.agentName(ceo)).toBe(`${prefix()}-project-proj-1`);
    // workspaceAgentName delegates to the table (name-column still wins).
    expect(wa.workspaceAgentName(ceo)).toBe(`${prefix()}-project-proj-1`);
    expect(wa.workspaceAgentName(mkRow({ id: "w", kind: "ceo", name: "pinned", work_id: "proj-1" }))).toBe("pinned");
  });

  test("channelEnv reproduces each kind's former per-kind channel scope", () => {
    expect(wa.SUPERVISOR_KINDS.cto.channelEnv(mkRow({ id: "c", kind: "cto", directory_id: DIR }))).toEqual({
      BUTCHR_CHANNEL_WORKSPACE: DIR,
    });
    expect(
      wa.SUPERVISOR_KINDS.leader.channelEnv(mkRow({ id: "l", kind: "leader", work_id: "story-1", directory_id: DIR })),
    ).toEqual({ BUTCHR_CHANNEL_STORY: "story-1", BUTCHR_CHANNEL_WORKSPACE: DIR });
    expect(wa.SUPERVISOR_KINDS.build.channelEnv(mkRow({ id: "b", kind: "build" }))).toEqual({
      BUTCHR_CHANNEL_CONNECTIVITY_ONLY: "1",
    });
    // ceo: PROJECT scope — BUTCHR_CHANNEL_PROJECT (project mode, channel.ts P3b) + the anchor dir.
    // Now actually written when a ceo launches (REVAMP-4 P3c).
    expect(
      wa.SUPERVISOR_KINDS.ceo.channelEnv(mkRow({ id: "e", kind: "ceo", work_id: "proj-1", directory_id: DIR })),
    ).toEqual({ BUTCHR_CHANNEL_PROJECT: "proj-1", BUTCHR_CHANNEL_WORKSPACE: DIR });
    // empty-value keys are omitted (matching the former `if (row.x)` guards).
    expect(wa.SUPERVISOR_KINDS.cto.channelEnv(mkRow({ id: "c", kind: "cto" }))).toEqual({});
  });

  test("agentCmd / isOperator / supervisedNodeKind match each kind's role", () => {
    expect(wa.SUPERVISOR_KINDS.cto.agentCmd()).toBe(cfgMod.config.ctoAgentCmd);
    expect(wa.SUPERVISOR_KINDS.leader.agentCmd()).toBe(cfgMod.config.storyAgentCmd);
    expect(wa.SUPERVISOR_KINDS.ceo.agentCmd()).toBe(cfgMod.config.ctoAgentCmd);
    // isOperator gates the launcher throw + the startup/mid-session probes.
    expect(wa.SUPERVISOR_KINDS.cto.isOperator).toBe(true);
    expect(wa.SUPERVISOR_KINDS.leader.isOperator).toBe(true);
    expect(wa.SUPERVISOR_KINDS.ceo.isOperator).toBe(true);
    expect(wa.SUPERVISOR_KINDS.build.isOperator).toBe(false);
    // supervised node tier (declarative).
    expect(wa.SUPERVISOR_KINDS.leader.supervisedNodeKind).toBe("node");
    expect(wa.SUPERVISOR_KINDS.cto.supervisedNodeKind).toBe("repo");
    expect(wa.SUPERVISOR_KINDS.ceo.supervisedNodeKind).toBe("project");
    expect(wa.SUPERVISOR_KINDS.build.supervisedNodeKind).toBeNull();
  });

  test("enabled gate: cto follows isCtoEnabled, leader/build always on, ceo follows isCeoEnabled", () => {
    expect(wa.SUPERVISOR_KINDS.leader.enabled(mkRow({ id: "l", kind: "leader" }))).toBe(true);
    expect(wa.SUPERVISOR_KINDS.build.enabled(mkRow({ id: "b", kind: "build" }))).toBe(true);
    // ceo with no CEO-enabled project node (DEFAULT OFF) → false, exactly isCeoEnabled(work_id).
    const ceoRow = mkRow({ id: "e", kind: "ceo", work_id: "proj-none" });
    expect(wa.SUPERVISOR_KINDS.ceo.enabled(ceoRow)).toBe(dirsMod.isCeoEnabled("proj-none"));
    expect(wa.SUPERVISOR_KINDS.ceo.enabled(ceoRow)).toBe(false);
    // cto's gate is exactly isCtoEnabled(directory).
    const ctoRow = mkRow({ id: "c", kind: "cto", directory_id: DIR });
    expect(wa.SUPERVISOR_KINDS.cto.enabled(ctoRow)).toBe(dirsMod.isCtoEnabled(DIR));
  });

  test("DEFAULT OFF: a ceo row whose project is NOT ceo-enabled → torn down by reconcile AND supervise (never launched)", async () => {
    const { runner, launcher, calls } = makeFake();
    harnessMod.setRunner(runner);
    wa.setLauncherForTest(launcher);
    // proj-1 is a plain LEAF (insertTask), not a ceo-enabled project node → isCeoEnabled false.
    insertTask("proj-1");
    dbMod.saveWorkspaceAgentRow("ws-ceo-proj-1", {
      kind: "ceo", directory_id: DIR, work_id: "proj-1", desired: 1,
    });

    // reconcile a DESIRED-UP but not-enabled ceo → torn down, never launched.
    const res = await wa.reconcileWorkspaceAgent("ws-ceo-proj-1", true);
    expect(res.action).toBe("stopped");
    expect(calls.launch).toHaveLength(0);
    expect(dbMod.getWorkspaceAgentRow("ws-ceo-proj-1")!.desired).toBe(0);

    // and a supervise tick on a (re-desired) ceo also never launches it.
    dbMod.saveWorkspaceAgentRow("ws-ceo-proj-1", { desired: 1 });
    await wa._superviseTickForTest("ws-ceo-proj-1");
    expect(calls.launch).toHaveLength(0);
  });
});

// ---- CEO LIFECYCLE (REVAMP-4 Phase 3 / P3c, story st-1a82a2e1) ---------------------------------
// Make a CEO agent LIVE-CAPABLE for a project node: createProject materializes the node, an
// operator enables its CEO (setWorkspaceCeoEnabled), and the SAME table-driven supervisor
// launches/reconciles/tears it down — no ceo-specific branch. DEFAULT OFF ⇒ prod byte-identical.
// Uses the injected WorkspaceLauncher mock (no real agent spawned).
describe("CEO lifecycle (REVAMP-4 P3c)", () => {
  test("createProject materializes a maximally-inert project NODE (work_kind='project', status='merged', parent_id NULL, anchored to a directory)", () => {
    const proj = dirsMod.createProject(DIR, "ship the moon");
    expect(proj.id.startsWith("pj-")).toBe(true);
    expect(proj.work_kind).toBe("project");
    expect(proj.status).toBe("merged"); // the inert terminal anchor (like a repo/story node)
    expect(proj.parent_id).toBeNull(); // top of the tree — no tier above a project
    expect(proj.workspace_id).toBe(DIR); // anchored to an existing directory (FK + CEO cwd)
    expect(proj.brief).toBe("ship the moon");
    expect(proj.ceo_enabled).toBeNull(); // created DISABLED — enabling is a separate step
    // getProject round-trips it; a non-project id (a plain leaf) is NOT a project.
    expect(dirsMod.getProject(proj.id)!.id).toBe(proj.id);
    insertTask("leaf-not-project");
    expect(dirsMod.getProject("leaf-not-project")).toBeNull();
    // 404 when the anchor directory is gone.
    expect(() => dirsMod.createProject("dir-does-not-exist")).toThrow();
  });

  test("a status='merged' project node is EXCLUDED from a directory's leaf-only counts (S0a exclusion)", () => {
    const ADIR = "dir-ceo-inert";
    insertDir(ADIR);
    const proj = dirsMod.createProject(ADIR);
    // counts filter work_kind='leaf', so the project node inflates NO status bucket.
    const detail = dirsMod.workspaceDetail(ADIR);
    expect(detail.counts.merged).toBe(0);
    // And it is invisible to the leaf-only membership query the loops use.
    const leafHit = dbMod.db
      .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM tasks WHERE id=? AND work_kind='leaf'`)
      .get(proj.id)!.n;
    expect(leafHit).toBe(0);
  });

  test("isCeoEnabled is a tri-state: missing→false, NULL→config default, 1→on, 0→off", async () => {
    const proj = dirsMod.createProject(DIR);
    const saved = cfgMod.config.ceoAgentEnabled;
    try {
      // missing / non-project id → never enabled.
      expect(dirsMod.isCeoEnabled("pj-nope")).toBe(false);
      // NULL (unset) inherits the global default.
      cfgMod.config.ceoAgentEnabled = false;
      expect(dirsMod.isCeoEnabled(proj.id)).toBe(false);
      cfgMod.config.ceoAgentEnabled = true;
      expect(dirsMod.isCeoEnabled(proj.id)).toBe(true);
      // An explicit per-project value WINS over the global default either way.
      cfgMod.config.ceoAgentEnabled = false;
      await dirsMod.setWorkspaceCeoEnabled(proj.id, true);
      expect(dirsMod.isCeoEnabled(proj.id)).toBe(true);
      cfgMod.config.ceoAgentEnabled = true;
      await dirsMod.setWorkspaceCeoEnabled(proj.id, false);
      expect(dirsMod.isCeoEnabled(proj.id)).toBe(false);
      // Clearing the override (null) reverts to inheriting the global default.
      await dirsMod.setWorkspaceCeoEnabled(proj.id, null);
      expect(dirsMod.isCeoEnabled(proj.id)).toBe(true);
    } finally {
      cfgMod.config.ceoAgentEnabled = saved;
      // Tear any ws-ceo row the enable created so it can't leak a desired=1 row into a later tick.
      await wa.stopWorkspaceAgent(`ws-ceo-${proj.id}`).catch(() => {});
    }
  });

  test("setWorkspaceCeoEnabled(true) materializes a desired-up ws-ceo row that the supervisor WOULD launch; (false) tears it down", async () => {
    const { runner, launcher, calls } = makeFake();
    harnessMod.setRunner(runner);
    wa.setLauncherForTest(launcher);
    const proj = dirsMod.createProject(DIR);
    const wsId = `ws-ceo-${proj.id}`;

    // ENABLE → tasks.ceo_enabled=1 + a desired-up ceo workspace row bound to the project node,
    // anchored to the CEO's OWN home directory (story st-307edc78) — NOT the project's repo dir —
    // so the CEO gets its own herdr workspace (cwd + channel-workspace scope live under dataDir).
    await dirsMod.setWorkspaceCeoEnabled(proj.id, true);
    expect(dirsMod.getProject(proj.id)!.ceo_enabled).toBe(1);
    const row = dbMod.getWorkspaceAgentRow(wsId)!;
    expect(row.kind).toBe("ceo");
    expect(row.work_id).toBe(proj.id);
    expect(row.directory_id).toBe(`ceo-dir-${proj.id}`);
    expect(row.directory_id).not.toBe(DIR); // NOT the member repo dir (root-cause fix)
    expect(row.desired).toBe(1);
    expect(wa.SUPERVISOR_KINDS.ceo.enabled(row)).toBe(true);
    // The mock agent name matches the ceo derivation.
    expect(wa.workspaceAgentName(row)).toBe(`${cfgMod.config.ctoAgentName}-project-${proj.id}`);

    // The supervisor WOULD launch it (dead + desired-up + enabled → a reconcile launches it).
    const res = await wa.reconcileWorkspaceAgent(wsId, true);
    expect(res.action).toBe("launched");
    expect(calls.launch.map((c) => c.id)).toContain(wsId);

    // DISABLE → torn down (desired=0 + the ceo pane torn down via the launcher).
    await dirsMod.setWorkspaceCeoEnabled(proj.id, false);
    expect(dirsMod.getProject(proj.id)!.ceo_enabled).toBe(0);
    expect(dbMod.getWorkspaceAgentRow(wsId)!.desired).toBe(0);
    expect(calls.teardown).toContain(`${cfgMod.config.ctoAgentName}-project-${proj.id}`);
  });

  test("HARDENING #1 — deleting the anchor directory GRACEFULLY stops an anchored CEO (not just cascade)", async () => {
    const ADIR = "dir-ceo-anchor";
    insertDir(ADIR);
    const { runner, launcher, calls } = makeFake();
    harnessMod.setRunner(runner);
    wa.setLauncherForTest(launcher);
    const proj = dirsMod.createProject(ADIR);
    await dirsMod.setWorkspaceCeoEnabled(proj.id, true);
    const wsId = `ws-ceo-${proj.id}`;
    const ceoName = wa.workspaceAgentName(dbMod.getWorkspaceAgentRow(wsId)!);
    // Make it live so a graceful stop has a pane to tear down.
    dbMod.saveWorkspaceAgentRow(wsId, { has_agent: 1 });

    await dirsMod.unregisterWorkspace(ADIR);

    // Since story st-307edc78 the CEO lives in its OWN home dir (directory_id = ceo-dir-<proj>), NOT
    // ADIR — but unregistering the project's ANCHOR directory cascade-deletes the project node, so
    // the CEO must still go. unregisterWorkspace GRACEFULLY stops the CEO BY NAME (via the anchored-
    // project enumeration) and drops its home-dir row, which cascades the CEO agent row away.
    expect(calls.teardown).toContain(ceoName);
    // No stranded ceo row survives (its home dir was deleted → the agent row cascaded).
    expect(dbMod.getWorkspaceAgentRow(wsId)).toBeNull();
    expect(
      dbMod.db.query(`SELECT COUNT(*) AS n FROM directory WHERE id=?`).get(`ceo-dir-${proj.id}`),
    ).toMatchObject({ n: 0 });
    // And no workspace row remains anchored to the removed repo directory either.
    expect(
      dbMod.db.query(`SELECT COUNT(*) AS n FROM workspace WHERE directory_id=?`).get(ADIR),
    ).toMatchObject({ n: 0 });
  });

  test("HARDENING #2 — an enabled but WORK-LESS CEO stands by SILENTLY (no idle escalation)", () => {
    const proj = dirsMod.createProject(DIR);
    // A live, desired-up, genuinely-idle CEO workspace row (no actionable work — P3d not landed).
    dbMod.saveWorkspaceAgentRow(`ws-ceo-${proj.id}`, {
      kind: "ceo", directory_id: DIR, work_id: proj.id, desired: 1, has_agent: 1,
      session_id: "sess-ceo",
    });
    const row = () => dbMod.getWorkspaceAgentRow(`ws-ceo-${proj.id}`)!;

    const events: Array<Record<string, unknown>> = [];
    const unsub = eventsMod.subscribe((e) => {
      if ((e as { type?: string }).type === "story.attention") events.push(e as Record<string, unknown>);
    });
    try {
      // Even forced idle across many cadences, a CEO NEVER pushes leader-idle (only a leader does)
      // and NEVER stamps an escalation — idle+zero-actionable = fully SILENT.
      wa.reconcileOperatorIdle(row(), { idle: () => true, now: () => 1_000 });
      wa.reconcileOperatorIdle(row(), { idle: () => true, now: () => 1_000 + cfgMod.config.idleEscalateEveryMs * 5 });
      expect(events.filter((e) => e.reason === "leader-idle")).toHaveLength(0);
      expect(events).toHaveLength(0);
      // A CEO gets NO durable idle projection either (setWorkspaceIdle projects only cto/leader —
      // nothing reads a ceo's idle), so the row stays fully inert. No escalation stamp was written.
      expect(row().idle).toBe(0);
      expect(row().idle_escalated_at).toBeNull();
    } finally {
      unsub();
    }
  });

  test("the CEO brief describes the real DIRECTIVE surface (register repos + seed initiatives)", () => {
    const proj = dirsMod.createProject(DIR);
    const brief = wa.buildWorkspaceBrief(
      mkRow({ id: `ws-ceo-${proj.id}`, kind: "ceo", work_id: proj.id, directory_id: DIR }),
    );
    expect(brief).toContain("CEO of project");
    // The P3d directive surface, scoped to THIS project id: register repos + seed initiatives.
    expect(brief).toContain(`POST /api/projects/${proj.id}/repos`);
    expect(brief).toContain(`POST /api/projects/${proj.id}/initiatives`);
    // No longer inert — the P3c "stand by" placeholder is gone.
    expect(brief).not.toContain("stand by");
    // P3e: cross-repo initiatives (fan ONE initiative into MULTIPLE member repos) are now
    // documented — the `targets` array shape + the completion-rollup GET.
    expect(brief).toContain("cross-repo");
    expect(brief).toContain("targets");
    expect(brief).toContain(`GET /api/projects/${proj.id}/initiatives`);
    // Honest about the REMAINING boundary: cross-repo SEQUENCING (blocked_by across repos) is not
    // yet available — a cross-repo initiative fans out in PARALLEL.
    expect(brief).toContain("PARALLEL only");
    // Must NOT instruct a GET /api/work/<project> — a 'project' node 404s there (P3a).
    expect(brief).not.toContain("GET /api/work");
    expect(brief.length).toBeGreaterThan(200); // a real brief, not an 80-byte stub
  });
});
