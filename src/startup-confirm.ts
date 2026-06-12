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
  // Folder-trust prompt: "Do you trust the files in this folder?" → option 1
  // ("Yes, proceed").
  {
    name: "folder-trust",
    test: /trust the files|do you trust|proceed\?/i,
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
  /** Consecutive prompt-free reads that mean "the agent is past startup → stop". */
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
 * Poll the agent's live pane and auto-confirm blocking startup prompts until it is
 * prompt-free (`quietPolls` consecutive clean reads) or `maxPolls` is hit. Returns
 * the ordered list of rule names it confirmed (for logging/tests). Best-effort: a
 * read/send error is swallowed and never propagates — this must never fail a launch.
 *
 * Idempotency: a confirming input is sent ONLY while a prompt is actually detected,
 * and the same contiguous prompt is de-bounced (sent once, then re-sent only every
 * `resendEvery` polls if it persists). Once the pane is prompt-free, nothing is sent
 * — so no stray keystroke leaks into the session after startup.
 */
export async function autoConfirmStartupPrompts(
  name: string,
  deps: AutoConfirmDeps,
): Promise<string[]> {
  const answered: string[] = [];
  const resendEvery = deps.resendEvery ?? 4;
  let lastRule: string | null = null;
  let sameCount = 0;
  let quiet = 0;

  for (let i = 0; i < deps.maxPolls; i++) {
    let screen = "";
    try {
      screen = await deps.read(name);
    } catch {
      screen = "";
    }
    const rule = detectStartupPrompt(screen, deps.rules);

    if (!rule) {
      lastRule = null;
      sameCount = 0;
      if (++quiet >= deps.quietPolls) break; // past startup → done
      await deps.sleep(deps.pollMs);
      continue;
    }

    quiet = 0;
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
  return answered;
}
