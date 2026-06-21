// Regression tests for the BOUNDED subprocess-output capture (latent-OOM fix). The
// two capture paths — exec.run and herdr.runHeadless — read a child's stdout/stderr
// into memory via the shared exec.readBoundedTail helper, which retains only the
// LAST `maxBytes` bytes (the TAIL, what ciTail + the conformance parser want) so a
// runaway command that prints gigabytes before its timeout fires can't OOM butchr.
//
// The contract under test:
//   - A SUB-CAP stream/command is captured in FULL, byte-for-byte unchanged.
//   - An OVER-CAP stream/command is truncated to ~cap, KEEPING THE TAIL, with a
//     `[...truncated N bytes...]` marker prepended (dropping from the FRONT).
//   - Exit code is still captured when output is truncated.
import { describe, expect, test } from "bun:test";
import { readBoundedTail, run } from "../src/exec.ts";
import { runHeadless } from "../src/herdr.ts";

const enc = new TextEncoder();

/** A one-shot ReadableStream that emits the given byte chunks then closes. */
function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    },
  });
}

describe("readBoundedTail()", () => {
  test("a sub-cap stream is returned in full, unchanged, with no marker", async () => {
    const out = await readBoundedTail(streamOf(enc.encode("hello world")), 1000);
    expect(out).toBe("hello world");
  });

  test("a null/absent stream yields the empty string", async () => {
    expect(await readBoundedTail(null, 1000)).toBe("");
    expect(await readBoundedTail(undefined, 1000)).toBe("");
  });

  test("maxBytes <= 0 is unbounded (whole stream returned)", async () => {
    const big = "z".repeat(50_000);
    expect(await readBoundedTail(streamOf(enc.encode(big)), 0)).toBe(big);
    expect(await readBoundedTail(streamOf(enc.encode(big)), -1)).toBe(big);
  });

  test("an over-cap stream keeps the TAIL and prepends a truncation marker", async () => {
    // Two chunks (600 'a' + 300 'b' = 900 bytes), cap 500 → keep the last 500 bytes
    // = 200 'a' + 300 'b', dropping the leading 400 bytes (a PARTIAL front-chunk trim).
    const out = await readBoundedTail(
      streamOf(enc.encode("a".repeat(600)), enc.encode("b".repeat(300))),
      500,
    );
    expect(out.startsWith("[...truncated 400 bytes...]\n")).toBe(true);
    const body = out.slice(out.indexOf("\n") + 1);
    expect(body.length).toBe(500); // exactly the cap, the tail
    expect(body.endsWith("b".repeat(300))).toBe(true); // the END is preserved
    expect(body.startsWith("a".repeat(200))).toBe(true);
  });

  test("truncation discards from the FRONT (early bytes are gone)", async () => {
    const out = await readBoundedTail(
      streamOf(enc.encode("FRONT" + "x".repeat(2000) + "BACK")),
      100,
    );
    expect(out).not.toContain("FRONT");
    expect(out.endsWith("BACK")).toBe(true);
  });
});

describe("exec.run() bounded capture", () => {
  test("a sub-cap command returns its full output unchanged", async () => {
    const res = await run(["echo", "hi"], { maxOutputBytes: 1000 });
    expect(res.ok).toBe(true);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("hi\n");
  });

  test("an over-cap command is truncated to ~cap, TAIL kept, exit code captured", async () => {
    const cap = 1000;
    // Print ~200KB of 'A' then a recognizable suffix, and exit non-zero — proving the
    // exit code survives truncation and the END of the stream is retained.
    const res = await run(
      ["bash", "-lc", "head -c 200000 /dev/zero | tr '\\0' 'A'; printf ENDTAIL; exit 3"],
      { maxOutputBytes: cap },
    );
    expect(res.code).toBe(3);
    expect(res.ok).toBe(false);
    expect(res.stdout.endsWith("ENDTAIL")).toBe(true); // tail retained
    expect(res.stdout.startsWith("[...truncated ")).toBe(true);
    expect(res.stdout).toContain("A"); // some of the bulk survives in the tail
    // captured length is bounded: cap bytes of tail + the short marker.
    expect(res.stdout.length).toBeLessThanOrEqual(cap + 64);
  });
});

describe("herdr.runHeadless() bounded capture", () => {
  test("an over-cap headless command truncates stdout, keeping the TAIL", async () => {
    const cap = 1000;
    const res = await runHeadless({
      cmd: "head -c 200000 /dev/zero | tr '\\0' 'A'; printf ENDTAIL",
      cwd: ".",
      timeoutMs: 10_000,
      maxOutputBytes: cap,
    });
    expect(res.ok).toBe(true);
    expect(res.code).toBe(0);
    expect(res.stdout.endsWith("ENDTAIL")).toBe(true);
    expect(res.stdout.startsWith("[...truncated ")).toBe(true);
    expect(res.stdout.length).toBeLessThanOrEqual(cap + 64);
  });

  test("a sub-cap headless command returns its full output unchanged", async () => {
    const res = await runHeadless({
      cmd: "printf 'hello headless'",
      cwd: ".",
      timeoutMs: 10_000,
      maxOutputBytes: 1000,
    });
    expect(res.ok).toBe(true);
    expect(res.stdout).toBe("hello headless");
  });
});
