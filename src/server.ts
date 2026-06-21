// HTTP layer: REST API + SSE + static webapp, all on one Bun.serve.
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getLastSnapshotAt, listBackups } from "./backup.ts";
import { config } from "./config.ts";
import { computeDiskUsage } from "./disk.ts";
import {
  ALL_STATUSES,
  computeMetrics,
  db,
  getLastMigrationOutcome,
  isTerminal,
  listTaskEvents,
  metricRows,
  REVIEW_STATES,
  STATE_META,
  sumStatuses,
} from "./db.ts";
import type { WorkspaceRow, TaskRow } from "./db.ts";
import { dispatcherHealth, isPaused, setPaused } from "./dispatcher.ts";
import {
  HttpError,
  dashboard,
  getWorkspace,
  getWorkspaceByPath,
  listWorkspaces,
  registerWorkspace,
  setWorkspaceBranchIsolation,
  setWorkspaceCtoEnabled,
  setWorkspaceReleaseMode,
  unregisterWorkspace,
  updateWorkspaceChangelogPath,
  updateWorkspaceGateCmd,
  updateWorkspaceVersionFile,
  workspaceDetail,
} from "./workspaces.ts";
import {
  ctoAgentName,
  ctoAgentStatus,
  restartCtoAgent,
  startCtoAgent,
  stopCtoAgent,
} from "./cto-agent.ts";
import { publish, subscribe } from "./events.ts";
import type { ButchrEvent } from "./events.ts";
import { expandBrief } from "./expand.ts";
import * as herdr from "./herdr.ts";
import { handleMcp } from "./mcp.ts";
import { getLastReap } from "./reaper.ts";
import pkg from "../package.json" with { type: "json" };
// Only the task ops the SURVIVING routes still touch: the attention feed, the stats
// rollup, and getTask (the work session/activity routes + requireTask read the row). Every
// other task/story op now flows through the unified /api/work surface (work-api.ts), which
// imports tasks.ts/stories.ts itself — the legacy /api/tasks + /api/stories routes that used
// the rest were deleted in the step-6e cutover.
import { attentionList, getTask, statsRollup, strandedTotals } from "./tasks.ts";
import {
  abortWork,
  answerWork,
  approveWork,
  askWork,
  assertWorkLeaf,
  confirmMajorWork,
  createWork,
  createWorkChild,
  createWorkspaceRollback,
  deleteWork,
  diffWork,
  escalateWork,
  estimateWork,
  eventsWork,
  listWork,
  nudgeWork,
  patchWork,
  planApproveWork,
  planRejectWork,
  prioritizeWork,
  readinessWork,
  rejectWork,
  reparentWork,
  requeueWork,
  resetWork,
  setWorkBlockedBy,
  specWork,
  versionBumpWork,
  workView,
} from "./work-api.ts";
import { listTemplates, renderTemplate } from "./templates.ts";
import { attachArgv, openTerminal } from "./terminal.ts";
import { readSessionActivity, readSessionTranscript } from "./transcript.ts";
import { worktreePath } from "./git.ts";

const PUBLIC_DIR = join(import.meta.dir, "..", "public");

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errResponse(e: unknown): Response {
  if (e instanceof HttpError) return json({ error: e.message }, e.status);
  console.error("[butchr] unhandled error:", e);
  return json({ error: (e as Error).message ?? "internal error" }, 500);
}

