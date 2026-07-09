// The PURE half of the TASK view — the predicates and label formatters its panels read, with no
// opinion about how they are drawn. The same horizontal cut RFC §0.1 #5 made through `chips`,
// `swimlanes`, `projects`, `diff` and `metrics`, applied to the sixth and largest view.
//
// DOM-free OUTRIGHT: zero imports beyond types, and nothing here touches `document` even when
// called.
//
// >>> NOTHING IMPORTS THIS MODULE YET. IT IS THE 4d FOUNDATION, LANDED EARLY. <<<
// `public/views/task.js` still defines its own private copies of all six functions below, and it
// is the one the app runs. This file is a typed transcription of those copies, byte-for-byte in
// behaviour, so that views/task.tsx can import them instead of re-deriving them. Until 4d lands,
// the two ARE duplicates — if you fix a bug in one, fix it in the other, and prefer landing 4d.
//
// `rescueNote` IS ALSO A SOURCE-SCRAPE TARGET, AND THE SCRAPE IS STILL ARMED.
// `test/output-snapshot-retired.test.ts` reads `public/views/task.js` as TEXT, matches that file's
// copy with `/function rescueNote\(events, status\) \{[\s\S]*?\n\}/`, and `new Function()`s the
// captured string. It reads task.js, NOT this file, so this transcription cannot disturb it — but
// that is also why views/task.js must not be touched before 4d retires the harness. When 4d points
// the test at this module, the regex and the `new Function` go with it. RFC §9.4's rule — "do not
// reintroduce a sentinel" — generalises: do not reintroduce a scrape.
//
// (RFC §9.1's table of "3 coupled by other means" does not list `output-snapshot-retired`. It is a
// fourth.)

import type { TaskEvent, TaskView } from "../core/types.js";

/** The agent is live (attachable) whenever butchr owns a launched agent for it (`has_agent`): a
 *  running/idle `in_progress` build agent, until butchr tears it down. Gating on `has_agent`
 *  mirrors the `/terminal` endpoint exactly — the button shows iff the attach would succeed. */
export function isLive(t: Pick<TaskView, "has_agent">): boolean {
  return !!t.has_agent;
}

/** Does the captured pane (`needs_user_input_context`) look like the dev-channels consent /
 *  folder-trust / numbered-proceed prompt whose SAFE answer is option "1"? Mirrors the
 *  '1'-response rules in src/startup-confirm.ts, so the one-click Confirm button is offered ONLY
 *  where nudging "1" is the right move; any other prompt falls back to Open terminal. */
export function isOneKeyConfirmPrompt(ctx: string | null | undefined): boolean {
  if (!ctx) return false;
  return /local development|development channel|trust the files|do you trust|(^|\n)\s*[❯>*]?\s*1\.\s*(yes|proceed|continue|i am|allow|trust)/i.test(ctx);
}

/**
 * The RESCUE NOTE for a task butchr force-moved to review, or null.
 *
 * butchr stamps its reason ("[butchr] moved to review automatically: …") as the note of the
 * transition INTO `in_review` (tasks.markInReview); an agent that submitted normally leaves a
 * different note, so the prefix is what distinguishes a rescue. Only meaningful while the task
 * still sits in review — once it merges or is re-worked, the Timeline keeps the history and a
 * dedicated panel would be stale. Returns the LATEST such note (a task can be rescued,
 * re-dispatched, and rescued again).
 *
 * This is the FE half of story st-b8c9249e's "no visibility gap" property: `output_snapshot` is
 * retired, the agent's own output now comes from the on-disk transcript, and butchr's rescue words
 * — which the agent never wrote, so no transcript can carry them — live in `task_events.note` and
 * surface through this function.
 */
export function rescueNote(events: TaskEvent[] | null | undefined, status: string): string | null {
  if (status !== "in_review" || !Array.isArray(events)) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.to_status === "in_review" && typeof ev.note === "string") {
      return ev.note.startsWith("[butchr] moved to review automatically") ? ev.note : null;
    }
  }
  return null;
}

/** Human label for a task's model: the requested model, and (when known and different) the model it
 *  actually ran under per the session transcript. An unset request shows "default", annotated with
 *  what the default resolved to if captured. */
export function modelLabel(t: Pick<TaskView, "model" | "model_used">): string {
  const want = (t.model || "").trim();
  const used = (t.model_used || "").trim();
  if (want && used && want !== used) return `${want} (ran as ${used})`;
  if (want) return want;
  if (used) return `default (${used})`;
  return "default";
}

/** Cost label. The session transcript records tokens but no dollar cost and butchr has no pricing
 *  table, so we show "—" (not tracked) rather than fabricate a number. */
export function costLabel(t: Pick<TaskView, "cost_usd">): string {
  return typeof t.cost_usd === "number" ? `$${t.cost_usd.toFixed(4)}` : "— (not tracked)";
}

/** Whether any token usage has been recorded at all. Below the threshold the meta row reads "—". */
export function hasTokenUsage(t: TaskView): boolean {
  return [t.usage_input_tokens, t.usage_output_tokens, t.usage_cache_read_tokens, t.usage_cache_creation_tokens].some(
    (n) => typeof n === "number" && n > 0,
  );
}
