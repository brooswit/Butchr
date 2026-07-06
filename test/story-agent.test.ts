// Tests for the PER-STORY MANAGED STORY-LEADER AGENT (src/story-agent.ts, Phase 3 of the
// STORIES epic) driven through a FAKE AgentRunner backend — no real herdr or claude. butchr
// runs ONE story-leader agent per OPEN story (in its workspace's repo root); every lifecycle
// op is scoped to a story_id. The module talks to the swappable `harness` proxy, so
// setRunner() drops in a fake whose liveness (`agentExists`) and recorded calls we control.
// This MIRRORS test/cto-agent.test.ts's fake-runner harness + gate-command.test.ts's setup.
//
// What this exercises:
//   - LIFECYCLE (scoped to a story): launch launches through the harness with cwd = the
//     workspace repo root, the Phase-4 story-scoped channel wiring (--mcp-config +
//     dev-channels flag, the per-story MCP config scoped via BUTCHR_CHANNEL_STORY), fresh
//     session on first launch; stop tears it down; restart resumes the SAME session;
//     restart(fresh) cold-starts a new one.
//   - SINGLE INSTANCE PER STORY: a launch when one is already live ADOPTS it.
//   - BOOT RECONCILE: adopt a live pane vs (re)launch a dead one; honor a prior stop;
//     disabled (story not open); herdr-down skip.
//   - SUPERVISED RELAUNCH on death RESUMES the same session.
//   - CRUD LIFECYCLE WIRING: createStory marks the leader desired + creates a story_agent
//     row; updateStory→done/aborted clears desired + tears down; updateStory→open on a TERMINAL
//     story is a guarded no-op (st-a632b2cc F2 — no leader relaunch); deleteStory removes the
//     story_agent row (and teardown is attempted); unregistering the WORKSPACE cascade-removes
//     its story_agent rows.
//
// config fields are set DIRECTLY on the imported config object (deterministic regardless of
// bun's shared-config import order).
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
let storiesMod: typeof import("../src/stories.ts");
let dirsMod: typeof import("../src/workspaces.ts");
let sa: typeof import("../src/story-agent.ts");
let originalRunner: AgentRunner;

const WS = "dir-storytest1";
const WS2 = "dir-storytest2";

function insertWorkspace(id: string): void {
  dbMod.db
    .query(
      `INSERT OR IGNORE INTO workspaces (id, path, label, herdr_workspace, herdr_pane, created_at)
       VALUES (?, ?, ?, NULL, NULL, ?)`,
    )
    .run(id, join(DATA_DIR, id), id, dbMod.nowIso());
}

/** Insert a story row DIRECTLY (bypasses the createStory launch hook) with a given status.
 *  Materializes the node's `tasks` row too (as production's createStory does) so the B.4-flipped
 *  read accessors — reading the node's own tasks row — resolve it. */
