// Shared scaffold for the HEADLESS, read-only, tempfile-prompt agent runners — the
// spec-conformance reviewer (src/conformance.ts) and the brief expander (src/expand.ts).
// Both follow the identical
// recipe: bail when the command template is empty (gate disabled), write the rendered
// prompt to a temp file under `<dataDir>/<subdir>/` (so the agent reads it via
// `$(cat …)` with no shell-escaping), substitute `{{PROMPT_FILE}}` (plus any
// caller-specific placeholders) into the command, run it through the harness's headless
// backend bounded by a timeout, and clean the temp file up on the way out — returning
// the run's stdout for the caller to parse, or NULL when it couldn't produce one.
//
// This owns ONLY that shared mechanics; each caller keeps its own prompt builder and
// stdout parser. Extracting it removes three byte-for-byte copies of the scaffold (and
// their hand-declared `<x>Dir = join(dataDir,"<sub>")` constants).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { harness } from "./harness.ts";

/** Inputs for one headless tempfile-prompt run — see runHeadlessWithPrompt. */
export type RunHeadlessWithPromptArgs = {
  /** The command template (e.g. config.conformanceCmd). Trimmed; empty → disabled (NULL). */
  cmdTemplate: string;
  /** Subdirectory of config.dataDir the temp prompt file is written under. */
  subdir: string;
  /** File name for the temp prompt file inside `<dataDir>/<subdir>/`. */
  fileBase: string;
  /** The fully-rendered prompt text written to the temp file. */
  promptText: string;
  /** Working directory for the headless run (the task's worktree / target repo). */
  cwd: string;
  /** Wall-clock bound (ms) passed to the headless backend. */
  timeoutMs: number;
  /**
   * Extra placeholder → value substitutions applied to the command BEFORE
   * `{{PROMPT_FILE}}` (for command templates that carry their own placeholders).
   */
  extraVars?: Record<string, string>;
};

/**
 * Run one headless, read-only agent invocation whose prompt is delivered via a temp
 * file. Owns the shared scaffold (empty-cmd bail, mkdir, write, placeholder
 * substitution, the timed headless run, the ok-guard, and temp-file cleanup in a
 * `finally` so a throw still cleans up) and returns the run's stdout, or NULL when the
 * command template is empty (gate disabled) or the run exited non-zero / couldn't run.
 * The caller parses the returned stdout itself. Never throws beyond what the harness
 * backend surfaces.
 */
export async function runHeadlessWithPrompt(args: RunHeadlessWithPromptArgs): Promise<string | null> {
  const tmpl = args.cmdTemplate.trim();
  if (!tmpl) return null; // gate disabled

  const dir = join(config.dataDir, args.subdir);
  mkdirSync(dir, { recursive: true });
  const promptFile = join(dir, args.fileBase);
  writeFileSync(promptFile, args.promptText, "utf8");

  let cmd = tmpl;
  if (args.extraVars) {
    for (const [placeholder, value] of Object.entries(args.extraVars)) {
      cmd = cmd.replaceAll(placeholder, value);
    }
  }
  cmd = cmd.replaceAll("{{PROMPT_FILE}}", promptFile);

  // Run via the harness's headless backend (read-only, stdin ignored, SIGKILL on
  // timeout) so this agent-execution path goes through the same swappable seam as
  // the interactive agent. A timed-out / non-zero / errored run yields NULL.
  try {
    const r = await harness.runHeadless({ cmd, cwd: args.cwd, timeoutMs: args.timeoutMs });
    if (!r.ok) return null;
    return r.stdout;
  } finally {
    rmSync(promptFile, { force: true });
  }
}
