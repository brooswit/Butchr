// Tests for the AGENT-EXECUTION HARNESS seam (src/harness.ts) and the dispatcher
// driving it through a FAKE backend instead of the real herdr.
//
// The harness abstracts the session/runtime that runs the Claude Code agent behind
// the `AgentRunner` interface: the dispatcher (and reaper) call the swappable
// `harness` proxy, never herdr directly. setRunner() lets a test drop in a fake
// backend, so we can exercise the WHOLE dispatch path — workspace heal, tab create,
// agent start, husk-pane close, pane resolution, markRunning — with NO real herdr or
// claude spawned. git is real (a throwaway repo); only the agent runtime is faked.
//
// What this exercises:
//   1. A successful dispatch: the fake records the exact backend calls the
//      dispatcher makes (workspaceCreate → tabCreate → agentStart → paneClose →
//      resolveAgentPane), and the task is markRunning'd against the RESOLVED pane id
//      (not the raw agentStart pane), with a fresh session id + the tab id.
//   2. A failed dispatch: when the backend can't resolve a live pane after start,
//      dispatch() routes the task through the bounded-retry path (markDispatchFailure:
//      stays in_progress with pane NULL, a backoff stamped) and deregisters the agent
//      name — exactly the phantom-pane guard, now verified against a fake backend.
//   3. runHeadless flows through the proxy (the headless read-only seam).
//
// Env is set before a dynamic import so config/db read our temp paths.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunner, HeadlessSpec, SendInput } from "../src/harness.ts";

let DATA_DIR: string;
let REPO_ROOT: string;
const DIR_ID = "harness-dir";

let dbMod: typeof import("../src/db.ts");
let tasksMod: typeof import("../src/tasks.ts");
let dispatchMod: typeof import("../src/dispatcher.ts");
let harnessMod: typeof import("../src/harness.ts");
let originalRunner: AgentRunner;

function g(args: string[], cwd = REPO_ROOT): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-harness-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-harness-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";
  // Small dispatch-retry knobs so the failure path's backoff is cheap to assert.
  process.env.BUTCHR_MAX_DISPATCH_ATTEMPTS = "3";
  process.env.BUTCHR_DISPATCH_BACKOFF_BASE_MS = "1000";

  // Real throwaway repo so git.createWorktree / prepareBranchForDispatch work.
  execFileSync("git", ["init", "-q", REPO_ROOT], { stdio: "ignore" });
  g(["config", "user.email", "t@t.t"]);
  g(["config", "user.name", "t"]);
  writeFileSync(join(REPO_ROOT, ".gitignore"), ".butchr/\n");
  writeFileSync(join(REPO_ROOT, "README.md"), "base\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "init"]);

  dbMod = await import("../src/db.ts");
  tasksMod = await import("../src/tasks.ts");
  dispatchMod = await import("../src/dispatcher.ts");
  harnessMod = await import("../src/harness.ts");
  originalRunner = harnessMod.getRunner(); // the real herdr backend, restored in afterAll

  // bun shares the config/db singletons across test files: config.dataDir is whatever
  // the FIRST-imported file set, and another file's afterAll may have rm'd that tree.
  // dispatch() writes the rendered prompt/mcp config under config.dataDir, so make
  // sure those subdirs exist for this file's run (recreating them if a sibling
  // cleaned up).
  const cfgDataDir = (await import("../src/config.ts")).config.dataDir;
  for (const sub of ["prompts", "runs", "mcp"]) {
    mkdirSync(join(cfgDataDir, sub), { recursive: true });
  }

  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(DIR_ID, REPO_ROOT, "test", dbMod.nowIso());
});

