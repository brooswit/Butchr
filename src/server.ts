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
  isTerminal,
  listTaskEvents,
  metricRows,
  REVIEW_STATES,
  STATE_META,
  sumStatuses,
} from "./db.ts";
import type { WorkspaceRow, TaskRow } from "./db.ts";
import { currentPaneRepairing, dispatcherHealth, isPaused, setPaused } from "./dispatcher.ts";
import {
  HttpError,
  dashboard,
  getWorkspace,
  getWorkspaceByPath,
  listWorkspaces,
  registerWorkspace,
  setWorkspaceCtoEnabled,
  setWorkspaceReleaseMode,
  unregisterWorkspace,
  updateWorkspaceChangelogPath,
  updateWorkspaceGateCmd,
  updateWorkspaceStepResponders,
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
import {
  abortTask,
  answerTask,
  approveTask,
  confirmMajor,
  createTask,
  getTask,
  nudgeTask,
  rejectTask,
  requeueTask,
  setBlockedBy,
  setPriority,
  setVersionBump,
  submitSpec,
  taskChainEstimate,
  taskDiff,
  taskEstimate,
  taskListView,
  taskView,
} from "./tasks.ts";
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
function sseResponse(): Response {
  let unsub: () => void = () => {};
  const stream = new ReadableStream({
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
      const ka = setInterval(() => {
        try {
          controller.enqueue(enc.encode(`: keepalive\n\n`));
        } catch {
          /* closed */
        }
      }, 25000);
      unsub = subscribe(send);
      // store cleanup on the controller via closure
      (controller as any)._cleanup = () => {
        clearInterval(ka);
        unsub();
      };
    },
    cancel() {
      unsub();
    },
  });
  return new Response(stream, {
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
          `SELECT status, COUNT(*) AS n FROM tasks GROUP BY status`,
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
  const needsAttention = {
    spec_review: tasks.spec_review ?? 0,
    in_review: tasks.in_review ?? 0,
    needs_info: tasks.needs_info ?? 0,
    failed: tasks.failed ?? 0,
    // Summed over the shared REVIEW_STATES membership (db.ts) — the single source for
    // the operator pull-signal, identical to the open-coded sum it replaces.
    total: sumStatuses(tasks, REVIEW_STATES),
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
    uptimeSec: Math.round(process.uptime()),
    // DISPATCHER PAUSE: true while NEW agent dispatch is halted (maintenance /
    // drain-only mode). Running/review/idle tasks are unaffected; this only gates
    // launching queued tasks. Persisted, so it survives a restart. The webapp keys
    // its PAUSED banner + pause/resume control off this.
    paused: isPaused(),
    db: { ok: dbOk },
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

// Workspaces
route("GET", "/api/workspaces", async () => json(listWorkspaces()));

// A single workspace's DETAIL view: the WorkspaceView (counts + columns) with the
// FULLY-RESOLVED step-responder map attached (every step present with its effective
// `cto`/`user` value — see workspaces.resolveStepResponders). This resolved shape is the
// single source the webapp's step-responder panel and the later feedback-routing tasks
// read. 404 if the workspace is gone.
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
//  - `step_responders`: a PARTIAL {step: 'cto'|'user'} update of the feedback-workflow
//    step-responder config — merged onto the existing overrides (validated step names +
//    values; CONFIG ONLY, nothing routes off it yet). See workspaces.updateWorkspaceStepResponders.
//  - `release_mode`: the per-workspace VERSIONED-RELEASES mode (true/false; null = off) —
//    when on, every merge bumps the version + stamps the changelog with a versioned heading
//    and the changelog gate is strict. See workspaces.setWorkspaceReleaseMode.
// A bare PATCH (no recognized key) clears the gate command, preserving the legacy
// contract. 404 if the workspace is gone. Publishes `workspace.updated`.
route("PATCH", "/api/workspaces/:id", async (req, p) => {
  const body = await readJson(req);
  let view;
  if ("cto_enabled" in body) view = setWorkspaceCtoEnabled(p.id!, body.cto_enabled);
  if ("version_file" in body) view = updateWorkspaceVersionFile(p.id!, body.version_file);
  if ("changelog_path" in body) view = updateWorkspaceChangelogPath(p.id!, body.changelog_path);
  if ("step_responders" in body) view = updateWorkspaceStepResponders(p.id!, body.step_responders);
  if ("release_mode" in body) view = setWorkspaceReleaseMode(p.id!, body.release_mode);
  // gate_cmd: set when its key is present, OR when NO other recognized key was sent
  // (a bare PATCH clears the gate override — the legacy contract).
  const touchedOther =
    "cto_enabled" in body || "version_file" in body || "changelog_path" in body ||
    "step_responders" in body || "release_mode" in body;
  if ("gate_cmd" in body || !touchedOther) {
    view = updateWorkspaceGateCmd(p.id!, body.gate_cmd ?? null);
  }
  return json(view!);
});

route("DELETE", "/api/workspaces/:id", async (_req, p) => {
  await unregisterWorkspace(p.id!);
  return json({ ok: true });
});

// Optional `?q=` is a case-insensitive FULL-TEXT SEARCH over each task's prompt
// (task.md), request_review summary, review notes, and id — filtered SERVER-SIDE so
// huge prompt bodies never ship to the client (the list projection omits them). A
// blank/absent q returns the full list unchanged. See tasks.taskListView.
route("GET", "/api/workspaces/:id/tasks", async (req, p) => {
  requireWorkspace(p.id!);
  const q = new URL(req.url).searchParams.get("q") ?? undefined;
  return json(taskListView(p.id!, q));
});

route("POST", "/api/workspaces/:id/tasks", async (req, p) => {
  const body = await readJson(req);
  // Optional blocked_by: [taskId,...] — the task starts `blocked` until every
  // listed blocker has merged (validated + cycle-checked inside createTask).
  // Optional kind: the built-in `rollback` template (the webapp's "Roll back" button)
  // creates a 'rollback'-kind task — it builds a revert like any task but lands via its
  // own `rolling_back`→`rolled_back` lifecycle tail (see tasks.finalizeMerge). Any other
  // task is an ordinary 'task'.
  const kind =
    body.kind === "rollback" || body.template === "rollback"
      ? "rollback"
      : "task";
  // Optional model: an alias (opus/sonnet/haiku/fable) or full id, threaded into the
  // agent launch. Unset → claude's current default. Validated inside createTask.
  // Optional tags: an array of free-form organizational labels (validated +
  // normalized inside createTask) for filtering the task list.
  // Optional template: create FROM a named built-in template (src/templates.ts) —
  // its body is rendered with `vars` substituted into the `{{placeholders}}` and the
  // result becomes the prompt (any explicit `prompt` is ignored when a template is
  // given). 404 on an unknown template name. The webapp instead renders client-side
  // (fills the textarea), so it posts a plain `prompt` and never this field.
  const prompt = body.template
    ? renderTemplate(body.template, body.vars)
    : body.prompt;
  // Optional priority: an integer (higher = dispatched sooner; default 0) that lets
  // an urgent task jump the dispatch queue. Validated inside createTask.
  // Optional plan_preview: a boolean that opts the task into the PLAN-PREVIEW gate —
  // the agent proposes a plan and pauses for operator approval before writing code
  // (see tasks.createTask / taskmd.renderAgentPrompt). Validated inside createTask.
  // Optional idea: true creates the task in the unified pipeline's FRONT state `idea` —
  // the `prompt` is treated as a one-line operator BRIEF, and the task WAITS (no agent)
  // for the spec-generation responder to submit a spec via POST /api/tasks/:id/spec,
  // which advances it to `spec_review`. Omitted/false is today's ordinary work task,
  // fully backward-compatible. We also honor a legacy
  // `stage: 'idea'` body (the retracted idea→spec→build axis) as `idea: true` so older
  // clients keep working. Validated inside createTask.
  const idea = body.idea === true || body.stage === "idea";
  // Optional version_bump: 'patch' (default) | 'minor' | 'major' — the semver bump applied
  // at merge when the workspace is in release_mode ('major' needs the human double-confirm
  // ritual). Inert outside release_mode. Validated inside createTask.
  const view = await createTask(
    p.id!,
    prompt,
    body.context ?? [],
    body.blocked_by ?? [],
    kind,
    body.model ?? null,
    body.tags ?? [],
    body.priority ?? 0,
    body.plan_preview ?? false,
    idea,
    body.version_bump ?? "patch",
  );
  return json(view, 201);
});

// Tasks
route("GET", "/api/tasks/:id", async (_req, p) => {
  requireTask(p.id!);
  return json(taskView(p.id!));
});

route("GET", "/api/tasks/:id/diff", async (_req, p) => {
  const d = await taskDiff(p.id!);
  return json({ diff: d });
});

// ROUGH duration estimate for a task (see src/estimate.ts): a loose p50–p90 range
// derived from butchr's own history, with the sample size — never a promise.
// `single` is the task's own estimate (also carried on TaskView); `chain` is the
// critical-path total across its dependency chain (a plan's sub-tasks, or this
// task's blockers), or null when there's nothing to chain. 404 if the task is gone.
route("GET", "/api/tasks/:id/estimate", async (_req, p) => {
  requireTask(p.id!);
  return json({ single: taskEstimate(p.id!), chain: taskChainEstimate(p.id!) });
});

// Per-task AUDIT TIMELINE: the ordered log of this task's status transitions
// (oldest → newest), powering the task-detail timeline. 404 if the task is gone.
route("GET", "/api/tasks/:id/events", async (_req, p) => {
  requireTask(p.id!);
  return json(listTaskEvents(p.id!));
});

// Best-effort live snapshot of the agent's recent terminal output, for the task
// page's "Live output" panel. Only meaningful while the task has a live pane;
// returns "" once the pane is gone. Never the source of truth for review.
route("GET", "/api/tasks/:id/output", async (_req, p) => {
  const t = requireTask(p.id!);
  const output = t.herdr_pane_id ? await herdr.agentRead(p.id!) : "";
  return json({ output });
});

// Agent transcript: a readable, ordered view of what the task's Claude session
// actually did — user/assistant prose, the assistant's thinking, tool calls
// (name + brief args), and (truncated) tool results — parsed from the session
// JSONL. Read-only and best-effort: returns an empty list (not a 404) when the
// task has no session yet or its transcript can't be located/read. Paginated via
// `?offset=&limit=` (limit clamped to 1..500, default 200) since a long session
// produces hundreds of turns; `total` and `hasMore` let the UI page or "load more".
route("GET", "/api/tasks/:id/transcript", async (req, p) => {
  // The transcript lives under ~/.claude/projects (outside the worktree), so it
  // survives worktree cleanup; findTranscript falls back to a by-session-id scan
  // when the munged worktree path no longer exists (e.g. after merge).
  const ctx = taskSessionContext(p.id!);
  const all = ctx ? readSessionTranscript(ctx.wt, ctx.sessionId) : [];
  const total = all.length;
  const url = new URL(req.url);
  const offset = intParam(url, "offset", { def: 0, max: total });
  const limit = intParam(url, "limit", { def: 200, max: 500 });
  const turns = all.slice(offset, offset + limit);
  return json({ turns, total, offset, limit, hasMore: offset + turns.length < total });
});

// LIVE ACTIVITY PULSE: a cheap, read-only "what is the agent doing right now" for a
// running task's card — the latest meaningful transcript action (last tool call +
// target, or last assistant step) plus how long the task has been running. Reads
// only the TAIL of the session JSONL (see transcript.readSessionActivity), so it's
// safe for the webapp to poll. `lastAction`/`lastAt` are null when no transcript /
// no qualifying step yet; `elapsedMs` is null until the task has started running.
// No actions, no side effects. 404 only if the task itself is gone.
route("GET", "/api/tasks/:id/activity", async (_req, p) => {
  const ctx = taskSessionContext(p.id!);
  const activity = ctx
    ? readSessionActivity(ctx.wt, ctx.sessionId)
    : { lastAction: null, lastAt: null };
  // Re-read the row (still present — taskSessionContext 404s if it isn't) for started_at.
  const t = getTask(p.id!)!;
  const startMs = t.started_at ? Date.parse(t.started_at) : NaN;
  const elapsedMs = Number.isFinite(startMs) ? Math.max(0, Date.now() - startMs) : null;
  return json({ ...activity, elapsedMs });
});

route("POST", "/api/tasks/:id/approve", async (_req, p) => {
  const r = await approveTask(p.id!);
  // Conflict kicked back to the agent: 200 with a flag the UI shows informationally.
  if (r.conflictSentBack) return json({ task: r.task, conflictSentBack: true });
  // Merge fast-forwarded but the post-merge verify gate failed → auto-reverted off
  // main and the task flagged. 200 with a flag so the UI explains the revert.
  if (r.revertedOnRed) return json({ task: r.task, revertedOnRed: true });
  // release_mode + major bump: approve just PARKS the task (it does NOT merge). 200 with a
  // flag so the UI shows the "awaiting major-version confirmation (n/2)" banner + button.
  if (r.awaitingMajorConfirm) return json({ task: r.task, awaitingMajorConfirm: true });
  return json(r.task);
});

// Update a task's declared semver version_bump level ('patch'|'minor'|'major'), applied
// at merge when the workspace is in release_mode. Changing it resets the major-confirm
// streak. 404 if gone; 409 if terminal; 400 on an invalid level. See tasks.setVersionBump.
route("POST", "/api/tasks/:id/version_bump", async (req, p) => {
  const body = await readJson(req);
  return json(setVersionBump(p.id!, body.version_bump));
});

// MAJOR DOUBLE-CONFIRM: the human's confirmation of a major version bump. Must be called
// TWICE CONSECUTIVELY on an in_review release_mode major task (count 0→1→2); the second
// call lands the merge. Any other action in between resets the streak. Always the human —
// never auto-issued. 409 unless the task is in_review + release_mode + version_bump major.
// Mirrors /approve's response shape (conflict / revert / still-awaiting flags). See
// tasks.confirmMajor.
route("POST", "/api/tasks/:id/confirm-major", async (_req, p) => {
  const r = await confirmMajor(p.id!);
  if (r.conflictSentBack) return json({ task: r.task, conflictSentBack: true });
  if (r.revertedOnRed) return json({ task: r.task, revertedOnRed: true });
  if (r.awaitingMajorConfirm) return json({ task: r.task, awaitingMajorConfirm: true });
  return json(r.task);
});

route("POST", "/api/tasks/:id/reject", async (req, p) => {
  const body = await readJson(req);
  return json(await rejectTask(p.id!, body.note));
});

// Answer a task parked in `needs_info` (the agent called the MCP `raise` tool).
// This is the unified answer surface shared by the operator CLI (`butchr answer`),
// the webapp answer box, and any API caller. On answer butchr re-queues the task and
// re-launches the SAME agent session via `--resume` with the answer injected (see
// tasks.answerTask). 409 if not awaiting input; 400 if the answer is blank.
route("POST", "/api/tasks/:id/answer", async (req, p) => {
  const body = await readJson(req);
  return json(await answerTask(p.id!, body.answer));
});

// Submit the SPEC for a task parked in `idea` (a brief awaiting a spec). The
// spec-generation responder — the persistent CTO agent (when the workspace's
// `spec-generation` responder is `cto`) or a human in the webapp (when it is `user`) —
// POSTs the written spec here. butchr rewrites the task's prompt brief → spec and advances
// idea → spec_review. Both responders use this SAME endpoint; they differ only in surface
// (the CTO reacts to the channel `spec requested` push, the user fills the webapp form).
// 409 if the task isn't in `idea`; 400 if the spec is blank.
route("POST", "/api/tasks/:id/spec", async (req, p) => {
  const body = await readJson(req);
  return json(await submitSpec(p.id!, body.spec));
});

route("POST", "/api/tasks/:id/abort", async (_req, p) => {
  return json(await abortTask(p.id!));
});

// IDLE-HANDLING ACTION: nudge a live build agent that has gone `idle` (the graceful
// replacement for the old blind auto-"continue"). A bare nudge sends `continue`; an
// optional `text` sends operator/CTO GUIDANCE instead — surfaced to whoever the
// workspace's `idle-handling` responder is (the CTO agent via the channel idle event, or
// a human via the webapp idle panel). Guarded on liveness: a dead-shell pane is NOT poked
// — it routes to auto-resume (requeueForResume) inside nudgeTask. 404 if gone; 409 if the
// task has no live agent to nudge. Requeue/abort reuse the existing /requeue + /abort.
route("POST", "/api/tasks/:id/nudge", async (req, p) => {
  const body = await readJson(req);
  return json(await nudgeTask(p.id!, body.text));
});

// Replace a task's dependency set (its blocked_by). Allowed on any NON-terminal
// task (queued/blocked/running/review); 409 on merged/aborted/rejected/failed.
// After updating it RE-EVALUATES: a now-satisfiable task moves toward queued, and
// a newly-blocked task with a live agent is killed-on-block (see tasks.setBlockedBy).
// Both PUT and POST are accepted for convenience.
async function blockedByHandler(req: Request, p: Record<string, string>): Promise<Response> {
  const body = await readJson(req);
  return json(await setBlockedBy(p.id!, body.blocked_by ?? []));
}
route("PUT", "/api/tasks/:id/blocked_by", blockedByHandler);
route("POST", "/api/tasks/:id/blocked_by", blockedByHandler);

// Update a task's dispatch PRIORITY (higher = dispatched sooner; default 0). Lets
// an urgent queued task jump ahead of older lower-priority ones — the dispatcher
// orders queued tasks by `priority DESC, created_at ASC` (see
// dispatcher.selectQueuedForDispatch). 404 if the task is gone; 400 if priority
// isn't an integer.
route("POST", "/api/tasks/:id/priority", async (req, p) => {
  const body = await readJson(req);
  return json(setPriority(p.id!, body.priority));
});

// Operator escape hatch: revive a task that gave up dispatching (`failed`) — or
// any other non-terminal stuck state — by clearing its dispatch retry state and
// re-queuing it for a fresh dispatch.
route("POST", "/api/tasks/:id/requeue", async (_req, p) => {
  return json(await requeueTask(p.id!));
});

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

// Open a GUI terminal attached to a task's live agent pane. Only `running` tasks
// have a live pane to attach to — the agent exits after the non-blocking
// request_review, so `review` (and queued/merged/aborted) have no pane.
route("POST", "/api/tasks/:id/terminal", async (_req, p) => {
  const t = requireTask(p.id!);
  // Gate on an actual live pane rather than a specific status — only a running
  // agent has a pane (herdr_pane_id set); everything else has nothing to attach to.
  if (!t.herdr_pane_id) {
    throw new HttpError(409, `task has no live agent pane (status=${t.status})`);
  }
  // herdr may have RENUMBERED the pane since launch (a sibling tab closed), so the
  // stored id can now point at a dead sibling shell. Re-resolve the CURRENT pane by
  // name and self-heal the stored id. (`agent attach` already targets by name, so the
  // attach itself is correct regardless — this keeps the recorded id truthful and is
  // the use-time reconciliation the spec mandates for every pane-touching path.)
  await currentPaneRepairing(p.id!);
  return attachAgentTerminal(p.id!);
});

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
  if (!s.running || !s.paneId) {
    throw new HttpError(409, "CTO agent has no live pane (not running)");
  }
  return attachAgentTerminal(ctoAgentName(p.id!));
});

/** Boot the HTTP server (REST + SSE) on `config.host:config.port`, wiring routing, CORS/CSRF, and error handling. */
export function startServer(): void {
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    idleTimeout: 0,
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
}
