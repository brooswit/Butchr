// REGRESSION GUARD for bin/butchr ↔ the unified `/api/work` server (story st-f61b3561).
//
// The Work+Workspace cutover deleted the split `/api/tasks/*` + `/api/stories/*` routes (and
// `POST /api/workspaces/:id/{tasks,stories}`, `GET /api/workspaces/:id/tasks`) and re-pointed
// the webapp — but bin/butchr was NOT re-pointed, so ~16 live CLI commands hit deleted routes
// and failed with the generic 404 `butchr: not found`. The PRIOR test suite only exercised
// pure arg-parse helpers (cli-helpers.test.ts), which is exactly why the regression shipped
// uncaught. This file exercises the REAL bin/butchr command handlers END-TO-END against the
// REAL `/api/work` routes and asserts each one hits a REGISTERED route (never a 404 'not
// found') — so it FAILS on the old (broken) bin/butchr and PASSES after the re-point.
//
// Boot model: the REAL server is booted in a SUBPROCESS (its own process → its own config/db
// singletons, so BUTCHR_PORT/BUTCHR_DB definitely apply — the in-process singletons are shared
// and locked by whichever test file imports first, and the dev box may already run butchr on
// the default port). The subprocess binds an EPHEMERAL port (BUTCHR_PORT=0) against a private
// BUTCHR_DB, with BUTCHR_HERDR_BIN=`true` so every herdr probe (story-leader launch, dispatch)
// is a harmless no-op. We then point BUTCHR_URL at it and import bin/butchr, driving its
// EXPORTED handlers directly (BASE derives from BUTCHR_URL at import).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SERVER_PATH = join(ROOT, "src", "server.ts");
const CLI_PATH = join(ROOT, "bin", "butchr");

let DATA_DIR: string;
let REPO_ROOT: string;
let serverProc: ReturnType<typeof Bun.spawn>;
let BASE: string;
let cli: typeof import("../bin/butchr");

// Seeded fixtures (created over the real API in beforeAll):
let WS: string; // registered workspace id
let nodeId: string; // a story NODE (must be FILTERED OUT of `ls`)
let leafId: string; // a rollback LEAF (the target for show/approve/answer/spec/wait)
let leafStatus: string; // the leaf's status (so `wait --until <it>` resolves instantly)

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

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-cliwork-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-cliwork-repo-"));

  // Protect the LIVE db if this file happens to import config/db first (every test file does
  // this) — the CLI import below transitively loads src/selftest.ts → config/db.
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  // A real git repo with one commit — createTask (the rollback leaf) adds a worktree off it.
  const g = (args: string[]) => execFileSync("git", ["-C", REPO_ROOT, ...args], { stdio: "ignore" });
  execFileSync("git", ["init", "-q", REPO_ROOT], { stdio: "ignore" });
  g(["config", "user.email", "test@butchr.local"]);
  g(["config", "user.name", "butchr test"]);
  g(["commit", "--allow-empty", "-q", "-m", "init"]);

  // Boot the real server in a subprocess on an ephemeral port against the private db.
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
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const port = await waitForPort(serverProc.stdout as ReadableStream<Uint8Array>, 25000);
  BASE = `http://127.0.0.1:${port}`;

  // bin/butchr reads BASE from BUTCHR_URL at import — set it BEFORE importing the CLI.
  process.env.BUTCHR_URL = BASE;
  cli = await import("../bin/butchr");

  // Wait until the server actually answers (routes are live the moment startServer returns,
  // but poll /health to be safe before seeding).
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok || res.status === 503) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  // Seed fixtures over the REAL API (using the CLI's own HTTP helper):
  // 1) register the workspace (gate_cmd="" so no gate could ever run).
  const ws = await cli.api("POST", "/api/workspaces", { path: REPO_ROOT, gate_cmd: "" });
  WS = ws.id;
  // 2) a story NODE (top-level non-rollback create) — must be filtered out of `ls`.
  const node = await cli.api("POST", `/api/workspaces/${encodeURIComponent(WS)}/work`, {
    brief: "a node for the ls leaf-filter assertion",
  });
  nodeId = node.id;
  // 3) a rollback LEAF (the one workspace-level leaf still creatable directly).
  const leaf = await cli.api("POST", `/api/workspaces/${encodeURIComponent(WS)}/work`, {
    kind: "rollback",
    template: "rollback",
    vars: { task: "seed-task", sha: "deadbeef" },
  });
  leafId = leaf.id;
  leafStatus = leaf.status;
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

/**
 * Run a CLI handler with stdout captured and process.exit neutralized (so a stray usage
 * `fail()` can't kill the test runner), returning the captured stdout + any thrown error.
 */
