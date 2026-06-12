// Tests for LAUNCH AUTO-CONFIRM (src/startup-confirm.ts): every per-workspace CTO
// (re)launch must come up READY unattended by detecting a blocking interactive startup
// prompt in the live pane and sending the safe confirming response. Pure / in-process:
// the detector is pure, and the poll loop's read/send/sleep seams are injected.
import { describe, expect, test } from "bun:test";
import type { SendInput } from "../src/harness.ts";
import {
  STARTUP_CONFIRM_RULES,
  autoConfirmStartupPrompts,
  detectStartupPrompt,
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
    const answered = await autoConfirmStartupPrompts("agent-x", {
      read: async () => screens[Math.min(i++, screens.length - 1)]!,
      send: async (name, input) => { sent.push({ name, input }); },
      sleep: noSleep,
      pollMs: 0,
      maxPolls: 20,
      quietPolls: 2,
    });
    // Each distinct prompt confirmed exactly once; nothing sent after the pane is ready.
    expect(answered).toEqual(["dev-channels-consent", "folder-trust"]);
    expect(sent.length).toBe(2);
    expect(sent.map((s) => s.name)).toEqual(["agent-x", "agent-x"]);
  });

  test("does NOT send when there is never a prompt (no stray input)", async () => {
    const sent: SendInput[] = [];
    const answered = await autoConfirmStartupPrompts("agent-y", {
      read: async () => "● running normally",
      send: async (_n, input) => { sent.push(input); },
      sleep: noSleep,
      pollMs: 0,
      maxPolls: 10,
      quietPolls: 2,
    });
    expect(answered).toEqual([]);
    expect(sent.length).toBe(0);
  });

  test("re-sends a PERSISTENT prompt (first keystroke dropped) then advances", async () => {
    // The dev-consent prompt persists for several polls (our send didn't register),
    // then the pane advances to ready.
    let polls = 0;
    const sent: SendInput[] = [];
    const answered = await autoConfirmStartupPrompts("agent-z", {
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
    expect(answered.every((a) => a === "dev-channels-consent")).toBe(true);
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
    ).resolves.toEqual([]);
  });
});
