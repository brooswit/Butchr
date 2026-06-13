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

  /** Dispatcher poll interval (ms). */
  tickMs: envInt("BUTCHR_TICK_MS", 1500),

  /**
   * POST-MERGE VERIFY GATE (and the in-worktree CI gate share this command). After a
   * task's branch fast-forwards into the default branch (see tasks.approveTask →
   * git.merge), butchr runs this command in the repo ROOT (the default-branch
   * worktree) to confirm the NEW tip still builds and its tests pass. If it exits
   * NON-ZERO, the merge is auto-reverted (the default branch is reset back to its
   * pre-merge tip — see git.resetHard) and the task is flagged so a broken commit
   * never sits on main. Runs INSIDE the global merge queue, so a verify+revert can
   * never interleave with another merge.
   *
   * butchr is a GENERAL tool that manages OTHER people's repos, so there is no
   * universal build/test command — this global default is therefore EMPTY (the gate
   * is OFF until configured), and a managed repo opts in to a gate by setting its
   * build/test command. Configure it PER-WORKSPACE via the workspace's `gate_cmd`
   * (set at register time or via `PUT /api/workspaces/:id`), or set a global default
   * for every workspace with BUTCHR_VERIFY_CMD. An empty effective command DISABLES
   * the gate for that workspace (every merge is accepted — no verify, no revert).
   *
   * Run via `bash -lc` with the repo root as cwd. If your command runs a test
   * discoverer, SCOPE it to your repo's own tests (e.g. `bun test ./test`, not a bare
   * `bun test`): butchr lays out each task's git worktree as a SUBDIRECTORY of the
   * repo (`<dir>/<taskId>` — see git.worktreePath), so an unscoped discoverer run from
   * the repo root would glob the ENTIRE tree and pick up the test files inside sibling
   * task worktrees — an in-flight worktree's failing test could then auto-revert an
   * unrelated, already-green merge.
   */
  verifyCmd: env("BUTCHR_VERIFY_CMD", ""),
  /** Max wall-clock (ms) the verify gate may run before it's killed + treated as RED. */
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
   * OPTIONAL CHANGELOG-UPDATE GATE (opt-in; DEFAULT OFF). butchr no longer WRITES the
   * changelog at merge — the task/agent owns its changelog entry, and this gate
   * VERIFIES one was added. This is the GLOBAL DEFAULT path (relative to the repo
   * root) of the changelog file the CI gate checks (e.g. `CHANGELOG.md`):
   *  - EMPTY (the default) → the changelog gate is OFF for every workspace.
   *  - A path → a task whose diff makes a CODE (non-docs) change but does NOT touch
   *    that file FAILS the CI gate (an additional gate concern layered ON TOP of the
   *    build/test command, not part of it). A docs-only/empty diff is exempt.
   * Override globally with BUTCHR_CHANGELOG_PATH, or PER-WORKSPACE via the workspace's
   * `changelog_path` column (NULL inherits this default; "" disables it). Resolved by
   * workspaces.workspaceChangelogPath; enforced in tasks.triggerCi via
   * changelog.checkChangelogUpdated.
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
  connectivityIntervalMs: envInt("BUTCHR_CONNECTIVITY_INTERVAL_MS", 15000),

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
  // exposes an 'Open CTO terminal' button for it. See src/cto-agent.ts.

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
   * become the agent's positional prompt (`-- "$(cat …)"`). See cto-agent.ts.
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
   * Placeholders, all substituted by
   * cto-agent.ts:
   *  - `{{MODEL_FLAG}}`   → `--model <model>` or empty (see `ctoAgentModel`).
   *  - `{{SESSION_FLAG}}` → `--session-id <uuid>` on a FRESH start, or
   *    `--resume <id>` on every supervised relaunch / boot-adopt so the CTO keeps
   *    full context and never cold-starts (session continuity; see src/cto-agent.ts).
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
   * SUPERVISION cadence + bounded relaunch backoff for the CTO agent (mirrors the
   * dispatch retry knobs). The supervisor polls every `ctoSuperviseMs`; when the
   * agent has died it relaunches (RESUMING the same session) with exponential
   * backoff `min(base * 2^(n-1), cap)`, giving up after `ctoMaxRestarts` consecutive
   * failures (the operator must then start/restart it). A successful launch resets
   * the counter.
   */
  ctoSuperviseMs: envInt("BUTCHR_CTO_SUPERVISE_MS", 5000),
  ctoMaxRestarts: envInt("BUTCHR_CTO_MAX_RESTARTS", 5),
  ctoRestartBackoffBaseMs: envInt("BUTCHR_CTO_RESTART_BACKOFF_BASE_MS", 2000),
  ctoRestartBackoffCapMs: envInt("BUTCHR_CTO_RESTART_BACKOFF_CAP_MS", 60000),
};

export type Config = typeof config;
