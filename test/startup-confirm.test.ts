// Tests for LAUNCH AUTO-CONFIRM (src/startup-confirm.ts): every per-workspace CTO
// (re)launch must come up READY unattended by detecting a blocking interactive startup
// prompt in the live pane and sending the safe confirming response. Pure / in-process:
// the detector is pure, and the poll loop's read/send/sleep seams are injected.
import { describe, expect, test } from "bun:test";
import type { SendInput } from "../src/harness.ts";
import {
  STARTUP_CONFIRM_RULES,
  autoConfirmStartupPrompts,
  classifyStartupScreen,
  detectStartupPrompt,
  looksLikePrompt,
} from "../src/startup-confirm.ts";

const noSleep = async () => {};

describe("detectStartupPrompt (generic, extensible — not hardcoded strings)", () => {
  test("matches the dev-channels consent (numbered local-development option)", () => {
    const screen = [
      "This tool can load development channels.",
      "  1. I am using this for local development",
      "  2. No",
    ].join("\n");
    const rule = detectStartupPrompt(screen);
    expect(rule?.name).toBe("dev-channels-consent");
    expect(rule?.response).toEqual({ text: "1", enter: true });
  });

  test("matches the folder-trust prompt", () => {
    const rule = detectStartupPrompt("Do you trust the files in this folder?\n 1. Yes, proceed");
    expect(rule?.name).toBe("folder-trust");
    expect((rule?.response as { text: string }).text).toBe("1");
  });

  test("matches a generic (y/n) confirmation", () => {
    const rule = detectStartupPrompt("Continue with the operation? (y/n)");
    expect(rule?.name).toBe("yes-no");
    expect(rule?.response).toEqual({ text: "y", enter: true });
  });

  test("matches a generic numbered proceed menu", () => {
    const rule = detectStartupPrompt("Pick one:\n❯ 1. Yes\n  2. No");
    expect(rule?.name).toBe("numbered-proceed");
  });

  test("returns null on a blank screen or an ordinary running pane", () => {
    expect(detectStartupPrompt("")).toBeNull();
    expect(detectStartupPrompt("   \n  ")).toBeNull();
    expect(detectStartupPrompt("● Running tests…\n  3 passed")).toBeNull();
  });

  test("is extensible via a custom rule table (first match wins)", () => {
    const custom = [
      { name: "custom", test: /please confirm/i, response: { text: "y", enter: true } as SendInput },
    ];
    expect(detectStartupPrompt("Please confirm to proceed", custom)?.name).toBe("custom");
    // The built-ins are not consulted when a custom table is passed.
    expect(detectStartupPrompt("(y/n)", custom)).toBeNull();
  });

  test("the built-in rule table is non-empty and well-formed", () => {
    expect(STARTUP_CONFIRM_RULES.length).toBeGreaterThan(0);
    for (const r of STARTUP_CONFIRM_RULES) {
      expect(typeof r.name).toBe("string");
      expect(r.test).toBeInstanceOf(RegExp);
    }
  });
});

describe("autoConfirmStartupPrompts (bounded, idempotent poll loop)", () => {
  test("confirms a prompt then stops sending once the pane is ready", async () => {
    // Screens: a dev-consent prompt, then a folder-trust prompt, then the ready pane.
    const screens = [
      "1. I am using this for local development",
      "Do you trust the files in this folder?",
      "● ready — awaiting your prompt",
      "● ready — awaiting your prompt",
    ];
    let i = 0;
    const sent: Array<{ name: string; input: SendInput }> = [];
    const result = await autoConfirmStartupPrompts("agent-x", {
      read: async () => screens[Math.min(i++, screens.length - 1)]!,
      send: async (name, input) => { sent.push({ name, input }); },
      sleep: noSleep,
      pollMs: 0,
      maxPolls: 20,
      quietPolls: 2,
    });
    // Each distinct prompt confirmed exactly once; nothing sent after the pane is ready.
    expect(result.answered).toEqual(["dev-channels-consent", "folder-trust"]);
    expect(result.stuckScreen).toBeUndefined();
    expect(sent.length).toBe(2);
    expect(sent.map((s) => s.name)).toEqual(["agent-x", "agent-x"]);
  });

  test("does NOT send when there is never a prompt (no stray input)", async () => {
    const sent: SendInput[] = [];
    const result = await autoConfirmStartupPrompts("agent-y", {
      read: async () => "● running normally",
      send: async (_n, input) => { sent.push(input); },
      sleep: noSleep,
      pollMs: 0,
      maxPolls: 10,
      quietPolls: 2,
    });
    expect(result.answered).toEqual([]);
    expect(result.stuckScreen).toBeUndefined();
    expect(sent.length).toBe(0);
  });

  test("re-sends a PERSISTENT prompt (first keystroke dropped) then advances", async () => {
    // The dev-consent prompt persists for several polls (our send didn't register),
    // then the pane advances to ready.
    let polls = 0;
    const sent: SendInput[] = [];
    const result = await autoConfirmStartupPrompts("agent-z", {
      read: async () => (polls++ < 6 ? "1. I am using this for local development" : "● ready"),
      send: async (_n, input) => { sent.push(input); },
      sleep: noSleep,
      pollMs: 0,
      maxPolls: 30,
      quietPolls: 2,
      resendEvery: 3,
    });
    // First send immediately, then a resend after `resendEvery` polls of persistence.
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(result.answered.every((a) => a === "dev-channels-consent")).toBe(true);
  });

  test("returns stuckScreen when an UNRECOGNIZED prompt persists the whole budget", async () => {
    // A prompt-like pane that matches NO rule (an unknown numbered consent menu) stays up for
    // every poll — auto-confirm must NOT mistake it for quiet, must send nothing (no safe
    // keystroke), and must report the screen so the caller can flag it for user input.
    const stuck = "Some unrecognized consent we have no rule for:\n  1. Foo\n  2. Bar";
    const sent: SendInput[] = [];
    const result = await autoConfirmStartupPrompts("agent-stuck", {
      read: async () => stuck,
      send: async (_n, input) => { sent.push(input); },
      sleep: noSleep,
      pollMs: 0,
      maxPolls: 5,
      quietPolls: 2,
    });
    expect(result.answered).toEqual([]);
    expect(result.stuckScreen).toBe(stuck);
    expect(sent.length).toBe(0); // no rule → no keystroke
  });

  test("a stuck pane that LATER goes quiet returns no stuckScreen (human answered)", async () => {
    // The unrecognized prompt clears (e.g. a human answered it) → the pane goes quiet and the
    // run reports a clean exit, NOT a stuck one.
    const screens = [
      "Unknown prompt:\n  1. Foo\n  2. Bar",
      "● ready — awaiting your prompt",
      "● ready — awaiting your prompt",
    ];
    let i = 0;
    const result = await autoConfirmStartupPrompts("agent-recovered", {
      read: async () => screens[Math.min(i++, screens.length - 1)]!,
      send: async () => {},
      sleep: noSleep,
      pollMs: 0,
      maxPolls: 10,
      quietPolls: 2,
    });
    expect(result.stuckScreen).toBeUndefined();
  });

  test("never throws when read/send fail (best-effort)", async () => {
    await expect(
      autoConfirmStartupPrompts("agent-bad", {
        read: async () => { throw new Error("pane gone"); },
        send: async () => { throw new Error("dead pane"); },
        sleep: noSleep,
        pollMs: 0,
        maxPolls: 3,
        quietPolls: 1,
      }),
    ).resolves.toEqual({ answered: [] });
  });
});

