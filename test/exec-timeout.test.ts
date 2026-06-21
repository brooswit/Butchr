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
import { KILL_GRACE_MS, run, TIMEOUT_MARKER } from "../src/exec.ts";

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

  test("a SIGTERM-trapping child is escalated to SIGKILL after the grace (F3)", async () => {
    // `trap '' TERM` makes the child IGNORE the timeout's SIGTERM, so the bare SIGTERM
    // kill would hang to the full 30s sleep. The SIGKILL escalation must terminate it
    // shortly after KILL_GRACE_MS — proving the bound holds even against a TERM-trapper.
    // The inner sleep redirects its fds away from the captured stdout/stderr pipes, so once
    // bash (the direct child) is SIGKILLed the pipes hit EOF and the run resolves — an
    // orphaned grandchild holding the pipe open is a separate, pre-existing concern.
    const startedAt = Date.now();
    const res = await run(["bash", "-c", "trap '' TERM; sleep 30 >/dev/null 2>&1"], {
      timeoutMs: 100,
    });
    const elapsedMs = Date.now() - startedAt;
    expect(res.timedOut).toBe(true);
    expect(res.code).toBe(124);
    expect(res.stderr).toContain(TIMEOUT_MARKER);
    // Killed within grace+epsilon (NOT hanging to the 30s sleep). Generous upper bound to
    // stay non-flaky on a loaded CI box while still far below the 30_000ms sleep.
    expect(elapsedMs).toBeLessThan(100 + KILL_GRACE_MS + 5_000);
  });
});
