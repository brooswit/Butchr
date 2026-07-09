// POST /api/work/:id/leader/terminal — the STORY-LEADER analog of the CTO/CEO terminal-attach
// routes (server.ts): open a GUI terminal attached to a story's managed leader agent pane. This
// suite pins the guarded outcomes:
//   - 404 when the id is not a story NODE — a LEAF (whose build-agent terminal is the pre-existing
//     POST /api/work/:id/terminal) and an unknown id alike. This DIVERGES from the sibling
//     assertWorkLeaf(), which answers 409 on a wrong-kind id: a leaf has no `leader/terminal`
//     sub-resource at all. Deliberate — these two cases pin it so nobody "fixes" it to a 409.
//   - 409 when the leader has no live pane, with an HONEST reason off the real StoryAgentStatus
//     fields — and the `desired && !running` and `!desired` reasons must be DIFFERENT strings that
//     each name their own case. That assertion is the whole point of the word HONEST.
//   - the happy path returning the attach payload, targeting storyAgentName(storyId), when live.
//
// The REAL server runs IN-PROCESS on an ephemeral port (BUTCHR_PORT=0) against a private BUTCHR_DB
// with BUTCHR_HERDR_BIN=`true` (every herdr probe a harmless no-op). Liveness is forced WITHOUT a
// real herdr: a fake AgentRunner whose `agentExists` reads a live-set (via setRunner) + a desired
// story_agent row written directly. The story NODE and LEAF rows are INSERTed directly rather than
// created through the API, so the leader launcher never fires and each test owns its story_agent
// state outright. The terminal spawn is stubbed via BUTCHR_TERMINAL_CMD + setTerminalDeps so no
// real GUI/emulator is touched.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunner, PaneInfo, StartedAgent } from "../src/harness.ts";

let DATA_DIR: string;
let REPO_ROOT: string;
let BASE: string;
let WS: string;
let server: ReturnType<typeof import("../src/server.ts").startServer>;

let cfgMod: typeof import("../src/config.ts");
let dbMod: typeof import("../src/db.ts");
let harnessMod: typeof import("../src/harness.ts");
let terminalMod: typeof import("../src/terminal.ts");
let serverMod: typeof import("../src/server.ts");
let wsAgentMod: typeof import("../src/workspace-agent.ts");
let originalRunner: AgentRunner;

/** A live set the fake runner's `agentExists` reads — the ONLY method liveness needs. */
const liveAgents = new Set<string>();

/** A minimal AgentRunner: `agentExists` reads `liveAgents`; every other method is an inert stub
 *  (the route never launches — we assert on the READ path only). */
function makeFakeRunner(): AgentRunner {
  return {
    async isUp() { return true; },
    async workspaceCreate() { return { workspaceId: "ws", rootPaneId: "rp" }; },
    async workspaceExists() { return true; },
    async workspaceClose() {},
    async tabCreate() { return { tabId: "tab", rootPaneId: "rp" }; },
    async tabClose() {},
    async agentTabId() { return undefined; },
    async agentStart(): Promise<StartedAgent> { return { paneId: "p", terminalId: "t" }; },
    async agentExists(name) { return liveAgents.has(name); },
    async agentPaneId(name) { return liveAgents.has(name) ? "p" : undefined; },
    async agentTerminalId() { return "t"; },
    async paneTerminalId() { return "t"; },
    async paneList(): Promise<PaneInfo[]> { return []; },
    async resolveAgentPane() { return "p"; },
    isAgentNameTaken() { return false; },
    async agentRead() { return ""; },
    async send() {},
    async paneClose() {},
    async teardownTask() {},
    async agentDeregister() {},
    async runHeadless() { return { ok: true, code: 0, stdout: "", stderr: "", timedOut: false }; },
  };
}

async function apiSend(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

let seq = 0;

/** A story NODE row, inserted straight into `tasks` (work_kind='node'), no leader launched. */
function makeStory(): string {
  const id = `st-leaderterm-${++seq}`;
  dbMod.db
    .query(`INSERT INTO tasks (id, workspace_id, status, created_at, work_kind, brief) VALUES (?, ?, 'open', ?, 'node', ?)`)
    .run(id, WS, dbMod.nowIso(), "a story");
  return id;
}

/** A LEAF row — the kind that has NO leader (its own agent terminal is /api/work/:id/terminal). */
function makeLeaf(): string {
  const id = `leaf-leaderterm-${++seq}`;
  dbMod.db
    .query(`INSERT INTO tasks (id, workspace_id, status, created_at, work_kind, brief) VALUES (?, ?, 'open', ?, 'leaf', ?)`)
    .run(id, WS, dbMod.nowIso(), "a leaf");
  return id;
}

const termPath = (id: string) => `/api/work/${encodeURIComponent(id)}/leader/terminal`;

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-leaderterm-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-leaderterm-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";
  process.env.BUTCHR_PORT = "0"; // ephemeral in-process bind

  execFileSync("git", ["init", "-q", REPO_ROOT], { stdio: "ignore" });
  const g = (args: string[]) => execFileSync("git", ["-C", REPO_ROOT, ...args], { stdio: "ignore" });
  g(["config", "user.email", "test@butchr.local"]);
  g(["config", "user.name", "butchr test"]);
  g(["commit", "--allow-empty", "-q", "-m", "init"]);

  cfgMod = await import("../src/config.ts");
  dbMod = await import("../src/db.ts");
  harnessMod = await import("../src/harness.ts");
  terminalMod = await import("../src/terminal.ts");
  wsAgentMod = await import("../src/workspace-agent.ts");
  serverMod = await import("../src/server.ts");
  originalRunner = harnessMod.getRunner();
  harnessMod.setRunner(makeFakeRunner());

  server = serverMod.startServer();
  BASE = `http://127.0.0.1:${server.port}`;

  const ws = await apiSend("POST", "/api/workspaces", { path: REPO_ROOT });
  WS = ws.body.id;
});

