// Tests for the STALLED-AGENT AUTO-NUDGE (see dispatcher.shouldNudgeStall — the
// pure trip decision — and dispatcher.maybeNudgeStalledAgent — the per-poll-tick
// step the task watcher runs). A WORKSPACE build agent can STALL: sit idle but
// alive on a transient API error (e.g. a 529 Overloaded) or parked at an empty
// prompt. butchr's idle detector only FLAGS that idle and the runaway watchdog only
// catches alive-and-LOOPING, so neither recovers a quiet stall — the agent auto-nudge
// types `continue` for it after a bounded grace period.
//
// These are in-process: no real claude or herdr is spawned. We swap a FAKE harness
// backend (via setRunner) that RECORDS every `send`, so we can assert the watcher
// pushes `continue` + Enter to the stalled pane — and that it does NOT for the
// non-build phases / past the consecutive-nudge cap (the CTO agent and any
// non-workspace agent never run under a task watcher, so they can't reach this path
// at all; the in_progress-only guard is the in-code half of that guarantee).
//
// The decision is driven off config thresholds READ AT RUNTIME (not hard-coded), so
// the file is robust to whichever test imports config first.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunner, SendInput } from "../src/harness.ts";

let DATA_DIR: string;
const DIR_ID = "idle-nudge-dir";

let dbMod: typeof import("../src/db.ts");
let dispatchMod: typeof import("../src/dispatcher.ts");
let harnessMod: typeof import("../src/harness.ts");
let liveMod: typeof import("../src/liveness.ts");
let cfg: typeof import("../src/config.ts").config;
let originalRunner: AgentRunner;

// Records the `send` calls the nudge makes; every other backend method is a
// harmless default (this path only ever calls `send`).
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
      // Everything else: a benign async no-op (nothing else is invoked here).
      return noop;
    },
  });
}

