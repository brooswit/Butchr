// Tests for the MANAGED CTO AGENT (src/cto-agent.ts) driven through a FAKE
// AgentRunner backend — no real herdr or claude. Mirrors test/harness.test.ts: the
// module talks to the swappable `harness` proxy, so setRunner() drops in a fake whose
// liveness (`agentExists`) and recorded calls we control.
//
// What this exercises:
//   - LIFECYCLE: start launches through the harness RESUMING the operator-seeded
//     session (first launch), wired to the channel (dev-channel flag + MCP config);
//     stop tears the agent down; restart resumes the SAME session; restart(fresh)
//     cold-starts a brand-new one.
//   - SINGLE INSTANCE: a start when one is already live ADOPTS it (no second launch).
//   - BOOT RECONCILE: adopt a live pane vs (re)launch a dead one.
//   - SUPERVISED RELAUNCH on death RESUMES the same session via `--resume` (NOT a
//     cold `--session-id` start).
//   - STATUS shape (the data behind the /api/cto endpoints).
//
// config fields are set DIRECTLY on the imported config object (not via env) so the
// test is deterministic regardless of bun's shared-config import order.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunner, PaneInfo, StartedAgent } from "../src/harness.ts";

let DATA_DIR: string;
let dbMod: typeof import("../src/db.ts");
let cfgMod: typeof import("../src/config.ts");
let harnessMod: typeof import("../src/harness.ts");
let cto: typeof import("../src/cto-agent.ts");
let originalRunner: AgentRunner;

const SEED = "seed-session-aaaa";

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-cto-data-"));
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  cfgMod = await import("../src/config.ts");
  dbMod = await import("../src/db.ts");
  harnessMod = await import("../src/harness.ts");
  cto = await import("../src/cto-agent.ts");
  originalRunner = harnessMod.getRunner();

  // Pin the CTO-agent config deterministically (mutating the singleton is robust to
  // import order — unlike env, which only wins if this file imports config first).
  cfgMod.config.ctoAgentEnabled = true;
  cfgMod.config.ctoSessionId = SEED;
  cfgMod.config.ctoAgentName = "butchr-cto-agent";
  cfgMod.config.ctoCwd = DATA_DIR;
  cfgMod.config.ctoBriefPath = "";
  cfgMod.config.ctoMaxRestarts = 3;
  cfgMod.config.ctoRestartBackoffBaseMs = 1; // tiny so backoff never gates a test tick
  cfgMod.config.ctoRestartBackoffCapMs = 1;
});

afterAll(() => {
  harnessMod.setRunner(originalRunner);
  rmSync(DATA_DIR, { recursive: true, force: true });
});

/** A fake backend whose liveness + recorded calls the test drives. */
function makeFake(opts: { alive?: boolean; resolvedPane?: string } = {}) {
  const state = { alive: opts.alive ?? false, pane: opts.alive ? "pane-live" : undefined as string | undefined };
  const resolvedPane = opts.resolvedPane ?? "pane-final";
  const calls = {
    agentStart: [] as Array<{ argv: string[]; tabId?: string }>,
    workspaceCreate: 0,
    tabClose: [] as Array<string | null | undefined>,
    agentDeregister: 0,
    teardownTask: 0,
    paneClose: [] as string[],
  };
  const runner: AgentRunner = {
    async isUp() { return true; },
    async workspaceCreate(_cwd, _label) { calls.workspaceCreate++; return { workspaceId: "cto-ws", rootPaneId: "cto-rp" }; },
    async workspaceExists() { return false; }, // force a heal → workspaceCreate
    async workspaceClose() {},
    async tabCreate() { return { tabId: "cto-tab", rootPaneId: "rp-1" }; },
    async tabClose(id) { calls.tabClose.push(id); },
    async agentTabId() { return state.alive ? "cto-tab" : undefined; },
    async agentStart(_name, _cwd, argv, _ws, tabId): Promise<StartedAgent> {
      calls.agentStart.push({ argv, tabId });
      state.alive = true;
      state.pane = "pane-raw";
      return { paneId: "pane-raw", terminalId: "term-1" };
    },
    async agentExists() { return state.alive; },
    async agentPaneId() { return state.alive ? state.pane : undefined; },
    async agentTerminalId() { return state.alive ? "term-1" : undefined; },
    async paneTerminalId() { return "rootterm"; },
    async paneList(): Promise<PaneInfo[]> { return []; },
    async resolveAgentPane() { state.pane = resolvedPane; return resolvedPane; },
    isAgentNameTaken() { return false; },
    async agentRead() { return ""; },
    async send() {},
    async paneClose(target) { calls.paneClose.push(target); },
    async teardownTask() { calls.teardownTask++; state.alive = false; state.pane = undefined; },
    async agentDeregister() { calls.agentDeregister++; state.alive = false; state.pane = undefined; },
    async runHeadless() { return { ok: true, code: 0, stdout: "", stderr: "", timedOut: false }; },
  };
  return { runner, calls, state };
}

