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
   * rather than by exiting. Override BUTCHR_AGENT_CMD to use a different agent.
   */
  agentCmd: env(
    "BUTCHR_AGENT_CMD",
    'claude --dangerously-skip-permissions --mcp-config {{MCP_CONFIG}} "$(cat {{PROMPT_FILE}})"',
  ),

  /** Max time (ms) a single watcher waits for the agent to finish. */
  agentTimeoutMs: envInt("BUTCHR_AGENT_TIMEOUT_MS", 1000 * 60 * 60),
};

export type Config = typeof config;
