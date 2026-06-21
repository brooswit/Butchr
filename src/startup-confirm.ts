// LAUNCH AUTO-CONFIRM for the managed CTO agent. Every per-workspace CTO (re)launch
// must come up READY unattended — but Claude Code (especially under the research-
// preview `--dangerously-load-development-channels` flag) can stop on a BLOCKING
// interactive startup prompt the first time a session touches a workspace:
//   - the dev-channels consent ("1. I am using this for local development"),
//   - the folder-TRUST prompt ("Do you trust the files in this folder?"),
//   - or any other yes/no / numbered-option confirmation.
// Left unanswered, the agent never reaches its prompt and the whole CTO is wedged on
// every (re)launch/reboot. This module DETECTS such a prompt in the live pane and
// sends the safe CONFIRMING response through the harness `send` capability, with a
// bounded poll/retry. It is GENERIC + EXTENSIBLE (a rule table, NOT two hardcoded
// exact strings) and IDEMPOTENT (it only ever sends while a prompt is actually on
// screen, and de-bounces the same contiguous prompt — so no stray keystroke leaks
// into the session once past the prompt).
import type { SendInput } from "./harness.ts";

/**
 * One confirm rule: when the live pane text matches `test`, `response` is the SAFE
 * confirming input to send. Ordered; the FIRST matching rule wins. The table is the
 * extension point — add a rule for a new prompt rather than hardcoding it inline.
 */
export type ConfirmRule = { name: string; test: RegExp; response: SendInput };

/**
 * The built-in confirm rules, most-specific first. Each `response` is the affirming
 * choice for a SAFE local-development launch: option `1` for the numbered consent /
 * trust menus (whose first option is the proceed/local-dev choice), or `y` for a
 * bare (y/n). Exported + mutable so a deployment/test can extend it.
 */
export const STARTUP_CONFIRM_RULES: ConfirmRule[] = [
  // Claude Code dev-channels consent (research preview): a numbered prompt whose
  // option 1 is "I am using this for local development".
  {
    name: "dev-channels-consent",
    test: /local development|development channel/i,
    response: { text: "1", enter: true },
  },
  // Folder-trust prompt: "Do you trust the files in this folder?" (and the
  // "trust this folder/workspace" variants) → option 1 ("Yes, proceed"). Anchored to the
  // actual trust phrasing — a bare "proceed?" is NOT a folder-trust dialog (it appears in
  // ordinary tool/agent output) and must never trigger an auto-confirm keystroke mid-session.
  {
    name: "folder-trust",
    test: /trust the files|do you trust|trust this (folder|workspace|directory)/i,
    response: { text: "1", enter: true },
  },
  // Generic numbered proceed/yes menu (e.g. "❯ 1. Yes" / "1. Continue").
  {
    name: "numbered-proceed",
    test: /(^|\n)\s*[❯>*]?\s*1\.\s*(yes|proceed|continue|i am|allow|trust)/i,
    response: { text: "1", enter: true },
  },
  // Generic (y/n) / (yes/no) confirmation.
  {
    name: "yes-no",
    test: /\(y\/n\)|\[y\/n\]|\(yes\/no\)|\[yes\/no\]/i,
    response: { text: "y", enter: true },
  },
  // A bare "Press Enter to confirm/continue" prompt with no numbered menu — the safe
  // affirming response is a lone Enter (no text). Lowest priority: only when none of
  // the more-specific menus above matched.
  {
    name: "enter-to-confirm",
    test: /press\s+enter\s+to\s+(confirm|continue|proceed)|enter\s+to\s+(confirm|continue)/i,
    response: { enter: true },
  },
];

/**
 * Pure: the first rule whose `test` matches the pane `screen`, or null when there is
 * no recognizable prompt (blank/whitespace screen → null). Exported so the detection
 * is unit-testable without a live pane.
 */
export function detectStartupPrompt(
  screen: string,
  rules: ConfirmRule[] = STARTUP_CONFIRM_RULES,
): ConfirmRule | null {
  if (!screen || !screen.trim()) return null;
  for (const r of rules) if (r.test.test(screen)) return r;
  return null;
}