const row = () => dbMod.getCtoAgentRow();

beforeEach(() => {
  // Reset the singleton record + in-memory supervision state between scenarios.
  dbMod.db.query(`DELETE FROM cto_agent`).run();
  cto._resetSupervisionStateForTest();
});

describe("CTO agent lifecycle", () => {
  test("start launches through the harness, RESUMING the seeded session + wiring the channel", async () => {
    const { runner, calls } = makeFake({ alive: false });
    harnessMod.setRunner(runner);

    const status = await cto.startCtoAgent();

    expect(calls.agentStart.length).toBe(1);
    const launched = calls.agentStart[0]!.argv.join(" ");
    // First launch resumes the operator-seeded session (NOT a fresh --session-id).
    expect(launched).toContain(`--resume ${SEED}`);
    expect(launched).not.toContain("--session-id");
    // Channel wiring: the development-channel flag + the per-CTO MCP config.
    expect(launched).toContain("--dangerously-load-development-channels server:butchr-cto-channel");
    expect(launched).toContain("--mcp-config");
    // Placed in the dedicated tab; husk root pane closed; real pane re-resolved.
    expect(calls.agentStart[0]!.tabId).toBe("cto-tab");
    expect(calls.paneClose).toContain("rp-1");

    // The MCP config registers the channel stdio server. (Read from the LIVE
    // config.dataDir — bun shares the config singleton across files, so it may be a
    // sibling file's temp dir rather than this file's DATA_DIR, depending on import
    // order; cto-agent writes the config under config.dataDir.)
    const mcp = JSON.parse(readFileSync(join(cfgMod.config.dataDir, "cto", "mcp.json"), "utf8"));
    expect(mcp.mcpServers["butchr-cto-channel"]).toBeTruthy();
    expect(mcp.mcpServers["butchr-cto-channel"].env.BUTCHR_CHANNEL_SSE_URL).toContain("/api/events");

    // Persisted record + returned status.
    const r = row()!;
    expect(r.session_id).toBe(SEED);
    expect(r.herdr_pane_id).toBe("pane-final");
    expect(r.herdr_tab_id).toBe("cto-tab");
    expect(r.desired).toBe(1);
    expect(r.restarts).toBe(0);
    expect(status.running).toBe(true);
    expect(status.sessionId).toBe(SEED);
    expect(status.paneId).toBe("pane-final");
  });

  test("a start while already live ADOPTS (single instance — no second launch)", async () => {
    const { runner, calls } = makeFake({ alive: true });
    harnessMod.setRunner(runner);

    const status = await cto.startCtoAgent();

    expect(calls.agentStart.length).toBe(0); // adopted, not relaunched
    expect(status.running).toBe(true);
    expect(row()!.desired).toBe(1);
    expect(row()!.herdr_pane_id).toBe("pane-live");
  });

  test("stop tears the agent down and marks it desired-down", async () => {
    const { runner, calls } = makeFake({ alive: false });
    harnessMod.setRunner(runner);
    await cto.startCtoAgent();

    const status = await cto.stopCtoAgent();

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
    await cto.startCtoAgent();
    const sid = row()!.session_id;
    expect(sid).toBe(SEED);

    // Plain restart → same session via --resume.
    const fake2 = makeFake({ alive: false });
    harnessMod.setRunner(fake2.runner);
    await cto.restartCtoAgent();
    expect(fake2.calls.agentStart.length).toBe(1);
    expect(fake2.calls.agentStart[0]!.argv.join(" ")).toContain(`--resume ${sid}`);
    expect(row()!.session_id).toBe(sid);

    // Fresh restart → a brand-new --session-id (different from the seed).
    const fake3 = makeFake({ alive: false });
    harnessMod.setRunner(fake3.runner);
    await cto.restartCtoAgent({ fresh: true });
    const launched = fake3.calls.agentStart[0]!.argv.join(" ");
    expect(launched).toContain("--session-id");
    expect(launched).not.toContain(`--resume ${sid}`);
    expect(row()!.session_id).not.toBe(sid);
  });
});

