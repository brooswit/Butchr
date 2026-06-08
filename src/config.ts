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
   * Placeholders, both replaced by the dispatcher:
   *  - `{{PROMPT_FILE}}` → absolute path to the rendered prompt file.
   *  - `{{MCP_CONFIG}}`  → absolute path to the per-task MCP config JSON that
   *    points the agent at butchr's `/mcp/<task-id>` endpoint.
   * It is run via `bash -lc`, in the worktree as cwd.
   *
   * Default: launch Claude Code INTERACTIVELY (no `-p`) with the prompt as the
   * positional arg and the butchr MCP server wired in. The agent stays alive and
   * attachable; it signals completion by calling the `request_review` MCP tool
   * rather than by exiting. On reject the same live session is handed the notes
   * (no re-run), which supersedes the old `--continue` resume mechanism.
   * Override BUTCHR_AGENT_CMD to use a different agent.
   */
  agentCmd: env(
    "BUTCHR_AGENT_CMD",
    // The `--` is REQUIRED: claude's `--mcp-config <configs...>` is variadic and
    // would otherwise swallow the positional prompt as a second config path.
    // `--` ends option parsing so the prompt is treated as the positional arg.
    'claude --dangerously-skip-permissions --mcp-config {{MCP_CONFIG}} -- "$(cat {{PROMPT_FILE}})"',
  ),

  /** Max time (ms) a single watcher waits for the agent to finish. */
  agentTimeoutMs: envInt("BUTCHR_AGENT_TIMEOUT_MS", 1000 * 60 * 60),

  /**
   * Command run (via `bash -lc`, cwd = the asking task's worktree) to answer an
   * engineer-agent's `ask` question in the CTO's voice. See src/cto.ts. The
   * `{{QUESTION_FILE}}` placeholder is replaced with a temp file holding the
   * question (avoids shell-escaping); `{{CTO_SESSION}}` with the resume flag.
   *
   * This MUST be READ-ONLY and MUST NOT recurse:
   *  - `-p` runs headless and prints the answer to stdout, then exits.
   *  - `--permission-mode dontAsk` resolves every tool request WITHOUT prompting
   *    (in `-p` there is no human to prompt, so any other mode hangs the moment
   *    the CTO touches a tool). Combined with the read-only allowlist below it
   *    auto-DENIES anything not listed.
   *  - `--allowedTools "Read Grep Glob"` grants only non-mutating tools. Write,
   *    Edit, NotebookEdit and Bash are absent → denied → the CTO cannot change
   *    files (verified: it refuses and creates nothing).
   *  - `{{CTO_SESSION}}` expands to `--resume <id> --fork-session` when
   *    `ctoSessionId` is set (forks the CTO session into a throwaway so the real
   *    one isn't mutated), or to nothing for a fresh read-only session.
   *  - NO `--mcp-config` and NO `--dangerously-skip-permissions`: the CTO can't
   *    reach butchr's own tools (`ask`/`request_review`), so there's no recursion.
   */
  ctoCmd: env(
    "BUTCHR_CTO_CMD",
    "claude -p {{CTO_SESSION}} --permission-mode dontAsk " +
      '--allowedTools "Read Grep Glob" -- "$(cat {{QUESTION_FILE}})"',
  ),

  /**
   * Optional CTO session id to resume+fork so the CTO inherits prior context.
   * When set, `{{CTO_SESSION}}` in ctoCmd resolves to `--resume <id>`; when empty
   * it resolves to nothing and the CTO runs fresh.
   */
  ctoSessionId: env("BUTCHR_CTO_SESSION_ID", ""),

  /** Max time (ms) to wait for a CTO `ask` answer before killing it. */
  askTimeoutMs: envInt("BUTCHR_ASK_TIMEOUT_MS", 120000),

  /**
   * How long (ms) a running agent's log can go with no new output before the
   * task is flagged `idle` — claude is alive but nothing is happening in its
   * interactive CLI (waiting on input, blocked, or just quiet). The watcher
   * clears the flag the moment output resumes. `0` disables idle detection.
   */
  idleMs: envInt("BUTCHR_IDLE_MS", 1000 * 60),

  /**
   * Optional override for opening a GUI terminal attached to a running task.
   * Template run via `bash -lc`; `{{CMD}}` is replaced with the shell-quoted
   * `herdr agent attach <id>` command. If unset, butchr auto-detects an
   * emulator (gnome-terminal, kitty, konsole, …).
   */
  terminalCmd: process.env.BUTCHR_TERMINAL_CMD || "",
};

export type Config = typeof config;