async function readJson(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

/**
 * Parse a positive-integer query param with a default and optional clamp. A
 * missing/non-finite/non-positive value yields `def`; otherwise it is floored and
 * clamped into `[min, max]` (each applied only when given). Centralizes the
 * `Number.isFinite(raw) && raw > 0 ? Math.min(MAX, Math.floor(raw)) : DEFAULT`
 * idiom the read routes repeated for `days` / `offset` / `limit`.
 */
function intParam(
  url: URL,
  name: string,
  opts: { def: number; min?: number; max?: number },
): number {
  const raw = Number(url.searchParams.get(name));
  if (!(Number.isFinite(raw) && raw > 0)) return opts.def;
  let v = Math.floor(raw);
  if (opts.max !== undefined) v = Math.min(opts.max, v);
  if (opts.min !== undefined) v = Math.max(opts.min, v);
  return v;
}

/** Look up a workspace by id or throw 404 — the single guard for the workspace-scoped routes. */
function requireWorkspace(id: string): WorkspaceRow {
  const dir = getWorkspace(id);
  if (!dir) throw new HttpError(404, "workspace not found");
  return dir;
}

/** Look up a task by id or throw 404 — the single guard for the task-scoped routes. */
function requireTask(id: string): TaskRow {
  const t = getTask(id);
  if (!t) throw new HttpError(404, "task not found");
  return t;
}

/**
 * Resolve a task's session context for the read-only transcript/activity routes:
 * throws 404 (via requireTask) if the task is gone, else returns the worktree path +
 * session id, or null when there's no resolvable session yet (its workspace is gone
 * or it has no session_id) — the caller then yields an empty transcript/activity
 * rather than a 404. The transcript itself lives under ~/.claude/projects (outside
 * the worktree), so the path is only a lookup hint that survives worktree cleanup.
 */
function taskSessionContext(taskId: string): { wt: string; sessionId: string } | null {
  const t = requireTask(taskId);
  const dir = getWorkspace(t.workspace_id);
  if (!dir || !t.session_id) return null;
  return { wt: worktreePath(dir.path, taskId), sessionId: t.session_id };
}

// ---- CSRF / DNS-rebinding guard -------------------------------------------
// butchr binds to loopback, but a malicious web page the operator merely VISITS
// can still make their BROWSER send forged state-changing requests to
// http://127.0.0.1:<port>/api/... — a cross-site POST, or a DNS-rebinding name
// that resolves to loopback — which would let that page create/approve/abort
// tasks. This is a small CENTRAL guard (NOT authentication, NO tokens/sessions)
// that blocks those browser-driven forgeries while leaving every NON-browser
// caller untouched:
//
//   (1) Browsers ALWAYS attach an `Origin` header to cross-site state-changing
//       fetches. For POST/PUT/DELETE/PATCH, if an `Origin` is present and is NOT
//       one of butchr's own origins, reject with 403. The webapp is same-origin,
//       so its `Origin` matches the allowlist and passes.
//   (2) A request with NO `Origin` (the operator CLI, the per-task MCP server,
//       curl, server-to-server) is ALLOWED — it is not a browser cross-site
//       request, so there is no forgery to block.
//   (3) DNS-rebinding hardening: the request's `Host` must be a loopback /
//       configured name. A rebound attacker domain pointed at 127.0.0.1 carries a
//       foreign `Host` even when same-origin (so it has no cross-site `Origin`).
//
// Allowlist = http://127.0.0.1:<port>, http://localhost:<port>, http://[::1]:<port>,
// http://<config.host>:<port>, plus any BUTCHR_ALLOWED_ORIGINS entries. GET reads
// and the SSE stream are never state-changing, so they are never gated.
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

const ALLOWED_ORIGINS: ReadonlySet<string> = (() => {
  const { host, port } = config;
  const set = new Set<string>([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
    `http://${host}:${port}`,
  ]);
  for (const o of config.allowedOrigins) set.add(stripTrailingSlash(o));
  return set;
})();

const ALLOWED_HOSTNAMES: ReadonlySet<string> = (() => {
  const set = new Set<string>(["127.0.0.1", "localhost", "::1", "[::1]", config.host]);
  for (const o of config.allowedOrigins) {
    try {
      set.add(new URL(o).hostname);
    } catch {
      /* ignore a malformed allowlist entry */
    }
  }
  return set;
})();

/**
 * Central CSRF / DNS-rebinding guard for state-changing `/api` requests. Returns a
 * 403 `Response` to REJECT, or `null` to ALLOW. Read requests (GET/HEAD/OPTIONS)
 * and any request with no cross-site `Origin` and a loopback `Host` pass through.
 * Exported so the rules can be unit-tested without standing up the HTTP server.
 */
export function csrfGuard(req: Request, url: URL): Response | null {
  if (!STATE_CHANGING_METHODS.has(req.method)) return null;

  // (1)+(2): browsers send `Origin` on cross-site state-changing fetches; a
  // present-but-foreign Origin is a forgery, a missing Origin is a non-browser
  // caller (CLI/MCP/curl) and is allowed.
  const origin = req.headers.get("origin");
  if (origin !== null && !ALLOWED_ORIGINS.has(stripTrailingSlash(origin))) {
    return json(
      {
        error:
          `forbidden: cross-origin ${req.method} from Origin '${origin}' is rejected. ` +
          `butchr only accepts same-origin browser requests on loopback ` +
          `(CSRF / DNS-rebinding hardening, NOT authentication). ` +
          `Set BUTCHR_ALLOWED_ORIGINS to permit additional origins.`,
      },
      403,
    );
  }

  // (3): DNS-rebinding — the Host must resolve to a loopback / configured name.
  const hostname = url.hostname;
  if (hostname && !ALLOWED_HOSTNAMES.has(hostname)) {
    return json(
      {
        error:
          `forbidden: unexpected Host '${hostname}' for a ${req.method} request — ` +
          `expected a loopback name (CSRF / DNS-rebinding hardening). ` +
          `Set BUTCHR_ALLOWED_ORIGINS if this host is intended.`,
      },
      403,
    );
  }
  return null;
}

// ---- SSE ----
// Exported for tests: returns the ReadableStream so a test can drive start()/cancel()
// directly and assert the keepalive timer is cleared on disconnect.
export function sseStream(): ReadableStream {
  // Hoisted into the closure so cancel() (which has no `controller` access) can
  // tear down BOTH the subscription and the keepalive timer on client disconnect.
  let unsub: () => void = () => {};
  let ka: ReturnType<typeof setInterval> | undefined;
  return new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const send = (e: ButchrEvent) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          /* closed */
        }
      };
      send({ type: "hello", now: new Date().toISOString() });
      // keepalive comment every 25s to defeat idle timeouts
      ka = setInterval(() => {
        try {
          controller.enqueue(enc.encode(`: keepalive\n\n`));
        } catch {
          /* closed */
        }
      }, 25000);
      unsub = subscribe(send);
    },
    cancel() {
      clearInterval(ka);
      unsub();
    },
  });
}