async function run(fn: () => Promise<unknown>): Promise<{ out: string; err: any }> {
  const chunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  const origExit = process.exit;
  // @ts-expect-error — test-time monkeypatch of the write signature.
  process.stdout.write = (s: unknown) => {
    chunks.push(typeof s === "string" ? s : String(s));
    return true;
  };
  // @ts-expect-error — neutralize process.exit for the duration of the call.
  process.exit = (code?: number) => {
    throw new Error(`unexpected process.exit(${code})`);
  };
  let err: any = null;
  try {
    await fn();
  } catch (e) {
    err = e;
  } finally {
    process.stdout.write = origWrite;
    process.exit = origExit;
  }
  return { out: chunks.join(""), err };
}

/**
 * The regression signature: a DELETED route → the generic 404 `{error:'not found'}`. A command
 * that hits a REAL (registered) route either succeeds or fails with a DIFFERENT, meaningful
 * status (e.g. 409 wrong-state) — never a 404 'not found'. Asserting on the thrown ApiError
 * keeps the check honest (it does NOT swallow everything): the route must be reached.
 */
function assertRouteReached(err: any) {
  expect(err).toBeInstanceOf(cli.ApiError);
  expect(err.status).not.toBe(404);
  expect(String(err.message)).not.toMatch(/not found/i);
}

describe("bin/butchr command handlers hit the unified /api/work routes (not deleted 404s)", () => {
  test("ls → GET /api/work?workspace= and filters to LEAVES (nodes dropped)", async () => {
    const { out, err } = await run(() => cli.cmdLs({ workspace: WS, json: true }));
    expect(err).toBeNull();
    const rows = JSON.parse(out);
    expect(Array.isArray(rows)).toBe(true);
    // Every row is a leaf (the load-bearing work_kind filter), the seeded leaf is present,
    // and the story NODE is NOT (it would appear in the raw union without the filter).
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r: any) => r.work_kind === "leaf")).toBe(true);
    expect(rows.some((r: any) => r.id === leafId)).toBe(true);
    expect(rows.some((r: any) => r.id === nodeId)).toBe(false);
  });

  test("show → GET /api/work/:id", async () => {
    const { out, err } = await run(() => cli.cmdShow([leafId], { json: true }));
    expect(err).toBeNull();
    const t = JSON.parse(out);
    expect(t.id).toBe(leafId);
  });

  test("story → POST /api/workspaces/:id/work creates a NODE", async () => {
    const { out, err } = await run(() =>
      cli.cmdStory([WS], { message: "a brand new story via the CLI", json: true }),
    );
    expect(err).toBeNull();
    const story = JSON.parse(out);
    expect(typeof story.id).toBe("string");
    expect(story.id.length).toBeGreaterThan(0);
  });

  test("new --template rollback → POST /api/workspaces/:id/work creates a leaf-ROLLBACK (not a node)", async () => {
    const { out, err } = await run(() =>
      cli.cmdNew([WS], { template: "rollback", var: ["task=t1", "sha=abc123"], json: true }),
    );
    expect(err).toBeNull();
    const task = JSON.parse(out);
    expect(task.kind).toBe("rollback");
    expect(typeof task.id).toBe("string");
    expect(task.id).not.toBe(nodeId);
  });

  test("approve → POST /api/work/:id/approve (route reached; 409 wrong-state, not 404)", async () => {
    const { err } = await run(() => cli.cmdApprove([leafId], { json: true }));
    assertRouteReached(err);
  });

  test("reject → POST /api/work/:id/reject (route reached; 409 wrong-state, not 404)", async () => {
    const { err } = await run(() => cli.cmdReject([leafId], { message: "needs work", json: true }));
    assertRouteReached(err);
  });

  test("answer → POST /api/work/:id/answer (route reached; 409 wrong-state, not 404)", async () => {
    const { err } = await run(() => cli.cmdAnswer([leafId], { message: "the answer", json: true }));
    assertRouteReached(err);
  });

  test("spec → POST /api/work/:id/spec (route reached; 409 wrong-state, not 404)", async () => {
    const { err } = await run(() => cli.cmdSpec([leafId], { message: "## Spec\nDo it.", json: true }));
    assertRouteReached(err);
  });

  test("wait → polls GET /api/work/:id (resolves instantly at the leaf's current status)", async () => {
    const { out, err } = await run(() =>
      cli.cmdWait([leafId], { until: leafStatus, timeout: "5", interval: "1", json: true }),
    );
    expect(err).toBeNull();
    const t = JSON.parse(out);
    expect(t.id).toBe(leafId);
  });
});