describe("CTO agent boot reconcile", () => {
  test("adopts an already-live pane (no relaunch)", async () => {
    const { runner, calls } = makeFake({ alive: true });
    harnessMod.setRunner(runner);

    const res = await cto.reconcileCtoAgent(true);

    expect(res.action).toBe("adopted");
    expect(calls.agentStart.length).toBe(0);
    expect(row()!.herdr_pane_id).toBe("pane-live");
  });

  test("(re)launches when no live agent exists", async () => {
    const { runner, calls } = makeFake({ alive: false });
    harnessMod.setRunner(runner);

    const res = await cto.reconcileCtoAgent(true);

    expect(res.action).toBe("launched");
    expect(calls.agentStart.length).toBe(1);
    expect(row()!.herdr_pane_id).toBe("pane-final");
  });

  test("respects an operator stop (desired=0) across a restart", async () => {
    // Simulate a prior explicit stop.
    dbMod.saveCtoAgentRow({ desired: 0 });
    const { runner, calls } = makeFake({ alive: false });
    harnessMod.setRunner(runner);

    const res = await cto.reconcileCtoAgent(true);

    expect(res.action).toBe("stopped");
    expect(calls.agentStart.length).toBe(0);
  });

  test("is a no-op when herdr is down (defer to the supervisor)", async () => {
    const { runner, calls } = makeFake({ alive: false });
    harnessMod.setRunner(runner);
    const res = await cto.reconcileCtoAgent(false);
    expect(res.action).toBe("skipped");
    expect(calls.agentStart.length).toBe(0);
  });
});

describe("CTO agent supervision", () => {
  test("a supervised relaunch on death RESUMES the same session (not a cold start)", async () => {
    // Bring it up so the session is persisted, then simulate the agent dying.
    const up = makeFake({ alive: false });
    harnessMod.setRunner(up.runner);
    await cto.startCtoAgent();
    const sid = row()!.session_id!;
    const restartsBefore = row()!.restarts;

    // New backend reporting the agent DEAD (alive=false) — the supervisor must relaunch.
    const dead = makeFake({ alive: false });
    harnessMod.setRunner(dead.runner);
    cto._resetSupervisionStateForTest(); // clear backoff so the tick fires immediately

    await cto._superviseTickForTest();

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
    await cto.startCtoAgent();

    // Agent is alive → tick must not relaunch.
    const live = makeFake({ alive: true });
    harnessMod.setRunner(live.runner);
    await cto._superviseTickForTest();
    expect(live.calls.agentStart.length).toBe(0);
  });

  test("does NOT relaunch when the operator wants it down (desired=0)", async () => {
    dbMod.saveCtoAgentRow({ desired: 0, session_id: "x" });
    const dead = makeFake({ alive: false });
    harnessMod.setRunner(dead.runner);
    await cto._superviseTickForTest();
    expect(dead.calls.agentStart.length).toBe(0);
  });
});

describe("CTO agent status (the /api/cto payload)", () => {
  test("reports the persisted record + live state", async () => {
    const { runner } = makeFake({ alive: false });
    harnessMod.setRunner(runner);
    await cto.startCtoAgent();

    const s = await cto.ctoAgentStatus();
    expect(s.enabled).toBe(true);
    expect(s.desired).toBe(true);
    expect(s.running).toBe(true);
    expect(s.sessionId).toBe(SEED);
    expect(typeof s.restarts).toBe("number");
    expect(s.paneId).toBe("pane-final");
  });
});