function sseResponse(): Response {
  return new Response(sseStream(), {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

// ---- static files ----
async function serveStatic(pathname: string): Promise<Response> {
  let rel = pathname === "/" ? "/index.html" : pathname;
  // prevent path traversal
  if (rel.includes("..")) return new Response("forbidden", { status: 403 });
  const file = Bun.file(join(PUBLIC_DIR, rel));
  if (await file.exists()) return new Response(file);
  // SPA fallback
  const index = Bun.file(join(PUBLIC_DIR, "index.html"));
  if (await index.exists()) return new Response(index);
  return new Response("not found", { status: 404 });
}

// ---- health ----
// Operational health snapshot for supervisors / uptime checks. 200 when healthy,
// 503 when the DB is unreachable or the dispatcher tick loop has stalled.
async function healthResponse(): Promise<Response> {
  // DB reachable: a trivial query.
  let dbOk = true;
  try {
    db.query("SELECT 1").get();
  } catch {
    dbOk = false;
  }

  // Task counts by status (best-effort; skipped if the DB is down).
  const tasks: Record<string, number> = {};
  if (dbOk) {
    try {
      const rows = db
        .query<{ status: string; n: number }, []>(
          // EXCLUDE materialized story Work NODES (st-540ba705 step 6a — see tasks.listTasks):
          // a story's anchor `tasks` row is not a real task, so it must not inflate the global
          // health status rollup with a phantom `merged` per story.
          `SELECT status, COUNT(*) AS n FROM tasks
            WHERE id NOT IN (SELECT id FROM stories) GROUP BY status`,
        )
        .all();
      for (const r of rows) tasks[r.status] = r.n;
    } catch {
      /* counts are best-effort */
    }
  }

  // Activity snapshot: an "active" task is any non-terminal one (an AGENT phase or a
  // FEEDBACK state awaiting the operator) — derived from the same status counts above
  // so we issue no extra queries. Tasks dispatch uncapped. Ready (`inactive`) and
  // running (`in_progress`) are now distinct statuses, so we report `inactive` + the
  // pre-dispatch `blocked` as the "waiting" bucket.
  const concurrency = {
    active:
      (tasks.idea ?? 0) +
      (tasks.spec_review ?? 0) +
      (tasks.needs_info ?? 0) +
      (tasks.in_progress ?? 0) +
      (tasks.in_review ?? 0) +
      (tasks.rolling_back ?? 0),
    queued: (tasks.blocked ?? 0) + (tasks.inactive ?? 0),
  };

  // Operator pull-signal: tasks needing a human's eyes right now — a generated spec
  // awaiting approval (`spec_review`), a diff awaiting review (`in_review`), an agent
  // question awaiting an answer (`needs_info`), or an execution `failed` task to inspect.
  // The webapp turns this into a tab-title badge + header indicator. Derived from the
  // status counts; no extra query.
  // STRANDED pull-signal (story st-a4cc6082, S2): agent-INDEPENDENT pending work (idea /
  // dead-blocked task; stuck / merge_blocked story) whose OWNING responder (CTO or story leader)
  // is dead-while-desired (gave_up) or disabled — a SYNC DB projection across all directories,
  // no liveness probe. FOLDED into needsAttention.total so the existing badge lights up; a LIVE
  // responder ⇒ stranded=0 ⇒ total is byte-for-byte the prior REVIEW_STATES sum (idea/blocked/
  // story-ids are all OUTSIDE REVIEW_STATES, so a stranded item is never double-counted).
  const stranded = dbOk
    ? strandedTotals()
    : { total: 0, items: [] as ReturnType<typeof strandedTotals>["items"] };
  const needsAttention = {
    spec_review: tasks.spec_review ?? 0,
    in_review: tasks.in_review ?? 0,
    needs_info: tasks.needs_info ?? 0,
    failed: tasks.failed ?? 0,
    // The stranded count, folded into `total` below.
    stranded: stranded.total,
    // Summed over the shared REVIEW_STATES membership (db.ts) PLUS the stranded pull-signal.
    total: sumStatuses(tasks, REVIEW_STATES) + stranded.total,
  };

  // Tick-loop liveness: stale if we've ticked at least once but not within
  // several intervals — meaning the dispatcher loop wedged. A never-ticked
  // loop (lastTickAt === 0) is treated as still-starting, not stalled.
  const { lastTickAt, tickCount, tickMs } = dispatcherHealth();
  const tickAgeMs = lastTickAt > 0 ? Date.now() - lastTickAt : null;
  const tickStaleAfterMs = Math.max(tickMs * 5, 10000);
  const tickAlive = lastTickAt === 0 || (tickAgeMs as number) <= tickStaleAfterMs;

  // herdr reachability — best-effort, never throws.
  let herdrReachable = false;
  try {
    herdrReachable = await herdr.isUp();
  } catch {
    herdrReachable = false;
  }

  // Reaper self-heal snapshot: the most recent startup-reap outcome (cheap,
  // synchronous module read — see reaper.getLastReap). Zeros + null timestamp
  // until the boot reap runs.
  const reap = getLastReap();

  // DB SNAPSHOT/BACKUP resilience snapshot (see src/backup.ts): when the last
  // snapshot was taken this run, how many are retained, and the backup dir. Cheap
  // (one readdir); best-effort — never affects the 200/503 verdict.
  let backupCount = 0;
  try {
    backupCount = listBackups().length;
  } catch {
    /* best-effort */
  }

  // DISK-USAGE snapshot (see src/disk.ts): size of the per-task worktrees under the
  // registered repo(s) + the DB backup dir, with an advisory `warn` when the total
  // crosses config.diskWarnBytes. Best-effort — a sizing failure leaves `disk` null
  // and never affects the 200/503 verdict.
  let disk: Awaited<ReturnType<typeof computeDiskUsage>> | null = null;
  try {
    disk = await computeDiskUsage();
  } catch {
    /* best-effort — disk accounting must never fail health */
  }

  const healthy = dbOk && tickAlive;
  const body = {
    status: healthy ? "ok" : "degraded",
    version: (pkg as { version?: string }).version ?? "unknown",
    // Process id of THIS server. Lets `butchr restart --verify` confirm the relaunch by
    // waiting for /health to answer with a DIFFERENT pid (a genuinely fresh process).
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    // DISPATCHER PAUSE: true while NEW agent dispatch is halted (maintenance /
    // drain-only mode). Running/review/idle tasks are unaffected; this only gates
    // launching queued tasks. Persisted, so it survives a restart. The webapp keys
    // its PAUSED banner + pause/resume control off this.
    paused: isPaused(),
    db: { ok: dbOk },
    // LAST-BOOT MIGRATION OUTCOME (see db.getLastMigrationOutcome): when the boot
    // migration pass ran, how many steps executed, whether it converged cleanly, and
    // the failing step + message if one threw — so an operator confirms a clean boot
    // migration in this ONE pull instead of grepping the journal. On a booted server
    // `ok` is true (a thrown migration aborts boot); the value's worth is the timestamp.
    migration: getLastMigrationOutcome(),
    tick: {
      alive: tickAlive,
      count: tickCount,
      lastTickAt: lastTickAt > 0 ? new Date(lastTickAt).toISOString() : null,
      ageMs: tickAgeMs,
      staleAfterMs: tickStaleAfterMs,
    },
    tasks,
    // Count of tasks in the terminal `failed` state (a dispatch/spec-gen give-up or a
    // post-merge verify revert) — execution failures, distinct from operator `aborted`.
    failedTasks: tasks.failed ?? 0,
    concurrency,
    needsAttention,
    // STRANDED-WORK pull-signal (story st-a4cc6082, S2): the agent-INDEPENDENT pending items
    // whose owning responder is dead-while-desired (gave_up) or disabled, with a human reason
    // per item — already folded into needsAttention.total/.stranded above.
    stranded,
    // Self-heal visibility: last startup reap of orphaned worktrees + herdr husks.
    reaper: { lastRunAt: reap.at, worktrees: reap.worktrees, husks: reap.husks },
    // DB snapshot/backup resilience: last snapshot time this run (null until the
    // first), retained-snapshot count, retention limit, cadence, dir, enabled.
    backup: {
      enabled: config.backupEnabled,
      lastSnapshotAt: getLastSnapshotAt(),
      count: backupCount,
      keep: config.backupKeep,
      intervalMs: config.backupIntervalMs,
      dir: config.backupDir,
    },
    // DISK usage of the worktrees + backup dir, with an advisory over-threshold flag
    // (null if sizing failed). See src/disk.ts / config.diskWarnBytes.
    disk,
    herdr: { reachable: herdrReachable },
  };
  return json(body, healthy ? 200 : 503);
}

// ---- router ----
type Handler = (req: Request, params: Record<string, string>) => Promise<Response>;

const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];

function route(method: string, path: string, handler: Handler): void {
  const keys: string[] = [];
  const pattern = new RegExp(
    "^" +
      path.replace(/:[^/]+/g, (m) => {
        keys.push(m.slice(1));
        return "([^/]+)";
      }) +
      "/?$",
  );
  routes.push({ method, pattern, keys, handler });
}

// Filesystem browser — powers the directory picker and the context-file
// selector in the webapp. butchr is a local single-operator tool (trusted
// environment per spec), so listing the host filesystem is fine. Returns the
// subdirectories of `path`, flagging git repos. Pass `files=1` to also include
// regular files (used by the context-file selector).
route("GET", "/api/fs", async (req) => {
  const url = new URL(req.url);
  const raw = url.searchParams.get("path");
  const withFiles = url.searchParams.get("files") === "1";
  const path = resolve(raw && raw.length > 0 ? raw : homedir());
  if (!existsSync(path)) throw new HttpError(404, `no such path: ${path}`);
  let st;
  try {
    st = statSync(path);
  } catch (e) {
    throw new HttpError(400, `cannot stat: ${(e as Error).message}`);
  }
  if (!st.isDirectory()) throw new HttpError(400, `not a directory: ${path}`);

  const entries: { name: string; path: string; isDir: boolean; isGitRepo: boolean }[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(path);
  } catch (e) {
    throw new HttpError(403, `cannot read directory: ${(e as Error).message}`);
  }
  for (const name of names) {
    if (name.startsWith(".")) continue; // hide dotfiles/dirs
    const full = join(path, name);
    let isDir: boolean;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue; // unreadable / broken symlink
    }
    if (!isDir && !withFiles) continue;
    entries.push({ name, path: full, isDir, isGitRepo: isDir && existsSync(join(full, ".git")) });
  }
  // Workspaces first, then files; alphabetical within each group.
  entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));

  const parent = dirname(path);
  return json({
    path,
    parent: parent === path ? null : parent, // null at filesystem root
    home: homedir(),
    isGitRepo: existsSync(join(path, ".git")),
    entries,
  });
});

