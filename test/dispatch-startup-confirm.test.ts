// Tests for the WORKER launch auto-confirm (dispatcher.autoConfirmTaskStartup) — the
// symmetric counterpart to the CTO's launch auto-confirm. Since the connectivity feature
// attaches `--dangerously-load-development-channels` to worker launches, a freshly
// dispatched worker hits Claude Code's BLOCKING dev-channels consent prompt the first
// time it loads; left unanswered it never reaches its task. autoConfirmTaskStartup polls
// the live pane and sends the safe confirming response (reusing src/startup-confirm.ts).
//
// In-process: a fake harness backend (setRunner) drives `agentRead` (the live pane text)
// and records every `send`, so we can assert a worker showing the consent prompt gets
// `1`+Enter, and a worker with no prompt on screen gets NO keystroke (no stray input).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AgentRunner, SendInput } from "../src/harness.ts";

let dispatchMod: typeof import("../src/dispatcher.ts");
let harnessMod: typeof import("../src/harness.ts");
let cfg: typeof import("../src/config.ts").config;
let originalRunner: AgentRunner;

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

beforeAll(async () => {
  harnessMod = await import("../src/harness.ts");
  dispatchMod = await import("../src/dispatcher.ts");
  cfg = (await import("../src/config.ts")).config;
  originalRunner = harnessMod.getRunner();
  // Tiny + quiet-after-one so the poll loop converges instantly in-test.
  cfg.ctoPromptPollMs = 0;
  cfg.ctoPromptMaxPolls = 10;
  cfg.ctoPromptQuietPolls = 1;
});

afterAll(() => {
  harnessMod.setRunner(originalRunner);
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

    const answered = await dispatchMod.autoConfirmTaskStartup("task-1");

    expect(answered).toEqual(["dev-channels-consent"]);
    expect(sends).toEqual([["task-1", { text: "1", enter: true }]]);
  });

  test("a worker with no prompt on screen gets NO keystroke (no stray input)", async () => {
    sends = [];
    const screens = new Map<string, string[]>([["task-2", ["● running normally"]]]);
    harnessMod.setRunner(makeFakeRunner(screens));

    const answered = await dispatchMod.autoConfirmTaskStartup("task-2");

    expect(answered).toEqual([]);
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

    await expect(dispatchMod.autoConfirmTaskStartup("task-3")).resolves.toEqual([]);
  });
});