/**
 * Pure heuristic: does `screen` LOOK like a blocking interactive prompt even though no
 * confirm RULE matched it? This is the safety net behind the rule table — Claude Code (or
 * any tool the agent shells into) can stop on a consent/menu we have not written a rule for
 * yet, and we must NOT mistake that frozen prompt for a quiet, past-startup pane.
 *
 * Returns true ONLY on the tell-tale shapes of a GENUINE blocking dialog: a `(y/n)`/`[y/n]`
 * confirmation, an "Enter to confirm/continue/proceed" line, the dev-channels consent banner
 * (and its "I am using this for local development" option line), a folder-trust dialog phrasing,
 * or a numbered options menu (two+ consecutive `1.`/`2.` choices). It must NOT fire on benign
 * text: the bare `❯` selection cursor is REMOVED (Claude Code's normal input box shows ❯ at all
 * times, so it matched every active pane), and the over-broad `proceed?`, `do you want`, and
 * bare `press enter` signals are gone — a tool description or active-turn output that merely
 * contains those words is not a blocking dialog. Returns false for a blank/whitespace screen and
 * for ordinary running output (logs, spinners, test runs, the `raise` tool description).
 */
export function looksLikePrompt(screen: string): boolean {
  if (!screen || !screen.trim()) return false;
  const signals: RegExp[] = [
    /\(y\/n\)|\[y\/n\]|\(yes\/no\)|\[yes\/no\]/i, // bare yes/no confirmation
    /(press\s+enter\s+to|enter\s+to)\s+(confirm|continue|proceed)/i, // explicit enter-to-confirm (not a bare "press enter")
    /loading development channels/i, //             dev-channels consent banner
    /i am using this for local development/i, //     dev-channels consent option line
    /trust the files|do you trust|trust this (folder|workspace|directory)/i, // folder-trust dialog
  ];
  if (signals.some((re) => re.test(screen))) return true;
  // A numbered options menu: at least two consecutive numbered choices (1. … 2. …). A lone
  // "1." can appear in ordinary output, so require the second option to call it a menu.
  const opt1 = /(^|\n)\s*[❯>*]?\s*1\.\s+\S/.test(screen);
  const opt2 = /(^|\n)\s*[❯>*]?\s*2\.\s+\S/.test(screen);
  return opt1 && opt2;
}

/**
 * Pure POSITIVE anchor: does `screen` show the tell-tale of a LIVE, working Claude session
 * turn — as opposed to a frozen blocking startup dialog? An active turn renders the working
 * spinner with an "esc to interrupt" affordance in its status bar; a blocking dialog NEVER
 * shows it. Verified against a REAL operator pane (2026-06-19): an in-flight turn's footer is
 * `⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt`, an IDLE pane's footer is
 * `… (shift+tab to cycle) · ctrl+t to hide tasks · ← for agents` (no such phrase), and the
 * genuine dev-channels consent / folder-trust dialogs show `Enter to confirm · Esc to cancel`
 * (or nothing) — the literal `esc to interrupt` is absent from every blocking dialog and
 * present throughout an active turn, so it is clean on BOTH sides.
 *
 * This is the missing "active session ⇒ quiet" anchor: it lets `classifyStartupScreen` treat a
 * working operator pane as QUIET even when its scrolling output incidentally contains a numbered
 * list (`1.`/`2.`), the word "proceed", or yes/no-ish prose. It is intentionally anchored on the
 * spinner affordance and NOT on the bare `❯` input box — the `❯` (and even the word "Esc") also
 * appear in the genuine dev-channels dialog (`❯ 1. I am using this for local development` /
 * `Esc to cancel`), so a `❯` anchor would wrongly quiet a real dialog. Blank/whitespace → false.
 */
export function looksLikeActiveSession(screen: string): boolean {
  if (!screen || !screen.trim()) return false;
  return /esc to interrupt/i.test(screen);
}

/**
 * The FOUR-way classification of a startup pane — the fix for `detectStartupPrompt`'s
 * null-ambiguity (a clean screen and an unrecognized-but-blocking prompt both used to read as
 * null, so an unhandled consent dialog was miscounted as "quiet" and the launch proceeded
 * while the agent stayed frozen forever), plus the 2026-06-20 BLANK-vs-active split:
 *   - `rule`   → a known prompt we can auto-confirm (send `rule.response`);
 *   - `stuck`  → no rule matched but the screen LOOKS like a blocking prompt → surface it;
 *   - `active` → a live, working Claude session (the `esc to interrupt` UI) → GENUINELY past
 *                startup; this is the ONLY signal that means "the agent is up, stop polling";
 *   - `quiet`  → blank / whitespace / still-initializing / ordinary pre-dialog output. This is
 *                NOT past startup — during a leader/CTO launch claude takes several seconds to
 *                render the dev-channels consent dialog and the pane reads blank until it does.
 *
 * The `active`/`quiet` split is the dev-channels-give-up-before-render fix (st-2ef28e4f): the
 * old three-way folded a blank/initializing pane into `quiet`, and the loop concluded "quiet ⇒
 * past startup ⇒ stop" after a few reads — giving up BEFORE the consent dialog rendered, so the
 * operator hung forever. Only `active` now ends the poll; a blank pane keeps polling.
 */
