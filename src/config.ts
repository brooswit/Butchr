// Centralized configuration, all overridable via environment.
import { homedir } from "node:os";
import { join } from "node:path";

const home = homedir();

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

// Where butchr keeps its own state (the SQLite db). This is distinct from the
// per-directory `.butchr/` folders that live inside each registered repo.
const dataDir = env("BUTCHR_DATA_DIR", join(home, ".local", "share", "butchr"));

export const config = {
  /** HTTP host/port for the REST API + webapp. */
  host: env("BUTCHR_HOST", "127.0.0.1"),
  port: envInt("BUTCHR_PORT", 47800),

  /** butchr's own state directory + SQLite path. */
  dataDir,
  dbPath: env("BUTCHR_DB", join(dataDir, "butchr.db")),

  /** Path to the herdr binary. */
  herdrBin: env("BUTCHR_HERDR_BIN", "herdr"),

  /** Path to the git binary. */
  gitBin: env("BUTCHR_GIT_BIN", "git"),

  /** Dispatcher poll interval (ms). */
  tickMs: envInt("BUTCHR_TICK_MS", 1500),

  /**
   * Optional cap on the total number of simultaneously running tasks across all
   * directories. `0` (the default) means unlimited — every queued task is
   * dispatched immediately. If > 0, dispatch stops once that many tasks are
   * running and the rest stay queued until a slot frees.
   */
  maxConcurrent: envInt("BUTCHR_MAX_CONCURRENT", 0),

  /**
   * Command template run inside a task's worktree to execute the agent.
   * `{{PROMPT_FILE}}` is replaced with the absolute path to the rendered
   * prompt file. `{{CONTINUE}}` is replaced with `agentContinueArg` on a
   * re-run (a task that has already been started once in its worktree) and
   * with the empty string on the very first run. It is run via `bash -lc`,
   * in the worktree as cwd.
   *
   * Default: pipe the prompt into Claude Code in headless/print mode so the
   * agent runs to completion and exits (which herdr reports as `done`). On a
   * re-run `{{CONTINUE}}` becomes `--continue`, so the rejected task resumes
   * its previous session (which lives in the same worktree cwd) instead of
   * starting from a blank conversation. If that resume fails, butchr falls back
   * to running this same command with `{{CONTINUE}}` stripped (a fresh session)
   * — see the dispatcher.
   * Override BUTCHR_AGENT_CMD to use a different agent.
   */
  agentCmd: env(
    "BUTCHR_AGENT_CMD",
    'cat {{PROMPT_FILE}} | claude --dangerously-skip-permissions {{CONTINUE}} -p',
  ),

  /**
   * Substituted for `{{CONTINUE}}` in `agentCmd` when re-running a task that
   * has already been started once (e.g. after a rejection, or after butchr
   * restarted mid-run). Lets the agent resume its prior session rather than
   * launch a brand new one. If the resume attempt exits non-zero the dispatcher
   * retries the same command with `{{CONTINUE}}` empty, so a refused resume
   * degrades to a fresh run instead of failing the task. Set to the empty
   * string to always start fresh — e.g. for agents that have no resume flag.
   */
  agentContinueArg: env("BUTCHR_AGENT_CONTINUE_ARG", "--continue"),

  /** Max time (ms) a single watcher waits for the agent to finish. */
  agentTimeoutMs: envInt("BUTCHR_AGENT_TIMEOUT_MS", 1000 * 60 * 60),
};

export type Config = typeof config;