describe("looksLikePrompt (heuristic STUCK-detection for unrecognized prompts)", () => {
  test("true for the dev-channels consent banner", () => {
    expect(looksLikePrompt("WARNING: Loading development channels\n  1. Yes\n  2. No")).toBe(true);
  });

  test("true for a folder-trust dialog", () => {
    expect(looksLikePrompt("Do you trust the files in this folder?")).toBe(true);
    expect(looksLikePrompt("Do you want to trust this workspace?")).toBe(true);
  });

  test("true for a (y/n) confirmation", () => {
    expect(looksLikePrompt("Overwrite existing file? (y/n)")).toBe(true);
  });

  test("true for an 'Enter to confirm' / 'press enter' prompt", () => {
    expect(looksLikePrompt("Press Enter to continue")).toBe(true);
    expect(looksLikePrompt("Enter to confirm your selection")).toBe(true);
  });

  test("true for a ❯ selection cursor", () => {
    expect(looksLikePrompt("Choose an option:\n❯ Apple\n  Banana")).toBe(true);
  });

  test("true for a two-option numbered menu (no other tell)", () => {
    expect(looksLikePrompt("Pick:\n  1. Keep\n  2. Discard")).toBe(true);
  });

  test("false for a blank or whitespace screen", () => {
    expect(looksLikePrompt("")).toBe(false);
    expect(looksLikePrompt("   \n  ")).toBe(false);
  });

  test("false for ordinary running output (logs/spinners/single numbered line)", () => {
    expect(looksLikePrompt("● Running tests…\n  3 passed")).toBe(false);
    expect(looksLikePrompt("Step 1. Compiling the project")).toBe(false);
  });
});

describe("classifyStartupScreen (rule / stuck / quiet — the null-ambiguity fix)", () => {
  test("rule: a known prompt is classified for auto-confirm", () => {
    const cls = classifyStartupScreen("1. I am using this for local development");
    expect(cls.kind).toBe("rule");
    if (cls.kind === "rule") expect(cls.rule.name).toBe("dev-channels-consent");
  });

  test("stuck: an unrecognized prompt-like screen (matches NO rule)", () => {
    expect(classifyStartupScreen("Unknown consent:\n  1. Foo\n  2. Bar").kind).toBe("stuck");
  });

  test("quiet: a blank screen or ordinary running output", () => {
    expect(classifyStartupScreen("").kind).toBe("quiet");
    expect(classifyStartupScreen("● Running tests…\n  3 passed").kind).toBe("quiet");
  });
});

describe("broadened rule table (enter-to-confirm + folder-trust variants)", () => {
  test("a bare 'Press Enter to confirm' is auto-confirmed with a lone Enter", () => {
    const rule = detectStartupPrompt("Press Enter to confirm");
    expect(rule?.name).toBe("enter-to-confirm");
    expect(rule?.response).toEqual({ enter: true });
  });

  test("a 'trust this workspace' variant is caught by folder-trust", () => {
    expect(detectStartupPrompt("Do you trust this workspace?")?.name).toBe("folder-trust");
  });
});