export type StartupClassification =
  | { kind: "rule"; rule: ConfirmRule }
  | { kind: "stuck" }
  | { kind: "active" }
  | { kind: "quiet" };

/** Classify a startup `screen` into rule / stuck / active / quiet. Pure + unit-testable. */
export function classifyStartupScreen(
  screen: string,
  rules: ConfirmRule[] = STARTUP_CONFIRM_RULES,
): StartupClassification {
  const rule = detectStartupPrompt(screen, rules);
  if (rule) return { kind: "rule", rule };
  // POSITIVE active-session anchor: a live, working Claude turn is genuinely PAST startup even
  // when its streaming output incidentally looks prompt-ish. Checked AFTER the rules (so a
  // genuine dev-channels/folder-trust dialog is STILL detected + auto-confirmed — rule wins) but
  // BEFORE the loose `looksLikePrompt` heuristics (so an incidental numbered list / 'proceed' /
  // yes-no prose in active output is never misread as a stuck blocking prompt). This is the
  // 2026-06-19 false-positive fix: a leader mid-review burned the whole poll budget and spammed
  // 'not auto-confirmable' because there was no "active ⇒ done" anchor. Returning a DEDICATED
  // `active` kind (not `quiet`) is the 2026-06-20 fix: only an active pane means "past startup",
  // so the poll loop can keep polling a blank pane until the dev-channels dialog finally renders.
  if (looksLikeActiveSession(screen)) return { kind: "active" };
  if (looksLikePrompt(screen)) return { kind: "stuck" };
  return { kind: "quiet" };
}

/** Injectable seams for the poll loop (the harness/timer in production; fakes in tests). */
export type AutoConfirmDeps = {
  /** Read the agent's recent pane output. */
  read: (name: string) => Promise<string>;
  /** Push a confirming input to the agent's stdin. */
  send: (name: string, input: SendInput) => Promise<void>;
  /** Sleep between polls. */
  sleep: (ms: number) => Promise<void>;
  /** Poll cadence (ms). */
  pollMs: number;
  /** Hard cap on poll iterations. */
  maxPolls: number;
  /** Consecutive ACTIVE reads (the live `esc to interrupt` UI) that mean "the agent is past
   *  startup → stop". A BLANK / still-initializing pane does NOT count — the loop keeps polling
   *  it (the dev-channels dialog may still render) up to `maxPolls`. */
  quietPolls: number;
  /** Re-send the SAME persistent prompt after this many polls (our first send may
   *  not have registered). Default 4. */
  resendEvery?: number;
  /** Extra/overriding rule table (defaults to STARTUP_CONFIRM_RULES). */
  rules?: ConfirmRule[];
  /** Optional diagnostics sink. */
  log?: (msg: string) => void;
};

/**
 * The outcome of an auto-confirm run. `answered` is the ordered list of rule names confirmed
 * (for logging/tests). `stuckScreen` is set ONLY when the loop gave up with an unrecognized
 * prompt-like screen STILL showing (no rule matched but `looksLikePrompt` held through the
 * budget) — the captured pane text the caller surfaces to a human (via `setNeedsUserInput`).
 * When the pane went genuinely quiet, `stuckScreen` is absent.
 */
export type AutoConfirmResult = { answered: string[]; stuckScreen?: string };

