// REVAMP-4 Phase 3 / P3c (story st-04869886) — the two pure-additive READ surfaces the Projects UI
// needs: GET /api/projects (list all project nodes, newest-first) and GET /api/projects/:id/ceo
// (the CEO-agent status card: { enabled, overridden, globalGate, live }). The REVAMP-4 tier shipped
// create/write + per-id reads but NO list/status reads, so a real Projects UI was impossible; these
// fill the gap without any schema/write/behavior change (GET /api/projects previously 404'd).
//
// Boot model mirrors cli-work-routes.test.ts: the REAL server runs in a SUBPROCESS on an ephemeral
// port (BUTCHR_PORT=0) against a private BUTCHR_DB, with BUTCHR_HERDR_BIN=`true` so every herdr probe
// is a harmless no-op and BUTCHR_CEO_AGENT=`0` so the global gate is a KNOWN false. We drive the real
// routes over raw fetch and assert the read shapes + the 404.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SERVER_PATH = join(ROOT, "src", "server.ts");

let DATA_DIR: string;
let REPO_ROOT: string;
let serverProc: ReturnType<typeof Bun.spawn>;
let BASE: string;
let WS: string; // the registered anchor directory (one path → one registration)

/** Read the subprocess's stdout until it logs the bound port, or throw on timeout. */
async function waitForPort(stream: ReadableStream<Uint8Array>, timeoutMs: number): Promise<number> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      const m = buf.match(/listening on http:\/\/[^:]+:(\d+)/);
      if (m) return Number(m[1]);
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error(`server did not report a listening port within ${timeoutMs}ms:\n${buf}`);
}

async function apiGet(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
async function apiSend(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-projceo-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-projceo-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  // A real git repo with one commit — a project anchors to a registered directory.
  execFileSync("git", ["init", "-q", REPO_ROOT], { stdio: "ignore" });
  const g = (args: string[]) => execFileSync("git", ["-C", REPO_ROOT, ...args], { stdio: "ignore" });
  g(["config", "user.email", "test@butchr.local"]);
  g(["config", "user.name", "butchr test"]);
  g(["commit", "--allow-empty", "-q", "-m", "init"]);

  serverProc = Bun.spawn({
    cmd: ["bun", "-e", `import(${JSON.stringify(SERVER_PATH)}).then((m) => m.startServer())`],
    cwd: ROOT,
    env: {
      ...process.env,
      BUTCHR_PORT: "0",
      BUTCHR_DATA_DIR: DATA_DIR,
      BUTCHR_DB: join(DATA_DIR, "test.db"),
      BUTCHR_LOG_FILE: "",
      BUTCHR_HERDR_BIN: "true",
      BUTCHR_CTO_AGENT: "0",
      BUTCHR_CEO_AGENT: "0", // globalGate is a KNOWN false
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const port = await waitForPort(serverProc.stdout as ReadableStream<Uint8Array>, 25000);
  BASE = `http://127.0.0.1:${port}`;

  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok || res.status === 503) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  // Register the anchor directory ONCE (a path registers exactly once); projects anchor to it.
  const ws = await apiSend("POST", "/api/workspaces", { path: REPO_ROOT });
  WS = ws.id;
}, 30000);

afterAll(() => {
  try {
    serverProc?.kill();
  } catch {
    /* already gone */
  }
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

test("GET /api/projects lists a created project node (newest-first, global)", async () => {
  // `workspace` is the REMOVED anchor param — a stale caller sending it is ignored silently.
  const project = await apiSend("POST", "/api/projects", { workspace: WS, brief: "read-routes proj" });
  expect(project.work_kind).toBe("project");

  const list = await apiGet("/api/projects");
  expect(list.status).toBe(200);
  expect(Array.isArray(list.body)).toBe(true);
  const found = list.body.find((p: any) => p.id === project.id);
  expect(found).toBeTruthy();
  // The accessor's projected columns are present.
  // Self-hosted anchor — NOT the ignored `workspace` the caller passed.
  expect(found.workspace_id).toBe(`ceo-dir-${project.id}`);
  expect(found.workspace_id).not.toBe(WS);
  expect(found.brief).toBe("read-routes proj");
  expect(found.status).toBe("merged"); // the inert project-node anchor
  expect(found.ceo_enabled).toBeNull(); // no override yet
  expect(found.created_at).toBeTruthy();
});

test("GET /api/projects/:id/ceo returns the 4-field CEO status; override flips enabled/overridden", async () => {
  const project = await apiSend("POST", "/api/projects", { workspace: WS });

  // Default: no override, global gate OFF → not enabled, not overridden.
  const before = await apiGet(`/api/projects/${encodeURIComponent(project.id)}/ceo`);
  expect(before.status).toBe(200);
  expect(before.body).toEqual({
    enabled: false,
    overridden: false,
    globalGate: false,
    live: false,
  });

  // Force the CEO on for this project → explicit override + enabled.
  await apiSend("PATCH", `/api/projects/${encodeURIComponent(project.id)}`, { ceo_enabled: true });
  const after = await apiGet(`/api/projects/${encodeURIComponent(project.id)}/ceo`);
  expect(after.status).toBe(200);
  expect(after.body.enabled).toBe(true);
  expect(after.body.overridden).toBe(true);
  expect(after.body.globalGate).toBe(false);
  expect(typeof after.body.live).toBe("boolean"); // desired && running (no live herdr → false)
});

test("GET /api/projects/:id/ceo 404s for a bogus id", async () => {
  const res = await apiGet("/api/projects/proj-does-not-exist/ceo");
  expect(res.status).toBe(404);
});
