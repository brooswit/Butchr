// Tests for IDLE-AS-FEEDBACK (FW-4): an idle build agent is surfaced as a graceful,
// responder-routed feedback condition — NOT blindly poked with "continue" anymore.
// Covers the three pure-ish seams:
//   - tasks.setIdle: flipping `idle` 0→1 captures the run-log tail into `idle_context`
//     (via the capture thunk, invoked ONLY on the flip); clearing idle wipes it.
//   - tasks.isAwaitingFeedback / pendingResponder: a LIVE in_progress + idle task is a
//     feedback surface resolved to its structural responder (idle stays a FLAG, not a state).
//   - dispatcher.handleIdleAgent: the watcher's idle step NO LONGER auto-types "continue"
//     for an alive agent (it just self-heals the pane + leaves it flagged); it is a no-op
//     off the in_progress build phase / before the log exists / under the idle threshold.
//
// In-process: no real claude or herdr. A fake harness backend (setRunner) records every
// `send` so we can assert the dispatcher sends NOTHING; the /proc probe is injected
// (setCmdlineLister) so liveness is deterministic.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunner, SendInput } from "../src/harness.ts";

let DATA_DIR: string;
const DIR_ID = "idle-handling-dir";

let dbMod: typeof import("../src/db.ts");
let dispatchMod: typeof import("../src/dispatcher.ts");
let tasksMod: typeof import("../src/tasks.ts");
let harnessMod: typeof import("../src/harness.ts");
let liveMod: typeof import("../src/liveness.ts");
let cfg: typeof import("../src/config.ts").config;
let originalRunner: AgentRunner;

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
      // currentPaneRepairing → reconcilePane: report the stored pane, never drifted.
      if (prop === "reconcilePane") {
        return async (_name: string, stored?: string | null) => ({
          paneId: stored ?? undefined,
          drifted: false,
        });
      }
      return noop;
    },
  });
}

// A LIVE build agent: in_progress with a pane (the precondition setIdle/idle guards on).
function seedLive(id: string, sessionId = "sess-" + id): void {
  // A LIVE launched build agent: in_progress + pane + has_agent=1 (the honest ownership
  // marker markRunning sets; setIdle/nudge now gate on it instead of pane-as-liveness).
  dbMod.db
    .query(
      `INSERT INTO tasks (id, workspace_id, status, herdr_pane_id, has_agent, session_id, created_at)
       VALUES (?, ?, 'in_progress', ?, 1, ?, ?)`,
    )
    .run(id, DIR_ID, "pane-" + id, sessionId, dbMod.nowIso());
}

function rowOf(id: string) {
  return tasksMod.getTask(id)!;
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-idle-handling-data-"));
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";
  process.env.BUTCHR_IDLE_MS = "1000";

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
    .run(DIR_ID, DATA_DIR, "test", dbMod.nowIso());
});

afterAll(() => {
  harnessMod.setRunner(originalRunner);
  liveMod.setCmdlineLister(null);
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("tasks.setIdle (flag + idle_context in lockstep)", () => {
  test("flipping idle on captures the context thunk; the thunk runs ONLY on the flip", () => {
    seedLive("ctx-task");
    let calls = 0;
    const capture = () => {
      calls++;
      return "...recent agent output...";
    };
    // 0→1: captures.
    tasksMod.setIdle("ctx-task", true, capture);
    expect(rowOf("ctx-task").idle).toBe(1);
    expect(rowOf("ctx-task").idle_context).toBe("...recent agent output...");
    expect(calls).toBe(1);
    // Already idle (no flip): the thunk is NOT invoked again (no per-poll re-read).
    tasksMod.setIdle("ctx-task", true, capture);
    expect(calls).toBe(1);
  });

  test("clearing idle wipes idle_context back to NULL", () => {
    seedLive("clear-task");
    tasksMod.setIdle("clear-task", true, () => "snapshot");
    expect(rowOf("clear-task").idle_context).toBe("snapshot");
    tasksMod.setIdle("clear-task", false);
    expect(rowOf("clear-task").idle).toBe(0);
    expect(rowOf("clear-task").idle_context).toBeNull();
  });

  test("an empty captured context stores NULL, not an empty string", () => {
    seedLive("empty-ctx");
    tasksMod.setIdle("empty-ctx", true, () => "");
    expect(rowOf("empty-ctx").idle).toBe(1);
    expect(rowOf("empty-ctx").idle_context).toBeNull();
  });
});

describe("a setStatus transition out of idle clears idle_context", () => {
  test("markInReview wipes the lingering idle snapshot", () => {
    seedLive("review-clears");
    tasksMod.setIdle("review-clears", true, () => "stale snapshot");
    expect(rowOf("review-clears").idle_context).toBe("stale snapshot");
    tasksMod.markInReview("review-clears", "done");
    const row = rowOf("review-clears");
    expect(row.status).toBe("in_review");
    expect(row.idle).toBe(0);
    expect(row.idle_context).toBeNull(); // no stale context lingers after leaving idle
  });
});

describe("idle as a feedback surface (isAwaitingFeedback + pendingResponder)", () => {
  test("a LIVE in_progress + idle task IS awaiting feedback, resolved to its responder", () => {
    seedLive("pending-idle");
    tasksMod.setIdle("pending-idle", true, () => "ctx");
    expect(tasksMod.isAwaitingFeedback(rowOf("pending-idle"))).toBe(true);
    // A non-story idle agent resolves to the CTO (structural — no per-workspace config).
    expect(tasksMod.pendingResponder(rowOf("pending-idle"))).toBe("cto");
  });

  test("a non-idle in_progress task is awaiting nothing (an agent state)", () => {
    seedLive("pending-busy");
    expect(tasksMod.isAwaitingFeedback(rowOf("pending-busy"))).toBe(false);
    expect(tasksMod.pendingResponder(rowOf("pending-busy"))).toBeNull();
  });
});

describe("dispatcher.handleIdleAgent (no more auto-nudge)", () => {
  test("an alive, idle in_progress agent is NOT auto-poked", async () => {
    sends = [];
    seedLive("handle-alive");
    liveMod.setCmdlineLister(() => [["claude", "--session-id", "sess-handle-alive"]]);
    await dispatchMod.handleIdleAgent("handle-alive", "in_progress", cfg.idleMs + 1);
    expect(sends).toEqual([]); // the blind "continue" is gone — left for the responder
    expect(rowOf("handle-alive").herdr_pane_id).not.toBeNull(); // not torn down
  });

  test("no-op off the in_progress build phase, before the log, or under the idle threshold", async () => {
    sends = [];
    seedLive("handle-noop");
    liveMod.setCmdlineLister(() => [["claude", "--session-id", "sess-handle-noop"]]);
    await dispatchMod.handleIdleAgent("handle-noop", "in_review", cfg.idleMs + 1); // wrong phase
    await dispatchMod.handleIdleAgent("handle-noop", "in_progress", null); // no log yet
    await dispatchMod.handleIdleAgent("handle-noop", "in_progress", cfg.idleMs - 1); // not idle
    expect(sends).toEqual([]);
  });
});
