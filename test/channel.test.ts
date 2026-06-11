// Tests for the ONE-WAY CTO notification channel bridge (src/channel.ts).
//
// Pure / in-process only: no real claude, no real butchr server, no socket. We
// drive the bridge's translation logic, the initialize-result shape, the SSE
// reconnect loop (with an injected `open`), and the malformed-input handling
// directly — the same seams main() wires to stdin/stdout/fetch at runtime.
import { describe, expect, test } from "bun:test";
import {
  ATTENTION_STATES,
  AttentionBridge,
  channelInitializeResult,
  channelNotificationMessage,
  handleRpc,
  makeSseParser,
  runSseLoop,
} from "../src/channel.ts";

// Build a serialized task.updated event the way taskView/SSE would emit it.
function taskUpdated(task: Record<string, unknown>) {
  return { type: "task.updated", task };
}

// A ReadableStream that emits the given string chunks then closes (one SSE socket).
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

describe("channel: attention transitions → notifications", () => {
  test("emits a correctly-shaped notification for each attention transition", () => {
    const bridge = new AttentionBridge();
    bridge.seedDirectoryLabels([{ id: "dir-1", label: "webapp" }]);

    const cases: Array<{
      state: string;
      task: Record<string, unknown>;
      expectText: string;
    }> = [
      {
        state: "spec_review",
        task: {
          id: "t-spec",
          directory_id: "dir-1",
          status: "spec_review",
          summary: "Spec: add a widget",
        },
        expectText: "Spec: add a widget",
      },
      {
        state: "in_review",
        task: {
          id: "t-review",
          directory_id: "dir-1",
          status: "in_review",
          summary: "Implemented the widget",
        },
        expectText: "Implemented the widget",
      },
      {
        state: "needs_info",
        task: {
          id: "t-ask",
          directory_id: "dir-1",
          status: "needs_info",
          question: "Which color should the widget be?",
        },
        expectText: "Which color should the widget be?",
      },
      {
        // The spec's "failed" attention state is the canonical `aborted`.
        state: "aborted",
        task: {
          id: "t-fail",
          directory_id: "dir-1",
          status: "aborted",
          last_dispatch_error: "spawn failed after 5 attempts",
        },
        expectText: "spawn failed after 5 attempts",
      },
    ];

    for (const c of cases) {
      const note = bridge.consume(taskUpdated(c.task));
      expect(note).not.toBeNull();
      // meta carries the identifier-keyed routing data.
      expect(note!.meta).toEqual({
        task_id: c.task.id as string,
        dir: "dir-1",
        state: c.state,
      });
      // content is a single human line carrying id, label, state phrase, and text.
      expect(note!.content).toContain(`[${c.task.id}]`);
      expect(note!.content).toContain("webapp");
      expect(note!.content).toContain(c.expectText);
      expect(note!.content).not.toContain("\n");
    }
  });

  test("ATTENTION_STATES are exactly the four CTO attention states", () => {
    expect([...ATTENTION_STATES].sort()).toEqual(
      ["aborted", "in_review", "needs_info", "spec_review"].sort(),
    );
  });

  test("a re-emitted same-status update is NOT a fresh transition", () => {
    const bridge = new AttentionBridge();
    const task = {
      id: "t1",
      directory_id: "dir-1",
      status: "in_review",
      summary: "done",
    };
    expect(bridge.consume(taskUpdated(task))).not.toBeNull();
    // Same status again (e.g. summary touched) → no duplicate notification.
    expect(bridge.consume(taskUpdated({ ...task, summary: "done v2" }))).toBeNull();
  });

  test("entering an attention state from a non-attention one fires once", () => {
    const bridge = new AttentionBridge();
    const base = { id: "t2", directory_id: "dir-1" };
    expect(bridge.consume(taskUpdated({ ...base, status: "in_progress" }))).toBeNull();
    const note = bridge.consume(
      taskUpdated({ ...base, status: "needs_info", question: "q?" }),
    );
    expect(note).not.toBeNull();
    expect(note!.meta.state).toBe("needs_info");
  });

  test("falls back to directory_id when no label is known", () => {
    const bridge = new AttentionBridge();
    const note = bridge.consume(
      taskUpdated({ id: "t3", directory_id: "dir-x", status: "spec_review" }),
    );
    expect(note!.meta.dir).toBe("dir-x");
    expect(note!.content).toContain("dir-x");
  });

  test("directory.updated events refresh the label cache mid-stream", () => {
    const bridge = new AttentionBridge();
    expect(
      bridge.consume({
        type: "directory.updated",
        directory: { id: "dir-2", label: "api-server" },
      }),
    ).toBeNull();
    const note = bridge.consume(
      taskUpdated({ id: "t4", directory_id: "dir-2", status: "in_review", summary: "x" }),
    );
    expect(note!.content).toContain("api-server");
  });
});

