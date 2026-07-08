// POST /api/projects/:id/ceo/terminal (story st-57435614 / S1) — the CEO analog of the CTO
// terminal-attach route (server.ts): open a GUI terminal attached to a project's managed CEO
// agent pane. This suite pins the three guarded outcomes:
//   - 404 when the id is not a project node (ceoAgentStatus → null),
//   - 409 when the CEO agent has no live pane, with the HONEST reason off the CeoStatus fields
//     (gate off / disabled override / enabled-but-not-running),
//   - the happy path returning the attach payload when the CEO is live.
//
// The REAL server runs IN-PROCESS on an ephemeral port (BUTCHR_PORT=0) against a private
// BUTCHR_DB with BUTCHR_HERDR_BIN=`true` (every herdr probe a harmless no-op) and
// BUTCHR_CEO_AGENT=`0` (global gate a KNOWN false). Liveness is forced WITHOUT a real herdr:
// a fake AgentRunner whose `agentExists` returns true for the CEO pane name (via setRunner) +
// a desired ws-ceo row inserted directly. The terminal spawn is stubbed via BUTCHR_TERMINAL_CMD
// + setTerminalDeps so no real GUI/emulator is touched.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunner, PaneInfo, StartedAgent } from "../src/harness.ts";

let DATA_DIR: string;
let REPO_ROOT: string;
let BASE: string;
let WS: string; // the registered anchor directory (one path → one registration)
let server: ReturnType<typeof import("../src/server.ts").startServer>;

let cfgMod: typeof import("../src/config.ts");
let dbMod: typeof import("../src/db.ts");
let harnessMod: typeof import("../src/harness.ts");
let terminalMod: typeof import("../src/terminal.ts");
let serverMod: typeof import("../src/server.ts");
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

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-ceoterm-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-ceoterm-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";
  process.env.BUTCHR_PORT = "0"; // ephemeral in-process bind
  process.env.BUTCHR_CEO_AGENT = "0"; // globalGate is a KNOWN false

  // A real git repo with one commit — a project anchors to a registered directory.
  execFileSync("git", ["init", "-q", REPO_ROOT], { stdio: "ignore" });
  const g = (args: string[]) => execFileSync("git", ["-C", REPO_ROOT, ...args], { stdio: "ignore" });
  g(["config", "user.email", "test@butchr.local"]);
  g(["config", "user.name", "butchr test"]);
  g(["commit", "--allow-empty", "-q", "-m", "init"]);

  cfgMod = await import("../src/config.ts");
  dbMod = await import("../src/db.ts");
  harnessMod = await import("../src/harness.ts");
  terminalMod = await import("../src/terminal.ts");
  serverMod = await import("../src/server.ts");
  originalRunner = harnessMod.getRunner();
  harnessMod.setRunner(makeFakeRunner());

  server = serverMod.startServer();
  BASE = `http://127.0.0.1:${server.port}`;

  // Register the anchor directory ONCE (a path registers exactly once); projects anchor to it.
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

/** Create a fresh project node anchored to the registered workspace; return its id. */
async function makeProject(): Promise<string> {
  const res = await apiSend("POST", "/api/projects", { workspace: WS });
  expect(res.status).toBe(200);
  return res.body.id;
}

test("404 when the id is not a project node", async () => {
  const res = await apiSend("POST", "/api/projects/proj-does-not-exist/ceo/terminal");
  expect(res.status).toBe(404);
  expect(String(res.body.error)).toContain("project not found");
});

test("409 with the gate reason when the CEO is not enabled (global gate off, no override)", async () => {
  const id = await makeProject();
  const res = await apiSend("POST", `/api/projects/${encodeURIComponent(id)}/ceo/terminal`);
  expect(res.status).toBe(409);
  expect(String(res.body.error)).toContain("global BUTCHR_CEO_AGENT gate is off");
});

test("409 with the not-running reason when enabled-but-no-live-pane", async () => {
  const id = await makeProject();
  // Force the CEO ON for this project (explicit override + enabled) but leave NO live herdr pane.
  const patched = await apiSend("PATCH", `/api/projects/${encodeURIComponent(id)}`, { ceo_enabled: true });
  expect(patched.status).toBe(200);
  expect(patched.body.ceo_enabled).toBe(1); // stored override → enabled (isCeoEnabled true)

  const res = await apiSend("POST", `/api/projects/${encodeURIComponent(id)}/ceo/terminal`);
  expect(res.status).toBe(409);
  expect(String(res.body.error)).toContain("enabled but not running");
});

test("happy path returns the attach payload when the CEO agent is live", async () => {
  const id = await makeProject();
  const paneName = `${cfgMod.config.ctoAgentName}-project-${id}`; // == ceoAgentName(id)

  // Make the CEO LIVE: a desired ws-ceo row (work_id = the project node) + a registered pane.
  dbMod.saveWorkspaceAgentRow(`ws-ceo-${id}`, { kind: "ceo", work_id: id, desired: 1 });
  liveAgents.add(paneName);

  // Stub the terminal spawn so no real GUI/emulator is touched: an override template + a
  // spawn seam that just records the argv and reports success.
  const spawned: string[][] = [];
  cfgMod.config.terminalCmd = "true {{CMD}}";
  terminalMod.setTerminalDeps({
    spawn: (argv) => {
      spawned.push(argv);
      return true;
    },
  });

  const res = await apiSend("POST", `/api/projects/${encodeURIComponent(id)}/ceo/terminal`);
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  // The attach command targets the CEO pane name (herdr agent attach <pane>).
  expect(res.body.command).toContain("agent attach");
  expect(res.body.command).toContain(paneName);
  // The spawn actually fired with the pane name embedded — proof we reused the attach machinery.
  expect(spawned.length).toBe(1);
  expect(spawned[0]!.join(" ")).toContain(paneName);
});