// Health (also exposed at the bare /health path — see fetch()).
route("GET", "/api/health", async () => healthResponse());

// DISPATCHER PAUSE / MAINTENANCE MODE. Pause stops NEW agent dispatch (drain-only)
// so the operator can hold for a restart/recovery/maintenance window without
// disturbing running/review/idle tasks, which continue untouched; resume restores
// normal dispatch. The flag is persisted, so a pause survives a restart and stays
// in effect until resumed. Both are idempotent. Each publishes a `dispatch.paused`
// SSE event so every connected webapp reflects the change live. See
// dispatcher.{isPaused,setPaused,selectQueuedForDispatch}.
function setPauseResponse(value: boolean): Response {
  setPaused(value);
  publish({ type: "dispatch.paused", paused: value });
  return json({ paused: value });
}
route("POST", "/api/pause", async () => setPauseResponse(true));
route("POST", "/api/resume", async () => setPauseResponse(false));

// RESTART the server process. Responds IMMEDIATELY with the current pid/version, then
// raises SIGTERM on ourselves so index.ts's graceful shutdown runs (stop loops + final DB
// snapshot + clean exit) and the process supervisor relaunches us. butchr re-adopts running
// tasks and re-drives gates on boot, so a restart resumes cleanly. REQUIRES a supervisor
// that relaunches on exit (the deployed systemd unit's Restart=always — see deploy/
// butchr.service); `butchr restart --verify` blocks on /health afterward and reports
// honestly if the server does not come back (so a non-supervised run isn't left silently
// down). The SIGTERM is deferred a tick so this response flushes to the client first.
route("POST", "/api/restart", async () => {
  setTimeout(() => process.kill(process.pid, "SIGTERM"), 50);
  return json({
    restarting: true,
    pid: process.pid,
    version: (pkg as { version?: string }).version ?? "unknown",
  });
});

// Operational metrics for the webapp's Metrics view. Read-only aggregates over
// all tasks (see db.computeMetrics): status counts, merged-per-day throughput,
// median time-to-review / time-to-merge, and conflict / revert / CI-pass /
// auto-merge rates. `?days=N` (1–90, default 14) sets the throughput window.
route("GET", "/api/metrics", async (req) => {
  const url = new URL(req.url);
  const days = intParam(url, "days", { def: 14, max: 90 });
  return json(computeMetrics(metricRows(), Date.now(), days));
});

// CROSS-PROJECT DASHBOARD. A top-level home aggregating every registered workspace:
// per-workspace active / review / failed / needs-attention counts, its effective
// build/test gate command, and a `totals` rollup. Powers the webapp dashboard's
// summary line + per-card counts and lets a supervisor pull per-workspace
// needs-attention without walking every workspace's task list. Read-only.
route("GET", "/api/dashboard", async () => json(dashboard()));

// GLOBAL STATS ROLLUP: status counts across ALL workspaces (+ the `idle` pseudo-bucket),
// a total task count, and a per-workspace breakdown. Replaces counting tasks by hand
// against the sqlite file. Read-only. See tasks.statsRollup.
route("GET", "/api/stats", async () => json(statsRollup()));

// ATTENTION FEED: the PULL side of the push-only CTO channel — a structured list of every
// task awaiting the operator right now (plan-approval / diff-review / needs-info /
// major-confirm / idle-handling / failed), so "is anything waiting on me" is one reliable
// call (a 404'd list previously gave a false "idle" read). Read-only. See tasks.attentionList.
route("GET", "/api/attention", async () => json(attentionList()));

// Workspaces
route("GET", "/api/workspaces", async () => json(listWorkspaces()));

// A single workspace's DETAIL view: the WorkspaceView (counts + columns). Responder
// routing is STRUCTURAL (per-task pending_responder), so there is no per-workspace
// responder config to surface here. 404 if the workspace is gone.
route("GET", "/api/workspaces/:id", async (_req, p) => json(workspaceDetail(p.id!)));

