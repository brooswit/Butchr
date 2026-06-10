// Tests for exec.run()'s optional `timeoutMs` bound (C7 — the enabler for the
// shared build+test gate runner, C3). These shell out to tiny real binaries
// (`sleep`, `echo`, `false`) — no claude/herdr/bun-build involved — so they're
// fast and hermetic.
//
// The contract under test:
//   - With no timeout, run() behaves exactly as before (default off).
//   - A run that exceeds timeoutMs is killed and resolves with ok:false,
//     code 124, timedOut:true, and TIMEOUT_MARKER in stderr.
//   - A run that finishes within timeoutMs is unaffected by the (unused) bound.
import { describe, expect, test } from "bun:test";
import { run, TIMEOUT_MARKER } from "../src/exec.ts";

describe("run() default (no timeout) is unchanged", () => {
  test("a fast command resolves with its real output and no timedOut flag", async () => {
    const res = await run(["echo", "hi"]);
    expect(res.ok).toBe(true);
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toBe("hi");
    expect(res.timedOut).toBeUndefined();
  });

  test("a non-zero exit is reported, still no timedOut flag", async () => {
    const res = await run(["false"]);
    expect(res.ok).toBe(false);
    expect(res.code).not.toBe(0);
    expect(res.timedOut).toBeUndefined();
  });

  test("a zero/negative timeoutMs arms no bound (off by default)", async () => {
    const res = await run(["echo", "ok"], { timeoutMs: 0 });
    expect(res.ok).toBe(true);
    expect(res.stdout.trim()).toBe("ok");
    expect(res.timedOut).toBeUndefined();
  });
});

describe("run() with timeoutMs", () => {
  test("a hung command is killed and flagged as a timeout", async () => {
    // `sleep 30` would never finish on its own within the test; the 100ms bound
    // must kill it and resolve promptly.
    const res = await run(["sleep", "30"], { timeoutMs: 100 });
    expect(res.timedOut).toBe(true);
    expect(res.ok).toBe(false);
    expect(res.code).toBe(124);
    expect(res.stderr).toContain(TIMEOUT_MARKER);
  });

  test("a command that finishes within the bound is unaffected", async () => {
    const res = await run(["echo", "done"], { timeoutMs: 10_000 });
    expect(res.ok).toBe(true);
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toBe("done");
    expect(res.timedOut).toBeUndefined();
  });
});
