// Centralized configuration, all overridable via environment.
import { homedir } from "node:os";
import { join } from "node:path";

const home = homedir();

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

/**
 * Parse an integer env var, STRICTLY. The value must be a FULLY-numeric integer
 * (optional sign, digits only) — a trailing-garbage value like `47800abc` is
 * REJECTED (falls back + warns) rather than silently truncated to `47800` by
 * `parseInt`, and a non-numeric value (`abc`) warns instead of silently falling
 * back. `opts.min` floor-clamps the parsed value (used to keep interval / timeout
 * knobs above a sane minimum so a 0/negative override can't create a tight loop or
 * disable a timeout). Exported for unit tests.
 */
export function envInt(
  name: string,
  fallback: number,
  opts: { min?: number } = {},
): number {
  const clamp = (n: number) => (opts.min !== undefined ? Math.max(opts.min, n) : n);
  const v = process.env[name];
  if (!v) return clamp(fallback);
  const t = v.trim();
  if (!/^[+-]?\d+$/.test(t)) {
    console.warn(
      `[butchr] ${name}="${v}" is not a valid integer; using default ${fallback}`,
    );
    return clamp(fallback);
  }
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? clamp(n) : clamp(fallback);
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

/**
 * Parse a comma-separated `key=value` env map (e.g. `ws-1=sess-a,ws-2=sess-b`),
 * trimming each side and dropping malformed/blank entries. Used for the PER-WORKSPACE
 * CTO-agent session seeds (`BUTCHR_CTO_AGENT_SESSION_IDS`), where each registered
 * workspace's first CTO launch resumes the operator-provided session for THAT
 * workspace. Empty/unset → an empty map (every workspace starts a fresh session).
 */
function envMap(name: string): Map<string, string> {
  const out = new Map<string, string>();
  const v = process.env[name];
  if (!v || !v.trim()) return out;
  for (const pair of v.split(",")) {
    const i = pair.indexOf("=");
    if (i <= 0) continue;
    const k = pair.slice(0, i).trim();
    const val = pair.slice(i + 1).trim();
    if (k && val) out.set(k, val);
  }
  return out;
}

// Where butchr keeps its own state (the SQLite db). This is distinct from the
// per-workspace `.butchr/` folders that live inside each registered repo.
const dataDir = env("BUTCHR_DATA_DIR", join(home, ".local", "share", "butchr"));

// The HTTP bind host, hoisted so `loopbackHost` can be derived from it once below.
const host = env("BUTCHR_HOST", "127.0.0.1");

// The read-only, non-recursing claude recipe shared by the two headless agents
// (conformance reviewer, brief expander). `-p` runs headless + prints the verdict then
// exits; `--permission-mode dontAsk` + `--allowedTools "Read Grep Glob"` makes it
// read-only (no Write/Edit/Bash) and auto-resolves tool requests; NO
// `--mcp-config`/`--dangerously-skip-permissions` so it can't recurse into butchr's own
// tools. `{{PROMPT_FILE}}` → the rendered prompt.
function readonlyClaude(): string {
  return (
    `claude -p --permission-mode dontAsk ` +
    '--allowedTools "Read Grep Glob" -- "$(cat {{PROMPT_FILE}})"'
  );
}

export const config = {
  /** HTTP host/port for the REST API + webapp. */
  host,
  port: envInt("BUTCHR_PORT", 47800),

  /**
   * The loopback-dialable form of `host`: when butchr binds 0.0.0.0 (all
   * interfaces) a local child process still reaches it via 127.0.0.1, so any URL
   * an agent's child dials should use this rather than the raw bind host. Computed
   * once here so the dispatcher (per-task MCP endpoint) and the CTO agent (channel
   * SSE URL) share one derivation.
   */
  loopbackHost: host === "0.0.0.0" ? "127.0.0.1" : host,

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

  /**
   * DB SNAPSHOT / BACKUP resilience (see src/backup.ts). The SQLite db is the
   * source of truth for all task state + history, so butchr takes periodic,
   * SQLite-safe snapshots (`VACUUM INTO`, not a raw mid-WAL file copy) and one on
   * clean shutdown, keeping the newest `backupKeep` and pruning older ones. A
   * damaged db can be rolled back with `butchr restore <file|latest>`.
   *  - `backupEnabled` master switch (default on). When off, no periodic/shutdown
   *    snapshots are taken (restore still works on any existing snapshots).
   *  - `backupDir` where snapshots live (default `<data>/backups`).
   *  - `backupIntervalMs` periodic snapshot cadence (default 15 min); <=0 disables
   *    the periodic loop (a shutdown snapshot is still taken if enabled).
   *  - `backupKeep` how many newest snapshots to retain; <=0 keeps ALL (no prune).
   */
  backupEnabled: envBool("BUTCHR_BACKUP_ENABLED", true),
  backupDir: env("BUTCHR_BACKUP_DIR", join(dataDir, "backups")),
  backupIntervalMs: envInt("BUTCHR_BACKUP_INTERVAL_MS", 1000 * 60 * 15),
  backupKeep: envInt("BUTCHR_BACKUP_KEEP", 24),

  /**
   * DISK-USAGE advisory threshold (bytes). butchr's two unbounded footprints — the
   * per-task git worktrees under each registered repo and the DB backup directory —
   * are sized on `/health` (the `disk` object). When their COMBINED size exceeds this,
   * `/health` flags `disk.warn=true` and the webapp shows an advisory badge. Purely
   * advisory: it never blocks dispatch, merges, or backups. Default 5 GiB. Set to 0
   * to DISABLE the warning (sizes are still reported). See src/disk.ts.
   */
  diskWarnBytes: envInt("BUTCHR_DISK_WARN_BYTES", 5 * 1024 * 1024 * 1024),

  /** Path to the herdr binary. */
  herdrBin: env("BUTCHR_HERDR_BIN", "herdr"),

  /**
   * Optional path to a file whose contents seed a freshly registered
   * workspace's `.butchr/CTO.md`. When unset or unreadable, the built-in
   * default CTO context is used instead.
   */
  ctoContextPath: env("BUTCHR_CTO_CONTEXT", ""),

  /** Path to the git binary. */
  gitBin: env("BUTCHR_GIT_BIN", "git"),

  /**
   * DURABLE GIT OBJECT WRITES. When on (default), butchr hardens every managed repo
   * so a power loss can't leave a truncated/empty loose object behind (the failure
   * that once wedged butchr: a mid-fsync interrupt left 0-byte objects in
   * .git/objects and merge/prune then broke). On register AND on every boot butchr
   * sets, idempotently, on each repo: `core.fsyncObjectFiles=true` (honored by git
   * < 2.36) and `core.fsync=all` (git >= 2.36; the older knob is ignored there, and
   * the new one is harmless on older git). Set BUTCHR_GIT_FSYNC=0 to skip writing
   * the config (e.g. if you manage these settings yourself). See git.setGitDurability.
   */
  gitFsync: envBool("BUTCHR_GIT_FSYNC", true),

  /**
   * STARTUP LOOSE-OBJECT SELF-HEAL. When on (default), on boot butchr scans every
   * managed repo for dangling/corrupt loose objects (0-byte truncations from a
   * power loss, plus anything `git fsck` flags) and removes ONLY those it can PROVE
   * are unreachable from any ref — reachable corruption is surfaced + logged but
   * NEVER auto-deleted (that would corrupt the repo). This auto-recovers from the
   * power-loss corruption class instead of wedging. Set BUTCHR_GIT_HEAL=0 to
   * disable the boot sweep. See git.healLooseObjects + the §3 runbook.
   */
  gitHealOnBoot: envBool("BUTCHR_GIT_HEAL", true),

  /** Dispatcher poll interval (ms). Floor-clamped so a 0/negative override can't
   * tight-loop the dispatcher (setInterval(fn,0) re-fires as fast as possible). */
  tickMs: envInt("BUTCHR_TICK_MS", 1500, { min: 250 }),

  /**
   * HERDR CLI SHELL-OUT TIMEOUTS. Every herdr command (src/herdr.ts) is bounded so
   * an alive-but-WEDGED herdr (stuck socket reply / hung `agent read` / `pane list`)
   * can't stall the dispatcher tick, the per-task watcher mid-probe, or the cto/leader
   * supervise loops FOREVER. A timed-out run returns code 124 / ok:false — exactly a
   * herdr failure — so the soft/degrading callers map it to their default (null/""/[])
   * and the hard callers throw it like any other failure (caught on the bounded-retry
   * dispatch / supervised-relaunch paths). Floor-clamped (min 1s) so a 0/negative
   * override can't disable the bound and reintroduce the unbounded hang.
   *  - herdrTimeoutMs (SHORT): reads/lists/status/probes/sends/closes/get/deregister.
   *    Kept to a few seconds since these run on the ~1.5s dispatcher tick.
   *  - herdrStartTimeoutMs (LONG): resource creation that spawns processes
   *    (agent start, workspace/tab create), which legitimately takes longer.
   */
  herdrTimeoutMs: envInt("BUTCHR_HERDR_TIMEOUT_MS", 5000, { min: 1000 }),
  herdrStartTimeoutMs: envInt("BUTCHR_HERDR_START_TIMEOUT_MS", 60000, { min: 1000 }),

  /**
   * MAX CAPTURED SUBPROCESS OUTPUT (bytes), per stream (stdout / stderr). The two
   * headless/subprocess capture paths — exec.run (gate/test commands, git) and
   * herdr.runHeadless (the conformance reviewer + brief expander) — read the child's
   * stdout/stderr into MEMORY. A gate command or a runaway `claude` that prints
   * gigabytes before its wall-clock timeout fires would otherwise be buffered
   * UNBOUNDEDLY and could OOM the butchr process (the timeout bounds wall-clock, not
   * bytes). So each stream is read with a bounded tail reader (exec.readBoundedTail)
   * that retains only the LAST `maxSubprocOutputBytes` bytes — the END is what
   * ciTail and the conformance-verdict parser both want — dropping from the FRONT and
   * prepending a short `[...truncated N bytes...]` marker when it trims. A normal
   * sub-cap run is captured in full, byte-for-byte unchanged. Default ~8 MiB.
   * Floor-clamped (min 64 KiB) so a tiny override can't truncate real gate output.
   */
  maxSubprocOutputBytes: envInt("BUTCHR_MAX_SUBPROC_OUTPUT_BYTES", 8 * 1024 * 1024, {
    min: 64 * 1024,
  }),

  /**
   * Max wall-clock (ms) the gate may run before it's killed + treated as RED. Bounds BOTH
   * the in-worktree CI gate (tasks.triggerCi) and the post-merge verify gate
   * (verify.verifyDefaultBranch), which now both run the repo's own `./scripts/ci`. There
   * is no gate COMMAND config: butchr carries ZERO gate configuration and execs the known
   * `./scripts/ci` path (a repo with no such script is un-gated). If your scripts/ci runs a
   * test discoverer, SCOPE it to your repo's own tests (e.g. `bun test ./test`, not a bare
   * `bun test`): butchr lays out each task's git worktree as a SUBDIRECTORY of the repo
   * (`<dir>/<taskId>` — see git.worktreePath), so an unscoped discoverer run from the repo
   * root would glob the ENTIRE tree and pick up the test files inside sibling task
   * worktrees — an in-flight worktree's failing test could then auto-revert an unrelated,
   * already-green merge.
   */
  verifyTimeoutMs: envInt("BUTCHR_VERIFY_TIMEOUT_MS", 1000 * 60 * 10),

  /**
   * OPTIONAL MERGE-TIME VERSION BUMP (opt-in; DEFAULT OFF). Not every managed repo
   * keeps a version file, so butchr no longer ASSUMES one — auto-patch-bumping is
   * opt-in. This is the GLOBAL DEFAULT path (relative to the repo root) of the
   * version file butchr patch-bumps on a successful merge (e.g. `package.json`):
   *  - EMPTY (the default) → version bumping is OFF for every workspace.
   *  - A path → on merge butchr patch-bumps the `"version": "x.y.z"` field of that
   *    file (a docs-only diff is skipped), committed inside the merge lock so
   *    concurrent tasks never collide on it.
   * Override globally with BUTCHR_VERSION_FILE, or PER-WORKSPACE via the workspace's
   * `version_file` column (NULL inherits this default; "" disables it for that
   * workspace). Resolved by workspaces.workspaceVersionFile. A graceful no-op when
   * the file is absent or has no semver `version` field — see git.bumpVersionFile.
   */
  versionFile: env("BUTCHR_VERSION_FILE", ""),

  /**
   * OPTIONAL CHANGELOG PATH for the MERGE-TIME RELEASE STAMP (opt-in; DEFAULT OFF). The
   * changelog-UPDATE RULE now lives inside the repo's own `./scripts/ci` gate (butchr
   * carries zero gate config), so this is NOT a gate setting — it is only the path
   * `release_mode`'s release stamp promotes `## [Unreleased]` into a versioned heading in
   * (e.g. `CHANGELOG.md`), relative to the repo root. EMPTY (the default) disables the
   * stamp. Override globally with BUTCHR_CHANGELOG_PATH, or PER-WORKSPACE via the
   * (read-only-inert) `changelog_path` column. Resolved by workspaces.workspaceChangelogPath;
   * consumed by git.merge / rebaseOntoDefault (promoteUnreleased).
   */
  changelogPath: env("BUTCHR_CHANGELOG_PATH", ""),

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
   * AUTO-RESUME bound (host/herdr-restart resilience). When butchr finds a task it
   * thinks is `in_progress` but whose `claude` process is NOT actually alive (a
   * power loss / herdr restart killed it, leaving herdr's pane as a bare login shell
   * — see src/liveness.ts), it auto-re-dispatches the SAME session via
   * `claude --resume` so the agent picks up exactly where it left off. This caps how
   * many CONSECUTIVE such auto-resumes butchr performs WITHOUT the agent making
   * progress (reaching review): past the cap the task is rescued to `in_review` for a
   * human instead of resumed again, so a session that dies the instant it relaunches
   * (e.g. a corrupt transcript) can never re-dispatch-loop forever. The counter
   * (`resume_attempts`) resets to 0 the moment the task reaches review or an operator
   * re-queues it. `<=0` disables auto-resume (a dead agent is rescued to review as
   * before).
   */
  maxResumeAttempts: envInt("BUTCHR_MAX_RESUME_ATTEMPTS", 5),

  /**
   * GATE-RECOVERY bound (host/herdr-restart resilience — the sibling of auto-resume
   * for CI/conformance GATES). The CI build/test gate (tasks.triggerCi) and the
   * spec-conformance reviewer (conformance.triggerConformance) run fire-and-forget IN
   * butchr's OWN process, so a power loss / restart kills the gate mid-run and leaves
   * the task stuck `ci_status='running'` / `conformance_status='checking'` FOREVER —
   * it could never become mergeable until an operator requeued it. On startup (and the
   * reaper backstop) butchr re-triggers every such stale in-flight gate. This caps how
   * many CONSECUTIVE recovery re-triggers a gate gets WITHOUT settling a real result:
   * past the cap the stuck gate is force-settled (CI → 'fail', conformance → cleared)
   * so the task is never left stuck, rather than re-triggered again — a gate that dies
   * the instant it starts can't loop across crash-restarts. The counter
   * (`gate_recovery_attempts`) resets to 0 the moment ANY gate settles a real result.
   * `<=0` disables gate recovery (a stuck gate is force-settled immediately instead).
   */
  maxGateRecoveryAttempts: envInt("BUTCHR_MAX_GATE_RECOVERY_ATTEMPTS", 5),

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
   *  - `{{CHANNEL_FLAG}}` → `--dangerously-load-development-channels
   *    server:butchr-cto-channel` when connectivity monitoring is ON (so a LIVE worker
   *    receives the broadcast `connectivity.restored` push mid-session via the same
   *    one-way channel the CTO uses, in CONNECTIVITY-ONLY mode — it never sees another
   *    task's review/idle/attention events), or EMPTY when connectivity is OFF. The
   *    matching `butchr-cto-channel` stdio server is added to the per-task MCP config
   *    only in that same case (see dispatcher.dispatch). NON-FATAL: if the channel
   *    fails to load/attach, the worker still launches and works normally — its real
   *    work is never blocked by this side-channel. A custom override that omits this
   *    placeholder simply never attaches the channel (the substitution is a no-op).
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
      '--mcp-config {{MCP_CONFIG}} {{CHANNEL_FLAG}} -- "$(cat {{PROMPT_FILE}})"',
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
      '--mcp-config {{MCP_CONFIG}} {{CHANNEL_FLAG}} -- "$(cat {{PROMPT_FILE}})"',
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
   * SPEC-CONFORMANCE REVIEW GATE. When a task enters `review`, butchr asynchronously
   * runs a READ-ONLY reviewer that judges whether the task's DIFF actually SATISFIES
   * its PROMPT (complete + on-spec) and writes an advisory `conformance_status` /
   * `conformance_summary` badge for the review panel. It runs a headless, read-only,
   * non-recursing claude:
   *  - `-p` runs headless and prints the verdict to stdout, then exits.
   *  - `--permission-mode dontAsk` + `--allowedTools "Read Grep Glob"` makes it
   *    read-only (no Write/Edit/Bash) so it can inspect the worktree but never mutate
   *    it, and auto-resolves tool requests without a human prompt.
   *  - NO `--mcp-config` / `--dangerously-skip-permissions`: it can't reach butchr's
   *    own tools, so there's no recursion.
   * The single `{{PROMPT_FILE}}` placeholder is replaced with a temp file holding the
   * rendered review prompt (task prompt + capped diff + agent summary), avoiding any
   * shell-escaping. Run via `bash -lc`, cwd = the task's worktree. Like the CI gate
   * this is ADVISORY (it never hard-blocks approval) and best-effort (a failure or an
   * unparseable verdict leaves conformance NULL). Set it EMPTY to DISABLE the gate.
   */
  conformanceCmd: env("BUTCHR_CONFORMANCE_CMD", readonlyClaude()),
  /** Max wall-clock (ms) the conformance reviewer may run before it's killed (→ NULL verdict). */
  conformanceTimeoutMs: envInt("BUTCHR_CONFORMANCE_TIMEOUT_MS", 120000),
  /**
   * Cap (bytes) on the git diff fed to the conformance reviewer, so a huge diff can't
   * blow the prompt argv limit or the model's context. A larger diff is truncated with
   * a marker; the reviewer can still Read/Grep the worktree for anything elided.
   */
  conformanceMaxDiffBytes: envInt("BUTCHR_CONFORMANCE_MAX_DIFF_BYTES", 60000),

  /**
   * BRIEF → EXPAND. Powers the webapp's low-effort new-task flow: the operator types a
   * one-line IDEA and `POST /api/expand-brief` runs this command to turn it into a
   * proper, concrete, scoped task prompt grounded in the target repo. It REUSES the
   * conformance reviewer's headless, read-only, non-recursing claude recipe:
   *  - `-p` runs headless and prints the expanded prompt to stdout, then exits.
   *  - `--permission-mode dontAsk` + `--allowedTools "Read Grep Glob"` makes it
   *    read-only (no Write/Edit/Bash) so it can inspect the repo (CONTRIBUTING.md / code)
   *    but never mutate it, and auto-resolves tool requests without a human prompt.
   *  - NO `--mcp-config` / `--dangerously-skip-permissions`: no recursion into butchr.
   * The single `{{PROMPT_FILE}}` placeholder is replaced with a temp file holding the
   * rendered expand prompt (avoiding shell-escaping). Run via `bash -lc`, cwd = the
   * target repo. Set it EMPTY to DISABLE expansion (the endpoint then 502s and the
   * operator writes the prompt by hand). See src/expand.ts.
   */
  expandBriefCmd: env("BUTCHR_EXPAND_BRIEF_CMD", readonlyClaude()),
  /** Max wall-clock (ms) the brief expander may run before it's killed (→ failure). */
  expandBriefTimeoutMs: envInt("BUTCHR_EXPAND_BRIEF_TIMEOUT_MS", 120000),

  /**
   * AUTO-MERGE green, low-risk tasks (opt-in; DEFAULT OFF). When enabled, a task
   * in `review` whose CI gate settled to `pass` and which qualifies as LOW-RISK is
   * approved + merged AUTOMATICALLY — running the SAME approve path a human would,
   * so the post-merge verify gate (the repo's `./scripts/ci`) still guards main. A task
   * that does NOT qualify waits for human review exactly as before. See
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
   *
   * Kept CONSERVATIVE (default 60s): the agent runs under `script -f` (flush after
   * every write), so an agent mid-generation is writing constantly and never trips
   * this. Only a genuinely-paused/stalled agent flips `idle`. That matters now that
   * idle is a graceful FEEDBACK surface (it pushes a channel event + shows action
   * buttons via the `idle-handling` responder, instead of auto-poking): too-sensitive
   * detection would spam the responder, so this threshold must stay generous.
   */
  idleMs: envInt("BUTCHR_IDLE_MS", 1000 * 60),

  /**
   * How many lines of the agent's run-log tail to capture as `idle_context` when a
   * task flips `idle` — the ANSI-stripped snapshot of WHAT the agent was doing and
   * WHERE it stopped, surfaced to the idle-handling responder (the CTO channel event
   * + the webapp idle panel) so it can act gracefully (nudge-with-guidance, requeue,
   * or abort) rather than poke blindly. `<=0` disables context capture (the flag is
   * still set). See dispatcher.readRunLogTail / tasks.setIdle.
   */
  idleContextLines: envInt("BUTCHR_IDLE_CONTEXT_LINES", 40),

  /**
   * REPEATING idle-escalation cadence (story st-926eea1c S1), in ms. When a story LEADER is
   * genuinely idle AND desired-up, workspace-agent.reconcileOperatorIdle re-fires the leader-idle
   * push to its CTO every `idleEscalateEveryMs`, stamping the durable workspace.idle_escalated_at
   * so an idle leader is NEVER a silent dead-end — it keeps nagging until it goes active or is
   * retired (desired=0), even across a butchr restart. A FLAT interval (CEO decision Q1 — NOT
   * exponential backoff): one knob, no backoff math. Default 15 minutes; prompt-retiring the
   * healthy done-case keeps it below this floor so the nag only bites a done-but-un-retired agent.
   */
  idleEscalateEveryMs: envInt("BUTCHR_IDLE_ESCALATE_EVERY_MS", 15 * 60 * 1000),

  /**
   * MID-SESSION PROMPT PROBE cadence, in watcher ticks. The per-task build-agent
   * watcher loops every ~1s but only stat()s the run-log mtime; it never reads pane
   * CONTENT. To catch a build agent that hits a human-only prompt AFTER launch (a
   * mid-run tool-permission / trust dialog, not just the startup consent the launch
   * auto-confirm covers), the watcher additionally reads the live pane every
   * `midProbeEveryTicks` ticks and runs it through the startup-prompt classifier:
   * a known prompt is auto-confirmed (mirroring launch auto-confirm); an
   * unrecognized-but-prompt-like pane flips `needs_user_input` so a human is routed
   * to it; a clean pane CLEARS the flag (same self-clearing lifecycle as idle).
   *
   * Kept COARSE (default every 10 ticks ≈ 10s) because `agentRead` shells out to
   * herdr — reading every 1s would hammer the hot watcher loop. The probe is
   * best-effort (a read/send failure is swallowed) so it can never disrupt the
   * watcher or fail a task. `<=0` disables the probe entirely. See
   * dispatcher.probeAgentForPrompt / shouldProbeTick.
   */
  midProbeEveryTicks: envInt("BUTCHR_MID_PROBE_TICKS", 10),

  /**
   * Optional override for opening a GUI terminal attached to a running task.
   * Template run via `bash -lc`; `{{CMD}}` is replaced with the shell-quoted
   * `herdr agent attach <id>` command. If unset, butchr auto-detects an
   * emulator (gnome-terminal, kitty, konsole, …).
   */
  terminalCmd: env("BUTCHR_TERMINAL_CMD", ""),

  // ---- CONNECTIVITY MONITOR (EVENT-ONLY) ------------------------------------
  // butchr ITSELF survives a host network outage (it's local — only the AGENTS'
  // model-API calls need the internet), so it is the right place to detect the
  // outage and signal RECOVERY. A monitor probes the model API endpoint, tracks a
  // debounced up/down state machine, and on a DOWN→UP transition BROADCASTS a single
  // `connectivity.restored` event (out the SSE stream → the CTO channel + the worker
  // connectivity channel) carrying the restored-at timestamp + outage duration. It is
  // strictly EVENT-ONLY: butchr takes NO recovery action on regain (no requeue/resume/
  // abort — the existing liveness/auto-resume/gate-recovery layers are untouched); each
  // recipient (worker or CTO) decides what to do. See src/connectivity.ts.

  /** Master switch (default on). When off, no probing, no event — and the worker
   * connectivity channel is NOT attached (it would have nothing to deliver). */
  connectivityEnabled: envBool("BUTCHR_CONNECTIVITY", true),

  /**
   * Reachability probe target — the model API the agents actually need. The probe
   * treats ANY resolved HTTP response (even 401/403/405/5xx) as REACHABLE (it proves
   * the internet works); only a network error / DNS failure / timeout is a failed
   * probe. Default is the Anthropic API root.
   */
  connectivityUrl: env("BUTCHR_CONNECTIVITY_URL", "https://api.anthropic.com/"),

  /** How often (ms) to probe reachability. */
  connectivityIntervalMs: envInt("BUTCHR_CONNECTIVITY_INTERVAL_MS", 15000, { min: 1000 }),

  /** Per-probe timeout (ms): a probe that doesn't resolve within this counts as a failure. */
  connectivityProbeTimeoutMs: envInt("BUTCHR_CONNECTIVITY_TIMEOUT_MS", 5000),

  /**
   * DEBOUNCE: require this many CONSECUTIVE failed probes to declare the network DOWN,
   * so a single transient failed probe can't false-trigger an outage (and thus can't
   * false-fire a spurious "restored" event on the next success). Default 3.
   */
  connectivityFailuresToDown: envInt("BUTCHR_CONNECTIVITY_FAILURES", 3),

  // ---- MANAGED CTO AGENT (PER-WORKSPACE) ------------------------------------
  // butchr can LAUNCH and SUPERVISE one long-lived CTO agent PER REGISTERED
  // WORKSPACE (repo) — a persistent Claude Code session that runs in that repo's
  // ROOT and IS the principal/dev agent for that project, operating butchr via its
  // API/CLI. Each is a first-class, channel-connected agent, just like the per-task
  // workspace agents but with NO worktree/branch/review/merge. Each receives ONLY
  // that workspace's PUSH attention notifications via the one-way CTO channel
  // (src/channel.ts, scoped to the workspace_id), and each workspace's dashboard card
  // exposes an 'Open CTO terminal' button for it. See src/workspace-agent.ts.

  /**
   * GLOBAL DEFAULT for the per-workspace CTO-agent enable. DEFAULT OFF so nothing
   * surprise-launches a Claude session. A workspace's own `cto_enabled` column WINS
   * over this (NULL on a workspace → inherit this default); with both off butchr
   * never boot-starts or supervises that workspace's CTO agent (existing behavior
   * unchanged). The per-workspace `/api/workspaces/:id/cto/*` endpoints still work
   * when disabled (so an operator can start one on demand) but nothing auto-starts.
   */
  ctoAgentEnabled: envBool("BUTCHR_CTO_AGENT", false),

  /**
   * GLOBAL DEFAULT for the per-PROJECT CEO-agent enable (REVAMP-4 Phase 3 / P3c). DEFAULT OFF
   * so nothing surprise-launches a Claude session — with this off AND no work_kind='project'
   * nodes, prod is byte-identical (no CEO ever boots). A project node's own `tasks.ceo_enabled`
   * tri-state WINS over this (NULL on the node → inherit this default); with both off butchr
   * never boot-starts or supervises that project's CEO agent. The CEO analog of
   * `ctoAgentEnabled`. Resolved by workspaces.isCeoEnabled; a project's CEO is enabled via
   * PATCH /api/projects/:id { ceo_enabled }.
   */
  ceoAgentEnabled: envBool("BUTCHR_CEO_AGENT", false),

  /**
   * NAME PREFIX for a workspace's CTO agent. The actual herdr agent name is
   * `<prefix>-<workspaceId>` (see cto-agent.ctoAgentName) — the stable handle
   * `herdr agent attach <name>` uses, one per workspace. Must NOT collide with any
   * task id; the default is hyphenated like an id but with a reserved human prefix so
   * it's unmistakable, and the appended `ws-<hex>` keeps each workspace's distinct.
   */
  ctoAgentName: env("BUTCHR_CTO_AGENT_NAME", "butchr-cto-agent"),

  /**
   * Optional `--model` for the CTO agent (e.g. 'opus'/'sonnet' or a full 'claude-*'
   * id). Empty → no flag (claude keeps its default). Threaded as `{{MODEL_FLAG}}`.
   */
  ctoAgentModel: env("BUTCHR_CTO_AGENT_MODEL", ""),

  /**
   * PER-WORKSPACE CTO-agent session SEEDS: `BUTCHR_CTO_AGENT_SESSION_IDS` is a
   * comma-separated `workspaceId=sessionId` map. On a workspace's FIRST CTO launch
   * (no persisted session yet) butchr RESUMES that workspace's seeded session when
   * present, else starts fresh and captures the new id; every later relaunch resumes
   * the persisted id. This is the per-workspace session seed for the MANAGED CTO agent.
   */
  ctoAgentSessionSeeds: envMap("BUTCHR_CTO_AGENT_SESSION_IDS"),

  /**
   * LAUNCH AUTO-CONFIRM (every per-workspace CTO (re)launch comes up READY
   * unattended). After the agent registers its pane, butchr polls the live pane and,
   * whenever it detects an unanswered blocking startup prompt (the
   * `--dangerously-load-development-channels` dev-channels consent, the Claude Code
   * folder-trust prompt, or any other yes/no / numbered confirmation — see
   * src/startup-confirm.ts), sends the safe confirming response via the harness `send`
   * capability. Bounded + idempotent: it polls every `ctoPromptPollMs` up to
   * `ctoPromptMaxPolls` times and stops once the pane is prompt-free for
   * `ctoPromptQuietPolls` consecutive reads. Best-effort — it never fails a launch.
   */
  ctoPromptPollMs: envInt("BUTCHR_CTO_PROMPT_POLL_MS", 500),
  ctoPromptMaxPolls: envInt("BUTCHR_CTO_PROMPT_MAX_POLLS", 60),
  ctoPromptQuietPolls: envInt("BUTCHR_CTO_PROMPT_QUIET_POLLS", 3),

  /**
   * Path to the EDITABLE CTO system prompt / brief that primes the agent on launch.
   * When unset, butchr writes a documented default to `<dataDir>/cto-brief.md` (and
   * reuses it thereafter) so an operator can edit it in place. The file's contents
   * become the agent's positional prompt (`-- "$(cat …)"`). See src/workspace-agent.ts.
   */
  ctoBriefPath: env("BUTCHR_CTO_BRIEF", ""),

  /**
   * Command (run via `bash -lc`, cwd = the workspace's repo root) that starts the
   * ONE-WAY CTO notification channel bridge. The bridge is butchr's OWN code
   * (`src/channel.ts`), so the default points at it by ABSOLUTE path (derived from
   * butchr's install dir) rather than `src/channel.ts` — the cwd is the MANAGED
   * repo's root (a different project that does NOT contain butchr's source), so a
   * cwd-relative path would never resolve. It is registered as an MCP STDIO server
   * named `butchr-cto-channel` in the CTO agent's generated MCP config and loaded as
   * a development channel via
   * `--dangerously-load-development-channels server:butchr-cto-channel`. The bridge
   * derives its SSE URL from butchr's host/port (overridable via
   * BUTCHR_CHANNEL_SSE_URL, which butchr sets on it) and is SCOPED to the workspace
   * via BUTCHR_CHANNEL_WORKSPACE (set per-launch) so it only pushes that workspace's events.
   */
  ctoChannelCmd: env(
    "BUTCHR_CTO_CHANNEL_CMD",
    `bun run ${join(import.meta.dir, "channel.ts")}`,
  ),

  /**
   * Command template that LAUNCHES a workspace's CTO agent (run via `bash -lc`,
   * wrapped under `script` for a PTY + log, cwd = the workspace's repo root).
   * Placeholders, all substituted by the unified launcher in
   * src/workspace-agent.ts:
   *  - `{{MODEL_FLAG}}`   → `--model <model>` or empty (see `ctoAgentModel`).
   *  - `{{SESSION_FLAG}}` → `--session-id <uuid>` on a FRESH start, or
   *    `--resume <id>` on every supervised relaunch / boot-adopt so the CTO keeps
   *    full context and never cold-starts (session continuity; see src/workspace-agent.ts).
   *  - `{{MCP_CONFIG}}`   → the generated MCP config registering the channel server.
   *  - `{{PROMPT_FILE}}`  → the editable CTO brief file (`ctoBriefPath`).
   * `--dangerously-skip-permissions` lets it call the butchr API/CLI without prompts.
   * `--dangerously-load-development-channels server:butchr-cto-channel` attaches the
   * custom channel (a research-preview flag — custom channels aren't allowlisted yet).
   */
  ctoAgentCmd: env(
    "BUTCHR_CTO_AGENT_CMD",
    "claude --dangerously-skip-permissions {{MODEL_FLAG}} {{SESSION_FLAG}} " +
      "--mcp-config {{MCP_CONFIG}} " +
      "--dangerously-load-development-channels server:butchr-cto-channel " +
      '-- "$(cat {{PROMPT_FILE}})"',
  ),

  /**
   * Command template that LAUNCHES a STORY-LEADER agent (run via `bash -lc`, wrapped under
   * `script` for a PTY + log, cwd = the story's workspace repo root). Mirrors `ctoAgentCmd`,
   * INCLUDING the channel wiring (Phase 4 of the STORIES epic): the leader gets a one-way
   * attention feed SCOPED to its story's subtasks via the same `butchr-cto-channel` stdio
   * server, just with BUTCHR_CHANNEL_STORY set. Placeholders (substituted by
   * the unified launcher in src/workspace-agent.ts):
   *  - `{{MODEL_FLAG}}`   → `--model <model>` or empty (reuses `ctoAgentModel`).
   *  - `{{SESSION_FLAG}}` → `--session-id <uuid>` fresh, or `--resume <id>` on every
   *    supervised relaunch / boot-adopt (session continuity; see src/workspace-agent.ts).
   *  - `{{MCP_CONFIG}}`   → the generated per-story MCP config registering the channel
   *    server (scoped to the story via BUTCHR_CHANNEL_STORY).
   *  - `{{PROMPT_FILE}}`  → the per-story generated leader brief file.
   * `--dangerously-load-development-channels server:butchr-cto-channel` attaches the custom
   * channel (a research-preview flag — custom channels aren't allowlisted yet).
   */
  storyAgentCmd: env(
    "BUTCHR_STORY_AGENT_CMD",
    "claude --dangerously-skip-permissions {{MODEL_FLAG}} {{SESSION_FLAG}} " +
      "--mcp-config {{MCP_CONFIG}} " +
      "--dangerously-load-development-channels server:butchr-cto-channel " +
      '-- "$(cat {{PROMPT_FILE}})"',
  ),

  /**
   * SUPERVISION cadence + bounded relaunch backoff for the CTO agent (mirrors the
   * dispatch retry knobs). The supervisor polls every `ctoSuperviseMs`; when the
   * agent has died it relaunches (RESUMING the same session) with exponential
   * backoff `min(base * 2^(n-1), cap)`, giving up after `ctoMaxRestarts` consecutive
   * failures (the operator must then start/restart it). A successful launch resets
   * the counter.
   */
  ctoSuperviseMs: envInt("BUTCHR_CTO_SUPERVISE_MS", 5000, { min: 1000 }),
  ctoMaxRestarts: envInt("BUTCHR_CTO_MAX_RESTARTS", 5),
  ctoRestartBackoffBaseMs: envInt("BUTCHR_CTO_RESTART_BACKOFF_BASE_MS", 2000),
  ctoRestartBackoffCapMs: envInt("BUTCHR_CTO_RESTART_BACKOFF_CAP_MS", 60000),

  /**
   * MID-SESSION PROMPT PROBE cadence for OPERATOR workspaces (kind 'cto'/'leader'),
   * in SUPERVISE ticks. The unified workspace supervisor (src/workspace-agent.ts)
   * polls every `ctoSuperviseMs` and is /proc-liveness-only; it never reads pane
   * CONTENT. To catch an operator agent parked at a blocking startup/permission
   * dialog AFTER launch (once the launch/adopt auto-confirm window has closed), the
   * supervisor additionally reads the live pane every `ctoMidProbeEverySupervisions`
   * ticks (genuine-idle gated off the agent.log mtime) and runs it through the same
   * startup-prompt classifier as the build-agent probe: a known prompt is
   * auto-confirmed; an unrecognized-but-prompt-like pane is surfaced via the
   * workspace row's last_error; a clean pane clears that signal.
   *
   * This is a DEDICATED supervise-cadence knob — NOT the build watcher's
   * `midProbeEveryTicks` (which counts ~1s watcher ticks). The supervisor ticks at
   * `ctoSuperviseMs` (default 5s), so the default 3 here is ≈15s between pane reads,
   * keeping `agentRead` (which shells out to herdr) off the hot path. `<=0` disables
   * the probe entirely. See workspace-agent.probeWorkspaceForPrompt / shouldProbeTick.
   */
  ctoMidProbeEverySupervisions: envInt("BUTCHR_CTO_MID_PROBE_SUPERVISIONS", 3),

  /**
   * UNIFIED-WORK ROUTING GATE (story st-540ba705 — DEFAULT ON as of step 6a). The feature
   * flag for the unified self-referential WORK model + the RECURSIVE parent-chain feedback
   * responder (src/work.ts, docs/rfc-work-workspace-unification.md §2.1). FLIPPED ON at the
   * step-6a cutover: tasks.pendingResponder now resolves the live feedback responder via the
   * recursive parent-chain (work.resolveWorkResponder over tasks.parent_id) instead of the old
   * 2-level story|cto|user rules — generalizing to arbitrary depth, with needs_user_input
   * short-circuiting to the user. The depth-1/2 instances (today's task/story shapes) resolve
   * IDENTICALLY to before: a story member (parent_id == its story_id, backfilled by the step-6a
   * boot migration) → `story`; a non-story task → `cto`, or `user` once escalated. Set
   * BUTCHR_UNIFIED_WORK=0 to fall back to the legacy 2-level routing. Read by
   * work.unifiedWorkEnabled() / tasks.pendingResponder.
   */
  unifiedWork: envBool("BUTCHR_UNIFIED_WORK", true),

  /**
   * RECURSIVE BRANCH-ISOLATION GATE (story st-540ba705, step 4 — DEFAULT OFF). The OFF
   * feature flag for the ARBITRARY-DEPTH generalization of story B's 3-level branch
   * isolation (docs/rfc-work-workspace-unification.md §4, Q9): every NODE Work can own a
   * branch, children merge into the nearest branched ancestor, and it re-gates + merges
   * upward (the depth-2 story-branch model is its single-level instance). DEFAULT OFF and
   * fully INERT — mirroring unifiedWork: while off, nothing in
   * the live dispatch / review / merge path branches on it (the recursive resolvers +
   * git.mergeWorkBranch have NO live caller this step), so today's single-level merge path
   * stays byte-for-byte authoritative and `/api/tasks` + `/api/stories` are byte-identical.
   * The recursive resolvers are exercised directly by tests while the live system is inert.
   * Per RFC Q9 activation is a separate, deliberate CEO call — turning this ON today still
   * has no live caller. Read by tasks.recursiveIsolationEnabled().
   */
  recursiveBranchIsolation: envBool("BUTCHR_RECURSIVE_BRANCH_ISOLATION", false),
};

export type Config = typeof config;
