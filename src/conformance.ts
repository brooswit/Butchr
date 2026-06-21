// SPEC-CONFORMANCE REVIEW GATE. When a task enters `review`, butchr asynchronously
// runs a READ-ONLY reviewer that judges whether the task's DIFF actually SATISFIES
// its PROMPT — complete and on-spec — and writes an advisory badge
// (`conformance_status` / `conformance_summary`) for the review panel, so
// incomplete / off-spec work is flagged BEFORE a human reads the diff.
//
// WHY this exists alongside the CI gate: CI proves a task BUILDS and its tests pass;
// it does NOT prove the task did what was ASKED. We hit exactly that — a task
// reached review CI-green but was half-implemented, and only a manual diff-read
// caught it. This gate closes that hole with a second, orthogonal signal.
//
// It is modelled on the CI gate (tasks.triggerCi): fired on the genuine
// running→review transition, fire-and-forget (review never blocks on it), advisory
// (it NEVER hard-blocks approval — mirrors the CI-fail warning), and best-effort
// (NULL when it can't run or its verdict can't be parsed). The reviewer runs a
// headless, read-only, non-recursing claude (config.conformanceCmd, run via
// `bash -lc` in the task's worktree with only Read/Grep/Glob — see config.ts). The
// runner is overridable in tests (setConformanceRunner) so the persistence + trigger
// wiring is exercised without spawning a real claude.
import { existsSync } from "node:fs";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { getWorkspace } from "./workspaces.ts";
import { publish } from "./events.ts";
import { makeGateLiveness, settleGate } from "./gate.ts";
import * as git from "./git.ts";
import { runHeadlessWithPrompt } from "./headless.ts";
// getTask / taskView are imported from tasks.ts; the reverse edge (tasks.ts importing
// triggerConformance) makes this a cycle, but every cross-reference here is used only
// INSIDE functions (call time), never at module-evaluation top level, so the cycle
// resolves cleanly under Bun's ESM loader — same pattern the rest of the tree relies on.
import { getTask, taskView } from "./tasks.ts";
import { readTaskMd } from "./taskmd.ts";

/** The reviewer's verdict on whether a diff satisfies its prompt. */
export type ConformanceVerdict = "yes" | "partial" | "no";

/** Structured result of one conformance review: a verdict plus a short reason. */
export type ConformanceResult = {
  conforms: ConformanceVerdict;
  /** One or two sentences naming any missing / incomplete / off-spec parts (may be empty on "yes"). */
  reason: string;
};

/** Everything the reviewer needs to judge a task; passed to the (mockable) runner. */
export type ConformanceInput = {
  taskId: string;
  /** The task's worktree, so the reviewer can Read/Grep beyond the diff. */
  cwd: string;
  /** The task's PROMPT (what was asked). */
  prompt: string;
  /** The task's git diff vs the default branch (already capped to a byte budget). */
  diff: string;
  /** The agent's optional request_review summary (what it claims it did). */
  summary: string;
};

/**
 * Runs one conformance review for a task and returns the structured verdict, or NULL
 * when it couldn't produce one (gate disabled, spawn/timeout failure, or an
 * unparseable answer). MUST NOT throw — best-effort by contract.
 */
export type ConformanceRunner = (input: ConformanceInput) => Promise<ConformanceResult | null>;

let conformanceRunner: ConformanceRunner = defaultConformanceRunner;

// Liveness for the conformance gate: which task ids have a reviewer IN FLIGHT in THIS
// butchr process right now. The reviewer runs in-process (triggerConformance awaits the
// runner), so a butchr restart kills it AND empties this set — which is exactly what makes
// a DB conformance_status='checking' with no entry here PROVABLY stale (its reviewer died
// with the process). recoverStuckGates keys off this to re-trigger only genuinely-dead
// gates, never one still legitimately running. Marked synchronously before the 'checking'
// write; cleared in a finally. Same makeGateLiveness primitive the CI gate uses. See
// tasks.recoverStuckGates.
const conformanceLiveness = makeGateLiveness();

/** Is this task's conformance reviewer running in THIS process right now? */
export function conformanceGateInFlight(id: string): boolean {
  return conformanceLiveness.isLive(id);
}

/** Replace the conformance runner (tests inject a fake to avoid spawning claude). */
export function setConformanceRunner(r: ConformanceRunner): void {
  conformanceRunner = r;
}

function emitUpdated(id: string): void {
  const v = taskView(id);
  if (v) publish({ type: "task.updated", task: v });
}

/** Cap the diff fed to the reviewer to a byte budget, appending a truncation marker. */
function capDiff(diff: string, maxBytes: number): string {
  if (diff.length <= maxBytes) return diff;
  return (
    diff.slice(0, maxBytes) +
    `\n\n[… diff truncated at ${maxBytes} bytes — inspect the worktree with Read/Grep for the rest …]`
  );
}

