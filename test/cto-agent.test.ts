// Tests for the PER-WORKSPACE MANAGED CTO AGENT (src/cto-agent.ts) driven through a
// FAKE AgentRunner backend — no real herdr or claude. butchr runs ONE CTO agent per
// registered workspace (in that repo's root); every lifecycle op is scoped to a
// workspace_id. The module talks to the swappable `harness` proxy, so setRunner()
// drops in a fake whose liveness (`agentExists`) and recorded calls we control.
//
// What this exercises:
//   - LIFECYCLE (scoped to a workspace): start launches through the harness RESUMING
//     the per-workspace operator-seeded session (first launch), with cwd = the repo
//     root, wired to the channel SCOPED to the workspace (dev-channel flag + MCP
//     config carrying BUTCHR_CHANNEL_WORKSPACE); stop tears it down; restart resumes the
//     SAME session; restart(fresh) cold-starts a brand-new one.
//   - SINGLE INSTANCE PER DIRECTORY: a start when one is already live ADOPTS it.
//   - PER-WORKSPACE ISOLATION: two workspaces run independent CTO agents whose names,
//     sessions, and supervision state never collide.
//   - BOOT RECONCILE: adopt a live pane vs (re)launch a dead one; honor a prior stop.
//   - SUPERVISED RELAUNCH on death RESUMES the same session via `--resume`.
//   - STATUS shape (the data behind the /api/workspaces/:id/cto endpoints).
//
// config fields are set DIRECTLY on the imported config object (not via env) so the
// test is deterministic regardless of bun's shared-config import order.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunner, PaneInfo, StartedAgent } from "../src/harness.ts";

let DATA_DIR: string;
let dbMod: typeof import("../src/db.ts");
let cfgMod: typeof import("../src/config.ts");
let harnessMod: typeof import("../src/harness.ts");
let livenessMod: typeof import("../src/liveness.ts");
let cto: typeof import("../src/cto-agent.ts");
let originalRunner: AgentRunner;

const DIR = "dir-ctotest1";
const DIR2 = "dir-ctotest2";
const SEED = "seed-session-aaaa";

function insertDir(id: string): void {
  dbMod.db
    .query(
      `INSERT OR IGNORE INTO workspaces (id, path, label, herdr_workspace, herdr_pane, gate_cmd, cto_enabled, created_at)
       VALUES (?, ?, ?, NULL, NULL, NULL, 1, ?)`,
    )
    .run(id, join(DATA_DIR, id), id, dbMod.nowIso());
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-cto-data-"));
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  cfgMod = await import("../src/config.ts");
  dbMod = await import("../src/db.ts");
  harnessMod = await import("../src/harness.ts");
  livenessMod = await import("../src/liveness.ts");
  cto = await import("../src/cto-agent.ts");
  originalRunner = harnessMod.getRunner();

  // Pin the CTO-agent config deterministically (mutating the singleton is robust to
  // import order — unlike env, which only wins if this file imports config first).
  cfgMod.config.ctoAgentEnabled = false; // prove per-workspace cto_enabled=1 WINS
  cfgMod.config.ctoAgentSessionSeeds = new Map([[DIR, SEED]]);
  cfgMod.config.ctoAgentName = "butchr-cto-agent";
  cfgMod.config.ctoBriefPath = "";
  cfgMod.config.ctoMaxRestarts = 3;
  cfgMod.config.ctoRestartBackoffBaseMs = 1; // tiny so backoff never gates a test tick
  cfgMod.config.ctoRestartBackoffCapMs = 1;
  // Launch auto-confirm: tiny + quiet-after-one so the (empty-screen) fake loop exits
  // immediately and never slows the per-launch path.
  cfgMod.config.ctoPromptPollMs = 1;
  cfgMod.config.ctoPromptMaxPolls = 3;
  cfgMod.config.ctoPromptQuietPolls = 1;

  insertDir(DIR);
  insertDir(DIR2);
});

afterAll(() => {
  harnessMod.setRunner(originalRunner);
  rmSync(DATA_DIR, { recursive: true, force: true });
});

