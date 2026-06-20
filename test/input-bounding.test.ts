// Tests for FIX F5 — input bounding on the task brief/prompt + the HTTP request-body cap.
//
// Two layers of defense against an unbounded / malformed brief (it is written verbatim to
// task.md and handed to the LLM, where a NUL byte can TRUNCATE it):
//   1. validatePrompt (tasks.ts) — strips NUL + C0/C1 control chars (KEEPING tab/newline/CR),
//      requires non-empty-after-strip, and length-caps at MAX_PROMPT_LEN. Exercised in-process
//      both directly and end-to-end through createTask (real worktree + task.md on disk).
//   2. maxRequestBodySize on Bun.serve (server.ts) — an oversized POST body is rejected (413)
//      by the transport BEFORE any handler runs. Exercised against a REAL server booted in a
//      subprocess on an ephemeral port (its own config/db singletons; herdr stubbed to a no-op).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SERVER_PATH = join(ROOT, "src", "server.ts");

let DATA_DIR: string;
let REPO_ROOT: string;
const DIR_ID = "f5-dir";

let tasksMod: typeof import("../src/tasks.ts");
let taskmdMod: typeof import("../src/taskmd.ts");
let dbMod: typeof import("../src/db.ts");

function g(args: string[], cwd = REPO_ROOT): void {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-f5-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-f5-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  execFileSync("git", ["init", "-q", REPO_ROOT], { stdio: "ignore" });
  g(["config", "user.email", "test@butchr.local"]);
  g(["config", "user.name", "butchr test"]);
  writeFileSync(join(REPO_ROOT, "README.md"), "base\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "init"]);

  dbMod = await import("../src/db.ts");
  tasksMod = await import("../src/tasks.ts");
  taskmdMod = await import("../src/taskmd.ts");

  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, gate_cmd, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(DIR_ID, REPO_ROOT, "test", "", dbMod.nowIso());
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

describe("validatePrompt — sanitize + bound the brief", () => {
  test("strips NUL + control chars but KEEPS tab / newline / carriage-return", () => {
    const raw = "line one\nline\ttwo\r\nthree\x00\x07\x1b\x7f end\x9f";
    const out = tasksMod.validatePrompt(raw);
    expect(out).toBe("line one\nline\ttwo\r\nthree end");
    expect(out.includes("\x00")).toBe(false);
    // The legitimate whitespace survived.
    expect(out.includes("\n")).toBe(true);
    expect(out.includes("\t")).toBe(true);
    expect(out.includes("\r")).toBe(true);
  });

  test("a brief that is only control chars / whitespace is rejected (empty after strip)", () => {
    expect(() => tasksMod.validatePrompt("\x00\x07\x1b")).toThrow(/prompt is required/);
    expect(() => tasksMod.validatePrompt("   \n\t  ")).toThrow(/prompt is required/);
  });

  test("a non-string brief is rejected", () => {
    // @ts-expect-error — deliberately wrong type
    expect(() => tasksMod.validatePrompt(undefined)).toThrow(/prompt is required/);
    // @ts-expect-error — deliberately wrong type
    expect(() => tasksMod.validatePrompt(123)).toThrow(/prompt is required/);
  });

  test("an over-cap brief is rejected; a brief at the cap is accepted", () => {
    const tooLong = "a".repeat(tasksMod.MAX_PROMPT_LEN + 1);
    expect(() => tasksMod.validatePrompt(tooLong)).toThrow(/characters or fewer/);
    const atCap = "a".repeat(tasksMod.MAX_PROMPT_LEN);
    expect(tasksMod.validatePrompt(atCap).length).toBe(tasksMod.MAX_PROMPT_LEN);
  });
});

describe("createTask — brief is sanitized on the way to task.md", () => {
  test("a NUL/control-laced brief is stored sanitized; newlines/tabs survive on disk", async () => {
    const brief = "real\twork\nwith a NUL\x00 and a bell\x07 here";
    const v = await tasksMod.createTask(DIR_ID, brief);

    // The returned view's prompt is the cleaned text.
    expect(v.prompt).toBe("real\twork\nwith a NUL and a bell here");

    // And it is clean ON DISK — no raw NUL byte ever reaches task.md (a NUL would truncate
    // the file/brief when later read or handed to the LLM).
    const onDisk = readFileSync(taskmdMod.taskMdPath(REPO_ROOT, v.id));
    expect(onDisk.includes(0x00)).toBe(false);
    const doc = taskmdMod.readTaskMd(REPO_ROOT, v.id);
    expect(doc.prompt).toBe("real\twork\nwith a NUL and a bell here");
  });

  test("an over-cap brief is rejected by createTask (400)", async () => {
    const tooLong = "x".repeat(tasksMod.MAX_PROMPT_LEN + 1);
    await expect(tasksMod.createTask(DIR_ID, tooLong)).rejects.toThrow(/characters or fewer/);
  });
});

describe("Bun.serve maxRequestBodySize — oversized request body is rejected", () => {
  let serverProc: ReturnType<typeof Bun.spawn>;
  let BASE: string;

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
    serverProc = Bun.spawn({
      cmd: ["bun", "-e", `import(${JSON.stringify(SERVER_PATH)}).then((m) => m.startServer())`],
      cwd: ROOT,
      env: {
        ...process.env,
        BUTCHR_PORT: "0",
        BUTCHR_DATA_DIR: DATA_DIR,
        BUTCHR_DB: join(DATA_DIR, "server.db"),
        BUTCHR_LOG_FILE: "",
        BUTCHR_HERDR_BIN: "true",
        BUTCHR_CTO_AGENT: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const port = await waitForPort(serverProc.stdout as ReadableStream<Uint8Array>, 25000);
    BASE = `http://127.0.0.1:${port}`;
  }, 30000);

  afterAll(() => {
    try {
      serverProc?.kill();
    } catch {
      /* already gone */
    }
  });

  test("a >1 MiB body is rejected (413) by the transport, before any handler", async () => {
    // 2 MiB — over the 1 MiB cap. No Origin header (CSRF passes for non-browser callers),
    // so the ONLY thing that can reject this is the body-size cap.
    const big = "a".repeat(2 * 1024 * 1024);
    const res = await fetch(`${BASE}/api/work`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blob: big }),
    });
    expect(res.status).toBe(413);
    await res.text().catch(() => "");
  });

  test("a small body is NOT rejected for size (reaches routing → not 413)", async () => {
    // A tiny body sails past the cap; it hits the router (a 404/400/etc. is fine — the
    // point is it is NEVER a 413). Proves the cap doesn't reject legitimate payloads.
    const res = await fetch(`${BASE}/api/work`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ small: "ok" }),
    });
    expect(res.status).not.toBe(413);
    await res.text().catch(() => "");
  });
});