// CANONICAL STATE METADATA. The single source of truth for the 12-state machine —
// each state's KIND (idle/agent/feedback) and AGENT TYPE — lives in src/db.ts
// (STATE_META) alongside the ordered status list (ALL_STATUSES). The webapp serves
// this at boot to BUILD its STATE_KIND / AGENT_TYPE / status-membership tables rather
// than hand-mirroring the literals, so a state-model change needs editing exactly one
// file. `terminalStatuses` is the isTerminal subset (which the kind alone can't express —
// `blocked`/`rolling_back` are also idle-kind but non-terminal), so the client derives
// its active/Finished split from the server too. Read-only; static for the process
// lifetime. See public/app.js (boot fetch / applyStateMeta).
route("GET", "/api/state-meta", async () =>
  json({
    stateMeta: STATE_META,
    allStatuses: ALL_STATUSES,
    terminalStatuses: ALL_STATUSES.filter(isTerminal),
  }),
);

// Built-in TASK TEMPLATES (recipes): the named, parameterized prompt skeletons the
// CLI `templates` command and the webapp new-task picker list. Each entry carries
// its `{{placeholder}}` names so a caller knows what to fill. See src/templates.ts.
route("GET", "/api/templates", async () => json(listTemplates()));

// BRIEF → EXPAND. Turns the operator's one-line IDEA into a proper, concrete, scoped
// task prompt grounded in the target repo, by running a headless, READ-ONLY claude
// (Read/Grep/Glob over the repo — see config.expandBriefCmd / src/expand.ts) that
// reuses the spec-conformance reviewer's recipe. Body `{ brief, workspace }`:
// `workspace` is the registered workspace's id (or its absolute path); the expander
// runs with that repo as cwd. Returns `{ prompt }` — the expanded text the webapp
// drops into the new-task prompt textarea for the operator to review/edit before
// Create. 400 on a blank brief, 404 on an unknown workspace, 502 if expansion failed.
route("POST", "/api/expand-brief", async (req) => {
  const body = await readJson(req);
  // Resolve the workspace by id first (what the webapp sends), then by path, so a
  // caller can pass either. The repo root is the expander's cwd.
  const dir = getWorkspace(body.workspace) ?? getWorkspaceByPath(body.workspace ?? "");
  if (!dir) throw new HttpError(404, "workspace not found");
  const prompt = await expandBrief(body.brief, dir.path);
  return json({ prompt });
});

route("POST", "/api/workspaces", async (req) => {
  const body = await readJson(req);
  // Optional per-workspace settings, all validated inside registerWorkspace (omit/null
  // → inherit the global default; "" → disable for this workspace):
  //  - gate_cmd: the build/test gate command both gates run.
  //  - version_file: the version file the merge patch-bumps (e.g. package.json).
  //  - changelog_path: the file the changelog CI gate requires a code change to update.
  const view = await registerWorkspace(
    body.path, body.label, body.gate_cmd, body.version_file, body.changelog_path,
  );
  return json(view, 201);
});

// Update a workspace's per-workspace settings. Each field is handled by KEY PRESENCE
// so updating one never clobbers another (a string sets it, "" disables it for this
// workspace, null CLEARS the override → inherit the global default):
//  - `gate_cmd`: the build/test gate command both the CI gate and the post-merge
//    verify gate run for this workspace (default config.verifyCmd).
//  - `version_file`: the version file butchr patch-bumps at merge (default
//    config.versionFile — EMPTY/off; version bumping is opt-in per workspace).
//  - `changelog_path`: the file the changelog CI gate requires a code change to update
//    (default config.changelogPath — EMPTY/off; the gate is opt-in per workspace).
//  - `cto_enabled`: the per-workspace CTO-agent enable (boot auto-start + supervision)
//    — true/false forces it on/off; null CLEARS the override → inherit the global
//    default config.ctoAgentEnabled.
//  - `release_mode`: the per-workspace VERSIONED-RELEASES mode (true/false; null = off) —
//    when on, every merge bumps the version + stamps the changelog with a versioned heading
//    and the changelog gate is strict. See workspaces.setWorkspaceReleaseMode.
//  - `branch_isolation`: the per-workspace 3-LEVEL BRANCH-ISOLATION guard (true/false; null
//    = off) — when on, stories OPENED afterward are isolated (own branch; subtasks merge into
//    the story branch; re-gate + merge to the default branch on completion). Already-open
//    stories keep their captured isolated bit (§11.8). See workspaces.setWorkspaceBranchIsolation.
// A bare PATCH (no recognized key) clears the gate command, preserving the legacy
// contract. 404 if the workspace is gone. Publishes `workspace.updated`.
route("PATCH", "/api/workspaces/:id", async (req, p) => {
  const body = await readJson(req);
  let view;
  if ("cto_enabled" in body) view = await setWorkspaceCtoEnabled(p.id!, body.cto_enabled);
  if ("version_file" in body) view = updateWorkspaceVersionFile(p.id!, body.version_file);
  if ("changelog_path" in body) view = updateWorkspaceChangelogPath(p.id!, body.changelog_path);
  if ("release_mode" in body) view = setWorkspaceReleaseMode(p.id!, body.release_mode);
  if ("branch_isolation" in body) view = setWorkspaceBranchIsolation(p.id!, body.branch_isolation);
  // gate_cmd: set when its key is present, OR when NO other recognized key was sent
  // (a bare PATCH clears the gate override — the legacy contract).
  const touchedOther =
    "cto_enabled" in body || "version_file" in body || "changelog_path" in body ||
    "release_mode" in body || "branch_isolation" in body;
  if ("gate_cmd" in body || !touchedOther) {
    view = updateWorkspaceGateCmd(p.id!, body.gate_cmd ?? null);
  }
  return json(view!);
});

route("DELETE", "/api/workspaces/:id", async (_req, p) => {
  await unregisterWorkspace(p.id!);
  return json({ ok: true });
});