// Seed a task with a session id; the injected /proc lister (see beforeAll) reports
// `sess-<id>` as a LIVE claude so the nudge's liveness guard passes and these tests
// exercise the nudge path (the auto-resume path is covered in auto-resume.test.ts).
function seedTask(id: string, status: string): void {
  dbMod.db
    .query(
      `INSERT INTO tasks (id, workspace_id, status, herdr_pane_id, session_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, DIR_ID, status, "pane-" + id, "sess-" + id, dbMod.nowIso());
}

function nudgeEvents(id: string): string[] {
  return dbMod
    .listTaskEvents(id)
    .map((e) => e.note ?? "")
    .filter((n) => n.includes("auto-nudged"));
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-idle-nudge-data-"));
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";
  // Small, deterministic thresholds (used only if this file imports config first).
  process.env.BUTCHR_IDLE_MS = "1000";
  process.env.BUTCHR_IDLE_NUDGE_MS = "2000";
  process.env.BUTCHR_IDLE_NUDGE_MAX = "2";

  dbMod = await import("../src/db.ts");
  cfg = (await import("../src/config.ts")).config;
  dispatchMod = await import("../src/dispatcher.ts");
  harnessMod = await import("../src/harness.ts");
  liveMod = await import("../src/liveness.ts");

  originalRunner = harnessMod.getRunner();
  harnessMod.setRunner(makeFakeRunner());
  // Report every seeded task's `sess-<id>` as a LIVE claude process, so the nudge's
  // liveness guard (don't nudge a dead shell) passes and these tests drive the nudge.
  liveMod.setCmdlineLister(() => {
    const ids = dbMod.db
      .query<{ session_id: string | null }, []>(`SELECT session_id FROM tasks WHERE session_id IS NOT NULL`)
      .all();
    return ids.map((r) => ["claude", "--session-id", r.session_id as string]);
  });

  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(DIR_ID, DATA_DIR, "test", dbMod.nowIso());
});

afterAll(() => {
  harnessMod.setRunner(originalRunner); // don't leak the fake into other files
  liveMod.setCmdlineLister(null); // restore the real /proc probe for other files
  rmSync(DATA_DIR, { recursive: true, force: true });
});

// quietMs that is comfortably past the idle threshold + grace period → a stall.
function stalledQuietMs(): number {
  return cfg.idleMs + cfg.idleNudgeMs + 1;
}

describe("shouldNudgeStall (the pure auto-nudge trip decision)", () => {
  const base = {
    quietMs: 10_000,
    sinceLastNudgeMs: null as number | null,
    nudgesSent: 0,
    idleMs: 1000,
    idleNudgeMs: 2000,
    maxNudges: 2,
  };

  test("fires once the agent has been quiet past idleMs + the grace period", () => {
    expect(dispatchMod.shouldNudgeStall({ ...base, quietMs: 3001 })).toBe(true);
    // Exactly at the boundary (idleMs + idleNudgeMs) is NOT yet past it.
    expect(dispatchMod.shouldNudgeStall({ ...base, quietMs: 3000 })).toBe(false);
    expect(dispatchMod.shouldNudgeStall({ ...base, quietMs: 2999 })).toBe(false);
  });

  test("disabled when idleNudgeMs <= 0 or maxNudges <= 0 (never fires)", () => {
    expect(dispatchMod.shouldNudgeStall({ ...base, idleNudgeMs: 0 })).toBe(false);
    expect(dispatchMod.shouldNudgeStall({ ...base, maxNudges: 0 })).toBe(false);
    expect(dispatchMod.shouldNudgeStall({ ...base, maxNudges: -1 })).toBe(false);
  });

  test("bounded: never nudges once nudgesSent has reached the cap", () => {
    expect(dispatchMod.shouldNudgeStall({ ...base, nudgesSent: 1 })).toBe(true);
    expect(dispatchMod.shouldNudgeStall({ ...base, nudgesSent: 2 })).toBe(false); // at cap
    expect(dispatchMod.shouldNudgeStall({ ...base, nudgesSent: 3 })).toBe(false); // past cap
  });

  test("successive nudges are spaced by at least the grace period", () => {
    // Just nudged (within the grace window) → hold off.
    expect(
      dispatchMod.shouldNudgeStall({ ...base, nudgesSent: 1, sinceLastNudgeMs: 1500 }),
    ).toBe(false);
    expect(
      dispatchMod.shouldNudgeStall({ ...base, nudgesSent: 1, sinceLastNudgeMs: 2000 }),
    ).toBe(false); // exactly the grace period — not yet
    // A full grace period has elapsed since the last nudge → fire again.
    expect(
      dispatchMod.shouldNudgeStall({ ...base, nudgesSent: 1, sinceLastNudgeMs: 2001 }),
    ).toBe(true);
  });
});

describe("maybeNudgeStalledAgent (the watcher's per-tick step)", () => {
  test("a stalled in_progress workspace agent gets a 'continue' nudge + an audit event", async () => {
    sends = [];
    seedTask("stalled-build", "in_progress");
    const now = 1_000_000;
    const next = await dispatchMod.maybeNudgeStalledAgent(
      "stalled-build",
      "in_progress",
      stalledQuietMs(),
      { nudgesSent: 0, lastNudgeAt: 0 },
      now,
    );
    // Typed `continue` and submitted it (text + trailing Enter), to the agent NAME.
    expect(sends).toEqual([["stalled-build", { text: "continue", enter: true }]]);
    // State advanced: one nudge sent, stamped at `now`.
    expect(next).toEqual({ nudgesSent: 1, lastNudgeAt: now });
    // The nudge is on the task's audit timeline.
    expect(nudgeEvents("stalled-build").length).toBe(1);
  });

  test("the finalizing (non-build) phase is never nudged", async () => {
    sends = [];
    seedTask("finalizing-task", "finalizing");
    const next = await dispatchMod.maybeNudgeStalledAgent(
      "finalizing-task",
      "finalizing",
      stalledQuietMs(),
      { nudgesSent: 0, lastNudgeAt: 0 },
      2_000_000,
    );
    expect(sends).toEqual([]); // no send — only the in_progress build phase qualifies
    expect(next).toEqual({ nudgesSent: 0, lastNudgeAt: 0 }); // untouched
    expect(nudgeEvents("finalizing-task").length).toBe(0);
  });

  test("output resuming (quiet back under idleMs) clears the nudge streak", async () => {
    sends = [];
    seedTask("resumed-build", "in_progress");
    const next = await dispatchMod.maybeNudgeStalledAgent(
      "resumed-build",
      "in_progress",
      Math.max(0, cfg.idleMs - 1), // active again — under the idle threshold
      { nudgesSent: 1, lastNudgeAt: 999 },
      2_500_000,
    );
    expect(sends).toEqual([]); // nothing to nudge
    expect(next).toEqual({ nudgesSent: 0, lastNudgeAt: 0 }); // streak reset
  });

  test("a missing log (quietMs === null) is a no-op", async () => {
    sends = [];
    seedTask("nolog-build", "in_progress");
    const state = { nudgesSent: 0, lastNudgeAt: 0 };
    const next = await dispatchMod.maybeNudgeStalledAgent(
      "nolog-build",
      "in_progress",
      null,
      state,
      3_000_000,
    );
    expect(sends).toEqual([]);
    expect(next).toBe(state); // unchanged
  });

  test("bounded: once at the consecutive-nudge cap, no further nudge is sent", async () => {
    sends = [];
    seedTask("capped-build", "in_progress");
    // Already nudged up to the cap, with the last nudge long enough ago that only the
    // cap (not the spacing) is what holds it back.
    const next = await dispatchMod.maybeNudgeStalledAgent(
      "capped-build",
      "in_progress",
      stalledQuietMs(),
      { nudgesSent: cfg.idleNudgeMaxNudges, lastNudgeAt: 1 },
      9_000_000,
    );
    expect(sends).toEqual([]); // cap reached → left flagged for a human
    expect(next).toEqual({ nudgesSent: cfg.idleNudgeMaxNudges, lastNudgeAt: 1 });
    expect(nudgeEvents("capped-build").length).toBe(0);
  });
});
