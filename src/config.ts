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

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v.length === 0) return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

/** Parse a comma-separated env list (trimmed, blanks dropped); fallback if unset. */
function envList(name: string, fallback: string[]): string[] {
  const v = process.env[name];
  if (!v || !v.trim()) return fallback;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

// Where butchr keeps its own state (the SQLite db). This is distinct from the
// per-directory `.butchr/` folders that live inside each registered repo.
const dataDir = env("BUTCHR_DATA_DIR", join(home, ".local", "share", "butchr"));

export const config = {
  /** HTTP host/port for the REST API + webapp. */
  host: env("BUTCHR_HOST", "127.0.0.1"),
  port: envInt("BUTCHR_PORT", 47800),

  /**
   * EXTRA browser origins allowed to make state-changing (`POST`/`PUT`/`DELETE`/
   * `PATCH`) `/api` requests, on top of butchr's own derived origins
   * (`http://127.0.0.1:<port>`, `http://localhost:<port>`, `http://[::1]:<port>`,
   * `http://<host>:<port>`). Comma-separated list of full origins, e.g.
   * `http://192.168.1.5:47800`. This feeds the CSRF / DNS-rebinding guard in
   * server.ts: a state-changing request whose `Origin` header is present but not
   * in the allowlist is rejected with 403. Each entry's hostname is also accepted
   * in the `Host` header (the DNS-rebinding check). Requests with NO `Origin`
   * (the operator CLI, the per-task MCP server, curl, server-to-server) are always
   * allowed — they are not browser cross-site requests. This is localhost CSRF /
   * rebinding hardening, NOT authentication. Empty (default) → only the derived
   * loopback origins are accepted.
   */
  allowedOrigins: envList("BUTCHR_ALLOWED_ORIGINS", []),

  /** butchr's own state directory + SQLite path. */
  dataDir,
  dbPath: env("BUTCHR_DB", join(dataDir, "butchr.db")),

  /**
   * Persistent server log file. butchr's console output is teed here (in
   * addition to stdout) so logs survive restarts and detached runs. Empty
   * disables file logging. Rotated by size — see `logMaxBytes`/`logKeep`.
   */
  logFile: env("BUTCHR_LOG_FILE", join(dataDir, "butchr.log")),
  /** Rotate the log once it exceeds this many bytes (0 disables rotation). */
  logMaxBytes: envInt("BUTCHR_LOG_MAX_BYTES", 10 * 1024 * 1024),
  /** Number of rotated log files to keep (butchr.log.1 … butchr.log.N). */
  logKeep: envInt("BUTCHR_LOG_KEEP", 3),

  /** Path to the herdr binary. */
  herdrBin: env("BUTCHR_HERDR_BIN", "herdr"),

  /**
   * Optional path to a file whose contents seed a freshly registered
   * directory's `.butchr/CTO.md`. When unset or unreadable, the built-in
   * default CTO context is used instead.
   */
  ctoContextPath: env("BUTCHR_CTO_CONTEXT", ""),

  /** Path to the git binary. */
  gitBin: env("BUTCHR_GIT_BIN", "git"),

  /** Dispatcher poll interval (ms). */
  tickMs: envInt("BUTCHR_TICK_MS", 1500),

  /**
   * POST-MERGE VERIFY GATE. After a task's branch fast-forwards into the default
   * branch (see tasks.approveTask → git.merge), butchr runs this command in the
   * repo ROOT (the default-branch worktree) to confirm the NEW tip still builds
   * and its tests pass. If it exits NON-ZERO, the merge is auto-reverted (the
   * default branch is reset back to its pre-merge tip — see git.resetHard) and the
   * task is flagged so a broken commit never sits on main. Runs INSIDE the global
   * merge queue, so a verify+revert can never interleave with another merge.
   *
   * Run via `bash -lc` with the repo root as cwd. The default builds the bun entry
   * and runs the suite — appropriate when butchr manages its OWN repo (the
   * dogfooding setup). For a repo where this command does not apply, override
   * BUTCHR_VERIFY_CMD with the right build/test command. Set it EMPTY to DISABLE
   * the gate entirely (every merge is accepted as before — no verify, no revert).
   */
  verifyCmd: env(
    "BUTCHR_VERIFY_CMD",
    "bun build src/index.ts --target bun --outfile /dev/null && bun test",
  ),
  /** Max wall-clock (ms) the verify gate may run before it's killed + treated as RED. */
  verifyTimeoutMs: envInt("BUTCHR_VERIFY_TIMEOUT_MS", 1000 * 60 * 10),

  /**
   * Bounded dispatch retry with exponential backoff. When dispatch() throws
   * (workspace heal / worktree / herdr pane setup failed), the task is re-queued
   * with a growing delay instead of hot-looping every tick. After
   * `maxDispatchAttempts` consecutive failures it gives up to the `failed` state
   * (no more retries until the operator re-queues). Backoff for attempt N (1-based)
   * is `min(dispatchBackoffBaseMs * 2^(N-1), dispatchBackoffCapMs)`.
   */
  maxDispatchAttempts: envInt("BUTCHR_MAX_DISPATCH_ATTEMPTS", 5),
  dispatchBackoffBaseMs: envInt("BUTCHR_DISPATCH_BACKOFF_BASE_MS", 1000),
  dispatchBackoffCapMs: envInt("BUTCHR_DISPATCH_BACKOFF_CAP_MS", 30000),

  /**
   * Command template run inside a task's worktree to execute the agent for its
   * FIRST attempt. Placeholders, all replaced by the dispatcher:
   *  - `{{PROMPT_FILE}}` → absolute path to the rendered prompt file.
   *  - `{{MCP_CONFIG}}`  → absolute path to the per-task MCP config JSON that
   *    points the agent at butchr's `/mcp/<task-id>` endpoint.
   *  - `{{SESSION_ID}}`  → a butchr-generated UUID assigned to the Claude Code
   *    session via `--session-id`, so butchr already knows the id to `--resume`
   *    later (see `resumeCmd`). Persisted on the task row.
   *  - `{{MODEL_FLAG}}`  → `--model <model>` when the task specified a model at
   *    creation, or EMPTY when it didn't (claude then uses its current default).
   *    See tasks.createTask (the `model` column) + dispatcher.resolveLaunchCommand.
   *    A custom override that omits this placeholder simply never threads a
   *    per-task model — the substitution is a no-op on it.
   * It is run via `bash -lc`, in the worktree as cwd.
   *
   * Default: launch Claude Code INTERACTIVELY (no `-p`) with the prompt as the
   * positional arg and the butchr MCP server wired in. The agent signals
   * completion by calling the `request_review` MCP tool, which is now
   * NON-BLOCKING: it records the review request in butchr's DB and returns
   * immediately, after which the agent is expected to EXIT (its pane closes). The
   * task then lives purely as DB state — no live process is held open waiting for
   * a human, so nothing hangs and nothing is lost across a restart. On reject,
   * butchr re-launches the SAME session with the notes via `resumeCmd`.
   * Override BUTCHR_AGENT_CMD to use a different agent.
   */
  agentCmd: env(
    "BUTCHR_AGENT_CMD",
    // The `--` is REQUIRED: claude's `--mcp-config <configs...>` is variadic and
    // would otherwise swallow the positional prompt as a second config path.
    // `--` ends option parsing so the prompt is treated as the positional arg.
    "claude --dangerously-skip-permissions {{MODEL_FLAG}} --session-id {{SESSION_ID}} " +
      '--mcp-config {{MCP_CONFIG}} -- "$(cat {{PROMPT_FILE}})"',
  ),

  /**
   * Command template run to RE-LAUNCH a rejected task's agent. Same placeholders
   * as `agentCmd`, except `{{SESSION_ID}}` resolves to the id of the agent's
   * EXISTING session, resumed via `--resume` so it re-enters with FULL prior
   * context (the original prompt, its earlier work, and the review exchange). The
   * rendered prompt here is just the reviewer's notes + a reminder to address them
   * and call `request_review` again. This replaces the old "hand notes to a
   * blocked live session" path with a durable suspend/resume model that survives
   * the agent process or butchr itself restarting. Override BUTCHR_RESUME_CMD.
   */
  resumeCmd: env(
    "BUTCHR_RESUME_CMD",
    "claude --dangerously-skip-permissions {{MODEL_FLAG}} --resume {{SESSION_ID}} " +
      '--mcp-config {{MCP_CONFIG}} -- "$(cat {{PROMPT_FILE}})"',
  ),

  /** Max time (ms) a single watcher waits for the agent to finish. */
  agentTimeoutMs: envInt("BUTCHR_AGENT_TIMEOUT_MS", 1000 * 60 * 60),

  /**
   * RUNAWAY/STUCK-AGENT watchdog. Max wall-clock (ms) a task may sit in `running`
   * — counting from when it (last) entered running — WITHOUT the agent calling
   * request_review, before the watcher force-rescues it to `review`. This catches
   * an agent that is still ALIVE and even still emitting output (so the idle
   * detector never fires) but is looping/stuck and never submits — a task that
   * would otherwise hold its herdr tab forever. On trip the watcher captures a
   * snapshot, closes the tab, and moves the task to `review` (NOT abort) with a
   * "stuck/runaway" note, keeping the human in control. `0` disables the guard.
   *
   * Distinct from `agentTimeoutMs`: this is a shorter, separately-tunable cap with
   * its own rescue reason. With the defaults (45 min here, 60 min there) the
   * runaway guard trips first; if disabled, agentTimeoutMs is still the backstop.
   */
  maxRunMs: envInt("BUTCHR_MAX_RUN_MS", 1000 * 60 * 45),

  /**
   * Grace period (ms) for a freshly-dispatched agent to REGISTER with herdr.
   * herdr registers the agent name the instant `agent start` runs, so this only
   * needs to cover transient lookup lag — but if the agent never appears within
   * it (a failed/clobbered start the dispatch-time check somehow missed), the
   * watcher rescues the task to review instead of waiting out `agentTimeoutMs`.
   */
  agentStartGraceMs: envInt("BUTCHR_AGENT_START_GRACE_MS", 1000 * 60),

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
   * AUTO-MERGE green, low-risk tasks (opt-in; DEFAULT OFF). When enabled, a task
   * in `review` whose CI gate settled to `pass` and which qualifies as LOW-RISK is
   * approved + merged AUTOMATICALLY — running the SAME approve path a human would,
   * so the post-merge verify gate (config.verifyCmd) still guards main. A task that
   * does NOT qualify waits for human review exactly as before. See
   * tasks.maybeAutoMerge / isLowRiskChange.
   *
   * LOW-RISK = all three:
   *  (a) every changed file is under `autoMergeAllowlist` (path prefixes like
   *      `public/`/`test/`/`docs/`, plus a `*.md` entry that matches TOP-LEVEL
   *      markdown files), AND
   *  (b) total changed lines (added+deleted across the diff) <=
   *      `autoMergeMaxChangedLines`, AND
   *  (c) no merge conflict (a conflict routes back to the agent via the normal
   *      approve path and never lands on main).
   *
   * A CI-fail or a non-qualifying diff never auto-merges. All three are
   * env-overridable; BUTCHR_AUTO_MERGE_ALLOWLIST is a comma-separated list.
   */
  autoMergeEnabled: envBool("BUTCHR_AUTO_MERGE", false),
  autoMergeAllowlist: envList("BUTCHR_AUTO_MERGE_ALLOWLIST", [
    "public/",
    "test/",
    "docs/",
    "*.md",
  ]),
  autoMergeMaxChangedLines: envInt("BUTCHR_AUTO_MERGE_MAX_LINES", 150),

  /**
   * FLAKY-CI RETRY. When the CI gate's build/test run for a task entering `review`
   * comes back FAIL, butchr automatically RE-RUNS it up to this many times before
   * settling ci_status='fail'; a pass on any retry settles 'pass'. This absorbs
   * flaky/transient build+test failures so a one-off red doesn't stick. Retries are
   * logged. Default 1 (one retry → up to two total runs); set 0 to disable retries
   * and settle the first result as-is. See tasks.triggerCi.
   */
  ciRetries: envInt("BUTCHR_CI_RETRIES", 1),

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
  terminalCmd: env("BUTCHR_TERMINAL_CMD", ""),
};

export type Config = typeof config;