// ---- WORK (UNIFIED SURFACE) -----------------------------------------------
// The `/api/work/*` surface unifies TASKS (leaves) and STORIES (nodes) under one "Work"
// vocabulary — see src/work-api.ts and docs/rfc-work-workspace-unification.md §5. Each
// route resolves a work id to a leaf/node and DISPATCHES to the tasks.ts/stories.ts
// operations the old `/api/tasks` + `/api/stories` routes used. As of the step-6e cutover
// this is the SOLE HTTP surface for work: those legacy routes have been DELETED (the webapp
// + agents call `/api/work` exclusively), and work-api.ts is the only adapter over the
// service ops. The data migration (folding stories into tasks) remains a later step;
// parent_id stays inert (no writes), and the responder chain on a leaf view is informational.

// Cross-resource WORK LIST: every leaf (task) + node (story) across all workspaces, each
// tagged `kind`, newest-first. Optional `?workspace=` / `?status=` / `?q=` mirror the task
// list's filters (applied to nodes too). Read-only. See work-api.listWork.
route("GET", "/api/work", async (req) => {
  const url = new URL(req.url);
  return json(
    await listWork({
      status: url.searchParams.get("status") ?? undefined,
      workspace: url.searchParams.get("workspace") ?? undefined,
      q: url.searchParams.get("q") ?? undefined,
    }),
  );
});

// Create a TOP-LEVEL unit of Work in a workspace. By default a NODE (story/container; body
// {brief}) — ordinary leaves are created as children of a node (see POST /api/work/:id/work).
// The ONE workspace-level LEAF still created directly is a ROLLBACK (`kind:'rollback'` or the
// `rollback` template — the webapp's "Roll back" flow): it builds a revert like any task and
// MIRRORS the POST /api/stories/:id/tasks body (prompt/template/context/blocked_by/model/tags/
// priority/plan_preview/idea/version_bump/allowlist). Maps to createWorkspaceRollback (node →
// createStory). 404 if the workspace is gone; 400 if the brief/prompt is blank.
route("POST", "/api/workspaces/:id/work", async (req, p) => {
  requireWorkspace(p.id!);
  const body = await readJson(req);
  const isRollback = body.kind === "rollback" || body.template === "rollback";
  if (isRollback) {
    const prompt = body.template ? renderTemplate(body.template, body.vars) : body.prompt;
    const idea = body.idea === true || body.stage === "idea";
    const view = await createWorkspaceRollback(p.id!, {
      prompt,
      context: body.context ?? [],
      blockedBy: body.blocked_by ?? [],
      kind: "rollback",
      model: body.model ?? null,
      tags: body.tags ?? [],
      priority: body.priority ?? 0,
      planPreview: body.plan_preview ?? false,
      idea,
      versionBump: body.version_bump ?? "patch",
      allowlist: body.allowlist ?? [],
    });
    return json(view, 201);
  }
  return json(createWork(p.id!, body.brief), 201);
});

// A single unit of Work as a unified WorkView — a leaf carries the full TaskView (+ the
// informational Work responder/chain), a node the full StoryView. 404 if gone.
route("GET", "/api/work/:id", async (_req, p) => json(await workView(p.id!)));

// PATCH a unit of Work: a LEAF edits prompt/context ({prompt?, context?}); a NODE updates
// brief/status ({brief?, status?}). Routed by kind. 404 if gone. See work-api.patchWork.
route("PATCH", "/api/work/:id", async (req, p) => {
  const body = await readJson(req);
  return json(patchWork(p.id!, body));
});

// Create a CHILD unit of Work under a node — a LEAF (subtask). NODE parent only (409 on a
// leaf). The body MIRRORS POST /api/stories/:id/tasks (kind/template/prompt/idea/model/
// tags/priority/plan_preview/version_bump/allowlist). Maps to createSubtask. 404 if the
// parent is gone; 409 if it is a leaf or not `open`.
route("POST", "/api/work/:id/work", async (req, p) => {
  const body = await readJson(req);
  const kind =
    body.kind === "rollback" || body.template === "rollback" ? "rollback" : "task";
  const prompt = body.template ? renderTemplate(body.template, body.vars) : body.prompt;
  const idea = body.idea === true || body.stage === "idea";
  const view = await createWorkChild(p.id!, {
    prompt,
    context: body.context ?? [],
    blockedBy: body.blocked_by ?? [],
    kind,
    model: body.model ?? null,
    tags: body.tags ?? [],
    priority: body.priority ?? 0,
    planPreview: body.plan_preview ?? false,
    idea,
    versionBump: body.version_bump ?? "patch",
    allowlist: body.allowlist ?? [],
  });
  return json(view, 201);
});

// APPROVE a unit of Work (LEAF-only) — mirrors POST /api/tasks/:id/approve's flag-shaped
// response (conflict / revert / awaiting-major-confirm). 409 on a node.
route("POST", "/api/work/:id/approve", async (_req, p) => {
  const r = await approveWork(p.id!);
  if (r.conflictSentBack) return json({ task: r.task, conflictSentBack: true });
  if (r.revertedOnRed) return json({ task: r.task, revertedOnRed: true });
  if (r.awaitingMajorConfirm) return json({ task: r.task, awaitingMajorConfirm: true });
  if (r.storyClosed) return json({ task: r.task, storyClosed: true, message: r.message });
  return json(r.task);
});

// REJECT a unit of Work (LEAF-only) — send it back for rework with {note}. 409 on a node.
route("POST", "/api/work/:id/reject", async (req, p) => {
  const body = await readJson(req);
  return json(await rejectWork(p.id!, body.note));
});

// ANSWER a unit of Work's open feedback — the UNIFIED answer verb: a LEAF answers its
// needs_info question, a NODE answers its open story-level ask. Body {answer}. 404 if gone.
route("POST", "/api/work/:id/answer", async (req, p) => {
  const body = await readJson(req);
  return json(await answerWork(p.id!, body.answer));
});

// ESCALATE a unit of Work's pending feedback to the next responder (the cto→user boundary)
// — a LEAF escalates its task feedback, a NODE its open ask. Routed by kind. 404 if gone.
route("POST", "/api/work/:id/escalate", async (_req, p) => {
  return json(escalateWork(p.id!));
});

// OPEN an ASK on a unit of Work (NODE-only) — a leader's story-level question up the chain;
// body {question}. 409 on a leaf. See work-api.askWork.
route("POST", "/api/work/:id/ask", async (req, p) => {
  const body = await readJson(req);
  return json(askWork(p.id!, body.question));
});