/**
 * A fake backend whose liveness + recorded calls the test drives. Liveness is tracked
 * PER AGENT NAME (so multiple workspaces' CTO agents are independent): `opts.alive`
 * pre-seeds every name as already-live (the adopt scenarios); otherwise a name becomes
 * live only once it is started, and is cleared on teardown/deregister.
 */
function makeFake(opts: { alive?: boolean; resolvedPane?: string } = {}) {
  const aliveAll = opts.alive ?? false;
  const started = new Set<string>();
  const resolvedPane = opts.resolvedPane ?? "pane-final";
  const live = (name: string) => aliveAll || started.has(name);
  const calls = {
    agentStart: [] as Array<{ name: string; cwd: string; argv: string[]; tabId?: string }>,
    workspaceCreate: 0,
    tabClose: [] as Array<string | null | undefined>,
    agentDeregister: 0,
    teardownTask: 0,
    teardownArgs: [] as Array<{ tab: string | null | undefined; name: string; pane: string | null | undefined }>,
    paneClose: [] as string[],
    // Ordered log of lifecycle calls (additive) so a test can assert teardown ran
    // BEFORE the relaunch in the reboot case.
    order: [] as string[],
  };
  const runner: AgentRunner = {
    async isUp() { return true; },
    async workspaceCreate(_cwd, _label) { calls.workspaceCreate++; return { workspaceId: "cto-ws", rootPaneId: "cto-rp" }; },
    async workspaceExists() { return false; }, // force a heal → workspaceCreate
    async workspaceClose() {},
    async tabCreate() { return { tabId: "cto-tab", rootPaneId: "rp-1" }; },
    async tabClose(id) { calls.tabClose.push(id); },
    async agentTabId(name) { return live(name) ? "cto-tab" : undefined; },
    async agentStart(name, cwd, argv, _ws, tabId): Promise<StartedAgent> {
      calls.agentStart.push({ name, cwd, argv, tabId });
      calls.order.push("agentStart");
      started.add(name);
      return { paneId: "pane-raw", terminalId: "term-1" };
    },
    async agentExists(name) { return live(name); },
    async agentPaneId(name) { return live(name) ? (started.has(name) ? resolvedPane : "pane-live") : undefined; },
    async agentTerminalId(name) { return live(name) ? "term-1" : undefined; },
    async paneTerminalId() { return "rootterm"; },
    async paneList(): Promise<PaneInfo[]> { return []; },
    async resolveAgentPane() { return resolvedPane; },
    async reconcilePane(name, stored) {
      // Per-name (mirrors agentPaneId): a started name reports its resolved pane, a
      // pre-seeded live name reports "pane-live", a dead name has none.
      const paneId = live(name) ? (started.has(name) ? resolvedPane : "pane-live") : undefined;
      return { paneId, drifted: !!paneId && !!stored && paneId !== stored };
    },
    isAgentNameTaken() { return false; },
    async agentRead() { return ""; }, // no startup prompt → auto-confirm exits at once
    async send() {},
    async paneClose(target) { calls.paneClose.push(target); },
    async teardownTask(tab, name, pane) {
      calls.teardownTask++;
      calls.teardownArgs.push({ tab, name, pane });
      calls.order.push("teardownTask");
      if (name) started.delete(name);
    },
    async agentDeregister(name) { calls.agentDeregister++; calls.order.push("agentDeregister"); started.delete(name); },
    async runHeadless() { return { ok: true, code: 0, stdout: "", stderr: "", timedOut: false }; },
  };
  return { runner, calls };
}

const row = (id = DIR) => dbMod.getCtoAgentRow(id);

beforeEach(() => {
  // Reset the per-workspace records + in-memory supervision state between scenarios.
  dbMod.db.query(`DELETE FROM cto_agent`).run();
  cto._resetSupervisionStateForTest();
});