/**
 * Poll the agent's live pane and auto-confirm blocking startup prompts until it is
 * prompt-free (`quietPolls` consecutive clean reads) or `maxPolls` is hit. Returns
 * `{ answered, stuckScreen? }`: the rules it confirmed, plus the still-showing screen if it
 * GAVE UP on an unrecognized but prompt-like pane (so a stuck agent becomes visible instead
 * of silently declared past-startup). Best-effort: a read/send error is swallowed and never
 * propagates — this must NEVER throw or fail a launch.
 *
 * Four-way per-poll via `classifyStartupScreen`:
 *   - `rule`   → send the safe response (de-bounced: sent once per contiguous prompt, re-sent
 *                only every `resendEvery` polls if it persists), reset the active counter;
 *   - `stuck`  → an unhandled blocking prompt: reset the active counter (NOT past startup) and
 *                remember the screen, but send nothing (no rule → no safe keystroke);
 *   - `active` → a live, working Claude UI: count toward `quietPolls`; break once we've seen
 *                `quietPolls` CONSECUTIVE active reads (genuinely past startup);
 *   - `quiet`  → a BLANK / still-initializing / pre-dialog pane: this is NOT past startup, so it
 *                does NOT advance the done-counter — reset it and keep polling (the dev-channels
 *                dialog may yet render) until `maxPolls`. This is the dev-channels-give-up fix
 *                (st-2ef28e4f): giving up on a blank pane left the operator frozen at the
 *                consent dialog that rendered seconds later with nobody polling.
 * If the loop ends while the last read was `stuck`, that screen is returned as `stuckScreen`.
 * Once the pane is prompt-free, nothing is sent — so no stray keystroke leaks into the session.
 */
export async function autoConfirmStartupPrompts(
  name: string,
  deps: AutoConfirmDeps,
): Promise<AutoConfirmResult> {
  const answered: string[] = [];
  const resendEvery = deps.resendEvery ?? 4;
  let lastRule: string | null = null;
  let sameCount = 0;
  let active = 0; // consecutive ACTIVE reads (the live `esc to interrupt` UI) → past startup
  // The most recent unrecognized prompt-like screen, or undefined after a rule/active/quiet read.
  let stuckScreen: string | undefined;

  for (let i = 0; i < deps.maxPolls; i++) {
    let screen = "";
    try {
      screen = await deps.read(name);
    } catch {
      screen = "";
    }
    const cls = classifyStartupScreen(screen, deps.rules);

    if (cls.kind === "active") {
      // A live, working Claude session → GENUINELY past startup. Count consecutive active reads;
      // once we have `quietPolls` of them the agent is up and we stop polling. An active pane is
      // a strict no-op (we never keystroke a working session).
      lastRule = null;
      sameCount = 0;
      stuckScreen = undefined; // a live session is not stuck
      if (++active >= deps.quietPolls) break; // past startup → done
      await deps.sleep(deps.pollMs);
      continue;
    }

    if (cls.kind === "quiet") {
      // A BLANK / still-initializing / pre-dialog pane: NOT past startup. Do NOT advance the
      // done-counter (the dev-channels-give-up bug: a blank pane was miscounted as past-startup
      // and the loop broke before the consent dialog rendered). Reset the active streak and keep
      // polling — the dialog may still appear — until `maxPolls`.
      active = 0;
      lastRule = null;
      sameCount = 0;
      stuckScreen = undefined; // a clean read means it is not stuck right now
      await deps.sleep(deps.pollMs);
      continue;
    }

    if (cls.kind === "stuck") {
      // An unhandled blocking prompt: it is NOT past startup, but we have no safe keystroke to
      // send. Capture it and keep polling — it may yet clear or be answered by a human.
      active = 0;
      lastRule = null;
      sameCount = 0;
      stuckScreen = screen;
      deps.log?.("startup prompt not auto-confirmable — flagging for user input");
      await deps.sleep(deps.pollMs);
      continue;
    }

    // cls.kind === "rule": a known prompt we can confirm.
    const rule = cls.rule;
    active = 0;
    stuckScreen = undefined;
    const isNew = rule.name !== lastRule;
    // Re-send a persisted prompt periodically in case the first keystroke was dropped.
    const resend = !isNew && ++sameCount >= resendEvery;
    if (isNew || resend) {
      sameCount = 0;
      try {
        await deps.send(name, rule.response);
        answered.push(rule.name);
        deps.log?.(`auto-confirmed startup prompt '${rule.name}'`);
      } catch {
        /* best-effort — a send to a dead pane is a no-op */
      }
    }
    lastRule = rule.name;
    await deps.sleep(deps.pollMs);
  }
  return stuckScreen === undefined ? { answered } : { answered, stuckScreen };
}
