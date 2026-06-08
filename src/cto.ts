// askCto: run a forked, headless, READ-ONLY Claude session in a task's worktree
// to answer an engineer-agent's clarifying question with the CTO's context. The
// answer (the CTO Claude's stdout) is returned as plain text.
//
// This is invoked from the `ask` MCP tool (see src/mcp.ts). Two non-negotiables,
// both enforced by config.ctoCmd's flags (NOT here):
//  - read-only: the CTO cannot edit files (plan mode + disallowed edit tools).
//  - no recursion: the CTO has no --mcp-config, so it can't call ask/request_review.
//
// We spawn directly via Bun.spawn (rather than exec.ts' run()) because we need to
// KILL the child on timeout — run() awaits exit with no escape hatch.
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";

const askDir = join(config.dataDir, "ask");
mkdirSync(askDir, { recursive: true });

export type AskCtoOpts = {
  /** Worktree to run in, so the CTO can READ the code under discussion. */
  cwd: string;
  /** Asking task's id — used only to name the temp question file. */
  taskId: string;
};

/**
 * Ask the CTO a question. Resolves to the CTO's text answer, or a short
 * human-readable error string on timeout/failure (never throws — the caller
 * wraps the result as an MCP tool result and must not crash the server).
 */
export async function askCto(question: string, opts: AskCtoOpts): Promise<string> {
  const q = (question ?? "").trim();
  if (!q) return "No question was provided.";

  // Write the question to a temp file so we never have to shell-escape it.
  const questionFile = join(askDir, `${opts.taskId}.q.md`);
  writeFileSync(questionFile, q, "utf8");

  const session = config.ctoSessionId
    ? `--resume ${config.ctoSessionId} --fork-session`
    : "";
  const cmd = config.ctoCmd
    .replaceAll("{{QUESTION_FILE}}", questionFile)
    .replaceAll("{{CTO_SESSION}}", session);

  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    proc = Bun.spawn(["bash", "-lc", cmd], {
      cwd: opts.cwd,
      stdout: "pipe",
      stderr: "pipe",
      // The CTO reads context but must never block on stdin.
      stdin: "ignore",
    });

    const child = proc;
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, config.askTimeoutMs);

    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    if (timedOut) {
      return `CTO did not respond in time (timeout after ${config.askTimeoutMs}ms).`;
    }
    if (code !== 0) {
      const detail = (stderr || stdout).trim().slice(0, 500);
      return `CTO could not answer (exit ${code})${detail ? `: ${detail}` : "."}`;
    }
    const answer = stdout.trim();
    return answer || "The CTO returned an empty answer.";
  } catch (err) {
    return `Failed to consult the CTO: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    if (timer) clearTimeout(timer);
    rmSync(questionFile, { force: true });
  }
}