describe("CTO agent lifecycle (per workspace)", () => {
  test("start launches through the harness, RESUMING the seeded session + wiring the scoped channel", async () => {
    const { runner, calls } = makeFake({ alive: false });
    harnessMod.setRunner(runner);

    const status = await cto.startCtoAgent(DIR);

    expect(calls.agentStart.length).toBe(1);
    const start = calls.agentStart[0]!;
    // Named + run with cwd = the workspace's repo root.
    expect(start.name).toBe(cto.ctoAgentName(DIR));
    expect(start.name).toContain(DIR);
    expect(start.cwd).toBe(join(DATA_DIR, DIR));
    const launched = start.argv.join(" ");
    // First launch resumes the per-workspace seeded session (NOT a fresh --session-id).
    expect(launched).toContain(`--resume ${SEED}`);
    expect(launched).not.toContain("--session-id");
    // Channel wiring: the development-channel flag + the per-CTO MCP config.
    expect(launched).toContain("--dangerously-load-development-channels server:butchr-cto-channel");
    expect(launched).toContain("--mcp-config");
    // Placed in the dedicated tab; husk root pane closed; real pane re-resolved.
    expect(start.tabId).toBe("cto-tab");
    expect(calls.paneClose).toContain("rp-1");

    // The MCP config registers the channel stdio server SCOPED to this workspace.
    const mcp = JSON.parse(readFileSync(join(cfgMod.config.dataDir, "cto", DIR, "mcp.json"), "utf8"));
    expect(mcp.mcpServers["butchr-cto-channel"]).toBeTruthy();
    expect(mcp.mcpServers["butchr-cto-channel"].env.BUTCHR_CHANNEL_SSE_URL).toContain("/api/events");
    expect(mcp.mcpServers["butchr-cto-channel"].env.BUTCHR_CHANNEL_WORKSPACE).toBe(DIR);

    // Persisted record + returned status.
    const r = row()!;
    expect(r.workspace_id).toBe(DIR);
    expect(r.session_id).toBe(SEED);
    expect(r.herdr_pane_id).toBe("pane-final");
    expect(r.herdr_tab_id).toBe("cto-tab");
    expect(r.desired).toBe(1);
    expect(r.restarts).toBe(0);
    expect(status.workspaceId).toBe(DIR);
    expect(status.running).toBe(true);
    expect(status.enabled).toBe(true); // cto_enabled=1 wins over the global default off
    expect(status.sessionId).toBe(SEED);
    expect(status.paneId).toBe("pane-final");
  });

  test("a start while already live ADOPTS (single instance — no second launch)", async () => {
    const { runner, calls } = makeFake({ alive: true });
    harnessMod.setRunner(runner);

    const status = await cto.startCtoAgent(DIR);

    expect(calls.agentStart.length).toBe(0); // adopted, not relaunched
    expect(status.running).toBe(true);
    expect(row()!.desired).toBe(1);
    expect(row()!.herdr_pane_id).toBe("pane-live");
  });

  test("stop tears the agent down and marks it desired-down", async () => {
    const { runner, calls } = makeFake({ alive: false });
    harnessMod.setRunner(runner);
    await cto.startCtoAgent(DIR);

    const status = await cto.stopCtoAgent(DIR);

    expect(calls.teardownTask).toBe(1);
    expect(calls.agentDeregister).toBeGreaterThanOrEqual(1);
    expect(status.running).toBe(false);
    expect(status.desired).toBe(false);
    const r = row()!;
    expect(r.desired).toBe(0);
    expect(r.herdr_pane_id).toBeNull();
  });

  test("restart RESUMES the same session; restart(fresh) cold-starts a NEW one", async () => {
    const fake1 = makeFake({ alive: false });
    harnessMod.setRunner(fake1.runner);
    await cto.startCtoAgent(DIR);
    const sid = row()!.session_id;
    expect(sid).toBe(SEED);

    // Plain restart → same session via --resume.
    const fake2 = makeFake({ alive: false });
    harnessMod.setRunner(fake2.runner);
    await cto.restartCtoAgent(DIR);
    expect(fake2.calls.agentStart.length).toBe(1);
    expect(fake2.calls.agentStart[0]!.argv.join(" ")).toContain(`--resume ${sid}`);
    expect(row()!.session_id).toBe(sid);

    // Fresh restart → a brand-new --session-id (different from the seed).
    const fake3 = makeFake({ alive: false });
    harnessMod.setRunner(fake3.runner);
    await cto.restartCtoAgent(DIR, { fresh: true });
    const launched = fake3.calls.agentStart[0]!.argv.join(" ");
    expect(launched).toContain("--session-id");
    expect(launched).not.toContain(`--resume ${sid}`);
    expect(row()!.session_id).not.toBe(sid);
  });

  test("two workspaces run independent CTO agents (distinct names/sessions/rows)", async () => {
    const f1 = makeFake({ alive: false });
    harnessMod.setRunner(f1.runner);
    await cto.startCtoAgent(DIR);

    const f2 = makeFake({ alive: false });
    harnessMod.setRunner(f2.runner);
    await cto.startCtoAgent(DIR2);

    expect(cto.ctoAgentName(DIR)).not.toBe(cto.ctoAgentName(DIR2));
    expect(f1.calls.agentStart[0]!.name).toBe(cto.ctoAgentName(DIR));
    expect(f2.calls.agentStart[0]!.name).toBe(cto.ctoAgentName(DIR2));
    // DIR has a seeded session; DIR2 has none → a fresh --session-id.
    expect(row(DIR)!.session_id).toBe(SEED);
    expect(row(DIR2)!.session_id).not.toBe(SEED);
    expect(f2.calls.agentStart[0]!.argv.join(" ")).toContain("--session-id");
    // The DIR2 MCP config is scoped to DIR2.
    const mcp2 = JSON.parse(readFileSync(join(cfgMod.config.dataDir, "cto", DIR2, "mcp.json"), "utf8"));
    expect(mcp2.mcpServers["butchr-cto-channel"].env.BUTCHR_CHANNEL_WORKSPACE).toBe(DIR2);
  });
});