/**
 * Render the review prompt the headless reviewer is fed: the task prompt, the agent's
 * summary, and the (capped) diff, plus an instruction to emit a single-line JSON
 * verdict. Kept pure so it's easy to reason about / reuse.
 */
export function buildReviewPrompt(input: ConformanceInput): string {
  const summary = input.summary.trim();
  return [
    "You are a STRICT spec-conformance reviewer. Judge ONLY whether the code change",
    "below actually SATISFIES the task it was given — i.e. it is COMPLETE and ON-SPEC,",
    "implementing everything the task prompt asked for. You are NOT judging code style,",
    "build success, or test results (a separate gate covers those).",
    "",
    "You may use the Read / Grep / Glob tools to inspect the worktree for context the",
    "diff alone doesn't show — including CONTRIBUTING.md (the project's living doc of",
    "conventions and public surfaces) and the surrounding source — but base your verdict",
    "on whether the prompt was fulfilled.",
    "",
    "=== TASK PROMPT (what was asked) ===",
    input.prompt.trim() || "(empty)",
    "",
    "=== AGENT SUMMARY (what the agent claims it did) ===",
    summary || "(none provided)",
    "",
    "=== GIT DIFF (the change) ===",
    input.diff.trim() || "(empty diff)",
    "",
    "=== YOUR VERDICT ===",
    "Respond with a one-line JSON object as the LAST line of your output, nothing after it:",
    '{"conforms": "yes" | "partial" | "no", "reason": "<short reason>"}',
    '  - "yes": the change fully and correctly implements what the prompt asked for.',
    '  - "partial": it implements some of it but leaves required parts missing,',
    "    incomplete, stubbed, or off-spec — name them in the reason.",
    '  - "no": it does not do what was asked.',
    'For "partial"/"no", the reason MUST name the specific missing / incomplete / off-spec',
    'part(s), in one or two sentences. For "yes" the reason may be empty.',
  ].join("\n");
}

const VALID: ReadonlySet<string> = new Set(["yes", "partial", "no"]);

/**
 * Scan stdout for every top-level balanced `{...}` object and return their substrings,
 * in source order. STRING-AWARE: braces inside a JSON string literal (delimited by `"`,
 * honoring `\` escapes) are NOT counted toward brace balance, so an object whose value
 * quotes code — e.g. `{"reason":"... returns {} ..."}` or even an UNBALANCED brace inside
 * the string (`"returns { instead"`) — is captured whole instead of being split. A naive
 * brace counter would mishandle exactly those, which is the bug this fixes.
 */
function balancedObjects(stdout: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let escaped = false;
  for (let i = 0; i < stdout.length; i++) {
    const ch = stdout[i]!;
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          out.push(stdout.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return out;
}

/**
 * Extract the structured verdict from the reviewer's stdout. The reviewer is asked to
 * end with a single-line JSON object, but headless models wrap output in prose, so we
 * scan for the LAST balanced `{...}` that JSON-parses to an object with a valid "conforms"
 * field and use it. Parsing the JSON properly (rather than a brace-free regex) means a
 * verdict whose `reason` quotes braces/code is captured, not silently dropped. Returns
 * NULL if nothing parseable / valid is found (best-effort — caller leaves conformance
 * NULL). Never throws.
 */
export function parseConformanceVerdict(stdout: string): ConformanceResult | null {
  if (!stdout) return null;
  // Candidate JSON objects, in source order; prefer the LAST valid one (the verdict line
  // the reviewer was told to put last). The format-example line in the prompt echo
  // (`{"conforms": "yes" | "partial" | "no", ...}`) is not valid JSON, so JSON.parse
  // rejects it naturally.
  const candidates = balancedObjects(stdout);
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(candidates[i]!) as { conforms?: unknown; reason?: unknown };
      const conforms = String(obj.conforms ?? "").toLowerCase();
      if (!VALID.has(conforms)) continue;
      const reason = typeof obj.reason === "string" ? obj.reason.trim() : "";
      return { conforms: conforms as ConformanceVerdict, reason };
    } catch {
      // not valid JSON — keep scanning earlier candidates
    }
  }
  return null;
}

/**
 * The real conformance runner: spawn the read-only headless claude (config.conformanceCmd)
 * in the task's worktree, feed it the rendered review prompt via a temp file (no
 * shell-escaping), and parse its verdict. Bounded by config.conformanceTimeoutMs — a
 * timed-out / non-zero / unparseable run yields NULL (best-effort). Never throws.
 */