afterAll(() => {
  // Restore the real (herdr) backend so a swapped fake can't leak into other files.
  harnessMod.setRunner(originalRunner);
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

/** Records every backend call; `resolvedPane` controls resolveAgentPane's answer. */
type Calls = {
  workspaceCreate: Array<[string, string]>;
  tabCreate: Array<[string | undefined, string, string]>;
  agentStart: Array<{ name: string; cwd: string; argv: string[]; tabId?: string }>;
  paneClose: string[];
  resolveAgentPane: Array<[string, string | undefined]>;
  agentDeregister: string[];
  send: Array<[string, SendInput]>;
  headless: HeadlessSpec[];
};

function makeFake(opts: { resolvedPane: string | undefined }): {
  runner: AgentRunner;
  calls: Calls;
} {
  const calls: Calls = {
    workspaceCreate: [],
    tabCreate: [],
    agentStart: [],
    paneClose: [],
    resolveAgentPane: [],
    agentDeregister: [],
    send: [],
    headless: [],
  };
  const runner: AgentRunner = {
    async isUp() {
      return true;
    },
    async workspaceCreate(cwd, label) {
      calls.workspaceCreate.push([cwd, label]);
      return { workspaceId: "ws-1", rootPaneId: "root-1" };
    },
    async workspaceExists() {
      return false; // force a heal → workspaceCreate
    },
    async workspaceClose() {},
    async tabCreate(workspaceId, cwd, label) {
      calls.tabCreate.push([workspaceId, cwd, label]);
      return { tabId: "tab-1", rootPaneId: "rp-1" };
    },
    async tabClose() {},
    async agentTabId() {
      return undefined;
    },
    async agentStart(name, cwd, argv, _workspaceId, tabId) {
      calls.agentStart.push({ name, cwd, argv, tabId });
      return { paneId: "pane-raw", terminalId: "term-1" };
    },
    async agentExists() {
      return true; // stay alive so the watcher loops until we abort it
    },
    async agentPaneId() {
      return undefined;
    },
    async agentTerminalId() {
      return "term-1";
    },
    async paneTerminalId() {
      return "rootterm-1"; // the husk root pane's stable terminal id
    },
    async paneList() {
      return [];
    },
    async resolveAgentPane(name, closedTerminalId) {
      calls.resolveAgentPane.push([name, closedTerminalId]);
      return opts.resolvedPane;
    },
    async reconcilePane(_name, stored) {
      const paneId = opts.resolvedPane;
      return { paneId, drifted: !!paneId && !!stored && paneId !== stored };
    },
    isAgentNameTaken() {
      return false;
    },
    async agentRead() {
      return "";
    },
    async send(name, input) {
      calls.send.push([name, input]);
    },
    async paneClose(target) {
      calls.paneClose.push(target);
    },
    async teardownTask() {},
    async agentDeregister(name) {
      calls.agentDeregister.push(name);
    },
    async runHeadless(spec) {
      calls.headless.push(spec);
      return { ok: true, code: 0, stdout: "headless-out", stderr: "", timedOut: false };
    },
  };
  return { runner, calls };
}

const dbRow = (id: string) =>
  dbMod.db.query<any, [string]>(`SELECT * FROM tasks WHERE id=?`).get(id)!;
const dirRow = () =>
  dbMod.db.query<any, [string]>(`SELECT * FROM workspaces WHERE id=?`).get(DIR_ID)!;

describe("dispatcher against a fake AgentRunner backend", () => {
  test("a successful dispatch drives the backend and markRunning against the resolved pane", async () => {
    const { runner, calls } = makeFake({ resolvedPane: "pane-final" });
    harnessMod.setRunner(runner);

    // A 'New task' (idea=false, no blockers) starts `inactive` with NO pane — the
    // exact ready-to-launch state selectQueuedForDispatch picks up.
    const view = await tasksMod.createTask(DIR_ID, "do the thing");
    expect(dbRow(view.id).status).toBe("inactive");
    expect(dbRow(view.id).herdr_pane_id).toBeNull();

    await dispatchMod.dispatch(dirRow(), dbRow(view.id));

    // The backend received the full launch sequence, in order.
    expect(calls.workspaceCreate.length).toBe(1);
    expect(calls.tabCreate.length).toBe(1);
    expect(calls.tabCreate[0]![0]).toBe("ws-1"); // started in the healed workspace
    expect(calls.agentStart.length).toBe(1);
    expect(calls.agentStart[0]!.name).toBe(view.id);
    expect(calls.agentStart[0]!.tabId).toBe("tab-1"); // placed in the dedicated tab
    // The launch argv wraps the agent command under `script` (PTY) — a fresh launch.
    const launched = calls.agentStart[0]!.argv.join(" ");
    expect(launched).toContain("script");
    expect(launched).toContain("--session-id");
    // The leftover root pane was closed, and the agent's real pane re-resolved by
    // its stable terminal id (waiting out the husk's renumber).
    expect(calls.paneClose).toContain("rp-1");
    expect(calls.resolveAgentPane.length).toBe(1);
    expect(calls.resolveAgentPane[0]).toEqual([view.id, "rootterm-1"]);

    // markRunning recorded the RESOLVED pane (not the raw agentStart pane), the tab,
    // and a fresh session id; started_at is stamped.
    const row = dbRow(view.id);
    expect(row.status).toBe("in_progress");
    expect(row.herdr_pane_id).toBe("pane-final");
    expect(row.herdr_tab_id).toBe("tab-1");
    expect(typeof row.session_id).toBe("string");
    expect(row.session_id.length).toBeGreaterThan(0);
    expect(row.started_at).not.toBeNull();

    // Reap the watcher dispatch spawned (it loops on the fake's agentExists=true).
    expect(dispatchMod.signalAbort(view.id)).toBe(true);
    await new Promise((r) => setTimeout(r, 1300));
  });

  test("a dispatch that can't resolve a live pane fails into the retry path", async () => {
    const { runner, calls } = makeFake({ resolvedPane: undefined });
    harnessMod.setRunner(runner);

    const view = await tasksMod.createTask(DIR_ID, "second task");
    await dispatchMod.dispatch(dirRow(), dbRow(view.id));

    // The agent start was attempted, but no live pane resolved → the dispatch threw
    // and was routed to markDispatchFailure rather than recording a phantom pane.
    expect(calls.agentStart.length).toBe(1);
    expect(calls.resolveAgentPane.length).toBe(1);
    expect(calls.agentDeregister).toContain(view.id); // cleanup freed the name

    const row = dbRow(view.id);
    expect(row.status).toBe("inactive"); // re-armed READY (under the attempt cap)
    expect(row.herdr_pane_id).toBeNull(); // NO phantom pane recorded
    expect(row.dispatch_attempts).toBe(1); // a bounded retry was counted
    expect(row.next_dispatch_at).not.toBeNull(); // backoff scheduled
  });
});

describe("send flows through the harness proxy", () => {
  test("the active backend's send receives text vs keys inputs verbatim", async () => {
    const { runner, calls } = makeFake({ resolvedPane: "x" });
    harnessMod.setRunner(runner);

    await harnessMod.harness.send("task-1", { text: "/compact", enter: true });
    await harnessMod.harness.send("task-1", { keys: ["C-c"] });

    expect(calls.send.length).toBe(2);
    expect(calls.send[0]).toEqual(["task-1", { text: "/compact", enter: true }]);
    expect(calls.send[1]).toEqual(["task-1", { keys: ["C-c"] }]);
  });
});

describe("runHeadless flows through the harness proxy", () => {
  test("the active backend's runHeadless is invoked", async () => {
    const { runner, calls } = makeFake({ resolvedPane: "x" });
    harnessMod.setRunner(runner);
    const r = await harnessMod.harness.runHeadless({
      cmd: "echo hi",
      cwd: REPO_ROOT,
      timeoutMs: 1000,
    });
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe("headless-out");
    expect(calls.headless.length).toBe(1);
    expect(calls.headless[0]!.cmd).toBe("echo hi");
  });
});