describe("CTO agent boot reconcile (per workspace)", () => {
  test("adopts an already-live pane (no relaunch)", async () => {
    const { runner, calls } = makeFake({ alive: true });
    harnessMod.setRunner(runner);

    const res = await cto.reconcileCtoAgent(DIR, true);

    expect(res.action).toBe("adopted");
    expect(calls.agentStart.length).toBe(0);
    expect(row()!.herdr_pane_id).toBe("pane-live");
  });

  test("(re)launches when no live agent exists", async () => {
    const { runner, calls } = makeFake({ alive: false });
    harnessMod.setRunner(runner);

    const res = await cto.reconcileCtoAgent(DIR, true);

    expect(res.action).toBe("launched");
    expect(calls.agentStart.length).toBe(1);
    expect(row()!.herdr_pane_id).toBe("pane-final");
  });

  test("respects an operator stop (desired=0) across a restart", async () => {
    dbMod.saveCtoAgentRow(DIR, { desired: 0 });
    const { runner, calls } = makeFake({ alive: false });
    harnessMod.setRunner(runner);

    const res = await cto.reconcileCtoAgent(DIR, true);

    expect(res.action).toBe("stopped");
    expect(calls.agentStart.length).toBe(0);
  });

  test("is DISABLED when the workspace is not CTO-enabled", async () => {
    // cto_enabled=0 → off regardless of the global default.
    dbMod.db.query(`UPDATE workspaces SET cto_enabled=0 WHERE id=?`).run(DIR);
    const { runner, calls } = makeFake({ alive: false });
    harnessMod.setRunner(runner);
    const res = await cto.reconcileCtoAgent(DIR, true);
    expect(res.action).toBe("disabled");
    expect(calls.agentStart.length).toBe(0);
    dbMod.db.query(`UPDATE workspaces SET cto_enabled=1 WHERE id=?`).run(DIR); // restore
  });

  test("is a no-op when herdr is down (defer to the supervisor)", async () => {
    const { runner, calls } = makeFake({ alive: false });
    harnessMod.setRunner(runner);
    const res = await cto.reconcileCtoAgent(DIR, false);
    expect(res.action).toBe("skipped");
    expect(calls.agentStart.length).toBe(0);
  });

  test("reconcileCtoAgents folds every workspace into aggregate counts", async () => {
    const { runner } = makeFake({ alive: false });
    harnessMod.setRunner(runner);
    const counts = await cto.reconcileCtoAgents(true);
    // Both DIR and DIR2 are enabled + have no live agent → both launched.
    expect(counts.launched).toBeGreaterThanOrEqual(2);
  });
});

