// Regression test for the SSE keepalive timer leak (see server.sseStream).
//
// The SSE endpoint installs a 25s keepalive setInterval in the stream's start().
// Bun fires the stream's cancel() when the EventSource client disconnects (tab
// navigate/refresh, network blip, laptop sleep — the webapp AND the MCP bridge
// both auto-reconnect). Previously the timer was only cleared via a dead
// `(controller as any)._cleanup` indirection that was never read, so cancel()
// left the 25s timer firing FOREVER on a closed controller — one leaked timer
// per disconnected client, accumulating for the life of the process.
//
// The fix hoists `ka` into the closure so cancel() can clearInterval(ka). This
// test drives start() (by reading the initial frame) then cancel() (client
// disconnect) and asserts the keepalive interval is actually cleared.
//
// In-process: no HTTP server, no claude, no herdr. We stub the global
// setInterval/clearInterval so we can match the created timer to the cleared one
// without leaning on real wall-clock timers.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let sseStream: typeof import("../src/server.ts").sseStream;
let DATA_DIR: string;

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-sse-data-"));
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  ({ sseStream } = await import("../src/server.ts"));
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

test("cancel() clears the keepalive interval on client disconnect (no leaked timer)", async () => {
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  const created: Array<{ id: object; ms: number }> = [];
  const cleared: unknown[] = [];
  // Hand out opaque sentinel ids so create→clear can be matched without relying
  // on real timer semantics.
  (globalThis as any).setInterval = (_fn: unknown, ms: number) => {
    const id = {};
    created.push({ id, ms });
    return id;
  };
  (globalThis as any).clearInterval = (id: unknown) => {
    cleared.push(id);
  };

  try {
    const stream = sseStream();
    const reader = stream.getReader();
    // Drain the initial "hello" frame: this guarantees start() ran and the 25s
    // keepalive timer was installed.
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(created.length).toBe(1);
    expect(created[0]!.ms).toBe(25000);
    expect(cleared.length).toBe(0); // still connected → timer must be live

    // Simulate the client disconnecting — Bun fires the stream's cancel().
    await reader.cancel();

    // The keepalive timer must be cleared exactly once, and it must be the SAME
    // timer that start() created — not left firing forever on a closed controller.
    expect(cleared.length).toBe(1);
    expect(cleared[0]).toBe(created[0]!.id);
  } finally {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
  }
});
