// Tests for the MID-SESSION SAFETY-NET probe (dispatcher.probeAgentForPrompt /
// probeTaskMidSession / shouldProbeTick) — the counterpart to launch auto-confirm for a
// human-only prompt that appears AFTER launch (a mid-run tool-permission / trust dialog).
// The per-task build-agent watcher loops ~1s but only stat()s the run-log mtime; on a
// COARSE cadence it additionally reads the live pane CONTENT and runs it through the same
// startup-prompt classifier: a known prompt is auto-confirmed (mirroring launch
// auto-confirm), an unrecognized-but-prompt-like pane flips needs_user_input, and a clean
// pane CLEARS the flag (same self-clearing lifecycle as idle).
//
// Two layers are exercised: probeAgentForPrompt with injectable fakes (logic), and
// probeTaskMidSession against a seeded LIVE in_progress build row (the harness + DB
// wiring). Env is set before the dynamic imports so config/db read our temp paths and the
// live DB is never touched.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunner, SendInput } from "../src/harness.ts";

let dispatchMod: typeof import("../src/dispatcher.ts");
let harnessMod: typeof import("../src/harness.ts");
let dbMod: typeof import("../src/db.ts");
let originalRunner: AgentRunner;

let DATA_DIR: string;
let REPO_ROOT: string;
const DIR_ID = "test-dir-mid-probe";

let sends: Array<[string, SendInput]> = [];

// A fake backend: `agentRead` returns the (sticky) screen for a name; `send` is recorded.
function makeFakeRunner(screens: Map<string, string>): AgentRunner {
  const noop = async () => undefined as never;
  return new Proxy({} as AgentRunner, {
    get(_t, prop) {
      if (prop === "send") {
        return async (name: string, input: SendInput) => {
          sends.push([name, input]);
        };
      }
      if (prop === "agentRead") {
        return async (name: string) => screens.get(name) ?? "";
      }
      return noop;
    },
  });
}

// Seed a LIVE in_progress build agent row (the only shape setNeedsUserInput acts on).
function seedLiveTask(id: string): void {
  dbMod.db
    .query(
      `INSERT INTO tasks (id, workspace_id, status, has_agent, created_at) VALUES (?, ?, 'in_progress', 1, ?)`,
    )
    .run(id, DIR_ID, dbMod.nowIso());
}

function flagOf(id: string): { flag: number; ctx: string | null } {
  const row = dbMod.db
    .query<{ needs_user_input: number; needs_user_input_context: string | null }, [string]>(
      `SELECT needs_user_input, needs_user_input_context FROM tasks WHERE id=?`,
    )
    .get(id);
  return { flag: row?.needs_user_input ?? -1, ctx: row?.needs_user_input_context ?? null };
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-repo-"));
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  harnessMod = await import("../src/harness.ts");
  dispatchMod = await import("../src/dispatcher.ts");
  dbMod = await import("../src/db.ts");
  originalRunner = harnessMod.getRunner();

  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(DIR_ID, REPO_ROOT, "test", dbMod.nowIso());
});

