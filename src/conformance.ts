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
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { getDirectory } from "./directories.ts";
import { publish } from "./events.ts";
import * as git from "./git.ts";
import { harness } from "./harness.ts";
// getTask / taskView are imported from tasks.ts; the reverse edge (tasks.ts importing
// triggerConformance) makes this a cycle, but every cross-reference here is used only
// INSIDE functions (call time), never at module-evaluation top level, so the cycle
// resolves cleanly under Bun's ESM loader — same pattern the rest of the tree relies on.
import { getTask, taskView } from "./tasks.ts";
import { readTaskMd } from "./taskmd.ts";

const confDir = join(config.dataDir, "conformance");

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
    "diff alone doesn't show, but base your verdict on whether the prompt was fulfilled.",
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
 * Extract the structured verdict from the reviewer's stdout. The reviewer is asked to
 * end with a single-line JSON object, but headless models wrap output in prose, so we
 * scan for the LAST `{...}` containing a "conforms" field and parse it. Returns NULL
 * if nothing parseable / valid is found (best-effort — caller leaves conformance NULL).
 */
export function parseConformanceVerdict(stdout: string): ConformanceResult | null {
  if (!stdout) return null;
  // Find candidate JSON objects mentioning "conforms"; prefer the last (the verdict
  // line the reviewer was told to put last). A non-greedy object match avoids
  // swallowing surrounding prose.
  const matches = stdout.match(/\{[^{}]*"conforms"[^{}]*\}/g);
  if (!matches) return null;
  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(matches[i]!) as { conforms?: unknown; reason?: unknown };
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
  const tmpl = config.conformanceCmd.trim();
  if (!tmpl) return null; // gate disabled

  mkdirSync(confDir, { recursive: true });
  const promptFile = join(confDir, `${input.taskId}.md`);
  writeFileSync(promptFile, buildReviewPrompt(input), "utf8");
  const cmd = tmpl.replaceAll("{{PROMPT_FILE}}", promptFile);

  // Run via the harness's headless backend (read-only, stdin ignored, SIGKILL on
  // timeout) so this agent-execution path goes through the same swappable seam as
  // the interactive agent. A timed-out / non-zero / unparseable run yields NULL.
  try {
    const r = await harness.runHeadless({
      cmd,
      cwd: input.cwd,
      timeoutMs: config.conformanceTimeoutMs,
    });
    if (!r.ok) return null;
    return parseConformanceVerdict(r.stdout);
  } finally {
    rmSync(promptFile, { force: true });
  }
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
  const dir = getDirectory(row.directory_id);
  if (!dir) return;
  const wt = git.worktreePath(dir.path, id);
  // Nothing to review/inspect — leave conformance unset rather than reviewing a tree
  // that isn't there (also keeps worktree-less seed rows from spawning a real claude).
  if (!existsSync(wt)) return;

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
  const status = result ? statusFor(result.conforms) : null;
  const summary = result ? (result.reason || (status === "pass" ? "conforms" : "")) : null;
  const res = db
    .query(
      `UPDATE tasks SET conformance_status=?, conformance_summary=? WHERE id=? AND status='in_review'`,
    )
    .run(status, summary, id);
  if (res.changes === 0) return;
  emitUpdated(id);
}