// Update a unit of Work's dispatch PRIORITY (LEAF-only); body {priority}. 409 on a node.
route("POST", "/api/work/:id/priority", async (req, p) => {
  const body = await readJson(req);
  return json(prioritizeWork(p.id!, body.priority));
});

// Replace a unit of Work's dependency set (LEAF-only this step); body {blocked_by}. Both PUT
// and POST accepted (mirrors the task blocked_by route). 409 on a node.
async function workBlockedByHandler(req: Request, p: Record<string, string>): Promise<Response> {
  const body = await readJson(req);
  return json(await setWorkBlockedBy(p.id!, body.blocked_by ?? []));
}
route("PUT", "/api/work/:id/blocked_by", workBlockedByHandler);
route("POST", "/api/work/:id/blocked_by", workBlockedByHandler);

// ---- WORK PARITY OPS (leaf reads / leaf actions / node actions) ------------
// The remaining `/api/work/:id/*` surfaces that mirror the split `/api/tasks/:id/*` +
// `/api/stories/:id/*` ops over the unified vocabulary, so `/api/work` is a TRUE superset
// before `/api/tasks` + `/api/stories` are deleted (the later 6e cutover). Each LEAF op 409s
// on a node and each NODE op 409s on a leaf (see work-api guards). Still ADDITIVE — the split
// routes above stay byte-identical until the deliberate cutover/restart.

// LEAF working-tree diff. 409 on a node. Mirrors GET /api/tasks/:id/diff.
route("GET", "/api/work/:id/diff", async (_req, p) => json({ diff: await diffWork(p.id!) }));

// LEAF merge-readiness snapshot. 409 on a node. Mirrors GET /api/tasks/:id/readiness.
route("GET", "/api/work/:id/readiness", async (_req, p) => json(await readinessWork(p.id!)));

// LEAF duration + dependency-chain estimate. 409 on a node. Mirrors GET /api/tasks/:id/estimate.
route("GET", "/api/work/:id/estimate", async (_req, p) => json(estimateWork(p.id!)));

// LEAF status-transition audit timeline. 409 on a node. Mirrors GET /api/tasks/:id/events.
route("GET", "/api/work/:id/events", async (_req, p) => json(eventsWork(p.id!)));

// LEAF live agent terminal output (best-effort). 409 on a node. Mirrors GET /api/tasks/:id/output.
route("GET", "/api/work/:id/output", async (_req, p) => {
  const t = assertWorkLeaf(p.id!, "read output for");
  const output = t.has_agent ? await herdr.agentRead(p.id!) : "";
  return json({ output });
});

// LEAF agent transcript (paginated). 409 on a node. Mirrors GET /api/tasks/:id/transcript.
route("GET", "/api/work/:id/transcript", async (req, p) => {
  assertWorkLeaf(p.id!, "read a transcript for");
  const ctx = taskSessionContext(p.id!);
  const all = ctx ? readSessionTranscript(ctx.wt, ctx.sessionId) : [];
  const total = all.length;
  const url = new URL(req.url);
  const offset = intParam(url, "offset", { def: 0, max: total });
  const limit = intParam(url, "limit", { def: 200, max: 500 });
  const turns = all.slice(offset, offset + limit);
  return json({ turns, total, offset, limit, hasMore: offset + turns.length < total });
});

// LEAF live activity pulse. 409 on a node. Mirrors GET /api/tasks/:id/activity.
route("GET", "/api/work/:id/activity", async (_req, p) => {
  assertWorkLeaf(p.id!, "read activity for");
  const ctx = taskSessionContext(p.id!);
  const activity = ctx
    ? readSessionActivity(ctx.wt, ctx.sessionId)
    : { lastAction: null, lastAt: null };
  const t = getTask(p.id!)!; // assertWorkLeaf proved the leaf row exists
  const startMs = t.started_at ? Date.parse(t.started_at) : NaN;
  const elapsedMs = Number.isFinite(startMs) ? Math.max(0, Date.now() - startMs) : null;
  return json({ ...activity, elapsedMs });
});

// Submit the SPEC for a LEAF parked in `idea`. 409 on a node. Mirrors POST /api/tasks/:id/spec.
route("POST", "/api/work/:id/spec", async (req, p) => {
  const body = await readJson(req);
  return json(await specWork(p.id!, body.spec));
});

// LEAF plan approve/reject (plan-preview step). 409 on a node. Mirrors POST /api/tasks/:id/plan/*.
route("POST", "/api/work/:id/plan/approve", async (req, p) => {
  const body = await readJson(req).catch(() => ({}));
  return json(await planApproveWork(p.id!, body.note ?? body.feedback));
});
route("POST", "/api/work/:id/plan/reject", async (req, p) => {
  const body = await readJson(req);
  return json(await planRejectWork(p.id!, body.note ?? body.feedback));
});

// Update a LEAF's declared version_bump level. 409 on a node. Mirrors POST /api/tasks/:id/version_bump.
route("POST", "/api/work/:id/version_bump", async (req, p) => {
  const body = await readJson(req);
  return json(versionBumpWork(p.id!, body.version_bump));
});

// MAJOR double-confirm on a LEAF — flag-shaped response (conflict/revert/awaiting). 409 on a
// node. Mirrors POST /api/tasks/:id/confirm-major.
route("POST", "/api/work/:id/confirm-major", async (_req, p) => {
  const r = await confirmMajorWork(p.id!);
  if (r.conflictSentBack) return json({ task: r.task, conflictSentBack: true });
  if (r.revertedOnRed) return json({ task: r.task, revertedOnRed: true });
  if (r.awaitingMajorConfirm) return json({ task: r.task, awaitingMajorConfirm: true });
  if (r.storyClosed) return json({ task: r.task, storyClosed: true, message: r.message });
  return json(r.task);
});

// ABORT a LEAF. 409 on a node (a node is reset/deleted). Mirrors POST /api/tasks/:id/abort.
route("POST", "/api/work/:id/abort", async (_req, p) => json(await abortWork(p.id!)));

// NUDGE a LEAF's idle build agent (optional {text}). 409 on a node. Mirrors POST /api/tasks/:id/nudge.
route("POST", "/api/work/:id/nudge", async (req, p) => {
  const body = await readJson(req);
  return json(await nudgeWork(p.id!, body.text));
});

// REQUEUE a LEAF that gave up dispatching. 409 on a node. Mirrors POST /api/tasks/:id/requeue.
route("POST", "/api/work/:id/requeue", async (_req, p) => json(await requeueWork(p.id!)));