describe("CTO agent reboot auto-recovery (adopt requires a LIVE claude process)", () => {
  // adoptOrLaunch (driven through reconcileCtoAgent) must not adopt a registered-but-DEAD
  // pane: after a host reboot herdr keeps the agent NAME/pane (a bare shell) while claude
  // is gone, so `agentExists` lies. We gate adopt on the OS-process probe (claudeLiveness),
  // injected here via the liveness module's lister so no real processes are touched.
  const SID = "cto-sess-reboot";

  afterEach(() => {
    livenessMod.setCmdlineLister(null); // restore the real /proc lister for other suites
  });

  test("pane-exists + claude ALIVE → ADOPTS (no relaunch)", async () => {
    dbMod.saveCtoAgentRow(DIR, { session_id: SID, herdr_pane_id: "pane-stale", herdr_tab_id: "tab-stale", desired: 1 });
    // A live process carries the session id as a distinct argv token → "alive".
    livenessMod.setCmdlineLister(() => [["claude", "--resume", SID, "--mcp-config", "x"]]);
    const { runner, calls } = makeFake({ alive: true });
    harnessMod.setRunner(runner);

    const res = await cto.reconcileCtoAgent(DIR, true);

    expect(res.action).toBe("adopted");
    expect(calls.agentStart.length).toBe(0); // healthy CTO is NEVER relaunched
    expect(calls.teardownTask).toBe(0); // and the live pane is left untouched
  });

  test("pane-exists + claude DEAD → RELAUNCHES via --resume, tearing down the stale pane FIRST (THE REBOOT CASE)", async () => {
    dbMod.saveCtoAgentRow(DIR, { session_id: SID, herdr_pane_id: "pane-stale", herdr_tab_id: "tab-stale", desired: 1 });
    // /proc is readable (non-empty) but NO process carries the session id → "dead".
    livenessMod.setCmdlineLister(() => [["bash", "-lc", "sleep"], ["systemd"]]);
    const { runner, calls } = makeFake({ alive: true }); // pane/name still registered (husk shell)
    harnessMod.setRunner(runner);

    const res = await cto.reconcileCtoAgent(DIR, true);

    expect(res.action).toBe("launched");
    expect(calls.agentStart.length).toBe(1);
    // Context preserved: the relaunch RESUMES the persisted session.
    expect(calls.agentStart[0]!.argv.join(" ")).toContain(`--resume ${SID}`);
    // The stale pane/tab was torn down + the name freed BEFORE the relaunch.
    expect(calls.teardownTask).toBe(1);
    expect(calls.teardownArgs[0]).toEqual({ tab: "tab-stale", name: cto.ctoAgentName(DIR), pane: "pane-stale" });
    expect(calls.agentDeregister).toBeGreaterThanOrEqual(1);
    const firstStart = calls.order.indexOf("agentStart");
    expect(calls.order.indexOf("teardownTask")).toBeLessThan(firstStart);
    expect(calls.order.indexOf("agentDeregister")).toBeLessThan(firstStart);
    expect(row()!.session_id).toBe(SID); // same session preserved on the row
  });

  test("pane-exists but the probe CANNOT run (empty lister / no /proc) → ADOPTS (indeterminate, never double-launch)", async () => {
    dbMod.saveCtoAgentRow(DIR, { session_id: SID, herdr_pane_id: "pane-stale", herdr_tab_id: "tab-stale", desired: 1 });
    livenessMod.setCmdlineLister(() => []); // can't prove anything → "unknown"
    const { runner, calls } = makeFake({ alive: true });
    harnessMod.setRunner(runner);

    const res = await cto.reconcileCtoAgent(DIR, true);

    expect(res.action).toBe("adopted"); // indeterminate signal → adopt, do NOT relaunch
    expect(calls.agentStart.length).toBe(0);
    expect(calls.teardownTask).toBe(0);
  });

  test("pane-ABSENT → LAUNCHES (nothing to adopt)", async () => {
    livenessMod.setCmdlineLister(() => [["bash", "-lc", "sleep"]]); // irrelevant: no pane registered
    const { runner, calls } = makeFake({ alive: false }); // agentExists → false
    harnessMod.setRunner(runner);

    const res = await cto.reconcileCtoAgent(DIR, true);

    expect(res.action).toBe("launched");
    expect(calls.agentStart.length).toBe(1);
  });
});

