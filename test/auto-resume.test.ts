// Tests for HOST/HERDR-RESTART AUTO-RESUME — butchr's resilience to power loss /
// re-login killing every agent's `claude` process while herdr restores the pane as a
// bare login shell (so `agentExists` still says "alive"). Covers:
//
//   - src/liveness.claudeAlive: the /proc-based ground-truth probe, matching the
//     session id as a DISTINCT argv token (not a loose substring).
//   - tasks.requeueForResume: dead-but-killed agent → reset to READY so the dispatcher
//     relaunches via `--resume` (transcript present) or FRESH (transcript gone); bounded
//     by config.maxResumeAttempts → rescued to review past the cap.
//   - dispatcher.reconcileRunningTasks: startup self-heal — a pane that survived a
//     restart but whose claude is DEAD (+ no `.done`) is auto-resumed, NOT re-adopted;
//     a clean-exit (`.done`) dead agent is rescued to review; a genuinely-alive agent is
//     re-adopted untouched (the "don't disturb the live agents" guarantee).
//   - dispatcher.handleIdleAgent: an idle agent whose claude is NOT actually alive is
//     auto-resumed (never surfaced as nudgeable); an alive-but-quiet one is left flagged
//     for the responder (no auto-"continue" anymore).
//   - tasks.nudgeTask: the responder's nudge re-checks liveness — alive → sends; dead →
//     auto-resumes instead of typing `continue` into a dead shell (the incident fix).
//
// In-process: no real claude/herdr. A fake harness backend (setRunner) records sends
// and reports the pane as surviving (agentExists=true); the /proc probe is driven by an
// injected cmdline lister (setCmdlineLister) so liveness is deterministic.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunner, SendInput } from "../src/harness.ts";

let DATA_DIR: string;
let CLAUDE_DIR: string;
const WS_ID = "auto-resume-ws";

let dbMod: typeof import("../src/db.ts");
let dispatchMod: typeof import("../src/dispatcher.ts");
let tasksMod: typeof import("../src/tasks.ts");
let harnessMod: typeof import("../src/harness.ts");
let liveMod: typeof import("../src/liveness.ts");
let cfg: typeof import("../src/config.ts").config;
let originalRunner: AgentRunner;

// Recorded `send` calls (the nudge path) — everything else is a benign no-op.
let sends: Array<[string, SendInput]> = [];

// Per-test overridable NAME→pane/tab resolvers so a test can model a herdr RENUMBER
// (the stored column is stale; the live pane resolves BY NAME to a different id) or a
// name that resolves NO live pane at all. Default: every name resolves to its
// canonical pane/tab. Reset in beforeEach.
let resolvePane: (name: string) => string | undefined = (name) => "pane-" + name;
let resolveTab: (name: string) => string | undefined = (name) => "tab-" + name;

function makeFakeRunner(): AgentRunner {
  const noop = async () => undefined as never;
  return new Proxy({} as AgentRunner, {
    get(_t, prop) {
      if (prop === "send") {
        return async (name: string, input: SendInput) => {
          sends.push([name, input]);
        };
      }
      // The pane SURVIVED the restart — herdr still knows the agent name (the bug this
      // fixes). Liveness is decided by the /proc probe, not this.
      if (prop === "agentExists") return async () => true;
      if (prop === "resolveAgentPane") return async (name: string) => resolvePane(name);
      if (prop === "agentTabId") return async (name: string) => resolveTab(name);
      return noop;
    },
  });
}

// A /proc cmdline lister that reports the given session ids as live claude processes
// (each as claude's own argv, where the uuid is a DISTINCT token).
function liveSessions(...sids: string[]): () => string[][] {
  return () => sids.map((sid) => ["claude", "--session-id", sid, "--mcp-config", "/x"]);
}