// REPARENT a LEAF under a node, or clear it (body {parent_id: string|null}) — the unified form
// of POST /api/tasks/:id/story (assign-to-story). 409 on a node.
route("POST", "/api/work/:id/parent", async (req, p) => {
  const body = await readJson(req);
  return json(reparentWork(p.id!, body.parent_id ?? null));
});

// Open a GUI terminal attached to a LEAF's live agent pane. 409 on a node or no live agent.
// Mirrors POST /api/tasks/:id/terminal.
route("POST", "/api/work/:id/terminal", async (_req, p) => {
  const t = assertWorkLeaf(p.id!, "attach a terminal to");
  if (!t.has_agent) {
    throw new HttpError(409, `work has no live agent to attach to (status=${t.status})`);
  }
  return attachAgentTerminal(p.id!);
});

// DELETE a NODE (member leaves' parent pointer is cleared, not deleted). 409 on a leaf (abort
// it instead). Mirrors DELETE /api/stories/:id.
route("DELETE", "/api/work/:id", async (_req, p) => {
  deleteWork(p.id!);
  return json({ ok: true });
});

// RESET a NODE — abort all in-flight children so the leader can re-decompose. 409 on a leaf.
// Mirrors POST /api/stories/:id/reset.
route("POST", "/api/work/:id/reset", async (_req, p) => json(await resetWork(p.id!)));

// Shared pane-attach: spawn a GUI terminal attached to a herdr AGENT by name (a
// task's agent name is its id; the managed CTO agent has its own fixed name). Used by
// BOTH the task terminal button and the CTO terminal button so the attach machinery
// lives in one place. Returns the OpenResult json or throws a 503 with the manual
// fallback command.
async function attachAgentTerminal(agentName: string): Promise<Response> {
  const res = await openTerminal(attachArgv(agentName));
  if (!res.ok) {
    throw new HttpError(
      503,
      `couldn't open a terminal automatically — run this yourself: ${res.command}`,
    );
  }
  return json(res);
}

// ---- MANAGED CTO AGENT (PER-WORKSPACE) -------------------------------------
// butchr runs ONE CTO agent PER REGISTERED WORKSPACE (src/cto-agent.ts) — a
// first-class, channel-connected Claude session that runs in that repo's ROOT and IS
// the project's principal/dev agent, with no worktree/branch/review/merge. These
// routes are all SCOPED to a workspace: status + start/stop/restart controls + an
// 'Open CTO terminal' attach (reusing the same pane-attach machinery as the
// workspace-agent terminal button). Each mutating route returns the refreshed
// CtoStatus (the lifecycle calls also publish a `cto.updated` SSE event so every
// dashboard reflects it live). 404 if the workspace is gone.
route("GET", "/api/workspaces/:id/cto", async (_req, p) => {
  requireWorkspace(p.id!);
  return json(await ctoAgentStatus(p.id!));
});
route("POST", "/api/workspaces/:id/cto/start", async (_req, p) => {
  requireWorkspace(p.id!);
  return json(await startCtoAgent(p.id!));
});
route("POST", "/api/workspaces/:id/cto/stop", async (_req, p) => {
  requireWorkspace(p.id!);
  return json(await stopCtoAgent(p.id!));
});
// `?fresh=1` cold-starts a BRAND-NEW session (the only way to do so — last-resort
// context hygiene); otherwise it bounces, RESUMING the same session.
route("POST", "/api/workspaces/:id/cto/restart", async (req, p) => {
  requireWorkspace(p.id!);
  const fresh = new URL(req.url).searchParams.get("fresh") === "1";
  return json(await restartCtoAgent(p.id!, { fresh }));
});
// Open a GUI terminal attached to this workspace's CTO agent's live pane.
route("POST", "/api/workspaces/:id/cto/terminal", async (_req, p) => {
  requireWorkspace(p.id!);
  const s = await ctoAgentStatus(p.id!);
  if (!s.running) {
    throw new HttpError(409, "CTO agent has no live pane (not running)");
  }
  return attachAgentTerminal(ctoAgentName(p.id!));
});

/** Boot the HTTP server (REST + SSE) on `config.host:config.port`, wiring routing, CORS/CSRF, and error handling. Returns the running server so callers/tests can `.stop()` it. */
export function startServer(): ReturnType<typeof Bun.serve> {
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    idleTimeout: 0,
    // Cap request bodies at 1 MiB. No API body (a task brief, context list, etc.) is
    // legitimately larger; this bounds memory and rejects an oversized/abusive payload
    // before readJson buffers it. Bun answers an over-cap request with 413.
    maxRequestBodySize: 1024 * 1024,
    async fetch(req) {
      const url = new URL(req.url);
      const { pathname } = url;

      if (pathname === "/api/events") return sseResponse();

      // Bare /health alias (supervisors often probe a top-level path) — the same
      // payload is also served under /api/health via the router below.
      if (pathname === "/health") {
        try {
          return await healthResponse();
        } catch (e) {
          return errResponse(e);
        }
      }

      // Per-task MCP endpoint the interactive agent connects to for the
      // request_review handshake. Identity is the path param.
      if (pathname.startsWith("/mcp/")) {
        const taskId = decodeURIComponent(pathname.slice("/mcp/".length).split("/")[0] ?? "");
        if (!taskId) return json({ error: "missing task id" }, 404);
        try {
          return await handleMcp(req, taskId);
        } catch (e) {
          return errResponse(e);
        }
      }

      if (pathname.startsWith("/api/")) {
        // CSRF / DNS-rebinding guard: reject forged cross-site state-changing
        // browser requests before they reach any handler (no-Origin CLI/MCP/curl
        // and same-origin webapp requests pass through). See csrfGuard above.
        const blocked = csrfGuard(req, url);
        if (blocked) return blocked;
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = r.pattern.exec(pathname);
          if (!m) continue;
          const params: Record<string, string> = {};
          r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
          try {
            return await r.handler(req, params);
          } catch (e) {
            return errResponse(e);
          }
        }
        return json({ error: "not found" }, 404);
      }

      return serveStatic(pathname);
    },
  });
  console.log(
    `[butchr] listening on http://${server.hostname}:${server.port}`,
  );
  return server;
}
