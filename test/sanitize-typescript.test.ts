// Coverage for the dispatcher's run-log SANITIZER. `sanitizeTypescript` is module
// -private, so we drive it through its exported caller, `readRunLogSnapshot`, which
// reads a task's `<id>.log` from the runs dir and returns the sanitized text. We
// write a synthetic raw typescript to that path and assert on the cleaned output.
//
// The sanitizer composes exec.stripAnsi (ANSI/CSI escapes + bare control chars,
// WIDENED to strip \x00-\x08,\x0b,\x0c,\x0e-\x1f while deliberately PRESERVING \t,
// \n, and \r) with \r\n→\n / \r→\n normalization and the `Script started/done on`
// banner filter. Env is set before a dynamic import so config/db read temp paths
// and herdr probes are no-ops (BUTCHR_HERDR_BIN=true), matching the other tests.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let RUNS_DIR: string;
let dispatchMod: typeof import("../src/dispatcher.ts");

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-sanitize-data-"));
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  dispatchMod = await import("../src/dispatcher.ts");
  // Derive the runs dir from the ACTUAL config (config.ts is import-cached by
  // whichever test file loads it first, so its dataDir may not be ours when the
  // whole suite shares one process). readRunLogSnapshot reads from there, so we
  // must write there too.
  const cfgMod = await import("../src/config.ts");
  RUNS_DIR = join(cfgMod.config.dataDir, "runs");
  mkdirSync(RUNS_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

// Write a raw run log for `taskId` and return its sanitized snapshot.
function sanitize(taskId: string, raw: string): string {
  writeFileSync(join(RUNS_DIR, `${taskId}.log`), raw, "utf8");
  return dispatchMod.readRunLogSnapshot(taskId);
}

describe("sanitizeTypescript — control-char widening + invariants", () => {
  test("strips the backspace \\x08 but PRESERVES \\t and \\n, and leaves no \\r", () => {
    const out = sanitize("ctl", "a\x08b\tc\r\nd");
    // The widened control-char strip removes the backspace entirely.
    expect(out).not.toContain("\x08");
    // \t and \n are intentionally NOT in the stripped range — content survives.
    expect(out).toContain("\t");
    expect(out).toContain("\n");
    expect(out).toContain("ab\tc"); // "a" + (backspace gone) + "b\tc"
    // \r is normalized away (\r\n → \n), so no carriage return remains.
    expect(out).not.toContain("\r");
    // Exact shape: "a\x08b\tc\r\nd" → strip \x08 → "ab\tc\r\nd" → \r\n→\n → "ab\tc\nd".
    expect(out).toBe("ab\tc\nd");
  });

  test("filters out the `Script started on ...` / `Script done on ...` banner lines", () => {
    const raw = [
      "Script started on 2026-06-11 12:00:00+00:00",
      "real agent output",
      "Script done on 2026-06-11 12:05:00+00:00",
    ].join("\n");
    const out = sanitize("banner", raw);
    expect(out).not.toContain("Script started on");
    expect(out).not.toContain("Script done on");
    // The genuine output between the banners survives intact.
    expect(out).toBe("real agent output");
  });

  test("a banner line interleaved with kept lines is the only thing removed", () => {
    const raw = ["before", "Script done on whenever", "after"].join("\n");
    const out = sanitize("interleaved", raw);
    expect(out).toBe("before\nafter");
  });

  test("a missing log file returns the empty string", () => {
    expect(dispatchMod.readRunLogSnapshot("no-such-task")).toBe("");
  });
});
