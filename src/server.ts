// HTTP layer: REST API + SSE + static webapp, all on one Bun.serve.
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { config } from "./config.ts";
import { computeMetrics, db, listTaskEvents, metricRows } from "./db.ts";
import { dispatcherHealth, isPaused, setPaused } from "./dispatcher.ts";
import {
  HttpError,
  getDirectory,
  listDirectories,
  registerDirectory,
  unregisterDirectory,
} from "./directories.ts";
import { publish, subscribe } from "./events.ts";
import type { ButchrEvent } from "./events.ts";
import * as herdr from "./herdr.ts";
import { handleMcp } from "./mcp.ts";
import { getLastReap } from "./reaper.ts";
import pkg from "../package.json" with { type: "json" };
import {
  abortTask,
  approveTask,
  createTask,
  getTask,
  rejectTask,
  requeueTask,
  rollbackTask,
  setBlockedBy,
  taskChainEstimate,
  taskDiff,
  taskEstimate,
  taskListView,
  taskView,
} from "./tasks.ts";
import { attachArgv, openTerminal } from "./terminal.ts";
import { readSessionTranscript } from "./transcript.ts";
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

  // Activity snapshot: an "active" task is one with a live dispatch footprint
  // (status running | review | finalizing). Derived from the same status counts
  // above so we issue no extra queries. Tasks dispatch uncapped — every queued
  // task is launched as soon as it's seen.
  const concurrency = {
    active: (tasks.running ?? 0) + (tasks.review ?? 0) + (tasks.finalizing ?? 0),
    queued: tasks.queued ?? 0,
  };

  // Operator pull-signal: tasks that need a human's eyes right now — ones waiting
  // in `review` and ones that gave up dispatching (`failed`). The webapp turns this
  // into a tab-title badge + header indicator so the operator gets pulled in rather
  // than polling. Derived from the status counts above; no extra query.
  const needsAttention = {
    review: tasks.review ?? 0,
    failed: tasks.failed ?? 0,
    total: (tasks.review ?? 0) + (tasks.failed ?? 0),
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
    // Convenience count of tasks that gave up dispatching (status='failed').
    // The `tasks` map above already includes it via GROUP BY, but surface it
    // directly so dispatch give-ups are visible at a glance.
    failedTasks: tasks.failed ?? 0,
    concurrency,
    needsAttention,
    // Self-heal visibility: last startup reap of orphaned worktrees + herdr husks.
    reaper: { lastRunAt: reap.at, worktrees: reap.worktrees, husks: reap.husks },
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
  // Directories first, then files; alphabetical within each group.
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
  const raw = Number(url.searchParams.get("days"));
  const days = Number.isFinite(raw) && raw > 0 ? Math.min(90, Math.floor(raw)) : 14;
  return json(computeMetrics(metricRows(), Date.now(), days));
});

// Directories
route("GET", "/api/directories", async () => json(listDirectories()));

route("POST", "/api/directories", async (req) => {
  const body = await readJson(req);
  const view = await registerDirectory(body.path, body.label);
  return json(view, 201);
});

route("DELETE", "/api/directories/:id", async (_req, p) => {
  await unregisterDirectory(p.id!);
  return json({ ok: true });
});

route("GET", "/api/directories/:id/tasks", async (_req, p) => {
  if (!getDirectory(p.id!)) throw new HttpError(404, "directory not found");
  return json(taskListView(p.id!));
});

route("POST", "/api/directories/:id/tasks", async (req, p) => {
  const body = await readJson(req);
  // Optional blocked_by: [taskId,...] — the task starts `blocked` until every
  // listed blocker has merged (validated + cycle-checked inside createTask).
  // Optional kind: "plan" creates an AUTO-DECOMPOSE task that breaks the request
  // into sub-tasks via the propose_subtasks MCP tool instead of writing code.
  const kind = body.kind === "plan" ? "plan" : "task";
  // Optional model: an alias (opus/sonnet/haiku/fable) or full id, threaded into the
  // agent launch. Unset → claude's current default. Validated inside createTask.
  const view = await createTask(
    p.id!,
    body.prompt,
    body.context ?? [],
    body.blocked_by ?? [],
    kind,
    body.model ?? null,
  );
  return json(view, 201);
});

