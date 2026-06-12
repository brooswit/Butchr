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
//   - dispatcher.maybeNudgeStalledAgent: the idle-nudge is SUPPRESSED when claude is
//     not actually alive — it auto-resumes instead of typing `continue` into a dead shell.
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
      if (prop === "resolveAgentPane") return async (name: string) => "pane-" + name;
      if (prop === "agentTabId") return async (name: string) => "tab-" + name;
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
  dbMod.db
    .query(
      `INSERT INTO tasks (id, workspace_id, status, herdr_pane_id, herdr_tab_id, session_id, started_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, WS_ID, status, "pane-" + id, "tab-" + id, sessionId, dbMod.nowIso(), dbMod.nowIso());
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
  process.env.BUTCHR_IDLE_NUDGE_MS = "2000";
  process.env.BUTCHR_IDLE_NUDGE_MAX = "2";
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
    expect(row.status).toBe("in_progress");
    expect(row.herdr_pane_id).toBeNull(); // READY again → dispatcher relaunches it
    expect(row.session_id).toBe("sid-resume-ok"); // kept → resolveLaunchCommand uses --resume
    expect(row.resume_attempts).toBe(1);
  });

  test("transcript MISSING → FRESH dispatch (session cleared) — never a zombie", async () => {
    seedRunning("resume-fresh", "sid-no-transcript");
    const r = await tasksMod.requeueForResume("resume-fresh", "test");
    expect(r).toBe("fresh");
    const row = tasksMod.getTask("resume-fresh")!;
    expect(row.status).toBe("in_progress");
    expect(row.herdr_pane_id).toBeNull();
    expect(row.session_id).toBeNull(); // cleared → relaunch is a fresh run from the prompt
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
    expect(killed.status).toBe("in_progress");
    expect(killed.herdr_pane_id).toBeNull(); // auto-resumed (READY for --resume)
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
    expect(row.herdr_pane_id).not.toBeNull(); // pane intact — left running
    expect(row.resume_attempts).toBe(0); // not resumed / not rescued
    dispatchMod.signalAbort("recon-alive"); // stop the re-adopted watcher this spawned
  });
});

describe("maybeNudgeStalledAgent (the idle-nudge liveness guard)", () => {
  test("claude DEAD → no 'continue' nudge; auto-resume is triggered instead", async () => {
    seedRunning("nudge-dead", "sid-nudge-dead");
    liveMod.setCmdlineLister(() => []); // dead
    const next = await dispatchMod.maybeNudgeStalledAgent(
      "nudge-dead",
      "in_progress",
      cfg.idleMs + cfg.idleNudgeMs + 1, // well into a stall
      { nudgesSent: 0, lastNudgeAt: 0 },
      1_000_000,
    );
    expect(sends).toEqual([]); // NOT typed into a dead shell
    expect(next).toEqual({ nudgesSent: 0, lastNudgeAt: 0 }); // streak untouched
    // The task was auto-resumed instead (pane cleared → the watcher hands off).
    const row = tasksMod.getTask("nudge-dead")!;
    expect(row.herdr_pane_id).toBeNull();
    expect(row.resume_attempts).toBe(1);
    const notes = dbMod.listTaskEvents("nudge-dead").map((e) => e.note ?? "");
    expect(notes.some((n) => n.includes("auto-nudged"))).toBe(false);
    expect(notes.some((n) => /auto-resume|FRESH/.test(n))).toBe(true);
  });

  test("claude ALIVE but quiet → the normal 'continue' nudge still fires", async () => {
    seedRunning("nudge-alive", "sid-nudge-alive");
    liveMod.setCmdlineLister(liveSessions("sid-nudge-alive")); // alive
    const next = await dispatchMod.maybeNudgeStalledAgent(
      "nudge-alive",
      "in_progress",
      cfg.idleMs + cfg.idleNudgeMs + 1,
      { nudgesSent: 0, lastNudgeAt: 0 },
      2_000_000,
    );
    expect(sends).toEqual([["nudge-alive", { text: "continue", enter: true }]]);
    expect(next).toEqual({ nudgesSent: 1, lastNudgeAt: 2_000_000 });
    expect(tasksMod.getTask("nudge-alive")!.herdr_pane_id).not.toBeNull(); // left running
  });
});