describe("channel: one-way capability (no tools)", () => {
  test("initialize advertises claude/channel and NO tools", () => {
    const res = channelInitializeResult("2025-06-18");
    expect(res.capabilities).toHaveProperty("experimental");
    expect(res.capabilities.experimental).toHaveProperty("claude/channel");
    expect(res.capabilities.experimental["claude/channel"]).toEqual({});
    // ONE-WAY: must NOT advertise tools (nor any other server capability).
    expect((res.capabilities as Record<string, unknown>).tools).toBeUndefined();
    expect((res.capabilities as Record<string, unknown>).resources).toBeUndefined();
    expect((res.capabilities as Record<string, unknown>).prompts).toBeUndefined();
    expect(Object.keys(res.capabilities)).toEqual(["experimental"]);
    expect(typeof res.instructions).toBe("string");
    expect(res.instructions.length).toBeGreaterThan(0);
  });

  test("handleRpc answers initialize/ping and exposes no tools surface", () => {
    const init = handleRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect((init as any).result.capabilities.experimental).toHaveProperty(
      "claude/channel",
    );
    expect((init as any).result.capabilities.tools).toBeUndefined();

    expect(handleRpc({ jsonrpc: "2.0", id: 2, method: "ping" })).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: {},
    });

    // Notifications get no reply.
    expect(
      handleRpc({ jsonrpc: "2.0", method: "notifications/initialized" }),
    ).toBeNull();

    // There is no tools/call path — an unknown method is a JSON-RPC error.
    const err = handleRpc({ jsonrpc: "2.0", id: 3, method: "tools/call" });
    expect((err as any).error.code).toBe(-32601);
  });

  test("channelNotificationMessage uses the channel method + params shape", () => {
    const msg = JSON.parse(
      channelNotificationMessage({
        content: "hello",
        meta: { task_id: "t", dir: "d", state: "in_review" },
      }),
    );
    expect(msg.jsonrpc).toBe("2.0");
    expect(msg.method).toBe("notifications/claude/channel");
    expect(msg.id).toBeUndefined(); // a notification has no id
    expect(msg.params).toEqual({
      content: "hello",
      meta: { task_id: "t", dir: "d", state: "in_review" },
    });
  });
});

describe("channel: SSE reconnect on drop", () => {
  test("runSseLoop reopens the stream after it ends and keeps consuming", async () => {
    const received: string[] = [];
    let openCount = 0;

    const ev1 = `data: ${JSON.stringify({ type: "hello", n: 1 })}\n\n`;
    const ev2 = `data: ${JSON.stringify({ type: "hello", n: 2 })}\n\n`;

    await runSseLoop({
      url: "http://test/api/events",
      onData: (p) => received.push(p),
      // Each open yields one event then the stream ENDS (a drop) → loop must reconnect.
      open: async () => {
        openCount++;
        return streamOf([openCount === 1 ? ev1 : ev2]);
      },
      // Stop only after we've seen both events (i.e. after the reconnect).
      shouldStop: () => received.length >= 2,
      sleep: async () => {}, // no real backoff delay in the test
    });

    expect(openCount).toBeGreaterThanOrEqual(2); // proves it reconnected
    expect(received.map((p) => JSON.parse(p).n)).toEqual([1, 2]);
  });

  test("runSseLoop survives an open() that throws and retries", async () => {
    let openCount = 0;
    const received: string[] = [];
    await runSseLoop({
      url: "http://test/api/events",
      onData: (p) => received.push(p),
      open: async () => {
        openCount++;
        if (openCount === 1) throw new Error("connection refused");
        return streamOf([`data: ${JSON.stringify({ type: "hello" })}\n\n`]);
      },
      shouldStop: () => received.length >= 1,
      sleep: async () => {},
    });
    expect(openCount).toBeGreaterThanOrEqual(2);
    expect(received.length).toBe(1);
  });

  test("makeSseParser extracts data payloads and skips keepalive comments", () => {
    const out: string[] = [];
    const feed = makeSseParser((p) => out.push(p));
    // Split across chunk boundaries to exercise buffering.
    feed("data: {\"a\":1}\n");
    feed("\n: keepalive\n\n");
    feed('data: {"b":2}\n\n');
    expect(out).toEqual(['{"a":1}', '{"b":2}']);
  });
});

describe("channel: malformed / irrelevant events dropped silently", () => {
  test("consume returns null and never throws on bad or irrelevant input", () => {
    const bridge = new AttentionBridge();
    const junk: unknown[] = [
      null,
      undefined,
      42,
      "not an object",
      {},
      { type: "hello", now: "2026-06-11" },
      { type: "task.updated" }, // no task (absent session payload)
      { type: "task.updated", task: null },
      { type: "task.updated", task: {} }, // no id/status
      { type: "task.updated", task: { id: "x" } }, // no status
      { type: "task.updated", task: { id: "x", status: "in_progress" } }, // not attention
      { type: "dispatch.paused", paused: true },
    ];
    for (const j of junk) {
      expect(() => bridge.consume(j)).not.toThrow();
      expect(bridge.consume(j)).toBeNull();
    }
  });
});