// Tasks
route("GET", "/api/tasks/:id", async (_req, p) => {
  const v = taskView(p.id!);
  if (!v) throw new HttpError(404, "task not found");
  return json(v);
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
  if (!getTask(p.id!)) throw new HttpError(404, "task not found");
  return json({ single: taskEstimate(p.id!), chain: taskChainEstimate(p.id!) });
});

// Per-task AUDIT TIMELINE: the ordered log of this task's status transitions
// (oldest → newest), powering the task-detail timeline. 404 if the task is gone.
route("GET", "/api/tasks/:id/events", async (_req, p) => {
  if (!getTask(p.id!)) throw new HttpError(404, "task not found");
  return json(listTaskEvents(p.id!));
});

// Best-effort live snapshot of the agent's recent terminal output, for the task
// page's "Live output" panel. Only meaningful while the task has a live pane;
// returns "" once the pane is gone. Never the source of truth for review.
route("GET", "/api/tasks/:id/output", async (_req, p) => {
  const t = getTask(p.id!);
  if (!t) throw new HttpError(404, "task not found");
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
  const t = getTask(p.id!);
  if (!t) throw new HttpError(404, "task not found");
  const dir = getDirectory(t.directory_id);
  // The transcript lives under ~/.claude/projects (outside the worktree), so it
  // survives worktree cleanup; findTranscript falls back to a by-session-id scan
  // when the munged worktree path no longer exists (e.g. after merge).
  const all =
    dir && t.session_id
      ? readSessionTranscript(worktreePath(dir.path, p.id!), t.session_id)
      : [];
  const total = all.length;
  const url = new URL(req.url);
  const rawOffset = Number(url.searchParams.get("offset"));
  const rawLimit = Number(url.searchParams.get("limit"));
  const offset =
    Number.isFinite(rawOffset) && rawOffset > 0 ? Math.min(Math.floor(rawOffset), total) : 0;
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(500, Math.floor(rawLimit)) : 200;
  const turns = all.slice(offset, offset + limit);
  return json({ turns, total, offset, limit, hasMore: offset + turns.length < total });
});

route("POST", "/api/tasks/:id/approve", async (_req, p) => {
  const r = await approveTask(p.id!);
  // Conflict kicked back to the agent: 200 with a flag the UI shows informationally.
  if (r.conflictSentBack) return json({ task: r.task, conflictSentBack: true });
  // Merge fast-forwarded but the post-merge verify gate failed → auto-reverted off
  // main and the task flagged. 200 with a flag so the UI explains the revert.
  if (r.revertedOnRed) return json({ task: r.task, revertedOnRed: true });
  return json(r.task);
});

route("POST", "/api/tasks/:id/reject", async (req, p) => {
  const body = await readJson(req);
  return json(await rejectTask(p.id!, body.note));
});

route("POST", "/api/tasks/:id/abort", async (_req, p) => {
  return json(await abortTask(p.id!));
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

// Operator escape hatch: revive a task that gave up dispatching (`failed`) — or
// any other non-terminal stuck state — by clearing its dispatch retry state and
// re-queuing it for a fresh dispatch.
route("POST", "/api/tasks/:id/requeue", async (_req, p) => {
  return json(await requeueTask(p.id!));
});

// One-click rollback: revert an already-merged task's commits off the default
// branch. Only valid for a `merged` task whose merge range was recorded; surfaces
// a 409 with a clear message on a revert conflict (tree left clean). Serialized
// through the same merge queue as approve (see tasks.rollbackTask).
route("POST", "/api/tasks/:id/rollback", async (_req, p) => {
  return json(await rollbackTask(p.id!));
});

// Open a GUI terminal attached to a task's live agent pane. Only `running` tasks
// have a live pane to attach to — the agent exits after the non-blocking
// request_review, so `review` (and queued/merged/aborted) have no pane.
route("POST", "/api/tasks/:id/terminal", async (_req, p) => {
  const t = getTask(p.id!);
  if (!t) throw new HttpError(404, "task not found");
  // Gate on an actual live pane rather than a specific status — only a running
  // agent has a pane (herdr_pane_id set); everything else has nothing to attach to.
  if (!t.herdr_pane_id) {
    throw new HttpError(409, `task has no live agent pane (status=${t.status})`);
  }
  const argv = attachArgv(p.id!);
  const res = await openTerminal(argv);
  if (!res.ok) {
    throw new HttpError(
      503,
      `couldn't open a terminal automatically — run this yourself: ${res.command}`,
    );
  }
  return json(res);
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
