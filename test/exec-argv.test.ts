// Coverage for the pure launch-command helpers in src/exec.ts that the agent-launch
// path shares: buildScriptArgv (the `script`-wrapped `bash -lc` argv) and modelFlag
// (the optional `--model <m>` flag). Both are pure string builders with no module
// side effects, so the tests import and call them directly.
import { describe, expect, test } from "bun:test";
import { buildScriptArgv, modelFlag, sleep } from "../src/exec.ts";

// `sleep` is now the SINGLE shared delay (formerly re-defined identically in
// herdr.ts + dispatcher.ts). It just resolves a promise after `ms`.
describe("sleep (shared poll/backoff delay)", () => {
  test("resolves to undefined after the delay elapses", async () => {
    const start = Date.now();
    const result = await sleep(20);
    expect(result).toBeUndefined();
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });
});

describe("buildScriptArgv", () => {
  test("always returns a `bash -lc <wrapped>` argv", () => {
    const argv = buildScriptArgv({ agentCmd: "claude run", logFile: "/r/t.log" });
    expect(argv[0]).toBe("bash");
    expect(argv[1]).toBe("-lc");
    expect(argv).toHaveLength(3);
  });

  test("WITH doneFile: the wrapped command ends with the `; echo \"$?\" > '<done>'` tail", () => {
    const argv = buildScriptArgv({
      agentCmd: "claude run",
      logFile: "/runs/t.log",
      doneFile: "/runs/t.done",
    });
    const wrapped = argv[2];
    // The exit-code capture tail is appended verbatim, single-quoting the done path.
    expect(wrapped.endsWith(`; echo "$?" > '/runs/t.done'`)).toBe(true);
    // And the body still wraps the agent command under `script` with --log-out + -c.
    expect(wrapped).toContain("--log-out '/runs/t.log' -c 'claude run'");
  });

  test("WITHOUT doneFile: no `echo \"$?\"` tail at all", () => {
    const argv = buildScriptArgv({ agentCmd: "claude run", logFile: "/runs/t.log" });
    const wrapped = argv[2];
    expect(wrapped).not.toContain('echo "$?"');
    expect(wrapped).toContain("--log-out '/runs/t.log' -c 'claude run'");
  });

  test("a logFile/agentCmd with a space and a single-quote is single-quote-escaped", () => {
    // shellQuote wraps in single quotes and rewrites each embedded ' as '\'' so the
    // value can't break out of the quoting. Both the log path and the command carry
    // a space AND an apostrophe.
    const argv = buildScriptArgv({
      agentCmd: "echo it's ok",
      logFile: "/r/a b's.log",
      doneFile: "/r/d e's.done",
    });
    const wrapped = argv[2];
    expect(wrapped).toContain("--log-out '/r/a b'\\''s.log'");
    expect(wrapped).toContain("-c 'echo it'\\''s ok'");
    expect(wrapped.endsWith(`; echo "$?" > '/r/d e'\\''s.done'`)).toBe(true);
  });
});

describe("modelFlag", () => {
  test("a blank/whitespace-only model yields an empty flag", () => {
    expect(modelFlag("  ")).toBe("");
  });

  test("an undefined model yields an empty flag", () => {
    expect(modelFlag(undefined)).toBe("");
  });

  test("a set model is trimmed into `--model <m>`", () => {
    expect(modelFlag(" opus ")).toBe("--model opus");
  });
});