afterAll(() => {
  harnessMod.setRunner(originalRunner);
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

// ── shouldProbeTick — the throttle gate ────────────────────────────────────────────────
describe("shouldProbeTick (throttle)", () => {
  test("fires only on every Nth tick, skipping the reads between probe ticks", () => {
    const every = 10;
    const fired = [];
    for (let t = 1; t <= 30; t++) if (dispatchMod.shouldProbeTick(t, every)) fired.push(t);
    expect(fired).toEqual([10, 20, 30]);
    // The 9 ticks between each probe do NOT read the pane.
    expect(dispatchMod.shouldProbeTick(5, every)).toBe(false);
    expect(dispatchMod.shouldProbeTick(19, every)).toBe(false);
  });

  test("a non-positive cadence disables the probe entirely", () => {
    expect(dispatchMod.shouldProbeTick(10, 0)).toBe(false);
    expect(dispatchMod.shouldProbeTick(10, -1)).toBe(false);
  });
});

// ── probeAgentForPrompt — the classify→act logic (injectable fakes) ─────────────────────
describe("probeAgentForPrompt (classify → auto-confirm / flag / clear)", () => {
  // A minimal in-memory deps factory over a fake flag store.
  function makeDeps(screen: string | (() => Promise<string>), flag = { on: false }) {
    const calls = { sends: [] as SendInput[], setFlag: [] as Array<{ on: boolean; ctx?: string }> };
    return {
      calls,
      deps: {
        read: typeof screen === "function" ? screen : async () => screen,
        send: async (_n: string, input: SendInput) => { calls.sends.push(input); },
        setFlag: (_id: string, on: boolean, capture?: () => string) => {
          flag.on = on;
          calls.setFlag.push({ on, ctx: on ? capture?.() : undefined });
        },
        flagged: () => flag.on,
      },
    };
  }

  test("auto-confirms a MATCHED prompt (sends the safe response)", async () => {
    const { deps, calls } = makeDeps(
      "WARNING: Loading development channels\n  1. I am using this for local development\n  2. Exit",
    );
    await dispatchMod.probeAgentForPrompt("t", deps);
    expect(calls.sends).toEqual([{ text: "1", enter: true }]);
  });

  test("flags an UNMATCHED prompt-like pane for user input, capturing the screen", async () => {
    const stuck = "Some tool wants permission:\n  1. Accept\n  2. Reject";
    const { deps, calls } = makeDeps(stuck);
    await dispatchMod.probeAgentForPrompt("t", deps);
    expect(calls.sends).toEqual([]); // no rule → no safe keystroke
    expect(calls.setFlag).toEqual([{ on: true, ctx: stuck }]);
  });

  test("CLEARS the flag when the pane goes clean and the flag was set", async () => {
    const { deps, calls } = makeDeps("● running normally — no prompt", { on: true });
    await dispatchMod.probeAgentForPrompt("t", deps);
    expect(calls.sends).toEqual([]);
    expect(calls.setFlag).toEqual([{ on: false }]);
  });

  test("a clean pane with the flag NOT set is a no-op (no clear churn)", async () => {
    const { deps, calls } = makeDeps("● running normally", { on: false });
    await dispatchMod.probeAgentForPrompt("t", deps);
    expect(calls.setFlag).toEqual([]);
  });

  test("auto-confirming a matched prompt ALSO clears a stale flag from an earlier prompt", async () => {
    const { deps, calls } = makeDeps("Do you trust the files in this folder?\n  1. Yes\n  2. No", {
      on: true,
    });
    await dispatchMod.probeAgentForPrompt("t", deps);
    expect(calls.sends).toEqual([{ text: "1", enter: true }]);
    expect(calls.setFlag).toEqual([{ on: false }]); // handled → user no longer needed
  });

  test("best-effort: a READ failure does nothing (no send, no flag change)", async () => {
    const { deps, calls } = makeDeps(async () => { throw new Error("pane gone"); }, { on: false });
    await expect(dispatchMod.probeAgentForPrompt("t", deps)).resolves.toBeUndefined();
    expect(calls.sends).toEqual([]);
    expect(calls.setFlag).toEqual([]);
  });

  test("best-effort: a SEND failure on a matched prompt is swallowed (still clears stale flag)", async () => {
    const flag = { on: true };
    const calls = { setFlag: [] as boolean[] };
    const deps = {
      read: async () => "  1. I am using this for local development\n  2. Exit",
      send: async () => { throw new Error("dead pane"); },
      setFlag: (_id: string, on: boolean) => { flag.on = on; calls.setFlag.push(on); },
      flagged: () => flag.on,
    };
    await expect(dispatchMod.probeAgentForPrompt("t", deps)).resolves.toBeUndefined();
    expect(calls.setFlag).toEqual([false]);
  });
});

// ── probeTaskMidSession — the live harness + DB wiring ──────────────────────────────────
describe("probeTaskMidSession (harness + needs_user_input wiring)", () => {
  test("an unmatched mid-session prompt flags the live build task and captures the screen", async () => {
    sends = [];
    seedLiveTask("mid-stuck");
    const stuck = "An unknown mid-run consent:\n  1. Foo\n  2. Bar";
    harnessMod.setRunner(makeFakeRunner(new Map([["mid-stuck", stuck]])));

    await dispatchMod.probeTaskMidSession("mid-stuck");

    const { flag, ctx } = flagOf("mid-stuck");
    expect(flag).toBe(1);
    expect(ctx).toBe(stuck);
    expect(sends).toEqual([]);
  });

  test("a matched mid-session prompt auto-confirms (sends safe response) and does not flag", async () => {
    sends = [];
    seedLiveTask("mid-match");
    harnessMod.setRunner(
      makeFakeRunner(new Map([["mid-match", "  1. I am using this for local development\n  2. Exit"]])),
    );

    await dispatchMod.probeTaskMidSession("mid-match");

    expect(sends).toEqual([["mid-match", { text: "1", enter: true }]]);
    expect(flagOf("mid-match").flag).toBe(0);
  });

  test("the flag CLEARS once the pane goes clean (self-clearing lifecycle)", async () => {
    sends = [];
    seedLiveTask("mid-clear");
    const stuck = "Unhandled dialog:\n  1. A\n  2. B";
    const screens = new Map([["mid-clear", stuck]]);
    harnessMod.setRunner(makeFakeRunner(screens));

    // First probe: the prompt is up → flagged.
    await dispatchMod.probeTaskMidSession("mid-clear");
    expect(flagOf("mid-clear").flag).toBe(1);

    // The agent answers / moves past it; the pane is now quiet → next probe clears.
    screens.set("mid-clear", "● back to work, no prompt");
    await dispatchMod.probeTaskMidSession("mid-clear");
    expect(flagOf("mid-clear").flag).toBe(0);
    expect(flagOf("mid-clear").ctx).toBeNull();
  });

  test("best-effort: a read/send failure never throws", async () => {
    seedLiveTask("mid-err");
    harnessMod.setRunner(
      new Proxy({} as AgentRunner, {
        get(_t, prop) {
          if (prop === "agentRead") return async () => { throw new Error("pane gone"); };
          if (prop === "send") return async () => { throw new Error("dead pane"); };
          return async () => undefined as never;
        },
      }),
    );
    await expect(dispatchMod.probeTaskMidSession("mid-err")).resolves.toBeUndefined();
  });
});
