// CTO-FORK SPEC GENERATOR. The unified pipeline's front state is `idea`: a task created
// from a one-line operator brief with no spec yet. Its "dispatch" is NOT a build agent —
// the dispatcher calls generateSpec() here to turn the brief into a detailed, repo-grounded
// SPEC, then advances the task to `queued` ('ready') carrying that spec as its prompt.
//
// This REVIVES the retired CTO-fork mechanism (the human-ask change retired the old CTO
// auto-answer): a forked, headless, READ-ONLY claude session that writes the spec WITH the
// CTO's accumulated context (when config.ctoSessionId is set, `--resume <id> --fork-session`)
// but never mutates the real session or any file. Two non-negotiables, both enforced by
// config.specGenCmd's flags (NOT here):
//  - read-only: only Read/Grep/Glob are allowed (no Write/Edit/Bash) — it inspects the repo
//    but can't change it.
//  - no recursion: no --mcp-config, so it can't call butchr's own ask/request_review tools.
//
// We REUSE src/expand.ts's brief→prompt grounding prompt (buildExpandPrompt) and output
// parser (parseExpansion): generating a spec from a brief is exactly what the webapp's
// "Expand" flow already does, just driven by the dispatcher and forking the CTO session.
//
// We spawn directly via Bun.spawn (rather than exec.ts' run()) so we can KILL the child on
// timeout. The runner is overridable in tests (setSpecWriter) so the idea→ready path is
// exercised without spawning a real claude.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { buildExpandPrompt, parseExpansion } from "./expand.ts";

const specDir = join(config.dataDir, "spec");

/** Everything the spec writer needs; passed to the (mockable) runner. */
export type SpecGenInput = {
  /** The operator's one-line idea/brief (the idea task's initial prompt). */
  brief: string;
  /** The task's worktree, so the spec writer can Read/Grep the repo for grounding. */
  cwd: string;
  /** The idea task's id — used only to name the temp prompt file. */
  taskId: string;
  /**
   * REVISION notes from the operator (spec_review → request_changes). When present the
   * generator is told to REVISE its prior spec to address them, rather than write a
   * fresh one. Absent on the first generation.
   */
  notes?: string;
};

/**
 * Turn a one-line brief into a full SPEC (a concrete, repo-grounded task prompt for the
 * build agent). Returns the spec text, or NULL when it couldn't produce one (spawn/timeout
 * failure, non-zero exit, empty/unparseable output, or generation disabled). MUST NOT throw.
 */
export type SpecWriter = (input: SpecGenInput) => Promise<string | null>;

let specWriter: SpecWriter = defaultSpecWriter;

/** Replace the spec writer (tests inject a fake to avoid spawning claude). */
export function setSpecWriter(w: SpecWriter): void {
  specWriter = w;
}

/**
 * Resolve the `{{CTO_SESSION}}` flag for the spec command: fork the CTO's session when a
 * ctoSessionId is configured (so the spec inherits the CTO's context without mutating the
 * real session), or nothing for a fresh read-only session. Pure + exported for testing.
 */
export function ctoSessionFlag(sessionId: string): string {
  const id = (sessionId ?? "").trim();
  return id ? `--resume ${id} --fork-session` : "";
}

/**
 * The real spec writer: spawn the forked, read-only headless claude (config.specGenCmd)
 * in the idea task's worktree, feed it the rendered spec-writing prompt via a temp file
 * (no shell-escaping), and parse the spec out of its stdout. Bounded by
 * config.specGenTimeoutMs — a timed-out / non-zero / unparseable run yields NULL. Never throws.
 */
async function defaultSpecWriter(input: SpecGenInput): Promise<string | null> {
  const tmpl = config.specGenCmd.trim();
  if (!tmpl) return null; // spec generation disabled

  mkdirSync(specDir, { recursive: true });
  const promptFile = join(specDir, `${input.taskId}.md`);
  // On a REVISE round, append the operator's change requests so the regenerated spec
  // addresses them (the base brief grounds the spec; the notes steer the revision).
  let prompt = buildExpandPrompt(input.brief);
  if (input.notes && input.notes.trim()) {
    prompt +=
      `\n\n=== SPEC CHANGES REQUESTED BY THE OPERATOR ===\n` +
      `Your previous spec was reviewed and changes were requested. REVISE the spec to ` +
      `address the following, keeping everything else that was correct:\n\n` +
      input.notes.trim();
  }
  writeFileSync(promptFile, prompt, "utf8");
  const cmd = tmpl
    .replaceAll("{{CTO_SESSION}}", ctoSessionFlag(config.ctoSessionId))
    .replaceAll("{{PROMPT_FILE}}", promptFile);

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const proc = Bun.spawn(["bash", "-lc", cmd], {
      cwd: input.cwd,
      stdout: "pipe",
      stderr: "pipe",
      // The spec writer reads context but must never block on stdin.
      stdin: "ignore",
    });
    timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, config.specGenTimeoutMs);

    const [stdout, , code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (timedOut || code !== 0) return null;
    return parseExpansion(stdout);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    rmSync(promptFile, { force: true });
  }
}

/**
 * Generate a spec for an idea task's brief. Thin wrapper over the active spec writer that
 * guards a blank brief and never throws (the dispatcher treats a NULL as a generation
 * failure → backoff/retry, then give-up to `failed` after the cap). See dispatcher.
 */
export async function generateSpec(input: SpecGenInput): Promise<string | null> {
  if (!input.brief || !input.brief.trim()) return null;
  try {
    return await specWriter(input);
  } catch {
    return null;
  }
}