async function defaultConformanceRunner(input: ConformanceInput): Promise<ConformanceResult | null> {
  const stdout = await runHeadlessWithPrompt({
    cmdTemplate: config.conformanceCmd,
    subdir: "conformance",
    fileBase: `${input.taskId}.md`,
    promptText: buildReviewPrompt(input),
    cwd: input.cwd,
    timeoutMs: config.conformanceTimeoutMs,
  });
  if (stdout === null) return null;
  return parseConformanceVerdict(stdout);
}

/** Run the active runner once, converting any throw into NULL (best-effort). */
async function runConformanceOnce(input: ConformanceInput): Promise<ConformanceResult | null> {
  try {
    return await conformanceRunner(input);
  } catch {
    return null;
  }
}

/** Map a verdict to the persisted status: "yes" → pass, otherwise → concern. */
function statusFor(v: ConformanceVerdict): "pass" | "concern" {
  return v === "yes" ? "pass" : "concern";
}

/**
 * Run the SPEC-CONFORMANCE gate for a task that just entered `review`: flip
 * conformance_status to 'checking' (emit so the webapp shows a spinner), run the
 * read-only reviewer over the task's prompt + diff (+ agent summary), then persist
 * the verdict as 'pass' (conforms) or 'concern' (partial/off-spec) with a short
 * reason — or back to NULL when the reviewer couldn't produce a verdict (best-effort).
 * Never throws. Skips entirely (leaving conformance_status NULL) when the task has no
 * worktree to inspect — mirroring the CI gate's worktree guard.
 *
 * Bounded cost: ONE reviewer pass (no retries), with the diff capped to
 * config.conformanceMaxDiffBytes before it's sent.
 */
export async function triggerConformance(id: string): Promise<void> {
  const row = getTask(id);
  if (!row) return;
  const dir = getWorkspace(row.workspace_id);
  if (!dir) return;
  const wt = git.worktreePath(dir.path, id);
  // Nothing to review/inspect — leave conformance unset rather than reviewing a tree
  // that isn't there (also keeps worktree-less seed rows from spawning a real claude).
  if (!existsSync(wt)) return;

  // Mark the reviewer IN FLIGHT in this process (synchronously, before the 'checking'
  // write) so a concurrent recovery sweep sees it's genuinely running here and won't
  // re-trigger it; cleared in the finally below when this process is done with it.
  conformanceLiveness.mark(id);
  try {
    // Flip to 'checking' SYNCHRONOUSLY — before any await — so a still-in-flight review
    // is visible (spinner) the instant the fire-and-forget call's sync prefix runs, and
    // so the gate has claimed the task before we gather the (async) diff.
    db.query(
      `UPDATE tasks SET conformance_status='checking', conformance_summary=NULL WHERE id=?`,
    ).run(id);
    emitUpdated(id);

    // Read the task's prompt from its on-disk task.md (the authoritative source).
    let prompt = "";
    try {
      prompt = readTaskMd(dir.path, id).prompt;
    } catch {
      /* best-effort — an empty prompt still lets the reviewer judge against the diff */
    }
    // The diff (capped). On a git error, treat as empty — the reviewer can still inspect.
    let rawDiff = "";
    try {
      rawDiff = await git.diff(dir.path, id);
    } catch {
      /* ignore — fall back to an empty diff */
    }
    const diff = capDiff(rawDiff, config.conformanceMaxDiffBytes);

    const result = await runConformanceOnce({
      taskId: id,
      cwd: wt,
      prompt,
      diff,
      summary: row.summary ?? "",
    });

    // Map the verdict (or NULL) to the persisted badge. NULL → conformance back to NULL
    // (couldn't run / parse). Only write back while the task is STILL in review — if it
    // merged/aborted while the reviewer ran, don't resurrect stale conformance onto it.
    // A real settle also resets gate_recovery_attempts (the restart-recovery streak) to
    // 0 — see tasks.recoverStuckGates / config.maxGateRecoveryAttempts.
    const status = result ? statusFor(result.conforms) : null;
    const summary = result ? (result.reason || (status === "pass" ? "conforms" : "")) : null;
    // BIND a real verdict to the tip it ran against (sibling of the CI gate's ci_tip), so a
    // stale verdict can't survive a tip change. A null verdict (couldn't run) binds no tip.
    const conformance_tip = status ? await git.headSha(wt).catch(() => null) : null;
    // Settle via the shared gate write (same primitive as the CI gate): persist the badge
    // + reset gate_recovery_attempts, guarded on the task still being in_review.
    if (!settleGate(id, { conformance_status: status, conformance_summary: summary, conformance_tip })) return;
    emitUpdated(id);
  } finally {
    conformanceLiveness.clear(id);
  }
}