afterAll(() => {
  try {
    server?.stop(true);
  } catch {
    /* already stopped */
  }
  harnessMod.setRunner(originalRunner);
  terminalMod.setTerminalDeps(); // reset to real deps
  cfgMod.config.terminalCmd = "";
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  liveAgents.clear();
  terminalMod.setTerminalDeps(); // reset stub between cases
  cfgMod.config.terminalCmd = "";
});

test("404 on an unknown id", async () => {
  const res = await apiSend("POST", termPath("st-does-not-exist"));
  expect(res.status).toBe(404);
  expect(String(res.body.error)).toContain("story not found");
});

// A LEAF has no leader, so it has no leader/terminal sub-resource AT ALL — 404, not the 409 the
// sibling assertWorkLeaf() would give. Deliberate; mirrors the CEO route.
test("404 on a LEAF id (not a 409) — a leaf has no leader sub-resource", async () => {
  const leaf = makeLeaf();
  const res = await apiSend("POST", termPath(leaf));
  expect(res.status).toBe(404);
  expect(String(res.body.error)).toContain("story not found");
});

test("409 with the torn-down reason when the leader is NOT desired", async () => {
  const id = makeStory(); // no story_agent row at all → desired:false, running:false
  const res = await apiSend("POST", termPath(id));
  expect(res.status).toBe(409);
  expect(String(res.body.error)).toContain("torn down or never launched");
});

test("409 with the starting reason when the leader is desired but NOT running", async () => {
  const id = makeStory();
  dbMod.saveStoryAgentRow(id, { desired: 1 }); // desired, but no live pane registered
  const res = await apiSend("POST", termPath(id));
  expect(res.status).toBe(409);
  expect(String(res.body.error)).toContain("starting");
});

// The HONEST requirement: the two not-live cases must be DISTINGUISHABLE by the operator, not one
// flat string. Assert the messages differ and that each names only its own case.
test("the two 409 reasons are genuinely different and each names its case", async () => {
  const tornDown = makeStory();
  const starting = makeStory();
  dbMod.saveStoryAgentRow(starting, { desired: 1 });

  const a = await apiSend("POST", termPath(tornDown));
  const b = await apiSend("POST", termPath(starting));
  expect(a.status).toBe(409);
  expect(b.status).toBe(409);

  const msgA = String(a.body.error);
  const msgB = String(b.body.error);
  expect(msgA).not.toBe(msgB);
  expect(msgA).toContain("torn down or never launched");
  expect(msgA).not.toContain("starting");
  expect(msgB).toContain("starting");
  expect(msgB).not.toContain("torn down");
});

// `lastError` is surfaced as EVIDENCE, never as a verdict: it can be stale from an earlier restart
// while the leader is genuinely starting now, so the message names BOTH possibilities.
test("409 surfaces lastError without asserting a crash it cannot prove", async () => {
  const id = makeStory();
  dbMod.saveStoryAgentRow(id, { desired: 1, last_error: "boom: exit 1" });
  const res = await apiSend("POST", termPath(id));
  expect(res.status).toBe(409);
  const msg = String(res.body.error);
  expect(msg).toContain("boom: exit 1");
  expect(msg).toContain("starting, or it crashed");
});

test("happy path attaches to storyAgentName(storyId) when the leader is live", async () => {
  const id = makeStory();
  const paneName = wsAgentMod.storyAgentName(id);
  expect(paneName).toBe(`${cfgMod.config.ctoAgentName}-story-${id}`);

  // Make the leader LIVE: a desired story_agent row + a registered pane.
  dbMod.saveStoryAgentRow(id, { desired: 1 });
  liveAgents.add(paneName);

  // Stub the terminal spawn: an override template + a spawn seam that records the argv.
  const spawned: string[][] = [];
  cfgMod.config.terminalCmd = "true {{CMD}}";
  terminalMod.setTerminalDeps({
    spawn: (argv) => {
      spawned.push(argv);
      return true;
    },
  });

  const res = await apiSend("POST", termPath(id));
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  expect(res.body.command).toContain("agent attach");
  expect(res.body.command).toContain(paneName);
  // The spawn actually fired with the leader pane name — proof we reused the shared attach seam.
  expect(spawned.length).toBe(1);
  expect(spawned[0]!.join(" ")).toContain(paneName);
});