function insertStory(id: string, workspaceId: string, status = "open"): void {
  dbMod.db
    .query(`INSERT INTO stories (id, workspace_id, brief, status, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(id, workspaceId, `brief for ${id}`, status, dbMod.nowIso());
  dbMod.ensureStoryWorkNode(id);
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-story-data-"));
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  cfgMod = await import("../src/config.ts");
  dbMod = await import("../src/db.ts");
  harnessMod = await import("../src/harness.ts");
  livenessMod = await import("../src/liveness.ts");
  dirsMod = await import("../src/workspaces.ts");
  storiesMod = await import("../src/stories.ts");
  sa = await import("../src/story-agent.ts");
  originalRunner = harnessMod.getRunner();

  // This file exercises the LEGACY per-kind story-leader supervisor. Pin the unified-workspace
  // gate OFF (it DEFAULTS ON as of step 6b, where the unified supervisor would otherwise no-op
  // the legacy reconcile/supervise paths under test).
  cfgMod.config.unifiedWorkspaceEnabled = false;
  // Pin the supervision/launch config deterministically (reuses the CTO knobs).
  cfgMod.config.ctoAgentName = "butchr-cto-agent";
  cfgMod.config.ctoMaxRestarts = 3;
  cfgMod.config.ctoRestartBackoffBaseMs = 1; // tiny so backoff never gates a test tick
  cfgMod.config.ctoRestartBackoffCapMs = 1;
  // Launch auto-confirm: tiny + quiet-after-one so the (empty-screen) fake loop exits at once.
  cfgMod.config.ctoPromptPollMs = 1;
  cfgMod.config.ctoPromptMaxPolls = 3;
  cfgMod.config.ctoPromptQuietPolls = 1;

  insertWorkspace(WS);
  insertWorkspace(WS2);
});

afterAll(() => {
  harnessMod.setRunner(originalRunner);
  rmSync(DATA_DIR, { recursive: true, force: true });
});

/**
 * A fake backend whose liveness + recorded calls the test drives. Liveness is tracked PER
 * AGENT NAME (so multiple stories' leaders are independent): `opts.alive` pre-seeds every
 * name as already-live (the adopt scenarios); otherwise a name becomes live only once it is
 * started, and is cleared on teardown/deregister. Mirrors the CTO test's makeFake.
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
    teardownArgs: [] as Array<{ name: string }>,
    paneClose: [] as string[],
    order: [] as string[],
  };
  const runner: AgentRunner = {
    async isUp() { return true; },
    async workspaceCreate(_cwd, _label) { calls.workspaceCreate++; return { workspaceId: "story-ws", rootPaneId: "story-rp" }; },
    async workspaceExists() { return false; }, // force a heal → workspaceCreate
    async workspaceClose() {},
    async tabCreate() { return { tabId: "story-tab", rootPaneId: "rp-1" }; },
    async tabClose(id) { calls.tabClose.push(id); },
    async agentTabId(name) { return live(name) ? "story-tab" : undefined; },
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
    isAgentNameTaken() { return false; },
    async agentRead() { return ""; }, // no startup prompt → auto-confirm exits at once
    async send() {},
    async paneClose(target) { calls.paneClose.push(target); },
    async teardownTask(name) {
      calls.teardownTask++;
      calls.teardownArgs.push({ name });
      calls.order.push("teardownTask");
      if (name) started.delete(name);
    },
    async agentDeregister(name) { calls.agentDeregister++; calls.order.push("agentDeregister"); started.delete(name); },
    async runHeadless() { return { ok: true, code: 0, stdout: "", stderr: "", timedOut: false }; },
  };
  return { runner, calls };
}

const row = (id: string) => dbMod.getStoryAgentRow(id);
/** Let fire-and-forget hooks (onStoryCreated launch / deleteStory teardown) settle. */
const flush = () => new Promise((r) => setTimeout(r, 25));

beforeEach(() => {
  // Reset the per-story records, stories, materialized story Work NODES, + in-memory supervision
  // state between scenarios. The db is process-wide across test files (see the top-of-file note),
  // so the scope of each delete matters:
  //   - story_agent GLOBAL: it is a leaf/child table (nothing FK-references it), so a global wipe
  //     is safe and clears any story_agent detritus reconcileStoryAgents left when it enumerated —
  //     via the B.5a work_kind='node' read — OTHER files' open nodes and launched their leaders.
  //   - stories + their materialized `tasks` nodes SCOPED to THIS file (`dir-storytest*`): a global
  //     `DELETE FROM stories` would delete OTHER files' stories while their `tasks` nodes survive,
  //     breaking the node⟺stories lock-step that reconcileStoryAgents' saveStoryAgentRow FK relies
  //     on (and a global node delete would FK-crash on their inbound referrers). The two scoped
  //     deletes clear this file's stories + nodes IN LOCK-STEP (as production's deleteStory removes
  //     both together), so no stale node leaks into the next scenario and other files stay consistent.
  dbMod.db.query(`DELETE FROM story_agent`).run();
  dbMod.db
    .query(`DELETE FROM tasks WHERE work_kind='node' AND workspace_id LIKE 'dir-storytest%'`)
    .run();
  dbMod.db.query(`DELETE FROM stories WHERE workspace_id LIKE 'dir-storytest%'`).run();
  sa._resetSupervisionStateForTest();
});

describe("story-leader lifecycle (per story)", () => {
  test("launch launches through the harness with cwd = the repo root + the story-scoped channel", async () => {
    insertStory("st-launch", WS);
    const { runner, calls } = makeFake({ alive: false });
    harnessMod.setRunner(runner);

    const status = await sa.launchStoryAgent("st-launch");

    expect(calls.agentStart.length).toBe(1);
    const start = calls.agentStart[0]!;
    expect(start.name).toBe(sa.storyAgentName("st-launch"));
    expect(start.name).toContain("st-launch");
    expect(start.name).toContain("-story-"); // disambiguating infix vs the CTO name
    expect(start.cwd).toBe(join(DATA_DIR, WS)); // the story's WORKSPACE repo root
    const launched = start.argv.join(" ");
    // First launch with no persisted/seeded session → a FRESH --session-id.
    expect(launched).toContain("--session-id");
    expect(launched).not.toContain("--resume");
    // PHASE 4: the channel feed is now wired — the development-channel flag + the per-story
    // MCP config (mirrors the CTO agent's channel wiring).
    expect(launched).toContain("--dangerously-load-development-channels server:butchr-cto-channel");
    expect(launched).toContain("--mcp-config");
    // The MCP config registers the channel stdio server SCOPED to THIS story (and carries the
    // workspace id for SSE filtering / the workspace label).
    const mcp = JSON.parse(
      readFileSync(join(cfgMod.config.dataDir, "story", "st-launch", "mcp.json"), "utf8"),
    );
    expect(mcp.mcpServers["butchr-cto-channel"]).toBeTruthy();
    expect(mcp.mcpServers["butchr-cto-channel"].env.BUTCHR_CHANNEL_SSE_URL).toContain("/api/events");
    expect(mcp.mcpServers["butchr-cto-channel"].env.BUTCHR_CHANNEL_STORY).toBe("st-launch");
    expect(mcp.mcpServers["butchr-cto-channel"].env.BUTCHR_CHANNEL_WORKSPACE).toBe(WS);
    // Placed in the dedicated tab; husk root pane closed.
    expect(start.tabId).toBe("story-tab");
    expect(calls.paneClose).toContain("rp-1");

    const r = row("st-launch")!;
    expect(r.story_id).toBe("st-launch");
    expect(r.desired).toBe(1);
    expect(r.restarts).toBe(0);
    expect(status.storyId).toBe("st-launch");
    expect(status.running).toBe(true); // attachable BY NAME (no stored pane)
    expect(status.desired).toBe(true);
  });

  test("a launch while already live ADOPTS (single instance — no second launch)", async () => {
    insertStory("st-adopt", WS);
    const { runner, calls } = makeFake({ alive: true });
    harnessMod.setRunner(runner);

    const status = await sa.launchStoryAgent("st-adopt");

    expect(calls.agentStart.length).toBe(0); // adopted, not relaunched
    expect(status.running).toBe(true);
    expect(row("st-adopt")!.desired).toBe(1);
  });

  test("stop tears the leader down and marks it desired-down", async () => {
    insertStory("st-stop", WS);
    const { runner, calls } = makeFake({ alive: false });
    harnessMod.setRunner(runner);
    await sa.launchStoryAgent("st-stop");

    const status = await sa.stopStoryAgent("st-stop");

    expect(calls.teardownTask).toBe(1);
    expect(calls.agentDeregister).toBeGreaterThanOrEqual(1);
    expect(status.running).toBe(false);
    expect(status.desired).toBe(false);
    const r = row("st-stop")!;
    expect(r.desired).toBe(0);
  });

  test("restart RESUMES the same session; restart(fresh) cold-starts a NEW one", async () => {
    insertStory("st-restart", WS);
    const fake1 = makeFake({ alive: false });
    harnessMod.setRunner(fake1.runner);
    await sa.launchStoryAgent("st-restart");
    const sid = row("st-restart")!.session_id!;
    expect(sid).toBeTruthy();

    const fake2 = makeFake({ alive: false });
    harnessMod.setRunner(fake2.runner);
    await sa.restartStoryAgent("st-restart");
    expect(fake2.calls.agentStart.length).toBe(1);
    expect(fake2.calls.agentStart[0]!.argv.join(" ")).toContain(`--resume ${sid}`);
    expect(row("st-restart")!.session_id).toBe(sid);

    const fake3 = makeFake({ alive: false });
    harnessMod.setRunner(fake3.runner);
    await sa.restartStoryAgent("st-restart", { fresh: true });
    const launched = fake3.calls.agentStart[0]!.argv.join(" ");
    expect(launched).toContain("--session-id");
    expect(launched).not.toContain(`--resume ${sid}`);
    expect(row("st-restart")!.session_id).not.toBe(sid);
  });
});

describe("story-leader boot reconcile (per story)", () => {
  test("adopts an already-live pane (no relaunch)", async () => {
    insertStory("st-rec-adopt", WS);
    const { runner, calls } = makeFake({ alive: true });
    harnessMod.setRunner(runner);

    const res = await sa.reconcileStoryAgent("st-rec-adopt", true);

    expect(res.action).toBe("adopted");
    expect(calls.agentStart.length).toBe(0);
    expect(row("st-rec-adopt")!.desired).toBe(1); // adoption marks it desired-up
    expect(await sa.storyAgentStatus("st-rec-adopt").then((s) => s.running)).toBe(true);
  });

  test("(re)launches when no live agent exists", async () => {
    insertStory("st-rec-launch", WS);
    const { runner, calls } = makeFake({ alive: false });
    harnessMod.setRunner(runner);

    const res = await sa.reconcileStoryAgent("st-rec-launch", true);

    expect(res.action).toBe("launched");
    expect(calls.agentStart.length).toBe(1);
    expect(row("st-rec-launch")!.desired).toBe(1); // launched + recorded desired-up
  });

  test("respects an operator stop (desired=0) across a restart", async () => {
    insertStory("st-rec-stopped", WS);
    dbMod.saveStoryAgentRow("st-rec-stopped", { desired: 0 });
    const { runner, calls } = makeFake({ alive: false });
    harnessMod.setRunner(runner);

    const res = await sa.reconcileStoryAgent("st-rec-stopped", true);

    expect(res.action).toBe("stopped");
    expect(calls.agentStart.length).toBe(0);
  });

  test("is DISABLED when the story is not open (done/aborted/gone)", async () => {
    insertStory("st-rec-done", WS, "done");
    const { runner, calls } = makeFake({ alive: false });
    harnessMod.setRunner(runner);
    expect((await sa.reconcileStoryAgent("st-rec-done", true)).action).toBe("disabled");
    // A nonexistent story is likewise disabled.
    expect((await sa.reconcileStoryAgent("st-nonexistent", true)).action).toBe("disabled");
    expect(calls.agentStart.length).toBe(0);
  });

  test("is a no-op when herdr is down (defer to the supervisor)", async () => {
    insertStory("st-rec-down", WS);
    const { runner, calls } = makeFake({ alive: false });
    harnessMod.setRunner(runner);
    const res = await sa.reconcileStoryAgent("st-rec-down", false);
    expect(res.action).toBe("skipped");
    expect(calls.agentStart.length).toBe(0);
  });

  test("reconcileStoryAgents folds every open story into aggregate counts", async () => {
    insertStory("st-rec-a", WS);
    insertStory("st-rec-b", WS2);
    insertStory("st-rec-closed", WS, "aborted"); // not open → not counted
    const { runner } = makeFake({ alive: false });
    harnessMod.setRunner(runner);
    const counts = await sa.reconcileStoryAgents(true);
    expect(counts.launched).toBeGreaterThanOrEqual(2);
  });
});

describe("story-leader reboot auto-recovery (adopt requires a LIVE claude process)", () => {
  const SID = "story-sess-reboot";
  afterEach(() => {
    livenessMod.setCmdlineLister(null); // restore the real /proc lister for other suites
  });

  test("pane-exists + claude DEAD → RELAUNCHES via --resume, tearing down the stale pane FIRST", async () => {
    insertStory("st-reboot", WS);
    dbMod.saveStoryAgentRow("st-reboot", { session_id: SID, desired: 1 });
    livenessMod.setCmdlineLister(() => [["bash", "-lc", "sleep"], ["systemd"]]); // no session → dead
    const { runner, calls } = makeFake({ alive: true }); // pane/name still registered (husk shell)
    harnessMod.setRunner(runner);

    const res = await sa.reconcileStoryAgent("st-reboot", true);

    expect(res.action).toBe("launched");
    expect(calls.agentStart.length).toBe(1);
    expect(calls.agentStart[0]!.argv.join(" ")).toContain(`--resume ${SID}`);
    expect(calls.teardownTask).toBe(1);
    expect(calls.teardownArgs[0]).toEqual({ name: sa.storyAgentName("st-reboot") });
    const firstStart = calls.order.indexOf("agentStart");
    expect(calls.order.indexOf("teardownTask")).toBeLessThan(firstStart);
    expect(row("st-reboot")!.session_id).toBe(SID);
  });

  test("pane-exists + claude ALIVE → ADOPTS (no relaunch)", async () => {
    insertStory("st-reboot-alive", WS);
    dbMod.saveStoryAgentRow("st-reboot-alive", { session_id: SID, desired: 1 });
    livenessMod.setCmdlineLister(() => [["claude", "--resume", SID, "--", "x"]]);
    const { runner, calls } = makeFake({ alive: true });
    harnessMod.setRunner(runner);

    const res = await sa.reconcileStoryAgent("st-reboot-alive", true);

    expect(res.action).toBe("adopted");
    expect(calls.agentStart.length).toBe(0);
    expect(calls.teardownTask).toBe(0);
  });
});

describe("story-leader supervision (per story)", () => {
  test("a supervised relaunch on death RESUMES the same session (not a cold start)", async () => {
    insertStory("st-sup", WS);
    const up = makeFake({ alive: false });
    harnessMod.setRunner(up.runner);
    await sa.launchStoryAgent("st-sup");
    const sid = row("st-sup")!.session_id!;
    const restartsBefore = row("st-sup")!.restarts;

    const dead = makeFake({ alive: false }); // reports DEAD → supervisor relaunches
    harnessMod.setRunner(dead.runner);
    sa._resetSupervisionStateForTest("st-sup"); // clear backoff so the tick fires immediately

    await sa._superviseTickForTest("st-sup");

    expect(dead.calls.agentStart.length).toBe(1);
    const launched = dead.calls.agentStart[0]!.argv.join(" ");
    expect(launched).toContain(`--resume ${sid}`);
    expect(launched).not.toContain("--session-id");
    expect(row("st-sup")!.session_id).toBe(sid);
    expect(row("st-sup")!.restarts).toBe(restartsBefore + 1);
  });

  test("a healthy tick does nothing", async () => {
    insertStory("st-sup-ok", WS);
    const up = makeFake({ alive: false });
    harnessMod.setRunner(up.runner);
    await sa.launchStoryAgent("st-sup-ok");

    const live = makeFake({ alive: true });
    harnessMod.setRunner(live.runner);
    await sa._superviseTickForTest("st-sup-ok");
    expect(live.calls.agentStart.length).toBe(0);
  });

  test("does NOT relaunch when the operator wants it down (desired=0)", async () => {
    insertStory("st-sup-down", WS);
    dbMod.saveStoryAgentRow("st-sup-down", { desired: 0, session_id: "x" });
    const dead = makeFake({ alive: false });
    harnessMod.setRunner(dead.runner);
    await sa._superviseTickForTest("st-sup-down");
    expect(dead.calls.agentStart.length).toBe(0);
  });
});

describe("CRUD lifecycle wiring (stories.ts / workspaces.ts → story-agent.ts)", () => {
  test("createStory marks the leader desired + creates a story_agent row", async () => {
    const { runner } = makeFake({ alive: false });
    harnessMod.setRunner(runner);

    const story = storiesMod.createStory(WS, "a new story");
    // The desired-mark + row creation are SYNCHRONOUS (the launch is fire-and-forget).
    const r = row(story.id);
    expect(r).toBeTruthy();
    expect(r!.desired).toBe(1);
    await flush(); // let the fire-and-forget launch settle so it doesn't leak into later tests
  });

  test("updateStory→done clears desired + tears the leader down", async () => {
    const { runner, calls } = makeFake({ alive: false });
    harnessMod.setRunner(runner);
    const story = storiesMod.createStory(WS, "story to finish");
    await flush();

    storiesMod.updateStory(story.id, { status: "done" });
    await flush();

    expect(row(story.id)!.desired).toBe(0);
    expect(calls.teardownTask).toBeGreaterThanOrEqual(1);
  });

  test("updateStory→aborted clears desired + tears the leader down", async () => {
    const { runner, calls } = makeFake({ alive: false });
    harnessMod.setRunner(runner);
    const story = storiesMod.createStory(WS, "story to abort");
    await flush();

    storiesMod.updateStory(story.id, { status: "aborted" });
    await flush();

    expect(row(story.id)!.desired).toBe(0);
    expect(calls.teardownTask).toBeGreaterThanOrEqual(1);
  });

  test("updateStory→open on a TERMINAL story is REJECTED — the leader is NOT relaunched (st-a632b2cc F2)", async () => {
    const { runner } = makeFake({ alive: false });
    harnessMod.setRunner(runner);
    const story = storiesMod.createStory(WS, "story reopen");
    await flush();
    storiesMod.updateStory(story.id, { status: "aborted" });
    await flush();
    expect(row(story.id)!.desired).toBe(0);

    // Re-opening a terminal (aborted/done) story is now a GUARDED no-op: `open`'s only legal
    // source is `open` itself, so the CAS rejects the transition and the leader is NOT relaunched
    // — fixing the bug where writing `open` over a terminal row relaunched a leader for a story
    // whose branch was already merged-and-deleted.
    const reopen = makeFake({ alive: false });
    harnessMod.setRunner(reopen.runner);
    const result = storiesMod.updateStory(story.id, { status: "open" });
    await flush();

    expect(result.status).toBe("aborted"); // unchanged — the reopen was rejected
    expect(row(story.id)!.desired).toBe(0);
    expect(reopen.calls.agentStart.length).toBe(0);
  });

  test("deleteStory removes the story_agent row (and a teardown is attempted)", async () => {
    const { runner, calls } = makeFake({ alive: false });
    harnessMod.setRunner(runner);
    const story = storiesMod.createStory(WS, "story to delete");
    await flush();
    expect(row(story.id)).toBeTruthy();

    storiesMod.deleteStory(story.id);
    await flush();

    // The story_agent row cascades away with the story row.
    expect(row(story.id)).toBeNull();
    expect(dbMod.db.query(`SELECT * FROM story_agent WHERE story_id=?`).get(story.id)).toBeNull();
    // A leader teardown was attempted.
    expect(calls.teardownTask).toBeGreaterThanOrEqual(1);
  });

  test("unregistering the WORKSPACE cascade-removes its story_agent rows", async () => {
    // A throwaway workspace inserted directly (registerWorkspace would need a live herdr).
    const WS_DEL = "dir-storytest-del";
    insertWorkspace(WS_DEL);
    const { runner } = makeFake({ alive: false });
    harnessMod.setRunner(runner);
    const s1 = storiesMod.createStory(WS_DEL, "ws story 1");
    const s2 = storiesMod.createStory(WS_DEL, "ws story 2");
    await flush();
    expect(row(s1.id)).toBeTruthy();
    expect(row(s2.id)).toBeTruthy();

    await dirsMod.unregisterWorkspace(WS_DEL);

    // Both stories + their story_agent rows cascade away with the workspace.
    expect(row(s1.id)).toBeNull();
    expect(row(s2.id)).toBeNull();
    expect(dbMod.db.query(`SELECT COUNT(*) AS n FROM story_agent`).get()).toMatchObject({ n: 0 });
  });
});
