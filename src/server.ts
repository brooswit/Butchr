// HTTP layer: REST API + SSE + static webapp, all on one Bun.serve.
import { join } from "node:path";
import { config } from "./config.ts";
import {
  HttpError,
  getDirectory,
  listDirectories,
  registerDirectory,
  unregisterDirectory,
} from "./directories.ts";
import { subscribe } from "./events.ts";
import type { ButchrEvent } from "./events.ts";
import {
  approveTask,
  createTask,
  listTasks,
  rejectTask,
  taskDiff,
  taskView,
} from "./tasks.ts";

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
  return json(listTasks(p.id!));
});

route("POST", "/api/directories/:id/tasks", async (req, p) => {
  const body = await readJson(req);
  const view = await createTask(p.id!, body.prompt, body.context ?? []);
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

route("POST", "/api/tasks/:id/approve", async (_req, p) => {
  return json(await approveTask(p.id!));
});

route("POST", "/api/tasks/:id/reject", async (req, p) => {
  const body = await readJson(req);
  return json(await rejectTask(p.id!, body.note));
});

export function startServer(): void {
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const { pathname } = url;

      if (pathname === "/api/events") return sseResponse();

      if (pathname.startsWith("/api/")) {
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
