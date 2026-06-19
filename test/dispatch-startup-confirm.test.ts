// Tests for the WORKER launch auto-confirm (dispatcher.autoConfirmTaskStartup) — the
// symmetric counterpart to the CTO's launch auto-confirm. Since the connectivity feature
// attaches `--dangerously-load-development-channels` to worker launches, a freshly
// dispatched worker hits Claude Code's BLOCKING dev-channels consent prompt the first
// time it loads; left unanswered it never reaches its task. autoConfirmTaskStartup polls
// the live pane and sends the safe confirming response (reusing src/startup-confirm.ts).
//
// It ALSO covers the root-fix wiring: when auto-confirm GIVES UP on an unrecognized but
// prompt-like pane, autoConfirmAndFlagTaskStartup flags the task via setNeedsUserInput so
// the hung agent becomes visible + user-routed instead of silently frozen.
//
// In-process: a fake harness backend (setRunner) drives `agentRead` (the live pane text)
// and records every `send`, so we can assert a worker showing the consent prompt gets
// `1`+Enter, and a worker with no prompt on screen gets NO keystroke (no stray input).
// Env is set before the dynamic imports so config/db read our temp paths (and the live DB
// is never touched).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunner, SendInput } from "../src/harness.ts";

let dispatchMod: typeof import("../src/dispatcher.ts");
let harnessMod: typeof import("../src/harness.ts");
let dbMod: typeof import("../src/db.ts");
let cfg: typeof import("../src/config.ts").config;
let originalRunner: AgentRunner;

let DATA_DIR: string;
let REPO_ROOT: string;
const DIR_ID = "test-dir-startup";

let sends: Array<[string, SendInput]> = [];

// A fake backend: `agentRead` returns successive screens from the per-name queue (the
// last screen sticks once drained); `send` is recorded. Everything else is a no-op.
function makeFakeRunner(screens: Map<string, string[]>): AgentRunner {
  const noop = async () => undefined as never;
  return new Proxy({} as AgentRunner, {
    get(_t, prop) {
      if (prop === "send") {
        return async (name: string, input: SendInput) => {
          sends.push([name, input]);
        };
      }
      if (prop === "agentRead") {
        return async (name: string) => {
          const q = screens.get(name) ?? [];
          return q.length > 1 ? q.shift()! : (q[0] ?? "");
        };
      }
      return noop;
    },
  });
}

// Seed a LIVE in_progress build agent row (the only shape setNeedsUserInput acts on).
function seedLiveTask(id: string): void {
  const created = dbMod.nowIso();
  dbMod.db
    .query(
      `INSERT INTO tasks (id, workspace_id, status, has_agent, created_at) VALUES (?, ?, 'in_progress', 1, ?)`,
    )
    .run(id, DIR_ID, created);
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
  cfg = (await import("../src/config.ts")).config;
  originalRunner = harnessMod.getRunner();
  // Tiny + quiet-after-one so the poll loop converges instantly in-test.
  cfg.ctoPromptPollMs = 0;
  cfg.ctoPromptMaxPolls = 10;
  cfg.ctoPromptQuietPolls = 1;

  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(DIR_ID, REPO_ROOT, "test", dbMod.nowIso());
});

afterAll(() => {
  harnessMod.setRunner(originalRunner);
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

describe("autoConfirmTaskStartup (worker launch auto-confirm)", () => {
  test("a worker showing the dev-channels consent prompt gets 1+Enter sent", async () => {
    sends = [];
    const screens = new Map<string, string[]>([
      [
        "task-1",
        [
          // The blocking consent the dev-channel flag triggers, then a ready pane.
          "WARNING: Loading development channels\n  1. I am using this for local development\n  2. Exit",
          "● ready — awaiting your prompt",
        ],
      ],
    ]);
    harnessMod.setRunner(makeFakeRunner(screens));

    const result = await dispatchMod.autoConfirmTaskStartup("task-1");

    expect(result.answered).toEqual(["dev-channels-consent"]);
    expect(result.stuckScreen).toBeUndefined();
    expect(sends).toEqual([["task-1", { text: "1", enter: true }]]);
  });

  test("a worker with no prompt on screen gets NO keystroke (no stray input)", async () => {
    sends = [];
    const screens = new Map<string, string[]>([["task-2", ["● running normally"]]]);
    harnessMod.setRunner(makeFakeRunner(screens));

    const result = await dispatchMod.autoConfirmTaskStartup("task-2");

    expect(result.answered).toEqual([]);
    expect(result.stuckScreen).toBeUndefined();
    expect(sends).toEqual([]);
  });

  test("an UNRECOGNIZED prompt-like pane reports a stuckScreen (no keystroke)", async () => {
    sends = [];
    const stuck = "An unknown consent we have no rule for:\n  1. Foo\n  2. Bar";
    const screens = new Map<string, string[]>([["task-stuck", [stuck]]]);
    harnessMod.setRunner(makeFakeRunner(screens));

    const result = await dispatchMod.autoConfirmTaskStartup("task-stuck");

    expect(result.answered).toEqual([]);
    expect(result.stuckScreen).toBe(stuck);
    expect(sends).toEqual([]);
  });

  test("best-effort: never throws even if the backend read/send fail", async () => {
    sends = [];
    harnessMod.setRunner(
      new Proxy({} as AgentRunner, {
        get(_t, prop) {
          if (prop === "agentRead") return async () => { throw new Error("pane gone"); };
          if (prop === "send") return async () => { throw new Error("dead pane"); };
          return async () => undefined as never;
        },
      }),
    );

    await expect(dispatchMod.autoConfirmTaskStartup("task-3")).resolves.toEqual({ answered: [] });
  });
});

describe("autoConfirmAndFlagTaskStartup (stuck → setNeedsUserInput flag)", () => {
  test("a stuck startup pane flags the live build task for user input, capturing the screen", async () => {
    seedLiveTask("task-flag");
    const stuck = "Blocking dialog with no matching rule:\n  1. Accept\n  2. Decline";
    harnessMod.setRunner(makeFakeRunner(new Map([["task-flag", [stuck]]])));

    await dispatchMod.autoConfirmAndFlagTaskStartup("task-flag");

    const row = dbMod.db
      .query<{ needs_user_input: number; needs_user_input_context: string | null }, [string]>(
        `SELECT needs_user_input, needs_user_input_context FROM tasks WHERE id=?`,
      )
      .get("task-flag");
    expect(row?.needs_user_input).toBe(1);
    expect(row?.needs_user_input_context).toBe(stuck);
  });

  test("a clean startup does NOT flag the task", async () => {
    seedLiveTask("task-clean");
    harnessMod.setRunner(makeFakeRunner(new Map([["task-clean", ["● ready — awaiting your prompt"]]])));

    await dispatchMod.autoConfirmAndFlagTaskStartup("task-clean");

    const row = dbMod.db
      .query<{ needs_user_input: number }, [string]>(
        `SELECT needs_user_input FROM tasks WHERE id=?`,
      )
      .get("task-clean");
    expect(row?.needs_user_input).toBe(0);
  });
});