describe("CTO agent supervision (per workspace)", () => {
  test("a supervised relaunch on death RESUMES the same session (not a cold start)", async () => {
    const up = makeFake({ alive: false });
    harnessMod.setRunner(up.runner);
    await cto.startCtoAgent(DIR);
    const sid = row()!.session_id!;
    const restartsBefore = row()!.restarts;

    // New backend reporting the agent DEAD (alive=false) — the supervisor must relaunch.
    const dead = makeFake({ alive: false });
    harnessMod.setRunner(dead.runner);
    cto._resetSupervisionStateForTest(DIR); // clear backoff so the tick fires immediately

    await cto._superviseTickForTest(DIR);

    expect(dead.calls.agentStart.length).toBe(1);
    const launched = dead.calls.agentStart[0]!.argv.join(" ");
    expect(launched).toContain(`--resume ${sid}`); // RESUME — never cold-start
    expect(launched).not.toContain("--session-id");
    expect(row()!.session_id).toBe(sid); // same session preserved
    expect(row()!.restarts).toBe(restartsBefore + 1); // counted as a supervised relaunch
  });

  test("a healthy tick does nothing (and resets backoff)", async () => {
    const up = makeFake({ alive: false });
    harnessMod.setRunner(up.runner);
    await cto.startCtoAgent(DIR);

    const live = makeFake({ alive: true });
    harnessMod.setRunner(live.runner);
    await cto._superviseTickForTest(DIR);
    expect(live.calls.agentStart.length).toBe(0);
  });

  test("does NOT relaunch when the operator wants it down (desired=0)", async () => {
    dbMod.saveCtoAgentRow(DIR, { desired: 0, session_id: "x" });
    const dead = makeFake({ alive: false });
    harnessMod.setRunner(dead.runner);
    await cto._superviseTickForTest(DIR);
    expect(dead.calls.agentStart.length).toBe(0);
  });
});

describe("CTO agent status (the /api/workspaces/:id/cto payload)", () => {
  test("reports the persisted record + live state", async () => {
    const { runner } = makeFake({ alive: false });
    harnessMod.setRunner(runner);
    await cto.startCtoAgent(DIR);

    const s = await cto.ctoAgentStatus(DIR);
    expect(s.workspaceId).toBe(DIR);
    expect(s.enabled).toBe(true);
    expect(s.desired).toBe(true);
    expect(s.running).toBe(true);
    expect(s.sessionId).toBe(SEED);
    expect(typeof s.restarts).toBe("number");
    expect(s.paneId).toBe("pane-final");
  });
});

describe("isCtoEnabled resolution (per-workspace wins over the global default)", () => {
  test("explicit 1/0 override the global default; NULL inherits it", async () => {
    dbMod.db.query(`UPDATE workspaces SET cto_enabled=1 WHERE id=?`).run(DIR);
    expect(cto.isCtoEnabled(DIR)).toBe(true);
    dbMod.db.query(`UPDATE workspaces SET cto_enabled=0 WHERE id=?`).run(DIR);
    expect(cto.isCtoEnabled(DIR)).toBe(false);

    dbMod.db.query(`UPDATE workspaces SET cto_enabled=NULL WHERE id=?`).run(DIR);
    cfgMod.config.ctoAgentEnabled = false;
    expect(cto.isCtoEnabled(DIR)).toBe(false); // inherit global OFF
    cfgMod.config.ctoAgentEnabled = true;
    expect(cto.isCtoEnabled(DIR)).toBe(true); // inherit global ON

    // restore the suite's invariant
    cfgMod.config.ctoAgentEnabled = false;
    dbMod.db.query(`UPDATE workspaces SET cto_enabled=1 WHERE id=?`).run(DIR);
    expect(cto.isCtoEnabled("dir-nonexistent")).toBe(false);
  });
});
