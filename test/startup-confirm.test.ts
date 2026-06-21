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
  looksLikeActiveSession,
  looksLikePrompt,
} from "../src/startup-confirm.ts";

const noSleep = async () => {};

// ── REAL captured pane fixtures (grounded against a live operator pane, 2026-06-19) ──────────
// The active-session anchor must match what the CURRENT Claude Code build actually renders, not
// a synthetic string. These are faithful to `herdr agent read` snapshots of live operator panes.

// A live, WORKING operator turn: a working-spinner line + the real status-bar footer carrying the
// literal `esc to interrupt` affordance. Captured verbatim from an in-flight turn.
const ACTIVE_TURN_FOOTER =
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt";

// An IDLE operator pane footer (turn finished, awaiting input): note it does NOT contain
// `esc to interrupt` — captured verbatim from the two real idle CTO panes.
const IDLE_FOOTER =
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ctrl+t to hide tasks · ← for agents";

// A faithful active leader/CTO pane mid-review whose scrolling output INCIDENTALLY contains a
// numbered list and the words 'proceed'/'yes' — exactly the 2026-06-19 false-positive shape. The
// numbered items are deliberately NOT `1. yes`/`1. proceed` so they match no confirm RULE; the
// prompt-ish content is purely incidental to a normal turn.
const ACTIVE_PANE_WITH_INCIDENTAL_PROMPTY_OUTPUT = [
  "● Reviewing the diff. My plan has three steps:",
  "  1. Anchor the classifier on the active-turn affordance",
  "  2. Wire it into classifyStartupScreen before the loose heuristics",
  "  3. Extend the regression tests",
  "  I'll proceed now — yes, the design holds and the rule path is unchanged.",
  "",
  "✻ Cogitating… (12s · ↓ 1.5k tokens)",
  "",
  "─────────────────────────────────────────────",
  "❯ ",
  "─────────────────────────────────────────────",
  ACTIVE_TURN_FOOTER,
].join("\n");

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

  // ── LOAD-BEARING false-positive regressions (the needs_user_input fix) ──────────────
  // A bare ❯ selection cursor is Claude Code's NORMAL input box — present on every active
  // pane — so it must NOT count as a blocking dialog on its own (the lone-❯ signal was
  // removed). Previously this returned true and mis-flagged every working agent.
  test("false for a bare ❯ active input box with no dialog phrase", () => {
    expect(looksLikePrompt("Choose an option:\n❯ Apple\n  Banana")).toBe(false);
    expect(looksLikePrompt("❯ ")).toBe(false);
  });

  // The OBSERVED false-positive: an actively-working agent whose pane held only the `raise`
  // MCP tool description got flagged. That benign description must classify as non-blocking.
  test("false for the `raise` MCP tool description text", () => {
    const raiseDesc =
      "Use this tool to put a clarifying question before proposing a plan. " +
      "raise is also non-blocking: it records your message and returns immediately, " +
      "after which you should stop and exit. Prefer raising over guessing.\n❯ ";
    expect(looksLikePrompt(raiseDesc)).toBe(false);
  });

  test("false for a normal active-turn pane (spinner + esc-to-interrupt + input box)", () => {
    expect(looksLikePrompt("✻ Considering… (12s · esc to interrupt)\n❯ ")).toBe(false);
  });

  test("true for the real dev-channels consent box and folder-trust dialog", () => {
    expect(
      looksLikePrompt(
        "WARNING: Loading development channels\n❯ 1. I am using this for local development\n  2. Exit",
      ),
    ).toBe(true);
    expect(looksLikePrompt("Do you trust the files in this folder?\n❯ 1. Yes\n  2. No")).toBe(true);
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

  test("quiet: a blank / whitespace / initializing / ordinary pre-dialog screen (NOT past startup)", () => {
    expect(classifyStartupScreen("").kind).toBe("quiet");
    expect(classifyStartupScreen("   \n  ").kind).toBe("quiet");
    expect(classifyStartupScreen("● Running tests…\n  3 passed").kind).toBe("quiet");
  });

  test("active: a live working Claude session ('esc to interrupt') is its own kind (past startup)", () => {
    expect(classifyStartupScreen(ACTIVE_TURN_FOOTER).kind).toBe("active");
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

  // Defense-in-depth (the needs_user_input fix): a bare "proceed?" is NOT a folder-trust
  // dialog — it appears in ordinary tool/agent output — so it must match NO rule, lest the
  // mid-session probe inject a spurious "1\n" into a working agent.
  test("a bare 'proceed?' matches NO rule (folder-trust no longer over-matches it)", () => {
    expect(detectStartupPrompt("Shall I proceed?")).toBeNull();
  });
});

// ── ACTIVE-SESSION ANCHOR (the 2026-06-19 false-positive fix, story st-a57a552e Bug 2) ───────
// A live, working operator pane must be a STRICT NO-OP for the startup classifier, while a
// genuine blocking dialog STILL auto-confirms. The anchor is grounded on the REAL `esc to
// interrupt` status-bar affordance present during an active turn and absent from every blocking
// dialog (verified against live operator panes — see the fixtures at the top of this file).
describe("looksLikeActiveSession (positive 'active turn ⇒ quiet' anchor)", () => {
  test("true on the REAL active-turn footer ('esc to interrupt' affordance)", () => {
    expect(looksLikeActiveSession(ACTIVE_TURN_FOOTER)).toBe(true);
    expect(looksLikeActiveSession(ACTIVE_PANE_WITH_INCIDENTAL_PROMPTY_OUTPUT)).toBe(true);
  });

  test("false on a blank/whitespace screen", () => {
    expect(looksLikeActiveSession("")).toBe(false);
    expect(looksLikeActiveSession("   \n  ")).toBe(false);
  });

  test("false on an IDLE operator footer (no active-turn affordance)", () => {
    expect(looksLikeActiveSession(IDLE_FOOTER)).toBe(false);
  });

  // The CRITICAL discriminator: the genuine blocking dialogs render `Esc to cancel` (or
  // nothing) — never `esc to interrupt` — so the anchor never quiets a real dialog.
  test("false on the genuine dev-channels consent + folder-trust dialogs", () => {
    const devChannels =
      "WARNING: Loading development channels\n❯ 1. I am using this for local development\n" +
      "  2. Exit\n  Enter to confirm · Esc to cancel";
    const folderTrust =
      "Do you trust the files in this folder?\n❯ 1. Yes, proceed\n  2. No\n  Enter to confirm · Esc to cancel";
    expect(looksLikeActiveSession(devChannels)).toBe(false);
    expect(looksLikeActiveSession(folderTrust)).toBe(false);
  });
});

describe("classifyStartupScreen anchors an ACTIVE operator pane as ACTIVE (false-positive fix)", () => {
  // (b) An active leader/CTO pane — input box + spinner + 'esc to interrupt' + ordinary tool
  // output that INCIDENTALLY contains a numbered list and the words 'proceed'/'yes' — classifies
  // ACTIVE (genuinely past startup), the dedicated kind that ends the poll. (Pre-2026-06-20 this
  // was folded into `quiet`; the active/quiet split is the dev-channels-give-up fix — a BLANK
  // pane is now `quiet` and keeps polling, while only a live session is `active` and stops it.)
  test("(b) active pane with incidental numbered list + 'proceed'/'yes' classifies ACTIVE", () => {
    expect(classifyStartupScreen(ACTIVE_PANE_WITH_INCIDENTAL_PROMPTY_OUTPUT).kind).toBe("active");
    // Bare active footer alone is also active.
    expect(classifyStartupScreen(ACTIVE_TURN_FOOTER).kind).toBe("active");
  });

  // (b) Through the poll loop: a normal working pane sends NO keystroke, sets NO stuckScreen,
  // and logs NO 'not auto-confirmable' line (it must not burn budget flagging a live agent).
  test("(b) autoConfirmStartupPrompts is a strict no-op on an active operator pane", async () => {
    const sent: SendInput[] = [];
    const logs: string[] = [];
    const result = await autoConfirmStartupPrompts("agent-active", {
      read: async () => ACTIVE_PANE_WITH_INCIDENTAL_PROMPTY_OUTPUT,
      send: async (_n, input) => { sent.push(input); },
      sleep: noSleep,
      pollMs: 0,
      maxPolls: 8,
      quietPolls: 2,
      log: (m) => logs.push(m),
    });
    expect(sent).toEqual([]); // no keystroke into a working pane
    expect(result.answered).toEqual([]);
    expect(result.stuckScreen).toBeUndefined(); // no last_error / stuckScreen surfaced
    expect(logs.some((m) => /not auto-confirmable/i.test(m))).toBe(false);
  });

  // (c) The genuine dialogs STILL classify as a rule and STILL auto-confirm — the rule path is
  // matched BEFORE the active-session guard, so the legit st-a57a552e purpose is preserved.
  test("(c) a real dev-channels consent dialog STILL classifies as a rule and confirms", async () => {
    const devChannels =
      "WARNING: Loading development channels\n❯ 1. I am using this for local development\n" +
      "  2. Exit\n  Enter to confirm · Esc to cancel";
    const cls = classifyStartupScreen(devChannels);
    expect(cls.kind).toBe("rule");
    if (cls.kind === "rule") expect(cls.rule.name).toBe("dev-channels-consent");

    const sent: Array<{ name: string; input: SendInput }> = [];
    const screens = [devChannels, "● ready — awaiting your prompt", "● ready — awaiting your prompt"];
    let i = 0;
    const result = await autoConfirmStartupPrompts("agent-devc", {
      read: async () => screens[Math.min(i++, screens.length - 1)]!,
      send: async (name, input) => { sent.push({ name, input }); },
      sleep: noSleep,
      pollMs: 0,
      maxPolls: 10,
      quietPolls: 2,
    });
    expect(result.answered).toEqual(["dev-channels-consent"]);
    expect(sent.map((s) => s.input)).toEqual([{ text: "1", enter: true }]);
  });

  // (c) A folder-trust dialog also stays a rule (auto-confirm), unaffected by the active-session guard.
  test("(c) a real folder-trust dialog STILL classifies as a rule and confirms", () => {
    const cls = classifyStartupScreen(
      "Do you trust the files in this folder?\n❯ 1. Yes, proceed\n  2. No\n  Enter to confirm · Esc to cancel",
    );
    expect(cls.kind).toBe("rule");
    if (cls.kind === "rule") expect(cls.rule.name).toBe("folder-trust");
  });
});

// ── DEV-CHANNELS GIVE-UP-BEFORE-RENDER fix (story st-2ef28e4f) ────────────────────────────────
// THE BUG (proven live 2026-06-20: 4 leaders launched at once, all 4 hung): a leader/CTO launch
// takes ~3-5s to load channels and RENDER the `--dangerously-load-development-channels` consent
// dialog. The pane reads BLANK during that window. The old loop folded a blank pane into `quiet`
// and concluded "past startup → done" after `quietPolls` reads — giving up BEFORE the dialog
// rendered, so it appeared later with nobody polling and the operator hung forever. The fix: only
// a genuinely ACTIVE pane (the live `esc to interrupt` UI) ends the poll; a BLANK pane keeps
// polling (up to maxPolls) so the dialog is still caught when it renders.
describe("auto-confirm does NOT give up during the BLANK pre-dialog window (st-2ef28e4f)", () => {
  const CONSENT =
    "WARNING: Loading development channels\n❯ 1. I am using this for local development\n  2. Exit";

  // (a) THE CORE REGRESSION: the pane is BLANK for FAR MORE polls than quietPolls, THEN the
  // dev-channels consent renders. The loop must STILL be polling (it did not give up in the blank
  // window) and must auto-confirm the dialog once it appears.
  test("(a) blank for the first N polls (N > quietPolls), then the dialog renders → STILL polling, auto-confirms it", async () => {
    // Five blank reads — well past quietPolls=2 — before the consent renders, then the live UI.
    const seq = ["", "", "", "", "", CONSENT, ACTIVE_TURN_FOOTER, ACTIVE_TURN_FOOTER, ACTIVE_TURN_FOOTER];
    let reads = 0;
    const sent: SendInput[] = [];
    const result = await autoConfirmStartupPrompts("agent-blank-then-dialog", {
      read: async () => seq[Math.min(reads++, seq.length - 1)]!,
      send: async (_n, input) => { sent.push(input); },
      sleep: noSleep,
      pollMs: 0,
      maxPolls: 30,
      quietPolls: 2,
    });
    // It polled THROUGH the blank window (>quietPolls reads) to reach the dialog at index 5 — the
    // old bug would have broken at poll 2 (blank==quiet==done) and NEVER reached the consent.
    expect(reads).toBeGreaterThan(2);
    // And it auto-confirmed the dialog once it rendered (exactly one option-1 keystroke).
    expect(result.answered).toEqual(["dev-channels-consent"]);
    expect(sent).toEqual([{ text: "1", enter: true }]);
    expect(result.stuckScreen).toBeUndefined();
  });

  // A pane that stays BLANK forever (the dialog never renders) must NOT be declared past-startup —
  // it keeps polling to maxPolls (sends nothing, reports no stuck). Cheap because it's fire-and-forget.
  test("(a') a pane that is blank for the WHOLE budget never breaks early (polls to maxPolls, sends nothing)", async () => {
    let reads = 0;
    const sent: SendInput[] = [];
    const result = await autoConfirmStartupPrompts("agent-blank-forever", {
      read: async () => { reads++; return ""; },
      send: async (_n, input) => { sent.push(input); },
      sleep: noSleep,
      pollMs: 0,
      maxPolls: 8,
      quietPolls: 2,
    });
    expect(reads).toBe(8); // never broke at quietPolls — polled the full budget waiting for the dialog
    expect(sent).toEqual([]);
    expect(result.answered).toEqual([]);
    expect(result.stuckScreen).toBeUndefined();
  });

  // (b) A pane that goes genuinely ACTIVE (no dialog) concludes within ~quietPolls active reads —
  // it does NOT poll forever / burn maxPolls now that blank no longer breaks the loop.
  test("(b) a genuinely ACTIVE pane concludes after exactly quietPolls reads (no maxPolls burn)", async () => {
    let reads = 0;
    const sent: SendInput[] = [];
    const result = await autoConfirmStartupPrompts("agent-active-only", {
      read: async () => { reads++; return ACTIVE_TURN_FOOTER; },
      send: async (_n, input) => { sent.push(input); },
      sleep: noSleep,
      pollMs: 0,
      maxPolls: 100,
      quietPolls: 3,
    });
    // Concluded at exactly quietPolls active reads — NOT maxPolls=100 (no infinite/over-long poll).
    expect(reads).toBe(3);
    expect(result.answered).toEqual([]);
    expect(result.stuckScreen).toBeUndefined();
    expect(sent).toEqual([]); // a live session is NEVER keystroked
  });

  // A blank stretch must RESET the active streak: active, active, blank, active, active needs a
  // FRESH quietPolls of consecutive active reads to conclude (a flicker can't prematurely finish).
  test("(b') a blank read between active reads resets the consecutive-active streak", async () => {
    // active, active, BLANK, active, active, active(stick) with quietPolls=3:
    // the streak resets at the blank, so it concludes only on the 3rd consecutive active AFTER it.
    const A = ACTIVE_TURN_FOOTER;
    const seq = [A, A, "", A, A, A, A];
    let reads = 0;
    const result = await autoConfirmStartupPrompts("agent-flicker", {
      read: async () => seq[Math.min(reads++, seq.length - 1)]!,
      send: async () => {},
      sleep: noSleep,
      pollMs: 0,
      maxPolls: 30,
      quietPolls: 3,
    });
    // Reads: A,A (streak 2), blank (reset 0), A,A,A (streak hits 3 → break) = 6 reads. Had the
    // blank NOT reset the streak, it would have broken at read 3 (2 pre-blank + 1 post).
    expect(reads).toBe(6);
    expect(result.answered).toEqual([]);
    expect(result.stuckScreen).toBeUndefined();
  });
});
