// BRIEF → EXPAND. The webapp's low-effort new-task flow: the operator types a
// one-line IDEA, and this turns it into a PROPER, concrete, scoped task prompt —
// grounded in the target repo (its CONTRIBUTING.md / code) — which the
// webapp drops into the prompt textarea for the operator to review/edit before
// Create. The operator gives ideas, not full specs; this closes that gap.
//
// It REUSES the same headless, read-only, non-recursing claude the spec-conformance
// reviewer uses (config.expandBriefCmd mirrors config.conformanceCmd — `-p` headless,
// `--permission-mode dontAsk` + `--allowedTools "Read Grep Glob"`, NO --mcp-config /
// --dangerously-skip-permissions so it can inspect the worktree but never mutate it
// and can't recurse into butchr's own tools). The single `{{PROMPT_FILE}}`
// placeholder is replaced with a temp file holding the rendered expand prompt,
// avoiding any shell-escaping. Run via `bash -lc`, cwd = the target repo.
//
// Like the conformance gate, the runner is overridable in tests (setBriefExpander) so
// the route + parsing wiring is exercised without spawning a real claude. Unlike the
// gate this is NOT best-effort: a failure surfaces an error to the operator (who keeps
// their brief and can retry or write the prompt by hand).
import { config } from "./config.ts";
import { HttpError } from "./workspaces.ts";
import { runHeadlessWithPrompt } from "./headless.ts";

/** Everything the expander needs; passed to the (mockable) runner. */
export type BriefExpansionInput = {
  /** The operator's one-line idea. */
  brief: string;
  /** The target repo root, so the expander can Read/Grep its CONTRIBUTING.md / code. */
  cwd: string;
};

/**
 * Turns a one-line brief into a full task prompt. Returns the expanded prompt text,
 * or NULL when it couldn't produce one (spawn/timeout failure, non-zero exit, or empty
 * output). MUST NOT throw — expandBrief maps a NULL into a clean operator-facing error.
 */
export type BriefExpander = (input: BriefExpansionInput) => Promise<string | null>;

let briefExpander: BriefExpander = defaultBriefExpander;

/** Replace the brief expander (tests inject a fake to avoid spawning claude). */
export function setBriefExpander(r: BriefExpander): void {
  briefExpander = r;
}

// Sentinel markers the expander is told to wrap its output in, so we can pull the
// task prompt out of any surrounding prose a headless model emits.
const BEGIN = "<<<TASK_PROMPT>>>";
const END = "<<<END_TASK_PROMPT>>>";

/**
 * Render the prompt fed to the headless expander: the operator's brief plus
 * instructions to ground a concrete, scoped task prompt in the repo. Kept pure so it's
 * easy to reason about / reuse.
 */
export function buildExpandPrompt(brief: string): string {
  return [
    "You are helping an operator turn a one-line IDEA into a PROPER engineering task",
    "prompt for a coding agent that will work in THIS repository.",
    "",
    "First, GROUND yourself in the repo: use the Read / Grep / Glob tools to read its",
    "CONTRIBUTING.md and the relevant source files so the task prompt",
    "names real files, modules, and conventions that actually exist here. Do NOT invent",
    "files or APIs.",
    "",
    "Then write ONE task prompt that:",
    "  - is concrete and SCOPED — a single, reviewable unit of work, not a project;",
    "  - names the specific files/areas to change and any tests to add/update;",
    "  - respects the repo's existing conventions (read them, don't guess);",
    "  - states what 'done' looks like, but does NOT over-specify implementation",
    "    details the agent should decide.",
    "Write it in the imperative, addressed to the agent. Keep it tight — a few short",
    "paragraphs or a short bullet list, not an essay.",
    "",
    "=== THE OPERATOR'S IDEA ===",
    brief.trim(),
    "",
    "=== OUTPUT FORMAT ===",
    `Output ONLY the task prompt, wrapped EXACTLY between ${BEGIN} and ${END} on their`,
    "own lines, with nothing after the closing marker:",
    BEGIN,
    "<the task prompt>",
    END,
  ].join("\n");
}

/**
 * Pull the expanded task prompt out of the expander's stdout. Prefers the text between
 * the sentinel markers; falls back to the whole trimmed stdout when the markers are
 * absent (a model that ignored the wrapper still gives usable text). Returns NULL when
 * there's nothing usable.
 */
export function parseExpansion(stdout: string): string | null {
  if (!stdout) return null;
  const start = stdout.indexOf(BEGIN);
  const end = stdout.lastIndexOf(END);
  let text: string;
  if (start !== -1 && end !== -1 && end > start) {
    text = stdout.slice(start + BEGIN.length, end).trim();
  } else {
    text = stdout.trim();
  }
  return text.length ? text : null;
}

/**
 * The real expander: spawn the read-only headless claude (config.expandBriefCmd) in the
 * target repo, feed it the rendered expand prompt via a temp file (no shell-escaping),
 * and parse the task prompt out of its stdout. Bounded by config.expandBriefTimeoutMs —
 * a timed-out / non-zero / unparseable run yields NULL. Never throws.
 */
async function defaultBriefExpander(input: BriefExpansionInput): Promise<string | null> {
  const stdout = await runHeadlessWithPrompt({
    cmdTemplate: config.expandBriefCmd,
    subdir: "expand",
    fileBase: `${Date.now()}-${process.pid}.md`,
    promptText: buildExpandPrompt(input.brief),
    cwd: input.cwd,
    timeoutMs: config.expandBriefTimeoutMs,
  });
  if (stdout === null) return null;
  return parseExpansion(stdout);
}

/**
 * Expand a one-line brief into a full task prompt for the repo at `cwd`. Validates the
 * brief is non-empty, runs the active expander, and returns the expanded prompt text.
 * Throws HttpError(400) on a blank brief and HttpError(502) when the expander couldn't
 * produce a prompt (so the webapp can keep the brief + show a message).
 */
export async function expandBrief(brief: unknown, cwd: string): Promise<string> {
  const text = typeof brief === "string" ? brief.trim() : "";
  if (!text) throw new HttpError(400, "brief is required");

  let result: string | null;
  try {
    result = await briefExpander({ brief: text, cwd });
  } catch {
    result = null;
  }
  if (!result) {
    throw new HttpError(502, "couldn't expand the brief — leave it and try again, or write the prompt yourself");
  }
  return result;
}