function seedRunning(id: string, sessionId: string, status = "in_progress"): void {
  // A LAUNCHED build agent: in_progress + pane + has_agent=1 (the honest ownership marker
  // markRunning sets). reconcile/reaper now pre-filter on has_agent=1, then probe the
  // process (claudeAlive) for true liveness.
  dbMod.db
    .query(
      `INSERT INTO tasks (id, workspace_id, status, has_agent, session_id, started_at, created_at)
       VALUES (?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(id, WS_ID, status, sessionId, dbMod.nowIso(), dbMod.nowIso());
}

// Drop a transcript so findTranscript() resolves it (scan-by-session-id finds any dir).
function writeTranscript(sessionId: string): void {
  const proj = join(CLAUDE_DIR, "projects", "anyproj");
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, `${sessionId}.jsonl`), "{}\n");
}

// The `.done` exit-code file the dispatcher writes when the agent EXITS on its own.
// The dispatcher reads it under config.dataDir/runs — and config.dataDir is a singleton
// frozen at import time (whichever test file imported config first wins), which may NOT
// be this file's DATA_DIR in the full shared-suite run. So write it where the
// dispatcher actually looks (cfg.dataDir), not this file's DATA_DIR.
function writeDone(id: string): void {
  const runs = join(cfg.dataDir, "runs");
  mkdirSync(runs, { recursive: true });
  writeFileSync(join(runs, `${id}.done`), "0");
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-auto-resume-data-"));
  CLAUDE_DIR = mkdtempSync(join(tmpdir(), "butchr-auto-resume-claude-"));
  mkdirSync(join(DATA_DIR, "runs"), { recursive: true });
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";
  process.env.CLAUDE_CONFIG_DIR = CLAUDE_DIR;
  // Small, deterministic thresholds (used only if this file imports config first).
  process.env.BUTCHR_IDLE_MS = "1000";
  process.env.BUTCHR_MAX_RESUME_ATTEMPTS = "3";

  dbMod = await import("../src/db.ts");
  cfg = (await import("../src/config.ts")).config;
  dispatchMod = await import("../src/dispatcher.ts");
  tasksMod = await import("../src/tasks.ts");
  harnessMod = await import("../src/harness.ts");
  liveMod = await import("../src/liveness.ts");

  originalRunner = harnessMod.getRunner();
  harnessMod.setRunner(makeFakeRunner());

  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(WS_ID, DATA_DIR, "test", dbMod.nowIso());
});

afterAll(() => {
  harnessMod.setRunner(originalRunner);
  liveMod.setCmdlineLister(null); // restore the real /proc probe for other files
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(CLAUDE_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  sends = [];
  liveMod.setCmdlineLister(() => []); // default: nothing alive (dead)
  resolvePane = (name) => "pane-" + name; // default: name resolves to its canonical pane
  resolveTab = (name) => "tab-" + name;
});

describe("claudeAlive (the /proc liveness probe)", () => {
  test("alive iff a process carries the session id as a DISTINCT argv token", () => {
    liveMod.setCmdlineLister(liveSessions("sid-live"));
    expect(liveMod.claudeAlive("sid-live")).toBe(true);
    expect(liveMod.claudeAlive("sid-other")).toBe(false);
  });

  test("a blank/missing session id is never alive", () => {
    liveMod.setCmdlineLister(liveSessions("whatever"));
    expect(liveMod.claudeAlive(null)).toBe(false);
    expect(liveMod.claudeAlive("")).toBe(false);
    expect(liveMod.claudeAlive("   ")).toBe(false);
  });

  test("a loose SUBSTRING match (uuid embedded in a bigger arg) does NOT count as alive", () => {
    // The wrapper shells (bash -lc '… --session-id sid …', script -c '…') carry the
    // uuid INSIDE one big arg, not as its own token — only claude's own argv has it
    // standalone. So a leftover wrapper shell must not read as a live claude.
    liveMod.setCmdlineLister(() => [["bash", "-lc", "script -c 'claude --session-id sid-x'"]]);
    expect(liveMod.claudeAlive("sid-x")).toBe(false);
  });
});

describe("requeueForResume (the bounded auto-resume transition)", () => {
  test("transcript present → --resume (session kept, pane cleared, attempt counted)", async () => {
    seedRunning("resume-ok", "sid-resume-ok");
    writeTranscript("sid-resume-ok");
    const r = await tasksMod.requeueForResume("resume-ok", "test");
    expect(r).toBe("resumed");
    const row = tasksMod.getTask("resume-ok")!;
    // Lands in `inactive` (READY) → selectQueuedForDispatch re-launches it at RUNTIME (no
    // restart). The killed agent is gone: has_agent dropped to 0 (setStatus's central clear
    // on the transition OFF in_progress), so reconcile/reaper/setIdle/nudge all correctly
    // read it as "no owned live agent".
    expect(row.status).toBe("inactive");
    expect(row.has_agent).toBe(0);
    expect(row.session_id).toBe("sid-resume-ok"); // kept → resolveLaunchCommand uses --resume
    expect(row.started_at).toBeTruthy(); // preserved → continuous runaway budget
    expect(row.resume_attempts).toBe(1);
  });

  test("transcript MISSING → FRESH dispatch (session cleared) — never a zombie", async () => {
    seedRunning("resume-fresh", "sid-no-transcript");
    const r = await tasksMod.requeueForResume("resume-fresh", "test");
    expect(r).toBe("fresh");
    const row = tasksMod.getTask("resume-fresh")!;
    expect(row.status).toBe("inactive"); // READY → runtime re-dispatch
    expect(row.has_agent).toBe(0);
    expect(row.session_id).toBeNull(); // cleared → relaunch is a fresh run from the prompt
    expect(row.started_at).toBeTruthy(); // preserved even on the fresh path
    expect(row.resume_attempts).toBe(1);
  });

  test("bounded: past config.maxResumeAttempts it rescues to in_review, not another resume", async () => {
    seedRunning("resume-capped", "sid-capped");
    writeTranscript("sid-capped");
    // Pretend we've already auto-resumed up to the cap without progress.
    dbMod.db.query(`UPDATE tasks SET resume_attempts=? WHERE id=?`).run(cfg.maxResumeAttempts, "resume-capped");
    const r = await tasksMod.requeueForResume("resume-capped", "test");
    expect(r).toBe("rescued");
    expect(tasksMod.getTask("resume-capped")!.status).toBe("in_review");
  });

  // THE INCIDENT FIX (F1): a task auto-resumed from a dead shell must be RE-DISPATCHED at
  // RUNTIME — without a butchr restart. selectQueuedForDispatch picks ONLY status='inactive',
  // so requeueForResume must land the task there (the old code left it in_progress+has_agent=0,
  // which nothing at runtime re-dispatches → stranded until the next boot).
  test("re-dispatchable at RUNTIME: landed in `inactive`, picked by selectQueuedForDispatch (resume branch)", async () => {
    seedRunning("resume-redispatch", "sid-redispatch");
    writeTranscript("sid-redispatch");
    expect(await tasksMod.requeueForResume("resume-redispatch", "test")).toBe("resumed");
    const row = tasksMod.getTask("resume-redispatch")!;
    expect(row.status).toBe("inactive");
    expect(row.session_id).toBe("sid-redispatch"); // preserved → --resume
    const queued = dispatchMod
      .selectQueuedForDispatch(dbMod.nowIso())
      .map((t) => t.id);
    expect(queued).toContain("resume-redispatch"); // dispatcher relaunches it, no restart
  });

  test("re-dispatchable at RUNTIME on the FRESH branch too (transcript gone → session cleared)", async () => {
    seedRunning("fresh-redispatch", "sid-fresh-redispatch"); // no transcript written
    expect(await tasksMod.requeueForResume("fresh-redispatch", "test")).toBe("fresh");
    const row = tasksMod.getTask("fresh-redispatch")!;
    expect(row.status).toBe("inactive");
    expect(row.session_id).toBeNull(); // cleared → relaunch is a fresh run
    const queued = dispatchMod
      .selectQueuedForDispatch(dbMod.nowIso())
      .map((t) => t.id);
    expect(queued).toContain("fresh-redispatch");
  });
});

describe("reconcileRunningTasks (startup self-heal, liveness-aware)", () => {
  test("dead claude + no .done → auto-resume; dead claude + .done → rescue to review", async () => {
    seedRunning("recon-killed", "sid-killed"); // killed mid-work (no .done) → resume
    writeTranscript("sid-killed");
    seedRunning("recon-exited", "sid-exited"); // ended on its own (.done) → review
    writeDone("recon-exited");
    // Neither session is alive in /proc (the restart killed them).
    liveMod.setCmdlineLister(() => []);

    // (Aggregate counts also fold in any rows other test files left in the shared DB,
    // so assert on THESE tasks' outcomes — and that each bucket saw at least our one.)
    const res = await dispatchMod.reconcileRunningTasks(true);
    expect(res.resumed).toBeGreaterThanOrEqual(1);
    expect(res.rescued).toBeGreaterThanOrEqual(1);

    const killed = tasksMod.getTask("recon-killed")!;
    expect(killed.status).toBe("inactive"); // auto-resumed → READY for runtime re-dispatch
    expect(killed.has_agent).toBe(0); // auto-resumed (READY for --resume)
    expect(killed.resume_attempts).toBe(1);

    expect(tasksMod.getTask("recon-exited")!.status).toBe("in_review"); // rescued, not resumed
  });

  test("a genuinely-alive agent is re-adopted untouched (live agents are never disturbed)", async () => {
    seedRunning("recon-alive", "sid-alive");
    liveMod.setCmdlineLister(liveSessions("sid-alive")); // claude IS in /proc → alive

    const res = await dispatchMod.reconcileRunningTasks(true);
    expect(res.adopted).toBeGreaterThanOrEqual(1); // recon-alive was re-adopted

    // The decisive assertion: a LIVE agent is left completely untouched (not resumed).
    const row = tasksMod.getTask("recon-alive")!;
    expect(row.status).toBe("in_progress");
    expect(row.has_agent).toBe(1); // agent intact — left running
    expect(row.resume_attempts).toBe(0); // not resumed / not rescued
    dispatchMod.signalAbort("recon-alive"); // stop the re-adopted watcher this spawned
  });

  test("re-adopts a live agent at its CURRENT name-resolved pane, ignoring a STALE stored column (renumber)", async () => {
    // ADDRESSING = NAME ONLY. Model a herdr renumber: the live agent resolves BY NAME
    // to its current pane even after a sibling tab closed and shifted positional ids
    // while butchr was down. Re-adoption resolves the agent by name; butchr no longer
    // records any stored pane/tab — the honest LIVE marker (has_agent) stays set.
    seedRunning("recon-renum", "sid-renum");
    resolvePane = (name) => (name === "recon-renum" ? "pane-LIVE-recon-renum" : "pane-" + name);
    resolveTab = (name) => (name === "recon-renum" ? "tab-LIVE-recon-renum" : "tab-" + name);
    liveMod.setCmdlineLister(liveSessions("sid-renum")); // claude IS alive

    const res = await dispatchMod.reconcileRunningTasks(true);
    expect(res.adopted).toBeGreaterThanOrEqual(1);

    const row = tasksMod.getTask("recon-renum")!;
    // Re-adopted BY NAME — left running, never resumed/rescued.
    expect(row.status).toBe("in_progress");
    expect(row.has_agent).toBe(1);
    expect(row.resume_attempts).toBe(0); // adopted, never resumed/rescued
    dispatchMod.signalAbort("recon-renum"); // stop the re-adopted watcher this spawned
  });

  test("a live agent whose NAME resolves NO live pane is auto-resumed, never re-adopted at an invented pane", async () => {
    // The OLD code fell back to a stored pane (or `row.id`) when the name lookup came
    // up empty — inventing a pane named the task id and re-adopting a husk shell. With
    // name-only addressing, an unresolvable name means the agent isn't attachable, so it
    // must fall through to the auto-resume branch instead.
    seedRunning("recon-nopane", "sid-nopane");
    writeTranscript("sid-nopane");
    resolvePane = (name) => (name === "recon-nopane" ? undefined : "pane-" + name);
    liveMod.setCmdlineLister(liveSessions("sid-nopane")); // process IS alive…

    const res = await dispatchMod.reconcileRunningTasks(true);
    expect(res.resumed).toBeGreaterThanOrEqual(1);

    const row = tasksMod.getTask("recon-nopane")!;
    // Auto-resumed (READY for --resume): pane cleared, attempt counted — NOT adopted at
    // a bogus "pane-recon-nopane"/task-id pane.
    expect(row.status).toBe("inactive");
    expect(row.has_agent).toBe(0);
    expect(row.resume_attempts).toBe(1);
  });
});

describe("dispatcher.handleIdleAgent (the idle liveness guard — no more auto-nudge)", () => {
  test("claude DEAD while idle → auto-resume (NEVER a 'continue' into a dead shell)", async () => {
    seedRunning("idle-dead", "sid-idle-dead");
    liveMod.setCmdlineLister(() => []); // dead
    await dispatchMod.handleIdleAgent("idle-dead", "in_progress", cfg.idleMs + 1);
    expect(sends).toEqual([]); // NOT typed into a dead shell
    // The task was auto-resumed instead (agent cleared → the watcher hands off).
    const row = tasksMod.getTask("idle-dead")!;
    expect(row.has_agent).toBe(0);
    expect(row.resume_attempts).toBe(1);
    const notes = dbMod.listTaskEvents("idle-dead").map((e) => e.note ?? "");
    expect(notes.some((n) => /auto-resume|FRESH/.test(n))).toBe(true);
  });

  test("claude ALIVE but idle → NOT nudged; left flagged for the responder", async () => {
    seedRunning("idle-alive", "sid-idle-alive");
    liveMod.setCmdlineLister(liveSessions("sid-idle-alive")); // alive
    await dispatchMod.handleIdleAgent("idle-alive", "in_progress", cfg.idleMs + 1);
    expect(sends).toEqual([]); // the dispatcher no longer auto-types "continue"
    expect(tasksMod.getTask("idle-alive")!.has_agent).toBe(1); // left running
  });
});

describe("tasks.nudgeTask (the responder's nudge — re-checks liveness)", () => {
  test("claude ALIVE → sends the steering line ('continue' for a bare nudge)", async () => {
    seedRunning("nudge-alive", "sid-nudge-alive");
    dbMod.db.query(`UPDATE tasks SET idle=1 WHERE id=?`).run("nudge-alive");
    liveMod.setCmdlineLister(liveSessions("sid-nudge-alive")); // alive
    await tasksMod.nudgeTask("nudge-alive");
    expect(sends).toEqual([["nudge-alive", { text: "continue", enter: true }]]);
    expect(tasksMod.getTask("nudge-alive")!.has_agent).toBe(1); // left running
  });

  test("guidance text is sent verbatim instead of a bare continue", async () => {
    seedRunning("nudge-guide", "sid-nudge-guide");
    dbMod.db.query(`UPDATE tasks SET idle=1 WHERE id=?`).run("nudge-guide");
    liveMod.setCmdlineLister(liveSessions("sid-nudge-guide")); // alive
    await tasksMod.nudgeTask("nudge-guide", "check the failing test first");
    expect(sends).toEqual([["nudge-guide", { text: "check the failing test first", enter: true }]]);
  });

  test("claude DEAD → NO nudge; routes to auto-resume instead (the incident fix)", async () => {
    seedRunning("nudge-dead", "sid-nudge-dead");
    dbMod.db.query(`UPDATE tasks SET idle=1 WHERE id=?`).run("nudge-dead");
    liveMod.setCmdlineLister(() => []); // dead
    await tasksMod.nudgeTask("nudge-dead");
    expect(sends).toEqual([]); // NEVER poke a dead shell
    const row = tasksMod.getTask("nudge-dead")!;
    expect(row.has_agent).toBe(0); // auto-resumed (agent cleared)
    expect(row.resume_attempts).toBe(1);
    const notes = dbMod.listTaskEvents("nudge-dead").map((e) => e.note ?? "");
    expect(notes.some((n) => /auto-resume|FRESH/.test(n))).toBe(true);
  });
});
